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
  counts: { matched: 34 },
  buckets: [
    { decision: 'AZIONE', n: 20 },
    { decision: 'ATTESA', n: 4 },
    { decision: 'SCARTO', n: 10 },
  ],
  skippedWinners: [{ ticker: 'ISP.MI' }, { ticker: 'UCG.MI' }],
};

const INSUFFICIENT = {
  available: true,
  verdict: 'insufficient' as const,
  edgeR: null,
  minSample: 30,
  counts: { matched: 3 },
  buckets: [
    { decision: 'AZIONE', n: 0 },
    { decision: 'ATTESA', n: 1 },
    { decision: 'SCARTO', n: 2 },
  ],
  skippedWinners: [],
};

describe('ShadowAiCalibrationBlock — render', () => {
  it('mostra campione, bucket, edgeR e scarti andati in positivo', () => {
    const out = renderToStaticMarkup(React.createElement(ShadowAiCalibrationBlock, { calibration: EVIDENCE }));
    assert.ok(out.includes('data-testid="shadow-ai-calibration"'));
    assert.ok(out.includes('campione sufficiente'));
    assert.ok(out.includes('abbinate: 34 / min 30'));
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
    assert.ok(out.includes('edgeR: non calcolabile'));
    assert.ok(out.includes('(non un risultato)'));
    assert.ok(!out.includes('scarti andati in positivo'));
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
