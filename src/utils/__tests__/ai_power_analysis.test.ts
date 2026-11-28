/**
 * Potenza statistica (Fase 5.1) e intervallo bootstrap della media (5.2).
 *
 * I valori attesi sono calcolati a mano dalla formula classica
 * n = (z_{1-α/2} + z_power)² · σ² / δ², non copiati dall'implementazione.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_POWER_TARGET_EFFECT_R,
  formatPowerLine,
  normalQuantile,
  requiredSampleSize,
  sampleVariance,
} from '../../server/aiPowerAnalysis';
import { bootstrapMeanInterval } from '../../server/aiMeanInterval';

describe('quantili normali', () => {
  it('riproduce i valori noti', () => {
    assert.ok(Math.abs(normalQuantile(0.975) - 1.959964) < 1e-4);
    assert.ok(Math.abs(normalQuantile(0.8) - 0.841621) < 1e-4);
    assert.ok(Math.abs(normalQuantile(0.5)) < 1e-9);
  });

  it('fuori da (0,1) restituisce NaN', () => {
    assert.ok(Number.isNaN(normalQuantile(0)));
    assert.ok(Number.isNaN(normalQuantile(1)));
  });
});

describe('campione richiesto', () => {
  it('effetto 0,2 R con varianza 1 richiede 197 trade', () => {
    const estimate = requiredSampleSize({ varianceR: 1, effectR: 0.2 });
    assert.equal(estimate?.n, 197);
    assert.equal(estimate?.alpha, 0.05);
    assert.equal(estimate?.power, 0.8);
  });

  it('a effetto 0,1 R servono 785 trade: è il numero che conta per il desk', () => {
    const estimate = requiredSampleSize({ varianceR: 1, effectR: AI_POWER_TARGET_EFFECT_R });
    assert.equal(estimate?.n, 785);
  });

  it('quadruplicare la varianza quadruplica il campione', () => {
    const base = requiredSampleSize({ varianceR: 1, effectR: 0.2, })!.n;
    const quattro = requiredSampleSize({ varianceR: 4, effectR: 0.2 })!.n;
    const ratio = quattro / base;
    assert.ok(ratio > 3.9 && ratio < 4.1, `rapporto inatteso: ${ratio}`);
  });

  it('più potenza richiesta, più campione', () => {
    const p80 = requiredSampleSize({ varianceR: 1, effectR: 0.2, power: 0.8 })!.n;
    const p90 = requiredSampleSize({ varianceR: 1, effectR: 0.2, power: 0.9 })!.n;
    assert.ok(p90 > p80);
  });

  it('un input che non permette una stima restituisce null, mai un numero finto', () => {
    assert.equal(requiredSampleSize({ varianceR: 1, effectR: 0 }), null);
    assert.equal(requiredSampleSize({ varianceR: 0, effectR: 0.2 }), null);
    assert.equal(requiredSampleSize({ varianceR: -1, effectR: 0.2 }), null);
    assert.equal(requiredSampleSize({ varianceR: Number.NaN, effectR: 0.2 }), null);
    assert.equal(requiredSampleSize({ varianceR: 1, effectR: 0.2, alpha: 1 }), null);
    assert.equal(requiredSampleSize({ varianceR: 1, effectR: 0.2, power: 1 }), null);
  });
});

describe('varianza campionaria', () => {
  it('usa n-1 e ignora i non finiti', () => {
    assert.equal(sampleVariance([1, 3]), 2);
    assert.equal(sampleVariance([1, 1, 1, Number.NaN]), 0);
    assert.equal(sampleVariance([1]), null);
    assert.equal(sampleVariance([]), null);
  });
});

describe('riga per l’utente', () => {
  it('dice quanti mancano', () => {
    const line = formatPowerLine({ requiredN: 785, observedN: 10, effectR: 0.1 });
    assert.ok(line.includes('servono 785 trade'));
    assert.ok(line.includes('ne hai 10'));
    assert.ok(line.includes('mancano 775 trade'));
  });

  it('dichiara quando il campione basta', () => {
    const line = formatPowerLine({ requiredN: 785, observedN: 800, effectR: 0.1 });
    assert.ok(line.includes('campione sufficiente'));
  });

  it('senza stima non inventa un numero', () => {
    const line = formatPowerLine({ requiredN: null, observedN: 3, effectR: 0.1 });
    assert.ok(line.includes('Campione troppo piccolo'));
    assert.equal(line.includes('servono'), false);
  });
});

describe('intervallo bootstrap della media', () => {
  it('su valori costanti l’intervallo è un punto', () => {
    const interval = bootstrapMeanInterval([0.5, 0.5, 0.5, 0.5]);
    assert.equal(interval?.lower, 0.5);
    assert.equal(interval?.upper, 0.5);
    assert.equal(interval?.mean, 0.5);
    assert.equal(interval?.n, 4);
  });

  it('è deterministico: stessa seed, stesso risultato', () => {
    const values = [1, -1, 0.5, 2, -0.3, 0.8, -1, 0.2];
    assert.deepEqual(bootstrapMeanInterval(values), bootstrapMeanInterval(values));
  });

  it('un solo valore non produce un intervallo', () => {
    assert.equal(bootstrapMeanInterval([1]), null);
    assert.equal(bootstrapMeanInterval([]), null);
  });

  it('più varianza, intervallo più largo', () => {
    const base = [0.1, -0.1, 0.1, -0.1, 0.1, -0.1, 0.1, -0.1];
    const spread = [1, -1, 1, -1, 1, -1, 1, -1];
    const narrow = bootstrapMeanInterval(base)!;
    const wide = bootstrapMeanInterval(spread)!;
    assert.ok(wide.upper - wide.lower > narrow.upper - narrow.lower);
  });

  it('include la media osservata come valore centrale dichiarato', () => {
    const interval = bootstrapMeanInterval([0.2, 0.4, 0.6]);
    assert.equal(interval?.mean, 0.4);
    assert.ok(interval!.lower <= interval!.mean && interval!.mean <= interval!.upper);
  });
});
