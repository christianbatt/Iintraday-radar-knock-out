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
});
