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

import { randomUUID } from 'node:crypto';
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

/**
 * Versione dichiarata del nucleo con cui il record e' stato prodotto.
 *
 * `shadowV1Live@1`: barre con `t > decidedAtMs`, stop in gap a −1 R fisso.
 * `shadowV1Live@2` (P18): barra della decisione utilizzabile (`t >= decidedAtMs`)
 * e stop in gap all'apertura con R di prezzo, anche sulla barra di fill.
 * `shadowV1Live@3` (P18b): come `@2`, ma il gap all'apertura vale solo sulle
 * barre successive a quella di fill: una barra di fill che apre oltre lo stop
 * esce a `stopLossLevel` con `r = −1` esatto (`@2` poteva registrare un R
 * peggiore di −1).
 *
 * I record gia' scritti (`@2`, `@1` o senza campo) conservano la versione con cui
 * sono nati: sono metodo precedente, non vengono ricalcolati ne' riscritti e le
 * metriche li contano separatamente (`metricsLegacy`).
 *
 * Un record non terminale aggiornato dal collector prende la versione corrente
 * solo se non ha ancora un `fillBarTs` (P18c): la versione e' quella del metodo
 * che ha fissato l'ingresso. Un `@2` gia' riempito resta `@2` anche se chiude o
 * resta aperto sotto `@3`, e il suo `fillBarTs` non viene riscritto.
 */
export const SHADOW_V1_LIVE_MODULE_VERSION = 'shadowV1Live@3';

/**
 * Percorso di produzione (E3). Non usato dalle funzioni: il chiamante lo passa
 * esplicitamente, cosi' i test non toccano mai `artifacts/`.
 */
export const SHADOW_V1_LIVE_SIGNALS_PATH = 'artifacts/shadow_v1_live/signals.jsonl';

/**
 * Provenienza di un record. 'client' = route HTTP dal browser, 'server-scanner' =
 * emissione server-side. E' un'etichetta informativa, non un controllo di
 * sicurezza e non un'attestazione: la route HTTP non autentica l'origine del
 * setup. I record scritti prima di questo campo non lo hanno e restano validi.
 */
