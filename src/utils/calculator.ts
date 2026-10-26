import {
  RawQuoteData,
  ScoredCandidate,
  ScoreBreakdown,
  ExecutionSetup,
  GeminiCatalystAnalysis,
  NewsItem,
  KnockOutCalculatorInput,
  KnockOutSafetyCheck,
  PnLScenario,
  DynamicBreakevenInfo,
  DerivativeStressReport,
  ImpliedVolatilityMetrics,
  TradeJournalEntry,
  SystemParameters,
  OptimizationProposal,
  DualOptimizationProposals,
  ProposedParameterChange,
  OptimizationMetrics,
  HourlySeasonalitySlot,
  DaySeasonalitySlot,
  SeasonalityReport,
  FilteringAuditReport,
  ExcludedCandidateInfo,
  ExclusionCategory,
  ExcludedSetupRecord,
  ExcludedCategoryAnalysis,
  ExcludedSetupsAutoAnalysis,
  ExcludedOutcomeStatus,
  EntryMode,
} from '../types/radar';
import { TRADING_PARAMS } from '../config/tradingParams';
import { getMarketTime, getExchangeDateStr } from './timezone';

export interface DailyBarInput {
  date?: string;
  timestamp?: number; // Unix seconds or ms
  open?: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IntradayCandleInput {
  timestamp: number | string | Date; // Unix seconds, ms, ISO string, or Date
  open?: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * Filtra solo le barre giornaliere completate (escludendo la candela odierna nel fuso della borsa).
 */
export function filterCompletedBars(
  bars: DailyBarInput[],
  market: 'EU' | 'US',
  referenceDate: Date = new Date()
): DailyBarInput[] {
  const todayStr = getExchangeDateStr(market, referenceDate);
  return bars.filter((b) => {
    let barDate = b.date;
    if (!barDate && b.timestamp != null) {
      const ms = b.timestamp > 1e11 ? b.timestamp : b.timestamp * 1000;
      barDate = getExchangeDateStr(market, new Date(ms));
    }
    return barDate ? barDate < todayStr : true;
  });
}

/**
 * ATR14 = media semplice di 14 True Range completati.
 * Richiede almeno 15 barre complete (serve il close precedente per il primo dei 14 TR).
 */
export function calculateAtr14FromBars(completedBars: DailyBarInput[]): number | null {
  if (!completedBars || completedBars.length < TRADING_PARAMS.ATR_MIN_BARS) {
    return null;
  }
  const period = TRADING_PARAMS.ATR_PERIOD;
  let trSum = 0;
  for (let i = completedBars.length - period; i < completedBars.length; i++) {
    const cur = completedBars[i];
    const prevClose = completedBars[i - 1].close;
    if (
      cur.high == null ||
      cur.low == null ||
      cur.close == null ||
      prevClose == null ||
      cur.high < cur.low
    ) {
      return null;
    }
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trSum += tr;
  }
  return +(trSum / period).toFixed(4);
}

/**
 * ADR14 = media semplice di 14 (massimo - minimo) completati.
 * Richiede almeno 14 barre complete.
 */
export function calculateAdr14FromBars(completedBars: DailyBarInput[]): number | null {
  if (!completedBars || completedBars.length < TRADING_PARAMS.ADR_PERIOD) {
    return null;
  }
  const period = TRADING_PARAMS.ADR_PERIOD;
  const sample = completedBars.slice(-period);
  let rangeSum = 0;
  for (const b of sample) {
    if (b.high == null || b.low == null || b.high < b.low) {
      return null;
    }
    rangeSum += b.high - b.low;
  }
  return +(rangeSum / period).toFixed(4);
}

/**
 * Liq€ = media di Volume * Close su 20 sessioni complete.
 * Richiede almeno 20 barre complete; se mancano restituisce null (-> G2 DATI INSUFFICIENTI).
 */
export function calculateLiqEurFromBars(
  completedBars: DailyBarInput[],
  fxDivisor: number = 1.0,
  currency: string = 'EUR'
): number | null {
  if (!completedBars || completedBars.length < TRADING_PARAMS.LIQ_BARS_REQUIRED) {
    return null;
  }
  const isEur = !currency || currency.toUpperCase() === 'EUR';
  if (!isEur) {
    if (fxDivisor == null || isNaN(fxDivisor) || fxDivisor <= 0) {
      throw new Error(`Tasso FX mancante o non valido per valuta ${currency}: impossibile calcolare Liq€ reale.`);
    }
  }
  const required = TRADING_PARAMS.LIQ_BARS_REQUIRED;
  const sample = completedBars.slice(-required);
  let turnoverSum = 0;
  for (const b of sample) {
    if (
      b.volume == null ||
      b.volume <= 0 ||
      b.close == null ||
      b.close <= 0
    ) {
      return null;
    }
    turnoverSum += b.volume * b.close;
  }
  const avgTurnover = turnoverSum / required;
  const divisor = isEur ? (fxDivisor && fxDivisor > 0 ? fxDivisor : 1.0) : fxDivisor;
  return Math.round(avgTurnover / divisor);
}

/**
 * Calcola i livelli ORB (T, S, Tb) dalle candele intraday nel fuso ufficiale della borsa.
 * Una candela appartiene alla finestra ORB se inizio >= apertura e inizio < chiusura ORB.
 * T e Tb restano invariati dopo la prima rottura.
 */
export function calculateOrbFromIntradayBars(
  bars: IntradayCandleInput[],
  market: 'EU' | 'US',
  referenceDate?: Date,
  direction: 'LONG' | 'SHORT' = 'LONG'
): {
  orbHigh: number | null;
  orbLow: number | null;
  triggerLevel: number | null;
  stopLossLevel: number | null;
  firstBreakoutTime: string | null;
} {
  if (!bars || bars.length === 0) {
    return { orbHigh: null, orbLow: null, triggerLevel: null, stopLossLevel: null, firstBreakoutTime: null };
  }

  const openM =
    market === 'US'
      ? TRADING_PARAMS.US_OPEN_HOUR * 60 + TRADING_PARAMS.US_OPEN_MINUTE
      : TRADING_PARAMS.EU_OPEN_HOUR * 60 + TRADING_PARAMS.EU_OPEN_MINUTE;
  const orbEndM = openM + TRADING_PARAMS.ORB_MINUTES;

  const toDate = (ts: number | string | Date): Date => {
    if (ts instanceof Date) return ts;
    if (typeof ts === 'string') return new Date(ts);
    return new Date(ts > 1e11 ? ts : ts * 1000);
  };

  const refDateObj = referenceDate || toDate(bars[0].timestamp);
  const sessionDateStr = getExchangeDateStr(market, refDateObj);

  const orbCandles: { high: number; low: number; close: number; dateObj: Date }[] = [];
  const postOrbCandles: { high: number; low: number; close: number; dateObj: Date }[] = [];

  for (const b of bars) {
    if (b.high == null || b.low == null || b.high <= 0 || b.low <= 0) continue;
    const d = toDate(b.timestamp);
    const mt = getMarketTime(market, d);
    if (mt.dateFormatted !== sessionDateStr) continue;
    const startMin = mt.totalMinutes;
    if (startMin >= openM && startMin < orbEndM) {
      orbCandles.push({ high: b.high, low: b.low, close: b.close, dateObj: d });
    } else if (startMin >= orbEndM) {
      postOrbCandles.push({ high: b.high, low: b.low, close: b.close, dateObj: d });
    }
  }

  if (orbCandles.length === 0) {
    return { orbHigh: null, orbLow: null, triggerLevel: null, stopLossLevel: null, firstBreakoutTime: null };
  }

  const orbHigh = +Math.max(...orbCandles.map((c) => c.high)).toFixed(6);
  const orbLow = +Math.min(...orbCandles.map((c) => c.low)).toFixed(6);
  const triggerLevel = direction === 'LONG' ? orbHigh : orbLow;
  const stopLossLevel = +(
    direction === 'LONG'
      ? orbLow * (1 - TRADING_PARAMS.STOP_BUF)
      : orbHigh * (1 + TRADING_PARAMS.STOP_BUF)
  ).toFixed(6);

  let firstBreakoutTime: string | null = null;
  for (const post of postOrbCandles) {
    const brokeLong = post.high > orbHigh + TRADING_PARAMS.EPSILON;
    const brokeShort = post.low < orbLow - TRADING_PARAMS.EPSILON;
    const broke = direction === 'LONG' ? brokeLong : brokeShort;
    if (broke || brokeLong || brokeShort) {
      firstBreakoutTime = post.dateObj.toISOString();
      break;
    }
  }

  return {
    orbHigh,
    orbLow,
    triggerLevel,
    stopLossLevel,
    firstBreakoutTime,
  };
}

/**
 * Freeze manuale: T e S calcolati sulle 15 candele da 1 minuto complete precedenti l'istante del freeze.
 * Una candela da 1m è completa e appartiene ai 15m precedenti se inizio >= (t_freeze - 15m) e inizio < t_freeze.
 */
export function calculateManualFreezeLevels(
  bars1m: IntradayCandleInput[],
  freezeTime: Date,
  direction: 'LONG' | 'SHORT' = 'LONG'
): {
  orbHigh: number | null;
  orbLow: number | null;
  triggerLevel: number | null;
  stopLossLevel: number | null;
  includedBarsCount: number;
} {
  const freezeMs = freezeTime.getTime();
  const windowStartMs = freezeMs - TRADING_PARAMS.MANUAL_FREEZE_BARS_1M * 60_000;

  const toDate = (ts: number | string | Date): Date => {
    if (ts instanceof Date) return ts;
    if (typeof ts === 'string') return new Date(ts);
    return new Date(ts > 1e11 ? ts : ts * 1000);
  };

  const windowBars = bars1m.filter((b) => {
    const ms = toDate(b.timestamp).getTime();
    return ms >= windowStartMs - TRADING_PARAMS.EPSILON && ms < freezeMs - TRADING_PARAMS.EPSILON;
  });

  if (windowBars.length === 0) {
    return { orbHigh: null, orbLow: null, triggerLevel: null, stopLossLevel: null, includedBarsCount: 0 };
  }

  const maxHigh = +Math.max(...windowBars.map((b) => b.high)).toFixed(6);
  const minLow = +Math.min(...windowBars.map((b) => b.low)).toFixed(6);
  const triggerLevel = direction === 'LONG' ? maxHigh : minLow;
  const stopLossLevel = +(
    direction === 'LONG'
      ? minLow * (1 - TRADING_PARAMS.STOP_BUF)
      : maxHigh * (1 + TRADING_PARAMS.STOP_BUF)
  ).toFixed(6);

  return {
    orbHigh: maxHigh,
    orbLow: minLow,
    triggerLevel,
    stopLossLevel,
    includedBarsCount: windowBars.length,
  };
}

/**
 * Funzione pura di verifica sicurezza barriera KO (Gate G9):
 * Long: S - B_rec >= BUF_BAR * E; Short: B_rec - S >= BUF_BAR * E.
 */
export function validateBarrierSafety(
  direction: 'LONG' | 'SHORT',
  entryLevel: number,
  stopLossLevel: number,
  barrierLevel: number,
  bufBar: number = TRADING_PARAMS.BUF_BAR
): { valid: boolean; message?: string } {
  const minBuffer = bufBar * entryLevel;
  const dist = direction === 'LONG' ? stopLossLevel - barrierLevel : barrierLevel - stopLossLevel;
  if (dist + TRADING_PARAMS.EPSILON >= minBuffer) {
    return { valid: true };
  }
  return { valid: false, message: 'BARRIERA NON VALIDA' };
}

/**
 * Costruzione pura e deterministica del record TradeJournalEntry a partire dal setup (C7).
 */
export function createJournalEntryFromSetup(
  tradeData: any,
  parameters?: SystemParameters,
  now: Date = new Date()
): TradeJournalEntry {
  if (!tradeData || !tradeData.entryMode) {
    throw new Error('entryMode obbligatorio per salvare il trade nel diario: nessun valore fornito');
  }
  const t1Mult = parameters?.target1Multiplier ?? TRADING_PARAMS.T1_R;
  const initialOutcome = tradeData.outcome || 'OPEN';
  let pnlEur = tradeData.pnlEur != null ? tradeData.pnlEur : 0;
  let rMultiple = tradeData.rMultiple != null ? tradeData.rMultiple : 0;
  const baseEntry = tradeData.entryLevel ?? tradeData.triggerLevel ?? tradeData.entryPrice ?? null;
  const baseStop = tradeData.stopLossLevel ?? tradeData.stopLoss ?? null;
  const baseT1 = tradeData.target1Level ?? tradeData.target1 ?? null;
  let exitPrice = tradeData.exitPrice ?? baseT1 ?? baseEntry ?? 0;
  const status: 'OPEN' | 'CLOSED' = initialOutcome === 'OPEN' ? 'OPEN' : 'CLOSED';

  if (initialOutcome === 'WIN') {
    exitPrice = baseT1 ?? exitPrice;
    rMultiple = +t1Mult.toFixed(2);
    pnlEur = tradeData.potentialGainT1Eur != null ? tradeData.potentialGainT1Eur : +(100 * rMultiple).toFixed(2);
  } else if (initialOutcome === 'LOSS') {
    exitPrice = baseStop ?? exitPrice;
    rMultiple = -1.0;
    pnlEur = -(tradeData.maxRiskEur != null ? tradeData.maxRiskEur : 100);
  } else if (initialOutcome === 'EXPIRED' || initialOutcome === 'BREAKEVEN') {
    exitPrice = baseEntry ?? exitPrice;
    rMultiple = 0;
    pnlEur = -2.0;
  }

  const resolvedBarrier = tradeData.barrierRecommended ?? tradeData.barrierStrike ?? null;
  const resolvedLeverage = tradeData.selectedLeverage ?? tradeData.leverage ?? null;

  return {
    id: tradeData.id || `trade-${now.getTime()}`,
    timestamp: tradeData.timestamp || now.toISOString(),
    date: tradeData.date || now.toLocaleDateString('it-IT'),
    session: tradeData.session,
    market: tradeData.market || (tradeData.session === 'US' ? 'US' : 'EU'),
    ticker: tradeData.ticker,
    direction: tradeData.direction,
    strategy: tradeData.strategy,
    entryPrice: baseEntry ?? 0,
    exitPrice,
    stopLoss: baseStop ?? 0,
    target1: baseT1 ?? 0,
    pnlEur,
    rMultiple,
    outcome: initialOutcome === 'OPEN' ? 'BREAKEVEN' : initialOutcome,
    status,
    closedAt: status === 'CLOSED' ? now.toISOString() : undefined,
    notes:
      tradeData.notes ||
      (initialOutcome === 'OPEN'
        ? `KO Strike ${resolvedBarrier} | Leva ${resolvedLeverage}x | ${tradeData.suggestedCertificates ?? 0} quote. In monitoraggio attivo.`
        : initialOutcome === 'WIN'
        ? `Target 1 (+${rMultiple}R) raggiunto con successo. Guadagno netto +${pnlEur} €.`
        : initialOutcome === 'LOSS'
        ? `Stop loss eseguito a protezione del capitale. Perdita controllata ${pnlEur} €.`
        : initialOutcome === 'EXPIRED'
        ? `Setup scaduto al cutoff orario senza rottura trigger né stop.`
        : `Chiuso a pareggio.`),
    isPaper: Boolean(tradeData.isPaper),
    barrierStrike: resolvedBarrier ?? undefined,
    leverage: resolvedLeverage ?? undefined,
    suggestedCertificates: tradeData.suggestedCertificates,
    maxRiskEur: tradeData.maxRiskEur,
    potentialGainT1Eur: tradeData.potentialGainT1Eur,
    investedEur: tradeData.investedEur,
    entryMode: tradeData.entryMode,
    triggerLevel: tradeData.triggerLevel ?? baseEntry,
    entryLevel: tradeData.entryLevel ?? baseEntry,
    stopLossLevel: baseStop,
    barrierRecommended: resolvedBarrier,
    selectedLeverage: resolvedLeverage,
    gateResults: tradeData.gateResults,
  };
}

// Default Adaptive System Parameters (Sincronizzati dinamicamente con TRADING_PARAMS)
export const DEFAULT_SYSTEM_PARAMETERS: SystemParameters = {
  version: 1,
  lastUpdated: TRADING_PARAMS.LAST_MODIFIED,
  minScore: 55,
  get minScoreEurope() {
    return TRADING_PARAMS.MIN_SCORE_EU;
  },
  get minScoreUSA() {
    return TRADING_PARAMS.MIN_SCORE_US;
  },
  minGapEurope: 0.40,
  minGapUSA: 0.75,
  minRvol: 1.0,
  minRvolEurope: 0.85,
  minRvolUSA: 1.15,
  minAvgVolume: 350000,
  normalRiskMultiplier: 0.50,
  target1Multiplier: TRADING_PARAMS.T1_R,
  target2Multiplier: TRADING_PARAMS.T2_R,
  suggestedKoBarrierMultiplier: 2.65,
  triggerOffsetPercent: 0.20,
  rsiFilterActive: false,
};

// Backward-compatible alias for existing imports
export const MIN_QUALIFICATION_THRESHOLDS = {
  minScore: DEFAULT_SYSTEM_PARAMETERS.minScore,
  minGapEurope: DEFAULT_SYSTEM_PARAMETERS.minGapEurope,
  minGapUSA: DEFAULT_SYSTEM_PARAMETERS.minGapUSA,
  minRvol: DEFAULT_SYSTEM_PARAMETERS.minRvol,
  minAvgVolume: DEFAULT_SYSTEM_PARAMETERS.minAvgVolume,
};

export function calculateCandidateScore(
  quote: RawQuoteData,
  benchmarkFuturesChangePercent: number | null | undefined,
  newsOrCatalyst?: GeminiCatalystAnalysis | NewsItem[] | number | null
): ScoreBreakdown {
  const details: string[] = [];
  let gapScore = 0;
  let rvolScore = 0;
  let liquidityScore = 0;
  let futuresScore = 0;
  let levelScore = 0;
  let rsiScore = 0;

  // If essential price data is missing from exchange, candidate receives 0 score
  const price = quote.currentPrice ?? quote.preMarketPrice;
  if (price == null || price <= 0) {
    return {
      gapScore: 0,
      rvolScore: 0,
      liquidityScore: 0,
      futuresScore: 0,
      levelScore: 0,
      rsiScore: 0,
      newsScore: 0,
      trendScore: 0,
      orderFlowScore: 0,
      rawTotal: 0,
      total: 0,
      details: ['Prezzo di mercato non disponibile dal feed: candidato non qualificabile.'],
    };
  }

  let isCandidateLong = (quote.gapPercent ?? 0) >= 0;
  if (newsOrCatalyst && typeof newsOrCatalyst === 'object' && 'direzione' in newsOrCatalyst) {
    const dir = (newsOrCatalyst as GeminiCatalystAnalysis).direzione;
    if (dir === 'LONG') isCandidateLong = true;
    else if (dir === 'SHORT') isCandidateLong = false;
  }

  const eps = TRADING_PARAMS.EPSILON;

  // 1. GAP SCORE (max 25) - Normalized by Volatility (ATR-scaled Gap)
  const cIeri = quote.prevClose;
  const oOggi = quote.todayOpen ?? price;
  if (quote.atr14 != null && quote.atr14 > 0 && cIeri != null && cIeri > 0) {
    const atrPct = (quote.atr14 / cIeri) * 100;
    const calcGapPct = quote.gapPercent != null ? quote.gapPercent : ((oOggi - cIeri) / cIeri) * 100;
    const absGap = Math.abs(calcGapPct);
    const gapToAtrRatio = absGap / atrPct;

    let matchedTier = false;
    for (const tier of TRADING_PARAMS.GAP_ATR_TIERS) {
      if (gapToAtrRatio + eps >= tier.minRatio) {
        gapScore = tier.points;
        matchedTier = true;
        break;
      }
    }
    if (!matchedTier) {
      gapScore = TRADING_PARAMS.GAP_ATR_MIN_POINTS;
    }
    details.push(
      `Gap normalizzato per ATR (${gapToAtrRatio.toFixed(2)}x ATR | ${absGap.toFixed(2)}% vs ATR ${atrPct.toFixed(2)}%): +${gapScore}pt`
    );
  } else {
    gapScore = 0;
    details.push('ATR(14) o Close ieri non disponibile dal feed: 0pt (nessun punteggio per dati mancanti)');
  }

  // 2. RVOL SCORE (max 25) - Only from real volume
  if (quote.rvol != null) {
    const rvol = quote.rvol;
    let matchedRvol = false;
    for (const tier of TRADING_PARAMS.RVOL_TIERS) {
      if (rvol + eps >= tier.minRvol) {
        rvolScore = tier.points;
        matchedRvol = true;
        break;
      }
    }
    if (!matchedRvol) {
      rvolScore = TRADING_PARAMS.RVOL_MIN_POINTS;
    }
    details.push(`Relative Volume (RVOL ${rvol.toFixed(2)}x): +${rvolScore}pt`);

    if (quote.rvol20m != null) {
      if (quote.rvol20m + eps >= TRADING_PARAMS.RVOL_SPIKE_20M_THRESHOLD) {
        if (rvolScore < TRADING_PARAMS.SCORE_MAX_COMPONENTS.RVOL) {
          rvolScore = Math.min(
            TRADING_PARAMS.SCORE_MAX_COMPONENTS.RVOL,
            rvolScore + TRADING_PARAMS.RVOL_SPIKE_20M_BONUS
          );
          details.push(`🔥 Spike Volumi ultimi 20m (${quote.rvol20m.toFixed(2)}x vs media 20m): +${TRADING_PARAMS.RVOL_SPIKE_20M_BONUS}pt.`);
        } else {
          details.push(`🔥 Spike Volumi ultimi 20m (${quote.rvol20m.toFixed(2)}x vs media mobile 20m): forte afflusso istituzionale.`);
        }
      }
    }
  } else {
    rvolScore = 0;
    details.push('RVOL non disponibile: 0pt');
  }

  // 3. LIQUIDITÀ GATE G1 (Esclusa dal calcolo punteggio, 0pt)
  liquidityScore = TRADING_PARAMS.SCORE_MAX_COMPONENTS.LIQUIDITY;
  details.push('Liquidità verificata come Gate G1 (esclusa dal calcolo del punteggio, 0pt).');

  // 4. FUTURES COHERENCE (max 20)
  if (benchmarkFuturesChangePercent == null || isNaN(benchmarkFuturesChangePercent)) {
    futuresScore = TRADING_PARAMS.FUT_SCORE_MISSING;
    details.push('Dati futures benchmark non disponibili: 0pt');
  } else if (Math.abs(benchmarkFuturesChangePercent) <= TRADING_PARAMS.FUT_NEUTRAL_BAND + eps) {
    futuresScore = TRADING_PARAMS.FUT_SCORE_NEUTRAL;
    details.push(
      `Futures indice neutrali (|chg| <= ${TRADING_PARAMS.FUT_NEUTRAL_BAND}% | ${benchmarkFuturesChangePercent.toFixed(2)}%): +${futuresScore}pt`
    );
  } else {
    const isFuturesGreen = benchmarkFuturesChangePercent > TRADING_PARAMS.FUT_NEUTRAL_BAND;
    const isFuturesRed = benchmarkFuturesChangePercent < -TRADING_PARAMS.FUT_NEUTRAL_BAND;
    if ((isCandidateLong && isFuturesGreen) || (!isCandidateLong && isFuturesRed)) {
      futuresScore = TRADING_PARAMS.FUT_SCORE_ALIGNED;
      details.push(
        `Allineamento totale titolo/futures indice (${benchmarkFuturesChangePercent > 0 ? '+' : ''}${benchmarkFuturesChangePercent.toFixed(2)}%): +${futuresScore}pt`
      );
    } else {
      futuresScore = TRADING_PARAMS.FUT_SCORE_DIVERGENT;
      details.push(
        `Divergenza con futures indice (${benchmarkFuturesChangePercent > 0 ? '+' : ''}${benchmarkFuturesChangePercent.toFixed(2)}%): +${futuresScore}pt`
      );
    }
  }

  // 5. KEY LEVELS PROXIMITY (max 10) - Real yesterday High / Low
  const prevHigh = quote.prevHigh;
  const prevLow = quote.prevLow;
  const proxFactor = TRADING_PARAMS.LEVEL_PROXIMITY_FACTOR;

  if (price > 0 && prevHigh != null && prevLow != null) {
    if (isCandidateLong && price + eps >= prevHigh) {
      levelScore = 10;
      details.push(`Rottura/apertura sopra il Massimo reale di ieri (${prevHigh.toFixed(2)}): +10pt`);
    } else if (!isCandidateLong && price - eps <= prevLow) {
      levelScore = 10;
      details.push(`Rottura/apertura sotto il Minimo reale di ieri (${prevLow.toFixed(2)}): +10pt`);
    } else if (isCandidateLong && price + eps >= prevHigh * (1 - proxFactor)) {
      levelScore = 7;
      details.push(`Prezzo a ridosso del Massimo di ieri (${prevHigh.toFixed(2)}): +7pt`);
    } else if (!isCandidateLong && price - eps <= prevLow * (1 + proxFactor)) {
      levelScore = 7;
      details.push(`Prezzo a ridosso del Minimo di ieri (${prevLow.toFixed(2)}): +7pt`);
    } else {
      levelScore = 5;
      details.push(`Prezzo all'interno del range di ieri: +5pt`);
    }
  } else {
    levelScore = 0;
    details.push('Livelli High/Low ieri non disponibili: 0pt');
  }

  // 6. RSI MOMENTUM & TURBO KO QUALITY (max 10)
  const activeRsi = quote.rsi5m ?? quote.rsi14;
  const rsiTimeframe = quote.rsi5m != null ? '5m Intraday' : '1D Daily';

  if (activeRsi != null) {
    if (isCandidateLong) {
      if (activeRsi >= 46 && activeRsi <= 66) {
        rsiScore = 10;
        details.push(`RSI ${rsiTimeframe} (${activeRsi}) ottimale per Turbo Long (+10pt)`);
      } else if (activeRsi > 66 && activeRsi <= 72) {
        rsiScore = 6;
        details.push(`RSI ${rsiTimeframe} (${activeRsi}) in accelerazione (+6pt)`);
      } else if (activeRsi >= 40 && activeRsi < 46) {
        rsiScore = 5;
        details.push(`RSI ${rsiTimeframe} (${activeRsi}) neutrale (+5pt)`);
      } else if (activeRsi > 72) {
        rsiScore = 0;
        details.push(`Allerta RSI ${rsiTimeframe} in Ipercomprato (${activeRsi}) (0pt)`);
      } else {
        rsiScore = 2;
        details.push(`RSI ${rsiTimeframe} debole (${activeRsi}) (+2pt)`);
      }
    } else {
      if (activeRsi >= 34 && activeRsi <= 54) {
        rsiScore = 10;
        details.push(`RSI ${rsiTimeframe} (${activeRsi}) ottimale per Turbo Short (+10pt)`);
      } else if (activeRsi >= 28 && activeRsi < 34) {
        rsiScore = 6;
        details.push(`RSI ${rsiTimeframe} (${activeRsi}) ribassista (+6pt)`);
      } else if (activeRsi > 54 && activeRsi <= 60) {
        rsiScore = 5;
        details.push(`RSI ${rsiTimeframe} (${activeRsi}) neutrale (+5pt)`);
      } else if (activeRsi < 28) {
        rsiScore = 0;
        details.push(`Allerta RSI ${rsiTimeframe} in Ipervenduto (${activeRsi}) (0pt)`);
      } else {
        rsiScore = 2;
        details.push(`RSI ${rsiTimeframe} rialzista (${activeRsi}) (+2pt)`);
      }
    }
  } else {
    rsiScore = 0;
    details.push('RSI non disponibile dal feed: 0pt');
  }

  // 7. NEWS & CATALYST BONUS SCORE (+0 to +15pt)
  let newsScore = 0;
  if (typeof newsOrCatalyst === 'number') {
    newsScore = Math.max(0, Math.min(TRADING_PARAMS.SCORE_MAX_COMPONENTS.NEWS, newsOrCatalyst));
  } else if (newsOrCatalyst && typeof newsOrCatalyst === 'object') {
    if ('newsBonusScore' in newsOrCatalyst && typeof (newsOrCatalyst as any).newsBonusScore === 'number') {
      newsScore = (newsOrCatalyst as any).newsBonusScore;
    } else if ('catalizzatore' in newsOrCatalyst) {
      const cat = newsOrCatalyst as GeminiCatalystAnalysis;
      const text = `${cat.catalizzatore || ''} ${(cat.punti_a_favore || []).join(' ')}`.toLowerCase();
      const hasMajorEvent =
        text.includes('upgrade') ||
        text.includes('target') ||
        text.includes('contratto') ||
        text.includes('ordini') ||
        text.includes('utili') ||
        text.includes('partnership') ||
        text.includes('earnings') ||
        text.includes('guidance');
      if (hasMajorEvent) {
        newsScore = 15;
      } else if (cat.fonti && cat.fonti.length > 0) {
        newsScore = 12;
      } else if (!text.includes('nessuna notizia') && !text.includes('setup tecnico')) {
        newsScore = 8;
      } else {
        newsScore = 0;
      }
    } else if (Array.isArray(newsOrCatalyst) && newsOrCatalyst.length > 0) {
      let freshestHours = 999;
      for (const item of newsOrCatalyst) {
        if (item.publishedAt) {
          const t = new Date(item.publishedAt).getTime();
          if (!isNaN(t)) {
            const ageH = (Date.now() - t) / (1000 * 60 * 60);
            if (ageH < freshestHours) freshestHours = ageH;
          }
        }
      }
      if (freshestHours <= 4) {
        newsScore = 15;
        details.push(`🔥 Notizia Fresca (<4h): +15pt`);
      } else if (freshestHours <= 12) {
        newsScore = 10;
        details.push(`📰 Notizia Recente (<12h): +10pt`);
      } else {
        newsScore = 6;
        details.push(`📰 Notizia nota (>12h): +6pt`);
      }
    }
  }

  if (newsScore > 0 && typeof newsOrCatalyst === 'object' && newsOrCatalyst !== null && 'direzione' in newsOrCatalyst) {
    const catDir = (newsOrCatalyst as GeminiCatalystAnalysis).direzione;
    const isContrarian =
      (catDir === 'LONG' && ((quote.gapPercent ?? 0) < -0.3 || (quote.vwap != null && price != null && price < quote.vwap * (1 - proxFactor)))) ||
      (catDir === 'SHORT' && ((quote.gapPercent ?? 0) > 0.3 || (quote.vwap != null && price != null && price > quote.vwap * (1 + proxFactor))));
    if (isContrarian) {
      const reducedBonus = Math.min(3, Math.floor(newsScore * 0.25));
      details.push(`⚠️ Notizia ${catDir} in contrasto con azione di prezzo: bonus ridotto a +${reducedBonus}pt`);
      newsScore = reducedBonus;
    }
  }

  if (newsScore === 0) {
    details.push('Assenza notizie straordinarie: 0pt bonus');
  }

  // 8. CONFLUENZA TREND MACRO DAILY EMA(20) (+0 to +8pt)
  let trendScore = 0;
  if (quote.ema20Daily != null && quote.ema20Daily > 0) {
    const isAboveEma = price + eps >= quote.ema20Daily;
    if ((isCandidateLong && isAboveEma) || (!isCandidateLong && !isAboveEma)) {
      trendScore = TRADING_PARAMS.SCORE_MAX_COMPONENTS.TREND;
      details.push(`Confluenza Trend Macro EMA(20) daily (${quote.ema20Daily.toFixed(2)}): +8pt`);
    } else {
      trendScore = 2;
      details.push(`Controtendenza Macro EMA(20) daily (${quote.ema20Daily.toFixed(2)}): +2pt`);
    }
  } else {
    trendScore = 0;
    details.push('Trend Macro EMA(20) daily non disponibile: 0pt');
  }

  // 9. CONVALIDA ORDER FLOW SYNTHETIC L2 & DELTA / VPOC (-10pt a +10pt)
  let orderFlowScore = 0;
  const of = quote.orderFlow;
  const strongOfPct = TRADING_PARAMS.ORDER_FLOW_STRONG_PCT;
  const modOfPct = TRADING_PARAMS.ORDER_FLOW_MOD_PCT;
  if (of) {
    if (of.flowQuality === 'ABSORPTION_TRAP' || of.cvdTrend === 'ABSORPTION_TRAP') {
      orderFlowScore = -10;
      details.push(`⚠️ Trappola di Assorbimento Delta (-10pt)`);
    } else if (isCandidateLong) {
      if (of.buyerVolumePercent >= strongOfPct && of.cvdTrend === 'EXPANDING_UP' && of.isPriceAboveVpoc) {
        orderFlowScore = 10;
        details.push(`🔥 Order Flow Bullish Istituzionale (+10pt)`);
      } else if (of.buyerVolumePercent >= modOfPct && of.cvdTrend !== 'EXPANDING_DOWN') {
        orderFlowScore = 6;
        details.push(`Order Flow a Favore (+6pt)`);
      } else if (of.sellerVolumePercent >= strongOfPct) {
        orderFlowScore = -6;
        details.push(`Allerta Delta Contrario (-6pt)`);
      } else {
        orderFlowScore = 2;
        details.push(`Order Flow Bilanciato (+2pt)`);
      }
    } else {
      if (of.sellerVolumePercent >= strongOfPct && of.cvdTrend === 'EXPANDING_DOWN' && of.isPriceAboveVpoc === false) {
        orderFlowScore = 10;
        details.push(`🔥 Order Flow Bearish Istituzionale (+10pt)`);
      } else if (of.sellerVolumePercent >= modOfPct && of.cvdTrend !== 'EXPANDING_UP') {
        orderFlowScore = 6;
        details.push(`Order Flow a Favore (+6pt)`);
      } else if (of.buyerVolumePercent >= strongOfPct) {
        orderFlowScore = -6;
        details.push(`Allerta Delta Contrario (-6pt)`);
      } else {
        orderFlowScore = 2;
        details.push(`Order Flow Bilanciato (+2pt)`);
      }
    }
  } else {
    orderFlowScore = 0;
  }

  const rawTotal =
    gapScore +
    rvolScore +
    liquidityScore +
    futuresScore +
    levelScore +
    rsiScore +
    newsScore +
    trendScore +
    orderFlowScore;
  const total = Math.max(
    0,
    Math.min(TRADING_PARAMS.SCORE_MAX_COMPONENTS.CAPPED_MAX, Math.round(rawTotal))
  );

  return {
    gapScore,
    rvolScore,
    liquidityScore,
    futuresScore,
    levelScore,
    rsiScore,
    newsScore,
    trendScore,
    orderFlowScore,
    rawTotal: +rawTotal.toFixed(1),
    total,
    details,
  };
}

export interface ScreeningFilterOptions {
  rsiFilterActive?: boolean;
  parameters?: SystemParameters;
  catalystCache?: Record<string, GeminiCatalystAnalysis>;
  newsCache?: Record<string, NewsItem[]>;
}

export function isRsiExtreme(rsi: number | null | undefined): boolean {
  if (rsi == null) return false;
  return rsi >= 70 || rsi <= 30;
}

export function calculateRsiFromPrices(closes: number[], period: number = 14): number | null {
  if (!closes || closes.length < 6) return null;
  const p = Math.min(period, closes.length - 1);
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= p; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / p;
  let avgLoss = losses / p;

  for (let i = p + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(1);
}

export function isCandidateCompliantWithParameters(
  quote: RawQuoteData,
  score: number,
  params: SystemParameters,
  isRsiFilterActive: boolean
): { compliant: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const price = quote.currentPrice ?? quote.preMarketPrice;
  if (price == null || price <= 0) reasons.push('Prezzo non disponibile');
  if (quote.atr14 == null || quote.atr14 <= 0) reasons.push('ATR(14) non calcolabile');
  if (quote.liqEur20d != null && quote.liqEur20d + TRADING_PARAMS.EPSILON < TRADING_PARAMS.LIQ_MIN_EUR) {
    reasons.push('LIQUIDITÀ INSUFFICIENTE');
  }

  const isEU = quote.market === 'EU';
  const minScore = isEU
    ? (params?.minScoreEurope ?? params?.minScore ?? TRADING_PARAMS.MIN_SCORE_EU)
    : (params?.minScoreUSA ?? params?.minScore ?? TRADING_PARAMS.MIN_SCORE_US);
  const minRvol = isEU
    ? (params?.minRvolEurope ?? params?.minRvol ?? 0.85)
    : (params?.minRvolUSA ?? params?.minRvol ?? 1.15);
  const minGap = isEU ? params.minGapEurope : params.minGapUSA;

  if (score + TRADING_PARAMS.EPSILON < minScore) {
    reasons.push(`Score ${score}/100 < ${minScore}/100 (${isEU ? 'EU' : 'US'})`);
  }
  const rvol = quote.rvol != null ? quote.rvol : 1.0;
  if (rvol < minRvol) {
    reasons.push(`RVOL ${rvol.toFixed(2)}x < ${minRvol}x (${isEU ? 'EU' : 'US'})`);
  }
  const absGap = Math.abs(quote.gapPercent ?? 0);
  if (absGap < minGap) {
    reasons.push(`Gap ${(quote.gapPercent ?? 0).toFixed(2)}% < ±${minGap}%`);
  }
  const rsi = quote.rsi5m ?? quote.rsi14;
  if (isRsiFilterActive && isRsiExtreme(rsi)) {
    reasons.push(`RSI estremo (${rsi})`);
  }

  return { compliant: reasons.length === 0, reasons };
}

export function rankMarketCandidates(
  quotes: RawQuoteData[],
  market: 'EU' | 'US',
  futuresChange: number | { EU: number; US: number },
  options?: ScreeningFilterOptions
): ScoredCandidate[] {
  let marketQuotes = quotes.filter((q) => q.market === market);

  // If RSI filter is active (from options or parameters), exclude overbought (RSI >= 70) and oversold (RSI <= 30)
  const isRsiActive = options?.rsiFilterActive ?? options?.parameters?.rsiFilterActive ?? false;
  if (isRsiActive) {
    marketQuotes = marketQuotes.filter((q) => !isRsiExtreme(q.rsi5m ?? q.rsi14));
  }

  const change =
    typeof futuresChange === 'number'
      ? futuresChange
      : market === 'US'
      ? futuresChange.US
      : futuresChange.EU;

  const scored = marketQuotes.map((quote) => {
    const catalystOrNews = options?.catalystCache?.[quote.ticker] || options?.newsCache?.[quote.ticker];
    return {
      quote,
      score: calculateCandidateScore(quote, change, catalystOrNews),
      rank: 0,
    };
  });

  scored.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    const rawB = b.score.rawTotal ?? b.score.total;
    const rawA = a.score.rawTotal ?? a.score.total;
    if (rawB !== rawA) return rawB - rawA;
    const rvolB = b.quote.rvol ?? 0;
    const rvolA = a.quote.rvol ?? 0;
    if (rvolB !== rvolA) return rvolB - rvolA;
    return Math.abs(b.quote.gapPercent ?? 0) - Math.abs(a.quote.gapPercent ?? 0);
  });

  return scored.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

export function rankTopCandidates(
  quotes: RawQuoteData[],
  futuresChange: number | { EU: number; US: number },
  options?: ScreeningFilterOptions
): ScoredCandidate[] {
  let targetQuotes = quotes;
  const isRsiActive = options?.rsiFilterActive ?? options?.parameters?.rsiFilterActive ?? false;
  if (isRsiActive) {
    targetQuotes = targetQuotes.filter((q) => !isRsiExtreme(q.rsi5m ?? q.rsi14));
  }

  const scored = targetQuotes.map((quote) => {
    const change =
      typeof futuresChange === 'number'
        ? futuresChange
        : quote.market === 'US'
        ? futuresChange.US
        : futuresChange.EU;
    const catalystOrNews = options?.catalystCache?.[quote.ticker] || options?.newsCache?.[quote.ticker];
    return {
      quote,
      score: calculateCandidateScore(quote, change, catalystOrNews),
      rank: 0,
    };
  });

  scored.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    const rawB = b.score.rawTotal ?? b.score.total;
    const rawA = a.score.rawTotal ?? a.score.total;
    if (rawB !== rawA) return rawB - rawA;
    const rvolB = b.quote.rvol ?? 0;
    const rvolA = a.quote.rvol ?? 0;
    if (rvolB !== rvolA) return rvolB - rvolA;
    return Math.abs(b.quote.gapPercent ?? 0) - Math.abs(a.quote.gapPercent ?? 0);
  });

