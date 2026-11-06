export interface UnderlyingItem {
  ticker: string;
  nome: string;
  mercato: 'EU' | 'US';
  valuta: string;
}

export interface RawQuoteData {
  ticker: string;
  name: string;
  market: 'EU' | 'US';
  currency: string;
  prevClose: number | null;
  currentPrice: number | null;
  preMarketPrice: number | null;
  prevHigh: number | null;
  prevLow: number | null;
  preMarketHigh: number | null;
  preMarketLow: number | null;
  todayOpen?: number | null;
  todayHigh?: number | null;
  todayLow?: number | null;
  vwap?: number | null;
  vwapCumulative?: number | null; // VWAP cumulativa di sessione calcolata dalle barre 5m (server -> scoring)
  vwapState?: VwapSignalState | null;
  lastBarVolume?: number | null; // volume della barra 5m piu' recente della sessione (getIntraday5mMetrics)
  lastBarTime?: number | null; // timestamp unix (secondi) della stessa barra
  vwapDataQuality?: VwapDataQuality | null; // esito del quality gate VWAP (server -> scoring), usato dal VWAP scoring
  setupIndicators?: SetupIndicators | null; // indicatori 5m (Supertrend, ADX, StochRSI, PSAR) calcolati dal server
  scoreBreakdown?: Record<string, number> | null; // breakdown dello score usato nel contesto AI
  setupVeto?: string | null; // reason del veto attivo sul setup, se presente
  ema20Daily?: number | null;
  avgVolume20d: number | null;
  preMarketVolume: number | null;
  atr14: number | null;
  adr14?: number | null;
  liqEur20d?: number | null;
  fxRate?: number | null;
  orbHigh?: number | null;
  orbLow?: number | null;
  orbBreakoutTime?: string | null;
  orbBreakoutTimeLong?: string | null;
  orbBreakoutTimeShort?: string | null;
  completedBarsCount?: number | null;
  T?: number | null;
  E?: number | null;
  S?: number | null;
  gapPercent: number | null;
  rvol: number | null;
  impliedVolatility?: number | null;
  historicalVolatility30d?: number | null;
  ivRank?: number | null;
  rsi14?: number | null;
  rsi5m?: number | null;
  rvol20m?: number | null;
  orderFlow?: OrderFlowMetrics | null;
  timestamp: string;
  source: string;
}

export type EntryMode = 'SNAPSHOT_0915' | 'UNFROZEN_LATE' | 'MANUAL_FREEZE';

export interface OrderFlowMetrics {
  buyerVolumePercent: number; // e.g. 64 (%)
  sellerVolumePercent: number; // e.g. 36 (%)
  netDeltaPercent: number; // buyerVolumePercent - sellerVolumePercent (e.g. +28%)
  cvdTrend: 'EXPANDING_UP' | 'EXPANDING_DOWN' | 'NEUTRAL' | 'ABSORPTION_TRAP';
  vpocPrice: number | null; // Volume Point of Control (30m)
  isPriceAboveVpoc: boolean | null;
  flowQuality: 'INSTITUTIONAL_BUYING' | 'INSTITUTIONAL_SELLING' | 'ABSORPTION_TRAP' | 'BALANCED';
  summary: string;
}

export interface ImpliedVolatilityMetrics {
  impliedVol: number; // e.g. 29.4 (%)
  avg30dVol: number; // e.g. 22.1 (%)
  riskPremium: number; // impliedVol - avg30dVol (e.g. +7.3%)
  riskPremiumPercent: number; // (impliedVol - avg30dVol) / avg30dVol * 100
  ivRank: number; // 0 - 100
  regime: 'COMPRESSED' | 'FAIR' | 'ELEVATED' | 'EXTREME';
  label: string;
  gaugePercent: number; // 0 - 100 mapped for needle/arc
  implication: string;
}

// Stato VWAP di sessione per candidato (IPOTESI: vedi TRADING_PARAMS.VWAP_*)
export type VwapStateName =
  | 'ABOVE'
  | 'BELOW'
  | 'PULLBACK'
  | 'RECLAIM'
  | 'REJECT'
  | 'NEUTRAL'
  | 'UNCONFIRMED'
  | 'UNKNOWN';

