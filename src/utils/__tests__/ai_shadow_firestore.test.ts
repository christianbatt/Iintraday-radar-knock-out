/**
 * Test del sync del log shadow AI su Firestore e del fallback in lettura
 * dell'endpoint `/api/shadow/ai-log` (Fase 10).
 *
 * Adapter Firestore in memoria: nessun client reale, nessuna credenziale.
 * Tutto l'I/O su file usa `os.tmpdir()` rimosso a fine test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendAiShadowLog,
  buildAiShadowLogResponse,
  buildAiShadowLogResponseWithFallback,
  type AiShadowLogEntry,
} from '../../server/aiShadowLog';
import {
  AI_SHADOW_LOG_FIRESTORE_COLLECTION,
  AI_SHADOW_LOG_FIRESTORE_FLAG,
  aiShadowLogDocId,
  readAiShadowLogFromFirestore,
  syncAiShadowLogToFirestore,
} from '../../server/aiShadowLogFirestore';
import {
  resetShadowFirestoreSyncForTest,
  setShadowFirestoreAdapter,
  type ShadowFirestoreAdapter,
} from '../../server/shadowFirestoreSync';

interface MemoryAdapter extends ShadowFirestoreAdapter {
  docs: Map<string, Record<string, unknown>>;
  batchCalls: number;
  listCalls: number;
  setDocCalls: number;
  getDocCalls: number;
}

function makeAdapter(options: { failBatch?: boolean; failList?: boolean } = {}): MemoryAdapter {
  const docs = new Map<string, Record<string, unknown>>();
  const adapter: MemoryAdapter = {
    docs,
    batchCalls: 0,
    listCalls: 0,
    setDocCalls: 0,
    getDocCalls: 0,
    async getDoc(docPath) {
      adapter.getDocCalls += 1;
      return docs.get(docPath) ?? null;
    },
    async setDoc(docPath, data) {
      adapter.setDocCalls += 1;
      docs.set(docPath, data);
    },
    async listDocs(collectionPath) {
      adapter.listCalls += 1;
      if (options.failList) throw new Error('listDocs ko');
      const prefix = `${collectionPath}/`;
      const out: Array<{ id: string; data: Record<string, unknown> }> = [];
      for (const [docPath, data] of docs.entries()) {
        if (docPath.startsWith(prefix)) out.push({ id: docPath.slice(prefix.length), data });
      }
      return out;
    },
    async batchSetDocs(items) {
      adapter.batchCalls += 1;
      if (options.failBatch) throw new Error('batch ko');
      for (const item of items) docs.set(item.path, item.data);
    },
  };
  return adapter;
}

function entry(i: number, runId: string, timestampMs: number): AiShadowLogEntry {
  const ticker = `T${String(i).padStart(2, '0')}`;
  return {
    id: `id-${runId}-${ticker}`,
    timestamp: new Date(timestampMs).toISOString(),
    ticker,
    market: i % 2 === 0 ? 'EU' : 'US',
    direction: 'LONG',
    setup: 'scan score 50/100',
    aiOutcome: `OSSERVAZIONE_${ticker}`,
    aiCategory: 'CATEGORIA_TEST',
    source: 'scan',
    evaluated: true,
    discarded: false,
    discardReason: null,
    status: 'NON_VALIDATO',
    outcome: null,
    candidateSource: 'snapshot',
    candidateKey: `${runId}:${ticker}`,
    runId,
    durationMs: 10,
  };
}

const RUN_ID = '11111111-2222-4333-8444-555555555555';
const T0 = Date.UTC(2026, 10, 20, 10, 0, 0);

function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[AI_SHADOW_LOG_FIRESTORE_FLAG];
  if (value === undefined) delete process.env[AI_SHADOW_LOG_FIRESTORE_FLAG];
  else process.env[AI_SHADOW_LOG_FIRESTORE_FLAG] = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env[AI_SHADOW_LOG_FIRESTORE_FLAG];
    else process.env[AI_SHADOW_LOG_FIRESTORE_FLAG] = previous;
  });
}

describe('aiShadowLogFirestore — scrittura', () => {
  it('flag spento (default): zero chiamate Firestore, zero documenti', async () => {
    resetShadowFirestoreSyncForTest();
    const adapter = makeAdapter();
    setShadowFirestoreAdapter(adapter);
    const result = await withEnv(undefined, () =>
      syncAiShadowLogToFirestore(Array.from({ length: 40 }, (_, i) => entry(i, RUN_ID, T0 + i)))
    );
    assert.deepEqual(result, { ok: true, written: 0 });
    assert.equal(adapter.batchCalls, 0);
    assert.equal(adapter.setDocCalls, 0);
    assert.equal(adapter.listCalls, 0);
    assert.equal(adapter.docs.size, 0);
    resetShadowFirestoreSyncForTest();
  });

  it('flag acceso con 40 voci: un batch, 40 documenti, id runId__ticker', async () => {
    resetShadowFirestoreSyncForTest();
    const adapter = makeAdapter();
    setShadowFirestoreAdapter(adapter);
    const entries = Array.from({ length: 40 }, (_, i) => entry(i, RUN_ID, T0 + i));
    const result = await withEnv('1', () => syncAiShadowLogToFirestore(entries));
    assert.equal(result.ok, true);
    assert.equal(result.written, 40);
    assert.equal(adapter.batchCalls, 1);
    assert.equal(adapter.docs.size, 40);
    for (let i = 0; i < 40; i += 1) {
      const docId = aiShadowLogDocId(RUN_ID, `T${String(i).padStart(2, '0')}`);
      const docPath = `${AI_SHADOW_LOG_FIRESTORE_COLLECTION}/${docId}`;
      const doc = adapter.docs.get(docPath);
      assert.ok(doc, `documento mancante: ${docPath}`);
      assert.equal(doc.ticker, `T${String(i).padStart(2, '0')}`);
      assert.equal(doc.runId, RUN_ID);
      assert.equal(typeof (doc.createdAt as { toMillis?: unknown }).toMillis, 'function');
      assert.equal(typeof (doc.expiresAt as { toMillis?: unknown }).toMillis, 'function');
      const expiresMs = (doc.expiresAt as { toMillis: () => number }).toMillis();
      const createdMs = (doc.createdAt as { toMillis: () => number }).toMillis();
      assert.equal(expiresMs - createdMs, 90 * 24 * 60 * 60 * 1000);
    }
    resetShadowFirestoreSyncForTest();
  });

  it('scrittura che lancia: nessuna propagazione, ok false', async () => {
    resetShadowFirestoreSyncForTest();
    const adapter = makeAdapter({ failBatch: true });
    setShadowFirestoreAdapter(adapter);
    const result = await withEnv('1', () =>
      syncAiShadowLogToFirestore([entry(0, RUN_ID, T0)])
    );
    assert.equal(result.ok, false);
    assert.equal(result.written, 0);
    assert.equal(result.error, 'batch ko');
    assert.equal(adapter.batchCalls, 1);
    resetShadowFirestoreSyncForTest();
  });

  it('stessa runId:ticker due volte: un solo documento', async () => {
    resetShadowFirestoreSyncForTest();
    const adapter = makeAdapter();
    setShadowFirestoreAdapter(adapter);
    const first = entry(0, RUN_ID, T0);
    const second = { ...entry(0, RUN_ID, T0 + 1000), aiOutcome: 'SECONDA' };
    await withEnv('1', async () => {
      await syncAiShadowLogToFirestore([first]);
      await syncAiShadowLogToFirestore([second]);
    });
    assert.equal(adapter.docs.size, 1);
    const docPath = `${AI_SHADOW_LOG_FIRESTORE_COLLECTION}/${aiShadowLogDocId(RUN_ID, 'T00')}`;
    assert.equal(adapter.docs.get(docPath)?.aiOutcome, 'SECONDA');
    resetShadowFirestoreSyncForTest();
  });
});

describe('aiShadowLogFirestore — fallback in lettura dell\'endpoint', () => {
  it('file vuoto e flag acceso: le voci arrivano da Firestore', async () => {
    resetShadowFirestoreSyncForTest();
    const adapter = makeAdapter();
    setShadowFirestoreAdapter(adapter);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-fs-'));
    const file = path.join(dir, 'log.jsonl');
    try {
      await withEnv('1', async () => {
        await syncAiShadowLogToFirestore([
          entry(0, RUN_ID, T0),
          entry(1, RUN_ID, T0 + 60_000),
          entry(2, RUN_ID, T0 + 120_000),
        ]);
        const body = await buildAiShadowLogResponseWithFallback('2', file);
        assert.equal(body.count, 2);
        assert.equal(body.limit, 2);
        // La lettura remota usa lo stesso `limit`: al massimo 2 voci lette.
        assert.equal(body.total, 2);
        // Le tre voci arrivano da un unico batch di sync: `createdAt` coincide
        // al millisecondo, quindi l'ordine remoto e' quello di inserimento e le
        // due voci lette (limit 2) sono T00 e T01, restituite in ordine crescente.
        assert.deepEqual(
          body.entries.map((e) => e.ticker),
          ['T00', 'T01']
        );
        assert.equal(adapter.listCalls, 1);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      resetShadowFirestoreSyncForTest();
    }
  });

  it('lettura Firestore che lancia: resta la risposta del file, nessun errore', async () => {
    resetShadowFirestoreSyncForTest();
    const adapter = makeAdapter({ failList: true });
    setShadowFirestoreAdapter(adapter);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-fs-'));
    const file = path.join(dir, 'log.jsonl');
    try {
      appendAiShadowLog([entry(0, RUN_ID, T0)], file);
      const body = await withEnv('1', () => buildAiShadowLogResponseWithFallback('50', file));
      assert.equal(body.count, 1);
      assert.equal(body.total, 1);
      assert.deepEqual(
        body.entries.map((e) => e.ticker),
        ['T00']
      );
      assert.equal(adapter.listCalls, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      resetShadowFirestoreSyncForTest();
    }
  });

  it('flag spento: nessuna lettura Firestore anche con file vuoto', async () => {
    resetShadowFirestoreSyncForTest();
    const adapter = makeAdapter();
    setShadowFirestoreAdapter(adapter);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-fs-'));
    const file = path.join(dir, 'missing.jsonl');
    try {
      const body = await withEnv('0', () => buildAiShadowLogResponseWithFallback('50', file));
      assert.equal(body.count, 0);
      assert.equal(body.total, 0);
      assert.equal(adapter.listCalls, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      resetShadowFirestoreSyncForTest();
    }
  });

  it('forma della risposta invariata rispetto al percorso solo-file', async () => {
    resetShadowFirestoreSyncForTest();
    const adapter = makeAdapter();
    setShadowFirestoreAdapter(adapter);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-fs-'));
    const file = path.join(dir, 'log.jsonl');
    try {
      appendAiShadowLog([entry(0, RUN_ID, T0)], file);
      const base = buildAiShadowLogResponse('50', file);
      const withFallback = await withEnv('1', () =>
        buildAiShadowLogResponseWithFallback('50', file)
      );
      assert.deepEqual(Object.keys(withFallback).sort(), Object.keys(base).sort());
      assert.deepEqual(
        Object.keys(withFallback.entries[0]).sort(),
        Object.keys(base.entries[0]).sort()
      );
      assert.equal(typeof withFallback.count, 'number');
      assert.equal(typeof withFallback.total, 'number');
      assert.equal(typeof withFallback.limit, 'number');
      assert.equal(typeof withFallback.byStatus, 'object');
      assert.equal(typeof withFallback.byDiscarded, 'object');
      assert.equal(typeof withFallback.byEvaluated, 'object');
      assert.deepEqual(withFallback.entries, base.entries);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      resetShadowFirestoreSyncForTest();
    }
  });

  it('flag acceso senza adapter: lettura remota vuota, risposta del file', async () => {
    resetShadowFirestoreSyncForTest();
    const result = await withEnv('1', () => readAiShadowLogFromFirestore(10));
    assert.deepEqual(result, []);
  });
});
