/**
 * Test del collector passivo SHADOW V1 LIVE (PR C1).
 *
 * Tutto l'I/O usa `os.tmpdir()`: nessun file viene scritto in `artifacts/` o
 * `registry/`. Il clock, la sorgente barre e le funzioni di persistenza sono
 * iniettati, quindi i test sono deterministici e senza rete.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  barsForShadowV1Live,
  clearShadowV1LiveBarsForTest,
  createObserveHandler,
  isShadowV1LiveCollectEnabled,
  parseObservePayload,
  recordBarsForShadowV1Live,
  registerShadowV1LiveCollector,
  runShadowV1LiveRevaluationCycle,
  SHADOW_V1_LIVE_COLLECT_ENV,
  SHADOW_V1_LIVE_CYCLE_MS,
  SHADOW_V1_LIVE_MAX_BARS_PER_TICKER,
  SHADOW_V1_LIVE_MAX_BODY_BYTES,
  SHADOW_V1_LIVE_OBSERVE_PATH,
  SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE,
  type CollectorDeps,
  type ObserveRequest,
  type ObserveResponse,
} from '../../server/shadowV1LiveCollector';
import {
  loadRecords,
  type PersistedShadowV1LiveRecord,
} from '../../server/shadowV1LiveStore';
import { shadowV1LiveKeyOf, type ShadowV1LiveBar } from '../../knowledge/shadowV1Live';

const BAR_MS = 5 * 60 * 1000;
const D0 = Date.UTC(2026, 2, 16, 14, 0, 0); // lunedi'
const CLOSE = D0 + 6 * 60 * 60 * 1000; // 16:00 EDT = 20:00Z
const ISO_D0 = new Date(D0).toISOString();

const ON = { [SHADOW_V1_LIVE_COLLECT_ENV]: '1' };
const OFF = {};

function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticker: 'AAPL',
    market: 'US',
    direction: 'LONG',
    entry: 100,
    stop: 95,
    target: 108,
    calculatedAt: ISO_D0,
    ...over,
  };
}

const tmpDirs: string[] = [];

function tmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1livecollector-'));
  tmpDirs.push(dir);
  return path.join(dir, 'shadow_v1_live', 'signals.jsonl');
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test.beforeEach(() => {
  clearShadowV1LiveBarsForTest();
});

function deps(
  signalsPath: string,
  over: Partial<CollectorDeps> = {},
  nowMs = D0 + 30 * 60 * 1000
): CollectorDeps {
  return {
    env: ON,
    signalsPath,
    now: () => nowMs,
    bars: () => [],
    warn: () => {},
    ...over,
  };
}

function ioSpies() {
  const calls: string[] = [];
  return {
    calls,
    readRecords: (p: string) => {
      calls.push(`read:${path.basename(p)}`);
      return { records: [] as PersistedShadowV1LiveRecord[], skipped: 0 };
    },
    writeRecords: (p: string, records: readonly PersistedShadowV1LiveRecord[]) => {
      calls.push(`write:${path.basename(p)}:${records.length}`);
      return { ok: true as const };
    },
  };
}

async function post(
  depsValue: CollectorDeps,
  body: unknown,
  over: Partial<ObserveRequest> = {}
): Promise<ObserveResponse> {
  const handler = createObserveHandler(depsValue);
  return handler({ body, ip: '127.0.0.1', ...over });
}

function bodyText(res: ObserveResponse): string {
  return JSON.stringify(res.body);
}

// --- F2: valori del flag ------------------------------------------------------

test('flag: attivo solo con "1" e "true" esatti', () => {
  for (const value of ['1', 'true']) {
    assert.equal(isShadowV1LiveCollectEnabled({ [SHADOW_V1_LIVE_COLLECT_ENV]: value }), true, value);
  }
  for (const value of ['0', 'false', '', 'TRUE', ' true', 'yes', 'on', undefined]) {
    const env =
      value === undefined ? {} : { [SHADOW_V1_LIVE_COLLECT_ENV]: value as string };
    assert.equal(isShadowV1LiveCollectEnabled(env), false, String(value));
  }
  assert.equal(isShadowV1LiveCollectEnabled(undefined), false);
});

// --- F3: flag OFF -> nessun I/O, nessun timer --------------------------------

test('flag OFF: 404 disabled, nessun I/O di store, nessun file creato', async () => {
  const file = tmpPath();
  const spies = ioSpies();
  const res = await post(
    deps(file, { env: OFF, readRecords: spies.readRecords, writeRecords: spies.writeRecords }),
    validBody()
  );
  assert.equal(res.status, 404);
  assert.equal(res.body.status, 'disabled');
  assert.deepEqual(spies.calls, []);
  assert.equal(fs.existsSync(path.dirname(file)), false, 'la directory non deve esistere');
});

test('flag OFF: nessun timer avviato, route comunque registrata', () => {
  const registered: string[] = [];
  const intervals: number[] = [];
  const app = {
    post: (p: string, _h: (req: unknown, res: unknown) => void) => registered.push(p),
  };
  const res = registerShadowV1LiveCollector(app, {
    env: OFF,
    timers: {
      setInterval: (fn, ms) => {
        intervals.push(ms);
        return { unref: () => {} };
      },
      clearInterval: () => {},
    },
  });
  assert.equal(res.enabled, false);
  assert.equal(res.stop, null);
  assert.deepEqual(intervals, []);
  assert.deepEqual(registered, [SHADOW_V1_LIVE_OBSERVE_PATH]);
});

test('flag ON: timer avviato con periodo dichiarato, unref e stop', () => {
  const intervals: number[] = [];
  const cleared: unknown[] = [];
  let unrefCalled = 0;
  const app = { post: () => {} };
  const res = registerShadowV1LiveCollector(app, {
    env: ON,
    timers: {
      setInterval: (_fn, ms) => {
        intervals.push(ms);
        return {
          unref: () => {
            unrefCalled += 1;
          },
        };
      },
      clearInterval: (handle) => cleared.push(handle),
    },
  });
  assert.equal(res.enabled, true);
  assert.deepEqual(intervals, [SHADOW_V1_LIVE_CYCLE_MS]);
  assert.equal(unrefCalled, 1);
  assert.equal(typeof res.stop, 'function');
  res.stop?.();
  assert.equal(cleared.length, 1);
});

// --- Validazione del payload --------------------------------------------------

test('payload non oggetto: 400', async () => {
  const file = tmpPath();
  for (const body of [null, [], 'x', 42, undefined]) {
    const res = await post(deps(file), body);
    assert.equal(res.status, 400, String(body));
    assert.equal(res.body.status, 'invalid_payload');
  }
});

test('ogni campo mancante da\u2019 400 con motivo', async () => {
  const file = tmpPath();
  for (const key of ['ticker', 'market', 'direction', 'entry', 'stop', 'target', 'calculatedAt']) {
    const body = validBody();
    delete body[key];
    const res = await post(deps(file), body);
    assert.equal(res.status, 400, key);
    assert.match(String(res.body.reason), new RegExp(key), key);
  }
});

test('campo non atteso: 400 e nessuna persistenza', async () => {
  const file = tmpPath();
  const res = await post(deps(file), validBody({ candidate: { ticker: 'X' } }));
  assert.equal(res.status, 400);
  assert.match(String(res.body.reason), /campo non atteso: candidate/);
  assert.equal(fs.existsSync(file), false);
});

test('tipi errati e valori non finiti: 400', async () => {
  const file = tmpPath();
  const cases: Array<[string, Record<string, unknown>]> = [
    ['ticker numero', { ticker: 5 }],
    ['ticker vuoto', { ticker: '   ' }],
    ['ticker troppo lungo', { ticker: 'A'.repeat(21) }],
    ['market sconosciuto', { market: 'UK' }],
    ['direction NEUTRAL', { direction: 'NEUTRAL' }],
    ['entry stringa', { entry: '100' }],
    ['entry NaN', { entry: Number.NaN }],
    ['entry Infinity', { entry: Number.POSITIVE_INFINITY }],
    ['entry zero', { entry: 0 }],
    ['stop negativo', { stop: -95 }],
    ['target null', { target: null }],
    ['calculatedAt numero', { calculatedAt: 1773673200000 }],
    ['calculatedAt non ISO', { calculatedAt: 'ieri' }],
    ['calculatedAt data impossibile', { calculatedAt: '2026-13-45T25:00:00.000Z' }],
  ];
  for (const [label, over] of cases) {
    const res = await post(deps(file), validBody(over));
    assert.equal(res.status, 400, label);
    assert.equal(res.body.status, 'invalid_payload', label);
  }
  assert.equal(fs.existsSync(file), false);
});

test('calculatedAt assente: 400, nessun fallback all\u2019orologio del server', async () => {
  const file = tmpPath();
  const spies = ioSpies();
  const body = validBody();
  delete body.calculatedAt;
  const res = await post(
    deps(file, { readRecords: spies.readRecords, writeRecords: spies.writeRecords }),
    body
  );
  assert.equal(res.status, 400);
  assert.match(String(res.body.reason), /calculatedAt/);
  assert.deepEqual(spies.calls, [], 'la richiesta invalida non deve toccare lo store');
  assert.equal(fs.existsSync(file), false);
});

test('parseObservePayload: accetta ISO con offset e rifiuta Z minuscola', () => {
  assert.equal(parseObservePayload(validBody()).ok, true);
  const withOffset = parseObservePayload(
    validBody({ calculatedAt: '2026-03-16T15:00:00+01:00' })
  );
  assert.equal(withOffset.ok, true);
  assert.equal(parseObservePayload(validBody({ calculatedAt: ISO_D0.replace('Z', 'z') })).ok, false);
});

// --- F5: limiti della route ---------------------------------------------------

test('413: body oltre 8192 byte (Content-Length dichiarato)', async () => {
  const file = tmpPath();
  const spies = ioSpies();
  const res = await post(
    deps(file, { readRecords: spies.readRecords, writeRecords: spies.writeRecords }),
    validBody(),
    { contentLength: SHADOW_V1_LIVE_MAX_BODY_BYTES + 1 }
  );
  assert.equal(res.status, 413);
  assert.equal(res.body.maxBytes, SHADOW_V1_LIVE_MAX_BODY_BYTES);
  assert.deepEqual(spies.calls, []);
});

test('413: body oltre 8192 byte (lunghezza serializzata, senza Content-Length)', async () => {
  const file = tmpPath();
  const res = await post(deps(file), validBody({ extra: 'x'.repeat(SHADOW_V1_LIVE_MAX_BODY_BYTES) }));
  assert.equal(res.status, 413);
});

test('body appena sotto il limite viene accettato', async () => {
  const file = tmpPath();
  const res = await post(deps(file), validBody());
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'PENDING_FILL');
});

test('429 dopo 10 richieste nello stesso minuto per lo stesso IP', async () => {
  const file = tmpPath();
  const handler = createObserveHandler(deps(file));
  const statuses: number[] = [];
  for (let i = 0; i < SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE + 1; i += 1) {
    const res = await handler({ body: validBody(), ip: '10.0.0.1' });
    statuses.push(res.status);
  }
  assert.deepEqual(
    statuses.slice(0, SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE),
    Array(SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE).fill(200)
  );
  assert.equal(statuses.at(-1), 429);
});

test('il limite e\u2019 per IP: un altro IP non viene bloccato', async () => {
  const file = tmpPath();
  const handler = createObserveHandler(deps(file));
  for (let i = 0; i < SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE; i += 1) {
    await handler({ body: validBody(), ip: '10.0.0.1' });
  }
  const res = await handler({ body: validBody(), ip: '10.0.0.2' });
  assert.notEqual(res.status, 429);
});

// --- F7: sessione -------------------------------------------------------------

test('weekend: 200 no_session, nessuna valutazione e nessuna scrittura', async () => {
  const file = tmpPath();
  const spies = ioSpies();
  const res = await post(
    deps(file, { readRecords: spies.readRecords, writeRecords: spies.writeRecords }),
    validBody({ calculatedAt: '2026-03-14T14:00:00.000Z' })
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'no_session');
  assert.equal(res.body.sessionDate, '2026-03-14');
  assert.deepEqual(spies.calls, []);
  assert.equal(fs.existsSync(file), false);
});

test('domenica EU: no_session anche con livelli validi', async () => {
  const file = tmpPath();
  const res = await post(
    deps(file),
    validBody({ market: 'EU', calculatedAt: '2026-03-15T10:00:00.000Z' })
  );
  assert.equal(res.body.status, 'no_session');
});

// --- Esiti del nucleo ---------------------------------------------------------

test('setup valido: PENDING_FILL persistito, una riga nel file', async () => {
  const file = tmpPath();
  const res = await post(deps(file), validBody());
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'PENDING_FILL');
  assert.equal(res.body.persisted, true);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]) as PersistedShadowV1LiveRecord;
  assert.equal(rec.key, shadowV1LiveKeyOf('AAPL', 100, 95, D0));
  assert.equal(rec.decidedAtMs, D0);
  assert.equal(rec.sessionCloseMs, CLOSE);
});

test('stessa richiesta due volte: DUPLICATE al secondo invio e un solo record', async () => {
  const file = tmpPath();
  const handler = createObserveHandler(deps(file));
  const first = await handler({ body: validBody(), ip: '1.1.1.1' });
  const second = await handler({ body: validBody(), ip: '1.1.1.1' });
  assert.equal(first.body.outcome, 'PENDING_FILL');
  assert.equal(second.body.outcome, 'DUPLICATE');
  assert.equal(second.body.persisted, false);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('INVALID_SETUP non viene persistito', async () => {
  const file = tmpPath();
  const res = await post(deps(file), validBody({ stop: 120 }));
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'INVALID_SETUP');
  assert.equal(res.body.persisted, false);
  assert.equal(fs.existsSync(file), false);
});

test('entry o stop diversi: nuova chiave, nuovo record', async () => {
  const file = tmpPath();
  const handler = createObserveHandler(deps(file));
  await handler({ body: validBody(), ip: '2.2.2.2' });
  const other = await handler({ body: validBody({ entry: 101 }), ip: '2.2.2.2' });
  assert.equal(other.body.outcome, 'PENDING_FILL');
  const records = loadRecords(file).records;
  assert.equal(records.length, 2);
});

// --- Concorrenza --------------------------------------------------------------

test('richieste concorrenti sulla stessa chiave: un solo record, file valido', async () => {
  const file = tmpPath();
  const handler = createObserveHandler(deps(file));
  const bodies = Array.from({ length: 8 }, () => validBody());
  const responses = await Promise.all(bodies.map((body) => handler({ body, ip: '3.3.3.3' })));
  assert.ok(responses.every((r) => r.status === 200));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  for (const line of lines) JSON.parse(line);
});

test('richieste concorrenti su chiavi diverse: nessun aggiornamento perso', async () => {
  const file = tmpPath();
  const delay = () => new Promise((r) => setTimeout(r, 5));
  let stored: PersistedShadowV1LiveRecord[] = [];
  const depsValue = deps(file, {
    readRecords: async () => {
      await delay();
      return { records: stored.map((r) => ({ ...r })), skipped: 0 };
    },
    writeRecords: async (_p: string, records: readonly PersistedShadowV1LiveRecord[]) => {
      await delay();
      stored = records.map((r) => ({ ...r }));
      return { ok: true as const };
    },
  });
  const handler = createObserveHandler(depsValue);
  await Promise.all([
    handler({ body: validBody(), ip: '4.4.4.4' }),
    handler({ body: validBody({ entry: 101 }), ip: '4.4.4.4' }),
    handler({ body: validBody({ entry: 102 }), ip: '4.4.4.4' }),
  ]);
  assert.equal(stored.length, 3);
});

// --- Ciclo di rivalutazione ---------------------------------------------------

/**
 * Stato iniziale realistico: il record nasce dalla route, come in produzione,
 * cosi' `reason` e campi derivati sono quelli che il nucleo produce davvero.
 */
