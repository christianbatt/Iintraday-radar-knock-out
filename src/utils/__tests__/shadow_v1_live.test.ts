/**
 * Test del nucleo puro V1-live: validazione, deduplica, limit-fill, precedenza dello
 * stop, scadenza a fine sessione.
 *
 * Dati SINTETICI: nessun test misura performance o valida una strategia. I valori
 * attesi sono calcolati a mano e riportati nel commento di ogni blocco.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateShadowV1Live,
  shadowV1LiveKeyOf,
  utcDayOf,
  type ShadowV1LiveBar,
  type ShadowV1LiveResult,
  type ShadowV1LiveSetup,
} from '../../knowledge/shadowV1Live';

const DAY = Date.UTC(2026, 10, 17); // 2026-11-17T00:00:00Z
const DECIDED = DAY + 10 * 3_600_000; // 10:00 UTC
const CLOSE = DAY + 14 * 3_600_000; // 14:00 UTC, fornito dal chiamante
const BAR = 5 * 60_000;

const ts = (i: number): number => DECIDED + (i + 1) * BAR;
const closedAt = (i: number): number => ts(i) + BAR;

const bar = (t: number, o: number, h: number, l: number, c: number): ShadowV1LiveBar => ({
  t,
  o,
  h,
  l,
  c,
});

/** Setup LONG: entry 100, stop 95 (risk 5), target 108 => target = +1.6 R. */
const baseSetup = (): ShadowV1LiveSetup => ({
  candidate: { ticker: 'AAA' },
  decision: 'TRADE',
  direction: 'LONG',
  triggerLevel: 100,
  entryLevel: 100,
  stopLossLevel: 95,
  target1Level: 108,
});

const longSetup = baseSetup;

/** Setup SHORT: entry 100, stop 105 (risk 5), target 92 => target = +1.6 R. */
const shortSetup = (): ShadowV1LiveSetup => ({
  ...baseSetup(),
  direction: 'SHORT',
  stopLossLevel: 105,
  target1Level: 92,
});

const run = (
  setup: ShadowV1LiveSetup,
  bars: readonly ShadowV1LiveBar[],
  opts: { nowMs?: number; sessionCloseMs?: number; decidedAtMs?: number; seenKeys?: string[] } = {}
): ShadowV1LiveResult =>
  evaluateShadowV1Live({
    setup,
    decidedAtMs: opts.decidedAtMs ?? DECIDED,
    sessionCloseMs: opts.sessionCloseMs ?? CLOSE,
    nowMs: opts.nowMs ?? CLOSE,
    bars,
    seenKeys: opts.seenKeys,
  });

describe('V1-live — validazione (D5)', () => {
  it('setup valido senza barre utili prima della chiusura => PENDING_FILL con chiave', () => {
    const r = run(longSetup(), [], { nowMs: closedAt(0) });
    assert.equal(r.status, 'PENDING_FILL');
    assert.equal(r.key, 'AAA|100|95|2026-11-17');
    assert.equal(r.r, null);
    assert.equal(r.riskPerUnit, 5);
    assert.ok(r.reason && r.reason.length > 0);
  });

  it('entry mancante (entryLevel e triggerLevel nulli) => INVALID_SETUP', () => {
    const r = run({ ...baseSetup(), entryLevel: null, triggerLevel: null }, []);
    assert.equal(r.status, 'INVALID_SETUP');
    assert.equal(r.reason, 'entry mancante o non finito');
    assert.equal(r.key, null);
    assert.equal(r.r, null);
  });

  it('entryLevel assente ma triggerLevel presente => entry = triggerLevel', () => {
    const setup = { ...baseSetup(), entryLevel: undefined, triggerLevel: 100 };
    const bars = [bar(ts(0), 99, 100.5, 98, 100)];
    const r = run(setup, bars, { nowMs: closedAt(0) });
    assert.equal(r.status, 'OPEN');
    assert.equal(r.entryPrice, 100);
    assert.equal(r.fillBarTs, ts(0));
  });

  it('stop mancante => INVALID_SETUP', () => {
    const r = run({ ...baseSetup(), stopLossLevel: null }, []);
    assert.equal(r.status, 'INVALID_SETUP');
    assert.equal(r.reason, 'stop mancante o non finito');
  });

  it('target1Level non finito => INVALID_SETUP', () => {
    const r = run({ ...baseSetup(), target1Level: Number.POSITIVE_INFINITY }, []);
    assert.equal(r.status, 'INVALID_SETUP');
    assert.equal(r.reason, 'target1Level mancante o non finito');
  });

  it('ticker vuoto => INVALID_SETUP', () => {
    const r = run({ ...baseSetup(), candidate: { ticker: '' } }, []);
    assert.equal(r.status, 'INVALID_SETUP');
    assert.equal(r.reason, 'ticker vuoto o non stringa');
  });

  it('ticker non stringa => INVALID_SETUP', () => {
    const setup = { ...baseSetup(), candidate: { ticker: 7 as unknown as string } };
    const r = run(setup, []);
    assert.equal(r.status, 'INVALID_SETUP');
    assert.equal(r.reason, 'ticker vuoto o non stringa');
  });

  it("direction 'NESSUNA' => INVALID_SETUP", () => {
    const r = run({ ...baseSetup(), direction: 'NESSUNA' }, []);
    assert.equal(r.status, 'INVALID_SETUP');
    assert.equal(r.reason, 'direction assente o NESSUNA');
  });

  it("decision 'NESSUN_TRADE' => INVALID_SETUP", () => {
    const r = run({ ...baseSetup(), decision: 'NESSUN_TRADE' }, []);
    assert.equal(r.status, 'INVALID_SETUP');
    assert.equal(r.reason, 'setup non emesso (decision diversa da TRADE)');
  });

  it('decidedAtMs non finito => INVALID_SETUP', () => {
    const r = run(baseSetup(), [], { decidedAtMs: Number.NaN });
    assert.equal(r.status, 'INVALID_SETUP');
    assert.equal(r.reason, 'decidedAtMs non finito');
  });

  it('risk nullo (entry == stop) => INVALID_SETUP, R non definito', () => {
    const r = run({ ...baseSetup(), stopLossLevel: 100 }, []);
    assert.equal(r.status, 'INVALID_SETUP');
    assert.equal(r.reason, 'distanza entry-stop nulla: R non definito');
  });
});

