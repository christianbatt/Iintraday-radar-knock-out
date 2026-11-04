/**
 * Indicatori di setup su barre 5m - funzioni pure, nessun I/O.
 *
 * Regole comuni (TUTTE IPOTESI, vedi TRADING_PARAMS.IND_* / ST_* / ADX_* / STOCH_RSI_* / PSAR_*):
 * - input: barre 5m della sessione regolare corrente fino a T + fino a WARMUP_MAX_PRIOR_SESSIONS
 *   sessioni regolari gia' chiuse prima dell'apertura della sessione corrente
 *   (festivita' e weekend saltati, mai una sessione futura);
 * - nessun look-ahead: una barra e' usabile solo se la sua chiusura (apertura + IND_BAR_MS)
 *   non supera T; le barre con chiusura > T vengono scartate prima del calcolo;
 * - after-market escluso e barre incomplete scartate;
 * - ogni indicatore restituisce status OK oppure UNKNOWN con reason esplicita
 *   (INSUFFICIENT_BARS, NAN, STALE, AFTER_HOURS): nessun valore di default inventato.
 *
 * Convenzioni di calcolo (condivise con scripts/indicator_reference.py, che genera
 * le fixture di riferimento usate dai test):
 * - ATR: media di Wilder (RMA) del True Range, seed = media semplice dei primi `period` TR.
 * - Supertrend: bande basic (HL2 +/- factor*ATR), bande finali con trailing e direzione +1/-1.
 * - ADX: smoothing di Wilder su TR/+DM/-DM, DX = 100*|+DI - -DI|/(+DI + -DI),
 *   ADX = media di Wilder dei DX con seed = media semplice dei primi `period` DX.
 * - StochRSI: RSI di Wilder(14) sul close, raw = (RSI - min)/(max - min) su 14, %K = SMA(raw,3),
 *   %D = SMA(%K,3).
 * - PSAR: 0.02/0.02/0.20 con clamp sui due estremi precedenti.
 */
import type {
  AdxSnapshot,
  IndicatorBarInput,
  IndicatorUnknownReason,
  PsarSnapshot,
  SetupIndicators,
  StochRsiSnapshot,
  SupertrendSnapshot,
} from '../types/radar';
import { adxThresholds, IND_BAR_MS, TRADING_PARAMS } from '../config/tradingParams';

const MINUTE_MS = 60_000;

/** Minuti dalla mezzanotte nel fuso del mercato, con ora legale gestita da Intl. */
export function exchangeMinutes(tsMs: number, market: 'EU' | 'US'): number {
  const timeZone = market === 'EU' ? 'Europe/Rome' : 'America/New_York';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(tsMs));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

export function isRegularSessionBar(tsMs: number, market: 'EU' | 'US'): boolean {
  const minutes = exchangeMinutes(tsMs, market);
  const open =
    market === 'US'
      ? TRADING_PARAMS.US_OPEN_HOUR * 60 + TRADING_PARAMS.US_OPEN_MINUTE
      : TRADING_PARAMS.EU_OPEN_HOUR * 60 + TRADING_PARAMS.EU_OPEN_MINUTE;
  const close =
    market === 'US'
      ? TRADING_PARAMS.US_CLOSE_HOUR * 60 + TRADING_PARAMS.US_CLOSE_MINUTE
      : TRADING_PARAMS.EU_CLOSE_HOUR * 60 + TRADING_PARAMS.EU_CLOSE_MINUTE;
  return minutes >= open && minutes < close;
}

/** Barre ordinate, senza duplicati, solo sessione regolare e OHLC finiti. */
export function filterRegularSessionBars(
  bars: readonly IndicatorBarInput[],
  market: 'EU' | 'US'
): IndicatorBarInput[] {
  const seen = new Set<number>();
  return bars
    // AUDIT P1-4: una barra non databile (timestamp non finito o data invalida) non e' usabile.
    .filter((b) => Number.isFinite(b.t) && b.t > 0 && Number.isFinite(new Date(b.t).getTime()))
    .filter((b) => isRegularSessionBar(b.t, market))
    .filter((b) => [b.o, b.h, b.l, b.c].every((v) => typeof v === 'number' && Number.isFinite(v)))
    .sort((a, b) => a.t - b.t)
    .filter((b) => {
      if (seen.has(b.t)) return false;
      seen.add(b.t);
      return true;
    });
}