async function seedPending(file: string, nowMs = D0 + 5 * 60_000): Promise<void> {
  const handler = createObserveHandler(deps(file, {}, nowMs));
  const res = await handler({ body: validBody(), ip: 'seed' });
  assert.equal(res.body.outcome, 'PENDING_FILL');
  assert.equal(res.body.persisted, true);
}

async function seedOpen(file: string, nowMs = D0 + 5 * 60_000): Promise<void> {
  await seedPending(file, nowMs);
  await runShadowV1LiveRevaluationCycle(
    deps(file, { bars: () => [bar(D0 + BAR_MS, 100, 101, 99, 100.5)] }, nowMs + BAR_MS)
  );
  assert.equal(loadRecords(file).records[0].status, 'OPEN');
}

function bar(t: number, o: number, h: number, l: number, c: number): ShadowV1LiveBar {
  return { t, o, h, l, c };
}

test('ciclo: PENDING_FILL -> OPEN con barra che tocca l\u2019entry', async () => {
  const file = tmpPath();
  await seedPending(file);
  const res = await runShadowV1LiveRevaluationCycle(
    deps(file, { bars: () => [bar(D0 + BAR_MS, 100, 101, 99, 100.5)] }, D0 + 2 * BAR_MS)
  );
  assert.equal(res.changed, 1);
  assert.equal(res.written, true);
  const rec = loadRecords(file).records[0];
  assert.equal(rec.status, 'OPEN');
  assert.equal(rec.fillBarTs, D0 + BAR_MS);
});

