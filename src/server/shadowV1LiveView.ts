/**
 * SHADOW V1 LIVE — vista read-only sui record persistiti (PR D1).
 *
 * Sola lettura: legge il JSONL dello store gia' approvato, non scrive nulla, non
 * rivaluta i record e non tocca il collector. Route `GET /api/shadow/v1-live/signals`
 * con flag dedicato `SHADOW_V1_LIVE_VIEW` (acceso di default; si spegne solo con `'0'` o `'false'`),
 * separato dal flag di raccolta: la vista si spegne senza fermare il collector.
 *
 * A flag OFF: 404 `disabled`, nessun I/O. File assente o illeggibile: 200 con
 * `available: false` (convenzione di `shadowRoute.ts`), nessuna eccezione.
 *
 * Le metriche sono esplorative e grossolane: `r` e' il R di prezzo del nucleo
 * V1-live (nessun costo, nessuna leva), non il `rNet` di V2. Denominatore sempre
 * esplicito e limitato agli stati con risultato reale (`STOP`, `TARGET`,
 * `EXPIRED`): `NOT_FILLED` e i record non terminali non entrano nel conteggio e
 * non valgono zero.
 *
 * Superficie pubblica di sola lettura (P11): `registerShadowV1LiveViewRoute` non
 * applica `requireApiAuth`; l'unica protezione e' `apiLimiter` (60 richieste al
 * minuto). Espone aggregati e record di ricerca, non dati operativi. L'apertura
 * e' deliberata e documentata qui, non una svista: chiuderla con auth o ridurre
 * il payload e' una decisione del proprietario, perche' cambia il contratto
 * osservabile della route e del pannello.
 */

import fs from 'node:fs';
import {
  isStale,
  loadRecords,
  SHADOW_V1_LIVE_MODULE_VERSION,
  SHADOW_V1_LIVE_STORE_VERSION,
  SHADOW_V1_LIVE_SIGNALS_PATH,
  type LoadResult,
  type PersistedShadowV1LiveRecord,
} from './shadowV1LiveStore';
import { listArchivePaths, mergeRecordFiles } from './shadowV1LiveRetention';

/**
 * Variabile d'ambiente, solo interruttore di emergenza: la vista e' accesa di
 * default come V2 e si spegne solo con `'0'` o `'false'`.
 */
export const SHADOW_V1_LIVE_VIEW_ENV = 'SHADOW_V1_LIVE_VIEW';

export const SHADOW_V1_LIVE_VIEW_PATH = '/api/shadow/v1-live/signals';

/** Tetto dichiarato della risposta: i piu' recenti per `decidedAtMs`. */
export const SHADOW_V1_LIVE_VIEW_MAX_RECORDS = 500;

/**
 * Soglia di ritardo di osservazione: 10 minuti, fissata prima di guardare i
 * dati e non modificabile a posteriori. `firstSeenAtMs` e' il primo istante in
 * cui il server ha visto il setup, non quello in cui il mercato lo ha
 * generato: oltre questa soglia il record resta nell'elenco ma e' escluso
 * dalle metriche, perche' l'esito puo' essere gia' avvenuto prima.
 */
export const LATE_THRESHOLD_MS = 600_000;

/**
 * Accesa di default con la stessa semantica di `SHADOW_V1_LIVE_COLLECT`:
 * variabile assente, vuota o diversa da `'0'`/`'false'` vale ON; solo `'0'` e
 * `'false'` (trim, case-insensitive) spengono la vista.
 */
export function isShadowV1LiveViewEnabled(
  env: Record<string, string | undefined> | undefined
): boolean {
  const raw = env?.[SHADOW_V1_LIVE_VIEW_ENV];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false';
}

export type ShadowV1LiveViewStatus =
  | 'PENDING_FILL'
  | 'OPEN'
  | 'STOP'
  | 'TARGET'
  | 'EXPIRED'
  | 'NOT_FILLED';

export interface ShadowV1LiveViewRecord {
  key: string;
  ticker: string;
  market: 'EU' | 'US';
  direction: 'LONG' | 'SHORT';
  status: ShadowV1LiveViewStatus;
  decidedAtMs: number;
  sessionCloseMs: number;
  /** Calcolato a lettura, mai persistito. */
  stale: boolean;
  /** `firstSeenAtMs - decidedAtMs`; `null` se non calcolabile o negativo. */
  delayMs: number | null;
  /** `delayMs > LATE_THRESHOLD_MS`. */
  late: boolean;
  r: number | null;
  fillBarTs: number | null;
  exitBarTs: number | null;
  exitPrice: number | null;
  /**
   * Metodo che ha prodotto il record (`shadowV1Live@3` = barra della decisione
   * + stop in gap solo sopra il fill); qualunque valore precedente (`@2`, `@1`)
   * o assente = record prodotto dal metodo precedente.
   * Sola lettura: la vista non ricalcola ne' riscrive nulla.
   */
  moduleVersion: string | null;
  updatedAtMs: number;
}

