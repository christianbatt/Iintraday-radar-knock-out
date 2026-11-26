/**
 * Guardia contro il ritorno del crash `process is not defined`.
 *
 * In dev il client non ha `process`: un modulo raggiungibile da `src/main.tsx`
 * che valuti `process.env` senza una guardia `typeof process` fa fallire
 * l'eval del modulo e l'app resta vuota (senza overlay, perche' l'errore
 * avviene nel grafo dei moduli).
 *
 * Il perimetro non e' una cartella e non ha esclusioni a mano: e' il GRAFO dei
 * moduli che finiscono davvero nel bundle, ricostruito dall'entry client
 * seguendo:
 * - import statici, side-effect, re-export e `import()` con specificatore
 *   letterale;
 * - `import.meta.glob(...)` / `globEager(...)`, con pattern singolo o array,
 *   pattern negativi compresi (Vite li risolve a compile time: quei moduli sono
 *   nel bundle anche se nessun import li nomina);
 * - `import(\`./views/${name}.tsx\`)`: il template con parti dinamiche viene
 *   espanso nel glob del prefisso statico.
 *
 * Punto cieco residuo (specificatori calcolati a runtime, es. `import(dir + name)`)
 * coperto dalla rete di sicurezza: ogni sorgente sotto `src/` che nomina
 * `process` deve stare o nel grafo client (e allora deve essere protetto) o nel
 * grafo server (allora gira solo in Node), altrimenti il test fallisce e chiede
 * di dichiararlo. Nessun file e' escluso per nome.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Radice del progetto: il test vive in `src/utils/__tests__/`. */
export const PROJECT_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const CLIENT_ENTRY = path.join(PROJECT_ROOT, 'src', 'main.tsx');
export const SERVER_ENTRY = path.join(PROJECT_ROOT, 'server.ts');

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

/** `import(\`./views/${name}.tsx\`)`: la parte dinamica diventa `*`. */
const TEMPLATE_IMPORT = /\bimport\s*\(\s*`([^`]+)`\s*\)/g;
/** Primo argomento di `import.meta.glob(...)`, stringa o array di stringhe. */
const GLOB_CALL = /import\.meta\.(?:glob|globEager)\s*\(\s*(\[[\s\S]*?\]|'[^']*'|"[^"]*")/g;
const QUOTED = /"([^"]+)"|'([^']+)'/g;

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
  for (const match of stripped.matchAll(TEMPLATE_IMPORT)) {
    specifiers.add(match[1].replace(/\$\{[^}]*\}/g, '*'));
  }
  return [...specifiers];
}

/** Pattern di `import.meta.glob` (stringa o array), segno `!` compreso. */
export function extractGlobPatterns(source: string): string[] {
  const patterns: string[] = [];
  const stripped = stripComments(source);
  for (const call of stripped.matchAll(GLOB_CALL)) {
    const argument = call[1];
    for (const quoted of argument.matchAll(QUOTED)) {
      const value = quoted[1] ?? quoted[2];
      if (value) patterns.push(value);
    }
  }
  return patterns;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Glob -> RegExp con supporto a `**`, `*`, `?` e `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if (char === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        const alternatives = glob.slice(i + 1, end).split(',').map(escapeRegExp);
        out += `(?:${alternatives.join('|')})`;
        i = end;
        continue;
      }
    }
    out += escapeRegExp(char);
  }
  return new RegExp(`^${out}$`);
}

