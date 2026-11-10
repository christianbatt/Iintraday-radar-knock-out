/**
 * Helper di audit STATICO sulla sorgente, condivisi dai test.
 *
 * NON e' un `*.test.ts`: il runner (`find src -name '*.test.ts'`) non lo esegue.
 * Nessun `describe`/`it`, nessun side effect all'import: `audit_round2.test.ts`
 * gira ad alto livello, un import con effetti la romperebbe.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

export function readSource(url: URL, label: string): string {
  if (!fs.existsSync(url)) {
    assert.fail(`${label} non trovato: ${url.pathname}`);
  }
  return fs.readFileSync(url, 'utf8');
}

/**
 * Scansione a parentesi bilanciate: gestisce stringhe, template literal e
 * commenti, cosi' le chiamate multi-riga vengono lette per intero.
 * Ritorna il testo degli argomenti di ogni invocazione del callee.
 * Nota: la DICHIARAZIONE (`export function callee(`) matcha la stessa regex ed
 * e' quindi la prima entry quando si scansiona il file che la contiene.
 */
export function extractCallArguments(
  source: string,
  callee: string,
): { line: number; args: string }[] {
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

/**
 * Valore testuale di un campo dentro gli argomenti di una chiamata.
 * Si ferma alla virgola: nessun valore osservato contiene virgole.
 */
export function fieldValue(args: string, field: string): string | null {
  const match = new RegExp(`\\b${field}\\s*:\\s*([^,}\\n]+)`).exec(args);
  return match ? match[1].trim() : null;
}

/**
 * Rimuove le liste di argomenti generici (`Record<string, number>` -> `Record`),
 * dalla piu' interna verso l'esterno: senza questo passo la virgola dentro
 * `Record<string, X>` verrebbe contata come separatore di parametri.
 */
function stripGenericArguments(args: string): string {
  let previous: string;
  let current = args;
  do {
    previous = current;
    current = current.replace(/\b\w+<[^<>]*>/g, (match) => match.slice(0, match.indexOf('<')));
  } while (current !== previous);
  return current;
}

/**
 * Numero di argomenti in un testo di argomenti gia' estratto: conta le virgole
 * a profondita' zero (parentesi, graffe, quadre) ignorando stringhe e commenti.
 * Le liste di generici sono neutralizzate prima del conteggio.
 */
export function countTopLevelArgs(args: string): number {
  const text = stripGenericArguments(args).trim();
  if (text.length === 0) return 0;

  let depth = 0;
  let quote: string | null = null;
  // Segmenti top-level: una virgola finale (trailing comma, valida in TS) non
  // crea un argomento, quindi si contano i segmenti non vuoti.
  const segments: string[] = [];
  let segmentStart = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      segments.push(text.slice(segmentStart, i));
      segmentStart = i + 1;
    }
  }

  segments.push(text.slice(segmentStart));
  return segments.filter((segment) => segment.trim().length > 0).length;
}

export type RegionAllowRule = {
  /** Token ammesso (`catalystCache` oppure `sessionInfo`). */
  token: string;
  /** Testo ESATTO della riga ammessa, confrontato per uguaglianza dopo trim. */
  line: string;
  /** Testo ESATTO del marcatore sulla riga immediatamente precedente. */
  prevLine: string;
};

export type RegionRefAudit = {
  anchorCount: number;
  regionFound: boolean;
  regionStartLine: number;
  regionEndLine: number;
  offending: { line: number; token: string; snippet: string }[];
  /** Regole `allowed` che hanno effettivamente trovato la loro riga. */
  allowedHits: number;
};

/**
 * Invariante su una regione di codice: dentro la regione (ancora -> `end`)
 * i token nudi `catalystCache` e `sessionInfo` non devono comparire, salvo le
 * occorrenze ammesse da `allowed`.
 *
 * - L'ancora deve esistere ESATTAMENTE una volta e `end` deve trovarsi dopo di
 *   essa, altrimenti la regione non e' identificabile e il test fallisce.
 * - Le righe di solo commento sono prosa: ignorate.
 * - I token si cercano con `\b...\b`, quindi `catalystCacheRef`, `setCatalystCache`
 *   e `sessionInfoRef` NON matchano.
 * - Ogni regola ammette AL MOMENTO UNA sola occorrenza: la seconda e' un offending.
 */
