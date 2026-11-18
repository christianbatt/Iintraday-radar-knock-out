/**
 * SHADOW V1 LIVE — store dei record osservati.
 *
 * Persistenza passiva dei lifecycle V1-live: idempotenza per chiave, transizioni
 * monotone, stati terminali immutabili, ricostruzione delle chiavi gia' viste.
 * Utilizzato solo dai moduli passivi lato server (`shadowV1LiveCollector` e
 * `shadowV1LiveView`); i test usano esclusivamente directory temporanee.
 *
 * Formato: JSONL, un record per riga, ordine deterministico per `decidedAtMs` e poi
 * `key`. Scrittura atomica (tmp nella stessa directory + rename), come
 * `writeFileAtomic` di `src/server/shadowV2Collector.ts:96-104`. Nessuna retention:
 * il file cresce e la compattazione e' fuori scope.
 *
 * Regole:
 * - `INVALID_SETUP` e `DUPLICATE` non vengono mai persistiti (E9).
 * - `decidedAtMs` e' il PRIMO istante osservato e non viene mai sovrascritto.
 * - Ordine degli stati: `PENDING_FILL` < `OPEN` < terminali
 *   (`STOP`, `TARGET`, `EXPIRED`, `NOT_FILLED`). Un terminale non torna indietro e
 *   non viene mai riscritto; una regressione viene rifiutata.
 * - `stale` non e' persistito: si calcola a lettura (`isStale`).
 * - Ogni errore di I/O viene restituito, mai lanciato: un guasto dello store non deve
 *   poter fermare il chiamante.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  ShadowV1LiveBar,
  ShadowV1LiveInput,
  ShadowV1LiveResult,
  ShadowV1LiveSetup,
  ShadowV1LiveStatus,
} from '../knowledge/shadowV1Live';

/** Versione del formato su disco. Record con `v` diversa vengono ignorati a lettura. */
export const SHADOW_V1_LIVE_STORE_VERSION = 1;

/** Versione dichiarata del nucleo con cui il record e' stato prodotto. */
export const SHADOW_V1_LIVE_MODULE_VERSION = 'shadowV1Live@1';

/**
 * Percorso di produzione (E3). Non usato dalle funzioni: il chiamante lo passa
 * esplicitamente, cosi' i test non toccano mai `artifacts/`.
 */
export const SHADOW_V1_LIVE_SIGNALS_PATH = 'artifacts/shadow_v1_live/signals.jsonl';

/** Stati che possono stare su disco. */
export type PersistableShadowV1LiveStatus =
  | 'PENDING_FILL'
  | 'OPEN'
  | 'STOP'
  | 'TARGET'
  | 'EXPIRED'
  | 'NOT_FILLED';

export interface PersistedShadowV1LiveRecord {
  v: number;
  key: string;
  ticker: string;
  market: 'EU' | 'US';
  direction: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  target: number;
  /** Primo `decidedAtMs` osservato: mai sovrascritto. */
  decidedAtMs: number;
  sessionCloseMs: number;
  firstSeenAtMs: number;
  status: PersistableShadowV1LiveStatus;
  r: number | null;
  reason: string | null;
  fillBarTs: number | null;
  exitBarTs: number | null;
  exitPrice: number | null;
  moduleVersion: string;
  updatedAtMs: number;
}

/** Contesto minimo che il chiamante conosce del setup emesso. */
export interface ShadowV1LiveObservationContext {
  ticker: string;
  market: 'EU' | 'US';
  direction: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  target: number;
  decidedAtMs: number;
  sessionCloseMs: number;
}

export interface ShadowV1LiveObservation {
  key: string;
  ticker: string;
  market: 'EU' | 'US';
  direction: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  target: number;
  decidedAtMs: number;
  sessionCloseMs: number;
  status: PersistableShadowV1LiveStatus;
  r: number | null;
  reason: string | null;
  fillBarTs: number | null;
  exitBarTs: number | null;
  exitPrice: number | null;
}

export type UpsertOutcome =
  | 'INSERTED'
  | 'UPDATED'
  | 'UNCHANGED'
  | 'REJECTED_TERMINAL'
  | 'REJECTED_REGRESSION'
  | 'SKIPPED_NOT_PERSISTABLE';

