/**
 * Test di calibrazione delle soglie di freschezza e volume per mercato (EU vs US).
 *
 * Verifica che:
 * - Le soglie siano differenziate per mercato (EU tollera il ritardo contrattuale di 15 min delle borse europee);
 * - Una serie a 18 minuti in EU (ritardo di 15 min del feed gratuito) non venga considerata STALE;
 * - Una serie a 18 minuti in US (mercato real-time) venga considerata STALE;
 * - Il VWAP Quality Gate tolleri fino a 2 barre con volume 0 in EU e 0 in USA;
 * - Non venga inventato alcun dato: vengono usati esclusivamente i prezzi reali.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  TRADING_PARAMS,
  indMaxStaleMin,
  vwapMaxStaleMin,
  vwapMaxZeroVolumeBars,
} from '../../config/tradingParams';
import { computeSetupIndicators } from '../indicators';
import { computeVwapDataQuality } from '../calculator';
import fixture from './fixtures/indicator_reference.json';

const BARS = fixture.bars;
const LAST_TS = BARS[BARS.length - 1].t;

describe('Soglie di freschezza differenziate per mercato (EU vs US)', () => {
  it('T1: helper indMaxStaleMin restituisce 25 per EU e 15 per US', () => {
    assert.strictEqual(indMaxStaleMin('EU'), 25);
    assert.strictEqual(indMaxStaleMin('US'), 15);
  });

  it('T2: helper vwapMaxStaleMin restituisce 25 per EU e 10 per US', () => {
    assert.strictEqual(vwapMaxStaleMin('EU'), 25);
    assert.strictEqual(vwapMaxStaleMin('US'), 10);
  });

  it('T3: helper vwapMaxZeroVolumeBars restituisce 2 per EU e 0 per US', () => {
    assert.strictEqual(vwapMaxZeroVolumeBars('EU'), 2);
    assert.strictEqual(vwapMaxZeroVolumeBars('US'), 0);
  });

  it('T4: serie a 18 minuti (ritardo ufficiale 15 min feed gratuito EU) -> OK (non STALE in EU)', () => {
    // 18 minuti dopo l'ultima barra
    const now18m = new Date(LAST_TS + 18 * 60_000);

    const indEU = computeSetupIndicators(BARS, {
      market: 'EU',
      now: now18m,
    });

    // In EU la tolleranza e' 25 min -> a 18 min la serie e' valida, non STALE
    assert.notStrictEqual(indEU.supertrend.reason, 'STALE');
    assert.notStrictEqual(indEU.adx.reason, 'STALE');
    assert.notStrictEqual(indEU.stochRsi.reason, 'STALE');
  });

  it('T5: serie a 18 minuti in US (mercato real-time BATS) -> STALE', () => {
    // 18 minuti dopo l'ultima barra
    const now18m = new Date(LAST_TS + 18 * 60_000);

    const indUS = computeSetupIndicators(BARS, {
      market: 'US',
      now: now18m,
    });

    // In US la tolleranza e' 15 min -> a 18 min la serie e' considerata STALE
    assert.strictEqual(indUS.supertrend.status, 'UNKNOWN');
    assert.strictEqual(indUS.supertrend.reason, 'STALE');
    assert.strictEqual(indUS.adx.status, 'UNKNOWN');
    assert.strictEqual(indUS.adx.reason, 'STALE');
  });

  it('T6: VWAP Quality Gate tollera fino a 2 barre a volume 0 in EU e 0 in USA', () => {
    // 2026-11-04: US in EST (UTC-5) -> 09:30 NY = 14:30 UTC. Alle 10:00 NY = 14:00 UTC ci sono 6 barre attese (09:30..09:55)
    const baseUtc = Date.UTC(2026, 10, 4, 14, 30, 0) / 1000;
    const makeSeries = (zeroCount: number) => [
      { timestamp: baseUtc, high: 101, low: 99, close: 100, volume: zeroCount >= 1 ? 0 : 5000 },
      { timestamp: baseUtc + 300, high: 102, low: 100, close: 101, volume: zeroCount >= 2 ? 0 : 6000 },
      { timestamp: baseUtc + 600, high: 103, low: 101, close: 102, volume: zeroCount >= 3 ? 0 : 7000 },
      { timestamp: baseUtc + 900, high: 104, low: 102, close: 103, volume: 8000 },
      { timestamp: baseUtc + 1200, high: 105, low: 103, close: 104, volume: 9000 },
      { timestamp: baseUtc + 1500, high: 106, low: 104, close: 105, volume: 10000 },
    ];

    const evalTimeUS = new Date(Date.UTC(2026, 10, 4, 15, 0, 0)); // 10:00 NY

    // 1 barra a zero volume in US: rigettata (ZERO_VOLUME)
    const qUS1 = computeVwapDataQuality(makeSeries(1), { currentPrice: 105, vwap: 103 }, 'US', evalTimeUS);
    assert.strictEqual(qUS1.reason, 'ZERO_VOLUME');

    // Serie EU alle 09:30 Rome (08:30 UTC): 6 barre (09:00..09:25)
    const baseUtcEU = Date.UTC(2026, 10, 4, 8, 0, 0) / 1000;
    const makeSeriesEU = (zeroCount: number) => [
      { timestamp: baseUtcEU, high: 101, low: 99, close: 100, volume: zeroCount >= 1 ? 0 : 5000 },
      { timestamp: baseUtcEU + 300, high: 102, low: 100, close: 101, volume: zeroCount >= 2 ? 0 : 6000 },
      { timestamp: baseUtcEU + 600, high: 103, low: 101, close: 102, volume: zeroCount >= 3 ? 0 : 7000 },
      { timestamp: baseUtcEU + 900, high: 104, low: 102, close: 103, volume: 8000 },
      { timestamp: baseUtcEU + 1200, high: 105, low: 103, close: 104, volume: 9000 },
      { timestamp: baseUtcEU + 1500, high: 106, low: 104, close: 105, volume: 10000 },
    ];
    const evalTimeEU = new Date(Date.UTC(2026, 10, 4, 8, 30, 0)); // 09:30 Rome

    // 1 barra a zero volume in EU: tollerata (non e' ZERO_VOLUME)
    const qEU1 = computeVwapDataQuality(makeSeriesEU(1), { currentPrice: 105, vwap: 103 }, 'EU', evalTimeEU);
    assert.notStrictEqual(qEU1.reason, 'ZERO_VOLUME');

    // 2 barre a zero volume in EU: ancora tollerate (max 2)
    const qEU2 = computeVwapDataQuality(makeSeriesEU(2), { currentPrice: 105, vwap: 103 }, 'EU', evalTimeEU);
    assert.notStrictEqual(qEU2.reason, 'ZERO_VOLUME');

    // 3 barre a zero volume in EU: oltre la soglia 2 -> rigettata (ZERO_VOLUME)
    const qEU3 = computeVwapDataQuality(makeSeriesEU(3), { currentPrice: 105, vwap: 103 }, 'EU', evalTimeEU);
    assert.strictEqual(qEU3.reason, 'ZERO_VOLUME');
  });
});
