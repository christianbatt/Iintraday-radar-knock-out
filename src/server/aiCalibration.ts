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
 * - la decisione viene dal campo CHIUSO `decision` scritto dall'handler
 *   (`AZIONE`/`ATTESA`/`SCARTO`). La classificazione testuale sopravvive solo
 *   per le righe storiche, scritte prima di quel campo: nessuna euristica sul
 *   testo quando l'handler ha gia' deciso;
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

import { isAiShadowDecision } from './aiShadowLog';
import { SHADOW_V2_HYPOTHESES } from '../knowledge/shadowV2';
import {
  AI_DESK_VALIDATION_MIN_PER_BUCKET,
  AI_DESK_VALIDATION_VERSION,
  validateAiDeskSample,
  type AiDeskValidation,
} from './aiDeskValidator';

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

/**
 * INCERTEZZA CAMPIONARIA: le soglie del validatore si applicano a stime
 * puntuali. Con 10 casi per lato un `edgeR` di +0.25 R ha un intervallo che
 * attraversa lo zero: il bootstrap percentile DETERMINISTICO (seed fissa,
 * nessun orologio, nessun I/O) rende visibile quella fragilita' senza
 * introdurre casualita' nella risposta. Gli intervalli sono calcolati sul R
 * NETTO, come il verdetto, e riguardano il SEGNO dell'edge: la soglia di +0.2 R
 * resta una regola sulla stima puntuale.
 */
export const AI_CALIBRATION_BOOTSTRAP_ITERATIONS = 2000;
export const AI_CALIBRATION_BOOTSTRAP_SEED = 0x5eed1a7e;
export const AI_CALIBRATION_CONFIDENCE = 0.95;
/**
 * Copertura minima del log: sotto questa quota di candidati davvero valutati il
 * campione descrive la pipeline (chiavi assenti, batch falliti), non il desk.
 * Vale solo con almeno `AI_CALIBRATION_ALERT_MIN_SAMPLE` candidati, per non
 * allarmare su tre righe.
 */
export const AI_CALIBRATION_MIN_EVALUATED_SHARE = 0.5;

/**
 * R NETTO: la calibrazione misurava l'R di prezzo (lordo). Un costo costante per
 * trade non sposta `edgeR` (differenza di medie), ma sposta `meanR` e soprattutto
 * il win rate: un trade chiuso appena sopra zero diventa perdente. Modello
 * dichiarato, riusato da Shadow V2 invece di inventare numeri nuovi:
 *
 * - commissione reale Trade Republic round-trip (EUR 2.00) sul rischio di
 *   riferimento (capitale 1000 EUR * rischio 1% = 10 EUR) => 0.20 R;
 * - proxy spread sottostante: le barre di V1-live non portano Corwin-Schultz,
 *   quindi si usa il TETTO dichiarato `UNDERLYING_SPREAD_MAX_R` (0.16 R) come
 *   costo conservativo, non misurato;
 * - totale 0.36 R per trade, uguale su AZIONE e SCARTO.
 */
export const AI_CALIBRATION_NET_FEE_R = Math.round(
  (SHADOW_V2_HYPOTHESES.FEE_ROUNDTRIP_EUR /
    (SHADOW_V2_HYPOTHESES.REFERENCE_CAPITAL_EUR * SHADOW_V2_HYPOTHESES.RISK_PCT)) *
    10_000
) / 10_000;
export const AI_CALIBRATION_NET_SPREAD_R = SHADOW_V2_HYPOTHESES.UNDERLYING_SPREAD_MAX_R;
export const AI_CALIBRATION_NET_COST_R =
  Math.round((AI_CALIBRATION_NET_FEE_R + AI_CALIBRATION_NET_SPREAD_R) * 10_000) / 10_000;

/**
 * Allarmi di formato: sotto questi denominatori una percentuale e' rumore,
 * quindi nessun allarme (meglio nessun avviso che un falso allarme su 3 righe).
 */
export const AI_CALIBRATION_ALERT_MIN_SAMPLE = 10;
/** Oltre questa quota di abbinamenti in SCONOSCIUTO il formato si sta degradando. */
export const AI_CALIBRATION_UNKNOWN_ALERT_RATIO = 0.3;
/**
 * Oltre questa quota di righe in prosa (direttive) il log non descrive piu'
 * decisioni: la calibrazione resta senza materia prima.
 */
export const AI_CALIBRATION_DIRECTIVES_ALERT_RATIO = 0.5;

export type AiCalibrationAlertCode =
  | 'UNKNOWN_SHARE_HIGH'
  | 'DIRECTIVES_SHARE_HIGH'
  | 'COVERAGE_LOW';

export interface AiCalibrationAlert {
  code: AiCalibrationAlertCode;
  /** Quota osservata, 4 decimali. */
  ratio: number;
  /** Soglia superata. */
  threshold: number;
  numerator: number;
  denominator: number;
  message: string;
}

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
 * Precedenza (l'ordine conta):
 * 1. riga non-candidato (prosa senza `candidateKey`) => `SCONOSCIUTO`,
 *    qualunque cosa contenga, `decision` compresa. Una decisione chiusa su una
 *    direttiva e' un dato incoerente: non deve entrare nei bucket;
 * 2. `decision` chiusa scritta dall'handler (fonte di verita');
 * 3. per le sole righe storiche senza `decision`, classificazione testuale
 *    dell'`aiOutcome`.
 */
export function classifyEntryDecision(entry: AiCalibrationEntry): AiDecisionClass {
  if (!isCandidateRow(entry)) return 'SCONOSCIUTO';
  if (isAiShadowDecision(entry.decision)) return entry.decision;
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
  /** Motivo chiuso dello scarto (`AI_SHADOW_DISCARD_REASONS`), per la copertura. */
  discardReason?: string | null;
  /** Durata del batch LLM che ha prodotto la valutazione (P4). */
  durationMs?: number | null;
  /** Campo chiuso scritto dall'handler; assente nelle righe storiche. */
  decision?: string | null;
}