/** Data locale di scambio (YYYY-MM-DD) nel fuso del mercato. */
export function exchangeDate(tsMs: number, market: 'EU' | 'US'): string {
  const timeZone = market === 'EU' ? 'Europe/Rome' : 'America/New_York';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(tsMs));
}

/**
 * Selezione della serie di warm-up senza look-ahead (solo barre chiuse):
 * - una barra e' usabile solo se la sua chiusura (apertura + IND_BAR_MS) <= T;
 *   le barre con chiusura > T vengono scartate e conteggiate in droppedFutureBars;
 * - sessione regolare corrente (barre chiuse <= T) + fino a WARMUP_MAX_PRIOR_SESSIONS sessioni
 *   regolari gia' chiuse prima dell'apertura corrente.
 * Le sessioni mancanti (festivi, weekend) vengono saltate: si usa la sessione chiusa piu'
 * recente realmente presente, mai una sessione futura. Nessuna barra inventata.
 */
export function selectWarmupBars(
  bars: readonly IndicatorBarInput[],
  market: 'EU' | 'US',
  options: { maxPriorSessions?: number; now?: Date | number } = {}
): {
  bars: IndicatorBarInput[];
  priorSessionsUsed: number;
  sessionsUsed: string[];
  droppedFutureBars: number;
} {
  const maxPrior = Math.max(0, options.maxPriorSessions ?? TRADING_PARAMS.WARMUP_MAX_PRIOR_SESSIONS);
  const nowMs = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
  const regularAll = filterRegularSessionBars(bars, market);
  // Yahoo riporta l'apertura della barra: una barra e' chiusa (usabile) solo se
  // apertura + IND_BAR_MS <= T. Barre non ancora chiuse (in formazione) escludono
  // ogni indicatore che le usa: non si calcola mai un indicatore su una barra in formazione.
  const prepared = regularAll.filter((b) => b.t + IND_BAR_MS <= nowMs);
  const droppedFutureBars = regularAll.length - prepared.length;
  if (prepared.length === 0) {
    return { bars: [], priorSessionsUsed: 0, sessionsUsed: [], droppedFutureBars };
  }

  const order: string[] = [];
  const byDate = new Map<string, IndicatorBarInput[]>();
  for (const bar of prepared) {
    const date = exchangeDate(bar.t, market);
    let group = byDate.get(date);
    if (!group) {
      group = [];
      byDate.set(date, group);
      order.push(date);
    }
    group.push(bar);
  }

  const used = order.slice(Math.max(0, order.length - (maxPrior + 1)));
  return {
    bars: used.flatMap((date) => byDate.get(date) ?? []),
    priorSessionsUsed: Math.max(0, used.length - 1),
    sessionsUsed: used,
    droppedFutureBars,
  };
}

export interface WarmupSeriesResult {
  bars: IndicatorBarInput[];
  rangeUsed: string;
  fallbackUsed: boolean;
  priorSessionsUsed: number;
  completeBars: number;
  /** Barre regolari scartate perche' successive a T (look-ahead): diagnostica della reason. */
  droppedFutureBars: number;
}

/**
 * Carica la serie 5m per gli indicatori con il range dedicato WARMUP_RANGE_5M; se dopo il
 * filtro le barre complete sono < IND_MIN_BARS richiede WARMUP_RANGE_FALLBACK_5M.
 * `fetcher` e' iniettato: in produzione e' la chiamata a Yahoo, nei test e' un mock (nessuna rete).
 * Nessuna imputazione: se anche il fallback non basta si restituisce la serie disponibile e
 * gli indicatori restano UNKNOWN con la reason esplicita. `now` e' il tempo T dello scan:
 * nessuna barra successiva a T entra nella serie.
 */
