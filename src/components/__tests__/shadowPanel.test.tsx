import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ShadowResearchPanel, { type ShadowPanelData } from '../ShadowResearchPanel';

function base(over: Partial<ShadowPanelData> = {}): ShadowPanelData {
  return {
    available: true,
    generatedAt: '2026-11-12T02:00:00.000Z',
    sample: { nDays: 30, nSetups: 123, nClusters: 13, barMinutes: 5 },
    emissionsByDay: [
      { day: '2026-10-28', candidates: 510, emitted: 6, blocked: 504, firstFailingGate: 'G8' },
      { day: '2026-11-03', candidates: 512, emitted: 2, blocked: 510, firstFailingGate: 'G8' },
    ],
    deathCriterion: {
      status: 'not_yet_evaluable',
      trigger: { needSetups: 100, haveSetups: 123, needDays: 30, haveDays: 13 },
      nCells: 40,
      nAdmissibleCells: 0,
      alphaEffective: 0.0063,
      alphaBonferroni: 0.0005,
      reason: 'trigger non soddisfatto',
    },
    fillIntegrity: 'ok',
    rules: [
      { id: 'S04', name: 'deflatedSharpe', family: 'INFERENZA', status: 'computed', value: 0, unit: 'ratio', n: 123, note: '' },
      { id: 'S05', name: 'kelly', family: 'SIZING', status: 'computed', value: 0, unit: 'frazione', n: 123, note: '' },
      { id: 'S11', name: 'permutationGross', family: 'INFERENZA', status: 'computed', value: 0.0005, unit: 'p', n: 123, note: '' },
      { id: 'S06', name: 'coverage', family: 'QUALITA', status: 'missing_input', value: null, unit: null, n: null, note: '' },
    ],
    spreadEstimate: {
      perSymbol: [{ symbol: 'BAMI', spreadPct: 0, n: 9 }],
      vsParametricPct: 0.1,
      deltaPct: -0.081,
      caveat: 'ordine di grandezza, non un costo realizzato',
    },
    deflatedSharpe: {
      nTrials: 7,
      nTrialsSource: 'registry/ai_registry.jsonl',
      dsr: 0,
      pValue: 0.5,
      alphaBonferroni: 0.0005,
      alphaEffective: 0.0063,
      note: '',
    },
    proposals: [],
    limitations: ['campione di 30 giorni'],
    flags: { SETUP_SELECTOR_LIVE: 'off', STALENESS_USE_MARKET_TS: 'off' },
    ...over,
  };
}

function html(data: ShadowPanelData | null): string {
  return renderToStaticMarkup(React.createElement(ShadowResearchPanel, { data }));
}

describe('R1 — artefatto completo: le 7 sezioni presenti', () => {
  it('mostra sample, fill, death, emissions, rules, spread, proposals', () => {
    const out = html(base());
    for (const s of ['sample', 'fill', 'death', 'emissions', 'rules', 'spread', 'proposals']) {
      assert.ok(out.includes(`data-section="${s}"`), `sezione mancante: ${s}`);
    }
    assert.ok(out.includes('2026-10-28'));
    assert.ok(out.includes('non interpretabile'));
  });
});

describe('R2 — artefatto assente: banner e nessun crash', () => {
  it('dichiara nessun artefatto', () => {
    const out = html(null);
    assert.ok(out.includes('nessun artefatto'));
    assert.equal(out.includes('data-section="rules"'), false);
  });
});

describe('R3 — nDays < 30: banner in stato avviso', () => {
  it('scrive campione insufficiente per inferenza', () => {
    const out = html(base({ sample: { nDays: 12, nSetups: 40, nClusters: 9, barMinutes: 5 } }));
    assert.ok(out.includes('campione insufficiente per inferenza'));
    assert.ok(out.includes('12 giorni · 40 setup · 9 cluster · barre a 5 minuti'));
  });
});

describe('R4 — zero proposte', () => {
  it('scrive nessuna proposta formulata', () => {
    assert.ok(html(base({ proposals: [] })).includes('nessuna proposta formulata'));
  });
});

describe('R5 — insufficient_holdout distinto da rejected', () => {
  it('etichetta own-label e non respinta', () => {
    const out = html(
      base({
        proposals: [
          {
            hypothesisId: 'AI-0007',
            status: 'insufficient_holdout',
            holdoutN: 4,
            meanRHoldout: 0.31,
            meanRNullP95: 0.44,
            alphaEffective: 0.0063,
            beatsNull: null,
            nullReason: 'n holdout sotto la soglia dichiarata',
            verdict: 'insufficient_holdout',
          },
        ],
      })
    );
    assert.ok(out.includes('holdout insufficiente'));
    assert.equal(out.includes('respinta'), false);
    assert.ok(out.includes('n holdout sotto la soglia dichiarata'));
  });
});

