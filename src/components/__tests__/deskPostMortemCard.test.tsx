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
import type { DeskEvidenceAnalysisPayload, DeskPostMortemReport } from '../../services/api';

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

describe('DeskPostMortemCard — analisi ancorata al fascicolo', () => {
  const ANCHORED: DeskEvidenceAnalysisPayload = {
    available: true,
    contractVersion: 'ai-desk@1',
    evidencePackVersion: 'ai-evidence@1',
    analysis: {
      summary: 'Sintesi',
      summaryVerified: true,
      claims: [
        {
          statement: 'Il veto di tendenza ha media negativa',
          evidenceRefs: ['veto.EU.SUPERTREND_OPPOSED.meanRMarket'],
          insufficient: false,
        },
        {
          statement: 'L edge del desk e positivo',
          evidenceRefs: ['calibration.edgeRNet'],
          insufficient: true,
        },
      ],
      dataGaps: ['copertura LLM bassa'],
      rejected: [
        { kind: 'claim', index: 2, code: 'unsupported_number', detail: '61,4%' },
        { kind: 'directive', index: 0, code: 'no_ref', detail: 'nessun riferimento' },
      ],
      complete: false,
      verified: false,
    },
    rejectedCount: 2,
    summaryVerified: true,
    evidenceKeys: 42,
    missingSections: ['shadowV1Live'],
  };

  it('mostra stato, chiavi citate, rifiuti e dati mancanti', () => {
    const html = renderToStaticMarkup(
      <DeskPostMortemCard report={report({ deskAnalysis: ANCHORED })} />
    );
    assert.ok(html.includes('data-testid="desk-anchored-analysis"'));
    assert.ok(html.includes('Analisi ancorata al fascicolo'));
    assert.ok(html.includes('non verificata'));
    assert.ok(html.includes('contratto ai-desk@1'));
    assert.ok(html.includes('42 chiavi citabili'));
    assert.ok(html.includes('sezioni mancanti: shadowV1Live'));
    assert.ok(html.includes('Il veto di tendenza ha media negativa'));
    assert.ok(html.includes('veto.EU.SUPERTREND_OPPOSED.meanRMarket'));
    assert.ok(html.includes('(campione insufficiente)'));
    assert.ok(html.includes('scartate dal validatore: 2'));
    assert.ok(html.includes('unsupported_number'));
    assert.ok(html.includes('dati mancanti o insufficienti: copertura LLM bassa'));
  });

  it('verificata quando il server lo dichiara', () => {
    const html = renderToStaticMarkup(
      <DeskPostMortemCard
        report={report({
          deskAnalysis: {
            ...ANCHORED,
            analysis: { ...ANCHORED.analysis, verified: true, rejected: [] },
          },
        })}
      />
    );
    assert.ok(html.includes('verificata'));
    assert.equal(html.includes('scartate dal validatore'), false);
  });

  it('senza analisi ancorata non inventa sezioni', () => {
    const html = renderToStaticMarkup(<DeskPostMortemCard report={report()} />);
    assert.equal(html.includes('desk-anchored-analysis'), false);
    assert.equal(html.includes('desk-anchored-unavailable'), false);
  });

  it('analisi non disponibile: una riga lo dichiara, nessuna card vuota', () => {
    const html = renderToStaticMarkup(
      <DeskPostMortemCard report={report({ deskAnalysis: { available: false, error: 'internal_error' } })} />
    );
    assert.ok(html.includes('data-testid="desk-anchored-unavailable"'));
    assert.ok(html.includes('non disponibile in questa risposta'));
    assert.equal(html.includes('desk-anchored-analysis'), false);
    assert.ok(html.includes('Sintesi delle sessioni EU.'), 'la prosa resta visibile');
  });
});
