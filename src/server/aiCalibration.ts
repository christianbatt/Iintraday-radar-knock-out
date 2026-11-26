/**
 * CALIBRAZIONE DEL DESK AI (PR-C) — che cosa ha deciso l'AI e come e' andata.
 *
 * Il log shadow AI registra le valutazioni (`shadow_ai_log.jsonl`, chiave
 * `runId:ticker`, `aiOutcome`, `status: NON_VALIDATO`, `outcome: null`): non sa
 * nulla dell'esito futuro. Shadow V1-live registra invece i setup emessi e il
 * loro R di prezzo (`artifacts/shadow_v1_live/signals.jsonl`).
 *
 * Questo modulo unisce le due fonti senza inventare nulla:
 * - dedup delle valutazioni per `candidateKey` (vince la piu' recente), come fa
 *   gia' il pannello Shadow AI, cosi' una riga `source: 'scan'` non conta due
 *   volte lo stesso candidato;
 * - join UNO-A-UNO per ticker entro una finestra fissa
 *   (`AI_CALIBRATION_MATCH_WINDOW_MS`): l'esito di un altro giorno sullo stesso
 *   titolo non e' l'esito di questa decisione, e una stessa osservazione forward
 *   non puo' essere attribuita a due decisioni (ne' una decisione a due esiti).
 *   Assegnazione greedy sulle coppie ordinate per distanza crescente, con
 *   spareggio deterministico;
 * - solo le VALUTAZIONI DI CANDIDATO entrano nei bucket: le direttive in prosa
 *   (`source: 'specialize'|'desk'` senza `candidateKey`) finiscono in
 *   `SCONOSCIUTO` e sono contate in `counts.directivesIgnored`. Anche un testo
 *   come "non comprare contro il trend" e' prosa, non un esito;
 * - bucket per decisione (`AZIONE` / `ATTESA` / `SCARTO`) con `n`, `meanR`,
 *   `winRatePct`;
 * - `edgeR` = meanR(AZIONE) − meanR(SCARTO): il numero che dice se il desk
 *   distingue i setup buoni dai cattivi. Senza almeno
 *   `AI_CALIBRATION_MIN_SAMPLE` valutazioni abbinate il verdetto resta
 *   `insufficient` e `edgeR` non viene presentato come risultato.
 *
 * NESSUN effetto collaterale: nessun I/O, nessun orologio globale, nessuna
 * scrittura. Non cambia memoria AI, non tocca gate o selezione dei setup.
 */

export const AI_CALIBRATION_VERSION = 'ai-calibration@1';
export const AI_CALIBRATION_PATH = '/api/shadow/ai-calibration';
/** Variabile d'ambiente: spenta solo con '0'/'false'; accesa di default. */
export const AI_CALIBRATION_ENV = 'SHADOW_AI_CALIBRATION';
/** Finestra di abbinamento decisione <-> esito forward. Fissa, non adattiva. */
export const AI_CALIBRATION_MATCH_WINDOW_MS = 30 * 60 * 1000;
/** Sotto questa numerosita' il verdetto e' `insufficient`. */
export const AI_CALIBRATION_MIN_SAMPLE = 30;
/** Tetto della risposta: solo i casi piu' recenti, per non gonfiare il payload. */
export const AI_CALIBRATION_MAX_ENTRIES = 2000;

export function isAiCalibrationEnabled(
  env: Record<string, string | undefined> | undefined
): boolean {
  const raw = env?.[AI_CALIBRATION_ENV];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false';
}

/** Decisione AI ricondotta a tre classi chiuse. */
export type AiDecisionClass = 'AZIONE' | 'ATTESA' | 'SCARTO' | 'SCONOSCIUTO';

/**
 * Classificazione per parola chiave sull'`aiOutcome` grezzo. Ordine deliberato:
 * prima lo scarto (un testo "SKIP: non comprare" non e' un'azione), poi
 * l'attesa, poi l'azione. Testo assente o vuoto => `SCONOSCIUTO`, che non entra
 * in nessun bucket e non altera `edgeR`.
 */
export function classifyAiOutcome(raw: string | null | undefined): AiDecisionClass {
  const text = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (text.length === 0) return 'SCONOSCIUTO';
  if (/(SKIP|SCART|EVITA|EVITARE|NO[-_ ]?TRADE|NON\s+COMPRARE|BOCCIAT)/.test(text)) return 'SCARTO';
  if (/(WAIT|ATTEND|MONITOR|OSSERVA|SOSPEND)/.test(text)) return 'ATTESA';
  if (/(BUY|SELL|LONG|SHORT|TRADE|APPROV|CONFERM|VALID|AZIONE|ENTRA)/.test(text)) return 'AZIONE';
  return 'SCONOSCIUTO';
}

