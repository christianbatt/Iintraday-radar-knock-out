/**
 * Test del pannello SHADOW V1 LIVE (PR D2), sola lettura.
 *
 * Render statico con `react-dom/server`: nessun effetto, nessuna richiesta di
 * rete reale, nessun file toccato. I dati sono iniettati.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ShadowV1LivePanel, {
  type ShadowV1LiveV2Summary,
} from '../ShadowV1LivePanel';
import {
  SHADOW_V1_LIVE_VIEW_PANEL,
  isShadowV1LivePanelEnabled,
} from '../../config/shadowV1LiveView';
import type {
  ShadowV1LiveViewRecord,
  ShadowV1LiveViewResponse,
} from '../../server/shadowV1LiveView';

const NOW = Date.UTC(2026, 2, 16, 21, 0, 0);

function row(over: Partial<ShadowV1LiveViewRecord> & { key: string }): ShadowV1LiveViewRecord {
  return {
    ticker: 'AAPL',
    market: 'US',
    direction: 'LONG',
    status: 'OPEN',
    decidedAtMs: NOW - 3 * 60 * 60 * 1000,
    sessionCloseMs: NOW + 60 * 60 * 1000,
    stale: false,
    delayMs: 0,
    late: false,
    r: null,
    fillBarTs: null,
    exitBarTs: null,
    exitPrice: null,
    updatedAtMs: NOW - 3 * 60 * 60 * 1000,
    ...over,
  };
}

function view(over: Partial<ShadowV1LiveViewResponse> = {}): ShadowV1LiveViewResponse {
  return {
    available: true,
    generatedAt: new Date(NOW).toISOString(),
    source: 'artifacts/shadow_v1_live/signals.jsonl',
    storeVersion: 1,
    lateThresholdMs: 600_000,
    limit: 500,
    truncated: false,
    skippedLines: 0,
    counts: {
      persisted: 3,
      pendingFill: 0,
      open: 1,
      stop: 1,
      target: 1,
      expired: 0,
      notFilled: 0,
      nonTerminal: 1,
      terminal: 2,
      stale: 1,
    },
    metrics: {
      resolved: 2,
      meanR: 0.5,
      winRatePct: 50,
      sumR: 1,
      maxDrawdownR: 1,
      nLate: 1,
      nResolvedAll: 3,
      nDelayUnavailable: 0,
      note: 'Esplorativo: R di prezzo del nucleo V1-live, senza costi ne\' leva.',
    },
    records: [
      row({ key: 'a', status: 'OPEN', stale: true }),
      row({ key: 'b', status: 'STOP', r: -1, exitBarTs: NOW - 2 * 60 * 60 * 1000 }),
      row({ key: 'c', status: 'TARGET', r: 2, ticker: 'MSFT', delayMs: 900_000, late: true }),
    ],
    limitations: ['Sola lettura.'],
    ...over,
  };
}

const V2: ShadowV1LiveV2Summary = {
  nSignals: 40,
  nResolved: 7,
  meanRGross: 0.123,
  meanRNet: -0.011,
  winRatePct: 42.9,
};

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('ShadowV1LivePanel — flag', () => {
  it('default ON (P7) e nessun markup a flag OFF esplicito', () => {
    assert.equal(SHADOW_V1_LIVE_VIEW_PANEL, 'on');
    assert.equal(isShadowV1LivePanelEnabled('off'), false);
    assert.equal(isShadowV1LivePanelEnabled('on'), true);

    assert.equal(
      html(<ShadowV1LivePanel data={view()} v2={V2} flag="off" />),
      ''
    );
  });

  it('flag ON rende il pannello marcato sola lettura', () => {
    const out = html(<ShadowV1LivePanel data={view()} v2={V2} flag="on" />);
    assert.match(out, /data-testid="v1live-panel"/);
    assert.match(out, /sola lettura/);
    assert.match(out, /esplorativo/);
  });
});

describe('ShadowV1LivePanel — stati', () => {
  it('loading', () => {
    const out = html(<ShadowV1LivePanel flag="on" loading />);
    assert.match(out, /data-testid="v1live-loading"/);
    assert.match(out, /caricamento/);
  });

  it('errore HTTP o di rete', () => {
    const out = html(<ShadowV1LivePanel flag="on" error="errore di rete: HTTP 500" />);
    assert.match(out, /data-testid="v1live-error"/);
    assert.match(out, /HTTP 500/);
  });

  it('vista non disponibile con motivo dichiarato', () => {
    const out = html(
      <ShadowV1LivePanel
        flag="on"
        data={view({ available: false, reason: 'nessun file persistito', records: [], counts: {
          persisted: 0, pendingFill: 0, open: 0, stop: 0, target: 0, expired: 0,
          notFilled: 0, nonTerminal: 0, terminal: 0, stale: 0,
        } })}
      />
    );
    assert.match(out, /data-testid="v1live-unavailable"/);
    assert.match(out, /nessun file persistito/);
    assert.match(out, /data-testid="v1live-empty"/);
  });

  it('nessun dato senza errore', () => {
    const out = html(<ShadowV1LivePanel flag="on" data={null} />);
    assert.match(out, /data-testid="v1live-panel"/);
    assert.doesNotMatch(out, /data-testid="v1live-row"/);
  });

  it('dati parziali: troncamento e righe ignorate dichiarati', () => {
    const out = html(
      <ShadowV1LivePanel
        flag="on"
        data={view({ truncated: true, limit: 500, skippedLines: 4 })}
      />
    );
    assert.match(out, /data-testid="v1live-truncated"/);
    assert.match(out, /troncata, non completa/);
    assert.match(out, /Righe ignorate/);
    assert.match(out, />4</);
  });
});

describe('ShadowV1LivePanel — record e stati', () => {
  it('una riga per record, etichette di stato e R solo dove esiste', () => {
    const out = html(<ShadowV1LivePanel data={view()} flag="on" />);
    const rows = out.match(/data-testid="v1live-row"/g) ?? [];
    assert.equal(rows.length, 3);
    assert.match(out, /aperto/);
    assert.match(out, /stop/);
    assert.match(out, /target/);
    assert.match(out, /-1\.00R/);
    assert.match(out, /2\.00R/);
    assert.match(out, /MSFT/);
    assert.equal((out.match(/—/g) ?? []).length, 1, 'solo il record senza esito ha trattino');
  });

  it('stale mostrato solo dove il server lo dichiara', () => {
    const out = html(<ShadowV1LivePanel data={view()} flag="on" />);
    assert.equal((out.match(/data-testid="v1live-stale"/g) ?? []).length, 1);
  });

  it('nessun record persistito', () => {
    const out = html(
      <ShadowV1LivePanel
        flag="on"
        data={view({ records: [], counts: {
          persisted: 0, pendingFill: 0, open: 0, stop: 0, target: 0, expired: 0,
          notFilled: 0, nonTerminal: 0, terminal: 0, stale: 0,
        }, metrics: { ...view().metrics, resolved: 0, meanR: null, winRatePct: null, sumR: null, maxDrawdownR: null } })}
      />
    );
    assert.match(out, /data-testid="v1live-empty"/);
    assert.match(out, /n\/d/);
  });

  it('le metriche mostrate sono quelle del server, non ricalcolate', () => {
    const out = html(
      <ShadowV1LivePanel
        flag="on"
        data={view({ metrics: { ...view().metrics, meanR: 9.99, resolved: 42 } })}
      />
    );
    assert.match(out, /9\.990R/);
    assert.match(out, /n=42/);
    assert.doesNotMatch(out, /0\.500R/);
  });
});

describe('ShadowV1LivePanel — confronto V1/V2', () => {
  it('dichiara il confronto quantitativo non disponibile e mostra i campioni separati', () => {
    const out = html(<ShadowV1LivePanel data={view()} v2={V2} flag="on" />);
    assert.match(out, /data-testid="v1live-nocompare"/);
    assert.match(out, /non disponibile/);
    assert.match(out, /ingresso V1 al tocco/);
    assert.match(out, /n=2 record con esito/);
    assert.match(out, /n=7 risolti su 40 segnali/);
    assert.match(out, /0\.123R/);
    assert.match(out, /-0\.011R/);
  });

  it('non espone alcun delta o rapporto derivato tra le due popolazioni', () => {
    const out = html(<ShadowV1LivePanel data={view()} v2={V2} flag="on" />);
    for (const forbidden of ['Delta', 'Differenza', 'Δ', 'differenza', 'rapporto R']) {
      assert.equal(out.includes(forbidden), false, `non deve comparire ${forbidden}`);
    }
  });

  it('senza dati V2 resta il divieto di confronto e i valori diventano n/d', () => {
    const out = html(<ShadowV1LivePanel data={view()} v2={null} flag="on" />);
    assert.match(out, /non disponibile/);
    assert.match(out, /n=0 risolti su 0 segnali/);
    assert.match(out, /n\/d/);
  });
});

describe('ShadowV1LivePanel — aggiornamento e campi', () => {
  it('in modalita live offre il comando di aggiornamento; con dati iniettati no', () => {
    const live = html(<ShadowV1LivePanel flag="on" loading />);
    assert.match(live, /data-testid="v1live-refresh"/);
    assert.match(live, /Aggiorna/);

    const injected = html(<ShadowV1LivePanel flag="on" data={view()} />);
    assert.doesNotMatch(injected, /data-testid="v1live-refresh"/);
  });

  it('a flag OFF non parte alcuna richiesta: guardia prima di ogni fetch', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/components/ShadowV1LivePanel.tsx'),
      'utf8'
    );
    const guard = src.indexOf('if (!enabled || !live) return;');
    const fetchUse = src.indexOf('const doFetch = fetchImpl ?? fetch;');
    assert.ok(guard > 0, 'la guardia del flag deve esistere nell\'effect');
    assert.ok(fetchUse > guard, 'nessun fetch prima della guardia del flag');
    assert.equal(
      (src.match(/fetchImpl \?\? fetch/g) ?? []).length,
      1,
      'un solo punto di accesso alla rete'
    );
  });

  it('non mostra livelli o campi non previsti dalla vista', () => {
    const out = html(<ShadowV1LivePanel data={view()} flag="on" />);
    for (const hidden of ['entryPrice', 'stopPrice', 'target1', 'moduleVersion', 'reason:']) {
      assert.equal(out.includes(hidden), false, `non deve comparire ${hidden}`);
    }
  });
});

describe('ShadowV1LivePanel — ritardo di osservazione', () => {
  it('mostra la colonna ritardo, il marcatore late e i due conteggi', () => {
    const out = html(<ShadowV1LivePanel data={view()} v2={V2} flag="on" />);
    assert.match(out, /ritardo/);
    assert.match(out, /data-testid="v1live-late"/);
    assert.match(out, /15m/, 'ritardo in minuti arrotondato');
    assert.match(out, /0m/, 'ritardo nullo mostrato');
    assert.match(out, /data-testid="v1live-late-note"/);
    assert.match(out, /escludendo i record in ritardo di osservazione/);
    assert.match(out, /inclusi 2, esclusi 1/);
    assert.match(out, /su 3 con\s+esito|su 3 con esito/);
    assert.match(out, /&gt; 10 min/);
  });

  it('senza record late il conteggio esclusi e zero', () => {
    const out = html(
      <ShadowV1LivePanel
        flag="on"
        data={view({
          metrics: { ...view().metrics, nLate: 0, nResolvedAll: 2 },
          records: [row({ key: 'a', status: 'STOP', r: -1 })],
        })}
      />
    );
    assert.match(out, /inclusi 2, esclusi 0/);
    assert.doesNotMatch(out, /data-testid="v1live-late"/);
  });

  it('il pannello non ricalcola le metriche ne i ritardi', () => {
    const out = html(
      <ShadowV1LivePanel
        flag="on"
        data={view({
          metrics: { ...view().metrics, meanR: 7.77, resolved: 99, nLate: 4, nResolvedAll: 103 },
          records: [row({ key: 'a', status: 'STOP', r: -1, delayMs: 42_000 })],
        })}
      />
    );
    assert.match(out, /7\.770R/);
    assert.match(out, /n=99/);
    assert.match(out, /esclusi 4/);
    assert.doesNotMatch(out, /0\.700R/);
  });

  it('mostra la diagnostica server quando fornita senza violare i divieti di confronto', () => {
    const out = html(
      <ShadowV1LivePanel
        flag="on"
        data={view({ available: false, reason: 'nessun file persistito', records: [] })}
        v2={V2}
        diagnostics={{
          lastScanAt: new Date(NOW).toISOString(),
          scannedTickers: 40,
          emittedThisScan: 0,
          blockedThisScan: 40,
          topEU: 'SAP.DE',
          topUS: 'NVDA',
          gateCounts: [
            { gate: 'G5', label: 'Breakout scaduto oltre 60 minuti', count: 22 },
            { gate: 'G11', label: 'Punteggio sotto soglia minima', count: 18 },
          ],
        }}
      />
    );
    assert.match(out, /data-testid="v1live-diagnostics"/);
    assert.match(out, /40 titoli/);
    assert.match(out, /SAP\.DE/);
    assert.match(out, /G5/);
    for (const forbidden of ['Delta', 'Differenza', 'Δ', 'differenza', 'rapporto R', 'entryPrice', 'stopPrice']) {
      assert.equal(out.includes(forbidden), false, `non deve comparire ${forbidden}`);
    }
  });
});
