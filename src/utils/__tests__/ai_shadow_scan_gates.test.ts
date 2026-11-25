/**
 * ADDITIVO (gate nel log AI): test dell'aggancio gate G1-G13 / motivo.
 *
 * Verifica che i gate gia' calcolati dalla diagnostica Shadow V1 arrivino nelle
 * righe `CANDIDATI_SCANSIONE` solo per la scansione che li ha prodotti
 * (chiave `runId:ticker`) e che le voci del log AI siano scritte anche quando
 * quella diagnostica manca o la lettura lancia. Nessun test esistente viene
 * modificato: questo file aggiunge solo casi nuovi.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RawQuoteData } from '../../types/radar';
import { observeShadowV1LiveScan } from '../../server/shadowV1LiveScanner';
import {
  applyScanGateDiagnostics,
  buildScanEvaluationPrompt,
  evaluateScanCandidates,
  formatScanCandidateLine,
  getLastScanCandidates,
  resetLastScanCandidates,
  resolveScanCandidateInput,
  setLastScanCandidates,
  setLastScanRunId,
  type ScanCandidateSnapshot,
} from '../../server/aiScanEvaluation';

const GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13'];

function snapshot(count: number): ScanCandidateSnapshot[] {
  return Array.from({ length: count }, (_, i) => ({
    ticker: `T${String(i).padStart(2, '0')}`,
    market: i % 2 === 0 ? 'EU' : 'US',
    direction: 'LONG',
    scoreTotal: 50 + i,
    veto: null,
  }));
}

function gateRows(count: number): { ticker: string; gate: string; reason: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const gate = GATES[i % GATES.length];
    return { ticker: `T${String(i).padStart(2, '0')}`, gate, reason: `Motivo ${gate}` };
  });
}

const D0 = Date.UTC(2026, 2, 16, 15, 0, 0);

/**
 * Citazione minima con indicatori in warmup: lo scanner produce una riga di
 * diagnostica `WARMUP_INCOMPLETE` per ogni titolo, senza setup ne' near-miss.
 */
