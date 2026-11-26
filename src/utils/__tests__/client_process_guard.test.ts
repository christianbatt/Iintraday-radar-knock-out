/**
 * Guardia contro il ritorno del crash `process is not defined`.
 *
 * In dev il client non ha `process`: un modulo raggiungibile da `src/main.tsx`
 * che valuti `process.env` senza una guardia `typeof process` fa fallire
 * l'eval del modulo e l'app resta vuota (senza overlay, perche' l'errore
 * avviene nel grafo dei moduli). Questo test risolve gli import statici,
 * dinamici e i re-export a partire dall'entry client e fallisce su qualunque
 * uso di `process` che non sia protetto da `typeof process ... !== 'undefined'`
 * sulla stessa riga e prima dell'uso.
 *
 * La scansione parte dal grafo e non dalla cartella: `src/server/**` vive nello
 * stesso albero ma non finisce nel bundle, quindi non va segnalato (ne'
 * escluso a mano, cosa che nasconderebbe il caso in cui qualcuno lo importi
 * davvero dal client).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Radice del progetto: il test vive in `src/utils/__tests__/`. */
export const PROJECT_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const CLIENT_ENTRY = path.join(PROJECT_ROOT, 'src', 'main.tsx');

/** `typeof process !== 'undefined'` / `typeof process === 'undefined'`. */
const GUARD_COMPARISON = /typeof\s+process\s*[=!]==?/;
const PROCESS_WORD = /\bprocess\b/g;

export interface ProcessUsage {
  file: string;
  line: number;
  text: string;
}

/**
 * Sostituisce i commenti con spazi mantenendo i fine riga: un commento che
 * parla di `process` non deve contare come uso, e i numeri di riga devono
 * restare quelli del file originale.
 */
export function stripComments(source: string): string {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, ' ')
  );
  return withoutBlockComments.replace(/(^|[^:])\/\/[^\n]*/g, (comment, prefix: string) =>
    prefix + ' '.repeat(comment.length - prefix.length)
  );
}

/**
 * Righe con un uso di `process` non coperto. Regola volutamente semplice e
 * deterministica: la guardia deve stare sulla stessa riga e prima dell'uso,
 * cosi' `process.env.X || typeof process !== 'undefined'` (che esploderebbe
 * comunque, perche' il primo operando viene valutato per primo) resta un errore.
 */
export function findUnguardedProcessUsages(source: string, file = 'module'): ProcessUsage[] {
  const usages: ProcessUsage[] = [];
  const lines = stripComments(source).split('\n');
  lines.forEach((line, index) => {
    if (!/\bprocess\b/.test(line)) return;
    const guardAt = line.search(GUARD_COMPARISON);
    for (const match of line.matchAll(PROCESS_WORD)) {
      const start = match.index ?? 0;
      const before = line.slice(0, start);
      // Operando di `typeof process`: non e' un accesso alla variabile.
      if (/typeof\s*$/.test(before)) continue;
      if (guardAt >= 0 && guardAt < start) continue;
      usages.push({ file, line: index + 1, text: line.trim() });
      break;
    }
  });
  return usages;
}

const SPECIFIER_PATTERNS: RegExp[] = [
  /\bimport\s+[^'"]*?\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bexport\s+[^'"]*?\bfrom\s+['"]([^'"]+)['"]/g,
];

/** `import type` / `export type` sono cancellati dal compilatore: non finiscono nel bundle. */
const TYPE_ONLY_IMPORT = /^\s*(?:import|export)\s+type\b/;

export function extractSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const stripped = stripComments(source);
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of stripped.matchAll(pattern)) {
      if (TYPE_ONLY_IMPORT.test(match[0])) continue;
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

/** Risolve uno specificatore relativo o `@/` in un file reale, altrimenti null. */
export function resolveModule(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith('@/')) base = path.join(PROJECT_ROOT, spec.slice(2));
  else return null;

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      // candidato assente: si prova il successivo
    }
  }
  return null;
}

