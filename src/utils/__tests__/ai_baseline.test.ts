/**
 * Test della baseline AI (Passo 0.1).
 *
 * I/O in memoria: nessun file temporaneo, nessun orologio. I casi verificano i
 * fatti dichiarati (conteggi, presenze, OHLC) e i casi degeneri (file assenti,
 * JSON rotto, righe illeggibili), che devono diventare fatti e mai eccezioni.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  AI_BASELINE_PATHS,
  AI_BASELINE_VERSION,
  buildAiBaseline,
  type AiBaselineIo,
} from '../../server/aiBaseline';

const ROOT = '/finto/progetto';
const NOW = Date.UTC(2026, 10, 28, 9, 30, 0);

function abs(relativePath: string): string {
  return path.join(ROOT, relativePath);
}

function ioOf(files: Record<string, string>): AiBaselineIo {
  return {
    readText: (absolutePath) => files[absolutePath] ?? null,
    sizeBytes: (absolutePath) =>
      absolutePath in files ? Buffer.byteLength(files[absolutePath], 'utf8') : null,
  };
}

function lines(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

describe('aiBaseline — assenza di dati', () => {
  it('radice vuota: nessuna eccezione, tutto dichiarato assente, zeri', () => {
    const out = buildAiBaseline({ rootDir: ROOT, nowMs: NOW, io: ioOf({}) });
    assert.equal(out.version, AI_BASELINE_VERSION);
    assert.equal(out.generatedAt, '2026-11-28T09:30:00.000Z');
    assert.equal(out.aiScans.exists, false);
    assert.equal(out.aiScans.rows, 0);
    assert.equal(out.signals.meanR, null);
    assert.equal(out.bars.parsed, false);
    assert.equal(out.bars.bars, 0);
    assert.equal(out.memory.parsed, false);
    assert.equal(out.availability.barsPresent, false);
    assert.equal(out.availability.aiDecisions, 0);
    assert.equal(out.availability.resolvedForward, 0);
    assert.equal(out.availability.validatedRules, 0);
  });

  it('JSON rotto: parsed false, nessun conteggio inventato', () => {
    const out = buildAiBaseline({
      rootDir: ROOT,
      nowMs: NOW,
      io: ioOf({
        [abs(AI_BASELINE_PATHS.bars)]: '{non-json',
        [abs(AI_BASELINE_PATHS.memory)]: 'nemmeno questo',
      }),
    });
    assert.equal(out.bars.exists, true);
    assert.equal(out.bars.parsed, false);
    assert.equal(out.memory.exists, true);
    assert.equal(out.memory.parsed, false);
    assert.equal(out.memory.rules, 0);
  });
});

describe('aiBaseline — conteggi delle righe', () => {
  it('conta righe, campi e righe illeggibili senza nasconderle', () => {
    const content = [
      JSON.stringify({ source: 'scan', evaluated: false, decision: null, discardReason: 'NON_INVIATO_ALLA_LLM' }),
      JSON.stringify({ source: 'scan', evaluated: true, decision: 'AZIONE' }),
      JSON.stringify({ source: 'scan', evaluated: true, decision: 'SCARTO' }),
      'riga-rotta',
      '',
    ].join('\n');

    const out = buildAiBaseline({
      rootDir: ROOT,
      nowMs: NOW,
      io: ioOf({ [abs(AI_BASELINE_PATHS.aiScans)]: content }),
    });

    assert.equal(out.aiScans.rows, 3);
    assert.equal(out.aiScans.unparsable, 1);
    assert.equal(out.aiScans.byField.decision?.AZIONE, 1);
    assert.equal(out.aiScans.byField.decision?.SCARTO, 1);
    assert.equal(out.aiScans.byField.decision?.null, 1);
    assert.equal(out.aiScans.byField.evaluated?.false, 1);
    // Solo le decisioni non nulle contano come classificabili.
    assert.equal(out.availability.aiDecisions, 2);
  });

  it('R medio: usa r se finito, altrimenti theoreticalRMultiple', () => {
    const signals = lines([
      { status: 'TARGET', r: 2 },
      { status: 'STOP', r: -1 },
      { status: 'EXPIRED', r: 'non-numerico' },
    ]);
    const nearMiss = lines([
      { status: 'TARGET', theoreticalRMultiple: 1.6 },
      { status: 'STOP', theoreticalRMultiple: -1 },
      { status: 'EXPIRED' },
      { status: 'NOT_FILLED' },
    ]);

    const out = buildAiBaseline({
      rootDir: ROOT,
      nowMs: NOW,
      io: ioOf({
        [abs(AI_BASELINE_PATHS.signals)]: signals,
        [abs(AI_BASELINE_PATHS.nearMiss)]: nearMiss,
      }),
    });

    assert.equal(out.signals.meanRN, 2);
    assert.equal(out.signals.meanR, 0.5);
    assert.equal(out.nearMiss.meanRN, 2);
    assert.equal(out.nearMiss.meanR, 0.3);
    // Risolti: signals 3 (TARGET/STOP/EXPIRED), near-miss 3 (NOT_FILLED escluso).
    assert.equal(out.availability.resolvedForward, 6);
    // Campo richiesto ma assente nelle righe: finisce sotto la chiave `null`,
    // mai sotto un valore inventato.
    assert.deepEqual(out.nearMiss.byField.nearMissGate, { null: 4 });
  });
});

describe('aiBaseline — barre', () => {
  it('mappa ticker -> barre con OHLC: conta ticker, barre e chiavi', () => {
    const bars = {
      'AAA.MI': [
        { t: 1, o: 10, h: 11, l: 9, c: 10.5, v: 100 },
        { t: 2, o: 10.5, h: 12, l: 10, c: 11.5, v: 120 },
      ],
      'BBB.MI': [{ t: 1, o: 20, h: 21, l: 19, c: 20.5, v: 80 }],
    };
    const out = buildAiBaseline({
      rootDir: ROOT,
      nowMs: NOW,
      io: ioOf({ [abs(AI_BASELINE_PATHS.bars)]: JSON.stringify(bars) }),
    });

    assert.equal(out.bars.parsed, true);
    assert.equal(out.bars.shape, 'map-of-arrays');
    assert.equal(out.bars.tickers, 2);
    assert.equal(out.bars.bars, 3);
    assert.equal(out.bars.hasOhlc, true);
    assert.equal(out.bars.sampledBars, 3);
    assert.deepEqual(out.bars.barKeys, ['c', 'h', 'l', 'o', 't', 'v']);
    assert.equal(out.availability.barsHaveOhlc, true);
    assert.equal(out.availability.barsCount, 3);
  });

  it('barra senza high: hasOhlc false (nessuna stima, nessun riempimento)', () => {
    const bars = { 'AAA.MI': [{ t: 1, o: 10, l: 9, c: 10.5 }] };
    const out = buildAiBaseline({
      rootDir: ROOT,
      nowMs: NOW,
      io: ioOf({ [abs(AI_BASELINE_PATHS.bars)]: JSON.stringify(bars) }),
    });
    assert.equal(out.bars.bars, 1);
    assert.equal(out.bars.hasOhlc, false);
    assert.equal(out.availability.barsHaveOhlc, false);
  });

  it('wrapper {ticker, bars}: srotola le barre e conta i ticker dichiarati', () => {
    // Forma reale di artifacts/shadow_v1_live/bars.json.
    const file = {
      bars: [
        {
          ticker: 'AAA.MI',
          market: 'EU',
          updatedAt: '2026-11-28T00:00:00Z',
          bars: [
            { t: 1, o: 10, h: 11, l: 9, c: 10.5 },
            { t: 2, o: 10.5, h: 12, l: 10, c: 11.5 },
          ],
        },
        { ticker: 'BBB.MI', market: 'EU', updatedAt: '2026-11-28T00:00:00Z', bars: [{ t: 1, o: 20, h: 21, l: 19, c: 20.5 }] },
      ],
    };
    const out = buildAiBaseline({
      rootDir: ROOT,
      nowMs: NOW,
      io: ioOf({ [abs(AI_BASELINE_PATHS.bars)]: JSON.stringify(file) }),
    });

    assert.equal(out.bars.shape, 'wrapper-list');
    assert.equal(out.bars.tickers, 2, 'due ticker dichiarati dai wrapper');
    assert.equal(out.bars.bars, 3, 'tre barre srotolate, non due wrapper');
    assert.equal(out.bars.hasOhlc, true);
    assert.deepEqual(out.bars.barKeys, ['c', 'h', 'l', 'o', 't']);
    assert.equal(out.availability.barsCount, 3);
    assert.equal(out.availability.barsHaveOhlc, true);
  });

  it('mappa verso lista di wrapper: srotola anche li (nessun involucro contato)', () => {
    const file = {
      '2026-11-28': [
        { ticker: 'AAA.MI', market: 'EU', updatedAt: 'x', bars: [{ t: 1, o: 10, h: 11, l: 9, c: 10.5 }] },
        { ticker: 'BBB.MI', market: 'EU', updatedAt: 'x', bars: [{ t: 2, o: 20, h: 21, l: 19, c: 20.5 }] },
      ],
    };
    const out = buildAiBaseline({
      rootDir: ROOT,
      nowMs: NOW,
      io: ioOf({ [abs(AI_BASELINE_PATHS.bars)]: JSON.stringify(file) }),
    });
    assert.equal(out.bars.shape, 'wrapper-list');
    assert.equal(out.bars.tickers, 2);
    assert.equal(out.bars.bars, 2, 'due barre reali, non due wrapper');
    assert.equal(out.bars.hasOhlc, true);
  });

  it('array piatto di barre: nessun ticker dichiarato, zero (non inventato)', () => {
    const bars = [{ t: 1, o: 10, h: 11, l: 9, c: 10.5 }];
    const out = buildAiBaseline({
      rootDir: ROOT,
      nowMs: NOW,
      io: ioOf({ [abs(AI_BASELINE_PATHS.bars)]: JSON.stringify(bars) }),
    });
    assert.equal(out.bars.shape, 'array');
    assert.equal(out.bars.tickers, 0);
    assert.equal(out.bars.bars, 1);
    assert.equal(out.bars.hasOhlc, true);
  });

  it('forma non riconosciuta: shape other, nessun conteggio inventato', () => {
    const out = buildAiBaseline({
      rootDir: ROOT,
      nowMs: NOW,
      io: ioOf({ [abs(AI_BASELINE_PATHS.bars)]: JSON.stringify({ v: 3, meta: 'x' }) }),
    });
    assert.equal(out.bars.parsed, true);
    assert.equal(out.bars.shape, 'other');
    assert.equal(out.bars.bars, 0);
    assert.equal(out.bars.hasOhlc, false);
  });
});

describe('aiBaseline — memoria', () => {
  it('distingue ipotesi a mano da regole scritte dal validatore', () => {
    const memory = [
      { id: 'ai-rule-1', topic: 'T1', confidence: null },
      { id: 'ai-rule-2', topic: 'PREDICATO_MARKET_EU', confidence: 97 },
    ];
    const out = buildAiBaseline({
      rootDir: ROOT,
      nowMs: NOW,
      io: ioOf({ [abs(AI_BASELINE_PATHS.memory)]: JSON.stringify(memory) }),
    });
    assert.equal(out.memory.parsed, true);
    assert.equal(out.memory.rules, 2);
    assert.equal(out.memory.validated, 1);
    assert.deepEqual(out.memory.topics, ['T1', 'PREDICATO_MARKET_EU']);
    assert.equal(out.availability.validatedRules, 1);
  });
});

describe('aiBaseline — determinismo', () => {
  it('stesso input => stesso output', () => {
    const files = {
      [abs(AI_BASELINE_PATHS.aiScans)]: lines([{ source: 'scan', evaluated: true, decision: 'ATTESA' }]),
      [abs(AI_BASELINE_PATHS.signals)]: lines([{ status: 'TARGET', r: 2 }]),
    };
    const first = buildAiBaseline({ rootDir: ROOT, nowMs: NOW, io: ioOf(files) });
    const second = buildAiBaseline({ rootDir: ROOT, nowMs: NOW, io: ioOf(files) });
    assert.deepEqual(first, second);
  });
});