export interface AiCalibrationForwardPoint {
  key: string;
  ticker: string;
  decidedAtMs: number;
  r: number;
  status: 'STOP' | 'TARGET' | 'EXPIRED';
  /**
   * Origine dell'esito: `signals` (setup emesso; default per le righe senza
   * campo), `near_miss` (setup bloccato da un solo gate e mai emesso) oppure
   * `rejected` (altro scarto con livelli coerenti, mai emesso). Gli ultimi due
   * sono esiti controfattuali. Non cambia il join, serve a dichiarare i numeri.
   */
  source?: 'signals' | 'near_miss' | 'rejected';
}

/** Campi dei record near-miss usati come esito (strutturale: nessun import). */
export interface AiCalibrationNearMissRecord {
  id: string;
  ticker: string;
  decidedAtMs: number;
  r: number | null;
  status: string;
}

const NEAR_MISS_RESOLVED_STATUSES = new Set(['TARGET', 'STOP', 'EXPIRED']);

/**
 * Record di esito gia' persistiti letti come punti forward (near-miss e scarti
 * condividono la stessa forma: qui non si importa nulla dal server).
 */
export type AiCalibrationRejectedRecord = AiCalibrationNearMissRecord;

/**
 * Converte i record near-miss GIA' persistiti in punti forward.
 *
 * Nessun nuovo macchinario: il tracker near-miss calcola gia' l'esito reale
 * sulle barre chiuse con lo stesso motore deterministico di Shadow V1-live.
 * Qui si leggono solo gli stati terminali con R finito: `PENDING_FILL`, `OPEN`
 * e `NOT_FILLED` non hanno un esito e restano fuori (non sono zero). La chiave
 * e' prefissata per non collidere con quelle di `signals.jsonl`.
 */
function mapOutcomeForwardPoints(
  records: readonly AiCalibrationNearMissRecord[],
  source: 'near_miss' | 'rejected'
): AiCalibrationForwardPoint[] {
  const points: AiCalibrationForwardPoint[] = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record.ticker !== 'string' || record.ticker.length === 0) continue;
    if (!NEAR_MISS_RESOLVED_STATUSES.has(record.status)) continue;
    if (typeof record.r !== 'number' || !Number.isFinite(record.r)) continue;
    if (typeof record.decidedAtMs !== 'number' || !Number.isFinite(record.decidedAtMs)) continue;
    points.push({
      key: `${source}:${
        typeof record.id === 'string' && record.id.length > 0
          ? record.id
          : `${record.ticker}@${record.decidedAtMs}`
      }`,
      ticker: record.ticker,
      decidedAtMs: record.decidedAtMs,
      r: record.r,
      status: record.status as AiCalibrationForwardPoint['status'],
      source,
    });
  }
  return points;
}

export function mapNearMissForwardPoints(
  records: readonly AiCalibrationNearMissRecord[]
): AiCalibrationForwardPoint[] {
  return mapOutcomeForwardPoints(records, 'near_miss');
}

/**
 * Converte gli esiti dei candidati scartati fuori dal near-miss (stessa forma:
 * stati terminali + R finito). Chiave prefissata `rejected:`.
 */
export function mapRejectedForwardPoints(
  records: readonly AiCalibrationRejectedRecord[]
): AiCalibrationForwardPoint[] {
  return mapOutcomeForwardPoints(records, 'rejected');
}

export interface AiCalibrationBucket {
  decision: AiDecisionClass;
  n: number;
  meanR: number | null;
  winRatePct: number | null;
  sumR: number | null;
  /** Media di R al netto dei costi dichiarati (`netModel.totalR`). */
  meanRNet: number | null;
  /** Successo calcolato sull'R netto: un trade a +0.1R lordo e' perdente netto. */
  winRateNetPct: number | null;
  sumRNet: number | null;
}

export interface AiCalibrationJoin {
  candidateKey: string | null;
  ticker: string;
  /** Mercato e direzione della decisione: servono agli strati, non al join. */
  market: string;
  direction: string | null;
  decision: AiDecisionClass;
  aiOutcome: string | null;
  r: number;
  /** R al netto dei costi dichiarati. */
  rNet: number;
  forwardStatus: string;
  deltaMs: number;
}

/** Intervallo percentile di un bootstrap deterministico. */
export interface AiCalibrationInterval {
  lower: number;
  upper: number;
}

export interface AiCalibrationUncertainty {
  method: 'bootstrap-percentile';
  iterations: number;
  seed: number;
  confidence: number;
  /** Gli intervalli sono sul R netto, come il verdetto del validatore. */
  net: true;
  edgeR: AiCalibrationInterval | null;
  winRateGapPct: AiCalibrationInterval | null;
  note: string;
}

/**
 * Copertura della pipeline: quanti candidati il desk ha davvero valutato. Una
 * calibrazione su un campione valutato al 2% e' formalmente valida e
 * sostanzialmente inutile, quindi il numero sta nella risposta e produce un
 * allarme (e un blocco del validatore) sotto la soglia dichiarata.
 */
export interface AiCalibrationCoverage {
  candidates: number;
  evaluated: number;
  notEvaluated: number;
  /** Righe storiche senza il campo booleano `evaluated`: fuori dal denominatore. */
  unknown: number;
  evaluatedSharePct: number | null;
  parseErrorRatePct: number | null;
  byReason: { reason: string; count: number }[];
  latency: { samples: number; p50Ms: number | null; p95Ms: number | null };
}

/** L'ordinalita' del schema a tre classi: SCARTO < ATTESA < AZIONE. */
export interface AiCalibrationOrdinality {
  status: 'ordinato' | 'non_ordinato' | 'non_valutabile';
  detail: string;
}

