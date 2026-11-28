/**
 * Perimetro della memoria (Fase 3): isolamento fra utenti, firma del dataset,
 * migrazione delle regole storiche.
 *
 * File temporanei in `os.tmpdir()`: nessuna scrittura nel repository.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_MEMORY_LEGACY_OWNER,
  aiMemoryFirestorePath,
  aiMemoryLocalFileName,
  computeDatasetHash,
  filterMemoryForUser,
  isScopedMemoryUid,
  migrateLegacyMemory,
  stampInsightOwner,
  stampInsightProvenance,
} from '../../server/aiMemoryScope';
import type { AILearnedInsight } from '../../types/radar';

function insight(over: Partial<AILearnedInsight> = {}): AILearnedInsight {
  return {
    id: 'ai-leverage-5',
    learnedAt: '2026-11-01T00:00:00.000Z',
    market: 'GLOBAL',
    topic: 'LEVERAGE_5',
    directive: 'Leva 5 va meglio',
    confidence: 95,
    sampleEvidence: 'n=42',
    ...over,
  };
}

describe('perimetro — uid e percorsi', () => {
  it('accetta un uid normale e rifiuta quelli che uscirebbero dal perimetro', () => {
    assert.equal(isScopedMemoryUid('abc123_-'), true);
    for (const bad of ['', '../altro', 'a/b', 'a b', 'x'.repeat(129), null, 42]) {
      assert.equal(isScopedMemoryUid(bad), false);
    }
  });

  it('due utenti hanno documenti e file diversi', () => {
    assert.equal(aiMemoryFirestorePath('u1'), 'users/u1/ai_specialization_memory/current');
    assert.notEqual(aiMemoryFirestorePath('u1'), aiMemoryFirestorePath('u2'));
    assert.equal(aiMemoryLocalFileName(AI_MEMORY_LEGACY_OWNER), 'ai_specialization_memory.json');
    assert.equal(aiMemoryLocalFileName('u1'), 'ai_specialization_memory.u1.json');
  });

  it('un uid non valido non diventa un percorso', () => {
    assert.throws(() => aiMemoryFirestorePath('../u2'));
    assert.throws(() => aiMemoryLocalFileName('..'));
  });
});

describe('datasetHash — firma del campione', () => {
  it('dipende dagli id, non dall’ordine né dai duplicati', () => {
    const a = computeDatasetHash([{ id: 't1' }, { id: 't2' }]);
    const b = computeDatasetHash([{ id: 't2' }, { id: 't1' }, { id: 't1' }]);
    assert.equal(a, b);
    assert.match(String(a), /^[a-f0-9]{64}$/);
  });

  it('cambia se entra un trade', () => {
    const before = computeDatasetHash([{ id: 't1' }]);
    const after = computeDatasetHash([{ id: 't1' }, { id: 't2' }]);
    assert.notEqual(before, after);
  });

  it('senza id non produce un hash inventato', () => {
    assert.equal(computeDatasetHash([]), null);
    assert.equal(computeDatasetHash(null), null);
    assert.equal(computeDatasetHash([{ id: '   ' }, { nope: 1 }, null]), null);
  });
});

describe('migrazione delle regole esistenti', () => {
  it('assegna le regole storiche al globale senza toccarne il contenuto', () => {
    const migrated = migrateLegacyMemory([insight()]);
    assert.equal(migrated[0].ownerUid, AI_MEMORY_LEGACY_OWNER);
    assert.equal(migrated[0].directive, 'Leva 5 va meglio');
    assert.equal(migrated[0].confidence, 95);
  });

  it('è idempotente e non ruba le regole già assegnate', () => {
    const once = migrateLegacyMemory([insight({ ownerUid: 'u1' })]);
    const twice = migrateLegacyMemory(once);
    assert.deepEqual(twice, once);
    assert.equal(twice[0].ownerUid, 'u1');
  });
});

describe('isolamento fra utenti', () => {
  const memory = [
    insight({ id: 'ai-globale', topic: 'SESSION_EU' }),
    insight({ id: 'ai-u1', topic: 'LEVERAGE_5', ownerUid: 'u1' }),
    insight({ id: 'ai-u2', topic: 'ENTRY_SNAPSHOT', ownerUid: 'u2' }),
  ];

  it('u1 vede la propria regola e quella globale, non quella di u2', () => {
    const visible = filterMemoryForUser(memory, 'u1');
    assert.deepEqual(
      visible.map((entry) => entry.id),
      ['ai-globale', 'ai-u1']
    );
  });

  it('la regola globale è marcata legacy, la propria no', () => {
    const visible = filterMemoryForUser(memory, 'u1');
    assert.equal(visible[0].legacy, true);
    assert.notEqual(visible[1].legacy, true);
  });

  it('u2 non vede la regola di u1', () => {
    const visible = filterMemoryForUser(memory, 'u2');
    assert.equal(visible.some((entry) => entry.id === 'ai-u1'), false);
  });

  it('il globale vede solo le storiche: le regole degli utenti non risalgono', () => {
    const visible = filterMemoryForUser(memory, AI_MEMORY_LEGACY_OWNER);
    assert.deepEqual(
      visible.map((entry) => entry.id),
      ['ai-globale']
    );
  });
});

describe('firma di una regola nuova', () => {
  it('scrive autore e hash del dataset dentro provenance', () => {
    const signed = stampInsightProvenance(
      stampInsightOwner(insight({ confidence: null }), 'u1'),
      { writerUid: 'u1', datasetHash: 'a'.repeat(64), runId: 'run-7' }
    );
    assert.equal(signed.ownerUid, 'u1');
    assert.equal(signed.provenance?.writerUid, 'u1');
    assert.equal(signed.provenance?.datasetHash, 'a'.repeat(64));
    assert.equal(signed.provenance?.runId, 'run-7');
  });

  it('conserva la provenienza esistente e lascia null ciò che manca', () => {
    const existing = insight({
      provenance: { promptVersion: 'ai-specialize@2', model: 'openrouter:m', evidenceRefs: ['scan.a'] },
    });
    const signed = stampInsightProvenance(existing, {
      writerUid: 'u1',
      datasetHash: null,
      runId: null,
    });
    assert.equal(signed.provenance?.promptVersion, 'ai-specialize@2');
    assert.deepEqual(signed.provenance?.evidenceRefs, ['scan.a']);
    assert.equal(signed.provenance?.datasetHash, null);
  });

  it('un ownerUid non valido non firma nulla', () => {
    assert.throws(() => stampInsightOwner(insight(), '../u2'));
  });
});
