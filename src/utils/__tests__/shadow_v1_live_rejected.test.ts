/**
 * Test del registro controfattuale degli scarti fuori whitelist near-miss.
 *
 * Tutto l'I/O usa `os.tmpdir()` rimosso a fine test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionSetup, ScoredCandidate } from '../../types/radar';
import { DEFAULT_SYSTEM_PARAMETERS } from '../../utils/calculator';
import {
  clearShadowV1LiveBarsForTest,
  recordBarsForShadowV1Live,
} from '../../server/shadowV1LiveCollector';
import {
  classifyRejectedCandidate,
  hasOpenRejectedRecords,
  loadRejectedRecords,
  SHADOW_V1_REJECTED_PATH,
  updateShadowV1Rejected,
} from '../../server/shadowV1LiveRejected';

const D0 = Date.UTC(2026, 2, 16, 15, 0, 0); // lunedi' 10:00 ET (sessione US aperta)
const BAR_MS = 5 * 60_000;

function cand(
  over: { veto?: string | null; warmupIncomplete?: boolean; ticker?: string; market?: 'EU' | 'US' } = {}
): ScoredCandidate {
  return {
    quote: {
      ticker: over.ticker ?? 'AAPL',
      market: over.market ?? 'US',
      setupIndicators: { adx: { value: 25 } },
    },
    score: {
      total: 55,
      warmupIncomplete: over.warmupIncomplete === true,
      veto: over.veto ?? null,
    },
  } as unknown as ScoredCandidate;
}

function setup(over: Record<string, unknown> = {}): ExecutionSetup {
  return {
    candidate: { ticker: 'AAPL' },
    decision: 'NESSUN_TRADE',
    direction: 'LONG',
    entryLevel: 100,
    triggerLevel: 100,
    stopLossLevel: 99,
    target1Level: 102,
    gateResults: {
      G1: { passed: true },
      G2: { passed: false },
      G3: { passed: false },
    },
    blockedGate: 'G2',
    reasonNoTrade: 'G2 e G3',
    ...over,
  } as unknown as ExecutionSetup;
}

test('scarto multi-gate: registrato con i gate falliti e la causa principale', () => {
  const out = classifyRejectedCandidate(cand(), setup(), DEFAULT_SYSTEM_PARAMETERS);
  assert.ok(out);
  assert.deepEqual(out.blockedGates, ['G2', 'G3']);
  assert.equal(out.blockedPrimary, 'G2');
  assert.match(out.gateDetail, /2 gate falliti/);
});

test('un candidato gia coperto dal near-miss non viene duplicato', () => {
  const nearMissSetup = setup({
    gateResults: {
      G1: { passed: true },
      G2: { passed: true },
      G3: { passed: true },
      G5: { passed: false },
    },
    blockedGate: 'G5',
  });
  assert.equal(
    classifyRejectedCandidate(cand(), nearMissSetup, DEFAULT_SYSTEM_PARAMETERS),
    null,
    'G5 singolo e whitelist near-miss: resta di competenza del near-miss'
  );
});

test('un veto blocca il candidato e viene dichiarato come causa principale', () => {
  const out = classifyRejectedCandidate(
    cand({ veto: 'SUPERTREND_OPPOSED' }),
    setup(),
    DEFAULT_SYSTEM_PARAMETERS
  );
  assert.ok(out);
  assert.equal(out.blockedPrimary, 'SUPERTREND_OPPOSED');
  assert.deepEqual(out.blockedGates[0], 'VETO:SUPERTREND_OPPOSED');
  assert.match(out.gateDetail, /Veto SUPERTREND_OPPOSED/);
});

test('nessun esito inventato: TRADE, livelli incoerenti e warmup incompleto restano fuori', () => {
  assert.equal(
    classifyRejectedCandidate(cand(), setup({ decision: 'TRADE' }), DEFAULT_SYSTEM_PARAMETERS),
    null
  );
  assert.equal(
    classifyRejectedCandidate(
      cand(),
      setup({ stopLossLevel: 101 }), // stop sopra l'entry su un LONG: setup non valutabile
      DEFAULT_SYSTEM_PARAMETERS
    ),
    null
  );
  assert.equal(
    classifyRejectedCandidate(
      cand({ warmupIncomplete: true }),
      setup(),
      DEFAULT_SYSTEM_PARAMETERS
    ),
    null
  );
});

test('registra una riga per ticker/sessione e ne segue l esito fino al target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1rej-'));
  try {
    const first = updateShadowV1Rejected({
      candidates: [{ cand: cand({ ticker: 'RJT' }), setup: setup() }],
      parameters: DEFAULT_SYSTEM_PARAMETERS,
      rootDir: dir,
      nowMs: D0,
    });
    assert.equal(first?.totalRecords, 1);

    const filePath = path.join(dir, SHADOW_V1_REJECTED_PATH);
    let records = loadRejectedRecords(filePath);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'PENDING_FILL');
    assert.equal(records[0].id, 'US|RJT|2026-03-16');
    assert.deepEqual(records[0].blockedGates, ['G2', 'G3']);
    assert.ok(hasOpenRejectedRecords(dir), 'record aperto: la rivalutazione deve girare');

    // Stessa sessione, secondo scan: nessun duplicato.
    updateShadowV1Rejected({
      candidates: [{ cand: cand({ ticker: 'RJT' }), setup: setup() }],
      parameters: DEFAULT_SYSTEM_PARAMETERS,
      rootDir: dir,
      nowMs: D0 + BAR_MS,
    });
    assert.equal(loadRejectedRecords(filePath).length, 1);

    recordBarsForShadowV1Live(
      'RJT',
      'US',
      [{ t: D0 + BAR_MS, o: 100.1, h: 102.4, l: 99.9, c: 102.2 }],
      D0 + 2 * BAR_MS,
      {}
    );

    const later = D0 + 30 * 60_000;
    const second = updateShadowV1Rejected({
      candidates: [],
      parameters: DEFAULT_SYSTEM_PARAMETERS,
      rootDir: dir,
      nowMs: later,
    });
    records = loadRejectedRecords(filePath);
    assert.equal(records[0].status, 'TARGET');
    assert.equal(records[0].r, 2);
    assert.equal(second?.resolved, 1);
    assert.equal(hasOpenRejectedRecords(dir), false);
  } finally {
    clearShadowV1LiveBarsForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
