import { generateFilteringAuditReport } from '../src/utils/calculator';
import { RawQuoteData, ScoredCandidate, SystemParameters } from '../src/types/radar';
import { TRADING_PARAMS } from '../src/config/tradingParams';

console.log('Testing Fix 5: candidate qualification logic in generateFilteringAuditReport...');

const defaultParams: SystemParameters = {
  version: 112,
  lastUpdated: '2026-11-01',
  minScore: TRADING_PARAMS.MIN_SCORE_EU,
  minScoreEurope: TRADING_PARAMS.MIN_SCORE_EU, // 54
  minScoreUSA: TRADING_PARAMS.MIN_SCORE_US, // 64
  minGapEurope: 0.40,
  minGapUSA: 0.75,
  minRvol: TRADING_PARAMS.MIN_RVOL_EU,
  minRvolEurope: TRADING_PARAMS.MIN_RVOL_EU, // 0.85
  minRvolUSA: TRADING_PARAMS.MIN_RVOL_US, // 1.15
  minAvgVolume: 350000,
  normalRiskMultiplier: 0.5,
  target1Multiplier: 1.6,
  target2Multiplier: 2.8,
  suggestedKoBarrierMultiplier: 2.65,
  triggerOffsetPercent: 0.2,
  rsiFilterActive: true,
};

// Candidate 1: Valid score (70 >= 54) BUT insufficient RVOL (0.50 < 0.85)
const lowRvolQuote = {
  ticker: 'ENI.MI',
  name: 'Eni S.p.A.',
  market: 'EU',
  currency: 'EUR',
  currentPrice: 14.50,
  prevClose: 14.20,
  gapPercent: 1.41,
  atr14: 0.35,
  rvol: 0.50, // Insufficient RVOL (< 0.85)
  rsi14: 55,
} as unknown as RawQuoteData;

const scoredLowRvol = {
  quote: lowRvolQuote,
  score: {
    total: 70, // valid score >= 54
    gapScore: 25,
    rvolScore: 10,
    intradayMomentumScore: 20,
    breakdown: [],
  },
  rank: 1,
  actionLabel: 'BUY',
} as unknown as ScoredCandidate;

// Candidate 2: Fully qualified candidate
const validQuote = {
  ticker: 'ISP.MI',
  name: 'Intesa Sanpaolo',
  market: 'EU',
  currency: 'EUR',
  currentPrice: 3.80,
  prevClose: 3.75,
  gapPercent: 0.80,
  atr14: 0.08,
  rvol: 1.45, // valid (> 0.85)
  rsi14: 52,
} as unknown as RawQuoteData;

const scoredValid = {
  quote: validQuote,
  score: {
    total: 75,
    gapScore: 25,
    rvolScore: 20,
    intradayMomentumScore: 15,
    breakdown: [],
  },
  rank: 1,
  actionLabel: 'BUY',
} as unknown as ScoredCandidate;

// Test A: Top candidate has valid score but low RVOL
const reportA = generateFilteringAuditReport(
  [lowRvolQuote],
  { topEU: scoredLowRvol, topUS: null },
  0.5,
  defaultParams,
  {},
  true
);

if (reportA.qualifiedCount !== 0) {
  throw new Error(`FAIL Test A: Candidate with score 70 and RVOL 0.50 was marked qualified! qualifiedCount=${reportA.qualifiedCount}`);
}
const excludedEni = reportA.excludedList.find(e => e.ticker === 'ENI.MI');
if (!excludedEni) {
  throw new Error(`FAIL Test A: ENI.MI should be in excludedList`);
}
if (excludedEni.primaryReasonCategory !== 'RVOL_INSUFFICIENT') {
  throw new Error(`FAIL Test A: Expected exclusion category RVOL_INSUFFICIENT, got ${excludedEni.primaryReasonCategory}`);
}
console.log('PASS Test A: Candidate with valid score but insufficient RVOL correctly rejected and categorized as RVOL_INSUFFICIENT.');

// Test B: Fully qualified candidate is qualified
const reportB = generateFilteringAuditReport(
  [validQuote],
  { topEU: scoredValid, topUS: null },
  0.5,
  defaultParams,
  {},
  true
);

if (reportB.qualifiedCount !== 1) {
  throw new Error(`FAIL Test B: Fully qualified candidate ISP.MI was NOT marked qualified! qualifiedCount=${reportB.qualifiedCount}`);
}
if (reportB.excludedList.some(e => e.ticker === 'ISP.MI')) {
  throw new Error(`FAIL Test B: ISP.MI should NOT be in excludedList`);
}
console.log('PASS Test B: Fully qualified candidate passes all gates and is accepted.');

console.log('ALL FIX 5 TESTS PASSED VERIFIED!');