test('ciclo: OPEN -> TARGET', async () => {
  const file = tmpPath();
  await seedOpen(file);
  const res = await runShadowV1LiveRevaluationCycle(
    deps(file, { bars: () => [bar(D0 + 2 * BAR_MS, 100, 108.5, 99, 108)] }, D0 + 3 * BAR_MS)
  );
  assert.equal(res.changed, 1);
  const rec = loadRecords(file).records[0];
  assert.equal(rec.status, 'TARGET');
  assert.equal(rec.exitPrice, 108);
});

test('ciclo: OPEN -> STOP', async () => {
  const file = tmpPath();
  await seedOpen(file);
  await runShadowV1LiveRevaluationCycle(
    deps(file, { bars: () => [bar(D0 + 2 * BAR_MS, 100, 100.5, 94, 94.5)] }, D0 + 3 * BAR_MS)
  );
  const rec = loadRecords(file).records[0];
  assert.equal(rec.status, 'STOP');
  assert.equal(rec.r, -1);
});

test('ciclo: OPEN -> EXPIRED a sessione chiusa', async () => {
  const file = tmpPath();
  await seedOpen(file);
  await runShadowV1LiveRevaluationCycle(
    deps(
      file,
      { bars: () => [bar(D0 + BAR_MS, 100, 101, 99, 100.5), bar(D0 + 2 * BAR_MS, 100.5, 101, 99.5, 100.25)] },
      CLOSE + BAR_MS
    )
  );
  const rec = loadRecords(file).records[0];
  assert.equal(rec.status, 'EXPIRED');
  assert.equal(rec.exitPrice, 100.25);
});