export interface VwapSignalState {
  state: VwapStateName;
  distAtr: number | null; // (prezzo - VWAP) / ATR 5m, con segno
  slopeAtr: number | null; // (VWAP ora - VWAP N barre fa) / ATR 5m, con segno
  coverage: number | null; // barre con volume / barre attese (da vwapCoverage)
  volumeRatio: number | null; // volume barra 5m piu' recente / media 5m della stessa serie
  flags: string[]; // es. LOW_VWAP_COVERAGE, WEAK_VWAP_BREAK, OPEN_WINDOW, ATR_MISSING
  vwapLevel: number | null; // livello VWAP usato (debug / prompt AI)
}

// Esito del quality gate sui dati VWAP (IPOTESI: vedi TRADING_PARAMS.VWAP_*)
export type VwapDataQualityReason =
  | 'FEED_ERROR'
  | 'NON_FINITE'
  | 'OHLC_INCONSISTENT'
  | 'DUPLICATE_OR_UNSORTED'
  | 'GAP'
  | 'ZERO_VOLUME'
  | 'LOW_COVERAGE'
  | 'STALE'
  | 'OUT_OF_RANGE'
  | 'QUOTE_MISMATCH';

export interface VwapDataQuality {
  ok: boolean;
  reason: VwapDataQualityReason | string | null;
  coverage: number;
  /** Barre incomplete (campi null/NaN) escluse dal calcolo: non invalidano piu' il feed. */
  nullFields?: number;
}

export interface ScoreBreakdown {
  gapScore: number;
  rvolScore: number;
  liquidityScore: number;
  futuresScore: number;
  levelScore: number;
  rsiScore?: number; // Intraday 5m Momentum & Multi-timeframe RSI quality (max 10)
  newsScore?: number; // Bonus news & catalyst quality (+0 to +15pt)
  trendScore?: number; // Bonus Confluenza Trend Macro Daily EMA 20 (+0 to +8pt)
  orderFlowScore?: number; // Convalida Ordini Aggressivi Delta & VPOC (-10pt a +10pt)
  vwapScore?: number; // Contributo VWAP di sessione (0..W, mai negativo; W = TRADING_PARAMS.W_VWAP) [IPOTESI]
  vwapLine?: string; // Riga VWAP sempre presente nel breakdown
  supertrendScore?: number; // Supertrend allineato (max W_SUPERTREND) [IPOTESI]
  adxScore?: number; // Forza di trend ADX (max W_ADX) [IPOTESI]
  stochRsiScore?: number; // StochRSI allineato (max W_STOCH_RSI) [IPOTESI]
  psarScore?: number; // Sempre 0: PSAR serve allo stop e all'uscita, non allo score
  scoreBreakdown?: Record<string, number>; // Mappa componente -> punti interi
  veto?: SetupVetoReason | null; // Veto attivo: il setup va scartato indipendentemente dallo score
  vetoReasons?: SetupVetoReason[];
  warmupIncomplete?: boolean; // WARMUP_INCOMPLETE: Supertrend/ADX/StochRSI UNKNOWN, nessuna raccomandazione
  rawTotal?: number; // Somma grezza pre-cap a 100 per tie-breaking quantitativo
  total: number;
  details: string[];
}

// ---------------------------------------------------------------------------
// Indicatori di setup 5m (TUTTE IPOTESI: vedi TRADING_PARAMS.ST_* / ADX_* / STOCH_RSI_* / PSAR_*)
// ---------------------------------------------------------------------------
export type IndicatorStatus = 'OK' | 'UNKNOWN';

export type IndicatorUnknownReason = 'INSUFFICIENT_BARS' | 'NAN' | 'STALE' | 'AFTER_HOURS';

