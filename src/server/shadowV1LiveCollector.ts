/**
 * SHADOW V1 LIVE — collector passivo lato server.
 *
 * Riceve un setup emesso dal client, lo valuta con il nucleo `shadowV1Live.ts`
 * (nessun ricalcolo di G1-G13: il server non ricostruisce il setup) e lo
 * persiste con `shadowV1LiveStore.ts`. Un ciclo periodico rivaluta i record non
 * terminali sulle barre 5m chiuse raccolte dal server o recuperate in autonomia
 * da Yahoo Finance (EOD / riavvio / titoli usciti dalla watchlist).
 *
 * Interruttore `SHADOW_V1_LIVE_COLLECT`: **acceso di default** (come V2); si
 * spegne solo con `'0'` o `'false'`. A flag OFF la route risponde 404 `disabled`
 * senza alcun I/O, nessun timer parte e `recordBarsForShadowV1Live` ritorna subito.
 *
 * Isolamento (F6): ogni eccezione viene catturata e registrata con
 * `console.warn('[Shadow V1 Live Collector] ...')`; non propaga mai al radar,
 * alle altre route o al ciclo V2. Un errore di scrittura non ferma nulla.
 *
 * Sorgente barre: archivio gemello con cache in memoria (tetto 600 barre/ticker)
 * e persistenza atomica su disco (`artifacts/shadow_v1_live/bars.json` quando il
 * collector e' registrato sul server), piu' recupero autonomo throttled da Yahoo
 * Finance 5m per i record non terminali rimasti scoperti o a fine giornata.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import {
  evaluateShadowV1Live,
  type ShadowV1LiveBar,
} from '../knowledge/shadowV1Live';
import { sessionCloseMsFor, sessionDateFor } from '../utils/sessionClose';
import {
  loadRecords,
  observationFromResult,
  toCoreInput,
  upsertObservation,
  writeRecordsAtomic,
  type LoadResult,
  type PersistedShadowV1LiveRecord,
  type ShadowV1LiveObservationContext,
  type ShadowV1LiveRecordSource,
  type WriteResult,
} from './shadowV1LiveStore';

/**
 * Variabile d'ambiente, solo interruttore di emergenza: il collector e' acceso
 * di default come V2 (che non ha flag) e si spegne solo con `'0'` o `'false'`.
 */
export const SHADOW_V1_LIVE_COLLECT_ENV = 'SHADOW_V1_LIVE_COLLECT';

/** Route di osservazione (POST). */
export const SHADOW_V1_LIVE_OBSERVE_PATH = '/api/shadow/v1-live/observe';

/** Archivio barre persistito su disco relativo alla root progetto. */
export const SHADOW_V1_LIVE_BARS_PATH = 'artifacts/shadow_v1_live/bars.json';

/** Limite esplicito del corpo per questa route (express.json globale: 10 MB). */
export const SHADOW_V1_LIVE_MAX_BODY_BYTES = 8192;

/** Limite proprio della route, piu' stretto di `apiLimiter` (60/min globale). */
export const SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE = 10;

export const SHADOW_V1_LIVE_RATE_WINDOW_MS = 60_000;

/**
 * Tetto della mappa del rate limit (un elemento per IP/UID visto nella finestra).
 * Oltre questa soglia le voci scadute vengono eliminate e, se non basta, le piu'
 * vecchie: la mappa non cresce con il numero di client diversi.
 */
export const SHADOW_V1_LIVE_RATE_MAP_MAX_ENTRIES = 1000;

/**
 * Origini HTTP aggiuntive ammesse per la route observe, separate da virgola
 * (`https://app.example.tld,https://staging.example.tld`). Vuota di default: la
 * stessa origine della richiesta e' sempre ammessa senza configurazione.
 */
export const SHADOW_V1_LIVE_ALLOWED_ORIGINS_ENV = 'SHADOW_V1_LIVE_ALLOWED_ORIGINS';

/** `source` persistito per i record che arrivano dalla route HTTP. */
export const SHADOW_V1_LIVE_SOURCE_CLIENT: ShadowV1LiveRecordSource = 'client';

/** `source` persistito per i record emessi dallo scanner server-side. */
export const SHADOW_V1_LIVE_SOURCE_SERVER_SCANNER: ShadowV1LiveRecordSource = 'server-scanner';

/** Barra 5m, come `SHADOW_V2_BAR_MS`. */
export const SHADOW_V1_LIVE_BAR_MS = 5 * 60 * 1000;

/** Tetto barre per ticker, come `MAX_BARS_PER_TICKER` di V2. */
export const SHADOW_V1_LIVE_MAX_BARS_PER_TICKER = 600;

/** Periodo del ciclo di rivalutazione. */
export const SHADOW_V1_LIVE_CYCLE_MS = 60_000;

/** Cooldown minimo tra recuperi Yahoo per lo stesso ticker/mercato. */
const YAHOO_BACKFILL_COOLDOWN_MS = 5 * 60_000;
const YAHOO_BACKFILL_TIMEOUT_MS = 8_000;

const WARN_PREFIX = '[Shadow V1 Live Collector]';

export type Market = 'EU' | 'US';

function isEnabled(env: Record<string, string | undefined> | undefined): boolean {
  const raw = env?.[SHADOW_V1_LIVE_COLLECT_ENV];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false';
}

/**
 * Lettura del flag, pura e testabile. **Acceso di default**, come V2 che non ha
 * flag: la variabile assente, vuota o con qualunque valore diverso da `'0'` e
 * `'false'` vale ON (la stringa vuota e' dichiarata ON). Si spegne solo con
 * `'0'` o `'false'`, con spazi esterni ignorati e confronto case-insensitive.
 */
export function isShadowV1LiveCollectEnabled(
  env: Record<string, string | undefined> | undefined
): boolean {
  return isEnabled(env);
}

// ---------------------------------------------------------------------------
// Archivio barre (RAM + persistenza atomica su disco)
// ---------------------------------------------------------------------------

interface BarsEntry {
  ticker: string;
  market: Market;
  bars: ShadowV1LiveBar[];
  updatedAt: number;
}

const barsByTicker = new Map<string, BarsEntry>();
let activeBarsDiskPath: string | null = null;
let activeObserveHandler: ((req: ObserveRequest) => Promise<ObserveResponse>) | null = null;

function barsKey(ticker: string, market: Market): string {
  return `${ticker}|${market}`;
}

