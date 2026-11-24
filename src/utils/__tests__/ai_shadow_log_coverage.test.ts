import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  safeAppendAiShadowLog,
  readAiShadowLog,
  buildScanCandidateEntries,
  AI_SHADOW_DISCARD_REASONS,
} from '../../server/aiShadowLog';
import {
  AI_SHADOW_BATCH_SIZE,
  AI_SHADOW_SCAN_SECTION,
  buildScanEvaluationPrompt,
  evaluateScanCandidates,
  setLastScanCandidates,
  getLastScanCandidates,
  resetLastScanCandidates,
  type ScanCandidateSnapshot,
} from '../../server/aiScanEvaluation';

/**
 * Pipeline mock: produce un candidato per ciascuno dei 40 titoli, invoca l'hook
 * di log come primo passo e SOLO DOPO applica il filtro che seleziona i top 2.
 * Serve a provare che il log copre i 40 candidati e non dipende dal filtro.
 */
function mockPipeline(
  quotes: ReadonlyArray<{ ticker: string; market: string; gapPercent: number | null }>,
  logFile: string
) {
  // 1. hook di log: tutti i candidati, prima di qualunque filtro
  const entries = buildScanCandidateEntries(
    quotes.map((q) => ({
      ticker: q.ticker,
      market: q.market,
      direction: typeof q.gapPercent === 'number' ? (q.gapPercent >= 0 ? 'LONG' : 'SHORT') : null,
      setup: null,
    }))
  );
  safeAppendAiShadowLog(entries, logFile);

  // 2. filtro successivo: tiene solo i primi due (simula la selezione top setup)
  const top = quotes.slice(0, 2);
  return { top, logged: entries.length };
}

describe('aiShadowLog — copertura di tutti i candidati (40 titoli)', () => {
  it('tutti e 40 i candidati arrivano al log prima del filtro, uno per titolo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-cov-'));
    const file = path.join(dir, 'log.jsonl');
    const quotes = Array.from({ length: 40 }, (_, i) => ({
      ticker: `T${String(i).padStart(2, '0')}`,
      market: i % 2 === 0 ? 'EU' : 'US',
      gapPercent: i % 4 === 0 ? -0.8 : 0.6,
    }));

    const { top, logged } = mockPipeline(quotes, file);

    // il filtro successivo ha tenuto solo 2 setup: il flusso di selezione non cambia
    assert.equal(top.length, 2);
    assert.equal(logged, 40);

    const entries = readAiShadowLog(undefined, file);
    assert.equal(entries.length, 40);
    assert.equal(entries.length, quotes.length);
    assert.equal(new Set(entries.map((e) => e.ticker)).size, 40);
    for (const q of quotes) {
      assert.ok(
        entries.some((e) => e.ticker === q.ticker),
        `candidato ${q.ticker} assente dal log`
      );
    }
    for (const entry of entries) {
      assert.equal(entry.source, 'scan');
      assert.equal(entry.evaluated, false);
      assert.equal(entry.discardReason, AI_SHADOW_DISCARD_REASONS.NON_INVIATO_ALLA_LLM);
      assert.equal(entry.status, 'NON_VALIDATO');
      assert.equal(entry.outcome, null);
      assert.equal(entry.aiOutcome, null);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errore di scrittura del log non altera la lista dei top setup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-cov-'));
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const badLog = path.join(blocker, 'log.jsonl');
    const quotes = Array.from({ length: 40 }, (_, i) => ({
      ticker: `S${i}`,
      market: 'US',
      gapPercent: 0.5,
    }));

    let result: ReturnType<typeof mockPipeline> | null = null;
    assert.doesNotThrow(() => {
      result = mockPipeline(quotes, badLog);
    });
    assert.equal(result!.top.length, 2);
    assert.equal(result!.top[0].ticker, 'S0');
    assert.equal(fs.existsSync(badLog), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('wiring reale: server.ts invoca buildScanCandidateEntries prima del filtro shape', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    const hookIdx = src.indexOf('buildScanCandidateEntries(');
    const filterIdx = src.indexOf('const shapeValidDirectives');
    assert.ok(hookIdx > 0, 'hook di scansione assente in server.ts');
    assert.ok(filterIdx > 0, 'filtro shape non trovato in server.ts');
    assert.ok(
      hookIdx < filterIdx,
      'il hook di scansione deve precedere il filtro delle direttive'
    );
    const scanSection = src.slice(0, hookIdx);
    assert.ok(
      scanSection.includes('executeMarketDataScan'),
      'il hook deve stare dentro executeMarketDataScan'
    );
  });

  it('wiring reale: server.ts salva i candidati e li valuta in entrambi gli handler AI', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    assert.ok(src.includes('setLastScanCandidates('), 'istantanea dei candidati assente');
    assert.equal((src.match(/await logScanCandidateEvaluations\('specialize'\)/g) ?? []).length, 1);
    assert.equal((src.match(/await logScanCandidateEvaluations\('desk'\)/g) ?? []).length, 1);
    const snapshotIdx = src.indexOf('setLastScanCandidates(');
    const fetchIdx = src.indexOf('await mapConcurrent(');
    assert.ok(snapshotIdx > fetchIdx, 'istantanea deve seguire il fetch dei 40 titoli');
  });
});