describe('V1-live — chiave di deduplica (D4)', () => {
  it('stessa emissione => chiave uguale; ticker, entry, stop o giorno diversi => chiave diversa', () => {
    const k = shadowV1LiveKeyOf('AAA', 100, 95, DECIDED);
    assert.equal(k, 'AAA|100|95|2026-11-17');
    assert.equal(shadowV1LiveKeyOf('AAA', 100, 95, DECIDED + 60_000), k);
    assert.notEqual(shadowV1LiveKeyOf('BBB', 100, 95, DECIDED), k);
    assert.notEqual(shadowV1LiveKeyOf('AAA', 101, 95, DECIDED), k);
    assert.notEqual(shadowV1LiveKeyOf('AAA', 100, 94, DECIDED), k);
    // Giorno UTC: +24h cambia il giorno, lo stesso giorno no.
    assert.notEqual(shadowV1LiveKeyOf('AAA', 100, 95, DECIDED + 24 * 3_600_000), k);
    assert.equal(utcDayOf(DECIDED + 24 * 3_600_000), '2026-11-18');
  });

  it('chiave gia\' vista => DUPLICATE, senza R', () => {
    const key = shadowV1LiveKeyOf('AAA', 100, 95, DECIDED);
    const r = run(longSetup(), [bar(ts(0), 99, 120, 98, 119)], { seenKeys: [key] });
    assert.equal(r.status, 'DUPLICATE');
    assert.equal(r.key, key);
    assert.equal(r.r, null);
    assert.equal(r.fillBarTs, null);
  });

  it('chiave diversa => valutazione normale', () => {
    const r = run(longSetup(), [bar(ts(0), 99, 120, 98, 119)], {
      seenKeys: ['BBB|100|95|2026-11-17'],
      nowMs: closedAt(0),
    });
    assert.equal(r.status, 'TARGET');
  });
});

