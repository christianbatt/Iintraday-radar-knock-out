/**
 * FASE 6.1 — costo per riga.
 *
 * I test verificano tre cose che devono restare vere:
 * 1. senza dati di prezzo il costo e' ESATTAMENTE quello dichiarato di prima
 *    (0,36 R), quindi nessuna riga storica diventa piu' conveniente per omissione;
 * 2. con barre e stop il costo usa lo spread stimato (Corwin-Schultz / stopPct);
 * 3. con la leva il termine del certificato KO si aggiunge e la fonte lo dichiara.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_TRADE_COST_DECLARED_R,
  AI_TRADE_COST_FEE_R,
  AI_TRADE_COST_SPREAD_CEILING_R,
  AI_TRADE_COST_TOTAL_CEILING_R,
  resolveTradeCost,
} from '../../server/aiTradeCost';
import { corwinSchultzSpreadProxy } from '../../knowledge/shadowAlgorithms';
import { SHADOW_V2_HYPOTHESES } from '../../knowledge/shadowV2';

const BAR_A = { t: 1_000_000, o: 100, h: 101, l: 99, c: 100.5, v: 1000 };
const BAR_B = { t: 1_000_000 + 5 * 60_000, o: 100.5, h: 100.8, l: 99.4, c: 100.2, v: 900 };

function csOfBars(): number {
  const value = corwinSchultzSpreadProxy([BAR_A, BAR_B]).at(-1);
  assert.ok(typeof value === 'number' && Number.isFinite(value), 'Corwin-Schultz calcolabile');
  return value as number;
}

describe('aiTradeCost — costo dichiarato quando mancano i dati', () => {
  it('nessun prezzo: costo identico al modello costante', () => {
    const cost = resolveTradeCost({});
    assert.equal(cost.costSource, 'declared_ceiling');
    assert.equal(cost.costR, AI_TRADE_COST_DECLARED_R);
    assert.equal(cost.costR, 0.36, 'fee 0.20 + tetto spread 0.16');
    assert.equal(cost.feeR, AI_TRADE_COST_FEE_R);
    assert.equal(cost.spreadR, AI_TRADE_COST_SPREAD_CEILING_R);
    assert.equal(cost.estimatedSpread, false);
  });

  it('stop uguale all ingresso o valori non validi: si torna al costo dichiarato', () => {
    for (const input of [
      { entry: 100, stop: 100 },
      { entry: 100, stop: Number.NaN },
      { entry: -5, stop: 3 },
      { entry: null, stop: 10 },
    ]) {
      const cost = resolveTradeCost(input);
      assert.equal(cost.costSource, 'declared_ceiling', JSON.stringify(input));
      assert.equal(cost.costR, AI_TRADE_COST_DECLARED_R, JSON.stringify(input));
    }
  });

  it('prezzo presente ma barre assenti: sottostante al tetto, fonte dichiarata', () => {
    const cost = resolveTradeCost({ entry: 100, stop: 98 });
    assert.equal(cost.costSource, 'declared_ceiling', 'senza barre e senza leva resta il modello costante');
    assert.equal(cost.costR, 0.36);
    assert.equal(cost.stopPct, 0.02);
  });
});

describe('aiTradeCost — spread misurato sulle barre', () => {
  it('spread sottostante = Corwin-Schultz / stopPct', () => {
    const cs = csOfBars();
    const cost = resolveTradeCost({ entry: 100, stop: 99, bars: [BAR_A, BAR_B] });
    assert.equal(cost.costSource, 'per_row_cs');
    assert.equal(cost.estimatedSpread, true);
    const expectedSpread = Math.min(cs / 0.01, AI_TRADE_COST_SPREAD_CEILING_R);
    assert.equal(cost.underlyingSpreadR, AI_TRADE_COST_SPREAD_CEILING_R, 'stop 1%: tetto');
    assert.ok(
      Math.abs(cost.spreadR - expectedSpread) < 1e-6,
      `spread ${cost.spreadR} atteso ${expectedSpread}`
    );
    assert.ok(Math.abs(cost.costR - (AI_TRADE_COST_FEE_R + expectedSpread)) < 1e-6);
  });

  it('stop al 10%: costo calcolato a mano (0,20 + 0,0106348/0,10)', () => {
    const cost = resolveTradeCost({ entry: 100, stop: 90, bars: [BAR_A, BAR_B] });
    assert.equal(cost.stopPct, 0.1);
    assert.equal(cost.underlyingSpreadR, 0.1063);
    assert.equal(cost.costR, 0.3063);
  });

  it('stop larghissimo: lo spread stimato non e un numero arbitrario, resta al tetto', () => {
    const cost = resolveTradeCost({ entry: 100, stop: 99.99, bars: [BAR_A, BAR_B] });
    assert.equal(cost.underlyingSpreadR, AI_TRADE_COST_SPREAD_CEILING_R);
    assert.equal(cost.costR, 0.36);
  });

  it('barre non consecutive: nessuna stima, si usa il tetto', () => {
    const farBar = { ...BAR_B, t: BAR_B.t + 24 * 60 * 60 * 1000 };
    const cost = resolveTradeCost({ entry: 100, stop: 99, bars: [BAR_A, farBar] });
    assert.equal(cost.estimatedSpread, false);
    assert.equal(cost.underlyingSpreadR, AI_TRADE_COST_SPREAD_CEILING_R);
    assert.equal(cost.costSource, 'declared_ceiling');
  });
});

describe('aiTradeCost — il termine che scala con la leva', () => {
  it('leva nota: spread certificato = 2 x 0.2% / (leva x stopPct)', () => {
    const cost = resolveTradeCost({ entry: 100, stop: 99, bars: [BAR_A, BAR_B], leverage: 10 });
    assert.equal(cost.costSource, 'per_row_cs_leverage');
    assert.equal(cost.leverage, 10);
    const expectedCert =
      (2 * SHADOW_V2_HYPOTHESES.KO_SPREAD_CERT_PCT_PER_SIDE) / (10 * 0.01);
    assert.ok(Math.abs(cost.certSpreadR - expectedCert) < 1e-6, `cert ${cost.certSpreadR}`);
    assert.ok(
      Math.abs(
        cost.costR -
          (AI_TRADE_COST_FEE_R +
            Math.min(cost.underlyingSpreadR + expectedCert, AI_TRADE_COST_TOTAL_CEILING_R))
      ) < 1e-6
    );
  });

  it('piu leva, meno spread certificato: il costo per riga scende', () => {
    const low = resolveTradeCost({ entry: 100, stop: 99, bars: [BAR_A, BAR_B], leverage: 5 });
    const high = resolveTradeCost({ entry: 100, stop: 99, bars: [BAR_A, BAR_B], leverage: 25 });
    assert.ok(low.certSpreadR > high.certSpreadR);
    assert.ok(low.costR >= high.costR, 'la leva alta non puo costare piu della bassa sul certificato');
  });

  it('leva senza barre: sottostante al tetto + certificato, fonte per_row_leverage', () => {
    const cost = resolveTradeCost({ entry: 100, stop: 99, leverage: 10 });
    assert.equal(cost.costSource, 'per_row_leverage');
    assert.equal(cost.underlyingSpreadR, AI_TRADE_COST_SPREAD_CEILING_R);
    assert.ok(cost.costR > 0.36, 'senza barre il costo non scende sotto il modello dichiarato');
  });

  it('tetto totale: spread complessivo mai oltre VAR_SPREAD_MAX_R', () => {
    const cost = resolveTradeCost({ entry: 100, stop: 99.9, bars: [BAR_A, BAR_B], leverage: 5 });
    assert.ok(cost.spreadR <= AI_TRADE_COST_TOTAL_CEILING_R + 1e-9);
    assert.ok(cost.costR <= AI_TRADE_COST_FEE_R + AI_TRADE_COST_TOTAL_CEILING_R + 1e-9);
  });
});

describe('aiTradeCost — determinismo', () => {
  it('stesso input, stesso costo e stessa fonte', () => {
    const input = { entry: 100, stop: 99, bars: [BAR_A, BAR_B], leverage: 7 };
    assert.deepEqual(resolveTradeCost(input), resolveTradeCost(input));
  });
});