/** Moduli `.ts`/`.tsx` raggiungibili dall'entry del client. */
export function collectClientModules(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [path.resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const spec of extractSpecifiers(source)) {
      const resolved = resolveModule(spec, file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

export function scanClientGraph(entry: string = CLIENT_ENTRY): {
  modules: string[];
  usages: ProcessUsage[];
} {
  const modules = [...collectClientModules(entry)].sort();
  const usages = modules.flatMap((file) =>
    findUnguardedProcessUsages(fs.readFileSync(file, 'utf8'), path.relative(PROJECT_ROOT, file))
  );
  return { modules, usages };
}

function describeUsages(usages: ProcessUsage[]): string {
  return usages.map((usage) => `  ${usage.file}:${usage.line}  ${usage.text}`).join('\n');
}

describe('client process guard — il rilevatore', () => {
  it('segnala process.env senza guardia', () => {
    const usages = findUnguardedProcessUsages(
      "const apiKey = metaEnv?.VITE_FIREBASE_API_KEY || process.env.VITE_FIREBASE_API_KEY;",
      'sample.ts'
    );
    assert.equal(usages.length, 1);
    assert.equal(usages[0].line, 1);
  });

  it('accetta la guardia sulla stessa riga, prima dell uso', () => {
    const usages = findUnguardedProcessUsages(
      "const processEnv = typeof process !== 'undefined' && process && process.env ? process.env : {};",
      'sample.ts'
    );
    assert.deepEqual(usages, []);
  });

  it('segnala process.cwd e qualunque altro uso della variabile', () => {
    assert.equal(findUnguardedProcessUsages("const cwd = process.cwd();").length, 1);
    assert.equal(findUnguardedProcessUsages('const env = process["env"];').length, 1);
  });

  it('non accetta una guardia messa dopo l uso', () => {
    assert.equal(
      findUnguardedProcessUsages("const k = process.env.K || typeof process !== 'undefined';").length,
      1
    );
  });

  it('ignora i commenti che parlano di process', () => {
    const source = [
      '/**',
      ' * Nel browser `process` non esiste: "process is not defined".',
      ' * Usa typeof process !== \'undefined\'.',
      ' */',
      '// process.env in un commento di riga',
      'const ok = 1;',
    ].join('\n');
    assert.deepEqual(findUnguardedProcessUsages(source), []);
  });

  it('conserva i numeri di riga anche con i commenti di blocco', () => {
    const source = ['/* a', '   b */', 'const k = process.env.K;'].join('\n');
    const usages = findUnguardedProcessUsages(source);
    assert.equal(usages.length, 1);
    assert.equal(usages[0].line, 3);
  });
});

describe('client process guard — grafo dei moduli', () => {
  it('l entry del client esiste ed e raggiungibile', () => {
    assert.equal(fs.existsSync(CLIENT_ENTRY), true);
  });

  it('segue gli import di valore e ignora quelli di solo tipo', () => {
    assert.deepEqual(
      extractSpecifiers([
        "import type { A } from '../server/a';",
        "import { b } from './b';",
        "export type { C } from '../server/c';",
      ].join('\n')),
      ['./b']
    );
  });

  it('il grafo contiene i moduli del client attesi', () => {
    const modules = collectClientModules(CLIENT_ENTRY);
    assert.ok(modules.size > 20, `grafo troppo piccolo: ${modules.size} moduli`);
    assert.ok(modules.has(path.join(PROJECT_ROOT, 'src', 'main.tsx')));
    // Modulo del crash storico: deve restare nel perimetro della guardia.
    assert.ok(modules.has(path.join(PROJECT_ROOT, 'src', 'services', 'firebaseSync.ts')));
  });

  it('i moduli solo-server non entrano nel perimetro client', () => {
    const modules = collectClientModules(CLIENT_ENTRY);
    assert.equal(modules.has(path.join(PROJECT_ROOT, 'src', 'config', 'aiDesk.ts')), false);
    assert.equal(
      [...modules].some((file) => file.startsWith(path.join(PROJECT_ROOT, 'src', 'server') + path.sep)),
      false
    );
  });

  it('nessun modulo client usa process senza la guardia typeof process', () => {
    const { modules, usages } = scanClientGraph();
    assert.deepEqual(
      usages,
      [],
      `Uso di \`process\` non protetto in un modulo client (il browser non lo definisce,\n` +
        `l'app resterebbe vuota). Avvolgi la lettura in una guardia, es.\n` +
        `  const processEnv = typeof process !== 'undefined' && process && process.env ? process.env : {};\n` +
        `Trovati:\n${describeUsages(usages)}\n(moduli scansionati: ${modules.length})`
    );
  });
});
