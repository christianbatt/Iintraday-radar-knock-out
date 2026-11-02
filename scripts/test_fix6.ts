import { runExcludedSetupsAutoAnalysis } from '../src/utils/calculator';
import { ExcludedSetupRecord, SystemParameters } from '../src/types/radar';
import { TRADING_PARAMS } from '../src/config/tradingParams';

console.log('Testing Fix 6: Market separation and aligned parameter keys in runExcludedSetupsAutoAnalysis...');

const defaultParams: SystemParameters = {
  version: 112,
  lastUpdated: '2026-11-01',
  minScore: 54,
  minScoreEurope: 54,
  minScoreUSA: 64,
  minGapEurope: 0.40,
  minGapUSA: 0.75,
  minRvol: 0.85,
  minRvolEurope: 0.85,
  minRvolUSA: 1.15,
  minAvgVolume: 350000,
  normalRiskMultiplier: 0.5,
  target1Multiplier: 1.6,
  target2Multiplier: 2.8,
  triggerOffsetPercent: 0.2,
  rsiFilterActive: true,
};

function makeExcludedRecord(
  id: string,
  ticker: string,
  market: 'EU' | 'US',
  category: any,
  outcome: 'THEORETICAL_PROFIT' | 'THEORETICAL_STOP',
  rvol: number,
  gapPercent: number,
  score: number
): ExcludedSetupRecord {
  return {
    id,
    ticker,
    name: ticker,
    market,
    currency: market === 'EU' ? 'EUR' : 'USD',
    direction: 'LONG',
    primaryReasonCategory: category,
    primaryReasonLabel: 'Reason',
    detail: 'Detail',
    entryTrigger: 100,
    stopLoss: 98,
    target1: 105,
    riskDist: 2,
    currentPrice: 105,
    outcomeStatus: outcome,
    theoreticalRMultiple: outcome === 'THEORETICAL_PROFIT' ? 2.5 : -1.0,
    theoreticalPnlEur: outcome === 'THEORETICAL_PROFIT' ? 250 : -100,
    rvol,
    gapPercent,
    score,
    sessionDate: '2026-11-01',
    rsi: 50,
    atr: 2.0,
    initialPrice: 100,
    timestamp: new Date().toISOString(),
  };
}

// Case 1: ONLY US records are profitable for RVOL_INSUFFICIENT
// 2 profitable US records with rvol = 1.05 (< 1.15)
const usOnlyRecords: ExcludedSetupRecord[] = [
  makeExcludedRecord('us-1', 'AAPL', 'US', 'RVOL_INSUFFICIENT', 'THEORETICAL_PROFIT', 1.05, 1.2, 70),
  makeExcludedRecord('us-2', 'MSFT', 'US', 'RVOL_INSUFFICIENT', 'THEORETICAL_PROFIT', 1.05, 1.5, 72),
];

const analysisUS = runExcludedSetupsAutoAnalysis(usOnlyRecords, defaultParams);

// Verify: Proposal should be for minRvolUSA, NOT minRvol or minRvolEurope!
const rvolAnalysisUS = analysisUS.categories.find(c => c.category === 'RVOL_INSUFFICIENT');
if (!rvolAnalysisUS) throw new Error('RVOL_INSUFFICIENT analysis not found');

if (rvolAnalysisUS.correctionProposal?.parameterKey !== 'minRvolUSA') {
  throw new Error(`FAIL Case 1: Expected parameterKey minRvolUSA, got ${rvolAnalysisUS.correctionProposal?.parameterKey}`);
}

const euUrgentsInUS = analysisUS.urgentCorrections.filter(u => u.parameterKey === 'minRvolEurope');
if (euUrgentsInUS.length > 0) {
  throw new Error('FAIL Case 1: US records generated an EU correction for minRvolEurope!');
}
console.log('PASS Case 1: US profitable records generated ONLY minRvolUSA proposals (EU remains untouched).');

