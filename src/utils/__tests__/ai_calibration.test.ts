import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_CALIBRATION_MATCH_WINDOW_MS,
  AI_CALIBRATION_VERSION,
  buildAiCalibration,
  classifyAiOutcome,
  classifyEntryDecision,
  createAiCalibrationHandler,
  isAiCalibrationEnabled,
  type AiCalibrationEntry,
  type AiCalibrationForwardPoint,
} from '../../server/aiCalibration';

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function entry(partial: Partial<AiCalibrationEntry> & { id: string }): AiCalibrationEntry {
  return {
    timestamp: iso(0),
    ticker: 'ENI.MI',
    market: 'EU',
    direction: 'LONG',
    source: 'scan',
    aiOutcome: 'BUY',
    candidateKey: null,
    ...partial,
  };
}

function point(partial: Partial<AiCalibrationForwardPoint> & { key: string }): AiCalibrationForwardPoint {
  return {
    ticker: 'ENI.MI',
    decidedAtMs: NOW,
    r: 1,
    status: 'TARGET',
    ...partial,
  };
}

function baseInput() {
  const entries: AiCalibrationEntry[] = [
    entry({ id: 'a1', ticker: 'ENI.MI', candidateKey: 'run1:ENI.MI', aiOutcome: 'BUY' }),
    // stessa candidateKey, piu' recente: vince questa riga
    entry({ id: 'a1b', timestamp: iso(2), ticker: 'ENI.MI', candidateKey: 'run1:ENI.MI', aiOutcome: 'SKIP: rottura debole' }),
    entry({ id: 'a2', ticker: 'ISP.MI', candidateKey: 'run1:ISP.MI', aiOutcome: 'SKIP: nessun volume' }),
    entry({ id: 'a3', ticker: 'TSLA', market: 'US', candidateKey: 'run1:TSLA', aiOutcome: 'WAIT' }),
    entry({ id: 'a4', ticker: 'UCG.MI', candidateKey: 'run1:UCG.MI', aiOutcome: 'BUY' }),
  ];
  const forward: AiCalibrationForwardPoint[] = [
    point({ key: 'f1', ticker: 'ENI.MI', decidedAtMs: NOW + 60_000, r: 2, status: 'TARGET' }),
    point({ key: 'f2', ticker: 'ISP.MI', decidedAtMs: NOW + 5 * 60_000, r: 1.5, status: 'TARGET' }),
    point({ key: 'f3', ticker: 'TSLA', decidedAtMs: NOW + 2 * 60_000, r: -1, status: 'STOP' }),
    // stesso ticker ma fuori finestra: non deve essere usato come esito della decisione
    point({ key: 'f4', ticker: 'ENI.MI', decidedAtMs: NOW + 5 * 3_600_000, r: -1, status: 'STOP' }),
  ];
  return { entries, forward };
}

describe('aiCalibration — classificazione della decisione', () => {
  it('distingue azione, attesa, scarto e sconosciuto', () => {
    assert.equal(classifyAiOutcome('BUY'), 'AZIONE');
    assert.equal(classifyAiOutcome('long confermato'), 'AZIONE');
    assert.equal(classifyAiOutcome('WAIT'), 'ATTESA');
    assert.equal(classifyAiOutcome('monitorare il livello'), 'ATTESA');
    assert.equal(classifyAiOutcome('SKIP'), 'SCARTO');
    assert.equal(classifyAiOutcome('SKIP: non comprare'), 'SCARTO');
    assert.equal(classifyAiOutcome(null), 'SCONOSCIUTO');
    assert.equal(classifyAiOutcome('   '), 'SCONOSCIUTO');
  });

  it('lo scarto ha la precedenza sulla parola azione', () => {
    assert.equal(classifyAiOutcome('NO-TRADE: setup LONG troppo esteso'), 'SCARTO');
  });
});

