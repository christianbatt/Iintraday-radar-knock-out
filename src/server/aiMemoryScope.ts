/**
 * Perimetro della memoria appresa (Fase 3).
 *
 * Prima la memoria era un documento unico per tutti (`users/system/...`) e ogni
 * handler autenticato poteva scriverci partendo dal body: una regola iniettata
 * da un utente finiva nel prompt del catalizzatore di tutti.
 *
 * Qui vive solo la parte pura: quale documento, quale file, quale hash del
 * dataset, chi possiede una regola. Nessun I/O, così le regole si possono
 * verificare senza Firestore.
 */

import { createHash } from 'node:crypto';
import type { AILearnedInsight } from '../types/radar';

/** Proprietario delle regole storiche: il documento globale di prima. */
export const AI_MEMORY_LEGACY_OWNER = 'system';

/**
 * Un uid accettabile come nome di documento: niente `/`, niente `..`, niente
 * spazi. Un uid rifiutato non diventa un percorso, quindi non può uscire dal
 * proprio perimetro.
 */
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isScopedMemoryUid(value: unknown): value is string {
  return typeof value === 'string' && UID_PATTERN.test(value);
}

/** Documento Firestore della memoria di un utente. */
export function aiMemoryFirestorePath(uid: string): string {
  if (!isScopedMemoryUid(uid)) throw new Error('aiMemoryFirestorePath: uid non valido');
  return ['users', uid, 'ai_specialization_memory', 'current'].join('/');
}

/**
 * Mirror locale: il documento globale mantiene il nome storico, gli utenti
 * hanno un file per uid accanto ad esso (mai lo stesso file).
 */
export function aiMemoryLocalFileName(uid: string): string {
  if (!isScopedMemoryUid(uid)) throw new Error('aiMemoryLocalFileName: uid non valido');
  return uid === AI_MEMORY_LEGACY_OWNER
    ? 'ai_specialization_memory.json'
    : `ai_specialization_memory.${uid}.json`;
}

/**
 * Hash deterministico del campione: id unici, ordinati, poi SHA-256.
 *
 * Serve a dire su quale dataset è stata scritta una regola. `null` quando non
 * c'è nemmeno un id: un hash di un campione vuoto sarebbe una firma inventata.
 */
export function computeDatasetHash(trades: unknown): string | null {
  if (!Array.isArray(trades)) return null;
  const ids = new Set<string>();
  for (const trade of trades) {
    if (!trade || typeof trade !== 'object') continue;
    const raw = (trade as Record<string, unknown>).id;
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id.length > 0) ids.add(id);
  }
  if (ids.size === 0) return null;
  const canonical = [...ids].sort().join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Proprietario effettivo: le regole storiche senza campo appartengono al globale. */
export function ownerUidOf(insight: AILearnedInsight): string {
  return typeof insight.ownerUid === 'string' && insight.ownerUid.trim().length > 0
    ? insight.ownerUid
    : AI_MEMORY_LEGACY_OWNER;
}

/**
 * Migrazione idempotente: una regola già scritta resta, ma dichiara di chi è.
 * Non cambia direttive, confidenze o date: solo la proprietà.
 */
export function migrateLegacyMemory(memory: readonly AILearnedInsight[]): AILearnedInsight[] {
  return memory.map((insight) =>
    typeof insight.ownerUid === 'string' && insight.ownerUid.trim().length > 0
      ? insight
      : { ...insight, ownerUid: AI_MEMORY_LEGACY_OWNER }
  );
}

/**
 * Cosa vede un utente: le proprie regole più quelle storiche globali, marcate
 * `legacy` perché chi legge sappia che non sono sue e non le ha validate.
 */
export function filterMemoryForUser(
  memory: readonly AILearnedInsight[],
  uid: string
): AILearnedInsight[] {
  const own: AILearnedInsight[] = [];
  const legacy: AILearnedInsight[] = [];
  for (const insight of memory) {
    const owner = ownerUidOf(insight);
    if (owner === uid) own.push({ ...insight, ownerUid: uid });
    else if (owner === AI_MEMORY_LEGACY_OWNER) legacy.push({ ...insight, ownerUid: owner, legacy: true });
  }
  return [...legacy, ...own];
}

/** Firma la proprietà di una regola nuova. */
export function stampInsightOwner(insight: AILearnedInsight, ownerUid: string): AILearnedInsight {
  if (!isScopedMemoryUid(ownerUid)) throw new Error('stampInsightOwner: ownerUid non valido');
  return { ...insight, ownerUid, legacy: false };
}

/**
 * Firma l'autore e il campione di una regola nuova, dentro `provenance`.
 * I campi passati restano `null` quando il dato manca: non si inventa un autore.
 */
export function stampInsightProvenance(
  insight: AILearnedInsight,
  writer: { writerUid: string; datasetHash: string | null; runId: string | null }
): AILearnedInsight {
  const base = insight.provenance ?? { promptVersion: null, model: null, evidenceRefs: [] };
  return {
    ...insight,
    provenance: {
      ...base,
      writerUid: writer.writerUid,
      datasetHash: writer.datasetHash,
      runId: writer.runId,
    },
  };
}
