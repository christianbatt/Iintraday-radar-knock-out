import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  computeVwapState,
  calculateVwapScoreContribution,
  passesVwapHardGate,
  rankMarketCandidates,
  calculateCandidateScore,
  VwapBar,
} from '../calculator';
import { TRADING_PARAMS } from '../../config/tradingParams';
import { RawQuoteData, VwapSignalState } from '../../types/radar';

// 2026-11-04: US in ora solare (EST, UTC-5) -> 09:30 NY = 14:30 UTC
const DATE = '2026-11-04';
const utc = (h: number, m: number): number => Date.UTC(2026, 10, 4, h, m, 0) / 1000;
const bar = (
  h: number,
  m: number,
  high: number,
  low: number,
  close: number,
  volume: number
): VwapBar => ({ timestamp: utc(h, m), high, low, close, volume });

// ATR 5m fittizio = 10 per rendere leggibili le soglie in ATR
const ATR = 10;
const COVERAGE = 1;

const risingBars = (): VwapBar[] =>
  Array.from({ length: 8 }, (_, i) => {
    const c = 100 + i;
    return bar(14, 30 + i * 5, c + 1, c - 1, c, 1000);
  });

const fallingBars = (): VwapBar[] =>
  Array.from({ length: 8 }, (_, i) => {
    const c = 107 - i;
    return bar(14, 30 + i * 5, c + 1, c - 1, c, 1000);
  });

const flatBars = (): VwapBar[] =>
  Array.from({ length: 8 }, (_, i) => bar(14, 30 + i * 5, 100.5, 99.5, 100, 1000));

const stateOf = (bars: VwapBar[], overrides: Record<string, unknown> = {}): VwapSignalState =>
  computeVwapState(bars, {
    market: 'US',
    sessionDate: DATE,
    atr5m: ATR,
    coverage: COVERAGE,
    ...overrides,
  });

const longContrib = (s: VwapSignalState) => calculateVwapScoreContribution(s, 'LONG');
const shortContrib = (s: VwapSignalState) => calculateVwapScoreContribution(s, 'SHORT');

// Fixture candidato per lo score completo
const baseQuote = (over: Partial<RawQuoteData> = {}): RawQuoteData => ({
  ticker: 'AAPL',
  name: 'Apple Inc.',
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
  avgVolume20d: 5_000_000,
  preMarketVolume: 100_000,
  atr14: 2,
  gapPercent: 1.0,
  rvol: 1.6,
  rsi5m: 55,
  rsi14: 55,
  ema20Daily: 98,
  orderFlow: null,
  timestamp: new Date().toISOString(),
  source: 'test',
  ...over,
});