function listFilesRecursively(dir: string): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      files.push(...listFilesRecursively(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Espande un pattern di `import.meta.glob` (relativo al modulo che lo chiama, o
 * assoluto con `/`) nei file che Vite includerebbe. I pattern negativi (`!`)
 * tolgono i file gia' selezionati, come fa Vite.
 */
export function expandGlob(pattern: string, fromFile: string): string[] {
  const negative = pattern.startsWith('!');
  const body = negative ? pattern.slice(1) : pattern;
  if (body.startsWith('node:')) return [];

  const absolute = body.startsWith('/')
    ? path.join(PROJECT_ROOT, body)
    : path.resolve(path.dirname(fromFile), body);
  const segments = absolute.split(path.sep);
  const wildcardIndex = segments.findIndex((segment) => /[*?{[]/.test(segment));
  const rootDir =
    wildcardIndex === -1
      ? path.dirname(absolute)
      : wildcardIndex === 0
        ? path.sep
        : segments.slice(0, wildcardIndex).join(path.sep);
  const relativePattern =
    wildcardIndex === -1
      ? path.basename(absolute)
      : segments.slice(wildcardIndex).join('/');

  const matcher = globToRegExp(relativePattern);
  const matches: string[] = [];
  for (const file of listFilesRecursively(rootDir)) {
    const relative = path.relative(rootDir, file).split(path.sep).join('/');
    if (matcher.test(relative)) matches.push(path.resolve(file));
  }
  return matches;
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

function isWildcardSpecifier(spec: string): boolean {
  return /[*?{]/.test(spec);
}

/**
 * Moduli raggiungibili dall'entry: import di valore, `import.meta.glob` e
 * template di `import()` espansi. I pattern negativi sono applicati per modulo
 * chiamante prima di accodare i file.
 */
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
      if (isWildcardSpecifier(spec)) {
        for (const match of expandGlob(spec, file)) {
          if (!seen.has(match)) queue.push(match);
        }
        continue;
      }
      const resolved = resolveModule(spec, file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }

    const globPatterns = extractGlobPatterns(source);
    if (globPatterns.length > 0) {
      const negatives = globPatterns.filter((pattern) => pattern.startsWith('!'));
      const included = new Set<string>();
      for (const pattern of globPatterns.filter((p) => !p.startsWith('!'))) {
        for (const match of expandGlob(pattern, file)) included.add(match);
      }
      for (const pattern of negatives) {
        for (const match of expandGlob(pattern, file)) included.delete(match);
      }
      for (const match of included) {
        if (!seen.has(match)) queue.push(match);
      }
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

/** Sorgenti sotto `src/` (esclusi i test, che girano in Node) che nominano `process`. */
export function findSourcesMentioningProcess(dir = path.join(PROJECT_ROOT, 'src')): string[] {
  return listFilesRecursively(dir)
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`) && !/\.test\.(ts|tsx)$/.test(file))
    .filter((file) => /\bprocess\b/.test(stripComments(fs.readFileSync(file, 'utf8'))))
    .map((file) => path.resolve(file))
    .sort();
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

  it('glob: supporta **, *, ? e {a,b}', () => {
    assert.equal(globToRegExp('views/*.tsx').test('views/a.tsx'), true);
    assert.equal(globToRegExp('views/*.tsx').test('views/nested/a.tsx'), false);
    assert.equal(globToRegExp('**/*.tsx').test('a/b/c.tsx'), true);
    assert.equal(globToRegExp('a/?.ts').test('a/b.ts'), true);
    assert.equal(globToRegExp('a.{ts,tsx}').test('a.tsx'), true);
    assert.equal(globToRegExp('a.{ts,tsx}').test('a.js'), false);
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

  it('i moduli importati solo come tipo non entrano nel perimetro client', () => {
    const modules = collectClientModules(CLIENT_ENTRY);
    assert.equal(modules.has(path.join(PROJECT_ROOT, 'src', 'config', 'aiDesk.ts')), false);
    assert.equal(
      [...modules].some((file) => file.startsWith(path.join(PROJECT_ROOT, 'src', 'server') + path.sep)),
      false
    );
  });

  it('import.meta.glob porta nel perimetro anche i moduli senza import nominale', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-guard-'));
    try {
      fs.mkdirSync(path.join(dir, 'views'));
      fs.writeFileSync(
        path.join(dir, 'entry.tsx'),
        "const views = import.meta.glob('./views/*.tsx');\nconst lazy = () => import(`./lazy/${'name'}.tsx`);\n",
        'utf8'
      );
      fs.writeFileSync(path.join(dir, 'views', 'bad.tsx'), 'export const key = process.env.K;\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'views', 'guarded.tsx'), "export const env = typeof process !== 'undefined' ? process.env : {};\n", 'utf8');
      fs.mkdirSync(path.join(dir, 'lazy'));
      fs.writeFileSync(path.join(dir, 'lazy', 'x.tsx'), 'export const key = process.env.K;\n', 'utf8');

      const modules = collectClientModules(path.join(dir, 'entry.tsx'));
      assert.ok(modules.has(path.resolve(dir, 'views', 'bad.tsx')));
      assert.ok(modules.has(path.resolve(dir, 'views', 'guarded.tsx')));
      assert.ok(modules.has(path.resolve(dir, 'lazy', 'x.tsx')), 'template di import() non espanso');

      const { usages } = scanClientGraph(path.join(dir, 'entry.tsx'));
      const files = usages.map((usage) => path.basename(usage.file)).sort();
      assert.deepEqual(files, ['bad.tsx', 'x.tsx']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('i pattern negativi tolgono i file dall espansione glob', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-guard-neg-'));
    try {
      fs.mkdirSync(path.join(dir, 'views'));
      fs.writeFileSync(
        path.join(dir, 'entry.tsx'),
        "const views = import.meta.glob(['./views/*.tsx', '!./views/skip.tsx']);\n",
        'utf8'
      );
      fs.writeFileSync(path.join(dir, 'views', 'keep.tsx'), 'export const a = 1;\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'views', 'skip.tsx'), 'export const b = process.env.B;\n', 'utf8');
      const modules = collectClientModules(path.join(dir, 'entry.tsx'));
      assert.ok(modules.has(path.resolve(dir, 'views', 'keep.tsx')));
      assert.equal(modules.has(path.resolve(dir, 'views', 'skip.tsx')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('nessun sorgente con process resta fuori da entrambi i grafi (punti ciechi)', () => {
    const client = collectClientModules(CLIENT_ENTRY);
    const server = collectClientModules(SERVER_ENTRY);
    const unknown = findSourcesMentioningProcess().filter(
      (file) => !client.has(file) && !server.has(file)
    );
    assert.deepEqual(
      unknown.map((file) => path.relative(PROJECT_ROOT, file)),
      [],
      'Questi sorgenti nominano `process` ma non sono raggiungibili ne dal client ne dal server:\n' +
        'se un import calcolato a runtime li porta nel bundle, il crash non e coperto.\n' +
        'Rendili raggiungibili con un import/glob statico oppure proteggi la lettura con typeof process.'
    );
  });
});
