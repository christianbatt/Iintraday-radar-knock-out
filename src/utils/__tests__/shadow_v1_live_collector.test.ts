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
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  barsForShadowV1Live,
  clearShadowV1LiveBarsForTest,
  createObserveHandler,
  createShadowV1LiveStoreQueue,
  fetchYahooMissingBarsForShadowV1Live,
  isShadowV1LiveOriginAllowed,
  observeShadowV1LiveFromServer,
  shadowV1LiveBodyLimitErrorHandler,
  shadowV1LiveBodyLimitParser,
  SHADOW_V1_LIVE_ALLOWED_ORIGINS_ENV,
  SHADOW_V1_LIVE_BAR_MS,
  SHADOW_V1_LIVE_BARS_PATH,
  SHADOW_V1_LIVE_RATE_MAP_MAX_ENTRIES,
  SHADOW_V1_LIVE_RATE_WINDOW_MS,
  SHADOW_V1_LIVE_SERVER_CLIENT_KEY,
  SHADOW_V1_LIVE_SOURCE_CLIENT,
  SHADOW_V1_LIVE_SOURCE_SERVER_SCANNER,
  checkShadowV1LiveBarCoverage,
  getShadowV1LiveCoverageStats,
  isShadowV1LiveCollectEnabled,
  loadShadowV1LiveBarsFromDisk,
  parseObservePayload,
  recordBarsForShadowV1Live,
  registerShadowV1LiveCollector,
  resetShadowV1LiveCoverageStatsForTest,
  runShadowV1LiveRevaluationCycle,
  shadowV1LiveCoverageBlock,
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
  readYahooCrumb,
  resetYahooCrumbCache,
  resolveYahooCrumbOnce,
  storeYahooCrumb,
  YAHOO_CRUMB_TTL_MS,
  type YahooCrumbPair,
} from '../../server/yahooCrumbCache';
import {
  loadRecords,
  SHADOW_V1_LIVE_MODULE_VERSION,
  SHADOW_V1_LIVE_SIGNALS_PATH,
  SHADOW_V1_LIVE_STORE_VERSION,
  type PersistedShadowV1LiveRecord,
} from '../../server/shadowV1LiveStore';
import { shadowV1LiveKeyOf, type ShadowV1LiveBar } from '../../knowledge/shadowV1Live';

const BAR_MS = 5 * 60 * 1000;
const D0 = Date.UTC(2026, 2, 16, 14, 0, 0); // lunedi'
const CLOSE = D0 + 6 * 60 * 60 * 1000; // 16:00 EDT = 20:00Z
const ISO_D0 = new Date(D0).toISOString();

const ON = { [SHADOW_V1_LIVE_COLLECT_ENV]: '1' };
/** Spento esplicitamente: il default ora e' ON, quindi OFF va dichiarato. */
const OFF = { [SHADOW_V1_LIVE_COLLECT_ENV]: '0' };

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
  resetShadowV1LiveCoverageStatsForTest();
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