test('ciclo: PENDING_FILL -> NOT_FILLED a sessione chiusa senza fill', async () => {
  const file = tmpPath();
  await seedPending(file);
  await runShadowV1LiveRevaluationCycle(
    deps(file, { bars: () => [bar(D0 + BAR_MS, 90, 91, 89, 90.5)] }, CLOSE + BAR_MS)
  );
  const rec = loadRecords(file).records[0];
  assert.equal(rec.status, 'NOT_FILLED');
});

test('ciclo: un terminale non cambia e il file resta identico', async () => {
  const file = tmpPath();
  await seedOpen(file);
  await runShadowV1LiveRevaluationCycle(
    deps(file, { bars: () => [bar(D0 + 2 * BAR_MS, 100, 108.5, 99, 108)] }, D0 + 3 * BAR_MS)
  );
  const before = fs.readFileSync(file, 'utf8');
  const res = await runShadowV1LiveRevaluationCycle(
    deps(file, { bars: () => [bar(D0 + 3 * BAR_MS, 100, 109, 94, 94)] }, CLOSE + BAR_MS)
  );
  assert.equal(res.changed, 0);
  assert.equal(res.written, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('riavvio con archivio barre vuoto: record non terminale invariato, nessuna eccezione', async () => {
  const file = tmpPath();
  await seedPending(file);
  const before = fs.readFileSync(file, 'utf8');
  clearShadowV1LiveBarsForTest();
  const res = await runShadowV1LiveRevaluationCycle(deps(file, { bars: () => [] }, D0 + 2 * BAR_MS));
  assert.equal(res.evaluated, 1);
  assert.equal(res.changed, 0);
  assert.equal(res.written, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('sessione chiusa con archivio barre vuoto: NOT_FILLED (comportamento documentato)', async () => {
  const file = tmpPath();
  await seedPending(file);
  clearShadowV1LiveBarsForTest();
  const res = await runShadowV1LiveRevaluationCycle(deps(file, { bars: () => [] }, CLOSE + 1));
  assert.equal(res.changed, 1);
  assert.equal(loadRecords(file).records[0].status, 'NOT_FILLED');
});

test('riga corrotta nel file: ignorata, il ciclo prosegue', async () => {
  const file = tmpPath();
  await seedPending(file);
  fs.appendFileSync(file, '{ non json\n', 'utf8');
  const res = await runShadowV1LiveRevaluationCycle(
    deps(file, { bars: () => [bar(D0 + BAR_MS, 100, 101, 99, 100.5)] }, D0 + 2 * BAR_MS)
  );
  assert.equal(res.changed, 1);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'la riga corrotta non viene riscritta');
  assert.equal(loadRecords(file).records[0].status, 'OPEN');
});

// --- Isolamento errori (F6) ---------------------------------------------------

test('persistenza ko: risposta 200 controllata, nessuna eccezione', async () => {
  const file = tmpPath();
  const warnings: string[] = [];
  const res = await post(
    deps(file, {
      writeRecords: () => ({ ok: false as const, error: 'EACCES simulato' }),
      warn: (m) => warnings.push(m),
    }),
    validBody()
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.persistence, 'failed');
  assert.equal(res.body.persisted, false);
  assert.ok(warnings.some((w) => w.includes('persistenza fallita')));
});

test('persistenza ko nel ciclo: nessuna eccezione, written false', async () => {
  const file = tmpPath();
  await seedPending(file);
  const warnings: string[] = [];
  const res = await runShadowV1LiveRevaluationCycle(
    deps(
      file,
      {
        bars: () => [bar(D0 + BAR_MS, 100, 101, 99, 100.5)],
        writeRecords: () => ({ ok: false as const, error: 'EACCES simulato' }),
        warn: (m) => warnings.push(m),
      },
      D0 + 2 * BAR_MS
    )
  );
  assert.equal(res.written, false);
  assert.ok(warnings.some((w) => w.includes('persistenza fallita')));
});

test('eccezione nella sorgente barre: catturata, console.warn, nessuna propagazione', async () => {
  const file = tmpPath();
  const warnings: string[] = [];
  const res = await post(
    deps(file, {
      bars: () => {
        throw new Error('sorgente rotta');
      },
      warn: (m) => warnings.push(m),
    }),
    validBody()
  );
  assert.equal(res.status, 500);
  assert.equal(res.body.status, 'internal_error');
  assert.ok(warnings.some((w) => w.includes('sorgente rotta')));
});

test('eccezione nella sorgente barre dentro il ciclo: catturata, risultato vuoto', async () => {
  const file = tmpPath();
  await seedPending(file);
  const warnings: string[] = [];
  const res = await runShadowV1LiveRevaluationCycle(
    deps(
      file,
      {
        bars: () => {
          throw new Error('sorgente rotta');
        },
        warn: (m) => warnings.push(m),
      },
      D0 + 2 * BAR_MS
    )
  );
  assert.deepEqual(res, { evaluated: 0, changed: 0, written: false });
  assert.ok(warnings.some((w) => w.includes('sorgente rotta')));
});

test('errore in lettura: catturato, nessuna eccezione verso il chiamante', async () => {
  const file = tmpPath();
  const warnings: string[] = [];
  const res = await post(
    deps(file, {
      readRecords: () => {
        throw new Error('disco sparito');
      },
      warn: (m) => warnings.push(m),
    }),
    validBody()
  );
  assert.equal(res.status, 500);
  assert.ok(warnings.some((w) => w.includes('disco sparito')));
});

// --- Purezza e determinismo ---------------------------------------------------

test('il handler non muta il body in ingresso', async () => {
  const file = tmpPath();
  const body = validBody();
  const snapshot = JSON.stringify(body);
  await post(deps(file), body);
  assert.equal(JSON.stringify(body), snapshot);
});

test('determinismo: stesso clock e stesso input danno la stessa risposta', async () => {
  const a = tmpPath();
  const b = tmpPath();
  const first = await post(deps(a), validBody());
  const second = await post(deps(b), validBody());
  assert.deepEqual(first, second);
});

// --- Wiring con server.ts (aggiunte isolate) ----------------------------------

test('server.ts: una sola alimentazione barre e una sola registrazione', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('../../../server.ts', import.meta.url)),
    'utf8'
  );
  const feed = source.match(/recordBarsForShadowV1Live\(ticker, market, barsForShadowV2\);/g) ?? [];
  assert.equal(feed.length, 1, 'una sola riga additiva di alimentazione');
  const registrations = source.match(/registerShadowV1LiveCollector\(app\);/g) ?? [];
  assert.equal(registrations.length, 1, 'una sola registrazione');
  assert.ok(
    source.includes(
      "import { recordBarsForShadowV1Live, registerShadowV1LiveCollector } from './src/server/shadowV1LiveCollector';"
    ),
    'import dedicato presente'
  );
  // La riga di alimentazione non crea timer ne' scritture: la funzione ritorna
  // subito a flag OFF (test dedicato sopra).
  assert.ok(source.includes('recordBarsForShadowV1Live(ticker, market, barsForShadowV2);'));
});

// --- Archivio barre -----------------------------------------------------------

test('archivio: solo barre chiuse (t + 300000 <= now)', () => {
  const now = D0 + 3 * BAR_MS;
  recordBarsForShadowV1Live(
    'AAPL',
    'US',
    [
      bar(D0, 100, 101, 99, 100.5),
      bar(now - BAR_MS, 101, 102, 100, 101.5),
      bar(now, 102, 103, 101, 102.5),
    ],
    now,
    ON
  );
  const bars = barsForShadowV1Live('AAPL', 'US');
  assert.equal(bars.length, 2);
  assert.deepEqual(bars.map((b) => b.t), [D0, now - BAR_MS]);
});

test('archivio: merge per t, vince l\u2019ultima barra in input', () => {
  recordBarsForShadowV1Live('AAPL', 'US', [bar(D0, 100, 101, 99, 100.5)], D0 + 2 * BAR_MS, ON);
  recordBarsForShadowV1Live('AAPL', 'US', [bar(D0, 100, 102, 99, 101.5)], D0 + 2 * BAR_MS, ON);
  const bars = barsForShadowV1Live('AAPL', 'US');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].c, 101.5);
});

