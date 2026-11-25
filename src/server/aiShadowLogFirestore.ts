/**
 * Sync del log shadow AI su Firestore (Fase 8-9).
 *
 * Replica il pattern di `shadowFirestoreSync.ts`: stesso adapter
 * (`ShadowFirestoreAdapter` di `shadowFirestoreSync`), nessun secondo client
 * Firestore, nessuna inizializzazione parallela, batching a blocchi di 400
 * delegato a `batchSetDocs`. Nessuna eccezione viene propagata al chiamante:
 * ogni errore produce solo un `console.warn` e un risultato `{ ok: false }`.
 *
 * Feature flag: `SHADOW_AI_LOG_FIRESTORE`, default `'0'` (spento). Con il flag
 * spento questo modulo non esegue nessuna chiamata Firestore: la guardia sta
 * prima di qualunque accesso all'adapter.
 *
 * Doc id deterministico `${runId}__${ticker}`: riscrivere la stessa coppia
 * runId/ticker non duplica il documento (stesso path, `set` con `merge`).
 *
 * NOTA TTL: `expiresAt` viene scritta come `Timestamp` a now + 90 giorni, ma la
 * policy TTL che la rende effettiva e' un passo da console/GCP (Firestore ->
 * TTL): finche' non viene creata, il campo e' solo un dato e nulla scade.
 */

import { Timestamp } from 'firebase-admin/firestore';
import {
  getShadowFirestoreAdapter,
  type ShadowFirestoreAdapter,
} from './shadowFirestoreSync';

/** Flag: spento di default, acceso solo con il valore esatto `'1'`. */
export const AI_SHADOW_LOG_FIRESTORE_FLAG = 'SHADOW_AI_LOG_FIRESTORE';
/** Collection del log AI: stessa convenzione `_system/<area>/<collezione>`. */
export const AI_SHADOW_LOG_FIRESTORE_COLLECTION = '_system/ai_shadow_log/entries';
/** Dimensione dei blocchi di scrittura, identica a `shadowFirestoreSync`. */
export const AI_SHADOW_LOG_FIRESTORE_BATCH_MAX = 400;
/** Giorni di conservazione dichiarati in `expiresAt`. */
export const AI_SHADOW_LOG_FIRESTORE_TTL_DAYS = 90;

export interface AiShadowLogFirestoreSyncResult {
  ok: boolean;
  written: number;
  error?: string;
}

export interface AiShadowLogFirestoreReadItem {
  docId: string;
  entry: Record<string, unknown>;
}

/** Flag del sync: spento di default, acceso solo con `'1'`. */
export function isAiShadowLogFirestoreEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[AI_SHADOW_LOG_FIRESTORE_FLAG] === '1';
}

/**
 * Doc id deterministico. `runId` e' un UUID (nessun `/`, nessun `:`), ma il
 * ticker puo' contenere caratteri speciali: ogni `/` viene sostituito con `_`
 * perche' Firestore non accetta `/` in un id di documento.
 */
