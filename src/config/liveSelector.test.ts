/**
 * Regressioni fetchMacroCalendar (status: 'ok'|'unavailable') + verifica
 * che il flag sia 'off'. Non legge nulla al di fuori di src/.
 *
 * Runner: npx tsx src/config/liveSelector.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMacroCalendar } from '../services/api';
import { SETUP_SELECTOR_LIVE } from '../config/liveSelector';

function makeResponse(status: number, body: unknown, ok = status >= 200 && status < 300): Response {
  return {
    ok,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
    blob: async () => new Blob([JSON.stringify(body)], { type: 'application/json' }),
    formData: async () => null as unknown as FormData,
    clone: function () {
      return makeResponse(status, body, ok);
    },
  } as unknown as Response;
}

describe('fetchMacroCalendar - regressioni status', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('ok, json() returns full calendar -> status ok, events length 1, isBlackoutActive true', async () => {
    globalThis.fetch = async () =>
      makeResponse(200, {
        events: [{ id: 'e1' } as unknown as ReturnType<typeof fetchMacroCalendar> extends Promise<infer T> ? T extends { events: Array<infer E> } ? E : never : never],
        isBlackoutActive: true,
        activeBlackoutEvent: null,
        spreadWarningTradeRepublic: null,
        attribution: 'FinanceCalendar.com',
      });

    const m = await fetchMacroCalendar();
    assert.equal(m.status, 'ok');
    assert.equal(Array.isArray(m.events), true);
    assert.equal(m.events.length, 1);
    assert.equal(m.isBlackoutActive, true);
  });

  it('ok: false -> status unavailable, events []', async () => {
    globalThis.fetch = async () =>
      makeResponse(500, { error: 'boom' }, false);

    const m = await fetchMacroCalendar();
    assert.equal(m.status, 'unavailable');
    assert.deepEqual(m.events, []);
  });

  it('fetch throws -> status unavailable, events []', async () => {
    globalThis.fetch = async () => {
      throw new Error('network error');
    };

    const m = await fetchMacroCalendar();
    assert.equal(m.status, 'unavailable');
    assert.deepEqual(m.events, []);
  });
});

describe('liveSelector - flag off', () => {
  it('SETUP_SELECTOR_LIVE === "off"', () => {
    assert.strictEqual(SETUP_SELECTOR_LIVE, 'off');
  });
});
