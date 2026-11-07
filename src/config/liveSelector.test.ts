/**
 * liveSelector: regressioni fetchMacroCalendar (status: 'ok'|'unavailable') e
 * verifica che il flag "off" produca output byte-identico alla baseline main
 * (a718bfd).
 *
 * Runner: npx tsx src/config/liveSelector.test.ts
 *
 * I casi di regressione mockano globalThis.fetch e lo ripristinano dopo ogni
 * caso; il test del flag lancia il harness come processo figlio con gli stessi
 * argomenti di step 2, scrive su un file temporaneo e lo confronta byte per
 * byte con artifacts/baseline/fixture_main.json. Non legge artifacts/passoA/.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { fetchMacroCalendar } from '../services/api';

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

const __filename0 = fileURLToPath(import.meta.url);
const __dirname0 = dirname(__filename0);
const WORKSPACE_ROOT0 = join(__dirname0, '..', '..');

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

describe('liveSelector - flag off coincide con baseline main', () => {
  it('harness con flag off == artifacts/baseline/fixture_main.json byte per byte', () => {
    const harnessPath = join(WORKSPACE_ROOT0, 'harness_live_fixture.ts');
    assert.ok(existsSync(harnessPath), 'harness non presente su disco');

    const outPath = join(tmpdir(), `live_selector_passoa_${Date.now()}.json`);
    try {
      const cmd = `npx tsx ${harnessPath} off > ${outPath}`;
      execFileSync('sh', ['-c', cmd], {
        cwd: WORKSPACE_ROOT0,
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          SETUP_SELECTOR_LIVE: 'off',
        },
      });

      const got = readFileSync(outPath, 'utf8');
      const baseline = readFileSync(join(WORKSPACE_ROOT0, 'artifacts', 'baseline', 'fixture_main.json'), 'utf8');
      assert.strictEqual(got, baseline, 'output con flag off non coincide con baseline main');
    } finally {
      try { unlinkSync(outPath); } catch {}
    }
  });
});