// ---------------------------------------------------------------------------
// Fasi 1-2: CANDIDATI_SCANSIONE, batching, parser e mappatura
// ---------------------------------------------------------------------------

function mockCandidates(count: number, vetoAt = -1): ScanCandidateSnapshot[] {
  return Array.from({ length: count }, (_, i) => ({
    ticker: `T${String(i).padStart(2, '0')}`,
    market: i % 2 === 0 ? 'EU' : 'US',
    direction: i % 4 === 0 ? 'SHORT' : 'LONG',
    scoreTotal: 50 + i,
    veto: i === vetoAt ? 'ADX_BELOW_MARKET_THRESHOLD' : null,
  }));
}

/** LLM mockata: legge i ticker dal prompt e restituisce fino a `quota` valutazioni. */
function makeMockLlm(quota: number | null) {
  const calls: { system: string; prompt: string }[] = [];
  let remaining = quota ?? 0;
  const fn = async (system: string, prompt: string): Promise<string | null> => {
    calls.push({ system, prompt });
    const tickers = [...prompt.matchAll(/^([A-Z0-9._-]+) \| /gm)].map((m) => m[1]);
    const take = quota == null ? tickers.length : Math.min(tickers.length, Math.max(0, remaining));
    if (quota != null) remaining -= take;
    return JSON.stringify({
      scanEvaluations: tickers.slice(0, take).map((ticker) => ({
        ticker,
        aiOutcome: `OSSERVAZIONE_${ticker}`,
        aiCategory: 'CATEGORIA_TEST',
      })),
    });
  };
  return { fn, calls };
}

