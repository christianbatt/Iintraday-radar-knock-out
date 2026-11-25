/**
 * ADDITIVO (gate nel log AI): test dell'aggancio gate G1-G13 / motivo.
 *
 * Verifica che i gate gia' calcolati dalla diagnostica Shadow V1 arrivino nelle
 * righe `CANDIDATI_SCANSIONE` e che le voci del log AI siano scritte anche
 * quando quella diagnostica manca o la lettura lancia. Nessun test esistente
 * viene modificato: questo file aggiunge solo casi nuovi.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyScanGateDiagnostics,
  buildScanEvaluationPrompt,
  evaluateScanCandidates,
  formatScanCandidateLine,
  getLastScanCandidates,
  resetLastScanCandidates,
  resolveScanCandidateInput,
  setLastScanCandidates,
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
    applyScanGateDiagnostics(() => gateRows(40));

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
    applyScanGateDiagnostics(() => gateRows(35));

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
    assert.doesNotThrow(() =>
      applyScanGateDiagnostics(() => {
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
