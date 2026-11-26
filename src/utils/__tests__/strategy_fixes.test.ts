/**
 * Test mirati sui fix alla strategia principale (non Shadow):
 *   1. griglia di leva per mercato (USA ammette 5x, quindi stop fino a 2.00%),
 *      con G8 che usa la stessa griglia del mercato;
 *   2. gate costi G14: blocca solo quando il rischio reale e' noto e l'attrito
 *      supera il 12% di 1R;
 *   3. fallback del Top Pick: mai un titolo sotto la soglia di punteggio del
 *      mercato (quella che G11 applicherebbe comunque).
 *
 * Uso: npx tsx src/utils/__tests__/strategy_fixes.test.ts
 */

import assert from 'node:assert/strict';
import {
  buildExecutionSetup,
  calculateCandidateScore,
  getDualTopCandidates,
  DEFAULT_SYSTEM_PARAMETERS,
} from '../calculator';
import { TRADING_PARAMS } from '../../config/tradingParams';
import type { RawQuoteData, ScoredCandidate } from '../../types/radar';

function quote(overrides: Partial<RawQuoteData> = {}): RawQuoteData {
  const base: RawQuoteData = {
    ticker: 'TEST.MI',
    name: 'Test S.p.A.',
    market: 'EU',
    currency: 'EUR',
    prevClose: 99.0,
    currentPrice: 100.1,
    preMarketPrice: 100.0,
    prevHigh: 99.5,
    prevLow: 98.0,
    preMarketHigh: 100.0,
    preMarketLow: 99.5,
    todayOpen: 100.0,
    todayHigh: 100.1,
    todayLow: 99.9,
    vwap: 100.0,
    ema20Daily: 98.0,
    avgVolume20d: 250_000,
    preMarketVolume: 50_000,
    atr14: 1.3,
    adr14: 10.0,
    liqEur20d: 5_000_000,
    completedBarsCount: 20,
    orbHigh: 100.0,
    orbLow: 99.799599,
    T: 100.0,
    E: 100.0,
    S: 99.6,
    orbBreakoutTime: new Date('2026-10-26T09:30:00+01:00').toISOString(),
    gapPercent: 1.01,
    rvol: 1.5,
    rvol20m: 1.2,
    rsi14: 55,
    rsi5m: 55,
    orderFlow: null,
    setupIndicators: {
      barsUsed: 120,
      atr: { value: 1.3, status: 'OK', reason: null },
      supertrend: { status: 'OK', reason: null, direction: 1, barsSinceFlip: 2, value: 99.5 },
      adx: { status: 'OK', reason: null, value: 28, plusDI: 30, minusDI: 12 },
      stochRsi: { status: 'OK', reason: null, k: 45, d: 40, lastCross: 'LONG', barsSinceCross: 1 },
      psar: { status: 'OK', reason: null, value: 99.2, direction: 1, barsSinceFlip: 4 },
    },
    vwapState: {
      state: 'ABOVE',
      distAtr: 0.5,
      slopeAtr: 0.1,
      coverage: 1,
      volumeRatio: 2.1,
      flags: [],
      vwapLevel: 100,
    },
    timestamp: new Date('2026-10-26T09:40:00+01:00').toISOString(),
    source: 'strategy_fixes fixture',
  };
  return { ...base, ...overrides };
}

const EU_NOW = new Date('2026-10-26T09:40:00+01:00');
const US_NOW = new Date('2026-10-26T10:00:00-04:00');

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- 1. leva USA
// dS = 1.50%: prima G8 usava il minimo della griglia EU (10x) e bloccava con
// "STOP TROPPO LONTANO"; con la griglia USA (5x) il limite e' 2.00%.
check('USA: stop 1.50% supera G8 e usa 5x (barriera a -20%)', () => {
  const usQuote = quote({
    ticker: 'AAPL',
    name: 'Apple',
    market: 'US',
    currency: 'USD',
    T: 100,
    E: 100,
    S: 98.5,
    orbHigh: 100,
    orbLow: 98.699599,
    currentPrice: 100.1,
    timestamp: US_NOW.toISOString(),
  });
  const cand: ScoredCandidate = {
    quote: usQuote,
    score: calculateCandidateScore(usQuote, 0.3, null),
    rank: 1,
  };
  const setup = buildExecutionSetup(cand, null, 'US', DEFAULT_SYSTEM_PARAMETERS, {
    currentTime: US_NOW,
  });
  if (setup.decision !== 'TRADE') {
    const failed = Object.entries(setup.gateResults ?? {})
      .filter(([, g]) => !g.passed)
      .map(([k, g]) => `${k}:${g.message ?? ''}`)
      .join(', ');
    console.log(`  debug US: score=${cand.score.total} failed=[${failed}]`);
  }
  assert.equal(setup.gateResults?.G8.passed, true, 'G8 deve passare con leva minima 5x');
  assert.equal(setup.selectedLeverage, 5);
  assert.equal(setup.barrierRecommended, 80);
  assert.equal(setup.decision, 'TRADE');
});

