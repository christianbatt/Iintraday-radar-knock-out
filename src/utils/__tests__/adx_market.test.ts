import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  adxThresholds,
  calculateCandidateScore,
  getDualTopCandidates,
  isWarmupIncomplete,
} from '../calculator';
import { TRADING_PARAMS } from '../../config/tradingParams';
import type { RawQuoteData, SetupIndicators, VwapSignalState } from '../../types/radar';

const P = TRADING_PARAMS;

const vwap = (direction: 1 | -1): VwapSignalState => ({
  state: direction === 1 ? 'ABOVE' : 'BELOW',
  distAtr: direction === 1 ? 0.5 : -0.5,
  slopeAtr: direction === 1 ? 0.2 : -0.2,
  coverage: 1,
  volumeRatio: 2.1,
  flags: [],
  vwapLevel: 102,
});

/** Indicatori con ADX parametrico: direzione 1 = long (+DI > -DI), -1 = short (-DI > +DI). */
const setupIndicators = (
  direction: 1 | -1,
  adx: number | 'UNKNOWN',
  diAligned = true
): SetupIndicators => ({
  barsUsed: 120,
  atr: { value: 0.5, status: 'OK', reason: null },
  supertrend: { status: 'OK', reason: null, direction, barsSinceFlip: 2, value: 99 },
  adx:
    adx === 'UNKNOWN'
      ? { status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS', value: null, plusDI: null, minusDI: null }
      : {
          status: 'OK',
          reason: null,
          value: adx,
          plusDI: direction === 1 ? (diAligned ? 30 : 10) : diAligned ? 10 : 30,
          minusDI: direction === 1 ? (diAligned ? 10 : 30) : diAligned ? 30 : 10,
        },
  stochRsi: {
    status: 'OK',
    reason: null,
    k: direction === 1 ? 40 : 60,
    d: direction === 1 ? 35 : 65,
    lastCross: direction === 1 ? 'LONG' : 'SHORT',
    barsSinceCross: 1,
  },
  psar: { status: 'OK', reason: null, value: 97, direction, barsSinceFlip: 3 },
});

/** Quote valida (gap, RVOL, order flow, VWAP allineati) per isolare il componente ADX. */
const quote = (
  market: 'EU' | 'US',
  direction: 1 | -1,
  indicators: SetupIndicators
): RawQuoteData => ({
  ticker: direction === 1 ? 'AAA' : 'BBB',
  name: 'Test',
  market,
  currency: market === 'EU' ? 'EUR' : 'USD',
  prevClose: 100,
  currentPrice: direction === 1 ? 103 : 97,
  preMarketPrice: null,
  prevHigh: direction === 1 ? 99 : 101,
  prevLow: direction === 1 ? 95 : 98,
  preMarketHigh: null,
  preMarketLow: null,
  todayOpen: direction === 1 ? 101 : 99,
  todayHigh: direction === 1 ? 104 : 100,
  todayLow: direction === 1 ? 100 : 96,
  vwap: direction === 1 ? 102 : 98,
  ema20Daily: direction === 1 ? 98 : 102,
  avgVolume20d: 5_000_000,
  preMarketVolume: 100_000,
  atr14: 1,
  gapPercent: direction === 1 ? 1 : -1,
  rvol: 2.5,
  rsi5m: 55,
  rsi14: 55,
  orderFlow: {
    buyerVolumePercent: direction === 1 ? 65 : 35,
    sellerVolumePercent: direction === 1 ? 35 : 65,
    netDeltaPercent: direction === 1 ? 30 : -30,
    cvdTrend: direction === 1 ? 'EXPANDING_UP' : 'EXPANDING_DOWN',
    vpocPrice: 100.5,
    isPriceAboveVpoc: direction === 1,
    flowQuality: direction === 1 ? 'INSTITUTIONAL_BUYING' : 'INSTITUTIONAL_SELLING',
    summary: 'test',
  },
  setupIndicators: indicators,
  vwapState: vwap(direction),
  timestamp: new Date().toISOString(),
  source: 'test',
});

const scoreFor = (market: 'EU' | 'US', direction: 1 | -1, adx: number | 'UNKNOWN', diAligned = true) =>
  calculateCandidateScore(
    quote(market, direction, setupIndicators(direction, adx, diAligned)),
    0.5,
    null
  );

describe('ADX per mercato e regola direzionale (IPOTESI)', () => {
  it('A1: EU ADX 15 con DI long allineato -> veto ADX_BELOW_MARKET_THRESHOLD', () => {
    const score = scoreFor('EU', 1, 15);
    assert.strictEqual(score.veto, 'ADX_BELOW_MARKET_THRESHOLD');
    assert.ok(score.vetoReasons?.includes('ADX_BELOW_MARKET_THRESHOLD'));
    assert.strictEqual(score.adxScore, 0);
  });

  it('A2: EU ADX 17 con DI long allineato -> nessun veto, 4 punti', () => {
    const score = scoreFor('EU', 1, 17);
    assert.strictEqual(score.veto, null);
    assert.ok(!score.vetoReasons?.includes('ADX_BELOW_MARKET_THRESHOLD'));
    assert.strictEqual(score.adxScore, 4);
  });

  it('A3: EU ADX 20 con DI long allineato -> 7 punti (trend forte EU)', () => {
    const score = scoreFor('EU', 1, 20);
    assert.strictEqual(score.veto, null);
    assert.strictEqual(score.adxScore, P.W_ADX);
  });

  it('A4: US ADX 18 con DI long allineato -> veto', () => {
    const score = scoreFor('US', 1, 18);
    assert.strictEqual(score.veto, 'ADX_BELOW_MARKET_THRESHOLD');
    assert.strictEqual(score.adxScore, 0);
  });

  it('A5: US ADX 22 con DI long allineato -> 4 punti', () => {
    const score = scoreFor('US', 1, 22);
    assert.strictEqual(score.veto, null);
    assert.strictEqual(score.adxScore, 4);
  });

  it('A6: US ADX 25 con DI long allineato -> 7 punti (trend forte US)', () => {
    const score = scoreFor('US', 1, 25);
    assert.strictEqual(score.veto, null);
    assert.strictEqual(score.adxScore, P.W_ADX);
  });

  it('A7: stesso ADX 17 -> EU senza veto, US con veto', () => {
    const eu = scoreFor('EU', 1, 17);
    const us = scoreFor('US', 1, 17);
    assert.strictEqual(eu.veto, null);
    assert.strictEqual(eu.adxScore, 4);
    assert.strictEqual(us.veto, 'ADX_BELOW_MARKET_THRESHOLD');
  });

  it('A8: short EU ADX 17 con -DI > +DI -> 4 punti', () => {
    const score = scoreFor('EU', -1, 17);
    assert.strictEqual(score.veto, null);
    assert.strictEqual(score.adxScore, 4);
  });

  it('A9: short EU ADX 17 con +DI > -DI -> 0 punti e nessun veto ADX', () => {
    const score = scoreFor('EU', -1, 17, false);
    assert.ok(!score.vetoReasons?.includes('ADX_BELOW_MARKET_THRESHOLD'));
    assert.strictEqual(score.adxScore, 0);
    assert.strictEqual(score.veto, null);
  });

  it('A10: ADX UNKNOWN -> 0 punti, nessun veto, WARMUP_INCOMPLETE', () => {
    const score = scoreFor('EU', 1, 'UNKNOWN');
    assert.strictEqual(score.adxScore, 0);
    assert.ok(!score.vetoReasons?.includes('ADX_BELOW_MARKET_THRESHOLD'));
    assert.strictEqual(score.veto, null);
    assert.strictEqual(score.warmupIncomplete, true);
    assert.strictEqual(isWarmupIncomplete(undefined), true);
  });

  it('A11: per ogni mercato ADX_MIN_TREND < ADX_STRONG', () => {
    const eu = adxThresholds('EU');
    const us = adxThresholds('US');
    assert.deepStrictEqual(eu, { min: 16, strong: 20 });
    assert.deepStrictEqual(us, { min: 20, strong: 25 });
    assert.ok(eu.min < eu.strong, `EU ${eu.min} >= ${eu.strong}`);
    assert.ok(us.min < us.strong, `US ${us.min} >= ${us.strong}`);
  });

  it('A12: un candidato con WARMUP_INCOMPLETE non puo essere Top Pick', () => {
    const incomplete = quote('EU', 1, setupIndicators(1, 'UNKNOWN'));
    const result = getDualTopCandidates([incomplete], 0.5);
    assert.strictEqual(result.rankedEU.length, 1);
    assert.strictEqual(result.topEU, null);
  });
});

console.log('ALL ADX MARKET TESTS PASS!');