/** Valore di una policy di selezione, in R netto per trade. */
export interface AiCalibrationPolicyRow {
  code: 'SOLO_AZIONE' | 'AZIONE_E_ATTESA' | 'TUTTI_I_CLASSIFICATI';
  decisions: AiDecisionClass[];
  trades: number;
  sumRNet: number | null;
  meanRNet: number | null;
  winRateNetPct: number | null;
}

/**
 * Strato esplorativo (mercato o direzione). `contradicts` segnala uno strato con
 * entrambi i lati sufficienti e edge netto negativo: non cambia il verdetto,
 * ma impedisce di leggere un edge aggregato come se valesse ovunque.
 */
export interface AiCalibrationStratum {
  dimension: 'market' | 'direction';
  value: string;
  matched: number;
  actionN: number;
  skipN: number;
  edgeRNet: number | null;
  contradicts: boolean;
}

export interface AiCalibrationResponse {
  version: typeof AI_CALIBRATION_VERSION;
  generatedAt: string;
  available: boolean;
  reason?: string;
  windowMs: number;
  minSample: number;
  /** Il campione letto ha toccato il tetto: puo' essere incompleto. */
  truncated: boolean;
  /** Tetto applicato alla lettura (0 = non dichiarato). */
  readLimit: number;
  sources: { aiLog: string; forward: string };
  counts: {
    aiEntries: number;
    dedupedEntries: number;
    forwardPoints: number;
    /** Punti forward controfattuali forniti dal tracker near-miss. */
    nearMissForwardPoints: number;
    /** Abbinamenti che hanno usato un esito near-miss. */
    nearMissMatched: number;
    /** Punti forward controfattuali forniti dal registro degli altri scarti. */
    rejectedForwardPoints: number;
    /** Abbinamenti che hanno usato un esito di un candidato scartato fuori dal near-miss. */
    rejectedMatched: number;
    matched: number;
    /** Abbinamenti con una decisione utilizzabile (tutti tranne SCONOSCIUTO). */
    classified: number;
    /** Voci effettivamente lette da Firestore (0 = fallback inutile). */
    remoteEntries: number;
    unmatchedAiEntries: number;
    forwardWithoutDecision: number;
    skippedAiEntries: number;
    /** Righe in prosa (direttive senza `candidateKey`): mai classificate. */
    directivesIgnored: number;
  };
  /** `sum(buckets[].n)` e' sempre uguale a `counts.matched`. */
  buckets: AiCalibrationBucket[];
  /** meanR(AZIONE) − meanR(SCARTO); `null` se manca uno dei due campioni. */
  edgeR: number | null;
  /** Stessa differenza sui valori netti (invariante a un costo costante). */
  edgeRNet: number | null;
  /** Costo per trade applicato a ogni abbinamento, in R. */
  costR: number;
  /** Modello di costo dichiarato (fonte e componenti). */
  netModel: {
    feeR: number;
    spreadR: number;
    totalR: number;
    source: string;
  };
  /** Incertezza campionaria dell'edge e del divario di successo (R netto). */
  uncertainty: AiCalibrationUncertainty;
  /** Copertura della pipeline LLM (candidati valutati / candidati nel log). */
  coverage: AiCalibrationCoverage;
  /** Ordinalita' di ATTESA fra SCARTO e AZIONE (diagnostica, non verdetto). */
  ordinality: AiCalibrationOrdinality;
  /** R netto per trade di tre policy di selezione. */
  policies: AiCalibrationPolicyRow[];
  /** Edge per mercato e per direzione, con le contraddizioni dichiarate. */
  strata: AiCalibrationStratum[];
  /** Decisioni di scarto su setup che poi sono andati in positivo. */
  skippedWinners: AiCalibrationJoin[];
  /** Allarmi di formato: vuoto quando la quota e' sotto soglia. */
  alerts: AiCalibrationAlert[];
  verdict: 'insufficient' | 'evidence';
  /**
   * Verdetto del validatore deterministico (`ai-desk-validation@1`): soglie
   * fisse applicate al campione aggregato, nessun effetto su gate o selezione.
   */
  validation: AiDeskValidation;
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

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function meanDiff(a: readonly number[], b: readonly number[]): number {
  return mean(a) - mean(b);
}

function winSharePct(values: readonly number[]): number {
  return (values.filter((value) => value > 0).length / values.length) * 100;
}

/** PRNG deterministico (mulberry32): nessuna dipendenza, nessun orologio. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile nearest-rank su un array gia' ordinato. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1)))
  );
  return sorted[index];
}

/**
 * Intervallo bootstrap percentile della differenza fra due campioni. `null`
 * sotto 2 esiti per lato: con un solo valore l'intervallo sarebbe una certezza
 * finta, non un'informazione.
 */
function bootstrapInterval(
  a: readonly number[],
  b: readonly number[],
  iterations: number,
  statistic: (sampleA: number[], sampleB: number[]) => number,
  seed: number
): AiCalibrationInterval | null {
  if (a.length < 2 || b.length < 2) return null;
  const random = mulberry32(seed);
  const values: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const sampleA: number[] = new Array(a.length);
    for (let j = 0; j < a.length; j += 1) sampleA[j] = a[Math.floor(random() * a.length)];
    const sampleB: number[] = new Array(b.length);
    for (let j = 0; j < b.length; j += 1) sampleB[j] = b[Math.floor(random() * b.length)];
    values.push(statistic(sampleA, sampleB));
  }
  values.sort((x, y) => x - y);
  const alpha = (1 - AI_CALIBRATION_CONFIDENCE) / 2;
  return {
    lower: round(percentile(values, alpha), 4),
    upper: round(percentile(values, 1 - alpha), 4),
  };
}