/**
 * Classifica una RIGA del log, non un testo qualsiasi.
 *
 * Solo una valutazione di candidato (riga di scansione o riga con
 * `candidateKey`) descrive una decisione su un setup. Le direttive prodotte da
 * `specialize`/`desk` sono prosa: anche se contengono "non comprare" o "attendi"
 * NON sono un esito e restano `SCONOSCIUTO`.
 */
export function classifyEntryDecision(entry: AiCalibrationEntry): AiDecisionClass {
  const hasCandidateKey =
    typeof entry.candidateKey === 'string' && entry.candidateKey.length > 0;
  const isCandidateEvaluation = hasCandidateKey || entry.source === 'scan';
  if (!isCandidateEvaluation) return 'SCONOSCIUTO';
  return classifyAiOutcome(entry.aiOutcome);
}

export interface AiCalibrationEntry {
  id: string;
  timestamp: string;
  ticker: string | null;
  market: string;
  direction: string | null;
  source: string;
  aiOutcome: string | null;
  candidateKey?: string | null;
  evaluated?: boolean;
  discarded?: boolean;
}

export interface AiCalibrationForwardPoint {
  key: string;
  ticker: string;
  decidedAtMs: number;
  r: number;
  status: 'STOP' | 'TARGET' | 'EXPIRED';
}

export interface AiCalibrationBucket {
  decision: AiDecisionClass;
  n: number;
  meanR: number | null;
  winRatePct: number | null;
  sumR: number | null;
}

export interface AiCalibrationJoin {
  candidateKey: string | null;
  ticker: string;
  decision: AiDecisionClass;
  aiOutcome: string | null;
  r: number;
  forwardStatus: string;
  deltaMs: number;
}

