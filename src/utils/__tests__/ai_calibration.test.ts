import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_CALIBRATION_MATCH_WINDOW_MS,
  AI_CALIBRATION_PATH,
  AI_CALIBRATION_VERSION,
  buildAiCalibration,
  classifyAiOutcome,
  classifyEntryDecision,
  createAiCalibrationHandler,
  isAiCalibrationEnabled,
  mapNearMissForwardPoints,
  mapRejectedForwardPoints,
  registerAiCalibrationRoute,
  type AiCalibrationEntry,
  type AiCalibrationForwardPoint,
  type AiCalibrationNearMissRecord,
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

describe('aiCalibration — la soglia conta solo le decisioni classificabili', () => {
  it('le righe in SCONOSCIUTO non avvicinano il campione alla soglia', () => {
    const entries: AiCalibrationEntry[] = [
      entry({ id: 'k1', timestamp: iso(0), ticker: 'ENI.MI', candidateKey: 'r:ENI', aiOutcome: null }),
      entry({ id: 'k2', timestamp: iso(0), ticker: 'ISP.MI', candidateKey: 'r:ISP', aiOutcome: null }),
      entry({ id: 'k3', timestamp: iso(0), ticker: 'TSLA', candidateKey: 'r:TSLA', aiOutcome: null }),
    ];
    const forward = [
      point({ key: 'k1p', ticker: 'ENI.MI', r: 1 }),
      point({ key: 'k2p', ticker: 'ISP.MI', r: 2 }),
      point({ key: 'k3p', ticker: 'TSLA', r: -1, status: 'STOP' }),
    ];
    const out = buildAiCalibration({
      entries,
      forward,
      nowMs: NOW,
      generatedAt: iso(0),
      minSample: 1,
    });

    assert.equal(out.counts.matched, 3);
    assert.equal(out.counts.classified, 0);
    assert.equal(out.buckets.find((b) => b.decision === 'SCONOSCIUTO')?.n, 3);
    assert.equal(out.verdict, 'insufficient', 'tre righe non classificabili non sono un campione');
    assert.match(out.note, /classificato 0 < 1/);
    assert.equal(
      out.buckets.reduce((total, bucket) => total + bucket.n, 0),
      out.counts.matched
    );
  });

  it('con abbinamenti misti la soglia usa i soli classificati', () => {
    const entries: AiCalibrationEntry[] = [
      entry({ id: 'q1', timestamp: iso(0), ticker: 'ENI.MI', candidateKey: 'r:ENI', aiOutcome: 'BUY', decision: 'AZIONE' }),
      entry({ id: 'q2', timestamp: iso(0), ticker: 'ISP.MI', candidateKey: 'r:ISP', aiOutcome: null }),
    ];
    const forward = [
      point({ key: 'q1p', ticker: 'ENI.MI', r: 2 }),
      point({ key: 'q2p', ticker: 'ISP.MI', r: 1 }),
    ];
    const out = buildAiCalibration({
      entries,
      forward,
      nowMs: NOW,
      generatedAt: iso(0),
      minSample: 2,
    });
    assert.equal(out.counts.matched, 2);
    assert.equal(out.counts.classified, 1);
    assert.equal(out.verdict, 'insufficient');
  });
});

describe('aiCalibration — lettura troncata dichiarata', () => {
  it('senza troncamento i campi sono espliciti e falsi', () => {
    const { entries, forward } = baseInput();
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });
    assert.equal(out.truncated, false);
    assert.equal(out.readLimit, 0);
    assert.ok(!out.limitations.some((line) => line.includes('troncata')));
  });

  it('con truncated:true lo dichiara nei campi e nei limiti', () => {
    const { entries, forward } = baseInput();
    const out = buildAiCalibration({
      entries,
      forward,
      nowMs: NOW,
      generatedAt: iso(0),
      truncated: true,
      readLimit: 2000,
    });
    assert.equal(out.truncated, true);
    assert.equal(out.readLimit, 2000);
    assert.ok(
      out.limitations.some((line) => line.includes('2000') && line.includes('troncata')),
      'il limite dichiara il tetto raggiunto'
    );
  });
});