function buildUncertainty(
  action: readonly number[],
  skip: readonly number[]
): AiCalibrationUncertainty {
  return {
    method: 'bootstrap-percentile',
    iterations: AI_CALIBRATION_BOOTSTRAP_ITERATIONS,
    seed: AI_CALIBRATION_BOOTSTRAP_SEED,
    confidence: AI_CALIBRATION_CONFIDENCE,
    net: true,
    edgeR: bootstrapInterval(
      action,
      skip,
      AI_CALIBRATION_BOOTSTRAP_ITERATIONS,
      meanDiff,
      AI_CALIBRATION_BOOTSTRAP_SEED
    ),
    winRateGapPct: bootstrapInterval(
      action,
      skip,
      AI_CALIBRATION_BOOTSTRAP_ITERATIONS,
      (sampleA, sampleB) => winSharePct(sampleA) - winSharePct(sampleB),
      AI_CALIBRATION_BOOTSTRAP_SEED + 1
    ),
    note:
      'Bootstrap percentile deterministico sul R netto (seed fissa): descrive ' +
      'l incertezza campionaria del segno, non una probabilita di profitto.',
  };
}

/**
 * Copertura della pipeline sui candidati del log, non sui soli abbinati: se il
 * desk non ha mai visto i candidati, il join non puo' accorgersene.
 */
function buildCoverage(rows: readonly AiCalibrationEntry[]): AiCalibrationCoverage {
  const candidateRows = rows.filter(isCandidateRow);
  const evaluated = candidateRows.filter((row) => row.evaluated === true);
  const notEvaluated = candidateRows.filter((row) => row.evaluated === false);
  // Le righe storiche senza il campo booleano non sono ne' valutate ne' no:
  // contarle come "non valutate" produrrebbe allarmi su dati che non dicono
  // nulla sulla pipeline. Restano dichiarate in `unknown`.
  const known = evaluated.length + notEvaluated.length;
  const byReason = new Map<string, number>();
  let parseErrors = 0;
  for (const row of notEvaluated) {
    const reason = typeof row.discardReason === 'string' ? row.discardReason.trim() : '';
    if (reason.length === 0) continue;
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    if (reason === 'ERRORE_PARSING') parseErrors += 1;
  }
  const durations = candidateRows
    .filter((row) => row.evaluated === true && finiteR(row.durationMs))
    .map((row) => row.durationMs as number)
    .sort((a, b) => a - b);
  const candidates = candidateRows.length;
  return {
    candidates,
    evaluated: evaluated.length,
    notEvaluated: notEvaluated.length,
    unknown: candidates - known,
    evaluatedSharePct: known > 0 ? round((evaluated.length / known) * 100, 2) : null,
    parseErrorRatePct: known > 0 ? round((parseErrors / known) * 100, 2) : null,
    byReason: [...byReason.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([reason, count]) => ({ reason, count })),
    latency: {
      samples: durations.length,
      p50Ms: durations.length > 0 ? Math.round(percentile(durations, 0.5)) : null,
      p95Ms: durations.length > 0 ? Math.round(percentile(durations, 0.95)) : null,
    },
  };
}

function buildStrata(rows: readonly AiCalibrationJoin[]): AiCalibrationStratum[] {
  const strata: AiCalibrationStratum[] = [];
  for (const dimension of ['market', 'direction'] as const) {
    const groups = new Map<string, AiCalibrationJoin[]>();
    for (const row of rows) {
      const raw = dimension === 'market' ? row.market : row.direction;
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (value.length === 0) continue;
      const list = groups.get(value) ?? [];
      list.push(row);
      groups.set(value, list);
    }
    for (const [value, group] of [...groups.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    )) {
      const action = group.filter((row) => row.decision === 'AZIONE').map((row) => row.rNet);
      const skip = group.filter((row) => row.decision === 'SCARTO').map((row) => row.rNet);
      const edgeRNet =
        action.length > 0 && skip.length > 0
          ? round(mean(action) - mean(skip), 4)
          : null;
      strata.push({
        dimension,
        value,
        matched: group.length,
        actionN: action.length,
        skipN: skip.length,
        edgeRNet,
        contradicts:
          edgeRNet !== null &&
          edgeRNet < 0 &&
          action.length >= AI_DESK_VALIDATION_MIN_PER_BUCKET &&
          skip.length >= AI_DESK_VALIDATION_MIN_PER_BUCKET,
      });
    }
  }
  return strata;
}

function buildPolicies(rows: readonly AiCalibrationJoin[]): AiCalibrationPolicyRow[] {
  const definitions: {
    code: AiCalibrationPolicyRow['code'];
    decisions: AiDecisionClass[];
  }[] = [
    { code: 'SOLO_AZIONE', decisions: ['AZIONE'] },
    { code: 'AZIONE_E_ATTESA', decisions: ['AZIONE', 'ATTESA'] },
    { code: 'TUTTI_I_CLASSIFICATI', decisions: ['AZIONE', 'ATTESA', 'SCARTO'] },
  ];
  return definitions.map(({ code, decisions }) => {
    const values = rows
      .filter((row) => decisions.includes(row.decision))
      .map((row) => row.rNet);
    return {
      code,
      decisions,
      trades: values.length,
      sumRNet: values.length > 0 ? round(values.reduce((total, value) => total + value, 0), 4) : null,
      meanRNet: values.length > 0 ? round(mean(values), 4) : null,
      winRateNetPct: values.length > 0 ? round(winSharePct(values), 2) : null,
    };
  });
}

/**
 * ATTESA deve stare fra SCARTO e AZIONE, altrimenti la terza classe non porta
 * informazione. Diagnostica: non entra nel verdetto e non promuove nulla.
 */
