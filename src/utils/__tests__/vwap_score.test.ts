import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateCandidateScore,
  calculateVwapScoreContribution,
  computeVwapDataQuality,
  resolveVwapStateForScoring,
  formatVwapDataQualityScan,
  rankMarketCandidates,
  type VwapBar,
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
  it('T2: ABOVE con volume confermato -> W pieno (contributo mai negativo)', () => {
    const c = calculateVwapScoreContribution(state({ state: 'ABOVE', distAtr: 0.5 }), 'LONG');
    assert.strictEqual(c.score, +10);
    assert.strictEqual(c.state, 'ABOVE');
    assert.ok(c.detail.startsWith('VWAP: ABOVE | dist 0.50 ATR | vol 2.10x | contributo 10/10'), c.detail);
  });

  it('T3: ABOVE con distAtr oltre 1 ATR -> cap a +W', () => {
    const c = calculateVwapScoreContribution(state({ state: 'ABOVE', distAtr: 3.4 }), 'LONG');
    assert.strictEqual(c.score, +W);
  });

  it('T4: RECLAIM con volume confermato -> W pieno', () => {
    const c = calculateVwapScoreContribution(state({ state: 'RECLAIM', distAtr: 0.4 }), 'LONG');
    assert.strictEqual(c.score, +10);
  });

  it('T5: PULLBACK con volume confermato -> W pieno', () => {
    const c = calculateVwapScoreContribution(state({ state: 'PULLBACK', distAtr: 0.6 }), 'LONG');
    assert.strictEqual(c.score, +10);
  });

  it('T6: BELOW/REJECT con volume confermato -> 0 per long (con veto), +W per short', () => {
    const below = state({ state: 'BELOW', distAtr: -0.6 });
    const reject = state({ state: 'REJECT', distAtr: -0.4 });
    const belowLong = calculateVwapScoreContribution(below, 'LONG');
    const rejectLong = calculateVwapScoreContribution(reject, 'LONG');
    assert.strictEqual(belowLong.score, 0);
    assert.strictEqual(rejectLong.score, 0);
    assert.strictEqual(belowLong.gated, true);
    assert.strictEqual(calculateVwapScoreContribution(below, 'SHORT').score, +W);
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

  it('T10: stato contrario in finestra di apertura -> 0 punti e veto', () => {
    const c = calculateVwapScoreContribution(
      state({ state: 'BELOW', distAtr: -0.8, flags: ['OPEN_WINDOW'] }),
      'LONG'
    );
    assert.strictEqual(c.score, 0);
    assert.strictEqual(c.gated, true);
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
      (score.vwapScore ?? 0) +
      (score.supertrendScore ?? 0) +
      (score.adxScore ?? 0) +
      (score.stochRsiScore ?? 0) +
      (score.psarScore ?? 0);
    assert.strictEqual(score.rawTotal, +sum.toFixed(1));
    assert.strictEqual(score.total, Math.max(0, Math.min(100, Math.round(sum))));
  });

  it('T12: candidato ABOVE confermato -> contributo pieno visibile nel breakdown', () => {
    const score = calculateCandidateScore(
      baseQuote({ gapPercent: 1.0, vwapState: state({ state: 'ABOVE', distAtr: 0.5 }) }),
      0.30,
      null
    );
    assert.strictEqual(score.vwapScore, +10);
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
    // Volume non confermato: nessun veto, contributo 0 (il candidato resta in classifica)
    const below = baseQuote({
      ticker: 'BBB',
      vwapState: state({ state: 'BELOW', distAtr: -0.8, volumeRatio: 0.4 }),
    });
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

// ---------------------------------------------------------------------------
// Quality gate VWAP: il VWAP contribuisce solo con una serie affidabile.
// Serie 5m del 2026-11-04 (EST, UTC-5): 09:30 ET = 14:30 UTC.
// ---------------------------------------------------------------------------
const etTs = (etMinutes: number): number =>
  Math.floor(Date.UTC(2026, 10, 4, Math.floor(etMinutes / 60) + 5, etMinutes % 60, 0) / 1000);
const NOW_1000_ET = new Date(Date.UTC(2026, 10, 4, 15, 0)); // 10:00 ET
const NOW_1020_ET = new Date(Date.UTC(2026, 10, 4, 15, 20)); // 10:20 ET

const barAt = (etMinutes: number, over: Partial<VwapBar> = {}): VwapBar => ({
  timestamp: etTs(etMinutes),
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1000,
  ...over,
});

// n barre contigue da 09:30 (570) ogni 5 minuti
const series = (n: number, over: (i: number) => Partial<VwapBar> = () => ({})): VwapBar[] =>
  Array.from({ length: n }, (_, i) => barAt(570 + i * 5, over(i)));

const CLEAN_QUOTE = { currentPrice: 100, vwap: 100 };

type QualityFixture = {
  reason: string;
  bars: VwapBar[];
  quote: { currentPrice?: number | null; vwap?: number | null } | null;
  now: Date;
};

const dupBars = series(6);
dupBars[2] = { ...dupBars[2], timestamp: dupBars[1].timestamp };

const FIXTURES: QualityFixture[] = [
  { reason: 'FEED_ERROR', bars: [], quote: CLEAN_QUOTE, now: NOW_1000_ET },
  { reason: 'NON_FINITE', bars: series(6, (i) => (i === 2 ? { volume: null } : {})), quote: CLEAN_QUOTE, now: NOW_1000_ET },
  { reason: 'OHLC_INCONSISTENT', bars: series(6, (i) => (i === 1 ? { high: 98, low: 99 } : {})), quote: CLEAN_QUOTE, now: NOW_1000_ET },
  { reason: 'DUPLICATE_OR_UNSORTED', bars: dupBars, quote: CLEAN_QUOTE, now: NOW_1000_ET },
  { reason: 'GAP', bars: series(6).filter((_, i) => i !== 2), quote: CLEAN_QUOTE, now: NOW_1000_ET },
  { reason: 'ZERO_VOLUME', bars: series(6, (i) => (i === 3 ? { volume: 0 } : {})), quote: CLEAN_QUOTE, now: NOW_1000_ET },
  { reason: 'LOW_COVERAGE', bars: series(2), quote: CLEAN_QUOTE, now: NOW_1000_ET },
  { reason: 'STALE', bars: series(8), quote: CLEAN_QUOTE, now: NOW_1020_ET },
  { reason: 'OUT_OF_RANGE', bars: series(6), quote: { currentPrice: 100, vwap: 500 }, now: NOW_1000_ET },
  { reason: 'QUOTE_MISMATCH', bars: series(6), quote: { currentPrice: 110, vwap: 100 }, now: NOW_1000_ET },
];

describe('VWAP quality gate - 10 motivi (IPOTESI)', () => {
  it('T17: serie pulita -> ok=true, coverage 1, stato normale preservato', () => {
    const q = computeVwapDataQuality(series(6), CLEAN_QUOTE, 'US', NOW_1000_ET);
    assert.deepStrictEqual(q, { ok: true, reason: null, coverage: 1 });
    const resolved = resolveVwapStateForScoring(state({ state: 'ABOVE', distAtr: 0.5 }), null, 'US', q);
    assert.strictEqual(resolved?.state, 'ABOVE');
  });

  it('T18: un fixture per motivo a-j, ognuno con il proprio reason', () => {
    for (const f of FIXTURES) {
      const q = computeVwapDataQuality(f.bars, f.quote, 'US', f.now);
      assert.strictEqual(q.ok, false, `${f.reason}: atteso ok=false`);
      assert.strictEqual(q.reason, f.reason, `${f.reason}: reason errata (${q.reason})`);
    }
  });

  it('T19: FEED_ERROR anche via options.feedError (429)', () => {
    const q = computeVwapDataQuality(series(6), CLEAN_QUOTE, 'US', NOW_1000_ET, { feedError: 'HTTP 429' });
    assert.strictEqual(q.ok, false);
    assert.strictEqual(q.reason, 'FEED_ERROR');
  });

  it('T20: gate fallito -> UNKNOWN + flag DATA_QUALITY:<reason> + contributo 0', () => {
    for (const f of FIXTURES) {
      const gate = computeVwapDataQuality(f.bars, f.quote, 'US', f.now);
      const resolved = resolveVwapStateForScoring(state({ state: 'ABOVE', distAtr: 0.8 }), null, 'US', gate);
      assert.strictEqual(resolved?.state, 'UNKNOWN', `${f.reason}: stato non UNKNOWN`);
      assert.ok(resolved?.flags.includes(`DATA_QUALITY:${f.reason}`), `${f.reason}: flag assente`);

      const quote = baseQuote({
        vwapState: state({ state: 'ABOVE', distAtr: 0.8 }),
        vwapDataQuality: gate,
      });
      const breakdown = calculateCandidateScore(quote, 0.3, null);
      assert.strictEqual(breakdown.vwapScore, 0, `${f.reason}: contributo non zero`);
      assert.ok(
        (breakdown.vwapLine || '').includes(`VWAP: UNKNOWN (DATA_QUALITY:${f.reason}) | contributo 0/${W}`),
        `${f.reason}: riga breakdown inattesa -> ${breakdown.vwapLine}`
      );
    }
  });

  it('T21: un feed guasto non penalizza il setup (total = stesso setup con peso VWAP 0)', () => {
    const badQuote = baseQuote({
      vwapState: state({ state: 'ABOVE', distAtr: 0.8 }),
      vwapDataQuality: { ok: false, reason: 'STALE', coverage: 0.8 },
    });
    const orig = TRADING_PARAMS.VWAP_SCORE_WEIGHT;
    let withZeroWeight: ReturnType<typeof calculateCandidateScore>;
    try {
      (TRADING_PARAMS as unknown as { VWAP_SCORE_WEIGHT: number }).VWAP_SCORE_WEIGHT = 0;
      withZeroWeight = calculateCandidateScore(badQuote, 0.3, null);
    } finally {
      (TRADING_PARAMS as unknown as { VWAP_SCORE_WEIGHT: number }).VWAP_SCORE_WEIGHT = orig;
    }
    const bad = calculateCandidateScore(badQuote, 0.3, null);
    assert.strictEqual(bad.total, withZeroWeight!.total);
    assert.strictEqual(bad.rawTotal, withZeroWeight!.rawTotal);
    assert.ok((bad.vwapLine || '').includes('DATA_QUALITY:STALE'), bad.vwapLine);
  });

  it('T22: prompt AI contiene la regola sui dati non affidabili', () => {
    assert.ok(VWAP_PROMPT_BLOCK.includes('VWAP non affidabile'), VWAP_PROMPT_BLOCK);
    assert.ok(VWAP_PROMPT_BLOCK.includes('DATA_QUALITY:STALE'));
  });

  it('T23: riga di log per scansione con conteggio per esito', () => {
    const line = formatVwapDataQualityScan('US', [
      { vwapDataQuality: { ok: true, reason: null, coverage: 1 } },
      { vwapDataQuality: { ok: false, reason: 'STALE', coverage: 0.8 } },
      { vwapDataQuality: { ok: false, reason: 'FEED_ERROR', coverage: 0 } },
    ]);
    assert.ok(line.includes('[VWAP quality] scan US: 3 candidati'), line);
    assert.ok(line.includes('ok=1'), line);
    assert.ok(line.includes('DATA_QUALITY:STALE=1'), line);
    assert.ok(line.includes('DATA_QUALITY:FEED_ERROR=1'), line);
  });
});

console.log('ALL VWAP SCORE TESTS PASS!');
