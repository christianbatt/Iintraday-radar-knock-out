import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ShadowAISection, { ShadowAiCalibrationBlock } from '../ShadowAISection';

const EVIDENCE = {
  available: true,
  verdict: 'evidence' as const,
  edgeR: 0.42,
  minSample: 30,
  counts: { matched: 34, classified: 34 },
  buckets: [
    { decision: 'AZIONE', n: 20 },
    { decision: 'ATTESA', n: 4 },
    { decision: 'SCARTO', n: 10 },
    { decision: 'SCONOSCIUTO', n: 0 },
  ],
  skippedWinners: [{ ticker: 'ISP.MI' }, { ticker: 'UCG.MI' }],
};

const INSUFFICIENT = {
  available: true,
  verdict: 'insufficient' as const,
  edgeR: null,
  minSample: 30,
  counts: { matched: 3, classified: 3 },
  buckets: [
    { decision: 'AZIONE', n: 0 },
    { decision: 'ATTESA', n: 1 },
    { decision: 'SCARTO', n: 2 },
    { decision: 'SCONOSCIUTO', n: 0 },
  ],
  skippedWinners: [],
};

const MIXED = {
  available: true,
  verdict: 'insufficient' as const,
  edgeR: null,
  minSample: 30,
  counts: { matched: 5, classified: 1 },
  buckets: [
    { decision: 'AZIONE', n: 1 },
    { decision: 'ATTESA', n: 0 },
    { decision: 'SCARTO', n: 0 },
    { decision: 'SCONOSCIUTO', n: 4 },
  ],
  skippedWinners: [],
};

describe('ShadowAiCalibrationBlock — render', () => {
  it('mostra campione, bucket, edgeR e scarti andati in positivo', () => {
    const out = renderToStaticMarkup(React.createElement(ShadowAiCalibrationBlock, { calibration: EVIDENCE }));
    assert.ok(out.includes('data-testid="shadow-ai-calibration"'));
    assert.ok(out.includes('campione sufficiente'));
    assert.ok(out.includes('classificati: 34 / min 30'));
    assert.ok(!out.includes('abbinamenti esclusi'), 'nessun escluso quando tutti sono classificati');
    assert.ok(out.includes('AZIONE 20'));
    assert.ok(out.includes('ATTESA 4'));
    assert.ok(out.includes('SCARTO 10'));
    assert.ok(out.includes('edgeR: 0.42'));
    assert.ok(out.includes('scarti andati in positivo: 2'));
    assert.ok(!out.includes('(non un risultato)'));
  });

  it('sotto soglia dichiara edgeR non calcolabile e "non un risultato"', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: INSUFFICIENT })
    );
    assert.ok(out.includes('campione insufficiente'));
    assert.ok(out.includes('classificati: 3 / min 30'));
    assert.ok(!out.includes('abbinamenti esclusi'));
    assert.ok(out.includes('edgeR: non calcolabile'));
    assert.ok(out.includes('(non un risultato)'));
    assert.ok(!out.includes('scarti andati in positivo'));
  });
});

