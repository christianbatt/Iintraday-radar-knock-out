import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeSetupIndicators, loadWarmupBars, selectWarmupBars } from '../indicators';
import { isWarmupIncomplete } from '../calculator';
import { TRADING_PARAMS } from '../../config/tradingParams';
import type { IndicatorBarInput } from '../../types/radar';

const P = TRADING_PARAMS;

interface MarketSpec {
  market: 'EU' | 'US';
  tz: string;
  openMinutes: number;
  closeMinutes: number;
}

const SPECS: MarketSpec[] = [
  {
    market: 'EU',
    tz: 'Europe/Rome',
    openMinutes: P.EU_OPEN_HOUR * 60 + P.EU_OPEN_MINUTE,
    closeMinutes: P.EU_CLOSE_HOUR * 60 + P.EU_CLOSE_MINUTE,
  },
  {
    market: 'US',
    tz: 'America/New_York',
    openMinutes: P.US_OPEN_HOUR * 60 + P.US_OPEN_MINUTE,
    closeMinutes: P.US_CLOSE_HOUR * 60 + P.US_CLOSE_MINUTE,
  },
];

const tzOffsetMinutes = (tz: string, y: number, m: number, d: number): number => {
  const probe = new Date(Date.UTC(y, m, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
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

/** Barre 5m della sessione regolare del mercato, prezzi deterministici. */
const sessionBars = (spec: MarketSpec, y: number, m: number, d: number, count?: number): IndicatorBarInput[] => {
  const total = count ?? Math.floor((spec.closeMinutes - spec.openMinutes) / 5);
  const offset = tzOffsetMinutes(spec.tz, y, m, d);
  const base = Date.UTC(y, m, d) + (spec.openMinutes - offset) * 60_000;
  return Array.from({ length: total }, (_, i) => {
    const o = 100 + i * 0.05;
    return { t: base + i * 5 * 60_000, o, h: o + 0.08, l: o - 0.06, c: o + 0.02, v: 1000 + i };
  });
};

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

/**
 * Nessun look-ahead: uno scan al tempo T usa solo barre chiuse <= T e sessioni chiuse
 * prima dell'apertura corrente. Festivita' e weekend vengono saltati, mai sessioni future.
 */
describe('Warm-up senza look-ahead (EU e US)', () => {
  for (const spec of SPECS) {
    const now = new Date(sessionBars(spec, 2026, 10, 4, 2)[1].t + 60_000); // 09:05 locale del 4 novembre
    const current = sessionBars(spec, 2026, 10, 4, 2);
    const mostRecentClosed = sessionBars(spec, 2026, 10, 2); // lunedi 2 novembre, gia' chiusa
    const olderClosed = sessionBars(spec, 2026, 9, 30); // venerdi 30 ottobre
    const futureSession = sessionBars(spec, 2026, 10, 5); // giovedi 5 novembre: futura rispetto a T

    it(`${spec.market}: festivo con sessione futura nel feed -> usa la chiusa piu' recente, mai la futura`, async () => {
      const bars = [...olderClosed, ...mostRecentClosed, ...current, ...futureSession];
      const { fetcher, calls } = mockedFetcher({ [P.WARMUP_RANGE_5M]: bars });

      const warmup = await loadWarmupBars(fetcher, { market: spec.market, now });
      assert.deepStrictEqual(calls, [P.WARMUP_RANGE_5M]);
      assert.strictEqual(warmup.fallbackUsed, false);
      assert.ok(warmup.priorSessionsUsed >= 1, `sessioni precedenti ${warmup.priorSessionsUsed}`);
      assert.ok(warmup.bars.every((b) => b.t <= now.getTime()), 'barre future nella serie');
      assert.ok(
        !selectWarmupBars(bars, spec.market, { now }).sessionsUsed.includes('2026-11-05'),
        'sessione futura usata'
      );

      const ind = computeSetupIndicators(bars, { market: spec.market, now });
      assert.strictEqual(ind.supertrend.status, 'OK', `supertrend ${ind.supertrend.reason}`);
      assert.strictEqual(ind.adx.status, 'OK', `adx ${ind.adx.reason}`);
      assert.strictEqual(isWarmupIncomplete(ind), false);
      assert.ok(ind.barsUsed >= P.IND_MIN_BARS);
    });

    it(`${spec.market}: scan alle 09:05 -> nessuna barra con timestamp > 09:05`, async () => {
      const { fetcher } = mockedFetcher({
        [P.WARMUP_RANGE_5M]: [...mostRecentClosed, ...current, ...futureSession],
      });
      const warmup = await loadWarmupBars(fetcher, { market: spec.market, now });
      assert.strictEqual(warmup.completeBars, mostRecentClosed.length + 2);
      assert.ok(warmup.bars.every((b) => b.t <= current[current.length - 1].t + 60_000 - 1 + 1));

      const ind = computeSetupIndicators(warmup.bars, { market: spec.market, now });
      assert.strictEqual(ind.barsUsed, mostRecentClosed.length + 2);
      assert.strictEqual(ind.supertrend.status, 'OK');
    });

    it(`${spec.market}: solo sessioni future -> UNKNOWN INSUFFICIENT_BARS + WARMUP_INCOMPLETE`, async () => {
      const { fetcher } = mockedFetcher({
        [P.WARMUP_RANGE_5M]: futureSession,
        [P.WARMUP_RANGE_FALLBACK_5M]: futureSession,
      });
      const warmup = await loadWarmupBars(fetcher, { market: spec.market, now });
      assert.strictEqual(warmup.completeBars, 0);

      const ind = computeSetupIndicators(warmup.bars, {
        market: spec.market,
        now,
        droppedFutureBars: warmup.droppedFutureBars,
      });
      assert.strictEqual(warmup.droppedFutureBars > 0, true, 'nessuna barra futura scartata');
      assert.strictEqual(ind.barsUsed, 0);
      assert.strictEqual(ind.supertrend.status, 'UNKNOWN');
      assert.strictEqual(ind.supertrend.reason, 'INSUFFICIENT_BARS');
      assert.strictEqual(ind.adx.reason, 'INSUFFICIENT_BARS');
      assert.strictEqual(ind.atr.value, null);
      assert.strictEqual(isWarmupIncomplete(ind), true);
    });

    it(`${spec.market}: primo giorno dopo il festivo -> usa la sessione chiusa piu' recente anche se piu' vecchia`, async () => {
      const bars = [...olderClosed, ...current];
      const selection = selectWarmupBars(bars, spec.market, { now });
      assert.deepStrictEqual(selection.sessionsUsed, ['2026-10-30', '2026-11-04']);
      assert.strictEqual(selection.priorSessionsUsed, 1);

      const ind = computeSetupIndicators(bars, { market: spec.market, now });
      assert.strictEqual(ind.priorSessionsUsed, 1);
      assert.strictEqual(ind.supertrend.status, 'OK');
      assert.strictEqual(ind.adx.status, 'OK');
      assert.ok(ind.barsUsed >= P.IND_MIN_BARS);
    });
  }
});

console.log('ALL WARMUP NO-LOOKAHEAD TESTS PASS!');