export interface ShadowV1LiveViewCounts {
  persisted: number;
  pendingFill: number;
  open: number;
  stop: number;
  target: number;
  expired: number;
  notFilled: number;
  nonTerminal: number;
  terminal: number;
  stale: number;
}

export interface ShadowV1LiveViewMetrics {
  /** Record con esito reale e `r` finito: unico denominatore dei valori sotto. */
  resolved: number;
  /** Media aritmetica di `r` sui soli `resolved`, 4 decimali. */
  meanR: number | null;
  /** Percentuale di `r > 0` sui soli `resolved`, 2 decimali. */
  winRatePct: number | null;
  /** Somma di `r` sui soli `resolved`, 4 decimali. */
  sumR: number | null;
  /** Drawdown massimo cumulato di `r`, ordine `exitBarTs` poi `decidedAtMs`. */
  maxDrawdownR: number | null;
  /** Record esclusi dalle metriche per ritardo di osservazione. */
  nLate: number;
  /** Denominatore prima dell'esclusione dei record in ritardo. */
  nResolvedAll: number;
  /** Record con esito esclusi perche' il ritardo non e' calcolabile. */
  nDelayUnavailable: number;
  note: string;
}

function delayOf(record: PersistedShadowV1LiveRecord): number | null {
  const delay = record.firstSeenAtMs - record.decidedAtMs;
  if (!Number.isFinite(delay) || delay < 0) return null;
  return delay;
}

/** `true` solo con ritardo calcolabile e strettamente oltre la soglia. */
export function isLateObservation(delayMs: number | null): boolean {
  return delayMs !== null && delayMs > LATE_THRESHOLD_MS;
}

export interface ShadowV1LiveViewResponse {
  available: boolean;
  reason?: string;
  generatedAt: string;
  source: string;
  storeVersion: number;
  /** Soglia usata per `late`, cosi' il client non la duplica. */
  lateThresholdMs: number;
  limit: number;
  truncated: boolean;
  skippedLines: number;
  counts: ShadowV1LiveViewCounts;
  /** Solo record prodotti dal metodo corrente; il resto sta in `metricsLegacy`. */
  metrics: ShadowV1LiveViewMetrics;
  /** Record del metodo precedente (`@2`, `@1` o senza campo): non confrontabile. */
  metricsLegacy: ShadowV1LiveViewMetrics;
  records: ShadowV1LiveViewRecord[];
  limitations: string[];
}

const RESOLVED = new Set<ShadowV1LiveViewStatus>(['STOP', 'TARGET', 'EXPIRED']);
const KNOWN_STATUS = new Set<ShadowV1LiveViewStatus>([
  'PENDING_FILL',
  'OPEN',
  'STOP',
  'TARGET',
  'EXPIRED',
  'NOT_FILLED',
]);

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function emptyCounts(): ShadowV1LiveViewCounts {
  return {
    persisted: 0,
    pendingFill: 0,
    open: 0,
    stop: 0,
    target: 0,
    expired: 0,
    notFilled: 0,
    nonTerminal: 0,
    terminal: 0,
    stale: 0,
  };
}

function metricsOf(
  records: readonly PersistedShadowV1LiveRecord[],
  note: string
): ShadowV1LiveViewMetrics {
  const eligible = records.filter(
    (r) => RESOLVED.has(r.status) && typeof r.r === 'number' && Number.isFinite(r.r)
  );
  const resolved = eligible
    .filter((r) => {
      const delay = delayOf(r);
      return delay !== null && !isLateObservation(delay);
    })
    .sort((a, b) => {
      const ea = a.exitBarTs ?? a.decidedAtMs;
      const eb = b.exitBarTs ?? b.decidedAtMs;
      if (ea !== eb) return ea - eb;
      return a.decidedAtMs - b.decidedAtMs;
    });

  const rList = resolved.map((r) => r.r as number);
  const n = rList.length;
  const sum = rList.reduce((a, b) => a + b, 0);
  const wins = rList.filter((r) => r > 0).length;

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of rList) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  const nLate = eligible.filter((r) => isLateObservation(delayOf(r))).length;
  const nDelayUnavailable = eligible.filter((r) => delayOf(r) === null).length;

  return {
    resolved: n,
    meanR: n > 0 ? round(sum / n, 4) : null,
    winRatePct: n > 0 ? round((wins / n) * 100, 2) : null,
    sumR: n > 0 ? round(sum, 4) : null,
    maxDrawdownR: n > 0 ? round(maxDd, 4) : null,
    nLate,
    nResolvedAll: eligible.length,
    nDelayUnavailable,
    note,
  };
}