export interface IndicatorBarInput {
  t: number; // timestamp unix in millisecondi
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface SupertrendSnapshot {
  status: IndicatorStatus;
  reason: IndicatorUnknownReason | null;
  direction: 1 | -1 | 0;
  barsSinceFlip: number | null;
  value: number | null;
}

export interface AdxSnapshot {
  status: IndicatorStatus;
  reason: IndicatorUnknownReason | null;
  value: number | null;
  plusDI: number | null;
  minusDI: number | null;
}

export interface StochRsiSnapshot {
  status: IndicatorStatus;
  reason: IndicatorUnknownReason | null;
  k: number | null;
  d: number | null;
  lastCross: 'LONG' | 'SHORT' | 'NONE';
  barsSinceCross: number | null;
}

export interface PsarSnapshot {
  status: IndicatorStatus;
  reason: IndicatorUnknownReason | null;
  value: number | null;
  direction: 1 | -1 | 0;
  barsSinceFlip: number | null;
}

export interface SetupIndicators {
  barsUsed: number;
  rangeUsed?: string | null; // range Yahoo usato per la serie di warm-up (diagnostica e PR)
  priorSessionsUsed?: number; // sessioni regolari precedenti usate oltre alla corrente
  recentBars?: { t: number; h: number; l: number; c: number }[]; // ultime barre regolari (replay veto ADX)
  adxThreshold?: { min: number; strong: number }; // soglie ADX applicate al mercato (calcolate dal server, IPOTESI)
  atr: { value: number | null; status: IndicatorStatus; reason: IndicatorUnknownReason | null };
  supertrend: SupertrendSnapshot;
  adx: AdxSnapshot;
  stochRsi: StochRsiSnapshot;
  psar: PsarSnapshot;
}

// Motivi di veto del setup (setup scartato indipendentemente dallo score)
export type SetupVetoReason = 'ADX_BELOW_MARKET_THRESHOLD' | 'SUPERTREND_OPPOSED' | 'VWAP_OPPOSED';

export interface KnockOutBarrierGuard {
  safeDistanceAtr: number; // e.g. 1.5 * ATR
  safeBarrierLevel: number | null; // long: entry - safeDistance, short: entry + safeDistance (null se setup non eseguibile)
  maxRecommendedLeverage: number | null; // e.g. 4x - 12x (null se nessuna leva compatibile o non eseguibile)
  leverageRiskLevel: 'SAFE' | 'MODERATE' | 'AGGRESSIVE';
  spreadBufferEur: number;
  tradeRepublicTip: string;
  isExecutableSetup?: boolean;
}

export interface MacroEvent {
  id: string;
  timeCET: string;
  event: string;
  currency: 'USD' | 'EUR';
  impact: 'HIGH' | 'EXTREME';
  description: string;
  isBlackoutNow: boolean;
  minutesToEvent: number;
  country?: string;
  period?: string | null;
  consensus?: string | null;
  prior?: string | null;
  actual?: string | null;
  unit?: string | null;
  source_name?: string | null;
  url?: string | null;
}

export interface MacroCalendarState {
  events: MacroEvent[];
  activeBlackoutEvent: MacroEvent | null;
  isBlackoutActive: boolean;
  spreadWarningTradeRepublic: string | null;
  isWeekend?: boolean;
  marketClosed?: boolean;
  message?: string;
  lastCheckedAt?: string;
  attribution?: string;
}

export interface ScoredCandidate {
  quote: RawQuoteData;
  score: ScoreBreakdown;
  rank: number;
  knockOutGuard?: KnockOutBarrierGuard;
}

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
}

export interface GeminiCatalystAnalysis {
  decisione: 'TRADE' | 'NESSUN_TRADE';
  direzione: 'LONG' | 'SHORT' | 'NESSUNA';
  catalizzatore: string;
  punti_a_favore: string[];
  rischi: string[];
  condizioni_invalidazione: string[];
  fonti: {
    title: string;
    url?: string;
    source: string;
    time?: string;
  }[];
  newsBonusScore?: number;
  confidenza?: number; // 0-100: abbassata da uno stato VWAP contrario, non rifiuta mai il setup
}

export interface AILearnedInsight {
  id: string;
  learnedAt: string;
  market: 'EU' | 'US' | 'GLOBAL';
  topic: string;
  directive: string;
  confidence: number | null;
  sampleEvidence: string;
}