describe('ShadowAiCalibrationBlock — fonte e troncamento', () => {
  it('mostra la fonte usata e il fallback solo con voci remote reali', () => {
    const plain = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: EVIDENCE })
    );
    assert.ok(plain.includes('data-testid="shadow-ai-calibration-source"'));
    assert.ok(plain.includes('fonte: shadow_ai_log.jsonl'));
    assert.ok(!plain.includes('fallback attivo'));

    const withFallback = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: {
          ...EVIDENCE,
          sources: { aiLog: 'shadow_ai_log.jsonl + Firestore (fallback)' },
          counts: { ...EVIDENCE.counts, remoteEntries: 2 },
        },
      })
    );
    assert.ok(withFallback.includes('shadow_ai_log.jsonl + Firestore (fallback)'));
    assert.ok(withFallback.includes('fallback attivo (2 voci)'));
  });

  it('flag acceso ma zero voci remote: nessuna dicitura di fallback', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: {
          ...EVIDENCE,
          // Etichetta che nomina Firestore ma nessuna voce remota usata:
          // il caso che prima produceva un "fallback attivo" falso.
          sources: { aiLog: 'shadow_ai_log.jsonl + Firestore (fallback)' },
          counts: { ...EVIDENCE.counts, remoteEntries: 0 },
        },
      })
    );
    assert.ok(out.includes('shadow_ai_log.jsonl + Firestore (fallback)'));
    assert.ok(!out.includes('fallback attivo'));
  });

  it('segnala la lettura troncata con il tetto raggiunto', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: { ...EVIDENCE, truncated: true, readLimit: 2000 },
      })
    );
    assert.ok(out.includes('data-testid="shadow-ai-calibration-truncated"'));
    assert.ok(out.includes('lettura troncata a 2000 voci'));
    assert.ok(out.includes('campione può essere incompleto'));
  });

  it('non mostra nessun avviso quando la lettura e\' completa', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: { ...EVIDENCE, truncated: false, readLimit: 2000 },
      })
    );
    assert.ok(!out.includes('data-testid="shadow-ai-calibration-truncated"'));
    assert.ok(!out.includes('lettura troncata'));
  });
});

describe('ShadowAiCalibrationBlock — allarmi di formato', () => {
  it('mostra ogni allarme con il messaggio del server', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: {
          ...EVIDENCE,
          alerts: [
            { code: 'UNKNOWN_SHARE_HIGH', message: '50% degli abbinamenti e SCONOSCIUTO' },
            { code: 'DIRECTIVES_SHARE_HIGH', message: '80% delle righe e prosa' },
          ],
        },
      })
    );
    assert.equal(out.match(/data-testid="shadow-ai-calibration-alert"/g)?.length, 2);
    assert.ok(out.includes('50% degli abbinamenti'));
    assert.ok(out.includes('80% delle righe'));
    assert.ok(out.includes('⚠'));
  });

  it('senza allarmi non renderizza nessun avviso', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: { ...EVIDENCE, alerts: [] },
      })
    );
    assert.ok(!out.includes('data-testid="shadow-ai-calibration-alert"'));
  });
});

describe('ShadowAiCalibrationBlock — classificati vs esclusi', () => {
  it('mostra classificati sulla soglia e gli abbinamenti esclusi a parte', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: MIXED })
    );
    assert.ok(out.includes('data-testid="shadow-ai-calibration-classified"'));
    assert.ok(out.includes('classificati: 1 / min 30'));
    assert.ok(out.includes('abbinamenti esclusi (SCONOSCIUTO): 4 su 5'));
    assert.ok(!out.includes('classificati: 5'), 'gli abbinati non sono la soglia');
  });

  it('senza counts.classified ricava i classificati dai bucket', () => {
    const legacy = { ...MIXED, counts: { matched: 5 } };
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: legacy })
    );
    assert.ok(out.includes('classificati: 1 / min 30'));
    assert.ok(out.includes('abbinamenti esclusi (SCONOSCIUTO): 4 su 5'));
  });
});

describe('ShadowAiCalibrationBlock — R netto', () => {
  it('mostra costo per trade, componenti e edgeR netto', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: {
          ...EVIDENCE,
          edgeRNet: 0.42,
          costR: 0.36,
          netModel: { feeR: 0.2, spreadR: 0.16, totalR: 0.36, source: 'Shadow V2' },
        },
      })
    );
    assert.ok(out.includes('data-testid="shadow-ai-calibration-net"'));
    assert.ok(out.includes('costi 0.36 R per trade'));
    assert.ok(out.includes('fee 0.2 + spread 0.16'));
    assert.ok(out.includes('edgeR netto 0.42'));
  });

  it('senza costR non aggiunge la riga netta (payload storici)', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: EVIDENCE })
    );
    assert.ok(!out.includes('shadow-ai-calibration-net'));
  });
});

