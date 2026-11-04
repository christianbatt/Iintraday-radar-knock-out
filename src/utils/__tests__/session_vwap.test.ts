import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeSessionVwap, VwapBar } from '../calculator';

// 2026-11-04: US in ora solare (EST, UTC-5) -> 09:30 NY = 14:30 UTC
// 2026-11-04: Roma in CET (UTC+1) -> 09:00 Roma = 08:00 UTC
const DATE = '2026-11-04';

const utc = (h: number, m: number): number => Date.UTC(2026, 10, 4, h, m, 0) / 1000;

const bar = (
  h: number,
  m: number,
  high: number | null,
  low: number | null,
  close: number | null,
  volume: number | null
): VwapBar => ({ timestamp: utc(h, m), high, low, close, volume });

// Barre base US: pre-market 08:00 NY, 09:30 NY, 09:35 NY
const usBars: VwapBar[] = [
  bar(13, 0, 50, 50, 50, 9000), // 08:00 NY
  bar(14, 30, 101, 99, 100, 1000), // 09:30 NY
  bar(14, 35, 103, 101, 102, 3000), // 09:35 NY
];

describe('computeSessionVwap - US regolare', () => {
  it('T1: esclude il pre-market e calcola 101.5 su 2 barre', () => {
    const res = computeSessionVwap(usBars, 'US', DATE);
    assert.strictEqual(res.vwap, 101.5);
    assert.strictEqual(res.barsUsed, 2);
    assert.strictEqual(res.barsWithVolume, 2);
    assert.strictEqual(res.cumulativeVolume, 4000);
  });

  it('T2: con pre-market include la barra 08:00 NY (856000 / 13000)', () => {
    const res = computeSessionVwap(usBars, 'US', DATE, { includePreMarket: true });
    assert.ok(res.vwap !== null);
    assert.ok(Math.abs(res.vwap - 856000 / 13000) < 1e-9, `vwap atteso 856000/13000, ottenuto ${res.vwap}`);
    assert.strictEqual(res.barsUsed, 3);
    assert.strictEqual(res.cumulativeVolume, 13000);
  });
});

describe('computeSessionVwap - filtri barre', () => {
  it('T3: barra con volume 0 entra in barsUsed ma non cambia il vwap', () => {
    const res = computeSessionVwap([...usBars, bar(14, 40, 110, 108, 109, 0)], 'US', DATE);
    assert.strictEqual(res.barsUsed, 3);
    assert.strictEqual(res.barsWithVolume, 2);
    assert.strictEqual(res.vwap, 101.5);
    assert.strictEqual(res.cumulativeVolume, 4000);
  });

  it('T4: barra alle 16:00 NY esclusa (fine finestra esclusa)', () => {
    const res = computeSessionVwap([...usBars, bar(21, 0, 200, 190, 195, 5000)], 'US', DATE);
    assert.strictEqual(res.barsUsed, 2);
    assert.strictEqual(res.vwap, 101.5);
    const withPre = computeSessionVwap([...usBars, bar(21, 0, 200, 190, 195, 5000)], 'US', DATE, {
      includePreMarket: true,
    });
    assert.strictEqual(withPre.barsUsed, 3);
    assert.ok(Math.abs((withPre.vwap as number) - 856000 / 13000) < 1e-9);
  });
});

describe('computeSessionVwap - EU', () => {
  it('T5: 08:55 Roma esclusa, 09:00 Roma inclusa, 17:30 Roma esclusa', () => {
    const bars: VwapBar[] = [
      bar(7, 55, 100, 100, 100, 500), // 08:55 Roma -> fuori
      bar(8, 0, 101, 99, 100, 100), // 09:00 Roma -> inclusa
      bar(16, 30, 120, 110, 115, 700), // 17:30 Roma -> fuori
    ];
    const res = computeSessionVwap(bars, 'EU', DATE);
    assert.strictEqual(res.barsUsed, 1);
    assert.strictEqual(res.barsWithVolume, 1);
    assert.strictEqual(res.vwap, 100);
    assert.strictEqual(res.cumulativeVolume, 100);
  });

  it('T5b: includePreMarket ignorato per EU', () => {
    const bars: VwapBar[] = [bar(7, 55, 100, 100, 100, 500), bar(8, 0, 101, 99, 100, 100)];
    const res = computeSessionVwap(bars, 'EU', DATE, { includePreMarket: true });
    assert.strictEqual(res.barsUsed, 1);
    assert.strictEqual(res.vwap, 100);
  });
});

describe('computeSessionVwap - casi limite', () => {
  it('T6: nessuna barra utile -> vwap e coverage null', () => {
    const res = computeSessionVwap([], 'US', DATE, { nowMinutes: 570 });
    assert.strictEqual(res.vwap, null);
    assert.strictEqual(res.coverage, null);
    assert.strictEqual(res.barsUsed, 0);
    assert.strictEqual(res.barsWithVolume, 0);
    assert.strictEqual(res.cumulativeVolume, 0);
  });

  it('T7: coverage con nowMinutes 600 (10:00 NY) = 2/6', () => {
    const res = computeSessionVwap(usBars, 'US', DATE, { nowMinutes: 600 });
    assert.ok(res.coverage !== null);
    assert.ok(Math.abs(res.coverage - 2 / 6) < 1e-9, `coverage atteso 2/6, ottenuto ${res.coverage}`);
    assert.strictEqual(res.barsWithVolume, 2);
  });
});

console.log('ALL SESSION VWAP TESTS PASS!');