export function aiShadowLogDocId(runId: string, ticker: string): string {
  return `${runId}__${ticker}`.replace(/\//g, '_');
}

/**
 * Doc id di una entry: `runId__ticker` quando entrambi sono presenti, altrimenti
 * l'`id` della entry (righe senza runId o senza ticker, es. NESSUN_CANDIDATO).
 */
export interface AiShadowLogDocIdSource {
  id?: unknown;
  runId?: unknown;
  ticker?: unknown;
}

export function aiShadowLogEntryDocId(entry: AiShadowLogDocIdSource): string | null {
  const runId = typeof entry.runId === 'string' && entry.runId.length > 0 ? entry.runId : null;
  const ticker = typeof entry.ticker === 'string' && entry.ticker.length > 0 ? entry.ticker : null;
  if (runId !== null && ticker !== null) return aiShadowLogDocId(runId, ticker);
  if (typeof entry.id === 'string' && entry.id.length > 0) return entry.id.replace(/\//g, '_');
  return null;
}

function createdAtMillis(value: unknown): number {
  if (value && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    try {
      return (value as { toMillis: () => number }).toMillis();
    } catch {
      return 0;
    }
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

/**
 * Scrive le entry su Firestore con lo stesso adapter di `shadowFirestoreSync`.
 * Non lancia mai: in errore ritorna `{ ok: false, written: 0 }`.
 * Con il flag spento non tocca l'adapter (zero chiamate, zero I/O).
 */
/** Copia senza cast: da un oggetto a una mappa di chiavi note. */
function toRecord(entry: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) out[key] = value;
  return out;
}

export async function syncAiShadowLogToFirestore(
  entries: ReadonlyArray<object>,
  options: {
    env?: Record<string, string | undefined>;
    nowMs?: number;
    adapter?: ShadowFirestoreAdapter | null;
  } = {}
): Promise<AiShadowLogFirestoreSyncResult> {
  if (!isAiShadowLogFirestoreEnabled(options.env ?? process.env)) {
    return { ok: true, written: 0 };
  }
  if (entries.length === 0) return { ok: true, written: 0 };
  const adapter = options.adapter === undefined ? getShadowFirestoreAdapter() : options.adapter;
  if (!adapter) return { ok: false, written: 0, error: 'adapter Firestore non disponibile' };

  try {
    const nowMs = options.nowMs ?? Date.now();
    const createdAt = Timestamp.fromMillis(nowMs);
    const expiresAt = Timestamp.fromMillis(
      nowMs + AI_SHADOW_LOG_FIRESTORE_TTL_DAYS * 24 * 60 * 60 * 1000
    );
    const items: Array<{ path: string; data: Record<string, unknown> }> = [];
    for (const entry of entries) {
      const docId = aiShadowLogEntryDocId(entry as AiShadowLogDocIdSource);
      if (docId === null) continue;
      items.push({
        path: `${AI_SHADOW_LOG_FIRESTORE_COLLECTION}/${docId}`,
        data: { ...toRecord(entry), createdAt, expiresAt },
      });
    }
    if (items.length === 0) return { ok: true, written: 0 };
    // `batchSetDocs` dell'adapter scrive con `writeBatch` a blocchi di 400.
    await adapter.batchSetDocs(items);
    return { ok: true, written: items.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[AI Shadow Log Firestore] sync non riuscito:', message);
    return { ok: false, written: 0, error: message };
  }
}

/**
 * Legge fino a `limit` documenti, ordinati per `createdAt` decrescente.
 * `listDocs` dell'adapter non espone query ne' limit: l'ordinamento e il taglio
 * avvengono qui. In errore ritorna `[]` e un `console.warn`, mai un'eccezione.
 */
export async function readAiShadowLogFromFirestore(
  limit: number,
  options: {
    env?: Record<string, string | undefined>;
    adapter?: ShadowFirestoreAdapter | null;
  } = {}
): Promise<AiShadowLogFirestoreReadItem[]> {
  if (!isAiShadowLogFirestoreEnabled(options.env ?? process.env)) return [];
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const adapter = options.adapter === undefined ? getShadowFirestoreAdapter() : options.adapter;
  if (!adapter) return [];

  try {
    const docs = await adapter.listDocs(AI_SHADOW_LOG_FIRESTORE_COLLECTION);
    const items: Array<AiShadowLogFirestoreReadItem & { createdAtMs: number }> = [];
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object') continue;
      const data = doc.data;
      if (!data || typeof data !== 'object') continue;
      items.push({ docId: doc.id, entry: data, createdAtMs: createdAtMillis(data.createdAt) });
    }
    return items
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, Math.floor(limit))
      .map((item) => ({ docId: item.docId, entry: item.entry }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[AI Shadow Log Firestore] lettura non riuscita:', message);
    return [];
  }
}