describe('ShadowAiCalibrationBlock — validatore deterministico', () => {
  it('mostra verdetto, stato del desk e riga di dettaglio', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: {
          ...EVIDENCE,
          validation: {
            version: 'ai-desk-validation@2',
            verdict: 'NON_CONFERMATO',
            deskStatus: 'NON_VALIDATO',
            headline: 'NON CONFERMATO: edgeR 0.05 R (soglia +0.2 R).',
          },
        },
      })
    );
    assert.ok(out.includes('data-testid="shadow-ai-calibration-validator"'));
    assert.ok(out.includes('validatore ai-desk-validation@2: NON_CONFERMATO'));
    assert.ok(out.includes('desk NON_VALIDATO'));
    assert.ok(out.includes('NON CONFERMATO: edgeR 0.05 R'));
  });

  it('senza validation nel payload non aggiunge righe', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: EVIDENCE })
    );
    assert.ok(!out.includes('shadow-ai-calibration-validator'));
  });
});

describe('ShadowAISection — calibrazione nel pannello', () => {
  it('renderizza il blocco quando i dati sono disponibili', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, { flag: 'on', entries: [], calibration: EVIDENCE })
    );
    assert.ok(out.includes('data-testid="shadow-ai-calibration"'));
    assert.ok(out.includes('edgeR: 0.42'));
  });

  it('mette il blocco di calibrazione prima dell elenco delle righe', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, {
        flag: 'on',
        entries: [
          {
            id: 'e1',
            timestamp: '2026-11-25T09:00:00.000Z',
            ticker: 'ENI.MI',
            market: 'EU',
            direction: 'LONG',
            setup: 'ORB',
            aiOutcome: 'APPROVATO: momentum',
            aiCategory: 'orb',
            source: 'scan',
            status: 'NON_VALIDATO',
            outcome: null,
            decision: 'AZIONE',
          },
        ],
        calibration: EVIDENCE,
      })
    );
    const calibration = out.indexOf('data-testid="shadow-ai-calibration"');
    const list = out.indexOf('data-testid="shadow-ai-list"');
    const sectionTitle = out.indexOf('Osservazioni AI shadow');
    assert.ok(sectionTitle >= 0 && calibration > sectionTitle, 'calibrazione assente o fuori sezione');
    assert.ok(list >= 0, 'elenco righe assente');
    assert.ok(calibration < list, 'la calibrazione deve precedere l elenco delle righe');
  });

  it('non renderizza il blocco senza dati (null)', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, { flag: 'on', entries: [], calibration: null })
    );
    assert.ok(out.includes('data-testid="shadow-ai-section"'));
    assert.ok(!out.includes('data-testid="shadow-ai-calibration"'));
  });

  it('non renderizza il blocco quando la risposta dice available:false', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, {
        flag: 'on',
        entries: [],
        calibration: { ...INSUFFICIENT, available: false },
      })
    );
    assert.ok(!out.includes('data-testid="shadow-ai-calibration"'));
  });

  it('dichiara gli esiti controfattuali near-miss solo quando sono usati', () => {
    const withNearMiss = {
      ...EVIDENCE,
      counts: { ...EVIDENCE.counts, nearMissMatched: 3 },
    };
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: withNearMiss })
    );
    assert.ok(out.includes('esiti controfattuali (near-miss): 3 su 34'));

    const plain = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: EVIDENCE })
    );
    assert.ok(!plain.includes('shadow-ai-calibration-near-miss'));
  });

  it('dichiara gli altri scarti controfattuali solo quando sono usati', () => {
    const withRejected = {
      ...EVIDENCE,
      counts: { ...EVIDENCE.counts, rejectedMatched: 2 },
    };
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: withRejected })
    );
    assert.ok(out.includes('esiti controfattuali (altri scartati): 2 su 34'));

    const plain = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: EVIDENCE })
    );
    assert.ok(!plain.includes('shadow-ai-calibration-rejected'));
  });

  it('flag off resta vuoto anche con calibrazione disponibile', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, { flag: 'off', entries: [], calibration: EVIDENCE })
    );
    assert.equal(out, '');
  });
});

