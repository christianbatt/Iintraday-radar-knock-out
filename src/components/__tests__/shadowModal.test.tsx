import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShadowResearchModal } from '../ShadowResearchModal';
import { ShadowV2Section, type ShadowPanelData } from '../ShadowResearchPanel';
import ShadowV1LivePanel from '../ShadowV1LivePanel';

const FULL: ShadowPanelData = {
  available: true,
  generatedAt: '2026-11-12T02:00:00.000Z',
  sample: { nDays: 13, nSetups: 15, nClusters: 13, barMinutes: 5 },
  emissionsByDay: [{ day: '2026-10-28', candidates: 510, emitted: 6, blocked: 504, firstFailingGate: 'G8' }],
  deathCriterion: {
    status: 'not_yet_evaluable',
    trigger: { needSetups: 100, haveSetups: 15, needDays: 30, haveDays: 13 },
    nCells: 40,
    nAdmissibleCells: 0,
    alphaEffective: 0.0045,
    alphaBonferroni: null,
    reason: 'trigger non soddisfatto',
  },
  fillIntegrity: 'ok',
  rules: [{ id: 'S05', name: 'kelly', family: 'SIZING', status: 'computed', value: 0, unit: null, n: 15, note: '' }],
  spreadEstimate: { perSymbol: [{ symbol: 'BAMI', spreadPct: 0, n: 9 }], vsParametricPct: 0.1, deltaPct: -0.081, caveat: 'ordine di grandezza' },
  deflatedSharpe: { nTrials: 10, nTrialsSource: 'registry', dsr: 0, pValue: 0.5, alphaBonferroni: null, alphaEffective: 0.0045, note: '' },
  proposals: [],
  limitations: ['15 setup distinti'],
  flags: { SETUP_SELECTOR_LIVE: 'off', STALENESS_USE_MARKET_TS: 'off' },
};

describe('M1 — il pannello e’ raggiungibile dalla UI', () => {
  it('espone un trigger nella navigazione', () => {
    const out = renderToStaticMarkup(React.createElement(ShadowResearchModal, {}));
    assert.ok(out.includes('data-testid="shadow-research-trigger"'));
    assert.ok(out.includes('Shadow Research'));
    assert.ok(out.includes('<button'));
  });
});

describe('M2 — available:true mostra le sezioni (V2 inclusa)', () => {
  it('rende sample, fill, death, emissions, rules, spread, proposals', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowResearchModal, { initialOpen: true, data: FULL })
    );
    for (const s of ['sample', 'fill', 'death', 'emissions', 'rules', 'spread', 'proposals', 'shadow-v2']) {
      assert.ok(out.includes(`data-section="${s}"`), `sezione mancante: ${s}`);
    }
    assert.equal(out.includes('data-testid="shadow-error"'), false);
  });
});

describe('M5 — V1-live e V2 nella stessa modale (P7)', () => {
  it('con la costante di config accesa la modale rende V2 e V1-live insieme', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowResearchModal, { initialOpen: true, data: FULL })
    );
    assert.ok(out.includes('data-testid="shadow-v2"'));
    assert.ok(out.includes('data-testid="v1live-panel"'));
    assert.ok(out.includes('data-section="shadow-v2"'));
  });

  it('vista V1-live indisponibile (404): stato esplicito nel pannello, V2 intatta', () => {
    const panel = renderToStaticMarkup(
      React.createElement(ShadowV1LivePanel, { flag: 'on', error: 'errore di rete: HTTP 404' })
    );
    assert.match(panel, /data-testid="v1live-error"/);
    assert.match(panel, /HTTP 404/);

    const v2 = renderToStaticMarkup(React.createElement(ShadowV2Section, {}));
    assert.ok(v2.includes('data-testid="shadow-v2"'));
    assert.ok(v2.includes('data-section="shadow-v2"'));
  });
});

describe('M3 — available:false mostra “nessun artefatto”', () => {
  it('non crasha e mantiene il pannello', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowResearchModal, {
        initialOpen: true,
        data: { available: false, reason: 'nessun artefatto' },
      })
    );
    assert.ok(out.includes('nessun artefatto'));
    assert.ok(out.includes('data-testid="shadow-research-modal"'));
  });
});

describe('M4 — errore di rete: messaggio, nessun crash', () => {
  it('mostra l’errore invece del pannello', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowResearchModal, {
        initialOpen: true,
        error: 'errore di rete: impossibile leggere l’artefatto shadow',
      })
    );
    assert.ok(out.includes('errore di rete'));
    assert.ok(out.includes('data-testid="shadow-error"'));
    assert.equal(out.includes('data-section="rules"'), false);
  });

  it('evita doppio fetch di /api/shadow/latest e date hardcoded in ShadowResearchPanel', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const modalSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/components/ShadowResearchModal.tsx'),
      'utf8'
    );
    const panelSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/components/ShadowResearchPanel.tsx'),
      'utf8'
    );
    assert.ok(modalSrc.includes('v2={data?.shadowV2 ?? null}'));
    assert.ok(modalSrc.includes('diagnostics={data?.v1LiveDiagnostics ?? null}'));
    assert.equal(panelSrc.includes('2026-10-28'), false);
    assert.equal(panelSrc.includes('2026-10-29'), false);
  });
});
