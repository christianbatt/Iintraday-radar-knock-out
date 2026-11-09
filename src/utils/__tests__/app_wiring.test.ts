/**
 * Wiring statico: ogni chiamata a buildExecutionSetup in src/App.tsx deve
 * passare `macroCalendar`. Legge i file come TESTO: non importa App.tsx,
 * quindi niente React/DOM in questo test.
 *
 * Runner: npx tsx src/utils/__tests__/app_wiring.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP_URL = new URL('../../App.tsx', import.meta.url);
const SELECTOR_URL = new URL('../../config/liveSelector.ts', import.meta.url);
const MIN_EXPECTED_INVOCATIONS = 15;
const CALLEE = 'buildExecutionSetup';

function readSource(url: URL, label: string): string {
  if (!fs.existsSync(url)) {
    assert.fail(`${label} non trovato: ${url.pathname}`);
  }
  return fs.readFileSync(url, 'utf8');
}

/**
 * Scansione a parentesi bilanciate: gestisce stringhe, template literal e
 * commenti, cosi' le chiamate multi-riga vengono lette per intero.
 * Ritorna il testo degli argomenti di ogni invocazione del callee.
 */
function extractCallArguments(source: string, callee: string): { line: number; args: string }[] {
  const calls: { line: number; args: string }[] = [];
  const pattern = new RegExp(`\\b${callee}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    let i = source.indexOf('(', match.index);
    const openParen = i;
    let depth = 0;
    let quote: string | null = null;

    while (i < source.length) {
      const ch = source[i];

      if (quote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }

      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        i += 1;
        continue;
      }

      if (ch === '/' && source[i + 1] === '/') {
        const nl = source.indexOf('\n', i);
        i = nl < 0 ? source.length : nl;
        continue;
      }

      if (ch === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        i = end < 0 ? source.length : end + 2;
        continue;
      }

      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          const line = source.slice(0, match.index).split('\n').length;
          calls.push({ line, args: source.slice(openParen + 1, i) });
          pattern.lastIndex = i + 1;
          break;
        }
      }
      i += 1;
    }

    if (depth !== 0) {
      assert.fail(`parentesi non bilanciate nella chiamata a riga ${match.index}`);
    }
  }

  return calls;
}

describe('wiring statico buildExecutionSetup', () => {
  it('src/App.tsx esiste e viene letto come testo', () => {
    const source = readSource(APP_URL, 'src/App.tsx');
    assert.ok(source.length > 0, 'src/App.tsx e vuoto');
    assert.ok(
      source.includes('export default function App'),
      'src/App.tsx non sembra il componente App atteso',
    );
  });

  it(`ogni chiamata passa macroCalendar (minimo ${MIN_EXPECTED_INVOCATIONS} invocazioni)`, () => {
    const source = readSource(APP_URL, 'src/App.tsx');
    const calls = extractCallArguments(source, CALLEE);

    // Guardia anti-vacuita: una regex che non matcha nulla non deve passare.
    assert.ok(
      calls.length >= MIN_EXPECTED_INVOCATIONS,
      `trovate ${calls.length} invocazioni di ${CALLEE}, attese almeno ${MIN_EXPECTED_INVOCATIONS}`,
    );

    const missing = calls.filter((c) => !c.args.includes('macroCalendar:'));
    assert.deepEqual(
      missing.map((c) => c.line),
      [],
      `invocazioni senza macroCalendar alle righe: ${missing.map((c) => c.line).join(', ')}`,
    );

    const withField = calls.filter((c) => c.args.includes('macroCalendar:')).length;
    assert.equal(
      withField,
      calls.length,
      `contate ${withField} chiamate con macroCalendar su ${calls.length} totali`,
    );
  });

  it("SETUP_SELECTOR_LIVE e ancora 'off'", () => {
    const source = readSource(SELECTOR_URL, 'src/config/liveSelector.ts');
    const declaration = /export\s+const\s+SETUP_SELECTOR_LIVE\s*(?::[^=]+)?=\s*(['"`])(on|off)\1/.exec(
      source,
    );
    assert.ok(declaration, 'dichiarazione SETUP_SELECTOR_LIVE non trovata');
    assert.equal(declaration[2], 'off', 'SETUP_SELECTOR_LIVE non e "off"');
  });
});
