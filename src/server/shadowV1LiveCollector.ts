/**
 * SHADOW V1 LIVE — collector passivo lato server.
 *
 * Riceve un setup emesso dal client, lo valuta con il nucleo `shadowV1Live.ts`
 * (nessun ricalcolo di G1-G13: il server non ricostruisce il setup) e lo
 * persiste con `shadowV1LiveStore.ts`. Un ciclo periodico rivaluta i record non
 * terminali sulle barre 5m chiuse gia' raccolte dal server.
 *
 * Tutto e' spento di default: flag `SHADOW_V1_LIVE_COLLECT` attivo solo con
 * `'1'` o `'true'` esatti. A flag OFF la route risponde 404 `disabled` senza
 * alcun I/O, nessun timer parte e `recordBarsForShadowV1Live` ritorna subito.
 *
 * Isolamento (F6): ogni eccezione viene catturata e registrata con
 * `console.warn('[Shadow V1 Live Collector] ...')`; non propaga mai al radar,
 * alle altre route o al ciclo V2. Un errore di scrittura non ferma nulla.
 *
 * Sorgente barre: archivio gemello privato, stessa semantica di
 * `src/server/shadowV2Collector.ts:32-72` (merge per `t`, sole barre chiuse,
 * tetto 600 per ticker), alimentato da `server.ts` con lo stesso array
 * `barsForShadowV2`. Limite dichiarato: l'archivio e' in memoria, quindi dopo un
 * riavvio e' vuoto finche' non gira una scansione; i record non terminali
 * restano invariati e il ciclo non produce errori.
 */

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
  type WriteResult,
} from './shadowV1LiveStore';

/** Nome della variabile d'ambiente. Attiva solo con `'1'` o `'true'` esatti. */
export const SHADOW_V1_LIVE_COLLECT_ENV = 'SHADOW_V1_LIVE_COLLECT';

/** Route di osservazione (POST). */
export const SHADOW_V1_LIVE_OBSERVE_PATH = '/api/shadow/v1-live/observe';

/** Limite esplicito del corpo per questa route (express.json globale: 10 MB). */
export const SHADOW_V1_LIVE_MAX_BODY_BYTES = 8192;

/** Limite proprio della route, piu' stretto di `apiLimiter` (60/min globale). */
export const SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE = 10;

export const SHADOW_V1_LIVE_RATE_WINDOW_MS = 60_000;

/** Barra 5m, come `SHADOW_V2_BAR_MS`. */
export const SHADOW_V1_LIVE_BAR_MS = 5 * 60 * 1000;

/** Tetto barre per ticker, come `MAX_BARS_PER_TICKER` di V2. */
export const SHADOW_V1_LIVE_MAX_BARS_PER_TICKER = 600;

/** Periodo del ciclo di rivalutazione. */
export const SHADOW_V1_LIVE_CYCLE_MS = 60_000;

const WARN_PREFIX = '[Shadow V1 Live Collector]';

export type Market = 'EU' | 'US';

function isEnabled(env: Record<string, string | undefined> | undefined): boolean {
  if (!env) return false;
  const raw = env[SHADOW_V1_LIVE_COLLECT_ENV];
  return raw === '1' || raw === 'true';
}

/**
 * Lettura del flag, pura e testabile. Attivo **solo** con `'1'` o `'true'`
 * esatti: `'TRUE'`, `' true'`, `''`, `'0'`, `'yes'` e l'assenza valgono OFF.
 */
export function isShadowV1LiveCollectEnabled(
  env: Record<string, string | undefined> | undefined
): boolean {
  return isEnabled(env);
}

// ---------------------------------------------------------------------------
// Archivio barre (gemello privato della sorgente V2)
// ---------------------------------------------------------------------------

interface BarsEntry {
  ticker: string;
  market: Market;
  bars: ShadowV1LiveBar[];
  updatedAt: number;
}

const barsByTicker = new Map<string, BarsEntry>();

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
    const byTs = new Map<number, ShadowV1LiveBar>();

    for (const b of existing) {
      if (isClosedValidBar(b, nowMs)) byTs.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
    }
    for (const b of rawBars) {
      if (isClosedValidBar(b, nowMs)) byTs.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
    }

    const merged = Array.from(byTs.values()).sort((a, b) => a.t - b.t);
    const trimmed =
      merged.length > SHADOW_V1_LIVE_MAX_BARS_PER_TICKER
        ? merged.slice(-SHADOW_V1_LIVE_MAX_BARS_PER_TICKER)
        : merged;

    barsByTicker.set(key, { ticker, market, bars: trimmed, updatedAt: nowMs });
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

