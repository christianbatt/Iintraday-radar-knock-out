import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_SHADOW_LOG_FALLBACK_MAX_LIMIT,
  appendAiShadowLog,
  readAiShadowLogWithFallback,
} from '../../server/aiShadowLog';
import type { AiShadowLogFirestoreReadItem } from '../../server/aiShadowLogFirestore';

const TMP = path.join(process.cwd(), 'artifacts', '_tmp_shadow_fallback.jsonl');

function entry(id: string, partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    timestamp: '2026-11-25T09:00:00.000Z',
    ticker: 'ENI.MI',
    market: 'EU',
    direction: 'LONG',
    setup: null,
    aiOutcome: 'BUY',
    aiCategory: null,
    source: 'scan',
    evaluated: true,
    discarded: false,
    discardReason: null,
    status: 'NON_VALIDATO',
    outcome: null,
    candidateKey: null,
    runId: null,
    durationMs: null,
    ...partial,
  };
}

function remote(docId: string, data: Record<string, unknown>): AiShadowLogFirestoreReadItem {
  return { docId, entry: data };
}

function reset(): void {
  fs.rmSync(TMP, { force: true });
}

describe('readAiShadowLogWithFallback', () => {
  it('a flag spento legge solo il file e non interroga il remoto', async () => {
    reset();
    appendAiShadowLog([entry('local1')], TMP);
    let remoteCalls = 0;
    const out = await readAiShadowLogWithFallback({
      filePath: TMP,
      env: {},
      readRemote: async () => {
        remoteCalls += 1;
        return [remote('r1', entry('remote1'))];
      },
    });
    assert.equal(remoteCalls, 0);
    assert.deepEqual(out.map((e) => e.id), ['local1']);
    reset();
  });

  it('a flag acceso e file vuoto restituisce le voci da Firestore', async () => {
    reset();
    const out = await readAiShadowLogWithFallback({
      filePath: TMP,
      env: { SHADOW_AI_LOG_FIRESTORE: '1' },
      readRemote: async () => [
        remote('run1__ENI.MI', entry('r1', { runId: 'run1', ticker: 'ENI.MI', decision: 'AZIONE' })),
        remote('run1__ISP.MI', entry('r2', { runId: 'run1', ticker: 'ISP.MI' })),
      ],
    });
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((e) => e.ticker).sort(), ['ENI.MI', 'ISP.MI']);
    // il campo chiuso sopravvive al giro remoto e viene ri-validato
    assert.equal(out.find((e) => e.ticker === 'ENI.MI')?.decision, 'AZIONE');
    assert.equal(out.find((e) => e.ticker === 'ISP.MI')?.decision, null);
    reset();
  });

  it('unisce file e remoto senza duplicare lo stesso doc id', async () => {
    reset();
    appendAiShadowLog([entry('run1__ENI.MI', { runId: 'run1', ticker: 'ENI.MI' })], TMP);
    const out = await readAiShadowLogWithFallback({
      filePath: TMP,
      env: { SHADOW_AI_LOG_FIRESTORE: '1' },
      readRemote: async () => [
        remote('run1__ENI.MI', entry('duplicato', { runId: 'run1', ticker: 'ENI.MI' })),
        remote('run1__UCG.MI', entry('r2', { runId: 'run1', ticker: 'UCG.MI' })),
      ],
    });
    assert.equal(out.length, 2, 'il doc gia\' presente sul file non viene duplicato');
    assert.deepEqual(out.map((e) => e.id).sort(), ['r2', 'run1__ENI.MI']);
    reset();
  });

  it('restituisce le voci dal piu\' vecchio al piu\' recente', async () => {
    reset();
    const out = await readAiShadowLogWithFallback({
      filePath: TMP,
      env: { SHADOW_AI_LOG_FIRESTORE: '1' },
      readRemote: async () => [
        remote('a', entry('old', { timestamp: '2026-11-25T08:00:00.000Z' })),
        remote('b', entry('new', { timestamp: '2026-11-25T10:00:00.000Z' })),
        remote('c', entry('mid', { timestamp: '2026-11-25T09:00:00.000Z' })),
      ],
    });
    assert.deepEqual(out.map((e) => e.id), ['old', 'mid', 'new']);
    reset();
  });

  it('rispetta il limite e non supera il tetto esteso', async () => {
    reset();
    const out = await readAiShadowLogWithFallback({
      filePath: TMP,
      limit: 2,
      env: { SHADOW_AI_LOG_FIRESTORE: '1' },
      readRemote: async () => [
        remote('a', entry('1', { timestamp: '2026-11-25T08:00:00.000Z' })),
        remote('b', entry('2', { timestamp: '2026-11-25T09:00:00.000Z' })),
        remote('c', entry('3', { timestamp: '2026-11-25T10:00:00.000Z' })),
      ],
    });
    assert.deepEqual(out.map((e) => e.id), ['2', '3'], 'taglia i piu\' vecchi, tiene i piu\' recenti');
    assert.equal(AI_SHADOW_LOG_FALLBACK_MAX_LIMIT, 2000);
    reset();
  });

  it('esclude i placeholder di scansione salvo includeScan', async () => {
    reset();
    appendAiShadowLog(
      [
        entry('scan1', {
          source: 'scan',
          evaluated: false,
          discardReason: 'NON_INVIATO_ALLA_LLM',
        }),
        entry('eval1'),
      ],
      TMP
    );
    const hidden = await readAiShadowLogWithFallback({ filePath: TMP, env: {} });
    assert.deepEqual(hidden.map((e) => e.id), ['eval1']);
    const shown = await readAiShadowLogWithFallback({ filePath: TMP, env: {}, includeScan: true });
    assert.deepEqual(shown.map((e) => e.id).sort(), ['eval1', 'scan1']);
    reset();
  });

  it('se il remoto lancia, resta il file (nessuna eccezione al chiamante)', async () => {
    reset();
    appendAiShadowLog([entry('local1')], TMP);
    const out = await readAiShadowLogWithFallback({
      filePath: TMP,
      env: { SHADOW_AI_LOG_FIRESTORE: '1' },
      readRemote: async () => {
        throw new Error('firestore down');
      },
    });
    assert.deepEqual(out.map((e) => e.id), ['local1']);
    reset();
  });
});