describe('VWAP - rilevazione stato', () => {
  it('T1: ABOVE con pendenza positiva', () => {
    const s = stateOf(risingBars());
    assert.strictEqual(s.state, 'ABOVE');
    assert.ok((s.slopeAtr ?? 0) > 0, `slope attesa > 0, ottenuta ${s.slopeAtr}`);
    const c = longContrib(s);
    assert.strictEqual(c.score, TRADING_PARAMS.VWAP_SCORE_WEIGHT);
    assert.strictEqual(c.score, 0.15);
    assert.strictEqual(c.gated, false);
  });

  it('T2: BELOW con pendenza negativa', () => {
    const s = stateOf(fallingBars());
    assert.strictEqual(s.state, 'BELOW');
    assert.ok((s.slopeAtr ?? 0) < 0, `slope attesa < 0, ottenuta ${s.slopeAtr}`);
    assert.strictEqual(longContrib(s).score, -0.15);
  });

  it('T3: PULLBACK_HOLD_UP con tenuta sopra la VWAP', () => {
    const bars = [...risingBars(), bar(15, 10, 105.5, 104.5, 105.2, 1000)];
    const s = stateOf(bars);
    assert.strictEqual(s.state, 'PULLBACK_HOLD_UP');
    assert.strictEqual(longContrib(s).score, 0.15);
  });

  it('T4: REJECT_DOWN con volume sopra soglia', () => {
    const bars = [...flatBars(), bar(15, 10, 101, 98, 99, 3000)];
    const s = stateOf(bars);
    assert.strictEqual(s.state, 'REJECT_DOWN');
    assert.ok(!s.flags.includes('WEAK_VWAP_BREAK'));
    assert.strictEqual(longContrib(s).score, -0.15);
  });

  it('T5: REJECT con volume basso -> fallback direzionale + WEAK_VWAP_BREAK, nessun evento extra', () => {
    const bars = [...flatBars(), bar(15, 10, 101, 98, 99, 200)];
    const s = stateOf(bars);
    assert.strictEqual(s.state, 'BELOW');
    assert.ok(s.flags.includes('WEAK_VWAP_BREAK'), `flag atteso WEAK_VWAP_BREAK, ottenuti ${s.flags.join(',')}`);
    // Il fallback direzionale resta valutabile: nessun evento RECLAIM/REJECT riconosciuto
    const c = longContrib(s);
    assert.strictEqual(c.score, -0.15);
    assert.ok(c.detail?.includes('BELOW'));
  });

  it('T6: coverage sotto soglia -> UNKNOWN, contributo 0 e flag LOW_VWAP_COVERAGE', () => {
    const s = stateOf(risingBars(), { coverage: 0.5 });
    assert.strictEqual(s.state, 'UNKNOWN');
    assert.ok(s.flags.includes('LOW_VWAP_COVERAGE'));
    const c = longContrib(s);
    assert.strictEqual(c.score, 0);
    assert.strictEqual(c.detail, null);
  });

  it('T7: finestra di apertura -> contributo moltiplicato per VWAP_OPEN_WEIGHT_FACTOR', () => {
    const s = stateOf(risingBars(), { nowMinutes: 575 });
    assert.ok(s.flags.includes('OPEN_WINDOW'));
    const c = longContrib(s);
    // 0.15 * 0.5 = 0.075 -> arrotondato a 2 decimali = 0.07
    assert.strictEqual(c.score, +(TRADING_PARAMS.VWAP_SCORE_WEIGHT * TRADING_PARAMS.VWAP_OPEN_WEIGHT_FACTOR).toFixed(2));
    assert.strictEqual(c.score, 0.07);
    assert.ok(Math.abs(c.score - TRADING_PARAMS.VWAP_SCORE_WEIGHT / 2) <= 0.005);
  });

  it('T8: direzione SHORT = specchio di T1-T4', () => {
    const above = stateOf(risingBars());
    const pullback = stateOf([...risingBars(), bar(15, 10, 105.5, 104.5, 105.2, 1000)]);
    const reject = stateOf([...flatBars(), bar(15, 10, 101, 98, 99, 3000)]);
    const below = stateOf(fallingBars());
    assert.strictEqual(shortContrib(above).score, -0.15);
    assert.strictEqual(shortContrib(pullback).score, -0.15);
    assert.strictEqual(shortContrib(reject).score, 0.15);
    assert.strictEqual(shortContrib(below).score, 0.15);
  });
});

describe('VWAP - contributo nello score', () => {
  it('T9: VWAP_SCORE_WEIGHT = 0 lascia lo score identico al baseline', () => {
    const above = stateOf(risingBars());
    const baseline = calculateCandidateScore(baseQuote(), 0.2, null);
    const withVwap = calculateCandidateScore(baseQuote({ vwapState: above }), 0.2, null);

    assert.strictEqual(withVwap.vwapScore, 0.15);
    assert.strictEqual(withVwap.rawTotal, +(baseline.rawTotal! + 0.15).toFixed(1));

    const original = TRADING_PARAMS.VWAP_SCORE_WEIGHT;
    TRADING_PARAMS.VWAP_SCORE_WEIGHT = 0;
    try {
      const zeroWeight = calculateCandidateScore(baseQuote({ vwapState: above }), 0.2, null);
      assert.strictEqual(zeroWeight.vwapScore, 0);
      assert.strictEqual(zeroWeight.total, baseline.total);
      assert.strictEqual(zeroWeight.rawTotal, baseline.rawTotal);
    } finally {
      TRADING_PARAMS.VWAP_SCORE_WEIGHT = original;
    }
  });

  it('T10: VWAP_HARD_GATE = true scarta il candidato con stato contrario', () => {
    const opposed = stateOf(fallingBars());
    assert.strictEqual(passesVwapHardGate(opposed, 'LONG', { hardGate: false }), true);
    assert.strictEqual(passesVwapHardGate(opposed, 'LONG', { hardGate: true }), false);
    assert.strictEqual(passesVwapHardGate(opposed, 'SHORT', { hardGate: true }), true);

    const quotes = [
      baseQuote({ ticker: 'AAPL', vwapState: opposed }),
      baseQuote({ ticker: 'MSFT', vwapState: stateOf(risingBars()) }),
    ];

    const withoutGate = rankMarketCandidates(quotes, 'US', 0.2);
    assert.strictEqual(withoutGate.length, 2);

    const original = TRADING_PARAMS.VWAP_HARD_GATE;
    TRADING_PARAMS.VWAP_HARD_GATE = true;
    try {
      const gated = rankMarketCandidates(quotes, 'US', 0.2);
      assert.strictEqual(gated.length, 1);
      assert.strictEqual(gated[0].quote.ticker, 'MSFT');
    } finally {
      TRADING_PARAMS.VWAP_HARD_GATE = original;
    }
  });
});

console.log('ALL VWAP SCORING TESTS PASS!');
