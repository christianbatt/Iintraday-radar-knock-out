/**
 * Test del ponte client -> server SHADOW V1 LIVE (PR C2).
 *
 * Nessuna rete reale: `fetch` e' iniettato. A flag OFF non deve partire alcuna
 * richiesta, a flag ON una sola POST per setup emesso.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildShadowV1LivePayload,
  notifyShadowV1Live,
  resetShadowV1LiveBridgeForTest,
  SHADOW_V1_LIVE_BRIDGE_ENDPOINT,
  SHADOW_V1_LIVE_BRIDGE_MAX_KEYS,
  type BridgeFetch,
  type ShadowV1LiveBridgePayload,
} from '../shadowV1LiveBridge';
import { SHADOW_V1_LIVE_BRIDGE } from '../../config/shadowV1LiveBridge';
import type { ExecutionSetup } from '../../types/radar';

const ISO = '2026-03-16T14:00:00.000Z';

function setup(over: Partial<ExecutionSetup> = {}): ExecutionSetup {
  return {
    candidate: { ticker: 'AAPL', market: 'US' } as ExecutionSetup['candidate'],
    decision: 'TRADE',
    direction: 'LONG',
    triggerLevel: 100,
    entryLevel: 100,
    stopLossLevel: 95,
    target1Level: 108,
    calculatedAt: ISO,
    marketType: 'US',
    ...over,
  } as ExecutionSetup;
}

function fakeFetch(status = 200): {
  calls: Array<{ url: string; init: { method: string; body: string; signal?: AbortSignal } }>;
  impl: BridgeFetch;
} {
  const calls: Array<{ url: string; init: { method: string; body: string; signal?: AbortSignal } }> = [];
  const impl: BridgeFetch = async (url, init) => {
    calls.push({ url, init });
    return { status };
  };
  return { calls, impl };
}

/** Lascia girare i microtask della fetch finta. */
const flush = () => new Promise((r) => setImmediate(r));

test.beforeEach(() => {
  resetShadowV1LiveBridgeForTest();
});

// --- Flag ---------------------------------------------------------------------

test('flag client: default "off" nella costante di config', () => {
  assert.equal(SHADOW_V1_LIVE_BRIDGE, 'off');
});

test('flag OFF: nessuna richiesta di rete e nessuna deduplica allocata', async () => {
  const fetcher = fakeFetch();
  const queued = notifyShadowV1Live(setup(), { enabled: false, fetchImpl: fetcher.impl });
  await flush();
  assert.equal(queued, false);
  assert.deepEqual(fetcher.calls, []);
});

test('flag OFF: nessuna richiesta nemmeno con setup valido e piu\u2019 giri', async () => {
  const fetcher = fakeFetch();
  for (let i = 0; i < 5; i += 1) {
    notifyShadowV1Live(setup(), { enabled: false, fetchImpl: fetcher.impl });
  }
  await flush();
  assert.equal(fetcher.calls.length, 0);
});

// --- Invio --------------------------------------------------------------------

test('flag ON: una POST per setup valido, con payload esatto', async () => {
  const fetcher = fakeFetch();
  const queued = notifyShadowV1Live(setup(), { enabled: true, fetchImpl: fetcher.impl });
  await flush();
  assert.equal(queued, true);
  assert.equal(fetcher.calls.length, 1);
  const call = fetcher.calls[0];
  assert.equal(call.url, SHADOW_V1_LIVE_BRIDGE_ENDPOINT);
  assert.equal(call.init.method, 'POST');
  const body = JSON.parse(call.init.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    'calculatedAt',
    'direction',
    'entry',
    'market',
    'stop',
    'target',
    'ticker',
  ]);
  assert.deepEqual(body, {
    ticker: 'AAPL',
    market: 'US',
    direction: 'LONG',
    entry: 100,
    stop: 95,
    target: 108,
    calculatedAt: ISO,
  });
});

test('stesso setup ricalcolato N volte: una sola POST', async () => {
  const fetcher = fakeFetch();
  for (let i = 0; i < 10; i += 1) {
    notifyShadowV1Live(setup(), { enabled: true, fetchImpl: fetcher.impl });
  }
  await flush();
  assert.equal(fetcher.calls.length, 1);
});

test('entry o stop diversi: nuova chiave, nuova POST', async () => {
  const fetcher = fakeFetch();
  notifyShadowV1Live(setup(), { enabled: true, fetchImpl: fetcher.impl });
  notifyShadowV1Live(setup({ entryLevel: 101 }), { enabled: true, fetchImpl: fetcher.impl });
  notifyShadowV1Live(setup({ stopLossLevel: 94 }), { enabled: true, fetchImpl: fetcher.impl });
  await flush();
  assert.equal(fetcher.calls.length, 3);
});

test('setup NESSUNA, non TRADE o senza livelli: nessuna POST', async () => {
  const fetcher = fakeFetch();
  const cases: Array<Partial<ExecutionSetup>> = [
    { direction: 'NESSUNA' },
    { decision: 'NESSUN_TRADE' },
    { entryLevel: null, triggerLevel: null },
    { stopLossLevel: null },
    { target1Level: null },
    { stopLossLevel: 0 },
    { target1Level: Number.NaN },
  ];
  for (const over of cases) {
    notifyShadowV1Live(setup(over), { enabled: true, fetchImpl: fetcher.impl });
  }
  await flush();
  assert.equal(fetcher.calls.length, 0);
});

