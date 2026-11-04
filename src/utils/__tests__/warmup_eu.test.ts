import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeSetupIndicators, loadWarmupBars, selectWarmupBars } from '../indicators';
import { calculateCandidateScore, getDualTopCandidates, isWarmupIncomplete } from '../calculator';
import { TRADING_PARAMS } from '../../config/tradingParams';
import type { IndicatorBarInput, RawQuoteData } from '../../types/radar';

const P = TRADING_PARAMS;

const TZ = 'Europe/Rome';
const OPEN_MINUTES = P.EU_OPEN_HOUR * 60 + P.EU_OPEN_MINUTE; // 09:00 Europe/Rome
const CLOSE_MINUTES = P.EU_CLOSE_HOUR * 60 + P.EU_CLOSE_MINUTE; // 17:30 Europe/Rome
const SESSION_BARS = Math.floor((CLOSE_MINUTES - OPEN_MINUTES) / 5); // 102 barre da 5m

/** Offset del fuso (minuti) per una data locale: gestisce CET/CEST senza hardcode. */
const tzOffsetMinutes = (y: number, m: number, d: number): number => {
  const probe = new Date(Date.UTC(y, m, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(probe);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - probe.getTime()) / 60_000);
};

/** Barre 5m regolari EU (09:00-17:30 Rome) per una data locale, prezzi deterministici. */
const sessionBars = (y: number, m: number, d: number, count = SESSION_BARS): IndicatorBarInput[] => {
  const offset = tzOffsetMinutes(y, m, d);
  const base = Date.UTC(y, m, d) + (OPEN_MINUTES - offset) * 60_000;
  return Array.from({ length: count }, (_, i) => {
    const o = 100 + i * 0.05;
    return { t: base + i * 5 * 60_000, o, h: o + 0.08, l: o - 0.06, c: o + 0.02, v: 1000 + i };
  });
};

/** Mock della risposta Yahoo: nessuna rete, range non previsto = errore esplicito. */
const mockedFetcher = (ranges: Record<string, IndicatorBarInput[]>) => {
  const calls: string[] = [];
  const fetcher = async (range: string): Promise<IndicatorBarInput[]> => {
    calls.push(range);
    const bars = ranges[range];
    if (!bars) throw new Error(`range non mockato: ${range}`);
    return bars;
  };
  return { fetcher, calls };
};

const baseQuote = (indicators: ReturnType<typeof computeSetupIndicators>): RawQuoteData => ({
  ticker: 'EU1',
  name: 'Euro Test',
  market: 'EU',
  currency: 'EUR',
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
  gapPercent: 1,
  rvol: 2.5,
  rsi5m: 55,
  rsi14: 55,
  setupIndicators: indicators,
  vwapState: {
    state: 'ABOVE',
    distAtr: 0.5,
    slopeAtr: 0.2,
    coverage: 1,
    volumeRatio: 2.1,
    flags: [],
    vwapLevel: 102,
  },
  timestamp: new Date(Date.UTC(2026, 10, 4, 8, 6)).toISOString(),
  source: 'test',
});