export async function loadWarmupBars(
  fetcher: (range: string) => Promise<readonly IndicatorBarInput[]>,
  options: { market: 'EU' | 'US'; minBars?: number; maxPriorSessions?: number; now?: Date }
): Promise<WarmupSeriesResult> {
  const minBars = options.minBars ?? TRADING_PARAMS.IND_MIN_BARS;
  const maxPriorSessions = options.maxPriorSessions ?? TRADING_PARAMS.WARMUP_MAX_PRIOR_SESSIONS;
  const now = options.now;

  const primaryRange = TRADING_PARAMS.WARMUP_RANGE_5M;
  let selection = selectWarmupBars(await fetcher(primaryRange), options.market, { maxPriorSessions, now });
  let rangeUsed = primaryRange;
  let fallbackUsed = false;

  if (selection.bars.length < minBars) {
    const fallbackRange = TRADING_PARAMS.WARMUP_RANGE_FALLBACK_5M;
    try {
      const fallbackSelection = selectWarmupBars(await fetcher(fallbackRange), options.market, {
        maxPriorSessions,
        now,
      });
      if (fallbackSelection.bars.length >= selection.bars.length) {
        selection = fallbackSelection;
        rangeUsed = fallbackRange;
        fallbackUsed = true;
      }
    } catch {
      // fallback non disponibile: resta la serie primaria, nessun valore inventato
    }
  }

  return {
    bars: selection.bars,
    rangeUsed,
    fallbackUsed,
    priorSessionsUsed: selection.priorSessionsUsed,
    completeBars: selection.bars.length,
    droppedFutureBars: selection.droppedFutureBars,
  };
}

/** True Range su tutte le barre (indice 0 null: serve il close precedente). */
export function trueRangeSeries(bars: readonly IndicatorBarInput[]): (number | null)[] {
  const tr: (number | null)[] = bars.map(() => null);
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].c;
    tr[i] = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - prevClose),
      Math.abs(bars[i].l - prevClose)
    );
  }
  return tr;
}

/** ATR di Wilder (RMA): null prima del seed, poi media di Wilder. */
export function atrSeries(
  bars: readonly IndicatorBarInput[],
  period: number = TRADING_PARAMS.ATR_PERIOD
): (number | null)[] {
  const tr = trueRangeSeries(bars);
  const out: (number | null)[] = bars.map(() => null);
  if (period <= 0 || bars.length <= period) return out;

  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i] ?? 0;
  let rma = seed / period;
  out[period] = rma;
  for (let i = period + 1; i < bars.length; i++) {
    rma = (rma * (period - 1) + (tr[i] ?? 0)) / period;
    out[i] = rma;
  }
  return out;
}

const unknownReason = (
  bars: readonly IndicatorBarInput[],
  prepared: boolean,
  minBars: number,
  now: Date,
  maxStaleMin: number
): IndicatorUnknownReason | null => {
  if (bars.length === 0) return 'AFTER_HOURS';
  if (!prepared) return 'INSUFFICIENT_BARS';
  if (bars.length < minBars) return 'INSUFFICIENT_BARS';
  const lastTs = bars[bars.length - 1].t;
  if (!Number.isFinite(lastTs)) return 'NAN';
  if (now.getTime() - lastTs > maxStaleMin * MINUTE_MS) return 'STALE';
  return null;
};

export interface SupertrendResult {
  snapshot: SupertrendSnapshot;
  /** Serie delle bande finali e direzione, allineata alle barre (null prima del warm-up). */
  upper: (number | null)[];
  lower: (number | null)[];
  direction: (1 | -1 | null)[];
}

/**
 * Supertrend standard:
 * basic = HL2 +/- factor*ATR; la banda finale trascina (non si allarga) finché il close
 * non la viola; la direzione cambia quando il close chiude oltre la banda finale opposta.
 */
