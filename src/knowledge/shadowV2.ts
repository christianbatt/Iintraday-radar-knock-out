/**
 * SHADOW V2 — Motore quantitativo parallelo (SOLA OSSERVAZIONE / ZERO IMPATTO LIVE).
 *
 * Strategia: CUSUM Displacement + VWAP Pullback-Reclaim, Volatility-Matched KO.
 * Tutti i parametri non ancora validati su >=100 segnali e >=30 sessioni reali
 * sono marcati (IPOTESI).
 *
 * Regole imperative:
 * - Zero look-ahead: usa esclusivamente barre 5m gia' chiuse (t + BAR_MS <= nowMs).
 * - Fill onesto: ingresso esclusivamente all'apertura della barra successiva (O_{t*+1})
 *   dopo la chiusura della barra segnale t*; finche' t*+1 non e' chiusa resta PENDING_OPEN.
 * - Barriera tripla pessimistica: se nella stessa barra vengono toccati Stop e Target,
 *   prevale lo Stop. Gestisce gap in apertura oltre Stop / oltre KO.
 * - Costi reali Trade Republic: commissione EUR 2.00 round-trip + proxy spread
 *   Corwin-Schultz + spread certificato KO espressi in multipli di R.
 * - Isolamento assoluto: non importa moduli di ricerca V1 o registro regole e
 *   non altera in alcun modo SETUP_SELECTOR_LIVE ('off').
 */

import { IND_BAR_MS, TRADING_PARAMS } from '../config/tradingParams';
import type { IndicatorBarInput } from '../types/radar';
import { atrSeries, computeSupertrend, exchangeDate, exchangeMinutes, filterRegularSessionBars } from '../utils/indicators';
import { getExchangeDateStr } from '../utils/timezone';

export const SHADOW_V2_BAR_MS = IND_BAR_MS; // 5 * 60_000

/** Tutti i parametri numerici sotto sono IPOTESI sperimentali finche' non validati out-of-sample. */
export const SHADOW_V2_HYPOTHESES = {
  /** IPOTESI: soglia CUSUM normalizzata per ATR per identificare spostamento istituzionale. */
  CUSUM_DISPLACEMENT_K: 1.5,
  /** IPOTESI: gap minimo (%) vs chiusura precedente per trigger Failed-Gap Reversal. */
  FAILED_GAP_MIN_PCT: 1.0,
  /** IPOTESI: finestra max di barre dopo impulso/gap entro cui cercare pullback-reclaim. */
  IMPULSE_TTL_BARS: 12,
  /** IPOTESI: lookback pullback rispetto alla barra reclaim [t-6 .. t-1]. */
  PULLBACK_LOOKBACK_BARS: 6,
  /** IPOTESI: distanza minima in ATR dalla VWAP durante pullback (lato sfavorevole). */
  PULLBACK_MIN_DIST_ATR: -0.35,
  /** IPOTESI: distanza massima in ATR dalla VWAP durante pullback (lato favorevole). */
  PULLBACK_MAX_DIST_ATR: 0.40,
  /** IPOTESI: volume pullback contratto rispetto a SMA20 volumi. */
  PULLBACK_MAX_VOL_RATIO: 0.95,
  /** IPOTESI: espansione volume minima sulla barra di reclaim vs SMA20 volumi. */
  RECLAIM_MIN_VOL_RATIO: 1.35,
  /** IPOTESI: forza trend minima ADX(14) alla barra reclaim. */
  ADX_MIN: 20,
  /** IPOTESI: floor dello stop strutturale in multipli di ATR14 (5m). */
  STOP_ATR_FLOOR_MULT: 1.6,
  /** IPOTESI: cuscinetto oltre lo swing del pullback per lo stop strutturale. */
  STOP_SWING_PAD_ATR: 0.15,
  /** IPOTESI: target R-multiplo simmetrico post-reclaim. */
  TARGET_R: 1.35,
  /** IPOTESI: barriera verticale in barre 5m (18 * 5m = 90 minuti). */
  VERTICAL_BARS: 18,
  /** IPOTESI: minuti prima della chiusura regolare per chiusura forzata intraday. */
  EXIT_BEFORE_CLOSE_MIN: 15,
  /** IPOTESI: griglia di leve KO Trade Republic ammesse. */
  LEVERAGE_GRID: [5, 7, 10, 15, 20, 25] as const,
  /** IPOTESI: cuscinetto minimo tra barriera KO e stop strutturale (dKO >= 1.25 * dS). */
  KO_STOP_BUFFER_MULT: 1.25,
  /** IPOTESI: distanza minima della barriera KO in ATR14 (5m). */
  KO_MIN_ATR_MULT: 2.5,
  /** IPOTESI: rapporto massimo (spread sottostante + spread KO) / rischio in R. */
  VAR_SPREAD_MAX_R: 0.25,
  /** IPOTESI: tetto massimo proxy spread sottostante sul rischio (CS / (dS/E)). */
  UNDERLYING_SPREAD_MAX_R: 0.08,
  /** IPOTESI: spread stimato sul certificato KO per lato (frazione del prezzo cert). */
  KO_SPREAD_CERT_PCT_PER_SIDE: 0.002,
  /** Commissione fissa reale Trade Republic round-trip (EUR 1 ingresso + EUR 1 uscita). */
  FEE_ROUNDTRIP_EUR: 2.0,
  /** IPOTESI: capitale di riferimento primario e rischio per trade (EUR 10). */
  REFERENCE_CAPITAL_EUR: 1000,
  RISK_PCT: 0.01,
  /** IPOTESI: tetto friction totale in R su capitale di riferimento EUR 1.000 (EUR 2 / EUR 10 = 0.20R di sola fee). */
  TOTAL_FRICTION_MAX_R: 0.35,
  /** IPOTESI: finestre orarie operative nel fuso di borsa (minuti da mezzanotte). */
  EU_WINDOW_START_MIN: 9 * 60 + 20, // 09:20 Europe/Rome
  EU_WINDOW_END_MIN: 11 * 60 + 30,  // 11:30 Europe/Rome
  US_WINDOW_START_MIN: 9 * 60 + 45, // 09:45 America/New_York
  US_WINDOW_END_MIN: 15 * 60 + 30,  // 15:30 America/New_York
  /** IPOTESI: parametri bootstrap e statistiche. */
  BOOTSTRAP_ITERATIONS: 2000,
  BOOTSTRAP_SEED: 20261116,
  DSR_TRIALS: 12,
  WARMUP_MIN_BARS: 35,
} as const;

export type ShadowV2Direction = 'LONG' | 'SHORT';
export type ShadowV2TriggerType = 'CUSUM_DISPLACEMENT' | 'FAILED_GAP_REVERSAL';
export type ShadowV2Status = 'PENDING_OPEN' | 'OPEN' | 'RESOLVED' | 'BLOCKED';
export type ShadowV2Outcome = 'TARGET_1' | 'STOP' | 'KO_HIT' | 'TIME_BARRIER' | 'OPEN' | 'PENDING' | 'BLOCKED';

export interface ShadowV2AltOutcome {
  outcome: ShadowV2Outcome;
  rGross: number;
  rNet: number;
  barsHeld: number;
}

export interface ShadowV2ExperimentSummary {
  id: 'BASE_1K' | 'CAPITAL_2500' | 'COST_AWARE_FILTER' | 'TRAIL_BE_120M';
  label: string;
  description: string;
  n: number;
  wins: number;
  winRatePct: number | null;
  meanRGross: number | null;
  meanRNet: number | null;
  sumRNet: number | null;
  profitFactor: number | null;
}