export interface ExecutionSetup {
  candidate: RawQuoteData;
  decision: 'TRADE' | 'NESSUN_TRADE';
  reasonNoTrade?: string;
  direction: 'LONG' | 'SHORT' | 'NESSUNA';
  strategy: 'Opening Range Breakout (5m / 15m)' | 'Gap and Go' | 'Nessun setup';
  triggerLevel: number | null;
  entryLevel?: number | null;
  vwapCondition: string;
  volumeCondition: string;
  stopLossLevel: number | null;
  stopLossTight?: number | null;
  stopLossConservative?: number | null;
  suggestedKoBarrier?: number | null;
  selectedLeverage?: number | null;
  barrierRecommended?: number | null;
  estimatedStopLossPct?: number | null;
  prudentLeverage?: number | null;
  prudentBarrier?: number | null;
  certificateNote?: string;
  calculatedAt?: string;
  stopDistancePct?: number | null;
  extensionPct?: number | null;
  adrConsumptionPct?: number | null;
  entryMode?: EntryMode | null;
  firstBreakoutTime?: string | null;
  blockedGate?: string | null;
  gateResults?: Record<string, { passed: boolean; label: string; message?: string }>;
  atrValue?: number | null;
  atrPercent?: number | null;
  marketType?: 'EU' | 'US';
  target1Level: number | null;
  target2Level: number | null;
  riskRewardRatio: number | null;
  invalidationConditions: string[];
  cutoffTime: string;
  catalystAnalysis: GeminiCatalystAnalysis | null;
  dynamicBreakeven?: DynamicBreakevenInfo | null;
  stressReport?: DerivativeStressReport | null;
  scenarios?: PnLScenario[] | null;
  orbPhase?: {
    phase: 'PRE_MARKET_MONITORING' | 'ORB_15M_FORMATION' | 'ACTIVE_BREAKOUT' | 'CUTOFF_PASSED';
    label: string;
    description: string;
    isEntryAllowed: boolean;
  };
  structuralLevels?: {
    stopType: 'STRUCTURAL_OPEN_LOW' | 'STRUCTURAL_OPEN_HIGH' | 'STRUCTURAL_VWAP' | 'VOLATILITY_ATR';
    referencePrice: number;
    explanation: string;
  };
  macroTrendAlignment?: {
    ema20Daily?: number | null;
    isAligned: boolean;
    label: string;
  };
  adrInfo?: {
    consumptionPct: number;
    remainingPct: number;
    status: 'OPTIMAL' | 'MODERATE' | 'EXHAUSTED';
    description: string;
  } | null;
  macroBlackout?: {
    isBlackoutActive: boolean;
    label: string;
    description: string;
  };
  overnightWarning?: {
    isCloseImminent: boolean;
    label: string;
    description: string;
  };
  initialBalance?: {
    isFormed: boolean;
    high: number;
    low: number;
    status: 'TREND_EXPANSION' | 'RANGE_ROTATION' | 'FORMING';
    label: string;
  };
  benchmarkConfluence?: {
    benchmarkSymbol: string;
    changePercent: number;
    isAligned: boolean;
    label: string;
  };
  orderFlow?: OrderFlowMetrics | null;
}

export interface PnLScenario {
  id: string;
  label: string;
  rMultiple: number;
  underlyingPrice: number;
  underlyingChangePercent: number;
  certEstimatedPrice: number;
  certChangePercent: number;
  grossPnlEur: number;
  netPnlEur: number;
  capitalRoiPercent: number;
  isBreakeven?: boolean;
  isStop?: boolean;
  isKnockOut?: boolean;
  notes: string;
}

export interface DynamicBreakevenInfo {
  spreadEur: number;
  brokerFeeEur: number;
  totalFrictionEur: number;
  underlyingBreakevenPrice: number;
  pointsToBreakeven: number;
  percentToBreakeven: number;
  frictionVsAtrPercent: number; // friction points / ATR(14) * 100
  frictionStatus: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
}

export interface DerivativeStressReport {
  stressScore: number; // 0-100 (100 is optimal)
  filterStatus: 'PASS' | 'WARNING' | 'CRITICAL_BLOCKED';
  barrierVsAtrRatio: number;
  barrierDistancePoints: number;
  barrierSafetyRatio: number;
  criticalReasons: string[];
  warningReasons: string[];
  passReasons: string[];
  canExecute: boolean;
}

export interface KnockOutCalculatorInput {
  barrierStrike: number;
  leverage: number;
  certificatePrice?: number;
  accountCapital: number;
  maxRiskPercent: number; // default 1%
  spreadEur?: number;
  brokerFeeEur?: number;
  ratio?: number; // e.g. 1, 0.1 (10:1), 0.01 (100:1)
  fxRateEurUsd?: number; // EUR/USD exchange rate
}

