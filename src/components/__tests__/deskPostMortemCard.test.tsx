/**
 * Test del post-mortem del desk (render statico, nessun effetto di rete).
 *
 * Requisito: quando il modello non risponde non devono comparire sezioni vuote
 * con il solo titolo. Si mostra il motivo e le metriche deterministiche.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeskPostMortemCard } from '../DeskPostMortemCard';
import type { DeskPostMortemReport } from '../../services/api';

function report(partial: Partial<DeskPostMortemReport> = {}): DeskPostMortemReport {
  return {
    executiveSummary: 'Sintesi delle sessioni EU.',
    strengths: [],
    failurePatterns: [],
    tacticalAdvice: '',
    generatedAt: '2026-11-25T10:00:00.000Z',
    ...partial,
  };
}

describe('DeskPostMortemCard — nessuna sezione vuota', () => {
  it('con array vuoti non rende i titoli delle card', () => {
    const html = renderToStaticMarkup(<DeskPostMortemCard report={report()} />);
    assert.equal(html.includes('Punti di Forza'), false);
    assert.equal(html.includes('Pattern di Errore'), false);
    assert.equal(html.includes('Raccomandazione Tattica'), false);
    assert.ok(html.includes('Sintesi delle sessioni EU.'));
  });

  it('con modello non disponibile mostra motivo e metriche, mai card vuote', () => {
    const html = renderToStaticMarkup(
      <DeskPostMortemCard
        report={report({
          llmUnavailable: true,
          executiveSummary: 'LLM non disponibile: riepilogo deterministico delle sessioni EU.',
          tacticalAdvice: 'Rilanciare il post-mortem quando il modello AI e disponibile.',
          metrics: {
            total: 12,
            wins: 6,
            losses: 4,
            breakevens: 1,
            expired: 1,
            winRatePct: 60,
            netPnlEur: 123.4,
            avgR: 0.35,
          },
        })}
      />
    );
    assert.ok(html.includes('non ha risposto'));
    assert.ok(html.includes('60.0%'));
    assert.ok(html.includes('123.40'));
    assert.ok(html.includes('0.35R'));
    assert.equal(html.includes('Punti di Forza'), false);
    assert.equal(html.includes('Pattern di Errore'), false);
  });

  it('con contenuto reale rende entrambe le card', () => {
    const html = renderToStaticMarkup(
      <DeskPostMortemCard
        report={report({
          strengths: ['Disciplina sugli stop'],
          failurePatterns: ['Ingressi tardivi'],
          tacticalAdvice: 'Attendere la chiusura ORB.',
        })}
      />
    );
    assert.ok(html.includes('Punti di Forza'));
    assert.ok(html.includes('Disciplina sugli stop'));
    assert.ok(html.includes('Pattern di Errore'));
    assert.ok(html.includes('Ingressi tardivi'));
    assert.ok(html.includes('Raccomandazione Tattica'));
    assert.equal(html.includes('non ha risposto'), false);
  });

  it('ignora stringhe vuote dentro gli array', () => {
    const html = renderToStaticMarkup(
      <DeskPostMortemCard report={report({ strengths: ['', 'Solo questa'], failurePatterns: ['  '] })} />
    );
    assert.ok(html.includes('Punti di Forza'));
    assert.ok(html.includes('Solo questa'));
    assert.equal(html.includes('Pattern di Errore'), false);
  });

  it('mostra il conteggio delle direttive solo se positivo', () => {
    const zero = renderToStaticMarkup(<DeskPostMortemCard report={report()} directivesAdded={0} />);
    assert.equal(zero.includes('nuove direttive qualitative'), false);
    const two = renderToStaticMarkup(<DeskPostMortemCard report={report()} directivesAdded={2} />);
    assert.ok(two.includes('2 nuove direttive qualitative'));
  });
});