export interface ShadowV2Record {
  id: string;
  ticker: string;
  market: 'EU' | 'US';
  sessionDate: string;
  direction: ShadowV2Direction;
  triggerType: ShadowV2TriggerType;
  signalBarTs: number;
  signalTimeIso: string;
  entryBarTs: number | null;
  refSignalClose: number;
  entryPrice: number | null;
  structuralStop: number;
  target1: number | null;
  riskDist: number | null;
  leverage: number | null;
  koBarrier: number | null;
  status: ShadowV2Status;
  outcome: ShadowV2Outcome;
  blockedReason: string | null;
  exitBarTs: number | null;
  exitPrice: number | null;
  barsHeld: number;
  rGross: number | null;
  rNet: number | null;
  csSpreadPct: number | null;
  amihud: number | null;
  varSpreadR: number | null;
  totalFrictionR: number | null;
  totalFrictionR2500: number | null;
  altOutcomes?: {
    trailBe120m?: ShadowV2AltOutcome;
  };
  diagnostics: {
    vwapAtSignal: number | null;
    atr5mAtSignal: number | null;
    adxAtSignal: number | null;
    pullbackDistAtr: number | null;
    pullbackVolRatio: number | null;
    reclaimVolRatio: number | null;
    cusumZ: number;
    gapPct: number | null;
  };
}

/**
 * Tetto verticale del ramo controfattuale TRAIL (24 barre = 120 minuti).
 * Il ramo BASE chiude a `SHADOW_V2_HYPOTHESES.VERTICAL_BARS` (18 barre = 90 minuti).
 */
export const SHADOW_V2_TRAIL_MAX_VERTICAL_BARS = 24;

/**
 * Diagnostica di appaiamento BASE/TRAIL per `trailBe120m` (solo lettura).
 *
 * BASE simula al massimo `VERTICAL_BARS` barre (90 minuti), TRAIL fino a
 * `SHADOW_V2_TRAIL_MAX_VERTICAL_BARS` (120 minuti) con lo stesso ingresso: se il numero di
 * barre effettivamente simulate coincide, i due esiti sono confrontabili; se differisce, il
 * confronto mescola finestre diverse. Questi conteggi espongono il fenomeno e non alterano
 * nel modo piu' assoluto il valore di `trailBe120m`.
 */
export interface ShadowV2TrailPairingDiagnostic {
  /** Record risolti che hanno un esito `trailBe120m`. */
  n: number;
  /** Casi in cui BASE e TRAIL hanno simulato lo stesso numero di barre. */
  sameWindow: number;
  /** Casi in cui il numero di barre simulate differisce. */
  differentWindow: number;
  /** Limite verticale del ramo BASE (barre). */
  baseVerticalBars: number;
  /** Limite verticale del ramo TRAIL (barre). */
  trailMaxVerticalBars: number;
}

export interface ShadowV2Summary {
  strategyName: string;
  generatedAt: string;
  nSessions: number;
  nSignals: number;
  nResolved: number;
  nOpen: number;
  nPendingOpen: number;
  nBlocked: number;
  wins: number;
  losses: number;
  koHits: number;
  timeouts: number;
  winRatePct: number | null;
  meanRGross: number | null;
  meanRNet: number | null;
  medianFrictionR: number | null;
  medianFrictionR2500: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  dsr: number | null;
  dsrNote: string;
  clusterBootstrapPValue: number | null;
  nDayClusters: number;
  experiments?: ShadowV2ExperimentSummary[];
  /** Appaiamento BASE/TRAIL di `trailBe120m`: campione confrontabile e non. */
  trailBe120mPairing?: ShadowV2TrailPairingDiagnostic;
  hypotheses: typeof SHADOW_V2_HYPOTHESES;
  limitations: string[];
  recentSignals: ShadowV2Record[];
}

// ---------------------------------------------------------------------------
// Utility matematiche pure (nessun I/O, zero look-ahead)
// ---------------------------------------------------------------------------

export function filterClosedBarsV2<T extends IndicatorBarInput>(
  bars: readonly T[],
  nowMs: number,
  barMs: number = SHADOW_V2_BAR_MS
): T[] {
  if (!Number.isFinite(nowMs) || !Number.isFinite(barMs) || barMs <= 0) return [];
  return bars.filter(
    (b) =>
      Number.isFinite(b.t) &&
      b.t > 0 &&
      b.t + barMs <= nowMs &&
      [b.o, b.h, b.l, b.c].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) &&
      b.h >= b.l
  );
}

/** Close Location Value in [-1, +1]; 0 se barra piatta (h === l). */
export function computeClv(bar: IndicatorBarInput): number {
  const span = bar.h - bar.l;
  if (!Number.isFinite(span) || span <= 0) return 0;
  return (2 * bar.c - bar.h - bar.l) / span;
}

/**
 * Proxy di spread bid-ask di Corwin & Schultz (2012) su coppie di barre consecutive.
 * Restituisce un array allineato alle barre (null se stima non calcolabile).
 */
export function corwinSchultzSpreadSeries(bars: readonly IndicatorBarInput[]): (number | null)[] {
  const k2 = Math.SQRT2;
  const denomConst = 3 - 2 * k2; // 3 - 2*sqrt(2) ~= 0.171572875
  const out: (number | null)[] = bars.map(() => null);
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];
    if (prev.l <= 0 || curr.l <= 0 || prev.h < prev.l || curr.h < curr.l) continue;
    const h2 = Math.max(prev.h, curr.h);
    const l2 = Math.min(prev.l, curr.l);
    const lPrev = Math.log(prev.h / prev.l);
    const lCurr = Math.log(curr.h / curr.l);
    const beta = lPrev * lPrev + lCurr * lCurr;
    const lPair = Math.log(h2 / l2);
    const gamma = lPair * lPair;
    const alpha = ((k2 - 1) * Math.sqrt(beta)) / denomConst - Math.sqrt(gamma / denomConst);
    const clampedAlpha = Math.max(0, alpha);
    const eAlpha = Math.exp(clampedAlpha);
    const spread = (2 * (eAlpha - 1)) / (1 + eAlpha);
    out[i] = Number.isFinite(spread) ? +spread.toFixed(6) : null;
  }
  return out;
}

/**
 * Illiquidita' di Amihud (2002) per barra: |ret| / dollar_volume * 1e6.
 */
export function amihudSeries(bars: readonly IndicatorBarInput[]): (number | null)[] {
  const out: (number | null)[] = bars.map(() => null);
  for (let i = 1; i < bars.length; i++) {
    const prevC = bars[i - 1].c;
    const c = bars[i].c;
    const v = bars[i].v;
    if (!Number.isFinite(prevC) || prevC <= 0 || !Number.isFinite(c) || c <= 0 || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      continue;
    }
    const ret = Math.abs(c / prevC - 1);
    const dollarVol = c * v;
    if (dollarVol <= 0) continue;
    const val = (ret / dollarVol) * 1e6;
    out[i] = Number.isFinite(val) ? +val.toFixed(6) : null;
  }
  return out;
}

