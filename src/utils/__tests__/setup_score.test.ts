import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateCandidateScore,
  calculateVwapScoreContribution,
  evaluateSetupVetoes,
  rankMarketCandidates,
  scaleComponentToWeight,
} from '../calculator';
import { TRADING_PARAMS } from '../../config/tradingParams';
import type { RawQuoteData, SetupIndicators, VwapSignalState } from '../../types/radar';

const P = TRADING_PARAMS;

const alignedIndicators = (direction: 1 | -1 = 1): SetupIndicators => ({
  barsUsed: 120,
  atr: { value: 0.5, status: 'OK', reason: null },
  supertrend: { status: 'OK', reason: null, direction, barsSinceFlip: 2, value: 99 },
  adx:
    direction === 1
      ? { status: 'OK', reason: null, value: 30, plusDI: 32, minusDI: 8 }
      : { status: 'OK', reason: null, value: 30, plusDI: 8, minusDI: 32 },
  stochRsi:
    direction === 1
      ? { status: 'OK', reason: null, k: 40, d: 35, lastCross: 'LONG', barsSinceCross: 1 }
      : { status: 'OK', reason: null, k: 60, d: 65, lastCross: 'SHORT', barsSinceCross: 1 },
  psar: { status: 'OK', reason: null, value: 97, direction, barsSinceFlip: 3 },
});

