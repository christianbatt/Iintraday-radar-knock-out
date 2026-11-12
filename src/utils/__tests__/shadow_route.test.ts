import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  getShadowLatest,
  registerShadowRoutes,
  SHADOW_ROUTES,
  type ShadowFs,
  type ShadowDeps,
} from '../../server/shadowRoute';

const ARTIFACT = {
  schemaVersion: 2,
  generatedAt: '2026-11-12T02:00:00.000Z',
  sample: { nDays: 30, nSetups: 123, nClusters: 13, barMinutes: 5 },
  emissionsByDay: [
    { day: '2026-10-28', candidates: 510, emitted: 6, blocked: 504, firstFailingGate: 'G8' },
  ],
  deathCriterion: {
    status: 'not_yet_evaluable',
    trigger: { needSetups: 100, haveSetups: 123, needDays: 30, haveDays: 13 },
    nCells: 40,
    nAdmissibleCells: 0,
    alphaEffective: 0.0063,
    alphaBonferroni: null,
    reason: 'trigger non soddisfatto',
  },
  rules: [
    { id: 'S01', name: 'tripleBarrierLabels', family: 'STIMATORE', status: 'computed', value: 0.179, unit: 'share', n: 123, note: '' },
  ],
  spreadEstimate: { perSymbol: [], vsParametricPct: 0.1, deltaPct: -0.081, caveat: 'ordine di grandezza' },
  deflatedSharpe: { nTrials: 7, nTrialsSource: 'registry/ai_registry.jsonl', dsr: 0, pValue: 0.5, alphaBonferroni: null, alphaEffective: 0.0063, note: '' },
  proposals: [],
  limitations: ['campione'],
};

function fakeFs(files: Record<string, string>, dirs: string[] = ['artifacts/shadow']): ShadowFs {
  return {
    existsSync: (p: string) => p in files || dirs.includes(p),
    readFileSync: (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    readdirSync: (p: string) => {
      if (!dirs.includes(p)) throw new Error(`ENOENT ${p}`);
      return Object.keys(files)
        .filter(k => k.startsWith(`${p}/`))
        .map(k => k.slice(p.length + 1));
    },
  };
}

function deps(files: Record<string, string>, dirs?: string[]): ShadowDeps {
  return {
    fs: fakeFs(files, dirs),
    artifactDir: 'artifacts',
    registryPath: 'registry/ai_registry.jsonl',
    deathcheckPath: 'artifacts/ai_deathcheck.json',
    flags: { SETUP_SELECTOR_LIVE: 'off', STALENESS_USE_MARKET_TS: 'off' },
  };
}

const VALID = {
  'artifacts/shadow/shadow_2026-11-12.json': JSON.stringify(ARTIFACT),
  'artifacts/ai_deathcheck.json': JSON.stringify({ status: 'not_yet_evaluable', fillIntegrity: 'ok' }),
  'registry/ai_registry.jsonl': `${JSON.stringify({ id: 'AI-0005', kind: 'hypothesis' })}\n`,
};

describe('T1 — artefatto valido: campi propagati', () => {
  it('restituisce i campi dell’artefatto con available true e status 200', () => {
    const out = getShadowLatest(deps(VALID));
    assert.equal(out.status, 200);
    assert.equal(out.body.available, true);
    const sample = out.body.sample as { nSetups: number; nDays: number };
    assert.equal(sample.nSetups, 123);
    assert.equal(sample.nDays, 30);
    const dc = out.body.deathCriterion as { status: string; nAdmissibleCells: number };
    assert.equal(dc.status, 'not_yet_evaluable');
    assert.equal(dc.nAdmissibleCells, 0);
    assert.equal(out.body.fillIntegrity, 'ok');
    const emissions = out.body.emissionsByDay as Array<{ day: string }>;
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].day, '2026-10-28');
    const reg = out.body.registry as { rows: number; hypotheses: number };
    assert.equal(reg.rows, 1);
    assert.equal(reg.hypotheses, 1);
    const flags = out.body.flags as { SETUP_SELECTOR_LIVE: string };
    assert.equal(flags.SETUP_SELECTOR_LIVE, 'off');
  });
});

describe('T2 — artefatto assente: available false, HTTP 200, nessuna eccezione', () => {
  it('non lancia e risponde 200 con reason', () => {
    const out = getShadowLatest(deps({}, []));
    assert.equal(out.status, 200);
    assert.equal(out.body.available, false);
    assert.equal(out.body.reason, 'nessun artefatto');
  });
});

describe('T3 — JSON malformato: available false, nessuna eccezione', () => {
  it('non lancia e dichiara l’artefatto illeggibile', () => {
    const out = getShadowLatest(deps({ 'artifacts/shadow/shadow_2026-11-12.json': '{ questo non e json' }));
    assert.equal(out.status, 200);
    assert.equal(out.body.available, false);
    assert.equal(out.body.reason, 'artefatto illeggibile');
  });
});

describe('T4 — il modulo non raggiunge applyOptimizationProposal né promote', () => {
  it('il sorgente del handler non li importa e non li chiama', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../../server/shadowRoute.ts', import.meta.url)),
      'utf8'
    );
    assert.equal(source.includes('applyOptimizationProposal'), false, 'applyOptimizationProposal non deve comparire');
    assert.equal(/\bpromote\b/.test(source), false, 'promote non deve comparire');
    assert.equal(source.includes('calculator'), false, 'il handler non deve importare calculator');
  });
});

describe('T5 — nessuna route POST per /api/shadow', () => {
  it('la tabella delle route contiene solo GET e la registrazione non espone POST', () => {
    assert.ok(SHADOW_ROUTES.length >= 1);
    for (const r of SHADOW_ROUTES) assert.equal(r.method, 'GET');
    assert.equal(SHADOW_ROUTES.some(r => r.path === '/api/shadow/latest'), true);
    const registered: Array<{ method: string; path: string }> = [];
    const app = {
      get: (p: string) => registered.push({ method: 'GET', path: p }),
      post: (p: string) => registered.push({ method: 'POST', path: p }),
    };
    registerShadowRoutes(app as unknown as { get: (p: string, h: (a: unknown, b: unknown) => void) => void }, deps(VALID));
    assert.equal(registered.filter(r => r.method === 'POST').length, 0);
    assert.deepEqual(registered.map(r => r.path), ['/api/shadow/latest']);
  });
});
