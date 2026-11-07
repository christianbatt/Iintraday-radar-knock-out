/**
 * SHADOW — algoritmi di ricerca implementati da zero dalle formule.
 *
 * Fonti: López de Prado, "Advances in Financial Machine Learning" (cap. 2, 3, 4, 7, 10, 14),
 * "Machine Learning for Asset Managers", Chan "Algorithmic Trading", Bouchaud et al.
 * "Trades, Quotes and Prices"; Corwin & Schultz (2012), Amihud (2002).
 *
 * IMPORTANTE (shadow): questo modulo NON è importato da buildExecutionSetup,
 * calculateCandidateScore, dai gate o da server.ts. Nessun setup viene filtrato, pesato o
 * riordinato da queste funzioni: servono solo come base testata per il registro
 * src/knowledge/ai_knowledge_rules.ts e per diagnostica.
 *
 * Nessuna dipendenza da mlfinlab né codice copiato: ogni funzione è scritta dalle formule,
 * con i passaggi numerici documentati e verificati nei test.
 *
 * Look-ahead: ogni funzione che consuma barre passa da filterClosedBars(), che ammette solo
 * barre con b.t + IND_BAR_MS <= nowMs. Una barra ancora aperta non entra mai nel calcolo.
 */

import { IND_BAR_MS } from '../config/tradingParams';
import type { IndicatorBarInput } from '../types/radar';

export type KnowledgeBar = IndicatorBarInput;

/** IPOTESI: costante di Eulero-Mascheroni usata nella deflazione del Sharpe (AFML cap. 14). */
const EULER_GAMMA = 0.5772156649015329;

/** IPOTESI: il test di expectancy è un randomization test a segni alternati, non un t-test. */
export const EXPECTANCY_BOOTSTRAP_ITERATIONS = 2000;
/** IPOTESI: seed fisso per rendere deterministico il bootstrap (nessun valore di mercato). */
export const EXPECTANCY_BOOTSTRAP_SEED = 20261107;
/** IPOTESI: soglia alfa del test di expectancy (informativa, non è un gate). */
export const EXPECTANCY_ALPHA = 0.05;

/** IPOTESI: frazione di Kelly e tetto di size, da validare sui trade reali. */
export const KELLY_FRACTION = 0.5;
export const KELLY_CAP = 0.25;

/** Ipotesi di default per le barriere triple (usate quando il setup non le definisce). */
export const TRIPLE_BARRIER_UPPER_HYPOTHESIS = 0.02; // IPOTESI: +2% di profitto
export const TRIPLE_BARRIER_LOWER_HYPOTHESIS = 0.02; // IPOTESI: -2% di stop
export const TRIPLE_BARRIER_VERTICAL_BARS_HYPOTHESIS = 48; // IPOTESI: 48 barre 5m = 4 ore

// ---------------------------------------------------------------------------
// Barre chiuse (guardia anti look-ahead)
// ---------------------------------------------------------------------------

/**
 * Restituisce solo le barre già chiuse a nowMs: b.t + barMs <= nowMs.
 * È l'unico punto di ingresso consentito alle barre in questo modulo.
 */
export function filterClosedBars<T extends KnowledgeBar>(
  bars: T[],
  nowMs: number,
  barMs: number = IND_BAR_MS
): T[] {
  if (!Number.isFinite(nowMs) || !Number.isFinite(barMs) || barMs <= 0) return [];
  return bars.filter((bar) => Number.isFinite(bar.t) && bar.t + barMs <= nowMs);
}

// ---------------------------------------------------------------------------
// R1 — Triple barrier labeling (AFML cap. 3)
// ---------------------------------------------------------------------------

export interface TripleBarrierConfig {
  /** IPOTESI: barriera superiore come frazione del prezzo di ingresso. */
  upperFraction: number;
  /** IPOTESI: barriera inferiore come frazione del prezzo di ingresso. */
  lowerFraction: number;
  /** IPOTESI: barriera verticale in numero di barre dall'evento. */
  verticalBars: number;
  barMs?: number;
}

