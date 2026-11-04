import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  atrSeries,
  computeAdx,
  computePsar,
  computeSetupIndicators,
  computeStochRsi,
  computeSupertrend,
  filterRegularSessionBars,
} from '../indicators';
import { TRADING_PARAMS } from '../../config/tradingParams';
import type { IndicatorBarInput, SetupIndicators } from '../../types/radar';

// Fixture generata da scripts/indicator_reference.py (implementazione Python indipendente).
const FIXTURE_PATH = path.join(process.cwd(), 'src/utils/__tests__/fixtures/indicator_reference.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as {
  bars: IndicatorBarInput[];
  expected: {
    atr: number;
    supertrend: { direction: number; barsSinceFlip: number | null; value: number };
    adx: { value: number; plusDI: number; minusDI: number };
    stochRsi: { k: number; d: number };
    psar: { value: number; direction: number; barsSinceFlip: number };
  };
};

const BARS = fixture.bars;
const EXPECTED = fixture.expected;
const LAST_TS = BARS[BARS.length - 1].t;
const NOW = new Date(LAST_TS + 60_000);
const TOL = 1e-6;

const closeTo = (actual: number | null, expected: number, label: string) => {
  assert.ok(actual != null, `${label}: valore nullo`);
  assert.ok(Math.abs((actual as number) - expected) <= TOL, `${label}: ${actual} vs ${expected}`);
};

const allUnknown = (ind: SetupIndicators, reason: string) => {
  assert.strictEqual(ind.supertrend.status, 'UNKNOWN');
  assert.strictEqual(ind.adx.status, 'UNKNOWN');
  assert.strictEqual(ind.stochRsi.status, 'UNKNOWN');
  assert.strictEqual(ind.psar.status, 'UNKNOWN');
  assert.strictEqual(ind.supertrend.reason, reason);
  assert.strictEqual(ind.adx.reason, reason);
  assert.strictEqual(ind.stochRsi.reason, reason);
  assert.strictEqual(ind.psar.reason, reason);
};

describe('Indicatori 5m - parita con riferimento Python (tolleranza 1e-6)', () => {
  it('I1: ATR(14) di Wilder coincide con il riferimento', () => {
    const atr = atrSeries(BARS, TRADING_PARAMS.ATR_PERIOD);
    closeTo(atr[atr.length - 1], EXPECTED.atr, 'ATR14');
  });

  it('I2: Supertrend(14, 3) coincide per direzione, flip e valore', () => {
    const { snapshot } = computeSupertrend(BARS, { now: NOW });
    assert.strictEqual(snapshot.status, 'OK', `reason ${snapshot.reason}`);
    assert.strictEqual(snapshot.direction, EXPECTED.supertrend.direction);
    assert.strictEqual(snapshot.barsSinceFlip, EXPECTED.supertrend.barsSinceFlip);
    closeTo(snapshot.value, EXPECTED.supertrend.value, 'Supertrend value');
  });

  it('I3: ADX(14) coincide per valore, +DI e -DI', () => {
    const { snapshot } = computeAdx(BARS, { now: NOW });
    assert.strictEqual(snapshot.status, 'OK', `reason ${snapshot.reason}`);
    closeTo(snapshot.value, EXPECTED.adx.value, 'ADX');
    closeTo(snapshot.plusDI, EXPECTED.adx.plusDI, '+DI');
    closeTo(snapshot.minusDI, EXPECTED.adx.minusDI, '-DI');
  });

  it('I4: StochRSI(14,14,3,3) coincide per %K e %D', () => {
    const { snapshot } = computeStochRsi(BARS, { now: NOW });
    assert.strictEqual(snapshot.status, 'OK', `reason ${snapshot.reason}`);
    closeTo(snapshot.k, EXPECTED.stochRsi.k, '%K');
    closeTo(snapshot.d, EXPECTED.stochRsi.d, '%D');
  });

  it('I5: PSAR(0.02, 0.02, 0.20) coincide per valore, direzione e flip', () => {
    const { snapshot } = computePsar(BARS, { now: NOW });
    assert.strictEqual(snapshot.status, 'OK', `reason ${snapshot.reason}`);
    assert.strictEqual(snapshot.direction, EXPECTED.psar.direction);
    assert.strictEqual(snapshot.barsSinceFlip, EXPECTED.psar.barsSinceFlip);
    closeTo(snapshot.value, EXPECTED.psar.value, 'PSAR');
  });
});

