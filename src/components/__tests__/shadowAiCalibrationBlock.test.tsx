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

describe('ShadowAISection — calibrazione nel pannello', () => {
  it('renderizza il blocco quando i dati sono disponibili', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, { flag: 'on', entries: [], calibration: EVIDENCE })
    );
    assert.ok(out.includes('data-testid="shadow-ai-calibration"'));
    assert.ok(out.includes('edgeR: 0.42'));
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

  it('flag off resta vuoto anche con calibrazione disponibile', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, { flag: 'off', entries: [], calibration: EVIDENCE })
    );
    assert.equal(out, '');
  });
});