describe('aiScanEvaluation — tutti i candidati valutati dall AI', () => {
  it('40 candidati e LLM con 40 valutazioni: 40 voci evaluated true con aiOutcome', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-scan-eval-'));
    const file = path.join(dir, 'log.jsonl');
    const candidates = mockCandidates(40);
    const llm = makeMockLlm(null);

    const result = await evaluateScanCandidates(candidates, 'specialize', llm.fn);
    safeAppendAiShadowLog(result.entries, file);

    assert.equal(result.entries.length, 40);
    assert.equal(result.evaluated, 40);
    assert.equal(result.notEvaluated, 0);
    assert.equal(result.batches.length, 4);
    assert.equal(result.batches.every((b) => b.candidateTickers.length === AI_SHADOW_BATCH_SIZE), true);
    assert.equal(new Set(result.entries.map((e) => e.ticker)).size, 40);
    assert.equal(result.ignoredUnknownTickers, 0);
    assert.equal(result.ignoredDuplicateTickers, 0);

    const persisted = readAiShadowLog(undefined, file);
    assert.equal(persisted.length, 40);
    for (const entry of persisted) {
      assert.equal(entry.evaluated, true);
      assert.equal(typeof entry.aiOutcome, 'string');
      assert.ok((entry.aiOutcome as string).length > 0);
      assert.equal(entry.discardReason, null);
      assert.equal(entry.status, 'NON_VALIDATO');
      assert.equal(entry.outcome, null);
      assert.equal(entry.source, 'specialize');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('40 candidati e LLM con 35 valutazioni: 5 voci NON_RESTITUITO_DALLA_LLM', async () => {
    const candidates = mockCandidates(40);
    const llm = makeMockLlm(35);
    const result = await evaluateScanCandidates(candidates, 'desk', llm.fn);

    assert.equal(result.entries.length, 40);
    assert.equal(result.evaluated, 35);
    assert.equal(result.notEvaluated, 5);
    const missing = result.entries.filter((e) => !e.evaluated);
    assert.equal(missing.length, 5);
    for (const entry of missing) {
      assert.equal(entry.aiOutcome, null);
      assert.equal(entry.discardReason, AI_SHADOW_DISCARD_REASONS.NON_RESTITUITO_DALLA_LLM);
      assert.equal(entry.source, 'desk');
    }
    // i primi 35 (ordine di scansione) sono valutati, gli ultimi 5 no
    assert.deepEqual(
      result.entries.slice(35).map((e) => e.ticker),
      candidates.slice(35).map((c) => c.ticker)
    );
  });

  it('LLM assente (null): tutte le voci LLM_NON_DISPONIBILE', async () => {
    const candidates = mockCandidates(40);
    const calls: string[] = [];
    const result = await evaluateScanCandidates(candidates, 'specialize', async (_s, prompt) => {
      calls.push(prompt);
      return null;
    });
    assert.equal(result.entries.length, 40);
    assert.equal(result.evaluated, 0);
    assert.equal(result.notEvaluated, 40);
    assert.equal(calls.length, 4);
    for (const entry of result.entries) {
      assert.equal(entry.evaluated, false);
      assert.equal(entry.discardReason, AI_SHADOW_DISCARD_REASONS.LLM_NON_DISPONIBILE);
    }
  });

  it('LLM che lancia: nessuna eccezione e tutte le voci LLM_NON_DISPONIBILE', async () => {
    const result = await evaluateScanCandidates(mockCandidates(40), 'desk', async () => {
      throw new Error('rete assente');
    });
    assert.equal(result.entries.length, 40);
    assert.equal(result.evaluated, 0);
    assert.equal(
      result.entries.every(
        (e) => e.discardReason === AI_SHADOW_DISCARD_REASONS.LLM_NON_DISPONIBILE
      ),
      true
    );
  });

  it('output non parsabile: tutte le voci ERRORE_PARSING', async () => {
    const result = await evaluateScanCandidates(mockCandidates(12), 'specialize', async () =>
      'questo non e JSON'
    );
    assert.equal(result.entries.length, 12);
    assert.equal(result.batches.length, 2);
    assert.equal(result.evaluated, 0);
    for (const entry of result.entries) {
      assert.equal(entry.discardReason, AI_SHADOW_DISCARD_REASONS.ERRORE_PARSING);
    }
  });

  it('batch di dimensione fissa: nessun candidato perso ne duplicato', async () => {
    const candidates = mockCandidates(40);
    const llm = makeMockLlm(null);
    const result = await evaluateScanCandidates(candidates, 'specialize', llm.fn);
    const seen = result.entries.map((e) => e.ticker);
    assert.equal(seen.length, 40);
    assert.equal(new Set(seen).size, 40);
    assert.deepEqual(seen, candidates.map((c) => c.ticker));
    const inBatches = result.batches.flatMap((b) => b.candidateTickers);
    assert.deepEqual(inBatches, candidates.map((c) => c.ticker));
    assert.equal(llm.calls.length, 4);
  });

  it('duplicati e ticker sconosciuti: ignorati e contati, candidati reali intatti', async () => {
    const candidates = mockCandidates(3);
    const result = await evaluateScanCandidates(candidates, 'specialize', async (_s, prompt) => {
      assert.ok(prompt.includes(AI_SHADOW_SCAN_SECTION));
      return JSON.stringify({
        scanEvaluations: [
          { ticker: 'T00', aiOutcome: 'A', aiCategory: 'C' },
          { ticker: 'T00', aiOutcome: 'DUPLICATO', aiCategory: 'C' },
          { ticker: 'T01', aiOutcome: 'B', aiCategory: 'C' },
          { ticker: 'SCONOSCIUTO', aiOutcome: 'X', aiCategory: 'C' },
        ],
      });
    });
    assert.equal(result.entries.length, 3);
    assert.equal(result.evaluated, 2);
    assert.equal(result.ignoredDuplicateTickers, 1);
    assert.equal(result.ignoredUnknownTickers, 1);
    const t00 = result.entries.find((e) => e.ticker === 'T00');
    assert.equal(t00?.aiOutcome, 'A');
    const t02 = result.entries.find((e) => e.ticker === 'T02');
    assert.equal(t02?.discardReason, AI_SHADOW_DISCARD_REASONS.NON_RESTITUITO_DALLA_LLM);
  });

  it('prompt: sezione CANDIDATI_SCANSIONE con una riga per candidato e veto incluso', () => {
    const candidates = mockCandidates(3, 1);
    const prompt = buildScanEvaluationPrompt(candidates);
    assert.ok(prompt.includes(AI_SHADOW_SCAN_SECTION));
    assert.ok(prompt.includes('T00 | EU | SHORT | score 50/100 | veto: nessuno'));
    assert.ok(prompt.includes('T01 | US | LONG | score 51/100 | veto: ADX_BELOW_MARKET_THRESHOLD'));
    assert.ok(prompt.includes('"scanEvaluations"'));
    assert.equal(prompt.match(/^T\d\d \| /gm)?.length, 3);
  });

  it('istantanea: setLastScanCandidates normalizza e scarta i ticker vuoti', () => {
    resetLastScanCandidates();
    assert.deepEqual(getLastScanCandidates(), []);
    setLastScanCandidates([
      { ticker: 'AAA', market: 'US', direction: 'LONG', scoreTotal: 70, veto: null },
      { ticker: '   ', market: 'EU', direction: null, scoreTotal: null, veto: null },
      { ticker: 'BBB', market: 'EU', direction: 'SHORT', scoreTotal: 55, veto: 'WARMUP_INCOMPLETE' },
    ]);
    const snapshot = getLastScanCandidates();
    assert.equal(snapshot.length, 2);
    assert.deepEqual(snapshot.map((c) => c.ticker), ['AAA', 'BBB']);
    assert.equal(snapshot[1].veto, 'WARMUP_INCOMPLETE');
    resetLastScanCandidates();
  });
});