describe('aiCalibration — join decisione -> esito forward', () => {
  it('deduplica per candidateKey e abbina solo entro la finestra', () => {
    const { entries, forward } = baseInput();
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });

    assert.equal(out.version, AI_CALIBRATION_VERSION);
    assert.equal(out.counts.aiEntries, 5);
    assert.equal(out.counts.dedupedEntries, 4);
    assert.equal(out.counts.forwardPoints, 4);
    assert.equal(out.counts.matched, 3);
    assert.equal(out.counts.unmatchedAiEntries, 1, 'UCG.MI non ha esito forward');
    assert.equal(out.counts.forwardWithoutDecision, 1, 'f4 e\' fuori finestra e resta inutilizzato');
    assert.equal(out.windowMs, AI_CALIBRATION_MATCH_WINDOW_MS);
  });

  it('vince la riga piu\' recente dello stesso candidato', () => {
    const { entries, forward } = baseInput();
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });
    const eni = out.buckets.find((b) => b.decision === 'SCARTO');
    assert.equal(eni?.n, 2, 'ENI (SKIP) + ISP (SKIP)');
    assert.equal(out.buckets.find((b) => b.decision === 'AZIONE')?.n, 0);
  });

  it('calcola bucket, edgeR e skippedWinners sui soli abbinati', () => {
    const { entries, forward } = baseInput();
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });
    const azione = out.buckets.find((b) => b.decision === 'AZIONE');
    const attesa = out.buckets.find((b) => b.decision === 'ATTESA');
    const scarto = out.buckets.find((b) => b.decision === 'SCARTO');

    assert.equal(azione?.n, 0);
    assert.equal(attesa?.n, 1);
    assert.equal(attesa?.meanR, -1);
    assert.equal(attesa?.winRatePct, 0);
    assert.equal(scarto?.n, 2);
    assert.equal(scarto?.meanR, 1.75);
    assert.equal(scarto?.winRatePct, 100);
    assert.equal(out.edgeR, null, 'senza AZIONE non c\'e\' edge da confrontare');
    assert.equal(out.skippedWinners.length, 2);
    assert.deepEqual(
      out.skippedWinners.map((row) => row.ticker),
      ['ENI.MI', 'ISP.MI']
    );
  });

  it('calcola edgeR quando esistono entrambi i campioni', () => {
    const { forward } = baseInput();
    const entries: AiCalibrationEntry[] = [
      entry({ id: 'b1', timestamp: iso(0), ticker: 'ENI.MI', candidateKey: 'r:ENI', aiOutcome: 'BUY' }),
      entry({ id: 'b2', timestamp: iso(0), ticker: 'ISP.MI', candidateKey: 'r:ISP', aiOutcome: 'SKIP' }),
    ];
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });
    assert.equal(out.edgeR, 0.5, 'meanR(AZIONE)=2 meno meanR(SCARTO)=1.5');
  });

  it('sotto la soglia il verdetto e\' insufficient', () => {
    const { entries, forward } = baseInput();
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });
    assert.equal(out.verdict, 'insufficient');
    assert.match(out.note, /3 < 30/);
  });

  it('con campione sufficiente il verdetto e\' evidence', () => {
    const { entries, forward } = baseInput();
    const out = buildAiCalibration({
      entries,
      forward,
      nowMs: NOW,
      generatedAt: iso(0),
      minSample: 2,
    });
    assert.equal(out.verdict, 'evidence');
  });

  it('la finestra e\' inclusiva sul bordo e chiusa oltre', () => {
    const forward = [point({ key: 'edge', ticker: 'ENI.MI', decidedAtMs: NOW + AI_CALIBRATION_MATCH_WINDOW_MS })];
    const inside = buildAiCalibration({
      entries: [entry({ id: 'c1', candidateKey: 'r:ENI' })],
      forward,
      nowMs: NOW,
      generatedAt: iso(0),
    });
    assert.equal(inside.counts.matched, 1);

    const beyond = buildAiCalibration({
      entries: [entry({ id: 'c2', candidateKey: 'r:ENI' })],
      forward: [
        point({ key: 'edge2', ticker: 'ENI.MI', decidedAtMs: NOW + AI_CALIBRATION_MATCH_WINDOW_MS + 1 }),
      ],
      nowMs: NOW,
      generatedAt: iso(0),
    });
    assert.equal(beyond.counts.matched, 0);
  });

  it('senza dati dichiara available:false invece di inventare metriche', () => {
    const out = buildAiCalibration({ entries: [], forward: [], nowMs: NOW, generatedAt: iso(0) });
    assert.equal(out.available, false);
    assert.equal(out.reason, 'nessuna valutazione AI nel log');
    assert.equal(out.edgeR, null);
    assert.deepEqual(
      out.buckets.map((b) => b.n),
      [0, 0, 0, 0]
    );
    assert.equal(
      out.buckets.reduce((sum, bucket) => sum + bucket.n, 0),
      out.counts.matched
    );
  });

  it('ignora esiti senza r finito', () => {
    const out = buildAiCalibration({
      entries: [entry({ id: 'd1', candidateKey: 'r:ENI' })],
      forward: [
        point({ key: 'bad', ticker: 'ENI.MI', r: Number.NaN }),
        point({ key: 'open', ticker: 'ENI.MI', r: Number.POSITIVE_INFINITY }),
      ],
      nowMs: NOW,
      generatedAt: iso(0),
    });
    assert.equal(out.counts.forwardPoints, 0);
    assert.equal(out.counts.matched, 0);
  });
});