describe('R6 — fillIntegrity suspect: sezione 2 in testa con il warning', () => {
  it('avverte che gli R vanno riletti e la sezione fill precede death', () => {
    const out = html(base({ fillIntegrity: 'suspect' }));
    assert.ok(out.includes('gli R di questa superficie sono da rileggere'));
    const iFill = out.indexOf('data-section="fill"');
    const iDeath = out.indexOf('data-section="death"');
    const iSample = out.indexOf('data-section="sample"');
    assert.ok(iSample < iFill && iFill < iDeath);
  });
});

describe('R7 — nessun punteggio composito', () => {
  it('nessun attributo di score e nessuna parola di affidabilità', () => {
    const out = html(base());
    assert.equal(/data-(score|quality|rating)/.test(out), false);
    assert.equal(/punteggio|affidabilit|badge/i.test(out), false);
    assert.equal(out.includes('PROMOTE'), true);
    assert.ok(out.includes('disabled'));
  });
});

/**
 * R8 — confronto V1 vs V2: nessun valore mal etichettato (PR "onestà del confronto").
 * V1 non pubblica un R netto aggregato né un win rate: S01 è la quota di etichette
 * UPPER di tripleBarrierLabels, non un multiplo di rischio.
 */
describe('R8 — confronto V1/V2 senza valori mal etichettati', () => {
  const s01 = {
    id: 'S01',
    name: 'tripleBarrierLabels',
    family: 'STIMATORE',
    status: 'computed',
    value: 0.17886178861788618,
    unit: 'share UPPER',
    n: 123,
    note: '',
  };

  const withS01 = (over: Partial<ShadowPanelData> = {}): ShadowPanelData =>
    base({ rules: [s01, ...(base().rules ?? [])], ...over });

  const paired = (out: string): string => {
    const i = out.indexOf('data-testid="shadow-v1-vs-v2"');
    return i < 0 ? '' : out.slice(i);
  };

  const cellText = (out: string, testid: string): string => {
    const m = new RegExp(`data-testid="${testid}">([^<]*)<`).exec(out);
    return m === null ? '' : m[1].trim();
  };

  it('T1: la cella V1 Mean R Netto non mostra S01 e non ha suffisso R', () => {
    const out = html(withS01());
    const v1VsV2 = paired(out);
    assert.ok(v1VsV2.length > 0, 'sezione di confronto assente');
    assert.equal(v1VsV2.includes('0.179R'), false, 'S01 presentato come R');
    assert.equal(v1VsV2.includes('0.1789'), false, 'valore di S01 dentro il confronto');
    // l'apostrofo è escapato da renderToStaticMarkup: si asserisce sul prefisso
    assert.ok(v1VsV2.includes('V1 non produce un R netto aggregato nell'));
    assert.ok(v1VsV2.includes('V1 non produce un win rate nell'));
    // il valore di S01 resta visibile solo nella tabella delle regole, non qui
    assert.ok(out.includes('0.1789'), 'il valore S01 deve restare visibile nella sezione regole');
  });

  it('T2: il delta della riga Mean R Netto è n/d', () => {
    const out = html(withS01());
    assert.equal(cellText(out, 'shadow-v1-meanr-delta'), 'n/d');
    assert.equal(/[-+]?0\.\d+R/.test(cellText(out, 'shadow-v1-meanr-delta')), false);
  });

  it('T3: i due p-value sono etichettati come test diversi e il delta non è calcolato', () => {
    const out = html(withS01());
    assert.ok(out.includes('p-value DSR (V1) vs p-value cluster (V2)'));
    assert.ok(out.includes('(DSR · n='));
    assert.ok(out.includes('(cluster · n='));
    assert.ok(out.includes('test diversi, non confrontabili'));
    assert.equal(cellText(out, 'shadow-pval-delta'), 'n/d');
  });

  it('T4: l\'avviso di non omogeneità è presente', () => {
    const out = html(withS01());
    assert.ok(out.includes('data-testid="shadow-v1-vs-v2-warning"'));
    assert.ok(
      out.includes(
        'Confronto non omogeneo: V1 e V2 hanno popolazioni e metodi di misura diversi. Differenza numerica esplorativa, nessun vincitore.'
      )
    );
  });

  it('T5: la riga Campione dichiara che V1 è popolazione di replay storico', () => {
    const out = html(withS01());
    assert.ok(out.includes('popolazione di replay storico (non i trade live)'));
    assert.ok(out.includes('data-testid="shadow-v1-population-note"'));
    assert.ok(out.includes('123 / 30g'), 'il campione V1 usa solo i campi già presenti');
  });

  it('T6: con artefatto V1 assente il comportamento resta invariato', () => {
    const out = html(null);
    assert.ok(out.includes('nessun artefatto'));
    assert.ok(out.includes('Artefatto V1 assente'));
    assert.equal(out.includes('data-section="rules"'), false);
    assert.ok(out.includes('data-testid="shadow-v1-vs-v2-warning"'));
  });
});