test('flag: acceso di default, spento solo con "0" e "false"', () => {
  // ON: variabile assente, stringa vuota e qualunque valore diverso da 0/false.
  assert.equal(isShadowV1LiveCollectEnabled(undefined), true, 'env assente = ON');
  assert.equal(isShadowV1LiveCollectEnabled({}), true, 'variabile assente = ON');
  for (const value of ['1', 'true', '', ' on ', 'TRUE', ' true', 'yes', '2']) {
    assert.equal(
      isShadowV1LiveCollectEnabled({ [SHADOW_V1_LIVE_COLLECT_ENV]: value }),
      true,
      `valore ${JSON.stringify(value)} deve lasciare il collector acceso`
    );
  }
  // OFF: solo 0/false, con trim e case-insensitive.
  for (const value of ['0', 'false', ' FALSE ', 'False', '0 ']) {
    assert.equal(
      isShadowV1LiveCollectEnabled({ [SHADOW_V1_LIVE_COLLECT_ENV]: value }),
      false,
      `valore ${JSON.stringify(value)} deve spegnere il collector`
    );
  }
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

/** Barre contigue a passo 300000 ms: copertura piena richiesta dalla guardia. */
function contiguousBars(
  fromTs: number,
  count: number,
  ohlc: (i: number) => { o: number; h: number; l: number; c: number }
): ShadowV1LiveBar[] {
  return Array.from({ length: count }, (_, i) => {
    const p = ohlc(i);
    return bar(fromTs + i * BAR_MS, p.o, p.h, p.l, p.c);
  });
}

/** D0+1 barra .. D0+71 barre: termina esattamente alla chiusura di sessione. */
const SESSION_BARS = 71;

/** Serie completa che non tocca mai l'entry 100 (nessun fill). */
function fullSessionNoFill(): ShadowV1LiveBar[] {
  return contiguousBars(D0 + BAR_MS, SESSION_BARS, () => ({ o: 90, h: 91, l: 89, c: 90.5 }));
}

/** Serie completa con fill sulla prima barra e uscita al close dell'ultima. */
function fullSessionOpen(): ShadowV1LiveBar[] {
  return contiguousBars(D0 + BAR_MS, SESSION_BARS, (i) => {
    if (i === 0) return { o: 100, h: 101, l: 99, c: 100.5 };
    if (i === SESSION_BARS - 1) return { o: 100.5, h: 101, l: 99.5, c: 100.25 };
    return { o: 100.5, h: 101, l: 99.5, c: 100.4 };
  });
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
    deps(
      file,
      {
        bars: () => [
          bar(D0 + BAR_MS, 100, 101, 99, 100.5),
          bar(D0 + 2 * BAR_MS, 100, 108.5, 99, 108),
        ],
      },
      D0 + 3 * BAR_MS
    )
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
    deps(
      file,
      {
        bars: () => [
          bar(D0 + BAR_MS, 100, 101, 99, 100.5),
          bar(D0 + 2 * BAR_MS, 100, 100.5, 94, 94.5),
        ],
      },
      D0 + 3 * BAR_MS
    )
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
      { bars: () => fullSessionOpen() },
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
    deps(file, { bars: () => fullSessionNoFill() }, CLOSE + BAR_MS)
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

test('sessione chiusa con archivio barre vuoto: record invariato e insufficient_bars', async () => {
  const file = tmpPath();
  await seedPending(file);
  clearShadowV1LiveBarsForTest();
  const before = fs.readFileSync(file, 'utf8');
  const res = await runShadowV1LiveRevaluationCycle(deps(file, { bars: () => [] }, CLOSE + 1));
  assert.equal(res.changed, 0);
  assert.equal(res.written, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nessun NOT_FILLED su barre assenti');
  assert.equal(loadRecords(file).records[0].status, 'PENDING_FILL');
  assert.equal(getShadowV1LiveCoverageStats().insufficientBars, 1);
  assert.equal(getShadowV1LiveCoverageStats().byReason.no_bars, 1);
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

// --- Guardia di copertura barre (C3) -----------------------------------------

test('copertura: buco in mezzo blocca il cambio di stato (TARGET non osservato)', async () => {
  const file = tmpPath();
  await seedOpen(file);
  const before = fs.readFileSync(file, 'utf8');
  const res = await runShadowV1LiveRevaluationCycle(
    deps(
      file,
      {
        bars: () => [
          bar(D0 + BAR_MS, 100, 101, 99, 100.5),
          bar(D0 + 2 * BAR_MS, 100, 101, 99, 100.5),
          // manca D0 + 3 barre, poi il target
          bar(D0 + 4 * BAR_MS, 100, 108.5, 99, 108),
        ],
      },
      D0 + 5 * BAR_MS
    )
  );
  assert.equal(res.changed, 0);
  assert.equal(res.written, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(loadRecords(file).records[0].status, 'OPEN');
  assert.equal(getShadowV1LiveCoverageStats().byReason.interior_hole, 1);
});

test('copertura: archivio che non copre l\\u2019inizio blocca anche STOP/TARGET contigui', async () => {
  const file = tmpPath();
  await seedOpen(file);
  const res = await runShadowV1LiveRevaluationCycle(
    deps(
      file,
      {
        bars: () => [
          bar(D0 + 2 * BAR_MS, 100, 101, 99, 100.5),
          bar(D0 + 3 * BAR_MS, 100, 108.5, 99, 108),
        ],
      },
      D0 + 4 * BAR_MS
    )
  );
  assert.equal(res.changed, 0);
  assert.equal(loadRecords(file).records[0].status, 'OPEN');
  assert.equal(getShadowV1LiveCoverageStats().byReason.leading_hole, 1);
});

test('copertura: STOP con buco prima della barra di uscita non viene applicato', async () => {
  const file = tmpPath();
  await seedOpen(file);
  const res = await runShadowV1LiveRevaluationCycle(
    deps(
      file,
      {
        bars: () => [
          bar(D0 + BAR_MS, 100, 101, 99, 100.5),
          bar(D0 + 2 * BAR_MS, 100, 101, 99, 100.5),
          bar(D0 + 4 * BAR_MS, 100, 100.5, 94, 94.5),
        ],
      },
      D0 + 5 * BAR_MS
    )
  );
  assert.equal(res.changed, 0);
  const rec = loadRecords(file).records[0];
  assert.equal(rec.status, 'OPEN');
  assert.equal(rec.r, null);
});

test('copertura: copre l\\u2019inizio ma non la fine di sessione: nessun EXPIRED', async () => {
  const file = tmpPath();
  await seedOpen(file);
  const before = fs.readFileSync(file, 'utf8');
  const partial = contiguousBars(D0 + BAR_MS, SESSION_BARS - 1, (i) =>
    i === 0 ? { o: 100, h: 101, l: 99, c: 100.5 } : { o: 100.5, h: 101, l: 99.5, c: 100.4 }
  );
  const res = await runShadowV1LiveRevaluationCycle(
    deps(file, { bars: () => partial }, CLOSE + 1)
  );
  assert.equal(res.changed, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(loadRecords(file).records[0].status, 'OPEN');
});

test('copertura: copre l\\u2019inizio ma non la fine: nessun NOT_FILLED', async () => {
  const file = tmpPath();
  await seedPending(file);
  const partial = fullSessionNoFill().slice(0, SESSION_BARS - 3);
  const res = await runShadowV1LiveRevaluationCycle(
    deps(file, { bars: () => partial }, CLOSE + 1)
  );
  assert.equal(res.changed, 0);
  assert.equal(loadRecords(file).records[0].status, 'PENDING_FILL');
});

test('riavvio: archivio vuoto non avanza, serie completa si\\u2019', async () => {
  const file = tmpPath();
  await seedPending(file);
  const empty = await runShadowV1LiveRevaluationCycle(
    deps(file, { bars: () => [] }, CLOSE + 1)
  );
  assert.equal(empty.changed, 0);
  assert.equal(loadRecords(file).records[0].status, 'PENDING_FILL');

  const filled = await runShadowV1LiveRevaluationCycle(
    deps(file, { bars: () => fullSessionNoFill() }, CLOSE + 2 * BAR_MS)
  );
  assert.equal(filled.changed, 1);
  assert.equal(loadRecords(file).records[0].status, 'NOT_FILLED');
});

test('copertura: funzione pura, deterministica e senza mutare l\\u2019input', () => {
  const base = { decidedAtMs: D0, sessionCloseMs: CLOSE, nowMs: CLOSE + BAR_MS };
  const unordered = [
    bar(D0 + 2 * BAR_MS, 100, 101, 99, 100.5),
    bar(D0 + BAR_MS, 100, 101, 99, 100.5),
    bar(D0 + 3 * BAR_MS, 100, 101, 99, 100.5),
  ];
  const snapshot = JSON.stringify(unordered);
  const first = checkShadowV1LiveBarCoverage({ ...base, bars: unordered });
  assert.equal(
    JSON.stringify(unordered),
    snapshot,
    'le barre in input non vengono mutate dalla prima chiamata'
  );
  const second = checkShadowV1LiveBarCoverage({ ...base, bars: unordered });
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.equal(first.firstBarTs, D0 + BAR_MS);
  assert.equal(first.lastBarTs, D0 + 3 * BAR_MS);
  assert.equal(first.expectedLastBarTs, CLOSE - BAR_MS);
  assert.equal(first.barsUsed, 3);

  assert.equal(checkShadowV1LiveBarCoverage({ ...base, bars: [] }).reason, 'no_bars');
  assert.equal(
    checkShadowV1LiveBarCoverage({ ...base, bars: [bar(D0 + 2 * BAR_MS, 100, 101, 99, 100.5)] }).reason,
    'leading_hole'
  );
  assert.equal(
    checkShadowV1LiveBarCoverage({
      ...base,
      bars: [bar(D0 + BAR_MS, 100, 101, 99, 100.5), bar(D0 + 3 * BAR_MS, 100, 101, 99, 100.5)],
    }).reason,
    'interior_hole'
  );
  assert.equal(
    checkShadowV1LiveBarCoverage({ decidedAtMs: Number.NaN, sessionCloseMs: CLOSE, nowMs: CLOSE, bars: [] }).reason,
    'invalid_input'
  );
});

test('copertura: blocco dipende da esito proposto e stato corrente', () => {
  const ok = {
    ok: true,
    reason: 'ok' as const,
    firstBarTs: D0 + BAR_MS,
    lastBarTs: CLOSE - BAR_MS,
    expectedLastBarTs: CLOSE - BAR_MS,
    barsUsed: 71,
  };
  const missing = { ...ok, ok: false, reason: 'no_bars' as const, firstBarTs: null, lastBarTs: null, barsUsed: 0 };
  const partialOk = { ...ok, lastBarTs: CLOSE - 2 * BAR_MS };

  // inserimento non terminale: sempre permesso
  assert.equal(
    shadowV1LiveCoverageBlock({ proposedStatus: 'PENDING_FILL', currentStatus: null, coverage: missing }),
    null
  );
  // cambio di stato non terminale: richiede copertura
  assert.equal(
    shadowV1LiveCoverageBlock({ proposedStatus: 'OPEN', currentStatus: 'PENDING_FILL', coverage: missing }),
    'no_bars'
  );
  // terminale di prezzo: copertura di contiguita' sufficiente
  assert.equal(
    shadowV1LiveCoverageBlock({ proposedStatus: 'TARGET', currentStatus: 'OPEN', coverage: partialOk }),
    null
  );
  // terminale di sessione: serve anche la fine sessione
  assert.equal(
    shadowV1LiveCoverageBlock({ proposedStatus: 'EXPIRED', currentStatus: 'OPEN', coverage: partialOk }),
    'interior_hole'
  );
  assert.equal(
    shadowV1LiveCoverageBlock({ proposedStatus: 'NOT_FILLED', currentStatus: 'PENDING_FILL', coverage: ok }),
    null
  );
});

test('route: insufficient_bars con HTTP 200, nessuna scrittura e log limitato', async () => {
  // Osservazione tardiva (a sessione chiusa) senza barre: il nucleo proporrebbe
  // NOT_FILLED, la guardia lo blocca e non nasce alcun record.
  const file = tmpPath();
  const warnings: string[] = [];
  const applyWarnings = (m: string) => warnings.push(m);
  const first = await createObserveHandler(
    deps(file, { bars: () => [], warn: applyWarnings }, CLOSE + 1)
  )({ body: validBody(), ip: '5.5.5.5' });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'ok');
  assert.equal(first.body.outcome, 'insufficient_bars');
  assert.equal(first.body.persisted, false);
  assert.equal(first.body.coverage, 'no_bars');
  assert.equal(fs.existsSync(file), false, 'nessun file creato su copertura assente');
  assert.equal(warnings.length, 1, 'un solo warn nel primo evento');
  assert.match(warnings[0], /copertura barre insufficiente/);

  const second = await createObserveHandler(
    deps(file, { bars: () => [], warn: applyWarnings }, CLOSE + 1000)
  )({ body: validBody(), ip: '5.5.5.5' });
  assert.equal(second.body.outcome, 'insufficient_bars');
  assert.equal(warnings.length, 1, 'warn limitato in frequenza');
  assert.equal(getShadowV1LiveCoverageStats().insufficientBars, 2);
  assert.equal(fs.existsSync(file), false);
});

test('route: osservazione tardiva con serie completa persiste EXPIRED', async () => {
  const file = tmpPath();
  const res = await createObserveHandler(
    deps(file, { bars: () => fullSessionOpen() }, CLOSE + BAR_MS)
  )({ body: validBody(), ip: '6.6.6.6' });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'EXPIRED');
  assert.equal(res.body.persisted, true);
  assert.equal(loadRecords(file).records[0].status, 'EXPIRED');
});

test('route: la guardia e\\u2019 iniettabile (stub con copertura piena applica l\\u2019esito)', async () => {
  const file = tmpPath();
  await seedOpen(file);
  const res = await runShadowV1LiveRevaluationCycle(
    deps(
      file,
      {
        bars: () => [bar(D0 + 3 * BAR_MS, 100, 108.5, 99, 108)],
        coverage: (input) => ({
          ok: true,
          reason: 'ok',
          firstBarTs: input.decidedAtMs + 1,
          lastBarTs: input.nowMs,
          expectedLastBarTs: input.sessionCloseMs - 1,
          barsUsed: 1,
        }),
      },
      D0 + 4 * BAR_MS
    )
  );
  assert.equal(res.changed, 1);
  assert.equal(loadRecords(file).records[0].status, 'TARGET');
});

test('rate limit: IP diversi non si limitano e oltre soglia arriva 429', async () => {
  const file = tmpPath();
  const handler = createObserveHandler(deps(file));
  const a: number[] = [];
  for (let i = 0; i < SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE; i += 1) {
    a.push((await handler({ body: validBody(), ip: '7.7.7.1' })).status);
  }
  assert.ok(a.every((s) => s === 200));
  assert.equal((await handler({ body: validBody(), ip: '7.7.7.1' })).status, 429);
  assert.equal((await handler({ body: validBody(), ip: '7.7.7.2' })).status, 200);
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
  // Import verificato per simboli e modulo, non per formattazione: la lista
  // puo' essere su piu' righe (P10 aggiunge i middleware del limite body).
  assert.match(
    source,
    /import\s*\{[^}]*\brecordBarsForShadowV1Live\b[^}]*\bregisterShadowV1LiveCollector\b[^}]*\}\s*from '\.\/src\/server\/shadowV1LiveCollector';/s,
    'import dedicato presente'
  );
  // La riga di alimentazione non crea timer ne' scritture: la funzione ritorna
  // subito a flag OFF (test dedicato sopra).
  assert.ok(source.includes('recordBarsForShadowV1Live(ticker, market, barsForShadowV2);'));
  assert.ok(
    source.includes("app.post('/api/shadow/v1-live/observe', requireApiAuth);"),
    'route POST protegge /api/shadow/v1-live/observe con requireApiAuth'
  );
  // SIC-2: il parser dedicato deve restare limitato al solo path della route e
  // deve precedere il parser globale (altrimenti il body e' gia' materializzato).
  assert.ok(
    source.includes('app.use(SHADOW_V1_LIVE_OBSERVE_PATH, shadowV1LiveBodyLimitParser(express.json));'),
    'parser dedicato montato sul solo path observe'
  );
  assert.ok(
    source.indexOf('shadowV1LiveBodyLimitParser(express.json)') <
      source.indexOf("app.use(express.json({ limit: '10mb' }));"),
    'il parser dedicato precede il parser globale'
  );
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

test('archivio su disco: ricarica le barre dopo clear/riavvio del collector', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1live-bars-'));
  try {
    const fakeApp = { post: () => {} };
    const first = registerShadowV1LiveCollector(fakeApp, {
      root: tmpDir,
      env: ON,
      fetchMissingBars: null,
      timers: { setInterval: () => ({}), clearInterval: () => {} },
    });
    assert.equal(first.enabled, true);
    recordBarsForShadowV1Live('ENI.MI', 'EU', [bar(D0, 14, 14.2, 13.9, 14.1)], D0 + 2 * BAR_MS, ON);
    assert.ok(fs.existsSync(path.join(tmpDir, 'artifacts', 'shadow_v1_live', 'bars.json')));

    // Simula riavvio del processo
    clearShadowV1LiveBarsForTest();
    assert.equal(barsForShadowV1Live('ENI.MI', 'EU').length, 0);

    const second = registerShadowV1LiveCollector(fakeApp, {
      root: tmpDir,
      env: ON,
      fetchMissingBars: null,
      timers: { setInterval: () => ({}), clearInterval: () => {} },
    });
    assert.equal(second.enabled, true);
    const reloaded = barsForShadowV1Live('ENI.MI', 'EU');
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].c, 14.1);
  } finally {
    clearShadowV1LiveBarsForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('backfill autonomo: risolve record EU illiquido con buchi a volume 0 dopo la chiusura (nessun blocco stale)', async () => {
  const file = tmpPath();
  await seedOpen(file);
  const backfilledBars: ShadowV1LiveBar[] = [
    bar(D0 + BAR_MS, 100, 101, 99, 100.5),
    // Buco di 15 minuti (3 candele a volume 0 omesse da Yahoo) e asta prima del close
    bar(D0 + 5 * BAR_MS, 100.5, 108.5, 100.2, 108),
  ];
  const res = await runShadowV1LiveRevaluationCycle(
    deps(
      file,
      {
        bars: () => [],
        fetchMissingBars: async () => ({ bars: backfilledBars, authoritative: true }),
      },
      CLOSE + 5 * BAR_MS
    )
  );
  assert.equal(res.changed, 1);
  assert.equal(loadRecords(file).records[0].status, 'TARGET');
});

test('backfill autonomo: chiude EXPIRED anche senza l’ultima candela esatta di griglia se feed autorevole', async () => {
  const file = tmpPath();
  await seedOpen(file);
  const sparseBars: ShadowV1LiveBar[] = [
    bar(D0 + BAR_MS, 100, 101, 99, 100.2),
    bar(CLOSE - 3 * BAR_MS, 100.2, 102, 99.8, 101.5),
  ];
  const res = await runShadowV1LiveRevaluationCycle(
    deps(
      file,
      {
        bars: () => [],
        fetchMissingBars: async () => ({ bars: sparseBars, authoritative: true }),
      },
      CLOSE + 5 * BAR_MS
    )
  );
  assert.equal(res.changed, 1);
  const rec = loadRecords(file).records[0];
  assert.equal(rec.status, 'EXPIRED');
  assert.equal(rec.exitPrice, 101.5);
});

test('backfill non autorevole: barre parziali non cambiano stato e restano conteggiate come copertura insufficiente', async () => {
  const file = tmpPath();
  await seedOpen(file);
  const before = fs.readFileSync(file, 'utf8');
  // Feed non autorevole con un buco interno: nessuna tolleranza `allowExchangeGaps`.
  const sparseBars: ShadowV1LiveBar[] = [
    bar(D0 + BAR_MS, 100, 101, 99, 100.2),
    bar(D0 + 5 * BAR_MS, 100.2, 108, 99.8, 107.5),
  ];
  const res = await runShadowV1LiveRevaluationCycle(
    deps(
      file,
      {
        bars: () => [],
        fetchMissingBars: async () => ({ bars: sparseBars, authoritative: false }),
      },
      CLOSE + 5 * BAR_MS
    )
  );
  assert.equal(res.evaluated, 1);
  assert.equal(res.changed, 0, 'senza ultima barra di griglia il backfill non autorevole non chiude il record');
  assert.equal(res.written, false, 'nessuna scrittura quando nessun record cambia');
  assert.equal(loadRecords(file).records[0].status, 'OPEN', 'lo stato resta invariato');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'il file attivo non viene riscritto');
  const stats = getShadowV1LiveCoverageStats();
  assert.equal(stats.byReason.interior_hole, 1, 'il buco resta contato come copertura insufficiente');
});

test('backfill non autorevole: barre contigue complete vengono accettate (comportamento attuale)', async () => {
  const file = tmpPath();
  await seedOpen(file);
  // Stesse barre di una sessione completa, ma dichiarate non autorevoli: la guardia
  // accetta la contiguita' piena e il record chiude comunque.
  const res = await runShadowV1LiveRevaluationCycle(
    deps(
      file,
      {
        bars: () => [],
        fetchMissingBars: async () => ({ bars: fullSessionOpen(), authoritative: false }),
      },
      CLOSE + 5 * BAR_MS
    )
  );
  assert.equal(res.changed, 1);
  assert.equal(res.written, true);
  const rec = loadRecords(file).records[0];
  assert.equal(rec.status, 'EXPIRED');
});

test('rate limit: usa clientKey UID distinto dietro IP condiviso e normalizza ::ffff:', async () => {
  const file = tmpPath();
  const handler = createObserveHandler(deps(file));
  for (let i = 0; i < SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE; i += 1) {
    const r = await handler({ body: validBody(), ip: '127.0.0.1', clientKey: 'uid:user-A' });
    assert.equal(r.status, 200);
  }
  assert.equal(
    (await handler({ body: validBody(), ip: '127.0.0.1', clientKey: 'uid:user-A' })).status,
    429
  );
  // Altro utente sullo stesso IP ha il proprio bucket
  assert.equal(
    (await handler({ body: validBody(), ip: '127.0.0.1', clientKey: 'uid:user-B' })).status,
    200
  );
  // ::ffff:10.0.0.9 e 10.0.0.9 condividono lo stesso bucket IP normalizzato
  for (let i = 0; i < SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE; i += 1) {
    assert.equal((await handler({ body: validBody(), ip: '::ffff:10.0.0.9' })).status, 200);
  }
  assert.equal((await handler({ body: validBody(), ip: '10.0.0.9' })).status, 429);
});

// --- P9 / CON-1: coda unica fra route e ciclo ---------------------------------

const KEY_AAPL = shadowV1LiveKeyOf('AAPL', 100, 95, D0);

type StoredState = {
  stored: PersistedShadowV1LiveRecord[];
  slowReads: boolean;
  reads: number;
  writes: number;
};

/**
 * Store in memoria con I/O asincrono ritardato. Lo snapshot viene catturato
 * **all'ingresso** della lettura: senza serializzazione il ciclo legge uno stato
 * vecchio e, scrivendo dopo la POST, ne cancella l'inserimento. E' il lost
 * update di CON-1, reso deterministico dall'iniezione della latenza.
 */
function sharedStore(): {
  state: StoredState;
  io: Pick<CollectorDeps, 'readRecords' | 'writeRecords'>;
} {
  const state: StoredState = { stored: [], slowReads: false, reads: 0, writes: 0 };
  return {
    state,
    io: {
      readRecords: async () => {
        const snapshot = state.stored.map((r) => ({ ...r }));
        state.reads += 1;
        const delayMs = state.slowReads ? 25 : 1;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { records: snapshot, skipped: 0 };
      },
      writeRecords: async (_p: string, records: readonly PersistedShadowV1LiveRecord[]) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        state.stored = records.map((r) => ({ ...r }));
        state.writes += 1;
        return { ok: true as const };
      },
    },
  };
}

test('P9 coda unica: ciclo e POST concorrenti non perdono aggiornamenti', async () => {
  const file = tmpPath();
  const { state, io } = sharedStore();
  const queue = createShadowV1LiveStoreQueue();
  const nowMs = D0 + 30 * 60_000;
  let barsOn = false;
  const depsValue = deps(file, {
    queue,
    now: () => nowMs,
    bars: () => (barsOn ? [bar(D0 + BAR_MS, 100, 101, 99, 100.5)] : []),
    ...io,
  });
  const handler = createObserveHandler(depsValue);

  const seed = await handler({ body: validBody(), ip: 'p9' });
  assert.equal(seed.body.outcome, 'PENDING_FILL');
  assert.equal(state.stored.length, 1);

  barsOn = true;
  state.slowReads = true;
  const cycle = runShadowV1LiveRevaluationCycle(depsValue);
  await new Promise((resolve) => setTimeout(resolve, 1)); // il ciclo ha iniziato a leggere
  const post = handler({ body: validBody({ entry: 101 }), ip: 'p9' });

  const [cycleRes, postRes] = await Promise.all([cycle, post]);
  assert.equal(postRes.status, 200);
  assert.equal(postRes.body.persisted, true);
  assert.equal(state.stored.length, 2, 'nessun record perso fra ciclo e POST');
  const updated = state.stored.find((r) => r.key === KEY_AAPL);
  assert.ok(updated, 'il record del ciclo resta nel file');
  assert.equal(
    updated?.status,
    'OPEN',
    'lo stato avanzato dal ciclo non viene riportato indietro dalla POST con snapshot vecchio'
  );
  assert.ok(
    state.stored.some((r) => r.entry === 101),
    'il record inserito dalla POST concorrente resta nel file'
  );
  assert.equal(cycleRes.written, true);
  assert.equal(handler.queuePending(), 0, 'coda vuota a operazioni concluse');
});

test('P9 coda unica: piu\u2019 cicli e POST su chiavi diverse e sulla stessa chiave', async () => {
  const file = tmpPath();
  const { state, io } = sharedStore();
  const queue = createShadowV1LiveStoreQueue();
  let barsOn = false;
  const depsValue = deps(file, {
    queue,
    now: () => D0 + 30 * 60_000,
    bars: () => (barsOn ? [bar(D0 + BAR_MS, 100, 101, 99, 100.5)] : []),
    ...io,
  });
  const handler = createObserveHandler(depsValue);
  await handler({ body: validBody(), ip: 'p9' });

  barsOn = true;
  state.slowReads = true;
  await Promise.all([
    runShadowV1LiveRevaluationCycle(depsValue),
    handler({ body: validBody({ entry: 101 }), ip: 'p9' }),
    runShadowV1LiveRevaluationCycle(depsValue),
    handler({ body: validBody({ entry: 102 }), ip: 'p9' }),
    runShadowV1LiveRevaluationCycle(depsValue),
    handler({ body: validBody({ entry: 101 }), ip: 'p9' }),
  ]);

  assert.equal(state.stored.length, 3, 'tre chiavi distinte, nessun doppione e nessuna perdita');
  assert.deepEqual(
    state.stored.map((r) => r.entry).sort((a, b) => a - b),
    [100, 101, 102]
  );
  assert.equal(handler.queuePending(), 0);
});

test('P9 coda unica: un task che fallisce non blocca i successivi', async () => {
  const file = tmpPath();
  const queue = createShadowV1LiveStoreQueue();
  let writes = 0;
  const handler = createObserveHandler(
    deps(file, {
      queue,
      readRecords: () => ({ records: [], skipped: 0 }),
      writeRecords: () => {
        writes += 1;
        if (writes === 1) throw new Error('disco pieno');
        return { ok: true as const };
      },
    })
  );

  const first = await handler({ body: validBody(), ip: 'p9' });
  assert.equal(first.status, 500, 'il task che esplode diventa 500, non blocca la coda');
  const second = await handler({ body: validBody({ entry: 101 }), ip: 'p9' });
  assert.equal(second.status, 200);
  assert.equal(second.body.persisted, true);
  assert.equal(writes, 2);
  assert.equal(handler.queuePending(), 0);
});

// --- P9 / CON-3: tetto della mappa del rate limit -----------------------------

test('P9 rate limit: la mappa non cresce oltre il tetto dichiarato', async () => {
  const file = tmpPath();
  const handler = createObserveHandler(deps(file, { rateMapMaxEntries: 4 }));
  for (let i = 0; i < 12; i += 1) {
    // Body invalido: il conteggio del rate limit avviene prima del parse, nessun I/O.
    const res = await handler({ body: { ticker: 'X' }, ip: `9.9.9.${i}` });
    assert.equal(res.status, 400);
  }
  assert.ok(
    handler.rateLimitEntries() <= 4,
    `attese al massimo 4 voci, trovate ${handler.rateLimitEntries()}`
  );
  assert.equal(fs.existsSync(file), false, 'nessuna scrittura per richieste invalide');
});

// --- P10 SIC-1: controllo dell'origine ---------------------------------------

test('P10 origine: assente (client non browser) resta ammessa', async () => {
  const file = tmpPath();
  const res = await post(deps(file), validBody(), { host: 'app.example.tld' });
  assert.equal(res.status, 200);
});

test('P10 origine: stessa origine ammessa, origine diversa 403', async () => {
  const file = tmpPath();
  const same = await post(deps(file), validBody(), {
    origin: 'https://app.example.tld',
    host: 'app.example.tld',
  });
  assert.equal(same.status, 200);
  const loopback = await post(deps(file), validBody(), {
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1:3000',
  });
  assert.equal(loopback.status, 200);

  const bad = await post(deps(file), validBody({ ticker: 'MSFT' }), {
    origin: 'https://evil.example',
    host: 'app.example.tld',
  });
  assert.equal(bad.status, 403);
  assert.deepEqual(bad.body, { status: 'forbidden_origin', origin: 'https://evil.example' });

  const clean = tmpPath();
  const opaque = await post(deps(clean), validBody(), { origin: 'null', host: 'app.example.tld' });
  assert.equal(opaque.status, 403, 'origine opaca negata');
  const denied = await post(deps(clean), validBody(), {
    origin: 'https://evil.example',
    host: 'app.example.tld',
  });
  assert.equal(denied.status, 403);
  assert.equal(fs.existsSync(clean), false, 'nessuna scrittura per richieste rifiutate');
});

test('P10 origine: lista consentita da env, default vuoto', async () => {
  const file = tmpPath();
  const env = {
    ...ON,
    [SHADOW_V1_LIVE_ALLOWED_ORIGINS_ENV]: 'https://staging.example.tld, https://alt.example.tld/',
  };
  const listed = await post(deps(file, { env }), validBody(), {
    origin: 'https://staging.example.tld',
    host: 'app.example.tld',
  });
  assert.equal(listed.status, 200);
  const altSlash = await post(deps(file, { env }), validBody(), {
    origin: 'https://alt.example.tld',
    host: 'app.example.tld',
  });
  assert.equal(altSlash.status, 200, 'slash finale ignorato');

  const defaultEmpty = await post(deps(file, { env: ON }), validBody(), {
    origin: 'https://staging.example.tld',
    host: 'app.example.tld',
  });
  assert.equal(defaultEmpty.status, 403, 'senza env la lista e\' vuota');

  assert.equal(isShadowV1LiveOriginAllowed({ origin: 'https://A.example/', host: 'a.example' }).ok, true);
  assert.equal(
    isShadowV1LiveOriginAllowed({ origin: 'https://a.example', host: 'a.example:443' }).ok,
    false,
    'porta diversa = origine diversa'
  );
  assert.equal(isShadowV1LiveOriginAllowed({ origin: undefined }).ok, true);
  assert.equal(isShadowV1LiveOriginAllowed({ origin: '' }).ok, true);
});

test('P10 origine: flag OFF resta 404, nessun I/O', async () => {
  const file = tmpPath();
  const res = await post(deps(file, { env: OFF }), validBody(), {
    origin: 'https://evil.example',
    host: 'app.example.tld',
  });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { status: 'disabled', flag: SHADOW_V1_LIVE_COLLECT_ENV });
  assert.equal(fs.existsSync(file), false);
});

// --- P10 provenienza sui record ----------------------------------------------

function freshRoot(prefix: string): { root: string; signals: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(root);
  return { root, signals: path.join(root, 'artifacts', 'shadow_v1_live', 'signals.jsonl') };
}

const fakeTimers = {
  setInterval: () => ({ unref: () => {} }),
  clearInterval: () => {},
};

test('P10 provenienza: la route HTTP persiste source client', async () => {
  const { root, signals } = freshRoot('v1livep10route-');
  const captured: { route?: (req: unknown, res: unknown) => void } = {};
  const app = {
    post: (p: string, h: (req: unknown, res: unknown) => void) => {
      if (p === SHADOW_V1_LIVE_OBSERVE_PATH) captured.route = h;
    },
  };
  const registration = registerShadowV1LiveCollector(app, {
    root,
    env: ON,
    now: () => D0 + 30 * 60 * 1000,
    fetchMissingBars: null,
    timers: fakeTimers,
  });
  try {
    assert.ok(captured.route, 'route registrata');
    let out: { status?: number } = {};
    captured.route?.(
      {
        body: validBody(),
        ip: '7.7.7.7',
        headers: { host: 'app.example.tld', origin: 'https://app.example.tld' },
      },
      {
        locals: {},
        status: (code: number) => ({
          json: () => {
            out = { status: code };
          },
        }),
      }
    );
    const deadline = Date.now() + 3000;
    while (out.status === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(out.status, 200);
    const records = loadRecords(signals).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].source, SHADOW_V1_LIVE_SOURCE_CLIENT);
  } finally {
    registration.stop?.();
  }
});

test('P10 provenienza: lo scanner server-side persiste source server-scanner', async () => {
  const { root, signals } = freshRoot('v1livep10scan-');
  const registration = registerShadowV1LiveCollector(
    { post: () => {} },
    {
      root,
      env: ON,
      now: () => D0 + 30 * 60 * 1000,
      fetchMissingBars: null,
      timers: fakeTimers,
    }
  );
  try {
    const out = await observeShadowV1LiveFromServer(validBody());
    assert.equal(out?.status, 200);
  } finally {
    registration.stop?.();
  }
  const records = loadRecords(signals).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].source, SHADOW_V1_LIVE_SOURCE_SERVER_SCANNER);
});