export type TripleBarrierOutcome = 'UPPER' | 'LOWER' | 'VERTICAL' | 'UNRESOLVED';

export interface TripleBarrierSample {
  eventIndex: number;
  t0: number;
  t1Index: number | null;
  t1: number | null;
  label: 1 | -1 | 0 | null;
  outcome: TripleBarrierOutcome;
  entryPrice: number;
  exitPrice: number | null;
  returnFraction: number | null;
}

/**
 * Etichetta ogni evento con la prima barriera colpita (AFML cap. 3).
 *
 * Percorso: close della barra-evento come prezzo di ingresso, poi high/low delle barre
 * successive chiuse. Barriera verticale = eventIndex + verticalBars.
 * IPOTESI: se in una stessa barra vengono toccate entrambe le barriere, il tie-break è il
 * close della barra (sopra la superiore ⇒ UPPER, altrimenti LOWER).
 * Un evento senza barre sufficienti a raggiungere la barriera verticale resta UNRESOLVED con
 * label null: non viene etichettato con un percorso parziale (nessun look-ahead).
 */
export function tripleBarrierLabels(
  bars: KnowledgeBar[],
  eventIndices: number[],
  config: TripleBarrierConfig,
  nowMs: number
): TripleBarrierSample[] {
  const barMs = config.barMs ?? IND_BAR_MS;
  const closed = filterClosedBars(bars, nowMs, barMs);
  const closedIndexByOriginal = new Map<number, number>();
  let closedCursor = 0;
  for (let index = 0; index < bars.length; index++) {
    if (closedCursor < closed.length && closed[closedCursor] === bars[index]) {
      closedIndexByOriginal.set(index, closedCursor);
      closedCursor++;
    }
  }

  const verticalBars = Math.max(1, Math.floor(config.verticalBars));
  const upperFraction = Math.max(0, config.upperFraction);
  const lowerFraction = Math.max(0, config.lowerFraction);

  return eventIndices.map((eventIndex) => {
    const start = closedIndexByOriginal.get(eventIndex);
    const eventBar = start !== undefined ? closed[start] : undefined;
    if (start === undefined || eventBar === undefined || !Number.isFinite(eventBar.c) || eventBar.c <= 0) {
      const originalBar = bars[eventIndex];
      return {
        eventIndex,
        t0: originalBar?.t ?? Number.NaN,
        t1Index: null,
        t1: null,
        label: null,
        outcome: 'UNRESOLVED' as const,
        entryPrice: Number.NaN,
        exitPrice: null,
        returnFraction: null,
      };
    }

    const entryPrice = eventBar.c;
    const upperPrice = entryPrice * (1 + upperFraction);
    const lowerPrice = entryPrice * (1 - lowerFraction);
    const verticalIndex = start + verticalBars;

    for (let index = start + 1; index <= Math.min(verticalIndex, closed.length - 1); index++) {
      const bar = closed[index];
      const hitUpper = Number.isFinite(bar.h) && bar.h >= upperPrice;
      const hitLower = Number.isFinite(bar.l) && bar.l <= lowerPrice;
      if (hitUpper || hitLower) {
        const isUpper = hitUpper && hitLower ? bar.c >= upperPrice : hitUpper;
        const exitPrice = isUpper ? upperPrice : lowerPrice;
        return {
          eventIndex,
          t0: eventBar.t,
          t1Index: index,
          t1: bar.t,
          label: isUpper ? (1 as const) : (-1 as const),
          outcome: isUpper ? ('UPPER' as const) : ('LOWER' as const),
          entryPrice,
          exitPrice,
          returnFraction: exitPrice / entryPrice - 1,
        };
      }
    }

    if (verticalIndex <= closed.length - 1) {
      const exitBar = closed[verticalIndex];
      return {
        eventIndex,
        t0: eventBar.t,
        t1Index: verticalIndex,
        t1: exitBar.t,
        label: 0 as const,
        outcome: 'VERTICAL' as const,
        entryPrice,
        exitPrice: exitBar.c,
        returnFraction: exitBar.c / entryPrice - 1,
      };
    }

    return {
      eventIndex,
      t0: eventBar.t,
      t1Index: null,
      t1: null,
      label: null,
      outcome: 'UNRESOLVED' as const,
      entryPrice,
      exitPrice: null,
      returnFraction: null,
    };
  });
}