export function computeSupertrend(
  bars: readonly IndicatorBarInput[],
  options: { period?: number; factor?: number; now?: Date; maxStaleMin?: number } = {}
): SupertrendResult {
  const period = options.period ?? TRADING_PARAMS.ST_PERIOD;
  const factor = options.factor ?? TRADING_PARAMS.ST_FACTOR;
  const now = options.now ?? new Date();
  const maxStaleMin = options.maxStaleMin ?? TRADING_PARAMS.IND_MAX_STALE_MIN;

  const atr = atrSeries(bars, period);
  const upper: (number | null)[] = bars.map(() => null);
  const lower: (number | null)[] = bars.map(() => null);
  const direction: (1 | -1 | null)[] = bars.map(() => null);

  let lastDir: 1 | -1 = 1;
  let barsSinceFlip: number | null = null;
  let flipIndex: number | null = null;

  for (let i = 0; i < bars.length; i++) {
    const a = atr[i];
    if (a == null || !Number.isFinite(a)) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    const basicUpper = hl2 + factor * a;
    const basicLower = hl2 - factor * a;

    if (i === 0 || upper[i - 1] == null || lower[i - 1] == null) {
      upper[i] = basicUpper;
      lower[i] = basicLower;
      direction[i] = 1;
      lastDir = 1;
      continue;
    }

    const prevUpper = upper[i - 1]!;
    const prevLower = lower[i - 1]!;
    upper[i] = basicUpper < prevUpper || bars[i - 1].c > prevUpper ? basicUpper : prevUpper;
    lower[i] = basicLower > prevLower || bars[i - 1].c < prevLower ? basicLower : prevLower;

    if (bars[i].c > prevUpper) lastDir = 1;
    else if (bars[i].c < prevLower) lastDir = -1;

    if (direction[i - 1] != null && lastDir !== direction[i - 1]) flipIndex = i;
    direction[i] = lastDir;
  }

  const lastIdx = bars.length - 1;
  if (flipIndex != null && lastIdx >= 0) barsSinceFlip = lastIdx - flipIndex;

  const reason = unknownReason(bars, direction[lastIdx] != null, TRADING_PARAMS.IND_MIN_BARS, now, maxStaleMin);
  const snapshot: SupertrendSnapshot =
    reason == null
      ? {
          status: 'OK',
          reason: null,
          direction: direction[lastIdx] ?? 0,
          barsSinceFlip,
          value: direction[lastIdx] === 1 ? lower[lastIdx] : upper[lastIdx],
        }
      : { status: 'UNKNOWN', reason, direction: 0, barsSinceFlip: null, value: null };

  return { snapshot, upper, lower, direction };
}

export interface AdxResult {
  snapshot: AdxSnapshot;
}

/** ADX di Wilder con +DI / -DI. */
export function computeAdx(
  bars: readonly IndicatorBarInput[],
  options: { period?: number; now?: Date; maxStaleMin?: number } = {}
): AdxResult {
  const period = options.period ?? TRADING_PARAMS.ADX_PERIOD;
  const now = options.now ?? new Date();
  const maxStaleMin = options.maxStaleMin ?? TRADING_PARAMS.IND_MAX_STALE_MIN;

  type AdxValue = { adx: number; plusDI: number; minusDI: number };
  let last: AdxValue | null = null;

  if (bars.length > 2 * period) {
    const tr = trueRangeSeries(bars);
    const plusDM: number[] = bars.map(() => 0);
    const minusDM: number[] = bars.map(() => 0);
    for (let i = 1; i < bars.length; i++) {
      const up = bars[i].h - bars[i - 1].h;
      const down = bars[i - 1].l - bars[i].l;
      plusDM[i] = up > down && up > 0 ? up : 0;
      minusDM[i] = down > up && down > 0 ? down : 0;
    }

    let trS = 0;
    let plusS = 0;
    let minusS = 0;
    for (let i = 1; i <= period; i++) {
      trS += tr[i] ?? 0;
      plusS += plusDM[i];
      minusS += minusDM[i];
    }

    const dx: (number | null)[] = bars.map(() => null);
    let adxValue: number | null = null;
    let adxCount = 0;
    let adxSum = 0;

    for (let i = period; i < bars.length; i++) {
      if (i > period) {
        trS = trS - trS / period + (tr[i] ?? 0);
        plusS = plusS - plusS / period + plusDM[i];
        minusS = minusS - minusS / period + minusDM[i];
      }
      const plusDI = trS > 0 ? (100 * plusS) / trS : 0;
      const minusDI = trS > 0 ? (100 * minusS) / trS : 0;
      const diSum = plusDI + minusDI;
      const dxValue = diSum > 0 ? (100 * Math.abs(plusDI - minusDI)) / diSum : 0;
      dx[i] = dxValue;

      if (adxValue == null) {
        adxSum += dxValue;
        adxCount++;
        if (adxCount === period) {
          adxValue = adxSum / period;
          last = { adx: adxValue, plusDI, minusDI };
        }
      } else {
        adxValue = (adxValue * (period - 1) + dxValue) / period;
        last = { adx: adxValue, plusDI, minusDI };
      }
    }
  }

  const reason = unknownReason(bars, last != null, TRADING_PARAMS.IND_MIN_BARS, now, maxStaleMin);
  const snapshot: AdxSnapshot =
    reason == null && last != null && Number.isFinite(last.adx)
      ? { status: 'OK', reason: null, value: +last.adx.toFixed(6), plusDI: +last.plusDI.toFixed(6), minusDI: +last.minusDI.toFixed(6) }
      : { status: 'UNKNOWN', reason: reason ?? 'NAN', value: null, plusDI: null, minusDI: null };

  return { snapshot };
}

