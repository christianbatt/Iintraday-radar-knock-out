import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ShadowAISection from '../ShadowAISection';

describe('ShadowAISection — flag', () => {
  it('flag off: non renderizza nulla', () => {
    const out = renderToStaticMarkup(React.createElement(ShadowAISection, { flag: 'off' }));
    assert.equal(out, '');
  });

  it('flag on: renderizza sezione', () => {
    const out = renderToStaticMarkup(React.createElement(ShadowAISection, { flag: 'on', entries: [] }));
    assert.ok(out.includes('data-testid=\"shadow-ai-section\"'));
    assert.ok(out.includes('NON VALIDATO') === false || out.includes('shadow-ai-empty'));
  });
});

describe('ShadowAISection — nuovi casi', () => {
  it('flag off: non renderizza e non fa fetch', () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return { ok: true, json: async () => ({ entries: [] }) } as any;
    };
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, { flag: 'off', fetchImpl })
    );
    assert.equal(out, '');
    assert.equal(called, false);
  });

  it('stato caricamento', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, { flag: 'on', loading: true, entries: null })
    );
    assert.ok(out.includes('data-testid=\"shadow-ai-loading\"'));
  });

  it('stato errore', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, { flag: 'on', error: 'boom', entries: null })
    );
    assert.ok(out.includes('data-testid=\"shadow-ai-error\"'));
    assert.ok(out.includes('boom'));
  });

  it('stato vuoto', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, { flag: 'on', entries: [] })
    );
    assert.ok(out.includes('data-testid=\"shadow-ai-empty\"'));
  });

  it('stato dati: mostra NON VALIDATO e conteggi', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, {
        flag: 'on',
        entries: [
          { id: '1', timestamp: 't', ticker: 'AAA', market: 'EU', direction: 'LONG', setup: 'X', aiOutcome: 'd', aiCategory: 'C', source: 'specialize', status: 'NON_VALIDATO', outcome: null, discarded: false, discardReason: null },
          { id: '2', timestamp: 't', ticker: 'BBB', market: 'US', direction: null, setup: 'Y', aiOutcome: 'e', aiCategory: 'D', source: 'desk', status: 'NON_VALIDATO', outcome: null, discarded: true, discardReason: 'shape: missing topic' },
        ],
      })
    );
    assert.ok(out.includes('NON VALIDATO'));
    assert.ok(out.includes('data-testid=\"shadow-ai-list\"'));
    assert.ok(out.includes('scartate: 1'));
    assert.ok(out.includes('esiti noti: 0'));
  });
});