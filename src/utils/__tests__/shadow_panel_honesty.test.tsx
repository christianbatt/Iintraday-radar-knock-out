import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ShadowResearchPanel, { type ShadowPanelData } from '../../components/ShadowResearchPanel';

/**
 * Sessione D — onestà del pannello Shadow V2 (sola UI, sola lettura).
 *
 * I test bloccano le proprietà che rendono il pannello non ingannevole:
 * non è un segnale operativo, ogni p-value ha accanto il proprio n,
 * i limiti forniti dai dati sono visibili, i dati assenti non producono
 * numeri di default, e nessuna dicitura promette un edge.
 */

const LIMITS = [
  'Motore sperimentale: parametri IPOTESI non ancora validati out-of-sample.',
  'Spread stimato via proxy Corwin-Schultz, nessun book L2 reale.',
  'Nessuna promozione automatica al selettore live.',
];

/** Riepilogo Shadow V2 con campi realmente presenti in artifacts/shadow_v2/summary.json. */
function baseV2(over: Record<string, unknown> = {}): NonNullable<ShadowPanelData['shadowV2']> {
  return {
    nSessions: 12,
    nSignals: 40,
    nResolved: 31,
    nOpen: 4,
    nPendingOpen: 2,
    nBlocked: 3,
    wins: 18,
    losses: 13,
    koHits: 2,
    timeouts: 1,
    winRatePct: 58.1,
    meanRGross: 0.42,
    meanRNet: 0.31,
    medianFrictionR: 0.11,
    medianFrictionR2500: 0.07,
    profitFactor: 1.4,
    maxDrawdownR: 2.2,
    dsr: 0.12,
    clusterBootstrapPValue: 0.0731,
    nDayClusters: 12,
    limitations: LIMITS,
    hypotheses: { BOOTSTRAP_ITERATIONS: 2000, BOOTSTRAP_SEED: 20261116 },
    recentSignals: [],
    ...over,
  };
}

function panel(over: Partial<ShadowPanelData> = {}): string {
  const data: ShadowPanelData = {
    available: true,
    sample: { nDays: 40, nSetups: 50, nClusters: 40, barMinutes: 5 },
    fillIntegrity: 'ok',
    shadowV2: baseV2(),
    ...over,
  };
  return renderToStaticMarkup(React.createElement(ShadowResearchPanel, { data }));
}

describe('C1 — disclaimer: ricerca esplorativa, non segnale operativo', () => {
  it('è presente con dati completi, con shadowV2 assente, con zero segnali e con artefatto nullo', () => {
    const variants = [
      panel(),
      panel({ shadowV2: null }),
      panel({ shadowV2: baseV2({ nSignals: 0, nResolved: 0 }) }),
      renderToStaticMarkup(React.createElement(ShadowResearchPanel, { data: null })),
    ];
    for (const html of variants) {
      assert.ok(html.includes('non è un segnale operativo'), 'disclaimer assente');
      assert.ok(html.includes('nessun edge è dimostrato'), 'manca la dichiarazione di assenza di edge');
      assert.ok(html.includes('data-testid="shadow-v2-disclaimer"'));
    }
  });
});

describe('C2 — ogni p-value mostrato è accompagnato da n', () => {
  it('il cluster bootstrap p porta accanto il numero di trade risolti', () => {
    const html = panel();
    const parts = html.split('0.0731');
    assert.ok(parts.length > 1, 'p-value del bootstrap non renderizzato');
    for (const tail of parts.slice(1)) {
      assert.ok(tail.slice(0, 80).includes('n=31'), `p-value senza n accanto: "${tail.slice(0, 60)}"`);
    }
  });

  it('anche il p-value del confronto V1/V2 è accompagnato da n', () => {
    const html = panel();
    const parts = html.split('0.5000');
    for (const tail of parts.slice(1)) {
      assert.ok(tail.slice(0, 40).includes('n='), `p-value V1 senza n: "${tail.slice(0, 40)}"`);
    }
  });
});

