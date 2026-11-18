/**
 * Test della vista read-only SHADOW V1 LIVE (PR D1).
 *
 * Sola lettura: nessun test scrive in `artifacts/` o `registry/`. I file reali
 * stanno in `os.tmpdir()` e vengono rimossi alla fine; la route e' montata con
 * dipendenze iniettate, senza avviare il server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildShadowV1LiveView,
  createShadowV1LiveViewHandler,
  isShadowV1LiveViewEnabled,
  isLateObservation,
  LATE_THRESHOLD_MS,
  registerShadowV1LiveViewRoute,
  SHADOW_V1_LIVE_VIEW_ENV,
  SHADOW_V1_LIVE_VIEW_MAX_RECORDS,
  SHADOW_V1_LIVE_VIEW_PATH,
} from '../../server/shadowV1LiveView';
import {
  loadRecords,
  SHADOW_V1_LIVE_MODULE_VERSION,
  SHADOW_V1_LIVE_SIGNALS_PATH,
  SHADOW_V1_LIVE_STORE_VERSION,
  type PersistedShadowV1LiveRecord,
} from '../../server/shadowV1LiveStore';

const D0 = Date.UTC(2026, 2, 16, 14, 0, 0);
const CLOSE = D0 + 60 * 60 * 1000;
const NOW = CLOSE + 60 * 60 * 1000;

function rec(
  over: Partial<PersistedShadowV1LiveRecord> & { key: string }
): PersistedShadowV1LiveRecord {
  return {
    v: SHADOW_V1_LIVE_STORE_VERSION,
    ticker: 'AAPL',
    market: 'US',
    direction: 'LONG',
    entry: 100,
    stop: 95,
    target: 110,
    decidedAtMs: D0,
    sessionCloseMs: CLOSE,
    firstSeenAtMs: D0,
    status: 'OPEN',
    r: null,
    reason: null,
    fillBarTs: null,
    exitBarTs: null,
    exitPrice: null,
    moduleVersion: SHADOW_V1_LIVE_MODULE_VERSION,
    updatedAtMs: D0,
    ...over,
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v1live-view-'));
}

function handlerWith(over: {
  env?: Record<string, string | undefined>;
  records?: PersistedShadowV1LiveRecord[];
  skipped?: number;
  exists?: boolean;
  throwOnRead?: boolean;
  limit?: number;
  seen?: string[];
}) {
  return createShadowV1LiveViewHandler({
    env: over.env ?? { [SHADOW_V1_LIVE_VIEW_ENV]: '1' },
    signalsPath: '/tmp/non-usato/signals.jsonl',
    now: () => NOW,
    limit: over.limit,
    fileExists: (p) => {
      over.seen?.push(`exists:${p}`);
      return over.exists ?? true;
    },
    readRecords: (p) => {
      over.seen?.push(`read:${p}`);
      if (over.throwOnRead) throw new Error('disco non leggibile');
      return { records: over.records ?? [], skipped: over.skipped ?? 0 };
    },
  });
}

test('vista: accesa di default, spenta solo con 0 o false', () => {
  assert.equal(isShadowV1LiveViewEnabled(undefined), true, 'env assente = ON');
  assert.equal(isShadowV1LiveViewEnabled({}), true, 'variabile assente = ON');
  for (const v of ['1', 'true', '', ' on ', 'TRUE', ' 1', '2']) {
    assert.equal(
      isShadowV1LiveViewEnabled({ [SHADOW_V1_LIVE_VIEW_ENV]: v }),
      true,
      `valore ${JSON.stringify(v)} deve lasciare la vista accesa`
    );
  }
  for (const v of ['0', 'false', ' FALSE ', 'False', '0 ']) {
    assert.equal(
      isShadowV1LiveViewEnabled({ [SHADOW_V1_LIVE_VIEW_ENV]: v }),
      false,
      `valore ${JSON.stringify(v)} deve spegnere la vista`
    );
  }
  assert.notEqual(SHADOW_V1_LIVE_VIEW_ENV, 'SHADOW_V1_LIVE_COLLECT');
});

test('vista: flag OFF esplicito risponde 404 disabled senza alcuna lettura', () => {
  const seen: string[] = [];
  const res = handlerWith({ env: { [SHADOW_V1_LIVE_VIEW_ENV]: '0' }, seen })();
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { status: 'disabled', flag: SHADOW_V1_LIVE_VIEW_ENV });
  assert.deepEqual(seen, []);
});

test('vista: schema stabile e ordinamento decrescente per decidedAtMs', () => {
  const res = handlerWith({
    records: [
      rec({ key: 'a', decidedAtMs: D0 }),
      rec({ key: 'c', decidedAtMs: D0 + 2 * 60000 }),
      rec({ key: 'b', decidedAtMs: D0 + 60000 }),
    ],
  })();
  assert.equal(res.status, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.available, true);
  assert.equal(body.source, SHADOW_V1_LIVE_SIGNALS_PATH);
  assert.equal(body.storeVersion, SHADOW_V1_LIVE_STORE_VERSION);
  assert.equal(body.limit, SHADOW_V1_LIVE_VIEW_MAX_RECORDS);
  assert.equal(body.truncated, false);
  assert.equal(body.skippedLines, 0);
  assert.equal(body.generatedAt, new Date(NOW).toISOString());
  assert.deepEqual(Object.keys(body).sort(), [
    'available',
    'counts',
    'generatedAt',
    'lateThresholdMs',
    'limit',
    'limitations',
    'metrics',
    'records',
    'skippedLines',
    'source',
    'storeVersion',
    'truncated',
  ]);
  const records = body.records as Array<Record<string, unknown>>;
  assert.deepEqual(records.map((r) => r.key), ['c', 'b', 'a']);
  assert.deepEqual(Object.keys(records[0]).sort(), [
    'decidedAtMs',
    'delayMs',
    'direction',
    'exitBarTs',
    'exitPrice',
    'fillBarTs',
    'key',
    'late',
    'market',
    'r',
    'sessionCloseMs',
    'stale',
    'status',
    'ticker',
    'updatedAtMs',
  ]);
});

test('vista: parita\' di decidedAtMs ordinata per key, in modo deterministico', () => {
  const res = handlerWith({
    records: [rec({ key: 'z' }), rec({ key: 'a' }), rec({ key: 'm' })],
  })();
  const records = (res.body as { records: Array<{ key: string }> }).records;
  assert.deepEqual(records.map((r) => r.key), ['a', 'm', 'z']);
});

test('vista: campi del setup non necessari non esposti', () => {
  const res = handlerWith({
    records: [rec({ key: 'a', reason: 'interno', entry: 101.5, stop: 99.25, target: 104.75 })],
  })();
  const json = JSON.stringify(res.body);
  const records = (res.body as { records: Array<Record<string, unknown>> }).records;
  for (const hidden of ['entry', 'stop', 'target', 'reason', 'moduleVersion', 'firstSeenAtMs', 'v']) {
    assert.equal(hidden in records[0], false, `campo ${hidden} non deve essere esposto`);
  }
  assert.equal(json.includes('"reason"'), false);
  assert.equal(json.includes('"moduleVersion"'), false);
});

test('vista: file assente => available false, nessuna scrittura', () => {
  const seen: string[] = [];
  const res = handlerWith({ exists: false, seen })();
  assert.equal(res.status, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.available, false);
  assert.equal(body.reason, 'nessun file persistito');
  assert.deepEqual(body.records, []);
  assert.deepEqual(seen, ['exists:/tmp/non-usato/signals.jsonl']);
});

test('vista: file presente ma vuoto => available true e conteggi a zero', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'signals.jsonl');
  fs.writeFileSync(file, '');
  try {
    const res = createShadowV1LiveViewHandler({
      env: { [SHADOW_V1_LIVE_VIEW_ENV]: '1' },
      signalsPath: file,
      now: () => NOW,
    })();
    const body = res.body as { available: boolean; counts: Record<string, number> };
    assert.equal(body.available, true);
    for (const [k, v] of Object.entries(body.counts)) assert.equal(v, 0, `count ${k}`);
    assert.equal(
      (res.body as { metrics: { resolved: number; meanR: number | null } }).metrics.resolved,
      0
    );
    assert.equal(
      (res.body as { metrics: { meanR: number | null } }).metrics.meanR,
      null
    );
    assert.equal(fs.readFileSync(file, 'utf8'), '', 'la vista non deve scrivere');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vista: righe corrotte e versione sconosciuta contate come ignorate', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'signals.jsonl');
  const good = JSON.stringify(rec({ key: 'ok' }));
  const badJson = '{"key": "rotto", ';
  const badVersion = JSON.stringify({ ...rec({ key: 'v9' }), v: 99 });
  const badShape = JSON.stringify({ ...rec({ key: 'x' }), status: 'BOH' });
  fs.writeFileSync(file, [good, badJson, badVersion, badShape, JSON.stringify(rec({ key: 'ok2' }))].join('\n') + '\n');
  try {
    const res = createShadowV1LiveViewHandler({
      env: { [SHADOW_V1_LIVE_VIEW_ENV]: '1' },
      signalsPath: file,
      now: () => NOW,
    })();
    const body = res.body as {
      available: boolean;
      skippedLines: number;
      counts: { persisted: number };
      records: Array<{ key: string }>;
    };
    assert.equal(body.available, true);
    assert.equal(body.skippedLines, 3);
    assert.equal(body.counts.persisted, 2);
    assert.deepEqual(body.records.map((r) => r.key).sort(), ['ok', 'ok2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vista: errore di lettura catturato, nessuna eccezione propagata', () => {
  const res = handlerWith({ throwOnRead: true })();
  assert.equal(res.status, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.available, false);
  assert.equal(body.reason, 'lettura non riuscita');
  assert.deepEqual(body.records, []);
  assert.equal((body.metrics as { resolved: number }).resolved, 0);
});

test('vista: limite deterministico con troncamento dichiarato', () => {
  const records = [1, 2, 3, 4, 5].map((n) =>
    rec({ key: `k${n}`, decidedAtMs: D0 + n * 1000 })
  );
  const res = handlerWith({ records, limit: 3 })();
  const body = res.body as {
    truncated: boolean;
    limit: number;
    records: Array<{ key: string }>;
    counts: { persisted: number };
  };
  assert.equal(body.limit, 3);
  assert.equal(body.truncated, true);
  assert.deepEqual(body.records.map((r) => r.key), ['k5', 'k4', 'k3']);
  assert.equal(body.counts.persisted, 5);
});

test('vista: conteggi coerenti con le fixture e nessun esito inventato', () => {
  const res = handlerWith({
    records: [
      rec({ key: 'p', status: 'PENDING_FILL' }),
      rec({ key: 'o', status: 'OPEN' }),
      rec({ key: 's', status: 'STOP', r: -1, exitBarTs: D0 + 60000 }),
      rec({ key: 't', status: 'TARGET', r: 2, exitBarTs: D0 + 120000 }),
      rec({ key: 'e', status: 'EXPIRED', r: 0.25, exitBarTs: D0 + 180000 }),
      rec({ key: 'n', status: 'NOT_FILLED', r: null }),
    ],
    skipped: 2,
  })();
  const body = res.body as {
    counts: Record<string, number>;
    metrics: { resolved: number; meanR: number | null; winRatePct: number | null; sumR: number | null; maxDrawdownR: number | null };
    skippedLines: number;
  };
  assert.deepEqual(body.counts, {
    persisted: 6,
    pendingFill: 1,
    open: 1,
    stop: 1,
    target: 1,
    expired: 1,
    notFilled: 1,
    nonTerminal: 2,
    terminal: 4,
    // i due non terminali hanno sessionCloseMs = CLOSE < NOW
    stale: 2,
  });
  assert.equal(body.skippedLines, 2);
  assert.equal(body.metrics.resolved, 3, 'NOT_FILLED non entra nel denominatore');
  assert.equal(body.metrics.meanR, 0.4167);
  assert.equal(body.metrics.winRatePct, 66.67);
  assert.equal(body.metrics.sumR, 1.25);
  assert.equal(body.metrics.maxDrawdownR, 1);
});

test('vista: NOT_FILLED e non terminali non contano come zero', () => {
  const soloTerminali = handlerWith({
    records: [
      rec({ key: 't', status: 'TARGET', r: 2, exitBarTs: D0 + 60000 }),
      rec({ key: 'n', status: 'NOT_FILLED', r: null }),
      rec({ key: 'o', status: 'OPEN' }),
      rec({ key: 'p', status: 'PENDING_FILL' }),
    ],
  })();
  const a = (soloTerminali.body as { metrics: { meanR: number | null; resolved: number } }).metrics;
  assert.equal(a.resolved, 1);
  assert.equal(a.meanR, 2);

  const nessunEsito = handlerWith({
    records: [rec({ key: 'n', status: 'NOT_FILLED', r: null }), rec({ key: 'o', status: 'OPEN' })],
  })();
  const b = (nessunEsito.body as { metrics: { meanR: number | null; winRatePct: number | null; resolved: number } }).metrics;
  assert.equal(b.resolved, 0);
  assert.equal(b.meanR, null);
  assert.equal(b.winRatePct, null);
});

test('vista: stale calcolato a lettura, mai persistito, solo sui non terminali', () => {
  const records = [
    rec({ key: 'vecchio', status: 'OPEN', sessionCloseMs: NOW - 1000 }),
    rec({ key: 'fresco', status: 'PENDING_FILL', sessionCloseMs: NOW + 1000 }),
    rec({ key: 'chiuso', status: 'EXPIRED', r: 0, sessionCloseMs: NOW - 1000 }),
  ];
  const res = handlerWith({ records })();
  const view = (res.body as { records: Array<{ key: string; stale: boolean }> }).records;
  const byKey = new Map(view.map((r) => [r.key, r.stale]));
  assert.equal(byKey.get('vecchio'), true);
  assert.equal(byKey.get('fresco'), false);
  assert.equal(byKey.get('chiuso'), false);
  assert.equal((res.body as { counts: { stale: number } }).counts.stale, 1);
  for (const r of view as Array<Record<string, unknown>>) {
    assert.equal('staleComputedAt' in r, false);
  }
  assert.equal(records[0].status, 'OPEN', 'la vista non modifica i record letti');
});

test('vista: la funzione pura non tocca il disco e non rivaluta', () => {
  const built = buildShadowV1LiveView({
    records: [rec({ key: 'a', status: 'OPEN' })],
    skippedLines: 0,
    nowMs: NOW,
    generatedAt: new Date(NOW).toISOString(),
  });
  assert.equal(built.counts.persisted, 1);
  assert.equal(built.records[0].status, 'OPEN');
  assert.equal(built.records[0].r, null);
});

test('vista: nessun percorso di scrittura o rivalutazione nel modulo', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/server/shadowV1LiveView.ts'),
    'utf8'
  );
  for (const forbidden of [
    'writeRecordsAtomic',
    'writeFileSync',
    'appendFileSync',
    'upsertObservation',
    'evaluateShadowV1Live',
    'runShadowV1LiveRevaluationCycle',
    'recordBarsForShadowV1Live',
  ]) {
    assert.equal(src.includes(forbidden), false, `vista: ${forbidden} non deve comparire`);
  }
  assert.equal(src.includes("'/api/shadow/v1-live/observe'"), false);
  assert.equal(SHADOW_V1_LIVE_VIEW_PATH, '/api/shadow/v1-live/signals');
});

test('vista: montaggio su app minimale con dipendenze iniettate', () => {
  const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = [];
  const app = { get: (p: string, h: (req: unknown, res: unknown) => void) => routes.push({ path: p, handler: h }) };
  registerShadowV1LiveViewRoute(app, {
    env: { [SHADOW_V1_LIVE_VIEW_ENV]: '0' },
    root: '/tmp/non-usato',
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, SHADOW_V1_LIVE_VIEW_PATH);

  let status = 0;
  let json: unknown = null;
  const res = { status: (c: number) => ({ json: (b: unknown) => { status = c; json = b; } }) };
  routes[0].handler({}, res);
  assert.equal(status, 404);
  assert.deepEqual(json, { status: 'disabled', flag: SHADOW_V1_LIVE_VIEW_ENV });
});

test('vista: loadRecords reale su file assente restituisce elenco vuoto senza creare nulla', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'manca.jsonl');
  try {
    const loaded = loadRecords(file);
    assert.deepEqual(loaded, { records: [], skipped: 0 });
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vista: delayMs e soglia late (600000 non late, 600001 late)', () => {
  assert.equal(LATE_THRESHOLD_MS, 600_000);
  assert.equal(isLateObservation(600_000), false);
  assert.equal(isLateObservation(600_001), true);
  assert.equal(isLateObservation(null), false);

  const res = handlerWith({
    records: [
      rec({ key: 'a', firstSeenAtMs: D0 }),
      rec({ key: 'b', firstSeenAtMs: D0 + 600_000 }),
      rec({ key: 'c', firstSeenAtMs: D0 + 600_001 }),
    ],
  })();
  const body = res.body as {
    lateThresholdMs: number;
    records: Array<{ key: string; delayMs: number | null; late: boolean }>;
  };
  assert.equal(body.lateThresholdMs, LATE_THRESHOLD_MS);
  const byKey = new Map(body.records.map((r) => [r.key, r]));
  assert.equal(byKey.get('a')?.delayMs, 0);
  assert.equal(byKey.get('a')?.late, false);
  assert.equal(byKey.get('b')?.delayMs, 600_000);
  assert.equal(byKey.get('b')?.late, false);
  assert.equal(byKey.get('c')?.delayMs, 600_001);
  assert.equal(byKey.get('c')?.late, true);
});

test('vista: delay non calcolabile o negativo => null, contato e fuori dalle metriche', () => {
  const res = handlerWith({
    records: [
      rec({ key: 'ok', status: 'TARGET', r: 2, exitBarTs: D0 + 60_000, firstSeenAtMs: D0 }),
      rec({ key: 'neg', status: 'TARGET', r: 10, exitBarTs: D0 + 120_000, firstSeenAtMs: D0 - 1000 }),
      rec({ key: 'nan', status: 'TARGET', r: 10, exitBarTs: D0 + 180_000, firstSeenAtMs: Number.NaN }),
    ],
  })();
  const body = res.body as {
    records: Array<{ key: string; delayMs: number | null; late: boolean }>;
    metrics: { resolved: number; meanR: number | null; nDelayUnavailable: number; nResolvedAll: number };
  };
  const byKey = new Map(body.records.map((r) => [r.key, r]));
  assert.equal(byKey.get('neg')?.delayMs, null);
  assert.equal(byKey.get('neg')?.late, false);
  assert.equal(byKey.get('nan')?.delayMs, null);
  assert.equal(body.metrics.nDelayUnavailable, 2);
  assert.equal(body.metrics.nResolvedAll, 3);
  assert.equal(body.metrics.resolved, 1);
  assert.equal(body.metrics.meanR, 2);
});

test('vista: metriche senza i record late, con nLate e nResolvedAll coerenti', () => {
  const res = handlerWith({
    records: [
      rec({ key: 't1', status: 'TARGET', r: 2, exitBarTs: D0 + 60_000, firstSeenAtMs: D0 }),
      rec({ key: 's1', status: 'STOP', r: -1, exitBarTs: D0 + 120_000, firstSeenAtMs: D0 + 20 * 60_000 }),
      rec({ key: 'e1', status: 'EXPIRED', r: -0.5, exitBarTs: D0 + 180_000, firstSeenAtMs: D0 + 5 * 60_000 }),
      rec({ key: 'b1', status: 'TARGET', r: 10, exitBarTs: D0 + 240_000, firstSeenAtMs: D0 - 1 }),
    ],
  })();
  const m = (res.body as {
    metrics: {
      resolved: number;
      meanR: number | null;
      winRatePct: number | null;
      sumR: number | null;
      maxDrawdownR: number | null;
      nLate: number;
      nResolvedAll: number;
      nDelayUnavailable: number;
    };
  }).metrics;
  assert.equal(m.nResolvedAll, 4);
  assert.equal(m.nLate, 1);
  assert.equal(m.nDelayUnavailable, 1);
  assert.equal(m.resolved, 2);
  assert.equal(m.meanR, 0.75);
  assert.equal(m.winRatePct, 50);
  assert.equal(m.sumR, 1.5);
  assert.equal(m.maxDrawdownR, 0.5);
});

test('vista: i record late restano nell elenco e non entrano nei conteggi di stato', () => {
  const res = handlerWith({
    records: [
      rec({ key: 'late', status: 'TARGET', r: 2, firstSeenAtMs: D0 + 30 * 60_000 }),
      rec({ key: 'ok', status: 'STOP', r: -1, firstSeenAtMs: D0 }),
    ],
  })();
  const body = res.body as {
    records: Array<{ key: string; late: boolean }>;
    counts: { persisted: number; target: number; stop: number; stale: number };
  };
  assert.equal(body.records.length, 2);
  assert.equal(body.records.find((r) => r.key === 'late')?.late, true);
  assert.equal(body.counts.persisted, 2);
  assert.equal(body.counts.target, 1);
  assert.equal(body.counts.stop, 1);
});
