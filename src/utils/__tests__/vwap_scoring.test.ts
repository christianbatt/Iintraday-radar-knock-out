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

// 2026-11-04: US in ora solare (EST, UTC-5) -> 09:30 ET = 14:30 UTC
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

const ATR = 10;
const COVERAGE = 1;
// Peso usato SOLO nei test: il default di TRADING_PARAMS e' 0 (parita' con il baseline)
const W = 0.15;

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

const pullbackBars = (): VwapBar[] => [...risingBars(), bar(15, 10, 105.5, 104.5, 105.2, 1000)];

const stateOf = (bars: VwapBar[], overrides: Record<string, unknown> = {}): VwapSignalState =>
  computeVwapState(bars, {
    market: 'US',
    sessionDate: DATE,
    atr5m: ATR,
    coverage: COVERAGE,
    ...overrides,
  });

const longContrib = (s: VwapSignalState) => calculateVwapScoreContribution(s, 'LONG', { weight: W });
const shortContrib = (s: VwapSignalState) => calculateVwapScoreContribution(s, 'SHORT', { weight: W });

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
  it('T1: ABOVE con pendenza positiva -> +W per long; con peso default 0 il contributo e nullo', () => {
    const s = stateOf(risingBars());
    assert.strictEqual(s.state, 'ABOVE');
    assert.ok((s.slopeAtr ?? 0) > 0, `slope attesa > 0, ottenuta ${s.slopeAtr}`);
    const c = longContrib(s);
    assert.strictEqual(c.score, W);
    assert.strictEqual(c.gated, false);
    assert.strictEqual(TRADING_PARAMS.VWAP_SCORE_WEIGHT, 0);
    assert.strictEqual(calculateVwapScoreContribution(s, 'LONG').score, 0);
  });

  it('T2: BELOW con pendenza negativa -> -W per long', () => {
    const s = stateOf(fallingBars());
    assert.strictEqual(s.state, 'BELOW');
    assert.ok((s.slopeAtr ?? 0) < 0, `slope attesa < 0, ottenuta ${s.slopeAtr}`);
    assert.strictEqual(longContrib(s).score, -W);
  });

  it('T3: PULLBACK_HOLD_UP con tenuta sopra la VWAP -> +W per long', () => {
    const s = stateOf(pullbackBars());
    assert.strictEqual(s.state, 'PULLBACK_HOLD_UP');
    assert.strictEqual(longContrib(s).score, W);
  });

  it('T4: REJECT_DOWN con volume sopra soglia -> -W per long', () => {
    const s = stateOf([...flatBars(), bar(15, 10, 101, 98, 99, 3000)]);
    assert.strictEqual(s.state, 'REJECT_DOWN');
    assert.ok(!s.flags.includes('WEAK_VWAP_BREAK'));
    assert.strictEqual(longContrib(s).score, -W);
  });

  it('T5: REJECT con volume basso -> fallback direzionale + WEAK_VWAP_BREAK, nessun evento extra', () => {
    const s = stateOf([...flatBars(), bar(15, 10, 101, 98, 99, 200)]);
    assert.strictEqual(s.state, 'BELOW');
    assert.ok(s.flags.includes('WEAK_VWAP_BREAK'), `flag atteso WEAK_VWAP_BREAK, ottenuti ${s.flags.join(',')}`);
    assert.ok(!s.flags.includes('AFTER_HOURS'));
    const c = longContrib(s);
    assert.strictEqual(c.score, -W);
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

  it('T7: finestra di apertura -> contributo x VWAP_OPEN_WEIGHT_FACTOR', () => {
    const s = stateOf(risingBars(), { nowMinutes: 575 });
    assert.ok(s.flags.includes('OPEN_WINDOW'));
    const c = longContrib(s);
    assert.strictEqual(c.score, +(W * TRADING_PARAMS.VWAP_OPEN_WEIGHT_FACTOR).toFixed(2));
    assert.strictEqual(c.score, 0.07);
    assert.ok(Math.abs(c.score - W / 2) <= 0.005);
  });

  it('T8: direzione SHORT = specchio di T1-T4', () => {
    const above = stateOf(risingBars());
    const pullback = stateOf(pullbackBars());
    const reject = stateOf([...flatBars(), bar(15, 10, 101, 98, 99, 3000)]);
    const below = stateOf(fallingBars());
    assert.strictEqual(shortContrib(above).score, -W);
    assert.strictEqual(shortContrib(pullback).score, -W);
    assert.strictEqual(shortContrib(reject).score, W);
    assert.strictEqual(shortContrib(below).score, W);
  });
});

describe('VWAP - regola after-hours', () => {
  it('T11: barra after-market sopra la VWAP -> UNKNOWN, flag AFTER_HOURS, contributo 0', () => {
    // 21:30 UTC = 16:30 ET: fuori sessione regolare, prezzo molto sopra la VWAP di sessione
    const s = stateOf([...risingBars(), bar(21, 30, 200, 199, 199.5, 500)]);
    assert.strictEqual(s.state, 'UNKNOWN');
    assert.ok(s.flags.includes('AFTER_HOURS'), `flag atteso AFTER_HOURS, ottenuti ${s.flags.join(',')}`);
    assert.strictEqual(longContrib(s).score, 0);
    assert.strictEqual(calculateVwapScoreContribution(s, 'LONG').score, 0);
  });

  it('T11b: barra in sessione ma troppo illiquida -> UNKNOWN + AFTER_HOURS', () => {
    const s = stateOf([...risingBars(), bar(15, 10, 106.5, 105.5, 106, 50)]);
    assert.strictEqual(s.state, 'UNKNOWN');
    assert.ok(s.flags.includes('AFTER_HOURS'));
    assert.strictEqual(longContrib(s).score, 0);
  });
});

describe('VWAP - contributo nello score', () => {
  it('T9: con VWAP_SCORE_WEIGHT = 0 lo score e identico al baseline', () => {
    const above = stateOf(risingBars());
    const baseline = calculateCandidateScore(baseQuote(), 0.2, null);
    const identical = calculateCandidateScore(baseQuote({ vwapState: above }), 0.2, null);

    assert.strictEqual(TRADING_PARAMS.VWAP_SCORE_WEIGHT, 0);
    assert.strictEqual(identical.vwapScore, 0);
    assert.strictEqual(identical.total, baseline.total);
    assert.strictEqual(identical.rawTotal, baseline.rawTotal);

    const original = TRADING_PARAMS.VWAP_SCORE_WEIGHT;
    TRADING_PARAMS.VWAP_SCORE_WEIGHT = W;
    try {
      const weighted = calculateCandidateScore(baseQuote({ vwapState: above }), 0.2, null);
      assert.strictEqual(weighted.vwapScore, W);
      assert.strictEqual(weighted.rawTotal, +(baseline.rawTotal! + W).toFixed(1));
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
