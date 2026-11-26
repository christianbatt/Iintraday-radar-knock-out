import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ShadowAISection from '../ShadowAISection';

const BASE = {
  id: 'x',
  timestamp: '2026-11-25T09:00:00.000Z',
  ticker: 'ENI.MI',
  market: 'EU',
  direction: 'LONG',
  setup: 'scan score 70/100',
  aiOutcome: 'BUY',
  aiCategory: null,
  source: 'scan' as const,
  status: 'NON_VALIDATO' as const,
  outcome: null,
};

const DECISION_CELL = /data-testid="shadow-ai-row-decision"[^>]*>([^<]*)</g;

function decisionsIn(out: string): string[] {
  return [...out.matchAll(DECISION_CELL)].map((match) => match[1].trim());
}

describe('ShadowAISection — decision accanto a ogni riga', () => {
  it('mostra il valore chiuso scritto dall\'handler', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, {
        flag: 'on',
        entries: [{ ...BASE, id: 'a', decision: 'AZIONE' }],
      })
    );
    assert.deepEqual(decisionsIn(out), ['AZIONE']);
  });

  it('mostra "—" quando decision e\' null o assente', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, {
        flag: 'on',
        entries: [
          { ...BASE, id: 'b', ticker: 'ISP.MI', decision: null },
          { ...BASE, id: 'c', ticker: 'TSLA', market: 'US' },
        ],
      })
    );
    assert.deepEqual(decisionsIn(out), ['—', '—']);
  });

  it('una riga per ogni voce, anche con decisioni miste', () => {
    const out = renderToStaticMarkup(
      React.createElement(ShadowAISection, {
        flag: 'on',
        entries: [
          { ...BASE, id: 'd', decision: 'ATTESA' },
          { ...BASE, id: 'e', ticker: 'ISP.MI', decision: 'SCARTO' },
          { ...BASE, id: 'f', ticker: 'TSLA', market: 'US' },
        ],
      })
    );
    assert.deepEqual(decisionsIn(out), ['ATTESA', 'SCARTO', '—']);
  });
});
