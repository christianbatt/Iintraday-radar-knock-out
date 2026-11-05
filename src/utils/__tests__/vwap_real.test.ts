/**
 * PUNTO 1 (VWAP di sessione, IPOTESI): computeSessionVwap e' il riferimento unico.
 *
 * Copre:
 * - formula ponderata per volume: (10 x 100 + 20 x 300) / 400 = 17.5;
 * - barre senza volume -> null (mai un prezzo tipico come surrogato);
 * - barre in formazione/future escluse tramite nowMinutes;
 * - filtro contrarian: senza quote.vwapCumulative non c'e' riduzione del bonus notizie,
 *   e con la cumulativa presente e' quella a decidere (quote.vwap non viene usato).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { calculateCandidateScore, computeSessionVwap } from '../calculator';
import type { VwapBar } from '../calculator';
import type { RawQuoteData } from '../../types/radar';

// 2026-11-04: US in ora solare (EST, UTC-5) -> 09:30 NY = 14:30 UTC
const DATE = '2026-11-04';
const utc = (h: number, m: number): number => Date.UTC(2026, 10, 4, h, m, 0) / 1000;
const bar = (h: number, m: number, price: number, volume: number): VwapBar => ({
  timestamp: utc(h, m),
  high: price,
  low: price,
  close: price,
  volume,
});

const tenAt0930 = bar(14, 30, 10, 100); // 09:30 NY, tp 10, vol 100
const twentyAt0935 = bar(14, 35, 20, 300); // 09:35 NY, tp 20, vol 300

const baseQuote = (over: Partial<RawQuoteData> = {}): RawQuoteData =>
  ({
    ticker: 'AAPL',
    name: 'Apple Inc.',
    market: 'US',
    currency: 'USD',
    prevClose: 100,
    currentPrice: 100,
    preMarketPrice: null,
    prevHigh: 99,
    prevLow: 95,
    preMarketHigh: null,
    preMarketLow: null,
    todayOpen: 101,
    todayHigh: 104,
    todayLow: 100,
    vwap: null,
    ema20Daily: 98,
    avgVolume20d: 5_000_000,
    preMarketVolume: 100_000,
    atr14: 2,
    gapPercent: 0.2,
    rvol: 1.6,
    rsi5m: 55,
    rsi14: 55,
    orderFlow: null,
    timestamp: new Date().toISOString(),
    source: 'test',
    ...over,
  } as RawQuoteData);

const catalystLong = () =>
  ({ direzione: 'LONG', newsBonusScore: 12 } as unknown as Parameters<typeof calculateCandidateScore>[2]);

const newsSnapshot = (q: RawQuoteData) => {
  const s = calculateCandidateScore(q, 0.3, catalystLong());
  const reducedLine = s.details.find((d) => d.includes('bonus ridotto a'));
  return {
    total: s.total,
    newsScore: s.newsScore ?? 0,
    reduced: Boolean(reducedLine),
    reducedTo: reducedLine ? Number(/bonus ridotto a (\d+)pt/.exec(reducedLine)![1]) : null,
  };
};

describe('VWAP di sessione (computeSessionVwap)', () => {
  it('T1: ponderata per volume -> 17.5', () => {
    const res = computeSessionVwap([tenAt0930, twentyAt0935], 'US', DATE);
    assert.strictEqual(res.vwap, 17.5);
    assert.strictEqual(res.cumulativeVolume, 400);
    assert.strictEqual(res.barsWithVolume, 2);
  });

  it('T2: senza volume -> vwap null (nessun prezzo tipico come fallback)', () => {
    const res = computeSessionVwap([bar(14, 30, 10, 0), bar(14, 35, 20, 0)], 'US', DATE);
    assert.strictEqual(res.vwap, null);
    assert.strictEqual(res.cumulativeVolume, 0);
    assert.strictEqual(res.barsUsed, 2);
    assert.strictEqual(res.barsWithVolume, 0);
  });

  it('T3: barre aperte o future escluse da nowMinutes', () => {
    // 10:00 NY = 14:00 UTC -> la barra 09:35 (chiusura 09:40) non e' ancora chiusa
    const before = computeSessionVwap([tenAt0930, twentyAt0935], 'US', DATE, { nowMinutes: 575 });
    assert.strictEqual(before.vwap, 10);
    assert.strictEqual(before.barsWithVolume, 1);
    const after = computeSessionVwap([tenAt0930, twentyAt0935], 'US', DATE, { nowMinutes: 580 });
    assert.strictEqual(after.vwap, 17.5);
  });
});

describe('Filtro contrarian e VWAP reale', () => {
  it('T4: vwapCumulative null -> nessuna riduzione, anche con quote.vwap che la innescherebbe', () => {
    const snap = newsSnapshot(baseQuote({ vwapCumulative: null, vwap: 101 }));
    assert.strictEqual(snap.reduced, false);
    assert.strictEqual(snap.newsScore, 8);
    assert.strictEqual(snap.total, 38);
    console.log('[vwap_real] senza VWAP:', JSON.stringify(snap));
  });

  it('T5: con vwapCumulativa presente decide lei, non quote.vwap', () => {
    // Prezzo 100 sotto la cumulativa 101 (contrarian), sopra la vecchia stima 98.
    const snap = newsSnapshot(baseQuote({ vwapCumulative: 101, vwap: 98 }));
    assert.strictEqual(snap.reduced, true);
    assert.strictEqual(snap.reducedTo, 3);
    assert.strictEqual(snap.newsScore, 2);
    console.log('[vwap_real] con VWAP cumulativa:', JSON.stringify(snap));
  });
});
