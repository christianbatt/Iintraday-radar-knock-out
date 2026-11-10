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
  let current = args;
  for (;;) {
    // La maschera si ricalcola a ogni giro: le sostituzioni accorciano il testo
    // e gli indici precedenti non valgono piu'.
    const mask = codeMask(current);
    let changed = false;
    current = current.replace(/\b\w+<[^<>]*>/g, (match, offset: number) => {
      // Dentro stringa, template o commento il testo non e' un tipo: toccarlo
      // muterebbe il contenuto del letterale (es. `'a<b>'` -> `'a'`).
      if (!mask[offset]) return match;
      changed = true;
      return match.slice(0, match.indexOf('<'));
    });
    if (!changed) return current;
  }
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

/**
 * Maschera "codice reale": commenti, stringhe e template literal sono esclusi.
 * I REGEX LITERAL vengono riconosciuti: un `'` dentro una regex non deve aprire
 * una stringa, altrimenti la scansione va fuori fase e nasconde il resto del
 * file (e' il difetto per cui un primo giro di questo audit "vedeva" solo 10
 * funzioni su 55).
 */
function codeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  const regexPrevChars = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
  const regexPrevWords = ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await'];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

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
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '/') {
      let p = i - 1;
      while (p >= 0 && /\s/.test(source[p])) p -= 1;
      const prev = p >= 0 ? source[p] : '';
      let isRegex = prev === '' || regexPrevChars.has(prev);
      if (!isRegex) {
        const word = /([A-Za-z_$][\w$]*)$/.exec(source.slice(Math.max(0, p - 11), p + 1));
        if (word && regexPrevWords.includes(word[1])) isRegex = true;
      }
      if (isRegex) {
        i += 1;
        while (i < source.length) {
          if (source[i] === '\\') {
            i += 2;
            continue;
          }
          if (source[i] === '[') {
            i += 1;
            while (i < source.length && source[i] !== ']') {
              if (source[i] === '\\') i += 1;
              i += 1;
            }
            i += 1;
            continue;
          }
          if (source[i] === '/') {
            i += 1;
            break;
          }
          if (source[i] === '\n') break;
          i += 1;
        }
        while (i < source.length && /[a-z]/i.test(source[i])) i += 1;
        continue;
      }
    }

    mask[i] = 1;
    i += 1;
  }

  return mask;
}

