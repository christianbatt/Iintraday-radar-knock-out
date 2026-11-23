import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendAiShadowLog,
  readAiShadowLog,
  appendAiShadowLogEntries,
} from '../../server/aiShadowLog';

describe('aiShadowLog — scrittura', () => {
  it('scrive entry con status NON_VALIDATO e outcome null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    const res = appendAiShadowLog(file, [
      {
        ticker: 'AAA',
        market: 'EU',
        direction: 'LONG',
        setup: 'TOPIC',
        aiOutcome: 'direttiva',
        aiCategory: 'MARKET_EU',
        source: 'specialize',
      },
    ]);
    assert.equal(res.ok, true);
    assert.equal(res.written, 1);
    const entries = readAiShadowLog(file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'NON_VALIDATO');
    assert.equal(entries[0].outcome, null);
    assert.equal(entries[0].source, 'specialize');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('append multipli accumulano righe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    appendAiShadowLog(file, [{ aiOutcome: 'a', aiCategory: 'c', source: 'desk' }]);
    appendAiShadowLogEntries(file, [{ aiOutcome: 'b', aiCategory: 'd', source: 'desk' }]);
    const entries = readAiShadowLog(file);
    assert.equal(entries.length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errore di I/O non lancia (path non scrivibile)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const file = path.join(blocker, 'log.jsonl');
    let thrown = false;
    try {
      const res = appendAiShadowLog(file, [{ aiOutcome: 'a', aiCategory: 'c' }]);
      assert.equal(res.ok, false);
    } catch {
      thrown = true;
    }
    assert.equal(thrown, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('nessuna scrittura in memoria: il modulo non importa memoryUpdater', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/server/aiShadowLog.ts'), 'utf8');
    assert.equal(src.includes('memoryUpdater'), false);
    assert.equal(src.includes('updateAIMemory'), false);
  });
});
