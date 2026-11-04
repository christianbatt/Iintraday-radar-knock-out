import {
  RawQuoteData,
  VwapSignalState,
  VwapStateName,
  VwapDataQuality,
  ScoredCandidate,
  ScoreBreakdown,
  ExecutionSetup,
  GeminiCatalystAnalysis,
  NewsItem,
  KnockOutCalculatorInput,
  KnockOutSafetyCheck,
  KnockOutBarrierGuard,
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
  MacroEvent,
  SessionInfo,
  SetupIndicators,
  SetupVetoReason,
} from '../types/radar';
import { TRADING_PARAMS, adxThresholds } from '../config/tradingParams';

export { adxThresholds };
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
 * RVOL ORB 15m = volume cumulato delle barre 5m della finestra ORB 15m /
 * media storica del volume cumulato della stessa finestra (ultime 20 sessioni).
 * - Una barra a volume 0 contribuisce 0 al cumulato e non produce rvol = 0 (se altre barre hanno volume > 0).
 * - Se il volume cumulato o la media storica non sono disponibili: rvol = null (mai 0).
 */
export function calculateOrbRvolFromBars(
  currentOrbBars: Array<{ volume?: number | null }>,
  historicalOrbVolumes20d: number[]
): number | null {
  if (!currentOrbBars || currentOrbBars.length === 0) {
    return null;
  }
  let currentCumVolume = 0;
  let hasValidBar = false;
  for (const bar of currentOrbBars) {
    if (bar.volume != null && !isNaN(bar.volume)) {
      currentCumVolume += Math.max(0, bar.volume);
      hasValidBar = true;
    }
  }
  if (!hasValidBar || currentCumVolume <= 0) {
    return null;
  }

  if (
    !historicalOrbVolumes20d ||
    historicalOrbVolumes20d.length === 0 ||
    historicalOrbVolumes20d.length < 20
  ) {
    return null;
  }

  const sample = historicalOrbVolumes20d.slice(-20);
  const sumHist = sample.reduce((acc, v) => acc + (v > 0 ? v : 0), 0);
  const avgHist = sumHist / sample.length;

  if (avgHist <= 0) {
    return null;
  }

  const rvol = +(currentCumVolume / avgHist).toFixed(2);
  return rvol > 0 ? rvol : null;
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
  direction?: 'LONG' | 'SHORT',
  asOfTime?: Date
): {
  orbHigh: number | null;
  orbLow: number | null;
  triggerLevel: number | null;
  stopLossLevel: number | null;
  firstBreakoutTime: string | null;
  firstBreakoutTimeLong: string | null;
  firstBreakoutTimeShort: string | null;
} {
  const emptyResult = {
    orbHigh: null,
    orbLow: null,
    triggerLevel: null,
    stopLossLevel: null,
    firstBreakoutTime: null,
    firstBreakoutTimeLong: null,
    firstBreakoutTimeShort: null,
  };

  if (!bars || bars.length === 0) {
    return emptyResult;
  }

  const openM =
    market === 'US'
      ? TRADING_PARAMS.US_OPEN_HOUR * 60 + TRADING_PARAMS.US_OPEN_MINUTE
      : TRADING_PARAMS.EU_OPEN_HOUR * 60 + TRADING_PARAMS.EU_OPEN_MINUTE;
  const orbEndM = openM + TRADING_PARAMS.ORB_MINUTES;

  // I tre slot attesi di 5 minuti: [openM, openM + 5, openM + 10]
  // EU: 09:00 (540), 09:05 (545), 09:10 (550)
  // US: 09:30 (570), 09:35 (575), 09:40 (580)
  const expectedSlots = [openM, openM + 5, openM + 10];

  const toDate = (ts: number | string | Date): Date => {
    if (ts instanceof Date) return ts;
    if (typeof ts === 'string') return new Date(ts);
    return new Date(ts > 1e11 ? ts : ts * 1000);
  };

  const refDateObj = referenceDate || toDate(bars[0].timestamp);
  const sessionDateStr = getExchangeDateStr(market, refDateObj);

  const slotMap = new Map<number, { high: number; low: number; close: number; dateObj: Date }>();
  const postOrbCandles: { high: number; low: number; close: number; dateObj: Date }[] = [];
  let hasDuplicateOrInvalid = false;

  for (const b of bars) {
    const d = toDate(b.timestamp);
    if (isNaN(d.getTime())) {
      hasDuplicateOrInvalid = true;
      continue;
    }

    // Validazione rigorosa prezzi OHLC
    if (
      b.high == null ||
      b.low == null ||
      b.close == null ||
      isNaN(b.high) ||
      isNaN(b.low) ||
      isNaN(b.close) ||
      b.high <= 0 ||
      b.low <= 0 ||
      b.close <= 0 ||
      b.high < b.low
    ) {
      hasDuplicateOrInvalid = true;
      continue;
    }

    const mt = getMarketTime(market, d);
    if (mt.dateFormatted !== sessionDateStr) continue;

    const startMin = mt.totalMinutes;

    if (startMin >= openM && startMin < orbEndM) {
      // Verifica allineamento intervallo 5m
      const offset = startMin - openM;
      if (offset % 5 !== 0 || !expectedSlots.includes(startMin)) {
        hasDuplicateOrInvalid = true;
        continue;
      }

      // Rifiuta barre duplicate per lo stesso intervallo 5m
      if (slotMap.has(startMin)) {
        hasDuplicateOrInvalid = true;
        continue;
      }

      // Se asOfTime è specificato, la barra è completa SOLO se l'intervallo 5m è già terminato
      if (asOfTime) {
        const asOfMt = getMarketTime(market, asOfTime);
        if (asOfMt.dateFormatted === sessionDateStr) {
          const slotEndMin = startMin + 5;
          if (asOfMt.totalMinutes < slotEndMin) {
            // Barra ancora in formazione: non completa
            continue;
          }
        }
      }

      slotMap.set(startMin, { high: b.high, low: b.low, close: b.close, dateObj: d });
    } else if (startMin >= orbEndM) {
      postOrbCandles.push({ high: b.high, low: b.low, close: b.close, dateObj: d });
    }
  }

  // Completezza ORB: devono essere presenti esattamente tutti e 3 gli slot previsti senza duplicati o anomalie
  const isComplete =
    !hasDuplicateOrInvalid &&
    expectedSlots.every((slot) => slotMap.has(slot));

  if (!isComplete) {
    return emptyResult;
  }

  const orbCandles = expectedSlots.map((slot) => slotMap.get(slot)!);
  const orbHigh = +Math.max(...orbCandles.map((c) => c.high)).toFixed(6);
  const orbLow = +Math.min(...orbCandles.map((c) => c.low)).toFixed(6);

  const effectiveDirection = direction ?? 'LONG';
  const triggerLevel = effectiveDirection === 'LONG' ? orbHigh : orbLow;
  const stopLossLevel = +(
    effectiveDirection === 'LONG'
      ? orbLow * (1 - TRADING_PARAMS.STOP_BUF)
      : orbHigh * (1 + TRADING_PARAMS.STOP_BUF)
  ).toFixed(6);

  // Calcolo e conservazione timestamp distinti per breakout LONG e SHORT
  // Ordiniamo le candele post-ORB cronologicamente
  postOrbCandles.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());

  let firstBreakoutTimeLong: string | null = null;
  let firstBreakoutTimeShort: string | null = null;

  for (const post of postOrbCandles) {
    if (firstBreakoutTimeLong === null && post.close > orbHigh + TRADING_PARAMS.EPSILON) {
      firstBreakoutTimeLong = post.dateObj.toISOString();
    }
    if (firstBreakoutTimeShort === null && post.close < orbLow - TRADING_PARAMS.EPSILON) {
      firstBreakoutTimeShort = post.dateObj.toISOString();
    }
    if (firstBreakoutTimeLong !== null && firstBreakoutTimeShort !== null) {
      break;
    }
  }

  // firstBreakoutTime corrisponde esclusivamente alla direzione valutata
  // Nessun default silenzioso LONG se la direzione richiesta è SHORT o non specificata
  const firstBreakoutTime =
    direction === 'LONG'
      ? firstBreakoutTimeLong
      : direction === 'SHORT'
      ? firstBreakoutTimeShort
      : null;

  return {
    orbHigh,
    orbLow,
    triggerLevel,
    stopLossLevel,
    firstBreakoutTime,
    firstBreakoutTimeLong,
    firstBreakoutTimeShort,
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
  const suppliedPnl = typeof tradeData.pnlEur === 'number' && Number.isFinite(tradeData.pnlEur)
    ? tradeData.pnlEur
    : null;
  let pnlEur = suppliedPnl ?? 0;
  let rMultiple = tradeData.rMultiple != null ? tradeData.rMultiple : 0;
  const potentialLossEur =
    typeof tradeData.potentialLossEur === 'number' && Number.isFinite(tradeData.potentialLossEur)
      ? tradeData.potentialLossEur
      : typeof tradeData.maxRiskEur === 'number' && Number.isFinite(tradeData.maxRiskEur)
      ? tradeData.maxRiskEur
      : null;
  const frictionEur =
    typeof tradeData.frictionEur === 'number' && Number.isFinite(tradeData.frictionEur)
      ? Math.max(0, tradeData.frictionEur)
      : 0;
  const baseEntry = tradeData.entryLevel ?? tradeData.triggerLevel ?? tradeData.entryPrice ?? null;
  const baseStop = tradeData.stopLossLevel ?? tradeData.stopLoss ?? null;
  const baseT1 = tradeData.target1Level ?? tradeData.target1 ?? null;
  let exitPrice = tradeData.exitPrice ?? baseT1 ?? baseEntry ?? 0;
  const status: 'OPEN' | 'CLOSED' = initialOutcome === 'OPEN' ? 'OPEN' : 'CLOSED';

  if (tradeData.status === 'CLOSED' && tradeData.exitPrice != null && tradeData.pnlEur != null && tradeData.rMultiple != null) {
    exitPrice = tradeData.exitPrice;
    rMultiple = tradeData.rMultiple;
    pnlEur = tradeData.pnlEur;
  } else if (initialOutcome === 'WIN') {
    exitPrice = baseT1 ?? exitPrice;
    rMultiple = +t1Mult.toFixed(2);
    if (suppliedPnl != null) {
      pnlEur = suppliedPnl;
    } else {
      const grossGain =
        typeof tradeData.potentialGainT1Eur === 'number'
          ? tradeData.potentialGainT1Eur
          : potentialLossEur != null
          ? potentialLossEur * rMultiple
          : null;
      if (grossGain == null) {
        throw new Error('PnL WIN non calcolabile: mancano potenziale T1 o rischio monetario effettivo');
      }
      pnlEur = +(grossGain - frictionEur).toFixed(2);
    }
  } else if (initialOutcome === 'LOSS') {
    exitPrice = baseStop ?? exitPrice;
    rMultiple = -1.0;
    if (suppliedPnl != null) {
      pnlEur = suppliedPnl;
    } else if (potentialLossEur != null) {
      pnlEur = +(-potentialLossEur - frictionEur).toFixed(2);
    } else {
      throw new Error('PnL LOSS non calcolabile: manca il rischio monetario effettivo');
    }
  } else if (initialOutcome === 'EXPIRED' || initialOutcome === 'BREAKEVEN') {
    exitPrice = baseEntry ?? exitPrice;
    rMultiple = 0;
    pnlEur = suppliedPnl ?? -frictionEur;
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
    potentialLossEur: tradeData.potentialLossEur,
    potentialGainT1Eur: tradeData.potentialGainT1Eur,
    potentialGainT2Eur: tradeData.potentialGainT2Eur,
    frictionEur: tradeData.frictionEur,
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
  minRvolEurope: TRADING_PARAMS.MIN_RVOL_EU,
  minRvolUSA: TRADING_PARAMS.MIN_RVOL_US,
  minAvgVolume: 350000,
  normalRiskMultiplier: 0.50,
  target1Multiplier: TRADING_PARAMS.T1_R,
  target2Multiplier: TRADING_PARAMS.T2_R,
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

/**
 * Conversione proporzionale dei componenti storici nel nuovo peso:
 * component = min(W_x, oldPoints * W_x / oldMax), arrotondato all'intero.
 * Vale anche per i contributi negativi (order flow contrario).
 */
export function scaleComponentToWeight(oldPoints: number, weight: number, oldMax: number): number {
  if (
    !Number.isFinite(oldPoints) ||
    !Number.isFinite(weight) ||
    !Number.isFinite(oldMax) ||
    oldMax <= 0
  ) {
    return 0;
  }
  return Math.round(Math.min(weight, (oldPoints * weight) / oldMax));
}

/**
 * WARMUP_INCOMPLETE (IPOTESI): Supertrend, ADX o StochRSI UNKNOWN (o indicatori del tutto
 * assenti). Il candidato resta visibile con il suo punteggio ma non puo essere Top Pick
 * ne essere raccomandato dall'AI, e non riceve soglie piu' basse ne punti rinormalizzati.
 */
export function isWarmupIncomplete(indicators: SetupIndicators | null | undefined): boolean {
  if (!indicators) return true;
  return (
    indicators.supertrend.status !== 'OK' ||
    indicators.adx.status !== 'OK' ||
    indicators.stochRsi.status !== 'OK'
  );
}

/**
 * Veti del setup (IPOTESI): ADX di trend assente, Supertrend contrario, VWAP contraria
 * con volume confermato (solo se VWAP_VETO_ENABLED). Un veto scarta il candidato
 * indipendentemente dal punteggio.
 */
export function evaluateSetupVetoes(
  direction: 'LONG' | 'SHORT',
  indicators: SetupIndicators | null | undefined,
  vwapState: VwapSignalState | null | undefined,
  market: 'EU' | 'US' = 'US'
): SetupVetoReason[] {
  const reasons: SetupVetoReason[] = [];
  const dirSign = direction === 'LONG' ? 1 : -1;

  const st = indicators?.supertrend;
  if (st?.status === 'OK' && st.direction !== 0 && st.direction !== dirSign) {
    reasons.push('SUPERTREND_OPPOSED');
  }

  const adx = indicators?.adx;
  const adxMin = adxThresholds(market).min;
  if (adx?.status === 'OK' && adx.value != null && adx.value < adxMin) {
    reasons.push('ADX_BELOW_MARKET_THRESHOLD');
  }

  if (TRADING_PARAMS.VWAP_VETO_ENABLED && isVwapStateOpposed(vwapState, direction)) {
    const confirmed =
      vwapState?.volumeRatio != null &&
      Number.isFinite(vwapState.volumeRatio) &&
      vwapState.volumeRatio >= TRADING_PARAMS.VWAP_MIN_VOLUME_RATIO;
    if (confirmed) reasons.push('VWAP_OPPOSED');
  }

  return reasons;
}

export function calculateCandidateScore(
  quote: RawQuoteData,
  benchmarkFuturesChangePercent: number | null | undefined,
  newsOrCatalyst?: GeminiCatalystAnalysis | NewsItem[] | number | null,
  vwapBar?: VwapBarContext
): ScoreBreakdown {
  const details: string[] = [];
  const P = TRADING_PARAMS;
  const LEGACY = P.SCORE_LEGACY_MAX;

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
      supertrendScore: 0,
      adxScore: 0,
      stochRsiScore: 0,
      psarScore: 0,
      veto: null,
      vetoReasons: [],
      warmupIncomplete: isWarmupIncomplete(quote.setupIndicators),
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
  const direction: 'LONG' | 'SHORT' = isCandidateLong ? 'LONG' : 'SHORT';
  const dirSign: 1 | -1 = isCandidateLong ? 1 : -1;

  const eps = P.EPSILON;

  // 1. GAP (legacy max 25 -> peso W_GAP) - Normalized by Volatility (ATR-scaled Gap)
  let gapLegacy = 0;
  const cIeri = quote.prevClose;
  const oOggi = quote.todayOpen ?? price;
  if (quote.atr14 != null && quote.atr14 > 0 && cIeri != null && cIeri > 0) {
    const atrPct = (quote.atr14 / cIeri) * 100;
    const calcGapPct = quote.gapPercent != null ? quote.gapPercent : ((oOggi - cIeri) / cIeri) * 100;
    const absGap = Math.abs(calcGapPct);
    const gapToAtrRatio = absGap / atrPct;

    let matchedTier = false;
    for (const tier of P.GAP_ATR_TIERS) {
      if (gapToAtrRatio + eps >= tier.minRatio) {
        gapLegacy = tier.points;
        matchedTier = true;
        break;
      }
    }
    if (!matchedTier) gapLegacy = P.GAP_ATR_MIN_POINTS;
    const gapScore = scaleComponentToWeight(gapLegacy, P.W_GAP, LEGACY.GAP);
    details.push(
      `Gap normalizzato per ATR (${gapToAtrRatio.toFixed(2)}x ATR | ${absGap.toFixed(2)}% vs ATR ${atrPct.toFixed(2)}%): +${gapScore}pt (peso ${P.W_GAP})`
    );
  } else {
    details.push(`ATR(14) o Close ieri non disponibile dal feed: 0pt (nessun punteggio per dati mancanti)`);
  }
  const gapScore = scaleComponentToWeight(gapLegacy, P.W_GAP, LEGACY.GAP);

  // 2. RVOL (legacy max 25 -> peso W_RVOL) - Only from real volume
  let rvolLegacy = 0;
  if (quote.rvol != null) {
    const rvol = quote.rvol;
    let matchedRvol = false;
    for (const tier of P.RVOL_TIERS) {
      if (rvol + eps >= tier.minRvol) {
        rvolLegacy = tier.points;
        matchedRvol = true;
        break;
      }
    }
    if (!matchedRvol) rvolLegacy = P.RVOL_MIN_POINTS;

    if (quote.rvol20m != null && quote.rvol20m + eps >= P.RVOL_SPIKE_20M_THRESHOLD) {
      if (rvolLegacy < LEGACY.RVOL) {
        rvolLegacy = Math.min(LEGACY.RVOL, rvolLegacy + P.RVOL_SPIKE_20M_BONUS);
        details.push(
          `🔥 Spike Volumi ultimi 20m (${quote.rvol20m.toFixed(2)}x vs media 20m): bonus ${P.RVOL_SPIKE_20M_BONUS}pt legacy.`
        );
      }
    }
    const rvolScore = scaleComponentToWeight(rvolLegacy, P.W_RVOL, LEGACY.RVOL);
    details.push(`Relative Volume (RVOL ${rvol.toFixed(2)}x): +${rvolScore}pt (peso ${P.W_RVOL})`);
  } else {
    details.push('Relative Volume (RVOL N/D): +0pt (punteggio neutro)');
  }
  const rvolScore = scaleComponentToWeight(rvolLegacy, P.W_RVOL, LEGACY.RVOL);

  // 3. LIQUIDITÀ GATE G1 (Esclusa dal calcolo punteggio, 0pt)
  const liquidityScore = P.SCORE_MAX_COMPONENTS.LIQUIDITY;
  details.push('Liquidità verificata come Gate G1 (esclusa dal calcolo del punteggio, 0pt).');

  // 4. FUTURES COHERENCE (legacy max 20 -> peso W_FUTURES)
  let futuresLegacy = 0;
  if (benchmarkFuturesChangePercent == null || isNaN(benchmarkFuturesChangePercent)) {
    futuresLegacy = P.FUT_SCORE_MISSING;
    details.push('Dati futures benchmark non disponibili: 0pt');
  } else if (Math.abs(benchmarkFuturesChangePercent) <= P.FUT_NEUTRAL_BAND + eps) {
    futuresLegacy = P.FUT_SCORE_NEUTRAL;
    details.push(
      `Futures indice neutrali (|chg| <= ${P.FUT_NEUTRAL_BAND}% | ${benchmarkFuturesChangePercent.toFixed(2)}%)`
    );
  } else {
    const isFuturesGreen = benchmarkFuturesChangePercent > P.FUT_NEUTRAL_BAND;
    const isFuturesRed = benchmarkFuturesChangePercent < -P.FUT_NEUTRAL_BAND;
    if ((isCandidateLong && isFuturesGreen) || (!isCandidateLong && isFuturesRed)) {
      futuresLegacy = P.FUT_SCORE_ALIGNED;
      details.push(
        `Allineamento totale titolo/futures indice (${benchmarkFuturesChangePercent > 0 ? '+' : ''}${benchmarkFuturesChangePercent.toFixed(2)}%)`
      );
    } else {
      futuresLegacy = P.FUT_SCORE_DIVERGENT;
      details.push(
        `Divergenza con futures indice (${benchmarkFuturesChangePercent > 0 ? '+' : ''}${benchmarkFuturesChangePercent.toFixed(2)}%)`
      );
    }
  }
  const futuresScore = scaleComponentToWeight(futuresLegacy, P.W_FUTURES, LEGACY.FUTURES);
  details.push(`Futures benchmark: +${futuresScore}pt (peso ${P.W_FUTURES})`);

  // 5. KEY LEVELS PROXIMITY (legacy max 10 -> peso W_LEVELS) - Real yesterday High / Low
  let levelLegacy = 0;
  const prevHigh = quote.prevHigh;
  const prevLow = quote.prevLow;
  const proxFactor = P.LEVEL_PROXIMITY_FACTOR;

  if (price > 0 && prevHigh != null && prevLow != null) {
    if (isCandidateLong && price + eps >= prevHigh) {
      levelLegacy = 10;
      details.push(`Rottura/apertura sopra il Massimo reale di ieri (${prevHigh.toFixed(2)})`);
    } else if (!isCandidateLong && price - eps <= prevLow) {
      levelLegacy = 10;
      details.push(`Rottura/apertura sotto il Minimo reale di ieri (${prevLow.toFixed(2)})`);
    } else if (isCandidateLong && price + eps >= prevHigh * (1 - proxFactor)) {
      levelLegacy = 7;
      details.push(`Prezzo a ridosso del Massimo di ieri (${prevHigh.toFixed(2)})`);
    } else if (!isCandidateLong && price - eps <= prevLow * (1 + proxFactor)) {
      levelLegacy = 7;
      details.push(`Prezzo a ridosso del Minimo di ieri (${prevLow.toFixed(2)})`);
    } else {
      levelLegacy = 5;
      details.push(`Prezzo all'interno del range di ieri`);
    }
  } else {
    details.push('Livelli High/Low ieri non disponibili: 0pt');
  }
  const levelScore = scaleComponentToWeight(levelLegacy, P.W_LEVELS, LEGACY.LEVELS);
  if (levelLegacy > 0) details.push(`Livelli chiave: +${levelScore}pt (peso ${P.W_LEVELS})`);

  // 6. RSI (escluso dallo score: W_RSI = 0, sostituito da StochRSI)
  const rsiScore = 0;
  details.push('RSI escluso dallo score (W_RSI=0): sostituito da StochRSI 5m.');

  // 7. NEWS & CATALYST BONUS (legacy max 15 -> peso W_NEWS)
  let newsLegacy = 0;
  if (typeof newsOrCatalyst === 'number') {
    newsLegacy = Math.max(0, Math.min(LEGACY.NEWS, newsOrCatalyst));
    details.push(`Bonus catalizzatore numerico esplicito: ${newsLegacy}pt legacy`);
  } else if (newsOrCatalyst && typeof newsOrCatalyst === 'object') {
    if ('newsBonusScore' in newsOrCatalyst && typeof (newsOrCatalyst as any).newsBonusScore === 'number') {
      newsLegacy = Math.max(0, Math.min(LEGACY.NEWS, (newsOrCatalyst as any).newsBonusScore));
      details.push(`Bonus catalizzatore verificato: ${newsLegacy}pt legacy (vincolato a 0..${LEGACY.NEWS}pt)`);
    } else if ('catalizzatore' in newsOrCatalyst) {
      const cat = newsOrCatalyst as GeminiCatalystAnalysis;
      const text = `${cat.catalizzatore || ''} ${(cat.punti_a_favore || []).join(' ')}`.toLowerCase();
      if (
        text.includes('earnings') ||
        text.includes('utili') ||
        text.includes('trimestrale') ||
        text.includes('bilancio')
      ) {
        details.push(
          '⚠️ Rilascio Utili/Earnings in giornata: bonus news neutralizzato a 0pt per rischio binario (nessun bonus keyword)'
        );
      } else {
        details.push(
          'Contributo notizie neutro (0pt): nessun bonus automatico da keyword, fonti o parole isolate'
        );
      }
    } else {
      details.push('Contributo notizie neutro (0pt): nessun bonus da parole isolate o timestamp recenti');
    }
  } else {
    details.push('Nessuna notizia o catalizzatore verificato: 0pt');
  }

  if (
    newsLegacy > 0 &&
    typeof newsOrCatalyst === 'object' &&
    newsOrCatalyst !== null &&
    'direzione' in newsOrCatalyst
  ) {
    const catDir = (newsOrCatalyst as GeminiCatalystAnalysis).direzione;
    const isContrarian =
      (catDir === 'LONG' &&
        ((quote.gapPercent ?? 0) < -0.3 || (quote.vwap != null && price != null && price < quote.vwap * (1 - proxFactor)))) ||
      (catDir === 'SHORT' &&
        ((quote.gapPercent ?? 0) > 0.3 || (quote.vwap != null && price != null && price > quote.vwap * (1 + proxFactor))));
    if (isContrarian) {
      const reducedBonus = Math.min(3, Math.floor(newsLegacy * 0.25));
      details.push(`⚠️ Notizia ${catDir} in contrasto con azione di prezzo: bonus ridotto a ${reducedBonus}pt legacy`);
      newsLegacy = reducedBonus;
    }
  }
  const newsScore = scaleComponentToWeight(newsLegacy, P.W_NEWS, LEGACY.NEWS);
  details.push(`Catalizzatore/news: +${newsScore}pt (peso ${P.W_NEWS})`);

  // 8. TREND MACRO EMA(20) daily (escluso dallo score: W_TREND = 0)
  const trendScore = 0;
  details.push('Confluenza EMA20 daily esclusa dallo score (W_TREND=0).');

  // 9. ORDER FLOW L2 (-legacy..+legacy -> peso W_ORDER_FLOW)
  let orderFlowLegacy = 0;
  const of = quote.orderFlow;
  const strongOfPct = P.ORDER_FLOW_STRONG_PCT;
  const modOfPct = P.ORDER_FLOW_MOD_PCT;
  if (of) {
    if (of.flowQuality === 'ABSORPTION_TRAP' || of.cvdTrend === 'ABSORPTION_TRAP') {
      orderFlowLegacy = -10;
      details.push(`⚠️ Trappola di Assorbimento Delta`);
    } else if (isCandidateLong) {
      if (of.buyerVolumePercent >= strongOfPct && of.cvdTrend === 'EXPANDING_UP' && of.isPriceAboveVpoc) {
        orderFlowLegacy = 10;
        details.push(`🔥 Order Flow Bullish Istituzionale`);
      } else if (of.buyerVolumePercent >= modOfPct && of.cvdTrend !== 'EXPANDING_DOWN') {
        orderFlowLegacy = 6;
        details.push(`Order Flow a Favore`);
      } else if (of.sellerVolumePercent >= strongOfPct) {
        orderFlowLegacy = -6;
        details.push(`Allerta Delta Contrario`);
      } else {
        orderFlowLegacy = 2;
        details.push(`Order Flow Bilanciato`);
      }
    } else {
      if (of.sellerVolumePercent >= strongOfPct && of.cvdTrend === 'EXPANDING_DOWN' && of.isPriceAboveVpoc === false) {
        orderFlowLegacy = 10;
        details.push(`🔥 Order Flow Bearish Istituzionale`);
      } else if (of.sellerVolumePercent >= modOfPct && of.cvdTrend !== 'EXPANDING_UP') {
        orderFlowLegacy = 6;
        details.push(`Order Flow a Favore`);
      } else if (of.buyerVolumePercent >= strongOfPct) {
        orderFlowLegacy = -6;
        details.push(`Allerta Delta Contrario`);
      } else {
        orderFlowLegacy = 2;
        details.push(`Order Flow Bilanciato`);
      }
    }
  }
  const orderFlowScore = scaleComponentToWeight(orderFlowLegacy, P.W_ORDER_FLOW, LEGACY.ORDER_FLOW);
  if (of) details.push(`Order Flow: ${orderFlowScore >= 0 ? '+' : ''}${orderFlowScore}pt (peso ${P.W_ORDER_FLOW})`);

  // 10. INDICATORI DI SETUP 5m: Supertrend, ADX, StochRSI (IPOTESI, barre chiuse sessione regolare)
  const indicators: SetupIndicators | null | undefined = quote.setupIndicators;
  if (!indicators) {
    details.push('Indicatori 5m non disponibili: Supertrend/ADX/StochRSI 0pt (dato assente, non segnale negativo).');
  }

  // 10a. Supertrend (max W_SUPERTREND)
  let supertrendScore = 0;
  const st = indicators?.supertrend;
  if (st?.status === 'OK' && st.direction === dirSign) {
    const recent = st.barsSinceFlip != null && st.barsSinceFlip <= P.ST_FLIP_RECENT_BARS;
    supertrendScore = recent ? P.W_SUPERTREND : Math.round(P.W_SUPERTREND / 2);
    details.push(
      `Supertrend 5m: ${dirSign === 1 ? 'LONG' : 'SHORT'} | flip ${st.barsSinceFlip ?? 'nd'} barre fa | +${supertrendScore}pt`
    );
  } else if (st?.status === 'OK' && st.direction !== 0) {
    details.push(`Supertrend 5m contrario al setup (direction ${st.direction}): 0pt + veto`);
  } else if (st) {
    details.push(`Supertrend 5m: UNKNOWN (${st.reason}) | 0pt`);
  }
  const psarScore = P.SCORE_MAX_COMPONENTS.PSAR; // sempre 0: PSAR = stop e uscita
  if (indicators?.psar) {
    const ps = indicators.psar;
    details.push(
      ps.status === 'OK'
        ? `PSAR: ${ps.value ?? 'nd'} ${ps.direction === 1 ? 'LONG' : ps.direction === -1 ? 'SHORT' : 'nd'} | 0pt (stop e uscita)`
        : `PSAR: UNKNOWN (${ps.reason}) | 0pt (stop e uscita)`
    );
  }

  // 10b. ADX (max W_ADX): soglie per mercato, DI allineato alla direzione del setup
  let adxScore = 0;
  const adx = indicators?.adx;
  const adxThreshold = adxThresholds(quote.market);
  if (adx?.status === 'OK' && adx.value != null) {
    const diAligned = adx.plusDI != null && adx.minusDI != null && (dirSign === 1 ? adx.plusDI > adx.minusDI : adx.minusDI > adx.plusDI);
    if (adx.value >= adxThreshold.strong && diAligned) {
      adxScore = P.W_ADX;
      details.push(`ADX 5m ${adx.value.toFixed(1)} (+DI ${adx.plusDI?.toFixed(1)} / -DI ${adx.minusDI?.toFixed(1)}) | trend forte ${quote.market} (>= ${adxThreshold.strong}) | +${adxScore}pt`);
    } else if (adx.value >= adxThreshold.min && diAligned) {
      adxScore = Math.round((P.W_ADX * 4) / 7);
      details.push(`ADX 5m ${adx.value.toFixed(1)} (+DI ${adx.plusDI?.toFixed(1)} / -DI ${adx.minusDI?.toFixed(1)}) | trend moderato ${quote.market} (${adxThreshold.min}-${adxThreshold.strong}) | +${adxScore}pt`);
    } else if (adx.value < adxThreshold.min) {
      details.push(`ADX 5m ${adx.value.toFixed(1)} < ${adxThreshold.min} (${quote.market}): trend assente | 0pt + veto ADX_BELOW_MARKET_THRESHOLD`);
    } else {
      details.push(`ADX 5m ${adx.value.toFixed(1)} con DI contrario al setup: 0pt (nessun veto, direzione coperta dal Supertrend)`);
    }
  } else if (adx) {
    details.push(`ADX 5m: UNKNOWN (${adx.reason}) | 0pt`);
  }

  // 10c. StochRSI (max W_STOCH_RSI): incrocio valido allineato, altrimenti solo K allineato a D
  let stochRsiScore = 0;
  const sr = indicators?.stochRsi;
  if (sr?.status === 'OK' && sr.k != null && sr.d != null) {
    const crossAligned =
      sr.lastCross === direction &&
      sr.barsSinceCross != null &&
      sr.barsSinceCross <= P.STOCH_RSI_CROSS_LOOKBACK &&
      (direction === 'LONG'
        ? sr.k <= P.STOCH_RSI_LONG_CROSS_MAX && sr.k < P.STOCH_RSI_EXTREME_HI
        : sr.k >= P.STOCH_RSI_SHORT_CROSS_MIN && sr.k > P.STOCH_RSI_EXTREME_LO);
    const kAligned = direction === 'LONG' ? sr.k > sr.d : sr.k < sr.d;
    if (crossAligned) {
      stochRsiScore = P.W_STOCH_RSI;
      details.push(
        `StochRSI K ${sr.k.toFixed(1)} / D ${sr.d.toFixed(1)} | incrocio ${sr.lastCross} ${sr.barsSinceCross} barre fa | +${stochRsiScore}pt`
      );
    } else if (kAligned) {
      stochRsiScore = Math.round(P.W_STOCH_RSI * (3 / 9));
      details.push(`StochRSI K ${sr.k.toFixed(1)} / D ${sr.d.toFixed(1)} | K allineato senza incrocio recente | +${stochRsiScore}pt`);
    } else {
      details.push(`StochRSI K ${sr.k.toFixed(1)} / D ${sr.d.toFixed(1)} | non allineato | 0pt`);
    }
  } else if (sr) {
    details.push(`StochRSI: UNKNOWN (${sr.reason}) | 0pt`);
  }

  // 11. VWAP DI SESSIONE (0..W_VWAP): logica con quality gate, contributo mai negativo
  const effectiveVwapState = resolveVwapStateForScoring(
    quote.vwapState ?? null,
    vwapBar,
    quote.market,
    quote.vwapDataQuality ?? null
  );
  const vwapContribution = calculateVwapScoreContribution(effectiveVwapState, direction);
  const vwapScore = vwapContribution.score;
  const vwapLine = vwapContribution.detail;
  details.push(vwapLine);

  // 12. VETI: indipendenti dallo score, scartano il setup (soglie ADX del mercato)
  const vetoReasons = evaluateSetupVetoes(direction, indicators, effectiveVwapState, quote.market);
  for (const reason of vetoReasons) details.push(`VETO: ${reason} - setup scartato indipendentemente dallo score.`);

  // 13. WARMUP_INCOMPLETE: indicatori di setup UNKNOWN -> nessuna raccomandazione, nessuna rinormalizzazione
  const warmupIncomplete = isWarmupIncomplete(indicators);
  if (warmupIncomplete) {
    details.push(
      `${P.WARMUP_INCOMPLETE}: Supertrend/ADX/StochRSI non tutti OK | candidato visibile ma non raccomandabile e non Top Pick | nessun punto rinormalizzato`
    );
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
    orderFlowScore +
    supertrendScore +
    adxScore +
    stochRsiScore +
    psarScore +
    vwapScore;
  const total = Math.max(0, Math.min(P.SCORE_MAX_COMPONENTS.CAPPED_MAX, Math.round(rawTotal)));

  const scoreBreakdown: Record<string, number> = {
    gap: gapScore,
    rvol: rvolScore,
    vwap: vwapScore,
    supertrend: supertrendScore,
    adx: adxScore,
    stochRsi: stochRsiScore,
    psar: psarScore,
    levels: levelScore,
    futures: futuresScore,
    news: newsScore,
    orderFlow: orderFlowScore,
    liquidity: liquidityScore,
    rsi: rsiScore,
    trend: trendScore,
  };

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
    supertrendScore,
    adxScore,
    stochRsiScore,
    psarScore,
    scoreBreakdown,
    veto: vetoReasons[0] ?? null,
    vetoReasons,
    warmupIncomplete,
    vwapScore,
    vwapLine,
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
  if (!closes || closes.length < period + 1) return null;
  const p = period;
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
    ? (params?.minRvolEurope ?? params?.minRvol ?? TRADING_PARAMS.MIN_RVOL_EU)
    : (params?.minRvolUSA ?? params?.minRvol ?? TRADING_PARAMS.MIN_RVOL_US);
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

/**
 * Calculates safety distance, safe barrier level, and max recommended leverage for Trade Republic Knock-Outs
 */
export function calculateKnockOutBarrierGuard(
  quote: RawQuoteData,
  direction?: 'LONG' | 'SHORT'
): KnockOutBarrierGuard {
  const dir = direction ?? ((quote.gapPercent ?? 0) >= 0 ? 'LONG' : 'SHORT');
  const price = quote.preMarketPrice ?? quote.currentPrice ?? quote.prevClose ?? 0;
  const atr = quote.atr14 ?? (price > 0 ? +(price * 0.02).toFixed(2) : 1.0);
  const spreadBufferEur = quote.market === 'EU' ? 0.04 : 0.12;
  const eps = TRADING_PARAMS.EPSILON;

  // Se T ed S sono già definiti dall'ORB o dal freeze, utilizziamo l'unica formula canonica deterministica V112
  if (quote.T != null && quote.S != null && quote.T > 0 && quote.S > 0) {
    const T = quote.T;
    const S = quote.S;
    const dS = Math.abs(T - S) / T;
    const eligibleLevers = TRADING_PARAMS.LEVE.filter(
      (l) => dS * l <= TRADING_PARAMS.LMAX + eps && 1 / l + eps >= dS + TRADING_PARAMS.BUF_BAR
    );

    if (eligibleLevers.length > 0) {
      const maxRecommendedLeverage = Math.max(...eligibleLevers);
      const safeBarrierLevel = +(
        dir === 'LONG'
          ? T * (1 - 1 / maxRecommendedLeverage)
          : T * (1 + 1 / maxRecommendedLeverage)
      ).toFixed(2);
      const safeDistanceAtr = +Math.abs(T - safeBarrierLevel).toFixed(2);

      let leverageRiskLevel: 'SAFE' | 'MODERATE' | 'AGGRESSIVE' = 'SAFE';
      if (maxRecommendedLeverage >= 9 && maxRecommendedLeverage <= 15) {
        leverageRiskLevel = 'MODERATE';
      } else if (maxRecommendedLeverage > 15) {
        leverageRiskLevel = 'AGGRESSIVE';
      }

      return {
        safeDistanceAtr,
        safeBarrierLevel: Math.max(0.01, safeBarrierLevel),
        maxRecommendedLeverage,
        leverageRiskLevel,
        spreadBufferEur,
        tradeRepublicTip: `Barriera KO V112: ${safeBarrierLevel} ${quote.currency} (distanza ${safeDistanceAtr}). Leva calibrata: ${maxRecommendedLeverage}x.`,
        isExecutableSetup: true,
      };
    } else {
      // Nessuna leva compatibile nel grid LEVE (es. dS troppo grande o L_sel < 1)
      return {
        safeDistanceAtr: +(atr * 1.5).toFixed(2),
        safeBarrierLevel: null,
        maxRecommendedLeverage: null,
        leverageRiskLevel: 'SAFE',
        spreadBufferEur,
        tradeRepublicTip: 'Nessuna leva Turbo compatibile con la distanza dello stop (L_sel < 1 o rischio KO eccessivo).',
        isExecutableSetup: false,
      };
    }
  }

  // Pre-ORB / T o S non ancora definiti: la logica ATR 1.5x è solo informativa di sicurezza, MAI raccomandazione eseguibile
  const safeDistanceAtr = +(atr * 1.5).toFixed(2);
  return {
    safeDistanceAtr,
    safeBarrierLevel: null,
    maxRecommendedLeverage: null,
    leverageRiskLevel: 'SAFE',
    spreadBufferEur,
    tradeRepublicTip: `Controllo sicurezza indicativo pre-ORB: distanza ±${safeDistanceAtr} ${quote.currency} (1.5x ATR). Barriera eseguibile non disponibile fino a definizione ORB (T ed S).`,
    isExecutableSetup: false,
  };
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

  if (TRADING_PARAMS.VWAP_HARD_GATE) {
    marketQuotes = marketQuotes.filter((q) =>
      passesVwapHardGate(q.vwapState ?? null, (q.gapPercent ?? 0) >= 0 ? 'LONG' : 'SHORT')
    );
  }

  const change =
    typeof futuresChange === 'number'
      ? futuresChange
      : market === 'US'
      ? futuresChange.US
      : futuresChange.EU;

  const scored = marketQuotes.map((quote) => {
    const catalystOrNews = options?.catalystCache?.[quote.ticker] || options?.newsCache?.[quote.ticker];
    const dir: 'LONG' | 'SHORT' = (quote.gapPercent ?? 0) >= 0 ? 'LONG' : 'SHORT';
    const knockOutGuard = calculateKnockOutBarrierGuard(quote, dir);
    return {
      quote,
      score: calculateCandidateScore(quote, change, catalystOrNews, {
        volume: quote.lastBarVolume ?? null,
        barTime: quote.lastBarTime ?? null,
      }),
      rank: 0,
      knockOutGuard,
    };
  });

  const eligible = scored.filter((item) => item.score.veto == null);
  eligible.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    const rawB = b.score.rawTotal ?? b.score.total;
    const rawA = a.score.rawTotal ?? a.score.total;
    if (rawB !== rawA) return rawB - rawA;
    const rvolB = b.quote.rvol ?? 0;
    const rvolA = a.quote.rvol ?? 0;
    if (rvolB !== rvolA) return rvolB - rvolA;
    return Math.abs(b.quote.gapPercent ?? 0) - Math.abs(a.quote.gapPercent ?? 0);
  });

  return eligible.map((item, index) => ({
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

  if (TRADING_PARAMS.VWAP_HARD_GATE) {
    targetQuotes = targetQuotes.filter((q) =>
      passesVwapHardGate(q.vwapState ?? null, (q.gapPercent ?? 0) >= 0 ? 'LONG' : 'SHORT')
    );
  }

  const scored = targetQuotes.map((quote) => {
    const change =
      typeof futuresChange === 'number'
        ? futuresChange
        : quote.market === 'US'
        ? futuresChange.US
        : futuresChange.EU;
    const catalystOrNews = options?.catalystCache?.[quote.ticker] || options?.newsCache?.[quote.ticker];
    const dir: 'LONG' | 'SHORT' = (quote.gapPercent ?? 0) >= 0 ? 'LONG' : 'SHORT';
    const knockOutGuard = calculateKnockOutBarrierGuard(quote, dir);
    return {
      quote,
      score: calculateCandidateScore(quote, change, catalystOrNews, {
        volume: quote.lastBarVolume ?? null,
        barTime: quote.lastBarTime ?? null,
      }),
      rank: 0,
      knockOutGuard,
    };
  });

  const eligible = scored.filter((item) => item.score.veto == null);
  eligible.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    const rawB = b.score.rawTotal ?? b.score.total;
    const rawA = a.score.rawTotal ?? a.score.total;
    if (rawB !== rawA) return rawB - rawA;
    const rvolB = b.quote.rvol ?? 0;
    const rvolA = a.quote.rvol ?? 0;
    if (rvolB !== rvolA) return rvolB - rvolA;
    return Math.abs(b.quote.gapPercent ?? 0) - Math.abs(a.quote.gapPercent ?? 0);
  });

  return eligible.map((item, index) => ({
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

  // Select top candidates that fully comply with active parameters (qualified).
  // WARMUP_INCOMPLETE escluso: resta nel radar ma non puo essere Top Pick.
  const recommendableEU = rankedEU.filter((cand) => !cand.score.warmupIncomplete);
  const recommendableUS = rankedUS.filter((cand) => !cand.score.warmupIncomplete);

  let topEU: ScoredCandidate | null = null;
  if (params && recommendableEU.length > 0) {
    topEU = recommendableEU.find((cand) => {
      const check = isCandidateCompliantWithParameters(cand.quote, cand.score.total, params, isRsiActive);
      return check.compliant;
    }) || null;
  }
  // Fallback to highest scored EU candidate if none passes all filters (mai un WARMUP_INCOMPLETE)
  if (!topEU && recommendableEU.length > 0) {
    topEU = recommendableEU[0];
  }

  let topUS: ScoredCandidate | null = null;
  if (params && recommendableUS.length > 0) {
    topUS = recommendableUS.find((cand) => {
      const check = isCandidateCompliantWithParameters(cand.quote, cand.score.total, params, isRsiActive);
      return check.compliant;
    }) || null;
  }
  // Fallback to highest scored US candidate if none passes all filters (mai un WARMUP_INCOMPLETE)
  if (!topUS && recommendableUS.length > 0) {
    topUS = recommendableUS[0];
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

export function getMacroBlackoutStatus(
  macroEvents?: MacroEvent[],
  now: Date = new Date()
): {
  isBlackoutActive: boolean;
  label: string;
  description: string;
  activeEvent?: MacroEvent | null;
} {
  const day = now.getDay();
  const isWeekend = day === 0 || day === 6;

  if (isWeekend) {
    return {
      isBlackoutActive: false,
      label: 'Nessun Blackout Macro (Mercato Chiuso)',
      description: 'I mercati finanziari sono chiusi per il fine settimana (sabato/domenica). Nessun rilascio macroeconomico.',
      activeEvent: null,
    };
  }

  if (Array.isArray(macroEvents) && macroEvents.length > 0) {
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

    const highImpact = macroEvents.filter(
      (e) => e.impact === 'HIGH' || e.impact === 'EXTREME'
    );

    for (const evt of highImpact) {
      if (evt.timeCET && evt.timeCET.includes(':')) {
        const [hStr, mStr] = evt.timeCET.split(':');
        const evtHour = parseInt(hStr, 10);
        const evtMin = parseInt(mStr, 10);
        if (!isNaN(evtHour) && !isNaN(evtMin)) {
          const eventMinutes = evtHour * 60 + evtMin;
          const diff = eventMinutes - currentMinutes;
          // Finestra di blackout dinamica: da 15 minuti prima a 15 minuti dopo il rilascio reale
          if (diff >= -15 && diff <= 15) {
            return {
              isBlackoutActive: true,
              label: `Blackout Macro Imminente (${evt.timeCET} CET)`,
              description: `Finestra rilascio dati macro ad alto impatto: ${evt.event} (${evt.timeCET} CET). Spike e allargamento spread broker: astenersi da nuovi ingressi a ridosso del dato.`,
              activeEvent: evt,
            };
          }
        }
      }
    }

    return {
      isBlackoutActive: false,
      label: 'Nessun Blackout Macro Imminente',
      description: 'Nessun rilascio macro primario nell\'immediato. Flusso di mercato regolare.',
      activeEvent: null,
    };
  }

  return {
    isBlackoutActive: false,
    label: 'Nessun Blackout Macro Imminente',
    description: 'Nessun rilascio macro primario nell\'immediato. Flusso di mercato regolare.',
    activeEvent: null,
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

/**
 * Verifica se un dato di mercato è stantio rispetto all'orario corrente.
 * La soglia è 5 minuti per EU e 3 minuti per US.
 */
export function checkQuoteStaleness(
  quote: RawQuoteData,
  currentTime: Date = new Date(),
  options?: { euStalenessMin?: number; usStalenessMin?: number }
): { isStale: boolean; minutesDelay: number | null; warning: string | null } {
  const threshold = quote.market === 'EU'
    ? options?.euStalenessMin ?? 5
    : options?.usStalenessMin ?? 3;

  if (!quote.timestamp) {
    return { isStale: true, minutesDelay: null, warning: 'Timestamp assente: dato non verificabile' };
  }

  const quoteTime = new Date(quote.timestamp);
  if (Number.isNaN(quoteTime.getTime())) {
    return { isStale: true, minutesDelay: null, warning: 'Timestamp non valido: dato non verificabile' };
  }

  const minutesDelay = (currentTime.getTime() - quoteTime.getTime()) / 60000;
  if (minutesDelay > threshold) {
    return {
      isStale: true,
      minutesDelay: +minutesDelay.toFixed(1),
      warning: `Feed ${quote.market} in ritardo di ${minutesDelay.toFixed(1)} min (soglia: ${threshold} min)`,
    };
  }

  return { isStale: false, minutesDelay: +minutesDelay.toFixed(1), warning: null };
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
    macroEvents?: MacroEvent[];
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
  let adrRemainingPriceSpace: number | null = null;
  if (adrConsumptionFraction != null && quote.adr14 != null && quote.adr14 > 0) {
    const consumedRange = quote.adr14 * adrConsumptionFraction;
    adrRemainingPriceSpace = +(quote.adr14 - consumedRange).toFixed(4);
  }

  const extensionFraction =
    entryLevel > 0
      ? direction === 'LONG'
        ? (price - entryLevel) / entryLevel
        : (entryLevel - price) / entryLevel
      : 0;
  const extensionPct = +(extensionFraction * 100).toFixed(2);

  const Tb =
    direction === 'LONG'
      ? (quote.orbBreakoutTimeLong ?? null)
      : direction === 'SHORT'
      ? (quote.orbBreakoutTimeShort ?? null)
      : null;
  const marketTime = getMarketTime(marketType, currentTime);
  const staleness = checkQuoteStaleness(quote, currentTime);

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

  // G12: T1 raggiungibile entro lo spazio ADR residuo
  const t1Distance = Math.abs(target1Level - entryLevel);
  const g12Pass =
    adrRemainingPriceSpace == null ||
    t1Distance <= adrRemainingPriceSpace + TRADING_PARAMS.EPSILON;
  gateResults['G12'] = {
    passed: g12Pass,
    label: 'T1 vs ADR Residuo',
    message: g12Pass ? undefined : 'T1 FUORI PORTATA ADR',
  };

  // G13: quote non stantia
  const g13Pass = !staleness.isStale;
  gateResults['G13'] = {
    passed: g13Pass,
    label: 'Freshness Dati',
    message: g13Pass ? undefined : staleness.warning ?? 'DATI NON FRESCHI',
  };

  const gateKeys = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13'];
  const firstFailedKey = gateKeys.find((k) => !gateResults[k].passed);

  const decision: 'TRADE' | 'NESSUN_TRADE' = firstFailedKey ? 'NESSUN_TRADE' : 'TRADE';
  const reasonNoTrade = firstFailedKey ? gateResults[firstFailedKey].message : undefined;
  const blockedGate = firstFailedKey || null;

  const orbPhase = getOrbPhaseInfo(marketType, currentTime);
  const adrInfo = calculateAdrInfo(quote);
  const macroBlackout = getMacroBlackoutStatus(options?.macroEvents, currentTime);
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
  spreadEur: number = TRADING_PARAMS.SPREAD_EUR,
  brokerFeeEur: number = TRADING_PARAMS.BROKER_FEE_PER_SIDE_EUR
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
  const t1R = setup.riskRewardRatio ?? TRADING_PARAMS.T1_R;
  const t2R = stopDistance > 0 && setup.target2Level != null
    ? +(Math.abs(setup.target2Level - entryPrice) / stopDistance).toFixed(2)
    : TRADING_PARAMS.T2_R;

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
      certEstimatedPrice = certPrice;
      grossPnlEur = 0;
      netPnlEur = -frictionEur;
    } else if (opts.isStop) {
      certEstimatedPrice = Math.max(0.01, +(certPrice * (1 + (underlyingChangePercent / 100) * leverage)).toFixed(3));
      // NOTE ON RISK CAP:
      // potentialLossEur represents the GROSS loss cap derived from 1% account risk (maxRiskEur = capital * 1%).
      // The position sizing calculates suggestedCertificates so that theoretical gross loss <= maxRiskEur.
      // Net loss includes transaction frictions: netPnlEur = grossPnlEur - frictionEur.
      grossPnlEur = -potentialLossEur;
      netPnlEur = +(grossPnlEur - frictionEur).toFixed(2);
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

  const t2Price = setup.target2Level ?? (isLong ? entryPrice + stopDistance * t2R : entryPrice - stopDistance * t2R);
  const t1Price = setup.target1Level ?? (isLong ? entryPrice + stopDistance * t1R : entryPrice - stopDistance * t1R);
  const tHalfPrice = isLong ? entryPrice + stopDistance * 0.8 : entryPrice - stopDistance * 0.8;
  const bePrice = isLong ? entryPrice + breakevenPoints : entryPrice - breakevenPoints;
  const pullbackPrice = isLong ? entryPrice - stopDistance * 0.5 : entryPrice + stopDistance * 0.5;
  const stopPrice = setup.stopLossLevel ?? (isLong ? entryPrice - stopDistance : entryPrice + stopDistance);
  const koPrice = input.barrierStrike;

  return [
    buildScenario('t2', 'Target 2 (Trend Esteso)', t2R, t2Price, 'Massimo target intraday'),
    buildScenario('t1', 'Target 1 (Presa 70% Profitto)', t1R, t1Price, 'Target primario: chiusura parziale e stop a BE'),
    buildScenario('half', 'Pullback Favorevole (+0.8R)', 0.8, tHalfPrice, 'Scalping intermedio o gestione protettiva'),
    buildScenario('be', 'Pareggio al Carico (0.0R Lordo)', 0, entryPrice, 'Uscita al prezzo di carico: PnL lordo 0 e netto pari alle sole frizioni', { isBreakeven: true }),
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
  const spreadEur = input.spreadEur ?? TRADING_PARAMS.SPREAD_EUR;
  const brokerFeeEur = input.brokerFeeEur ?? TRADING_PARAMS.BROKER_FEE_PER_SIDE_EUR;

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
  const t2R = stopDistance > 0 && setup.target2Level != null
    ? +(Math.abs(setup.target2Level - entryPrice) / stopDistance).toFixed(2)
    : TRADING_PARAMS.T2_R;
  const potentialGainT2Eur = +(potentialLossEur * t2R).toFixed(2);

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
      spreadEur: TRADING_PARAMS.SPREAD_EUR,
      brokerFeeEur: TRADING_PARAMS.BROKER_FEE_PER_SIDE_EUR,
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
 * Requires at least `minRequiredTrades` (strictly 15) closed trades for that market before generating proposals,
 * preventing curve-fitting and variance chasing.
 * If insufficient data, returns a clear status with zero mock or synthetic proposals.
 */
export function evaluateSessionOptimization(
  trades: TradeJournalEntry[],
  market: 'EU' | 'US',
  currentParams: SystemParameters = DEFAULT_SYSTEM_PARAMETERS,
  minRequiredTrades = 15
): OptimizationProposal {
  // Exclude OPEN trades and filter by market
  const closedMarketTrades = trades.filter(
    (t) => (t.market || (t.session === 'US' ? 'US' : 'EU')) === market && t.status !== 'OPEN'
  );
  const sorted = [...closedMarketTrades].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  // Total calculated over full closed trade sample before slicing
  const total = closedMarketTrades.length;
  // Slice to 20 setups preserved strictly for display/visualization
  const evaluatedBatch = sorted.slice(0, 20);
  const cycle = Math.max(1, Math.floor(total / 20));
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
        wins: closedMarketTrades.filter((t) => t.outcome === 'WIN').length,
        losses: closedMarketTrades.filter((t) => t.outcome === 'LOSS').length,
        breakevens: closedMarketTrades.filter((t) => t.outcome === 'BREAKEVEN').length,
        expired: closedMarketTrades.filter((t) => t.outcome === 'EXPIRED').length,
        winRate: 0,
        expiredRate: 0,
        lossRate: 0,
        netPnlEur: +(closedMarketTrades.reduce((acc, t) => acc + (t.pnlEur || 0), 0)).toFixed(2),
        profitFactor: 0,
        avgR: 0,
      },
      status: 'NO_CHANGES_NEEDED',
      performanceRating: 'GOOD',
      summaryTitle: `Sessione ${marketName}: Dati Insufficienti - Campionamento in Corso (${total}/${minRequiredTrades} Trade)`,
      summaryExplanation: `Sono stati registrati ${total} trade chiusi per il mercato ${marketName}. La soglia minima di affidabilità statistica richiede almeno ${minRequiredTrades} trade per formulare proposte di ricalibrazione ed evitare il curve-fitting (inseguire il rumore di mercato). Il sistema mantiene attivi i parametri correnti.`,
      identifiedStrengths: [],
      identifiedWeaknesses: [
        `Campione statistico in formazione (${total}/${minRequiredTrades} trade chiusi): registra ulteriori ${minRequiredTrades - total} trade in questa sessione per sbloccare l'auto-ottimizzazione con significatività statistica validata.`,
      ],
      proposedChanges: [],
      statisticalSignificance: 'INSUFFICIENTE',
      statisticalConfidencePct: Math.round((total / minRequiredTrades) * 100),
      sampleSizeRequired: minRequiredTrades,
    };
  }

  const wins = closedMarketTrades.filter((t) => t.outcome === 'WIN');
  const losses = closedMarketTrades.filter((t) => t.outcome === 'LOSS');
  const breakevens = closedMarketTrades.filter((t) => t.outcome === 'BREAKEVEN');
  const expired = closedMarketTrades.filter((t) => t.outcome === 'EXPIRED');

  const winCount = wins.length;
  const lossCount = losses.length;
  const beCount = breakevens.length;
  const expiredCount = expired.length;

  const winRate = total > 0 ? +((winCount / total) * 100).toFixed(1) : 0;
  const expiredRate = total > 0 ? +((expiredCount / total) * 100).toFixed(1) : 0;
  const lossRate = total > 0 ? +((lossCount / total) * 100).toFixed(1) : 0;

  const netPnlEur = +(closedMarketTrades.reduce((acc, t) => acc + (t.pnlEur || 0), 0)).toFixed(2);
  const totalGains = wins.reduce((acc, t) => acc + (t.pnlEur || 0), 0);
  const totalLosses = Math.abs(losses.reduce((acc, t) => acc + (t.pnlEur || 0), 0));
  const profitFactor =
    totalLosses > 0 ? +(totalGains / totalLosses).toFixed(2) : totalGains > 0 ? 99.0 : 0;
  const avgR =
    total > 0
      ? +(closedMarketTrades.reduce((acc, t) => acc + (t.rMultiple || 0), 0) / total).toFixed(2)
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

      const curRvol = currentParams.minRvolEurope ?? TRADING_PARAMS.MIN_RVOL_EU;
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

      const curRvol = currentParams.minRvolUSA ?? TRADING_PARAMS.MIN_RVOL_US;
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

  const statisticalSignificance: 'ELEVATA' | 'MODERATA' | 'INSUFFICIENTE' =
    total >= 30 ? 'ELEVATA' : total >= 15 ? 'MODERATA' : 'INSUFFICIENTE';
  const statisticalConfidencePct = Math.min(100, Math.round((total / 30) * 100));

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
    statisticalSignificance,
    statisticalConfidencePct,
    sampleSizeRequired: minRequiredTrades,
  };
}

export function evaluateDualSystemOptimization(
  trades: TradeJournalEntry[],
  currentParams: SystemParameters = DEFAULT_SYSTEM_PARAMETERS,
  minRequiredTrades = 15
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
  const minRvolEU = parameters?.minRvolEurope ?? parameters?.minRvol ?? TRADING_PARAMS.MIN_RVOL_EU;
  const minRvolUS = parameters?.minRvolUSA ?? parameters?.minRvol ?? TRADING_PARAMS.MIN_RVOL_US;
  const minGapEU = parameters?.minGapEurope ?? DEFAULT_SYSTEM_PARAMETERS.minGapEurope;
  const minGapUS = parameters?.minGapUSA ?? DEFAULT_SYSTEM_PARAMETERS.minGapUSA;

  const isCandidateFullyQualified = (
    candidate: ScoredCandidate | null,
    market: 'EU' | 'US'
  ): boolean => {
    if (!candidate || !candidate.quote) return false;
    const q = candidate.quote;

    // Data completeness
    if (q.currentPrice == null && q.preMarketPrice == null) return false;
    if (q.atr14 == null || q.atr14 <= 0) return false;

    const isEU = market === 'EU';
    const minScore = isEU ? minScoreEU : minScoreUS;
    const minRvol = isEU ? minRvolEU : minRvolUS;
    const minGap = isEU ? minGapEU : minGapUS;

    // 1. Score Gate
    if (candidate.score.total < minScore) return false;

    // 2. RVOL Gate
    const rvol = q.rvol != null ? q.rvol : (isEU ? 1.0 : 1.0);
    if (rvol < minRvol) return false;

    // 3. Gap Gate
    const absGap = Math.abs(q.gapPercent ?? 0);
    if (absGap < minGap) return false;

    // 4. RSI Gate
    const rsi = q.rsi5m ?? q.rsi14 ?? null;
    if (isRsiFilterActive && isRsiExtreme(rsi)) return false;

    // 5. Catalyst Gate
    const cat = catalystCache[q.ticker];
    if (cat && cat.decisione === 'NESSUN_TRADE') {
      const isAbsenceOfNewsOnly =
        cat.catalizzatore?.toLowerCase().includes('nessuna notizia') ||
        cat.catalizzatore?.toLowerCase().includes('assenza di catalizzatore') ||
        cat.catalizzatore?.toLowerCase().includes('assenza di notizie') ||
        (cat.rischi?.length === 1 &&
          (cat.rischi[0]?.toLowerCase().includes('mancanza di notizie') ||
           cat.rischi[0]?.toLowerCase().includes('assenza di catalizzatore') ||
           cat.rischi[0]?.toLowerCase().includes('assenza di notizie')));
      if (!isAbsenceOfNewsOnly) return false;
    }

    return true;
  };

  if (isCandidateFullyQualified(dualTop.topEU, 'EU')) {
    qualifiedTickers.add(dualTop.topEU!.quote.ticker);
  }

  if (isCandidateFullyQualified(dualTop.topUS, 'US')) {
    qualifiedTickers.add(dualTop.topUS!.quote.ticker);
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
    const scoreObj = calculateCandidateScore(q, change, cat, {
      volume: q.lastBarVolume ?? null,
      barTime: q.lastBarTime ?? null,
    });
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
 *
 * NOTA ARCHITETTURALE E LIMITE STRUTTURALE DEL POLLING SPOT PRICE:
 * Questa funzione esegue una verifica istantanea (single-sample polling) basata sulle quotazioni spot fornite ad ogni ciclo del feed.
 * Limite strutturale intrinseco: target o stop loss toccati dal sottostante all'interno dell'intervallo tra un poll e il successivo
 * possono non essere intercettati se il prezzo ritraccia prima del campionamento successivo.
 * Per una risoluzione esaustiva dei massimi e minimi estremi intraday intra-poll, è necessario un feed continuo tick-by-tick / OHLC.
 * La presente funzione non altera la logica quantitativa di calcolo, ma documenta formalmente tale caratteristica operativa.
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

    // 3. Cutoff Time Expiration with Adaptive Soft Cutoff Logic
    if (currentCetMinutes != null) {
      const isEuCutoff = record.market === 'EU' && currentCetMinutes >= 690; // 11:30 CET
      const isUsCutoff = record.market === 'US' && currentCetMinutes >= 1050; // 17:30 CET
      const isEuHardCeiling = record.market === 'EU' && currentCetMinutes >= 855; // 14:15 CET (pre-macro USA)
      const isUsHardCeiling = record.market === 'US' && currentCetMinutes >= 1290; // 21:30 CET (15:30 NY)

      const diff = isLong ? livePrice - entry : entry - livePrice;
      const rMultiple = riskDist > 0 ? +(diff / riskDist).toFixed(2) : 0;
      const pnlEur = +(rMultiple * (accountCapital * 0.01)).toFixed(2);

      // Scenario A: Trade is ALREADY in Soft Cutoff Extension
      if (record.softCutoffExtended) {
        // Condition 1: Check Breakeven Protection (if price falls back to entry level)
        const isBreakevenHit = isLong ? livePrice <= entry : livePrice >= entry;
        if (isBreakevenHit) {
          newlyResolvedCount++;
          return {
            ...record,
            currentPrice: livePrice,
            outcomeStatus: 'THEORETICAL_EXPIRED' as const,
            theoreticalRMultiple: 0.0,
            theoreticalPnlEur: 0,
            resolvedAt: new Date().toISOString(),
            notes: `🛡️ Soft Cutoff Breakeven: ritracciamento al prezzo di carico (${entry.toFixed(2)} ${record.currency}). Capitale protetto a pareggio (0.0R).`,
          };
        }

        // Condition 2: Hard Exit Ceiling reached (14:15 CET EU pre-macro / 21:30 CET US)
        if (isEuHardCeiling || isUsHardCeiling) {
          newlyResolvedCount++;
          const outcomeStatus = rMultiple >= 0.5 ? ('THEORETICAL_PROFIT' as const) : ('THEORETICAL_EXPIRED' as const);
          return {
            ...record,
            currentPrice: livePrice,
            outcomeStatus,
            theoreticalRMultiple: rMultiple,
            theoreticalPnlEur: pnlEur,
            resolvedAt: new Date().toISOString(),
            notes: `⏰ Soft Cutoff Hard Ceiling raggiunto (${record.market === 'EU' ? '14:15' : '21:30'} CET). Chiusura protetta in profitto a +${rMultiple}R.`,
          };
        }

        // Still healthy in extension, let it continue towards Target 1!
        return {
          ...record,
          currentPrice: livePrice,
        };
      }

      // Scenario B: First crossing of standard cutoff (11:30 EU / 17:30 US)
      if (isEuCutoff || isUsCutoff) {
        // Soft Cutoff Criteria:
        // C1: Latent profit >= +0.35R
        // C2: Not already past Hard Ceiling
        const canSoftExtend = rMultiple >= 0.35 && !(isEuHardCeiling || isUsHardCeiling);

        if (canSoftExtend) {
          return {
            ...record,
            currentPrice: livePrice,
            softCutoffExtended: true,
            isBreakevenLocked: true,
            stopLoss: entry, // lock Breakeven
            notes: `🛡️ Soft Cutoff Attivato: +${rMultiple}R al cutoff standard. Stop protetto a Pareggio (${entry.toFixed(2)}). Estensione attiva verso Target 1 fino al Ceiling (${record.market === 'EU' ? '14:15' : '21:30'} CET).`,
          };
        }

        // Standard Hard Close: setup had insufficient momentum (< +0.35R) or was negative
        newlyResolvedCount++;
        return {
          ...record,
          currentPrice: livePrice,
          outcomeStatus: 'THEORETICAL_EXPIRED' as const,
          theoreticalRMultiple: rMultiple,
          theoreticalPnlEur: pnlEur,
          resolvedAt: new Date().toISOString(),
          notes: `Cutoff superato senza momentum sufficiente (+${rMultiple}R < +0.35R). Chiusura temporale a ${livePrice.toFixed(2)} ${record.currency}.`,
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
      if (cat === 'RVOL_INSUFFICIENT') {
        const euProfitableRvols = catRecords
          .filter((r) => r.market === 'EU' && r.outcomeStatus === 'THEORETICAL_PROFIT' && typeof r.rvol === 'number' && r.rvol > 0)
          .map((r) => r.rvol as number);
        const usProfitableRvols = catRecords
          .filter((r) => r.market === 'US' && r.outcomeStatus === 'THEORETICAL_PROFIT' && typeof r.rvol === 'number' && r.rvol > 0)
          .map((r) => r.rvol as number);

        let anyUncalibrated = false;

        // Process EU
        if (euProfitableRvols.length > 0) {
          const curRvolEU = currentParams.minRvolEurope ?? TRADING_PARAMS.MIN_RVOL_EU;
          const minProfitableEU = Math.min(...euProfitableRvols);
          const proposedEU = Math.max(0.65, +Math.min(curRvolEU - 0.05, minProfitableEU).toFixed(2));
          const isCalibratedEU = curRvolEU <= proposedEU + 0.01;

          if (!isCalibratedEU) {
            anyUncalibrated = true;
            const proposal = {
              parameterKey: 'minRvolEurope' as const,
              label: 'Soglia Minima Volume Relativo Europa (minRvolEurope)',
              currentValue: `${curRvolEU}x`,
              proposedValue: `${proposedEU}x`,
              actionType: 'REDUCE_PARAM' as const,
              explanation: `Micro-ottimizzazione Europa: riduci la soglia minima di RVOL da ${curRvolEU}x a ${proposedEU}x per includere nella prossima sessione europea titoli con volume relativo a partire da ${proposedEU}x che sono andati a target.`,
            };
            if (!correctionProposal) correctionProposal = proposal;
            urgentCorrections.push({
              category: cat,
              title: 'Allentamento Soglia RVOL Europa',
              description: proposal.explanation,
              parameterKey: 'minRvolEurope',
              currentValue: curRvolEU,
              proposedValue: proposedEU,
            });
          }
        }

        // Process US
        if (usProfitableRvols.length > 0) {
          const curRvolUS = currentParams.minRvolUSA ?? TRADING_PARAMS.MIN_RVOL_US;
          const minProfitableUS = Math.min(...usProfitableRvols);
          const proposedUS = Math.max(0.85, +Math.min(curRvolUS - 0.05, minProfitableUS).toFixed(2));
          const isCalibratedUS = curRvolUS <= proposedUS + 0.01;

          if (!isCalibratedUS) {
            anyUncalibrated = true;
            const proposal = {
              parameterKey: 'minRvolUSA' as const,
              label: 'Soglia Minima Volume Relativo USA (minRvolUSA)',
              currentValue: `${curRvolUS}x`,
              proposedValue: `${proposedUS}x`,
              actionType: 'REDUCE_PARAM' as const,
              explanation: `Micro-ottimizzazione USA: riduci la soglia minima di RVOL da ${curRvolUS}x a ${proposedUS}x per includere nella prossima sessione americana titoli con volume relativo a partire da ${proposedUS}x che sono andati a target.`,
            };
            if (!correctionProposal) correctionProposal = proposal;
            urgentCorrections.push({
              category: cat,
              title: 'Allentamento Soglia RVOL USA',
              description: proposal.explanation,
              parameterKey: 'minRvolUSA',
              currentValue: curRvolUS,
              proposedValue: proposedUS,
            });
          }
        }

        if (anyUncalibrated) {
          verdict = 'TOO_RESTRICTIVE';
          verdictTitle = '⚠️ Filtro Troppo Severo (Troppi Profitti Persi)';
          verdictDescription = `${profitCount} setup su ${resolved} risolti (${winRate}%) sono andati a target con successo nonostante l'esclusione. Il filtro è eccessivamente restrittivo e sta frenando le performance della strategia.`;
        } else {
          verdict = 'CALIBRATED';
          verdictTitle = '✅ Filtro Calibrato & Ottimizzato';
          verdictDescription = 'Le soglie di Volume Relativo per i mercati con trade profittevoli sono già allineate ai valori ottimali. Nessuna ulteriore riduzione necessaria.';
          correctionProposal = undefined;
        }
      } else if (cat === 'GAP_INSUFFICIENT') {
        const euProfitableGaps = catRecords
          .filter((r) => r.market === 'EU' && r.outcomeStatus === 'THEORETICAL_PROFIT' && typeof r.gapPercent === 'number')
          .map((r) => Math.abs(r.gapPercent as number));
        const usProfitableGaps = catRecords
          .filter((r) => r.market === 'US' && r.outcomeStatus === 'THEORETICAL_PROFIT' && typeof r.gapPercent === 'number')
          .map((r) => Math.abs(r.gapPercent as number));

        let anyUncalibrated = false;

        // Process EU
        if (euProfitableGaps.length > 0) {
          const curGapEU = currentParams.minGapEurope ?? DEFAULT_SYSTEM_PARAMETERS.minGapEurope;
          const minProfitableEU = Math.min(...euProfitableGaps);
          const proposedEU = Math.max(0.15, +Math.min(curGapEU - 0.05, minProfitableEU).toFixed(2));
          const isCalibratedEU = curGapEU <= proposedEU + 0.01;

          if (!isCalibratedEU) {
            anyUncalibrated = true;
            const proposal = {
              parameterKey: 'minGapEurope' as const,
              label: 'Soglia Minima Gap % Europa (minGapEurope)',
              currentValue: `${curGapEU}%`,
              proposedValue: `${proposedEU}%`,
              actionType: 'REDUCE_PARAM' as const,
              explanation: `Micro-calibrazione Europa: abbassa il gap minimo europeo da ${curGapEU}% a ${proposedEU}% per intercettare continuazioni di trend con gap a partire da ±${proposedEU}%.`,
            };
            if (!correctionProposal) correctionProposal = proposal;
            urgentCorrections.push({
              category: cat,
              title: 'Riduzione Soglia Gap Minimo Europa',
              description: proposal.explanation,
              parameterKey: 'minGapEurope',
              currentValue: curGapEU,
              proposedValue: proposedEU,
            });
          }
        }

        // Process US
        if (usProfitableGaps.length > 0) {
          const curGapUS = currentParams.minGapUSA ?? DEFAULT_SYSTEM_PARAMETERS.minGapUSA;
          const minProfitableUS = Math.min(...usProfitableGaps);
          const proposedUS = Math.max(0.35, +Math.min(curGapUS - 0.05, minProfitableUS).toFixed(2));
          const isCalibratedUS = curGapUS <= proposedUS + 0.01;

          if (!isCalibratedUS) {
            anyUncalibrated = true;
            const proposal = {
              parameterKey: 'minGapUSA' as const,
              label: 'Soglia Minima Gap % USA (minGapUSA)',
              currentValue: `${curGapUS}%`,
              proposedValue: `${proposedUS}%`,
              actionType: 'REDUCE_PARAM' as const,
              explanation: `Micro-calibrazione USA: abbassa il gap minimo americano da ${curGapUS}% a ${proposedUS}% per intercettare continuazioni di trend a Wall Street con gap a partire da ±${proposedUS}%.`,
            };
            if (!correctionProposal) correctionProposal = proposal;
            urgentCorrections.push({
              category: cat,
              title: 'Riduzione Soglia Gap Minimo USA',
              description: proposal.explanation,
              parameterKey: 'minGapUSA',
              currentValue: curGapUS,
              proposedValue: proposedUS,
            });
          }
        }

        if (anyUncalibrated) {
          verdict = 'TOO_RESTRICTIVE';
          verdictTitle = '⚠️ Filtro Troppo Severo (Troppi Profitti Persi)';
          verdictDescription = `${profitCount} setup su ${resolved} risolti (${winRate}%) sono andati a target con successo nonostante l'esclusione. Il filtro è eccessivamente restrittivo e sta frenando le performance della strategia.`;
        } else {
          verdict = 'CALIBRATED';
          verdictTitle = '✅ Filtro Calibrato & Ottimizzato';
          verdictDescription = 'I Gap % minimi per i mercati con trade profittevoli sono già stati calibrati. Nessuna ulteriore riduzione necessaria.';
          correctionProposal = undefined;
        }
      } else if (cat === 'SCORE_BELOW_MIN') {
        const euProfitableScores = catRecords
          .filter((r) => r.market === 'EU' && r.outcomeStatus === 'THEORETICAL_PROFIT' && typeof r.score === 'number')
          .map((r) => r.score);
        const usProfitableScores = catRecords
          .filter((r) => r.market === 'US' && r.outcomeStatus === 'THEORETICAL_PROFIT' && typeof r.score === 'number')
          .map((r) => r.score);

        let anyUncalibrated = false;

        // Process EU
        if (euProfitableScores.length > 0) {
          const curScoreEU = currentParams.minScoreEurope ?? TRADING_PARAMS.MIN_SCORE_EU;
          const minProfitableScoreEU = Math.min(...euProfitableScores);
          const proposedEU = Math.max(40, Math.min(curScoreEU - 1, minProfitableScoreEU));
          const isCalibratedEU = curScoreEU <= proposedEU;

          if (!isCalibratedEU) {
            anyUncalibrated = true;
            const proposal = {
              parameterKey: 'minScoreEurope' as const,
              label: 'Punteggio Minimo Algoritmico Europa (minScoreEurope)',
              currentValue: `${curScoreEU}/100`,
              proposedValue: `${proposedEU}/100`,
              actionType: 'REDUCE_PARAM' as const,
              explanation: `Micro-ottimizzazione Europa: riduci la soglia di sblocco europeo da ${curScoreEU} a ${proposedEU}/100 per ammettere setup con punteggio da ${proposedEU} in su.`,
            };
            if (!correctionProposal) correctionProposal = proposal;
            urgentCorrections.push({
              category: cat,
              title: 'Abbassamento Soglia Punteggio Europa',
              description: proposal.explanation,
              parameterKey: 'minScoreEurope',
              currentValue: curScoreEU,
              proposedValue: proposedEU,
            });
          }
        }

        // Process US
        if (usProfitableScores.length > 0) {
          const curScoreUS = currentParams.minScoreUSA ?? TRADING_PARAMS.MIN_SCORE_US;
          const minProfitableScoreUS = Math.min(...usProfitableScores);
          const proposedUS = Math.max(45, Math.min(curScoreUS - 1, minProfitableScoreUS));
          const isCalibratedUS = curScoreUS <= proposedUS;

          if (!isCalibratedUS) {
            anyUncalibrated = true;
            const proposal = {
              parameterKey: 'minScoreUSA' as const,
              label: 'Punteggio Minimo Algoritmico USA (minScoreUSA)',
              currentValue: `${curScoreUS}/100`,
              proposedValue: `${proposedUS}/100`,
              actionType: 'REDUCE_PARAM' as const,
              explanation: `Micro-ottimizzazione USA: riduci la soglia di sblocco americano da ${curScoreUS} a ${proposedUS}/100 per ammettere setup con punteggio da ${proposedUS} in su.`,
            };
            if (!correctionProposal) correctionProposal = proposal;
            urgentCorrections.push({
              category: cat,
              title: 'Abbassamento Soglia Punteggio USA',
              description: proposal.explanation,
              parameterKey: 'minScoreUSA',
              currentValue: curScoreUS,
              proposedValue: proposedUS,
            });
          }
        }

        if (anyUncalibrated) {
          verdict = 'TOO_RESTRICTIVE';
          verdictTitle = '⚠️ Filtro Troppo Severo (Troppi Profitti Persi)';
          verdictDescription = `${profitCount} setup su ${resolved} risolti (${winRate}%) sono andati a target con successo nonostante l'esclusione.`;
        } else {
          verdict = 'CALIBRATED';
          verdictTitle = '✅ Filtro Calibrato & Ottimizzato';
          verdictDescription = 'Le soglie di punteggio minime per i mercati con trade profittevoli sono già al livello ottimale per ammettere i setup di qualità.';
          correctionProposal = undefined;
        }
      } else if (cat === 'RSI_EXTREME') {
        if (!currentParams.rsiFilterActive) {
          verdict = 'CALIBRATED';
          verdictTitle = '✅ Filtro Calibrato (RSI Momentum Disattivato)';
          verdictDescription = 'Il blocco RSI rigido è già stato disattivato per consentire al radar di catturare setup ad alto momentum.';
          correctionProposal = undefined;
        } else {
          verdict = 'TOO_RESTRICTIVE';
          verdictTitle = '⚠️ Filtro Troppo Severo (Troppi Profitti Persi)';
          verdictDescription = `In sessioni con forte spinta istituzionale, l'RSI estremo ha prodotto un win rate del ${winRate}% a profitto. Disattivando il blocco rigido RSI, i setup ad alto momentum non vengono scartati.`;
          correctionProposal = {
            parameterKey: 'rsiFilterActive',
            label: 'Filtro Ipercomprato/Ipervenduto RSI (30/70)',
            currentValue: 'Attivo',
            proposedValue: 'Disattivo',
            actionType: 'TOGGLE_RSI',
            explanation: `Disattivando il blocco rigido RSI, i setup ad alto momentum non vengono scartati.`,
          };
          urgentCorrections.push({
            category: cat,
            title: 'Disattivazione Filtro RSI per Momentum',
            description: correctionProposal.explanation,
            parameterKey: 'rsiFilterActive',
            currentValue: true,
            proposedValue: false,
          });
        }
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

export type PositionCloseReason =
  | NonNullable<TradeJournalEntry['closeReason']>
  | 'CUTOFF_MOMENTUM_LOSS';

export interface PositionEvaluationResult {
  updatedTrade: TradeJournalEntry;
  wasClosed: boolean;
  reason?: PositionCloseReason | 'SOFT_CUTOFF_ACTIVATED';
  notification?: string;
}

export interface PositionEvaluationOptions {
  sessionInfo?: SessionInfo | null;
  accountCapital?: number;
  forceEod?: boolean;
  ignoreStaleness?: boolean;
  // Parametrizzazione Cutoff e Hard Ceiling (non hardcoded)
  usSoftCutoffCET?: number; // default 1050 (17:30 CET in minuti)
  usHardCeilingCET?: number; // default 1290 (21:30 CET in minuti)
  softCutoffRThreshold?: number; // default 0.35 (soglia minima R)
  momentumWindowMin?: number; // default 30 (finestra temporale momentum in minuti)
  momentum?: number; // valore esplicito momentum (opzionale)
  usMomentumRetraceR?: number; // default 0.25 (soglia arretramento dal picco per il proxy momentum)
  euSoftCutoffCET?: number; // default 690 (11:30 CET in minuti)
  euHardCeilingCET?: number; // default 855 (14:15 CET in minuti)
  euEodCET?: number; // default 1050 (17:30 CET in minuti)
  usEodCET?: number; // default 1320 (22:00 CET in minuti)
}

/**
 * Valuta il ciclo di vita di una posizione aperta (Paper o Reale)
 * - Monitoraggio tick-by-tick indipendente dal limite giornaliero nuovi trade
 * - Esecuzione automatica al primo tocco di target o stop (garantita se R <= -1)
 * - Rilevamento salto/gap oltre lo stop con calcolo effettivo slippage e R negativo
 * - Tracciamento continuo MFE (massimo favorevole) e MAE (massimo avverso)
 * - Cutoff dinamico US con valutazione momentum su finestra temporale o proxy
 * - Chiusura di fine sessione (EOD) con motivo esplicito (EOD_CUTOFF)
 * - Tracciamento cronistoria transizioni di stato (stateHistory)
 */
export function evaluateOpenPositionLifecycle(
  trade: TradeJournalEntry,
  quote: RawQuoteData | undefined,
  currentTime: Date = new Date(),
  options?: PositionEvaluationOptions
): PositionEvaluationResult {
  if (trade.status !== 'OPEN') {
    return { updatedTrade: trade, wasClosed: false };
  }

  // AUDIT P0-1: solo prezzi operativi (ultimo / pre-market). prevClose non e' un prezzo corrente:
  // usarlo farebbe scattare target o stop su un livello statico di ieri.
  // Senza prezzo operativo l'esito e' "non valutabile": nessuna chiusura, nessun PnL, nessun win rate.
  const livePrice = quote?.currentPrice ?? quote?.preMarketPrice ?? null;

  if (livePrice == null || !(livePrice > 0)) {
    return { updatedTrade: trade, wasClosed: false };
  }

  const isLong = trade.direction === 'LONG';
  const entry = trade.entryPrice;
  const stop = trade.stopLoss;
  const target1 = trade.target1;
  const market = trade.market || (trade.session === 'US' ? 'US' : 'EU');

  // AUDIT P0-2: nessun fallback sintetico (0.5% di entry / 1.6R). Un setup con entry == stop
  // o T1 == entry e' invalido: non si valuta (nessun esito, nessun PnL), non si inventa un rischio.
  const riskDist = Math.abs(entry - stop);
  const targetDist = Math.abs(target1 - entry);
  if (!(entry > 0) || !(riskDist > 0) || !(targetDist > 0)) {
    return { updatedTrade: trade, wasClosed: false };
  }

  // Fallback capital and risk amount: non bloccare mai il monitoraggio se riskAmountEur manca
  const fallbackCap = options?.accountCapital && options.accountCapital > 0 ? options.accountCapital : 10000;
  const riskAmountEur =
    typeof trade.potentialLossEur === 'number' && Number.isFinite(trade.potentialLossEur) && trade.potentialLossEur > 0
      ? trade.potentialLossEur
      : typeof trade.maxRiskEur === 'number' && Number.isFinite(trade.maxRiskEur) && trade.maxRiskEur > 0
      ? trade.maxRiskEur
      : +(fallbackCap * 0.01).toFixed(2);
  const frictionEur = Math.max(0, trade.frictionEur ?? 0);

  // Time metrics
  const marketTime = getMarketTime(market, currentTime);
  const currentMinutes = options?.sessionInfo?.cet?.currentMinutes ?? marketTime.hour * 60 + marketTime.minute;

  // Excursion update (MFE / MAE in R-multiples)
  let newMfe = typeof trade.mfe === 'number' ? trade.mfe : 0;
  let newMae = typeof trade.mae === 'number' ? trade.mae : 0;

  if (livePrice != null && livePrice > 0) {
    const tickR = isLong ? (livePrice - entry) / riskDist : (entry - livePrice) / riskDist;
    newMfe = Math.max(newMfe, tickR);
    newMae = Math.min(newMae, tickR);

    // Also consider quote high/low if present
    if (typeof quote?.todayHigh === 'number' && typeof quote?.todayLow === 'number') {
      const highR = isLong ? (quote.todayHigh - entry) / riskDist : (entry - quote.todayHigh) / riskDist;
      const lowR = isLong ? (quote.todayLow - entry) / riskDist : (entry - quote.todayLow) / riskDist;
      newMfe = Math.max(newMfe, highR, lowR);
      newMae = Math.min(newMae, highR, lowR);
    }
  }

  newMfe = +newMfe.toFixed(2);
  newMae = +newMae.toFixed(2);

  const prevHistory = trade.stateHistory ? [...trade.stateHistory] : [];

  // Helper function to close position with explicit reason, slippage, and history
  const closePosition = (
    exitP: number,
    rMult: number,
    outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'EXPIRED',
    reason: PositionCloseReason,
    noteSuffix: string,
    notification: string,
    slippageP: number = 0,
    slippageE: number = 0
  ): PositionEvaluationResult => {
    const timestampIso = currentTime.toISOString();
    const finalPnlEur =
      outcome === 'WIN'
        ? trade.potentialGainT1Eur != null && Math.abs(rMult - targetDist / riskDist) < 0.05
          ? +(trade.potentialGainT1Eur - frictionEur).toFixed(2)
          : +(rMult * riskAmountEur - frictionEur).toFixed(2)
        : outcome === 'LOSS'
        ? +(rMult * riskAmountEur - frictionEur).toFixed(2)
        : outcome === 'BREAKEVEN'
        ? -frictionEur
        : +(rMult * riskAmountEur - frictionEur).toFixed(2);

    const updatedTrade: TradeJournalEntry = {
      ...trade,
      status: 'CLOSED',
      outcome,
      exitPrice: +exitP.toFixed(4),
      pnlEur: finalPnlEur,
      rMultiple: +rMult.toFixed(2),
      closedAt: timestampIso,
      closeReason: reason,
      mfe: newMfe,
      mae: newMae,
      slippagePrice: slippageP > 0 ? +slippageP.toFixed(4) : undefined,
      slippageEur: slippageE > 0 ? +slippageE.toFixed(2) : undefined,
      potentialLossEur: trade.potentialLossEur ?? riskAmountEur,
      maxRiskEur: trade.maxRiskEur ?? riskAmountEur,
      notes: `${trade.notes} | ${noteSuffix}`.trim(),
      stateHistory: [
        ...prevHistory,
        {
          timestamp: timestampIso,
          status: 'CLOSED',
          price: +exitP.toFixed(4),
          reason: reason || 'UNKNOWN',
          notes: noteSuffix,
        },
      ],
    };

    return {
      updatedTrade,
      wasClosed: true,
      reason,
      notification,
    };
  };

  // CHECK 1: Target 1 Hit (WIN)
  if (livePrice != null && livePrice > 0) {
    const isTargetHit = isLong ? livePrice >= target1 : livePrice <= target1;
    if (isTargetHit) {
      const rMultiple = +(targetDist / riskDist).toFixed(2);
      newMfe = Math.max(newMfe, rMultiple);
      const grossGainEur = trade.potentialGainT1Eur ?? riskAmountEur * rMultiple;
      const pnlEur = +(grossGainEur - frictionEur).toFixed(2);
      const notif = `🎯 Risoluzione Autonoma: ${trade.ticker} ha raggiunto Target 1 a ${livePrice.toFixed(2)} (+${rMultiple}R / +${pnlEur} €)!`;
      return closePosition(
        livePrice,
        rMultiple,
        'WIN',
        'TARGET_HIT',
        `Target 1 toccato a ${livePrice.toFixed(2)}.`,
        notif
      );
    }

    // CHECK 2: Stop Loss Hit (LOSS / SLIPPAGE)
    const priceDiff = isLong ? livePrice - entry : entry - livePrice;
    const actualR = riskDist > 0 ? +(priceDiff / riskDist).toFixed(2) : -1.0;
    const isStopHit = (isLong ? livePrice <= stop : livePrice >= stop) || actualR <= -1.0;
    if (isStopHit) {
      newMae = Math.min(newMae, actualR);

      // Slippage: check if price gapped past stop level by more than 1 cent
      const slippageDiff = isLong ? stop - livePrice : livePrice - stop;
      const isSlippage = slippageDiff > 0.01;
      const finalR = isSlippage ? actualR : -1.0;
      const reason: TradeJournalEntry['closeReason'] = isSlippage ? 'STOP_GAP_SLIPPAGE' : 'STOP_HIT';
      const slippageEur = isSlippage ? +(Math.abs(actualR - -1.0) * riskAmountEur).toFixed(2) : 0;
      const notif = isSlippage
        ? `🛑 Risoluzione Stop con Slippage: ${trade.ticker} ha saltato lo stop a ${livePrice.toFixed(2)} (${finalR}R / slippage: ${slippageDiff.toFixed(2)})!`
        : `🛑 Risoluzione Autonoma: ${trade.ticker} ha attivato Stop Loss a ${livePrice.toFixed(2)} (-1.0R)!`;

      return closePosition(
        livePrice,
        finalR,
        'LOSS',
        reason,
        isSlippage
          ? `Stop Loss saltato (gap/slippage) a ${livePrice.toFixed(2)} (${finalR}R, slippage: ${slippageDiff.toFixed(2)}).`
          : `Stop Loss attivato a ${livePrice.toFixed(2)} (-1.0R).`,
        notif,
        isSlippage ? slippageDiff : 0,
        slippageEur
      );
    }
  }

  const effectiveLivePrice = livePrice != null && livePrice > 0 ? livePrice : entry;
  const currentDiff = isLong ? effectiveLivePrice - entry : entry - effectiveLivePrice;
  const currentR = riskDist > 0 ? +(currentDiff / riskDist).toFixed(2) : 0;

  // Verifica tassativa: se R <= -1.0 la posizione si chiude tassativamente sullo stop e non resta mai IN CORSO
  if (currentR <= -1.0) {
    newMae = Math.min(newMae, currentR);
    const slippageDiff = isLong ? stop - effectiveLivePrice : effectiveLivePrice - stop;
    const isSlippage = slippageDiff > 0.01;
    const finalR = isSlippage ? currentR : -1.0;
    const reason: TradeJournalEntry['closeReason'] = isSlippage ? 'STOP_GAP_SLIPPAGE' : 'STOP_HIT';
    const slippageEur = isSlippage ? +(Math.abs(currentR - -1.0) * riskAmountEur).toFixed(2) : 0;
    return closePosition(
      effectiveLivePrice,
      finalR,
      'LOSS',
      reason,
      isSlippage
        ? `Stop Loss saltato (gap/slippage) a ${effectiveLivePrice.toFixed(2)} (${finalR}R, slippage: ${slippageDiff.toFixed(2)}).`
        : `Stop Loss attivato a ${effectiveLivePrice.toFixed(2)} (-1.0R).`,
      `🛑 Risoluzione Autonoma: ${trade.ticker} ha attivato Stop Loss a ${effectiveLivePrice.toFixed(2)} (${finalR}R)!`,
      isSlippage ? slippageDiff : 0,
      slippageEur
    );
  }

  // Parametrizzazione Cutoff e Hard Ceiling (Regola 4)
  const usSoftCutoffCET = options?.usSoftCutoffCET ?? 1050; // default 17:30 CET (1050 min)
  const usHardCeilingCET = options?.usHardCeilingCET ?? 1290; // default 21:30 CET (1290 min)
  const softCutoffRThreshold = options?.softCutoffRThreshold ?? 0.35; // default 0.35R
  const momentumWindowMin = options?.momentumWindowMin ?? 30; // default 30 min
  // Soglia proxy momentum: arretramento dal picco > soglia => momentum < 0. Valori fuori [0.05, 1] => default 0.25
  const rawMomentumRetraceR = options?.usMomentumRetraceR;
  const usMomentumRetraceR =
    typeof rawMomentumRetraceR === 'number' &&
    Number.isFinite(rawMomentumRetraceR) &&
    rawMomentumRetraceR >= 0.05 &&
    rawMomentumRetraceR <= 1
      ? rawMomentumRetraceR
      : 0.25;

  const euSoftCutoffCET = options?.euSoftCutoffCET ?? 690; // default 11:30 CET (690 min)
  const euHardCeilingCET = options?.euHardCeilingCET ?? 855; // default 14:15 CET (855 min)
  const euEodCET = options?.euEodCET ?? 1050; // default 17:30 CET (1050 min)
  const usEodCET = options?.usEodCET ?? 1320; // default 22:00 CET (1320 min)

  // CHECK 3: End Of Day (EOD) Market Close
  // EU market closes at 17:30 CET (default 1050m)
  // US market closes at 22:00 CET (default 1320m) / 16:00 NY
  // Also close if calendar date has rolled over
  const tradeDateStr = trade.date; // "DD/MM/YYYY"
  const currentItDateStr = currentTime.toLocaleDateString('it-IT');
  const isPastDay = Boolean(tradeDateStr && currentItDateStr && tradeDateStr !== currentItDateStr);
  const isEuEod = market === 'EU' && (currentMinutes >= euEodCET || options?.sessionInfo?.cet?.marketStatusEU === 'CLOSED');
  const isUsEod = market === 'US' && (currentMinutes >= usEodCET || options?.sessionInfo?.cet?.marketStatusUS === 'CLOSED');

  if (options?.forceEod || isPastDay || isEuEod || isUsEod) {
    const outcome = currentR >= 0.2 ? 'WIN' : currentR <= -0.2 ? 'LOSS' : 'EXPIRED';
    const notif = `🏁 Chiusura EOD: ${trade.ticker} chiuso al termine della sessione a ${effectiveLivePrice.toFixed(2)} (${currentR > 0 ? '+' : ''}${currentR}R).`;
    return closePosition(
      effectiveLivePrice,
      currentR,
      outcome,
      'EOD_CUTOFF',
      `Chiusura di fine sessione (EOD) a ${effectiveLivePrice.toFixed(2)} (${currentR > 0 ? '+' : ''}${currentR}R).`,
      notif
    );
  }

  // CHECK 4: Intraday Cutoff and Soft Cutoff (11:30 EU / 17:30 US)
  const isEuCutoff = market === 'EU' && currentMinutes >= euSoftCutoffCET;
  const isUsCutoff = market === 'US' && currentMinutes >= usSoftCutoffCET;
  const isEuHardCeiling = market === 'EU' && currentMinutes >= euHardCeilingCET;
  const isUsHardCeiling = market === 'US' && currentMinutes >= usHardCeilingCET;

  // Calcolo momentum
  // NOTA: stateHistory viene scritto solo sulle transizioni di stato (attivazione Soft Cutoff / chiusura),
  // non esiste alcun campionamento periodico a 30 minuti: senza storico prezzi il ramo .find sottostante
  // e' non raggiungibile in produzione. Il proxy esplicito su MFE/arretramento e' quindi il percorso operativo.
  let momentum = options?.momentum;
  if (momentum == null) {
    const windowMs = momentumWindowMin * 60 * 1000;
    const cutoffTimeMs = currentTime.getTime();
    const pastState = trade.stateHistory?.find((h) => {
      const hTime = new Date(h.timestamp).getTime();
      return !Number.isNaN(hTime) && cutoffTimeMs - hTime >= windowMs * 0.7;
    });

    if (pastState && typeof pastState.price === 'number') {
      const pastR = riskDist > 0 ? (isLong ? (pastState.price - entry) / riskDist : (entry - pastState.price) / riskDist) : 0;
      momentum = +(currentR - pastR).toFixed(2);
    } else {
      // Fallback proxy: senza storico prezzi usa la distanza residua dal target / arretramento da MFE
      // Se il trade è arretrato rispetto al massimo favorevole raggiunto (distanza residua aumentata), momentum negativo
      // Se il trade è sui massimi favorevoli verso target (distanza residua ridotta al minimo), momentum positivo/nullo
      const retracement = newMfe - currentR;
      momentum = retracement > usMomentumRetraceR ? -1 : 1;
    }
  }

  // Sub-scenario 4A: Trade is ALREADY in Soft Cutoff Extension
  if (trade.softCutoffActive) {
    // Condition 1: Breakeven retest
    const isBreakevenHit = isLong ? effectiveLivePrice <= entry : effectiveLivePrice >= entry;
    if (isBreakevenHit) {
      const notif = `🛡️ Breakeven Attivato: ${trade.ticker} ritracciato al prezzo di carico in Soft Cutoff. Capitale protetto a pareggio (0.00 €).`;
      return closePosition(
        entry,
        0,
        'BREAKEVEN',
        'BREAKEVEN',
        `Chiuso a Breakeven durante estensione Soft Cutoff a ${entry.toFixed(2)}.`,
        notif
      );
    }

    // Condition 2: Hard Exit Ceiling reached
    if ((market === 'EU' && isEuHardCeiling) || (market === 'US' && isUsHardCeiling)) {
      const ceilingTimeStr = market === 'EU' ? '14:15' : '21:30';
      const outcome = currentR >= 0.2 ? 'WIN' : 'BREAKEVEN';
      // US con momentum non negativo: scadenza temporale (CUTOFF_EXPIRED). EU invariato.
      const hardCeilingReason = market === 'US' && momentum >= 0 ? 'CUTOFF_EXPIRED' : 'SOFT_CUTOFF_HARD_EXIT';
      const notif = `⏰ Hard Ceiling Cutoff: ${trade.ticker} chiuso alle ${ceilingTimeStr} CET prima dei macro (+${currentR}R).`;
      return closePosition(
        effectiveLivePrice,
        currentR,
        outcome,
        hardCeilingReason,
        `Hard Exit Ceiling raggiunto (${ceilingTimeStr} CET): incassato a ${effectiveLivePrice.toFixed(2)} (+${currentR}R).`,
        notif
      );
    }
  } else if (market === 'EU' && isEuCutoff) {
    // Regola 1: EU invariata (soft cutoff 11:30 CET, soglia +0.35R, hard ceiling 14:15 CET, EOD 17:30 CET)
    const canSoftExtend = currentR >= softCutoffRThreshold && !isEuHardCeiling;
    if (canSoftExtend) {
      const timestampIso = currentTime.toISOString();
      const updatedTrade: TradeJournalEntry = {
        ...trade,
        softCutoffActive: true,
        softCutoffExtendedAt: timestampIso,
        isBreakevenLocked: true,
        stopLoss: entry, // lock Breakeven
        mfe: newMfe,
        mae: newMae,
        notes: `${trade.notes} | 🛡️ Soft Cutoff Attivato a +${currentR}R: Stop portato a Pareggio (${entry.toFixed(2)}).`.trim(),
        stateHistory: [
          ...prevHistory,
          {
            timestamp: timestampIso,
            status: 'OPEN',
            price: effectiveLivePrice,
            reason: 'SOFT_CUTOFF_ACTIVATED',
            notes: `Soft Cutoff attivato a +${currentR}R. Stop lock a ${entry.toFixed(2)}.`,
          },
        ],
      };
      return {
        updatedTrade,
        wasClosed: false,
        reason: 'SOFT_CUTOFF_ACTIVATED',
        notification: `🛡️ Soft Cutoff Attivato: ${trade.ticker} è a +${currentR}R! Stop protetto a Pareggio (${entry.toFixed(2)}).`,
      };
    } else {
      const outcome = Math.abs(currentR) < 0.2 ? 'BREAKEVEN' : currentR > 0 ? 'WIN' : 'EXPIRED';
      const notif = `⏰ Risoluzione Autonoma: ${trade.ticker} cutoff orario superato (+${currentR}R < +${softCutoffRThreshold}R). Chiusura disciplinata (${outcome}).`;
      return closePosition(
        effectiveLivePrice,
        currentR,
        outcome,
        'CUTOFF_EXPIRED',
        `Cutoff orario superato (+${currentR}R < +${softCutoffRThreshold}R) a ${effectiveLivePrice.toFixed(2)}.`,
        notif
      );
    }
  } else if (market === 'US' && isUsCutoff) {
    // Regole 2 & 3: US decisione dinamica al soft cutoff
    // Regola 3.1: R < softCutoffRThreshold (0.35) -> chiudi a mercato, motivo CUTOFF_EXPIRED
    if (currentR < softCutoffRThreshold) {
      const outcome = Math.abs(currentR) < 0.2 ? 'BREAKEVEN' : currentR > 0 ? 'WIN' : 'EXPIRED';
      const notif = `⏰ Risoluzione Autonoma US: ${trade.ticker} cutoff superato (+${currentR}R < +${softCutoffRThreshold}R). Chiusura disciplinata (${outcome}).`;
      return closePosition(
        effectiveLivePrice,
        currentR,
        outcome,
        'CUTOFF_EXPIRED',
        `Cutoff orario US superato (+${currentR}R < +${softCutoffRThreshold}R) a ${effectiveLivePrice.toFixed(2)}.`,
        notif
      );
    }

    // Regola 3.2: R >= softCutoffRThreshold e momentum >= 0 -> stop a pareggio, resta aperta fino a target, stop o hard ceiling
    if (momentum >= 0 && !isUsHardCeiling) {
      const timestampIso = currentTime.toISOString();
      const updatedTrade: TradeJournalEntry = {
        ...trade,
        softCutoffActive: true,
        softCutoffExtendedAt: timestampIso,
        isBreakevenLocked: true,
        stopLoss: entry, // lock Breakeven
        mfe: newMfe,
        mae: newMae,
        notes: `${trade.notes} | 🛡️ Soft Cutoff US: Estensione dinamica (+${currentR}R >= +${softCutoffRThreshold}R, momentum ${momentum >= 0 ? '+' : ''}${momentum} >= 0). Stop a pareggio (${entry.toFixed(2)}).`.trim(),
        stateHistory: [
          ...prevHistory,
          {
            timestamp: timestampIso,
            status: 'OPEN',
            price: effectiveLivePrice,
            reason: 'SOFT_CUTOFF_ACTIVATED',
            notes: `Soft Cutoff US attivo: +${currentR}R, momentum ${momentum}. Stop lock a ${entry.toFixed(2)}.`,
          },
        ],
      };
      return {
        updatedTrade,
        wasClosed: false,
        reason: 'SOFT_CUTOFF_ACTIVATED',
        notification: `🛡️ Soft Cutoff US Attivato: ${trade.ticker} a +${currentR}R con momentum positivo (${momentum}). Stop protetto a Pareggio (${entry.toFixed(2)}).`,
      };
    }

    // Regola 3.3: R >= softCutoffRThreshold e momentum >= 0 ma hard ceiling US raggiunto (21:30 CET)
    // -> chiusura per scadenza oraria, MAI come perdita di momentum
    if (momentum >= 0) {
      const outcome = currentR >= 0.2 ? 'WIN' : 'BREAKEVEN';
      const notif = `⏰ Hard Ceiling Cutoff: ${trade.ticker} chiuso alle 21:30 CET per scadenza temporale (+${currentR}R).`;
      return closePosition(
        effectiveLivePrice,
        currentR,
        outcome,
        'CUTOFF_EXPIRED',
        `Hard Ceiling US raggiunto (21:30 CET) con momentum non negativo (${momentum}): chiusura per scadenza a ${effectiveLivePrice.toFixed(2)} (+${currentR}R).`,
        notif
      );
    }

    // Regola 3.4: R >= softCutoffRThreshold e momentum < 0 -> chiudi a mercato, motivo CUTOFF_MOMENTUM_LOSS
    const outcome = currentR >= 0.2 ? 'WIN' : 'BREAKEVEN';
    const notif = `📉 Risoluzione Cutoff Momentum Loss: ${trade.ticker} a +${currentR}R ma con perdita di momentum (${momentum} < 0). Chiusura protettiva anticipata.`;
    return closePosition(
      effectiveLivePrice,
      currentR,
      outcome,
      'CUTOFF_MOMENTUM_LOSS',
      `Chiusura al cutoff US per perdita di momentum (+${currentR}R, momentum ${momentum} < 0) a ${effectiveLivePrice.toFixed(2)}.`,
      notif
    );
  }

  // If still OPEN, update MFE and MAE
  const mfeOrMaeChanged = trade.mfe !== newMfe || trade.mae !== newMae;
  if (mfeOrMaeChanged) {
    return {
      updatedTrade: {
        ...trade,
        mfe: newMfe,
        mae: newMae,
      },
      wasClosed: false,
    };
  }

  return { updatedTrade: trade, wasClosed: false };
}

// ---------------------------------------------------------------------------
// Session VWAP cumulativa di sessione
// Calcolo + esposizione nel payload; alimenta lo stato VWAP di computeVwapState (contributo allo score).
// Con il default TRADING_PARAMS.VWAP_SCORE_WEIGHT = 0 il contributo allo score resta nullo.
// `getMarketTime` e' gia' importato in testa al modulo da './timezone'.
// ---------------------------------------------------------------------------

export interface VwapBar {
  timestamp: number; // secondi unix, inizio barra
  open?: number | null; // apertura barra (usata dal quality gate, non dal VWAP)
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface SessionVwapResult {
  vwap: number | null;
  cumulativeVolume: number;
  barsUsed: number;
  barsWithVolume: number;
  coverage: number | null; // barre con volume / barre attese fino a nowMinutes
}

// VWAP cumulativa di sessione: sum(typical * volume) / sum(volume), typical = (H+L+C)/3
// Finestre (minuti dal mezzanotte, fuso del mercato, fine esclusa):
// US regolare 570-960 (09:30-16:00 NY); US con pre-market 240-960 (04:00-16:00 NY); EU 540-1050 (09:00-17:30 Roma)
/**
 * Definizione della VWAP usata dal progetto
 * -----------------------------------------
 * Formula: sum(typical_i * volume_i) / sum(volume_i)  con  typical_i = (high_i + low_i + close_i) / 3.
 * Fonte volumi: barre a 5 minuti del feed Yahoo Finance (chart 5m, `indicators.quote[0].volume`),
 *   gli stessi high/low/close usati per il prezzo: nessun volume sintetico, stimato o da proxy.
 * Ancora temporale: il timestamp di ogni barra e' l'INIZIO della barra (Unix secondi) e la barra
 *   viene attribuita alla sessione leggendo l'orario LOCALE di mercato via Intl
 *   (America/New_York per US, Europe/Rome per EU), mai UTC.
 * Pre/post mercato: le barre entrano solo nella finestra scelta, con fine esclusa:
 *   - US sessione regolare 570-960 minuti locali (09:30-16:00 ET);
 *   - US con pre-market 240-960 (04:00-16:00 ET), solo con includePreMarket o VWAP_SOURCE = 'withPre';
 *   - EU 540-1050 (09:00-17:30 Roma).
 *   Il post-market (dalle 16:00 ET in poi) e' sempre escluso; per i segnali (computeVwapState) una barra
 *   piu' recente fuori sessione regolare, o troppo illiquida, produce state = UNKNOWN con flag AFTER_HOURS.
 * Attenzione: il campo numerico `quote.vwap` NON usa questa formula. E' il prezzo tipico
 *   (todayHigh + todayLow + currentPrice) / 3, senza volumi e senza cumulazione (vedi server.ts).
 */
export function computeSessionVwap(
  bars: VwapBar[],
  market: 'EU' | 'US',
  sessionDate: string, // 'YYYY-MM-DD' nel fuso del mercato
  options: { includePreMarket?: boolean; nowMinutes?: number } = {}
): SessionVwapResult {
  const includePre = market === 'US' && options.includePreMarket === true;
  const startM = market === 'US' ? (includePre ? 240 : 570) : 540;
  const endM = market === 'US' ? 960 : 1050;

  let pv = 0;
  let vol = 0;
  let barsUsed = 0;
  let barsWithVolume = 0;

  for (const b of bars) {
    if (b.high == null || b.low == null || b.close == null) continue;
    const mt = getMarketTime(market, new Date(b.timestamp * 1000));
    if (mt.dateFormatted !== sessionDate) continue;
    if (mt.totalMinutes < startM || mt.totalMinutes >= endM) continue;
    barsUsed++;
    const v = b.volume != null && b.volume > 0 ? b.volume : 0;
    if (v === 0) continue;
    barsWithVolume++;
    pv += ((b.high + b.low + b.close) / 3) * v;
    vol += v;
  }

  const upTo = Math.min(options.nowMinutes ?? endM, endM);
  const expected = Math.max(0, Math.floor((upTo - startM) / 5));

  return {
    vwap: vol > 0 ? pv / vol : null,
    cumulativeVolume: vol,
    barsUsed,
    barsWithVolume,
    coverage: expected > 0 ? Math.min(1, barsWithVolume / expected) : null,
  };
}

// ---------------------------------------------------------------------------
// Quality gate dei dati VWAP: il VWAP contribuisce allo score SOLO se la serie e' affidabile.
// Se il gate fallisce: state UNKNOWN, flag DATA_QUALITY:<reason>, contributo 0.
// Tutte le soglie sono IPOTESI (TRADING_PARAMS.VWAP_*), da validare empiricamente.
// ---------------------------------------------------------------------------

export interface VwapQualityOptions {
  feedError?: string | null; // es. 'HTTP 429' dal fetch Yahoo
  vwapOverride?: number | null; // livello VWAP da validare (default: quote.vwap o VWAP calcolata)
}

/**
 * Verifica la qualita' della serie 5m prima di dare un segnale VWAP.
 * Ordine dei controlli (il primo che fallisce determina `reason`):
 * a FEED_ERROR, b NON_FINITE, c OHLC_INCONSISTENT, d DUPLICATE_OR_UNSORTED, e GAP,
 * f ZERO_VOLUME, g LOW_COVERAGE, h STALE, i OUT_OF_RANGE, j QUOTE_MISMATCH.
 * I controlli strutturali (b, c) si applicano alle barre della sessione corrente dentro la
 * finestra regolare, cioe' alla serie che alimenta la VWAP.
 */
export function computeVwapDataQuality(
  bars: VwapBar[],
  quote: { currentPrice?: number | null; vwap?: number | null } | null,
  market: 'EU' | 'US',
  now: Date,
  options: VwapQualityOptions = {}
): VwapDataQuality {
  const fail = (reason: string, coverage = 0): VwapDataQuality => ({ ok: false, reason, coverage: +coverage.toFixed(3) });

  // a. FEED_ERROR: richiesta fallita (es. 429) o nessuna barra restituita
  if (options.feedError) return fail('FEED_ERROR');
  if (!bars || bars.length === 0) return fail('FEED_ERROR');

  const mtNow = getMarketTime(market, now);
  const sessionDate = mtNow.dateFormatted;
  const nowMinutes = mtNow.totalMinutes;
  const openMinutes = market === 'US' ? 570 : 540;
  const closeMinutes = market === 'US' ? 960 : 1050;
  const upTo = Math.min(nowMinutes, closeMinutes);

  type RawBar = {
    timestamp: number;
    minutes: number;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
  };
  const sessionBars: RawBar[] = [];
  for (const b of bars) {
    const mt = getMarketTime(market, new Date(b.timestamp * 1000));
    if (mt.dateFormatted !== sessionDate) continue;
    if (mt.totalMinutes < openMinutes || mt.totalMinutes >= closeMinutes) continue;
    sessionBars.push({
      timestamp: b.timestamp,
      minutes: mt.totalMinutes,
      open: b.open ?? null,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    });
  }

  // b. NON_FINITE: high/low/close/volume null o NaN, prezzi <= 0
  for (const r of sessionBars) {
    for (const n of [r.high, r.low, r.close, r.volume]) {
      if (n == null || !isFinite(n) || isNaN(n)) return fail('NON_FINITE');
    }
    if ((r.high as number) <= 0 || (r.low as number) <= 0 || (r.close as number) <= 0) return fail('NON_FINITE');
    if (r.open != null && (!isFinite(r.open) || isNaN(r.open) || r.open <= 0)) return fail('NON_FINITE');
  }

  // c. OHLC_INCONSISTENT: high < low, oppure open/close fuori da [low, high]
  for (const r of sessionBars) {
    const hi = r.high as number;
    const lo = r.low as number;
    const cl = r.close as number;
    if (hi < lo) return fail('OHLC_INCONSISTENT');
    if (cl < lo || cl > hi) return fail('OHLC_INCONSISTENT');
    if (r.open != null && (r.open < lo || r.open > hi)) return fail('OHLC_INCONSISTENT');
  }

  // d. DUPLICATE_OR_UNSORTED: timestamp non strettamente crescenti
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].timestamp <= bars[i - 1].timestamp) return fail('DUPLICATE_OR_UNSORTED');
  }

  const regular = sessionBars
    .filter((r) => r.minutes < upTo)
    .map((r) => {
      const hi = r.high as number;
      const lo = r.low as number;
      const cl = r.close as number;
      return {
        timestamp: r.timestamp,
        minutes: r.minutes,
        high: hi,
        low: lo,
        close: cl,
        volume: r.volume as number,
        typical: (hi + lo + cl) / 3,
      };
    });

  // e. GAP: buco interno nella griglia 5m della sessione prima della valutazione
  for (let i = 1; i < regular.length; i++) {
    if (regular[i].minutes - regular[i - 1].minutes > 5) return fail('GAP');
  }

  // f. ZERO_VOLUME: barre di sessione a volume 0 oltre la soglia tollerata (IPOTESI: 0)
  const zeroVolumeBars = regular.filter((r) => r.volume === 0).length;
  if (zeroVolumeBars > TRADING_PARAMS.VWAP_MAX_ZERO_VOLUME_BARS) return fail('ZERO_VOLUME');

  // g. LOW_COVERAGE: barre presenti / barre attese dall'apertura alla valutazione
  const expected = Math.max(0, Math.floor((upTo - openMinutes) / 5));
  const coverage = expected > 0 ? Math.min(1, regular.length / expected) : 0;
  if (coverage < TRADING_PARAMS.VWAP_MIN_COVERAGE) return fail('LOW_COVERAGE', coverage);

  // h. STALE: ultima barra piu' vecchia di VWAP_MAX_STALE_MIN mentre la sessione e' aperta
  const lastRegular = regular.length > 0 ? regular[regular.length - 1] : null;
  if (
    nowMinutes >= openMinutes &&
    nowMinutes < closeMinutes &&
    lastRegular != null &&
    nowMinutes - lastRegular.minutes > TRADING_PARAMS.VWAP_MAX_STALE_MIN
  ) {
    return fail('STALE', coverage);
  }

  // i. OUT_OF_RANGE: il livello VWAP usato deve stare dentro [minimo, massimo] di sessione
  let pv = 0;
  let vol = 0;
  let sessionLow = Infinity;
  let sessionHigh = -Infinity;
  for (const r of regular) {
    if (r.volume > 0) {
      pv += r.typical * r.volume;
      vol += r.volume;
    }
    sessionLow = Math.min(sessionLow, r.low);
    sessionHigh = Math.max(sessionHigh, r.high);
  }
  const computedVwap = vol > 0 ? pv / vol : null;
  const quoteVwap = quote?.vwap != null && isFinite(quote.vwap) && quote.vwap > 0 ? quote.vwap : null;
  const vwapLevel = options.vwapOverride ?? quoteVwap ?? computedVwap;
  if (
    vwapLevel != null &&
    isFinite(vwapLevel) &&
    sessionLow !== Infinity &&
    (vwapLevel < sessionLow - TRADING_PARAMS.EPSILON || vwapLevel > sessionHigh + TRADING_PARAMS.EPSILON)
  ) {
    return fail('OUT_OF_RANGE', coverage);
  }

  // j. QUOTE_MISMATCH: ultima chiusura 5m troppo distante dal prezzo corrente della quote
  const price = quote?.currentPrice;
  if (price == null || !isFinite(price) || price <= 0) return fail('QUOTE_MISMATCH', coverage);
  if (lastRegular != null && Math.abs(lastRegular.close - price) / price > TRADING_PARAMS.VWAP_MAX_QUOTE_DRIFT_PCT) {
    return fail('QUOTE_MISMATCH', coverage);
  }

  return { ok: true, reason: null, coverage: +coverage.toFixed(3) };
}

/** Conteggio dei candidati per esito del quality gate (log di scansione). */
export function summarizeVwapDataQuality(
  quotes: Array<{ vwapDataQuality?: VwapDataQuality | null }>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const q of quotes) {
    const dq = q.vwapDataQuality;
    const key = !dq ? 'missing' : dq.ok ? 'ok' : `DATA_QUALITY:${dq.reason ?? 'UNKNOWN'}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Riga di log per scansione: visibile nel report, non nella UI. */
export function formatVwapDataQualityScan(
  market: 'EU' | 'US' | 'ALL',
  quotes: Array<{ vwapDataQuality?: VwapDataQuality | null }>
): string {
  const counts = summarizeVwapDataQuality(quotes);
  const parts = Object.keys(counts)
    .sort()
    .map((k) => `${k}=${counts[k]}`);
  return `[VWAP quality] scan ${market}: ${quotes.length} candidati | ${parts.join(' | ')}`;
}

// ---------------------------------------------------------------------------
// VWAP di sessione: stato per candidato e contributo allo score
// Tutte le soglie sono IPOTESI (TRADING_PARAMS.VWAP_*), da validare empiricamente.
// ---------------------------------------------------------------------------

export interface VwapStateParams {
  minCoverage: number;
  nearAtr: number;
  rejectVolMult: number;
  slopeBars: number;
  openWindowMin: number;
}

export interface VwapScoreOptions {
  weight?: number;
  openWeightFactor?: number;
  hardGate?: boolean;
  neutralBandAtr?: number;
  minVolumeRatio?: number;
  vetoEnabled?: boolean; // VWAP_VETO_ENABLED: stato contrario con volume confermato = veto
}

// ATR approssimato sulle barre 5m della sessione (media semplice dei range H-L)
export function calculateAtr5m(bars: VwapBar[], period: number = 14): number | null {
  const valid = bars.filter((b) => b.high != null && b.low != null);
  if (valid.length === 0) return null;
  const slice = valid.slice(-period);
  const sum = slice.reduce((acc, b) => acc + ((b.high as number) - (b.low as number)), 0);
  const atr = sum / slice.length;
  return atr > 0 ? atr : null;
}

// Riconosce un ritorno alla VWAP con tenuta (PULLBACK), valutato sulla barra 5m piu' recente:
// il minimo (up) / massimo (down) tocca la VWAP entro VWAP_NEAR_ATR dalla parte giusta e la chiusura tiene.
function hasVwapPullbackHold(
  last: { close: number; high: number; low: number },
  vwapNow: number,
  atr: number,
  nearAtr: number,
  side: 'up' | 'down'
): boolean {
  const tol = nearAtr * atr;
  if (side === 'up') {
    return last.low >= vwapNow && last.low - vwapNow <= tol && last.close > vwapNow;
  }
  return last.high <= vwapNow && vwapNow - last.high <= tol && last.close < vwapNow;
}

export function computeVwapState(
  bars: VwapBar[],
  options: {
    market: 'EU' | 'US';
    sessionDate: string;
    atr5m: number | null;
    vwapCumulative?: number | null;
    coverage?: number | null;
    nowMinutes?: number;
    source?: 'session' | 'withPre';
    params?: Partial<VwapStateParams>;
  }
): VwapSignalState {
  const p: VwapStateParams = {
    minCoverage: options.params?.minCoverage ?? TRADING_PARAMS.VWAP_MIN_COVERAGE,
    nearAtr: options.params?.nearAtr ?? TRADING_PARAMS.VWAP_NEAR_ATR,
    rejectVolMult: options.params?.rejectVolMult ?? TRADING_PARAMS.VWAP_REJECT_VOL_MULT,
    slopeBars: options.params?.slopeBars ?? TRADING_PARAMS.VWAP_SLOPE_BARS,
    openWindowMin: options.params?.openWindowMin ?? TRADING_PARAMS.VWAP_OPEN_WINDOW_MIN,
  };

  const source = options.source ?? TRADING_PARAMS.VWAP_SOURCE;
  const includePre = options.market === 'US' && source === 'withPre';
  const startM = options.market === 'US' ? (includePre ? 240 : 570) : 540;
  const endM = options.market === 'US' ? 960 : 1050;

  const flags: string[] = [];
  const nowM = options.nowMinutes ?? endM;
  if (nowM - startM < p.openWindowMin) flags.push('OPEN_WINDOW');

  const series: { close: number; high: number; low: number; volume: number; vwap: number }[] = [];
  let pv = 0;
  let vol = 0;

  for (const b of bars) {
    if (b.high == null || b.low == null || b.close == null) continue;
    const mt = getMarketTime(options.market, new Date(b.timestamp * 1000));
    if (mt.dateFormatted !== options.sessionDate) continue;
    if (mt.totalMinutes < startM || mt.totalMinutes >= endM) continue;
    const v = b.volume != null && b.volume > 0 ? b.volume : 0;
    const typical = (b.high + b.low + b.close) / 3;
    if (v > 0) {
      pv += typical * v;
      vol += v;
    }
    series.push({ close: b.close, high: b.high, low: b.low, volume: v, vwap: vol > 0 ? pv / vol : typical });
  }

  const coverage = options.coverage ?? null;
  const atr = options.atr5m != null && options.atr5m > 0 ? options.atr5m : null;
  const last = series.length > 0 ? series[series.length - 1] : null;
  const vwapNow =
    options.vwapCumulative != null && options.vwapCumulative > 0
      ? options.vwapCumulative
      : last
      ? last.vwap
      : null;

  if (atr == null) flags.push('ATR_MISSING');

  const distAtr =
    vwapNow != null && last != null && atr != null ? +((last.close - vwapNow) / atr).toFixed(3) : null;
  const backIdx = Math.max(0, series.length - 1 - p.slopeBars);
  const slopeAtr =
    vwapNow != null && series.length > 0 && atr != null
      ? +((vwapNow - series[backIdx].vwap) / atr).toFixed(3)
      : null;

  const vwapLevel = vwapNow != null ? +vwapNow.toFixed(2) : null;

  // Volume relativo della barra 5m piu' recente rispetto alla media 5m della stessa serie
  const volumesForRatio = series.map((s) => s.volume).filter((v) => v > 0);
  const avgVolume5m =
    volumesForRatio.length > 0
      ? volumesForRatio.reduce((a, b) => a + b, 0) / volumesForRatio.length
      : 0;
  const volumeRatio =
    last != null && avgVolume5m > 0 ? +(last.volume / avgVolume5m).toFixed(2) : null;

  const mk = (
    state: VwapStateName,
    d: number | null,
    sl: number | null,
    cov: number | null,
    fl: string[],
    lvl: number | null
  ): VwapSignalState => ({
    state,
    distAtr: d,
    slopeAtr: sl,
    coverage: cov,
    volumeRatio,
    flags: fl,
    vwapLevel: lvl,
  });

  if (coverage == null || coverage < p.minCoverage) {
    if (coverage != null && coverage < p.minCoverage) flags.push('LOW_VWAP_COVERAGE');
    return mk('UNKNOWN', distAtr, slopeAtr, coverage, flags, vwapLevel);
  }

  // Regola after-hours (IPOTESI): nessun segnale VWAP fuori dalla sessione regolare o su barra illiquida.
  // Si guarda l'ultima barra disponibile per la sessione, anche quando e' esclusa dalla finestra di calcolo.
  let latestSessionBar: { minutes: number; volume: number } | null = null;
  for (const b of bars) {
    if (b.high == null || b.low == null || b.close == null) continue;
    const mt = getMarketTime(options.market, new Date(b.timestamp * 1000));
    if (mt.dateFormatted !== options.sessionDate) continue;
    const v = b.volume != null && b.volume > 0 ? b.volume : 0;
    if (latestSessionBar == null || mt.totalMinutes >= latestSessionBar.minutes) {
      latestSessionBar = { minutes: mt.totalMinutes, volume: v };
    }
  }

  if (latestSessionBar != null) {
    const regularStart = options.market === 'US' ? 570 : 540;
    const regularEnd = options.market === 'US' ? 960 : 1050;
    const volsForRatio = series.map((s) => s.volume).filter((v) => v > 0);
    const avgVolForRatio =
      volsForRatio.length > 0 ? volsForRatio.reduce((a, b) => a + b, 0) / volsForRatio.length : 0;
    const outsideRegular =
      latestSessionBar.minutes < regularStart || latestSessionBar.minutes >= regularEnd;
    const thinVolume =
      latestSessionBar.volume === 0 ||
      (avgVolForRatio > 0 &&
        latestSessionBar.volume < avgVolForRatio * TRADING_PARAMS.VWAP_AFTER_HOURS_VOL_RATIO);
    if (outsideRegular || thinVolume) {
      flags.push('AFTER_HOURS');
      return mk('UNKNOWN', distAtr, slopeAtr, coverage, flags, vwapLevel);
    }
  }
  if (atr == null || last == null || series.length < 2 || vwapNow == null) {
    return mk('UNKNOWN', distAtr, slopeAtr, coverage, flags, vwapLevel);
  }

  const prev = series[series.length - 2];
  const volumes = series.map((s) => s.volume).filter((v) => v > 0);
  const avgVol = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
  const volumeOk = avgVol > 0 && last.volume >= p.rejectVolMult * avgVol;

  const crossedUp = prev.close < prev.vwap && last.close > vwapNow;
  const crossedDown = prev.close > prev.vwap && last.close < vwapNow;
  const rejectedDown = last.high > vwapNow && last.close < vwapNow;
  const rejectedUp = last.low < vwapNow && last.close > vwapNow;

  if (rejectedDown || rejectedUp || crossedUp || crossedDown) {
    const eventState: VwapStateName = rejectedDown || rejectedUp ? 'REJECT' : 'RECLAIM';
    if (volumeOk) {
      return mk(eventState, distAtr, slopeAtr, coverage, flags, vwapLevel);
    }
    // Volume insufficiente: nessun evento riconosciuto, resta lo stato direzionale
    flags.push('WEAK_VWAP_BREAK');
    const fallback: VwapStateName = last.close >= vwapNow ? 'ABOVE' : 'BELOW';
    return mk(fallback, distAtr, slopeAtr, coverage, flags, vwapLevel);
  }

  if (last.close >= vwapNow && hasVwapPullbackHold(last, vwapNow, atr, p.nearAtr, 'up')) {
    return mk('PULLBACK', distAtr, slopeAtr, coverage, flags, vwapLevel);
  }
  if (last.close <= vwapNow && hasVwapPullbackHold(last, vwapNow, atr, p.nearAtr, 'down')) {
    return mk('PULLBACK', distAtr, slopeAtr, coverage, flags, vwapLevel);
  }

  return mk(
    last.close >= vwapNow ? 'ABOVE' : 'BELOW',
    distAtr,
    slopeAtr,
    coverage,
    flags,
    vwapLevel
  );
}

export interface VwapBarContext {
  volume?: number | null; // volume della barra 5m piu' recente della sessione
  barTime?: number | string | Date | null; // timestamp della stessa barra (secondi/ms unix o ISO)
}

function parseVwapBarTimeMs(barTime: number | string | Date | null | undefined): number | null {
  if (barTime == null) return null;
  if (barTime instanceof Date) return isNaN(barTime.getTime()) ? null : barTime.getTime();
  if (typeof barTime === 'number') {
    if (!isFinite(barTime) || barTime <= 0) return null;
    return barTime > 1e11 ? barTime : barTime * 1000;
  }
  const ms = Date.parse(barTime);
  return isNaN(ms) ? null : ms;
}

/**
 * Stato VWAP usato dal punteggio, a partire da quote.vwapState e dalla barra 5m che lo ha generato.
 * Se la barra e' fuori sessione regolare (prima delle 09:30 o dalle 16:00 ET in poi, EU fuori
 * 09:00-17:30) o non ha volume, lo stato diventa UNKNOWN con flag AFTER_HOURS / THIN_BAR_VOLUME:
 * nessun segnale VWAP in after-market e nessun contributo allo score.
 * Senza dati di barra lo stato calcolato dal feed resta invariato (retrocompatibile).
 */
export function resolveVwapStateForScoring(
  vwapState: VwapSignalState | null | undefined,
  vwapBar: VwapBarContext | null | undefined,
  market: 'EU' | 'US',
  quality?: VwapDataQuality | null
): VwapSignalState | null {
  // Quality gate: dati inaffidabili -> nessun segnale, motivo esplicito, contributo 0.
  if (quality && !quality.ok) {
    const flag = `DATA_QUALITY:${quality.reason ?? 'UNKNOWN'}`;
    const base: VwapSignalState = vwapState ?? {
      state: 'UNKNOWN',
      distAtr: null,
      slopeAtr: null,
      coverage: quality.coverage,
      volumeRatio: null,
      flags: [],
      vwapLevel: null,
    };
    const flags = base.flags.includes(flag) ? base.flags : [flag, ...base.flags];
    return { ...base, state: 'UNKNOWN', coverage: quality.coverage, flags };
  }

  if (!vwapState) return null;

  const barMs = parseVwapBarTimeMs(vwapBar?.barTime);
  if (barMs == null) return vwapState;

  const marketTime = getMarketTime(market, new Date(barMs));
  const startM = market === 'US' ? 570 : 540;
  const endM = market === 'US' ? 960 : 1050;
  const outsideRegular = marketTime.totalMinutes < startM || marketTime.totalMinutes >= endM;

  const volume = vwapBar?.volume;
  const thinBar = volume == null || !isFinite(volume) || volume <= 0;

  if (!outsideRegular && !thinBar) return vwapState;

  const flag = outsideRegular ? 'AFTER_HOURS' : 'THIN_BAR_VOLUME';
  const flags = vwapState.flags.includes(flag) ? vwapState.flags : [...vwapState.flags, flag];
  return { ...vwapState, state: 'UNKNOWN', flags };
}

// Segno del segnale VWAP: +1 rialzista, -1 ribassista, 0 neutro/non valutabile.
// ABOVE/BELOW sono intrinsecamente direzionali; PULLBACK/RECLAIM/REJECT usano il segno di distAtr.
export function vwapStateSign(vwapState: VwapSignalState | null | undefined): -1 | 0 | 1 {
  if (!vwapState) return 0;
  if (
    vwapState.state === 'UNKNOWN' ||
    vwapState.state === 'NEUTRAL' ||
    vwapState.state === 'UNCONFIRMED'
  ) {
    return 0;
  }
  if (vwapState.state === 'ABOVE') return 1;
  if (vwapState.state === 'BELOW') return -1;
  const dist = vwapState.distAtr;
  if (dist == null || dist === 0) return 0;
  return dist > 0 ? 1 : -1;
}

export function isVwapStateAligned(
  vwapState: VwapSignalState | null | undefined,
  direction: 'LONG' | 'SHORT'
): boolean {
  const sign = vwapStateSign(vwapState);
  return direction === 'LONG' ? sign > 0 : sign < 0;
}

export function isVwapStateOpposed(
  vwapState: VwapSignalState | null | undefined,
  direction: 'LONG' | 'SHORT'
): boolean {
  const sign = vwapStateSign(vwapState);
  return direction === 'LONG' ? sign < 0 : sign > 0;
}

function pickVwapFlag(flags: string[]): string {
  const dataQuality = flags.find((f) => f.startsWith('DATA_QUALITY:'));
  if (dataQuality) return dataQuality;
  const priority = [
    'AFTER_HOURS',
    'LOW_VOLUME',
    'THIN_BAR_VOLUME',
    'MISSING_VOLUME',
    'LOW_VWAP_COVERAGE',
    'WEAK_VWAP_BREAK',
    'ATR_MISSING',
  ];
  for (const f of priority) if (flags.includes(f)) return f;
  return 'UNKNOWN';
}

export interface VwapContribution {
  score: number; // punti aggiunti a rawTotal
  state: VwapStateName; // stato effettivo mostrato nel breakdown
  detail: string; // riga VWAP sempre valorizzata
  gated: boolean; // true solo con VWAP_HARD_GATE attivo e segnale contrario
}

/**
 * Contributo VWAP allo score (IPOTESI, vedi TRADING_PARAMS.VWAP_*):
 * - ABOVE/RECLAIM con volume confermato: +/- W scalato su |distAtr| fino a 1 ATR (cap a W)
 * - PULLBACK con volume confermato e tenuta: +/- W/2
 * - BELOW/REJECT con volume confermato: -/+ W pieno
 * - |distAtr| < VWAP_NEUTRAL_BAND_ATR: NEUTRAL, 0
 * - volume < VWAP_MIN_VOLUME_RATIO (o assente): UNCONFIRMED, 0
 * - UNKNOWN (AFTER_HOURS, LOW_VOLUME, ...): 0, flag riportato
 * La riga `detail` e' SEMPRE presente, anche a contributo 0.
 */
export function calculateVwapScoreContribution(
  vwapState: VwapSignalState | null | undefined,
  direction: 'LONG' | 'SHORT',
  options: VwapScoreOptions = {}
): VwapContribution {
  const weight = options.weight ?? TRADING_PARAMS.VWAP_SCORE_WEIGHT;
  const neutralBand = options.neutralBandAtr ?? TRADING_PARAMS.VWAP_NEUTRAL_BAND_ATR;
  const minVolumeRatio = options.minVolumeRatio ?? TRADING_PARAMS.VWAP_MIN_VOLUME_RATIO;
  const openFactor = options.openWeightFactor ?? TRADING_PARAMS.VWAP_OPEN_WEIGHT_FACTOR;
  const vetoEnabled = options.vetoEnabled ?? TRADING_PARAMS.VWAP_VETO_ENABLED;

  const unknown = (flag: string): VwapContribution => ({
    score: 0,
    state: 'UNKNOWN',
    detail: `VWAP: UNKNOWN (${flag}) | contributo 0/${weight}`,
    gated: false,
  });

  if (!vwapState) return unknown('MISSING_VWAP');
  if (vwapState.state === 'UNKNOWN') return unknown(pickVwapFlag(vwapState.flags));

  const dist = vwapState.distAtr;
  if (dist == null || !isFinite(dist)) return unknown('ATR_MISSING');

  const volumeRatio = vwapState.volumeRatio;
  const volTxt = volumeRatio != null ? `${volumeRatio.toFixed(2)}x` : 'nd';
  const distTxt = dist.toFixed(2);
  const neutralPoints = weight <= 0 ? 0 : Math.round(weight / 2);

  const neutral = (): VwapContribution => ({
    score: neutralPoints,
    state: 'NEUTRAL',
    detail: `VWAP: NEUTRAL | dist ${distTxt} ATR | vol ${volTxt} | contributo ${neutralPoints}/${weight}`,
    gated: false,
  });

  if (Math.abs(dist) < neutralBand) return neutral();

  if (volumeRatio == null || !isFinite(volumeRatio) || volumeRatio < minVolumeRatio) {
    return {
      score: 0,
      state: 'UNCONFIRMED',
      detail: `VWAP: UNCONFIRMED | dist ${distTxt} ATR | vol ${volTxt} | contributo 0/${weight}`,
      gated: false,
    };
  }

  const sign = vwapStateSign(vwapState);
  if (sign === 0) return neutral();

  const dirSign = direction === 'LONG' ? 1 : -1;

  // Stato contrario con volume confermato: contributo 0 (mai negativo) + veto se abilitato.
  if (sign * dirSign < 0) {
    return {
      score: 0,
      state: vwapState.state,
      detail: `VWAP: ${vwapState.state} | dist ${distTxt} ATR | vol ${volTxt} | contraria al setup | contributo 0/${weight}`,
      gated: vetoEnabled,
    };
  }

  const openWindow = vwapState.flags.includes('OPEN_WINDOW');
  const points = weight <= 0 ? 0 : Math.max(1, Math.round(weight * (openWindow ? openFactor : 1)));

  return {
    score: points,
    state: vwapState.state,
    detail: `VWAP: ${vwapState.state} | dist ${distTxt} ATR | vol ${volTxt} | contributo ${points}/${weight}`,
    gated: false,
  };
}

export function passesVwapHardGate(
  vwapState: VwapSignalState | null | undefined,
  direction: 'LONG' | 'SHORT',
  params?: { hardGate?: boolean }
): boolean {
  const hardGate = params?.hardGate ?? TRADING_PARAMS.VWAP_HARD_GATE;
  if (!hardGate) return true;
  if (!vwapState || vwapState.state === 'UNKNOWN') return true;
  return !isVwapStateOpposed(vwapState, direction);
}