/**
 * Note delle due metriche (P18b). Il denominatore e la regola di ritardo sono
 * gli stessi: cambia solo il campione, separato per metodo del record.
 */
const METRICS_NOTE_COMMON =
  'Esplorativo: R di prezzo del nucleo V1-live, senza costi ne\' leva. ' +
  'Denominatore = record con esito STOP/TARGET/EXPIRED e r finito, esclusi ' +
  'quelli osservati oltre ' +
  `${LATE_THRESHOLD_MS / 60000} minuti dalla decisione o senza ritardo calcolabile. ` +
  'NOT_FILLED, PENDING_FILL e OPEN sono esclusi e non valgono zero.';

const METRICS_NOTE_CURRENT =
  'Campione del metodo v3 (`shadowV1Live@3`): i record del metodo precedente ' +
  'stanno in `metricsLegacy` e non entrano qui. ' +
  METRICS_NOTE_COMMON;

const METRICS_NOTE_LEGACY =
  'Campione del metodo precedente (`@2`, `@1` o senza campo): esiti prodotti da ' +
  'un metodo diverso da quello corrente, non confrontabile con metodo v3. ' +
  METRICS_NOTE_COMMON;

function toViewRecord(
  record: PersistedShadowV1LiveRecord,
  nowMs: number
): ShadowV1LiveViewRecord {
  return {
    key: record.key,
    ticker: record.ticker,
    market: record.market,
    direction: record.direction,
    status: record.status,
    decidedAtMs: record.decidedAtMs,
    sessionCloseMs: record.sessionCloseMs,
    stale: isStale(record, nowMs),
    delayMs: delayOf(record),
    late: isLateObservation(delayOf(record)),
    r: typeof record.r === 'number' && Number.isFinite(record.r) ? record.r : null,
    fillBarTs: record.fillBarTs,
    exitBarTs: record.exitBarTs,
    exitPrice: record.exitPrice,
    moduleVersion: record.moduleVersion ?? null,
    updatedAtMs: record.updatedAtMs,
  };
}

/**
 * Costruisce la risposta in modo deterministico: ordina per `decidedAtMs`
 * decrescente (poi `key`), tronca al limite e segnala `truncated` senza
 * silenzi. Funzione pura.
 */
