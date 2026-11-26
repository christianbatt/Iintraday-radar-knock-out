/**
 * Test di persistenza e idratazione bidirezionale Shadow V1-live + Near-Miss + Shadow V2 su Firestore.
 *
 * Tutto l'I/O usa `os.tmpdir()` e un adapter in-memory: nessuna scrittura su `artifacts/`
 * ne' chiamate di rete verso Firebase.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeShadowV2, type ShadowV2Record } from '../../knowledge/shadowV2';
import {
  clearShadowV1LiveBarsForTest,
  createObserveHandler,
  recordBarsForShadowV1Live,
  runShadowV1LiveRevaluationCycle,
  SHADOW_V1_LIVE_BAR_MS,
} from '../../server/shadowV1LiveCollector';
import {
  SHADOW_V1_ACTIVE_BARS_DOC,
  SHADOW_V1_DIAGNOSTICS_DOC,
  SHADOW_V1_LIVE_MARKS_DOC,
  SHADOW_V1_NEAR_MISS_COLLECTION,
  SHADOW_V1_SIGNALS_COLLECTION,
  SHADOW_V2_SIGNALS_COLLECTION,
  SHADOW_V2_SUMMARY_DOC,
  flushPendingShadowFirestoreSync,
  hydrateAllShadowStateFromFirestore,
  mergeShadowV2RecordsMonotone,
  mergeV1LiveRecordsMonotone,
  resetShadowFirestoreSyncForTest,
  setShadowFirestoreAdapter,
  shadowDocIdForKey,
  syncShadowV1LiveRecordsToFirestore,
  type ShadowFirestoreAdapter,
} from '../../server/shadowFirestoreSync';
import { loadRecords, SHADOW_V1_LIVE_SIGNALS_PATH, type PersistedShadowV1LiveRecord } from '../../server/shadowV1LiveStore';
import { loadNearMissRecords, SHADOW_V1_NEAR_MISS_PATH, type ShadowV1NearMissRecord } from '../../server/shadowV1LiveNearMiss';
import { loadShadowV2Records, observeShadowV2Scan, clearShadowV2BarsForTest, recordClosedBarsForShadowV2 } from '../../server/shadowV2Collector';

function createMemoryFirestoreAdapter(): ShadowFirestoreAdapter & {
  docs: Map<string, Record<string, unknown>>;
  writeCalls: number;
} {
  const docs = new Map<string, Record<string, unknown>>();
  const adapter = {
    docs,
    writeCalls: 0,
    async getDoc(docPath: string) {
      const hit = docs.get(docPath);
      return hit ? structuredClone(hit) : null;
    },
    async setDoc(docPath: string, data: Record<string, unknown>) {
      adapter.writeCalls += 1;
      docs.set(docPath, structuredClone(data));
    },
    async listDocs(collectionPath: string) {
      const prefix = `${collectionPath}/`;
      const out: Array<{ id: string; data: Record<string, unknown> }> = [];
      for (const [k, v] of docs.entries()) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          if (!rest.includes('/')) {
            out.push({ id: rest, data: structuredClone(v) });
          }
        }
      }
      return out;
    },
    async batchSetDocs(items: Array<{ path: string; data: Record<string, unknown> }>) {
      if (items.length === 0) return;
      adapter.writeCalls += 1;
      for (const item of items) {
        docs.set(item.path, structuredClone(item.data));
      }
    },
  };
  return adapter;
}

function sampleV1Record(over: Partial<PersistedShadowV1LiveRecord> = {}): PersistedShadowV1LiveRecord {
  const decidedAtMs = Date.UTC(2026, 10, 19, 14, 0, 0); // 2026-11-19T14:00Z
  const sessionCloseMs = Date.UTC(2026, 10, 19, 16, 30, 0);
  return {
    v: 1,
    moduleVersion: 'shadowV1Live@3',
    key: over.key ?? 'SAP.DE|LONG|2026-11-19|1',
    ticker: over.ticker ?? 'SAP.DE',
    market: over.market ?? 'EU',
    direction: over.direction ?? 'LONG',
    entry: 200,
    stop: 198,
    target: 204,
    decidedAtMs,
    sessionCloseMs,
    firstSeenAtMs: decidedAtMs + 10_000,
    status: over.status ?? 'OPEN',
    r: over.r !== undefined ? over.r : null,
    reason: null,
    fillBarTs: over.fillBarTs !== undefined ? over.fillBarTs : decidedAtMs + 5 * 60_000,
    exitBarTs: over.exitBarTs !== undefined ? over.exitBarTs : null,
    exitPrice: over.exitPrice !== undefined ? over.exitPrice : null,
    updatedAtMs: decidedAtMs + 60_000,
    ...over,
  };
}

function sampleV2Record(over: Partial<ShadowV2Record> = {}): ShadowV2Record {
  const ts = over.signalBarTs ?? Date.UTC(2026, 10, 19, 14, 5, 0);
  return {
    id: over.id ?? `v2|SAP.DE|${ts}`,
    sessionDate: '2026-11-19',
    ticker: 'SAP.DE',
    market: 'EU',
    direction: 'LONG',
    triggerType: 'CUSUM_DISPLACEMENT',
    signalBarTs: ts,
    signalTimeIso: new Date(ts).toISOString(),
    entryBarTs: ts + 300_000,
    refSignalClose: 200,
    entryPrice: 200,
    structuralStop: 198,
    target1: 204,
    riskDist: 2,
    leverage: 10,
    koBarrier: 184,
    status: 'RESOLVED',
    outcome: 'TARGET_1',
    blockedReason: null,
    exitBarTs: ts + 1_200_000,
    exitPrice: 204,
    barsHeld: 4,
    rGross: 2.0,
    rNet: 1.85,
    csSpreadPct: 0.04,
    amihud: 0.001,
    varSpreadR: 0.05,
    totalFrictionR: 0.15,
    totalFrictionR2500: 0.08,
    diagnostics: {
      vwapAtSignal: 199.5,
      atr5mAtSignal: 0.5,
      adxAtSignal: 24,
      pullbackDistAtr: 0.2,
      pullbackVolRatio: 0.7,
      reclaimVolRatio: 1.6,
      cusumZ: 2.4,
      gapPct: 0.1,
    },
    ...over,
  };
}

test('merge monotone V1 e V2 non regredisce mai stati terminali', () => {
  const openV1 = sampleV1Record({ status: 'OPEN', updatedAtMs: 2_000 });
  const closedV1 = sampleV1Record({
    status: 'TARGET',
    r: 2.0,
    exitBarTs: openV1.decidedAtMs + 600_000,
    exitPrice: 204,
    updatedAtMs: 1_000,
  });
  const mergedV1 = mergeV1LiveRecordsMonotone([closedV1], [openV1]);
  assert.equal(mergedV1.length, 1);
  assert.equal(mergedV1[0].status, 'TARGET');
  assert.equal(mergedV1[0].r, 2.0);

  const openV2 = sampleV2Record({ id: 'a1', status: 'OPEN', outcome: 'OPEN', rNet: null, barsHeld: 3 });
  const closedV2 = sampleV2Record({ id: 'a1', status: 'RESOLVED', outcome: 'TARGET_1', rNet: 1.5, barsHeld: 5 });
  const mergedV2 = mergeShadowV2RecordsMonotone([closedV2], [openV2]);
  assert.equal(mergedV2.length, 1);
  assert.equal(mergedV2[0].status, 'RESOLVED');
  assert.equal(mergedV2[0].outcome, 'TARGET_1');
});

test('diff cache evita scritture ripetute verso Firestore su record invariati', async () => {
  resetShadowFirestoreSyncForTest();
  const adapter = createMemoryFirestoreAdapter();
  setShadowFirestoreAdapter(adapter);
  try {
    const rec = sampleV1Record();
    await syncShadowV1LiveRecordsToFirestore([rec]);
    assert.equal(adapter.writeCalls, 1);
    await syncShadowV1LiveRecordsToFirestore([rec]);
    assert.equal(adapter.writeCalls, 1, 'secondo sync identico deve essere skippato dal diff cache');
  } finally {
    resetShadowFirestoreSyncForTest();
  }
});

test('idratazione all avvio ripristina V1-live (aperti+chiusi), Near-Miss, Diagnostica, Marks, ActiveBars e V2 su disco vuoto', async () => {
  resetShadowFirestoreSyncForTest();
  clearShadowV1LiveBarsForTest();
  const adapter = createMemoryFirestoreAdapter();
  setShadowFirestoreAdapter(adapter);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-hydrate-'));

  try {
    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    const v1Open = sampleV1Record({ key: 'SAP.DE|LONG|open', status: 'OPEN' });
    const v1Closed = sampleV1Record({
      key: 'NVDA|LONG|closed',
      ticker: 'NVDA',
      market: 'US',
      status: 'TARGET',
      r: 2.0,
      exitBarTs: v1Open.decidedAtMs + 600_000,
      exitPrice: 150,
    });
    adapter.docs.set(
      `${SHADOW_V1_SIGNALS_COLLECTION}/${shadowDocIdForKey(v1Open.key)}`,
      structuredClone(v1Open) as unknown as Record<string, unknown>
    );
    adapter.docs.set(
      `${SHADOW_V1_SIGNALS_COLLECTION}/${shadowDocIdForKey(v1Closed.key)}`,
      structuredClone(v1Closed) as unknown as Record<string, unknown>
    );

    const nm: ShadowV1NearMissRecord = {
      id: 'EU|AIR.PA|2026-11-20|G11_SCORE',
      ticker: 'AIR.PA',
      market: 'EU',
      sessionDate: '2026-11-20',
      direction: 'LONG',
      nearMissGate: 'G11_SCORE',
      gateDetail: 'Score 64 vs 65',
      score: 64,
      adxValue: 22,
      extensionPct: 0.2,
      entryLevel: 150,
      stopLossLevel: 148,
      target1Level: 154,
      decidedAtMs: nowMs - 600_000,
      sessionCloseMs: Date.UTC(2026, 10, 20, 16, 30, 0),
      status: 'OPEN',
      r: null,
      fillBarTs: nowMs - 300_000,
      exitBarTs: null,
      exitPrice: null,
      updatedAtMs: nowMs - 300_000,
    };
    adapter.docs.set(
      `${SHADOW_V1_NEAR_MISS_COLLECTION}/${shadowDocIdForKey(nm.id)}`,
      structuredClone(nm) as unknown as Record<string, unknown>
    );
    adapter.docs.set(SHADOW_V1_DIAGNOSTICS_DOC, {
      payload: {
        version: 1,
        lastScanAt: new Date(nowMs - 60_000).toISOString(),
        scannedTickers: 40,
        evaluatedTickers: 40,
        emittedThisScan: 1,
        persistedThisScan: 1,
        blockedThisScan: 39,
        topEU: 'SAP.DE',
        topUS: 'NVDA',
        gateCounts: [],
        sampleCandidates: [],
      },
    });
    adapter.docs.set(SHADOW_V1_LIVE_MARKS_DOC, {
      payload: {
        version: 1,
        updatedAt: new Date(nowMs - 60_000).toISOString(),
        marks: [
          {
            key: v1Open.key,
            ticker: 'SAP.DE',
            market: 'EU',
            direction: 'LONG',
            status: 'OPEN',
            currency: 'EUR',
            lastPrice: 201.5,
            lastPriceAtMs: nowMs - 60_000,
            unrealizedR: 0.75,
            pctFromEntry: 0.75,
            priceSource: 'quote',
          },
        ],
      },
    });
    adapter.docs.set(SHADOW_V1_ACTIVE_BARS_DOC, {
      version: 1,
      entries: [
        {
          ticker: 'SAP.DE',
          market: 'EU',
          updatedAt: nowMs - 300_000,
          bars: [
            { t: v1Open.decidedAtMs + 300_000, o: 200, h: 201.8, l: 199.9, c: 201.5 },
          ],
        },
      ],
    });

    const v2Closed = sampleV2Record({ id: 'v2-closed', status: 'RESOLVED', outcome: 'TARGET_1', rNet: 1.9 });
    const v2Open = sampleV2Record({
      id: 'v2-open',
      status: 'OPEN',
      outcome: 'OPEN',
      rNet: null,
      rGross: null,
      signalBarTs: Date.UTC(2026, 10, 20, 11, 0, 0),
    });
    adapter.docs.set(
      `${SHADOW_V2_SIGNALS_COLLECTION}/${shadowDocIdForKey(v2Closed.id)}`,
      structuredClone(v2Closed) as unknown as Record<string, unknown>
    );
    adapter.docs.set(
      `${SHADOW_V2_SIGNALS_COLLECTION}/${shadowDocIdForKey(v2Open.id)}`,
      structuredClone(v2Open) as unknown as Record<string, unknown>
    );

    // Simula disco locale che ha un segnale V2 locale extra non ancora sul cloud
    const localOnlyV2 = sampleV2Record({
      id: 'v2-local-only',
      status: 'RESOLVED',
      outcome: 'STOP',
      rNet: -1.1,
      signalBarTs: Date.UTC(2026, 10, 18, 10, 0, 0),
    });
    const v2Dir = path.join(tmpRoot, 'artifacts', 'shadow_v2');
    fs.mkdirSync(v2Dir, { recursive: true });
    fs.writeFileSync(path.join(v2Dir, 'signals.jsonl'), JSON.stringify(localOnlyV2) + '\n', 'utf8');

    const seededTickers: string[] = [];
    const report = await hydrateAllShadowStateFromFirestore(tmpRoot, {
      nowMs,
      seedV1Bars: (ticker, market, bars, ts) => {
        seededTickers.push(ticker);
        recordBarsForShadowV1Live(ticker, market, bars, ts);
      },
    });
    await flushPendingShadowFirestoreSync();

    assert.equal(report.v1SignalsMerged, 2);
    assert.equal(report.v1NearMissMerged, 1);
    assert.equal(report.v2SignalsMerged, 3);
    assert.equal(report.diagnosticsRestored, true);
    assert.equal(report.activeBarsRestored, 1);
    assert.deepEqual(seededTickers, ['SAP.DE']);

    const restoredV1 = loadRecords(path.join(tmpRoot, SHADOW_V1_LIVE_SIGNALS_PATH)).records;
    assert.equal(restoredV1.length, 2);
    assert.ok(restoredV1.some((r) => r.key === v1Open.key && r.status === 'OPEN'));
    assert.ok(restoredV1.some((r) => r.key === v1Closed.key && r.status === 'TARGET'));

    const restoredNm = loadNearMissRecords(path.join(tmpRoot, SHADOW_V1_NEAR_MISS_PATH));
    assert.equal(restoredNm.length, 1);
    assert.equal(restoredNm[0].id, nm.id);

    assert.ok(fs.existsSync(path.join(tmpRoot, 'artifacts', 'shadow_v1_live', 'scan_diagnostics.json')));
    assert.ok(fs.existsSync(path.join(tmpRoot, 'artifacts', 'shadow_v1_live', 'live_marks.json')));

    const restoredV2 = loadShadowV2Records(path.join(v2Dir, 'signals.jsonl'));
    assert.equal(restoredV2.length, 3);
    assert.ok(fs.existsSync(path.join(v2Dir, 'summary.json')));

    // Anche il record V2 locale deve essere salito su Firestore!
    assert.ok(adapter.docs.has(`${SHADOW_V2_SIGNALS_COLLECTION}/${shadowDocIdForKey(localOnlyV2.id)}`));
    assert.ok(adapter.docs.has(SHADOW_V2_SUMMARY_DOC));
  } finally {
    clearShadowV1LiveBarsForTest();
    resetShadowFirestoreSyncForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collector V1-live e collector V2 propagano le mutazioni su Firestore end-to-end', async () => {
  resetShadowFirestoreSyncForTest();
  clearShadowV1LiveBarsForTest();
  clearShadowV2BarsForTest();
  const adapter = createMemoryFirestoreAdapter();
  setShadowFirestoreAdapter(adapter);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-e2e-'));

  try {
    const signalsPath = path.join(tmpRoot, SHADOW_V1_LIVE_SIGNALS_PATH);
    const decidedAtMs = Date.UTC(2026, 10, 19, 14, 0, 0);
    const bar1Ts = decidedAtMs + SHADOW_V1_LIVE_BAR_MS;
    const bar2Ts = decidedAtMs + 2 * SHADOW_V1_LIVE_BAR_MS;
    const bar1 = { t: bar1Ts, o: 100.2, h: 100.3, l: 99.9, c: 100.1 };
    const bar2 = { t: bar2Ts, o: 100.1, h: 104.5, l: 100.1, c: 104.2 };

    recordBarsForShadowV1Live('NVDA', 'US', [bar1], bar1Ts + SHADOW_V1_LIVE_BAR_MS);

    // L'istante della decisione lo fissa il server alla POST (deps.now), non il
    // `calculatedAt` del client: il setup nasce a D0, quando la barra di fill
    // (D0+5m) non esiste ancora. La barra che tocca l'entry arriva al ciclo.
    let fakeNow = decidedAtMs;
    const handler = createObserveHandler({
      env: {},
      signalsPath,
      now: () => fakeNow,
      bars: () => [],
    });

    const resp = await handler({
      body: {
        ticker: 'NVDA',
        market: 'US',
        direction: 'LONG',
        entry: 100,
        stop: 98,
        target: 104,
        calculatedAt: new Date(decidedAtMs).toISOString(),
      },
      skipRateLimit: true,
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.body.outcome, 'PENDING_FILL');
    await flushPendingShadowFirestoreSync();

    const v1RemotePending = await adapter.listDocs(SHADOW_V1_SIGNALS_COLLECTION);
    assert.equal(v1RemotePending.length, 1);
    assert.equal(v1RemotePending[0].data.status, 'PENDING_FILL');

    // Prima barra chiusa che tocca l'entry 100 -> OPEN sullo stesso documento.
    fakeNow = bar1Ts + SHADOW_V1_LIVE_BAR_MS;
    await runShadowV1LiveRevaluationCycle({
      env: {},
      signalsPath,
      now: () => fakeNow,
      bars: () => [bar1],
    });
    await flushPendingShadowFirestoreSync();

    // Deve esistere su Firestore come OPEN
    const v1Remote1 = await adapter.listDocs(SHADOW_V1_SIGNALS_COLLECTION);
    assert.equal(v1Remote1.length, 1);
    assert.equal(v1Remote1[0].data.status, 'OPEN');

    // Seconda barra tocca target 104 -> TARGET deve aggiornare lo stesso documento su Firestore
    fakeNow = bar2Ts + SHADOW_V1_LIVE_BAR_MS;
    await runShadowV1LiveRevaluationCycle({
      env: {},
      signalsPath,
      now: () => fakeNow,
      bars: () => [bar1, bar2],
    });
    await flushPendingShadowFirestoreSync();

    const v1Remote2 = await adapter.listDocs(SHADOW_V1_SIGNALS_COLLECTION);
    assert.equal(v1Remote2.length, 1);
    assert.equal(v1Remote2[0].data.status, 'TARGET');

    // Anche V2 con record sintetico/vuoto + barre reali non deve lanciare e aggiorna summary
    const v2Summary = observeShadowV2Scan([], tmpRoot, fakeNow);
    assert.ok(v2Summary);
    recordClosedBarsForShadowV2('NVDA', 'US', [], fakeNow);
    await flushPendingShadowFirestoreSync();
  } finally {
    clearShadowV1LiveBarsForTest();
    clearShadowV2BarsForTest();
    resetShadowFirestoreSyncForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('summarizeShadowV2 recentSignals tiene le posizioni OPEN/PENDING_OPEN in testa anche con >25 blocchi recenti', () => {
  const baseTs = Date.UTC(2026, 10, 20, 10, 0, 0);
  const oldOpen = sampleV2Record({
    id: 'open-oldest',
    ticker: 'ENI.MI',
    status: 'OPEN',
    outcome: 'OPEN',
    rNet: null,
    rGross: null,
    signalBarTs: baseTs - 10_000_000,
  });
  const manyBlocked: ShadowV2Record[] = Array.from({ length: 30 }, (_, i) =>
    sampleV2Record({
      id: `blocked-${i}`,
      status: 'BLOCKED',
      outcome: 'BLOCKED',
      blockedReason: 'COST',
      rNet: null,
      rGross: null,
      signalBarTs: baseTs + i * 300_000,
    })
  );
  const summary = summarizeShadowV2([oldOpen, ...manyBlocked], new Date(baseTs).toISOString());
  assert.equal(summary.recentSignals.length, 25);
  assert.equal(summary.recentSignals[0].id, 'open-oldest');
});

function backupFilesIn(dir: string, prefix: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${prefix}.bak-`))
    .sort();
}

test('idratazione V1: righe corrotte o con versione diversa finiscono in .bak, le valide restano', async () => {
  resetShadowFirestoreSyncForTest();
  clearShadowV1LiveBarsForTest();
  setShadowFirestoreAdapter(createMemoryFirestoreAdapter());
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-bak-v1-'));

  try {
    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    const valid = sampleV1Record({ key: 'BAK|LONG|2026-11-19|1', status: 'OPEN' });
    const corrupt = '{"key":"rotto"';
    const wrongVersion = JSON.stringify({ ...sampleV1Record({ key: 'OLD|LONG|2026-11-19|1' }), v: 2 });
    const dir = path.join(tmpRoot, 'artifacts', 'shadow_v1_live');
    fs.mkdirSync(dir, { recursive: true });
    const signalsPath = path.join(tmpRoot, SHADOW_V1_LIVE_SIGNALS_PATH);
    const original = `${JSON.stringify(valid)}\n${corrupt}\n${wrongVersion}\n`;
    fs.writeFileSync(signalsPath, original, 'utf8');

    const report = await hydrateAllShadowStateFromFirestore(tmpRoot, { nowMs, seedV1Bars: () => {} });

    assert.equal(report.v1SignalsMerged, 1, 'solo la riga valida resta nel ledger');
    assert.equal(loadRecords(signalsPath).records.length, 1);
    const backups = backupFilesIn(dir, 'signals.jsonl');
    assert.equal(backups.length, 1, 'deve esistere esattamente una copia di sicurezza');
    assert.equal(
      fs.readFileSync(path.join(dir, backups[0]), 'utf8'),
      original,
      'il backup conserva le righe originali, comprese quelle scartate'
    );
  } finally {
    clearShadowV1LiveBarsForTest();
    resetShadowFirestoreSyncForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('idratazione V1: un file pulito non crea alcun .bak', async () => {
  resetShadowFirestoreSyncForTest();
  clearShadowV1LiveBarsForTest();
  setShadowFirestoreAdapter(createMemoryFirestoreAdapter());
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-bak-clean-'));

  try {
    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    const valid = sampleV1Record({ key: 'CLEAN|LONG|2026-11-19|1', status: 'OPEN' });
    const dir = path.join(tmpRoot, 'artifacts', 'shadow_v1_live');
    fs.mkdirSync(dir, { recursive: true });
    const signalsPath = path.join(tmpRoot, SHADOW_V1_LIVE_SIGNALS_PATH);
    fs.writeFileSync(signalsPath, `${JSON.stringify(valid)}\n`, 'utf8');

    const report = await hydrateAllShadowStateFromFirestore(tmpRoot, { nowMs, seedV1Bars: () => {} });

    assert.equal(report.v1SignalsMerged, 1);
    assert.equal(loadRecords(signalsPath).records.length, 1);
    assert.deepEqual(backupFilesIn(dir, 'signals.jsonl'), [], 'nessun backup su file pulito');
  } finally {
    clearShadowV1LiveBarsForTest();
    resetShadowFirestoreSyncForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('idratazione near-miss: le righe non valide finiscono in .bak', async () => {
  resetShadowFirestoreSyncForTest();
  clearShadowV1LiveBarsForTest();
  setShadowFirestoreAdapter(createMemoryFirestoreAdapter());
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-bak-nm-'));

  try {
    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    const nm: ShadowV1NearMissRecord = {
      id: 'EU|AIR.PA|2026-11-20|G11_SCORE',
      ticker: 'AIR.PA',
      market: 'EU',
      sessionDate: '2026-11-20',
      direction: 'LONG',
      nearMissGate: 'G11_SCORE',
      gateDetail: 'Score 64 vs 65',
      score: 64,
      adxValue: 22,
      extensionPct: 0.2,
      entryLevel: 150,
      stopLossLevel: 148,
      target1Level: 154,
      decidedAtMs: nowMs - 600_000,
      sessionCloseMs: Date.UTC(2026, 10, 20, 16, 30, 0),
      status: 'OPEN',
      r: null,
      fillBarTs: nowMs - 300_000,
      exitBarTs: null,
      exitPrice: null,
      updatedAtMs: nowMs - 300_000,
    };
    const dir = path.join(tmpRoot, 'artifacts', 'shadow_v1_live');
    fs.mkdirSync(dir, { recursive: true });
    const nearMissPath = path.join(tmpRoot, SHADOW_V1_NEAR_MISS_PATH);
    const original = `${JSON.stringify(nm)}\nnon-json\n${JSON.stringify({ ticker: 'X' })}\n`;
    fs.writeFileSync(nearMissPath, original, 'utf8');

    const report = await hydrateAllShadowStateFromFirestore(tmpRoot, { nowMs, seedV1Bars: () => {} });

    assert.equal(report.v1NearMissMerged, 1);
    assert.equal(loadNearMissRecords(nearMissPath).length, 1);
    const backups = backupFilesIn(dir, 'near_miss.jsonl');
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
  } finally {
    clearShadowV1LiveBarsForTest();
    resetShadowFirestoreSyncForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('idratazione V2: le righe non valide finiscono in .bak', async () => {
  resetShadowFirestoreSyncForTest();
  clearShadowV1LiveBarsForTest();
  setShadowFirestoreAdapter(createMemoryFirestoreAdapter());
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-bak-v2-'));

  try {
    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    const v2a = sampleV2Record({ id: 'v2-bak-a' });
    const v2b = sampleV2Record({ id: 'v2-bak-b' });
    const dir = path.join(tmpRoot, 'artifacts', 'shadow_v2');
    fs.mkdirSync(dir, { recursive: true });
    const signalsPath = path.join(dir, 'signals.jsonl');
    const original = `${JSON.stringify(v2a)}\n${JSON.stringify(v2b)}\nriga-rotta\n`;
    fs.writeFileSync(signalsPath, original, 'utf8');

    const report = await hydrateAllShadowStateFromFirestore(tmpRoot, { nowMs, seedV1Bars: () => {} });

    assert.equal(report.v2SignalsMerged, 2);
    assert.equal(loadShadowV2Records(signalsPath).length, 2);
    const backups = backupFilesIn(dir, 'signals.jsonl');
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
  } finally {
    clearShadowV1LiveBarsForTest();
    resetShadowFirestoreSyncForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('idratazione V1 serializza la scrittura locale in coda evitando race con observe concorrenti e salva active_bars su disco', async () => {
  resetShadowFirestoreSyncForTest();
  clearShadowV1LiveBarsForTest();
  const baseAdapter = createMemoryFirestoreAdapter();
  let releaseV1List!: () => void;
  const v1ListStarted = new Promise<void>((resolve) => {
    const gate = new Promise<void>((r) => {
      releaseV1List = r;
    });
    setShadowFirestoreAdapter({
      ...baseAdapter,
      async listDocs(collectionPath: string) {
        if (collectionPath === SHADOW_V1_SIGNALS_COLLECTION) {
          resolve();
          await gate;
        }
        return baseAdapter.listDocs(collectionPath);
      },
    });
  });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-race-v1-'));

  try {
    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    const remoteRec = sampleV1Record({
      key: 'SAP.DE|LONG|remote-race',
      ticker: 'SAP.DE',
      market: 'EU',
      status: 'TARGET',
      r: 2.0,
      exitBarTs: nowMs - 60_000,
      exitPrice: 204,
    });
    baseAdapter.docs.set(
      `${SHADOW_V1_SIGNALS_COLLECTION}/${shadowDocIdForKey(remoteRec.key)}`,
      structuredClone(remoteRec) as unknown as Record<string, unknown>
    );
    baseAdapter.docs.set(SHADOW_V1_ACTIVE_BARS_DOC, {
      version: 1,
      entries: [
        {
          ticker: 'SAP.DE',
          market: 'EU',
          updatedAt: nowMs - 60_000,
          bars: [{ t: nowMs - 300_000, o: 200, h: 201, l: 199.5, c: 200.8 }],
        },
      ],
    });

    const hydrationPromise = hydrateAllShadowStateFromFirestore(tmpRoot, {
      nowMs,
      activeBarsPath: path.join(tmpRoot, 'artifacts', 'shadow_v1_live', 'active_bars.json'),
    });

    // Attende che hydrate sia fermo su listDocs Firestore, poi esegue un observe locale concorrente
    await v1ListStarted;
    const signalsPath = path.join(tmpRoot, SHADOW_V1_LIVE_SIGNALS_PATH);
    const decidedAtMs = Date.UTC(2026, 10, 20, 11, 55, 0);
    const handler = createObserveHandler({
      env: {},
      signalsPath,
      now: () => nowMs,
      bars: () => [],
    });
    const obsRes = await handler({
      body: {
        ticker: 'NVDA',
        market: 'US',
        direction: 'LONG',
        entry: 140,
        stop: 138,
        target: 144,
        calculatedAt: new Date(decidedAtMs).toISOString(),
      },
      skipRateLimit: true,
    });
    assert.equal(obsRes.status, 200);

    releaseV1List();
    const report = await hydrationPromise;
    await flushPendingShadowFirestoreSync();

    const merged = loadRecords(signalsPath).records;
    assert.equal(merged.length, 2, 'entrambi i record (remoto + observe concorrente) devono persistere');
    assert.ok(merged.some((r) => r.key === remoteRec.key && r.status === 'TARGET'));
    assert.ok(merged.some((r) => r.ticker === 'NVDA' && r.status === 'PENDING_FILL'));
    assert.equal(report.activeBarsRestored, 1);
    const barsFile = path.join(tmpRoot, 'artifacts', 'shadow_v1_live', 'active_bars.json');
    assert.ok(fs.existsSync(barsFile), 'active_bars.json deve essere flushato su disco dopo idratazione');
  } finally {
    clearShadowV1LiveBarsForTest();
    resetShadowFirestoreSyncForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