describe('aiCalibration — allarmi di formato', () => {
  function tenCandidates(unknown: number) {
    const entries: AiCalibrationEntry[] = [];
    const forward: AiCalibrationForwardPoint[] = [];
    for (let i = 0; i < 10; i += 1) {
      const ticker = `TCK${i}`;
      const isUnknown = i < unknown;
      entries.push(
        entry({
          id: `a${i}`,
          ticker,
          candidateKey: `r:${ticker}`,
          aiOutcome: isUnknown ? null : 'BUY',
          decision: isUnknown ? null : 'AZIONE',
        })
      );
      forward.push(point({ key: `p${i}`, ticker, decidedAtMs: NOW, r: 1 }));
    }
    return { entries, forward };
  }

  it('allarma quando la quota di SCONOSCIUTO supera la soglia', () => {
    const { entries, forward } = tenCandidates(5);
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });
    assert.equal(out.counts.matched, 10);
    const alert = out.alerts.find((a) => a.code === 'UNKNOWN_SHARE_HIGH');
    assert.ok(alert, 'allarme presente');
    assert.equal(alert?.numerator, 5);
    assert.equal(alert?.denominator, 10);
    assert.equal(alert?.threshold, 0.3);
    assert.equal(alert?.ratio, 0.5);
    assert.match(alert?.message ?? '', /50% degli abbinamenti/);
  });

  it('non allarma quando la quota resta sotto soglia', () => {
    const { entries, forward } = tenCandidates(2);
    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });
    assert.deepEqual(out.alerts, []);
    assert.equal(out.buckets.find((b) => b.decision === 'SCONOSCIUTO')?.n, 2);
  });

  it('allarma quando il log e\' quasi tutto prosa', () => {
    const entries: AiCalibrationEntry[] = Array.from({ length: 10 }, (_, i) =>
      entry({
        id: `d${i}`,
        source: 'desk',
        candidateKey: null,
        aiOutcome: 'Non comprare contro il trend',
      })
    );
    const out = buildAiCalibration({
      entries,
      forward: [point({ key: 'p', decidedAtMs: NOW, r: 1 })],
      nowMs: NOW,
      generatedAt: iso(0),
    });
    assert.equal(out.counts.matched, 0);
    const alert = out.alerts.find((a) => a.code === 'DIRECTIVES_SHARE_HIGH');
    assert.ok(alert, 'allarme prosa presente');
    assert.equal(alert?.numerator, 10);
    assert.equal(alert?.denominator, 10);
    assert.match(alert?.message ?? '', /100% delle righe del log e' prosa/);
  });

  it('non allarma su campioni minuscoli', () => {
    const entries: AiCalibrationEntry[] = [
      entry({ id: 's1', source: 'desk', candidateKey: null, aiOutcome: 'prosa' }),
      entry({ id: 's2', source: 'desk', candidateKey: null, aiOutcome: 'prosa' }),
    ];
    const out = buildAiCalibration({
      entries,
      forward: [point({ key: 'p', decidedAtMs: NOW, r: 1 })],
      nowMs: NOW,
      generatedAt: iso(0),
    });
    assert.equal(out.counts.directivesIgnored, 2);
    assert.deepEqual(out.alerts, [], 'sotto il denominatore minimo nessuna percentuale');
  });
});