// ---------------------------------------------------------------------------
// R2 — Pesi per unicità (AFML cap. 4)
// ---------------------------------------------------------------------------

export interface SampleSpan {
  /** Indice (o posizione) della prima barra della finestra, inclusa. */
  startIndex: number;
  /** Indice (o posizione) dell'ultima barra della finestra, inclusa. */
  endIndex: number;
}

/**
 * Peso di unicità di ogni campione: media di 1/concorrenza sulle barre della sua finestra,
 * dove concorrenza = numero di finestre che coprono quella barra (AFML cap. 4).
 * Proprietà (verificata nei test): se tutte le finestre hanno la stessa lunghezza L, la somma
 * dei pesi è (barre distinte coperte)/L, quindi ogni barra conta una volta sola anche quando
 * più trade si sovrappongono.
 */
export function sampleUniquenessWeights(spans: SampleSpan[], totalBars: number): number[] {
  if (spans.length === 0) return [];
  const bars = Math.max(0, Math.floor(totalBars));
  const concurrency = new Array<number>(bars).fill(0);
  for (const span of spans) {
    const start = Math.max(0, Math.min(bars - 1, Math.floor(span.startIndex)));
    const end = Math.max(0, Math.min(bars - 1, Math.floor(span.endIndex)));
    if (end < start) continue;
    for (let index = start; index <= end; index++) concurrency[index] += 1;
  }

  return spans.map((span) => {
    const start = Math.max(0, Math.min(bars - 1, Math.floor(span.startIndex)));
    const end = Math.max(0, Math.min(bars - 1, Math.floor(span.endIndex)));
    if (end < start) return 0;
    let sum = 0;
    for (let index = start; index <= end; index++) {
      sum += concurrency[index] > 0 ? 1 / concurrency[index] : 0;
    }
    return sum / (end - start + 1);
  });
}

// ---------------------------------------------------------------------------
// R3 — Purged k-fold con embargo (AFML cap. 7)
// ---------------------------------------------------------------------------

export interface PurgedFold {
  fold: number;
  testIndices: number[];
  trainIndices: number[];
  purgedIndices: number[];
  embargoIndices: number[];
}

/**
 * Purged k-fold: i campioni di training la cui finestra [start,end] si sovrappone alla
 * finestra di test vengono rimossi (purge); i campioni che iniziano entro `embargoBars`
 * barre dopo la fine del test vengono rimossi (embargo). Test e training sono quindi
 * disgiunti e nessun indice di training cade nella finestra purgata o nell'embargo.
 */
export function purgedKFold(spans: SampleSpan[], folds: number, embargoBars: number): PurgedFold[] {
  if (spans.length === 0) return [];
  const k = Math.max(1, Math.floor(folds));
  const embargo = Math.max(0, Math.floor(embargoBars));
  const foldSize = Math.ceil(spans.length / k);
  const result: PurgedFold[] = [];

  for (let fold = 0; fold < k; fold++) {
    const testStartSample = fold * foldSize;
    const testEndSample = Math.min(spans.length, testStartSample + foldSize) - 1;
    if (testStartSample > testEndSample) break;
    const testIndices: number[] = [];
    for (let index = testStartSample; index <= testEndSample; index++) testIndices.push(index);

    let testStartBar = Infinity;
    let testEndBar = -Infinity;
    for (const index of testIndices) {
      testStartBar = Math.min(testStartBar, spans[index].startIndex);
      testEndBar = Math.max(testEndBar, spans[index].endIndex);
    }

    const trainIndices: number[] = [];
    const purgedIndices: number[] = [];
    const embargoIndices: number[] = [];
    for (let index = 0; index < spans.length; index++) {
      if (index >= testStartSample && index <= testEndSample) continue;
      const span = spans[index];
      const overlapsTest = span.startIndex <= testEndBar && span.endIndex >= testStartBar;
      if (overlapsTest) {
        purgedIndices.push(index);
        continue;
      }
      const inEmbargo = span.startIndex > testEndBar && span.startIndex <= testEndBar + embargo;
      if (inEmbargo) {
        embargoIndices.push(index);
        continue;
      }
      trainIndices.push(index);
    }

    result.push({ fold, testIndices, trainIndices, purgedIndices, embargoIndices });
  }

  return result;
}