describe('ShadowAiCalibrationBlock — incertezza, copertura e policy', () => {
  const ENRICHED = {
    ...EVIDENCE,
    uncertainty: {
      confidence: 0.95,
      edgeR: { lower: 0.1, upper: 0.8 },
      winRateGapPct: { lower: 2, upper: 18 },
    },
    coverage: {
      candidates: 120,
      evaluated: 30,
      evaluatedSharePct: 25,
      parseErrorRatePct: 1.67,
    },
    policies: [{ code: 'SOLO_AZIONE', trades: 20, meanRNet: 0.44 }],
  };

  it('mostra intervallo, copertura e valore della policy', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: ENRICHED })
    );
    assert.ok(out.includes('data-testid="shadow-ai-calibration-uncertainty"'));
    assert.ok(out.includes('IC95% R netto: edgeR [0.1, 0.8]'));
    assert.ok(out.includes('divario [2, 18] punti'));
    assert.ok(out.includes('shadow-ai-calibration-coverage'));
    assert.ok(out.includes('copertura LLM: 30/120 candidati valutati (25%)'));
    assert.ok(out.includes('errori di parsing 1.67%'));
    assert.ok(out.includes('SOLO_AZIONE n=20 media 0.44'));
  });

  it('intervallo non calcolabile: lo dichiara invece di mostrare zeri', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: { ...EVIDENCE, uncertainty: { confidence: 0.95, edgeR: null } },
      })
    );
    assert.ok(out.includes('IC: non calcolabile'));
  });

  it('strato in contraddizione: nominato nel pannello', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: {
          ...EVIDENCE,
          strata: [{ dimension: 'market', value: 'US', contradicts: true }],
        },
      })
    );
    assert.ok(out.includes('strati in contraddizione: market US'));
  });
});

describe('ShadowAiCalibrationBlock — tagli per prompt e modello', () => {
  const TAGGED = {
    ...EVIDENCE,
    byPromptVersion: [
      { value: 'ai-specialize@1', matched: 20, actionN: 10, skipN: 10, edgeRNet: 0.31, contradicts: false },
      { value: 'ai-specialize@2', matched: 14, actionN: 6, skipN: 8, edgeRNet: -0.4, contradicts: true },
      { value: null, matched: 3, actionN: 1, skipN: 1, edgeRNet: null, contradicts: false },
    ],
    byModel: [
      { value: 'openrouter:m1', matched: 30, actionN: 14, skipN: 12, edgeRNet: 0.22, contradicts: false },
    ],
  };

  it('mostra i due tagli con R netto e le righe non attribuibili come n.d.', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: TAGGED })
    );
    assert.ok(out.includes('data-testid="shadow-ai-calibration-prompt-versions"'));
    assert.ok(out.includes('per prompt (R netto):'));
    assert.ok(out.includes('ai-specialize@1 n=20 edgeR=0.31'));
    assert.ok(out.includes('ai-specialize@2 n=14 edgeR=-0.4'));
    assert.ok(out.includes('n.d. n=3 edgeR=—'));
    assert.ok(out.includes('data-testid="shadow-ai-calibration-models"'));
    assert.ok(out.includes('openrouter:m1 n=30 edgeR=0.22'));
  });

  it('senza tagli non inventa righe', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: EVIDENCE })
    );
    assert.ok(!out.includes('shadow-ai-calibration-prompt-versions'));
    assert.ok(!out.includes('shadow-ai-calibration-models'));
  });

  it('ogni riga del log mostra promptVersion e model solo quando ci sono', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, {
        flag: 'on',
        entries: [
          {
            id: 'tagged',
            timestamp: '2026-11-25T09:00:00.000Z',
            ticker: 'ENI.MI',
            market: 'EU',
            direction: 'LONG',
            setup: 'ORB',
            aiOutcome: 'APPROVATO: momentum',
            aiCategory: 'orb',
            source: 'specialize',
            status: 'NON_VALIDATO',
            outcome: null,
            decision: 'AZIONE',
            promptVersion: 'ai-specialize@1',
            model: 'openrouter:m1',
          },
          {
            id: 'untagged',
            timestamp: '2026-11-25T09:05:00.000Z',
            ticker: 'ISP.MI',
            market: 'EU',
            direction: 'SHORT',
            setup: null,
            aiOutcome: 'SKIP',
            aiCategory: null,
            source: 'specialize',
            status: 'NON_VALIDATO',
            outcome: null,
            decision: 'SCARTO',
            promptVersion: null,
            model: null,
          },
        ],
        calibration: null,
      })
    );
    const versions = out.match(/shadow-ai-row-prompt-version/g) ?? [];
    const models = out.match(/shadow-ai-row-model/g) ?? [];
    assert.equal(versions.length, 1, 'solo la riga con promptVersion');
    assert.equal(models.length, 1, 'solo la riga con model');
    assert.ok(out.includes('ai-specialize@1'));
    assert.ok(out.includes('openrouter:m1'));
  });
});