describe('aiCalibration — abbinamento uno-a-uno', () => {
  it("un solo esito forward non viene attribuito a due decisioni", () => {
    const entries: AiCalibrationEntry[] = [
      entry({ id: 'x1', timestamp: iso(0), candidateKey: 'r1:ENI', aiOutcome: 'BUY' }),
      entry({ id: 'x2', timestamp: iso(5), candidateKey: 'r2:ENI', aiOutcome: 'BUY' }),
    ];
    const forward = [point({ key: 'single', decidedAtMs: NOW + 4 * 60_000, r: 1.2 })];
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });

    assert.equal(out.counts.matched, 1, 'il punto forward vale per una sola decisione');
    assert.equal(out.counts.unmatchedAiEntries, 1);
    assert.equal(out.counts.forwardWithoutDecision, 0);
    assert.equal(out.buckets.find((b) => b.decision === 'AZIONE')?.n, 1);
    assert.equal(out.buckets.find((b) => b.decision === 'AZIONE')?.meanR, 1.2);
  });

  it("vince la coppia piu' vicina, non l'ordine del log", () => {
    const entries: AiCalibrationEntry[] = [
      entry({ id: 'y1', timestamp: iso(0), candidateKey: 'r1:ENI', aiOutcome: 'BUY' }),
      entry({ id: 'y2', timestamp: iso(5), candidateKey: 'r2:ENI', aiOutcome: 'SKIP' }),
    ];
    // il punto e' a +4 minuti: piu' vicino a y2 (1 min) che a y1 (4 min)
    const forward = [point({ key: 'near', decidedAtMs: NOW + 4 * 60_000, r: 0.8 })];
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });

    assert.equal(out.counts.matched, 1);
    assert.equal(out.buckets.find((b) => b.decision === 'SCARTO')?.n, 1);
    assert.equal(out.buckets.find((b) => b.decision === 'AZIONE')?.n, 0);
    assert.equal(out.counts.unmatchedAiEntries, 1);
  });

  it('una decisione non consuma due esiti diversi', () => {
    const entries: AiCalibrationEntry[] = [
      entry({ id: 'z1', timestamp: iso(0), candidateKey: 'r1:ENI', aiOutcome: 'BUY' }),
    ];
    const forward = [
      point({ key: 'first', decidedAtMs: NOW + 60_000, r: 2 }),
      point({ key: 'second', decidedAtMs: NOW + 2 * 60_000, r: -1, status: 'STOP' }),
    ];
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });

    assert.equal(out.counts.matched, 1);
    assert.equal(out.counts.forwardWithoutDecision, 1, "il secondo esito resta senza decisione");
    assert.equal(out.buckets.find((b) => b.decision === 'AZIONE')?.sumR, 2);
  });
});

describe('aiCalibration — ogni riga abbinata compare in un bucket', () => {
  it("sum(buckets[].n) e' sempre uguale a counts.matched", () => {
    const { entries, forward } = baseInput();
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });
    const sum = out.buckets.reduce((total, bucket) => total + bucket.n, 0);
    assert.equal(sum, out.counts.matched);
    assert.equal(out.counts.matched, 3);
  });

  it('una valutazione abbinata con esito illeggibile finisce in SCONOSCIUTO', () => {
    const out = buildAiCalibration({
      entries: [entry({ id: 'u1', candidateKey: 'r:ENI', aiOutcome: null })],
      forward: [point({ key: 'p', decidedAtMs: NOW, r: -1, status: 'STOP' })],
      nowMs: NOW,
      generatedAt: iso(0),
    });
    assert.equal(out.counts.matched, 1);
    const sconosciuto = out.buckets.find((b) => b.decision === 'SCONOSCIUTO');
    assert.equal(sconosciuto?.n, 1);
    assert.equal(sconosciuto?.meanR, -1);
    assert.equal(
      out.buckets.reduce((total, bucket) => total + bucket.n, 0),
      out.counts.matched
    );
    assert.equal(out.edgeR, null, 'SCONOSCIUTO non entra in edgeR');
  });

  it('la prosa non abbinata non entra nel rendiconto dei bucket', () => {
    const out = buildAiCalibration({
      entries: [
        {
          id: 'w1',
          timestamp: iso(0),
          ticker: 'ENI.MI',
          market: 'EU',
          direction: null,
          source: 'desk',
          aiOutcome: 'Non comprare contro il SuperTrend',
          candidateKey: null,
        },
      ],
      forward: [point({ key: 'p', decidedAtMs: NOW, r: 2 })],
      nowMs: NOW,
      generatedAt: iso(0),
    });
    assert.equal(out.counts.directivesIgnored, 1);
    assert.equal(out.counts.matched, 0);
    assert.equal(
      out.buckets.reduce((total, bucket) => total + bucket.n, 0),
      0
    );
  });
});

