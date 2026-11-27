/**
 * Regression tests for the deep AI audit fixes:
 * - aiCalibration empirical catalystLift breakdown
 * - aiScanEvaluation timestamp anchoring & scan source
 * - aiDesk read-only shadowV1Live evidence collection
 * - aiEvidencePack section prioritization (shadowV1Live/shadowV2 before scan)
 * - aiShadowLog 'catalyst' source preservation & evaluated 'scan' visibility
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAiCalibration } from '../../server/aiCalibration';
import {
  combineScanEvaluations,
  getLastScanTimestampMs,
  resetLastScanCandidates,
  setLastScanCandidates,
} from '../../server/aiScanEvaluation';
import {
  appendAiShadowLog,
  buildAiShadowLogResponse,
  isUnprocessedScanEntry,
} from '../../server/aiShadowLog';
import { collectDeskEvidenceInput } from '../../server/aiDesk';
import { buildAiEvidencePack, serializeAiEvidencePack } from '../../knowledge/aiEvidencePack';
import { SHADOW_V1_LIVE_SIGNALS_PATH } from '../../server/shadowV1LiveStore';

const T0 = Date.parse('2026-11-26T09:30:00.000Z');

describe('AI Audit Fixes Regression Suite', () => {
  it('F1: aiCalibration computes empirical catalystLift on matched source=catalyst rows', () => {
    const entries = [
      {
        id: 'c1',
        timestamp: new Date(T0).toISOString(),
        ticker: 'UCG.MI',
        market: 'EU',
        direction: 'LONG',
        source: 'catalyst',
        aiOutcome: 'Upgrade analisti',
        aiCategory: 'newsBonus=15;dirMatch=aligned;regime=aligned',
        candidateKey: 'run1:UCG.MI',
        decision: 'AZIONE',
        evaluated: true,
        discarded: false,
      },
      {
        id: 'c2',
        timestamp: new Date(T0 + 60_000).toISOString(),
        ticker: 'ENI.MI',
        market: 'EU',
        direction: 'LONG',
        source: 'catalyst',
        aiOutcome: 'News neutra',
        aiCategory: 'newsBonus=0;dirMatch=opposed;regime=opposed',
        candidateKey: 'run1:ENI.MI',
        decision: 'SCARTO',
        evaluated: true,
        discarded: false,
      },
    ];
    const forward = [
      { key: 's1', ticker: 'UCG.MI', decidedAtMs: T0 + 10_000, r: 1.6, status: 'TARGET' as const },
      { key: 's2', ticker: 'ENI.MI', decidedAtMs: T0 + 70_000, r: -1.0, status: 'STOP' as const },
    ];
    const cal = buildAiCalibration({
      entries,
      forward,
      nowMs: T0 + 3600_000,
      generatedAt: new Date(T0 + 3600_000).toISOString(),
      minSample: 30,
    });
    assert.strictEqual(cal.catalystLift.matchedCatalysts, 2);
    assert.strictEqual(cal.catalystLift.withBonus.n, 1);
    assert.strictEqual(cal.catalystLift.withoutBonus.n, 1);
    assert.strictEqual(cal.catalystLift.bonusLiftR, 2.6);
    assert.strictEqual(cal.catalystLift.aligned.n, 1);
    assert.strictEqual(cal.catalystLift.opposed.n, 1);
    assert.strictEqual(cal.catalystLift.alignmentLiftR, 2.6);
    assert.strictEqual(cal.catalystLift.verdict, 'insufficient');
  });

  it('F2: aiScanEvaluation anchors timestamps to evaluatedAtMs and supports source=scan', () => {
    resetLastScanCandidates();
    setLastScanCandidates(
      [{ ticker: 'NVDA', market: 'US', direction: 'LONG', scoreTotal: 72, veto: null, runId: 'r-1' }],
      T0
    );
    assert.strictEqual(getLastScanTimestampMs(), T0);

    const entries = combineScanEvaluations(
      [{ ticker: 'NVDA', market: 'US', direction: 'LONG', scoreTotal: 72, veto: null, runId: 'r-1' }],
      [
        {
          batchIndex: 0,
          candidateTickers: ['NVDA'],
          status: 'ok',
          evaluations: [{ ticker: 'NVDA', aiOutcome: 'Setup coerente', aiCategory: 'MOMENTUM', decision: 'AZIONE' }],
          ignoredUnknownTickers: 0,
          ignoredDuplicateTickers: 0,
          durationMs: 120,
          model: 'gemini:gemini-4-hydrogen',
        },
      ],
      'scan',
      { runId: 'r-1', candidateSource: 'snapshot', evaluatedAtMs: T0 }
    );
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].source, 'scan');
    assert.strictEqual(entries[0].timestamp, new Date(T0).toISOString());
    assert.strictEqual(isUnprocessedScanEntry(entries[0]), false);
    resetLastScanCandidates();
  });

  it('F3: aiShadowLog preserves source=catalyst and shows evaluated scan rows in response', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-cat-'));
    const logPath = path.join(dir, 'shadow_ai_log.jsonl');
    appendAiShadowLog(
      [
        {
          ticker: 'AAPL',
          market: 'US',
          direction: 'LONG',
          setup: 'catalyst',
          aiOutcome: 'Strong guidance',
          aiCategory: 'newsBonus=12;dirMatch=aligned;regime=aligned',
          source: 'catalyst',
          evaluated: true,
          discarded: false,
          discardReason: null,
          decision: 'AZIONE',
          candidateKey: 'r1:AAPL',
        },
        {
          ticker: 'MSFT',
          market: 'US',
          direction: 'LONG',
          setup: 'scan score 75/100',
          aiOutcome: 'Coerente',
          aiCategory: 'TREND',
          source: 'scan',
          evaluated: true,
          discarded: false,
          discardReason: null,
          decision: 'AZIONE',
          candidateKey: 'r1:MSFT',
        },
      ],
      logPath
    );
    const resp = buildAiShadowLogResponse(50, logPath);
    assert.strictEqual(resp.entries.length, 2);
    assert.strictEqual(resp.entries[0].source, 'catalyst');
    assert.strictEqual(resp.entries[1].source, 'scan');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('F4: aiDesk collects shadowV1Live read-only from signals.jsonl and evidencePack prioritizes it before scan', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-desk-v1-'));
    const signalsPath = path.join(dir, SHADOW_V1_LIVE_SIGNALS_PATH);
    fs.mkdirSync(path.dirname(signalsPath), { recursive: true });
    const record = {
      v: 1,
      key: 'US|NVDA|2026-11-26|LONG|E100.00|S98.00',
      ticker: 'NVDA',
      market: 'US',
      direction: 'LONG',
      entry: 100,
      stop: 98,
      target: 103.2,
      decidedAtMs: T0,
      sessionCloseMs: T0 + 6 * 3600_000,
      firstSeenAtMs: T0 + 1000,
      status: 'TARGET',
      r: 1.6,
      reason: null,
      fillBarTs: T0 + 60_000,
      exitBarTs: T0 + 600_000,
      exitPrice: 103.2,
      updatedAtMs: T0 + 600_000,
      moduleVersion: 'shadowV1Live@3',
      score: 78,
    };
    fs.writeFileSync(signalsPath, JSON.stringify(record) + '\n', 'utf8');

    const input = collectDeskEvidenceInput({ nowMs: T0 + 3600_000, rootDir: dir });
    assert.ok(input.shadowV1Live != null, 'shadowV1Live deve essere caricata da signals.jsonl');

    const pack = buildAiEvidencePack({
      ...input,
      scan: {
        runId: 'r1',
        tradeCount: 1,
        candidates: Array.from({ length: 40 }, (_, i) => ({
          ticker: `T${i}`,
          market: 'US',
          direction: 'LONG',
          score: 60,
          veto: null,
          gate: 'G6',
          gateReason: 'motivo lungo di test per riempire il budget caratteri',
          decision: null,
        })),
      },
    });
    const prompt = serializeAiEvidencePack(pack, { maxChars: 1500 });
    assert.ok(prompt.text.includes('SECTION shadowV1Live'), 'shadowV1Live precede scan nel budget');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