/** Serie causale ADX(14) di Wilder allineata alle barre. */
export function computeAdxSeries(
  bars: readonly IndicatorBarInput[],
  period: number = TRADING_PARAMS.ADX_PERIOD
): (number | null)[] {
  const out: (number | null)[] = bars.map(() => null);
  if (period <= 0 || bars.length <= 2 * period) return out;

  const tr: number[] = bars.map(() => 0);
  const plusDM: number[] = bars.map(() => 0);
  const minusDM: number[] = bars.map(() => 0);
  for (let i = 1; i < bars.length; i++) {
    const prevC = bars[i - 1].c;
    tr[i] = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prevC), Math.abs(bars[i].l - prevC));
    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  let trS = 0;
  let plusS = 0;
  let minusS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    plusS += plusDM[i];
    minusS += minusDM[i];
  }

  let adxVal: number | null = null;
  let dxCount = 0;
  let dxSum = 0;

  for (let i = period; i < bars.length; i++) {
    if (i > period) {
      trS = trS - trS / period + tr[i];
      plusS = plusS - plusS / period + plusDM[i];
      minusS = minusS - minusS / period + minusDM[i];
    }
    const plusDI = trS > 0 ? (100 * plusS) / trS : 0;
    const minusDI = trS > 0 ? (100 * minusS) / trS : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (100 * Math.abs(plusDI - minusDI)) / diSum : 0;

    if (adxVal == null) {
      dxSum += dx;
      dxCount++;
      if (dxCount === period) {
        adxVal = dxSum / period;
        out[i] = adxVal;
      }
    } else {
      adxVal = (adxVal * (period - 1) + dx) / period;
      out[i] = adxVal;
    }
  }
  return out;
}

/** VWAP di sessione cumulativa causale, resettata su cambio data locale di borsa. */
export function computeSessionVwapSeries(
  bars: readonly IndicatorBarInput[],
  market: 'EU' | 'US'
): (number | null)[] {
  const out: (number | null)[] = bars.map(() => null);
  let activeDate = '';
  let sumTPV = 0;
  let sumVol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = exchangeDate(b.t, market);
    if (d !== activeDate) {
      activeDate = d;
      sumTPV = 0;
      sumVol = 0;
    }
    const vol = typeof b.v === 'number' && Number.isFinite(b.v) && b.v > 0 ? b.v : 0;
    if (vol > 0) {
      const tp = (b.h + b.l + b.c) / 3;
      sumTPV += tp * vol;
      sumVol += vol;
    }
    out[i] = sumVol > 0 ? sumTPV / sumVol : null;
  }
  return out;
}

/** Media mobile semplice dei volumi delle `period` barre precedenti [i-period .. i-1] (esclude barra i). */
export function computePriorVolumeSmaSeries(
  bars: readonly IndicatorBarInput[],
  period: number = 20
): (number | null)[] {
  const out: (number | null)[] = bars.map(() => null);
  for (let i = period; i < bars.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - period; j < i; j++) {
      const v = bars[j].v;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        sum += v;
        count++;
      }
    }
    out[i] = count >= Math.ceil(period * 0.6) ? sum / count : null;
  }
  return out;
}

export function isInShadowV2OperatingWindow(tsMs: number, market: 'EU' | 'US'): boolean {
  const min = exchangeMinutes(tsMs, market);
  if (market === 'EU') {
    return min >= SHADOW_V2_HYPOTHESES.EU_WINDOW_START_MIN && min <= SHADOW_V2_HYPOTHESES.EU_WINDOW_END_MIN;
  }
  return min >= SHADOW_V2_HYPOTHESES.US_WINDOW_START_MIN && min <= SHADOW_V2_HYPOTHESES.US_WINDOW_END_MIN;
}

function sessionCloseMinutes(market: 'EU' | 'US'): number {
  return market === 'US'
    ? TRADING_PARAMS.US_CLOSE_HOUR * 60 + TRADING_PARAMS.US_CLOSE_MINUTE
    : TRADING_PARAMS.EU_CLOSE_HOUR * 60 + TRADING_PARAMS.EU_CLOSE_MINUTE;
}

/** CDF normale standard via approssimazione di Abramowitz & Stegun (7.1.26). */
function stdNormalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t) *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/** Quantile normale standard via Acklam rational approximation. */
function stdNormalQuantile(p: number): number {
  if (p <= 0 || p >= 1) return NaN;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Deflated Sharpe Ratio (Bailey & Lopez de Prado, 2014). Restituisce null se campione/varianza non sufficienti. */
export function computeDeflatedSharpe(
  returns: readonly number[],
  nTrials: number = SHADOW_V2_HYPOTHESES.DSR_TRIALS
): { dsr: number | null; note: string } {
  const n = returns.length;
  if (n < 5) {
    return { dsr: null, note: `Campione insufficiente per DSR (n=${n} < 5)` };
  }
  if (nTrials < 2) {
    return { dsr: null, note: 'nTrials deve essere >= 2' };
  }
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std <= 1e-12) {
    return { dsr: null, note: 'Varianza nulla: DSR non definito' };
  }
  const sr = mean / std;
  let skew = 0;
  let kurt = 0;
  for (const r of returns) {
    const z = (r - mean) / std;
    skew += z ** 3;
    kurt += z ** 4;
  }
  skew /= n;
  kurt /= n;

  const varSr = (1 - skew * sr + ((kurt - 1) / 4) * sr * sr) / Math.max(1, n - 1);
  if (!Number.isFinite(varSr) || varSr <= 0) {
    return { dsr: null, note: 'Varianza dello Sharpe non positiva' };
  }
  const eulerGamma = 0.5772156649015329;
  const z1 = stdNormalQuantile(1 - 1 / nTrials);
  const z2 = stdNormalQuantile(1 - 1 / (nTrials * Math.E));
  const sr0 = Math.sqrt(varSr) * ((1 - eulerGamma) * z1 + eulerGamma * z2);
  const dsr = stdNormalCdf((sr - sr0) / Math.sqrt(varSr));
  return {
    dsr: Number.isFinite(dsr) ? +dsr.toFixed(4) : null,
    note: `DSR calcolato su n=${n} trade chiusi, T=${nTrials} prove`,
  };
}

/**
 * Selezione leva KO da griglia [5, 7, 10, 15, 20, 25]: sceglie la leva PIU' ALTA
 * la cui barriera sta oltre lo stop strutturale con buffer (dKO >= 1.25 * dS)
 * e oltre almeno 2.5 * ATR14_5m.
 */