export interface UpsertResult {
  records: PersistedShadowV1LiveRecord[];
  changed: boolean;
  outcome: UpsertOutcome;
}

export type LoadResult = {
  records: PersistedShadowV1LiveRecord[];
  skipped: number;
};

export type WriteResult = { ok: true } | { ok: false; error: string };

function isPersistableStatus(status: ShadowV1LiveStatus): status is PersistableShadowV1LiveStatus {
  return (
    status === 'PENDING_FILL' ||
    status === 'OPEN' ||
    status === 'STOP' ||
    status === 'TARGET' ||
    status === 'EXPIRED' ||
    status === 'NOT_FILLED'
  );
}

/** `PENDING_FILL` 0, `OPEN` 1, terminali 2. */
function statusRank(status: PersistableShadowV1LiveStatus): number {
  if (status === 'PENDING_FILL') return 0;
  if (status === 'OPEN') return 1;
  return 2;
}

function isTerminal(status: PersistableShadowV1LiveStatus): boolean {
  return statusRank(status) === 2;
}

function byOrder(
  a: PersistedShadowV1LiveRecord,
  b: PersistedShadowV1LiveRecord
): number {
  if (a.decidedAtMs !== b.decidedAtMs) return a.decidedAtMs - b.decidedAtMs;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Costruisce l'osservazione da persistere a partire dal contesto del setup e dal
 * risultato del nucleo. `null` per `INVALID_SETUP`/`DUPLICATE` (E9) o se il nucleo
 * non ha prodotto una chiave: quei casi non entrano nello store.
 */
export function observationFromResult(
  context: ShadowV1LiveObservationContext,
  result: ShadowV1LiveResult
): ShadowV1LiveObservation | null {
  if (!isPersistableStatus(result.status)) return null;
  if (typeof result.key !== 'string' || result.key.length === 0) return null;
  return {
    key: result.key,
    ticker: context.ticker,
    market: context.market,
    direction: context.direction,
    entry: context.entry,
    stop: context.stop,
    target: context.target,
    decidedAtMs: context.decidedAtMs,
    sessionCloseMs: context.sessionCloseMs,
    status: result.status,
    r: result.r,
    reason: result.reason,
    fillBarTs: result.fillBarTs,
    exitBarTs: result.exitBarTs,
    exitPrice: result.exitPrice,
  };
}

function samePayload(
  record: PersistedShadowV1LiveRecord,
  observation: ShadowV1LiveObservation
): boolean {
  return (
    record.status === observation.status &&
    record.r === observation.r &&
    record.reason === observation.reason &&
    record.fillBarTs === observation.fillBarTs &&
    record.exitBarTs === observation.exitBarTs &&
    record.exitPrice === observation.exitPrice
  );
}

/**
 * Applica un'osservazione all'elenco dei record. Funzione pura: non muta `records`
 * ne' `observation` e restituisce un nuovo array ordinato.
 */
export function upsertObservation(
  records: readonly PersistedShadowV1LiveRecord[],
  observation: ShadowV1LiveObservation,
  nowMs: number
): UpsertResult {
  if (!isPersistableStatus(observation.status)) {
    return { records: [...records], changed: false, outcome: 'SKIPPED_NOT_PERSISTABLE' };
  }

  const index = records.findIndex((r) => r.key === observation.key);

  if (index === -1) {
    const inserted: PersistedShadowV1LiveRecord = {
      v: SHADOW_V1_LIVE_STORE_VERSION,
      key: observation.key,
      ticker: observation.ticker,
      market: observation.market,
      direction: observation.direction,
      entry: observation.entry,
      stop: observation.stop,
      target: observation.target,
      decidedAtMs: observation.decidedAtMs,
      sessionCloseMs: observation.sessionCloseMs,
      firstSeenAtMs: nowMs,
      status: observation.status,
      r: observation.r,
      reason: observation.reason,
      fillBarTs: observation.fillBarTs,
      exitBarTs: observation.exitBarTs,
      exitPrice: observation.exitPrice,
      moduleVersion: SHADOW_V1_LIVE_MODULE_VERSION,
      updatedAtMs: nowMs,
    };
    const next = [...records, inserted].sort(byOrder);
    return { records: next, changed: true, outcome: 'INSERTED' };
  }

  const existing = records[index];

  if (existing.status === observation.status && samePayload(existing, observation)) {
    return { records: [...records], changed: false, outcome: 'UNCHANGED' };
  }

  // Terminale: immutabile. Una differenza viene rifiutata, non assorbita.
  if (isTerminal(existing.status)) {
    return { records: [...records], changed: false, outcome: 'REJECTED_TERMINAL' };
  }

  if (statusRank(observation.status) < statusRank(existing.status)) {
    return { records: [...records], changed: false, outcome: 'REJECTED_REGRESSION' };
  }

  // Non terminale -> non terminale (OPEN dopo PENDING_FILL) oppure -> terminale.
  // `decidedAtMs`, `firstSeenAtMs` e `moduleVersion` restano quelli della prima volta.
  const updated: PersistedShadowV1LiveRecord = {
    ...existing,
    status: observation.status,
    r: observation.r,
    reason: observation.reason,
    fillBarTs: observation.fillBarTs,
    exitBarTs: observation.exitBarTs,
    exitPrice: observation.exitPrice,
    updatedAtMs: nowMs,
  };
  const next = [...records];
  next[index] = updated;
  return { records: next, changed: true, outcome: 'UPDATED' };
}

/** Tutte le chiavi persistite: e' cio' che il chiamante passa come `seenKeys`. */
export function buildSeenKeys(
  records: readonly PersistedShadowV1LiveRecord[]
): Set<string> {
  return new Set(records.map((r) => r.key));
}

/**
 * Ricostruisce l'input del nucleo per rivalutare un record non terminale.
 *
 * `seenKeys` esclude la chiave del record stesso: il nucleo risponderebbe
 * `DUPLICATE` e non aggiornerebbe mai il lifecycle. Serve l'elenco completo dei
 * record per ricavare le altre chiavi (parametro aggiuntivo rispetto alla bozza).
 * Il setup usa solo campi reali del tipo del nucleo.
 */
export function toCoreInput(
  record: PersistedShadowV1LiveRecord,
  nowMs: number,
  bars: readonly ShadowV1LiveBar[],
  records: readonly PersistedShadowV1LiveRecord[]
): ShadowV1LiveInput {
  const setup: ShadowV1LiveSetup = {
    candidate: { ticker: record.ticker },
    decision: 'TRADE',
    direction: record.direction,
    triggerLevel: record.entry,
    entryLevel: record.entry,
    stopLossLevel: record.stop,
    target1Level: record.target,
  };
  const seenKeys = Array.from(buildSeenKeys(records)).filter((k) => k !== record.key);
  return {
    setup,
    decidedAtMs: record.decidedAtMs,
    sessionCloseMs: record.sessionCloseMs,
    nowMs,
    bars,
    seenKeys,
  };
}

/** `stale` a lettura: solo per stati non terminali oltre la chiusura di sessione. */
export function isStale(record: PersistedShadowV1LiveRecord, nowMs: number): boolean {
  if (record.status !== 'PENDING_FILL' && record.status !== 'OPEN') return false;
  return nowMs > record.sessionCloseMs;
}

/**
 * Legge il JSONL. File assente o illeggibile => elenco vuoto. Righe corrotte o con
 * `v` sconosciuta vengono saltate e contate. Non lancia mai.
 */
export function loadRecords(filePath: string): LoadResult {
  const records: PersistedShadowV1LiveRecord[] = [];
  let skipped = 0;
  let raw: string;
  try {
    if (!fs.existsSync(filePath)) return { records, skipped };
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { records, skipped };
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed as { v?: unknown }).v !== SHADOW_V1_LIVE_STORE_VERSION ||
      typeof (parsed as { key?: unknown }).key !== 'string'
    ) {
      skipped += 1;
      continue;
    }
    records.push(parsed as PersistedShadowV1LiveRecord);
  }
  return { records, skipped };
}

/**
 * Scrittura atomica: tmp nella stessa directory + rename. Crea la directory se
 * manca. In caso di errore ritorna `{ ok: false, error }` senza lanciare: il
 * chiamante deve poter proseguire anche con la persistenza rotta.
 */
export function writeRecordsAtomic(
  filePath: string,
  records: readonly PersistedShadowV1LiveRecord[]
): WriteResult {
  const ordered = [...records].sort(byOrder);
  const content = ordered.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
    return { ok: true };
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    } catch {
      // best effort: nessuna eccezione deve uscire
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