// --- P10 SIC-2: limite di body per-route (express reale) ----------------------

function bodyOfSize(bytes: number): string {
  const empty = JSON.stringify({ pad: '' });
  return JSON.stringify({ pad: 'x'.repeat(bytes - Buffer.byteLength(empty)) });
}

test('P10 body: oltre 8192 B la route observe risponde 413 e non viene raggiunta', async () => {
  const app = express();
  // Stessa sequenza di server.ts:167-176 (parser dedicato + gestore errori
  // prima del parser globale da 10 MB).
  app.use(SHADOW_V1_LIVE_OBSERVE_PATH, shadowV1LiveBodyLimitParser(express.json));
  app.use(SHADOW_V1_LIVE_OBSERVE_PATH, shadowV1LiveBodyLimitErrorHandler());
  app.use(express.json({ limit: '10mb' }));
  let observeCalls = 0;
  app.post(SHADOW_V1_LIVE_OBSERVE_PATH, (_req, res) => {
    observeCalls += 1;
    res.status(200).json({ status: 'accepted' });
  });
  app.post('/api/altro', (_req, res) => res.status(200).json({ status: 'accepted' }));

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const send = (p: string, body: string) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  try {
    const huge = bodyOfSize(9 * 1024 * 1024);
    assert.equal(Buffer.byteLength(huge), 9 * 1024 * 1024);
    const big = await send(SHADOW_V1_LIVE_OBSERVE_PATH, huge);
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), {
      status: 'payload_too_large',
      maxBytes: SHADOW_V1_LIVE_MAX_BODY_BYTES,
    });
    assert.equal(observeCalls, 0, 'il corpo oltre il limite non raggiunge la route');

    const exact = bodyOfSize(SHADOW_V1_LIVE_MAX_BODY_BYTES);
    assert.equal(Buffer.byteLength(exact), SHADOW_V1_LIVE_MAX_BODY_BYTES);
    assert.equal((await send(SHADOW_V1_LIVE_OBSERVE_PATH, exact)).status, 200);
    assert.equal(observeCalls, 1, 'il corpo al limite raggiunge la route');

    const one = bodyOfSize(SHADOW_V1_LIVE_MAX_BODY_BYTES + 1);
    assert.equal((await send(SHADOW_V1_LIVE_OBSERVE_PATH, one)).status, 413);
    assert.equal(observeCalls, 1, 'un byte in piu\' non raggiunge la route');

    assert.equal((await send('/api/altro', huge)).status, 200, 'limite globale invariato (10 MB)');
  } finally {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// --- P11: valori dichiarati delle costanti (guardia di non regressione) -------

test('P11 costanti: valori dichiarati invariati', () => {
  assert.equal(SHADOW_V1_LIVE_OBSERVE_PATH, '/api/shadow/v1-live/observe');
  assert.equal(SHADOW_V1_LIVE_MAX_BODY_BYTES, 8192);
  assert.equal(SHADOW_V1_LIVE_RATE_LIMIT_PER_MINUTE, 10);
  assert.equal(SHADOW_V1_LIVE_RATE_WINDOW_MS, 60_000);
  assert.equal(SHADOW_V1_LIVE_RATE_MAP_MAX_ENTRIES, 1000);
  assert.equal(SHADOW_V1_LIVE_BARS_PATH, 'artifacts/shadow_v1_live/bars.json');
  assert.equal(SHADOW_V1_LIVE_SIGNALS_PATH, 'artifacts/shadow_v1_live/signals.jsonl');
  assert.equal(SHADOW_V1_LIVE_BAR_MS, 5 * 60 * 1000);
  assert.equal(SHADOW_V1_LIVE_MAX_BARS_PER_TICKER, 600);
  assert.equal(SHADOW_V1_LIVE_CYCLE_MS, 60_000);
  assert.equal(SHADOW_V1_LIVE_SERVER_CLIENT_KEY, 'server-scan');
  assert.equal(SHADOW_V1_LIVE_SOURCE_CLIENT, 'client');
  assert.equal(SHADOW_V1_LIVE_SOURCE_SERVER_SCANNER, 'server-scanner');
  assert.equal(SHADOW_V1_LIVE_STORE_VERSION, 1);
  // P18: la versione dichiara il metodo (M2 barra della decisione, M3 stop in gap).
  assert.equal(SHADOW_V1_LIVE_MODULE_VERSION, 'shadowV1Live@2');
});

test('P11 costanti: la registrazione scrive sul path dello store, non su una copia locale', async () => {
  const { root, signals } = freshRoot('v1livep11path-');
  const registration = registerShadowV1LiveCollector(
    { post: () => {} },
    {
      root,
      env: ON,
      now: () => D0 + 30 * 60 * 1000,
      fetchMissingBars: null,
      timers: fakeTimers,
    }
  );
  try {
    const out = await observeShadowV1LiveFromServer(validBody());
    assert.equal(out?.status, 200);
  } finally {
    registration.stop?.();
  }
  assert.equal(signals, path.join(root, SHADOW_V1_LIVE_SIGNALS_PATH));
  assert.equal(loadRecords(signals).records.length, 1, 'il record finisce nel file dello store');
});

// --- P12: retention dentro la coda del collector ------------------------------

test('P12 retention: due osservazioni concorrenti archiviano il mese chiuso senza perdere record', async () => {
  const file = tmpPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const february = Date.UTC(2026, 1, 10, 14, 0, 0);
  const closedRecord = {
    v: 1,
    key: 'OLD|100|95|1770000000000',
    ticker: 'OLD',
    market: 'US',
    direction: 'LONG',
    entry: 100,
    stop: 95,
    target: 108,
    decidedAtMs: february,
    sessionCloseMs: february + 6 * 60 * 60 * 1000,
    firstSeenAtMs: february + 5 * 60 * 1000,
    status: 'STOP',
    r: -1,
    reason: 'stop',
    fillBarTs: null,
    exitBarTs: null,
    exitPrice: null,
    moduleVersion: 'shadowV1Live@1',
    updatedAtMs: february + 60 * 60 * 1000,
  };
  fs.writeFileSync(file, JSON.stringify(closedRecord) + '\n');

  const handler = createObserveHandler(deps(file));
  const [first, second] = await Promise.all([
    handler({ body: validBody({ ticker: 'MSFT' }), ip: '1.1.1.1' }),
    handler({ body: validBody({ ticker: 'NVDA' }), ip: '1.1.1.2' }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const active = loadRecords(file).records;
  assert.equal(
    active.some((r) => r.key === closedRecord.key),
    false,
    'il terminale di febbraio non resta nel file attivo'
  );
  assert.equal(active.length, 2, 'i due record nuovi sono entrambi attivi');
  const archived = loadRecords(path.join(dir, 'signals-2026-02.jsonl')).records;
  assert.deepEqual(
    archived.map((r) => r.key),
    [closedRecord.key],
    'il record di febbraio e\' nell archivio, una sola volta'
  );
});

// --- P14: allineamento 5m, pulizia disco, crumb 401 e grace period EOD ------

test('P14 allineamento griglia 5m: barre con offset irregolare rifiutate in RAM e in coverage', () => {
  clearShadowV1LiveBarsForTest();
  const base = Math.floor(D0 / BAR_MS) * BAR_MS;
  const aligned: ShadowV1LiveBar = { t: base - BAR_MS, o: 100, h: 101, l: 99, c: 100.5 };
  const unaligned: ShadowV1LiveBar = { t: base - BAR_MS + 37_000, o: 100, h: 101, l: 99, c: 100.5 };

  recordBarsForShadowV1Live('ASML.AS', 'EU', [aligned, unaligned], base + BAR_MS, ON);
  const stored = barsForShadowV1Live('ASML.AS', 'EU');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].t, aligned.t);

  const cov = checkShadowV1LiveBarCoverage({
    decidedAtMs: base - 3 * BAR_MS,
    sessionCloseMs: base + BAR_MS,
    nowMs: base + BAR_MS,
    bars: [unaligned, aligned],
  });
  assert.equal(cov.ok, false, 'la barra disallineata non entra e resta leading_hole sulla barra mancante');
  assert.equal(cov.reason, 'leading_hole');
  assert.equal(cov.barsUsed, 1);
  clearShadowV1LiveBarsForTest();
});

test('P14 avvio collector: rimuove barre disallineate dal bars.json persistito e riscrive pulito', () => {
  clearShadowV1LiveBarsForTest();
  const { root } = freshRoot('v1livescrub-');
  const barsPath = path.join(root, SHADOW_V1_LIVE_BARS_PATH);
  fs.mkdirSync(path.dirname(barsPath), { recursive: true });
  const base = Math.floor(D0 / BAR_MS) * BAR_MS;
  const dirtyPayload = {
    version: 1,
    entries: [
      {
        ticker: 'ASML.AS',
        market: 'EU',
        bars: [
          { t: base - 2 * BAR_MS, o: 100, h: 101, l: 99, c: 100.2 },
          { t: base - 2 * BAR_MS + 42_000, o: 100, h: 101, l: 99, c: 100.3 },
          { t: base - BAR_MS, o: 100.2, h: 101, l: 100, c: 100.5 },
        ],
      },
    ],
  };
  fs.writeFileSync(barsPath, JSON.stringify(dirtyPayload), 'utf8');

  const reg = registerShadowV1LiveCollector(
    { post: () => {} },
    {
      root,
      env: ON,
      now: () => base + BAR_MS,
      fetchMissingBars: null,
      timers: fakeTimers,
    }
  );
  try {
    const cleanRam = barsForShadowV1Live('ASML.AS', 'EU');
    assert.deepEqual(
      cleanRam.map((b) => b.t),
      [base - 2 * BAR_MS, base - BAR_MS]
    );
    const rewritten = JSON.parse(fs.readFileSync(barsPath, 'utf8')) as {
      entries: Array<{ ticker: string; bars: ShadowV1LiveBar[] }>;
    };
    assert.equal(rewritten.entries[0].bars.length, 2, 'bars.json su disco ripulito subito');
  } finally {
    reg.stop?.();
    clearShadowV1LiveBarsForTest();
  }
});

test('P14 backfill Yahoo: retry 401 con crumb, scarta tick non allineati e attende grace EOD 20m', async () => {
  clearShadowV1LiveBarsForTest();
  const sessionClose = Math.floor(D0 / BAR_MS) * BAR_MS;
  const fromMs = sessionClose - 3 * BAR_MS;
  const secondLastSec = Math.floor((sessionClose - 2 * BAR_MS) / 1000);
  const lastSec = Math.floor((sessionClose - BAR_MS) / 1000);
  const unalignedSec = secondLastSec + 19;

  let chartCalls = 0;
  const mockFetch = (async (url: string, init?: RequestInit) => {
    if (url.includes('fc.yahoo.com')) {
      return new Response('', {
        status: 200,
        headers: { 'set-cookie': 'A3=testcookie; Path=/; Secure' },
      });
    }
    if (url.includes('/v1/test/getcrumb')) {
      return new Response('CRUMB123', { status: 200 });
    }
    chartCalls += 1;
    if (chartCalls === 1) {
      return new Response('Unauthorized', { status: 401 });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.ok(url.includes('crumb=CRUMB123'));
    assert.ok(String(headers.Cookie || '').includes('A3=testcookie'));

    const includeFinalBar = url.includes('AAPL') ? false : true;
    const ts = includeFinalBar ? [secondLastSec, unalignedSec, lastSec] : [secondLastSec, unalignedSec];
    const open = ts.map(() => 100);
    const high = ts.map(() => 101);
    const low = ts.map(() => 99);
    const close = ts.map(() => 100.5);
    return new Response(
      JSON.stringify({
        chart: { result: [{ timestamp: ts, indicators: { quote: [{ open, high, low, close }] } }] },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  // Caso 1: 401 -> crumb retry -> ultima barra mancante a +2m -> non ancora autorevole
  const partialEarly = await fetchYahooMissingBarsForShadowV1Live(
    'AAPL',
    'US',
    fromMs,
    sessionClose,
    sessionClose + 2 * 60_000,
    mockFetch
  );
  assert.ok(partialEarly);
  assert.equal(partialEarly.bars.length, 1, 'tick non allineato scartato');
  assert.equal(partialEarly.authoritative, false, 'a +2m senza ultima barra attende il settle');

  // Caso 2: +21m -> grace scaduta -> autorevole anche se ultima barra assente (titolo fermo)
  const partialSettled = await fetchYahooMissingBarsForShadowV1Live(
    'AAPL',
    'US',
    fromMs,
    sessionClose,
    sessionClose + 21 * 60_000,
    mockFetch
  );
  assert.ok(partialSettled);
  assert.equal(partialSettled.authoritative, true, 'dopo grace 20m la sessione diventa autorevole');

  // Caso 3: con final bar presente -> autorevole gia a +2m
  const completeEarly = await fetchYahooMissingBarsForShadowV1Live(
    'MSFT',
    'US',
    fromMs,
    sessionClose,
    sessionClose + 2 * 60_000,
    mockFetch
  );
  assert.ok(completeEarly);
  assert.equal(completeEarly.bars.length, 2);
  assert.equal(completeEarly.authoritative, true, 'con ultima barra presente non serve aspettare 20m');
  clearShadowV1LiveBarsForTest();
});

// --- P17: cache crumb canonica condivisa (N6) ---------------------------------

/** Istante fisso: i test della cache non dipendono dall'orologio di sistema. */
const CRUMB_T0 = 1_767_225_600_000;

function crumbPair(tag: string): Pick<YahooCrumbPair, 'cookie' | 'crumb'> {
  return { cookie: `cookie-${tag}`, crumb: `crumb-${tag}` };
}

test('P17 crumb: due chiamanti concorrenti su resolveYahooCrumbOnce fanno un solo fetch', async () => {
  resetYahooCrumbCache();
  try {
    let loads = 0;
    let release!: (pair: YahooCrumbPair | null) => void;
    const gate = new Promise<YahooCrumbPair | null>((resolve) => {
      release = resolve;
    });
    const loader = () => {
      loads += 1;
      return gate;
    };

    const first = resolveYahooCrumbOnce(loader);
    const second = resolveYahooCrumbOnce(loader);
    assert.equal(loads, 1, 'il loader parte una sola volta con due chiamanti concorrenti');

    const stored = storeYahooCrumb(crumbPair('shared'), CRUMB_T0);
    release(stored);
    const [a, b] = await Promise.all([first, second]);

    assert.equal(loads, 1, 'nessun secondo fetch dopo il primo');
    assert.equal(a, b, 'le due chiamate ricevono la stessa voce');
    assert.deepEqual(a, stored);
    assert.equal(readYahooCrumb(CRUMB_T0)?.crumb, 'crumb-shared', 'la voce e\' finita nella cache canonica');

    await resolveYahooCrumbOnce(async () => {
      loads += 1;
      return null;
    });
    assert.equal(loads, 2, 'nessun volo residuo dopo la risoluzione');
  } finally {
    resetYahooCrumbCache();
  }
});

test('P17 crumb: la voce scade esattamente dopo 1800 s (TTL invariato)', () => {
  resetYahooCrumbCache();
  try {
    assert.equal(YAHOO_CRUMB_TTL_MS, 30 * 60_000);
    const stored = storeYahooCrumb(crumbPair('ttl'), CRUMB_T0);
    assert.equal(stored.expiresAtMs, CRUMB_T0 + 1_800_000);

    assert.equal(readYahooCrumb(CRUMB_T0 + 1_800_000 - 1)?.crumb, 'crumb-ttl', 'valida a TTL-1 ms');
    assert.equal(readYahooCrumb(CRUMB_T0 + 1_800_000), null, 'null al TTL esatto');
    assert.equal(readYahooCrumb(CRUMB_T0 + 24 * 60 * 60_000), null, 'null molto dopo il TTL');
  } finally {
    resetYahooCrumbCache();
  }
});

test('P17 crumb: resetYahooCrumbCache svuota la cache', () => {
  resetYahooCrumbCache();
  storeYahooCrumb(crumbPair('reset'), CRUMB_T0);
  assert.notEqual(readYahooCrumb(CRUMB_T0), null, 'voce presente prima del reset');

  resetYahooCrumbCache();
  assert.equal(readYahooCrumb(CRUMB_T0), null, 'voce assente dopo il reset');
});

// --- P17: cold start senza bars.json ------------------------------------------

test('P17 cold start: bars.json mancante carica 0 barre senza eccezioni', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v1live-coldstart-'));
  tmpDirs.push(root);
  const barsPath = path.join(root, 'artifacts', 'shadow_v1_live', 'bars.json');
  assert.equal(fs.existsSync(barsPath), false, 'precondizione: file assente');

  let loaded: number | undefined;
  assert.doesNotThrow(() => {
    loaded = loadShadowV1LiveBarsFromDisk(barsPath, D0);
  });
  assert.equal(loaded, 0, 'nessuna barra caricata');
  assert.equal(fs.existsSync(barsPath), false, 'la lettura non crea il file');
});