export function buildShadowV1LiveView(input: {
  records: readonly PersistedShadowV1LiveRecord[];
  skippedLines: number;
  nowMs: number;
  generatedAt: string;
  limit?: number;
  available?: boolean;
  reason?: string;
}): ShadowV1LiveViewResponse {
  const limit = input.limit ?? SHADOW_V1_LIVE_VIEW_MAX_RECORDS;
  // `loadRecords` valida solo `v` e `key`: uno stato sconosciuto non deve
  // rompere i conteggi, quindi la riga viene ignorata e dichiarata.
  const usable = input.records.filter((r) => KNOWN_STATUS.has(r.status));
  const skippedLines = input.skippedLines + (input.records.length - usable.length);
  const all = [...usable].sort((a, b) => {
    if (a.decidedAtMs !== b.decidedAtMs) return b.decidedAtMs - a.decidedAtMs;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const truncated = all.length > limit;
  const shown = truncated ? all.slice(0, limit) : all;

  const counts = emptyCounts();
  for (const record of usable) {
    counts.persisted += 1;
    switch (record.status) {
      case 'PENDING_FILL':
        counts.pendingFill += 1;
        break;
      case 'OPEN':
        counts.open += 1;
        break;
      case 'STOP':
        counts.stop += 1;
        break;
      case 'TARGET':
        counts.target += 1;
        break;
      case 'EXPIRED':
        counts.expired += 1;
        break;
      case 'NOT_FILLED':
        counts.notFilled += 1;
        break;
    }
    if (record.status === 'PENDING_FILL' || record.status === 'OPEN') counts.nonTerminal += 1;
    else counts.terminal += 1;
    if (isStale(record, input.nowMs)) counts.stale += 1;
  }

  // P18b: separazione dei campioni. `counts` resta su tutti i record, mentre
  // `metrics` parla solo del metodo corrente e `metricsLegacy` raccoglie il resto:
  // mescolare metodi diversi in un solo aggregato non sarebbe confrontabile.
  const current = usable.filter((r) => r.moduleVersion === SHADOW_V1_LIVE_MODULE_VERSION);
  const legacy = usable.filter((r) => r.moduleVersion !== SHADOW_V1_LIVE_MODULE_VERSION);

  return {
    available: input.available ?? true,
    ...(input.reason ? { reason: input.reason } : {}),
    generatedAt: input.generatedAt,
    source: SHADOW_V1_LIVE_SIGNALS_PATH,
    storeVersion: SHADOW_V1_LIVE_STORE_VERSION,
    lateThresholdMs: LATE_THRESHOLD_MS,
    limit,
    truncated,
    skippedLines,
    counts,
    metrics: metricsOf(current, METRICS_NOTE_CURRENT),
    metricsLegacy: metricsOf(legacy, METRICS_NOTE_LEGACY),
    records: shown.map((r) => toViewRecord(r, input.nowMs)),
    limitations: [
      'Sola lettura: la vista non rivaluta i record e non scrive nulla.',
      'Calendario sessioni con festivita\' annuali e mezze giornate US; eventuali chiusure straordinarie una tantum restano escluse.',
      'Retention mensile: i record terminali di mesi precedenti sono archiviati in ' +
        '`signals-YYYY-MM.jsonl` accanto al file attivo (con sidecar di verifica) e la ' +
        'vista li legge insieme al file attivo; mostra al massimo gli ultimi ' +
        `${limit} record per decidedAtMs.`,
      'Righe con stato non riconosciuto sono ignorate e contate in skippedLines.',
      `Ritardo di osservazione oltre ${LATE_THRESHOLD_MS / 60000} minuti: record esclusi dalle metriche (nLate).`,
      '`metrics` conta solo i record del metodo v3 (`shadowV1Live@3`); i record `@2`, `@1` e quelli senza campo sono in `metricsLegacy`, non confrontabile con il metodo v3.',
      'Campione esplorativo, non un risultato operativo.',
    ],
  };
}

export interface ViewDeps {
  env: Record<string, string | undefined> | undefined;
  signalsPath: string;
  now: () => number;
  readRecords?: (path: string) => LoadResult;
  fileExists?: (path: string) => boolean;
  /** Elenco degli archivi mensili accanto al file attivo (default: `listArchivePaths`). */
  listArchives?: (signalsPath: string) => string[];
  limit?: number;
}

export interface ViewResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Handler della vista con dipendenze iniettate. A flag OFF nessuna lettura;
 * ogni errore di lettura e' catturato e diventa `available: false`.
 */
export function createShadowV1LiveViewHandler(
  deps: ViewDeps
): () => ViewResponse {
  const readRecords = deps.readRecords ?? loadRecords;
  const fileExists = deps.fileExists ?? ((p: string) => fs.existsSync(p));
  const listArchives = deps.listArchives ?? listArchivePaths;
  const limit = deps.limit ?? SHADOW_V1_LIVE_VIEW_MAX_RECORDS;

  return function handle(): ViewResponse {
    if (!isShadowV1LiveViewEnabled(deps.env)) {
      return {
        status: 404,
        body: { status: 'disabled', flag: SHADOW_V1_LIVE_VIEW_ENV },
      };
    }

    const nowMs = deps.now();
    const generatedAt = new Date(nowMs).toISOString();

    try {
      // File attivo + archivi mensili: la vista deve mostrare lo stesso insieme
      // di prima dell'archiviazione (dedup per chiave, ordine invariato).
      const archives = listArchives(deps.signalsPath);
      const files = [...(fileExists(deps.signalsPath) ? [deps.signalsPath] : []), ...archives];
      if (files.length === 0) {
        return {
          status: 200,
          body: {
            ...buildShadowV1LiveView({
              records: [],
              skippedLines: 0,
              nowMs,
              generatedAt,
              limit,
              available: false,
              reason: 'nessun file persistito',
            }),
          },
        };
      }

      const loaded = mergeRecordFiles(files, readRecords);
      return {
        status: 200,
        body: {
          ...buildShadowV1LiveView({
            records: loaded.records,
            skippedLines: loaded.skipped,
            nowMs,
            generatedAt,
            limit,
          }),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Shadow V1 Live View] lettura non riuscita: ${message}`);
      return {
        status: 200,
        body: {
          ...buildShadowV1LiveView({
            records: [],
            skippedLines: 0,
            nowMs,
            generatedAt,
            limit,
            available: false,
            reason: 'lettura non riuscita',
          }),
        },
      };
    }
  };
}

type MinimalApp = {
  get: (path: string, handler: (req: unknown, res: unknown) => void) => void;
};

type MinimalResponse = {
  status: (code: number) => { json: (body: unknown) => void };
};

export interface ViewRegistrationOptions {
  root?: string;
  env?: Record<string, string | undefined>;
}

/** Registrazione usata da server.ts: una riga. */
export function registerShadowV1LiveViewRoute(
  app: MinimalApp,
  options: ViewRegistrationOptions = {}
): void {
  const root = options.root ?? process.cwd();
  const env = options.env ?? process.env;
  const handler = createShadowV1LiveViewHandler({
    env,
    signalsPath: `${root}/${SHADOW_V1_LIVE_SIGNALS_PATH}`,
    now: () => Date.now(),
  });

  app.get(SHADOW_V1_LIVE_VIEW_PATH, (_req, res) => {
    const out = handler();
    const response = res as MinimalResponse;
    response.status(out.status).json(out.body);
  });
}