  return scored.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

export function getDualTopCandidates(
  quotes: RawQuoteData[],
  futuresChange: number | { EU: number; US: number },
  options?: ScreeningFilterOptions
): {
  topEU: ScoredCandidate | null;
  topUS: ScoredCandidate | null;
  rankedEU: ScoredCandidate[];
  rankedUS: ScoredCandidate[];
  allRanked: ScoredCandidate[];
} {
  const rankedEU = rankMarketCandidates(quotes, 'EU', futuresChange, options);
  const rankedUS = rankMarketCandidates(quotes, 'US', futuresChange, options);
  const allRanked = rankTopCandidates(quotes, futuresChange, options);

  const params = options?.parameters;
  const isRsiActive = options?.rsiFilterActive ?? options?.parameters?.rsiFilterActive ?? false;

  // Select top candidates that fully comply with active parameters (qualified)
  let topEU: ScoredCandidate | null = null;
  if (params && rankedEU.length > 0) {
    topEU = rankedEU.find((cand) => {
      const check = isCandidateCompliantWithParameters(cand.quote, cand.score.total, params, isRsiActive);
      return check.compliant;
    }) || null;
  }
  // Fallback to highest scored EU candidate if none passes all filters
  if (!topEU && rankedEU.length > 0) {
    topEU = rankedEU[0];
  }

  let topUS: ScoredCandidate | null = null;
  if (params && rankedUS.length > 0) {
    topUS = rankedUS.find((cand) => {
      const check = isCandidateCompliantWithParameters(cand.quote, cand.score.total, params, isRsiActive);
      return check.compliant;
    }) || null;
  }
  // Fallback to highest scored US candidate if none passes all filters
  if (!topUS && rankedUS.length > 0) {
    topUS = rankedUS[0];
  }

  return {
    topEU,
    topUS,
    rankedEU,
    rankedUS,
    allRanked,
  };
}

export function getOrbPhaseInfo(
  market: 'EU' | 'US',
  currentTime?: Date
): {
  phase: 'PRE_MARKET_MONITORING' | 'ORB_15M_FORMATION' | 'ACTIVE_BREAKOUT' | 'CUTOFF_PASSED';
  label: string;
  description: string;
  isEntryAllowed: boolean;
} {
  const mTime = getMarketTime(market, currentTime);
  const cutoffMinutes = 11 * 60 + 30; // 11:30 local exchange time

  if (mTime.isOrbWindow) {
    return {
      phase: 'ORB_15M_FORMATION',
      label: `Fase 1: Formazione Range 15m (${mTime.orbCloseFormatted})`,
      description: `Prime 3 candele 5m in formazione. Non anticipare: attendere range consolidato alle ${mTime.orbCloseFormatted}.`,
      isEntryAllowed: false,
    };
  } else if (mTime.isBeforeOrb) {
    return {
      phase: 'PRE_MARKET_MONITORING',
      label: `Fase 0: Pre-Market ${market}`,
      description: `Monitoraggio book e volumi pre-apertura ${market}. Attendere apertura e consolidamento ORB.`,
      isEntryAllowed: false,
    };
  } else if (mTime.totalMinutes < cutoffMinutes) {
    return {
      phase: 'ACTIVE_BREAKOUT',
      label: 'Fase 2: Finestra Operativa Attiva',
      description: 'Range 15m consolidato. Esecuzione autorizzata alla rottura confermata del trigger con volumi.',
      isEntryAllowed: true,
    };
  } else {
    return {
      phase: 'CUTOFF_PASSED',
      label: `Cutoff Raggiunto (11:30 ${market === 'US' ? 'NY' : 'Rome'})`,
      description: 'Finestra primaria conclusa. Rischio di contrazione volumi pomeridiana.',
      isEntryAllowed: false,
    };
  }
}

export function getMacroBlackoutStatus(): {
  isBlackoutActive: boolean;
  label: string;
  description: string;
} {
  const now = new Date();
  const cetFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = cetFormatter.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  const currentMinutes = hour * 60 + minute;

  // Window 1: 14:15 - 14:45 CET (US Macro Data: CPI, NFP, Retail Sales at 14:30 CET)
  if (currentMinutes >= 14 * 60 + 15 && currentMinutes <= 14 * 60 + 45) {
    return {
      isBlackoutActive: true,
      label: 'Blackout Macro Imminente (14:15 - 14:45 CET)',
      description: 'Finestra rilascio dati macro USA (ore 14:30 CET). Spike e allargamento spread broker: astenersi da nuovi ingressi a ridosso del dato.',
    };
  }

  // Window 2: 19:45 - 20:30 CET (FOMC Fed Decision at 20:00 CET)
  if (currentMinutes >= 19 * 60 + 45 && currentMinutes <= 20 * 60 + 30) {
    return {
      isBlackoutActive: true,
      label: 'Blackout Decisione Tassi Fed (19:45 - 20:30 CET)',
      description: 'Annuncio tassi e conferenza stampa Fed: volatilità estrema a due vie. Proteggere le posizioni aperte.',
    };
  }

  return {
    isBlackoutActive: false,
    label: 'Nessun Blackout Macro Imminente',
    description: 'Nessun rilascio macro primario nell\'immediato. Flusso di mercato regolare.',
  };
}

export function getOvernightCountdownStatus(market: 'EU' | 'US'): {
  isCloseImminent: boolean;
  label: string;
  description: string;
} {
  const now = new Date();
  const cetFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = cetFormatter.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  const currentMinutes = hour * 60 + minute;

  if (market === 'EU') {
    if (currentMinutes >= 17 * 60 && currentMinutes <= 17 * 60 + 35) {
      return {
        isCloseImminent: true,
        label: 'Chiusura Imminente Seduta Europa (17:30 CET)',
        description: 'Regola ferrea anti-overnight: liquidare qualsiasi certificato Turbo prima del settlement. Vietato mantenere leva notturna.',
      };
    }
  } else {
    if (currentMinutes >= 21 * 60 + 30 && currentMinutes <= 22 * 60 + 5) {
      return {
        isCloseImminent: true,
        label: 'Chiusura Imminente Wall Street (22:00 CET)',
        description: 'Campanella di chiusura USA alle 22:00 CET: monetizzare qualsiasi quota residua. Prevenzione gap notturno.',
      };
    }
  }

  return {
    isCloseImminent: false,
    label: 'Finestra Regolare',
    description: 'Seduta attiva senza allerta di chiusura immediata.',
  };
}

export function calculateInitialBalance(quote: RawQuoteData, market: 'EU' | 'US'): {
  isFormed: boolean;
  high: number;
  low: number;
  status: 'TREND_EXPANSION' | 'RANGE_ROTATION' | 'FORMING';
  label: string;
} {
  const now = new Date();
  const cetFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = cetFormatter.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  const currentMinutes = hour * 60 + minute;

  const isFormed = market === 'EU' ? currentMinutes >= 9 * 60 + 30 : currentMinutes >= 16 * 60;
  const price = quote.preMarketPrice ?? quote.currentPrice ?? 0;
  const high = quote.todayHigh ?? 0;
  const low = quote.todayLow ?? 0;

  if (!isFormed) {
    return {
      isFormed: false,
      high,
      low,
      status: 'FORMING',
      label: `Formazione Initial Balance 30m in corso (chiusura ore ${market === 'EU' ? '09:30' : '16:00'} CET)`,
    };
  }

  if (price > high) {
    return {
      isFormed: true,
      high,
      low,
      status: 'TREND_EXPANSION',
      label: `Espansione sopra Initial Balance High (${high.toFixed(2)}) - Trend Day`,
    };
  } else if (price < low) {
    return {
      isFormed: true,
      high,
      low,
      status: 'TREND_EXPANSION',
      label: `Espansione sotto Initial Balance Low (${low.toFixed(2)}) - Trend Day`,
    };
  } else {
    return {
      isFormed: true,
      high,
      low,
      status: 'RANGE_ROTATION',
      label: `Rotazione all'interno dell'Initial Balance 30m [${low.toFixed(2)} - ${high.toFixed(2)}]`,
    };
  }
}

export function calculateAdrInfo(quote: RawQuoteData): {
  consumptionPct: number;
  remainingPct: number;
  status: 'OPTIMAL' | 'MODERATE' | 'EXHAUSTED';
  description: string;
} | null {
  const adr = quote.adr14;
  const high = quote.todayHigh;
  const low = quote.todayLow;

  // Zero default su dati mancanti: se ADR14 o High/Low di oggi non sono disponibili, restituisce null
  if (adr == null || adr <= 0 || high == null || low == null || high < low) {
    return null;
  }

  const sessionRange = high - low;
  const consumptionPct = +Math.min(100, (sessionRange / adr) * 100).toFixed(1);
  const remainingPct = +Math.max(0, 100 - consumptionPct).toFixed(1);

  if (consumptionPct <= TRADING_PARAMS.ADR_OPTIMAL_MAX_PCT) {
    return {
      consumptionPct,
      remainingPct,
      status: 'OPTIMAL',
      description: `Spazio ADR Residuo (${remainingPct}%): eccellente capacità di espansione verso i target.`,
    };
  } else if (consumptionPct <= TRADING_PARAMS.ADR_MAX * 100) {
    return {
      consumptionPct,
      remainingPct,
      status: 'MODERATE',
      description: `Spazio ADR Intermedio (${remainingPct}%): estensione discreta, preferire primo take-profit a T1.`,
    };
  } else {
    return {
      consumptionPct,
      remainingPct,
      status: 'EXHAUSTED',
      description: `Range ADR Prossimo a Esaurimento (${consumptionPct}% consumato): alto rischio di consolidamento/fade.`,
    };
  }
}

export function buildExecutionSetup(
  topCandidate: ScoredCandidate | null,
  catalyst: GeminiCatalystAnalysis | null,
  session: 'EU' | 'US' | 'GLOBAL',
  params?: SystemParameters,
  options?: {
    entryMode?: EntryMode | null;
    currentTime?: Date;
    customLeve?: readonly number[];
  }
): ExecutionSetup {
  const currentTime = options?.currentTime || new Date();

  const cutoffTime =
    topCandidate?.quote?.market === 'US'
      ? '11:30 NY'
      : topCandidate?.quote?.market === 'EU'
      ? '11:30 Rome'
      : session === 'US'
      ? '11:30 NY'
      : '11:30 Rome';

  if (!topCandidate) {
    return {
      candidate: {} as RawQuoteData,
      decision: 'NESSUN_TRADE',
      reasonNoTrade: 'Nessun titolo presente o analizzato per la sessione.',
      direction: 'NESSUNA',
      strategy: 'Nessun setup',
      triggerLevel: null,
      entryLevel: null,
      vwapCondition: 'N/A',
      volumeCondition: 'N/A',
      stopLossLevel: null,
      target1Level: null,
      target2Level: null,
      riskRewardRatio: null,
      invalidationConditions: ['Nessun titolo idoneo'],
      cutoffTime,
      catalystAnalysis: null,
      dynamicBreakeven: null,
      certificateNote: 'Certificato: scelta manuale',
      calculatedAt: currentTime.toISOString(),
    };
  }

  const quote = topCandidate.quote;
  const score = topCandidate.score.total;
  const rawPrice = quote.currentPrice ?? quote.preMarketPrice ?? null;
  const price = rawPrice ?? 0;
  const marketType = (quote.market || (session === 'US' ? 'US' : 'EU')) as 'EU' | 'US';
  const isEU = marketType === 'EU';
  const eps = TRADING_PARAMS.EPSILON;

  const isGapLong = quote.gapPercent != null ? quote.gapPercent >= 0 : true;
  const direction: 'LONG' | 'SHORT' =
    catalyst?.direzione === 'SHORT'
      ? 'SHORT'
      : catalyst?.direzione === 'LONG'
      ? 'LONG'
      : isGapLong
      ? 'LONG'
      : 'SHORT';

  // 1. Definition of Trigger T and Entry E
  // Long: T = max ORB, Short: T = min ORB. E = T
  const orbHigh = quote.orbHigh ?? null;
  const orbLow = quote.orbLow ?? null;
  const triggerLevel =
    quote.T != null
      ? quote.T
      : orbHigh != null && orbLow != null
      ? direction === 'LONG'
        ? orbHigh
        : orbLow
      : price;
  const entryLevel = quote.E != null ? quote.E : triggerLevel;

  // 2. Stop Loss S
  // Long: S = min ORB * (1 - STOP_BUF); Short: S = max ORB * (1 + STOP_BUF)
  const stopLossLevel =
    quote.S != null
      ? quote.S
      : orbHigh != null && orbLow != null
      ? +(
          direction === 'LONG'
            ? orbLow * (1 - TRADING_PARAMS.STOP_BUF)
            : orbHigh * (1 + TRADING_PARAMS.STOP_BUF)
        ).toFixed(6)
      : +(
          direction === 'LONG'
            ? price * (1 - TRADING_PARAMS.STOP_BUF)
            : price * (1 + TRADING_PARAMS.STOP_BUF)
        ).toFixed(6);

  // 3. Stop Distance fraction dS = |E - S| / E
  const dS = entryLevel > 0 ? Math.abs(entryLevel - stopLossLevel) / entryLevel : 0;
  const stopDistancePct = +(dS * 100).toFixed(4);

  // 4. Leverage Selection L_sel = max{ L ∈ LEVE : dS × L ≤ LMAX e 1/L ≥ dS + BUF_BAR }
  const leveGrid = options?.customLeve ?? TRADING_PARAMS.LEVE;
  const eligibleLevers = leveGrid.filter(
    (l) => dS * l <= TRADING_PARAMS.LMAX + eps && 1 / l + eps >= dS + TRADING_PARAMS.BUF_BAR
  );
  const selectedLeverage = eligibleLevers.length > 0 ? Math.max(...eligibleLevers) : null;
  const prudentLeverage = eligibleLevers.length > 0 ? Math.min(...eligibleLevers) : null;

  // 5. Recommended KO Barrier B_rec & Prudent Barrier
  // Long: B_rec = E × (1 − 1/L_sel). Short: B_rec = E × (1 + 1/L_sel).
  const computedBarrierRec =
    selectedLeverage != null
      ? +(
          direction === 'LONG'
            ? entryLevel * (1 - 1 / selectedLeverage)
            : entryLevel * (1 + 1 / selectedLeverage)
        ).toFixed(2)
      : null;
  const barrierRecommended = computedBarrierRec;

  const prudentBarrier =
    prudentLeverage != null
      ? +(
          direction === 'LONG'
            ? entryLevel * (1 - 1 / prudentLeverage)
            : entryLevel * (1 + 1 / prudentLeverage)
        ).toFixed(2)
      : null;

  const estimatedStopLossPct =
    selectedLeverage != null ? +(dS * selectedLeverage * 100).toFixed(2) : null;

  // 6. Targets T1 and T2
  // R = |E - S|; T1 = E +/- T1_R * R; T2 = E +/- T2_R * R
  const riskDist = Math.abs(entryLevel - stopLossLevel);
  const t1Multiplier = params?.target1Multiplier ?? TRADING_PARAMS.T1_R;
  const t2Multiplier = params?.target2Multiplier ?? TRADING_PARAMS.T2_R;
  const target1Level = +(
    direction === 'LONG'
      ? entryLevel + t1Multiplier * riskDist
      : entryLevel - t1Multiplier * riskDist
  ).toFixed(4);
  const target2Level = +(
    direction === 'LONG'
      ? entryLevel + t2Multiplier * riskDist
      : entryLevel - t2Multiplier * riskDist
  ).toFixed(4);

  // 7. Consumo ADR and Estensione
  const highToday = quote.todayHigh;
  const lowToday = quote.todayLow;
  const adrConsumptionFraction =
    quote.adr14 != null &&
    quote.adr14 > 0 &&
    highToday != null &&
    lowToday != null &&
    highToday >= lowToday
      ? (highToday - lowToday) / quote.adr14
      : null;
  const adrConsumptionPct =
    adrConsumptionFraction != null ? +(adrConsumptionFraction * 100).toFixed(1) : null;

  const extensionFraction =
    entryLevel > 0
      ? direction === 'LONG'
        ? (price - entryLevel) / entryLevel
        : (entryLevel - price) / entryLevel
      : 0;
  const extensionPct = +(extensionFraction * 100).toFixed(2);

  const Tb = quote.orbBreakoutTime || null;
  const marketTime = getMarketTime(marketType, currentTime);

  // 8. Evaluation of Gates G1 to G11 in exact sequence
  const gateResults: Record<string, { passed: boolean; label: string; message?: string }> = {};

  // G1 Liquidità: Liq€ < LIQ_MIN_EUR → LIQUIDITÀ INSUFFICIENTE
  // Se mancano le 20 barre complete o Liq€ è assente, cade in G2 (DATI INSUFFICIENTI), non in G1.
  const liqEur = quote.liqEur20d ?? null;
  const hasInsufficientBarsForLiq =
    quote.completedBarsCount != null &&
    quote.completedBarsCount < TRADING_PARAMS.LIQ_BARS_REQUIRED;
  const g1Pass =
    liqEur == null || hasInsufficientBarsForLiq
      ? true
      : liqEur + eps >= TRADING_PARAMS.LIQ_MIN_EUR;
  gateResults['G1'] = {
    passed: g1Pass,
    label: 'Liquidità',
    message: g1Pass ? undefined : 'LIQUIDITÀ INSUFFICIENTE',
  };

  // G2 Dati: manca ORB, ATR14, ADR14, C_ieri, volume, prezzo, gap, o barre complete insufficienti → DATI INSUFFICIENTI
  const g2Pass =
    !hasInsufficientBarsForLiq &&
    orbHigh != null &&
    orbLow != null &&
    rawPrice != null &&
    rawPrice > 0 &&
    quote.gapPercent != null &&
    quote.atr14 != null &&
    quote.atr14 > 0 &&
    quote.adr14 != null &&
    quote.adr14 > 0 &&
    quote.prevClose != null &&
    quote.prevClose > 0 &&
    quote.avgVolume20d != null &&
    quote.avgVolume20d > 0 &&
    liqEur != null &&
    liqEur > 0;
  gateResults['G2'] = {
    passed: g2Pass,
    label: 'Dati',
    message: g2Pass ? undefined : 'DATI INSUFFICIENTI',
  };

  // G3 Orario: t < chiusura ORB → ATTENDERE CHIUSURA ORB
  const g3Pass = !marketTime.isBeforeOrb;
  gateResults['G3'] = {
    passed: g3Pass,
    label: 'Orario ORB',
    message: g3Pass ? undefined : 'ATTENDERE CHIUSURA ORB',
  };

  // G4 Estensione: Estensione(t) > EST_MAX → TRIGGER GIÀ SUPERATO
  const g4Pass = extensionFraction <= TRADING_PARAMS.EST_MAX + eps;
  gateResults['G4'] = {
    passed: g4Pass,
    label: 'Estensione',
    message: g4Pass ? undefined : 'TRIGGER GIÀ SUPERATO',
  };

  // G5 Freschezza: Tb esiste e (t − Tb) > FRESH_MIN minuti → TRIGGER SCADUTO
  let g5Pass = true;
  if (Tb != null) {
    const diffMin = (currentTime.getTime() - new Date(Tb).getTime()) / 60000;
    if (diffMin > TRADING_PARAMS.FRESH_MIN + eps) {
      g5Pass = false;
    }
  }
  gateResults['G5'] = {
    passed: g5Pass,
    label: 'Freschezza',
    message: g5Pass ? undefined : 'TRIGGER SCADUTO',
  };

  // G6 Target: H_sess(t) >= T1 (long) o L_sess(t) <= T1 (short) → T1 RAGGIUNTO
  const g6Pass =
    direction === 'LONG'
      ? !(highToday != null && highToday + eps >= target1Level)
      : !(lowToday != null && lowToday - eps <= target1Level);
  gateResults['G6'] = {
    passed: g6Pass,
    label: 'Target',
    message: g6Pass ? undefined : 'T1 RAGGIUNTO',
  };

  // G7 ADR: Consumo_ADR(t) > ADR_MAX → RANGE ESAURITO
  const g7Pass =
    adrConsumptionFraction != null && adrConsumptionFraction <= TRADING_PARAMS.ADR_MAX + eps;
  gateResults['G7'] = {
    passed: g7Pass,
    label: 'ADR',
    message: g7Pass ? undefined : 'RANGE ESAURITO',
  };

  // G8 Stop distanza: dS > LMAX / min(LEVE) → STOP TROPPO LONTANO
  const minLeva = Math.min(...TRADING_PARAMS.LEVE);
  const g8Pass = dS <= TRADING_PARAMS.LMAX / minLeva + eps;
  gateResults['G8'] = {
    passed: g8Pass,
    label: 'Stop distanza',
    message: g8Pass ? undefined : 'STOP TROPPO LONTANO',
  };

  // G9 Leva e barriera:
  // L_sel = max{ L in LEVE : dS × L <= LMAX e 1/L >= dS + BUF_BAR }. Se vuoto → LEVA NON COMPATIBILE.
  // Controllo: long S − B_rec >= BUF_BAR × E; short B_rec − S >= BUF_BAR × E; altrimenti → BARRIERA NON VALIDA.
  let g9Pass = false;
  let g9Message: string | undefined = undefined;
  if (selectedLeverage == null || barrierRecommended == null) {
    g9Pass = false;
    g9Message = 'LEVA NON COMPATIBILE';
  } else {
    const barrierCheck = validateBarrierSafety(
      direction,
      entryLevel,
      stopLossLevel,
      barrierRecommended,
      TRADING_PARAMS.BUF_BAR
    );
    g9Pass = barrierCheck.valid;
    g9Message = barrierCheck.message;
  }
  gateResults['G9'] = {
    passed: g9Pass,
    label: 'Leva e barriera',
    message: g9Message,
  };

  // G10 Stop già toccato: P_t <= S (long) o P_t >= S (short) → STOP GIÀ RAGGIUNTO. Usa solo P_t.
  const g10Pass =
    direction === 'LONG' ? price > stopLossLevel + eps : price < stopLossLevel - eps;
  gateResults['G10'] = {
    passed: g10Pass,
    label: 'Stop già toccato',
    message: g10Pass ? undefined : 'STOP GIÀ RAGGIUNTO',
  };

  // G11 Score: score senza liquidità < minScore → PUNTEGGIO SOTTO SOGLIA
  const minScore = isEU
    ? (params?.minScoreEurope ?? params?.minScore ?? TRADING_PARAMS.MIN_SCORE_EU)
    : (params?.minScoreUSA ?? params?.minScore ?? TRADING_PARAMS.MIN_SCORE_US);
  const g11Pass = score + eps >= minScore;
  gateResults['G11'] = {
    passed: g11Pass,
    label: 'Score',
    message: g11Pass ? undefined : 'PUNTEGGIO SOTTO SOGLIA',
  };

  const gateKeys = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11'];
  const firstFailedKey = gateKeys.find((k) => !gateResults[k].passed);

  const decision: 'TRADE' | 'NESSUN_TRADE' = firstFailedKey ? 'NESSUN_TRADE' : 'TRADE';
  const reasonNoTrade = firstFailedKey ? gateResults[firstFailedKey].message : undefined;
  const blockedGate = firstFailedKey || null;

  const orbPhase = getOrbPhaseInfo(marketType, currentTime);
  const adrInfo = calculateAdrInfo(quote);
  const macroBlackout = getMacroBlackoutStatus();
  const overnightWarning = getOvernightCountdownStatus(marketType);
  const initialBalance = calculateInitialBalance(quote, marketType);

  const vwapCondition =
    direction === 'LONG'
      ? 'Prezzo stabilmente SOPRA il riferimento intraday dal minuto 5.'
      : 'Prezzo stabilmente SOTTO il riferimento intraday dal minuto 5.';

  const volumeCondition =
    direction === 'LONG'
      ? 'Volume sulla candela di breakout almeno 1.5x rispetto al volume medio delle prime candele a 1 minuto.'
      : 'Volume vendite in accelerazione al test del breakdown con spread bid/ask compatto.';

  const invalidationConditions = [
    `Rottura e chiusura oltre lo Stop Loss sul sottostante a ${stopLossLevel} ${quote.currency}`,
    `Superamento dell'orario limite di permanenza (${cutoffTime}) senza raggiungimento del Target 1`,
    ...(quote.orderFlow?.flowQuality === 'ABSORPTION_TRAP'
      ? ['Allerta Order Flow: Trappola di Assorbimento Delta attiva (divergenza prezzo/CVD - rischio fakeout)']
      : []),
    ...(catalyst?.condizioni_invalidazione || []),
  ];

  return {
    candidate: quote,
    decision,
    reasonNoTrade,
    blockedGate,
    gateResults,
    direction,
    strategy: 'Opening Range Breakout (5m / 15m)',
    triggerLevel,
    entryLevel,
    vwapCondition,
    volumeCondition,
    stopLossLevel,
    stopLossTight: stopLossLevel,
    stopLossConservative: stopLossLevel,
    suggestedKoBarrier: barrierRecommended,
    selectedLeverage,
    barrierRecommended,
    estimatedStopLossPct,
    prudentLeverage,
    prudentBarrier,
    certificateNote: 'Certificato: scelta manuale',
    calculatedAt: currentTime.toISOString(),
    stopDistancePct,
    extensionPct,
    adrConsumptionPct,
    entryMode: options?.entryMode ?? null,
    firstBreakoutTime: Tb,
    atrValue: quote.atr14,
    atrPercent: quote.atr14 && price > 0 ? +((quote.atr14 / price) * 100).toFixed(2) : null,
    marketType,
    target1Level,
    target2Level,
    riskRewardRatio: t1Multiplier,
    invalidationConditions,
    cutoffTime,
    catalystAnalysis: catalyst,
    dynamicBreakeven: null,
    orbPhase,
    macroTrendAlignment: {
      ema20Daily: quote.ema20Daily,
      isAligned:
        quote.ema20Daily != null
          ? direction === 'LONG'
            ? price >= quote.ema20Daily
            : price <= quote.ema20Daily
          : true,
      label:
        quote.ema20Daily != null
          ? (direction === 'LONG' ? price >= quote.ema20Daily : price <= quote.ema20Daily)
            ? 'Allineato Macro Trend'
            : 'Controtendenza Macro'
          : 'Neutro',
    },
    adrInfo,
    initialBalance,
    macroBlackout,
    overnightWarning,
    orderFlow: quote.orderFlow ?? null,
  };
}

export function calculateDynamicBreakeven(
  entryPrice: number,
  isLong: boolean,
  leverage: number,
  certPrice: number,
  suggestedCertificates: number,
  totalInvestedEur: number,
  atr: number,
  spreadEur: number = 0.02,
  brokerFeeEur: number = 1.0
): DynamicBreakevenInfo {
  // Roundtrip broker fees (buy + sell, e.g. 1€ + 1€ in Trade Republic)
  const brokerRoundtrip = brokerFeeEur * 2;
  // Total spread cost on all certificates
  const spreadCostEur = spreadEur * suggestedCertificates;
  const totalFrictionEur = +(brokerRoundtrip + spreadCostEur).toFixed(2);

  // Capital moving on the underlying = invested in cert * leverage
  const effectiveCapitalInStock = totalInvestedEur * leverage;

  // Points on underlying needed to offset total friction
  const pointsToBreakeven =
    effectiveCapitalInStock > 0 && entryPrice > 0
      ? +((totalFrictionEur * entryPrice) / effectiveCapitalInStock).toFixed(2)
      : 0;

  const percentToBreakeven =
    entryPrice > 0 ? +((pointsToBreakeven / entryPrice) * 100).toFixed(3) : 0;

  const underlyingBreakevenPrice = isLong
    ? +(entryPrice + pointsToBreakeven).toFixed(2)
    : +(entryPrice - pointsToBreakeven).toFixed(2);

  const frictionVsAtrPercent =
    atr > 0 ? +((pointsToBreakeven / atr) * 100).toFixed(1) : 0;

  let frictionStatus: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' = 'LOW';
  if (frictionVsAtrPercent > 35) {
    frictionStatus = 'CRITICAL';
  } else if (frictionVsAtrPercent > 20) {
    frictionStatus = 'HIGH';
  } else if (frictionVsAtrPercent > 10) {
    frictionStatus = 'MODERATE';
  }

  return {
    spreadEur,
    brokerFeeEur,
    totalFrictionEur,
    underlyingBreakevenPrice,
    pointsToBreakeven,
    percentToBreakeven,
    frictionVsAtrPercent,
    frictionStatus,
  };
}

export function generatePnLScenarios(
  setup: ExecutionSetup,
  input: KnockOutCalculatorInput,
  certPrice: number,
  suggestedCertificates: number,
  totalInvestedEur: number,
  frictionEur: number,
  breakevenPoints: number,
  stopDistance: number,
  potentialLossEur: number
): PnLScenario[] {
  const entryPrice = setup.triggerLevel ?? setup.candidate.preMarketPrice ?? setup.candidate.currentPrice ?? 0;
  const isLong = setup.direction === 'LONG';
  const leverage = input.leverage || 1;
  const capital = input.accountCapital || 10000;

  const buildScenario = (
    id: string,
    label: string,
    rMultiple: number,
    targetPrice: number,
    notes: string,
    opts: { isBreakeven?: boolean; isStop?: boolean; isKnockOut?: boolean } = {}
  ): PnLScenario => {
    const rawDiff = isLong ? targetPrice - entryPrice : entryPrice - targetPrice;
    const underlyingChangePercent = entryPrice > 0 ? +((rawDiff / entryPrice) * 100).toFixed(2) : 0;

    let certEstimatedPrice: number;
    let grossPnlEur: number;
    let netPnlEur: number;

    if (opts.isKnockOut) {
      certEstimatedPrice = 0;
      grossPnlEur = -totalInvestedEur;
      netPnlEur = -totalInvestedEur;
    } else if (opts.isBreakeven) {
      certEstimatedPrice = +(certPrice + frictionEur / Math.max(1, suggestedCertificates)).toFixed(3);
      grossPnlEur = +frictionEur.toFixed(2);
      netPnlEur = 0;
    } else if (opts.isStop) {
      certEstimatedPrice = Math.max(0.01, +(certPrice * (1 + (underlyingChangePercent / 100) * leverage)).toFixed(3));
      grossPnlEur = +(suggestedCertificates * (certEstimatedPrice - certPrice)).toFixed(2);
      netPnlEur = -potentialLossEur;
    } else {
      certEstimatedPrice = Math.max(0.01, +(certPrice * (1 + (underlyingChangePercent / 100) * leverage)).toFixed(3));
      grossPnlEur = +(suggestedCertificates * (certEstimatedPrice - certPrice)).toFixed(2);
      netPnlEur = +(grossPnlEur - frictionEur).toFixed(2);
    }

    const capitalRoiPercent = +((netPnlEur / capital) * 100).toFixed(2);

    return {
      id,
      label,
      rMultiple,
      underlyingPrice: +targetPrice.toFixed(2),
      underlyingChangePercent,
      certEstimatedPrice,
      certChangePercent: +(underlyingChangePercent * leverage).toFixed(2),
      grossPnlEur,
      netPnlEur,
      capitalRoiPercent,
      notes,
      ...opts,
    };
  };

  const t2Price = setup.target2Level ?? (isLong ? entryPrice + stopDistance * TRADING_PARAMS.T2_R : entryPrice - stopDistance * TRADING_PARAMS.T2_R);
  const t1Price = setup.target1Level ?? (isLong ? entryPrice + stopDistance * TRADING_PARAMS.T1_R : entryPrice - stopDistance * TRADING_PARAMS.T1_R);
  const tHalfPrice = isLong ? entryPrice + stopDistance * 0.8 : entryPrice - stopDistance * 0.8;
  const bePrice = isLong ? entryPrice + breakevenPoints : entryPrice - breakevenPoints;
  const pullbackPrice = isLong ? entryPrice - stopDistance * 0.5 : entryPrice + stopDistance * 0.5;
  const stopPrice = setup.stopLossLevel ?? (isLong ? entryPrice - stopDistance : entryPrice + stopDistance);
  const koPrice = input.barrierStrike;

  return [
    buildScenario('t2', 'Target 2 (Trend Esteso)', TRADING_PARAMS.T2_R, t2Price, 'Massimo target intraday'),
    buildScenario('t1', 'Target 1 (Presa 70% Profitto)', TRADING_PARAMS.T1_R, t1Price, 'Target primario: chiusura parziale e stop a BE'),
    buildScenario('half', 'Pullback Favorevole (+0.8R)', 0.8, tHalfPrice, 'Scalping intermedio o gestione protettiva'),
    buildScenario('be', 'Breakeven Dinamico (0.0R Netto)', 0, bePrice, 'Sottostante necessario per assorbire spread e fee', { isBreakeven: true }),
    buildScenario('pullback', 'Drawdown Transitorio (-0.5R)', -0.5, pullbackPrice, 'Rintraccio fisiologico pre-breakout'),
    buildScenario('stop', 'Stop Loss Tecnico (-1.0R)', -1.0, stopPrice, 'Chiusura disciplinata al rischio predefinito 1%', { isStop: true }),
    buildScenario('ko', 'Stress Test Knock-Out (-100% Wipeout)', -100, koPrice, 'Liquidazione totale del certificato per gap o spike', { isKnockOut: true }),
  ];
}

export function calculateDerivativeStressReport(
  entryPrice: number,
  stopLoss: number,
  barrierStrike: number,
  stopDistance: number,
  barrierDistance: number,
  safetyRatio: number,
  isLong: boolean,
  atr: number,
  frictionVsAtrPercent: number,
  leverage: number,
  atrPercent: number | null
): DerivativeStressReport {
  const criticalReasons: string[] = [];
  const warningReasons: string[] = [];
  const passReasons: string[] = [];

  const barrierVsAtrRatio = atr > 0 ? +(barrierDistance / atr).toFixed(2) : 0;

  // 1. Strike vs Stop Loss direct conflict
  if (isLong && barrierStrike >= stopLoss) {
    criticalReasons.push(
      `Barriera strike (${barrierStrike}) superiore o uguale allo Stop Loss (${stopLoss}): il Knock-Out salta prima dello stop!`
    );
  } else if (!isLong && barrierStrike <= stopLoss) {
    criticalReasons.push(
      `Barriera strike (${barrierStrike}) inferiore o uguale allo Stop Loss (${stopLoss}): il Knock-Out salta prima dello stop!`
    );
  }

  // 2. Safety Ratio (Barrier vs Stop Distance)
  if (safetyRatio < TRADING_PARAMS.KO_SAFETY_RATIO_CRITICAL) {
    criticalReasons.push(
      `Distanza barriera critica (${safetyRatio}x vs min ${TRADING_PARAMS.KO_SAFETY_RATIO_CRITICAL}x stop): margine insufficiente contro spike di apertura.`
    );
  } else if (safetyRatio < TRADING_PARAMS.KO_SAFETY_RATIO_WARNING) {
    warningReasons.push(
      `Distanza barriera moderata (${safetyRatio}x stop): raccomandato > ${TRADING_PARAMS.KO_SAFETY_RATIO_WARNING}x per evitare flash-crash.`
    );
  } else {
    passReasons.push(`Barriera KO distante ${safetyRatio}x lo stop loss (ottimo buffer protettivo).`);
  }

  // 3. Barrier vs ATR
  if (barrierVsAtrRatio < 0.7) {
    criticalReasons.push(
      `Barriera troppo vicina rispetto all'ATR giornaliero (${barrierVsAtrRatio}x ATR vs min 0.7x): vulnerabile alla normale volatilità intraday.`
    );
  } else if (barrierVsAtrRatio < 1.1) {
    warningReasons.push(
      `Barriera entro il range medio giornaliero (${barrierVsAtrRatio}x ATR): monitorare espansione di volatilità.`
    );
  } else {
    passReasons.push(`Barriera oltre 1.1x ATR (${barrierVsAtrRatio}x ATR): eccellente isolamento da rumore statistico.`);
  }

  // 4. Friction vs ATR
  if (frictionVsAtrPercent > 35) {
    criticalReasons.push(
      `Attrito spread e commissioni eccessivo (${frictionVsAtrPercent}% dell'ATR): il trade parte con un handicap matematico proibitivo.`
    );
  } else if (frictionVsAtrPercent > 20) {
    warningReasons.push(
      `Attrito spread significativo (${frictionVsAtrPercent}% dell'ATR): raccomandato eseguire solo con spread compatto.`
    );
  } else {
    passReasons.push(`Attrito ridotto (${frictionVsAtrPercent}% dell'ATR): breakeven rapido e favorevole.`);
  }

  // 5. Excessive Leverage with high ATR
  if (leverage > 25 && (atrPercent ?? 0) > 2.5) {
    warningReasons.push(
      `Leva ${leverage}x elevata su titolo ad alta volatilità (ATR ${atrPercent}%): rischio oscillazione aggressiva.`
    );
  }

  // Calculate stress score (0 to 100)
  let score = 100;
  if (criticalReasons.length > 0) score -= 50 * criticalReasons.length;
  if (safetyRatio < 2.0) score -= 15;
  if (barrierVsAtrRatio < 1.0) score -= 15;
  if (frictionVsAtrPercent > 20) score -= 15;
  if (leverage > 25) score -= 10;
  const stressScore = Math.max(0, Math.min(100, score));

  let filterStatus: 'PASS' | 'WARNING' | 'CRITICAL_BLOCKED' = 'PASS';
  if (criticalReasons.length > 0 || stressScore < 45) {
    filterStatus = 'CRITICAL_BLOCKED';
  } else if (warningReasons.length > 0 || stressScore < 75) {
    filterStatus = 'WARNING';
  }

  const canExecute = filterStatus !== 'CRITICAL_BLOCKED';

  return {
    stressScore,
    filterStatus,
    barrierVsAtrRatio,
    barrierDistancePoints: +barrierDistance.toFixed(2),
    barrierSafetyRatio: safetyRatio,
    criticalReasons,
    warningReasons,
    passReasons,
    canExecute,
  };
}

export function calculateKnockOutSafety(
  setup: ExecutionSetup,
  input: KnockOutCalculatorInput
): KnockOutSafetyCheck {
  const entryPrice = setup.triggerLevel ?? setup.candidate.preMarketPrice ?? setup.candidate.currentPrice ?? 0;
  const stopLoss = setup.stopLossLevel ?? 0;
  const barrierStrike = input.barrierStrike;
  const isLong = setup.direction === 'LONG';
  const atr = setup.atrValue ?? setup.candidate.atr14 ?? 0;
  const spreadEur = input.spreadEur ?? 0.02;
  const brokerFeeEur = input.brokerFeeEur ?? 1.0;

  if (entryPrice <= 0 || stopLoss <= 0 || barrierStrike <= 0) {
    const emptyBreakeven: DynamicBreakevenInfo = {
      spreadEur,
      brokerFeeEur,
      totalFrictionEur: 0,
      underlyingBreakevenPrice: 0,
      pointsToBreakeven: 0,
      percentToBreakeven: 0,
      frictionVsAtrPercent: 0,
      frictionStatus: 'LOW',
    };
    const emptyStress: DerivativeStressReport = {
      stressScore: 0,
      filterStatus: 'CRITICAL_BLOCKED',
      barrierVsAtrRatio: 0,
      barrierDistancePoints: 0,
      barrierSafetyRatio: 0,
      criticalReasons: ['Livelli di ingresso, stop o barriera non disponibili.'],
      warningReasons: [],
      passReasons: [],
      canExecute: false,
    };

    return {
      entryPrice,
      stopLoss,
      barrierStrike,
      stopDistance: 0,
      barrierDistance: 0,
      safetyRatio: 0,
      isSafe: false,
      warningMessage: 'Livelli di ingresso, stop o barriera non disponibili.',
      maxRiskEur: +(input.accountCapital * (input.maxRiskPercent / 100)).toFixed(2),
      suggestedCertificates: 0,
      totalInvestedEur: 0,
      potentialLossEur: 0,
      potentialGainT1Eur: 0,
      potentialGainT2Eur: 0,
      breakeven: emptyBreakeven,
      scenarios: [],
      stressReport: emptyStress,
    };
  }

  const stopDistance = Math.abs(entryPrice - stopLoss);
  const barrierDistance = Math.abs(entryPrice - barrierStrike);

  // Safety ratio: Barrier distance vs Stop Loss distance
  const safetyRatio = stopDistance > 0 ? +(barrierDistance / stopDistance).toFixed(2) : 0;
  const isSafeBasic = safetyRatio >= 2.0 && (isLong ? barrierStrike < stopLoss : barrierStrike > stopLoss);

  // 1% Risk Position Sizing
  const maxRiskEur = +(input.accountCapital * (input.maxRiskPercent / 100)).toFixed(2);

  // Ratio / Parity and FX conversion for US stocks on European EUR brokers
  const ratio = input.ratio ?? (setup.candidate.market === 'US' ? 0.1 : 1);
  const fxRate = input.fxRateEurUsd ?? 1.08;
  const isUsStock = setup.candidate.market === 'US' || setup.candidate.currency === 'USD';

  const theoreticalCertPriceEur = isUsStock
    ? Math.max(+((barrierDistance * ratio) / fxRate).toFixed(2), 0.30)
    : Math.max(+(barrierDistance * ratio).toFixed(2), 0.50);

  // Estimate KO certificate price if not supplied
  const certPrice = input.certificatePrice && input.certificatePrice > 0
    ? input.certificatePrice
    : theoreticalCertPriceEur;

  // Estimated loss per certificate if stop triggers
  const lossRatioOnCert = stopDistance / entryPrice; // percentage drop on underlying
  const estimatedLossPerCert = certPrice * lossRatioOnCert * input.leverage;
  const validLossPerCert = Math.max(estimatedLossPerCert, 0.2);

  const suggestedCertificates = Math.max(1, Math.floor(maxRiskEur / validLossPerCert));
  const totalInvestedEur = +(suggestedCertificates * certPrice).toFixed(2);
  const potentialLossEur = Math.min(+(suggestedCertificates * validLossPerCert).toFixed(2), maxRiskEur);

  const rewardRatioT1 = setup.riskRewardRatio || TRADING_PARAMS.T1_R;
  const potentialGainT1Eur = +(potentialLossEur * rewardRatioT1).toFixed(2);
  const potentialGainT2Eur = +(potentialLossEur * TRADING_PARAMS.T2_R).toFixed(2);

  // Dynamic Breakeven calculation
  const breakeven = calculateDynamicBreakeven(
    entryPrice,
    isLong,
    input.leverage,
    certPrice,
    suggestedCertificates,
    totalInvestedEur,
    atr,
    spreadEur,
    brokerFeeEur
  );

  // Stress Report & Hybrid Filter
  const stressReport = calculateDerivativeStressReport(
    entryPrice,
    stopLoss,
    barrierStrike,
    stopDistance,
    barrierDistance,
    safetyRatio,
    isLong,
    atr,
    breakeven.frictionVsAtrPercent,
    input.leverage,
    setup.atrPercent ?? null
  );

  // Multi-scenario PnL simulation
  const scenarios = generatePnLScenarios(
    setup,
    input,
    certPrice,
    suggestedCertificates,
    totalInvestedEur,
    breakeven.totalFrictionEur,
    breakeven.pointsToBreakeven,
    stopDistance,
    potentialLossEur
  );

  let warningMessage: string | undefined;
  if (!stressReport.canExecute) {
    warningMessage = stressReport.criticalReasons.join(' | ');
  } else if (stressReport.filterStatus === 'WARNING') {
    warningMessage = stressReport.warningReasons.join(' | ');
  }

  const isSafe = stressReport.canExecute && isSafeBasic;

  return {
    entryPrice,
    stopLoss,
    barrierStrike,
    stopDistance: +stopDistance.toFixed(2),
    barrierDistance: +barrierDistance.toFixed(2),
    safetyRatio,
    isSafe,
    warningMessage,
    maxRiskEur,
    suggestedCertificates,
    totalInvestedEur,
    potentialLossEur,
    potentialGainT1Eur,
    potentialGainT2Eur,
    breakeven,
    scenarios,
    stressReport,
    ratio,
    theoreticalCertPriceEur,
  };
}

export function createDefaultSafetyCheck(
  accountCapital: number = 10000,
  maxRiskPercent: number = 1.0
): KnockOutSafetyCheck {
  return {
    entryPrice: 0,
    stopLoss: 0,
    barrierStrike: 0,
    stopDistance: 0,
    barrierDistance: 0,
    safetyRatio: 0,
    isSafe: false,
    warningMessage: 'Livelli non disponibili.',
    maxRiskEur: +(accountCapital * (maxRiskPercent / 100)).toFixed(2),
    suggestedCertificates: 0,
    totalInvestedEur: 0,
    potentialLossEur: 0,
    potentialGainT1Eur: 0,
    potentialGainT2Eur: 0,
    breakeven: {
      spreadEur: 0.02,
      brokerFeeEur: 1.0,
      totalFrictionEur: 0,
      underlyingBreakevenPrice: 0,
      pointsToBreakeven: 0,
      percentToBreakeven: 0,
      frictionVsAtrPercent: 0,
      frictionStatus: 'LOW',
    },
    scenarios: [],
    stressReport: {
      stressScore: 0,
      filterStatus: 'CRITICAL_BLOCKED',
      barrierVsAtrRatio: 0,
      barrierDistancePoints: 0,
      barrierSafetyRatio: 0,
      criticalReasons: ['Setup non attivo'],
      warningReasons: [],
      passReasons: [],
      canExecute: false,
    },
  };
}

function formatCompactNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(0) + 'k';
  return num.toString();
}