const unknownIndicators = (): SetupIndicators => ({
  barsUsed: 4,
  atr: { value: null, status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS' },
  supertrend: { status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS', direction: 0, barsSinceFlip: null, value: null },
  adx: { status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS', value: null, plusDI: null, minusDI: null },
  stochRsi: {
    status: 'UNKNOWN',
    reason: 'INSUFFICIENT_BARS',
    k: null,
    d: null,
    lastCross: 'NONE',
    barsSinceCross: null,
  },
  psar: { status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS', value: null, direction: 0, barsSinceFlip: null },
});

const vwap = (over: Partial<VwapSignalState> = {}): VwapSignalState => ({
  state: 'ABOVE',
  distAtr: 0.5,
  slopeAtr: 0.2,
  coverage: 1,
  volumeRatio: 2.1,
  flags: [],
  vwapLevel: 102,
  ...over,
});

const longQuote = (over: Partial<RawQuoteData> = {}): RawQuoteData => ({
  ticker: 'AAA',
  name: 'Alpha',
  market: 'US',
  currency: 'USD',
  prevClose: 100,
  currentPrice: 103,
  preMarketPrice: null,
  prevHigh: 99,
  prevLow: 95,
  preMarketHigh: null,
  preMarketLow: null,
  todayOpen: 101,
  todayHigh: 104,
  todayLow: 100,
  vwap: 102,
  ema20Daily: 98,
  avgVolume20d: 5_000_000,
  preMarketVolume: 100_000,
  atr14: 1,
  gapPercent: 1.0,
  rvol: 2.5,
  rsi5m: 55,
  rsi14: 55,
  orderFlow: {
    buyerVolumePercent: 65,
    sellerVolumePercent: 35,
    netDeltaPercent: 30,
    cvdTrend: 'EXPANDING_UP',
    vpocPrice: 100.5,
    isPriceAboveVpoc: true,
    flowQuality: 'INSTITUTIONAL_BUYING',
    summary: 'buying',
  },
  setupIndicators: alignedIndicators(1),
  vwapState: vwap(),
  timestamp: new Date().toISOString(),
  source: 'test',
  ...over,
});

const shortQuote = (over: Partial<RawQuoteData> = {}): RawQuoteData => ({
  ...longQuote(),
  ticker: 'BBB',
  prevClose: 100,
  currentPrice: 97,
  todayOpen: 99,
  prevHigh: 101,
  prevLow: 98,
  vwap: 98,
  ema20Daily: 102,
  gapPercent: -1.0,
  orderFlow: {
    buyerVolumePercent: 35,
    sellerVolumePercent: 65,
    netDeltaPercent: -30,
    cvdTrend: 'EXPANDING_DOWN',
    vpocPrice: 99.5,
    isPriceAboveVpoc: false,
    flowQuality: 'INSTITUTIONAL_SELLING',
    summary: 'selling',
  },
  setupIndicators: alignedIndicators(-1),
  vwapState: vwap({ state: 'BELOW', distAtr: -0.5 }),
  ...over,
});

describe('Setup score - pesi a 100 (IPOTESI)', () => {
  it('S1: la somma dei pesi W_* e esattamente 100', () => {
    const sum =
      P.W_GAP +
      P.W_RVOL +
      P.W_VWAP +
      P.W_SUPERTREND +
      P.W_ADX +
      P.W_STOCH_RSI +
      P.W_LEVELS +
      P.W_FUTURES +
      P.W_NEWS +
      P.W_ORDER_FLOW +
      P.W_LIQUIDITY +
      P.W_PSAR +
      P.W_RSI +
      P.W_TREND;
    assert.strictEqual(sum, 100, `somma pesi = ${sum}`);
  });

  it('S2: SCORE_MAX_COMPONENTS coerente con i pesi e tetto 100', () => {
    const components = P.SCORE_MAX_COMPONENTS;
    assert.strictEqual(components.GAP, P.W_GAP);
    assert.strictEqual(components.RVOL, P.W_RVOL);
    assert.strictEqual(components.VWAP, P.W_VWAP);
    assert.strictEqual(components.SUPERTREND, P.W_SUPERTREND);
    assert.strictEqual(components.ADX, P.W_ADX);
    assert.strictEqual(components.STOCH_RSI, P.W_STOCH_RSI);
    assert.strictEqual(components.LEVELS, P.W_LEVELS);
    assert.strictEqual(components.FUTURES, P.W_FUTURES);
    assert.strictEqual(components.NEWS, P.W_NEWS);
    assert.strictEqual(components.ORDER_FLOW, P.W_ORDER_FLOW);
    assert.strictEqual(components.PSAR, P.W_PSAR);
    assert.strictEqual(components.RAW_MAX, 100);
    assert.strictEqual(components.CAPPED_MAX, 100);
    assert.strictEqual(P.VWAP_SCORE_WEIGHT, P.W_VWAP);
  });

  it('S3: tutti i componenti al massimo -> total 100, nessun veto', () => {
    const score = calculateCandidateScore(longQuote(), 0.5, 15);
    const expected: Record<string, number> = {
      gap: 12,
      rvol: 14,
      vwap: 10,
      supertrend: 12,
      adx: 7,
      stochRsi: 9,
      levels: 6,
      futures: 12,
      news: 10,
      orderFlow: 8,
      liquidity: 0,
      psar: 0,
      rsi: 0,
      trend: 0,
    };
    assert.deepStrictEqual(score.scoreBreakdown, expected);
    assert.strictEqual(score.rawTotal, 100);
    assert.strictEqual(score.total, 100);
    assert.strictEqual(score.veto, null);
  });

  it('S4: esempio long completo (breakdown stampato per il report)', () => {
    const score = calculateCandidateScore(longQuote(), 0.5, 15);
    console.log('[example LONG]', JSON.stringify({ total: score.total, breakdown: score.scoreBreakdown }));
    assert.strictEqual(score.total, 100);
    assert.ok(score.details.some((d) => d.startsWith('Supertrend 5m: LONG')));
    assert.ok(score.details.some((d) => d.startsWith('ADX 5m 30.0')));
    assert.ok(score.details.some((d) => d.startsWith('StochRSI')));
    assert.ok(score.details.some((d) => d.startsWith('PSAR:')));
  });

  it('S5: esempio short completo (breakdown stampato per il report)', () => {
    const score = calculateCandidateScore(shortQuote(), -0.5, 15);
    console.log('[example SHORT]', JSON.stringify({ total: score.total, breakdown: score.scoreBreakdown }));
    assert.strictEqual(score.total, 100);
    assert.strictEqual(score.veto, null);
    assert.ok(score.details.some((d) => d.startsWith('Supertrend 5m: SHORT')));
    assert.ok((score.vwapScore ?? 0) === 10);
  });
});

describe('Setup score - dati assenti e conversioni', () => {
  it('S6: indicatori UNKNOWN -> 0 punti per Supertrend/ADX/StochRSI e nessun veto', () => {
    const score = calculateCandidateScore(longQuote({ setupIndicators: unknownIndicators() }), 0.5, null);
    assert.strictEqual(score.supertrendScore, 0);
    assert.strictEqual(score.adxScore, 0);
    assert.strictEqual(score.stochRsiScore, 0);
    assert.strictEqual(score.veto, null);
  });

  it('S7: conversione proporzionale legacy -> nuovo peso', () => {
    assert.strictEqual(scaleComponentToWeight(25, P.W_GAP, 25), 12);
    assert.strictEqual(scaleComponentToWeight(20, P.W_GAP, 25), 10);
    assert.strictEqual(scaleComponentToWeight(25, P.W_RVOL, 25), 14);
    assert.strictEqual(scaleComponentToWeight(10, P.W_LEVELS, 10), 6);
    assert.strictEqual(scaleComponentToWeight(20, P.W_FUTURES, 20), 12);
    assert.strictEqual(scaleComponentToWeight(12, P.W_FUTURES, 20), 7);
    assert.strictEqual(scaleComponentToWeight(4, P.W_FUTURES, 20), 2);
    assert.strictEqual(scaleComponentToWeight(15, P.W_NEWS, 15), 10);
    assert.strictEqual(scaleComponentToWeight(10, P.W_ORDER_FLOW, 10), 8);
    assert.strictEqual(scaleComponentToWeight(-10, P.W_ORDER_FLOW, 10), -8);
    assert.strictEqual(scaleComponentToWeight(-6, P.W_ORDER_FLOW, 10), -5);
    // nessun componente puo superare il proprio peso
    assert.strictEqual(scaleComponentToWeight(99, P.W_ADX, 20), P.W_ADX);
  });

  it('S8: VWAP non e mai negativa (stato contrario -> 0 + veto)', () => {
    const opposed = calculateVwapScoreContribution(vwap({ state: 'BELOW', distAtr: -2 }), 'LONG');
    assert.strictEqual(opposed.score, 0);
    assert.strictEqual(opposed.gated, true);
    for (const st of ['ABOVE', 'BELOW', 'PULLBACK', 'RECLAIM', 'REJECT', 'NEUTRAL', 'UNCONFIRMED', 'UNKNOWN'] as const) {
      const c = calculateVwapScoreContribution(vwap({ state: st, distAtr: -1.5 }), 'LONG');
      assert.ok(c.score >= 0, `stato ${st}: score ${c.score}`);
    }
  });
});

describe('Setup score - veti', () => {
  const adxWeak = (): SetupIndicators => ({
    ...alignedIndicators(1),
    adx: { status: 'OK', reason: null, value: 15, plusDI: 20, minusDI: 12 },
  });
  const supertrendOpposed = (): SetupIndicators => ({
    ...alignedIndicators(1),
    supertrend: { status: 'OK', reason: null, direction: -1, barsSinceFlip: 1, value: 104 },
  });

  it('S9: ADX 15 sotto la soglia US (20) blocca il setup con veto ADX_BELOW_MARKET_THRESHOLD', () => {
    const score = calculateCandidateScore(longQuote({ setupIndicators: adxWeak() }), 0.5, null);
    assert.ok(score.vetoReasons?.includes('ADX_BELOW_MARKET_THRESHOLD'), `veti: ${score.vetoReasons}`);
    assert.strictEqual(score.adxScore, 0);
    assert.strictEqual(score.veto, 'ADX_BELOW_MARKET_THRESHOLD');
  });

  it('S10: Supertrend contrario blocca il setup con veto SUPERTREND_OPPOSED', () => {
    const score = calculateCandidateScore(longQuote({ setupIndicators: supertrendOpposed() }), 0.5, null);
    assert.ok(score.vetoReasons?.includes('SUPERTREND_OPPOSED'));
    assert.strictEqual(score.supertrendScore, 0);
  });

  it('S11: VWAP contraria con volume confermato -> veto VWAP_OPPOSED (disattivabile)', () => {
    const q = longQuote({ vwapState: vwap({ state: 'BELOW', distAtr: -0.5 }) });
    const vetoed = calculateCandidateScore(q, 0.5, null);
    assert.ok(vetoed.vetoReasons?.includes('VWAP_OPPOSED'), `veti: ${vetoed.vetoReasons}`);
    assert.strictEqual(vetoed.vwapScore, 0);

    const original = P.VWAP_VETO_ENABLED;
    try {
      P.VWAP_VETO_ENABLED = false;
      const noVeto = calculateCandidateScore(q, 0.5, null);
      assert.ok(!noVeto.vetoReasons?.includes('VWAP_OPPOSED'));
      assert.strictEqual(noVeto.vwapScore, 0);
    } finally {
      P.VWAP_VETO_ENABLED = original;
    }
  });

  it('S12: senza volume confermato la VWAP contraria non produce veto', () => {
    const q = longQuote({ vwapState: vwap({ state: 'BELOW', distAtr: -0.5, volumeRatio: 0.4 }) });
    const reasons = evaluateSetupVetoes('LONG', q.setupIndicators, q.vwapState);
    assert.deepStrictEqual(reasons, []);
  });

  it('S13: rankMarketCandidates scarta i candidati con veto', () => {
    const good = longQuote({ ticker: 'GOOD' });
    const bad = longQuote({ ticker: 'BAD', setupIndicators: supertrendOpposed() });
    const ranked = rankMarketCandidates([bad, good], 'US', 0.5);
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].quote.ticker, 'GOOD');
  });
});

console.log('ALL SETUP SCORE TESTS PASS!');