function buildOrdinality(
  buckets: readonly AiCalibrationBucket[]
): AiCalibrationOrdinality {
  const bucketOf = (decision: AiDecisionClass) =>
    buckets.find((bucket) => bucket.decision === decision) ?? null;
  const action = bucketOf('AZIONE');
  const wait = bucketOf('ATTESA');
  const skip = bucketOf('SCARTO');
  const minimum = AI_DESK_VALIDATION_MIN_PER_BUCKET;
  if (
    !action ||
    !wait ||
    !skip ||
    action.n < minimum ||
    wait.n < minimum ||
    skip.n < minimum ||
    action.meanRNet === null ||
    wait.meanRNet === null ||
    skip.meanRNet === null
  ) {
    return {
      status: 'non_valutabile',
      detail:
        `AZIONE ${action?.n ?? 0}, ATTESA ${wait?.n ?? 0}, SCARTO ${skip?.n ?? 0}: ` +
        `servono almeno ${minimum} casi e una media netta per ciascuna classe.`,
    };
  }
  const ordered = skip.meanRNet <= wait.meanRNet && wait.meanRNet <= action.meanRNet;
  return {
    status: ordered ? 'ordinato' : 'non_ordinato',
    detail:
      `R netto SCARTO ${skip.meanRNet} <= ATTESA ${wait.meanRNet} <= AZIONE ${action.meanRNet}: ` +
      (ordered
        ? 'le tre classi sono ordinate.'
        : 'ATTESA non sta fra le altre due: la classe intermedia non porta informazione.'),
  };
}

/**
 * Ordine dei bucket nella risposta. Include `SCONOSCIUTO` di proposito: ogni riga
 * abbinata deve comparire in un bucket, cosi' `sum(buckets[].n) === counts.matched`
 * sempre. Senza questo bucket una valutazione di candidato con esito illeggibile
 * sarebbe contata in `matched` ma invisibile nel rendiconto.
 */
const BUCKET_ORDER: readonly AiDecisionClass[] = ['AZIONE', 'ATTESA', 'SCARTO', 'SCONOSCIUTO'];

/**
 * Dicitura della fonte forward: i file controfattuali compaiono solo se almeno
 * un loro esito e' stato davvero abbinato.
 */
function forwardSourceLabel(nearMissMatched: number, rejectedMatched: number): string {
  const parts = ['artifacts/shadow_v1_live/signals.jsonl'];
  if (nearMissMatched > 0) parts.push('near_miss.jsonl');
  if (rejectedMatched > 0) parts.push('rejected.jsonl');
  const counterfactual = nearMissMatched > 0 || rejectedMatched > 0;
  return `${parts.join(' + ')}${counterfactual ? ' (controfattuale)' : ''}`;
}