// ---------------------------------------------------------------------------
// R4 — Deflated Sharpe Ratio (AFML cap. 14; Bailey & López de Prado)
// ---------------------------------------------------------------------------

export interface DeflatedSharpeResult {
  sharpe: number | null;
  /** Sharpe atteso del massimo di `trials` prove indipendenti sotto H0 (Bailey-LdP). */
  sharpeZero: number | null;
  deflated: number | null;
  trials: number;
  observations: number;
  status: 'OK' | 'INSUFFICIENT_SAMPLE' | 'ZERO_VARIANCE' | 'INVALID_TRIALS';
  /** IPOTESI: campo informativo, non è un gate. */
  note: string;
}

/** CDF normale standard via erf (Abramowitz-Stegun 7.1.26, errore < 1.5e-7). */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const coefficients = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  let poly = 0;
  for (let index = coefficients.length - 1; index >= 0; index--) {
    poly = (poly + coefficients[index]) * t;
  }
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Quantile normale standard per bisezione su normalCdf (nessuna tabella copiata). */
export function normalQuantile(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  let low = -40;
  let high = 40;
  for (let iteration = 0; iteration < 200; iteration++) {
    const mid = (low + high) / 2;
    if (normalCdf(mid) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * DSR = Φ((SR − SR0) · √(n−1) / √(1 − γ3·SR + ((γ4−1)/4)·SR²))
 * con SR0 = √V[SR] · [(1−γ)·Φ⁻¹(1−1/T) + γ·Φ⁻¹(1−1/(T·e))], γ = costante di Eulero.
 * SR è per-osservazione (non annualizzato); γ3 = skew, γ4 = kurtosi grezza (normale = 3).
 * IPOTESI: T (numero di prove indipendenti) deve essere dichiarato dal chiamante; con T < 2
 * la deflazione non è definita e il risultato è null.
 */
export function deflatedSharpeRatio(returns: number[], trials: number): DeflatedSharpeResult {
  const clean = returns.filter((value) => Number.isFinite(value));
  const observations = clean.length;
  const declaredTrials = Math.floor(trials);

  if (observations < 3) {
    return {
      sharpe: null,
      sharpeZero: null,
      deflated: null,
      trials: declaredTrials,
      observations,
      status: 'INSUFFICIENT_SAMPLE',
      note: 'IPOTESI: servono almeno 3 osservazioni per stimare skew e kurtosi.',
    };
  }
  if (!Number.isFinite(declaredTrials) || declaredTrials < 2) {
    return {
      sharpe: null,
      sharpeZero: null,
      deflated: null,
      trials: declaredTrials,
      observations,
      status: 'INVALID_TRIALS',
      note: 'IPOTESI: numero di prove non dichiarato (T < 2); DSR non calcolabile.',
    };
  }

  const mean = clean.reduce((sum, value) => sum + value, 0) / observations;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const value of clean) {
    const deviation = value - mean;
    m2 += deviation * deviation;
    m3 += deviation * deviation * deviation;
    m4 += deviation * deviation * deviation * deviation;
  }
  m2 /= observations;
  m3 /= observations;
  m4 /= observations;
  if (!(m2 > 0)) {
    return {
      sharpe: null,
      sharpeZero: null,
      deflated: null,
      trials: declaredTrials,
      observations,
      status: 'ZERO_VARIANCE',
      note: 'IPOTESI: varianza nulla, Sharpe indefinito.',
    };
  }

  const sd = Math.sqrt(m2 * observations / (observations - 1));
  const sharpe = mean / sd;
  const skew = m3 / Math.pow(m2, 1.5);
  const kurtosis = m4 / (m2 * m2);
  const varianceOfSharpe =
    (1 - skew * sharpe + ((kurtosis - 1) / 4) * sharpe * sharpe) / (observations - 1);
  if (!(varianceOfSharpe > 0)) {
    return {
      sharpe,
      sharpeZero: null,
      deflated: null,
      trials: declaredTrials,
      observations,
      status: 'ZERO_VARIANCE',
      note: 'IPOTESI: varianza del Sharpe non positiva.',
    };
  }

  const sharpeZero =
    Math.sqrt(varianceOfSharpe) *
    ((1 - EULER_GAMMA) * normalQuantile(1 - 1 / declaredTrials) +
      EULER_GAMMA * normalQuantile(1 - 1 / (declaredTrials * Math.E)));
  const deflated = normalCdf((sharpe - sharpeZero) / Math.sqrt(varianceOfSharpe));

  return {
    sharpe,
    sharpeZero,
    deflated,
    trials: declaredTrials,
    observations,
    status: 'OK',
    note: 'IPOTESI: campo informativo, non usato come gate.',
  };
}

// ---------------------------------------------------------------------------
// R5 — Kelly frazionato con tetto (AFML cap. 10)
// ---------------------------------------------------------------------------

export interface KellyConfig {
  /** IPOTESI: frazione del Kelly pieno da applicare. */
  fraction: number;
  /** IPOTESI: tetto massimo di size. */
  cap: number;
}

export interface KellyResult {
  fullKelly: number;
  fraction: number;
  cap: number;
  size: number;
  status: 'IPOTESI';
}

/**
 * f* = p − (1−p)/b (b = payoff ratio guadagno/perdita), poi size = clamp(fraction·f*, 0, cap).
 * Funzione deterministica: il LLM non calcola la size, la riceve.
 */
export function fractionalKelly(
  p: number,
  payoffRatio: number,
  config: KellyConfig = { fraction: KELLY_FRACTION, cap: KELLY_CAP }
): KellyResult {
  const fraction = Math.max(0, config.fraction);
  const cap = Math.max(0, config.cap);
  if (!Number.isFinite(p) || p <= 0 || p >= 1 || !Number.isFinite(payoffRatio) || payoffRatio <= 0) {
    return { fullKelly: 0, fraction, cap, size: 0, status: 'IPOTESI' };
  }
  const fullKelly = p - (1 - p) / payoffRatio;
  const size = Math.min(cap, Math.max(0, fraction * fullKelly));
  return { fullKelly, fraction, cap, size, status: 'IPOTESI' };
}

// ---------------------------------------------------------------------------
// R6 — Filtro CUSUM per il campionamento degli eventi (AFML cap. 2)
// ---------------------------------------------------------------------------

/**
 * CUSUM simmetrico: emette l'indice della barra quando il prezzo si allontana di `threshold`
 * dal minimo (o massimo) corrente dall'ultimo evento; al rilascio i cumulatori si azzerano.
 */
export function cusumEventIndices(prices: number[], threshold: number): number[] {
  if (!(threshold > 0)) return [];
  const events: number[] = [];
  let positive = 0;
  let negative = 0;
  for (let index = 1; index < prices.length; index++) {
    const previous = prices[index - 1];
    const current = prices[index];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    positive = Math.max(0, positive + current - previous);
    negative = Math.max(0, negative + previous - current);
    if (positive >= threshold || negative >= threshold) {
      events.push(index);
      positive = 0;
      negative = 0;
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// R7 — Proxy di spread e illiquidità da OHLC (Corwin-Schultz 2012; Amihud 2002)
// ---------------------------------------------------------------------------

/**
 * Stima lo spread relativo con Corwin-Schultz su coppie di barre consecutive.
 * β = ln(H_t/L_t)² + ln(H_{t+1}/L_{t+1})², γ = ln(max(H_t,H_{t+1})/min(L_t,L_{t+1}))²,
 * α = (√(2β) − √β)/(3−2√2) − √(γ/(3−2√2)), S = 2(e^α − 1)/(1 + e^α).
 * Restituisce un valore per barra (null sulla prima barra e sugli input non validi).
 * IPOTESI: è una stima, non una misura diretta dello spread.
 */
export function corwinSchultzSpreadProxy(bars: KnowledgeBar[]): Array<number | null> {
  const denominator = 3 - 2 * Math.SQRT2;
  const result: Array<number | null> = new Array(bars.length).fill(null);
  for (let index = 1; index < bars.length; index++) {
    const previous = bars[index - 1];
    const current = bars[index];
    if (
      !Number.isFinite(previous.h) || !Number.isFinite(previous.l) || previous.l <= 0 ||
      !Number.isFinite(current.h) || !Number.isFinite(current.l) || current.l <= 0
    ) continue;

    const beta = Math.pow(Math.log(previous.h / previous.l), 2) + Math.pow(Math.log(current.h / current.l), 2);
    const gamma = Math.pow(Math.log(Math.max(previous.h, current.h) / Math.min(previous.l, current.l)), 2);
    const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / denominator - Math.sqrt(gamma / denominator);
    if (!Number.isFinite(alpha)) continue;
    const spread = 2 * (Math.exp(alpha) - 1) / (1 + Math.exp(alpha));
    result[index] = spread > 0 ? spread : 0;
  }
  return result;
}

/**
 * Illiquidità di Amihud per barra: |r_t| / (close_t · volume_t), scalata per 1e6.
 * IPOTESI: la scala 1e6 è arbitraria e serve solo a rendere i valori leggibili.
 */
export function amihudIlliquidity(bars: KnowledgeBar[]): Array<number | null> {
  const result: Array<number | null> = new Array(bars.length).fill(null);
  for (let index = 1; index < bars.length; index++) {
    const previous = bars[index - 1];
    const current = bars[index];
    if (
      !Number.isFinite(previous.c) || previous.c <= 0 ||
      !Number.isFinite(current.c) || current.c <= 0 ||
      !Number.isFinite(current.v) || current.v <= 0
    ) continue;
    result[index] = (Math.abs(current.c / previous.c - 1) / (current.c * current.v)) * 1e6;
  }
  return result;
}

// ---------------------------------------------------------------------------
// R8 — Volume bars / information bars, solo come approssimazione (AFML cap. 2)
// ---------------------------------------------------------------------------

export interface ApproximateVolumeBar extends KnowledgeBar {
  sourceBars: number;
  /** Marcatore esplicito: barra ricostruita, non un vero clock di volume. */
  exact: false;
}

/**
 * Approssimazione di volume bar con sole barre 5m: accumula barre finché il volume cumulato
 * raggiunge `targetVolume`, poi emette una barra sintetica (open della prima, close della
 * ultima, high/low estremi, volume cumulato). L'ordine intrabar è ignoto, quindi il confine
 * del bucket non coincide con il clock informativo di AFML: è un'approssimazione dichiarata.
 * IPOTESI: l'ultimo bucket incompleto viene scartato perché non è una barra chiusa.
 */
export function approximateVolumeBars(bars: KnowledgeBar[], targetVolume: number): ApproximateVolumeBar[] {
  if (!(targetVolume > 0)) return [];
  const result: ApproximateVolumeBar[] = [];
  let open: number | null = null;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let close = 0;
  let volume = 0;
  let sourceBars = 0;
  let lastTimestamp = 0;

  for (const bar of bars) {
    if (!Number.isFinite(bar.c) || !Number.isFinite(bar.v) || bar.v < 0) continue;
    if (open === null) open = bar.o;
    high = Math.max(high, bar.h);
    low = Math.min(low, bar.l);
    close = bar.c;
    volume += bar.v;
    sourceBars += 1;
    lastTimestamp = bar.t;
    if (volume >= targetVolume) {
      result.push({
        t: lastTimestamp,
        o: open,
        h: high,
        l: low,
        c: close,
        v: volume,
        sourceBars,
        exact: false,
      });
      open = null;
      high = Number.NEGATIVE_INFINITY;
      low = Number.POSITIVE_INFINITY;
      close = 0;
      volume = 0;
      sourceBars = 0;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// R10 — Finestra oraria ad alta probabilità (ipotesi da testare sui trade reali)
// ---------------------------------------------------------------------------

/**
 * IPOTESI: prima ora della sessione regolare (US 09:30–10:29 ET, EU 09:00–09:59 Rome).
 * Restituisce true solo se la barra in timestampMs è già chiusa a nowMs (nessun look-ahead).
 */
export function isHighProbabilityWindow(
  timestampMs: number,
  market: 'US' | 'EU',
  nowMs: number,
  barMs: number = IND_BAR_MS
): boolean {
  if (!Number.isFinite(timestampMs) || timestampMs + barMs > nowMs) return false;
  const timeZone = market === 'US' ? 'America/New_York' : 'Europe/Rome';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestampMs));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const totalMinutes = hour * 60 + minute;
  const [start, end] = market === 'US' ? [570, 629] : [540, 599];
  return totalMinutes >= start && totalMinutes <= end;
}

// ---------------------------------------------------------------------------
// Test di expectancy sugli R-multipli (bootstrap deterministico a segni alternati)
// ---------------------------------------------------------------------------

export interface ExpectancyBootstrapResult {
  method: 'BOOTSTRAP_SIGN_FLIP';
  meanR: number;
  standardError: number;
  tStatistic: number | null;
  pValue: number;
  alpha: number;
  iterations: number;
  seed: number;
  significant: boolean;
  status: 'IPOTESI';
}

/** PRNG deterministico (mulberry32): nessuna dipendenza, stesso output a parità di seed. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Randomization test a segni alternati sulla media degli R-multipli: sotto H0 la distribuzione
 * è simmetrica attorno a 0, quindi ogni R può cambiare segno con probabilità 1/2.
 * p = (#|media permutata| >= |media osservata| + 1) / (iterazioni + 1).
 * IPOTESI: soglia alfa 0.05, seed fisso, 2000 iterazioni; è informativo, non è un gate.
 */
export function expectancyBootstrap(
  rMultiples: number[],
  iterations: number = EXPECTANCY_BOOTSTRAP_ITERATIONS,
  seed: number = EXPECTANCY_BOOTSTRAP_SEED,
  alpha: number = EXPECTANCY_ALPHA
): ExpectancyBootstrapResult | null {
  const values = rMultiples.filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  const rounds = Math.max(1, Math.floor(iterations));
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / (values.length - 1);
  const standardError = Math.sqrt(variance / values.length);
  if (!(standardError > 0)) return null;

  const random = createRandom(seed);
  const observed = Math.abs(mean);
  let atLeastAsExtreme = 0;
  for (let round = 0; round < rounds; round++) {
    let permutedSum = 0;
    for (const value of values) permutedSum += random() < 0.5 ? -value : value;
    if (Math.abs(permutedSum / values.length) >= observed - 1e-12) atLeastAsExtreme += 1;
  }
  const pValue = (atLeastAsExtreme + 1) / (rounds + 1);

  return {
    method: 'BOOTSTRAP_SIGN_FLIP',
    meanR: mean,
    standardError,
    tStatistic: mean / standardError,
    pValue,
    alpha,
    iterations: rounds,
    seed,
    significant: pValue < alpha,
    status: 'IPOTESI',
  };
}