describe('ShadowAiCalibrationBlock — intervallo sulla media di AZIONE (5.2)', () => {
  it('mostra media, IC e n dichiarandolo diagnostico', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: {
          ...EVIDENCE,
          uncertainty: {
            confidence: 0.95,
            avgRNet: { lower: 0.11, upper: 0.73, mean: 0.42, n: 20 },
          },
        },
      })
    );
    assert.ok(out.includes('data-testid="shadow-ai-calibration-avg-r"'));
    assert.ok(out.includes('0.42 [0.11, 0.73]'));
    assert.ok(out.includes('n 20'));
    assert.ok(out.includes('diagnostica, non entra nel verdetto'));
  });

  it('senza intervallo la riga non compare', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: { ...EVIDENCE, uncertainty: { confidence: 0.95, avgRNet: null } },
      })
    );
    assert.ok(!out.includes('data-testid="shadow-ai-calibration-avg-r"'));
  });
});

describe('ShadowAiCalibrationBlock — costo per riga (Fase 6.1)', () => {
  it('mostra costo medio e quante righe sono al tetto dichiarato', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: {
          ...EVIDENCE,
          costR: 0.36,
          costSummary: { rows: 30, perRow: 26, declared: 4, meanR: 0.2987 },
        },
      })
    );
    assert.ok(out.includes('data-testid="shadow-ai-calibration-cost"'));
    assert.ok(out.includes('costo per trade: 0.2987 R medio'));
    assert.ok(out.includes('26 righe con costo misurato'));
    assert.ok(out.includes('4 al tetto dichiarato'));
  });

  it('senza riepilogo la riga non compare', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, { calibration: EVIDENCE })
    );
    assert.ok(!out.includes('data-testid="shadow-ai-calibration-cost"'));
  });
});

describe('ShadowAiCalibrationBlock — convenienza per policy (Fase 6.2)', () => {
  it('mostra n, media, somma e quota sotto costo per ogni policy', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: {
          ...EVIDENCE,
          policies: [
            { code: 'SOLO_AZIONE', trades: 12, meanRNet: -0.21, sumRNet: -2.52, belowCostPct: 58.33 },
            { code: 'TUTTI_I_CLASSIFICATI', trades: 30, meanRNet: -0.12, sumRNet: -3.6, belowCostPct: 63.33 },
          ],
        },
      })
    );
    assert.ok(out.includes('data-testid="shadow-ai-calibration-policies"'));
    assert.ok(out.includes('SOLO_AZIONE n=12 media -0.21 · somma -2.52 · sotto costo 58.33%'));
    assert.ok(out.includes('TUTTI_I_CLASSIFICATI n=30 media -0.12 · somma -3.6 · sotto costo 63.33%'));
  });

  it('costo: dichiara quante righe stanno al pavimento della stima', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: {
          ...EVIDENCE,
          costR: 0.36,
          costSummary: { rows: 30, perRow: 30, declared: 0, meanR: 0.2889, atFloor: 20 },
        },
      })
    );
    assert.ok(out.includes('20 con spread al pavimento 0: costo limite inferiore'));
  });
});
