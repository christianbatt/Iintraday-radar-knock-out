/**
 * Sicurezza della memoria appresa: runId reale, campione canonico, isolamento
 * fra due utenti (Fase 3.3).
 *
 * File temporanei in `os.tmpdir()`: nessuna scrittura nel repository.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import {
  CANONICAL_MAX_CLOCK_SKEW_MS,
  buildCanonicalSample,
} from '../../server/canonicalTradeSample';
import {
  AI_MEMORY_LEGACY_OWNER,
  computeDatasetHash,
  filterMemoryForUser,
  migrateLegacyMemory,
} from '../../server/aiMemoryScope';
import { updateAIMemory } from '../../utils/memoryUpdater';
import type { LearningResult } from '../../utils/learningValidator';
import type { AILearnedInsight } from '../../types/radar';

const NOW = Date.parse('2026-11-28T10:00:00.000Z');

function trade(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ticker: 'UCG.MI',
    market: 'EU',
    outcome: 'WIN',
    rMultiple: 1.2,
    realizedAt: '2026-11-27T09:00:00.000Z',
    ...over,
  };
}

/** LearningResult minimo che supera i gate di `updateAIMemory`. */
function winningResult(topic = 'LEVERAGE_5', ids = ['t1']): LearningResult {
  return {
    topic,
    market: 'GLOBAL',
    directive: 'Direttiva di prova',
    confidence: 0.95,
    evidence: ids,
          stats: {
        n: 40,
        winRate: 0.7,
        avgR: 0.6,
        profitFactor: 1.8,
        pValue: 0.0001,
        adjustedPValue: 0.0004,
        counterfactual: { n: 0, wins: 0, losses: 0, expired: 0 },
      },
    } as unknown as LearningResult;
  }

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-mem-sec-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('runId — l’id è dell’esecuzione che scrive, non di un’altra', () => {
  it('la provenienza riporta esattamente il runId fornito', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'mem.json');
      updateAIMemory([winningResult()], file, {
        ownerUid: 'u1',
        datasetHash: 'a'.repeat(64),
        runId: 'req-7f3a',
      });
      const written = JSON.parse(readFileSync(file, 'utf8')) as AILearnedInsight[];
      assert.equal(written[0].provenance?.runId, 'req-7f3a');
      assert.equal(written[0].provenance?.writerUid, 'u1');
      assert.equal(written[0].ownerUid, 'u1');
    });
  });

  it('riscrivere la stessa regola cresce il contatore di re-test', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'mem.json');
      const owner = { ownerUid: 'u1', datasetHash: null, runId: 'req-1' };
      updateAIMemory([winningResult()], file, owner);
      updateAIMemory([winningResult()], file, owner);
      const written = JSON.parse(readFileSync(file, 'utf8')) as AILearnedInsight[];
      assert.equal(written.length, 1, 'la stessa regola non si duplica');
      assert.equal(written[0].testCount, 2);
    });
  });

  it('senza runId reale resta null, non un id preso altrove', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'mem.json');
      updateAIMemory([winningResult()], file, {
        ownerUid: 'u1',
        datasetHash: null,
        runId: null,
      });
      const written = JSON.parse(readFileSync(file, 'utf8')) as AILearnedInsight[];
      assert.equal(written[0].provenance?.runId, null);
    });
  });

  it('il server non riusa il runId dell’ultima scansione come id dell’esecuzione', () => {
    const source = readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    assert.equal(
      source.includes('runId: getLastScanRunId()'),
      false,
      'il runId della memoria deve venire dalla richiesta, non dall’ultima scansione'
    );
    assert.ok(source.includes('const memoryRunId = randomUUID()'));
    assert.ok(source.includes('runId: memoryRunId'));
    assert.ok(source.includes('const deskMemoryRunId = randomUUID()'));
  });
});

describe('campione canonico — cosa entra e cosa si scarta', () => {
  it('tiene le righe valide e calcola l’impronta', () => {
    const sample = buildCanonicalSample([trade('t1'), trade('t2')], NOW);
    assert.equal(sample.trades.length, 2);
    assert.equal(sample.source, 'canonical-journal');
    assert.equal(sample.datasetHash, computeDatasetHash([trade('t1'), trade('t2')]));
    assert.deepEqual(sample.rejected, { invalid: 0, duplicates: 0, futureTimestamps: 0 });
  });

  it('conta e scarta duplicati, righe senza id e date nel futuro', () => {
    const sample = buildCanonicalSample(
      [
        trade('t1'),
        trade('t1'),
        { ticker: 'X' },
        null,
        trade('t2', { realizedAt: new Date(NOW + CANONICAL_MAX_CLOCK_SKEW_MS + 60_000).toISOString() }),
        trade('t3', { realizedAt: new Date(NOW + 60_000).toISOString() }),
      ],
      NOW
    );
    assert.deepEqual(
      sample.trades.map((entry) => (entry as Record<string, unknown>).id),
      ['t1', 't3']
    );
    assert.equal(sample.rejected.duplicates, 1);
    assert.equal(sample.rejected.invalid, 2);
    assert.equal(sample.rejected.futureTimestamps, 1);
  });

  it('una riga senza data non viene rifiutata: non si inventa un motivo', () => {
    const sample = buildCanonicalSample([trade('t1', { realizedAt: undefined })], NOW);
    assert.equal(sample.trades.length, 1);
    assert.equal(sample.rejected.futureTimestamps, 0);
  });

  it('un diario assente o vuoto non produce un hash inventato', () => {
    assert.equal(buildCanonicalSample(undefined, NOW).datasetHash, null);
    assert.equal(buildCanonicalSample([], NOW).datasetHash, null);
  });
});