/** RSI di Wilder (prima media semplice, poi smoothing di Wilder). */
export function wilderRsiSeries(closes: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss += Math.abs(diff);
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

const sma = (values: readonly (number | null)[], endIndex: number, length: number): number | null => {
  const start = endIndex - length + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= endIndex; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / length;
};

export interface StochRsiResult {
  snapshot: StochRsiSnapshot;
}

/** StochRSI(14,14,3,3) con incroci K/D riconosciuti nelle ultime STOCH_RSI_CROSS_LOOKBACK barre. */
export function computeStochRsi(
  bars: readonly IndicatorBarInput[],
  options: {
    rsiLen?: number;
    stochLen?: number;
    kPeriod?: number;
    dPeriod?: number;
    lookback?: number;
    longCrossMax?: number;
    shortCrossMin?: number;
    now?: Date;
    maxStaleMin?: number;
  } = {}
): StochRsiResult {
  const rsiLen = options.rsiLen ?? TRADING_PARAMS.STOCH_RSI_RSI_LEN;
  const stochLen = options.stochLen ?? TRADING_PARAMS.STOCH_RSI_STOCH_LEN;
  const kPeriod = options.kPeriod ?? TRADING_PARAMS.STOCH_RSI_K;
  const dPeriod = options.dPeriod ?? TRADING_PARAMS.STOCH_RSI_D;
  const lookback = options.lookback ?? TRADING_PARAMS.STOCH_RSI_CROSS_LOOKBACK;
  const longCrossMax = options.longCrossMax ?? TRADING_PARAMS.STOCH_RSI_LONG_CROSS_MAX;
  const shortCrossMin = options.shortCrossMin ?? TRADING_PARAMS.STOCH_RSI_SHORT_CROSS_MIN;
  const now = options.now ?? new Date();
  const maxStaleMin = options.maxStaleMin ?? TRADING_PARAMS.IND_MAX_STALE_MIN;

  const closes = bars.map((b) => b.c);
  const rsi = wilderRsiSeries(closes, rsiLen);
  const raw: (number | null)[] = bars.map(() => null);
  for (let i = 0; i < bars.length; i++) {
    if (rsi[i] == null) continue;
    const start = i - stochLen + 1;
    if (start < 0) continue;
    let min = Infinity;
    let max = -Infinity;
    let complete = true;
    for (let j = start; j <= i; j++) {
      const v = rsi[j];
      if (v == null) {
        complete = false;
        break;
      }
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!complete) continue;
    raw[i] = max - min === 0 ? 50 : ((rsi[i]! - min) / (max - min)) * 100;
  }

  const kSerie: (number | null)[] = bars.map((_, i) => sma(raw, i, kPeriod));
  const dSerie: (number | null)[] = bars.map((_, i) => sma(kSerie, i, dPeriod));

  const lastIdx = bars.length - 1;
  const k = lastIdx >= 0 ? kSerie[lastIdx] : null;
  const d = lastIdx >= 0 ? dSerie[lastIdx] : null;

  let lastCross: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
  let barsSinceCross: number | null = null;
  for (let i = lastIdx; i >= Math.max(1, lastIdx - lookback + 1); i--) {
    const kNow = kSerie[i];
    const dNow = dSerie[i];
    const kPrev = kSerie[i - 1];
    const dPrev = dSerie[i - 1];
    if (kNow == null || dNow == null || kPrev == null || dPrev == null) continue;
    const isLongCross = kPrev <= dPrev && kNow > dNow;
    const isShortCross = kPrev >= dPrev && kNow < dNow;
    if (isLongCross && kNow <= longCrossMax) {
      lastCross = 'LONG';
      barsSinceCross = lastIdx - i;
      break;
    }
    if (isShortCross && kNow >= shortCrossMin) {
      lastCross = 'SHORT';
      barsSinceCross = lastIdx - i;
      break;
    }
  }

  const reason = unknownReason(bars, k != null && d != null, TRADING_PARAMS.IND_MIN_BARS, now, maxStaleMin);
  const snapshot: StochRsiSnapshot =
    reason == null && k != null && d != null && Number.isFinite(k) && Number.isFinite(d)
      ? { status: 'OK', reason: null, k: +k.toFixed(6), d: +d.toFixed(6), lastCross, barsSinceCross }
      : { status: 'UNKNOWN', reason: reason ?? 'NAN', k: null, d: null, lastCross: 'NONE', barsSinceCross: null };

  return { snapshot };
}

export interface PsarResult {
  snapshot: PsarSnapshot;
  series: (number | null)[];
}

/** Parabolic SAR (0.02 / 0.02 / 0.20) con clamp sui due estremi precedenti. */
export function computePsar(
  bars: readonly IndicatorBarInput[],
  options: { start?: number; step?: number; max?: number; now?: Date; maxStaleMin?: number } = {}
): PsarResult {
  const start = options.start ?? TRADING_PARAMS.PSAR_START;
  const step = options.step ?? TRADING_PARAMS.PSAR_STEP;
  const max = options.max ?? TRADING_PARAMS.PSAR_MAX;
  const now = options.now ?? new Date();
  const maxStaleMin = options.maxStaleMin ?? TRADING_PARAMS.IND_MAX_STALE_MIN;

  const series: (number | null)[] = bars.map(() => null);
  let isLong = true;
  let sar = 0;
  let ep = 0;
  let af = start;
  let flipIndex = 0;
  let initialised = false;

  for (let i = 0; i < bars.length; i++) {
    if (!initialised) {
      if (i < 1) continue;
      isLong = bars[i].c >= bars[i - 1].c;
      sar = isLong ? bars[i - 1].l : bars[i - 1].h;
      ep = isLong ? bars[i].h : bars[i].l;
      af = start;
      flipIndex = i;
      initialised = true;
      series[i] = sar;
      continue;
    }

    sar = sar + af * (ep - sar);
    if (isLong) {
      const prevLow = bars[i - 1].l;
      const prev2Low = i >= 2 ? bars[i - 2].l : prevLow;
      sar = Math.min(sar, prevLow, prev2Low);
      if (bars[i].l < sar) {
        isLong = false;
        sar = ep;
        ep = bars[i].l;
        af = start;
        flipIndex = i;
      } else if (bars[i].h > ep) {
        ep = bars[i].h;
        af = Math.min(max, af + step);
      }
    } else {
      const prevHigh = bars[i - 1].h;
      const prev2High = i >= 2 ? bars[i - 2].h : prevHigh;
      sar = Math.max(sar, prevHigh, prev2High);
      if (bars[i].h > sar) {
        isLong = true;
        sar = ep;
        ep = bars[i].h;
        af = start;
        flipIndex = i;
      } else if (bars[i].l < ep) {
        ep = bars[i].l;
        af = Math.min(max, af + step);
      }
    }
    series[i] = sar;
  }

  const lastIdx = bars.length - 1;
  const reason = unknownReason(bars, initialised, TRADING_PARAMS.IND_MIN_BARS, now, maxStaleMin);
  const snapshot: PsarSnapshot =
    reason == null && initialised
      ? {
          status: 'OK',
          reason: null,
          value: +sar.toFixed(6),
          direction: isLong ? 1 : -1,
          barsSinceFlip: lastIdx - flipIndex,
        }
      : { status: 'UNKNOWN', reason: reason ?? 'NAN', value: null, direction: 0, barsSinceFlip: null };

  return { snapshot, series };
}

/**
 * Calcola il pacchetto indicatori usato dallo score e dal prompt AI.
 * Solo barre chiuse (apertura + IND_BAR_MS <= T) sono usate: il confronto con T e'
 * centralizzato in selectWarmupBars, quindi nessun punto del codice confronta t con now
 * direttamente. Le barre after-market e quelle non ancora chiuse vengono escluse prima del
 * calcolo; con meno di IND_MIN_BARS barre regolari ogni indicatore e' UNKNOWN.
 */
export function computeSetupIndicators(
  bars: readonly IndicatorBarInput[],
  options: {
    market: 'EU' | 'US';
    now?: Date;
    minBars?: number;
    maxStaleMin?: number;
    maxPriorSessions?: number;
    rangeUsed?: string | null;
    priorSessionsUsed?: number;
    droppedFutureBars?: number;
  }
): SetupIndicators {
  const now = options.now ?? new Date();
  const minBars = options.minBars ?? TRADING_PARAMS.IND_MIN_BARS;
  const maxStaleMin = options.maxStaleMin ?? TRADING_PARAMS.IND_MAX_STALE_MIN;
  const selection = selectWarmupBars(bars, options.market, {
    maxPriorSessions: options.maxPriorSessions,
    now,
  });
  const prepared = selection.bars;
  const warmupMeta = {
    rangeUsed: options.rangeUsed ?? null,
    priorSessionsUsed: options.priorSessionsUsed ?? selection.priorSessionsUsed,
    recentBars: prepared.slice(-12).map((b) => ({ t: b.t, h: b.h, l: b.l, c: b.c })),
    adxThreshold: adxThresholds(options.market),
  };

  if (prepared.length < minBars) {
    const droppedFutureBars = options.droppedFutureBars ?? selection.droppedFutureBars;
    const reason: IndicatorUnknownReason =
      prepared.length === 0
        ? droppedFutureBars > 0
          ? 'INSUFFICIENT_BARS'
          : 'AFTER_HOURS'
        : 'INSUFFICIENT_BARS';
    const unknown = <T extends { status: 'UNKNOWN'; reason: IndicatorUnknownReason }>(extra: T) => extra;
    return {
      barsUsed: prepared.length,
      ...warmupMeta,
      atr: { value: null, status: 'UNKNOWN', reason },
      supertrend: { status: 'UNKNOWN', reason, direction: 0, barsSinceFlip: null, value: null },
      adx: { status: 'UNKNOWN', reason, value: null, plusDI: null, minusDI: null },
      stochRsi: { status: 'UNKNOWN', reason, k: null, d: null, lastCross: 'NONE', barsSinceCross: null },
      psar: { status: 'UNKNOWN', reason, value: null, direction: 0, barsSinceFlip: null },
    };
  }

  const supertrend = computeSupertrend(prepared, { now, maxStaleMin }).snapshot;
  const adx = computeAdx(prepared, { now, maxStaleMin }).snapshot;
  const stochRsi = computeStochRsi(prepared, { now, maxStaleMin }).snapshot;
  const psar = computePsar(prepared, { now, maxStaleMin }).snapshot;

  const atrValues = atrSeries(prepared);
  const lastAtr = atrValues[atrValues.length - 1];
  const stale = now.getTime() - prepared[prepared.length - 1].t > maxStaleMin * MINUTE_MS;

  return {
    barsUsed: prepared.length,
    ...warmupMeta,
    atr:
      lastAtr != null && Number.isFinite(lastAtr) && !stale
        ? { value: +lastAtr.toFixed(6), status: 'OK', reason: null }
        : { value: null, status: 'UNKNOWN', reason: lastAtr == null ? 'INSUFFICIENT_BARS' : stale ? 'STALE' : 'NAN' },
    supertrend,
    adx,
    stochRsi,
    psar,
  };
}
