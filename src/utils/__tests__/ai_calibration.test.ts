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
  registerAiCalibrationRoute,
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