export interface KnockOutSafetyCheck {
  entryPrice: number;
  stopLoss: number;
  barrierStrike: number;
  stopDistance: number;
  barrierDistance: number;
  safetyRatio: number;
  isSafe: boolean; // safetyRatio >= 2.0
  warningMessage?: string;
  maxRiskEur: number;
  suggestedCertificates: number;
  totalInvestedEur: number;
  potentialLossEur: number;
  /** Perdita reale superiore al rischio pianificato (nessuna esclusione del candidato). */
  riskBreached: boolean;
  potentialGainT1Eur: number;
  potentialGainT2Eur: number;
  breakeven: DynamicBreakevenInfo;
  scenarios: PnLScenario[];
  stressReport: DerivativeStressReport;
  ratio?: number;
  theoreticalCertPriceEur?: number;
}

export interface TradeJournalEntry {
  id: string;
  timestamp: string;
  date: string;
  session: 'EU' | 'US' | 'GLOBAL';
  market?: 'EU' | 'US';
  ticker: string;
  direction: 'LONG' | 'SHORT';
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  target1: number;
  pnlEur: number;
  rMultiple: number;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'EXPIRED';
  status?: 'OPEN' | 'CLOSED';
  notes: string;
  isPaper: boolean;
  closedAt?: string;
  closeReason?:
    | 'TARGET_HIT'
    | 'STOP_HIT'
    | 'STOP_GAP_SLIPPAGE'
    | 'BREAKEVEN'
    | 'CUTOFF_EXPIRED'
    | 'SOFT_CUTOFF_HARD_EXIT'
    | 'EOD_CUTOFF'
    | 'MANUAL'
    | 'CUTOFF_MOMENTUM_LOSS';
  mfe?: number; // Maximum Favorable Excursion (in R-multiples)
  mae?: number; // Maximum Adverse Excursion (in R-multiples)
  slippagePrice?: number; // Slippage price diff relative to stop
  slippageEur?: number; // Estimated monetary cost of slippage in EUR
  stateHistory?: Array<{
    timestamp: string;
    status: 'OPEN' | 'CLOSED';
    price: number;
    reason: string;
    notes?: string;
  }>;
  softCutoffActive?: boolean;
  softCutoffExtendedAt?: string;
  isBreakevenLocked?: boolean;
  barrierStrike?: number;
  leverage?: number;
  suggestedCertificates?: number;
  maxRiskEur?: number;
  potentialLossEur?: number;
  potentialGainT1Eur?: number;
  potentialGainT2Eur?: number;
  frictionEur?: number;
  investedEur?: number;
  entryMode?: EntryMode | null;
  triggerLevel?: number | null; // T
  entryLevel?: number | null; // E
  stopLossLevel?: number | null; // S
  barrierRecommended?: number | null; // B_rec
  selectedLeverage?: number | null; // L_sel
  gateResults?: Record<string, { passed: boolean; label: string; message?: string }>;
}

export interface SystemParameters {
  version: number;
  lastUpdated: string;
  minScore: number; // fallback globale
  minScoreEurope: number; // soglia Europa
  minScoreUSA: number; // soglia USA
  minGapEurope: number; // e.g. 0.40 (%)
  minGapUSA: number; // e.g. 0.75 (%)
  minRvol: number; // e.g. 1.0 (fallback globale)
  minRvolEurope: number; // e.g. 0.85 (Europa)
  minRvolUSA: number; // e.g. 1.15 (USA)
  minAvgVolume: number; // e.g. 350000
  normalRiskMultiplier: number; // e.g. 0.50 * ATR
  target1Multiplier: number; // e.g. 1.60 * normalRisk
  target2Multiplier: number; // e.g. 2.80 * normalRisk
  triggerOffsetPercent: number; // e.g. 0.20 (%)
  rsiFilterActive: boolean; // default false
  parameterHistory?: ParameterHistoryEntry[]; // AUDIT V12: storico calibrazioni accettate
}

export interface ProposedParameterChange {
  parameterKey: keyof SystemParameters;
  label: string;
  currentValue: number | boolean | string;
  proposedValue: number | boolean | string;
  unit?: string;
  reason: string;
  expectedBenefit: string;
}