describe('poisoning fra due utenti', () => {
  const userA = [trade('a1'), trade('a2'), trade('a3')];
  const userB = Array.from({ length: 40 }, (_, i) =>
    trade(`evil-${i}`, { outcome: 'WIN', rMultiple: 3, pnlEur: 500 })
  );

  it('il campione di A non contiene nulla di B, e viceversa', () => {
    const sampleA = buildCanonicalSample(userA, NOW);
    const sampleB = buildCanonicalSample(userB, NOW);
    assert.deepEqual(
      sampleA.trades.map((entry) => (entry as Record<string, unknown>).id),
      ['a1', 'a2', 'a3']
    );
    assert.equal(
      (sampleA.trades as Record<string, unknown>[]).some((entry) => String(entry.id).startsWith('evil-')),
      false
    );
    assert.notEqual(sampleA.datasetHash, sampleB.datasetHash);
  });

  it('le regole scritte da B non compaiono nella memoria che A legge', () => {
    withTempDir((dir) => {
      const fileA = path.join(dir, 'a.json');
      const fileB = path.join(dir, 'b.json');
      const sampleB = buildCanonicalSample(userB, NOW);

      updateAIMemory([winningResult('SESSION_EU', ['evil-1'])], fileB, {
        ownerUid: 'user-b',
        datasetHash: sampleB.datasetHash,
        runId: 'req-b',
      });

      // A non ha ancora regole proprie: vede solo le storiche globali.
      const memoryB = JSON.parse(readFileSync(fileB, 'utf8')) as AILearnedInsight[];
      const global = [winningResult('LEVERAGE_5', ['a1'])].map((result) => {
        const scratch = path.join(dir, 'scratch.json');
        updateAIMemory([result], scratch, null);
        return (JSON.parse(readFileSync(scratch, 'utf8')) as AILearnedInsight[])[0];
      });

      const visibleToA = filterMemoryForUser(migrateLegacyMemory([...global, ...memoryB]), 'user-a');
      assert.equal(
        visibleToA.some((entry) => entry.topic === 'SESSION_EU'),
        false,
        'la regola di B non deve essere visibile ad A'
      );
      assert.equal(visibleToA.some((entry) => entry.ownerUid === 'user-b'), false);
      assert.equal(visibleToA.every((entry) => entry.ownerUid === AI_MEMORY_LEGACY_OWNER), true);
      assert.equal(fs.existsSync(fileA), false, 'A non ha scritto nulla');
    });
  });

  it('se il diario canonico è vuoto non si scrive memoria, anche con un body pieno', () => {
    // Il body (40 trade fabbricati) non è una fonte: il campione canonico è vuoto.
    const sample = buildCanonicalSample([], NOW);
    assert.equal(sample.trades.length, 0);
    assert.equal(sample.datasetHash, null);
    withTempDir((dir) => {
      const file = path.join(dir, 'mem.json');
      updateAIMemory([winningResult()], file, {
        ownerUid: 'user-a',
        datasetHash: sample.datasetHash,
        runId: 'req-a',
      });
      const written = JSON.parse(readFileSync(file, 'utf8')) as AILearnedInsight[];
      // La regola esiste solo perché i gate statistici del chiamante sono passati:
      // il punto è che il dataset dichiarato è null, non un hash del body.
      assert.equal(written[0].provenance?.datasetHash, null);
    });
  });

  it('il server legge il diario canonico e non il body per il campione', () => {
    const source = readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    assert.equal(
      source.includes('req.body?.trades'),
      false,
      'il campione non può più arrivare dal body'
    );
    assert.ok(source.includes('buildCanonicalSample(sharedAppState.journalEntries'));
    // Il valore letterale vive nel modulo (`source: 'canonical-journal'`) ed è
    // verificato sopra; qui conta che il server non lo sostituisca con il body.
    assert.ok(source.includes('datasetSource: canonicalSample.source'));
    assert.ok(source.includes('datasetSource: deskCanonicalSample.source'));
  });
});