/** Svuota l'archivio: usato solo dai test, come `clearShadowV2BarsForTest`. */
export function clearShadowV1LiveBarsForTest(): void {
  barsByTicker.clear();
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

/**
 * Costruisce il handler della route con dipendenze iniettate. Le richieste sono
 * serializzate da una coda in memoria: lettura, valutazione e scrittura della
 * stessa finestra non si sovrappongono, cosi' richieste ravvicinate non perdono
 * aggiornamenti ne' creano doppioni.
 */
export function createObserveHandler(
  deps: CollectorDeps
): (req: ObserveRequest) => Promise<ObserveResponse> {
  const readRecords = deps.readRecords ?? loadRecords;
  const writeRecords = deps.writeRecords ?? writeRecordsAtomic;
  const warn = deps.warn ?? ((message: string) => console.warn(`${WARN_PREFIX} ${message}`));
  const limit = deps.rateLimitPerMinute ?? SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE;
  const hits = new Map<string, { windowStart: number; count: number }>();

  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function rateLimited(ip: string, nowMs: number): boolean {
    const entry = hits.get(ip);
    if (!entry || nowMs - entry.windowStart >= SHADOW_V1_LIVE_RATE_WINDOW_MS) {
      hits.set(ip, { windowStart: nowMs, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > limit;
  }

  return async function handle(req: ObserveRequest): Promise<ObserveResponse> {
    // Flag OFF: nessun I/O, nessun timer, nessuna scrittura di stato.
    if (!isEnabled(deps.env)) {
      return { status: 404, body: { status: 'disabled', flag: SHADOW_V1_LIVE_COLLECT_ENV } };
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
    const ip = req.ip && req.ip.length > 0 ? req.ip : 'unknown';
    if (rateLimited(ip, nowMs)) {
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
            reason: 'chiusura di sessione non determinabile (weekend o data non valida)',
            market: setup.market,
            sessionDate,
          },
        };
      }

      return await enqueue(async (): Promise<ObserveResponse> => {
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
        };
        const bars = deps.bars(setup.ticker, setup.market);
        const result = evaluateShadowV1Live({
          setup: {
            candidate: { ticker: setup.ticker },
            decision: 'TRADE',
            direction: setup.direction,
            triggerLevel: setup.entry,
            entryLevel: setup.entry,
            stopLossLevel: setup.stop,
            target1Level: setup.target,
          },
          decidedAtMs: context.decidedAtMs,
          sessionCloseMs: context.sessionCloseMs,
          nowMs,
          bars,
          seenKeys: records.map((r) => r.key),
        });

        const observation = observationFromResult(context, result);
        if (!observation) {
          return {
            status: 200,
            body: { status: 'ok', outcome: result.status, persisted: false, key: result.key },
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
  };
}

export interface CycleResult {
  evaluated: number;
  changed: number;
  written: boolean;
}

/**
 * Rivaluta i record non terminali con le barre disponibili. A fine sessione il
 * nucleo li porta a `EXPIRED` (o `NOT_FILLED`) alla prima valutazione con
 * `nowMs > sessionCloseMs`. Non lancia mai: un errore viene solo registrato.
 *
 * Con archivio barre vuoto (riavvio) i record restano invariati e il ciclo
 * scrive solo se qualcosa e' cambiato.
 */
export async function runShadowV1LiveRevaluationCycle(
  deps: CollectorDeps
): Promise<CycleResult> {
  const warn = deps.warn ?? ((message: string) => console.warn(`${WARN_PREFIX} ${message}`));
  const readRecords = deps.readRecords ?? loadRecords;
  const writeRecords = deps.writeRecords ?? writeRecordsAtomic;
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
      const bars = deps.bars(record.ticker, record.market);
      const input = toCoreInput(record, nowMs, bars, records);
      const result = evaluateShadowV1Live(input);
      const observation = observationFromResult(contextFromRecord(record), result);
      if (!observation) continue;
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
  cycleMs?: number;
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
};

/**
 * Registra la route POST e, **solo** a flag ON, avvia il ciclo. A flag OFF non
 * registra timer e il handler risponde 404 `disabled` senza I/O.
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

  const deps: CollectorDeps = {
    env,
    signalsPath: `${root}/artifacts/shadow_v1_live/signals.jsonl`,
    now: () => Date.now(),
    bars: (ticker, market) => barsForShadowV1Live(ticker, market),
  };
  const handler = createObserveHandler(deps);

  app.post(SHADOW_V1_LIVE_OBSERVE_PATH, (req, res) => {
    const request = req as ObserveRequest & {
      headers?: Record<string, string | string[] | undefined>;
    };
    const response = res as MinimalResponse;
    const contentLength = request.contentLength ?? request.headers?.['content-length'];
    void handler({
      body: request.body,
      contentLength,
      ip: request.ip,
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
  const handle = timers.setInterval(cycle, options.cycleMs ?? SHADOW_V1_LIVE_CYCLE_MS);
  if (typeof handle?.unref === 'function') handle.unref();

  return {
    enabled: true,
    stop: () => timers.clearInterval(handle),
  };
}