// AUDIT V12: traccia le calibrazioni accettate. Serve a rendere recuperabile il valore
// precedente di ogni parametro: nessuna accettazione sovrascrive senza lasciare traccia.
export interface ParameterHistoryEntry {
  appliedAt: string;
  version: number;
  proposalId?: string | null;
  changes: { parameterKey: keyof SystemParameters; from: number | boolean; to: number | boolean }[];
}

export interface OptimizationMetrics {
  totalSetups: number;
  wins: number;
  losses: number;
  breakevens: number;
  expired: number;
  winRate: number; // %
  expiredRate: number; // %
  lossRate: number; // %
  netPnlEur: number;
  profitFactor: number;
  avgR: number;
}

export interface OptimizationProposal {
  id: string;
  cycleNumber: number; // e.g. 1 for trades 1-20, 2 for 21-40
  evaluatedTradesCount: number; // e.g. 20
  date: string;
  metrics: OptimizationMetrics;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'NO_CHANGES_NEEDED';
  performanceRating: 'EXCELLENT' | 'GOOD' | 'NEEDS_IMPROVEMENT' | 'CRITICAL';
  summaryTitle: string;
  summaryExplanation: string;
  identifiedStrengths: string[];
  identifiedWeaknesses: string[];
  proposedChanges: ProposedParameterChange[];
  appliedAt?: string;
  market?: 'EU' | 'US' | 'GLOBAL';
  statisticalSignificance?: 'ELEVATA' | 'MODERATA' | 'INSUFFICIENTE';
  statisticalConfidencePct?: number;
  sampleSizeRequired?: number;
}

export interface DualOptimizationProposals {
  eu: OptimizationProposal | null;
  us: OptimizationProposal | null;
}

export interface SessionInfo {
  cet: {
    formatted: string;
    date: string;
    hour: number;
    minute: number;
    dayOfWeek?: number;
    isWeekend?: boolean;
    isEuropeWindow: boolean;
    isUSAWindow: boolean;
    isEuropeLive?: boolean;
    isUSAPreMarket?: boolean;
    isUSALive?: boolean;
    marketStatusEU?: 'PRE_MARKET' | 'OPEN_LIVE' | 'CLOSED';
    marketStatusUS?: 'PRE_MARKET' | 'OPEN_LIVE' | 'CLOSED';
    currentMinutes: number;
    usMinutes?: number;
  };
  recommendedSession: 'EU' | 'US' | 'GLOBAL';
}

export interface HourlySeasonalitySlot {
  slotKey: string; // e.g. "09:00 - 10:00"
  label: string; // e.g. "Golden Hour Europa"
  startHour: number;
  endHour: number;
  marketSession: 'EU' | 'US' | 'GLOBAL';
  tradesCount: number;
  winCount: number;
  lossCount: number;
  beCount: number;
  expiredCount: number;
  winRate: number; // 0-100%
  avgRMultiple: number;
  netPnlEur: number;
  profitFactor: number;
  status: 'HIGH_CONVICTION' | 'NEUTRAL' | 'CHOP_RISK' | 'INSUFFICIENT_DATA';
  description: string;
  tacticalAdvice: string;
  isCurrentHour?: boolean;
}

export interface DaySeasonalitySlot {
  dayName: string; // "Lunedì", "Martedì", etc.
  dayIndex: number; // 1 to 5
  tradesCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  netPnlEur: number;
  avgRMultiple: number;
  isToday?: boolean;
}

export interface SeasonalityReport {
  hourlySlots: HourlySeasonalitySlot[];
  daySlots: DaySeasonalitySlot[];
  bestWindow: HourlySeasonalitySlot | null;
  worstWindow: HourlySeasonalitySlot | null;
  currentActiveSlot: HourlySeasonalitySlot | null;
  isJournalDataAvailable: boolean;
  totalAnalyzedTrades: number;
  averageWinRate: number;
  recommendationForNow: {
    verdict: 'FAVORABLE' | 'NEUTRAL' | 'CAUTION_CHOP';
    title: string;
    message: string;
  };
}