export function selectShadowV2KoLeverage(
  entryPrice: number,
  structuralStop: number,
  atr5m: number,
  direction: ShadowV2Direction
): { leverage: number | null; barrier: number | null; reason: string | null } {
  if (!(entryPrice > 0) || !(atr5m > 0)) {
    return { leverage: null, barrier: null, reason: 'INVALID_PRICE_OR_ATR' };
  }
  const dS = direction === 'LONG' ? entryPrice - structuralStop : structuralStop - entryPrice;
  if (!(dS > 0)) {
    return { leverage: null, barrier: null, reason: 'OPEN_GAP_BEYOND_STOP' };
  }
  const minDist = Math.max(
    dS * SHADOW_V2_HYPOTHESES.KO_STOP_BUFFER_MULT,
    atr5m * SHADOW_V2_HYPOTHESES.KO_MIN_ATR_MULT
  );
  const minFrac = minDist / entryPrice;
  const descendingGrid = [...SHADOW_V2_HYPOTHESES.LEVERAGE_GRID].sort((a, b) => b - a);
  for (const lev of descendingGrid) {
    const koFrac = 1 / lev;
    if (koFrac >= minFrac) {
      const barrier = direction === 'LONG' ? entryPrice * (1 - koFrac) : entryPrice * (1 + koFrac);
      return { leverage: lev, barrier: +barrier.toFixed(4), reason: null };
    }
  }
  return { leverage: null, barrier: null, reason: 'KO_BARRIER_TOO_CLOSE' };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Motore di rilevazione + simulazione Shadow V2 su serie storica/intraday di barre 5m chiuse.
 * Garantisce assenza totale di look-ahead fino a `nowMs`.
 */
export function evaluateShadowV2OnBars(
  ticker: string,
  market: 'EU' | 'US',
  rawBars: readonly IndicatorBarInput[],
  options: { nowMs?: number } = {}
): ShadowV2Record[] {
  const nowMs = options.nowMs ?? Date.now();
  const regularSorted = filterRegularSessionBars(rawBars, market);
  const closed = filterClosedBarsV2(regularSorted, nowMs, SHADOW_V2_BAR_MS);
  if (closed.length < SHADOW_V2_HYPOTHESES.WARMUP_MIN_BARS) {
    return [];
  }

  const atr = atrSeries(closed, TRADING_PARAMS.ATR_PERIOD);
  const st = computeSupertrend(closed, {
    period: TRADING_PARAMS.ST_PERIOD,
    factor: TRADING_PARAMS.ST_FACTOR,
    now: new Date(nowMs),
  });
  const adx = computeAdxSeries(closed, TRADING_PARAMS.ADX_PERIOD);
  const vwap = computeSessionVwapSeries(closed, market);
  const volSma = computePriorVolumeSmaSeries(closed, 20);
  const csSpread = corwinSchultzSpreadSeries(closed);
  const amihud = amihudSeries(closed);

  // Stato di sessione e impulsi CUSUM / Failed-Gap
  let currentSession = '';
  let prevSessionClose: number | null = null;
  let sessionFirstBarIdx = 0;
  let gapPctSession: number | null = null;
  let cusumPos = 0;
  let cusumNeg = 0;
  let activeImpulse: {
    dir: 1 | -1;
    barIndex: number;
    cusumZ: number;
    triggerType: ShadowV2TriggerType;
  } | null = null;
  let cooldownUntilIndex = -1;

  const records: ShadowV2Record[] = [];

  for (let i = 1; i < closed.length; i++) {
    const b = closed[i];
    const sess = getExchangeDateStr(market, new Date(b.t));

    if (sess !== currentSession) {
      if (i > 0 && currentSession !== '') {
        prevSessionClose = closed[i - 1].c;
      }
      currentSession = sess;
      sessionFirstBarIdx = i;
      cusumPos = 0;
      cusumNeg = 0;
      activeImpulse = null;
      cooldownUntilIndex = -1;
      gapPctSession =
        prevSessionClose != null && prevSessionClose > 0
          ? ((b.o - prevSessionClose) / prevSessionClose) * 100
          : null;
    }

    const a = atr[i];
    const v = vwap[i];
    const d = st.direction[i];
    const x = adx[i];
    const vs = volSma[i];

    // Aggiornamento causale CUSUM su variazioni normalizzate per ATR
    if (a != null && a > 0 && i > sessionFirstBarIdx) {
      const dz = (b.c - closed[i - 1].c) / a;
      cusumPos = Math.max(0, cusumPos + dz);
      cusumNeg = Math.max(0, cusumNeg - dz);

      if (cusumPos >= SHADOW_V2_HYPOTHESES.CUSUM_DISPLACEMENT_K && d === 1) {
        if (!activeImpulse || activeImpulse.dir !== 1) {
          activeImpulse = {
            dir: 1,
            barIndex: i,
            cusumZ: +cusumPos.toFixed(3),
            triggerType: 'CUSUM_DISPLACEMENT',
          };
        } else {
          activeImpulse.cusumZ = Math.max(activeImpulse.cusumZ, +cusumPos.toFixed(3));
        }
        cusumPos = 0;
      } else if (cusumNeg >= SHADOW_V2_HYPOTHESES.CUSUM_DISPLACEMENT_K && d === -1) {
        if (!activeImpulse || activeImpulse.dir !== -1) {
          activeImpulse = {
            dir: -1,
            barIndex: i,
            cusumZ: +(-cusumNeg).toFixed(3),
            triggerType: 'CUSUM_DISPLACEMENT',
          };
        } else {
          activeImpulse.cusumZ = Math.min(activeImpulse.cusumZ, +(-cusumNeg).toFixed(3));
        }
        cusumNeg = 0;
      }
    }

    // Trigger alternativo causale: Failed-Gap Reversal sulla prima espansione contro-gap
    if (
      gapPctSession != null &&
      Math.abs(gapPctSession) >= SHADOW_V2_HYPOTHESES.FAILED_GAP_MIN_PCT &&
      v != null &&
      d != null &&
      a != null &&
      a > 0
    ) {
      const gapDir = gapPctSession > 0 ? 1 : -1;
      const clvNow = computeClv(b);
      if (gapDir === 1 && b.c < v && d === -1 && clvNow <= 0) {
        activeImpulse = {
          dir: -1,
          barIndex: i,
          cusumZ: +(-Math.abs(b.c - closed[sessionFirstBarIdx].o) / a).toFixed(3),
          triggerType: 'FAILED_GAP_REVERSAL',
        };
      } else if (gapDir === -1 && b.c > v && d === 1 && clvNow >= 0) {
        activeImpulse = {
          dir: 1,
          barIndex: i,
          cusumZ: +(Math.abs(b.c - closed[sessionFirstBarIdx].o) / a).toFixed(3),
          triggerType: 'FAILED_GAP_REVERSAL',
        };
      }
    }

    // Scadenza impulso se troppo vecchio o Supertrend invertito
    if (
      activeImpulse &&
      (i - activeImpulse.barIndex > SHADOW_V2_HYPOTHESES.IMPULSE_TTL_BARS ||
        (d != null && d !== activeImpulse.dir))
    ) {
      activeImpulse = null;
    }

    // Check condizioni di segnale su barra i chiusa
    if (i <= cooldownUntilIndex) continue;
    if (!isInShadowV2OperatingWindow(b.t, market)) continue;
    if (!activeImpulse || i <= activeImpulse.barIndex) continue;
    if (a == null || a <= 0 || v == null || d == null || x == null || vs == null || vs <= 0) continue;
    if (typeof b.v !== 'number' || !Number.isFinite(b.v) || b.v <= 0) continue;

    const dir = activeImpulse.dir;
    if (d !== dir) continue;
    if (x < SHADOW_V2_HYPOTHESES.ADX_MIN) continue;

    const reclaimVolRatio = b.v / vs;
    if (reclaimVolRatio < SHADOW_V2_HYPOTHESES.RECLAIM_MIN_VOL_RATIO) continue;

    const clv = computeClv(b);
    if (dir === 1 && !(b.c > v && clv >= 0)) continue;
    if (dir === -1 && !(b.c < v && clv <= 0)) continue;

    // Cerca barra di pullback in [i - PULLBACK_LOOKBACK_BARS .. i - 1] nella stessa sessione
    let pullbackIdx = -1;
    let pullbackDistAtr = 0;
    let pullbackVolRatio = 0;
    let swingExtreme = dir === 1 ? b.l : b.h;

    const lbStart = Math.max(sessionFirstBarIdx, i - SHADOW_V2_HYPOTHESES.PULLBACK_LOOKBACK_BARS);
    for (let p = i - 1; p >= lbStart; p--) {
      const pb = closed[p];
      const pv = vwap[p];
      const pvs = volSma[p];
      const pa = atr[p];
      if (pv == null || pvs == null || pvs <= 0 || pa == null || pa <= 0) continue;
      if (typeof pb.v !== 'number' || !Number.isFinite(pb.v)) continue;

      if (dir === 1) swingExtreme = Math.min(swingExtreme, pb.l);
      else swingExtreme = Math.max(swingExtreme, pb.h);

      const pVolRatio = pb.v / pvs;
      if (pVolRatio > SHADOW_V2_HYPOTHESES.PULLBACK_MAX_VOL_RATIO) continue;

      // Distanza in ATR orientata lungo la direzione del trade (+ = favorevole, - = lieve attraversamento VWAP)
      const signedDist = dir === 1 ? (pb.c - pv) / pa : (pv - pb.c) / pa;
      if (
        signedDist >= SHADOW_V2_HYPOTHESES.PULLBACK_MIN_DIST_ATR &&
        signedDist <= SHADOW_V2_HYPOTHESES.PULLBACK_MAX_DIST_ATR
      ) {
        pullbackIdx = p;
        pullbackDistAtr = signedDist;
        pullbackVolRatio = pVolRatio;
        break;
      }
    }

    if (pullbackIdx < 0) continue;

    // Segnale confermato a barra i chiusa!
    const direction: ShadowV2Direction = dir === 1 ? 'LONG' : 'SHORT';
    const refSignalClose = b.c;
    const structuralStop =
      dir === 1
        ? +(Math.min(swingExtreme - SHADOW_V2_HYPOTHESES.STOP_SWING_PAD_ATR * a, refSignalClose - SHADOW_V2_HYPOTHESES.STOP_ATR_FLOOR_MULT * a)).toFixed(4)
        : +(Math.max(swingExtreme + SHADOW_V2_HYPOTHESES.STOP_SWING_PAD_ATR * a, refSignalClose + SHADOW_V2_HYPOTHESES.STOP_ATR_FLOOR_MULT * a)).toFixed(4);

    // Calcolo spread CS causale fino alla barra i (mediana ultime 5 stime disponibili <= i)
    const recentCs: number[] = [];
    for (let s = Math.max(1, i - 4); s <= i; s++) {
      const val = csSpread[s];
      if (val != null) recentCs.push(val);
    }
    const csSpreadEst = median(recentCs);
    const amihudEst = amihud[i];

    const recordId = `${ticker}|${sess}|${b.t}|${direction}`;
    const baseDiagnostics = {
      vwapAtSignal: +v.toFixed(4),
      atr5mAtSignal: +a.toFixed(4),
      adxAtSignal: +x.toFixed(2),
      pullbackDistAtr: +pullbackDistAtr.toFixed(3),
      pullbackVolRatio: +pullbackVolRatio.toFixed(3),
      reclaimVolRatio: +reclaimVolRatio.toFixed(3),
      cusumZ: activeImpulse.cusumZ,
      gapPct: gapPctSession != null ? +gapPctSession.toFixed(2) : null,
    };

    // Verifica presenza della barra successiva chiusa per ingresso onesto a O_{i+1}
    const nextBar = closed[i + 1];
    if (!nextBar || getExchangeDateStr(market, new Date(nextBar.t)) !== sess) {
      records.push({
        id: recordId,
        ticker,
        market,
        sessionDate: sess,
        direction,
        triggerType: activeImpulse.triggerType,
        signalBarTs: b.t,
        signalTimeIso: new Date(b.t).toISOString(),
        entryBarTs: null,
        refSignalClose: +refSignalClose.toFixed(4),
        entryPrice: null,
        structuralStop,
        target1: null,
        riskDist: null,
        leverage: null,
        koBarrier: null,
        status: 'PENDING_OPEN',
        outcome: 'PENDING',
        blockedReason: null,
        exitBarTs: null,
        exitPrice: null,
        barsHeld: 0,
        rGross: null,
        rNet: null,
        csSpreadPct: csSpreadEst != null ? +csSpreadEst.toFixed(6) : null,
        amihud: amihudEst,
        varSpreadR: null,
        totalFrictionR: null,
        totalFrictionR2500: null,
        diagnostics: baseDiagnostics,
      });
      cooldownUntilIndex = i + 5;
      activeImpulse = null;
      continue;
    }

    const entryPrice = nextBar.o;
    const riskDist = dir === 1 ? entryPrice - structuralStop : structuralStop - entryPrice;

    // Controlli integrita' fill all'apertura successiva
    let blockedReason: string | null = null;
    if (!(riskDist > 0)) {
      blockedReason = 'OPEN_GAP_BEYOND_STOP';
    } else if (Math.abs(entryPrice - refSignalClose) > 1.5 * a) {
      blockedReason = 'OPEN_GAP_TOO_WIDE';
    }

    const koSelection =
      blockedReason == null
        ? selectShadowV2KoLeverage(entryPrice, structuralStop, a, direction)
        : { leverage: null, barrier: null, reason: blockedReason };

    if (blockedReason == null && koSelection.reason != null) {
      blockedReason = koSelection.reason;
    }

    // Calcolo friction reale in multipli di R
    let varSpreadR: number | null = null;
    let totalFrictionR: number | null = null;
    let totalFrictionR2500: number | null = null;

    if (riskDist > 0 && entryPrice > 0 && koSelection.leverage != null) {
      const stopPct = riskDist / entryPrice;
      const underlyingSpreadR = csSpreadEst != null ? csSpreadEst / stopPct : 0;
      const certSpreadR = (2 * SHADOW_V2_HYPOTHESES.KO_SPREAD_CERT_PCT_PER_SIDE) / (koSelection.leverage * stopPct);
      varSpreadR = +(underlyingSpreadR + certSpreadR).toFixed(4);
      const riskEur1000 = SHADOW_V2_HYPOTHESES.REFERENCE_CAPITAL_EUR * SHADOW_V2_HYPOTHESES.RISK_PCT;
      const riskEur2500 = 2500 * SHADOW_V2_HYPOTHESES.RISK_PCT;
      totalFrictionR = +(varSpreadR + SHADOW_V2_HYPOTHESES.FEE_ROUNDTRIP_EUR / riskEur1000).toFixed(4);
      totalFrictionR2500 = +(varSpreadR + SHADOW_V2_HYPOTHESES.FEE_ROUNDTRIP_EUR / riskEur2500).toFixed(4);

      if (blockedReason == null) {
        if (underlyingSpreadR > SHADOW_V2_HYPOTHESES.UNDERLYING_SPREAD_MAX_R) {
          blockedReason = 'UNDERLYING_SPREAD_TOO_HIGH';
        } else if (varSpreadR > SHADOW_V2_HYPOTHESES.VAR_SPREAD_MAX_R) {
          blockedReason = 'VAR_SPREAD_TOO_HIGH';
        } else if (totalFrictionR > SHADOW_V2_HYPOTHESES.TOTAL_FRICTION_MAX_R) {
          blockedReason = 'FRICTION_TOO_HIGH_FOR_CAPITAL';
        }
      }
    }

    if (blockedReason != null || koSelection.leverage == null || koSelection.barrier == null) {
      records.push({
        id: recordId,
        ticker,
        market,
        sessionDate: sess,
        direction,
        triggerType: activeImpulse.triggerType,
        signalBarTs: b.t,
        signalTimeIso: new Date(b.t).toISOString(),
        entryBarTs: nextBar.t,
        refSignalClose: +refSignalClose.toFixed(4),
        entryPrice: +entryPrice.toFixed(4),
        structuralStop,
        target1: riskDist > 0 ? +(entryPrice + dir * SHADOW_V2_HYPOTHESES.TARGET_R * riskDist).toFixed(4) : null,
        riskDist: riskDist > 0 ? +riskDist.toFixed(4) : null,
        leverage: koSelection.leverage,
        koBarrier: koSelection.barrier,
        status: 'BLOCKED',
        outcome: 'BLOCKED',
        blockedReason: blockedReason ?? 'BLOCKED',
        exitBarTs: null,
        exitPrice: null,
        barsHeld: 0,
        rGross: null,
        rNet: null,
        csSpreadPct: csSpreadEst != null ? +csSpreadEst.toFixed(6) : null,
        amihud: amihudEst,
        varSpreadR,
        totalFrictionR,
        totalFrictionR2500,
        diagnostics: baseDiagnostics,
      });
      cooldownUntilIndex = i + 5;
      activeImpulse = null;
      continue;
    }

    const target1 = +(entryPrice + dir * SHADOW_V2_HYPOTHESES.TARGET_R * riskDist).toFixed(4);
    const barrier = koSelection.barrier;
    const closeLimitMin = sessionCloseMinutes(market) - SHADOW_V2_HYPOTHESES.EXIT_BEFORE_CLOSE_MIN;

    // Barriera tripla pessimistica a partire da entryIdx = i + 1
    let outcome: ShadowV2Outcome = 'OPEN';
    let exitBarTs: number | null = null;
    let exitPrice: number | null = null;
    let barsHeld = 0;

    const entryIdx = i + 1;
    const maxIdx = Math.min(closed.length - 1, entryIdx + SHADOW_V2_HYPOTHESES.VERTICAL_BARS - 1);

    for (let k = entryIdx; k <= maxIdx; k++) {
      const barK = closed[k];
      if (getExchangeDateStr(market, new Date(barK.t)) !== sess) {
        // Cambio sessione imprevisto: chiude sull'ultima barra della sessione
        const prevBar = closed[k - 1];
        outcome = 'TIME_BARRIER';
        exitBarTs = prevBar.t;
        exitPrice = prevBar.c;
        break;
      }
      barsHeld++;

      if (dir === 1) {
        if (barK.o <= barrier) {
          outcome = 'KO_HIT';
          exitBarTs = barK.t;
          exitPrice = barK.o;
          break;
        }
        if (barK.o <= structuralStop) {
          outcome = 'STOP';
          exitBarTs = barK.t;
          exitPrice = barK.o;
          break;
        }
        if (barK.l <= barrier) {
          outcome = 'KO_HIT';
          exitBarTs = barK.t;
          exitPrice = barrier;
          break;
        }
        if (barK.l <= structuralStop) {
          outcome = 'STOP';
          exitBarTs = barK.t;
          exitPrice = structuralStop;
          break;
        }
        if (barK.h >= target1) {
          outcome = 'TARGET_1';
          exitBarTs = barK.t;
          exitPrice = target1;
          break;
        }
      } else {
        if (barK.o >= barrier) {
          outcome = 'KO_HIT';
          exitBarTs = barK.t;
          exitPrice = barK.o;
          break;
        }
        if (barK.o >= structuralStop) {
          outcome = 'STOP';
          exitBarTs = barK.t;
          exitPrice = barK.o;
          break;
        }
        if (barK.h >= barrier) {
          outcome = 'KO_HIT';
          exitBarTs = barK.t;
          exitPrice = barrier;
          break;
        }
        if (barK.h >= structuralStop) {
          outcome = 'STOP';
          exitBarTs = barK.t;
          exitPrice = structuralStop;
          break;
        }
        if (barK.l <= target1) {
          outcome = 'TARGET_1';
          exitBarTs = barK.t;
          exitPrice = target1;
          break;
        }
      }

      const barMin = exchangeMinutes(barK.t, market);
      const isLastInVertical = k === entryIdx + SHADOW_V2_HYPOTHESES.VERTICAL_BARS - 1;
      if (isLastInVertical || barMin >= closeLimitMin) {
        outcome = 'TIME_BARRIER';
        exitBarTs = barK.t;
        exitPrice = barK.c;
        break;
      }
    }

    const isResolved = outcome !== 'OPEN';
    const rGross =
      isResolved && exitPrice != null ? +(((dir * (exitPrice - entryPrice)) / riskDist).toFixed(4)) : null;
    const rNet = rGross != null && totalFrictionR != null ? +((rGross - totalFrictionR).toFixed(4)) : null;

    // Simulazione controfattuale A/B (IPOTESI): breakeven +0.05R dopo +0.80R,
    // trailing +0.55R dopo +1.10R e estensione finestra a 120m solo se > +0.25R a 90m.
    let trailBe120m: ShadowV2AltOutcome | undefined;
    if (isResolved && totalFrictionR != null) {
      let altStop = structuralStop;
      let altOutcome: ShadowV2Outcome = 'OPEN';
      let altExitPrice: number | null = null;
      let altBarsHeld = 0;
      const altMaxVertical = SHADOW_V2_TRAIL_MAX_VERTICAL_BARS; // 120 minuti
      const altMaxIdx = Math.min(closed.length - 1, entryIdx + altMaxVertical - 1);

      for (let k = entryIdx; k <= altMaxIdx; k++) {
        const barK = closed[k];
        if (getExchangeDateStr(market, new Date(barK.t)) !== sess) {
          const prevBar = closed[k - 1];
          altOutcome = 'TIME_BARRIER';
          altExitPrice = prevBar.c;
          break;
        }
        altBarsHeld++;

        if (dir === 1) {
          if (barK.o <= barrier) {
            altOutcome = 'KO_HIT';
            altExitPrice = barK.o;
            break;
          }
          if (barK.o <= altStop) {
            altOutcome = 'STOP';
            altExitPrice = barK.o;
            break;
          }
          if (barK.l <= barrier) {
            altOutcome = 'KO_HIT';
            altExitPrice = barrier;
            break;
          }
          if (barK.l <= altStop) {
            altOutcome = 'STOP';
            altExitPrice = altStop;
            break;
          }
          if (barK.h >= target1) {
            altOutcome = 'TARGET_1';
            altExitPrice = target1;
            break;
          }
        } else {
          if (barK.o >= barrier) {
            altOutcome = 'KO_HIT';
            altExitPrice = barK.o;
            break;
          }
          if (barK.o >= altStop) {
            altOutcome = 'STOP';
            altExitPrice = barK.o;
            break;
          }
          if (barK.h >= barrier) {
            altOutcome = 'KO_HIT';
            altExitPrice = barrier;
            break;
          }
          if (barK.h >= altStop) {
            altOutcome = 'STOP';
            altExitPrice = altStop;
            break;
          }
          if (barK.l <= target1) {
            altOutcome = 'TARGET_1';
            altExitPrice = target1;
            break;
          }
        }

        const closeR = (dir * (barK.c - entryPrice)) / riskDist;
        const barMin = exchangeMinutes(barK.t, market);
        if (barMin >= closeLimitMin) {
          altOutcome = 'TIME_BARRIER';
          altExitPrice = barK.c;
          break;
        }
        // A 90 minuti (barra 18): estende fino a 120m solo se in trend positivo > +0.25R
        if (altBarsHeld === SHADOW_V2_HYPOTHESES.VERTICAL_BARS && closeR <= 0.25) {
          altOutcome = 'TIME_BARRIER';
          altExitPrice = barK.c;
          break;
        }
        if (altBarsHeld === altMaxVertical) {
          altOutcome = 'TIME_BARRIER';
          altExitPrice = barK.c;
          break;
        }

        // Aggiornamento trailing solo a chiusura barra per evitare look-ahead intrabarra
        if (closeR >= 1.10) {
          const lockStop = entryPrice + dir * 0.55 * riskDist;
          altStop = dir === 1 ? Math.max(altStop, lockStop) : Math.min(altStop, lockStop);
        } else if (closeR >= 0.80) {
          const beStop = entryPrice + dir * 0.05 * riskDist;
          altStop = dir === 1 ? Math.max(altStop, beStop) : Math.min(altStop, beStop);
        }
      }

      if (altOutcome !== 'OPEN' && altExitPrice != null) {
        const altRGross = +(((dir * (altExitPrice - entryPrice)) / riskDist).toFixed(4));
        const altRNet = +((altRGross - totalFrictionR).toFixed(4));
        trailBe120m = {
          outcome: altOutcome,
          rGross: altRGross,
          rNet: altRNet,
          barsHeld: altBarsHeld,
        };
      }
    }

    records.push({
      id: recordId,
      ticker,
      market,
      sessionDate: sess,
      direction,
      triggerType: activeImpulse.triggerType,
      signalBarTs: b.t,
      signalTimeIso: new Date(b.t).toISOString(),
      entryBarTs: nextBar.t,
      refSignalClose: +refSignalClose.toFixed(4),
      entryPrice: +entryPrice.toFixed(4),
      structuralStop,
      target1,
      riskDist: +riskDist.toFixed(4),
      leverage: koSelection.leverage,
      koBarrier: barrier,
      status: isResolved ? 'RESOLVED' : 'OPEN',
      outcome,
      blockedReason: null,
      exitBarTs,
      exitPrice: exitPrice != null ? +exitPrice.toFixed(4) : null,
      barsHeld,
      rGross,
      rNet,
      csSpreadPct: csSpreadEst != null ? +csSpreadEst.toFixed(6) : null,
      amihud: amihudEst,
      varSpreadR,
      totalFrictionR,
      totalFrictionR2500,
      ...(trailBe120m ? { altOutcomes: { trailBe120m } } : {}),
      diagnostics: baseDiagnostics,
    });

    cooldownUntilIndex = i + SHADOW_V2_HYPOTHESES.PULLBACK_LOOKBACK_BARS;
    activeImpulse = null;
  }

  return records;
}

/** PRNG deterministico (mulberry32): segni indipendenti, nessuna dipendenza, stesso output a parità di seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded sign-flip bootstrap aggregato per cluster giornalieri (`sessionDate`). */
export function clusterBootstrapSignFlipPValue(
  resolved: readonly ShadowV2Record[],
  iterations: number = SHADOW_V2_HYPOTHESES.BOOTSTRAP_ITERATIONS,
  seed: number = SHADOW_V2_HYPOTHESES.BOOTSTRAP_SEED
): { pValue: number | null; nDayClusters: number } {
  const byDay = new Map<string, number[]>();
  for (const r of resolved) {
    if (r.rNet == null || !Number.isFinite(r.rNet)) continue;
    const arr = byDay.get(r.sessionDate) ?? [];
    arr.push(r.rNet);
    byDay.set(r.sessionDate, arr);
  }
  const clusterMeans = Array.from(byDay.values()).map((arr) => arr.reduce((a, b) => a + b, 0) / arr.length);
  const nClusters = clusterMeans.length;
  if (nClusters < 2) {
    return { pValue: null, nDayClusters: nClusters };
  }
  const observedMean = clusterMeans.reduce((a, b) => a + b, 0) / nClusters;
  const rng = mulberry32(seed);
  let geCount = 0;
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let c = 0; c < nClusters; c++) {
      const sign = rng() < 0.5 ? 1 : -1;
      sum += sign * clusterMeans[c];
    }
    if (sum / nClusters >= observedMean) geCount++;
  }
  return {
    pValue: +((geCount + 1) / (iterations + 1)).toFixed(4),
    nDayClusters: nClusters,
  };
}

