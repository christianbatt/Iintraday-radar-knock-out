import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AI_EVIDENCE_MAX_CALIBRATION_POLICIES,
  AI_EVIDENCE_MAX_SCAN_CANDIDATES,
  AI_EVIDENCE_MIN_SAMPLE,
  AI_EVIDENCE_PACK_VERSION,
  buildAiEvidencePack,
  indexAiEvidence,
  serializeAiEvidencePack,
  summarizeJournalEvidence,
  type AiEvidencePackInput,
  type AiEvidenceVetoOutcomeRow,
} from '../../knowledge/aiEvidencePack';
import { summarizeVetoOutcomes } from '../../server/vetoOutcomeLog';
import type { ExcludedSetupRecord, TradeJournalEntry } from '../../types/radar';

const T0 = Date.UTC(2026, 10, 25, 12, 0, 0);

function trade(partial: Partial<TradeJournalEntry>): TradeJournalEntry {
  return {
    id: 't1',
    timestamp: '2026-11-25T09:00:00.000Z',
    date: '2026-11-25',
    session: 'EU',
    market: 'EU',
    ticker: 'ENI.MI',
    direction: 'LONG',
    strategy: 'ORB',
    entryPrice: 100,
    exitPrice: 101,
    stopLoss: 99,
    target1: 102,
    pnlEur: 100,
    rMultiple: 1,
    outcome: 'WIN',
    notes: '',
    isPaper: false,
    ...partial,
  } as TradeJournalEntry;
}

function excluded(partial: Partial<ExcludedSetupRecord>): ExcludedSetupRecord {
  return {
    id: 'e1',
    ticker: 'ENI.MI',
    name: 'ENI',
    market: 'EU',
    currency: 'EUR',
    sessionDate: '2026-11-25',
    timestamp: '2026-11-25T09:00:00.000Z',
    score: 50,
    gapPercent: 1,
    rvol: 1.2,
    rsi: 55,
    atr: 1,
    primaryReasonCategory: 'G11' as ExcludedSetupRecord['primaryReasonCategory'],
    primaryReasonLabel: 'score',
    detail: '',
    direction: 'LONG',
    initialPrice: 100,
    entryTrigger: 100,
    stopLoss: 99,
    target1: 102,
    riskDist: 1,
    outcomeStatus: 'PENDING' as ExcludedSetupRecord['outcomeStatus'],
    ...partial,
  } as ExcludedSetupRecord;
}