export type ExclusionCategory =
  | 'RSI_EXTREME'
  | 'GAP_INSUFFICIENT'
  | 'RVOL_INSUFFICIENT'
  | 'SCORE_BELOW_MIN'
  | 'CATALYST_UNVERIFIED'
  | 'ATR_INSUFFICIENT'
  | 'CUTOFF_PASSED'
  | 'PRICE_UNAVAILABLE';

export interface ExcludedCandidateInfo {
  ticker: string;
  name: string;
  market: 'EU' | 'US';
  currency: string;
  score: number;
  gapPercent: number | null;
  rvol: number | null;
  rsi: number | null;
  atr: number | null;
  primaryReasonCategory: ExclusionCategory;
  primaryReasonLabel: string;
  detail: string;
}

export interface FilteringAuditReport {
  totalScanned: number;
  qualifiedCount: number;
  excludedCount: number;
  timestamp: string;
  countsByCategory: {
    rsiExtreme: number;
    gapInsufficient: number;
    rvolInsufficient: number;
    scoreBelowMin: number;
    catalystUnverified: number;
    atrInsufficient: number;
    cutoffPassed: number;
    priceUnavailable: number;
  };
  briefNotificationMessage: string;
  bulletSummary: string[];
  excludedList: ExcludedCandidateInfo[];
}

export type ExcludedOutcomeStatus =
  | 'MONITORING'
  | 'THEORETICAL_PROFIT'
  | 'THEORETICAL_STOP'
  | 'THEORETICAL_EXPIRED'
  | 'INSUFFICIENT_DATA';

export interface ExcludedSetupRecord {
  id: string;
  ticker: string;
  name: string;
  market: 'EU' | 'US';
  currency: string;
  sessionDate: string;
  timestamp: string;
  score: number;
  gapPercent: number | null;
  rvol: number | null;
  rsi: number | null;
  atr: number | null;
  primaryReasonCategory: ExclusionCategory;
  primaryReasonLabel: string;
  detail: string;

  // Theoretical setup geometry
  direction: 'LONG' | 'SHORT';
  initialPrice: number;
  entryTrigger: number;
  stopLoss: number;
  target1: number;
  riskDist: number;

  // Live monitoring
  currentPrice?: number;
  outcomeStatus: ExcludedOutcomeStatus;
  theoreticalRMultiple?: number;
  theoreticalPnlEur?: number;
  resolvedAt?: string;
  notes?: string;
  softCutoffExtended?: boolean;
  isBreakevenLocked?: boolean;
}

export interface ExcludedCategoryAnalysis {
  category: ExclusionCategory;
  label: string;
  totalExcluded: number;
  profitCount: number;
  lossCount: number;
  expiredCount: number;
  monitoringCount: number;
  winRate: number; // 0-100%
  missedPnlEur: number;
  savedPnlEur: number;
  verdict: 'TOO_RESTRICTIVE' | 'EFFECTIVE_SHIELD' | 'BALANCED' | 'INSUFFICIENT_SAMPLE' | 'CALIBRATED';
  verdictTitle: string;
  verdictDescription: string;
  currentParamValue?: string | number;
  correctionProposal?: {
    parameterKey: keyof SystemParameters;
    label: string;
    currentValue: string | number;
    proposedValue: string | number;
    explanation: string;
    actionType: 'REDUCE_PARAM' | 'EXPAND_PARAM' | 'TOGGLE_RSI' | 'CUSTOM';
  };
}

export interface ExcludedSetupsAutoAnalysis {
  totalTracked: number;
  totalResolved: number;
  totalProfitable: number;
  totalStopped: number;
  totalExpired: number;
  totalMonitoring: number;
  overallMissedWinRate: number;
  totalMissedPnlEur: number;
  totalCapitalSavedEur: number;
  categories: ExcludedCategoryAnalysis[];
  urgentCorrections: Array<{
    category: ExclusionCategory;
    title: string;
    description: string;
    parameterKey: keyof SystemParameters;
    currentValue: any;
    proposedValue: any;
  }>;
  analyzedAt: string;
}

export interface MarketFreezeState {
  isFrozen: boolean;
  frozenTicker: string | null;
  frozenAt: string | null; // ISO timestamp
  frozenTimeFormatted: string | null; // e.g. "09:15 CET"
  isAutoFrozen: boolean;
  unlockedByUser: boolean;
}
