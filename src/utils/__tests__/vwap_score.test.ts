import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateCandidateScore,
  calculateVwapScoreContribution,
  rankMarketCandidates,
} from '../calculator';
import { TRADING_PARAMS } from '../../config/tradingParams';
import { VWAP_PROMPT_BLOCK, VWAP_STATE_NAMES } from '../../config/vwapPrompt';
import { RawQuoteData, VwapSignalState } from '../../types/radar';

const W = TRADING_PARAMS.VWAP_SCORE_WEIGHT;

const state = (over: Partial<VwapSignalState> = {}): VwapSignalState => ({
  state: 'ABOVE',
  distAtr: 0.5,
  slopeAtr: 0.2,
  coverage: 1,
  volumeRatio: 2.1,
  flags: [],
  vwapLevel: 100,
  ...over,
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

describe('VWAP scoring - pesi e parametri (IPOTESI)', () => {
  it('T1: VWAP_SCORE_WEIGHT = 10 (10% del tetto 100), gate off, banda neutra e soglia volume attive', () => {
    assert.strictEqual(TRADING_PARAMS.VWAP_SCORE_WEIGHT, 10);
    assert.strictEqual(TRADING_PARAMS.VWAP_HARD_GATE, false);
    assert.strictEqual(TRADING_PARAMS.VWAP_NEUTRAL_BAND_ATR, 0.1);
    assert.strictEqual(TRADING_PARAMS.VWAP_MIN_VOLUME_RATIO, 1.5);
  });
});

describe('VWAP scoring - contributo per stato', () => {
  it('T2: ABOVE con volume confermato -> +W scalato su distAtr (0.5 ATR = +5)', () => {
    const c = calculateVwapScoreContribution(state({ state: 'ABOVE', distAtr: 0.5 }), 'LONG');
    assert.strictEqual(c.score, +5);
    assert.strictEqual(c.state, 'ABOVE');
    assert.ok(c.detail.startsWith('VWAP: ABOVE | dist 0.50 ATR | vol 2.10x | contributo +5/10'), c.detail);
  });

  it('T3: ABOVE con distAtr oltre 1 ATR -> cap a +W', () => {
    const c = calculateVwapScoreContribution(state({ state: 'ABOVE', distAtr: 3.4 }), 'LONG');
    assert.strictEqual(c.score, +W);
  });

  it('T4: RECLAIM con volume confermato -> +W scalato (0.4 ATR = +4)', () => {
    const c = calculateVwapScoreContribution(state({ state: 'RECLAIM', distAtr: 0.4 }), 'LONG');
    assert.strictEqual(c.score, +4);
  });

  it('T5: PULLBACK con volume confermato -> +W/2', () => {
    const c = calculateVwapScoreContribution(state({ state: 'PULLBACK', distAtr: 0.6 }), 'LONG');
    assert.strictEqual(c.score, +5);
  });

  it('T6: BELOW/REJECT con volume confermato -> -W per long, +W per short', () => {
    const below = state({ state: 'BELOW', distAtr: -0.6 });
    const reject = state({ state: 'REJECT', distAtr: -0.4 });
    assert.strictEqual(calculateVwapScoreContribution(below, 'LONG').score, -W);
    assert.strictEqual(calculateVwapScoreContribution(below, 'SHORT').score, +W);
    assert.strictEqual(calculateVwapScoreContribution(reject, 'LONG').score, -W);
    assert.strictEqual(calculateVwapScoreContribution(reject, 'SHORT').score, +W);
  });

  it('T7: |distAtr| < banda neutra -> NEUTRAL, 0 punti e riga presente', () => {
    const c = calculateVwapScoreContribution(state({ state: 'ABOVE', distAtr: 0.05 }), 'LONG');
    assert.strictEqual(c.score, 0);
    assert.strictEqual(c.state, 'NEUTRAL');
    assert.ok(c.detail.startsWith('VWAP: NEUTRAL | dist 0.05 ATR | vol 2.10x | contributo 0/10'), c.detail);
  });

  it('T8: volume non confermato (< 1.5x) -> UNCONFIRMED, 0 punti e riga presente', () => {
    const c = calculateVwapScoreContribution(state({ state: 'ABOVE', volumeRatio: 1.2 }), 'LONG');
    assert.strictEqual(c.score, 0);
    assert.strictEqual(c.state, 'UNCONFIRMED');
    assert.ok(c.detail.startsWith('VWAP: UNCONFIRMED | dist 0.50 ATR | vol 1.20x | contributo 0/10'), c.detail);
  });

  it('T9: UNKNOWN -> contributo 0 e riga con il flag', () => {
    const c = calculateVwapScoreContribution(
      state({ state: 'UNKNOWN', distAtr: 1.2, flags: ['AFTER_HOURS'] }),
      'LONG'
    );
    assert.strictEqual(c.score, 0);
    assert.strictEqual(c.state, 'UNKNOWN');
    assert.strictEqual(c.detail, 'VWAP: UNKNOWN (AFTER_HOURS) | contributo 0/10');
  });

  it('T10: finestra di apertura -> contributo x VWAP_OPEN_WEIGHT_FACTOR', () => {
    const c = calculateVwapScoreContribution(
      state({ state: 'BELOW', distAtr: -0.8, flags: ['OPEN_WINDOW'] }),
      'LONG'
    );
    assert.strictEqual(c.score, -(W * TRADING_PARAMS.VWAP_OPEN_WEIGHT_FACTOR));
  });
});

describe('VWAP scoring - integrazione nel breakdown', () => {
  it('T11: candidato UNKNOWN -> contributo 0 ma riga VWAP sempre presente; total = somma componenti', () => {
    const score = calculateCandidateScore(
      baseQuote({ vwapState: state({ state: 'UNKNOWN', flags: ['AFTER_HOURS'] }) }),
      0.30,
      null
    );
    assert.strictEqual(score.vwapScore, 0);
    assert.ok(score.vwapLine?.startsWith('VWAP: UNKNOWN (AFTER_HOURS) | contributo 0/10'), score.vwapLine);
    assert.ok(score.details.includes(score.vwapLine!));

    const sum =
      score.gapScore +
      score.rvolScore +
      score.liquidityScore +
      score.futuresScore +
      score.levelScore +
      (score.rsiScore ?? 0) +
      (score.newsScore ?? 0) +
      (score.trendScore ?? 0) +
      (score.orderFlowScore ?? 0) +
      (score.vwapScore ?? 0);
    assert.strictEqual(score.rawTotal, +sum.toFixed(1));
    assert.strictEqual(score.total, Math.max(0, Math.min(100, Math.round(sum))));
  });

  it('T12: candidato ABOVE confermato -> contributo positivo visibile nel breakdown', () => {
    const score = calculateCandidateScore(
      baseQuote({ gapPercent: 1.0, vwapState: state({ state: 'ABOVE', distAtr: 0.5 }) }),
      0.30,
      null
    );
    assert.strictEqual(score.vwapScore, +5);
    assert.ok(score.vwapLine?.includes('VWAP: ABOVE'), score.vwapLine);
    assert.ok(score.details.some((d) => d.startsWith('VWAP: ABOVE | dist 0.50 ATR')));
  });

  it('T13: il call site passa la barra 5m -> dopo le 16:00 ET lo stato diventa UNKNOWN', () => {
    const afterHoursMs = Date.UTC(2026, 10, 4, 21, 30, 0); // 16:30 ET
    const ranked = rankMarketCandidates(
      [
        baseQuote({
          vwapState: state({ state: 'ABOVE', distAtr: 0.5 }),
          lastBarVolume: 900,
          lastBarTime: Math.floor(afterHoursMs / 1000),
        }),
      ],
      'US',
      0.30
    );
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].score.vwapScore, 0);
    assert.ok(
      ranked[0].score.vwapLine?.startsWith('VWAP: UNKNOWN (AFTER_HOURS)'),
      ranked[0].score.vwapLine
    );
  });

  it('T14: ranking -> ABOVE confermato batte un candidato identico con BELOW confermato', () => {
    const above = baseQuote({ ticker: 'AAA', vwapState: state({ state: 'ABOVE', distAtr: 0.8 }) });
    const below = baseQuote({ ticker: 'BBB', vwapState: state({ state: 'BELOW', distAtr: -0.8 }) });
    const ranked = rankMarketCandidates([below, above], 'US', 0.30);
    assert.strictEqual(ranked[0].quote.ticker, 'AAA');
    assert.ok((ranked[0].score.total ?? 0) > (ranked[1].score.total ?? 0));
  });
});

describe('VWAP scoring - payload e prompt AI', () => {
  it('T15: round-trip del payload contiene i sei campi vwap', () => {
    const payload = JSON.parse(
      JSON.stringify({ candidate: baseQuote({ vwapState: state() }) })
    ) as { candidate: { vwapState: Record<string, unknown> } };
    for (const key of ['state', 'distAtr', 'slopeAtr', 'coverage', 'volumeRatio', 'flags']) {
      assert.ok(key in payload.candidate.vwapState, `campo ${key} mancante nel payload`);
    }
  });

  it('T16: il prompt contiene i cinque stati e la regola sul volume', () => {
    for (const name of VWAP_STATE_NAMES) {
      assert.ok(VWAP_PROMPT_BLOCK.includes(name), `stato ${name} mancante nel prompt`);
    }
    assert.strictEqual(VWAP_STATE_NAMES.length, 5);
    assert.ok(VWAP_PROMPT_BLOCK.includes('volumeRatio >= 1.5x'), VWAP_PROMPT_BLOCK);
    assert.ok(VWAP_PROMPT_BLOCK.includes('non rifiuta mai un setup da solo'));
  });
});

console.log('ALL VWAP SCORE TESTS PASS!');
