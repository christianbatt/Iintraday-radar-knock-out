import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendAiShadowLog,
  safeAppendAiShadowLog,
  readAiShadowLog,
  clampAiShadowLogLimit,
  buildAiShadowLogResponse,
  AI_SHADOW_LOG_RELATIVE_PATH,
  AI_SHADOW_LOG_DEFAULT_LIMIT,
  AI_SHADOW_LOG_MAX_LIMIT,
  AI_SHADOW_LOG_MAX_BYTES,
  AI_SHADOW_LOG_MAX_ARCHIVES,
  aiShadowLogArchivePath,
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
    assert.equal(entries[0].evaluated, true);
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

  it('registra proposte non valutate (evaluated false, discardReason valorizzato)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    // 1) direttiva LLM senza shape valida
    // 2) voce esplicita di assenza direttiva (newDirectives vuoto)
    appendAiShadowLog(
      [
        { ticker: 'AAA', topic: 'SOLO_TOPIC', source: 'specialize' },
        {
          source: 'desk',
          ticker: null,
          market: 'US',
          direction: null,
          setup: null,
          aiOutcome: null,
          aiCategory: null,
          evaluated: false,
          discarded: true,
          discardReason: 'llm: nessuna direttiva restituita (newDirectives assente o vuoto)',
        },
      ],
      file
    );
    const entries = readAiShadowLog(undefined, file);
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.evaluated, false);
      assert.equal(entry.discarded, true);
      assert.equal(typeof entry.discardReason, 'string');
      assert.ok((entry.discardReason as string).length > 0);
      assert.equal(entry.status, 'NON_VALIDATO');
      assert.equal(entry.outcome, null);
    }
    assert.match(entries[1].discardReason as string, /newDirectives/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('discarded non specificato dal chiamante => derivato dalla shape', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    appendAiShadowLog([{ topic: 'T', directive: 'D', predicateId: 'MARKET_EU' }], file);
    const [entry] = readAiShadowLog(undefined, file);
    assert.equal(entry.evaluated, true);
    assert.equal(entry.discarded, false);
    assert.equal(entry.discardReason, null);
    assert.equal(entry.aiCategory, 'MARKET_EU');
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

  it('rotazione a soglia: oltre 5 MB il file diventa .1 e il nuovo file riparte', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    fs.writeFileSync(file, Buffer.alloc(AI_SHADOW_LOG_MAX_BYTES + 1, 120), 'utf8');
    const before = fs.statSync(file).size;
    assert.ok(before > AI_SHADOW_LOG_MAX_BYTES);

    const res = appendAiShadowLog([{ aiOutcome: 'post-rotazione', aiCategory: 'X' }], file);
    assert.equal(res.ok, true);

    const archive1 = aiShadowLogArchivePath(file, 1);
    assert.equal(fs.existsSync(archive1), true);
    assert.equal(fs.statSync(archive1).size, before);
    const entries = readAiShadowLog(undefined, file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].aiOutcome, 'post-rotazione');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rotazione: mantiene al massimo tre archivi, elimina il piu\' vecchio', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    assert.equal(AI_SHADOW_LOG_MAX_ARCHIVES, 3);
    fs.writeFileSync(aiShadowLogArchivePath(file, 2), 'vecchio-2');
    fs.writeFileSync(aiShadowLogArchivePath(file, 3), 'vecchio-3');
    fs.writeFileSync(file, Buffer.alloc(AI_SHADOW_LOG_MAX_BYTES + 1, 120), 'utf8');

    appendAiShadowLog([{ aiOutcome: 'a', aiCategory: 'c' }], file);

    // .3 preesistente eliminato, .2 scalato a .3, file corrente diventato .1.
    assert.equal(fs.readFileSync(aiShadowLogArchivePath(file, 1), 'utf8').length > AI_SHADOW_LOG_MAX_BYTES, true);
    assert.equal(fs.existsSync(aiShadowLogArchivePath(file, 2)), false);
    assert.equal(fs.readFileSync(aiShadowLogArchivePath(file, 3), 'utf8'), 'vecchio-2');
    assert.equal(fs.existsSync(aiShadowLogArchivePath(file, 4)), false);
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

describe('aiShadowLog — safeAppend', () => {
  it('mock che lancia: non propaga, ritorna ok:false, usa console.warn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    const bad = Object.defineProperty({ source: 'specialize' as const }, 'aiOutcome', {
      get() {
        throw new Error('mock write failure');
      },
      enumerable: true,
    });
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '));
    };
    let thrown = false;
    let result: { ok: boolean } | null = null;
    try {
      result = safeAppendAiShadowLog(bad, file);
    } catch {
      thrown = true;
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(thrown, false);
    assert.equal(result?.ok, false);
    assert.ok(warnings.some((w) => w.includes('mock write failure')));
    assert.equal(fs.existsSync(file), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scrittura normale: ok:true e nessun warning', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    const result = safeAppendAiShadowLog([{ aiOutcome: 'a', aiCategory: 'c' }], file);
    assert.equal(result.ok, true);
    assert.equal(result.written, 1);
    assert.equal(readAiShadowLog(undefined, file).length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('aiShadowLog — endpoint /api/shadow/ai-log', () => {
  it('clamp del limite: default 50, massimo 200, minimo 1, non numerico => default', () => {
    assert.equal(AI_SHADOW_LOG_DEFAULT_LIMIT, 50);
    assert.equal(AI_SHADOW_LOG_MAX_LIMIT, 200);
    assert.equal(clampAiShadowLogLimit(undefined), 50);
    assert.equal(clampAiShadowLogLimit(null), 50);
    assert.equal(clampAiShadowLogLimit('abc'), 50);
    assert.equal(clampAiShadowLogLimit('500'), 200);
    assert.equal(clampAiShadowLogLimit(999), 200);
    assert.equal(clampAiShadowLogLimit('0'), 1);
    assert.equal(clampAiShadowLogLimit(10), 10);
    assert.equal(clampAiShadowLogLimit('10.9'), 10);
  });

  it('risposta con conteggi per status, discarded ed evaluated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'log.jsonl');
    appendAiShadowLog(
      [
        { topic: 'T', directive: 'D', predicateId: 'MARKET_EU' },
        { ticker: 'X', source: 'desk' },
        {
          aiOutcome: null,
          source: 'desk',
          evaluated: false,
          discarded: true,
          discardReason: 'llm: nessuna direttiva restituita',
        },
      ],
      file
    );
    const all = buildAiShadowLogResponse(undefined, file);
    assert.equal(all.total, 3);
    assert.equal(all.count, 3);
    assert.equal(all.limit, 50);
    assert.equal(all.byStatus.NON_VALIDATO, 3);
    assert.equal(all.byEvaluated.true, 1);
    assert.equal(all.byEvaluated.false, 2);
    assert.equal(all.byDiscarded.true, 2);
    assert.equal(all.byDiscarded.false, 1);

    const limited = buildAiShadowLogResponse('2', file);
    assert.equal(limited.limit, 2);
    assert.equal(limited.count, 2);
    assert.equal(limited.total, 3);

    const clamped = buildAiShadowLogResponse('9999', file);
    assert.equal(clamped.limit, 200);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('file assente: risposta vuota senza errori', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-log-'));
    const file = path.join(dir, 'missing.jsonl');
    const body = buildAiShadowLogResponse(undefined, file);
    assert.deepEqual(body.entries, []);
    assert.equal(body.count, 0);
    assert.equal(body.total, 0);
    assert.equal(body.limit, 50);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('percorso di default: radice del repo, non artifacts/', () => {
    assert.equal(AI_SHADOW_LOG_RELATIVE_PATH, 'shadow_ai_log.jsonl');
    assert.equal(AI_SHADOW_LOG_RELATIVE_PATH.includes('artifacts'), false);
  });
});