export function calculateImpliedVolatilityMetrics(
  quote: RawQuoteData | undefined | null
): ImpliedVolatilityMetrics {
  if (!quote) {
    return {
      impliedVol: 22.0,
      avg30dVol: 22.0,
      riskPremium: 0,
      riskPremiumPercent: 0,
      ivRank: 50,
      regime: 'FAIR',
      label: 'Neutro (Dati Iniziali)',
      gaugePercent: 45,
      implication: 'Dati di volatilità in caricamento dal feed di mercato.',
    };
  }

  const p = quote.preMarketPrice ?? quote.currentPrice ?? quote.prevClose ?? 100;
  const atr = quote.atr14 ?? null;

  // 1. Determine Historical 30d Average Volatility
  let avg30d = quote.historicalVolatility30d ?? null;
  if (avg30d == null || avg30d <= 0) {
    avg30d = atr != null && p > 0 ? +((atr / p) * Math.sqrt(252) * 100).toFixed(1) : 22.5;
  }
  avg30d = Math.max(8.0, Math.min(avg30d, 120.0));

  // 2. Determine Implied Volatility (IV)
  let iv = quote.impliedVolatility ?? null;
  if (iv == null || iv <= 0) {
    const rawGap = Math.abs(quote.gapPercent ?? 0);
    const gapExp = rawGap * 1.35;
    const rvolExp = (quote.rvol ?? 1) > 1.2 ? Math.min(((quote.rvol ?? 1) - 1) * 3.5, 12) : 0;
    iv = +(avg30d * 1.05 + gapExp + rvolExp).toFixed(1);
  }
  iv = Math.max(9.0, Math.min(iv, 150.0));

  // 3. Compute Risk Premium Spread & %
  const riskPremium = +(iv - avg30d).toFixed(1);
  const riskPremiumPercent = avg30d > 0 ? +((riskPremium / avg30d) * 100).toFixed(1) : 0;

  // 4. Calculate IV Rank
  let ivRank = quote.ivRank;
  if (ivRank == null) {
    const lowerBound = avg30d * 0.75;
    const upperBound = Math.max(avg30d * 1.5, iv * 1.15);
    ivRank = Math.min(
      100,
      Math.max(0, Math.round(((iv - lowerBound) / (upperBound - lowerBound)) * 100))
    );
  }

  // 5. Gauge Position Percentage (0 to 100)
  const normalizedGauge = Math.min(
    100,
    Math.max(0, Math.round(45 + riskPremiumPercent * 1.1))
  );

  // 6. Regime classification & tactical derivatives advice
  let regime: 'COMPRESSED' | 'FAIR' | 'ELEVATED' | 'EXTREME' = 'FAIR';
  let label = 'Premio Equo / Neutro';
  let implication = '';

  if (riskPremiumPercent < -5) {
    regime = 'COMPRESSED';
    label = 'Sconto Volatilità (IV < Media 30gg)';
    implication =
      'Volatilità implicita compressa rispetto alla media 30gg. Spread del market maker sui knock-out ridotto al minimo; favorevole a espansioni direzionali repentine.';
  } else if (riskPremiumPercent <= 12) {
    regime = 'FAIR';
    label = 'Premio Equo / Bilanciato';
    implication =
      'Prezzatura in linea con la norma storica a 30 giorni. Spread equilibrato e attrito ordinario per il trading con certificati a leva intraday.';
  } else if (riskPremiumPercent <= 32) {
    regime = 'ELEVATED';
    label = 'Premio al Rischio Elevato';
    implication =
      `Premio al rischio espanso (+${riskPremiumPercent}% rispetto alla media a 30 giorni). I market maker allargano lo spread bid-ask del knock-out: gestire l'uscita a target rigorosamente.`;
  } else {
    regime = 'EXTREME';
    label = 'Rischio Estremo / Volatilità Espansa';
    implication =
      `Sovrapprezzo estremo (+${riskPremiumPercent}% vs media 30gg). Alto rischio di contrazione della volatilità (IV crush) e spread penalizzante; preferire barriere più conservative.`;
  }

  return {
    impliedVol: iv,
    avg30dVol: avg30d,
    riskPremium,
    riskPremiumPercent,
    ivRank,
    regime,
    label,
    gaugePercent: normalizedGauge,
    implication,
  };
}

