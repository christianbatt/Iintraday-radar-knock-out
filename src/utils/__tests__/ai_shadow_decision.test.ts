import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_SHADOW_DECISIONS,
  appendAiShadowLog,
  buildScanCandidateEntries,
  isAiShadowDecision,
  readAiShadowLog,
} from '../../server/aiShadowLog';
import {
  buildScanEvaluationPrompt,
  combineScanEvaluations,
  parseScanEvaluations,
} from '../../server/aiScanEvaluation';
import { classifyEntryDecision, type AiCalibrationEntry } from '../../server/aiCalibration';
import type { AiShadowLogEntry } from '../../server/aiShadowLog';

const TMP_LOG = path.join(process.cwd(), 'artifacts', '_tmp_shadow_decision.jsonl');

function rawEntry(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    timestamp: '2026-11-25T09:00:00.000Z',
    ticker: 'ENI.MI',
    market: 'EU',
    direction: 'LONG',
    setup: null,
    aiOutcome: 'BUY',
    aiCategory: null,
    source: 'scan',
    evaluated: true,
    discarded: false,
    discardReason: null,
    status: 'NON_VALIDATO',
    outcome: null,
    candidateKey: 'run1:ENI.MI',
    runId: 'run1',
    durationMs: null,
    ...partial,
  };
}

function calibrationEntry(partial: Partial<AiCalibrationEntry> & { id: string }): AiCalibrationEntry {
  return {
    timestamp: '2026-11-25T09:00:00.000Z',
    ticker: 'ENI.MI',
    market: 'EU',
    direction: 'LONG',
    source: 'scan',
    aiOutcome: 'BUY',
    candidateKey: 'run1:ENI.MI',
    ...partial,
  };
}

describe('aiShadowLog — campo decision chiuso', () => {
  it('accetta solo i tre valori ammessi', () => {
    assert.deepEqual([...AI_SHADOW_DECISIONS], ['AZIONE', 'ATTESA', 'SCARTO']);
    assert.equal(isAiShadowDecision('AZIONE'), true);
    assert.equal(isAiShadowDecision('ATTESA'), true);
    assert.equal(isAiShadowDecision('SCARTO'), true);
    assert.equal(isAiShadowDecision('BUY'), false);
    assert.equal(isAiShadowDecision('azione'), false);
    assert.equal(isAiShadowDecision(null), false);
    assert.equal(isAiShadowDecision(1), false);
  });

  it('scrive e rilegge decision valida; un valore fuori enum diventa null', () => {
    fs.rmSync(TMP_LOG, { force: true });
    const result = appendAiShadowLog(
      [rawEntry({ id: 'ok', decision: 'AZIONE' }), rawEntry({ id: 'bad', decision: 'BUY' })],
      TMP_LOG
    );
    assert.equal(result.ok, true);
    assert.equal(result.written, 2);
    const read = readAiShadowLog(undefined, TMP_LOG);
    assert.equal(read.length, 2);
    assert.equal(read[0].decision, 'AZIONE');
    assert.equal(read[1].decision, null);
    fs.rmSync(TMP_LOG, { force: true });
  });

  it('le righe di scansione placeholder non hanno decision', () => {
    const entries = buildScanCandidateEntries([{ ticker: 'ENI.MI', market: 'EU', direction: 'LONG' }], 'run1');
    assert.equal(entries[0].decision, null);
  });
});

describe('aiScanEvaluation — decision nel prompt, nel parser e nelle voci', () => {
  it('il prompt chiede decision con i tre valori', () => {
    const prompt = buildScanEvaluationPrompt([
      { ticker: 'ENI.MI', market: 'EU', direction: 'LONG', scoreTotal: 70, veto: null },
    ]);
    assert.match(prompt, /"decision":"AZIONE\|ATTESA\|SCARTO"/);
    assert.match(prompt, /AZIONE = il candidato ha un edge/);
  });

  it('il parser tiene solo i valori ammessi', () => {
    const raw = JSON.stringify({
      scanEvaluations: [
        { ticker: 'A', aiOutcome: 'edge chiaro', aiCategory: 'x', decision: 'AZIONE' },
        { ticker: 'B', aiOutcome: 'edge debole', aiCategory: null, decision: 'BUY' },
        { ticker: 'C', aiOutcome: 'in attesa', aiCategory: null },
      ],
    });
    const parsed = parseScanEvaluations(raw);
    assert.equal(parsed.ok, true);
    assert.deepEqual(
      parsed.evaluations.map((e) => e.decision),
      ['AZIONE', null, null]
    );
  });

  it('la voce valutata porta decision, quella non restituita resta null', () => {
    const candidates = [
      { ticker: 'A', market: 'EU', direction: 'LONG', scoreTotal: 70, veto: null },
      { ticker: 'B', market: 'EU', direction: 'SHORT', scoreTotal: 40, veto: 'VWAP_STRETCH' },
    ];
    const entries = combineScanEvaluations(
      candidates,
      [
        {
          batchIndex: 0,
          candidateTickers: ['A', 'B'],
          status: 'ok',
          evaluations: [{ ticker: 'A', aiOutcome: 'edge', aiCategory: null, decision: 'SCARTO' }],
          ignoredUnknownTickers: 0,
          ignoredDuplicateTickers: 0,
          durationMs: 5,
        },
      ],
      'specialize'
    );
    const byTicker = new Map(entries.map((entry) => [entry.ticker, entry]));
    assert.equal(byTicker.get('A')?.decision, 'SCARTO');
    assert.equal(byTicker.get('B')?.decision, null);
    assert.equal(byTicker.get('B')?.evaluated, false);
    assert.equal(byTicker.get('A')?.candidateKey, null, 'senza runId non c\'e\' candidateKey');
  });
});

describe('aiCalibration — la decision chiusa vince sul testo', () => {
  it('usa decision dell\'handler anche se il testo dice altro', () => {
    const row = calibrationEntry({ id: 'm1', aiOutcome: 'BUY', decision: 'ATTESA' });
    assert.equal(classifyEntryDecision(row), 'ATTESA');
  });

  it('un valore fuori enum ricade sul testo solo per righe di candidato', () => {
    const historical = calibrationEntry({ id: 'm2', aiOutcome: 'SKIP' });
    assert.equal(classifyEntryDecision(historical), 'SCARTO');

    const corrupted = calibrationEntry({ id: 'm3', aiOutcome: 'SKIP', decision: 'BUY' });
    assert.equal(classifyEntryDecision(corrupted), 'SCARTO');
  });

  it('la prosa resta SCONOSCIUTO anche senza decision', () => {
    const prose = calibrationEntry({
      id: 'm4',
      source: 'desk',
      candidateKey: null,
      aiOutcome: 'BUY subito',
    });
    assert.equal(classifyEntryDecision(prose), 'SCONOSCIUTO');
  });

  it('una decision chiusa su una direttiva e\' un dato incoerente: resta SCONOSCIUTO', () => {
    const proseWithDecision = calibrationEntry({
      id: 'm5',
      source: 'desk',
      candidateKey: null,
      aiOutcome: 'BUY subito',
      decision: 'AZIONE',
    });
    assert.equal(classifyEntryDecision(proseWithDecision), 'SCONOSCIUTO');
  });
});