function makeWarmupQuote(ticker: string): RawQuoteData {
  return {
    ticker,
    name: ticker,
    market: 'US',
    currency: 'USD',
    currentPrice: 100.2,
    prevClose: 99,
    preMarketPrice: 100,
    prevHigh: 99.8,
    prevLow: 98.4,
    preMarketHigh: 100.2,
    preMarketLow: 99.4,
    preMarketVolume: 250_000,
    todayOpen: 100,
    todayHigh: 100.6,
    todayLow: 99.6,
    atr14: 2.0,
    adr14: 4.0,
    avgVolume20d: 1_000_000,
    liqEur20d: 80_000_000,
    completedBarsCount: 20,
    rvol: 2.2,
    rvol20m: 2.0,
    gapPercent: 1.01,
    rsi14: 58,
    rsi5m: 58,
    orbHigh: 100.1,
    orbLow: 99.5,
    orbBreakoutTime: null,
    orbBreakoutTimeLong: null,
    orbBreakoutTimeShort: null,
    vwapCumulative: 99.8,
    lastBarTime: Math.floor((D0 - 2 * 60_000) / 1000),
    marketTs: Math.floor((D0 - 60_000) / 1000),
    timestamp: new Date(D0).toISOString(),
    source: 'YAHOO',
    vwapState: {
      state: 'ABOVE',
      vwapLevel: 99.8,
      distAtr: 0.4,
      slopeAtr: 0.1,
      coverage: 1,
      volumeRatio: 1.8,
      flags: [],
    },
    orderFlow: {
      buyerVolumePercent: 62,
      sellerVolumePercent: 38,
      netDeltaPercent: 24,
      cvdTrend: 'EXPANDING_UP',
      vpocPrice: 99.9,
      isPriceAboveVpoc: true,
      flowQuality: 'INSTITUTIONAL_BUYING',
      summary: 'Flusso acquirente positivo',
    },
    setupIndicators: {
      barsUsed: 0,
      priorSessionsUsed: 0,
      recentBars: [],
      atr: { value: null, status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS' },
      supertrend: {
        status: 'UNKNOWN',
        reason: 'INSUFFICIENT_BARS',
        direction: 0,
        barsSinceFlip: null,
        value: null,
      },
      adx: {
        status: 'UNKNOWN',
        reason: 'INSUFFICIENT_BARS',
        value: null,
        plusDI: null,
        minusDI: null,
      },
      stochRsi: {
        status: 'UNKNOWN',
        reason: 'INSUFFICIENT_BARS',
        k: null,
        d: null,
        lastCross: 'NONE',
        barsSinceCross: null,
      },
      psar: {
        status: 'UNKNOWN',
        reason: 'INSUFFICIENT_BARS',
        value: null,
        direction: 0,
        barsSinceFlip: null,
      },
    },
  } as RawQuoteData;
}

function makeMockLlm(): (system: string, prompt: string) => Promise<string | null> {
  return async (_system: string, prompt: string): Promise<string | null> => {
    const tickers = [...prompt.matchAll(/^([A-Z0-9._-]+) \| /gm)].map((m) => m[1]);
    return JSON.stringify({
      scanEvaluations: tickers.map((ticker) => ({
        ticker,
        aiOutcome: `OSSERVAZIONE_${ticker}`,
        aiCategory: 'CATEGORIA_TEST',
      })),
    });
  };
}

function promptLines(prompt: string): string[] {
  return prompt.split('\n').filter((line) => /^T\d\d \| /.test(line));
}

describe('gate G1-G13 nel log AI', () => {
  it('E1 — 40 candidati con gate e motivo: 40 righe con gate/motivo reali e 40 voci evaluated', async () => {
    resetLastScanCandidates();
    setLastScanCandidates(snapshot(40));
    setLastScanRunId('run-gates');
    applyScanGateDiagnostics('run-gates', () => gateRows(40));

    const resolved = resolveScanCandidateInput(undefined, undefined);
    assert.equal(resolved.candidateSource, 'snapshot');
    assert.equal(resolved.candidates.length, 40);

    const lines = promptLines(buildScanEvaluationPrompt(resolved.candidates));
    assert.equal(lines.length, 40);
    for (const line of lines) {
      assert.match(line, /gate: G\d+/);
      assert.doesNotMatch(line, /gate: n\.d\./);
      assert.match(line, /motivo: Motivo G\d+/);
      assert.doesNotMatch(line, /motivo: n\.d\./);
    }
    const distinctGates = new Set(lines.map((line) => line.split('gate: ')[1].split(' | ')[0]));
    assert.equal(distinctGates.size, 13);
    console.log('RIGHE_PROMPT_E1:\n' + lines.slice(0, 3).join('\n'));

    const result = await evaluateScanCandidates(resolved.candidates, 'specialize', makeMockLlm(), 10, {
      runId: 'run-gates',
    });
    assert.equal(result.entries.length, 40);
    assert.equal(result.evaluated, 40);
    assert.ok(result.entries.every((entry) => entry.evaluated === true));
    resetLastScanCandidates();
  });

  it('E2 — gate assente per 5 candidati: 5 righe gate/motivo n.d., 35 con gate, 40 voci scritte', async () => {
    resetLastScanCandidates();
    setLastScanCandidates(snapshot(40));
    setLastScanRunId('run-gates-partial');
    applyScanGateDiagnostics('run-gates-partial', () => gateRows(35));

    const resolved = resolveScanCandidateInput(undefined, undefined);
    const lines = promptLines(buildScanEvaluationPrompt(resolved.candidates));
    assert.equal(lines.length, 40);
    const withGate = lines.filter((line) => !line.includes('gate: n.d.'));
    const withoutGate = lines.filter((line) => line.includes('gate: n.d.'));
    assert.equal(withGate.length, 35);
    assert.equal(withoutGate.length, 5);
    for (const line of withoutGate) {
      assert.match(line, /motivo: n\.d\./);
    }
    assert.deepEqual(
      withoutGate.map((line) => line.split(' | ')[0]),
      ['T35', 'T36', 'T37', 'T38', 'T39']
    );

    const result = await evaluateScanCandidates(resolved.candidates, 'desk', makeMockLlm(), 10, {
      runId: 'run-gates-partial',
    });
    assert.equal(result.entries.length, 40);
    assert.equal(result.evaluated, 40);
    resetLastScanCandidates();
  });

  it('E3 — lettura della diagnostica che lancia: 40 voci scritte, gate null, nessuna eccezione', async () => {
    resetLastScanCandidates();
    setLastScanCandidates(snapshot(40));
    setLastScanRunId('run-gates-missing');
    assert.doesNotThrow(() =>
      applyScanGateDiagnostics('run-gates-missing', () => {
        throw new Error('shadow v1 ko');
      })
    );
    assert.deepEqual(
      getLastScanCandidates().map((candidate) => candidate.gate ?? null),
      new Array(40).fill(null)
    );

    const resolved = resolveScanCandidateInput(undefined, undefined);
    const lines = promptLines(buildScanEvaluationPrompt(resolved.candidates));
    assert.equal(lines.length, 40);
    for (const line of lines) {
      assert.match(line, /gate: n\.d\./);
      assert.match(line, /motivo: n\.d\./);
    }

    const result = await evaluateScanCandidates(resolved.candidates, 'specialize', makeMockLlm(), 10, {
      runId: 'run-gates-missing',
    });
    assert.equal(result.entries.length, 40);
    assert.equal(result.evaluated, 40);
    resetLastScanCandidates();
  });

  it('4.1 — scansione N+1 con scanner null: 40 voci gate null, nessun gate della scansione N', async () => {
    resetLastScanCandidates();
    setLastScanCandidates(snapshot(40));
    setLastScanRunId('run-N');
    applyScanGateDiagnostics('run-N', () => gateRows(40));
    assert.equal(getLastScanCandidates().length, 40);

    // Scansione N+1: lo scanner restituisce `null` (uscita anomala prevista).
    applyScanGateDiagnostics('run-N+1', () => null);
    setLastScanCandidates(snapshot(40).map((candidate) => ({ ...candidate, runId: 'run-N+1' })));
    setLastScanRunId('run-N+1');

    const resolved = resolveScanCandidateInput(undefined, undefined);
    assert.equal(resolved.runId, 'run-N+1');
    assert.equal(resolved.candidates.length, 40);
    assert.ok(
      resolved.candidates.every(
        (candidate) => candidate.gate === null && candidate.gateReason === null
      )
    );
    const lines = promptLines(buildScanEvaluationPrompt(resolved.candidates));
    assert.equal(lines.length, 40);
    for (const line of lines) {
      assert.match(line, /gate: n\.d\./);
      assert.match(line, /motivo: n\.d\./);
    }
    // ASSERZIONE 4.1: nessuna riga di N+1 riporta un gate G1-G13 della scansione N.
    assert.equal(lines.filter((line) => /gate: G\d+/.test(line)).length, 0);
    assert.equal(lines.filter((line) => /motivo: Motivo G\d+/.test(line)).length, 0);

    const result = await evaluateScanCandidates(resolved.candidates, 'specialize', makeMockLlm(), 10, {
      runId: 'run-N+1',
    });
    assert.equal(result.entries.length, 40);
    assert.equal(result.evaluated, 40);
    resetLastScanCandidates();
  });

  it('4.2 — body con runId diverso da quello della mappa: nessun gate applicato (n.d.)', () => {
    resetLastScanCandidates();
    applyScanGateDiagnostics('run-N', () => gateRows(40));

    const body = snapshot(2).map((candidate) => ({
      ticker: candidate.ticker,
      market: candidate.market,
      direction: candidate.direction,
      score: candidate.scoreTotal,
      veto: null,
    }));
    const resolved = resolveScanCandidateInput(body, 'run-OTHER');
    assert.equal(resolved.candidateSource, 'body');
    assert.equal(resolved.runId, 'run-OTHER');
    assert.ok(
      resolved.candidates.every(
        (candidate) =>
          candidate.gate === null && candidate.gateReason === null && candidate.decision === null
      )
    );
    const lines = resolved.candidates.map(formatScanCandidateLine);
    assert.deepEqual(lines, [
      'T00 | EU | LONG | score 50/100 | veto: nessuno | gate: n.d. | motivo: n.d.',
      'T01 | US | LONG | score 51/100 | veto: nessuno | gate: n.d. | motivo: n.d.',
    ]);
    resetLastScanCandidates();
  });

  it('4.3 — candidato TRADE con gate null in diagnostica: gate nessuno, non n.d.', () => {
    resetLastScanCandidates();
    applyScanGateDiagnostics('run-T', () => [
      { ticker: 'TRADE1', gate: null, reason: null, decision: 'TRADE' },
      { ticker: 'BLOCK1', gate: 'G4', reason: 'Prezzo esteso', decision: 'BLOCKED' },
    ]);
    const resolved = resolveScanCandidateInput(
      [
        { ticker: 'TRADE1', market: 'EU', direction: 'LONG', score: 80, veto: null },
        { ticker: 'BLOCK1', market: 'US', direction: 'SHORT', score: 20, veto: null },
      ],
      'run-T'
    );
    const lines = resolved.candidates.map(formatScanCandidateLine);
    assert.equal(
      lines[0],
      'TRADE1 | EU | LONG | score 80/100 | veto: nessuno | gate: nessuno | motivo: nessuno'
    );
    assert.equal(
      lines[1],
      'BLOCK1 | US | SHORT | score 20/100 | veto: nessuno | gate: G4 | motivo: Prezzo esteso'
    );
    resetLastScanCandidates();
  });

  it('3.1 — invariante della diagnostica: 11 chiavi, allCandidateDiags 40 non enumerabile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-gate-invariante-'));
    try {
      const quotes: RawQuoteData[] = Array.from({ length: 40 }, (_, i) =>
        makeWarmupQuote(`T${String(i).padStart(2, '0')}`)
      );
      const diagnostics = await observeShadowV1LiveScan(quotes, null, {
        rootDir: dir,
        nowMs: D0,
        env: { SHADOW_V1_LIVE_COLLECT: '1' },
        observe: async () => null,
      });
      assert.ok(diagnostics);
      assert.equal(Object.keys(diagnostics).length, 11);
      assert.equal(JSON.stringify(diagnostics).includes('allCandidateDiags'), false);
      assert.equal(diagnostics.allCandidateDiags?.length, 40);
      assert.equal(
        Object.getOwnPropertyDescriptor(diagnostics, 'allCandidateDiags')?.enumerable,
        false
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2 — formato di riga: a capo sanificati, valori assenti n.d.', () => {
    const line = formatScanCandidateLine({
      ticker: 'AAA',
      market: 'EU',
      direction: null,
      scoreTotal: null,
      veto: null,
      gate: 'G4',
      gateReason: 'Prezzo esteso\ndeviazione',
    });
    assert.equal(
      line,
      'AAA | EU | n.d. | score n.d. | veto: nessuno | gate: G4 | motivo: Prezzo esteso deviazione'
    );
    const empty = formatScanCandidateLine({
      ticker: 'BBB',
      market: 'US',
      direction: 'SHORT',
      scoreTotal: 61,
      veto: null,
    });
    assert.equal(
      empty,
      'BBB | US | SHORT | score 61/100 | veto: nessuno | gate: n.d. | motivo: n.d.'
    );
  });
});