function bucketOf(rows: readonly AiCalibrationJoin[]): AiCalibrationBucket[] {
  return BUCKET_ORDER.map((decision) => {
    const inBucket = rows.filter((row) => row.decision === decision);
    const rs = inBucket.map((row) => row.r);
    const netRs = inBucket.map((row) => row.rNet);
    const n = rs.length;
    const sum = rs.reduce((a, b) => a + b, 0);
    const netSum = netRs.reduce((a, b) => a + b, 0);
    const wins = rs.filter((r) => r > 0).length;
    const netWins = netRs.filter((r) => r > 0).length;
    return {
      decision,
      n,
      meanR: n > 0 ? round(sum / n, 4) : null,
      winRatePct: n > 0 ? round((wins / n) * 100, 2) : null,
      sumR: n > 0 ? round(sum, 4) : null,
      meanRNet: n > 0 ? round(netSum / n, 4) : null,
      winRateNetPct: n > 0 ? round((netWins / n) * 100, 2) : null,
      sumRNet: n > 0 ? round(netSum, 4) : null,
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
  /** Voci prese davvero da Firestore (0 = fallback non ha aggiunto nulla). */
  remoteEntries?: number;
  /** La lettura ha toccato il tetto: il campione non e' completo. */
  truncated?: boolean;
  readLimit?: number;
}): AiCalibrationResponse {
  const windowMs = input.windowMs ?? AI_CALIBRATION_MATCH_WINDOW_MS;
  const minSample = input.minSample ?? AI_CALIBRATION_MIN_SAMPLE;
  const rawEntries = Array.isArray(input.entries) ? input.entries : [];
  const cappedEntries = rawEntries.slice(-AI_CALIBRATION_MAX_ENTRIES);
  const deduped = dedupeEntries(cappedEntries);
  // La copertura si misura sui candidati del log, prima di qualsiasi join: e'
  // l'unico numero che dice se il desk ha davvero visto qualcosa.
  const coverage = buildCoverage(deduped);
  const forwardList = Array.isArray(input.forward) ? input.forward : [];
  const forwardIndex = indexForward(forwardList);
  const nearMissForwardPoints = forwardList.filter(
    (point) => point && point.source === 'near_miss'
  ).length;
  const rejectedForwardPoints = forwardList.filter(
    (point) => point && point.source === 'rejected'
  ).length;

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
  let nearMissMatched = 0;
  let rejectedMatched = 0;
  for (const pair of pairs) {
    if (matchedOrders.has(pair.candidate.order)) continue;
    if (usedPointKeys.has(pair.point.key)) continue;
    matchedOrders.add(pair.candidate.order);
    usedPointKeys.add(pair.point.key);
    if (pair.point.source === 'near_miss') nearMissMatched += 1;
    if (pair.point.source === 'rejected') rejectedMatched += 1;
    const { entry, ticker, atMs } = pair.candidate;
    joined.push({
      candidateKey:
        typeof entry.candidateKey === 'string' && entry.candidateKey.length > 0
          ? entry.candidateKey
          : null,
      ticker,
      market: typeof entry.market === 'string' ? entry.market.trim() : '',
      direction:
        typeof entry.direction === 'string' && entry.direction.trim().length > 0
          ? entry.direction.trim()
          : null,
      decision: classifyEntryDecision(entry),
      aiOutcome: entry.aiOutcome ?? null,
      r: pair.point.r,
      rNet: round(pair.point.r - AI_CALIBRATION_NET_COST_R, 4),
      forwardStatus: pair.point.status,
      deltaMs: Math.round(pair.point.decidedAtMs - atMs),
    });
  }
  const unmatchedAiEntries = candidates.length - joined.length;

  const buckets = bucketOf(joined);
  const actionNetR = joined
    .filter((row) => row.decision === 'AZIONE')
    .map((row) => row.rNet);
  const skipNetR = joined
    .filter((row) => row.decision === 'SCARTO')
    .map((row) => row.rNet);
  const uncertainty = buildUncertainty(actionNetR, skipNetR);
  const strata = buildStrata(joined);
  const policies = buildPolicies(joined);
  const ordinality = buildOrdinality(buckets);
  const action = buckets.find((b) => b.decision === 'AZIONE');
  const skip = buckets.find((b) => b.decision === 'SCARTO');
  const edgeR =
    action && skip && action.meanR !== null && skip.meanR !== null
      ? round(action.meanR - skip.meanR, 4)
      : null;
  const edgeRNet =
    action && skip && action.meanRNet !== null && skip.meanRNet !== null
      ? round(action.meanRNet - skip.meanRNet, 4)
      : null;

  const skippedWinners = joined
    .filter((row) => row.decision === 'SCARTO' && row.r > 0)
    .sort((a, b) => b.r - a.r)
    .slice(0, 10);

  const forwardPoints = [...forwardIndex.values()].reduce((n, list) => n + list.length, 0);
  const matched = joined.length;

  // Allarmi di formato: un degrado degli handler si vede qui, non solo come
  // silenzioso aumento dei non classificati.
  const alerts: AiCalibrationAlert[] = [];
  const unknownCount = buckets.find((bucket) => bucket.decision === 'SCONOSCIUTO')?.n ?? 0;
  if (matched >= AI_CALIBRATION_ALERT_MIN_SAMPLE) {
    const unknownRatio = unknownCount / matched;
    if (unknownRatio > AI_CALIBRATION_UNKNOWN_ALERT_RATIO) {
      alerts.push({
        code: 'UNKNOWN_SHARE_HIGH',
        ratio: round(unknownRatio, 4),
        threshold: AI_CALIBRATION_UNKNOWN_ALERT_RATIO,
        numerator: unknownCount,
        denominator: matched,
        message:
          `${round(unknownRatio * 100, 1)}% degli abbinamenti e' SCONOSCIUTO (${unknownCount}/${matched}): ` +
          'possibile degrado del campo decision scritto dagli handler (o aiOutcome illeggibile nelle righe storiche).',
      });
    }
  }
  const coveredCandidates = coverage.evaluated + coverage.notEvaluated;
  if (
    coveredCandidates >= AI_CALIBRATION_ALERT_MIN_SAMPLE &&
    coverage.evaluatedSharePct !== null &&
    coverage.evaluatedSharePct < AI_CALIBRATION_MIN_EVALUATED_SHARE * 100
  ) {
    alerts.push({
      code: 'COVERAGE_LOW',
      ratio: round(coverage.evaluated / coveredCandidates, 4),
      threshold: AI_CALIBRATION_MIN_EVALUATED_SHARE,
      numerator: coverage.evaluated,
      denominator: coveredCandidates,
      message:
        `solo ${coverage.evaluatedSharePct}% dei candidati e' stato valutato ` +
        `(${coverage.evaluated}/${coveredCandidates}): il campione descrive la pipeline, non il desk.`,
    });
  }
  if (deduped.length >= AI_CALIBRATION_ALERT_MIN_SAMPLE) {
    const directivesRatio = directivesIgnored / deduped.length;
    if (directivesRatio > AI_CALIBRATION_DIRECTIVES_ALERT_RATIO) {
      alerts.push({
        code: 'DIRECTIVES_SHARE_HIGH',
        ratio: round(directivesRatio, 4),
        threshold: AI_CALIBRATION_DIRECTIVES_ALERT_RATIO,
        numerator: directivesIgnored,
        denominator: deduped.length,
        message:
          `${round(directivesRatio * 100, 1)}% delle righe del log e' prosa (${directivesIgnored}/${deduped.length}): ` +
          'la calibrazione ha poche decisioni su cui lavorare.',
      });
    }
  }
  // La soglia si applica alle sole decisioni classificabili: una riga in
  // SCONOSCIUTO e' abbinata ma non e' un giudizio, e non deve avvicinare il
  // campione alla soglia.
  const classified = buckets
    .filter((bucket) => bucket.decision !== 'SCONOSCIUTO')
    .reduce((total, bucket) => total + bucket.n, 0);
  const remoteEntries =
    typeof input.remoteEntries === 'number' &&
    Number.isFinite(input.remoteEntries) &&
    input.remoteEntries > 0
      ? Math.floor(input.remoteEntries)
      : 0;
  const available = deduped.length > 0 && forwardPoints > 0;
  const verdict: AiCalibrationResponse['verdict'] =
    classified >= minSample ? 'evidence' : 'insufficient';
  // Il validatore lavora sull'aggregato gia' calcolato: stesse regole per tutti,
  // nessuna soglia adattiva e nessun accesso ai dati grezzi.
  // Il verdetto usa i valori NETTI: e' la stessa differenza di medie (un costo
  // costante si semplifica), ma il divario di successo no: un trade a +0.1R
  // lordo e' perdente al netto, e questo deve contare.
  const validation = validateAiDeskSample({
    classified,
    buckets,
    edgeR: edgeRNet ?? edgeR,
    edgeRNet,
    alerts,
    uncertainty: { edgeR: uncertainty.edgeR, winRateGapPct: uncertainty.winRateGapPct },
  });

  return {
    version: AI_CALIBRATION_VERSION,
    generatedAt: input.generatedAt,
    available,
    ...(available ? {} : { reason: deduped.length === 0 ? 'nessuna valutazione AI nel log' : 'nessun esito forward disponibile' }),
    windowMs,
    minSample,
    truncated: input.truncated === true,
    readLimit:
      typeof input.readLimit === 'number' && Number.isFinite(input.readLimit) && input.readLimit > 0
        ? Math.floor(input.readLimit)
        : 0,
    sources: {
      // La dicitura del fallback dipende dalle voci realmente usate: un flag
      // acceso senza risultati non rende la fonte "file + Firestore".
      aiLog:
        remoteEntries > 0
          ? 'shadow_ai_log.jsonl + Firestore (fallback)'
          : 'shadow_ai_log.jsonl',
      // Le fonti controfattuali entrano nella dicitura solo se un loro esito e'
      // stato usato: fornirne senza abbinarli non rende la calibrazione tale.
      forward: forwardSourceLabel(nearMissMatched, rejectedMatched),
    },
    counts: {
      aiEntries: rawEntries.length,
      dedupedEntries: deduped.length,
      forwardPoints,
      nearMissForwardPoints,
      nearMissMatched,
      rejectedForwardPoints,
      rejectedMatched,
      matched,
      classified,
      remoteEntries,
      unmatchedAiEntries,
      forwardWithoutDecision: Math.max(0, forwardPoints - usedPointKeys.size),
      skippedAiEntries,
      directivesIgnored,
    },
    buckets,
    edgeR,
    edgeRNet,
    costR: AI_CALIBRATION_NET_COST_R,
    netModel: {
      feeR: AI_CALIBRATION_NET_FEE_R,
      spreadR: AI_CALIBRATION_NET_SPREAD_R,
      totalR: AI_CALIBRATION_NET_COST_R,
      source:
        'Shadow V2: fee Trade Republic 2.00 EUR round-trip sul rischio di riferimento 10 EUR ' +
        '+ proxy spread al tetto UNDERLYING_SPREAD_MAX_R (non misurato sulle barre V1-live)',
    },
    uncertainty,
    coverage,
    ordinality,
    policies,
    strata,
    skippedWinners,
    alerts,
    verdict,
    validation,
    note:
      (verdict === 'evidence'
        ? `Campione classificato ${classified} >= ${minSample} (${matched} abbinati, ${matched - classified} in SCONOSCIUTO): edgeR calcolato.`
        : `Campione classificato ${classified} < ${minSample} (${matched} abbinati, ${matched - classified} in SCONOSCIUTO): nessuna conclusione, edgeR non e' un risultato.`) +
      ` Validatore ${AI_DESK_VALIDATION_VERSION}: ${validation.verdict}.`,
    limitations: [
      'Sola lettura: nessuna scrittura, nessun cambio di memoria AI, gate o selezione setup.',
      'Il join e\' per ticker e prossimita\' temporale (finestra fissa); non dimostra che la decisione AI abbia causato l\'esito.',
      'L\'R di V1-live e\' di prezzo e solo su setup emessi con decisione TRADE: gli altri candidati restano non abbinati, tranne i near-miss e gli altri scarti registrati (esiti controfattuali).',
      `R netto: a ogni abbinamento si sottrae ${AI_CALIBRATION_NET_COST_R} R di costi dichiarati ` +
        `(${AI_CALIBRATION_NET_FEE_R} R di fee round-trip + ${AI_CALIBRATION_NET_SPREAD_R} R di proxy spread al tetto, non misurato). ` +
        'Un costo costante non cambia edgeR, ma abbassa meanR e win rate: il verdetto del validatore usa i valori netti.',
      'Nessuna leva nel R: il moltiplicatore del certificato non entra nel calcolo, quindi il R netto non e\' un P&L.',
      ...(nearMissForwardPoints > 0
        ? [
            `${nearMissMatched} abbinamenti usano un esito near-miss controfattuale: il setup era bloccato da un solo gate (ADX borderline, G4, G5, G7, G8/G9, G11) e non e' mai stato emesso. L'esito e' calcolato sulle barre chiuse con lo stesso motore di V1-live, ma non e' un trade reale.`,
          ]
        : []),
      ...(rejectedForwardPoints > 0
        ? [
            `${rejectedMatched} abbinamenti usano l'esito di un candidato scartato fuori dal near-miss (due o piu' gate, veto, o gate fuori whitelist) e mai emesso. L'esito e' calcolato sulle stesse barre chiuse, ma non e' un trade reale.`,
          ]
        : []),
      `Righe AI senza esito entro ${Math.round(windowMs / 60000)} minuti sono contate come non abbinate, non come zero.`,
      '`counts.matched` e\' sempre la somma dei `buckets`: le valutazioni abbinate con esito illeggibile stanno in `SCONOSCIUTO`, non spariscono.',
      `Incertezza: IC ${Math.round(AI_CALIBRATION_CONFIDENCE * 100)}% da bootstrap deterministico sul R netto ` +
        `(${AI_CALIBRATION_BOOTSTRAP_ITERATIONS} iterazioni, seed fissa). Il check \`edge_r_ci\` chiede solo che il limite inferiore sia > 0: ` +
        'la soglia di +0.2 R resta una regola sulla stima puntuale, non un risultato con quella confidenza.',
      coverage.evaluatedSharePct !== null
        ? `Copertura LLM: ${coverage.evaluated}/${coverage.candidates} candidati valutati (${coverage.evaluatedSharePct}%). ` +
          `Sotto ${Math.round(AI_CALIBRATION_MIN_EVALUATED_SHARE * 100)}% il campione parla della pipeline, non del desk, e il validatore resta INSUFFICIENTE.`
        : 'Copertura LLM non calcolabile: nessun candidato nel log.',
      'Le policy sono R netti per trade, senza capitalizzazione ne leva: non sono un P&L.',
      'Gli strati (mercato, direzione) sono esplorativi: non entrano nel verdetto e non dimostrano causalita. ' +
        'Un edge aggregato puo non valere in ogni strato.',
      validation.verdict === 'CONFERMATO'
        ? `Validatore ${AI_DESK_VALIDATION_VERSION}: CONFERMATO (${validation.checks
            .filter((check) => check.status === 'pass')
            .map((check) => check.code)
            .join(', ')}). Resta una vista di sola lettura: le righe del log non vengono promosse.`
        : `Il desk resta NON_VALIDATO: validatore ${AI_DESK_VALIDATION_VERSION} => ${validation.verdict}. ${validation.headline}`,
      ...(input.truncated === true
        ? [
            `Lettura troncata al tetto di ${input.readLimit ?? 0} valutazioni: il campione puo' essere incompleto (truncated: true).`,
          ]
        : []),
    ],
  };
}

export interface AiCalibrationEntriesInput {
  entries: AiCalibrationEntry[];
  truncated?: boolean;
  readLimit?: number;
  /** Voci prese da Firestore: alimenta `counts.remoteEntries` e la fonte. */
  remoteEntries?: number;
}

export interface AiCalibrationRegistrationDeps {
  /**
   * Accetta l'elenco nudo o `{ entries, truncated, readLimit }`: cosi' il tetto
   * raggiunto arriva fino alla risposta invece di sembrare completezza.
   */
  readEntries: () =>
    | AiCalibrationEntry[]
    | AiCalibrationEntriesInput
    | Promise<AiCalibrationEntry[] | AiCalibrationEntriesInput>;
  readForward: () => AiCalibrationForwardPoint[] | Promise<AiCalibrationForwardPoint[]>;
  /**
   * Esiti controfattuali dei near-miss gia' persistiti: opzionale. Se manca o
   * lancia, la calibrazione resta quella di `signals.jsonl` (niente dati
   * inventati, nessuna 500).
   */
  readNearMissForward?: () => AiCalibrationForwardPoint[] | Promise<AiCalibrationForwardPoint[]>;
  /**
   * Esiti controfattuali degli altri candidati scartati: opzionale, stessa
   * gestione del near-miss (in errore restano le altre fonti, nessuna 500).
   */
  readRejectedForward?: () => AiCalibrationForwardPoint[] | Promise<AiCalibrationForwardPoint[]>;

  env?: Record<string, string | undefined>;
  now?: () => number;
}

type MinimalApp = { get: (path: string, handler: (req: unknown, res: unknown) => void) => void };
type MinimalResponse = { status: (code: number) => { json: (body: unknown) => void } };

/**
 * Handler con dipendenze iniettate: a flag OFF nessuna lettura; ogni errore
 * diventa `available: false`, mai una 500.
 */
function normalizeEntriesInput(
  input: AiCalibrationEntry[] | AiCalibrationEntriesInput | null | undefined
): AiCalibrationEntriesInput {
  if (Array.isArray(input)) {
    return { entries: input, truncated: false, readLimit: 0, remoteEntries: 0 };
  }
  if (input && typeof input === 'object' && Array.isArray((input as AiCalibrationEntriesInput).entries)) {
    const value = input as AiCalibrationEntriesInput;
    return {
      entries: value.entries,
      truncated: value.truncated === true,
      readLimit: typeof value.readLimit === 'number' ? value.readLimit : 0,
      remoteEntries:
        typeof value.remoteEntries === 'number' && value.remoteEntries > 0
          ? value.remoteEntries
          : 0,
    };
  }
  return { entries: [], truncated: false, readLimit: 0, remoteEntries: 0 };
}

/**
 * Unione per chiave dei punti forward: la prima occorrenza vince, cosi' i
 * segnali emessi (`signals.jsonl`) non vengono mai sovrascritti dai near-miss.
 */
function mergeForwardPoints(
  first: readonly AiCalibrationForwardPoint[],
  second: readonly AiCalibrationForwardPoint[]
): AiCalibrationForwardPoint[] {
  const byKey = new Map<string, AiCalibrationForwardPoint>();
  for (const point of [...first, ...second]) {
    if (!point || typeof point.key !== 'string' || point.key.length === 0) continue;
    if (!byKey.has(point.key)) byKey.set(point.key, point);
  }
  return [...byKey.values()];
}

export async function createAiCalibrationHandler(
  deps: AiCalibrationRegistrationDeps
): Promise<{ status: number; body: Record<string, unknown> | AiCalibrationResponse }> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  if (!isAiCalibrationEnabled(env)) {
    // Flag off: nessuna lettura, nemmeno del fallback remoto.
    return { status: 404, body: { status: 'disabled', flag: AI_CALIBRATION_ENV } };
  }
  const nowMs = now();
  try {
    const read = normalizeEntriesInput(await deps.readEntries());
    const signals = await deps.readForward();
    let nearMiss: AiCalibrationForwardPoint[] = [];
    if (deps.readNearMissForward) {
      try {
        nearMiss = [...(await deps.readNearMissForward())];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[AI Calibration] near-miss non disponibili: ${message}`);
      }
    }
    let rejected: AiCalibrationForwardPoint[] = [];
    if (deps.readRejectedForward) {
      try {
        rejected = [...(await deps.readRejectedForward())];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[AI Calibration] esiti degli scarti non disponibili: ${message}`);
      }
    }
    return {
      status: 200,
      body: buildAiCalibration({
        entries: read.entries,
        forward: mergeForwardPoints(mergeForwardPoints(signals, nearMiss), rejected),
        nowMs,
        generatedAt: new Date(nowMs).toISOString(),
        remoteEntries: read.remoteEntries,
        truncated: read.truncated,
        readLimit: read.readLimit,
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
}

export function registerAiCalibrationRoute(
  app: MinimalApp,
  deps: AiCalibrationRegistrationDeps
): void {
  app.get(AI_CALIBRATION_PATH, (_req, res) => {
    void createAiCalibrationHandler(deps)
      .then((out) => {
        (res as MinimalResponse).status(out.status).json(out.body);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        (res as MinimalResponse).status(500).json({ available: false, error: message });
      });
  });
}
