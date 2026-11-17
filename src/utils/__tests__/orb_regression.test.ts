/**
 * Regressioni per calculateOrbFromIntradayBars (src/utils/calculator.ts:226-417).
 * Runner: tsx, come gli altri test del progetto —
 *   `npx tsx src/utils/__tests__/orb_regression.test.ts`.
 *
 * Solo dati sintetici con timestamp deterministici (nessuna rete, Date.now o Math.random).
 * Ogni caso "vuoto" è accompagnato da un controllo positivo con le stesse barre valide,
 * così il test non può passare per un fixture rotto.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrbFromIntradayBars, type IntradayCandleInput } from '../calculator';

const ALL_NULL = {
  orbHigh: null,
  orbLow: null,
  triggerLevel: null,
  stopLossLevel: null,
  firstBreakoutTime: null,
  firstBreakoutTimeLong: null,
  firstBreakoutTimeShort: null,
};

const bar = (iso: string, high: number, low: number, close: number): IntradayCandleInput => ({
  timestamp: new Date(iso),
  high,
  low,
  close,
});

/**
 * Sessione EU del 2026-11-04 (CET, UTC+1): apertura 09:00 Roma = 08:00Z.
 * Slot ORB attesi: 09:00, 09:05, 09:10.
 *   high: 102.0 / 103.5 / 101.8  -> orbHigh = 103.5
 *   low : 100.0 / 100.5 /  99.5  -> orbLow  = 99.5
 *   stop LONG = 99.5 * (1 - STOP_BUF 0.002) = 99.301
 */
const EU_REF = new Date('2026-11-04T08:00:00Z');
const ORB_0900 = bar('2026-11-04T08:00:00Z', 102.0, 100.0, 101.0);
const ORB_0905 = bar('2026-11-04T08:05:00Z', 103.5, 100.5, 102.5);
const ORB_0910 = bar('2026-11-04T08:10:00Z', 101.8, 99.5, 100.0);

/** Controllo positivo: le tre barre valide producono i livelli attesi. */
function assertControlLevels(): void {
  const ctrl = calculateOrbFromIntradayBars([ORB_0900, ORB_0905, ORB_0910], 'EU', EU_REF, 'LONG');
  assert.equal(ctrl.orbHigh, 103.5, 'controllo: orbHigh dai 3 slot');
  assert.equal(ctrl.orbLow, 99.5, 'controllo: orbLow dai 3 slot');
}