function isClosedValidBar(b: ShadowV1LiveBar, nowMs: number): boolean {
  if (!b || typeof b !== 'object') return false;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!finite(b.t) || b.t <= 0) return false;
  if (!(b.t + SHADOW_V1_LIVE_BAR_MS <= nowMs)) return false;
  if (![b.o, b.h, b.l, b.c].every((v) => finite(v) && v > 0)) return false;
  return b.h >= b.l;
}

function mergeBarsList(
  existing: readonly ShadowV1LiveBar[],
  incoming: readonly ShadowV1LiveBar[],
  nowMs: number
): ShadowV1LiveBar[] {
  const byTs = new Map<number, ShadowV1LiveBar>();
  for (const b of existing) {
    if (isClosedValidBar(b, nowMs)) byTs.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  for (const b of incoming) {
    if (isClosedValidBar(b, nowMs)) byTs.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  const merged = Array.from(byTs.values()).sort((a, b) => a.t - b.t);
  return merged.length > SHADOW_V1_LIVE_MAX_BARS_PER_TICKER
    ? merged.slice(-SHADOW_V1_LIVE_MAX_BARS_PER_TICKER)
    : merged;
}

export function saveShadowV1LiveBarsToDisk(barsPath: string): void {
  try {
    const dir = path.dirname(barsPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${barsPath}.tmp-${process.pid}`;
    const payload = {
      version: 1,
      updatedAtMs: Date.now(),
      entries: Array.from(barsByTicker.values()),
    };
    fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmpPath, barsPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${WARN_PREFIX} salvataggio bars.json: ${message}`);
  }
}

export function loadShadowV1LiveBarsFromDisk(
  barsPath: string,
  nowMs: number = Date.now()
): number {
  if (!fs.existsSync(barsPath)) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(barsPath, 'utf8')) as {
      entries?: BarsEntry[];
    } | null;
    if (!raw || !Array.isArray(raw.entries)) return 0;
    let loaded = 0;
    for (const entry of raw.entries) {
      if (
        !entry ||
        typeof entry.ticker !== 'string' ||
        (entry.market !== 'EU' && entry.market !== 'US') ||
        !Array.isArray(entry.bars)
      ) {
        continue;
      }
      const key = barsKey(entry.ticker, entry.market);
      const existing = barsByTicker.get(key)?.bars ?? [];
      const merged = mergeBarsList(existing, entry.bars, nowMs);
      if (merged.length > 0) {
        barsByTicker.set(key, {
          ticker: entry.ticker,
          market: entry.market,
          bars: merged,
          updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : nowMs,
        });
        loaded += 1;
      }
    }
    return loaded;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${WARN_PREFIX} caricamento bars.json: ${message}`);
    return 0;
  }
}

/**
 * Memorizza le barre 5m chiuse di un ticker. A flag OFF ritorna subito, senza
 * allocare e senza I/O. Non lancia mai.
 */
export function recordBarsForShadowV1Live(
  ticker: string,
  market: Market,
  rawBars: readonly ShadowV1LiveBar[],
  nowMs: number = Date.now(),
  env: Record<string, string | undefined> | undefined = process.env
): void {
  if (!isEnabled(env)) return;
  try {
    if (typeof ticker !== 'string' || ticker.length === 0) return;
    if (!Array.isArray(rawBars) || rawBars.length === 0) return;

    const key = barsKey(ticker, market);
    const existing = barsByTicker.get(key)?.bars ?? [];
    const trimmed = mergeBarsList(existing, rawBars, nowMs);
    if (trimmed.length === 0) return;

    barsByTicker.set(key, { ticker, market, bars: trimmed, updatedAt: nowMs });
    if (activeBarsDiskPath) {
      saveShadowV1LiveBarsToDisk(activeBarsDiskPath);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${WARN_PREFIX} archivio barre: ${message}`);
  }
}

/** Barre chiuse disponibili per ticker e mercato (copia difensiva). */
export function barsForShadowV1Live(ticker: string, market: Market): ShadowV1LiveBar[] {
  const entry = barsByTicker.get(barsKey(ticker, market));
  return entry ? entry.bars.map((b) => ({ ...b })) : [];
}

/** Svuota l'archivio e resetta il percorso disco: usato solo dai test. */
export function clearShadowV1LiveBarsForTest(): void {
  barsByTicker.clear();
  activeBarsDiskPath = null;
  activeObserveHandler = null;
}

// ---------------------------------------------------------------------------
// Guardia di copertura barre (PR C3 + tolleranza feed autorevole EOD)
// ---------------------------------------------------------------------------

export const SHADOW_V1_LIVE_COVERAGE_WARN_MS = 60_000;

export type BarCoverageReason =
  | 'ok'
  | 'invalid_input'
  | 'no_bars'
  | 'leading_hole'
  | 'interior_hole';

export interface BarCoverageInput {
  bars: readonly ShadowV1LiveBar[];
  decidedAtMs: number;
  sessionCloseMs: number;
  nowMs: number;
  /**
   * Abilitato solo quando le barre provengono da un backfill autorevole Yahoo
   * sull'intera finestra richiesta: permette buchi legittimi di borsa
   * (candele 5m a volume 0 su titoli illiquidi, aste di volatilita'/chiusura).
   */
  allowExchangeGaps?: boolean;
  /** True solo se nowMs > sessionCloseMs ed il backfill autorevole ha confermato la sessione. */
  authoritativeSession?: boolean;
  /** True se esistono barre reali della stessa sessione prima della decisione. */
  hasSessionContextBar?: boolean;
}

export interface BarCoverageResult {
  ok: boolean;
  reason: BarCoverageReason;
  firstBarTs: number | null;
  lastBarTs: number | null;
  /** Ultima barra della griglia che termina entro la chiusura di sessione. */
  expectedLastBarTs: number | null;
  barsUsed: number;
  allowExchangeGaps?: boolean;
}

/**
 * Copertura delle barre fornite, senza guardare lo stato del record.
 * Non muta l'input (copia e ordina una mappa locale) e non lancia mai.
 */