test('archivio: tetto di 600 barre, restano le piu\u2019 recenti', () => {
  const now = D0 + 1000 * BAR_MS;
  const many: ShadowV1LiveBar[] = Array.from({ length: 700 }, (_, i) =>
    bar(now - (700 - i) * BAR_MS, 100, 101, 99, 100.5)
  );
  recordBarsForShadowV1Live('AAPL', 'US', many, now, ON);
  const bars = barsForShadowV1Live('AAPL', 'US');
  assert.equal(bars.length, SHADOW_V1_LIVE_MAX_BARS_PER_TICKER);
  assert.equal(bars[0].t, many[100].t);
  assert.equal(bars.at(-1)?.t, many.at(-1)?.t);
});

test('archivio: barre invalide scartate', () => {
  const now = D0 + 2 * BAR_MS;
  recordBarsForShadowV1Live(
    'AAPL',
    'US',
    [
      bar(D0, 100, 99, 101, 100), // h < l
      bar(D0 + BAR_MS, 0, 101, 99, 100.5), // o <= 0
      bar(Number.NaN, 100, 101, 99, 100.5),
    ],
    now,
    ON
  );
  assert.deepEqual(barsForShadowV1Live('AAPL', 'US'), []);
});

test('archivio: flag OFF non scrive nulla', () => {
  recordBarsForShadowV1Live('AAPL', 'US', [bar(D0, 100, 101, 99, 100.5)], D0 + 2 * BAR_MS, OFF);
  assert.deepEqual(barsForShadowV1Live('AAPL', 'US'), []);
});

test('archivio: reset vuota tutto', () => {
  recordBarsForShadowV1Live('AAPL', 'US', [bar(D0, 100, 101, 99, 100.5)], D0 + 2 * BAR_MS, ON);
  assert.equal(barsForShadowV1Live('AAPL', 'US').length, 1);
  clearShadowV1LiveBarsForTest();
  assert.equal(barsForShadowV1Live('AAPL', 'US').length, 0);
});

test('archivio: ticker e mercati restano separati', () => {
  recordBarsForShadowV1Live('AAPL', 'US', [bar(D0, 100, 101, 99, 100.5)], D0 + 2 * BAR_MS, ON);
  assert.equal(barsForShadowV1Live('AAPL', 'EU').length, 0);
  assert.equal(barsForShadowV1Live('MSFT', 'US').length, 0);
});

test('archivio: la copia restituita non permette di mutare lo stato interno', () => {
  recordBarsForShadowV1Live('AAPL', 'US', [bar(D0, 100, 101, 99, 100.5)], D0 + 2 * BAR_MS, ON);
  const copy = barsForShadowV1Live('AAPL', 'US');
  copy[0].c = 999;
  assert.equal(barsForShadowV1Live('AAPL', 'US')[0].c, 100.5);
});