describe('Warm-up EU: indicatori dall apertura (IPOTESI)', () => {
  const previousSession = sessionBars(2026, 10, 2); // lunedi 2 novembre 2026
  const currentSession = sessionBars(2026, 10, 4, 2); // mercoledi 4 novembre, 09:00 e 09:05 Rome
  const now0906 = new Date(currentSession[currentSession.length - 1].t + 60_000);

  it('W1: EU con sessione precedente completa -> indicatori OK alle 09:05 Rome', async () => {
    const { fetcher, calls } = mockedFetcher({ [P.WARMUP_RANGE_5M]: [...previousSession, ...currentSession] });
    const warmup = await loadWarmupBars(fetcher, { market: 'EU' });

    assert.strictEqual(warmup.rangeUsed, P.WARMUP_RANGE_5M);
    assert.strictEqual(warmup.fallbackUsed, false);
    assert.strictEqual(warmup.priorSessionsUsed, 1);
    assert.strictEqual(warmup.completeBars, SESSION_BARS + 2); // 102 + 2 = 104 barre complete
    assert.deepStrictEqual(calls, [P.WARMUP_RANGE_5M]);

    const ind = computeSetupIndicators(warmup.bars, {
      market: 'EU',
      now: now0906,
      rangeUsed: warmup.rangeUsed,
      priorSessionsUsed: warmup.priorSessionsUsed,
    });
    assert.strictEqual(ind.barsUsed, SESSION_BARS + 2);
    assert.strictEqual(ind.rangeUsed, P.WARMUP_RANGE_5M);
    assert.strictEqual(ind.priorSessionsUsed, 1);
    assert.strictEqual(ind.supertrend.status, 'OK', `supertrend ${ind.supertrend.reason}`);
    assert.strictEqual(ind.adx.status, 'OK', `adx ${ind.adx.reason}`);
    assert.strictEqual(ind.stochRsi.status, 'OK', `stochRsi ${ind.stochRsi.reason}`);
    assert.strictEqual(ind.psar.status, 'OK', `psar ${ind.psar.reason}`);
    assert.strictEqual(isWarmupIncomplete(ind), false);
  });

  it('W2: EU senza sessione precedente -> UNKNOWN, WARMUP_INCOMPLETE, nessun veto ne rinormalizzazione', async () => {
    const { fetcher, calls } = mockedFetcher({
      [P.WARMUP_RANGE_5M]: currentSession,
      [P.WARMUP_RANGE_FALLBACK_5M]: currentSession,
    });
    const warmup = await loadWarmupBars(fetcher, { market: 'EU' });

    assert.strictEqual(warmup.fallbackUsed, true);
    assert.strictEqual(warmup.rangeUsed, P.WARMUP_RANGE_FALLBACK_5M);
    assert.deepStrictEqual(calls, [P.WARMUP_RANGE_5M, P.WARMUP_RANGE_FALLBACK_5M]);
    assert.strictEqual(warmup.completeBars, 2);

    const ind = computeSetupIndicators(warmup.bars, { market: 'EU', now: now0906 });
    assert.strictEqual(ind.barsUsed, 2);
    assert.strictEqual(ind.supertrend.status, 'UNKNOWN');
    assert.strictEqual(ind.supertrend.reason, 'INSUFFICIENT_BARS');
    assert.strictEqual(ind.adx.status, 'UNKNOWN');
    assert.strictEqual(ind.stochRsi.status, 'UNKNOWN');
    assert.strictEqual(isWarmupIncomplete(ind), true);

    const score = calculateCandidateScore(baseQuote(ind), 0.5, null);
    assert.strictEqual(score.veto, null);
    assert.strictEqual(score.warmupIncomplete, true);
    const missing = P.W_SUPERTREND + P.W_ADX + P.W_STOCH_RSI;
    assert.ok(score.total <= 100 - missing, `score ${score.total} rinormalizzato?`);
    const sumBreakdown = Object.values(score.scoreBreakdown ?? {}).reduce((a, b) => a + b, 0);
    assert.strictEqual(sumBreakdown, score.total);

    const top = getDualTopCandidates([baseQuote(ind)], 0.5);
    assert.strictEqual(top.rankedEU.length, 1);
    assert.strictEqual(top.topEU, null);
  });

  it('W3: EU con festivo (sessione precedente mancante) -> usa la sessione disponibile precedente', () => {
    // 30 ottobre e 2 novembre presenti, 3 novembre festivo: nessuna barra inventata.
    const bars = [...sessionBars(2026, 9, 30), ...previousSession, ...currentSession];
    const selection = selectWarmupBars(bars, 'EU');
    assert.deepStrictEqual(selection.sessionsUsed, ['2026-10-30', '2026-11-02', '2026-11-04']);
    assert.strictEqual(selection.priorSessionsUsed, 2);
    assert.deepStrictEqual(
      selection.bars.map((b) => b.t),
      bars.map((b) => b.t)
    );

    const ind = computeSetupIndicators(bars, { market: 'EU', now: now0906 });
    assert.strictEqual(ind.priorSessionsUsed, 2);
    assert.strictEqual(ind.supertrend.status, 'OK');
    assert.strictEqual(ind.adx.status, 'OK');
  });

  it('W4: barre insufficienti anche dopo il fallback -> UNKNOWN INSUFFICIENT_BARS, nessuna imputazione', async () => {
    const short = sessionBars(2026, 10, 4, 10);
    const { fetcher } = mockedFetcher({
      [P.WARMUP_RANGE_5M]: short,
      [P.WARMUP_RANGE_FALLBACK_5M]: short,
    });
    const warmup = await loadWarmupBars(fetcher, { market: 'EU' });
    assert.strictEqual(warmup.completeBars, 10);
    assert.ok(warmup.completeBars < P.IND_MIN_BARS);

    const ind = computeSetupIndicators(warmup.bars, { market: 'EU', now: now0906 });
    assert.strictEqual(ind.barsUsed, 10);
    assert.strictEqual(ind.supertrend.status, 'UNKNOWN');
    assert.strictEqual(ind.supertrend.reason, 'INSUFFICIENT_BARS');
    assert.strictEqual(ind.adx.reason, 'INSUFFICIENT_BARS');
    assert.strictEqual(ind.stochRsi.reason, 'INSUFFICIENT_BARS');
    assert.strictEqual(ind.atr.value, null);
  });
});

console.log('ALL WARMUP EU TESTS PASS!');