describe('Indicatori 5m - status, barre e sessione', () => {
  it('I6: pacchetto indicatori completo con sessione corrente + precedente', () => {
    const ind = computeSetupIndicators(BARS, { market: 'US', now: NOW });
    assert.ok(ind.barsUsed >= TRADING_PARAMS.IND_MIN_BARS, `barsUsed ${ind.barsUsed}`);
    assert.strictEqual(ind.supertrend.status, 'OK');
    assert.strictEqual(ind.adx.status, 'OK');
    assert.strictEqual(ind.stochRsi.status, 'OK');
    assert.strictEqual(ind.psar.status, 'OK');
    assert.strictEqual(ind.atr.status, 'OK');
  });

  it('I7: meno di IND_MIN_BARS barre -> UNKNOWN INSUFFICIENT_BARS (nessun valore inventato)', () => {
    const short = BARS.slice(-10);
    const ind = computeSetupIndicators(short, { market: 'US', now: new Date(short[short.length - 1].t + 60_000) });
    assert.strictEqual(ind.barsUsed, 10);
    allUnknown(ind, 'INSUFFICIENT_BARS');
    assert.strictEqual(ind.atr.value, null);
    assert.strictEqual(ind.supertrend.value, null);
    assert.strictEqual(ind.adx.value, null);
    assert.strictEqual(ind.stochRsi.k, null);
    assert.strictEqual(ind.psar.value, null);
  });

  it('I8: le barre after-market sono escluse dal calcolo', () => {
    // 17:00 ET = 22:00 UTC: fuori dalla sessione regolare US (09:30-16:00 ET)
    const afterHours: IndicatorBarInput[] = [
      { t: LAST_TS + 65 * 60_000, o: 120, h: 130, l: 119, c: 129, v: 500 },
      { t: LAST_TS + 70 * 60_000, o: 129, h: 140, l: 128, c: 139, v: 500 },
    ];
    const withAfterHours = computeSetupIndicators([...BARS, ...afterHours], { market: 'US', now: NOW });
    const clean = computeSetupIndicators(BARS, { market: 'US', now: NOW });
    assert.strictEqual(withAfterHours.barsUsed, clean.barsUsed);
    assert.deepStrictEqual(withAfterHours.supertrend, clean.supertrend);
    assert.deepStrictEqual(withAfterHours.adx, clean.adx);
  });

  it('I9: solo barre after-market -> UNKNOWN AFTER_HOURS', () => {
    const onlyAfter: IndicatorBarInput[] = Array.from({ length: 70 }, (_, i) => ({
      t: LAST_TS + (65 + i * 5) * 60_000,
      o: 120,
      h: 121,
      l: 119,
      c: 120,
      v: 400,
    }));
    const ind = computeSetupIndicators(onlyAfter, { market: 'US', now: NOW });
    assert.strictEqual(ind.barsUsed, 0);
    allUnknown(ind, 'AFTER_HOURS');
  });

  it('I10: serie ferma oltre IND_MAX_STALE_MIN -> UNKNOWN STALE', () => {
    const staleNow = new Date(LAST_TS + (TRADING_PARAMS.IND_MAX_STALE_MIN + 5) * 60_000);
    const ind = computeSetupIndicators(BARS, { market: 'US', now: staleNow });
    allUnknown(ind, 'STALE');
  });

  it('I11: warm-up alle 09:45 ET con sessione precedente -> OK; senza sessione precedente -> UNKNOWN', () => {
    // La sessione precedente inizia alla stessa ora: la sessione corrente e' la seconda occorrenza.
    const currentSessionStart = BARS.findIndex((b, i) => i > 0 && new Date(b.t).getUTCHours() === 14 && new Date(b.t).getUTCMinutes() === 30);
    assert.ok(currentSessionStart > 0, 'indice inizio sessione corrente non trovato');
    const previousSession = BARS.slice(0, currentSessionStart);
    const firstFour = BARS.slice(currentSessionStart, currentSessionStart + 4); // 09:30, 09:35, 09:40, 09:45 ET
    const at0945 = new Date(firstFour[firstFour.length - 1].t + 60_000);

    const withPrevious = computeSetupIndicators([...previousSession, ...firstFour], { market: 'US', now: at0945 });
    assert.ok(withPrevious.barsUsed >= TRADING_PARAMS.IND_MIN_BARS);
    assert.strictEqual(withPrevious.supertrend.status, 'OK');
    assert.strictEqual(withPrevious.adx.status, 'OK');
    assert.strictEqual(withPrevious.stochRsi.status, 'OK');

    const todayOnly = computeSetupIndicators(firstFour, { market: 'US', now: at0945 });
    assert.strictEqual(todayOnly.barsUsed, 4);
    allUnknown(todayOnly, 'INSUFFICIENT_BARS');
  });

  it('I12: filtro sessione regolare rimuove barre fuori orario e duplicati', () => {
    const duplicated = [...BARS, BARS[10], { ...BARS[12], t: LAST_TS + 65 * 60_000 }];
    const filtered = filterRegularSessionBars(duplicated, 'US');
    assert.strictEqual(filtered.length, BARS.length);
    const timestamps = new Set(filtered.map((b) => b.t));
    assert.strictEqual(timestamps.size, filtered.length);
  });
});

console.log('ALL INDICATORS TESTS PASS!');