// Case 2: ONLY EU records are profitable for RVOL_INSUFFICIENT
// 2 profitable EU records with rvol = 0.75 (< 0.85)
const euOnlyRecords: ExcludedSetupRecord[] = [
  makeExcludedRecord('eu-1', 'ISP.MI', 'EU', 'RVOL_INSUFFICIENT', 'THEORETICAL_PROFIT', 0.75, 0.5, 60),
  makeExcludedRecord('eu-2', 'ENI.MI', 'EU', 'RVOL_INSUFFICIENT', 'THEORETICAL_PROFIT', 0.75, 0.6, 62),
];

const analysisEU = runExcludedSetupsAutoAnalysis(euOnlyRecords, defaultParams);

const rvolAnalysisEU = analysisEU.categories.find(c => c.category === 'RVOL_INSUFFICIENT');
if (!rvolAnalysisEU) throw new Error('RVOL_INSUFFICIENT analysis not found');

if (rvolAnalysisEU.correctionProposal?.parameterKey !== 'minRvolEurope') {
  throw new Error(`FAIL Case 2: Expected parameterKey minRvolEurope, got ${rvolAnalysisEU.correctionProposal?.parameterKey}`);
}

const usUrgentsInEU = analysisEU.urgentCorrections.filter(u => u.parameterKey === 'minRvolUSA');
if (usUrgentsInEU.length > 0) {
  throw new Error('FAIL Case 2: EU records generated a US correction for minRvolUSA!');
}
console.log('PASS Case 2: EU profitable records generated ONLY minRvolEurope proposals (US remains untouched).');

// Case 3: Test GAP_INSUFFICIENT market separation
const usGapRecords: ExcludedSetupRecord[] = [
  makeExcludedRecord('us-gap-1', 'NVDA', 'US', 'GAP_INSUFFICIENT', 'THEORETICAL_PROFIT', 1.5, 0.60, 75),
  makeExcludedRecord('us-gap-2', 'AMD', 'US', 'GAP_INSUFFICIENT', 'THEORETICAL_PROFIT', 1.6, 0.65, 72),
];
const analysisUSGap = runExcludedSetupsAutoAnalysis(usGapRecords, defaultParams);
const gapAnalysisUS = analysisUSGap.categories.find(c => c.category === 'GAP_INSUFFICIENT');
if (gapAnalysisUS?.correctionProposal?.parameterKey !== 'minGapUSA') {
  throw new Error(`FAIL Case 3: Expected parameterKey minGapUSA, got ${gapAnalysisUS?.correctionProposal?.parameterKey}`);
}
console.log('PASS Case 3: US gap records generated ONLY minGapUSA proposals.');

// Case 4: Test SCORE_BELOW_MIN market separation
const euScoreRecords: ExcludedSetupRecord[] = [
  makeExcludedRecord('eu-score-1', 'UCG.MI', 'EU', 'SCORE_BELOW_MIN', 'THEORETICAL_PROFIT', 1.2, 0.8, 50),
  makeExcludedRecord('eu-score-2', 'RACE.MI', 'EU', 'SCORE_BELOW_MIN', 'THEORETICAL_PROFIT', 1.3, 0.9, 52),
];
const analysisEUScore = runExcludedSetupsAutoAnalysis(euScoreRecords, defaultParams);
const scoreAnalysisEU = analysisEUScore.categories.find(c => c.category === 'SCORE_BELOW_MIN');
if (scoreAnalysisEU?.correctionProposal?.parameterKey !== 'minScoreEurope') {
  throw new Error(`FAIL Case 4: Expected parameterKey minScoreEurope, got ${scoreAnalysisEU?.correctionProposal?.parameterKey}`);
}
console.log('PASS Case 4: EU score records generated ONLY minScoreEurope proposals.');

console.log('ALL FIX 6 TESTS PASSED VERIFIED!');