export function checkShadowV1LiveBarCoverage(input: BarCoverageInput): BarCoverageResult {
  const empty = (
    reason: BarCoverageReason,
    expected: number | null,
    allowExchangeGaps?: boolean
  ): BarCoverageResult => ({
    ok: false,
    reason,
    firstBarTs: null,
    lastBarTs: null,
    expectedLastBarTs: expected,
    barsUsed: 0,
    ...(allowExchangeGaps ? { allowExchangeGaps: true } : {}),
  });

  try {
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (!finite(input.decidedAtMs) || !finite(input.sessionCloseMs) || !finite(input.nowMs)) {
      return empty('invalid_input', null);
    }

    const barMs = SHADOW_V1_LIVE_BAR_MS;
    const horizon = Math.min(input.sessionCloseMs, input.nowMs);
    const expectedLastBarTs = Math.floor((input.sessionCloseMs - barMs) / barMs) * barMs;
    const rawBars = Array.isArray(input.bars) ? input.bars : [];
    const allowGaps = input.allowExchangeGaps === true;

    const byTs = new Map<number, ShadowV1LiveBar>();
    for (const b of rawBars) {
      if (!b || typeof b !== 'object') continue;
      if (!finite(b.t) || b.t <= input.decidedAtMs) continue;
      if (!(b.t + barMs <= horizon)) continue;
      if (![b.o, b.h, b.l, b.c].every((v) => finite(v) && v > 0)) continue;
      if (b.h < b.l) continue;
      byTs.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
    }

    const ts = Array.from(byTs.keys()).sort((a, b) => a - b);
    if (ts.length === 0) {
      if (
        allowGaps &&
        input.authoritativeSession === true &&
        input.hasSessionContextBar === true &&
        horizon >= input.sessionCloseMs
      ) {
        return {
          ok: true,
          reason: 'ok',
          firstBarTs: null,
          lastBarTs: null,
          expectedLastBarTs,
          barsUsed: 0,
          allowExchangeGaps: true,
        };
      }
      return empty('no_bars', expectedLastBarTs, allowGaps);
    }

    const first = ts[0];
    if (!allowGaps) {
      if (first - barMs > input.decidedAtMs) {
        return {
          ok: false,
          reason: 'leading_hole',
          firstBarTs: first,
          lastBarTs: ts[ts.length - 1],
          expectedLastBarTs,
          barsUsed: ts.length,
        };
      }

      for (let i = 1; i < ts.length; i += 1) {
        if (ts[i] - ts[i - 1] !== barMs) {
          return {
            ok: false,
            reason: 'interior_hole',
            firstBarTs: first,
            lastBarTs: ts[ts.length - 1],
            expectedLastBarTs,
            barsUsed: ts.length,
          };
        }
      }
    }

    return {
      ok: true,
      reason: 'ok',
      firstBarTs: first,
      lastBarTs: ts[ts.length - 1],
      expectedLastBarTs,
      barsUsed: ts.length,
      ...(allowGaps ? { allowExchangeGaps: true } : {}),
    };
  } catch {
    return empty('invalid_input', null);
  }
}

/**
 * `null` = l'upsert puo' procedere; altrimenti il motivo del blocco.
 * Solo i cambi di stato e gli esiti terminali richiedono copertura.
 */
export function shadowV1LiveCoverageBlock(args: {
  proposedStatus: PersistedShadowV1LiveRecord['status'];
  currentStatus: PersistedShadowV1LiveRecord['status'] | null;
  coverage: BarCoverageResult;
}): BarCoverageReason | null {
  const { proposedStatus, currentStatus, coverage } = args;
  const sessionTerminal = proposedStatus === 'EXPIRED' || proposedStatus === 'NOT_FILLED';
  const tradeTerminal = proposedStatus === 'STOP' || proposedStatus === 'TARGET';
  const statusChange = currentStatus !== null && currentStatus !== proposedStatus;

  if (!sessionTerminal && !tradeTerminal && !statusChange) return null;
  if (!coverage.ok) return coverage.reason;
  if (
    sessionTerminal &&
    !coverage.allowExchangeGaps &&
    coverage.expectedLastBarTs !== null &&
    coverage.lastBarTs !== coverage.expectedLastBarTs
  ) {
    return 'interior_hole';
  }
  return null;
}

interface CoverageStats {
  insufficientBars: number;
  byReason: Record<string, number>;
}

const coverageStats: CoverageStats = { insufficientBars: 0, byReason: {} };
let lastCoverageWarnMs: number | null = null;

/** Contatori in memoria della guardia (nessuna persistenza). */
export function getShadowV1LiveCoverageStats(): CoverageStats {
  return { insufficientBars: coverageStats.insufficientBars, byReason: { ...coverageStats.byReason } };
}

export function resetShadowV1LiveCoverageStatsForTest(): void {
  coverageStats.insufficientBars = 0;
  coverageStats.byReason = {};
  lastCoverageWarnMs = null;
}

/** Conteggio sempre, log limitato a uno ogni `SHADOW_V1_LIVE_COVERAGE_WARN_MS`. */
function noteInsufficientCoverage(
  reason: BarCoverageReason,
  nowMs: number,
  warn: (message: string) => void
): void {
  coverageStats.insufficientBars += 1;
  coverageStats.byReason[reason] = (coverageStats.byReason[reason] ?? 0) + 1;
  if (lastCoverageWarnMs === null || nowMs - lastCoverageWarnMs >= SHADOW_V1_LIVE_COVERAGE_WARN_MS) {
    lastCoverageWarnMs = nowMs;
    warn(`copertura barre insufficiente (${reason}): nessun cambio di stato`);
  }
}

// ---------------------------------------------------------------------------
// Backfill autonomo Yahoo Finance 5m (chiusura sessione / riavvio / watchlist)
// ---------------------------------------------------------------------------

export interface BarBackfillResult {
  bars: ShadowV1LiveBar[];
  authoritative: boolean;
}