test('senza calculatedAt o non parsabile: nessuna POST', async () => {
  const fetcher = fakeFetch();
  notifyShadowV1Live(setup({ calculatedAt: undefined }), { enabled: true, fetchImpl: fetcher.impl });
  notifyShadowV1Live(setup({ calculatedAt: 'ieri' }), { enabled: true, fetchImpl: fetcher.impl });
  await flush();
  assert.equal(fetcher.calls.length, 0);
});

test('senza ticker o senza mercato: nessuna POST', async () => {
  const fetcher = fakeFetch();
  notifyShadowV1Live(
    setup({ candidate: { ticker: '' } as ExecutionSetup['candidate'] }),
    { enabled: true, fetchImpl: fetcher.impl }
  );
  notifyShadowV1Live(setup({ marketType: undefined, candidate: { ticker: 'AAPL' } as ExecutionSetup['candidate'] }), {
    enabled: true,
    fetchImpl: fetcher.impl,
  });
  await flush();
  assert.equal(fetcher.calls.length, 0);
});

test('buildShadowV1LivePayload: nessun campo extra e entry da triggerLevel se serve', () => {
  const payload = buildShadowV1LivePayload(
    setup({ entryLevel: null, triggerLevel: 100 })
  ) as ShadowV1LiveBridgePayload;
  assert.equal(payload.entry, 100);
  assert.equal(Object.keys(payload).length, 7);
});

// --- Errori e isolamento ------------------------------------------------------

test('fetch che rifiuta sempre: nessuna eccezione, un solo warn', async () => {
  const warnings: string[] = [];
  const impl: BridgeFetch = async () => {
    throw new Error('offline');
  };
  assert.doesNotThrow(() =>
    notifyShadowV1Live(setup(), { enabled: true, fetchImpl: impl, warn: (m) => warnings.push(m) })
  );
  await flush();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /offline/);
});

test('5xx: un solo tentativo di ripetizione', async () => {
  const fetcher = fakeFetch(503);
  notifyShadowV1Live(setup(), { enabled: true, fetchImpl: fetcher.impl });
  await flush();
  assert.equal(fetcher.calls.length, 2);
});

test('429/413/400: nessuna ripetizione', async () => {
  for (const status of [429, 413, 400]) {
    resetShadowV1LiveBridgeForTest();
    const fetcher = fakeFetch(status);
    notifyShadowV1Live(setup(), { enabled: true, fetchImpl: fetcher.impl });
    await flush();
    assert.equal(fetcher.calls.length, 1, String(status));
  }
});

test('timeout: la richiesta viene abortita e nessuna eccezione esce', async () => {
  let aborted = false;
  const impl: BridgeFetch = (_url, init) =>
    new Promise((resolve) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        resolve({ status: 0 });
      });
    });
  notifyShadowV1Live(setup(), { enabled: true, fetchImpl: impl, timeoutMs: 10 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(aborted, true);
});

test('il chiamante non attende la rete', async () => {
  let resolved = false;
  const impl: BridgeFetch = () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve({ status: 200 });
      }, 1000);
    });
  const started = Date.now();
  const queued = notifyShadowV1Live(setup(), { enabled: true, fetchImpl: impl });
  const elapsed = Date.now() - started;
  assert.equal(queued, true);
  assert.ok(elapsed < 50, `ritorno non bloccante, elapsed=${elapsed}ms`);
  assert.equal(resolved, false);
});

// --- Deduplica con tetto ------------------------------------------------------

test('tetto della deduplica: la chiave piu\u2019 vecchia viene dimenticata', async () => {
  const fetcher = fakeFetch();
  const maxKeys = 3;
  for (let i = 0; i < 5; i += 1) {
    notifyShadowV1Live(setup({ entryLevel: 100 + i }), {
      enabled: true,
      fetchImpl: fetcher.impl,
      maxKeys,
    });
  }
  await flush();
  assert.equal(fetcher.calls.length, 5);
  assert.equal(SHADOW_V1_LIVE_BRIDGE_MAX_KEYS, 500);
  // La prima chiave e' stata sfrattata: il setup originale viene inviato di nuovo.
  notifyShadowV1Live(setup({ entryLevel: 100 }), { enabled: true, fetchImpl: fetcher.impl, maxKeys });
  await flush();
  assert.equal(fetcher.calls.length, 6);
});

// --- Aggancio in App.tsx (riga isolata) ---------------------------------------

test('App.tsx: l\u2019aggancio e\u2019 un solo effect che chiama il ponte per EU e US', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../../src/App.tsx', import.meta.url)), 'utf8');
  const imports = source.match(/import \{ notifyShadowV1Live \} from '\.\/utils\/shadowV1LiveBridge';/g) ?? [];
  assert.equal(imports.length, 1, 'un solo import');
  const calls = source.match(/notifyShadowV1Live\(setup(?:EU|US)\);/g) ?? [];
  assert.equal(calls.length, 2, 'una chiamata per mercato');
  assert.ok(source.includes('}, [setupEU, setupUS]);'), 'effect con dipendenze sui due setup');
});