/**
 * Rigorous 20-Setup Cycle Optimization Engine
 * Evaluates performance after every 20 completed setups.
 * If performance is stellar (high win rate, positive PnL, low expired), it maintains current parameters.
 * If weaknesses are detected (e.g., high expired rate, low win rate, high loss rate), it proposes concrete parameter adjustments with justification and expected benefits for user acceptance.
 */
export function evaluateSystemOptimization(
  trades: TradeJournalEntry[],
  currentParams: SystemParameters = DEFAULT_SYSTEM_PARAMETERS,
  cycleNumber?: number
): OptimizationProposal {
  // Sort trades chronologically descending to isolate the latest batch of 20 setups
  const sorted = [...trades].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  const evaluatedBatch = sorted.slice(0, 20);
  const total = evaluatedBatch.length;
  const cycle = cycleNumber || Math.max(1, Math.floor(trades.length / 20));

  const wins = evaluatedBatch.filter((t) => t.outcome === 'WIN');
  const losses = evaluatedBatch.filter((t) => t.outcome === 'LOSS');
  const breakevens = evaluatedBatch.filter((t) => t.outcome === 'BREAKEVEN');
  const expired = evaluatedBatch.filter((t) => t.outcome === 'EXPIRED');

  const winCount = wins.length;
  const lossCount = losses.length;
  const beCount = breakevens.length;
  const expiredCount = expired.length;

  const winRate = total > 0 ? +((winCount / total) * 100).toFixed(1) : 0;
  const expiredRate = total > 0 ? +((expiredCount / total) * 100).toFixed(1) : 0;
  const lossRate = total > 0 ? +((lossCount / total) * 100).toFixed(1) : 0;

  const netPnlEur = +(evaluatedBatch.reduce((acc, t) => acc + t.pnlEur, 0)).toFixed(2);
  const totalGains = wins.reduce((acc, t) => acc + t.pnlEur, 0);
  const totalLosses = Math.abs(losses.reduce((acc, t) => acc + t.pnlEur, 0));
  const profitFactor =
    totalLosses > 0 ? +(totalGains / totalLosses).toFixed(2) : totalGains > 0 ? 99.0 : 0;
  const avgR =
    total > 0
      ? +(evaluatedBatch.reduce((acc, t) => acc + t.rMultiple, 0) / total).toFixed(2)
      : 0;

  const metrics: OptimizationMetrics = {
    totalSetups: total,
    wins: winCount,
    losses: lossCount,
    breakevens: beCount,
    expired: expiredCount,
    winRate,
    expiredRate,
    lossRate,
    netPnlEur,
    profitFactor,
    avgR,
  };

  const identifiedStrengths: string[] = [];
  const identifiedWeaknesses: string[] = [];
  const proposedChanges: ProposedParameterChange[] = [];

  // Identify strengths
  if (winRate >= 55) {
    identifiedStrengths.push(`Tasso di successo solido: Win Rate ${winRate}% sui setup eseguiti.`);
  }
  if (profitFactor >= 1.5) {
    identifiedStrengths.push(`Profit Factor elevato (${profitFactor.toFixed(2)}) con forte asimmetria tra guadagni e perdite.`);
  }
  if (netPnlEur > 0) {
    identifiedStrengths.push(`P&L netto positivo (+${netPnlEur.toFixed(2)} €) nei ${total} setup del ciclo.`);
  }
  if (expiredRate < 15 && total >= 10) {
    identifiedStrengths.push(`Tasso di setup scaduti contenuto (${expiredRate}%), a conferma di target realistici.`);
  }

  // 1. Check EXPIRED weakness (High expired rate is a major flaw for intraday systems)
  const isHighExpired = expiredRate >= 20 || expiredCount >= 4;
  if (isHighExpired) {
    identifiedWeaknesses.push(
      `Tasso di setup scaduti (EXPIRED) critico (${expiredRate}%: ${expiredCount} su ${total}). I trade non riescono a raggiungere il Target 1 prima del cutoff o non scattano, immobilizzando capitale ed esponendo a rischio overnight o uscite forzate.`
    );

    // Propose reducing target1Multiplier from current (e.g. 1.6 -> 1.35)
    if (currentParams.target1Multiplier > 1.35) {
      const newT1 = +(Math.max(1.30, currentParams.target1Multiplier - 0.25)).toFixed(2);
      proposedChanges.push({
        parameterKey: 'target1Multiplier',
        label: 'Moltiplicatore Target 1 (Take Profit)',
        currentValue: `${currentParams.target1Multiplier}x R`,
        proposedValue: `${newT1}x R`,
        unit: 'x R',
        reason: `Target 1 attuale (${currentParams.target1Multiplier}x R) troppo ambizioso per l'espansione media giornaliera, provocando ${expiredCount} setup scaduti senza presa di profitto prima del cutoff.`,
        expectedBenefit: `Abbassando Target 1 a ${newT1}x R, il profitto viene incassato più rapidamente nella prima ora di borsa, con una riduzione attesa del tasso di Expired del ~35-45%.`,
      });
    }

    // Propose reducing triggerOffsetPercent (e.g. 0.20% -> 0.10%)
    if (currentParams.triggerOffsetPercent > 0.10) {
      const newOffset = +(Math.max(0.08, currentParams.triggerOffsetPercent - 0.10)).toFixed(2);
      proposedChanges.push({
        parameterKey: 'triggerOffsetPercent',
        label: 'Offset Trigger di Ingresso',
        currentValue: `${currentParams.triggerOffsetPercent}%`,
        proposedValue: `${newOffset}%`,
        unit: '%',
        reason: `L'offset del trigger allo ${currentParams.triggerOffsetPercent}% ritarda l'attivazione dell'ordine, facendo perdere l'impulso iniziale.`,
        expectedBenefit: `Avvicinando il trigger allo ${newOffset}%, i breakout vengono agganciati con immediatezza alla rottura del range senza restare ineseguiti.`,
      });
    }
  }

  // 2. Check WIN RATE & LOSS RATE weakness
  const isLowWinRate = winRate < 50;
  const isHighLossRate = lossRate >= 35 || lossCount >= 7;
  if (isLowWinRate || isHighLossRate) {
    identifiedWeaknesses.push(
      `Win Rate insufficiente (${winRate}%) con ${lossCount} stop loss subiti (${lossRate}%). I titoli selezionati subiscono falsi breakout o vengono scossi prematuramente dal rumore di apertura.`
    );

    // Propose raising minScore (e.g. 55 -> 65)
    if (currentParams.minScore < 70) {
      const newScore = Math.min(75, currentParams.minScore + 10);
      proposedChanges.push({
        parameterKey: 'minScore',
        label: 'Soglia Minima Punteggio Radar',
        currentValue: `${currentParams.minScore}/100`,
        proposedValue: `${newScore}/100`,
        unit: 'pt',
        reason: `La soglia attuale (${currentParams.minScore}/100) qualifica titoli con gap o volumi marginali che faticano a proseguire.`,
        expectedBenefit: `Filtro più selettivo a ${newScore}/100: elimina il 30% dei titoli più deboli aumentando il Win Rate medio stimato del +8-12%.`,
      });
    }

    // Propose raising minRvol (e.g. 1.10 -> 1.35)
    if (currentParams.minRvol < 1.40) {
      const newRvol = +(currentParams.minRvol + 0.25).toFixed(2);
      proposedChanges.push({
        parameterKey: 'minRvol',
        label: 'RVOL Minimo Richiesto',
        currentValue: `${currentParams.minRvol}x`,
        proposedValue: `${newRvol}x`,
        unit: 'x',
        reason: `Richiesta di volume relativo troppo permissiva (${currentParams.minRvol}x), favorevole a trappole di liquidità.`,
        expectedBenefit: `Imponendo RVOL >= ${newRvol}x si garantisce presenza istituzionale, riducendo i falsi breakout.`,
      });
    }

    // Propose widening normalRiskMultiplier to breathe
    if (currentParams.normalRiskMultiplier <= 0.50) {
      const newRisk = +(currentParams.normalRiskMultiplier + 0.08).toFixed(2);
      proposedChanges.push({
        parameterKey: 'normalRiskMultiplier',
        label: 'Tolleranza Stop Loss vs ATR',
        currentValue: `${currentParams.normalRiskMultiplier}x ATR`,
        proposedValue: `${newRisk}x ATR`,
        unit: 'x ATR',
        reason: `Lo stop loss a ${currentParams.normalRiskMultiplier}x ATR è troppo stretto e viene spesso colpito dal rumore dei primi 15 minuti.`,
        expectedBenefit: `Aumentando a ${newRisk}x ATR si concede respiro al titolo, evitando stop prematuri su volatilità transitoria.`,
      });
    }

    // Propose activating RSI Filter if not active
    if (!currentParams.rsiFilterActive) {
      proposedChanges.push({
        parameterKey: 'rsiFilterActive',
        label: 'Filtro Ipercomprato/Ipervenduto RSI',
        currentValue: 'Disattivato',
        proposedValue: 'Attivo',
        reason: 'Diversi trade in perdita sono stati aperti su titoli già in territorio di ipercomprato (>70) o ipervenduto (<30).',
        expectedBenefit: 'Esclusione automatica di titoli esausti prima che invertano contro il setup.',
      });
    }
  }

  // 3. Check BREAKEVEN / FRICTION weakness
  const isHighBreakeven = beCount >= 5 && netPnlEur <= 50;
  if (isHighBreakeven && proposedChanges.length === 0) {
    identifiedWeaknesses.push(
      `Troppi trade chiusi a pareggio (${beCount}/${total}) con PnL eroso dai costi commissionali e di spread.`
    );
    if (currentParams.minGapEurope < 0.6) {
      proposedChanges.push({
        parameterKey: 'minGapEurope',
        label: 'Gap Minimo Europa',
        currentValue: `${currentParams.minGapEurope}%`,
        proposedValue: `0.65%`,
        unit: '%',
        reason: 'Gap troppo modesto non garantisce espansione sufficiente a superare il costo commissional-spread.',
        expectedBenefit: 'Focalizzazione su gap più ampi con maggior potenziale direzionale post-open.',
      });
    }
  }

  // Determine overall status and rating
  let performanceRating: OptimizationProposal['performanceRating'] = 'NEEDS_IMPROVEMENT';
  let status: OptimizationProposal['status'] = 'PENDING';
  let summaryTitle = '';
  let summaryExplanation = '';

  const isFlawless = winRate >= 60 && expiredRate <= 15 && netPnlEur > 0 && profitFactor >= 1.5;

  if (isFlawless && proposedChanges.length === 0) {
    performanceRating = 'EXCELLENT';
    status = 'NO_CHANGES_NEEDED';
    summaryTitle = `Ciclo #${cycle}: Prestazioni Eccellenti — Parametri Confermati`;
    summaryExplanation = `Il ciclo di ${total} setup ha dimostrato elevata affidabilità: Win Rate al ${winRate}%, PnL netto di +${netPnlEur.toFixed(2)} € e tasso di Expired controllato (${expiredRate}%). In base alla regola aurea del trading sistematico quantitativo, non si modificano parametri su un edge statistico comprovato. Il sistema proseguirà con i parametri attuali.`;
  } else if (proposedChanges.length === 0) {
    performanceRating = 'GOOD';
    status = 'NO_CHANGES_NEEDED';
    summaryTitle = `Ciclo #${cycle}: Prestazioni Stabili — Nessuna Modifica Necessaria`;
    summaryExplanation = `I dati degli ultimi ${total} setup rientrano nei parametri di tolleranza previsti. Non sono state individuate anomalie strutturali tali da richiedere ricalibrazioni. Parametri confermati.`;
  } else {
    performanceRating = (expiredRate >= 25 || winRate < 40) ? 'CRITICAL' : 'NEEDS_IMPROVEMENT';
    status = 'PENDING';
    summaryTitle = isHighExpired
      ? `Audit Ciclo #${cycle}: Riduzione Tasso Expired e Ottimizzazione Target`
      : `Audit Ciclo #${cycle}: Aumento Selettività Radar e Difesa Win Rate`;
    summaryExplanation = `L'analisi quantitativa dei ${total} setup ha evidenziato ${proposedChanges.length} aree di miglioramento critiche. ${
      isHighExpired
        ? `In particolare, il tasso di Expired al ${expiredRate}% disperde opportunità. Si propone di avvicinare il Target 1 e ridurre l'offset del trigger per accelerare la chiusura positiva prima del cutoff.`
        : `Il Win Rate al ${winRate}% richiede un innalzamento della selettività minima per evitare falsi breakout.`
    } Esamina i parametri proposti e decidi se accettarli o continuare con la configurazione attuale.`;
  }

  return {
    id: `opt-cycle-${cycle}-${Date.now()}`,
    cycleNumber: cycle,
    evaluatedTradesCount: total,
    date: new Date().toLocaleDateString('it-IT'),
    metrics,
    status,
    performanceRating,
    summaryTitle,
    summaryExplanation,
    identifiedStrengths,
    identifiedWeaknesses,
    proposedChanges,
    market: 'GLOBAL',
  };
}

/**
 * Evaluates systemic performance specifically for one market session ('EU' or 'US').
 * Requires at least `minRequiredTrades` (default 5) closed trades for that market before generating proposals.
 * If insufficient data, returns a clear status with zero mock or synthetic proposals.
 */
export function evaluateSessionOptimization(
  trades: TradeJournalEntry[],
  market: 'EU' | 'US',
  currentParams: SystemParameters = DEFAULT_SYSTEM_PARAMETERS,
  minRequiredTrades = 5
): OptimizationProposal {
  const marketTrades = trades.filter((t) => (t.market || (t.session === 'US' ? 'US' : 'EU')) === market);
  const sorted = [...marketTrades].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  const evaluatedBatch = sorted.slice(0, 20);
  const total = evaluatedBatch.length;
  const cycle = Math.max(1, Math.floor(marketTrades.length / 20));
  const marketName = market === 'EU' ? 'Europa' : 'USA';

  if (total < minRequiredTrades) {
    return {
      id: `prop-${market.toLowerCase()}-insufficient-${Date.now()}`,
      cycleNumber: cycle,
      evaluatedTradesCount: total,
      date: new Date().toLocaleDateString('it-IT'),
      market,
      metrics: {
        totalSetups: total,
        wins: evaluatedBatch.filter((t) => t.outcome === 'WIN').length,
        losses: evaluatedBatch.filter((t) => t.outcome === 'LOSS').length,
        breakevens: evaluatedBatch.filter((t) => t.outcome === 'BREAKEVEN').length,
        expired: evaluatedBatch.filter((t) => t.outcome === 'EXPIRED').length,
        winRate: 0,
        expiredRate: 0,
        lossRate: 0,
        netPnlEur: +(evaluatedBatch.reduce((acc, t) => acc + (t.pnlEur || 0), 0)).toFixed(2),
        profitFactor: 0,
        avgR: 0,
      },
      status: 'NO_CHANGES_NEEDED',
      performanceRating: 'GOOD',
      summaryTitle: `Sessione ${marketName}: Dati Insufficienti (${total}/${minRequiredTrades} Trade)`,
      summaryExplanation: `Sono stati registrati ${total} trade chiusi per il mercato ${marketName}. La soglia minima di affidabilità statistica richiede almeno ${minRequiredTrades} trade per formulare proposte di ricalibrazione. Il sistema mantiene attivi i parametri correnti senza generare stime fittizie.`,
      identifiedStrengths: [],
      identifiedWeaknesses: [
        `Campione statistico ridotto (${total}/${minRequiredTrades} trade chiusi): registra ulteriori trade in questa sessione per sbloccare l'auto-ottimizzazione.`,
      ],
      proposedChanges: [],
    };
  }

  const wins = evaluatedBatch.filter((t) => t.outcome === 'WIN');
  const losses = evaluatedBatch.filter((t) => t.outcome === 'LOSS');
  const breakevens = evaluatedBatch.filter((t) => t.outcome === 'BREAKEVEN');
  const expired = evaluatedBatch.filter((t) => t.outcome === 'EXPIRED');

  const winCount = wins.length;
  const lossCount = losses.length;
  const beCount = breakevens.length;
  const expiredCount = expired.length;

  const winRate = total > 0 ? +((winCount / total) * 100).toFixed(1) : 0;
  const expiredRate = total > 0 ? +((expiredCount / total) * 100).toFixed(1) : 0;
  const lossRate = total > 0 ? +((lossCount / total) * 100).toFixed(1) : 0;

  const netPnlEur = +(evaluatedBatch.reduce((acc, t) => acc + t.pnlEur, 0)).toFixed(2);
  const totalGains = wins.reduce((acc, t) => acc + t.pnlEur, 0);
  const totalLosses = Math.abs(losses.reduce((acc, t) => acc + t.pnlEur, 0));
  const profitFactor =
    totalLosses > 0 ? +(totalGains / totalLosses).toFixed(2) : totalGains > 0 ? 99.0 : 0;
  const avgR =
    total > 0
      ? +(evaluatedBatch.reduce((acc, t) => acc + t.rMultiple, 0) / total).toFixed(2)
      : 0;

  const metrics: OptimizationMetrics = {
    totalSetups: total,
    wins: winCount,
    losses: lossCount,
    breakevens: beCount,
    expired: expiredCount,
    winRate,
    expiredRate,
    lossRate,
    netPnlEur,
    profitFactor,
    avgR,
  };

  const identifiedStrengths: string[] = [];
  const identifiedWeaknesses: string[] = [];
  const proposedChanges: ProposedParameterChange[] = [];

  if (winRate >= 55) {
    identifiedStrengths.push(`Tasso di successo solido: Win Rate ${winRate}% sui setup ${marketName}.`);
  }
  if (profitFactor >= 1.5) {
    identifiedStrengths.push(`Profit Factor elevato (${profitFactor.toFixed(2)}) con forte asimmetria tra guadagni e perdite.`);
  }
  if (netPnlEur > 0) {
    identifiedStrengths.push(`P&L netto positivo (+${netPnlEur.toFixed(2)} €) nei ${total} setup ${marketName} del ciclo.`);
  }
  if (expiredRate < 15 && total >= 5) {
    identifiedStrengths.push(`Tasso di setup scaduti contenuto (${expiredRate}%), a conferma di target realistici.`);
  }

  // 1. Check EXPIRED weakness
  const isHighExpired = expiredRate >= 20 || expiredCount >= (total >= 10 ? 4 : 2);
  if (isHighExpired) {
    identifiedWeaknesses.push(
      `Tasso di setup scaduti (EXPIRED) critico in sessione ${marketName} (${expiredRate}%: ${expiredCount} su ${total}). I trade non raggiungono Target 1 prima del cutoff (${market === 'EU' ? '11:30' : '17:30'} CET) o non scattano.`
    );

    if (currentParams.target1Multiplier > 1.35) {
      const newT1 = +(Math.max(1.30, currentParams.target1Multiplier - 0.25)).toFixed(2);
      proposedChanges.push({
        parameterKey: 'target1Multiplier',
        label: `Moltiplicatore Target 1 (${marketName})`,
        currentValue: `${currentParams.target1Multiplier}x R`,
        proposedValue: `${newT1}x R`,
        unit: 'x R',
        reason: `Target 1 attuale (${currentParams.target1Multiplier}x R) troppo ambizioso per l'espansione media della sessione ${marketName}, provocando ${expiredCount} setup scaduti senza presa di profitto prima del cutoff.`,
        expectedBenefit: `Abbassando Target 1 a ${newT1}x R, il profitto viene incassato più rapidamente nella prima ora post-ORB con riduzione del tasso di Expired del ~35-45%.`,
      });
    }

    if (currentParams.triggerOffsetPercent > 0.10) {
      const newOffset = +(Math.max(0.08, currentParams.triggerOffsetPercent - 0.10)).toFixed(2);
      proposedChanges.push({
        parameterKey: 'triggerOffsetPercent',
        label: `Offset Trigger di Ingresso (${marketName})`,
        currentValue: `${currentParams.triggerOffsetPercent}%`,
        proposedValue: `${newOffset}%`,
        unit: '%',
        reason: `L'offset del trigger allo ${currentParams.triggerOffsetPercent}% ritarda l'attivazione dell'ordine sul breakout.`,
        expectedBenefit: `Avvicinando il trigger allo ${newOffset}%, i breakout vengono agganciati con immediatezza alla rottura del range senza restare ineseguiti.`,
      });
    }
  }

  // 2. Check WIN RATE & LOSS RATE weakness
  const isLowWinRate = winRate < 50;
  const isHighLossRate = lossRate >= 35 || lossCount >= (total >= 10 ? 4 : 2);
  if (isLowWinRate || isHighLossRate) {
    identifiedWeaknesses.push(
      `Win Rate insufficiente in sessione ${marketName} (${winRate}%) con ${lossCount} stop loss subiti (${lossRate}%). I titoli selezionati subiscono falsi breakout.`
    );

    if (market === 'EU') {
      const curScore = currentParams.minScoreEurope ?? TRADING_PARAMS.MIN_SCORE_EU;
      if (curScore < 60) {
        const newScore = Math.min(65, curScore + 6);
        proposedChanges.push({
          parameterKey: 'minScoreEurope',
          label: 'Soglia Minima Punteggio Europa (Gate G11)',
          currentValue: `${curScore}/100`,
          proposedValue: `${newScore}/100`,
          unit: 'pt',
          reason: `La soglia europea attuale (${curScore}/100) ammette titoli con confluenza debole in apertura.`,
          expectedBenefit: `Inasprendo il filtro a ${newScore}/100 per l'Europa si eliminano i falsi segnali aumentando il Win Rate medio.`,
        });
      }

      const curRvol = currentParams.minRvolEurope ?? 0.85;
      if (curRvol < 1.10) {
        const newRvol = +(curRvol + 0.15).toFixed(2);
        proposedChanges.push({
          parameterKey: 'minRvolEurope',
          label: 'RVOL Minimo Europa',
          currentValue: `${curRvol}x`,
          proposedValue: `${newRvol}x`,
          unit: 'x',
          reason: `Volume relativo europeo attuale (${curRvol}x) permissivo, rischio trappole di liquidità.`,
          expectedBenefit: `Richiedendo RVOL >= ${newRvol}x si assicura vera partecipazione istituzionale sulle borse europee.`,
        });
      }
    } else {
      const curScore = currentParams.minScoreUSA ?? TRADING_PARAMS.MIN_SCORE_US;
      if (curScore < 70) {
        const newScore = Math.min(75, curScore + 6);
        proposedChanges.push({
          parameterKey: 'minScoreUSA',
          label: 'Soglia Minima Punteggio USA (Gate G11)',
          currentValue: `${curScore}/100`,
          proposedValue: `${newScore}/100`,
          unit: 'pt',
          reason: `La volatilità di Wall Street richiede maggior selettività rispetto alla soglia attuale di ${curScore}/100.`,
          expectedBenefit: `Elevando la soglia USA a ${newScore}/100 si selezionano solo titoli con forte spinta direzionale.`,
        });
      }

      const curRvol = currentParams.minRvolUSA ?? 1.15;
      if (curRvol < 1.40) {
        const newRvol = +(curRvol + 0.20).toFixed(2);
        proposedChanges.push({
          parameterKey: 'minRvolUSA',
          label: 'RVOL Minimo USA',
          currentValue: `${curRvol}x`,
          proposedValue: `${newRvol}x`,
          unit: 'x',
          reason: `A Wall Street il volume relativo minimo di ${curRvol}x è troppo basso per confermare l'intraday trend.`,
          expectedBenefit: `Richiedendo RVOL >= ${newRvol}x si garantisce presenza massiccia di ordini istituzionali.`,
        });
      }
    }
  }

  // 3. Check BREAKEVEN / FRICTION weakness
  const isHighBreakeven = beCount >= (total >= 10 ? 4 : 2) && netPnlEur <= 50;
  if (isHighBreakeven && proposedChanges.length === 0) {
    identifiedWeaknesses.push(
      `Troppi trade chiusi a pareggio (${beCount}/${total}) in sessione ${marketName}.`
    );
    if (market === 'EU' && currentParams.minGapEurope < 0.6) {
      proposedChanges.push({
        parameterKey: 'minGapEurope',
        label: 'Gap Minimo Europa',
        currentValue: `${currentParams.minGapEurope}%`,
        proposedValue: `0.60%`,
        unit: '%',
        reason: 'Gap europeo modesto non garantisce espansione sufficiente.',
        expectedBenefit: 'Focalizzazione su gap più ampi con maggior potenziale direzionale.',
      });
    } else if (market === 'US' && currentParams.minGapUSA < 0.90) {
      proposedChanges.push({
        parameterKey: 'minGapUSA',
        label: 'Gap Minimo USA',
        currentValue: `${currentParams.minGapUSA}%`,
        proposedValue: `0.95%`,
        unit: '%',
        reason: 'Gap USA troppo compatto per assorbire la volatilità di apertura.',
        expectedBenefit: 'Selezione di titoli con catalizzatore più marcato.',
      });
    }
  }

  let performanceRating: OptimizationProposal['performanceRating'] = 'NEEDS_IMPROVEMENT';
  let status: OptimizationProposal['status'] = 'PENDING';
  let summaryTitle = '';
  let summaryExplanation = '';

  const isFlawless = winRate >= 60 && expiredRate <= 15 && netPnlEur > 0 && profitFactor >= 1.5;

  if (isFlawless && proposedChanges.length === 0) {
    performanceRating = 'EXCELLENT';
    status = 'NO_CHANGES_NEEDED';
    summaryTitle = `Sessione ${marketName} (Ciclo #${cycle}): Prestazioni Eccellenti`;
    summaryExplanation = `Il ciclo di ${total} setup ${marketName} ha registrato un Win Rate del ${winRate}% e PnL netto di +${netPnlEur.toFixed(2)} €. Parametri confermati senza modifiche.`;
  } else if (proposedChanges.length === 0) {
    performanceRating = 'GOOD';
    status = 'NO_CHANGES_NEEDED';
    summaryTitle = `Sessione ${marketName} (Ciclo #${cycle}): Parametri Stabili`;
    summaryExplanation = `I dati degli ultimi ${total} setup ${marketName} rientrano nella tolleranza statistica. Parametri confermati.`;
  } else {
    performanceRating = (expiredRate >= 25 || winRate < 40) ? 'CRITICAL' : 'NEEDS_IMPROVEMENT';
    status = 'PENDING';
    summaryTitle = isHighExpired
      ? `Sessione ${marketName}: Calibrazione Anti-Scadenza (Expired ${expiredRate}%)`
      : `Sessione ${marketName}: Inasprimento Filtri e Selettività (Win Rate ${winRate}%)`;
    summaryExplanation = `Rilevate inefficienze nei ${total} setup ${marketName}: ${identifiedWeaknesses[0] || 'Variazione parametri consigliata.'}`;
  }

  return {
    id: `prop-${market.toLowerCase()}-${cycle}-${Date.now()}`,
    cycleNumber: cycle,
    evaluatedTradesCount: total,
    date: new Date().toLocaleDateString('it-IT'),
    market,
    metrics,
    status,
    performanceRating,
    summaryTitle,
    summaryExplanation,
    identifiedStrengths,
    identifiedWeaknesses,
    proposedChanges,
  };
}

