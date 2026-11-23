import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendAiShadowLog,
  readAiShadowLog,
  AI_SHADOW_LOG_RELATIVE_PATH,
} from '../../server/aiShadowLog';

describe('aiShadowLog — scrittura', () => {
  it('scrive entry con status NON_VALIDATO e outcome null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    const res = appendAiShadowLog(
      [
        {
          ticker: 'AAA',
          market: 'EU',
          direction: 'LONG',
          setup: 'TOPIC',
          aiOutcome: 'direttiva',
          aiCategory: 'MARKET_EU',
          source: 'specialize',
        },
      ],
      file
    );
    assert.equal(res.ok, true);
    assert.equal(res.written, 1);
    const entries = readAiShadowLog(undefined, file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'NON_VALIDATO');
    assert.equal(entries[0].outcome, null);
    assert.equal(entries[0].source, 'specialize');
    assert.equal(entries[0].discarded, false);
    assert.equal(entries[0].discardReason, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('append multipli accumulano righe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    appendAiShadowLog([{ aiOutcome: 'a', aiCategory: 'c', source: 'desk' }], file);
    appendAiShadowLog([{ aiOutcome: 'b', aiCategory: 'd', source: 'desk' }], file);
    const entries = readAiShadowLog(undefined, file);
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
      const res = appendAiShadowLog([{ aiOutcome: 'a', aiCategory: 'c' }], file);
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

  it('registra anche proposte scartate (discarded true, discardReason valorizzato)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    const res = appendAiShadowLog(
      [
        { ticker: 'ZZZ', source: 'specialize' }, // manca topic/directive -> scartata
        { topic: 'T', directive: 'D', source: 'desk' }, // valida
      ],
      file
    );
    assert.equal(res.ok, true);
    assert.equal(res.written, 2);
    const entries = readAiShadowLog(undefined, file);
    assert.equal(entries.length, 2);
    const discarded = entries.find((e) => e.discarded === true);
    assert.ok(discarded);
    assert.equal(typeof discarded!.discardReason, 'string');
    assert.ok((discarded!.discardReason as string).length > 0);
    assert.equal(discarded!.status, 'NON_VALIDATO');
    assert.equal(discarded!.outcome, null);
    const valid = entries.find((e) => e.discarded === false);
    assert.ok(valid);
    assert.equal(valid!.discardReason, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readAiShadowLog(limit) restituisce le ultime N', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    appendAiShadowLog(
      [
        { aiOutcome: 'a', aiCategory: 'c' },
        { aiOutcome: 'b', aiCategory: 'd' },
        { aiOutcome: 'c', aiCategory: 'e' },
      ],
      file
    );
    const last2 = readAiShadowLog(2, file);
    assert.equal(last2.length, 2);
    assert.equal(last2[0].aiOutcome, 'b');
    assert.equal(last2[1].aiOutcome, 'c');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('nessuna scrittura su file memoria: append non tocca ai_specialization_memory.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    const memFile = path.join(dir, 'ai_specialization_memory.json');
    fs.writeFileSync(memFile, '{"before":true}');
    const before = fs.readFileSync(memFile, 'utf8');
    appendAiShadowLog([{ aiOutcome: 'x', aiCategory: 'y' }], file);
    const after = fs.readFileSync(memFile, 'utf8');
    assert.equal(before, after);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});