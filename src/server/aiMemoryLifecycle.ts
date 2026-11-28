/**
 * Ciclo di vita di una regola di memoria (Fase 4).
 *
 * Una regola scritta non resta vera per sempre: la FDR corregge la famiglia
 * dentro una esecuzione, non nel tempo. Qui vive la sola parte pura: scadenza,
 * attività, revoca e il testo iniettato nel prompt.
 *
 * Regola di disciplina: una regola senza `validUntil` o senza test recente non
 * entra nel prompt. Le regole storiche ricevono una scadenza derivata dal loro
 * `learnedAt` (migrazione), così nessuna diventa eterna per omissione.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AILearnedInsight } from '../types/radar';

/** Durata dichiarata di una regola, dalla scrittura o dall'ultimo re-test. */
export const AI_MEMORY_RULE_TTL_DAYS = 90;
export const AI_MEMORY_RULE_TTL_MS = AI_MEMORY_RULE_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Registro append-only delle revoche. */
export const AI_MEMORY_REVOCATION_LOG_RELATIVE_PATH = 'logs/ai_memory_revocations.jsonl';

/** Motivo di revoca quando il predicato non supera più i gate. */
export const AI_MEMORY_REVOCATION_RETEST_FAILED = 'RIGATES_FALLITI';

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Scadenza derivata: `learnedAt` + 90 giorni (o `now` se la data non è leggibile). */
export function ruleExpiryIso(learnedAt: unknown, nowMs: number): string {
  const base = parseMs(learnedAt) ?? nowMs;
  return new Date(base + AI_MEMORY_RULE_TTL_MS).toISOString();
}

/**
 * Migrazione dei campi di ciclo di vita. Idempotente: chi li ha già non cambia.
 * `lastTestedAt` non si inventa come "adesso": la regola è stata testata quando
 * è stata scritta, quindi si usa `learnedAt`.
 */
export function applyLifecycleDefaults(entry: AILearnedInsight, nowMs = Date.now()): AILearnedInsight {
  const validUntil =
    parseMs(entry.validUntil) !== null ? entry.validUntil : ruleExpiryIso(entry.learnedAt, nowMs);
  const lastTestedAt = parseMs(entry.lastTestedAt) !== null ? entry.lastTestedAt : entry.learnedAt;
  const testCount =
    typeof entry.testCount === 'number' && Number.isFinite(entry.testCount) && entry.testCount >= 1
      ? entry.testCount
      : 1;
  return { ...entry, validUntil, lastTestedAt, testCount };
}

/**
 * Una regola è attiva solo se: non revocata, con scadenza futura, testata negli
 * ultimi 90 giorni. Ogni condizione mancante vale "non attiva": un dato assente
 * non è una promessa di validità.
 */
export function isRuleActive(entry: AILearnedInsight, nowMs: number): boolean {
  if (typeof entry.revokedAt === 'string' && entry.revokedAt.trim().length > 0) return false;
  const validUntil = parseMs(entry.validUntil);
  if (validUntil === null || validUntil <= nowMs) return false;
  const lastTested = parseMs(entry.lastTestedAt);
  if (lastTested === null) return false;
  if (nowMs - lastTested > AI_MEMORY_RULE_TTL_MS) return false;
  return true;
}

/**
 * Regole iniettabili: validate (`confidence != null`) e attive.
 * L'ordine è quello della memoria, così il prompt resta deterministico.
 */
export function selectActiveRules(memory: readonly AILearnedInsight[], nowMs: number): AILearnedInsight[] {
  return memory.filter((entry) => entry.confidence != null && isRuleActive(entry, nowMs));
}

/** Re-test superato: la regola si rinnova e il contatore cresce di uno. */
export function stampTestedRule(entry: AILearnedInsight, nowMs: number): AILearnedInsight {
  return {
    ...entry,
    validUntil: new Date(nowMs + AI_MEMORY_RULE_TTL_MS).toISOString(),
    lastTestedAt: new Date(nowMs).toISOString(),
    testCount:
      typeof entry.testCount === 'number' && Number.isFinite(entry.testCount) ? entry.testCount + 1 : 1,
    revokedAt: null,
    revocationReason: null,
  };
}

/** Revoca: la regola resta nel file, con data e motivo. Non si cancella nulla. */
export function revokeRule(entry: AILearnedInsight, reason: string, nowMs: number): AILearnedInsight {
  return {
    ...entry,
    revokedAt: new Date(nowMs).toISOString(),
    revocationReason: reason,
  };
}

export interface LearningPredicateRowLike {
  predicateId: string;
  /**
   * Topic con cui la scansione scrive la regola (`PREDICATO_<id>`). Se assente
   * si deriva da `predicateId`: e' l'unico punto in cui il nome viene costruito.
   */
  topic?: string | null;
  tested: boolean;
  passesGates: boolean;
  n: number;
}

/**
 * Topic reale di una riga di scansione.
 *
 * La scansione chiama `validateLearningPattern(..., `PREDICATO_${predicateId}`)`:
 * confrontare `row.predicateId` con `entry.topic` non trovava mai nulla, quindi
 * revoca e rinnovo non scattavano mai.
 */
export function ruleTopicForPredicateRow(row: LearningPredicateRowLike): string {
  const explicit = typeof row.topic === 'string' ? row.topic.trim() : '';
  return explicit.length > 0 ? explicit : `PREDICATO_${row.predicateId}`;
}

