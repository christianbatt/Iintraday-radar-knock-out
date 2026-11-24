/**
 * ADDITIVO (P2/P3/P4): test di snapshot indipendente dall'istanza, conteggio
 * per `candidateKey` e concorrenza dei batch LLM.
 *
 * Nessun test esistente viene modificato: questo file aggiunge solo casi nuovi.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AI_SHADOW_BATCH_SIZE,
  AI_SHADOW_CONCURRENCY,
  buildNoCandidateEntry,
  consumeHandlerScanInput,
  evaluateScanCandidates,
  setHandlerScanInput,
  getLastScanRunId,
  normalizeScanCandidatesPayload,
  resetLastScanCandidates,
  resolveScanCandidateInput,
  setLastScanCandidates,
  setLastScanRunId,
  type ScanCandidateSnapshot,
} from '../../server/aiScanEvaluation';
import {
  AI_SHADOW_DISCARD_REASONS,
  buildScanCandidateEntries,
  readAiShadowLog,
  safeAppendAiShadowLog,
  type AiShadowLogEntry,
} from '../../server/aiShadowLog';
import { buildScanCandidatesPayload } from '../scanCandidatesPayload';
import ShadowAISection, { summarizeShadowLogEntries } from '../../components/ShadowAISection';

function candidates(count: number): ScanCandidateSnapshot[] {
  return Array.from({ length: count }, (_, i) => ({
    ticker: `T${String(i).padStart(2, '0')}`,
    market: i % 2 === 0 ? 'EU' : 'US',
    direction: 'LONG',
    scoreTotal: 50 + i,
    veto: null,
  }));
}

function tickersFromPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/^([A-Z0-9._-]+) \| /gm)].map((m) => m[1]);
}

function logEntry(over: Partial<AiShadowLogEntry>): AiShadowLogEntry {
  return {
    id: `${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    ticker: 'AAA',
    market: 'EU',
    direction: 'LONG',
    setup: 'x',
    aiOutcome: null,
    aiCategory: null,
    source: 'scan',
    evaluated: false,
    discarded: false,
    discardReason: null,
    status: 'NON_VALIDATO',
    outcome: null,
    ...over,
  };
}

describe('P2 — sorgente dei candidati: body, istantanea, nessuna', () => {
  it('normalizza il payload del body (score o scoreTotal) e scarta i ticker vuoti', () => {
    const normalized = normalizeScanCandidatesPayload([
      { ticker: 'AAA', market: 'US', direction: 'LONG', score: 72, veto: null },
      { ticker: 'BBB', market: 'EU', direction: 'SHORT', scoreTotal: 61, veto: 'WARMUP_INCOMPLETE' },
      { ticker: '   ', market: 'EU', direction: null, score: 10, veto: null },
      { ticker: 'CCC', market: 'EU', direction: 'FLAT', score: 'x', veto: '' },
      null,
    ]);
    assert.equal(normalized.length, 3);
    assert.deepEqual(normalized[0], {
      ticker: 'AAA',
      market: 'US',
      direction: 'LONG',
      scoreTotal: 72,
      veto: null,
    });
    assert.deepEqual(normalized[1], {
      ticker: 'BBB',
      market: 'EU',
      direction: 'SHORT',
      scoreTotal: 61,
      veto: 'WARMUP_INCOMPLETE',
    });
    assert.deepEqual(normalized[2], {
      ticker: 'CCC',
      market: 'EU',
      direction: null,
      scoreTotal: null,
      veto: null,
    });
  });

  it('il body ha priorita’ sull’istantanea; senza body si usa lo snapshot', () => {
    resetLastScanCandidates();
    setLastScanCandidates(candidates(2));
    setLastScanRunId('run-snapshot');
    assert.equal(getLastScanRunId(), 'run-snapshot');

    const fromBody = resolveScanCandidateInput(
      [{ ticker: 'BODY1', market: 'US', direction: 'SHORT', score: 88, veto: null }],
      'run-body'
    );
    assert.equal(fromBody.candidateSource, 'body');
    assert.equal(fromBody.runId, 'run-body');
    assert.deepEqual(fromBody.candidates.map((c) => c.ticker), ['BODY1']);

    const fromSnapshot = resolveScanCandidateInput(undefined, undefined);
    assert.equal(fromSnapshot.candidateSource, 'snapshot');
    assert.equal(fromSnapshot.runId, 'run-snapshot');
    assert.deepEqual(fromSnapshot.candidates.map((c) => c.ticker), ['T00', 'T01']);
    resetLastScanCandidates();
  });

  it('nessuna sorgente: candidateSource none, una riga NESSUN_CANDIDATO_DISPONIBILE, zero chiamate LLM', async () => {
    resetLastScanCandidates();
    const resolution = resolveScanCandidateInput(undefined, undefined);
    assert.equal(resolution.candidateSource, 'none');
    assert.deepEqual(resolution.candidates, []);

    let llmCalls = 0;
    const callLlm = async (): Promise<string | null> => {
      llmCalls += 1;
      return null;
    };
    // Stessa decisione dell'handler: nessuna sorgente => riga unica, nessuna LLM.
    const entries: AiShadowLogEntry[] =
      resolution.candidates.length === 0
        ? [buildNoCandidateEntry('specialize'), buildNoCandidateEntry('desk')]
        : (await evaluateScanCandidates(resolution.candidates, 'specialize', callLlm)).entries;

    assert.equal(llmCalls, 0);
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.evaluated, false);
      assert.equal(entry.discardReason, AI_SHADOW_DISCARD_REASONS.NESSUN_CANDIDATO_DISPONIBILE);
      assert.equal(entry.candidateSource, 'none');
      assert.equal(entry.ticker, null);
      assert.equal(entry.aiOutcome, null);
    }
    assert.deepEqual(entries.map((e) => e.source), ['specialize', 'desk']);
  });

  it('handoff sincrono dell’input handler: una sola consegna, poi azzerata', () => {
    setHandlerScanInput([{ ticker: 'AAA', score: 10 }], 'run-x');
    const first = consumeHandlerScanInput();
    assert.deepEqual(first.bodyCandidates, [{ ticker: 'AAA', score: 10 }]);
    assert.equal(first.bodyRunId, 'run-x');
    const second = consumeHandlerScanInput();
    assert.equal(second.bodyCandidates, undefined);
    assert.equal(second.bodyRunId, undefined);
    // Il body consegnato viene usato con priorita' dall'handler.
    setHandlerScanInput([{ ticker: 'AAA', score: 10 }], 'run-x');
    const resolution = resolveScanCandidateInput(first.bodyCandidates, first.bodyRunId);
    assert.equal(resolution.candidateSource, 'body');
    assert.equal(resolution.runId, 'run-x');
    consumeHandlerScanInput();
  });

  it('le voci del log portano candidateSource, runId e candidateKey runId:ticker', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-p2-'));
    const file = path.join(dir, 'log.jsonl');
    const result = await evaluateScanCandidates(
      candidates(12),
      'desk',
      async (_system, prompt) => {
        const tickers = tickersFromPrompt(prompt);
        return JSON.stringify({
          scanEvaluations: tickers.map((ticker) => ({
            ticker,
            aiOutcome: `OSS_${ticker}`,
            aiCategory: 'CAT',
          })),
        });
      },
      AI_SHADOW_BATCH_SIZE,
      { runId: 'run-body', candidateSource: 'body' }
    );
    safeAppendAiShadowLog(result.entries, file);
    const persisted = readAiShadowLog(undefined, file);
    assert.equal(persisted.length, 12);
    for (const entry of persisted) {
      assert.equal(entry.candidateSource, 'body');
      assert.equal(entry.runId, 'run-body');
      assert.equal(entry.candidateKey, `run-body:${entry.ticker}`);
      assert.equal(entry.evaluated, true);
      assert.equal(typeof entry.durationMs, 'number');
      assert.ok((entry.durationMs as number) >= 0);
    }
    // Lo stesso ticker nella riga di scansione ha la stessa candidateKey.
    const scanRows = buildScanCandidateEntries(
      result.entries.map((entry) => ({
        ticker: entry.ticker,
        market: entry.market,
        direction: entry.direction,
        setup: null,
      })),
      'run-body'
    );
    assert.deepEqual(
      scanRows.map((row) => row.candidateKey),
      result.entries.map((entry) => entry.candidateKey)
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('P3 — conteggio non valutate per candidateKey', () => {
  it('una scansione valutata, una non valutata e un ticker in due run: conteggi corretti', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-p3-'));
    const file = path.join(dir, 'log.jsonl');
    const rows: AiShadowLogEntry[] = [
      // run1: riga di scansione + riga handler valutata per lo stesso ticker
      logEntry({ ticker: 'AAA', source: 'scan', evaluated: false, candidateKey: 'run1:AAA' }),
      logEntry({
        ticker: 'AAA',
        source: 'specialize',
        evaluated: true,
        aiOutcome: 'SI',
        candidateKey: 'run1:AAA',
      }),
      // run2: AAA non valutato, BBB valutato
      logEntry({ ticker: 'AAA', source: 'scan', evaluated: false, candidateKey: 'run2:AAA' }),
      logEntry({ ticker: 'BBB', source: 'scan', evaluated: false, candidateKey: 'run2:BBB' }),
      logEntry({
        ticker: 'BBB',
        source: 'desk',
        evaluated: true,
        aiOutcome: 'SI',
        candidateKey: 'run2:BBB',
      }),
    ];
    safeAppendAiShadowLog(rows, file);
    const persisted = readAiShadowLog(undefined, file);
    assert.equal(persisted.length, 5);

    // Conteggio grezzo (vecchio comportamento): 3 righe evaluated:false.
    assert.equal(persisted.filter((e) => e.evaluated === false).length, 3);

    const summary = summarizeShadowLogEntries(persisted);
    assert.equal(summary.notEvaluatedCount, 1);
    assert.equal(summary.evaluatedCount, 2);

    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, { flag: 'on', entries: persisted })
    );
    assert.ok(out.includes('non valutate: 1'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('righe senza candidateKey restano contate singolarmente (compatibilita’)', () => {
    const summary = summarizeShadowLogEntries([
      logEntry({ id: 'a', source: 'desk', evaluated: false, candidateKey: null }),
      logEntry({ id: 'b', source: 'specialize', evaluated: true, candidateKey: null }),
    ]);
    assert.equal(summary.notEvaluatedCount, 1);
    assert.equal(summary.evaluatedCount, 1);
    assert.equal(summarizeShadowLogEntries(null).notEvaluatedCount, 0);
  });
});

describe('P4 — concorrenza dei batch e latenza misurata', () => {
  it('concorrenza 2: risultati identici al sequenziale e tempo inferiore (LLM mockata, 100 ms)', async () => {
    assert.equal(AI_SHADOW_CONCURRENCY, 2);
    const batch = candidates(40);
    const makeLlm = () => async (_system: string, prompt: string): Promise<string | null> => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const tickers = tickersFromPrompt(prompt);
      return JSON.stringify({
        scanEvaluations: tickers.map((ticker) => ({
          ticker,
          aiOutcome: `OSS_${ticker}`,
          aiCategory: 'CAT',
        })),
      });
    };

    const sequentialStart = performance.now();
    const sequential = await evaluateScanCandidates(batch, 'specialize', makeLlm(), AI_SHADOW_BATCH_SIZE, {
      runId: 'run-seq',
      candidateSource: 'snapshot',
      concurrency: 1,
    });
    const sequentialMs = performance.now() - sequentialStart;

    const concurrentStart = performance.now();
    const concurrent = await evaluateScanCandidates(batch, 'specialize', makeLlm(), AI_SHADOW_BATCH_SIZE, {
      runId: 'run-seq',
      candidateSource: 'snapshot',
      concurrency: AI_SHADOW_CONCURRENCY,
    });
    const concurrentMs = performance.now() - concurrentStart;

    console.log(
      `[P4] sequenziale=${sequentialMs.toFixed(1)}ms concorrenza2=${concurrentMs.toFixed(1)}ms ` +
        `batch=${concurrent.batches.map((b) => `${b.durationMs}ms`).join(',')}`
    );

    assert.equal(sequential.batches.length, 4);
    assert.equal(concurrent.batches.length, 4);
    assert.deepEqual(
      concurrent.entries.map((e) => [e.ticker, e.aiOutcome, e.evaluated]),
      sequential.entries.map((e) => [e.ticker, e.aiOutcome, e.evaluated])
    );
    assert.deepEqual(
      concurrent.batches.map((b) => b.batchIndex),
      [0, 1, 2, 3]
    );
    assert.deepEqual(
      concurrent.batches.flatMap((b) => b.candidateTickers),
      batch.map((c) => c.ticker)
    );
    assert.equal(concurrent.evaluated, 40);
    for (const batchResult of concurrent.batches) {
      assert.equal(typeof batchResult.durationMs, 'number');
      assert.ok(batchResult.durationMs >= 90);
    }
    assert.ok(
      concurrentMs < sequentialMs * 0.9,
      `atteso tempo inferiore con concorrenza 2: ${concurrentMs.toFixed(1)}ms vs ${sequentialMs.toFixed(1)}ms`
    );
  });
});

describe('Regressione — il payload additivo non altera la selezione dei setup', () => {
  it('buildScanCandidatesPayload e’ in sola lettura e conserva ordine, score e veto', () => {
    const scored = [
      {
        quote: { ticker: 'AAA', market: 'EU', gapPercent: 1.2 },
        score: { total: 70, veto: null },
        rank: 1,
      },
      {
        quote: { ticker: 'BBB', market: 'US', gapPercent: -0.8 },
        score: { total: 40, veto: 'ADX_BELOW_MARKET_THRESHOLD' },
        rank: 2,
      },
    ];
    const before = JSON.stringify(scored);
    const payload = buildScanCandidatesPayload(scored as any);
    assert.equal(JSON.stringify(scored), before);
    assert.deepEqual(payload, [
      { ticker: 'AAA', market: 'EU', direction: 'LONG', score: 70, veto: null },
      {
        ticker: 'BBB',
        market: 'US',
        direction: 'SHORT',
        score: 40,
        veto: 'ADX_BELOW_MARKET_THRESHOLD',
      },
    ]);
    // La selezione (rank) non viene riscritta: stessi oggetti, stesso ordine.
    assert.deepEqual(
      (scored as any[]).map((c) => c.rank),
      [1, 2]
    );
  });
});