export function evaluateDualSystemOptimization(
  trades: TradeJournalEntry[],
  currentParams: SystemParameters = DEFAULT_SYSTEM_PARAMETERS,
  minRequiredTrades = 5
): DualOptimizationProposals {
  return {
    eu: evaluateSessionOptimization(trades, 'EU', currentParams, minRequiredTrades),
    us: evaluateSessionOptimization(trades, 'US', currentParams, minRequiredTrades),
  };
}

// -------------------------------------------------------------
// INTRADAY SEASONALITY & TIME-OF-DAY PATTERN ENGINE
// -------------------------------------------------------------

export function calculateIntradaySeasonality(
  entries: TradeJournalEntry[],
  currentCetMinutes?: number,
  marketFilter: 'ALL' | 'EU' | 'US' = 'ALL'
): SeasonalityReport {
  // If currentCetMinutes not provided, compute from real now
  let currentMinutes = currentCetMinutes;
  if (currentMinutes == null) {
    const now = new Date();
    const cetFormatter = new Intl.DateTimeFormat('it-IT', {
      timeZone: 'Europe/Rome',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = cetFormatter.formatToParts(now);
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
    const m = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
    currentMinutes = h * 60 + m;
  }

  const currentHourDecimal = currentMinutes / 60;

  // Canonical Intraday Time Slots
  const CANONICAL_SLOTS_DEF = [
    {
      slotKey: '08:00 - 09:00',
      label: 'Pre-Market Europa',
      startHour: 8.0,
      endHour: 9.0,
      marketSession: 'EU' as const,
      description: 'Aste di apertura ed elaborazione gap mattutini. Volumi in formazione.',
      tacticalAdvice: 'Monitorare i gap emergenti e attendere la prima chiusura a 5m per evitare trappole di apertura.',
      benchmarkWinRate: 52,
      benchmarkAvgR: 0.95,
    },
    {
      slotKey: '09:00 - 10:00',
      label: 'Golden Hour Europa (Apertura Cash)',
      startHour: 9.0,
      endHour: 10.0,
      marketSession: 'EU' as const,
      description: 'Massimo volume ed espansione del range sui sottostanti XETRA, Euronext e Piazza Affari.',
      tacticalAdvice: 'Finestra d\'oro per breakout ORB 5m/15m e setup Gap and Go con catalizzatore confermato.',
      benchmarkWinRate: 71,
      benchmarkAvgR: 1.68,
    },
    {
      slotKey: '10:00 - 11:30',
      label: 'Espansione Trend Europa',
      startHour: 10.0,
      endHour: 11.5,
      marketSession: 'EU' as const,
      description: 'Fase di consolidamento direzionale prima del cutoff temporale europeo delle 11:30 CET.',
      tacticalAdvice: 'Alzare lo stop loss a pareggio (breakeven); evitare nuovi ingressi ritardati con R/R sfavorevole.',
      benchmarkWinRate: 64,
      benchmarkAvgR: 1.35,
    },
    {
      slotKey: '11:30 - 14:30',
      label: 'Midday Chop & Bassa Liquidità',
      startHour: 11.5,
      endHour: 14.5,
      marketSession: 'GLOBAL' as const,
      description: 'Pausa pranzo istituzionale. Crollo dei volumi medi e frequenti finte di breakout (whipsaw).',
      tacticalAdvice: 'Sconsigliata l\'apertura di nuovi trade a leva; proteggere le posizioni o restare flat.',
      benchmarkWinRate: 36,
      benchmarkAvgR: 0.42,
    },
    {
      slotKey: '14:30 - 15:30',
      label: 'Pre-Market USA & Macro Release',
      startHour: 14.5,
      endHour: 15.5,
      marketSession: 'US' as const,
      description: 'Rilascio dei dati macroeconomici USA (CPI, NFP, PPI) e primi scambi istituzionali a New York.',
      tacticalAdvice: 'Verificare la reazione dei futures ES/NQ; non anticipare l\'apertura prima delle 15:30 CET.',
      benchmarkWinRate: 57,
      benchmarkAvgR: 1.15,
    },
    {
      slotKey: '15:30 - 16:30',
      label: 'Golden Hour Wall Street',
      startHour: 15.5,
      endHour: 16.5,
      marketSession: 'US' as const,
      description: 'Apertura cash NYSE/Nasdaq. Esplosione di liquidità e momentum sui titoli tech a forte beta.',
      tacticalAdvice: 'Finestra ad altissima convinzione per titoli USA (NVDA, TSLA, AAPL). Esecuzione immediata sui trigger.',
      benchmarkWinRate: 74,
      benchmarkAvgR: 1.75,
    },
    {
      slotKey: '16:30 - 17:30',
      label: 'Fix Europa & Pre-Cutoff USA',
      startHour: 16.5,
      endHour: 17.5,
      marketSession: 'GLOBAL' as const,
      description: 'Coincidenza tra la chiusura delle borse europee (17:35 CET) e il cutoff orario dei setup USA.',
      tacticalAdvice: 'Chiusura tassativa dei setup europei; stringere il trailing stop sui titoli americani.',
      benchmarkWinRate: 60,
      benchmarkAvgR: 1.22,
    },
    {
      slotKey: '17:30 - 20:00',
      label: 'Sessione Pomeridiana USA',
      startHour: 17.5,
      endHour: 20.0,
      marketSession: 'US' as const,
      description: 'Mercato USA in fase di trend pomeridiano consolidato senza interferenze europee.',
      tacticalAdvice: 'Operare unicamente a favore di trend conclamato e confermato dai futures di riferimento.',
      benchmarkWinRate: 56,
      benchmarkAvgR: 1.10,
    },
    {
      slotKey: '20:00 - 22:00',
      label: 'Power Hour & Chiusura New York',
      startHour: 20.0,
      endHour: 22.0,
      marketSession: 'US' as const,
      description: 'Ultima ora di negoziazione a Wall Street con ribilanciamenti fondi e ordini MOC (Market on Close).',
      tacticalAdvice: 'Evitare posizioni overnight sui certificati Knock-Out per scongiurare il rischio gap del giorno successivo.',
      benchmarkWinRate: 50,
      benchmarkAvgR: 0.85,
    },
  ];

  // Filter completed trades by market if requested
  const completedEntries = entries.filter((e) => e.status !== 'OPEN');
  const relevantEntries = marketFilter === 'ALL'
    ? completedEntries
    : completedEntries.filter((e) => e.session === marketFilter);

  const isJournalDataAvailable = relevantEntries.length >= 3;

  // Process Hourly Slots
  const hourlySlots: HourlySeasonalitySlot[] = CANONICAL_SLOTS_DEF.map((def) => {
    const isCurrentHour = currentHourDecimal >= def.startHour && currentHourDecimal < def.endHour;

    // Filter trades belonging to this time window
    const slotTrades = relevantEntries.filter((entry) => {
      try {
        const d = new Date(entry.timestamp);
        const cetFormatter = new Intl.DateTimeFormat('it-IT', {
          timeZone: 'Europe/Rome',
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        });
        const parts = cetFormatter.formatToParts(d);
        const h = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
        const m = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
        const entryHourDec = h + m / 60;
        return entryHourDec >= def.startHour && entryHourDec < def.endHour;
      } catch {
        return false;
      }
    });

    const tradesCount = slotTrades.length;
    const winCount = slotTrades.filter((t) => t.outcome === 'WIN').length;
    const lossCount = slotTrades.filter((t) => t.outcome === 'LOSS').length;
    const beCount = slotTrades.filter((t) => t.outcome === 'BREAKEVEN').length;
    const expiredCount = slotTrades.filter((t) => t.outcome === 'EXPIRED').length;

    let winRate = def.benchmarkWinRate;
    let avgRMultiple = def.benchmarkAvgR;
    let netPnlEur = 0;
    let profitFactor = 1.5;

    if (tradesCount > 0) {
      winRate = +((winCount / tradesCount) * 100).toFixed(1);
      avgRMultiple = +(slotTrades.reduce((acc, t) => acc + t.rMultiple, 0) / tradesCount).toFixed(2);
      netPnlEur = +(slotTrades.reduce((acc, t) => acc + t.pnlEur, 0)).toFixed(2);
      const totalWinsEur = slotTrades.filter((t) => t.pnlEur > 0).reduce((acc, t) => acc + t.pnlEur, 0);
      const totalLossesEur = Math.abs(slotTrades.filter((t) => t.pnlEur < 0).reduce((acc, t) => acc + t.pnlEur, 0));
      profitFactor = totalLossesEur > 0 ? +(totalWinsEur / totalLossesEur).toFixed(2) : totalWinsEur > 0 ? 99.0 : 0;
    }

    let status: HourlySeasonalitySlot['status'] = 'NEUTRAL';
    if (tradesCount === 0 && !isJournalDataAvailable) {
      if (def.benchmarkWinRate >= 68) status = 'HIGH_CONVICTION';
      else if (def.benchmarkWinRate <= 40) status = 'CHOP_RISK';
      else status = 'NEUTRAL';
    } else if (tradesCount === 0) {
      status = 'INSUFFICIENT_DATA';
    } else if (winRate >= 65 || avgRMultiple >= 1.3) {
      status = 'HIGH_CONVICTION';
    } else if (winRate < 45 || netPnlEur < 0) {
      status = 'CHOP_RISK';
    } else {
      status = 'NEUTRAL';
    }

    return {
      slotKey: def.slotKey,
      label: def.label,
      startHour: def.startHour,
      endHour: def.endHour,
      marketSession: def.marketSession,
      tradesCount,
      winCount,
      lossCount,
      beCount,
      expiredCount,
      winRate,
      avgRMultiple,
      netPnlEur,
      profitFactor,
      status,
      description: def.description,
      tacticalAdvice: def.tacticalAdvice,
      isCurrentHour,
    };
  });

  // Process Days of Week (1 = Lunedì ... 5 = Venerdì)
  const DAY_NAMES = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì'];
  const todayDayIndex = (() => {
    try {
      const now = new Date();
      const cetDay = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short' }).format(now);
      const d = now.getDay(); // 0 Sun, 1 Mon ... 5 Fri
      return d >= 1 && d <= 5 ? d : 1;
    } catch {
      return 1;
    }
  })();

  const daySlots: DaySeasonalitySlot[] = DAY_NAMES.map((name, idx) => {
    const dayNum = idx + 1; // 1 to 5
    const isToday = dayNum === todayDayIndex;

    const dayTrades = relevantEntries.filter((entry) => {
      try {
        const d = new Date(entry.timestamp);
        return d.getDay() === dayNum;
      } catch {
        return false;
      }
    });

    const tradesCount = dayTrades.length;
    const winCount = dayTrades.filter((t) => t.outcome === 'WIN').length;
    const lossCount = dayTrades.filter((t) => t.outcome === 'LOSS').length;

    // Benchmark base weights per day
    const benchWR = dayNum === 2 ? 68 : dayNum === 3 ? 65 : dayNum === 1 ? 57 : dayNum === 4 ? 61 : 52;
    const benchR = dayNum === 2 ? 1.55 : dayNum === 3 ? 1.45 : dayNum === 1 ? 1.15 : dayNum === 4 ? 1.25 : 0.95;

    let winRate = benchWR;
    let avgRMultiple = benchR;
    let netPnlEur = 0;

    if (tradesCount > 0) {
      winRate = +((winCount / tradesCount) * 100).toFixed(1);
      avgRMultiple = +(dayTrades.reduce((acc, t) => acc + t.rMultiple, 0) / tradesCount).toFixed(2);
      netPnlEur = +(dayTrades.reduce((acc, t) => acc + t.pnlEur, 0)).toFixed(2);
    }

    return {
      dayName: name,
      dayIndex: dayNum,
      tradesCount,
      winCount,
      lossCount,
      winRate,
      netPnlEur,
      avgRMultiple,
      isToday,
    };
  });

  // Find best and worst slots
  const validSlotsForRanking = hourlySlots.filter((s) => s.status !== 'INSUFFICIENT_DATA');
  const sortedByWinRate = [...validSlotsForRanking].sort((a, b) => b.winRate - a.winRate);
  const bestWindow = sortedByWinRate.length > 0 ? sortedByWinRate[0] : null;
  const worstWindow = sortedByWinRate.length > 0 ? sortedByWinRate[sortedByWinRate.length - 1] : null;

  const currentActiveSlot = hourlySlots.find((s) => s.isCurrentHour) || null;

  // Real-time Recommendation based on current time window
  let recommendationVerdict: SeasonalityReport['recommendationForNow']['verdict'] = 'NEUTRAL';
  let recommendationTitle = 'Finestra Operativa Regolare';
  let recommendationMessage = 'L\'orario attuale presenta parametri di volatilità e liquidità bilanciati. Operare rispettando trigger e stop loss prefissati.';

  if (currentActiveSlot) {
    if (currentActiveSlot.status === 'HIGH_CONVICTION') {
      recommendationVerdict = 'FAVORABLE';
      recommendationTitle = `Finestra ad Alta Probabilità: ${currentActiveSlot.label}`;
      recommendationMessage = `I pattern stagionali storici evidenziano un tasso di successo del ${currentActiveSlot.winRate}% ed un R-medio di ${currentActiveSlot.avgRMultiple > 0 ? '+' : ''}${currentActiveSlot.avgRMultiple}R in questa fascia. Condizioni ideali per eseguire i setup primari.`;
    } else if (currentActiveSlot.status === 'CHOP_RISK') {
      recommendationVerdict = 'CAUTION_CHOP';
      recommendationTitle = `Attenzione: Finestra ad Alto Rischio / Chop (${currentActiveSlot.label})`;
      recommendationMessage = `Questa fascia oraria soffre storicamente di contrazione dei volumi e frequenti falsi breakout (Win Rate ${currentActiveSlot.winRate}%). Il filtro consiglia di attendere o dimezzare la size.`;
    }
  }

  const averageWinRate = relevantEntries.length > 0
    ? +((relevantEntries.filter((t) => t.outcome === 'WIN').length / relevantEntries.length) * 100).toFixed(1)
    : 62.0;

  return {
    hourlySlots,
    daySlots,
    bestWindow,
    worstWindow,
    currentActiveSlot,
    isJournalDataAvailable,
    totalAnalyzedTrades: relevantEntries.length,
    averageWinRate,
    recommendationForNow: {
      verdict: recommendationVerdict,
      title: recommendationTitle,
      message: recommendationMessage,
    },
  };
}

// -------------------------------------------------------------
// VISUAL FILTERING AUDIT ENGINE
// -------------------------------------------------------------

export function generateFilteringAuditReport(
  quotes: RawQuoteData[],
  dualTop: { topEU: ScoredCandidate | null; topUS: ScoredCandidate | null },
  futuresChange: number | { EU: number; US: number },
  parameters: SystemParameters,
  catalystCache: Record<string, GeminiCatalystAnalysis>,
  isRsiFilterActive: boolean,
  currentCetMinutes?: number
): FilteringAuditReport {
  const totalScanned = quotes.length;
  const qualifiedTickers = new Set<string>();

  const minScoreEU = parameters?.minScoreEurope ?? parameters?.minScore ?? TRADING_PARAMS.MIN_SCORE_EU;
  const minScoreUS = parameters?.minScoreUSA ?? parameters?.minScore ?? TRADING_PARAMS.MIN_SCORE_US;
  const minRvolEU = parameters?.minRvolEurope ?? parameters?.minRvol ?? 0.85;
  const minRvolUS = parameters?.minRvolUSA ?? parameters?.minRvol ?? 1.15;

  if (dualTop.topEU && dualTop.topEU.score.total >= minScoreEU) {
    const cat = catalystCache[dualTop.topEU.quote.ticker];
    const isAbsenceOfNewsOnly = cat && (
      cat.catalizzatore?.toLowerCase().includes('nessuna notizia') ||
      cat.catalizzatore?.toLowerCase().includes('assenza di catalizzatore') ||
      cat.catalizzatore?.toLowerCase().includes('assenza di notizie')
    );
    if (!cat || cat.decisione !== 'NESSUN_TRADE' || isAbsenceOfNewsOnly) {
      qualifiedTickers.add(dualTop.topEU.quote.ticker);
    }
  }

  if (dualTop.topUS && dualTop.topUS.score.total >= minScoreUS) {
    const cat = catalystCache[dualTop.topUS.quote.ticker];
    const isAbsenceOfNewsOnly = cat && (
      cat.catalizzatore?.toLowerCase().includes('nessuna notizia') ||
      cat.catalizzatore?.toLowerCase().includes('assenza di catalizzatore') ||
      cat.catalizzatore?.toLowerCase().includes('assenza di notizie')
    );
    if (!cat || cat.decisione !== 'NESSUN_TRADE' || isAbsenceOfNewsOnly) {
      qualifiedTickers.add(dualTop.topUS.quote.ticker);
    }
  }

  const countsByCategory = {
    rsiExtreme: 0,
    gapInsufficient: 0,
    rvolInsufficient: 0,
    scoreBelowMin: 0,
    catalystUnverified: 0,
    atrInsufficient: 0,
    cutoffPassed: 0,
    priceUnavailable: 0,
  };

  const excludedList: ExcludedCandidateInfo[] = [];

  quotes.forEach((q) => {
    if (qualifiedTickers.has(q.ticker)) return;

    const change =
      typeof futuresChange === 'number'
        ? futuresChange
        : q.market === 'US'
        ? futuresChange.US
        : futuresChange.EU;

    const isEU = q.market === 'EU';
    const minScore = isEU ? minScoreEU : minScoreUS;
    const minRvol = isEU ? minRvolEU : minRvolUS;
    const minGap = isEU ? parameters.minGapEurope : parameters.minGapUSA;

    const cat = catalystCache[q.ticker];
    const scoreObj = calculateCandidateScore(q, change, cat);
    const score = scoreObj.total;
    const rsi = q.rsi5m ?? q.rsi14 ?? null;
    const gap = q.gapPercent ?? 0;
    const absGap = Math.abs(gap);
    const rvol = q.rvol != null ? q.rvol : (isEU ? 1.0 : 1.0);

    let primaryReasonCategory: ExclusionCategory = 'SCORE_BELOW_MIN';
    let primaryReasonLabel = `Punteggio complessivo sotto soglia (${isEU ? 'EU' : 'US'})`;
    let detail = `Punteggio quantitativo ${score}/100 inferiore alla soglia minima richiesta di ${minScore}/100 per ${isEU ? 'Europa' : 'USA'}.`;

    // Hierarchy of exclusions:
    if (q.currentPrice == null && q.preMarketPrice == null) {
      primaryReasonCategory = 'PRICE_UNAVAILABLE';
      primaryReasonLabel = 'Prezzo non disponibile';
      detail = 'Quotazione assente dal feed in tempo reale di borsa.';
      countsByCategory.priceUnavailable++;
    } else if (q.atr14 == null || q.atr14 <= 0) {
      primaryReasonCategory = 'ATR_INSUFFICIENT';
      primaryReasonLabel = 'Volatilità ATR insufficiente o non calcolabile';
      detail = 'Storico sedute o volatilità media non calcolabile per definire lo stop.';
      countsByCategory.atrInsufficient++;
    } else if (isRsiFilterActive && isRsiExtreme(rsi)) {
      primaryReasonCategory = 'RSI_EXTREME';
      primaryReasonLabel = `RSI fuori range (${rsi! >= 70 ? 'Ipercomprato' : 'Ipervenduto'}: ${rsi})`;
      detail = `RSI a ${rsi}: rischio elevato di inversione brusca e knock-out anticipato sul certificato.`;
      countsByCategory.rsiExtreme++;
    } else if (absGap < minGap) {
      primaryReasonCategory = 'GAP_INSUFFICIENT';
      primaryReasonLabel = `Gap % insufficiente (${gap.toFixed(2)}% vs min ±${minGap}%)`;
      detail = `Il sottostante non presenta un gap d'apertura minimo per attivare strategie Gap & Go o ORB.`;
      countsByCategory.gapInsufficient++;
    } else if (rvol < minRvol) {
      primaryReasonCategory = 'RVOL_INSUFFICIENT';
      primaryReasonLabel = `Volume Relativo basso (${rvol.toFixed(2)}x vs min ${minRvol}x)`;
      detail = `Scambi istituzionali inferiori alla media mobile a 20 periodi; rischio falsa rottura.`;
      countsByCategory.rvolInsufficient++;
    } else if (cat && cat.decisione === 'NESSUN_TRADE') {
      const isAbsenceOfNewsOnly =
        cat.catalizzatore?.toLowerCase().includes('nessuna notizia') ||
        cat.catalizzatore?.toLowerCase().includes('assenza di catalizzatore') ||
        cat.catalizzatore?.toLowerCase().includes('assenza di notizie') ||
        (cat.rischi?.length === 1 &&
          (cat.rischi[0]?.toLowerCase().includes('mancanza di notizie') ||
           cat.rischi[0]?.toLowerCase().includes('assenza di catalizzatore') ||
           cat.rischi[0]?.toLowerCase().includes('assenza di notizie')));

      if (!isAbsenceOfNewsOnly) {
        primaryReasonCategory = 'CATALYST_UNVERIFIED';
        primaryReasonLabel = 'Rischio fondamentale avverso o trimestrale';
        detail = cat.catalizzatore || 'Rischio trimestrale o evento societario critico attivo nella giornata odierna.';
        countsByCategory.catalystUnverified++;
      } else if (score < minScore) {
        primaryReasonCategory = 'SCORE_BELOW_MIN';
        primaryReasonLabel = `Punteggio sotto soglia (${score}/100 vs min ${minScore})`;
        detail = `Punteggio ${score}/100: confluenza tecnica debole tra gap, book e futures per ${isEU ? 'Europa' : 'USA'}.`;
        countsByCategory.scoreBelowMin++;
      } else {
        primaryReasonCategory = 'CUTOFF_PASSED';
        primaryReasonLabel = 'Orario di cutoff superato';
        detail = `Sessione oltre l'orario di cutoff consentito (${q.market === 'EU' ? '11:30' : '17:30'} CET).`;
        countsByCategory.cutoffPassed++;
      }
    } else if (score < minScore) {
      primaryReasonCategory = 'SCORE_BELOW_MIN';
      primaryReasonLabel = `Punteggio sotto soglia (${score}/100 vs min ${minScore})`;
      detail = `Punteggio ${score}/100: confluenza tecnica debole tra gap, book e futures per ${isEU ? 'Europa' : 'USA'}.`;
      countsByCategory.scoreBelowMin++;
    } else {
      primaryReasonCategory = 'CUTOFF_PASSED';
      primaryReasonLabel = 'Orario di cutoff superato';
      detail = `Sessione oltre l'orario di cutoff consentito (${q.market === 'EU' ? '11:30' : '17:30'} CET).`;
      countsByCategory.cutoffPassed++;
    }

    excludedList.push({
      ticker: q.ticker,
      name: q.name,
      market: q.market,
      currency: q.currency,
      score,
      gapPercent: q.gapPercent,
      rvol: q.rvol,
      rsi,
      atr: q.atr14,
      primaryReasonCategory,
      primaryReasonLabel,
      detail,
    });
  });

  const excludedCount = excludedList.length;
  const qualifiedCount = qualifiedTickers.size;

  // Build bullet summary
  const bulletSummary: string[] = [];
  if (countsByCategory.gapInsufficient > 0) {
    bulletSummary.push(`${countsByCategory.gapInsufficient} per Gap % insufficiente (< ±${parameters.minGapEurope}% EU / ±${parameters.minGapUSA}% US)`);
  }
  if (countsByCategory.rvolInsufficient > 0) {
    bulletSummary.push(`${countsByCategory.rvolInsufficient} per Volume Relativo basso (< ${parameters.minRvol}x)`);
  }
  if (countsByCategory.rsiExtreme > 0) {
    bulletSummary.push(`${countsByCategory.rsiExtreme} per RSI fuori range (ipercomprato/ipervenduto)`);
  }
  if (countsByCategory.scoreBelowMin > 0) {
    bulletSummary.push(`${countsByCategory.scoreBelowMin} per Punteggio sotto soglia (< ${parameters.minScore}/100)`);
  }
  if (countsByCategory.catalystUnverified > 0) {
    bulletSummary.push(`${countsByCategory.catalystUnverified} per Catalizzatore non idoneo o rischio utili`);
  }
  if (countsByCategory.atrInsufficient > 0) {
    bulletSummary.push(`${countsByCategory.atrInsufficient} per Volatilità ATR non calcolabile`);
  }
  if (countsByCategory.cutoffPassed > 0) {
    bulletSummary.push(`${countsByCategory.cutoffPassed} per Orario di cutoff superato`);
  }
  if (countsByCategory.priceUnavailable > 0) {
    bulletSummary.push(`${countsByCategory.priceUnavailable} per Prezzo non disponibile`);
  }

  const topExclusionSummary = bulletSummary.slice(0, 3).join(', ');
  const briefNotificationMessage = `🔍 Audit Filtraggio: ${totalScanned} titoli analizzati • ${qualifiedCount} qualificati • ${excludedCount} scartati (${topExclusionSummary})`;

  return {
    totalScanned,
    qualifiedCount,
    excludedCount,
    timestamp: new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    countsByCategory,
    briefNotificationMessage,
    bulletSummary,
    excludedList,
  };
}

// -------------------------------------------------------------
// EXCLUDED SETUPS COUNTERFACTUAL & AUTO-ANALYSIS ENGINE
// -------------------------------------------------------------

/**
 * Builds a theoretical execution setup for an excluded candidate to track whether
 * it would have hit profit or stop loss had it not been filtered out.
 */
export function buildTheoreticalSetupForExcluded(
  candidate: ExcludedCandidateInfo,
  quote: RawQuoteData,
  parameters: SystemParameters
): ExcludedSetupRecord | null {
  const price = quote.currentPrice ?? quote.preMarketPrice;
  if (!price || price <= 0) return null;

  const gap = candidate.gapPercent ?? 0;
  const isLong = gap >= 0;
  const direction: 'LONG' | 'SHORT' = isLong ? 'LONG' : 'SHORT';

  let entryTrigger: number;
  let stopLoss: number;
  let riskDist: number;

  if (quote.orbHigh != null && quote.orbLow != null && quote.orbHigh > quote.orbLow) {
    entryTrigger = isLong ? quote.orbHigh : quote.orbLow;
    stopLoss = +(isLong
      ? quote.orbLow * (1 - TRADING_PARAMS.STOP_BUF)
      : quote.orbHigh * (1 + TRADING_PARAMS.STOP_BUF)
    ).toFixed(3);
    riskDist = Math.abs(entryTrigger - stopLoss);
  } else {
    const offsetPct = (parameters.triggerOffsetPercent || TRADING_PARAMS.FUT_NEUTRAL_BAND) / 100;
    entryTrigger = +(isLong ? price * (1 + offsetPct) : price * (1 - offsetPct)).toFixed(3);

    if (!quote.atr14 || quote.atr14 <= 0) return null;
    const atr = quote.atr14;
    riskDist = +(atr * (parameters.normalRiskMultiplier || 0.5)).toFixed(3);
    stopLoss = +(isLong ? entryTrigger - riskDist : entryTrigger + riskDist).toFixed(3);
  }

  const t1Mult = parameters.target1Multiplier || TRADING_PARAMS.T1_R;
  const target1 = +(isLong ? entryTrigger + riskDist * t1Mult : entryTrigger - riskDist * t1Mult).toFixed(3);

  const dateStr = new Date().toLocaleDateString('it-IT');
  const id = `ex-${candidate.ticker}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  return {
    id,
    ticker: candidate.ticker,
    name: candidate.name,
    market: candidate.market,
    currency: candidate.currency,
    sessionDate: dateStr,
    timestamp: new Date().toISOString(),
    score: candidate.score,
    gapPercent: candidate.gapPercent,
    rvol: candidate.rvol,
    rsi: candidate.rsi,
    atr: candidate.atr,
    primaryReasonCategory: candidate.primaryReasonCategory,
    primaryReasonLabel: candidate.primaryReasonLabel,
    detail: candidate.detail,
    direction,
    initialPrice: price,
    entryTrigger,
    stopLoss,
    target1,
    riskDist,
    currentPrice: price,
    outcomeStatus: 'MONITORING',
    theoreticalRMultiple: 0,
    theoreticalPnlEur: 0,
    notes: `Setup teorico monitorato post-esclusione: ${candidate.primaryReasonLabel}`,
  };
}

/**
 * Updates active monitored excluded setups against live market quotes tick-by-tick.
 */
export function updateExcludedSetupsWithLiveQuotes(
  records: ExcludedSetupRecord[],
  quotes: RawQuoteData[],
  currentCetMinutes?: number,
  accountCapital = 10000
): { updated: ExcludedSetupRecord[]; newlyResolvedCount: number } {
  let newlyResolvedCount = 0;

  const updated = records.map((record) => {
    if (record.outcomeStatus !== 'MONITORING') return record;

    const matchingQuote = quotes.find((q) => q.ticker === record.ticker);
    if (!matchingQuote) return record;

    const livePrice = matchingQuote.currentPrice ?? matchingQuote.preMarketPrice;
    if (livePrice == null || livePrice <= 0) return record;

    const isLong = record.direction === 'LONG';
    const entry = record.entryTrigger;
    const stop = record.stopLoss;
    const target = record.target1;
    const riskDist = record.riskDist > 0 ? record.riskDist : Math.abs(entry - stop);

    // 1. Target 1 Reached (Theoretical Profit)
    const hitTarget = isLong ? livePrice >= target : livePrice <= target;
    if (hitTarget) {
      newlyResolvedCount++;
      const rMultiple = +(Math.abs(target - entry) / (riskDist || 1)).toFixed(2);
      const pnlEur = +(rMultiple * (accountCapital * 0.01)).toFixed(2);
      return {
        ...record,
        currentPrice: livePrice,
        outcomeStatus: 'THEORETICAL_PROFIT' as const,
        theoreticalRMultiple: rMultiple,
        theoreticalPnlEur: pnlEur,
        resolvedAt: new Date().toISOString(),
        notes: `Raggiunto Target 1 a ${livePrice.toFixed(2)} ${record.currency} (+${rMultiple}R). Esclusione che ha impedito un profitto.`,
      };
    }

    // 2. Stop Loss Hit (Theoretical Loss)
    const hitStop = isLong ? livePrice <= stop : livePrice >= stop;
    if (hitStop) {
      newlyResolvedCount++;
      const pnlEur = -+(accountCapital * 0.01).toFixed(2);
      return {
        ...record,
        currentPrice: livePrice,
        outcomeStatus: 'THEORETICAL_STOP' as const,
        theoreticalRMultiple: -1.0,
        theoreticalPnlEur: pnlEur,
        resolvedAt: new Date().toISOString(),
        notes: `Attivato Stop Loss a ${livePrice.toFixed(2)} ${record.currency} (-1.0R). Il filtro ha salvato il capitale evitando una perdita reale.`,
      };
    }

    // 3. Cutoff Time Expiration
    if (currentCetMinutes != null) {
      const isEuCutoff = record.market === 'EU' && currentCetMinutes >= 690; // 11:30 CET
      const isUsCutoff = record.market === 'US' && currentCetMinutes >= 1050; // 17:30 CET
      if (isEuCutoff || isUsCutoff) {
        newlyResolvedCount++;
        const diff = isLong ? livePrice - entry : entry - livePrice;
        const rMultiple = riskDist > 0 ? +(diff / riskDist).toFixed(2) : 0;
        const pnlEur = +(rMultiple * (accountCapital * 0.01)).toFixed(2);
        return {
          ...record,
          currentPrice: livePrice,
          outcomeStatus: 'THEORETICAL_EXPIRED' as const,
          theoreticalRMultiple: rMultiple,
          theoreticalPnlEur: pnlEur,
          resolvedAt: new Date().toISOString(),
          notes: `Cutoff superato senza target né stop. Chiusura temporale a ${livePrice.toFixed(2)} ${record.currency}.`,
        };
      }
    }

    return {
      ...record,
      currentPrice: livePrice,
    };
  });

  return { updated, newlyResolvedCount };
}

/**
 * Runs rigorous auto-analysis on excluded setups, grouping by exclusion category,
 * determining whether too many excluded setups were actually profitable,
 * and proposing automated calibration improvements for the next trading session.
 */
export function runExcludedSetupsAutoAnalysis(
  records: ExcludedSetupRecord[],
  currentParams: SystemParameters = DEFAULT_SYSTEM_PARAMETERS,
  accountCapital = 10000
): ExcludedSetupsAutoAnalysis {
  const categoryOrder: ExclusionCategory[] = [
    'RSI_EXTREME',
    'RVOL_INSUFFICIENT',
    'GAP_INSUFFICIENT',
    'SCORE_BELOW_MIN',
    'CATALYST_UNVERIFIED',
    'ATR_INSUFFICIENT',
    'CUTOFF_PASSED',
    'PRICE_UNAVAILABLE',
  ];

  const categoryLabels: Record<ExclusionCategory, string> = {
    RSI_EXTREME: 'Filtro RSI Fuori Range (Ipercomprato / Ipervenduto)',
    RVOL_INSUFFICIENT: 'Filtro Volume Relativo Basso (RVOL)',
    GAP_INSUFFICIENT: 'Filtro Ampiezza Gap % d\'Apertura',
    SCORE_BELOW_MIN: 'Soglia Punteggio Minimo (minScore)',
    CATALYST_UNVERIFIED: 'Filtro Catalizzatore Fondamentale & Earnings',
    ATR_INSUFFICIENT: 'Filtro Volatilità Media ATR',
    CUTOFF_PASSED: 'Filtro Orario di Cutoff (11:30 / 17:30 CET)',
    PRICE_UNAVAILABLE: 'Filtro Feed Dati / Prezzo Assente',
  };

  const categories: ExcludedCategoryAnalysis[] = [];
  const urgentCorrections: ExcludedSetupsAutoAnalysis['urgentCorrections'] = [];

  let totalTracked = records.length;
  let totalProfitable = 0;
  let totalStopped = 0;
  let totalExpired = 0;
  let totalMonitoring = 0;
  let totalMissedPnlEur = 0;
  let totalCapitalSavedEur = 0;

  for (const cat of categoryOrder) {
    const catRecords = records.filter((r) => r.primaryReasonCategory === cat);
    const totalExcluded = catRecords.length;

    if (totalExcluded === 0) continue;

    const profitCount = catRecords.filter((r) => r.outcomeStatus === 'THEORETICAL_PROFIT').length;
    const lossCount = catRecords.filter((r) => r.outcomeStatus === 'THEORETICAL_STOP').length;
    const expiredCount = catRecords.filter((r) => r.outcomeStatus === 'THEORETICAL_EXPIRED').length;
    const monitoringCount = catRecords.filter((r) => r.outcomeStatus === 'MONITORING').length;

    totalProfitable += profitCount;
    totalStopped += lossCount;
    totalExpired += expiredCount;
    totalMonitoring += monitoringCount;

    const resolved = profitCount + lossCount + expiredCount;
    const winRate = resolved > 0 ? +((profitCount / resolved) * 100).toFixed(1) : 0;

    const missedPnlEur = +(catRecords.reduce((acc, r) => acc + (r.outcomeStatus === 'THEORETICAL_PROFIT' ? (r.theoreticalPnlEur || 0) : 0), 0)).toFixed(2);
    const savedPnlEur = +(catRecords.reduce((acc, r) => acc + (r.outcomeStatus === 'THEORETICAL_STOP' ? Math.abs(r.theoreticalPnlEur || 100) : 0), 0)).toFixed(2);

    totalMissedPnlEur += missedPnlEur;
    totalCapitalSavedEur += savedPnlEur;

    let verdict: ExcludedCategoryAnalysis['verdict'] = 'BALANCED';
    let verdictTitle = 'Filtro Bilanciato';
    let verdictDescription = 'Il filtro mostra un equilibrio fisiologico tra falsi positivi evitati e opportunità scartate.';
    let correctionProposal: ExcludedCategoryAnalysis['correctionProposal'] | undefined = undefined;

    // Check if TOO RESTRICTIVE (too many excluded went to profit)
    const isTooRestrictive = profitCount >= 2 && (winRate >= 55 || profitCount > lossCount);
    // Check if EFFECTIVE SHIELD (most excluded went to stop loss)
    const isEffectiveShield = lossCount >= 2 && lossCount > profitCount;

    if (isTooRestrictive) {
      verdict = 'TOO_RESTRICTIVE';
      verdictTitle = '⚠️ Filtro Troppo Severo (Troppi Profitti Persi)';
      verdictDescription = `${profitCount} setup su ${resolved} risolti (${winRate}%) sono andati a target con successo nonostante l'esclusione. Il filtro è eccessivamente restrittivo e sta frenando le performance della strategia.`;

      if (cat === 'RVOL_INSUFFICIENT') {
        const profitableRvols = catRecords
          .filter((r) => r.outcomeStatus === 'THEORETICAL_PROFIT' && typeof r.rvol === 'number' && r.rvol > 0)
          .map((r) => r.rvol as number);
        const minProfitableRvol = profitableRvols.length > 0 ? Math.min(...profitableRvols) : currentParams.minRvol - 0.20;
        const proposed = Math.max(0.65, +Math.min(currentParams.minRvol - 0.15, minProfitableRvol).toFixed(2));
        correctionProposal = {
          parameterKey: 'minRvol',
          label: 'Soglia Minima Volume Relativo (RVOL)',
          currentValue: `${currentParams.minRvol}x`,
          proposedValue: `${proposed}x`,
          actionType: 'REDUCE_PARAM',
          explanation: `Riduci la soglia minima di RVOL da ${currentParams.minRvol}x a ${proposed}x per includere nella prossima sessione titoli con volume relativo a partire da ${proposed}x che sono andati a target con successo.`,
        };
        urgentCorrections.push({
          category: cat,
          title: 'Allentamento Soglia RVOL',
          description: correctionProposal.explanation,
          parameterKey: 'minRvol',
          currentValue: currentParams.minRvol,
          proposedValue: proposed,
        });
      } else if (cat === 'GAP_INSUFFICIENT') {
        const profitableGaps = catRecords
          .filter((r) => r.outcomeStatus === 'THEORETICAL_PROFIT' && typeof r.gapPercent === 'number')
          .map((r) => Math.abs(r.gapPercent as number));
        const minProfitableGap = profitableGaps.length > 0 ? Math.min(...profitableGaps) : currentParams.minGapEurope - 0.15;
        const proposedEU = Math.max(0.15, +Math.min(currentParams.minGapEurope - 0.10, minProfitableGap).toFixed(2));
        correctionProposal = {
          parameterKey: 'minGapEurope',
          label: 'Soglia Minima Gap % Europa',
          currentValue: `${currentParams.minGapEurope}%`,
          proposedValue: `${proposedEU}%`,
          actionType: 'REDUCE_PARAM',
          explanation: `Abbassa il gap minimo europeo a ${proposedEU}% (e USA a ${(currentParams.minGapUSA * 0.8).toFixed(2)}%) per intercettare continuazioni di trend con gap a partire da ±${proposedEU}%.`,
        };
        urgentCorrections.push({
          category: cat,
          title: 'Riduzione Soglia Gap Minimo',
          description: correctionProposal.explanation,
          parameterKey: 'minGapEurope',
          currentValue: currentParams.minGapEurope,
          proposedValue: proposedEU,
        });
      } else if (cat === 'SCORE_BELOW_MIN') {
        const profitableScores = catRecords
          .filter((r) => r.outcomeStatus === 'THEORETICAL_PROFIT' && typeof r.score === 'number')
          .map((r) => r.score);
        const minProfitableScore = profitableScores.length > 0 ? Math.min(...profitableScores) : currentParams.minScore - 5;
        const proposedScore = Math.max(40, Math.min(currentParams.minScore - 5, minProfitableScore));
        correctionProposal = {
          parameterKey: 'minScore',
          label: 'Punteggio Minimo Algoritmico (minScore)',
          currentValue: `${currentParams.minScore}/100`,
          proposedValue: `${proposedScore}/100`,
          actionType: 'REDUCE_PARAM',
          explanation: `Riduci la soglia di sblocco setup da ${currentParams.minScore} a ${proposedScore}/100 per ammettere i setup con punteggio da ${proposedScore} in su che hanno dimostrato win rate del ${winRate}%.`,
        };
        urgentCorrections.push({
          category: cat,
          title: 'Abbassamento Soglia Punteggio',
          description: correctionProposal.explanation,
          parameterKey: 'minScore',
          currentValue: currentParams.minScore,
          proposedValue: proposedScore,
        });
      } else if (cat === 'RSI_EXTREME') {
        correctionProposal = {
          parameterKey: 'rsiFilterActive',
          label: 'Filtro Ipercomprato/Ipervenduto RSI (30/70)',
          currentValue: currentParams.rsiFilterActive ? 'Attivo' : 'Disattivo',
          proposedValue: 'Disattivo',
          actionType: 'TOGGLE_RSI',
          explanation: `In sessioni con forte spinta istituzionale, l'RSI estremo ha prodotto un win rate del ${winRate}% a profitto. Disattivando il blocco rigido RSI, i setup ad alto momentum non vengono scartati.`,
        };
        urgentCorrections.push({
          category: cat,
          title: 'Disattivazione Filtro RSI per Momentum',
          description: correctionProposal.explanation,
          parameterKey: 'rsiFilterActive',
          currentValue: currentParams.rsiFilterActive,
          proposedValue: false,
        });
      }
    } else if (isEffectiveShield) {
      verdict = 'EFFECTIVE_SHIELD';
      verdictTitle = '🛡️ Scudo Difensivo Efficace (Capitale Protetto)';
      verdictDescription = `Il filtro ha intercettato ${lossCount} stop loss su falsi segnali (${((lossCount / (resolved || 1)) * 100).toFixed(1)}%), risparmiando circa +${savedPnlEur} € di perdite certe. Mantieni il filtro rigorosamente attivo!`;
    } else if (resolved < 2) {
      verdict = 'INSUFFICIENT_SAMPLE';
      verdictTitle = 'Campione in Accumulazione';
      verdictDescription = `Dati storici insufficienti (${resolved} setup risolti) per decretare con certezza statistica se il filtro debba essere modificato. Continua il monitoraggio tick-by-tick.`;
    }

    categories.push({
      category: cat,
      label: categoryLabels[cat] || cat,
      totalExcluded,
      profitCount,
      lossCount,
      expiredCount,
      monitoringCount,
      winRate,
      missedPnlEur,
      savedPnlEur,
      verdict,
      verdictTitle,
      verdictDescription,
      correctionProposal,
    });
  }

  const totalResolved = totalProfitable + totalStopped + totalExpired;
  const overallMissedWinRate = totalResolved > 0 ? +((totalProfitable / totalResolved) * 100).toFixed(1) : 0;

  return {
    totalTracked,
    totalResolved,
    totalProfitable,
    totalStopped,
    totalExpired,
    totalMonitoring,
    overallMissedWinRate,
    totalMissedPnlEur: +totalMissedPnlEur.toFixed(2),
    totalCapitalSavedEur: +totalCapitalSavedEur.toFixed(2),
    categories,
    urgentCorrections,
    analyzedAt: new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
  };
}