export interface MemoryRenewal {
  at: string;
  topic: string;
  testCount: number;
}

export interface RenewalOutcome {
  memory: AILearnedInsight[];
  renewed: MemoryRenewal[];
}

/**
 * Rinnova le regole il cui predicato e' stato ri-testato con successo.
 *
 * Non dipende dal modello: un re-test deterministico che passa e' un fatto, e la
 * regola non deve scadere perche' nessuna LLM ha risposto. Una regola revocata
 * resta revocata: il rinnovo non annulla una decisione gia' presa.
 */
export function renewRulesForPassingPredicates(
  own: readonly AILearnedInsight[],
  rows: readonly LearningPredicateRowLike[],
  nowMs: number,
  /**
   * Topic che lo stesso run riscriverà tramite `updateAIMemory`: quel percorso
   * incrementa già il contatore, quindi rinnovarli anche qui conterebbe due
   * volte lo stesso re-test.
   */
  skipTopics: ReadonlySet<string> = new Set<string>()
): RenewalOutcome {
  const passing = new Set(rows.filter((row) => row.tested && row.passesGates).map(ruleTopicForPredicateRow));
  const renewed: MemoryRenewal[] = [];
  const memory = own.map((entry) => {
    if (typeof entry.revokedAt === 'string' && entry.revokedAt.trim().length > 0) return entry;
    if (!passing.has(entry.topic)) return entry;
    if (skipTopics.has(entry.topic)) return entry;
    const next = stampTestedRule(entry, nowMs);
    renewed.push({
      at: new Date(nowMs).toISOString(),
      topic: entry.topic,
      testCount: typeof next.testCount === 'number' ? next.testCount : 1,
    });
    return next;
  });
  return { memory, renewed };
}

export interface MemoryRevocation {
  at: string;
  topic: string;
  ownerUid: string | null;
  reason: string;
  sampleSize: number | null;
}

export interface RevocationOutcome {
  memory: AILearnedInsight[];
  revoked: MemoryRevocation[];
}

/**
 * Revoca le regole il cui predicato è stato ri-testato e non passa più i gate.
 *
 * Solo predicati **testati** (`n` sufficiente) e **falliti** revocano: un
 * predicato senza campione non è una smentita, è silenzio, e non tocca la
 * regola. Le regole già revocate non producono una seconda voce.
 */
export function revokeRulesForFailedPredicates(
  own: readonly AILearnedInsight[],
  rows: readonly LearningPredicateRowLike[],
  nowMs: number
): RevocationOutcome {
  const failed = new Map<string, number>();
  for (const row of rows) {
    if (row.tested && !row.passesGates) failed.set(ruleTopicForPredicateRow(row), row.n);
  }
  const revoked: MemoryRevocation[] = [];
  const memory = own.map((entry) => {
    if (typeof entry.revokedAt === 'string' && entry.revokedAt.trim().length > 0) return entry;
    if (!failed.has(entry.topic)) return entry;
    revoked.push({
      at: new Date(nowMs).toISOString(),
      topic: entry.topic,
      ownerUid: typeof entry.ownerUid === 'string' ? entry.ownerUid : null,
      reason: AI_MEMORY_REVOCATION_RETEST_FAILED,
      sampleSize: failed.get(entry.topic) ?? null,
    });
    return revokeRule(entry, AI_MEMORY_REVOCATION_RETEST_FAILED, nowMs);
  });
  return { memory, revoked };
}

function formatQ(confidence: number): string {
  // `confidence` e' 100*(1-q). Si mostra q, che e' un p-value aggiustato,
  // e non una percentuale: il modello non deve leggerlo come probabilita'.
  const q = Math.max(0, Math.min(1, (100 - confidence) / 100));
  return q.toFixed(3).replace('.', ',');
}

function formatDate(iso: unknown): string {
  const ms = parseMs(iso);
  if (ms === null) return 'non dichiarata';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Blocco da iniettare nel prompt: nessun simbolo `%`.
 * Ogni riga porta q, n, scadenza e modello, così la regola è leggibile e
 * verificabile invece di essere un'affermazione autorevole.
 */
export function buildMemoryPromptBlock(active: readonly AILearnedInsight[], nowMs: number): string {
  return active
    .map((entry, index) => {
      const parts: string[] = [];
      if (entry.confidence != null) parts.push(`q ${formatQ(entry.confidence)}`);
      parts.push(`n ${typeof entry.sampleSize === 'number' ? entry.sampleSize : 'non dichiarato'}`);
      parts.push(`valida fino al ${formatDate(entry.validUntil)}`);
      parts.push(`modello ${entry.provenance?.model ?? 'non dichiarato'}`);
      if (entry.legacy === true) parts.push('regola storica');
      const age = typeof entry.lastTestedAt === 'string' ? formatDate(entry.lastTestedAt) : 'non dichiarato';
      parts.push(`ultimo test ${age}`);
      return `[Pattern statistico ${index + 1} - ${entry.topic} (${entry.market})]: ${entry.directive} (${parts.join(' · ')})`;
    })
    .join('\n');
}

/** Scrittura append-only del registro revoche; best-effort, come gli altri log. */
export function appendRevocationLog(entries: readonly MemoryRevocation[], filePath: string): number {
  if (entries.length === 0) return 0;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
    return entries.length;
  } catch (error) {
    console.warn('[AI Memory] Registro revoche non scrivibile:', error);
    return 0;
  }
}