export interface AiCalibrationResponse {
  version: typeof AI_CALIBRATION_VERSION;
  generatedAt: string;
  available: boolean;
  reason?: string;
  windowMs: number;
  minSample: number;
  sources: { aiLog: string; forward: string };
  counts: {
    aiEntries: number;
    dedupedEntries: number;
    forwardPoints: number;
    matched: number;
    unmatchedAiEntries: number;
    forwardWithoutDecision: number;
    skippedAiEntries: number;
    /** Righe in prosa (direttive senza `candidateKey`): mai classificate. */
    directivesIgnored: number;
  };
  buckets: AiCalibrationBucket[];
  /** meanR(AZIONE) − meanR(SCARTO); `null` se manca uno dei due campioni. */
  edgeR: number | null;
  /** Decisioni di scarto su setup che poi sono andati in positivo. */
  skippedWinners: AiCalibrationJoin[];
  verdict: 'insufficient' | 'evidence';
  note: string;
  limitations: string[];
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function finiteR(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const BUCKET_ORDER: readonly AiDecisionClass[] = ['AZIONE', 'ATTESA', 'SCARTO'];

function bucketOf(rows: readonly AiCalibrationJoin[]): AiCalibrationBucket[] {
  return BUCKET_ORDER.map((decision) => {
    const rs = rows.filter((row) => row.decision === decision).map((row) => row.r);
    const n = rs.length;
    const sum = rs.reduce((a, b) => a + b, 0);
    const wins = rs.filter((r) => r > 0).length;
    return {
      decision,
      n,
      meanR: n > 0 ? round(sum / n, 4) : null,
      winRatePct: n > 0 ? round((wins / n) * 100, 2) : null,
      sumR: n > 0 ? round(sum, 4) : null,
    };
  });
}

/**
 * Dedup per `candidateKey` (vince l'ultima riga per timestamp): le righe senza
 * chiave restano distinte per `id`, come nel pannello Shadow AI.
 */
function dedupeEntries(entries: readonly AiCalibrationEntry[]): AiCalibrationEntry[] {
  const latest = new Map<string, AiCalibrationEntry>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const key =
      typeof entry.candidateKey === 'string' && entry.candidateKey.length > 0
        ? `candidate:${entry.candidateKey}`
        : `raw:${entry.id}`;
    const previous = latest.get(key);
    if (!previous) {
      latest.set(key, entry);
      continue;
    }
    const prevAt = Date.parse(previous.timestamp) || 0;
    const nextAt = Date.parse(entry.timestamp) || 0;
    if (nextAt >= prevAt) latest.set(key, entry);
  }
  return [...latest.values()];
}

/** Indice ticker -> punti forward ordinati per istante di decisione. */
function indexForward(
  forward: readonly AiCalibrationForwardPoint[]
): Map<string, AiCalibrationForwardPoint[]> {
  const byTicker = new Map<string, AiCalibrationForwardPoint[]>();
  for (const point of forward) {
    if (!point || typeof point.ticker !== 'string' || point.ticker.length === 0) continue;
    if (!finiteR(point.r) || !finiteR(point.decidedAtMs)) continue;
    const list = byTicker.get(point.ticker) ?? [];
    list.push(point);
    byTicker.set(point.ticker, list);
  }
  for (const list of byTicker.values()) list.sort((a, b) => a.decidedAtMs - b.decidedAtMs);
  return byTicker;
}

/** Una riga rappresenta una decisione su un setup? (scansione o candidateKey) */
function isCandidateRow(entry: AiCalibrationEntry): boolean {
  if (typeof entry.candidateKey === 'string' && entry.candidateKey.length > 0) return true;
  return entry.source === 'scan';
}

/**
 * Costruisce la risposta di calibrazione. Pura: stesso input => stesso output.
 */
export function buildAiCalibration(input: {
  entries: readonly AiCalibrationEntry[];
  forward: readonly AiCalibrationForwardPoint[];
  nowMs: number;
  generatedAt: string;
  windowMs?: number;
  minSample?: number;
}): AiCalibrationResponse {
  const windowMs = input.windowMs ?? AI_CALIBRATION_MATCH_WINDOW_MS;
  const minSample = input.minSample ?? AI_CALIBRATION_MIN_SAMPLE;
  const rawEntries = Array.isArray(input.entries) ? input.entries : [];
  const cappedEntries = rawEntries.slice(-AI_CALIBRATION_MAX_ENTRIES);
  const deduped = dedupeEntries(cappedEntries);
  const forwardIndex = indexForward(Array.isArray(input.forward) ? input.forward : []);

  // Solo valutazioni di candidato; la prosa resta fuori e viene dichiarata.
  interface Candidate {
    entry: AiCalibrationEntry;
    ticker: string;
    atMs: number;
    order: number;
  }
  const candidates: Candidate[] = [];
  let skippedAiEntries = 0;
  let directivesIgnored = 0;
  deduped.forEach((entry, order) => {
    if (!isCandidateRow(entry)) {
      directivesIgnored += 1;
      return;
    }
    const ticker = typeof entry.ticker === 'string' ? entry.ticker.trim() : '';
    const atMs = Date.parse(entry.timestamp);
    if (ticker.length === 0 || !Number.isFinite(atMs)) {
      skippedAiEntries += 1;
      return;
    }
    candidates.push({ entry, ticker, atMs, order });
  });

  // Coppie possibili entro la finestra, ordinate per distanza crescente: cosi'
  // l'abbinamento e' uno-a-uno e vince sempre la coppia piu' vicina.
  interface Pair {
    candidate: Candidate;
    point: AiCalibrationForwardPoint;
    delta: number;
  }
  const pairs: Pair[] = [];
  for (const candidate of candidates) {
    for (const point of forwardIndex.get(candidate.ticker) ?? []) {
      const delta = Math.abs(point.decidedAtMs - candidate.atMs);
      if (delta > windowMs) continue;
      pairs.push({ candidate, point, delta });
    }
  }
  pairs.sort((a, b) => {
    if (a.delta !== b.delta) return a.delta - b.delta;
    if (a.candidate.atMs !== b.candidate.atMs) return a.candidate.atMs - b.candidate.atMs;
    if (a.candidate.order !== b.candidate.order) return a.candidate.order - b.candidate.order;
    return a.point.key < b.point.key ? -1 : a.point.key > b.point.key ? 1 : 0;
  });

  const matchedOrders = new Set<number>();
  const usedPointKeys = new Set<string>();
  const joined: AiCalibrationJoin[] = [];
  for (const pair of pairs) {
    if (matchedOrders.has(pair.candidate.order)) continue;
    if (usedPointKeys.has(pair.point.key)) continue;
    matchedOrders.add(pair.candidate.order);
    usedPointKeys.add(pair.point.key);
    const { entry, ticker, atMs } = pair.candidate;
    joined.push({
      candidateKey:
        typeof entry.candidateKey === 'string' && entry.candidateKey.length > 0
          ? entry.candidateKey
          : null,
      ticker,
      decision: classifyEntryDecision(entry),
      aiOutcome: entry.aiOutcome ?? null,
      r: pair.point.r,
      forwardStatus: pair.point.status,
      deltaMs: Math.round(pair.point.decidedAtMs - atMs),
    });
  }
  const unmatchedAiEntries = candidates.length - joined.length;

  const buckets = bucketOf(joined);
  const action = buckets.find((b) => b.decision === 'AZIONE');
  const skip = buckets.find((b) => b.decision === 'SCARTO');
  const edgeR =
    action && skip && action.meanR !== null && skip.meanR !== null
      ? round(action.meanR - skip.meanR, 4)
      : null;

  const skippedWinners = joined
    .filter((row) => row.decision === 'SCARTO' && row.r > 0)
    .sort((a, b) => b.r - a.r)
    .slice(0, 10);

  const forwardPoints = [...forwardIndex.values()].reduce((n, list) => n + list.length, 0);
  const matched = joined.length;
  const available = deduped.length > 0 && forwardPoints > 0;
  const verdict: AiCalibrationResponse['verdict'] =
    matched >= minSample ? 'evidence' : 'insufficient';

  return {
    version: AI_CALIBRATION_VERSION,
    generatedAt: input.generatedAt,
    available,
    ...(available ? {} : { reason: deduped.length === 0 ? 'nessuna valutazione AI nel log' : 'nessun esito forward disponibile' }),
    windowMs,
    minSample,
    sources: {
      aiLog: 'shadow_ai_log.jsonl',
      forward: 'artifacts/shadow_v1_live/signals.jsonl',
    },
    counts: {
      aiEntries: rawEntries.length,
      dedupedEntries: deduped.length,
      forwardPoints,
      matched,
      unmatchedAiEntries,
      forwardWithoutDecision: Math.max(0, forwardPoints - usedPointKeys.size),
      skippedAiEntries,
      directivesIgnored,
    },
    buckets,
    edgeR,
    skippedWinners,
    verdict,
    note:
      verdict === 'evidence'
        ? `Campione abbinato ${matched} >= ${minSample}: edgeR calcolato.`
        : `Campione abbinato ${matched} < ${minSample}: nessuna conclusione, edgeR non e' un risultato.`,
    limitations: [
      'Sola lettura: nessuna scrittura, nessun cambio di memoria AI, gate o selezione setup.',
      'Il join e\' per ticker e prossimita\' temporale (finestra fissa); non dimostra che la decisione AI abbia causato l\'esito.',
      'L\'R di V1-live e\' di prezzo (senza costi ne\' leva) e solo su setup emessi con decisione TRADE: i candidati mai emessi non hanno esito forward e restano non abbinati.',
      `Righe AI senza esito entro ${Math.round(windowMs / 60000)} minuti sono contate come non abbinate, non come zero.`,
      'Il desk resta NON_VALIDATO finche\' il validatore deterministico non conferma: questa vista e\' esplorativa.',
    ],
  };
}

export interface AiCalibrationRegistrationDeps {
  readEntries: () => AiCalibrationEntry[];
  readForward: () => AiCalibrationForwardPoint[];
  env?: Record<string, string | undefined>;
  now?: () => number;
}

type MinimalApp = { get: (path: string, handler: (req: unknown, res: unknown) => void) => void };
type MinimalResponse = { status: (code: number) => { json: (body: unknown) => void } };

/**
 * Handler con dipendenze iniettate: a flag OFF nessuna lettura; ogni errore
 * diventa `available: false`, mai una 500.
 */
export function createAiCalibrationHandler(
  deps: AiCalibrationRegistrationDeps
): () => { status: number; body: Record<string, unknown> | AiCalibrationResponse } {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  return function handle() {
    if (!isAiCalibrationEnabled(env)) {
      return { status: 404, body: { status: 'disabled', flag: AI_CALIBRATION_ENV } };
    }
    const nowMs = now();
    try {
      return {
        status: 200,
        body: buildAiCalibration({
          entries: deps.readEntries(),
          forward: deps.readForward(),
          nowMs,
          generatedAt: new Date(nowMs).toISOString(),
        }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[AI Calibration] lettura non riuscita: ${message}`);
      return {
        status: 200,
        body: buildAiCalibration({
          entries: [],
          forward: [],
          nowMs,
          generatedAt: new Date(nowMs).toISOString(),
        }),
      };
    }
  };
}

export function registerAiCalibrationRoute(
  app: MinimalApp,
  deps: AiCalibrationRegistrationDeps
): void {
  const handler = createAiCalibrationHandler(deps);
  app.get(AI_CALIBRATION_PATH, (_req, res) => {
    const out = handler();
    (res as MinimalResponse).status(out.status).json(out.body);
  });
}