function baseInput(): AiEvidencePackInput {
  return {
    generatedAtMs: T0,
    scan: {
      runId: 'run-1',
      tradeCount: 7,
      candidates: [
        {
          ticker: 'ENI.MI',
          market: 'EU',
          direction: 'LONG',
          score: 62,
          veto: null,
          gate: null,
          gateReason: null,
          decision: 'TRADE',
        },
        {
          ticker: 'UCG.MI',
          market: 'EU',
          direction: 'SHORT',
          score: 41,
          veto: 'ADX_BELOW_MARKET_THRESHOLD',
          gate: 'G11',
          gateReason: 'score 41 < 48',
        },
      ],
    },
    vetoOutcomes: [
      {
        veto: 'SUPERTREND_OPPOSED',
        market: 'EU',
        n: 42,
        triggerFillPct: 55.5,
        target: 9,
        stop: 12,
        expired: 3,
        open: 2,
        noLevels: 1,
        meanRTrigger: 0.21,
        meanRMarket: 0.05,
        ciRMarket: [-0.31, 0.42],
        meanMark15: 0.02,
        meanMark30: 0.07,
        meanMark60: 0.11,
        meanMfeR: 0.8,
        meanMaeR: -0.6,
      },
      {
        veto: 'ADX_BELOW_MARKET_THRESHOLD',
        market: 'US',
        n: 12,
        triggerFillPct: null,
        target: 1,
        stop: 2,
        expired: 0,
        open: 5,
        noLevels: 0,
        meanRTrigger: null,
        meanRMarket: null,
        ciRMarket: null,
        meanMark15: null,
        meanMark30: null,
        meanMark60: null,
        meanMfeR: null,
        meanMaeR: null,
      },
    ],
    nearMiss: {
      totalRecords: 35,
      byGate: [{ gate: 'G11_SCORE', total: 35, resolved: 31, winRatePct: 51.61, meanR: 0.09 }],
    },
    shadowV1Live: {
      counts: { persisted: 60, pendingFill: 5, open: 7, stop: 20, target: 18, expired: 4, notFilled: 6, stale: 2 },
      metrics: { resolved: 42, meanR: 0.18, winRatePct: 52.38, maxDrawdownR: -3.2, nLate: 1 },
    },
    shadowV2: {
      nSignals: 80,
      nResolved: 70,
      wins: 38,
      losses: 32,
      winRatePct: 54.29,
      meanRNet: 0.11,
      profitFactor: 1.24,
      maxDrawdownR: -5.5,
      dsr: 0.31,
      clusterBootstrapPValue: 0.42,
      nDayClusters: 35,
      limitations: ['Costi stimati, non eseguiti', 'Nessun confronto con V1-live'],
    },
    journal: {
      trades: [
        trade({ id: 'a', outcome: 'WIN', rMultiple: 2 }),
        trade({ id: 'b', outcome: 'LOSS', rMultiple: -1 }),
        trade({ id: 'c', outcome: 'WIN', rMultiple: 1, isPaper: true }),
        trade({ id: 'd', outcome: 'BREAKEVEN', rMultiple: 0, isPaper: true }),
        trade({ id: 'e', outcome: 'EXPIRED', rMultiple: 0 }),
        trade({ id: 'f', outcome: 'WIN', rMultiple: 5, status: 'OPEN' }),
        trade({ id: 'g', outcome: 'LOSS', rMultiple: Number.NaN }),
      ],
      excluded: [
        excluded({ id: 'x', outcomeStatus: 'THEORETICAL_PROFIT' as ExcludedSetupRecord['outcomeStatus'] }),
        excluded({ id: 'y', outcomeStatus: 'THEORETICAL_STOP' as ExcludedSetupRecord['outcomeStatus'] }),
        excluded({ id: 'z' }),
      ],
    },
  };
}

