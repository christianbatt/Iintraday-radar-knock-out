/**
 * Percorso Firestore REALE della calibrazione, senza credenziali:
 * sync del log AI su un adapter in memoria, poi lettura con
 * `readAiShadowLogFallbackDetailed` che usa `readAiShadowLogFromFirestore`
 * (nessun `readRemote` iniettato). Verifica `remoteEntries`, la precedenza del
 * file locale sui documenti remoti e l'effetto sui conteggi della risposta.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendAiShadowLog,
  readAiShadowLogFallbackDetailed,
  type AiShadowLogEntry,
} from '../../server/aiShadowLog';
import {
  AI_SHADOW_LOG_FIRESTORE_COLLECTION,
  syncAiShadowLogToFirestore,
} from '../../server/aiShadowLogFirestore';
import {
  resetShadowFirestoreSyncForTest,
  setShadowFirestoreAdapter,
  type ShadowFirestoreAdapter,
} from '../../server/shadowFirestoreSync';
import {
  createAiCalibrationHandler,
  type AiCalibrationForwardPoint,
} from '../../server/aiCalibration';

const TMP = path.join(process.cwd(), 'artifacts', '_tmp_calibration_firestore.jsonl');
const RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);
const ENV_ON = { SHADOW_AI_LOG_FIRESTORE: '1' };

interface MemoryAdapter extends ShadowFirestoreAdapter {
  docs: Map<string, Record<string, unknown>>;
  batchCalls: number;
}

function makeAdapter(): MemoryAdapter {
  const docs = new Map<string, Record<string, unknown>>();
  const adapter: MemoryAdapter = {
    docs,
    batchCalls: 0,
    async getDoc(docPath) {
      return docs.get(docPath) ?? null;
    },
    async setDoc(docPath, data) {
      docs.set(docPath, data);
    },
    async listDocs(collectionPath) {
      const prefix = `${collectionPath}/`;
      const out: Array<{ id: string; data: Record<string, unknown> }> = [];
      for (const [docPath, data] of docs.entries()) {
        if (docPath.startsWith(prefix)) out.push({ id: docPath.slice(prefix.length), data });
      }
      return out;
    },
    async listRecentDocs(collectionPath, orderByField, limit) {
      const listed = await adapter.listDocs(collectionPath);
      const millisOf = (value: unknown): number => {
        if (value && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
          return (value as { toMillis: () => number }).toMillis();
        }
        return 0;
      };
      return listed
        .sort(
          (a, b) => millisOf(b.data[orderByField]) - millisOf(a.data[orderByField])
        )
        .slice(0, limit);
    },
    async batchSetDocs(items) {
      adapter.batchCalls += 1;
      for (const item of items) docs.set(item.path, item.data);
    },
  };
  return adapter;
}

function entry(
  ticker: string,
  partial: Partial<AiShadowLogEntry> = {}
): AiShadowLogEntry {
  return {
    id: `${RUN_ID}-${ticker}`,
    timestamp: new Date(T0).toISOString(),
    ticker,
    market: 'EU',
    direction: 'LONG',
    setup: 'scan score 70/100',
    aiOutcome: 'edge chiaro',
    aiCategory: 'BREAKOUT',
    source: 'scan',
    evaluated: true,
    discarded: false,
    discardReason: null,
    status: 'NON_VALIDATO',
    outcome: null,
    candidateSource: 'snapshot',
    candidateKey: `${RUN_ID}:${ticker}`,
    runId: RUN_ID,
    durationMs: 12,
    ...partial,
  };
}

function reset(): void {
  fs.rmSync(TMP, { force: true });
  resetShadowFirestoreSyncForTest();
}

describe('calibrazione — percorso Firestore end-to-end', () => {
  it('sync su adapter in memoria e lettura: remoteEntries conta i documenti usati', async () => {
    reset();
    const adapter = makeAdapter();
    setShadowFirestoreAdapter(adapter);

    const sync = await syncAiShadowLogToFirestore(
      [entry('ENI.MI', { decision: 'AZIONE' }), entry('ISP.MI', { decision: 'SCARTO' })],
      { env: ENV_ON, nowMs: T0 }
    );
    assert.equal(sync.ok, true);
    assert.equal(sync.written, 2);
    assert.equal(adapter.docs.size, 2);
    assert.ok(
      adapter.docs.has(`${AI_SHADOW_LOG_FIRESTORE_COLLECTION}/${RUN_ID}__ENI.MI`),
      'doc id deterministico runId__ticker'
    );

    const read = await readAiShadowLogFallbackDetailed({ filePath: TMP, env: ENV_ON });
    assert.equal(read.entries.length, 2);
    assert.equal(read.remoteEntries, 2);
    assert.equal(read.truncated, false);
    assert.deepEqual(read.entries.map((e) => e.decision).sort(), ['AZIONE', 'SCARTO']);
    reset();
  });

  it('i documenti gia presente nel file locale non sono contati come remoti e vincono', async () => {
    reset();
    const adapter = makeAdapter();
    setShadowFirestoreAdapter(adapter);
    await syncAiShadowLogToFirestore(
      [entry('ENI.MI', { aiOutcome: 'REMOTO', decision: 'AZIONE' }), entry('ISP.MI')],
      { env: ENV_ON, nowMs: T0 }
    );

    // Stesso docId sul file: la riga locale ha la precedenza.
    appendAiShadowLog([entry('ENI.MI', { aiOutcome: 'LOCALE', decision: 'ATTESA' })], TMP);

    const read = await readAiShadowLogFallbackDetailed({ filePath: TMP, env: ENV_ON });
    assert.equal(read.entries.length, 2, 'nessun duplicato file/remoto');
    assert.equal(read.remoteEntries, 1, 'solo ISP.MI arriva da Firestore');
    const eni = read.entries.find((e) => e.ticker === 'ENI.MI');
    assert.equal(eni?.aiOutcome, 'LOCALE');
    assert.equal(eni?.decision, 'ATTESA');
    reset();
  });

  it('Firestore vuoto con flag acceso: remoteEntries zero', async () => {
    reset();
    setShadowFirestoreAdapter(makeAdapter());
    appendAiShadowLog([entry('ENI.MI')], TMP);
    const read = await readAiShadowLogFallbackDetailed({ filePath: TMP, env: ENV_ON });
    assert.equal(read.entries.length, 1);
    assert.equal(read.remoteEntries, 0);
    reset();
  });

  it('la risposta di calibrazione dichiara il fallback e i conteggi corretti', async () => {
    reset();
    const adapter = makeAdapter();
    setShadowFirestoreAdapter(adapter);
    await syncAiShadowLogToFirestore(
      [entry('ENI.MI', { decision: 'AZIONE' }), entry('ISP.MI', { decision: 'ATTESA' })],
      { env: ENV_ON, nowMs: T0 }
    );

    const forward: AiCalibrationForwardPoint[] = [
      { key: 'f1', ticker: 'ENI.MI', decidedAtMs: T0, r: 1.5, status: 'TARGET' },
    ];

    const out = await createAiCalibrationHandler({
      env: {},
      now: () => T0 + 60_000,
      readEntries: () => readAiShadowLogFallbackDetailed({ filePath: TMP, env: ENV_ON }),
      readForward: () => forward,
    });
    const body = out.body as any;

    assert.equal(body.counts.aiEntries, 2);
    assert.equal(body.counts.remoteEntries, 2);
    assert.equal(body.sources.aiLog, 'shadow_ai_log.jsonl + Firestore (fallback)');
    assert.equal(body.counts.matched, 1, 'solo ENI.MI ha un esito forward');
    assert.equal(body.counts.classified, 1);
    assert.equal(body.buckets.find((b: any) => b.decision === 'AZIONE')?.sumR, 1.5);
    reset();
  });
});