describe('aiCalibration — flag e handler', () => {
  it('accesa di default, spenta solo con 0/false', () => {
    assert.equal(isAiCalibrationEnabled({}), true);
    assert.equal(isAiCalibrationEnabled({ SHADOW_AI_CALIBRATION: '1' }), true);
    assert.equal(isAiCalibrationEnabled({ SHADOW_AI_CALIBRATION: 'false' }), false);
    assert.equal(isAiCalibrationEnabled({ SHADOW_AI_CALIBRATION: ' 0 ' }), false);
  });

  it('a flag OFF non legge nulla e risponde 404', async () => {
    let reads = 0;
    const out = await createAiCalibrationHandler({
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
    assert.equal(out.status, 404);
    assert.equal(reads, 0);
  });

  it('a flag ON attende letture asincrone e dichiara il fallback solo con voci remote', async () => {
    const out = await createAiCalibrationHandler({
      env: {},
      now: () => NOW,
      readEntries: async () => ({
        entries: baseInput().entries,
        remoteEntries: 2,
      }),
      readForward: async () => baseInput().forward,
    });
    assert.equal(out.status, 200);
    const body = out.body as any;
    assert.equal(body.counts.matched, 3);
    assert.equal(body.counts.remoteEntries, 2);
    assert.equal(body.sources.aiLog, 'shadow_ai_log.jsonl + Firestore (fallback)');
  });

  it('flag Firestore acceso ma zero voci remote: la fonte resta il file', async () => {
    const out = await createAiCalibrationHandler({
      env: {},
      now: () => NOW,
      readEntries: async () => ({ entries: baseInput().entries, remoteEntries: 0 }),
      readForward: () => baseInput().forward,
    });
    const body = out.body as any;
    assert.equal(body.counts.remoteEntries, 0);
    assert.equal(body.sources.aiLog, 'shadow_ai_log.jsonl');
  });

  it('propaga truncated e readLimit dalla lettura dettagliata', async () => {
    const out = await createAiCalibrationHandler({
      env: {},
      now: () => NOW,
      readEntries: async () => ({
        entries: baseInput().entries,
        truncated: true,
        readLimit: 2000,
      }),
      readForward: () => baseInput().forward,
    });
    const body = out.body as any;
    assert.equal(body.truncated, true);
    assert.equal(body.readLimit, 2000);
    assert.equal(body.counts.matched, 3, 'le voci lette vengono comunque usate');
  });

  it('con elenco nudo la fonte resta il file locale', async () => {
    const out = await createAiCalibrationHandler({
      env: {},
      now: () => NOW,
      readEntries: () => baseInput().entries,
      readForward: () => baseInput().forward,
    });
    assert.equal((out.body as any).sources.aiLog, 'shadow_ai_log.jsonl');
    assert.equal((out.body as any).counts.remoteEntries, 0);
  });

  it('non lancia: lettura sincrona che esplode o promise rifiutata producono available:false', async () => {
    const syncError = await createAiCalibrationHandler({
      env: {},
      now: () => NOW,
      readEntries: () => {
        throw new Error('boom');
      },
      readForward: () => [],
    });
    assert.equal(syncError.status, 200);
    assert.equal((syncError.body as any).available, false);

    const asyncError = await createAiCalibrationHandler({
      env: {},
      now: () => NOW,
      readEntries: () => Promise.reject(new Error('firestore down')),
      readForward: () => [],
    });
    assert.equal(asyncError.status, 200);
    assert.equal((asyncError.body as any).available, false);
  });

  it('la route risponde con il corpo della calibrazione', async () => {
    const routes = new Map<string, (req: unknown, res: unknown) => void>();
    registerAiCalibrationRoute(
      { get: (routePath, handler) => void routes.set(routePath, handler) },
      {
        env: {},
        now: () => NOW,
        readEntries: async () => baseInput().entries,
        readForward: async () => baseInput().forward,
      }
    );
    const handler = routes.get(AI_CALIBRATION_PATH);
    assert.ok(handler, 'route registrata');
    const captured = await new Promise<{ code: number; body: any }>((resolve) => {
      handler?.({}, {
        status: (code: number) => ({
          json: (body: unknown) => resolve({ code, body }),
        }),
      });
    });
    assert.equal(captured.code, 200);
    assert.equal(captured.body.counts.matched, 3);
  });
});

describe('aiCalibration — esiti near-miss per i candidati scartati', () => {
  const nearMissRecord = (
    partial: Partial<AiCalibrationNearMissRecord> & { id: string }
  ): AiCalibrationNearMissRecord => ({
    ticker: 'ISP.MI',
    decidedAtMs: NOW,
    r: 0.5,
    status: 'EXPIRED',
    ...partial,
  });

  it('mappa solo gli stati terminali con R finito e prefissa la chiave', () => {
    const points = mapNearMissForwardPoints([
      nearMissRecord({ id: 'a', status: 'EXPIRED', r: 0.537 }),
      nearMissRecord({ id: 'b', status: 'TARGET', r: 1.6 }),
      nearMissRecord({ id: 'c', status: 'STOP', r: -1 }),
      nearMissRecord({ id: 'd', status: 'NOT_FILLED', r: null }),
      nearMissRecord({ id: 'e', status: 'OPEN', r: null }),
      nearMissRecord({ id: 'f', status: 'PENDING_FILL', r: null }),
      nearMissRecord({ id: 'g', status: 'TARGET', r: Number.NaN }),
    ]);

    assert.deepEqual(
      points.map((p) => p.key),
      ['near_miss:a', 'near_miss:b', 'near_miss:c'],
      'solo stati terminali con R finito'
    );
    assert.ok(points.every((p) => p.source === 'near_miss'));
    assert.equal(points[1].status, 'TARGET');
    assert.equal(points[2].r, -1);
  });

  it('un esito near-miss da un R allo SCARTO e rende calcolabile edgeR', () => {
    const entries: AiCalibrationEntry[] = [
      entry({ id: 'e1', ticker: 'ENI.MI', candidateKey: 'r1:ENI.MI', aiOutcome: 'BUY', decision: 'AZIONE' }),
      entry({ id: 'e2', ticker: 'ISP.MI', candidateKey: 'r1:ISP.MI', aiOutcome: 'SKIP', decision: 'SCARTO' }),
    ];
    const forward: AiCalibrationForwardPoint[] = [
      point({ key: 'sig:ENI', ticker: 'ENI.MI', decidedAtMs: NOW, r: 2, status: 'TARGET' }),
      ...mapNearMissForwardPoints([
        nearMissRecord({ id: 'EU|ISP.MI|2026-11-25|G11_SCORE', ticker: 'ISP.MI', r: -0.5 }),
      ]),
    ];

    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0), minSample: 2 });
    const skip = out.buckets.find((bucket) => bucket.decision === 'SCARTO');

    assert.equal(skip?.n, 1, 'lo scarto ora ha un esito');
    assert.equal(skip?.meanR, -0.5);
    assert.equal(out.edgeR, 2.5, 'edgeR = 2 - (-0.5)');
    assert.equal(out.verdict, 'evidence');
    assert.equal(out.counts.nearMissMatched, 1);
    assert.equal(out.counts.nearMissForwardPoints, 1);
    assert.equal(
      out.sources.forward,
      'artifacts/shadow_v1_live/signals.jsonl + near_miss.jsonl (controfattuale)'
    );
    assert.ok(
      out.limitations.some((line) => line.includes('controfattuale') && line.includes('mai stato emesso')),
      'il limite dichiara la natura controfattuale'
    );
    assert.equal(
      out.buckets.reduce((total, bucket) => total + bucket.n, 0),
      out.counts.matched,
      'invariante dei bucket'
    );
    // Il validatore non si accontenta di un caso per lato: resta senza verdetto.
    assert.equal(out.validation.version, 'ai-desk-validation@2');
    assert.equal(out.validation.verdict, 'INSUFFICIENTE');
    assert.equal(out.validation.deskStatus, 'NON_VALIDATO');
    assert.match(out.note, /ai-desk-validation@2: INSUFFICIENTE/);
    assert.ok(
      out.limitations.some(
        (line) => line.includes('NON_VALIDATO') && line.includes('INSUFFICIENTE')
      ),
      'la risposta dichiara il verdetto del validatore'
    );
  });

  it('validatore: campione forte => CONFERMATO, senza promuovere le righe del log', () => {
    const entries: AiCalibrationEntry[] = [];
    const forward: AiCalibrationForwardPoint[] = [];
    const add = (n: number, decision: 'AZIONE' | 'SCARTO' | 'ATTESA', r: number, from: number) => {
      for (let i = 0; i < n; i += 1) {
        const ticker = `${decision}${from + i}`;
        entries.push(
          entry({
            id: `v-${ticker}`,
            ticker,
            candidateKey: `runv:${ticker}`,
            aiOutcome: decision,
            decision,
          })
        );
        forward.push(point({ key: `sig:${ticker}`, ticker, r, status: r > 0 ? 'TARGET' : 'STOP' }));
      }
    };
    add(12, 'AZIONE', 1, 0);
    add(12, 'SCARTO', -1, 0);
    add(6, 'ATTESA', 0, 0);

    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });

    assert.equal(out.counts.classified, 30, 'campione classificato al bordo della soglia');
    assert.equal(out.edgeR, 2, 'edgeR = 1 - (-1)');
    assert.equal(out.validation.verdict, 'CONFERMATO');
    assert.equal(out.validation.deskStatus, 'VALIDATO');
    assert.ok(out.validation.checks.every((check) => check.status !== 'fail'));
    assert.match(out.note, /ai-desk-validation@2: CONFERMATO/);
    assert.ok(
      out.limitations.some((line) => line.includes('le righe del log non vengono promosse')),
      'il verdetto non riscrive lo status NON_VALIDATO delle righe'
    );
    assert.equal(out.costR, 0.36, 'fee 0.20 R + proxy spread 0.16 R');
    assert.equal(out.netModel.totalR, 0.36);
    assert.ok(out.netModel.source.includes('Trade Republic'));
    assert.equal(out.edgeRNet, 2);
    assert.equal(
      out.buckets.find((bucket) => bucket.decision === 'AZIONE')?.meanRNet,
      0.64,
      'meanR 1.00 al netto di 0.36 R'
    );
  });

  it('R netto: il costo abbassa meanR e successo, non la differenza fra medie', () => {
    const entries: AiCalibrationEntry[] = [
      entry({ id: 'n1', ticker: 'AAA', candidateKey: 'r:AAA', decision: 'AZIONE' }),
      entry({ id: 'n2', ticker: 'BBB', candidateKey: 'r:BBB', decision: 'SCARTO' }),
    ];
    const forward: AiCalibrationForwardPoint[] = [
      point({ key: 'sig:AAA', ticker: 'AAA', r: 0.1, status: 'TARGET' }),
      point({ key: 'sig:BBB', ticker: 'BBB', r: -0.1, status: 'STOP' }),
    ];

    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0), minSample: 2 });
    const azione = out.buckets.find((bucket) => bucket.decision === 'AZIONE');
    const scarto = out.buckets.find((bucket) => bucket.decision === 'SCARTO');

    assert.equal(azione?.winRatePct, 100, 'lordo: +0.1 R e positivo');
    assert.equal(azione?.winRateNetPct, 0, 'netto: 0.1 - 0.36 < 0, il trade diventa perdente');
    assert.equal(azione?.meanRNet, -0.26);
    assert.equal(scarto?.winRatePct, 0);
    assert.equal(scarto?.winRateNetPct, 0);
    assert.equal(out.edgeR, 0.2);
    assert.equal(out.edgeRNet, 0.2, 'un costo costante non cambia la differenza di medie');
    assert.ok(
      out.limitations.some((line) => line.includes('R netto') && line.includes('win rate')),
      'la risposta dichiara il modello netto'
    );
  });

  it('near-miss forniti ma non abbinati: la fonte resta signals-only', () => {
    const entries: AiCalibrationEntry[] = [
      entry({ id: 'n1', ticker: 'ENI.MI', candidateKey: 'r1:ENI.MI', aiOutcome: 'BUY', decision: 'AZIONE' }),
    ];
    const forward: AiCalibrationForwardPoint[] = [
      point({ key: 'sig:ENI', ticker: 'ENI.MI', r: 1, status: 'TARGET' }),
      ...mapNearMissForwardPoints([nearMissRecord({ id: 'x', ticker: 'UCG.MI', r: 0.2 })]),
    ];

    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });
    assert.equal(out.counts.nearMissForwardPoints, 1);
    assert.equal(out.counts.nearMissMatched, 0);
    assert.equal(out.sources.forward, 'artifacts/shadow_v1_live/signals.jsonl');
  });

  it('il handler unisce le due fonti: sui duplicati vince la chiave dei segnali', async () => {
    const out = await createAiCalibrationHandler({
      env: {},
      now: () => NOW,
      readEntries: () => [
        entry({ id: 'h1', ticker: 'ENI.MI', candidateKey: 'r:ENI', aiOutcome: 'BUY', decision: 'AZIONE' }),
      ],
      readForward: () => [point({ key: 'same', ticker: 'ENI.MI', r: 2 })],
      readNearMissForward: () => [point({ key: 'same', ticker: 'ENI.MI', r: -5, source: 'near_miss' })],
    });
    const body = out.body as any;

    assert.equal(out.status, 200);
    assert.equal(body.counts.forwardPoints, 1, 'chiave duplicata unita');
    assert.equal(body.buckets.find((b: any) => b.decision === 'AZIONE')?.sumR, 2);
  });

  it('un esito di scarto fuori whitelist entra nel bucket SCARTO e si dichiara', () => {
    const entries: AiCalibrationEntry[] = [
      entry({ id: 'r1', ticker: 'ENI.MI', candidateKey: 'r1:ENI.MI', aiOutcome: 'BUY', decision: 'AZIONE' }),
      entry({ id: 'r2', ticker: 'ISP.MI', candidateKey: 'r1:ISP.MI', aiOutcome: 'SKIP', decision: 'SCARTO' }),
    ];
    const forward: AiCalibrationForwardPoint[] = [
      point({ key: 'sig:ENI', ticker: 'ENI.MI', decidedAtMs: NOW, r: 2, status: 'TARGET' }),
      ...mapRejectedForwardPoints([
        { id: 'EU|ISP.MI|2026-11-25', ticker: 'ISP.MI', decidedAtMs: NOW, r: 0.75, status: 'EXPIRED' },
      ]),
    ];

    const out = buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0), minSample: 2 });
    const skip = out.buckets.find((bucket) => bucket.decision === 'SCARTO');

    assert.equal(skip?.n, 1);
    assert.equal(skip?.meanR, 0.75);
    assert.equal(out.counts.rejectedMatched, 1);
    assert.equal(out.counts.rejectedForwardPoints, 1);
    assert.equal(out.counts.nearMissMatched, 0);
    assert.equal(
      out.sources.forward,
      'artifacts/shadow_v1_live/signals.jsonl + rejected.jsonl (controfattuale)'
    );
    assert.ok(
      out.limitations.some((line) => line.includes('fuori dal near-miss') && line.includes('mai emesso')),
      'il limite distingue gli altri scarti dal near-miss'
    );
  });

  it('lettura near-miss in errore: restano gli esiti dei segnali', async () => {
    const out = await createAiCalibrationHandler({
      env: {},
      now: () => NOW,
      readEntries: () => [
        entry({ id: 'h2', ticker: 'ENI.MI', candidateKey: 'r:ENI', aiOutcome: 'BUY', decision: 'AZIONE' }),
      ],
      readForward: () => [point({ key: 'sig', ticker: 'ENI.MI', r: 1.5 })],
      readNearMissForward: () => {
        throw new Error('near_miss.jsonl illeggibile');
      },
    });
    const body = out.body as any;

    assert.equal(out.status, 200);
    assert.equal(body.counts.matched, 1);
    assert.equal(body.counts.nearMissForwardPoints, 0);
  });

  it('il handler unisce anche gli altri scarti; in errore restano le altre fonti', async () => {
    const deps = {
      env: {},
      now: () => NOW,
      readEntries: () => [
        entry({ id: 'h3', ticker: 'ISP.MI', candidateKey: 'r:ISP', aiOutcome: 'SKIP', decision: 'SCARTO' }),
      ],
      readForward: () => [point({ key: 'sig', ticker: 'ENI.MI', r: 1.5 })],
      readRejectedForward: () => [
        point({ key: 'rejected:x', ticker: 'ISP.MI', r: -0.4, source: 'rejected' as const }),
      ],
    };
    const ok = await createAiCalibrationHandler(deps);
    const okBody = ok.body as any;
    assert.equal(okBody.counts.rejectedMatched, 1);
    assert.equal(okBody.buckets.find((b: any) => b.decision === 'SCARTO')?.meanR, -0.4);

    const failed = await createAiCalibrationHandler({
      ...deps,
      readRejectedForward: () => {
        throw new Error('rejected.jsonl illeggibile');
      },
    });
    const failedBody = failed.body as any;
    assert.equal(failed.status, 200);
    assert.equal(failedBody.counts.rejectedForwardPoints, 0);
    assert.equal(failedBody.counts.forwardPoints, 1, 'gli esiti dei segnali restano');
  });
});