export async function fetchYahooMissingBarsForShadowV1Live(
  ticker: string,
  _market: Market,
  fromMs: number,
  toMs: number,
  nowMs: number = Date.now()
): Promise<BarBackfillResult | null> {
  try {
    const p1 = Math.max(0, Math.floor((fromMs - 15 * 60_000) / 1000));
    const p2 = Math.max(p1 + 300, Math.ceil((toMs + 15 * 60_000) / 1000));
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?interval=5m&period1=${p1}&period2=${p2}&includePrePost=false`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IntradayKnockoutRadar/1.0)',
      },
      signal: AbortSignal.timeout(YAHOO_BACKFILL_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: Array<number | null>;
              high?: Array<number | null>;
              low?: Array<number | null>;
              close?: Array<number | null>;
            }>;
          };
        }>;
      };
    };
    const result = json?.chart?.result?.[0];
    if (!result) return null;

    const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
    const q = result.indicators?.quote?.[0];
    const bars: ShadowV1LiveBar[] = [];
    for (let i = 0; i < timestamps.length; i += 1) {
      const tsSec = timestamps[i];
      const o = q?.open?.[i];
      const h = q?.high?.[i];
      const l = q?.low?.[i];
      const c = q?.close?.[i];
      if (
        typeof tsSec === 'number' &&
        typeof o === 'number' &&
        typeof h === 'number' &&
        typeof l === 'number' &&
        typeof c === 'number'
      ) {
        const candidate: ShadowV1LiveBar = { t: tsSec * 1000, o, h, l, c };
        if (isClosedValidBar(candidate, nowMs)) {
          bars.push(candidate);
        }
      }
    }

    return {
      bars,
      authoritative: bars.length > 0,
    };
  } catch {
    return null;
  }
}

function createThrottledYahooBackfill(
  nowFn: () => number,
  env: Record<string, string | undefined> | undefined
): NonNullable<CollectorDeps['fetchMissingBars']> {
  const lastAttemptByKey = new Map<string, number>();

  return async (ticker, market, fromMs, toMs) => {
    const key = barsKey(ticker, market);
    const nowMs = nowFn();
    const last = lastAttemptByKey.get(key) ?? 0;
    if (nowMs - last < YAHOO_BACKFILL_COOLDOWN_MS) {
      return null;
    }
    lastAttemptByKey.set(key, nowMs);

    const fetched = await fetchYahooMissingBarsForShadowV1Live(ticker, market, fromMs, toMs, nowMs);
    if (fetched && fetched.bars.length > 0) {
      recordBarsForShadowV1Live(ticker, market, fetched.bars, nowMs, env);
    }
    return fetched;
  };
}

// ---------------------------------------------------------------------------
// Validazione del payload
// ---------------------------------------------------------------------------

const PAYLOAD_KEYS = [
  'ticker',
  'market',
  'direction',
  'entry',
  'stop',
  'target',
  'calculatedAt',
] as const;

const TICKER_MAX_LENGTH = 20;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export interface ParsedObservePayload {
  ticker: string;
  market: Market;
  direction: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  target: number;
  calculatedAt: string;
  decidedAtMs: number;
}

export type ParseObservePayloadResult =
  | { ok: true; value: ParsedObservePayload }
  | { ok: false; reason: string };

function isFinitePositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Schema rigoroso: soli i sette campi attesi, nessun campo extra, nessun
 * fallback. `calculatedAt` deve essere una stringa ISO parsabile: se manca o non
 * e' valida il chiamante risponde 400 (il server non inventa l'istante).
 */
export function parseObservePayload(body: unknown): ParseObservePayloadResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'body non e\u2019 un oggetto' };
  }
  const raw = body as Record<string, unknown>;
  const allowed = new Set<string>(PAYLOAD_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return { ok: false, reason: `campo non atteso: ${key}` };
  }
  for (const key of PAYLOAD_KEYS) {
    if (key === 'calculatedAt') continue;
    if (!(key in raw)) return { ok: false, reason: `campo mancante: ${key}` };
  }

  const ticker = raw.ticker;
  if (typeof ticker !== 'string') return { ok: false, reason: 'ticker non stringa' };
  const trimmedTicker = ticker.trim();
  if (trimmedTicker.length === 0) return { ok: false, reason: 'ticker vuoto' };
  if (trimmedTicker.length > TICKER_MAX_LENGTH) {
    return { ok: false, reason: `ticker oltre ${TICKER_MAX_LENGTH} caratteri` };
  }

  const market = raw.market;
  if (market !== 'EU' && market !== 'US') return { ok: false, reason: 'market non EU|US' };

  const direction = raw.direction;
  if (direction !== 'LONG' && direction !== 'SHORT') {
    return { ok: false, reason: 'direction non LONG|SHORT' };
  }

  if (!isFinitePositive(raw.entry)) return { ok: false, reason: 'entry non finito o <= 0' };
  if (!isFinitePositive(raw.stop)) return { ok: false, reason: 'stop non finito o <= 0' };
  if (!isFinitePositive(raw.target)) return { ok: false, reason: 'target non finito o <= 0' };

  const calculatedAt = raw.calculatedAt;
  if (typeof calculatedAt !== 'string') {
    return { ok: false, reason: 'calculatedAt assente o non stringa' };
  }
  if (calculatedAt.length === 0) return { ok: false, reason: 'calculatedAt vuoto' };
  if (!ISO_RE.test(calculatedAt)) return { ok: false, reason: 'calculatedAt non ISO 8601' };
  const decidedAtMs = Date.parse(calculatedAt);
  if (!Number.isFinite(decidedAtMs)) {
    return { ok: false, reason: 'calculatedAt non parsabile' };
  }

  return {
    ok: true,
    value: {
      ticker: trimmedTicker,
      market,
      direction,
      entry: raw.entry,
      stop: raw.stop,
      target: raw.target,
      calculatedAt,
      decidedAtMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Handler della route e ciclo
// ---------------------------------------------------------------------------

export type MaybePromise<T> = T | Promise<T>;

export interface ObserveRequest {
  body: unknown;
  contentLength?: string | number | string[] | undefined;
  ip?: string;
  clientKey?: string;
  skipRateLimit?: boolean;
  /** Header `Origin` della richiesta HTTP: assente per le chiamate interne. */
  origin?: string | string[] | undefined;
  /** Host della richiesta (o `x-forwarded-host`): usato per il controllo origine. */
  host?: string | string[] | undefined;
  /** Provenienza da persistere sul record; assente = nessuna etichetta. */
  source?: ShadowV1LiveRecordSource;
}

export interface ObserveResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface CollectorTimers {
  setInterval: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval: (handle: unknown) => void;
}

export interface CollectorDeps {
  env: Record<string, string | undefined> | undefined;
  signalsPath: string;
  now: () => number;
  bars: (ticker: string, market: Market) => readonly ShadowV1LiveBar[];
  readRecords?: (path: string) => MaybePromise<LoadResult>;
  writeRecords?: (
    path: string,
    records: readonly PersistedShadowV1LiveRecord[]
  ) => MaybePromise<WriteResult>;
  warn?: (message: string) => void;
  rateLimitPerMinute?: number;
  /** Tetto della mappa del rate limit (default: `SHADOW_V1_LIVE_RATE_MAP_MAX_ENTRIES`). */
  rateMapMaxEntries?: number;
  /**
   * Coda unica delle mutazioni dello store. Default: quella di processo
   * (`SHADOW_V1_LIVE_STORE_QUEUE`), condivisa da handler e ciclo. Iniettabile
   * nei test per isolare l'ordine delle operazioni.
   */
  queue?: ShadowV1LiveStoreQueue;
  /** Guardia di copertura iniettabile (default: `checkShadowV1LiveBarCoverage`). */
  coverage?: (input: BarCoverageInput) => BarCoverageResult;
  /** Backfill autonomo opzionale quando mancano barre in RAM/disco. */
  fetchMissingBars?: (
    ticker: string,
    market: Market,
    fromMs: number,
    toMs: number
  ) => MaybePromise<BarBackfillResult | null>;
}

const NON_TERMINAL = new Set(['PENDING_FILL', 'OPEN']);

function isNonTerminal(record: PersistedShadowV1LiveRecord): boolean {
  return NON_TERMINAL.has(record.status);
}

function contextFromRecord(record: PersistedShadowV1LiveRecord): ShadowV1LiveObservationContext {
  return {
    ticker: record.ticker,
    market: record.market,
    direction: record.direction,
    entry: record.entry,
    stop: record.stop,
    target: record.target,
    decidedAtMs: record.decidedAtMs,
    sessionCloseMs: record.sessionCloseMs,
  };
}

function byteLengthOfJson(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return null;
    return Buffer.byteLength(json, 'utf8');
  } catch {
    return null;
  }
}

function parseContentLength(raw: ObserveRequest['contentLength']): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (Array.isArray(raw) && raw.length === 1) return parseContentLength(raw[0]);
  return null;
}

function normalizeRateLimitKey(req: ObserveRequest): string {
  if (typeof req.clientKey === 'string' && req.clientKey.trim().length > 0) {
    return req.clientKey.trim();
  }
  const rawIp = typeof req.ip === 'string' ? req.ip.trim().replace(/^::ffff:/, '') : '';
  return rawIp.length > 0 ? rawIp : 'unknown';
}

function hasSessionBarOnDate(
  bars: readonly ShadowV1LiveBar[],
  market: Market,
  decidedAtMs: number
): boolean {
  const targetDate = sessionDateFor(market, decidedAtMs);
  if (!targetDate) return false;
  for (const b of bars) {
    if (sessionDateFor(market, b.t) === targetDate) return true;
  }
  return false;
}

function needsBackfillForRecord(
  coverage: BarCoverageResult,
  proposedStatus: PersistedShadowV1LiveRecord['status'],
  currentStatus: PersistedShadowV1LiveRecord['status'] | null,
  sessionCloseMs: number,
  nowMs: number
): boolean {
  const blocked = shadowV1LiveCoverageBlock({ proposedStatus, currentStatus, coverage });
  if (blocked !== null) return true;
  if (
    nowMs > sessionCloseMs &&
    coverage.expectedLastBarTs !== null &&
    coverage.lastBarTs !== coverage.expectedLastBarTs &&
    NON_TERMINAL.has(proposedStatus)
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// SIC-1: controllo dell'origine HTTP (NON e' autenticazione)
//
// Regole: `Origin` assente -> comportamento invariato (client non browser o
// chiamata interna); `Origin` uguale all'host della richiesta oppure presente
// nella lista `SHADOW_V1_LIVE_ALLOWED_ORIGINS` -> ammesso; qualunque altra
// origine -> 403. Un client non browser puo' omettere o falsificare l'header:
// questo controllo alza il costo di una richiesta cross-site verso la route,
// non sostituisce l'autenticazione (che resta `requireApiAuth` in server.ts).
// ---------------------------------------------------------------------------

/** Forma canonica di un'origine: minuscola, senza spazi esterni ne' slash finale. */
export function normalizeShadowV1LiveOrigin(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}

export type OriginDecision = { ok: true } | { ok: false; origin: string };

export function isShadowV1LiveOriginAllowed(args: {
  origin?: string | string[] | undefined;
  host?: string | string[] | undefined;
  allowedOrigins?: string | undefined;
}): OriginDecision {
  const rawOrigin = Array.isArray(args.origin) ? args.origin[0] : args.origin;
  if (typeof rawOrigin !== 'string' || rawOrigin.trim().length === 0) return { ok: true };
  const origin = normalizeShadowV1LiveOrigin(rawOrigin);

  const rawHost = Array.isArray(args.host) ? args.host[0] : args.host;
  const host = typeof rawHost === 'string' ? rawHost.trim().toLowerCase() : '';
  if (host.length > 0 && (origin === `http://${host}` || origin === `https://${host}`)) {
    return { ok: true };
  }

  const allowed = (args.allowedOrigins ?? '')
    .split(',')
    .map((entry) => normalizeShadowV1LiveOrigin(entry))
    .filter((entry) => entry.length > 0);
  if (allowed.includes(origin)) return { ok: true };

  return { ok: false, origin };
}

