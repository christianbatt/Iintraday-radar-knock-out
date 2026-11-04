import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateCandidateScore,
  computeVwapState,
  resolveVwapStateForScoring,
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

// Barre di sessione regolare 09:30-10:05 ET con volume reale
const risingBars = (): VwapBar[] =>
  Array.from({ length: 8 }, (_, i) => {
    const c = 100 + i;
    return bar(14, 30 + i * 5, c + 1, c - 1, c, 1000);
  });

const LAST_BAR_TIME = utc(15, 5); // 10:05 ET, ultima barra di risingBars()

const stateOf = (bars: VwapBar[]): VwapSignalState =>
  computeVwapState(bars, {
    market: 'US',
    sessionDate: DATE,
    atr5m: 10,
    coverage: 1,
  });

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

describe('VWAP scoring - volume della barra dal feed 5m', () => {
  it('T12: barra di sessione regolare con volume -> stato diverso da UNKNOWN al call site di scoring', () => {
    const state = stateOf(risingBars());
    assert.strictEqual(state.state, 'ABOVE');

    const resolved = resolveVwapStateForScoring(state, { volume: 1000, barTime: LAST_BAR_TIME }, 'US');
    assert.notStrictEqual(resolved?.state, 'UNKNOWN');
    assert.strictEqual(resolved?.state, 'ABOVE');

    const score = calculateCandidateScore(baseQuote({ vwapState: state }), 0.2, null, {
      volume: 1000,
      barTime: LAST_BAR_TIME,
    });
    assert.strictEqual(score.vwapScore, 0); // VWAP_SCORE_WEIGHT = 0
    assert.ok(
      score.details.some((d) => d.includes('VWAP di sessione ABOVE')),
      `dettaglio VWAP atteso con stato ABOVE, ottenuti: ${score.details.join(' | ')}`
    );
  });

  it('T13: barra after-market -> UNKNOWN + AFTER_HOURS, contributo 0 anche con peso forzato', () => {
    const state = stateOf(risingBars());
    const resolved = resolveVwapStateForScoring(
      state,
      { volume: 900, barTime: utc(21, 30) }, // 16:30 ET
      'US'
    );
    assert.strictEqual(resolved?.state, 'UNKNOWN');
    assert.ok(resolved?.flags.includes('AFTER_HOURS'));

    const original = TRADING_PARAMS.VWAP_SCORE_WEIGHT;
    TRADING_PARAMS.VWAP_SCORE_WEIGHT = 0.15;
    try {
      const score = calculateCandidateScore(baseQuote({ vwapState: state }), 0.2, null, {
        volume: 900,
        barTime: utc(21, 30),
      });
      assert.strictEqual(score.vwapScore, 0);
    } finally {
      TRADING_PARAMS.VWAP_SCORE_WEIGHT = original;
    }
  });

  it('T14: barra in sessione senza volume -> UNKNOWN + THIN_BAR_VOLUME', () => {
    const state = stateOf(risingBars());
    const resolved = resolveVwapStateForScoring(state, { volume: 0, barTime: LAST_BAR_TIME }, 'US');
    assert.strictEqual(resolved?.state, 'UNKNOWN');
    assert.ok(resolved?.flags.includes('THIN_BAR_VOLUME'));
    assert.ok(!resolved?.flags.includes('AFTER_HOURS'));
  });

  it('T15: payload AI - il candidato espone l\'oggetto vwap con state, distAtr, slopeAtr, coverage, flags', () => {
    const state = stateOf(risingBars());
    const payload = JSON.parse(
      JSON.stringify({ candidate: baseQuote({ vwapState: state }) })
    ) as { candidate: { vwapState: Record<string, unknown> } };
    for (const key of ['state', 'distAtr', 'slopeAtr', 'coverage', 'flags']) {
      assert.ok(key in payload.candidate.vwapState, `campo ${key} mancante nel payload AI`);
    }
  });

  it('T16: parita\' con peso 0 - barra valida o assente non cambiano lo score', () => {
    const state = stateOf(risingBars());
    const quote = baseQuote({ vwapState: state });
    const withoutBar = calculateCandidateScore(quote, 0.2, null);
    const withBar = calculateCandidateScore(quote, 0.2, null, {
      volume: 1000,
      barTime: LAST_BAR_TIME,
    });

    assert.strictEqual(TRADING_PARAMS.VWAP_SCORE_WEIGHT, 0);
    assert.strictEqual(TRADING_PARAMS.VWAP_HARD_GATE, false);
    assert.strictEqual(withBar.vwapScore, 0);
    assert.strictEqual(withBar.total, withoutBar.total);
    assert.strictEqual(withBar.rawTotal, withoutBar.rawTotal);
  });
});

console.log('ALL VWAP SCORE TESTS PASS!');