/** Indice della parentesi di chiusura che bilancia quella aperta in `openIdx`. */
function matchCloseIndex(source: string, mask: Uint8Array, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < source.length; i += 1) {
    if (!mask[i]) continue;
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Segmenti di primo livello separati da virgole (generici neutralizzati). */
function splitTopLevelSegments(text: string): string[] {
  const clean = stripGenericArguments(text);
  const mask = codeMask(clean);
  const segments: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < clean.length; i += 1) {
    if (!mask[i]) continue;
    const ch = clean[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      segments.push(clean.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(clean.slice(start));

  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/**
 * Nomi dei parametri di una firma. I parametri destrutturati non hanno un nome
 * singolo verificabile e tornano come `'{…}'`: chi consuma il risultato li
 * esclude dal controllo di lettura.
 */
export function extractParamNames(args: string): string[] {
  return splitTopLevelSegments(args).map((segment) => {
    if (/^[{[]/.test(segment)) return '{…}';
    const rest = segment.replace(/^\.\.\./, '');
    const match = /^([A-Za-z_$][\w$]*)/.exec(rest);
    return match ? match[1] : '{…}';
  });
}

/**
 * Corpo bilanciato della DICHIARAZIONE `function <callee>(…): Tipo { … }`.
 *
 * Richiede la parola chiave `function`: le chiamate non matchano, quindi
 * l'assunzione "il primo match e' la dichiarazione" e' verificata dal codice,
 * non sperata. Il tipo di ritorno viene saltato riconoscendo una `{` di tipo da
 * quella del corpo (una `{` preceduta da `< , | & : ( >` e' un tipo).
 */
export function extractFunctionBody(
  source: string,
  callee: string,
): { line: number; body: string; bodyLine: number; params: string } | null {
  const mask = codeMask(source);
  const pattern = new RegExp(`\\bfunction\\s+${callee}\\s*(?:<[^()]*>)?\\s*\\(`);
  const match = pattern.exec(source);
  if (!match || !mask[match.index]) return null;

  const line = source.slice(0, match.index).split('\n').length;
  const openIdx = match.index + match[0].length - 1;
  const closeIdx = matchCloseIndex(source, mask, openIdx, '(', ')');
  if (closeIdx < 0) return null;

  let j = closeIdx + 1;
  while (j < source.length && /\s/.test(source[j])) j += 1;

  if (source[j] === ':') {
    let k = j + 1;
    while (k < source.length) {
      if (!mask[k]) {
        k += 1;
        continue;
      }
      if (source[k] === '{') {
        let p = k - 1;
        while (p >= 0 && /\s/.test(source[p])) p -= 1;
        const prev = p >= 0 ? source[p] : '';
        if ('<,|&:(>'.includes(prev)) {
          const typeEnd = matchCloseIndex(source, mask, k, '{', '}');
          if (typeEnd < 0) return null;
          k = typeEnd + 1;
          continue;
        }
        break;
      }
      if (source[k] === '(') {
        const parenEnd = matchCloseIndex(source, mask, k, '(', ')');
        if (parenEnd < 0) return null;
        k = parenEnd + 1;
        continue;
      }
      if (source[k] === ')' || source[k] === '}') break;
      k += 1;
    }
    j = k;
  }

  if (source[j] !== '{') return null;
  const bodyEnd = matchCloseIndex(source, mask, j, '{', '}');
  if (bodyEnd < 0) return null;

  return {
    line,
    body: source.slice(j, bodyEnd + 1),
    bodyLine: source.slice(0, j).split('\n').length,
    params: source.slice(openIdx + 1, closeIdx),
  };
}

export type UnreadParamsAudit = {
  line: number;
  params: string[];
  unread: string[];
  bodyLength: number;
};

/**
 * Parametri dichiarati e MAI letti nel corpo: la regola vera dietro il "numero
 * fisso di parametri" di Passo F. Un parametro con un ref allineato e' un
 * valore che qualcuno ha passato e nessuno usa; un numero magico (`=== 6`) non
 * se ne accorge.
 */
export function findUnreadParams(source: string, callee: string): UnreadParamsAudit | null {
  const found = extractFunctionBody(source, callee);
  if (!found) return null;

  const params = extractParamNames(found.params);

  const unread = params.filter((name) => {
    if (name === '{…}') return false;
    return !new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(found.body);
  });

  return { line: found.line, params, unread, bodyLength: found.body.length };
}

/**
 * Ancoraggi delle due regioni "ref-backed" di `src/App.tsx`.
 *
 * Vivono qui, e non nei test, perche' erano duplicati alla lettera fra
 * `app_wiring.test.ts` e `audit_round2.test.ts`: la costante condivisa toglie
 * la copia, e una futura modifica al codice ha un solo posto da aggiornare.
 * `allowed` e' la sola lettura dallo state ammessa, con la sua motivazione.
 */
export const APP_REGIONS = {
  rerank: {
    anchor: '// Re-rank instantly when RSI Filter or parameters are changed',
    end: '\n  }, [rsiFilterActive, parameters]);',
    allowed: [
      {
        token: 'catalystCache',
        line: 'const currentCache: Record<string, GeminiCatalystAnalysis> = { ...catalystCache };',
        prevLine:
          "// PASSO E: catalystCache resta dallo state di proposito (snapshot pre-run: in questo run setCatalystCache e' gia' stato chiamato).",
      },
    ] as RegionAllowRule[],
  },
  scan: {
    // `const handleRunScreening` da solo comparirebbe DUE volte (c'e' anche
    // `const handleRunScreeningRef = React.useRef(...)`): l'ancora deve essere
    // unica, altrimenti l'invariante non sa quale regione sta guardando.
    anchor: 'const handleRunScreening = useCallback(async () => {',
    end: '}, [underlyings, currentSession, futures, rsiFilterActive, parameters, journalEntries]);',
    allowed: [] as RegionAllowRule[],
  },
} as const;

export type AppRegion = { anchor: string; end: string; allowed?: RegionAllowRule[] };

/**
 * Invariante di regione, in un posto solo: i test invocano questa funzione
 * invece di ripetere le quattro asserzioni, cosi' la REGOLA (ancora unica,
 * regione delimitata, eccezioni consumate, nessun offending) non puo' divergere
 * fra i due file. Duplicare l'invocazione e' accettabile, duplicare la regola no.
 */
export function assertRegionHasNoStateReads(
  source: string,
  region: AppRegion,
  label: string,
): RegionRefAudit {
  const audit = auditRegionRefs(source, region);
  const allowedCount = region.allowed?.length ?? 0;
  const problems: string[] = [];

  if (audit.anchorCount !== 1) {
    problems.push(`${label}: ancora trovata ${audit.anchorCount} volte (attesa 1)`);
  }
  if (!audit.regionFound) {
    problems.push(`${label}: regione non delimitata dopo la riga ${audit.regionStartLine}`);
  }
  if (audit.allowedHits !== allowedCount) {
    problems.push(`${label}: eccezioni ammesse soddisfatte ${audit.allowedHits} su ${allowedCount}`);
  }
  if (audit.offending.length > 0) {
    problems.push(
      `${label}: letture dirette dello state -> ${audit.offending
        .map((o) => `riga ${o.line}: ${o.token} (${o.snippet})`)
        .join(', ')}`,
    );
  }

  if (problems.length > 0) {
    assert.fail(problems.join(' | '));
  }

  return audit;
}