/** Riepilogo metriche Shadow V2 da tutti i record osservati (100% dati reali raccolti). */
export function summarizeShadowV2(records: readonly ShadowV2Record[], generatedAt: string = new Date().toISOString()): ShadowV2Summary {
  const resolved = records
    .filter((r) => r.status === 'RESOLVED' && r.rGross != null && r.rNet != null)
    .sort((a, b) => (a.exitBarTs ?? a.signalBarTs) - (b.exitBarTs ?? b.signalBarTs));
  const open = records.filter((r) => r.status === 'OPEN');
  const pendingOpen = records.filter((r) => r.status === 'PENDING_OPEN');
  const blocked = records.filter((r) => r.status === 'BLOCKED');

  const wins = resolved.filter((r) => (r.rNet ?? 0) > 0).length;
  const koHits = resolved.filter((r) => r.outcome === 'KO_HIT').length;
  const losses = resolved.filter((r) => r.outcome === 'STOP' || r.outcome === 'KO_HIT' || ((r.rNet ?? 0) < 0 && r.outcome !== 'TIME_BARRIER')).length;
  const timeouts = resolved.filter((r) => r.outcome === 'TIME_BARRIER').length;

  const rGrossList = resolved.map((r) => r.rGross!);
  const rNetList = resolved.map((r) => r.rNet!);
  const fricList = resolved.map((r) => r.totalFrictionR).filter((v): v is number => v != null && Number.isFinite(v));
  const fric2500List = resolved.map((r) => r.totalFrictionR2500).filter((v): v is number => v != null && Number.isFinite(v));

  const meanRGross = rGrossList.length > 0 ? +(rGrossList.reduce((a, b) => a + b, 0) / rGrossList.length).toFixed(4) : null;
  const meanRNet = rNetList.length > 0 ? +(rNetList.reduce((a, b) => a + b, 0) / rNetList.length).toFixed(4) : null;

  const grossProfit = rNetList.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLossAbs = Math.abs(rNetList.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = resolved.length > 0 && grossLossAbs > 0 ? +(grossProfit / grossLossAbs).toFixed(3) : null;

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of rNetList) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  const maxDrawdownR = resolved.length > 0 ? +maxDd.toFixed(4) : null;

  const dsrRes = computeDeflatedSharpe(rNetList);
  const boot = clusterBootstrapSignFlipPValue(resolved);

  const distinctSessions = new Set(records.map((r) => r.sessionDate)).size;

  const limitations: string[] = [
    'Motore sperimentale Shadow V2 (CUSUM + VWAP Pullback-Reclaim + Volatility KO): tutti i parametri numerici sono IPOTESI non ancora validate out-of-sample.',
    'Spread stimato tramite proxy di Corwin-Schultz su barre OHLC 5m e spread KO parametrico (0.20% per lato): nessun tick bid/ask o book L2 reale.',
    'Nessuna promozione automatica al selettore live: SETUP_SELECTOR_LIVE rimane disabilitato ("off"). Validazione minima richiesta >= 100 segnali risolti su >= 30 sessioni distinte.',
  ];
  if (resolved.length < 30) {
    limitations.push(`Campione ridotto (n=${resolved.length} trade risolti): le metriche statistiche non sono ancora inferenziali.`);
  }

  const buildExperiment = (
    id: ShadowV2ExperimentSummary['id'],
    label: string,
    description: string,
    items: ReadonlyArray<{ rGross: number; rNet: number }>
  ): ShadowV2ExperimentSummary => {
    const n = items.length;
    if (n === 0) {
      return {
        id,
        label,
        description,
        n: 0,
        wins: 0,
        winRatePct: null,
        meanRGross: null,
        meanRNet: null,
        sumRNet: null,
        profitFactor: null,
      };
    }
    const w = items.filter((x) => x.rNet > 0).length;
    const sumG = items.reduce((a, x) => a + x.rGross, 0);
    const sumN = items.reduce((a, x) => a + x.rNet, 0);
    const gp = items.filter((x) => x.rNet > 0).reduce((a, x) => a + x.rNet, 0);
    const gl = Math.abs(items.filter((x) => x.rNet < 0).reduce((a, x) => a + x.rNet, 0));
    return {
      id,
      label,
      description,
      n,
      wins: w,
      winRatePct: +((w / n) * 100).toFixed(1),
      meanRGross: +(sumG / n).toFixed(4),
      meanRNet: +(sumN / n).toFixed(4),
      sumRNet: +sumN.toFixed(4),
      profitFactor: gl > 0 ? +(gp / gl).toFixed(3) : null,
    };
  };

  const expBase = buildExperiment(
    'BASE_1K',
    'Base attuale (€1.000 · 90m)',
    'Rischio €10/trade, fee €2 (0,20R) + spread, uscita fissa a Target 1.35R / Stop / 90m.',
    resolved.map((r) => ({ rGross: r.rGross!, rNet: r.rNet! }))
  );

  const expCap2500 = buildExperiment(
    'CAPITAL_2500',
    'Sizing €2.500 (rischio €25)',
    'Identici ingressi e uscite ma rischio €25/trade: la fee €2 scende da 0,20R a 0,08R.',
    resolved.map((r) => {
      const f2500 = r.totalFrictionR2500 ?? r.totalFrictionR ?? 0;
      return { rGross: r.rGross!, rNet: +(r.rGross! - f2500).toFixed(4) };
    })
  );

  const expCostFilter = buildExperiment(
    'COST_AWARE_FILTER',
    'Filtro Costi <= 0,22R',
    'Esclude gli ingressi in cui commissioni + spread erodono oltre il 22% del rischio iniziale.',
    resolved
      .filter((r) => (r.totalFrictionR ?? 1) <= 0.22)
      .map((r) => ({ rGross: r.rGross!, rNet: r.rNet! }))
  );

  const expTrail120 = buildExperiment(
    'TRAIL_BE_120M',
    'Trailing BE + Finestra 120m',
    'Stop a +0,05R dopo +0,80R (lock +0,55R dopo +1,10R) e estensione a 120m solo se > +0,25R a 90m.',
    resolved
      .map((r) => r.altOutcomes?.trailBe120m)
      .filter((a): a is ShadowV2AltOutcome => a != null)
      .map((a) => ({ rGross: a.rGross, rNet: a.rNet }))
  );

  const trailPaired = resolved.filter((r) => r.altOutcomes?.trailBe120m != null);
  const trailSameWindow = trailPaired.filter(
    (r) => r.altOutcomes?.trailBe120m?.barsHeld === r.barsHeld
  ).length;
  const trailBe120mPairing: ShadowV2TrailPairingDiagnostic = {
    n: trailPaired.length,
    sameWindow: trailSameWindow,
    differentWindow: trailPaired.length - trailSameWindow,
    baseVerticalBars: SHADOW_V2_HYPOTHESES.VERTICAL_BARS,
    trailMaxVerticalBars: SHADOW_V2_TRAIL_MAX_VERTICAL_BARS,
  };

  const experiments: ShadowV2ExperimentSummary[] = [
    expBase,
    expCap2500,
    expCostFilter,
    expTrail120,
  ];

  return {
    strategyName: 'Shadow V2 — CUSUM Displacement + VWAP Pullback-Reclaim (KO Vol-Matched)',
    generatedAt,
    nSessions: distinctSessions,
    nSignals: records.length,
    nResolved: resolved.length,
    nOpen: open.length,
    nPendingOpen: pendingOpen.length,
    nBlocked: blocked.length,
    wins,
    losses,
    koHits,
    timeouts,
    winRatePct: resolved.length > 0 ? +((wins / resolved.length) * 100).toFixed(1) : null,
    meanRGross,
    meanRNet,
    medianFrictionR: median(fricList) != null ? +median(fricList)!.toFixed(4) : null,
    medianFrictionR2500: median(fric2500List) != null ? +median(fric2500List)!.toFixed(4) : null,
    profitFactor,
    maxDrawdownR,
    dsr: dsrRes.dsr,
    dsrNote: dsrRes.note,
    clusterBootstrapPValue: boot.pValue,
    nDayClusters: boot.nDayClusters,
    trailBe120mPairing,
    experiments,
    hypotheses: SHADOW_V2_HYPOTHESES,
    limitations,
    recentSignals: [...records]
      .sort((a, b) => {
        const aActive = a.status === 'OPEN' || a.status === 'PENDING_OPEN' ? 0 : 1;
        const bActive = b.status === 'OPEN' || b.status === 'PENDING_OPEN' ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return b.signalBarTs - a.signalBarTs;
      })
      .slice(0, 25),
  };
}

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const SHADOW_V2_CSV_HEADERS = [
  'id',
  'sessionDate',
  'ticker',
  'market',
  'direction',
  'triggerType',
  'signalTimeIso',
  'status',
  'outcome',
  'blockedReason',
  'entryPrice',
  'structuralStop',
  'target1',
  'leverage',
  'koBarrier',
  'exitPrice',
  'barsHeld',
  'rGross',
  'rNet',
  'totalFrictionR',
  'totalFrictionR2500',
  'varSpreadR',
  'csSpreadPct',
  'cusumZ',
  'gapPct',
] as const;