// ---------------------------------------------------------------------------
// SIC-2: limite di body della sola route observe
//
// Il parser globale di server.ts (10 MB) girava prima del controllo a 8192 B
// del handler, che quindi avveniva su un body gia' materializzato. Questi due
// middleware vanno montati PRIMA del parser globale: il parser dedicato legge
// al massimo `SHADOW_V1_LIVE_MAX_BODY_BYTES` e body-parser salta i body gia'
// letti, quindi gli altri endpoint restano a 10 MB. La risposta 413 conserva la
// stessa forma JSON del handler.
// ---------------------------------------------------------------------------

export function shadowV1LiveBodyLimitParser(
  json: (options: { limit: number }) => RequestHandler
): RequestHandler {
  return json({ limit: SHADOW_V1_LIVE_MAX_BODY_BYTES });
}

export function shadowV1LiveBodyLimitErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
    if (status === 413) {
      res.status(413).json({ status: 'payload_too_large', maxBytes: SHADOW_V1_LIVE_MAX_BODY_BYTES });
      return;
    }
    next(err);
  };
}

/**
 * Coda FIFO di task asincroni sul file dei record.
 *
 * Una sola istanza di processo serializza **tutte** le mutazioni dello store:
 * richieste POST, osservazioni server-side (scanner) e ciclo di rivalutazione.
 * Ogni task esegue per intero lettura + valutazione + scrittura, quindi due
 * percorsi non possono piu' sovrascriversi lo snapshot l'uno dell'altro.
 * Un task che fallisce non blocca la coda: il successivo parte comunque.
 * Un task non deve accodarne un altro (nessun annidamento): sarebbe un deadlock.
 */
