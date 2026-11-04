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
import { RawQuoteData } from '../../types/radar';

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
const W = TRADING_PARAMS.VWAP_SCORE_WEIGHT;

// Serie rialzista con ultima barra a volume confermato (2.4x la media 5m)
const risingBars = (): VwapBar[] => {
  const bars = Array.from({ length: 7 }, (_, i) => {
    const c = 100 + i;
    return bar(14, 30 + i * 5, c + 1, c - 1, c, 1000);
  });
  bars.push(bar(15, 5, 109, 107, 108, 3000));
  return bars;
};

const fallingBars = (): VwapBar[] => {
  const bars = Array.from({ length: 7 }, (_, i) => {
    const c = 107 - i;
    return bar(14, 30 + i * 5, c + 1, c - 1, c, 1000);
  });
  bars.push(bar(15, 5, 101, 99, 100, 3000));
  return bars;
};

// Chiusure sotto la VWAP e ultima barra che la recupera con volume -> RECLAIM
const reclaimBars = (): VwapBar[] => {
  const bars = Array.from({ length: 7 }, (_, i) => bar(14, 30 + i * 5, 100.5, 99, 99.5, 1000));
  // ultima barra: recupera la VWAP senza toccarla dal basso, volume 2.4x
  bars.push(bar(15, 5, 105, 101, 102, 3000));
  return bars;
};

// Ultima barra che rompe sopra la VWAP e chiude sotto con volume -> REJECT
const rejectBars = (): VwapBar[] => {
  const bars = Array.from({ length: 7 }, (_, i) => bar(14, 30 + i * 5, 100.5, 99, 99.5, 1000));
  // ultima barra: rompe sopra la VWAP e chiude decisamente sotto, volume 2.4x
  bars.push(bar(15, 5, 101, 96, 97, 3000));
  return bars;
};

// Ritorno alla VWAP con tenuta (minimo a contatto, chiusura sopra) -> PULLBACK
const pullbackBars = (): VwapBar[] => {
  const bars = Array.from({ length: 7 }, (_, i) => bar(14, 30 + i * 5, 100.5, 99.5, 100, 1000));
  // ultima barra: minimo a contatto con la VWAP e chiusura sopra, volume 2.4x
  bars.push(bar(15, 5, 108.3, 101.2, 102.5, 3000));
  return bars;
};

const stateOf = (bars: VwapBar[], overrides: Record<string, unknown> = {}) =>
  computeVwapState(bars, {
    market: 'US',
    sessionDate: DATE,
    atr5m: ATR,
    coverage: COVERAGE,
    ...overrides,
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
  ema20Daily: 98,
  avgVolume20d: 5_000_000,
  preMarketVolume: 100_000,
  atr14: 2,
  gapPercent: 1.0,
  rvol: 1.6,
  rsi5m: 55,
  rsi14: 55,
  orderFlow: null,
  timestamp: new Date().toISOString(),
  source: 'test',
  ...over,
});

describe('VWAP - rilevazione stato (nomi finali)', () => {
  it('T1: serie rialzista -> ABOVE con volumeRatio >= 1.5 e contributo positivo per LONG', () => {
    const s = stateOf(risingBars());
    assert.strictEqual(s.state, 'ABOVE');
    assert.ok((s.volumeRatio ?? 0) >= 1.5, `volumeRatio atteso >= 1.5, ottenuto ${s.volumeRatio}`);
    assert.ok(calculateVwapScoreContribution(s, 'LONG').score > 0);
  });

  it('T2: serie ribassista -> BELOW e contributo negativo per LONG', () => {
    const s = stateOf(fallingBars());
    assert.strictEqual(s.state, 'BELOW');
    assert.ok(calculateVwapScoreContribution(s, 'LONG').score < 0);
  });

  it('T3: ritorno alla VWAP con tenuta -> PULLBACK', () => {
    const s = stateOf(pullbackBars());
    assert.strictEqual(s.state, 'PULLBACK');
    assert.strictEqual(calculateVwapScoreContribution(s, 'LONG').score, +(W / 2).toFixed(2));
  });

  it('T4: recupero con volume -> RECLAIM', () => {
    const s = stateOf(reclaimBars());
    assert.strictEqual(s.state, 'RECLAIM');
    assert.ok(calculateVwapScoreContribution(s, 'LONG').score > 0);
  });

  it('T5: respinta con volume -> REJECT', () => {
    const s = stateOf(rejectBars());
    assert.strictEqual(s.state, 'REJECT');
    assert.ok(calculateVwapScoreContribution(s, 'LONG').score < 0);
  });
});

describe('VWAP - regola after-hours e qualita dati', () => {
  it('T6: barra after-market -> UNKNOWN + AFTER_HOURS, contributo 0', () => {
    const s = stateOf([...risingBars(), bar(21, 30, 200, 199, 199.5, 900)]);
    assert.strictEqual(s.state, 'UNKNOWN');
    assert.ok(s.flags.includes('AFTER_HOURS'));
    const c = calculateVwapScoreContribution(s, 'LONG');
    assert.strictEqual(c.score, 0);
    assert.ok(c.detail.startsWith('VWAP: UNKNOWN (AFTER_HOURS)'));
  });

  it('T7: coverage sotto soglia -> UNKNOWN + LOW_VWAP_COVERAGE, contributo 0', () => {
    const s = stateOf(risingBars(), { coverage: 0.5 });
    assert.strictEqual(s.state, 'UNKNOWN');
    assert.ok(s.flags.includes('LOW_VWAP_COVERAGE'));
    const c = calculateVwapScoreContribution(s, 'LONG');
    assert.strictEqual(c.score, 0);
  });
});

describe('VWAP - gate e score', () => {
  it('T8: VWAP_HARD_GATE = false (default) non scarta nessuno; con gate attivo scarta il contrario', () => {
    const opposed = stateOf(fallingBars());
    assert.strictEqual(TRADING_PARAMS.VWAP_HARD_GATE, false);
    assert.strictEqual(passesVwapHardGate(opposed, 'LONG'), true);
    assert.strictEqual(passesVwapHardGate(opposed, 'LONG', { hardGate: true }), false);
    assert.strictEqual(passesVwapHardGate(opposed, 'SHORT', { hardGate: true }), true);

    const quotes = [
      baseQuote({ ticker: 'AAPL', vwapState: opposed }),
      baseQuote({ ticker: 'MSFT', vwapState: stateOf(risingBars()) }),
    ];
    assert.strictEqual(rankMarketCandidates(quotes, 'US', 0.2).length, 2);

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

  it('T9: con peso 10 lo score incorpora il contributo VWAP (non piu parita a zero)', () => {
    const above = stateOf(risingBars());
    const withoutVwap = calculateCandidateScore(baseQuote({ vwapState: null }), 0.2, null);
    const withVwap = calculateCandidateScore(baseQuote({ vwapState: above }), 0.2, null);

    assert.strictEqual(withoutVwap.vwapScore, 0);
    assert.ok((withVwap.vwapScore ?? 0) > 0, `vwapScore atteso > 0, ottenuto ${withVwap.vwapScore}`);
    assert.ok((withVwap.rawTotal ?? 0) > (withoutVwap.rawTotal ?? 0));
    assert.ok(withVwap.details.some((d) => d.startsWith('VWAP: ABOVE')));
  });
});

console.log('ALL VWAP SCORING TESTS PASS!');