export type ShadowV1LiveRecordSource = 'client' | 'server-scanner';

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
  /**
   * Versione del nucleo che ha prodotto il record. Assente nei record scritti
   * prima dell'introduzione del campo: quelli sono metodo v1 e non vengono
   * riscritti ne' ricalcolati (P18).
   */
  moduleVersion?: string;
  updatedAtMs: number;
  /** Opzionale: assente nei record scritti prima dell'introduzione del campo. */
  source?: ShadowV1LiveRecordSource;
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
  /** Provenienza da persistere sui nuovi record; assente = nessuna etichetta. */
  source?: ShadowV1LiveRecordSource;
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
  source?: ShadowV1LiveRecordSource;
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
    ...(context.source ? { source: context.source } : {}),
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
      ...(observation.source ? { source: observation.source } : {}),
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
  // `decidedAtMs` e `firstSeenAtMs` restano quelli della prima volta.
  //
  // Versione (P18c): la versione e' quella del metodo che ha fissato l'ingresso,
  // cioe' che ha prodotto `fillBarTs`. Se il record ha gia' un `fillBarTs` di un
  // metodo precedente (`@2`, `@1` o campo assente), ne' la versione ne' l'istante
  // di ingresso cambiano: chiudere il record sotto il metodo nuovo non rende
  // l'ingresso attribuibile ad esso, quindi il record resta fuori dalla headline
  // e finisce in `metricsLegacy`. Solo un record senza `fillBarTs`
  // (PENDING_FILL) che riceve il primo fill prende la versione corrente. I
  // terminali non si toccano (uscita anticipata sopra) e i record invariati non
  // cambiano nulla (UNCHANGED).
  const entryFromPreviousMethod =
    existing.fillBarTs !== null && existing.moduleVersion !== SHADOW_V1_LIVE_MODULE_VERSION;
  const updated: PersistedShadowV1LiveRecord = {
    ...existing,
    status: observation.status,
    r: observation.r,
    reason: observation.reason,
    fillBarTs: entryFromPreviousMethod ? existing.fillBarTs : observation.fillBarTs,
    exitBarTs: observation.exitBarTs,
    exitPrice: observation.exitPrice,
    moduleVersion:
      existing.fillBarTs !== null ? existing.moduleVersion : SHADOW_V1_LIVE_MODULE_VERSION,
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

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Record conforme allo schema v=1 scritto da `upsertObservation`.
 *
 * Serve a impedire che una riga troncata o modificata a mano propaghi
 * `undefined`/`NaN` in `byOrder`, nei conteggi e nelle metriche: quei valori non
 * fanno fallire il parsing JSON, ma rompono silenziosamente l'ordinamento e le
 * medie. Lo schema su disco non cambia: qui si accetta esattamente cio' che lo
 * store scrive, campi extra compresi (compatibilita' in avanti).
 */
export function isValidPersistedRecord(value: unknown): value is PersistedShadowV1LiveRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (r.v !== SHADOW_V1_LIVE_STORE_VERSION) return false;
  if (typeof r.key !== 'string' || r.key.trim().length === 0) return false;
  if (typeof r.ticker !== 'string' || r.ticker.trim().length === 0) return false;
  if (r.market !== 'EU' && r.market !== 'US') return false;
  if (r.direction !== 'LONG' && r.direction !== 'SHORT') return false;
  for (const field of ['entry', 'stop', 'target'] as const) {
    const n = r[field];
    if (!isFiniteNumber(n) || n <= 0) return false;
  }
  for (const field of ['decidedAtMs', 'sessionCloseMs', 'firstSeenAtMs', 'updatedAtMs'] as const) {
    if (!isFiniteNumber(r[field])) return false;
  }
  if (!isPersistableStatus(r.status as ShadowV1LiveStatus)) return false;
  if (r.r !== null && !isFiniteNumber(r.r)) return false;
  if (r.reason !== null && typeof r.reason !== 'string') return false;
  for (const field of ['fillBarTs', 'exitBarTs', 'exitPrice'] as const) {
    const v = r[field];
    if (v !== null && !isFiniteNumber(v)) return false;
  }
  // `moduleVersion` e' opzionale: un record senza campo e' legacy (metodo v1),
  // non fuori schema. Se presente deve essere una stringa non vuota.
  if (r.moduleVersion !== undefined && (typeof r.moduleVersion !== 'string' || r.moduleVersion.length === 0)) {
    return false;
  }
  // `source` e' opzionale (record storici); se presente deve essere una stringa
  // non vuota. Un valore nuovo di una versione futura non invalida il record.
  if (r.source !== undefined && (typeof r.source !== 'string' || r.source.length === 0)) {
    return false;
  }
  return true;
}

/**
 * Legge il JSONL. File assente o illeggibile => elenco vuoto. Righe corrotte,
 * versione sconosciuta o record fuori schema vengono saltati e contati. Non
 * lancia mai.
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
    if (!isValidPersistedRecord(parsed)) {
      skipped += 1;
      continue;
    }
    records.push(parsed);
  }
  return { records, skipped };
}

/**
 * Nome del file temporaneo di una scrittura, univoco per processo e per chiamata
 * (`pid` + UUID): due scritture concorrenti, anche di processi diversi, non
 * possono sovrascriversi il temporaneo prima del rename.
 */
export function shadowV1LiveTmpPath(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${randomUUID()}`;
}

/**
 * Scrittura atomica: tmp univoco nella stessa directory + rename. Crea la
 * directory se manca. In caso di errore rimuove **solo** il proprio temporaneo
 * e ritorna `{ ok: false, error }` senza lanciare: il chiamante deve poter
 * proseguire anche con la persistenza rotta.
 */
export function writeRecordsAtomic(
  filePath: string,
  records: readonly PersistedShadowV1LiveRecord[]
): WriteResult {
  const ordered = [...records].sort(byOrder);
  const content = ordered.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const dir = path.dirname(filePath);
  const tmpPath = shadowV1LiveTmpPath(filePath);
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