export interface ShadowV1LiveStoreQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Task accodati o in esecuzione in questo istante (diagnostica e test). */
  pending(): number;
}

export function createShadowV1LiveStoreQueue(): ShadowV1LiveStoreQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      pending += 1;
      // `task` gira sia dopo un successo sia dopo un errore del precedente.
      const result = tail.then(task, task);
      tail = result.then(
        () => {
          pending -= 1;
        },
        () => {
          pending -= 1;
        }
      );
      return result;
    },
    pending: () => pending,
  };
}

/** Coda condivisa di processo: unica per handler, scanner e ciclo. */
export const SHADOW_V1_LIVE_STORE_QUEUE = createShadowV1LiveStoreQueue();

/**
 * Costruisce il handler della route con dipendenze iniettate. Le richieste sono
 * serializzate dalla coda dello store: lettura, valutazione e scrittura della
 * stessa finestra non si sovrappongono, cosi' richieste ravvicinate e ciclo di
 * rivalutazione non perdono aggiornamenti ne' creano doppioni.
 */
export interface ObserveHandler {
  (req: ObserveRequest): Promise<ObserveResponse>;
  /** Voci correnti nella mappa del rate limit (diagnostica e test). */
  rateLimitEntries: () => number;
  /** Task accodati o in esecuzione nella coda condivisa (diagnostica e test). */
  queuePending: () => number;
}