check('EU: lo stesso stop 1.50% resta bloccato da G8 (griglia min 10x)', () => {
  const cand: ScoredCandidate = {
    quote: quote({ T: 100, E: 100, S: 98.5, orbHigh: 100, orbLow: 98.699599, currentPrice: 100.1 }),
    score: calculateCandidateScore(quote(), 0.3, null),
    rank: 1,
  };
  const setup = buildExecutionSetup(cand, null, 'EU', DEFAULT_SYSTEM_PARAMETERS, {
    currentTime: EU_NOW,
  });
  assert.equal(setup.gateResults?.G8.passed, false);
  assert.equal(setup.blockedGate, 'G8');
});

// ---------------------------------------------------------------- 2. G14 costi
check('senza rischio noto il gate costi non compare (replay invariato)', () => {
  const cand: ScoredCandidate = {
    quote: quote(),
    score: calculateCandidateScore(quote(), 0.3, null),
    rank: 1,
  };
  const setup = buildExecutionSetup(cand, null, 'EU', DEFAULT_SYSTEM_PARAMETERS, {
    currentTime: EU_NOW,
  });
  assert.equal(setup.gateResults?.G14, undefined);
  assert.equal(setup.decision, 'TRADE');
});

check('rischio 10 EUR: fee 2 EUR = 20% di 1R -> G14 blocca', () => {
  const cand: ScoredCandidate = {
    quote: quote(),
    score: calculateCandidateScore(quote(), 0.3, null),
    rank: 1,
  };
  const setup = buildExecutionSetup(cand, null, 'EU', DEFAULT_SYSTEM_PARAMETERS, {
    currentTime: EU_NOW,
    riskEur: 10,
  });
  assert.equal(setup.gateResults?.G14?.passed, false);
  assert.equal(setup.blockedGate, 'G14');
  assert.equal(setup.decision, 'NESSUN_TRADE');
});

check('rischio 100 EUR (capitale 10k al 1%): fee 2% di 1R -> G14 passa', () => {
  const cand: ScoredCandidate = {
    quote: quote(),
    score: calculateCandidateScore(quote(), 0.3, null),
    rank: 1,
  };
  const setup = buildExecutionSetup(cand, null, 'EU', DEFAULT_SYSTEM_PARAMETERS, {
    currentTime: EU_NOW,
    riskEur: 100,
  });
  assert.equal(setup.gateResults?.G14?.passed, true);
  assert.equal(setup.decision, 'TRADE');
});

// ---------------------------------------------------------------- 3. fallback
check('fallback Top EU: un titolo sotto MIN_SCORE_EU resta visibile ma G11 lo blocca', () => {
  // Indicatori presenti (altrimenti sarebbe WARMUP_INCOMPLETE, escluso a monte),
  // ma contesto debole: gap quasi nullo, RVOL sotto soglia, nessuna confluenza.
  const weak = quote({
    ticker: 'WEAK.MI',
    gapPercent: 0.05,
    rvol: 0.9,
    currentPrice: 100.02,
    todayHigh: 100.02,
    setupIndicators: {
      barsUsed: 120,
      atr: { value: 1.3, status: 'OK', reason: null },
      supertrend: { status: 'OK', reason: null, direction: 1, barsSinceFlip: 1, value: 99.5 },
      adx: { status: 'OK', reason: null, value: 17, plusDI: 18, minusDI: 16 },
      stochRsi: { status: 'OK', reason: null, k: 85, d: 80, lastCross: 'NONE', barsSinceCross: 9 },
      psar: { status: 'OK', reason: null, value: 99.4, direction: 1, barsSinceFlip: 2 },
    },
    vwapState: {
      state: 'BELOW',
      distAtr: -0.8,
      slopeAtr: -0.1,
      coverage: 1,
      volumeRatio: 0.7,
      flags: [],
      vwapLevel: 100.4,
    },
    ema20Daily: null,
  });
  const weakCandidate: ScoredCandidate = {
    quote: weak,
    score: calculateCandidateScore(weak, 0, null),
    rank: 1,
  };
  assert.ok(
    weakCandidate.score.total < TRADING_PARAMS.MIN_SCORE_EU,
    `fixture debole troppo alta: ${weakCandidate.score.total}`
  );
  const dual = getDualTopCandidates([weak], 0, { parameters: DEFAULT_SYSTEM_PARAMETERS });
  assert.ok(dual.topEU !== null, 'il candidato deve restare visibile per motivare il blocco');
  const setup = buildExecutionSetup(dual.topEU, null, 'EU', DEFAULT_SYSTEM_PARAMETERS, {
    currentTime: EU_NOW,
  });
  assert.equal(setup.decision, 'NESSUN_TRADE');
  assert.equal(setup.blockedGate, 'G11');
});

check('fallback Top EU: un candidato sopra soglia resta operabile', () => {
  const strong = quote();
  const dual = getDualTopCandidates([strong], 0.3, { parameters: DEFAULT_SYSTEM_PARAMETERS });
  assert.ok(dual.topEU !== null);
});

console.log(`\nRISULTATO: ${passed} PASS`);
