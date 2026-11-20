/**
 * Test dello store SHADOW V1 LIVE.
 *
 * Tutto l'I/O usa `os.tmpdir()` con una directory dedicata e rimossa alla fine:
 * nessun file viene scritto in `artifacts/` o `registry/`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSeenKeys,
  isStale,
  loadRecords,
  observationFromResult,
  SHADOW_V1_LIVE_MODULE_VERSION,
  SHADOW_V1_LIVE_SIGNALS_PATH,
  SHADOW_V1_LIVE_STORE_VERSION,
  shadowV1LiveTmpPath,
  toCoreInput,
  upsertObservation,
  writeRecordsAtomic,
  type PersistedShadowV1LiveRecord,
  type ShadowV1LiveObservation,
  type ShadowV1LiveObservationContext,
} from '../../server/shadowV1LiveStore';
import {
  archiveClosedMonths,
  archivePathFor,
  countLines,
  isTerminalLiveStatus,
  listArchivePaths,
  mergeByKey,
  monthKeyUtc,
  serializeRecords,
  sha256Of,
  sidecarPathFor,
} from '../../server/shadowV1LiveRetention';
import {
  evaluateShadowV1Live,
  shadowV1LiveKeyOf,
  type ShadowV1LiveBar,
  type ShadowV1LiveResult,
  type ShadowV1LiveStatus,
} from '../../knowledge/shadowV1Live';

const D0 = Date.UTC(2026, 2, 16, 14, 0, 0);
const BAR_MS = 5 * 60 * 1000;
const CLOSE = D0 + 60 * 60 * 1000;

const CTX: ShadowV1LiveObservationContext = {
  ticker: 'AAPL',
  market: 'US',
  direction: 'LONG',
  entry: 100,
  stop: 95,
  target: 108,
  decidedAtMs: D0,
  sessionCloseMs: CLOSE,
};

const KEY = shadowV1LiveKeyOf(CTX.ticker, CTX.entry, CTX.stop, CTX.decidedAtMs);

function observation(
  status: ShadowV1LiveObservation['status'],
  over: Partial<ShadowV1LiveObservation> = {}
): ShadowV1LiveObservation {
  return {
    key: KEY,
    ticker: CTX.ticker,
    market: CTX.market,
    direction: CTX.direction,
    entry: CTX.entry,
    stop: CTX.stop,
    target: CTX.target,
    decidedAtMs: CTX.decidedAtMs,
    sessionCloseMs: CTX.sessionCloseMs,
    status,
    r: null,
    reason: null,
    fillBarTs: null,
    exitBarTs: null,
    exitPrice: null,
    ...over,
  };
}

function recordFrom(
  obs: ShadowV1LiveObservation,
  nowMs = D0 + BAR_MS
): PersistedShadowV1LiveRecord {
  const res = upsertObservation([], obs, nowMs);
  assert.equal(res.outcome, 'INSERTED');
  return res.records[0];
}

function result(
  status: ShadowV1LiveStatus,
  over: Partial<ShadowV1LiveResult> = {}
): ShadowV1LiveResult {
  return {
    status,
    key: KEY,
    reason: null,
    r: null,
    entryPrice: CTX.entry,
    stopPrice: CTX.stop,
    targetPrice: CTX.target,
    riskPerUnit: CTX.entry - CTX.stop,
    fillBarTs: null,
    exitBarTs: null,
    exitPrice: null,
    ...over,
  };
}

const tmpRoots: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1livestore-'));
  tmpRoots.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

// --- inserimento e idempotenza -------------------------------------------------

test('primo record: INSERTED con versione, primo avvistamento e moduleVersion', () => {
  const res = upsertObservation([], observation('PENDING_FILL'), D0 + BAR_MS);
  assert.equal(res.outcome, 'INSERTED');
  assert.equal(res.changed, true);
  assert.equal(res.records.length, 1);
  const rec = res.records[0];
  assert.equal(rec.v, SHADOW_V1_LIVE_STORE_VERSION);
  assert.equal(rec.key, KEY);
  assert.equal(rec.firstSeenAtMs, D0 + BAR_MS);
  assert.equal(rec.updatedAtMs, D0 + BAR_MS);
  assert.equal(rec.moduleVersion, SHADOW_V1_LIVE_MODULE_VERSION);
  assert.equal(rec.status, 'PENDING_FILL');
});

test('stessa osservazione due volte: UNCHANGED, array identico riga per riga', () => {
  const first = upsertObservation([], observation('PENDING_FILL'), D0 + BAR_MS);
  const second = upsertObservation(first.records, observation('PENDING_FILL'), D0 + 9 * BAR_MS);
  assert.equal(second.outcome, 'UNCHANGED');
  assert.equal(second.changed, false);
  assert.equal(second.records.length, 1);
  assert.deepEqual(second.records, first.records);
  assert.notEqual(second.records, first.records, 'array nuovo, contenuto identico');
});

test('idempotenza su disco: due scritture della stessa osservazione non duplicano la riga', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'signals.jsonl');
  const once = upsertObservation([], observation('OPEN', { fillBarTs: D0 + BAR_MS }), D0 + BAR_MS);
  assert.equal(writeRecordsAtomic(file, once.records).ok, true);
  const loaded = loadRecords(file);
  const twice = upsertObservation(
    loaded.records,
    observation('OPEN', { fillBarTs: D0 + BAR_MS }),
    D0 + 2 * BAR_MS
  );
  assert.equal(twice.outcome, 'UNCHANGED');
  assert.equal(writeRecordsAtomic(file, twice.records).ok, true);
  const raw = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(raw.length, 1);
});

test('il decidedAtMs del primo avvistamento vince su quello dell\u2019osservazione', () => {
  const first = upsertObservation([], observation('PENDING_FILL'), D0 + BAR_MS);
  const next = upsertObservation(
    first.records,
    observation('OPEN', { decidedAtMs: D0 + 1000, fillBarTs: D0 + BAR_MS }),
    D0 + 2 * BAR_MS
  );
  assert.equal(next.outcome, 'UPDATED');
  assert.equal(next.records[0].decidedAtMs, D0);
});

// --- transizioni ---------------------------------------------------------------

test('PENDING_FILL -> OPEN: UPDATED, fill registrato, decidedAtMs invariato', () => {
  const first = upsertObservation([], observation('PENDING_FILL'), D0 + BAR_MS);
  const next = upsertObservation(
    first.records,
    observation('OPEN', { fillBarTs: D0 + 2 * BAR_MS }),
    D0 + 2 * BAR_MS
  );
  assert.equal(next.outcome, 'UPDATED');
  assert.equal(next.changed, true);
  assert.equal(next.records[0].status, 'OPEN');
  assert.equal(next.records[0].fillBarTs, D0 + 2 * BAR_MS);
  assert.equal(next.records[0].decidedAtMs, D0);
  assert.equal(next.records[0].firstSeenAtMs, D0 + BAR_MS);
  assert.equal(next.records[0].updatedAtMs, D0 + 2 * BAR_MS);
});

test('OPEN -> STOP: terminale con r=−1 e prezzi di uscita', () => {
  const open = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const next = upsertObservation(
    [open],
    observation('STOP', { r: -1, fillBarTs: D0 + BAR_MS, exitBarTs: D0 + 3 * BAR_MS, exitPrice: 95 }),
    D0 + 3 * BAR_MS
  );
  assert.equal(next.outcome, 'UPDATED');
  assert.equal(next.records[0].status, 'STOP');
  assert.equal(next.records[0].r, -1);
  assert.equal(next.records[0].exitPrice, 95);
  assert.equal(next.records[0].exitBarTs, D0 + 3 * BAR_MS);
});

test('OPEN -> TARGET: terminale con r di target', () => {
  const open = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const next = upsertObservation(
    [open],
    observation('TARGET', { r: 1.6, fillBarTs: D0 + BAR_MS, exitBarTs: D0 + 4 * BAR_MS, exitPrice: 108 }),
    D0 + 4 * BAR_MS
  );
  assert.equal(next.records[0].status, 'TARGET');
  assert.equal(next.records[0].r, 1.6);
});

test('OPEN -> EXPIRED: terminale con r calcolato e close come uscita', () => {
  const open = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const next = upsertObservation(
    [open],
    observation('EXPIRED', { r: 0.1, fillBarTs: D0 + BAR_MS, exitBarTs: CLOSE - BAR_MS, exitPrice: 100.5 }),
    CLOSE
  );
  assert.equal(next.records[0].status, 'EXPIRED');
  assert.equal(next.records[0].r, 0.1);
});

test('PENDING_FILL -> NOT_FILLED: terminale senza fill', () => {
  const pending = recordFrom(observation('PENDING_FILL'));
  const next = upsertObservation(
    [pending],
    observation('NOT_FILLED', { reason: 'sessione finita senza tocco' }),
    CLOSE
  );
  assert.equal(next.records[0].status, 'NOT_FILLED');
  assert.equal(next.records[0].fillBarTs, null);
});

test('stati terminali immutabili: TARGET -> STOP rifiutato, record byte per byte identico', () => {
  const target = recordFrom(
    observation('TARGET', { r: 1.6, fillBarTs: D0 + BAR_MS, exitBarTs: D0 + BAR_MS, exitPrice: 108 })
  );
  const before = JSON.stringify(target);
  const res = upsertObservation(
    [target],
    observation('STOP', { r: -1, fillBarTs: D0 + BAR_MS, exitBarTs: D0 + 2 * BAR_MS, exitPrice: 95 }),
    D0 + 2 * BAR_MS
  );
  assert.equal(res.outcome, 'REJECTED_TERMINAL');
  assert.equal(res.changed, false);
  assert.equal(JSON.stringify(res.records[0]), before);
});

test('NOT_FILLED terminale: un OPEN successivo viene rifiutato', () => {
  const notFilled = recordFrom(observation('NOT_FILLED'), CLOSE);
  const res = upsertObservation(
    [notFilled],
    observation('OPEN', { fillBarTs: D0 + BAR_MS }),
    CLOSE + BAR_MS
  );
  assert.equal(res.outcome, 'REJECTED_TERMINAL');
  assert.equal(res.records[0].status, 'NOT_FILLED');
});

test('regressione OPEN -> PENDING_FILL: REJECTED_REGRESSION, record invariato', () => {
  const open = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const res = upsertObservation([open], observation('PENDING_FILL'), D0 + 2 * BAR_MS);
  assert.equal(res.outcome, 'REJECTED_REGRESSION');
  assert.equal(res.changed, false);
  assert.equal(res.records[0].status, 'OPEN');
});

test('UPDATE non tocca gli altri record e li mantiene ordinati', () => {
  const a = upsertObservation([], observation('PENDING_FILL'), D0 + BAR_MS).records[0];
  const otherKey = shadowV1LiveKeyOf('MSFT', 50, 47, D0 - 60_000);
  const b = upsertObservation(
    [a],
    observation('PENDING_FILL', { key: otherKey, ticker: 'MSFT', entry: 50, stop: 47, target: 54, decidedAtMs: D0 - 60_000 }),
    D0 + BAR_MS
  ).records[0];
  assert.equal(b.key, otherKey);
  const all = [a, b].sort((x, y) => x.decidedAtMs - y.decidedAtMs);
  const res = upsertObservation(
    all,
    observation('OPEN', { fillBarTs: D0 + BAR_MS }),
    D0 + 2 * BAR_MS
  );
  assert.equal(res.records.length, 2);
  assert.equal(res.records[0].key, otherKey);
  assert.equal(res.records[0].status, 'PENDING_FILL');
  assert.equal(res.records[1].status, 'OPEN');
});

// --- stati non persistibili ----------------------------------------------------

test('INVALID_SETUP non viene persistito', () => {
  const res = upsertObservation([], observation('INVALID_SETUP' as ShadowV1LiveObservation['status']), D0);
  assert.equal(res.outcome, 'SKIPPED_NOT_PERSISTABLE');
  assert.equal(res.changed, false);
  assert.equal(res.records.length, 0);
});

test('DUPLICATE non viene persistito e non tocca un record esistente', () => {
  const existing = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const res = upsertObservation(
    [existing],
    observation('DUPLICATE' as ShadowV1LiveObservation['status']),
    D0 + 3 * BAR_MS
  );
  assert.equal(res.outcome, 'SKIPPED_NOT_PERSISTABLE');
  assert.equal(res.records.length, 1);
  assert.deepEqual(res.records, [existing]);
});

test('observationFromResult: INVALID_SETUP e chiave assente danno null', () => {
  assert.equal(observationFromResult(CTX, result('INVALID_SETUP', { key: null })), null);
  assert.equal(observationFromResult(CTX, result('OPEN', { key: null })), null);
  assert.equal(observationFromResult(CTX, result('OPEN', { key: '' })), null);
});

test('observationFromResult: DUPLICATE non produce osservazione', () => {
  assert.equal(observationFromResult(CTX, result('DUPLICATE')), null);
});

test('observationFromResult: copia i campi utili e azzera quelli assenti', () => {
  const obs = observationFromResult(
    CTX,
    result('OPEN', { reason: 'posizione aperta', fillBarTs: D0 + BAR_MS })
  );
  assert.ok(obs);
  assert.equal(obs.key, KEY);
  assert.equal(obs.market, 'US');
  assert.equal(obs.entry, 100);
  assert.equal(obs.stop, 95);
  assert.equal(obs.target, 108);
  assert.equal(obs.decidedAtMs, D0);
  assert.equal(obs.sessionCloseMs, CLOSE);
  assert.equal(obs.fillBarTs, D0 + BAR_MS);
  assert.equal(obs.exitPrice, null);
});

// --- chiavi viste e input del nucleo -------------------------------------------

test('buildSeenKeys raccoglie tutte le chiavi persistite', () => {
  const a = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const b = recordFrom(
    observation('PENDING_FILL', { key: shadowV1LiveKeyOf('MSFT', 50, 47, D0), ticker: 'MSFT', entry: 50, stop: 47, target: 54 }),
    D0
  );
  const seen = buildSeenKeys([a, b]);
  assert.equal(seen.size, 2);
  assert.ok(seen.has(a.key));
  assert.ok(seen.has(b.key));
});

test('toCoreInput: TRADE, livelli dal record, seenKeys senza la propria chiave', () => {
  const rec = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const input = toCoreInput(rec, D0 + 2 * BAR_MS, [], [rec]);
  assert.equal(input.setup.decision, 'TRADE');
  assert.equal(input.setup.direction, 'LONG');
  assert.equal(input.setup.candidate.ticker, 'AAPL');
  assert.equal(input.setup.entryLevel, 100);
  assert.equal(input.setup.stopLossLevel, 95);
  assert.equal(input.setup.target1Level, 108);
  assert.equal(input.decidedAtMs, D0);
  assert.equal(input.sessionCloseMs, CLOSE);
  assert.equal(input.nowMs, D0 + 2 * BAR_MS);
  assert.deepEqual(input.seenKeys, []);
});

test('toCoreInput: le altre chiavi restano in seenKeys', () => {
  const rec = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const other = recordFrom(
    observation('PENDING_FILL', { key: shadowV1LiveKeyOf('MSFT', 50, 47, D0), ticker: 'MSFT', entry: 50, stop: 47, target: 54 }),
    D0
  );
  const input = toCoreInput(rec, D0 + 2 * BAR_MS, [], [rec, other]);
  assert.deepEqual(input.seenKeys, [other.key]);
});

test('integrazione col nucleo: record OPEN rivalutato con barre nuove -> EXPIRED', () => {
  const rec = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const bars: ShadowV1LiveBar[] = [
    { t: D0 + BAR_MS, o: 100, h: 101, l: 99, c: 100.5 },
    { t: D0 + 2 * BAR_MS, o: 100.5, h: 101, l: 99.5, c: 100.5 },
  ];
  const res = evaluateShadowV1Live(toCoreInput(rec, CLOSE, bars, [rec]));
  assert.equal(res.status, 'EXPIRED');
  assert.equal(res.key, KEY);
  assert.ok(Math.abs((res.r ?? 0) - 0.1) < 1e-9, `r atteso 0.1, ottenuto ${res.r}`);
  assert.equal(res.exitPrice, 100.5);
});

test('integrazione col nucleo: se seenKeys contenesse la propria chiave il nucleo direbbe DUPLICATE', () => {
  const rec = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const input = toCoreInput(rec, CLOSE, [], [rec]);
  const withSelf = evaluateShadowV1Live({ ...input, seenKeys: [rec.key] });
  assert.equal(withSelf.status, 'DUPLICATE');
  assert.notEqual(evaluateShadowV1Live(input).status, 'DUPLICATE');
});

test('integrazione col nucleo: stop toccato -> STOP, poi upsert in terminale', () => {
  const rec = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const bars: ShadowV1LiveBar[] = [{ t: D0 + 2 * BAR_MS, o: 100, h: 100.5, l: 94, c: 94.5 }];
  const res = evaluateShadowV1Live(toCoreInput(rec, D0 + 3 * BAR_MS, bars, [rec]));
  assert.equal(res.status, 'STOP');
  const obs = observationFromResult(CTX, res);
  assert.ok(obs);
  const up = upsertObservation([rec], obs, D0 + 3 * BAR_MS);
  assert.equal(up.outcome, 'UPDATED');
  assert.equal(up.records[0].status, 'STOP');
});

// --- stale a lettura -----------------------------------------------------------

test('isStale: PENDING_FILL prima della chiusura -> false, dopo -> true', () => {
  const rec = recordFrom(observation('PENDING_FILL'));
  assert.equal(isStale(rec, CLOSE), false);
  assert.equal(isStale(rec, CLOSE + 1), true);
});

test('isStale: OPEN oltre la chiusura -> true', () => {
  const rec = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  assert.equal(isStale(rec, CLOSE), false);
  assert.equal(isStale(rec, CLOSE + 1), true);
});

test('isStale: i terminali non sono mai stale', () => {
  for (const status of ['STOP', 'TARGET', 'EXPIRED', 'NOT_FILLED'] as const) {
    const rec = recordFrom(observation(status), D0 + BAR_MS);
    assert.equal(isStale(rec, CLOSE + 30 * 24 * 60 * 60 * 1000), false, status);
  }
});

test('stale non e\u2019 persistito: il file non contiene la parola', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'signals.jsonl');
  const rec = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  writeRecordsAtomic(file, [rec]);
  assert.equal(fs.readFileSync(file, 'utf8').includes('stale'), false);
});

// --- lettura -------------------------------------------------------------------

test('loadRecords: file assente -> elenco vuoto, skipped 0', () => {
  const dir = tmpDir();
  const res = loadRecords(path.join(dir, 'non-esiste.jsonl'));
  assert.deepEqual(res, { records: [], skipped: 0 });
});

test('loadRecords: file vuoto -> elenco vuoto', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'vuoto.jsonl');
  fs.writeFileSync(file, '');
  assert.deepEqual(loadRecords(file), { records: [], skipped: 0 });
});

test('loadRecords: righe corrotte o versione sconosciuta vengono saltate e contate', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'misto.jsonl');
  const good = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const unknownVersion = { ...good, key: 'X|1|2|2026-03-16', v: 99 };
  fs.writeFileSync(
    file,
    [JSON.stringify(good), '{ non json', '', JSON.stringify(unknownVersion), 'null', JSON.stringify({ key: 'senza-v' })].join('\n') + '\n'
  );
  const res = loadRecords(file);
  assert.equal(res.records.length, 1);
  assert.equal(res.records[0].key, KEY);
  assert.equal(res.skipped, 4);
});

test('P18b loadRecords: record senza moduleVersion e\' legacy, non fuori schema', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'legacy.jsonl');
  const legacy = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS })) as unknown as Record<string, unknown>;
  delete legacy.moduleVersion;
  const raw = `${JSON.stringify(legacy)}\n`;
  fs.writeFileSync(file, raw);

  const res = loadRecords(file);
  assert.equal(res.skipped, 0, 'il record legacy non viene scartato');
  assert.equal(res.records.length, 1);
  assert.equal(res.records[0].moduleVersion, undefined, 'in lettura nessuna versione inventata');

  // P18b: un record non terminale aggiornato prende la versione corrente, anche se
  // era legacy: l'esito che registra e' prodotto dal metodo nuovo.
  const next = upsertObservation(
    res.records,
    observation('OPEN', { fillBarTs: D0 + 2 * BAR_MS }),
    D0 + 3 * BAR_MS
  );
  assert.equal(next.outcome, 'UPDATED');
  assert.equal(next.records[0].moduleVersion, SHADOW_V1_LIVE_MODULE_VERSION);
  assert.equal(SHADOW_V1_LIVE_MODULE_VERSION, 'shadowV1Live@3');

  // Lo store e' puro: il file su disco non viene riscritto da `upsertObservation`.
  assert.equal(fs.readFileSync(file, 'utf8'), raw, 'il file non viene riscritto');
});

test('P18b upsert: non terminale legacy -> terminale prende la versione corrente', () => {
  const open = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS })) as unknown as Record<string, unknown>;
  delete open.moduleVersion;
  const seeded = [open as unknown as PersistedShadowV1LiveRecord];

  const next = upsertObservation(
    seeded,
    observation('STOP', {
      r: -1,
      fillBarTs: D0 + BAR_MS,
      exitBarTs: D0 + 2 * BAR_MS,
      exitPrice: CTX.stop,
    }),
    D0 + 3 * BAR_MS
  );
  assert.equal(next.outcome, 'UPDATED');
  assert.equal(next.records[0].status, 'STOP');
  assert.equal(next.records[0].moduleVersion, 'shadowV1Live@3', 'l\'esito e\' del metodo nuovo');
  assert.equal(seeded[0].moduleVersion, undefined, 'input non mutato');
});

test('P18b upsert: terminale legacy non viene ne\' aggiornato ne\' etichettato', () => {
  const closed = recordFrom(
    observation('STOP', { r: -1, exitBarTs: D0 + BAR_MS, exitPrice: CTX.stop })
  ) as unknown as Record<string, unknown>;
  delete closed.moduleVersion;
  const seeded = [closed as unknown as PersistedShadowV1LiveRecord];

  const next = upsertObservation(
    seeded,
    observation('STOP', { r: -1.5, exitBarTs: D0 + 2 * BAR_MS, exitPrice: 92.5 }),
    D0 + 3 * BAR_MS
  );
  assert.equal(next.outcome, 'REJECTED_TERMINAL');
  assert.equal(next.changed, false);
  assert.equal(next.records[0].moduleVersion, undefined, 'terminale legacy intatto');
  assert.equal(next.records[0].exitPrice, CTX.stop, 'nessuna riscrittura');
});

test('P18b upsert: UNCHANGED non tocca la versione del record legacy', () => {
  const open = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS })) as unknown as Record<string, unknown>;
  delete open.moduleVersion;
  const seeded = [open as unknown as PersistedShadowV1LiveRecord];

  const next = upsertObservation(
    seeded,
    observation('OPEN', { fillBarTs: D0 + BAR_MS }),
    D0 + 9 * BAR_MS
  );
  assert.equal(next.outcome, 'UNCHANGED');
  assert.equal(next.changed, false);
  assert.equal(next.records[0].moduleVersion, undefined, 'payload identico: nessuna versione aggiunta');
  assert.equal(next.records[0].updatedAtMs, seeded[0].updatedAtMs);
});

test('loadRecords: file illeggibile (directory al posto del file) non lancia', () => {
  const dir = tmpDir();
  const res = loadRecords(dir);
  assert.deepEqual(res, { records: [], skipped: 0 });
});

// --- scrittura -----------------------------------------------------------------

test('writeRecordsAtomic: round-trip identico', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'signals.jsonl');
  const a = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const b = recordFrom(
    observation('NOT_FILLED', { key: shadowV1LiveKeyOf('MSFT', 50, 47, D0 - 1000), ticker: 'MSFT', entry: 50, stop: 47, target: 54, decidedAtMs: D0 - 1000 }),
    CLOSE
  );
  const res = writeRecordsAtomic(file, [a, b]);
  assert.equal(res.ok, true);
  const loaded = loadRecords(file);
  assert.equal(loaded.skipped, 0);
  assert.deepEqual(loaded.records, [b, a], 'ordine per decidedAtMs: prima il piu\u2019 vecchio');
});

test('writeRecordsAtomic: ordine deterministico indipendente dall\u2019ordine di input', () => {
  const dir = tmpDir();
  const f1 = path.join(dir, 'a.jsonl');
  const f2 = path.join(dir, 'b.jsonl');
  const a = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const b = recordFrom(
    observation('NOT_FILLED', { key: shadowV1LiveKeyOf('ZZZ', 10, 9, D0), ticker: 'ZZZ', entry: 10, stop: 9, target: 12 }),
    CLOSE
  );
  writeRecordsAtomic(f1, [a, b]);
  writeRecordsAtomic(f2, [b, a]);
  assert.equal(fs.readFileSync(f1, 'utf8'), fs.readFileSync(f2, 'utf8'));
});

test('writeRecordsAtomic: nessun file temporaneo residuo', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'signals.jsonl');
  writeRecordsAtomic(file, [recordFrom(observation('PENDING_FILL'))]);
  writeRecordsAtomic(file, [recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }))]);
  assert.deepEqual(fs.readdirSync(dir), ['signals.jsonl']);
});

test('writeRecordsAtomic: percorso non scrivibile -> ok false, nessuna eccezione', () => {
  const dir = tmpDir();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'sono un file');
  const res = writeRecordsAtomic(path.join(blocker, 'signals.jsonl'), []);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.error.length > 0);
});

test('writeRecordsAtomic: elenco vuoto -> file vuoto leggibile', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'signals.jsonl');
  assert.equal(writeRecordsAtomic(file, []).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '\n');
  assert.deepEqual(loadRecords(file), { records: [], skipped: 0 });
});

// --- purezza e percorso di produzione ------------------------------------------

test('upsertObservation non muta l\u2019osservazione in ingresso', () => {
  const obs = observation('OPEN', { fillBarTs: D0 + BAR_MS });
  const snapshot = JSON.stringify(obs);
  upsertObservation([recordFrom(observation('PENDING_FILL'))], obs, D0 + 5 * BAR_MS);
  assert.equal(JSON.stringify(obs), snapshot);
});

test('determinismo: stesso input -> stesso output', () => {
  const records = [recordFrom(observation('PENDING_FILL'))];
  const obs = observation('OPEN', { fillBarTs: D0 + BAR_MS });
  assert.deepEqual(
    upsertObservation(records, obs, D0 + 2 * BAR_MS),
    upsertObservation(records, obs, D0 + 2 * BAR_MS)
  );
});

test('percorso di produzione dichiarato ma non usato dai test', () => {
  assert.equal(SHADOW_V1_LIVE_SIGNALS_PATH, 'artifacts/shadow_v1_live/signals.jsonl');
  const dir = tmpDir();
  assert.equal(fs.existsSync(path.join(dir, 'artifacts')), false);
});

// --- P9 / CON-2: temporaneo univoco -------------------------------------------

test('writeRecordsAtomic: il nome del temporaneo e\u2019 univoco per processo e chiamata', () => {
  const file = path.join(os.tmpdir(), 'v1livestore-unique', 'signals.jsonl');
  const prefix = `${file}.tmp-${process.pid}-`;
  const names = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const candidate = shadowV1LiveTmpPath(file);
    assert.ok(candidate.startsWith(prefix), `prefisso con pid atteso in ${candidate}`);
    assert.ok(candidate.length > prefix.length, 'suffisso univoco non vuoto');
    names.add(candidate);
  }
  assert.equal(names.size, 200, 'duecento chiamate, duecento nomi distinti');
});

test('writeRecordsAtomic: un errore rimuove solo il proprio temporaneo', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'sono-una-directory');
  fs.mkdirSync(target);
  const decoy = `${target}.tmp-999999-altro-scrittore`;
  fs.writeFileSync(decoy, 'righe di un altro scrittore');

  const res = writeRecordsAtomic(target, []);
  assert.equal(res.ok, false, 'il rename su una directory fallisce senza eccezioni');
  assert.equal(fs.existsSync(decoy), true, 'il temporaneo di un altro scrittore resta intatto');
  const leftovers = fs
    .readdirSync(dir)
    .filter((name) => name.includes('.tmp-') && name !== path.basename(decoy));
  assert.deepEqual(leftovers, [], 'nessun temporaneo proprio residuo');
});

// --- P9 / CON-4: schema in lettura --------------------------------------------

test('loadRecords: record fuori schema scartati e contati, nessun NaN a valle', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'parziale.jsonl');
  const good = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  const goodExtra = recordFrom(
    observation('TARGET', {
      key: shadowV1LiveKeyOf('MSFT', 50, 47, D0),
      ticker: 'MSFT',
      entry: 50,
      stop: 47,
      target: 54,
      r: 1.6,
      exitBarTs: D0 + 2 * BAR_MS,
      exitPrice: 54,
    })
  );
  const invalid: unknown[] = [
    { ...good, key: 'a', status: undefined },
    { ...good, key: 'b', sessionCloseMs: null },
    { ...good, key: 'c', decidedAtMs: 'ieri' },
    { ...good, key: 'd', status: 'BOH' },
    { ...good, key: 'e', market: 'GLOBAL' },
    { ...good, key: 'f', entry: -1 },
    { ...good, key: 'g', r: 'x' },
    { ...good, key: 'h', fillBarTs: undefined },
  ];
  fs.writeFileSync(
    file,
    [
      JSON.stringify(good),
      ...invalid.map((v) => JSON.stringify(v)),
      JSON.stringify({ ...goodExtra, campoFuturo: 1 }),
    ].join('\n') + '\n'
  );

  const res = loadRecords(file);
  assert.equal(res.records.length, 2, 'restano solo i due record conformi');
  assert.equal(res.skipped, invalid.length, 'ogni riga fuori schema e\u2019 contata');
  assert.deepEqual(
    res.records.map((r) => r.ticker),
    ['AAPL', 'MSFT'],
    'un campo extra non invalida un record conforme'
  );
  for (const r of res.records) {
    assert.equal(Number.isFinite(r.decidedAtMs), true);
    assert.equal(Number.isFinite(r.sessionCloseMs), true);
    assert.equal(Number.isFinite(r.entry), true);
  }
});

test('loadRecords: un campo numerico nullo non entra nell\u2019ordinamento', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nullo.jsonl');
  const good = recordFrom(observation('OPEN', { fillBarTs: D0 + BAR_MS }));
  fs.writeFileSync(
    file,
    [JSON.stringify({ ...good, key: 'n1', decidedAtMs: null }), JSON.stringify(good)].join('\n') +
      '\n'
  );
  const res = loadRecords(file);
  assert.equal(res.records.length, 1);
  assert.equal(res.skipped, 1);
  assert.equal(
    res.records.every((r) => !Number.isNaN(r.decidedAtMs)),
    true,
    'nessun NaN raggiunge il sort'
  );
});

// --- P12: retention mensile verificata ----------------------------------------

const MAR = Date.UTC(2026, 2, 16, 14, 0, 0);
const APR = Date.UTC(2026, 3, 2, 14, 0, 0);

function liveRecord(
  key: string,
  status: ShadowV1LiveObservation['status'],
  decidedAtMs: number,
  updatedAtMs = decidedAtMs + 60_000
): PersistedShadowV1LiveRecord {
  return recordFrom(observation(status, { key, decidedAtMs }), updatedAtMs);
}

function retentionDir(): string {
  const dir = tmpDir();
  return path.join(dir, 'shadow_v1_live', 'signals.jsonl');
}

function readJsonl(file: string): PersistedShadowV1LiveRecord[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PersistedShadowV1LiveRecord);
}

test('P12 retention: mese UTC e stati terminali', () => {
  assert.equal(monthKeyUtc(MAR), '2026-03');
  assert.equal(monthKeyUtc(APR), '2026-04');
  assert.equal(monthKeyUtc(Date.UTC(2026, 2, 31, 23, 59, 59)), '2026-03');
  assert.equal(monthKeyUtc(Date.UTC(2026, 3, 1, 0, 0, 0)), '2026-04');
  assert.equal(isTerminalLiveStatus('STOP'), true);
  assert.equal(isTerminalLiveStatus('NOT_FILLED'), true);
  assert.equal(isTerminalLiveStatus('OPEN'), false);
  assert.equal(isTerminalLiveStatus('PENDING_FILL'), false);
});

test('P12 retention: archivia solo i terminali di mesi chiusi e verifica il sidecar', () => {
  const file = retentionDir();
  const old = liveRecord('k-stop', 'STOP', MAR);
  const stillOpen = liveRecord('k-open-old', 'OPEN', MAR);
  const current = liveRecord('k-open-new', 'OPEN', APR);
  const res = archiveClosedMonths({ signalsPath: file, records: [old, stillOpen, current], nowMs: APR });

  assert.equal(res.archived, 1);
  assert.deepEqual(res.months, ['2026-03']);
  assert.deepEqual(res.notes, []);
  assert.deepEqual(
    res.records.map((r) => r.key),
    ['k-open-old', 'k-open-new'],
    'i non terminali restano attivi, anche se del mese scorso'
  );

  const archive = archivePathFor(file, '2026-03');
  assert.equal(fs.existsSync(archive), true);
  const archived = readJsonl(archive);
  assert.deepEqual(archived.map((r) => r.key), ['k-stop']);

  const content = fs.readFileSync(archive, 'utf8');
  const sidecar = fs.readFileSync(sidecarPathFor(archive), 'utf8').split('\n');
  assert.equal(sidecar[0], `${sha256Of(content)}  signals-2026-03.jsonl`);
  assert.equal(sidecar[1], `records=${countLines(content)}`);
  assert.equal(countLines(content), archived.length);
});

test('P12 retention: nessun I/O quando non ci sono mesi chiusi', () => {
  const file = retentionDir();
  const res = archiveClosedMonths({
    signalsPath: file,
    records: [liveRecord('a', 'STOP', APR), liveRecord('b', 'OPEN', APR)],
    nowMs: APR,
  });
  assert.equal(res.archived, 0);
  assert.equal(res.records.length, 2);
  assert.equal(fs.existsSync(path.dirname(file)), false, 'nessuna directory creata');
});

test('P12 retention: archivio non scrivibile => nessuna perdita, solo nota', () => {
  const file = retentionDir();
  const archive = archivePathFor(file, '2026-03');
  // Una directory al posto del file di archivio fa fallire il rename.
  fs.mkdirSync(archive, { recursive: true });
  const records = [liveRecord('k1', 'STOP', MAR), liveRecord('k2', 'OPEN', APR)];
  const res = archiveClosedMonths({ signalsPath: file, records, nowMs: APR });
  assert.equal(res.archived, 0, 'nessun record tolto dal file attivo');
  assert.deepEqual(res.records.map((r) => r.key), ['k1', 'k2']);
  assert.ok(res.notes.some((n) => n.includes('2026-03')), 'il fallimento e\' loggato');
});

test('P12 retention: un mese fallisce, l altro viene archiviato', () => {
  const file = retentionDir();
  fs.mkdirSync(archivePathFor(file, '2026-02'), { recursive: true });
  const feb = liveRecord('feb', 'TARGET', Date.UTC(2026, 1, 10, 14, 0, 0));
  const mar = liveRecord('mar', 'STOP', MAR);
  const res = archiveClosedMonths({ signalsPath: file, records: [feb, mar], nowMs: APR });
  assert.deepEqual(res.records.map((r) => r.key), ['feb'], 'febbraio resta attivo');
  assert.deepEqual(res.months, ['2026-03']);
  assert.equal(res.archived, 1);
  assert.deepEqual(readJsonl(archivePathFor(file, '2026-03')).map((r) => r.key), ['mar']);
});

test('P12 retention: unione per chiave, vince updatedAtMs piu alto', () => {
  const older = { ...liveRecord('k', 'STOP', MAR, MAR + 1000), r: 1 };
  const newer = { ...liveRecord('k', 'STOP', MAR, MAR + 5000), r: 2 };
  const merged = mergeByKey([older], [newer]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].r, 2);
});

test('P12 retention: elenco archivi deterministico e filtrato', () => {
  const file = retentionDir();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['signals-2026-03.jsonl', 'signals-2026-02.jsonl', 'signals.jsonl', 'altro.jsonl']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  assert.deepEqual(
    listArchivePaths(file).map((p) => path.basename(p)),
    ['signals-2026-02.jsonl', 'signals-2026-03.jsonl']
  );
  assert.equal(serializeRecords([]), '\n');
});

// --- P10: campo opzionale `source` -------------------------------------------

test('P10 source: persistito sui nuovi record, non sovrascritto in update', () => {
  const first = upsertObservation(
    [],
    { ...observation('PENDING_FILL'), source: 'client' },
    D0 + BAR_MS
  );
  assert.equal(first.records[0].source, 'client');

  const second = upsertObservation(
    first.records,
    { ...observation('PENDING_FILL', { source: 'server-scanner' }) },
    D0 + 2 * BAR_MS
  );
  assert.equal(second.records[0].source, 'client', 'la provenienza originale resta');

  const legacy = upsertObservation([], observation('PENDING_FILL'), D0 + BAR_MS);
  assert.equal('source' in legacy.records[0], false, 'senza source il campo non compare');
});

test('P10 source: observationFromResult propaga la provenienza', () => {
  const withSource = observationFromResult(
    { ...CTX, source: 'server-scanner' },
    result('PENDING_FILL')
  );
  assert.equal(withSource?.source, 'server-scanner');
  const without = observationFromResult(CTX, result('PENDING_FILL'));
  assert.equal('source' in (without ?? {}), false);
});

test('P10 source: record storici senza campo validi, valori non stringa scartati', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'signals.jsonl');
  const legacy = recordFrom(observation('PENDING_FILL'));
  const tagged = { ...legacy, source: 'client' as const };
  const wrongType = { ...legacy, source: 42 as unknown as string };
  const empty = { ...legacy, source: '' };
  fs.writeFileSync(
    file,
    [legacy, tagged, wrongType, empty].map((r) => JSON.stringify(r)).join('\n') + '\n'
  );
  const res = loadRecords(file);
  assert.equal(res.records.length, 2);
  assert.equal(res.skipped, 2);
  assert.equal(
    res.records.filter((r) => r.source === 'client').length,
    1,
    'il record con source valido e\' conservato'
  );
  assert.ok(
    res.records.some((r) => r.source === undefined),
    'il record storico senza source resta valido'
  );
});
