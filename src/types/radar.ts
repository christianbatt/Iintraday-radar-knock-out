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
  avgVolume20d: number | null;
  preMarketVolume: number | null;
  atr14: number | null;
  gapPercent: number | null;
  rvol: number | null;
  timestamp: string;
  source: string;
}

export interface ScoreBreakdown {
  gapScore: number;
  rvolScore: number;
  liquidityScore: number;
  futuresScore: number;
  levelScore: number;
  total: number;
  details: string[];
}

export interface ScoredCandidate {
  quote: RawQuoteData;
  score: ScoreBreakdown;
  rank: number;
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
}

export interface ExecutionSetup {
  candidate: RawQuoteData;
  decision: 'TRADE' | 'NESSUN_TRADE';
  reasonNoTrade?: string;
  direction: 'LONG' | 'SHORT' | 'NESSUNA';
  strategy: 'Opening Range Breakout (5m / 15m)' | 'Gap and Go' | 'Nessun setup';
  triggerLevel: number | null;
  vwapCondition: string;
  volumeCondition: string;
  stopLossLevel: number | null;
  stopLossTight?: number | null;
  stopLossConservative?: number | null;
  suggestedKoBarrier?: number | null;
  atrValue?: number | null;
  atrPercent?: number | null;
  marketType?: 'EU' | 'US';
  target1Level: number | null;
  target2Level: number | null;
  riskRewardRatio: number | null;
  invalidationConditions: string[];
  cutoffTime: string;
  catalystAnalysis: GeminiCatalystAnalysis | null;
}

export interface KnockOutCalculatorInput {
  barrierStrike: number;
  leverage: number;
  certificatePrice?: number;
  accountCapital: number;
  maxRiskPercent: number; // default 1%
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
  potentialGainT1Eur: number;
  potentialGainT2Eur: number;
}

export interface TradeJournalEntry {
  id: string;
  timestamp: string;
  date: string;
  session: 'EU' | 'US' | 'GLOBAL';
  ticker: string;
  direction: 'LONG' | 'SHORT';
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  target1: number;
  pnlEur: number;
  rMultiple: number;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
  notes: string;
  isPaper: boolean;
}

export interface SessionInfo {
  cet: {
    formatted: string;
    date: string;
    hour: number;
    minute: number;
    isEuropeWindow: boolean;
    isUSAWindow: boolean;
    isEuropeLive?: boolean;
    isUSAPreMarket?: boolean;
    isUSALive?: boolean;
    marketStatusEU?: 'PRE_MARKET' | 'OPEN_LIVE' | 'CLOSED';
    marketStatusUS?: 'PRE_MARKET' | 'OPEN_LIVE' | 'CLOSED';
    currentMinutes: number;
  };
  recommendedSession: 'EU' | 'US' | 'GLOBAL';
}