describe('aiCalibration — le direttive in prosa non sono esiti', () => {
  it('una direttiva desk/specialize finisce in SCONOSCIUTO e fuori dai bucket', () => {
    const entries: AiCalibrationEntry[] = [
      {
        id: 'd1',
        timestamp: iso(0),
        ticker: 'ENI.MI',
        market: 'EU',
        direction: null,
        source: 'desk',
        aiOutcome: 'Non comprare contro il SuperTrend',
        candidateKey: null,
      },
      {
        id: 'd2',
        timestamp: iso(0),
        ticker: 'ISP.MI',
        market: 'EU',
        direction: null,
        source: 'specialize',
        aiOutcome: 'Attendere la conferma del volume',
        candidateKey: null,
      },
    ];
    const forward = [
      point({ key: 'p1', ticker: 'ENI.MI', decidedAtMs: NOW, r: 2 }),
      point({ key: 'p2', ticker: 'ISP.MI', decidedAtMs: NOW, r: 1 }),
    ];
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });

    assert.equal(out.counts.directivesIgnored, 2);
    assert.equal(out.counts.matched, 0, 'la prosa non si abbina');
    assert.equal(out.counts.unmatchedAiEntries, 0);
    assert.equal(out.counts.forwardWithoutDecision, 2);
    assert.deepEqual(
      out.buckets.map((b) => b.n),
      [0, 0, 0, 0]
    );
    assert.equal(out.edgeR, null);
    assert.equal(out.skippedWinners.length, 0);
  });

  it('classifyEntryDecision ignora la prosa anche con verbi di decisione', () => {
    assert.equal(
      classifyEntryDecision({
        id: 'p',
        timestamp: iso(0),
        ticker: 'ENI.MI',
        market: 'EU',
        direction: null,
        source: 'desk',
        aiOutcome: 'BUY',
        candidateKey: null,
      }),
      'SCONOSCIUTO'
    );
    assert.equal(
      classifyEntryDecision(entry({ id: 'q', candidateKey: 'r:ENI', aiOutcome: 'BUY' })),
      'AZIONE'
    );
    assert.equal(
      classifyEntryDecision({ ...entry({ id: 's' }), source: 'scan', candidateKey: null, aiOutcome: 'SKIP' }),
      'SCARTO'
    );
  });
});

describe('aiCalibration — flag e handler', () => {
  it('accesa di default, spenta solo con 0/false', () => {
    assert.equal(isAiCalibrationEnabled({}), true);
    assert.equal(isAiCalibrationEnabled({ SHADOW_AI_CALIBRATION: '1' }), true);
    assert.equal(isAiCalibrationEnabled({ SHADOW_AI_CALIBRATION: 'false' }), false);
    assert.equal(isAiCalibrationEnabled({ SHADOW_AI_CALIBRATION: ' 0 ' }), false);
  });

  it('a flag OFF non legge nulla e risponde 404', () => {
    let reads = 0;
    const handler = createAiCalibrationHandler({
      env: { SHADOW_AI_CALIBRATION: '0' },
      readEntries: () => {
        reads += 1;
        return [];
      },
      readForward: () => {
        reads += 1;
        return [];
      },
    });
    const out = handler();
    assert.equal(out.status, 404);
    assert.equal(reads, 0);
  });

  it('a flag ON restituisce la calibrazione e non lancia in caso di errore', () => {
    const ok = createAiCalibrationHandler({
      env: {},
      now: () => NOW,
      readEntries: () => baseInput().entries,
      readForward: () => baseInput().forward,
    });
    const out = ok();
    assert.equal(out.status, 200);
    assert.equal((out.body as any).counts.matched, 3);

    const broken = createAiCalibrationHandler({
      env: {},
      now: () => NOW,
      readEntries: () => {
        throw new Error('boom');
      },
      readForward: () => [],
    });
    const failed = broken();
    assert.equal(failed.status, 200);
    assert.equal((failed.body as any).available, false);
  });
});