describe('V1-live — selezione e normalizzazione delle barre', () => {
  it('barre con t <= decidedAtMs escluse: nessun fill', () => {
    const bars = [
      bar(DECIDED - BAR, 99, 130, 98, 129), // prima della decisione
      bar(DECIDED, 99, 130, 98, 129), // esattamente alla decisione
      bar(ts(0), 99, 100.5, 98, 100), // successiva, non tocca 100? la tocca (h=100.5)
    ];
    const r = run(longSetup(), [bars[0], bars[1]], { nowMs: closedAt(0) });
    assert.equal(r.status, 'PENDING_FILL');
    assert.equal(r.fillBarTs, null);
  });

  it('barra non chiusa (t + barMs > nowMs) ignorata', () => {
    const openBar = bar(ts(0), 99, 130, 98, 129);
    const r = run(longSetup(), [openBar], { nowMs: ts(0) + BAR / 2 });
    assert.equal(r.status, 'PENDING_FILL');
  });

  it('barra oltre la chiusura di sessione ignorata', () => {
    const late = bar(CLOSE, 99, 130, 98, 129);
    const r = run(longSetup(), [late], { nowMs: CLOSE + BAR });
    assert.equal(r.status, 'NOT_FILLED');
    assert.equal(r.fillBarTs, null);
  });

  it('barra con OHLC non finiti o high < low ignorata', () => {
    const r = run(
      longSetup(),
      [bar(ts(0), 99, Number.NaN, 98, 129), bar(ts(1), 99, 97, 98, 99)],
      { nowMs: closedAt(1) }
    );
    assert.equal(r.status, 'PENDING_FILL');
  });

  it('ordine di input irrilevante e duplicati sullo stesso t: vince l\'ultimo', () => {
    const b1 = bar(ts(0), 99, 101, 98, 100.5);
    const b2last = bar(ts(1), 100, 101, 99, 101);
    const b2first = bar(ts(1), 100, 101, 99, 130); // stesso t, valore che non deve vincere
    const sorted = run(longSetup(), [b1, b2last], { nowMs: CLOSE });
    const shuffled = run(longSetup(), [b2last, b1], { nowMs: CLOSE });
    const shuffledWithDup = run(longSetup(), [b1, b2first, b2last], { nowMs: CLOSE });

    assert.equal(sorted.status, 'EXPIRED');
    assert.equal(sorted.exitPrice, 101);
    // input fuori ordine: le barre vengono ordinate internamente
    assert.deepEqual(shuffled, sorted);
    // duplicato: l'ultima occorrenza in ordine di input vince (c = 101)
    assert.deepEqual(shuffledWithDup, sorted);
    assert.equal(shuffledWithDup.exitPrice, 101);
  });

  it('non muta gli input', () => {
    const bars = [bar(ts(1), 100, 101, 99, 101), bar(ts(0), 99, 120, 98, 119)];
    const snapshot = JSON.stringify({ bars, setup: longSetup() });
    const setup = longSetup();
    evaluateShadowV1Live({
      setup,
      decidedAtMs: DECIDED,
      sessionCloseMs: CLOSE,
      nowMs: CLOSE,
      bars,
    });
    assert.equal(JSON.stringify({ bars, setup }), snapshot);
  });

  it('deterministico: stesso input, stesso output', () => {
    const bars = [
      bar(ts(0), 99, 101, 98, 100.5),
      bar(ts(1), 100.5, 104, 99, 103),
    ];
    const a = run(longSetup(), bars, { nowMs: closedAt(1) });
    const b = run(longSetup(), bars, { nowMs: closedAt(1) });
    assert.deepEqual(a, b);
  });
});