describe('aiEvidencePack — determinismo e input sporchi', () => {
  it('a parità di input produce lo stesso pack byte per byte', () => {
    const a = buildAiEvidencePack(baseInput());
    const b = buildAiEvidencePack(baseInput());
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it('generatedAt dipende solo da generatedAtMs', () => {
    const pack = buildAiEvidencePack({ generatedAtMs: T0 });
    assert.equal(pack.generatedAt, new Date(T0).toISOString());
    assert.equal(pack.schemaVersion, AI_EVIDENCE_PACK_VERSION);
  });

  it('generatedAtMs non finito non lancia e ricade su epoch', () => {
    const pack = buildAiEvidencePack({ generatedAtMs: Number.NaN });
    assert.equal(pack.generatedAt, new Date(0).toISOString());
  });

  it('input vuoto: nessuna sezione, nessuna eccezione, limiti dichiarati', () => {
    const pack = buildAiEvidencePack({ generatedAtMs: T0 });
    assert.equal(pack.sections.scan, null);
    assert.deepEqual([...pack.missing].sort(), [
      'calibration',
      'journal',
      'nearMiss',
      'scan',
      'shadowV1Live',
      'shadowV2',
      'vetoOutcomes',
    ]);
    assert.equal(pack.evidence.length, 0);
    assert.ok(pack.notes.some((note) => note.includes('Sezioni non disponibili')));
  });

  it('input con tipi sbagliati non lancia', () => {
    const junk = {
      generatedAtMs: T0,
      scan: { candidates: 'nope', runId: 42 },
      vetoOutcomes: [null, 7, 'x'],
      nearMiss: { byGate: {} },
      shadowV1Live: 'x',
      shadowV2: 42,
      journal: { trades: 'x', excluded: 3 },
    } as unknown as AiEvidencePackInput;
    const pack = buildAiEvidencePack(junk);
    assert.equal(pack.evidence.length, 0);
  });
});

describe('aiEvidencePack — scansione', () => {
  it('conta i candidati validi e scarta quelli senza ticker', () => {
    const pack = buildAiEvidencePack({
      generatedAtMs: T0,
      scan: { candidates: [{ ticker: 'ENI.MI' }, { ticker: '   ' }, { market: 'EU' }] },
    });
    assert.equal(pack.sections.scan?.candidateCount, 1);
    assert.equal(pack.sections.scan?.droppedCandidates, 2);
    assert.ok(pack.notes.some((note) => note.startsWith('scan: 2 candidati esclusi')));
  });

  it('rispetta il tetto difensivo dei candidati', () => {
    const candidates = Array.from({ length: AI_EVIDENCE_MAX_SCAN_CANDIDATES + 5 }, (_, index) => ({
      ticker: `T${index}`,
      market: 'EU',
    }));
    const pack = buildAiEvidencePack({ generatedAtMs: T0, scan: { candidates } });
    assert.equal(pack.sections.scan?.candidateCount, AI_EVIDENCE_MAX_SCAN_CANDIDATES);
    assert.equal(pack.sections.scan?.droppedCandidates, 5);
  });

  it('espone i conteggi per veto e per gate come chiavi citabili', () => {
    const index = indexAiEvidence(buildAiEvidencePack(baseInput()));
    assert.equal(index.get('scan.vetoCount.ADX_BELOW_MARKET_THRESHOLD')?.value, 1);
    assert.equal(index.get('scan.gateCount.G11')?.value, 1);
    assert.equal(index.get('scan.candidateCount')?.value, 2);
    assert.equal(index.get('scan.tradeCount')?.value, 7);
  });
});

describe('aiEvidencePack — veto outcome e soglia di campione', () => {
  it('marca insufficiente sotto 30 e sufficiente da 30 in su', () => {
    const pack = buildAiEvidencePack(baseInput());
    const index = indexAiEvidence(pack);
    assert.equal(index.get('veto.EU.SUPERTREND_OPPOSED.n')?.insufficient, false);
    assert.equal(index.get('veto.US.ADX_BELOW_MARKET_THRESHOLD.n')?.insufficient, true);
    assert.ok(pack.insufficient.includes('veto.US.ADX_BELOW_MARKET_THRESHOLD.meanRMarket'));
  });

  it('ordina le righe per mercato e veto', () => {
    const pack = buildAiEvidencePack(baseInput());
    const keys = pack.sections.vetoOutcomes?.rows.map((row) => `${row.market}.${row.veto}`) ?? [];
    assert.deepEqual(keys, ['EU.SUPERTREND_OPPOSED', 'US.ADX_BELOW_MARKET_THRESHOLD']);
  });

  it('espone gli estremi dell intervallo di confidenza', () => {
    const index = indexAiEvidence(buildAiEvidencePack(baseInput()));
    assert.equal(index.get('veto.EU.SUPERTREND_OPPOSED.ciRLow')?.value, -0.31);
    assert.equal(index.get('veto.EU.SUPERTREND_OPPOSED.ciRHigh')?.value, 0.42);
  });

  it('resta compatibile con la riga reale di summarizeVetoOutcomes', () => {
    type RealVetoRow = ReturnType<typeof summarizeVetoOutcomes>[number];
    const realRows: RealVetoRow[] = [];
    const structural: readonly AiEvidenceVetoOutcomeRow[] = realRows;
    assert.equal(structural.length, 0);
  });
});

describe('aiEvidencePack — near miss, Shadow V1-live, Shadow V2', () => {
  it('normalizza i bucket near miss e ne espone le chiavi', () => {
    const index = indexAiEvidence(buildAiEvidencePack(baseInput()));
    assert.equal(index.get('nearMiss.G11_SCORE.total')?.value, 35);
    assert.equal(index.get('nearMiss.G11_SCORE.meanR')?.insufficient, false);
  });

  it('legge counts e metrics annidati della vista V1-live', () => {
    const index = indexAiEvidence(buildAiEvidencePack(baseInput()));
    assert.equal(index.get('shadowV1Live.persisted')?.value, 60);
    assert.equal(index.get('shadowV1Live.meanR')?.value, 0.18);
    assert.equal(index.get('shadowV1Live.resolved')?.n, 42);
  });

  it('una vista V1-live tutta a zero non produce una sezione vuota', () => {
    const pack = buildAiEvidencePack({
      generatedAtMs: T0,
      shadowV1Live: { counts: {}, metrics: {} },
    });
    assert.equal(pack.sections.shadowV1Live, null);
  });

  it('normalizza Shadow V2 mantenendo i limiti dichiarati', () => {
    const pack = buildAiEvidencePack(baseInput());
    assert.equal(pack.sections.shadowV2?.limitations.length, 2);
    assert.equal(pack.sections.shadowV2?.nResolved, 70);
    assert.ok(pack.notes.some((note) => note.includes('non sono confrontabili')));
  });
});

describe('aiEvidencePack — calibrazione del desk', () => {
  const calibration = {
    version: 'ai-calibration@1',
    available: true,
    verdict: 'evidence',
    counts: { matched: 44, classified: 40 },
    edgeRNet: 0.21,
    costR: 0.36,
    uncertainty: { edgeR: { lower: 0.02, upper: 0.4 } },
    coverage: { candidates: 160, evaluated: 80, evaluatedSharePct: 50 },
    validation: { verdict: 'CONFERMATO' },
    alerts: [{ code: 'COVERAGE_LOW' }],
    policies: [
      { code: 'SOLO_AZIONE', trades: 22, meanRNet: 0.31, winRateNetPct: 54.55 },
      { code: 'AZIONE_E_ATTESA', trades: 30, meanRNet: 0.12, winRateNetPct: 50 },
      { code: 'TUTTI_I_CLASSIFICATI', trades: 40, meanRNet: -0.02, winRateNetPct: 45 },
      { code: 'QUARTA_IGNORATA', trades: 1, meanRNet: 9, winRateNetPct: 100 },
    ],
    strata: [
      { dimension: 'market', value: 'EU', matched: 20, edgeRNet: 0.3, contradicts: false },
      { dimension: 'market', value: 'US', matched: 20, edgeRNet: -0.12, contradicts: true },
      { dimension: 'direction', value: '', matched: 2, edgeRNet: 1, contradicts: false },
    ],
    limitations: ['Sola lettura', 'Join temporale'],
  };

  it('porta nel fascicolo il track record gia calcolato, senza ricalcolarlo', () => {
    const pack = buildAiEvidencePack({ generatedAtMs: T0, calibration });
    const index = indexAiEvidence(pack);
    assert.ok(pack.sections.calibration);
    assert.equal(pack.sections.calibration?.classified, 40);
    assert.equal(pack.sections.calibration?.matched, 44);
    assert.equal(index.get('calibration.edgeRNet')?.value, 0.21);
    assert.equal(index.get('calibration.edgeRNet')?.n, 40);
    assert.equal(index.get('calibration.validationVerdict')?.value, 'CONFERMATO');
    assert.equal(index.get('calibration.edgeRCI.low')?.value, 0.02);
    assert.equal(index.get('calibration.coverage.evaluatedPct')?.value, 50);
  });

  it('limita policy e strati e dichiara le contraddizioni', () => {
    const pack = buildAiEvidencePack({ generatedAtMs: T0, calibration });
    assert.equal(pack.sections.calibration?.policies.length, AI_EVIDENCE_MAX_CALIBRATION_POLICIES);
    assert.equal(pack.sections.calibration?.strata.length, 2, 'strato senza valore escluso');
    assert.ok(pack.sections.calibration?.strata.some((stratum) => stratum.contradicts));
    assert.ok(pack.notes.some((note) => note.includes('contraddice')));
  });

  it('sotto soglia la chiave e insufficiente e la nota lo dice', () => {
    const pack = buildAiEvidencePack({
      generatedAtMs: T0,
      calibration: {
        ...calibration,
        verdict: 'insufficient',
        counts: { matched: 4, classified: 4 },
        validation: { verdict: 'INSUFFICIENTE' },
      },
    });
    const index = indexAiEvidence(pack);
    assert.equal(index.get('calibration.edgeRNet')?.insufficient, true);
    assert.ok(pack.notes.some((note) => note.includes('Calibrazione del desk insufficiente')));
  });

  it('calibrazione non disponibile resta dichiarata e non blocca il pack', () => {
    const pack = buildAiEvidencePack({
      generatedAtMs: T0,
      calibration: { available: false, reason: 'nessuna valutazione AI nel log' },
    });
    const index = indexAiEvidence(pack);
    assert.equal(index.get('calibration.available')?.value, false);
    assert.ok(pack.notes.some((note) => note.includes('non disponibile')));
  });

  it('va nel testo del prompt prima del diario', () => {
    const out = serializeAiEvidencePack(buildAiEvidencePack({ generatedAtMs: T0, calibration }));
    const calibrationAt = out.text.indexOf('SECTION calibration ');
    assert.ok(calibrationAt > -1);
    assert.ok(out.text.includes('calibration.policy.SOLO_AZIONE.meanRNet'));
  });
});

describe('aiEvidencePack — diario', () => {
  it('win rate sui soli decisivi ed esclude OPEN e R non finiti', () => {
    const section = summarizeJournalEvidence(baseInput().journal?.trades, []);
    assert.ok(section);
    assert.equal(section.n, 5);
    assert.equal(section.wins, 2);
    assert.equal(section.losses, 1);
    assert.equal(section.breakevens, 1);
    assert.equal(section.expired, 1);
    assert.equal(section.winRatePct, 66.67);
    assert.equal(section.sumR, 2);
    assert.equal(section.avgR, 0.4);
  });

  it('profit factor corretto e mai Infinity senza perdite', () => {
    const withLoss = summarizeJournalEvidence(baseInput().journal?.trades, []);
    assert.equal(withLoss?.profitFactor, 3);
    const noLoss = summarizeJournalEvidence([trade({ outcome: 'WIN', rMultiple: 2 })], []);
    assert.equal(noLoss?.profitFactor, null);
  });

  it('separa paper, reale e controfattuali', () => {
    const section = summarizeJournalEvidence(
      baseInput().journal?.trades,
      baseInput().journal?.excluded
    );
    assert.ok(section);
    assert.equal(section.nPaper, 2);
    assert.equal(section.nReal, 3);
    assert.deepEqual(section.excluded, { n: 3, profit: 1, stop: 1, other: 1 });
  });

  it('senza diario e senza esclusi la sezione e assente', () => {
    assert.equal(summarizeJournalEvidence([], []), null);
    assert.equal(summarizeJournalEvidence(null, null), null);
  });

  it('espone n e marcatura di campione sulle chiavi del diario', () => {
    const index = indexAiEvidence(buildAiEvidencePack(baseInput()));
    assert.equal(index.get('journal.n')?.n, 5);
    assert.equal(index.get('journal.n')?.insufficient, true);
    assert.equal(index.get('journal.excluded.n')?.value, 3);
  });
});

describe('aiEvidencePack — serializzazione per il prompt', () => {
  it('e deterministica e contiene schema e sezioni', () => {
    const pack = buildAiEvidencePack(baseInput());
    const a = serializeAiEvidencePack(pack);
    const b = serializeAiEvidencePack(pack);
    assert.equal(a.text, b.text);
    assert.ok(a.text.includes(`schema=${AI_EVIDENCE_PACK_VERSION}`));
    assert.ok(a.text.includes('SECTION journal '));
    assert.ok(a.text.includes('SECTION vetoOutcomes '));
    assert.ok(a.chars <= a.maxChars);
    assert.deepEqual([...a.truncatedSections], []);
  });

  it('con budget ridotto dichiara le sezioni omesse invece di troncarle', () => {
    const pack = buildAiEvidencePack(baseInput());
    const out = serializeAiEvidencePack(pack, { maxChars: 400 });
    assert.ok(out.truncatedSections.length > 0);
    assert.ok(out.chars <= 400);
    for (const section of out.truncatedSections) {
      assert.equal(out.text.includes(`SECTION ${section} `), false);
    }
  });

  it('elenca le chiavi insufficienti nel testo', () => {
    const out = serializeAiEvidencePack(buildAiEvidencePack(baseInput()));
    assert.ok(out.text.includes('INSUFFICIENT '));
    assert.ok(out.text.includes('journal.n'));
  });

  it('limita il testo al budget anche con le sole note', () => {
    const pack = buildAiEvidencePack({ generatedAtMs: T0 });
    const out = serializeAiEvidencePack(pack, { maxChars: 120 });
    assert.ok(out.chars <= 120);
  });
});

describe('aiEvidencePack — igiene del modulo', () => {
  it('non usa I/O, rete o variabili di ambiente', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../../knowledge/aiEvidencePack.ts', import.meta.url)),
      'utf8'
    );
    assert.equal(source.includes("from 'node:fs'"), false);
    assert.equal(source.includes('process.env'), false);
    assert.equal(source.includes('fetch('), false);
    assert.equal(source.includes('Date.now()'), false);
  });

  it('la soglia esposta e quella del validatore deterministico', () => {
    assert.equal(AI_EVIDENCE_MIN_SAMPLE, 30);
  });
});