describe('ORB regression — calculateOrbFromIntradayBars', () => {
  it('C1: array vuoto -> tutti i livelli null', () => {
    // calculator.ts:249-252 — `if (!bars || bars.length === 0) return emptyResult;`
    const res = calculateOrbFromIntradayBars([], 'EU', EU_REF, 'LONG');
    assert.deepEqual(res, ALL_NULL);
    assertControlLevels();
  });

  it('C2: nessuna barra nella finestra ORB (solo 12:00-12:10) -> tutti i livelli null', () => {
    // calculator.ts:295-299 — slot ORB = [openM, orbEndM), barre fuori finestra scartate;
    // calculator.ts:360-366 — senza i 3 slot la finestra è incompleta.
    const outOfWindow = [
      bar('2026-11-04T11:00:00Z', 110, 109, 109.5), // 12:00 Roma
      bar('2026-11-04T11:05:00Z', 111, 109.2, 110.5), // 12:05
      bar('2026-11-04T11:10:00Z', 110.4, 108.8, 109.9), // 12:10
    ];
    const res = calculateOrbFromIntradayBars(outOfWindow, 'EU', EU_REF, 'LONG');
    assert.deepEqual(res, ALL_NULL);
    assertControlLevels();
  });

  it('C3: finestra parziale (solo 09:00 e 09:05) -> tutti i livelli null', () => {
    // calculator.ts:360-366 — `expectedSlots.every((slot) => slotMap.has(slot))`.
    const partial = calculateOrbFromIntradayBars([ORB_0900, ORB_0905], 'EU', EU_REF, 'LONG');
    assert.deepEqual(partial, ALL_NULL);
    assertControlLevels();
  });

  it('C4: slot duplicato (due barre alle 09:00) -> tutti i livelli null', () => {
    // calculator.ts:329-332 — `if (slotMap.has(startMin)) { hasDuplicateOrInvalid = true; continue; }`
    // calculator.ts:360-362 — `!hasDuplicateOrInvalid && ...`
    const duplicate = bar('2026-11-04T08:00:00Z', 104.0, 99.0, 100.5);
    const res = calculateOrbFromIntradayBars([ORB_0900, duplicate, ORB_0905, ORB_0910], 'EU', EU_REF, 'LONG');
    assert.deepEqual(res, ALL_NULL);
    assertControlLevels();
  });

  it('C5: barra fuori griglia 5m dentro la finestra (09:01) -> tutti i livelli null', () => {
    // calculator.ts:322-326 — `if (offset % 5 !== 0 || !expectedSlots.includes(startMin))`
    const offGrid = bar('2026-11-04T08:01:00Z', 104.0, 99.0, 100.5); // 09:01 Roma
    const res = calculateOrbFromIntradayBars([offGrid, ORB_0905, ORB_0910], 'EU', EU_REF, 'LONG');
    assert.deepEqual(res, ALL_NULL);
    assertControlLevels();
  });

  it('C6: OHLC invalido in uno slot ORB (high < low) -> tutti i livelli null', () => {
    // calculator.ts:301-317 — `validOhlc` include `b.high >= b.low`; se la barra è in slot ORB
    // l'anomalia marca `hasDuplicateOrInvalid` e invalida la finestra.
    const brokenHighLow = bar('2026-11-04T08:00:00Z', 99.0, 101.0, 100.0);
    const res = calculateOrbFromIntradayBars([brokenHighLow, ORB_0905, ORB_0910], 'EU', EU_REF, 'LONG');
    assert.deepEqual(res, ALL_NULL);
    assertControlLevels();
  });

  it('C7: prezzo NaN in uno slot ORB -> tutti i livelli null', () => {
    // calculator.ts:305-307 — `!isNaN(b.high)` ecc.; barra in slot ORB -> `hasDuplicateOrInvalid`.
    const nanHigh = bar('2026-11-04T08:05:00Z', Number.NaN, 100.5, 102.5);
    const res = calculateOrbFromIntradayBars([ORB_0900, nanHigh, ORB_0910], 'EU', EU_REF, 'LONG');
    assert.deepEqual(res, ALL_NULL);
    assertControlLevels();
  });

  it('C8: asOf prima della chiusura dello slot 09:10 -> null; asOf 09:15 -> livelli completi', () => {
    // calculator.ts:334-343 (fix 745cd00 "barra ancora in formazione"): uno slot ORB vale solo se
    // `slotEndMin = startMin + 5 <= asOf.totalMinutes`.
    const forming = calculateOrbFromIntradayBars(
      [ORB_0900, ORB_0905, ORB_0910],
      'EU',
      EU_REF,
      'LONG',
      new Date('2026-11-04T08:12:00Z') // 09:12 Roma: la barra 09:10 chiude alle 09:15
    );
    assert.deepEqual(forming, ALL_NULL);

    const closed = calculateOrbFromIntradayBars(
      [ORB_0900, ORB_0905, ORB_0910],
      'EU',
      EU_REF,
      'LONG',
      new Date('2026-11-04T08:15:00Z') // 09:15 Roma: tutti e 3 gli slot sono chiusi
    );
    assert.equal(closed.orbHigh, 103.5);
    assert.equal(closed.orbLow, 99.5);
    assert.equal(closed.triggerLevel, 103.5);
    assert.equal(closed.stopLossLevel, 99.301);
  });

  it('C9: barre ORB di una sessione precedente non entrano nell\'ORB odierno', () => {
    // calculator.ts:276-277 e 292 — il filtro `mt.dateFormatted !== sessionDateStr` precede
    // la validazione OHLC e il riempimento degli slot.
    const yesterday = [
      bar('2026-11-03T08:00:00Z', 500, 400, 450),
      bar('2026-11-03T08:05:00Z', 501, 401, 451),
      bar('2026-11-03T08:10:00Z', 502, 402, 452),
    ];
    const res = calculateOrbFromIntradayBars([...yesterday, ORB_0900, ORB_0905, ORB_0910], 'EU', EU_REF, 'LONG');
    assert.equal(res.orbHigh, 103.5, 'gli estremi di ieri (high 502) non devono entrare');
    assert.equal(res.orbLow, 99.5);
    assertControlLevels();
  });

  it('C10: la finestra ORB segue l\'ora locale di borsa anche nel cambio ora legale', () => {
    // getMarketTime usa Europe/Rome (timezone.ts:74-80): 09:00 Roma = 08:00Z in CET, 07:00Z in CEST.
    // La stessa finestra locale deve produrre gli stessi livelli nei due regimi.
    const levels = (highs: [number, number, number], lows: [number, number, number], closes: [number, number, number]) => ({
      highs,
      lows,
      closes,
    });
    const v = levels([10, 11, 10.4], [9, 9.2, 8.8], [9.5, 10.5, 9.9]);

    const winter = [0, 5, 10].map((m, i) =>
      bar(`2026-03-27T08:${String(m).padStart(2, '0')}:00Z`, v.highs[i], v.lows[i], v.closes[i])
    );
    const winterRef = new Date('2026-03-27T08:00:00Z');
    const resWinter = calculateOrbFromIntradayBars(winter, 'EU', winterRef, 'LONG');
    assert.equal(resWinter.orbHigh, 11, 'CET: 08:00Z equivale a 09:00 Roma');
    assert.equal(resWinter.orbLow, 8.8);
    assert.equal(resWinter.stopLossLevel, 8.7824);

    const summer = [0, 5, 10].map((m, i) =>
      bar(`2026-03-30T07:${String(m).padStart(2, '0')}:00Z`, v.highs[i], v.lows[i], v.closes[i])
    );
    const summerRef = new Date('2026-03-30T07:00:00Z');
    const resSummer = calculateOrbFromIntradayBars(summer, 'EU', summerRef, 'LONG');
    assert.equal(resSummer.orbHigh, 11, 'CEST: 07:00Z equivale a 09:00 Roma');
    assert.equal(resSummer.orbLow, 8.8);
    assert.equal(resSummer.stopLossLevel, 8.7824);

    // Controprova: l'orario UTC invernale applicato al giorno estivo è 10:00 Roma, fuori finestra.
    const misplaced = [0, 5, 10].map((m, i) =>
      bar(`2026-03-30T08:${String(m).padStart(2, '0')}:00Z`, v.highs[i], v.lows[i], v.closes[i])
    );
    const resMisplaced = calculateOrbFromIntradayBars(misplaced, 'EU', summerRef, 'LONG');
    assert.deepEqual(resMisplaced, ALL_NULL);
  });
});