describe('V1-live — limit-fill ed esiti', () => {
  it('long: fill alla prima barra chiusa con high >= entry, poi OPEN se non tocca stop/target', () => {
    const bars = [
      bar(ts(0), 98, 99, 97, 98.5), // non tocca 100
      bar(ts(1), 99, 102, 98, 101), // fill
      bar(ts(2), 101, 103, 97, 102),
    ];
    const r = run(longSetup(), bars, { nowMs: closedAt(2) });
    assert.equal(r.status, 'OPEN');
    assert.equal(r.fillBarTs, ts(1));
    assert.equal(r.r, null);
    assert.equal(r.entryPrice, 100);
  });

  it('long: apertura in gap oltre l\'entry => fill registrato al livello entry (metodo storico)', () => {
    const bars = [bar(ts(0), 104, 106, 103, 105)];
    const r = run(longSetup(), bars, { nowMs: closedAt(0) });
    assert.equal(r.status, 'OPEN');
    assert.equal(r.fillBarTs, ts(0));
    assert.equal(r.entryPrice, 100);
  });

  it('short: fill se low <= entry', () => {
    const bars = [bar(ts(0), 102, 103, 100, 101), bar(ts(1), 101, 102, 96, 97)];
    const r = run(shortSetup(), bars, { nowMs: closedAt(1) });
    assert.equal(r.status, 'OPEN');
    assert.equal(r.fillBarTs, ts(0));
  });

  it('long: stop prima del target => -1 R', () => {
    const bars = [bar(ts(0), 99, 101, 98, 100), bar(ts(1), 100, 101, 94, 95)];
    const r = run(longSetup(), bars, { nowMs: closedAt(1) });
    assert.equal(r.status, 'STOP');
    assert.equal(r.r, -1);
    assert.equal(r.exitPrice, 95);
    assert.equal(r.exitBarTs, ts(1));
  });

  it('long: stop in gap sotto il livello => comunque -1 R', () => {
    const bars = [bar(ts(0), 99, 101, 98, 100), bar(ts(1), 90, 91, 88, 89)];
    const r = run(longSetup(), bars, { nowMs: closedAt(1) });
    assert.equal(r.status, 'STOP');
    assert.equal(r.r, -1);
    assert.equal(r.exitPrice, 95);
  });

  it('long: target prima dello stop => +1.6 R', () => {
    const bars = [bar(ts(0), 99, 101, 98, 100), bar(ts(1), 100, 109, 99, 108)];
    const r = run(longSetup(), bars, { nowMs: closedAt(1) });
    assert.equal(r.status, 'TARGET');
    assert.equal(r.r, 1.6);
    assert.equal(r.exitPrice, 108);
  });

  it('short: target prima dello stop => +1.6 R con segno di direzione', () => {
    const bars = [bar(ts(0), 102, 103, 100, 101), bar(ts(1), 101, 102, 91, 92)];
    const r = run(shortSetup(), bars, { nowMs: closedAt(1) });
    assert.equal(r.status, 'TARGET');
    assert.equal(r.r, 1.6);
  });

  it('barra di fill che tocca anche lo stop: prevale lo stop (D6)', () => {
    const bars = [bar(ts(0), 99, 109, 94, 108)]; // tocca entry, stop e target
    const r = run(longSetup(), bars, { nowMs: closedAt(0) });
    assert.equal(r.status, 'STOP');
    assert.equal(r.r, -1);
    assert.equal(r.fillBarTs, ts(0));
    assert.equal(r.exitBarTs, ts(0));
  });

  it('target1Level usato cosi\' com\'e\' con multiplier diverso da 1.6', () => {
    // entry 100, stop 95, target 106 => +6/5 = +1.2 R
    const setup = { ...baseSetup(), target1Level: 106 };
    const bars = [bar(ts(0), 99, 107, 98, 106)];
    const r = run(setup, bars, { nowMs: closedAt(0) });
    assert.equal(r.status, 'TARGET');
    assert.equal(r.r, 1.2);
    assert.equal(r.targetPrice, 106);
  });
});

describe('V1-live — terminazione di sessione (D2/D7)', () => {
  it('sessione finita senza fill => NOT_FILLED, senza R', () => {
    const bars = [bar(ts(0), 98, 99, 97, 98.5), bar(ts(1), 98.5, 99.5, 96, 99)];
    const r = run(longSetup(), bars, { nowMs: CLOSE });
    assert.equal(r.status, 'NOT_FILLED');
    assert.equal(r.r, null);
    assert.equal(r.fillBarTs, null);
    assert.equal(r.exitPrice, null);
    assert.ok(r.reason && r.reason.length > 0);
  });

  it('sessione finita dopo fill => EXPIRED al close dell\'ultima barra chiusa', () => {
    const bars = [
      bar(ts(0), 99, 101, 98, 100.5), // fill
      bar(ts(1), 100.5, 103, 99, 101.5), // nessun stop/target
    ];
    const r = run(longSetup(), bars, { nowMs: CLOSE });
    assert.equal(r.status, 'EXPIRED');
    assert.equal(r.exitBarTs, ts(1));
    assert.equal(r.exitPrice, 101.5);
    assert.equal(r.r, (101.5 - 100) / 5); // +0.3 R
  });

  it('short: EXPIRED con R di direzione corretta', () => {
    const bars = [bar(ts(0), 102, 103, 100, 101), bar(ts(1), 101, 102, 99, 98)];
    const r = run(shortSetup(), bars, { nowMs: CLOSE });
    assert.equal(r.status, 'EXPIRED');
    assert.equal(r.r, (100 - 98) / 5); // +0.4 R (dir = -1)
  });

  it('fill e sessione finita sulla stessa barra: EXPIRED al close di quella barra', () => {
    const bars = [bar(ts(0), 99, 102, 99, 101)];
    const r = run(longSetup(), bars, { nowMs: CLOSE });
    assert.equal(r.status, 'EXPIRED');
    assert.equal(r.fillBarTs, ts(0));
    assert.equal(r.exitBarTs, ts(0));
    assert.equal(r.exitPrice, 101);
  });
});
