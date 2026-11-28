/**
 * Ciclo di vita delle regole (Fase 4): scadenza, attività, revoca, prompt.
 *
 * File temporanei in `os.tmpdir()`: nessuna scrittura nel repository.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AI_MEMORY_RULE_TTL_MS,
  AI_MEMORY_REVOCATION_RETEST_FAILED,
  appendRevocationLog,
  applyLifecycleDefaults,
  buildMemoryPromptBlock,
  isRuleActive,
  revokeRulesForFailedPredicates,
  ruleExpiryIso,
  selectActiveRules,
  stampTestedRule,
} from '../../server/aiMemoryLifecycle';
import type { AILearnedInsight } from '../../types/radar';

const NOW = Date.parse('2026-11-28T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function rule(over: Partial<AILearnedInsight> = {}): AILearnedInsight {
  return {
    id: 'ai-leverage-5',
    learnedAt: new Date(NOW - 10 * DAY).toISOString(),
    market: 'GLOBAL',
    topic: 'LEVERAGE_5',
    directive: 'Leva 5 con stop stretto',
    confidence: 95,
    sampleEvidence: 'n=42',
    sampleSize: 42,
    validUntil: new Date(NOW + 30 * DAY).toISOString(),
    lastTestedAt: new Date(NOW - 10 * DAY).toISOString(),
    testCount: 1,
    provenance: { promptVersion: 'ai-specialize@2', model: 'openrouter:m', evidenceRefs: [] },
    ...over,
  };
}

describe('scadenza derivata', () => {
  it('90 giorni da learnedAt, non da adesso', () => {
    const learnedAt = new Date(NOW - 200 * DAY).toISOString();
    assert.equal(ruleExpiryIso(learnedAt, NOW), new Date(NOW - 200 * DAY + AI_MEMORY_RULE_TTL_MS).toISOString());
  });

  it('una data non leggibile non produce una scadenza nel passato per caso', () => {
    assert.equal(ruleExpiryIso(undefined, NOW), new Date(NOW + AI_MEMORY_RULE_TTL_MS).toISOString());
  });

  it('la migrazione completa i campi mancanti ed è idempotente', () => {
    const migrated = applyLifecycleDefaults({ ...rule(), validUntil: undefined, lastTestedAt: undefined, testCount: undefined }, NOW);
    assert.ok(migrated.validUntil);
    assert.equal(migrated.lastTestedAt, migrated.learnedAt);
    assert.equal(migrated.testCount, 1);
    assert.deepEqual(applyLifecycleDefaults(migrated, NOW), migrated);
  });

  it('non sovrascrive una scadenza già presente', () => {
    const existing = new Date(NOW + 3 * DAY).toISOString();
    assert.equal(applyLifecycleDefaults(rule({ validUntil: existing }), NOW).validUntil, existing);
  });
});

describe('isRuleActive', () => {
  it('attiva quando scade nel futuro ed è testata di recente', () => {
    assert.equal(isRuleActive(rule(), NOW), true);
  });

  it('scaduta: non attiva', () => {
    assert.equal(isRuleActive(rule({ validUntil: new Date(NOW - 1).toISOString() }), NOW), false);
  });

  it('revocata: non attiva', () => {
    assert.equal(isRuleActive(rule({ revokedAt: new Date(NOW - DAY).toISOString() }), NOW), false);
  });

  it('senza scadenza o senza data di test: non attiva, il dato assente non è una promessa', () => {
    assert.equal(isRuleActive(rule({ validUntil: undefined }), NOW), false);
    assert.equal(isRuleActive(rule({ lastTestedAt: undefined }), NOW), false);
  });

  it('re-test troppo vecchio: non attiva', () => {
    assert.equal(isRuleActive(rule({ lastTestedAt: new Date(NOW - 91 * DAY).toISOString() }), NOW), false);
  });

  it('solo le regole validate e attive vengono selezionate, in ordine', () => {
    const active = selectActiveRules(
      [
        rule({ id: 'a', topic: 'A' }),
        rule({ id: 'b', topic: 'B', confidence: null }),
        rule({ id: 'c', topic: 'C', validUntil: new Date(NOW - 1).toISOString() }),
        rule({ id: 'd', topic: 'D' }),
      ],
      NOW
    );
    assert.deepEqual(
      active.map((entry) => entry.id),
      ['a', 'd']
    );
  });
});

describe('prompt della memoria', () => {
  it('non contiene percentuali e dichiara q, n, scadenza e modello', () => {
    const block = buildMemoryPromptBlock(selectActiveRules([rule()], NOW), NOW);
    assert.equal(block.includes('%'), false);
    assert.ok(block.includes('q 0,050'));
    assert.ok(block.includes('n 42'));
    assert.ok(block.includes('valida fino al'));
    assert.ok(block.includes('modello openrouter:m'));
    assert.ok(block.includes('ultimo test'));
  });

  it('un dato mancante è dichiarato, non riempito', () => {
    const block = buildMemoryPromptBlock(
      [rule({ sampleSize: undefined, provenance: null })],
      NOW
    );
    assert.ok(block.includes('n non dichiarato'));
    assert.ok(block.includes('modello non dichiarato'));
  });
});

describe('re-test e revoca', () => {
  it('un predicato testato e fallito revoca la regola, che resta nel file', () => {
    const outcome = revokeRulesForFailedPredicates(
      [rule()],
      [{ predicateId: 'LEVERAGE_5', tested: true, passesGates: false, n: 55 }],
      NOW
    );
    assert.equal(outcome.revoked.length, 1);
    assert.equal(outcome.revoked[0].reason, AI_MEMORY_REVOCATION_RETEST_FAILED);
    assert.equal(outcome.revoked[0].sampleSize, 55);
    const revoked = outcome.memory[0];
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.revocationReason, AI_MEMORY_REVOCATION_RETEST_FAILED);
    assert.equal(revoked.directive, 'Leva 5 con stop stretto', 'la regola resta, non si cancella');
  });

  it('un predicato senza campione non revoca nulla', () => {
    const outcome = revokeRulesForFailedPredicates(
      [rule()],
      [{ predicateId: 'LEVERAGE_5', tested: false, passesGates: false, n: 4 }],
      NOW
    );
    assert.equal(outcome.revoked.length, 0);
    assert.equal(outcome.memory[0].revokedAt, undefined);
  });

  it('un predicato che passa non revoca, e una regola già revocata non produce doppioni', () => {
    const passing = revokeRulesForFailedPredicates(
      [rule()],
      [{ predicateId: 'LEVERAGE_5', tested: true, passesGates: true, n: 60 }],
      NOW
    );
    assert.equal(passing.revoked.length, 0);

    const twice = revokeRulesForFailedPredicates(
      [{ ...rule(), revokedAt: new Date(NOW - DAY).toISOString() }],
      [{ predicateId: 'LEVERAGE_5', tested: true, passesGates: false, n: 60 }],
      NOW
    );
    assert.equal(twice.revoked.length, 0);
  });

  it('il re-test superato rinnova la regola e cresce il contatore', () => {
    const renewed = stampTestedRule(rule({ testCount: 2 }), NOW);
    assert.equal(renewed.testCount, 3);
    assert.equal(renewed.lastTestedAt, new Date(NOW).toISOString());
    assert.equal(renewed.validUntil, new Date(NOW + AI_MEMORY_RULE_TTL_MS).toISOString());
  });

  it('il registro delle revoche è append-only e una riga per revoca', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-mem-rev-'));
    const file = path.join(dir, 'revocations.jsonl');
    try {
      const outcome = revokeRulesForFailedPredicates(
        [rule()],
        [{ predicateId: 'LEVERAGE_5', tested: true, passesGates: false, n: 55 }],
        NOW
      );
      appendRevocationLog(outcome.revoked, file);
      appendRevocationLog(outcome.revoked, file);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      const first = JSON.parse(lines[0]) as { topic: string; reason: string };
      assert.equal(first.topic, 'LEVERAGE_5');
      assert.equal(first.reason, AI_MEMORY_REVOCATION_RETEST_FAILED);
      // La prima riga resta identica: il registro non si riscrive.
      assert.equal(lines[0], lines[1]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
