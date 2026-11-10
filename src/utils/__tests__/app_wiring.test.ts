/**
 * Wiring statico: ogni chiamata a buildExecutionSetup in src/App.tsx deve
 * passare `macroCalendar`, e le due regioni con stato "ref-backed"
 * (effetto re-rank e handleRunScreening) non devono leggere dallo state i
 * valori che hanno un ref allineato. Legge i file come TESTO: non importa
 * App.tsx, quindi niente React/DOM in questo test.
 *
 * Runner: npx tsx src/utils/__tests__/app_wiring.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditCalendarPairing,
  auditRegionRefs,
  extractCallArguments,
  findUnreadParams,
  readSource,
  type RegionAllowRule,
} from './sourceAudit';

const APP_URL = new URL('../../App.tsx', import.meta.url);
const CALC_URL = new URL('../calculator.ts', import.meta.url);
const SELECTOR_URL = new URL('../../config/liveSelector.ts', import.meta.url);
const SELECTOR_CALL_URL = new URL('../setupSelector.ts', import.meta.url);
const MIN_EXPECTED_INVOCATIONS = 15;
const CALLEE = 'buildExecutionSetup';
const AUDIT_CALLEE = 'generateFilteringAuditReport';

// --- Regione 1: effetto re-rank ------------------------------------------
const RERANK_ANCHOR = '// Re-rank instantly when RSI Filter or parameters are changed';
const RERANK_END = '\n  }, [rsiFilterActive, parameters]);';

// --- Regione 2: handleRunScreening ---------------------------------------
// `const handleRunScreening` da solo comparirebbe DUE volte (c'e' anche
// `const handleRunScreeningRef = React.useRef(...)`): l'ancora deve essere
// unica, altrimenti l'invariante non sa quale regione sta guardando.
const SCAN_ANCHOR = 'const handleRunScreening = useCallback(async () => {';
const SCAN_END = '}, [underlyings, currentSession, futures, rsiFilterActive, parameters, journalEntries]);';

/**
 * Unica lettura dallo state ammessa, con motivazione dichiarata:
 * `catalystCache` e' lo snapshot PRE-RUN. In questo run `setCatalystCache` e'
 * gia' stato chiamato (resolveCandidateCatalyst), quindi il ref potrebbe gia'
 * contenere i catalyst risolti e `currentCache` non sarebbe piu' lo snapshot
 * pre-run: cambierebbe la lista degli esclusi nel Catalyst Gate del report.
 * La regola e' pinnata sul testo esatto: nessun `includes`, nessun marcatore
 * "qualsiasi".
 */