describe('aiCalibration — incertezza deterministica sul R netto', () => {
  function sample(azioneR: number[], scartoR: number[]) {
    const entries: AiCalibrationEntry[] = [];
    const forward: AiCalibrationForwardPoint[] = [];
    azioneR.forEach((r, i) => {
      const ticker = `AZ${i}`;
      entries.push(entry({ id: `az${i}`, ticker, candidateKey: `k:AZ${i}`, decision: 'AZIONE' }));
      forward.push(point({ key: `p:AZ${i}`, ticker, r }));
    });
    scartoR.forEach((r, i) => {
      const ticker = `SC${i}`;
      entries.push(entry({ id: `sc${i}`, ticker, candidateKey: `k:SC${i}`, decision: 'SCARTO' }));
      forward.push(point({ key: `p:SC${i}`, ticker, r }));
    });
    return buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });
  }

  it('stesso campione => stessi intervalli, e la stima puntuale cade dentro', () => {
    const first = sample([1, 0.5, 0.8, 1.2, 0.4], [-1, -0.5, -0.8, -1.2, -0.4]);
    const second = sample([1, 0.5, 0.8, 1.2, 0.4], [-1, -0.5, -0.8, -1.2, -0.4]);

    assert.deepEqual(first.uncertainty, second.uncertainty, 'nessuna casualita: stessa seed');
    assert.equal(first.uncertainty.net, true, 'gli intervalli sono sul R netto');
    assert.ok(first.uncertainty.edgeR);
    assert.ok(first.uncertainty.edgeR.lower <= first.edgeRNet!);
    assert.ok(first.uncertainty.edgeR.upper >= first.edgeRNet!);
    assert.ok(first.uncertainty.winRateGapPct);
  });

  it('meno di 2 esiti per lato: nessun intervallo inventato', () => {
    const out = sample([1], [-1]);
    assert.equal(out.uncertainty.edgeR, null);
    assert.equal(out.uncertainty.winRateGapPct, null);
  });
});