export function formatShadowV2SignalsCsv(records: readonly Partial<ShadowV2Record>[]): string {
  const header = SHADOW_V2_CSV_HEADERS.join(',');
  const rows = records.map((r) =>
    [
      r.id ?? '',
      r.sessionDate ?? '',
      r.ticker ?? '',
      r.market ?? '',
      r.direction ?? '',
      r.triggerType ?? '',
      r.signalTimeIso ?? '',
      r.status ?? '',
      r.outcome ?? '',
      r.blockedReason ?? '',
      r.entryPrice ?? '',
      r.structuralStop ?? '',
      r.target1 ?? '',
      r.leverage ?? '',
      r.koBarrier ?? '',
      r.exitPrice ?? '',
      r.barsHeld ?? '',
      r.rGross ?? '',
      r.rNet ?? '',
      r.totalFrictionR ?? '',
      r.totalFrictionR2500 ?? '',
      r.varSpreadR ?? '',
      r.csSpreadPct ?? '',
      r.diagnostics?.cusumZ ?? '',
      r.diagnostics?.gapPct ?? '',
    ]
      .map(escapeCsvCell)
      .join(',')
  );
  return [header, ...rows].join('\n');
}

export function formatShadowV2SignalsJsonl(records: readonly Partial<ShadowV2Record>[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}