const RERANK_ALLOWED: RegionAllowRule[] = [
  {
    token: 'catalystCache',
    line: 'const currentCache: Record<string, GeminiCatalystAnalysis> = { ...catalystCache };',
    prevLine:
      "// PASSO E: catalystCache resta dallo state di proposito (snapshot pre-run: in questo run setCatalystCache e' gia' stato chiamato).",
  },
];

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

  it(`macroCalendar deriva dalla stessa sorgente di macroEvents (minimo ${MIN_EXPECTED_INVOCATIONS} invocazioni)`, () => {
    const source = readSource(APP_URL, 'src/App.tsx');
    const audit = auditCalendarPairing(source, CALLEE);

    // Guardia anti-vacuita: la coppia si verifica solo su un campione reale.
    assert.ok(
      audit.calls >= MIN_EXPECTED_INVOCATIONS,
      `trovate ${audit.calls} invocazioni di ${CALLEE}, attese almeno ${MIN_EXPECTED_INVOCATIONS}`,
    );

    assert.deepEqual(
      audit.unparsed,
      [],
      `campi non riconosciuti alle righe: ${audit.unparsed.join(', ')}`,
    );
    assert.deepEqual(
      audit.mismatches.map(
        (m) => `riga ${m.line}: macroEvents=${m.events} ma macroCalendar=${m.calendar}`,
      ),
      [],
      'coppie incoerenti',
    );
  });

  it('il controllo di coppia segnala il ref come calendar quando events viene dalla variabile', () => {
    // Sorgente sintetica: `macroCalendarRef.current` inizia per `macroCalendar`,
    // quindi senza l'esclusione esplicita del prefisso questa coppia passerebbe.
    const synthetic = [
      'const macroCalendar = buildMacroCalendar(events);',
      'const macroCalendarRef = useRef<MacroCalendarState | null>(null);',
      'const setup = buildExecutionSetup(candidate, catalyst, "EU", params, {',
      '  macroEvents: macroCalendar?.events,',
      '  macroCalendar: macroCalendarRef.current,',
      '});',
    ].join('\n');

    const audit = auditCalendarPairing(synthetic, CALLEE);

    assert.equal(audit.calls, 1, 'la sorgente sintetica deve avere una sola invocazione');
    assert.deepEqual(audit.unparsed, [], 'la coppia sintetica deve essere leggibile');
    assert.equal(audit.mismatches.length, 1, 'la coppia incoerente non e stata segnalata');
    assert.equal(audit.mismatches[0].calendar, 'macroCalendarRef.current');
  });

  it("SETUP_SELECTOR_LIVE e ancora 'off'", () => {
    const source = readSource(SELECTOR_URL, 'src/config/liveSelector.ts');
    const declaration = /export\s+const\s+SETUP_SELECTOR_LIVE\s*(?::[^=]+)?=\s*(['"`])(on|off)\1/.exec(
      source,
    );
    assert.ok(declaration, 'dichiarazione SETUP_SELECTOR_LIVE non trovata');
    assert.equal(declaration[2], 'off', 'SETUP_SELECTOR_LIVE non e "off"');
  });

  it("l'effetto re-rank non legge dallo state i valori che hanno un ref allineato", () => {
    const source = readSource(APP_URL, 'src/App.tsx');
    const audit = auditRegionRefs(source, {
      anchor: RERANK_ANCHOR,
      end: RERANK_END,
      allowed: RERANK_ALLOWED,
    });

    assert.equal(
      audit.anchorCount,
      1,
      `ancora dell'effetto re-rank trovata ${audit.anchorCount} volte (attesa: 1)`,
    );
    assert.ok(
      audit.regionFound,
      `regione dell'effetto re-rank non delimitata (deps array non trovato dopo la riga ${audit.regionStartLine})`,
    );
    // Guardia anti-vacuita: l'unica eccezione ammessa deve essere stata consumata,
    // altrimenti la regola e' scritta su un testo che non esiste piu'.
    assert.equal(
      audit.allowedHits,
      RERANK_ALLOWED.length,
      `regole ammesse soddisfatte: ${audit.allowedHits} su ${RERANK_ALLOWED.length}`,
    );
    assert.deepEqual(
      audit.offending.map((o) => `riga ${o.line}: ${o.token} -> ${o.snippet}`),
      [],
      "letture dirette dello state dentro l'effetto re-rank",
    );
  });

  it('la regione della scansione non legge dallo state i valori che hanno un ref allineato', () => {
    const source = readSource(APP_URL, 'src/App.tsx');
    const audit = auditRegionRefs(source, { anchor: SCAN_ANCHOR, end: SCAN_END });

    assert.equal(
      audit.anchorCount,
      1,
      `ancora di handleRunScreening trovata ${audit.anchorCount} volte (attesa: 1)`,
    );
    assert.ok(
      audit.regionFound,
      `regione di handleRunScreening non delimitata (deps array non trovato dopo la riga ${audit.regionStartLine})`,
    );
    // Nessuna eccezione: nella scansione ogni valore con ref deve venire dal ref.
    assert.equal(audit.allowedHits, 0, 'la scansione non ha letture ammesse');
    assert.deepEqual(
      audit.offending.map((o) => `riga ${o.line}: ${o.token} -> ${o.snippet}`),
      [],
      'letture dirette dello state dentro handleRunScreening',
    );
  });

  // --- Anti-vacuita: l'helper deve fallire quando deve -------------------
  it('l\'audit di regione segnala una lettura nuda di sessionInfo', () => {
    const synthetic = [
      'const regione = () => {',
      '  const x = sessionInfo?.cet?.currentMinutes;',
      '\n};',
    ].join('\n');

    const audit = auditRegionRefs(synthetic, { anchor: 'const regione = () => {', end: '\n};' });

    assert.equal(audit.anchorCount, 1);
    assert.ok(audit.regionFound, 'la regione sintetica deve essere delimitata');
    assert.deepEqual(
      audit.offending.map((o) => `riga ${o.line}: ${o.token}`),
      ['riga 2: sessionInfo'],
      'la lettura nuda non e stata segnalata alla riga attesa',
    );
  });

  it('la seconda snapshot marcata e un offending: ogni regola ammette una sola occorrenza', () => {
    const mark = '// PASSO E: snapshot documentata';
    const snapshot = 'const currentCache = { ...catalystCache };';
    const synthetic = [
      'const regione = () => {',
      `  ${mark}`,
      `  ${snapshot}`,
      `  ${mark}`,
      `  ${snapshot}`,
      '\n};',
    ].join('\n');

    const audit = auditRegionRefs(synthetic, {
      anchor: 'const regione = () => {',
      end: '\n};',
      allowed: [{ token: 'catalystCache', line: snapshot, prevLine: mark }],
    });

    assert.equal(audit.allowedHits, 1, 'la regola deve ammettere esattamente una occorrenza');
    assert.deepEqual(
      audit.offending.map((o) => `riga ${o.line}: ${o.token}`),
      ['riga 5: catalystCache'],
      'la seconda snapshot non e stata segnalata alla riga attesa',
    );
  });

  // --- Firma del report di audit: nessun parametro morto ------------------
  it('generateFilteringAuditReport non dichiara parametri che nessuno legge', () => {
    const calc = readSource(CALC_URL, 'src/utils/calculator.ts');
    const audit = findUnreadParams(calc, AUDIT_CALLEE);

    assert.ok(audit, `dichiarazione di ${AUDIT_CALLEE} non trovata`);
    // Guardie anti-vacuita': senza corpo non c'e' niente da verificare, e una
    // firma letta male darebbe zero parametri (cioe' zero controlli).
    assert.ok(audit.bodyLength > 0, `corpo vuoto per ${AUDIT_CALLEE}`);
    assert.ok(
      audit.params.length > 0,
      `nessun parametro estratto dalla firma a riga ${audit.line}`,
    );
    assert.deepEqual(
      audit.unread,
      [],
      `riga ${audit.line}: parametri dichiarati e mai letti nel corpo: ${audit.unread.join(', ')}`,
    );
  });

  it('nessun parametro morto nelle funzioni chiuse da Passo G1', () => {
    const calc = readSource(CALC_URL, 'src/utils/calculator.ts');
    const closed = [
      'calculateDynamicBreakeven',
      'calculateDerivativeStressReport',
      'runExcludedSetupsAutoAnalysis',
    ];

    for (const callee of closed) {
      const audit = findUnreadParams(calc, callee);
      assert.ok(audit, `${callee}: dichiarazione non trovata`);
      assert.ok(audit.params.length > 0, `${callee}: nessun parametro estratto`);
      assert.deepEqual(
        audit.unread,
        [],
        `${callee} (riga ${audit.line}): parametri mai letti: ${audit.unread.join(', ')}`,
      );
    }
    assert.equal(closed.length, 3, 'la lista delle funzioni chiuse non e stata svuotata');
  });

  it('applyCalendarSelector non dichiara parametri che nessuno legge', () => {
    const source = readSource(SELECTOR_CALL_URL, 'src/utils/setupSelector.ts');
    const audit = findUnreadParams(source, 'applyCalendarSelector');

    assert.ok(audit, 'dichiarazione di applyCalendarSelector non trovata');
    assert.ok(audit.params.length > 0, 'nessun parametro estratto dalla firma');
    assert.deepEqual(
      audit.unread,
      [],
      `riga ${audit.line}: parametri dichiarati e mai letti nel corpo: ${audit.unread.join(', ')}`,
    );
  });

  it('il controllo dei parametri non letti segnala quelli realmente non letti', () => {
    // Sorgente sintetica: `inerte` e' dichiarato nell'ordine e mai usato.
    const synthetic = [
      'export function finta(usato: number, inerte: string): number {',
      '  return usato;',
      '}',
    ].join('\n');

    const audit = findUnreadParams(synthetic, 'finta');

    assert.ok(audit, 'dichiarazione sintetica non trovata');
    assert.deepEqual(audit.params, ['usato', 'inerte'], 'parametri letti male dalla firma');
    assert.deepEqual(audit.unread, ['inerte'], 'il parametro inerte non e stato segnalato');
  });
});