describe('aiCalibration — copertura della pipeline', () => {
  it('distingue valutati, non valutati e righe storiche senza campo', () => {
    const rows: AiCalibrationEntry[] = [];
    for (let i = 0; i < 3; i += 1) {
      rows.push(
        entry({
          id: `e${i}`,
          ticker: `E${i}`,
          candidateKey: `k:E${i}`,
          evaluated: true,
          durationMs: 100 + i * 50,
        })
      );
    }
    for (let i = 0; i < 9; i += 1) {
      rows.push(
        entry({
          id: `n${i}`,
          ticker: `N${i}`,
          candidateKey: `k:N${i}`,
          evaluated: false,
          discardReason: 'NON_INVIATO_ALLA_LLM',
        })
      );
    }
    for (let i = 0; i < 4; i += 1) {
      rows.push(entry({ id: `u${i}`, ticker: `U${i}`, candidateKey: `k:U${i}` }));
    }

    const out = buildAiCalibration({ entries: rows, forward: [], nowMs: NOW, generatedAt: iso(0) });

    assert.equal(out.coverage.candidates, 16);
    assert.equal(out.coverage.evaluated, 3);
    assert.equal(out.coverage.notEvaluated, 9);
    assert.equal(out.coverage.unknown, 4, 'le righe senza campo non sporcano il denominatore');
    assert.equal(out.coverage.evaluatedSharePct, 25);
    assert.deepEqual(out.coverage.byReason, [{ reason: 'NON_INVIATO_ALLA_LLM', count: 9 }]);
    assert.equal(out.coverage.latency.samples, 3);
    assert.ok(out.coverage.latency.p95Ms !== null);

    const alert = out.alerts.find((item) => item.code === 'COVERAGE_LOW');
    assert.ok(alert, 'copertura bassa: allarme esplicito');
    assert.match(alert!.message, /25%/);
    assert.equal(
      out.validation.checks.find((check) => check.code === 'sample_integrity')?.status,
      'insufficient'
    );
  });

  it('righe senza campo evaluated: quota non calcolabile e nessun allarme', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      entry({ id: `u${i}`, ticker: `U${i}`, candidateKey: `k:U${i}` })
    );
    const out = buildAiCalibration({ entries: rows, forward: [], nowMs: NOW, generatedAt: iso(0) });

    assert.equal(out.coverage.evaluatedSharePct, null);
    assert.equal(out.coverage.unknown, 12);
    assert.equal(out.alerts.some((item) => item.code === 'COVERAGE_LOW'), false);
  });
});

