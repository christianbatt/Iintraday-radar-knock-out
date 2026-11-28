/**
 * Attribuzione della memoria (Passo 2.5).
 *
 * Il catalizzatore e' l'unico percorso che inietta regole apprese nel prompt:
 * senza gli id sulla riga di log, l'effetto di una regola e' indistinguibile
 * dall'effetto del prompt. Qui si verifica la sanificazione e il round-trip.
 *
 * File temporanei in `os.tmpdir()`: nessuna scrittura nel repository.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AI_SHADOW_MAX_MEMORY_RULE_IDS,
  appendAiShadowLog,
  normalizeMemoryRuleIds,
  readAiShadowLog,
} from '../../server/aiShadowLog';

describe('memoryRuleIds — sanificazione', () => {
  it('campo assente o non array: null, mai un array vuoto', () => {
    assert.equal(normalizeMemoryRuleIds(undefined), null);
    assert.equal(normalizeMemoryRuleIds(null), null);
    assert.equal(normalizeMemoryRuleIds('ai-rule-1'), null);
    assert.equal(normalizeMemoryRuleIds([]), null);
  });

  it('trim, dedupe e scarto dei non-stringa', () => {
    assert.deepEqual(
      normalizeMemoryRuleIds([' ai-rule-1 ', 'ai-rule-1', '', 42, 'ai-rule-2']),
      ['ai-rule-1', 'ai-rule-2']
    );
  });

  it('solo spazi: null (una stringa vuota non e un id)', () => {
    assert.equal(normalizeMemoryRuleIds(['   ', '\t']), null);
  });

  it('tetto dichiarato: oltre il massimo gli id vengono troncati', () => {
    const many = Array.from({ length: AI_SHADOW_MAX_MEMORY_RULE_IDS + 5 }, (_, i) => `id-${i}`);
    const out = normalizeMemoryRuleIds(many);
    assert.equal(out?.length, AI_SHADOW_MAX_MEMORY_RULE_IDS);
    assert.equal(out?.[0], 'id-0');
  });
});

describe('memoryRuleIds — round-trip nel log', () => {
  it('la riga del catalizzatore conserva gli id iniettati', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-mem-attr-'));
    const file = path.join(dir, 'shadow_ai_log.jsonl');
    try {
      const written = appendAiShadowLog(
        {
          ticker: 'UCG.MI',
          market: 'EU',
          direction: 'LONG',
          setup: 'catalyst score=61/100 news=2 bonus=+5',
          aiOutcome: 'Upgrade da agenzia primaria',
          aiCategory: 'newsBonus=5;dirMatch=true;regime=true',
          source: 'catalyst',
          evaluated: true,
          decision: 'AZIONE',
          candidateKey: 'catalyst:run-1:UCG.MI',
          runId: 'run-1',
          promptVersion: 'ai-catalyst@3',
          model: 'openrouter:m',
          memoryRuleIds: ['ai-rule-1', ' ai-rule-1 ', 'ai-rule-2'],
        },
        file
      );
      assert.equal(written.ok, true);

      const rows = readAiShadowLog(undefined, file);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source, 'catalyst');
      assert.deepEqual(rows[0].memoryRuleIds, ['ai-rule-1', 'ai-rule-2']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('riga senza campo: null, cosi una regola non attribuita resta non attribuita', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-mem-attr-'));
    const file = path.join(dir, 'shadow_ai_log.jsonl');
    try {
      appendAiShadowLog(
        {
          ticker: 'ISP.MI',
          market: 'EU',
          source: 'scan',
          evaluated: false,
          decision: null,
          promptVersion: 'ai-scan@1',
        },
        file
      );
      const rows = readAiShadowLog(undefined, file);
      assert.equal(rows[0].memoryRuleIds, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
