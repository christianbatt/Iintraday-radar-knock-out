import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShadowResearchModal } from '../ShadowResearchModal';
import type { ShadowPanelData } from '../ShadowResearchPanel';

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

describe('M2 — available:true mostra le 7 sezioni', () => {
  it('rende sample, fill, death, emissions, rules, spread, proposals', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowResearchModal, { initialOpen: true, data: FULL })
    );
    for (const s of ['sample', 'fill', 'death', 'emissions', 'rules', 'spread', 'proposals']) {
      assert.ok(out.includes(`data-section="${s}"`), `sezione mancante: ${s}`);
    }
    assert.equal(out.includes('data-testid="shadow-error"'), false);
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
});