describe('aiCalibration — ordinalita, policy e strati', () => {
  function buildSets(
    sets: { decision: 'AZIONE' | 'ATTESA' | 'SCARTO'; r: number; market?: string; n: number }[]
  ) {
    const entries: AiCalibrationEntry[] = [];
    const forward: AiCalibrationForwardPoint[] = [];
    let index = 0;
    for (const set of sets) {
      for (let i = 0; i < set.n; i += 1) {
        index += 1;
        const ticker = `T${index}`;
        entries.push(
          entry({
            id: `e${index}`,
            ticker,
            market: set.market ?? 'EU',
            candidateKey: `k:${ticker}`,
            decision: set.decision,
          })
        );
        forward.push(point({ key: `p:${ticker}`, ticker, r: set.r }));
      }
    }
    return buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });
  }

  it('ATTESA fra le altre due: ordinato; fuori posto: non ordinato', () => {
    const ordered = buildSets([
      { decision: 'AZIONE', r: 1, n: 10 },
      { decision: 'ATTESA', r: 0, n: 10 },
      { decision: 'SCARTO', r: -1, n: 10 },
    ]);
    assert.equal(ordered.ordinality.status, 'ordinato');

    const broken = buildSets([
      { decision: 'AZIONE', r: 1, n: 10 },
      { decision: 'ATTESA', r: -2, n: 10 },
      { decision: 'SCARTO', r: -1, n: 10 },
    ]);
    assert.equal(broken.ordinality.status, 'non_ordinato');
    assert.match(broken.ordinality.detail, /non porta informazione/);
  });

  it('policy: il costo uniforme non cambia la differenza, il filtro si vede nei trade', () => {
    const out = buildSets([
      { decision: 'AZIONE', r: 1, n: 10 },
      { decision: 'ATTESA', r: 0, n: 10 },
      { decision: 'SCARTO', r: -1, n: 10 },
    ]);
    const solo = out.policies.find((policy) => policy.code === 'SOLO_AZIONE')!;
    const tutti = out.policies.find((policy) => policy.code === 'TUTTI_I_CLASSIFICATI')!;

    assert.equal(solo.trades, 10);
    assert.equal(solo.meanRNet, 0.64, '1.00 - 0.36 di costi');
    assert.equal(tutti.trades, 30);
    assert.equal(tutti.meanRNet, -0.36, 'media lorda 0, al netto -0.36');
    assert.equal(tutti.winRateNetPct, 33.33);
  });

  it('strato con edge negativo e lati sufficienti: contraddizione dichiarata', () => {
    const out = buildSets([
      { decision: 'AZIONE', r: 1, market: 'EU', n: 10 },
      { decision: 'SCARTO', r: -1, market: 'EU', n: 10 },
      { decision: 'AZIONE', r: -1, market: 'US', n: 10 },
      { decision: 'SCARTO', r: 1, market: 'US', n: 10 },
    ]);

    const us = out.strata.find((row) => row.dimension === 'market' && row.value === 'US')!;
    assert.equal(us.edgeRNet, -2);
    assert.equal(us.contradicts, true);
    const eu = out.strata.find((row) => row.dimension === 'market' && row.value === 'EU')!;
    assert.equal(eu.contradicts, false);
    assert.ok(
      out.limitations.some((line) => line.includes('strati')),
      'la risposta dichiara che gli strati non entrano nel verdetto'
    );
  });
});