describe('C3 — i limiti forniti dai dati sono tutti visibili', () => {
  it('rende ogni stringa di shadowV2.limitations, senza accorciarla', () => {
    const html = panel();
    for (const l of LIMITS) {
      assert.ok(html.includes(l), `limite non visibile: ${l}`);
    }
    assert.ok(html.includes('data-testid="shadow-v2-limits"'));
  });

  it('non inventa una sezione limiti quando i dati non ne forniscono', () => {
    const html = panel({ shadowV2: baseV2({ limitations: [] }) });
    assert.equal(html.includes('data-testid="shadow-v2-limits"'), false);
  });
});

describe('C4 — dati vuoti o assenti: nessun valore di default presentato come risultato', () => {
  it('zero segnali: messaggio esplicito e nessun numero di default', () => {
    const html = panel({
      shadowV2: baseV2({
        nSignals: 0,
        nResolved: 0,
        winRatePct: null,
        meanRNet: null,
        dsr: null,
        clusterBootstrapPValue: null,
        nDayClusters: 0,
      }),
    });
    assert.ok(html.includes('In attesa di segnali reali'));
    // "n=0 risolti" nei limiti è un conteggio reale: qui si vieta un default che sembri una metrica.
    for (const bad of ['0 cl.', 'NaN', 'undefined', '0.0%', '0.000']) {
      assert.equal(html.includes(bad), false, `valore di default mostrato: ${bad}`);
    }
    assert.equal(html.includes('Cluster Bootstrap p'), false);
    assert.equal(html.includes('Mean R Lordo / Netto'), false);
  });

  it('shadowV2 assente: solo il messaggio, nessuna metrica', () => {
    const html = panel({ shadowV2: null });
    assert.ok(html.includes('In attesa di segnali reali'));
    assert.equal(html.includes('Cluster Bootstrap p'), false);
    assert.equal(html.includes('NaN'), false);
  });

  it('integrità del fill non disponibile: nessun "0 violazioni" dichiarato', () => {
    const html = panel({ fillIntegrity: 'unknown' });
    assert.ok(html.includes('data-testid="shadow-fill-unknown"'));
    assert.equal(html.includes('0 violazioni'), false);
  });
});

describe('C5 — nessuna dicitura di evidenza, edge o raccomandazione', () => {
  it('non contiene le diciture vietate', () => {
    const html = panel();
    for (const f of ['AI learned memory', 'edge confermato', 'raccomandazione operativa']) {
      assert.equal(html.includes(f), false, `dicitura vietata: ${f}`);
    }
    assert.equal(/edge\s+(dimostrato|provato|confermato)/i.test(html), false);
  });

  it('la parola "segnale" compare solo nella negazione del disclaimer', () => {
    const html = panel();
    const total = (html.match(/segnale/g) ?? []).length;
    const negated = (html.match(/non è un segnale operativo/g) ?? []).length;
    assert.ok(total > 0, 'disclaimer non renderizzato');
    assert.equal(total, negated, '"segnale" usato fuori dal disclaimer negativo');
  });
});

describe('C6 — soglia di campione ridotto già esistente (nDays/nClusters < 30)', () => {
  it('sotto soglia mostra il banner di campione insufficiente', () => {
    const html = panel({ sample: { nDays: 12, nSetups: 40, nClusters: 12, barMinutes: 5 } });
    assert.ok(html.includes('campione insufficiente per inferenza'));
  });

  it('sopra soglia non mostra il banner', () => {
    const html = panel({ sample: { nDays: 40, nSetups: 50, nClusters: 40, barMinutes: 5 } });
    assert.equal(html.includes('campione insufficiente per inferenza'), false);
  });
});

describe('C7 — riepilogo in parole semplici con equivalenti in Euro', () => {
  it('mostra gli equivalenti in Euro su shadowV2 valorizzato e li nasconde a zero segnali', () => {
    const populated = panel();
    assert.ok(populated.includes('data-testid="shadow-v2-plain-summary"'));
    assert.ok(populated.includes('In parole semplici'));
    assert.ok(populated.includes('€'));

    const empty = panel({
      shadowV2: baseV2({
        nSignals: 0,
        nResolved: 0,
        winRatePct: null,
        meanRGross: null,
        meanRNet: null,
        dsr: null,
        clusterBootstrapPValue: null,
        nDayClusters: 0,
      }),
    });
    assert.equal(empty.includes('data-testid="shadow-v2-plain-summary"'), false);
  });
});
