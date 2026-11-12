/**
 * Handler di sola lettura per il pannello Shadow Research (Passo L).
 *
 * PRINCIPIO: nessun calcolo, nessun processo, nessuna scrittura. Legge gli
 * artefatti prodotti offline (`scripts/shadow_report.ts`, `scripts/ai_cycle.ts
 * deathcheck`) e li restituisce. Un artefatto mancante NON e' un errore del
 * server: e' `available: false` con HTTP 200.
 *
 * Le dipendenze sono iniettate: il corpo del handler non importa `fs`, cosi'
 * e' testabile senza filesystem.
 */

import nodeFs from 'node:fs';
import { SETUP_SELECTOR_LIVE } from '../config/liveSelector';
import { STALENESS_USE_MARKET_TS } from '../config/stalenessFlag';

export type ShadowFs = {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: 'utf8') => string;
  readdirSync: (path: string) => string[];
};

export type ShadowDeps = {
  fs: ShadowFs;
  artifactDir: string;
  registryPath: string;
  deathcheckPath: string;
  flags: { SETUP_SELECTOR_LIVE: string; STALENESS_USE_MARKET_TS: string };
};

export type ShadowResponse = { status: number; body: Record<string, unknown> };

type Json = Record<string, unknown>;

const MISSING = { available: false as const };

function readJsonSafe(fs: ShadowFs, path: string): Json | null {
  if (!fs.existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

function latestShadowPath(fs: ShadowFs, artifactDir: string): string | null {
  const dir = `${artifactDir}/shadow`;
  if (!fs.existsSync(dir)) return null;
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.startsWith('shadow_') && f.endsWith('.json')).sort();
  } catch {
    return null;
  }
  if (!files.length) return null;
  return `${dir}/${files[files.length - 1]}`;
}

function registryCounts(fs: ShadowFs, path: string): { rows: number | null; hypotheses: number | null } {
  if (!fs.existsSync(path)) return { rows: null, hypotheses: null };
  try {
    const lines = fs.readFileSync(path, 'utf8').split('\n').filter(l => l.trim().length > 0);
    let hypotheses = 0;
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as { kind?: string };
        if (row.kind === 'hypothesis') hypotheses += 1;
      } catch {
        /* riga illeggibile: non si inventa */
      }
    }
    return { rows: lines.length, hypotheses };
  } catch {
    return { rows: null, hypotheses: null };
  }
}

/**
 * GET /api/shadow/latest — sola lettura.
 * Restituisce `available: false` con HTTP 200 se l'artefatto manca o e' rotto.
 */
export function getShadowLatest(deps: ShadowDeps): ShadowResponse {
  const path = latestShadowPath(deps.fs, deps.artifactDir);
  if (path === null) {
    return { status: 200, body: { ...MISSING, reason: 'nessun artefatto', flags: deps.flags } };
  }
  const artifact = readJsonSafe(deps.fs, path);
  if (artifact === null) {
    return { status: 200, body: { ...MISSING, reason: 'artefatto illeggibile', flags: deps.flags } };
  }
  const deathcheck = readJsonSafe(deps.fs, deps.deathcheckPath);
  return {
    status: 200,
    body: {
      available: true,
      artifactPath: path,
      generatedAt: artifact.generatedAt ?? null,
      sample: artifact.sample ?? null,
      emissionsByDay: artifact.emissionsByDay ?? [],
      deathCriterion: artifact.deathCriterion ?? null,
      fillIntegrity: typeof deathcheck?.fillIntegrity === 'string' ? deathcheck.fillIntegrity : 'unknown',
      rules: artifact.rules ?? [],
      spreadEstimate: artifact.spreadEstimate ?? null,
      deflatedSharpe: artifact.deflatedSharpe ?? null,
      proposals: artifact.proposals ?? [],
      limitations: artifact.limitations ?? [],
      registry: registryCounts(deps.fs, deps.registryPath),
      flags: deps.flags,
    },
  };
}

/** Tabella delle route di questo modulo: una sola GET, nessuna POST. */
export const SHADOW_ROUTES: ReadonlyArray<{ method: 'GET'; path: string }> = [
  { method: 'GET', path: '/api/shadow/latest' },
];

type MinimalApp = {
  get: (path: string, handler: (req: unknown, res: unknown) => void) => void;
};

type MinimalResponse = {
  status: (code: number) => { json: (body: unknown) => void };
  json?: (body: unknown) => void;
};

/**
 * Registrazione usata da server.ts: una riga sola. Le dipendenze concrete
 * (fs, percorsi, flag) si compongono qui, non nel chiamante, cosi' server.ts
 * non duplica ne' percorsi ne' valori dei flag.
 */
export function registerShadowRoutesFromDisk(app: MinimalApp, root: string = process.cwd()): void {
  registerShadowRoutes(app, {
    fs: {
      existsSync: p => nodeFs.existsSync(p),
      readFileSync: (p, e) => nodeFs.readFileSync(p, e),
      readdirSync: p => nodeFs.readdirSync(p),
    },
    artifactDir: `${root}/artifacts`,
    registryPath: `${root}/registry/ai_registry.jsonl`,
    deathcheckPath: `${root}/artifacts/ai_deathcheck.json`,
    flags: { SETUP_SELECTOR_LIVE, STALENESS_USE_MARKET_TS },
  });
}

/** Registra le route. Unico punto in cui server.ts tocca questo modulo. */
export function registerShadowRoutes(app: MinimalApp, deps: ShadowDeps): void {
  app.get('/api/shadow/latest', (_req, res) => {
    const out = getShadowLatest(deps);
    const r = res as MinimalResponse;
    if (typeof r.status === 'function') r.status(out.status).json(out.body);
    else if (typeof r.json === 'function') r.json(out.body);
  });
}