describe('aiCalibration — tagli per promptVersion e per modello', () => {
  function buildTagged(
    sets: {
      decision: 'AZIONE' | 'ATTESA' | 'SCARTO';
      r: number;
      n: number;
      promptVersion?: string | null;
      model?: string | null;
    }[]
  ) {
    const entries: AiCalibrationEntry[] = [];
    const forward: AiCalibrationForwardPoint[] = [];
    let index = 0;
    for (const set of sets) {
      for (let i = 0; i < set.n; i += 1) {
        index += 1;
        const ticker = `T${index}`;
        entries.push(
          entry({
            id: `e${index}`,
            ticker,
            candidateKey: `k:${ticker}`,
            decision: set.decision,
            promptVersion: set.promptVersion,
            model: set.model,
          })
        );
        forward.push(point({ key: `p:${ticker}`, ticker, r: set.r }));
      }
    }
    return buildAiCalibration({ entries, forward, nowMs: NOW, generatedAt: iso(0) });
  }

  it('separa le versioni di prompt senza cambiare il verdetto aggregato', () => {
    const curvature = {
      promptVersion: 'ai-specialize@1',
      model: 'openrouter:m1',
    };
    const tagged = buildTagged([
      { decision: 'AZIONE', r: 1, n: 10, ...curvature },
      { decision: 'SCARTO', r: -1, n: 10, ...curvature },
      { decision: 'AZIONE', r: -1, n: 10, promptVersion: 'ai-specialize@2', model: 'openrouter:m1' },
      { decision: 'SCARTO', r: 1, n: 10, promptVersion: 'ai-specialize@2', model: 'openrouter:m1' },
    ]);
    const untagged = buildTagged([
      { decision: 'AZIONE', r: 1, n: 10 },
      { decision: 'SCARTO', r: -1, n: 10 },
      { decision: 'AZIONE', r: -1, n: 10 },
      { decision: 'SCARTO', r: 1, n: 10 },
    ]);

    assert.equal(tagged.verdict, untagged.verdict, 'i tagli non cambiano il verdetto');
    assert.equal(tagged.edgeRNet, untagged.edgeRNet);
    assert.equal(tagged.counts.matched, 40);

    const v1 = tagged.byPromptVersion.find((row) => row.value === 'ai-specialize@1')!;
    const v2 = tagged.byPromptVersion.find((row) => row.value === 'ai-specialize@2')!;
    assert.equal(v1.matched, 20);
    assert.equal(v1.classified, 20);
    assert.equal(v1.edgeRNet, 2, '1.00 lordo - (-1.00) = 2.00 R');
    assert.equal(v1.contradicts, false);
    assert.equal(v2.edgeRNet, -2);
    assert.equal(v2.contradicts, true, 'versione con entrambi i lati sufficienti e edge negativo');
    // Le versioni sono ordinate e il valore non viene inventato.
    assert.deepEqual(
      tagged.byPromptVersion.map((row) => row.value),
      ['ai-specialize@1', 'ai-specialize@2']
    );
  });

  it('il taglio per modello mette in fondo le righe non attribuibili', () => {
    const out = buildTagged([
      { decision: 'AZIONE', r: 1, n: 3, model: 'openrouter:m2' },
      { decision: 'AZIONE', r: 1, n: 3, model: 'gemini:g1' },
      { decision: 'AZIONE', r: 1, n: 3, model: null },
      { decision: 'AZIONE', r: 1, n: 3, model: '   ' },
    ]);

    assert.deepEqual(
      out.byModel.map((row) => row.value),
      ['gemini:g1', 'openrouter:m2', null],
      'stringa vuota = non attribuibile, non un modello'
    );
    const unknown = out.byModel.find((row) => row.value === null)!;
    assert.equal(unknown.matched, 6, 'le righe senza modello restano insieme e dichiarate');
    assert.equal(unknown.edgeRNet, null, 'senza SCARTO l edge non si calcola');
  });

  it('senza tag nel log i due elenchi restano presenti e vuoti', () => {
    const out = buildTagged([{ decision: 'AZIONE', r: 1, n: 2 }]);
    assert.equal(out.byPromptVersion.length, 1);
    assert.equal(out.byPromptVersion[0].value, null);
    assert.equal(out.byModel.length, 1);
    assert.equal(out.byModel[0].value, null);
    assert.ok(
      out.limitations.some((line) => line.includes('promptVersion') && line.includes('diagnostici')),
      'la risposta dichiara che i tagli non entrano nel verdetto'
    );
  });
});