export function createObserveHandler(deps: CollectorDeps): ObserveHandler {
  const readRecords = deps.readRecords ?? loadRecords;
  const writeRecords = deps.writeRecords ?? writeRecordsAtomic;
  const warn = deps.warn ?? ((message: string) => console.warn(`${WARN_PREFIX} ${message}`));
  const limit = deps.rateLimitPerMinute ?? SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE;
  const queue = deps.queue ?? SHADOW_V1_LIVE_STORE_QUEUE;
  const rateMapMaxEntries = Math.max(
    1,
    deps.rateMapMaxEntries ?? SHADOW_V1_LIVE_RATE_MAP_MAX_ENTRIES
  );
  const hits = new Map<string, { windowStart: number; count: number }>();

  /** Elimina le voci scadute e, se serve spazio, le piu' vecchie. */
  function sweepRateLimit(nowMs: number): void {
    for (const [k, v] of hits.entries()) {
      if (nowMs - v.windowStart >= SHADOW_V1_LIVE_RATE_WINDOW_MS) {
        hits.delete(k);
      }
    }
    if (hits.size < rateMapMaxEntries) return;
    const excess = hits.size - rateMapMaxEntries + 1;
    let removed = 0;
    for (const k of hits.keys()) {
      hits.delete(k);
      removed += 1;
      if (removed >= excess) break;
    }
  }

  function rateLimited(key: string, nowMs: number): boolean {
    if (hits.size >= rateMapMaxEntries) sweepRateLimit(nowMs);
    const entry = hits.get(key);
    if (!entry || nowMs - entry.windowStart >= SHADOW_V1_LIVE_RATE_WINDOW_MS) {
      hits.set(key, { windowStart: nowMs, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > limit;
  }

  const handle = (async (req: ObserveRequest): Promise<ObserveResponse> => {
    // Flag OFF: nessun I/O, nessun timer, nessuna scrittura di stato.
    if (!isEnabled(deps.env)) {
      return { status: 404, body: { status: 'disabled', flag: SHADOW_V1_LIVE_COLLECT_ENV } };
    }

    // SIC-1: origine dichiarata dal browser. Assente = comportamento invariato.
    const originCheck = isShadowV1LiveOriginAllowed({
      origin: req.origin,
      host: req.host,
      allowedOrigins: deps.env?.[SHADOW_V1_LIVE_ALLOWED_ORIGINS_ENV],
    });
    if (!originCheck.ok) {
      return {
        status: 403,
        body: { status: 'forbidden_origin', origin: originCheck.origin },
      };
    }

    const declared = parseContentLength(req.contentLength);
    const serialized = byteLengthOfJson(req.body);
    if (serialized === null) {
      return { status: 400, body: { status: 'invalid_payload', reason: 'body non serializzabile' } };
    }
    if ((declared ?? 0) > SHADOW_V1_LIVE_MAX_BODY_BYTES || serialized > SHADOW_V1_LIVE_MAX_BODY_BYTES) {
      return {
        status: 413,
        body: { status: 'payload_too_large', maxBytes: SHADOW_V1_LIVE_MAX_BODY_BYTES },
      };
    }

    const nowMs = deps.now();
    const rateKey = normalizeRateLimitKey(req);
    if (!req.skipRateLimit && rateLimited(rateKey, nowMs)) {
      return {
        status: 429,
        body: { status: 'rate_limited', perMinute: limit },
      };
    }

    const parsed = parseObservePayload(req.body);
    if (!parsed.ok) {
      return { status: 400, body: { status: 'invalid_payload', reason: parsed.reason } };
    }
    const setup = parsed.value;

    try {
      const sessionDate = sessionDateFor(setup.market, setup.decidedAtMs);
      const sessionCloseMs = sessionDate === null ? null : sessionCloseMsFor(setup.market, sessionDate);
      if (sessionDate === null || sessionCloseMs === null) {
        return {
          status: 200,
          body: {
            status: 'no_session',
            reason: 'chiusura di sessione non determinabile (weekend, festivita\' o data non valida)',
            market: setup.market,
            sessionDate,
          },
        };
      }

      return await queue.run(async (): Promise<ObserveResponse> => {
        const loaded = await readRecords(deps.signalsPath);
        const records = loaded.records;
        const context: ShadowV1LiveObservationContext = {
          ticker: setup.ticker,
          market: setup.market,
          direction: setup.direction,
          entry: setup.entry,
          stop: setup.stop,
          target: setup.target,
          decidedAtMs: setup.decidedAtMs,
          sessionCloseMs,
          ...(req.source ? { source: req.source } : {}),
        };
        const evalPayload = {
          candidate: { ticker: setup.ticker },
          decision: 'TRADE' as const,
          direction: setup.direction,
          triggerLevel: setup.entry,
          entryLevel: setup.entry,
          stopLossLevel: setup.stop,
          target1Level: setup.target,
        };

        let bars = deps.bars(setup.ticker, setup.market);
        const seenKeys = records.map((r) => r.key);
        let result = evaluateShadowV1Live({
          setup: evalPayload,
          decidedAtMs: context.decidedAtMs,
          sessionCloseMs: context.sessionCloseMs,
          nowMs,
          bars,
          seenKeys,
        });

        let observation = observationFromResult(context, result);
        if (!observation) {
          return {
            status: 200,
            body: { status: 'ok', outcome: result.status, persisted: false, key: result.key },
          };
        }

        const coverageFn = deps.coverage ?? checkShadowV1LiveBarCoverage;
        let coverage = coverageFn({
          bars,
          decidedAtMs: context.decidedAtMs,
          sessionCloseMs: context.sessionCloseMs,
          nowMs,
        });
        const existingStatus = records.find((r) => r.key === observation!.key)?.status ?? null;
        let blocked = shadowV1LiveCoverageBlock({
          proposedStatus: observation.status,
          currentStatus: existingStatus,
          coverage,
        });

        if (blocked && deps.fetchMissingBars) {
          const backfill = await deps.fetchMissingBars(
            setup.ticker,
            setup.market,
            context.decidedAtMs,
            Math.min(nowMs, context.sessionCloseMs)
          );
          if (backfill?.authoritative) {
            bars = mergeBarsList(bars, backfill.bars, nowMs);
            result = evaluateShadowV1Live({
              setup: evalPayload,
              decidedAtMs: context.decidedAtMs,
              sessionCloseMs: context.sessionCloseMs,
              nowMs,
              bars,
              seenKeys,
            });
            observation = observationFromResult(context, result);
            if (!observation) {
              return {
                status: 200,
                body: { status: 'ok', outcome: result.status, persisted: false, key: result.key },
              };
            }
            coverage = coverageFn({
              bars,
              decidedAtMs: context.decidedAtMs,
              sessionCloseMs: context.sessionCloseMs,
              nowMs,
              allowExchangeGaps: true,
              authoritativeSession: nowMs > context.sessionCloseMs,
              hasSessionContextBar: hasSessionBarOnDate(bars, setup.market, context.decidedAtMs),
            });
            blocked = shadowV1LiveCoverageBlock({
              proposedStatus: observation.status,
              currentStatus: records.find((r) => r.key === observation!.key)?.status ?? null,
              coverage,
            });
          }
        }

        if (blocked) {
          noteInsufficientCoverage(blocked, nowMs, warn);
          return {
            status: 200,
            body: {
              status: 'ok',
              outcome: 'insufficient_bars',
              persisted: false,
              coverage: blocked,
              key: observation.key,
            },
          };
        }

        const upserted = upsertObservation(records, observation, nowMs);
        if (!upserted.changed) {
          return {
            status: 200,
            body: {
              status: 'ok',
              outcome: observation.status,
              persisted: true,
              changed: false,
              upsert: upserted.outcome,
              key: observation.key,
            },
          };
        }

        const written = await writeRecords(deps.signalsPath, upserted.records);
        if (!written.ok) {
          warn(`persistenza fallita (${observation.key}): ${written.error}`);
          return {
            status: 200,
            body: {
              status: 'ok',
              outcome: observation.status,
              persisted: false,
              changed: true,
              upsert: upserted.outcome,
              persistence: 'failed',
              key: observation.key,
            },
          };
        }

        return {
          status: 200,
          body: {
            status: 'ok',
            outcome: observation.status,
            persisted: true,
            changed: true,
            upsert: upserted.outcome,
            key: observation.key,
          },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`richiesta non elaborata: ${message}`);
      return { status: 500, body: { status: 'internal_error' } };
    }
  }) as ObserveHandler;
  handle.rateLimitEntries = () => hits.size;
  handle.queuePending = () => queue.pending();
  return handle;
}

export interface CycleResult {
  evaluated: number;
  changed: number;
  written: boolean;
}

/**
 * Rivaluta i record non terminali con le barre disponibili (e con eventuale
 * backfill Yahoo autonomo se configurato nei `deps`). A fine sessione il
 * nucleo li porta a `EXPIRED` (o `NOT_FILLED`) alla prima valutazione con
 * `nowMs > sessionCloseMs`. Non lancia mai: un errore viene solo registrato.
 */
export async function runShadowV1LiveRevaluationCycle(
  deps: CollectorDeps
): Promise<CycleResult> {
  const queue = deps.queue ?? SHADOW_V1_LIVE_STORE_QUEUE;
  // L'intero ciclo (lettura + valutazione + scrittura) e' un solo task: senza
  // questo, un upsert arrivato nel frattempo verrebbe sovrascritto dal ciclo.
  return queue.run(() => evaluateAndPersistCycle(deps));
}

async function evaluateAndPersistCycle(deps: CollectorDeps): Promise<CycleResult> {
  const warn = deps.warn ?? ((message: string) => console.warn(`${WARN_PREFIX} ${message}`));
  const readRecords = deps.readRecords ?? loadRecords;
  const writeRecords = deps.writeRecords ?? writeRecordsAtomic;
  const coverageFn = deps.coverage ?? checkShadowV1LiveBarCoverage;
  const empty: CycleResult = { evaluated: 0, changed: 0, written: false };

  try {
    const nowMs = deps.now();
    const loaded = await readRecords(deps.signalsPath);
    let records = loaded.records;
    let changed = 0;
    let evaluated = 0;

    for (const record of loaded.records) {
      if (!isNonTerminal(record)) continue;
      evaluated += 1;

      let bars = deps.bars(record.ticker, record.market);
      let result = evaluateShadowV1Live(toCoreInput(record, nowMs, bars, records));
      let observation = observationFromResult(contextFromRecord(record), result);
      if (!observation) continue;

      let coverage = coverageFn({
        bars,
        decidedAtMs: record.decidedAtMs,
        sessionCloseMs: record.sessionCloseMs,
        nowMs,
      });

      if (
        deps.fetchMissingBars &&
        needsBackfillForRecord(
          coverage,
          observation.status,
          record.status,
          record.sessionCloseMs,
          nowMs
        )
      ) {
        const backfill = await deps.fetchMissingBars(
          record.ticker,
          record.market,
          record.decidedAtMs,
          Math.min(nowMs, record.sessionCloseMs)
        );
        if (backfill?.authoritative) {
          bars = mergeBarsList(bars, backfill.bars, nowMs);
          result = evaluateShadowV1Live(toCoreInput(record, nowMs, bars, records));
          observation = observationFromResult(contextFromRecord(record), result);
          if (!observation) continue;
          coverage = coverageFn({
            bars,
            decidedAtMs: record.decidedAtMs,
            sessionCloseMs: record.sessionCloseMs,
            nowMs,
            allowExchangeGaps: true,
            authoritativeSession: nowMs > record.sessionCloseMs,
            hasSessionContextBar: hasSessionBarOnDate(bars, record.market, record.decidedAtMs),
          });
        }
      }

      const blocked = shadowV1LiveCoverageBlock({
        proposedStatus: observation.status,
        currentStatus: record.status,
        coverage,
      });
      if (blocked) {
        noteInsufficientCoverage(blocked, nowMs, warn);
        continue;
      }
      const upserted = upsertObservation(records, observation, nowMs);
      if (upserted.changed) {
        records = upserted.records;
        changed += 1;
      }
    }

    if (changed === 0) return { evaluated, changed, written: false };

    const written = await writeRecords(deps.signalsPath, records);
    if (!written.ok) warn(`ciclo: persistenza fallita (${written.error})`);
    return { evaluated, changed, written: written.ok };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`ciclo non completato: ${message}`);
    return empty;
  }
}

export interface RegistrationOptions {
  root?: string;
  env?: Record<string, string | undefined>;
  timers?: CollectorTimers;
  now?: () => number;
  cycleMs?: number;
  barsPath?: string;
  fetchMissingBars?: CollectorDeps['fetchMissingBars'] | null;
  /** Coda condivisa fra handler e ciclo (default: una nuova per registrazione). */
  queue?: ShadowV1LiveStoreQueue;
}

export interface RegistrationResult {
  enabled: boolean;
  stop: (() => void) | null;
}

type MinimalApp = {
  post: (path: string, handler: (req: unknown, res: unknown) => void) => void;
};

type MinimalResponse = {
  status: (code: number) => { json: (body: unknown) => void };
  locals?: { authenticatedUid?: string };
};

/**
 * Registra la route POST e, **solo** a flag ON, carica le barre salvate su
 * disco e avvia il ciclo (con backfill autonomo Yahoo per sessioni chiuse o
 * buchi post-riavvio). A flag OFF non registra timer ne' tocca disco.
 */
export function registerShadowV1LiveCollector(
  app: MinimalApp,
  options: RegistrationOptions = {}
): RegistrationResult {
  const root = options.root ?? process.cwd();
  const env = options.env ?? process.env;
  const timers: CollectorTimers = options.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const enabled = isEnabled(env);

  if (enabled) {
    const diskPath = options.barsPath ?? path.join(root, SHADOW_V1_LIVE_BARS_PATH);
    activeBarsDiskPath = diskPath;
    loadShadowV1LiveBarsFromDisk(diskPath, Date.now());
  }

  const nowFn = options.now ?? (() => Date.now());
  const fetchMissingBars =
    options.fetchMissingBars === null
      ? undefined
      : options.fetchMissingBars ?? createThrottledYahooBackfill(nowFn, env);

  // Una sola coda per registrazione: handler, osservazioni server-side e ciclo
  // scrivono sullo stesso file e devono serializzarsi fra loro.
  const storeQueue = options.queue ?? createShadowV1LiveStoreQueue();
  const deps: CollectorDeps = {
    env,
    signalsPath: `${root}/artifacts/shadow_v1_live/signals.jsonl`,
    now: nowFn,
    bars: (ticker, market) => barsForShadowV1Live(ticker, market),
    queue: storeQueue,
    ...(fetchMissingBars ? { fetchMissingBars } : {}),
  };
  const handler = createObserveHandler(deps);
  activeObserveHandler = enabled ? handler : null;

  app.post(SHADOW_V1_LIVE_OBSERVE_PATH, (req, res) => {
    const request = req as ObserveRequest & {
      headers?: Record<string, string | string[] | undefined>;
    };
    const response = res as MinimalResponse;
    const contentLength = request.contentLength ?? request.headers?.['content-length'];
    const uid = response.locals?.authenticatedUid;
    const rawIp = typeof request.ip === 'string' ? request.ip.trim().replace(/^::ffff:/, '') : '';
    const clientKey = uid && uid !== 'legacy' ? `uid:${uid}` : rawIp || undefined;
    const origin = request.headers?.['origin'];
    const host = request.headers?.['x-forwarded-host'] ?? request.headers?.['host'];

    void handler({
      body: request.body,
      contentLength,
      ip: request.ip,
      clientKey,
      origin,
      host,
      source: SHADOW_V1_LIVE_SOURCE_CLIENT,
    })
      .then((out) => response.status(out.status).json(out.body))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`${WARN_PREFIX} handler: ${message}`);
        response.status(500).json({ status: 'internal_error' });
      });
  });

  if (!enabled) return { enabled: false, stop: null };

  const cycle = () => {
    void runShadowV1LiveRevaluationCycle(deps);
  };
  // Primo giro immediato all'avvio per sbloccare eventuali record stale dopo riavvio.
  cycle();
  const handle = timers.setInterval(cycle, options.cycleMs ?? SHADOW_V1_LIVE_CYCLE_MS);
  if (typeof handle?.unref === 'function') handle.unref();

  return {
    enabled: true,
    stop: () => {
      activeObserveHandler = null;
      timers.clearInterval(handle);
    },
  };
}

/**
 * Punto di ingresso interno lato server (senza limite HTTP 10/min): usato
 * dallo scanner V1-live su tutto il paniere per persistere i setup `TRADE`
 * attraverso la stessa coda serializzata del collector.
 */
export async function observeShadowV1LiveFromServer(
  payload: ObserveRequest['body']
): Promise<ObserveResponse | null> {
  if (!activeObserveHandler) return null;
  return activeObserveHandler({
    body: payload,
    clientKey: 'server-scan',
    skipRateLimit: true,
    source: SHADOW_V1_LIVE_SOURCE_SERVER_SCANNER,
  });
}