export function auditRegionRefs(
  source: string,
  options: { anchor: string; end: string; allowed?: RegionAllowRule[] },
): RegionRefAudit {
  const { anchor, end, allowed = [] } = options;
  const anchorCount = source.split(anchor).length - 1;
  const empty = { anchorCount, regionFound: false, regionStartLine: 0, regionEndLine: 0, offending: [], allowedHits: 0 };

  if (anchorCount !== 1) return empty;

  const startIdx = source.indexOf(anchor);
  const endIdx = source.indexOf(end, startIdx);
  if (endIdx < 0) {
    return { ...empty, regionStartLine: source.slice(0, startIdx).split('\n').length };
  }

  const regionStartLine = source.slice(0, startIdx).split('\n').length;
  const region = source.slice(startIdx, endIdx + end.length);
  const lines = region.split('\n');
  const regionEndLine = regionStartLine + lines.length - 1;

  const offending: RegionRefAudit['offending'] = [];
  const used = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i];
    // Le righe di solo commento sono prosa (spiegano le scelte): non sono letture.
    if (lineText.trim().startsWith('//')) continue;

    const tokens = lineText.match(/\b(catalystCache|sessionInfo)\b/g) ?? [];
    for (const token of tokens) {
      const ruleIndex = allowed.findIndex(
        (rule, index) =>
          !used.has(index) &&
          rule.token === token &&
          lineText.trim() === rule.line.trim() &&
          i > 0 &&
          lines[i - 1].trim() === rule.prevLine.trim(),
      );

      if (ruleIndex >= 0) {
        used.add(ruleIndex);
        continue;
      }

      offending.push({
        line: regionStartLine + i,
        token,
        snippet: lineText.trim().slice(0, 140),
      });
    }
  }

  return {
    anchorCount,
    regionFound: true,
    regionStartLine,
    regionEndLine,
    offending,
    allowedHits: used.size,
  };
}

export type CalendarPairAudit = {
  calls: number;
  unparsed: number[];
  mismatches: { line: number; events: string; calendar: string }[];
};

/**
 * Confronto esatto fra `macroEvents` e `macroCalendar`.
 *
 * Il confronto NON puo' essere un semplice `startsWith`: `'macroCalendarRef.current'`
 * inizia per `'macroCalendar'`, quindi un calendar preso dal ref supererebbe il
 * controllo del prefisso e la coppia incoerente (eventi dalla variabile, calendario
 * dal ref) passerebbe in silenzio. Il ref e' quindi ammesso solo quando gli eventi
 * arrivano dal ref, ed escluso ESPLICITAMENTE quando arrivano dalla variabile.
 */
export function auditCalendarPairing(source: string, callee: string): CalendarPairAudit {
  const calls = extractCallArguments(source, callee);
  const unparsed: number[] = [];
  const mismatches: CalendarPairAudit['mismatches'] = [];

  for (const call of calls) {
    const events = fieldValue(call.args, 'macroEvents');
    const calendar = fieldValue(call.args, 'macroCalendar');

    if (events === null || calendar === null) {
      unparsed.push(call.line);
      continue;
    }

    // Il ref va riconosciuto per primo: il suo nome contiene il prefisso della variabile.
    const expected = events.startsWith('macroCalendarRef.current')
      ? 'macroCalendarRef.current'
      : events.startsWith('macroCalendar')
        ? 'macroCalendar'
        : null;

    if (expected === null) {
      unparsed.push(call.line);
      continue;
    }

    const consistent =
      expected === 'macroCalendarRef.current'
        ? calendar.startsWith('macroCalendarRef.current')
        : calendar.startsWith('macroCalendar') && !calendar.startsWith('macroCalendarRef');

    if (!consistent) {
      mismatches.push({ line: call.line, events, calendar });
    }
  }

  return { calls: calls.length, unparsed, mismatches };
}
