import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_DESK_CONTRACT_VERSION,
  AI_DESK_MAX_CLAIMS,
  AI_DESK_MAX_DIRECTIVES,
  AI_DESK_MAX_SUMMARY_CHARS,
  buildDeskPrompt,
  buildEvidencePromptAddendum,
  extractJsonObject,
  extractMeasuredNumbers,
  parseDeskAnalysis,
  validateDeskAnalysis,
} from '../../knowledge/aiDeskContract';
import { buildAiEvidencePack } from '../../knowledge/aiEvidencePack';
import type { TradeJournalEntry } from '../../types/radar';

const T0 = Date.UTC(2026, 10, 25, 12, 0, 0);
const PREDICATES = ['MARKET_EU', 'MARKET_US', 'SESSION_EU'] as const;

function trade(partial: Partial<TradeJournalEntry>): TradeJournalEntry {
  return {
    id: 't1',
    timestamp: '2026-11-25T09:00:00.000Z',
    date: '2026-11-25',
    session: 'EU',
    market: 'EU',
    ticker: 'ENI.MI',
    direction: 'LONG',
    strategy: 'ORB',
    entryPrice: 100,
    exitPrice: 101,
    stopLoss: 99,
    target1: 102,
    pnlEur: 100,
    rMultiple: 1,
    outcome: 'WIN',
    notes: '',
    isPaper: false,
    ...partial,
  } as TradeJournalEntry;
}

function makePack() {
  return buildAiEvidencePack({
    generatedAtMs: T0,
    journal: {
      trades: [
        trade({ id: 'a', outcome: 'WIN', rMultiple: 2 }),
        trade({ id: 'b', outcome: 'LOSS', rMultiple: -1 }),
        trade({ id: 'c', outcome: 'WIN', rMultiple: 1 }),
        trade({ id: 'd', outcome: 'BREAKEVEN', rMultiple: 0 }),
        trade({ id: 'e', outcome: 'EXPIRED', rMultiple: 0 }),
      ],
      excluded: [],
    },
    vetoOutcomes: [
      {
        veto: 'SUPERTREND_OPPOSED',
        market: 'EU',
        n: 42,
        triggerFillPct: 55.5,
        target: 9,
        stop: 12,
        expired: 3,
        open: 2,
        noLevels: 1,
        meanRTrigger: 0.21,
        meanRMarket: 0.05,
        ciRMarket: [-0.31, 0.42],
      },
    ],
    shadowV1Live: {
      counts: { resolved: 42, persisted: 50 },
      metrics: { resolved: 42, meanR: 0.18, winRatePct: 52.38 },
    },
  });
}

function parse(body: unknown) {
  return parseDeskAnalysis(JSON.stringify(body), { pack: makePack(), predicateIds: PREDICATES });
}

describe('aiDeskContract — prompt', () => {
  it('include il fascicolo, lo schema e l enum dei predicati', () => {
    const prompt = buildDeskPrompt(makePack(), { predicateIds: PREDICATES, question: 'Analizza.' });
    assert.ok(prompt.userPrompt.includes('SECTION journal '));
    assert.ok(prompt.userPrompt.includes('evidenceRefs'));
    assert.ok(prompt.userPrompt.includes('MARKET_EU'));
    assert.ok(prompt.userPrompt.includes('Analizza.'));
    assert.ok(prompt.packChars > 0);
    assert.ok(prompt.systemInstruction.includes('non garantisci profitti'));
  });

  it('propaga le sezioni omesse dal budget', () => {
    const prompt = buildDeskPrompt(makePack(), { predicateIds: PREDICATES, maxChars: 300 });
    assert.ok(prompt.truncatedSections.length > 0);
  });

  it('non contiene promesse di rendimento nel testo utente', () => {
    const prompt = buildDeskPrompt(makePack(), { predicateIds: PREDICATES });
    assert.equal(/profitti garantiti|rendimento garantito/i.test(prompt.userPrompt), false);
  });
});

describe('aiDeskContract — estrazione JSON e numeri', () => {
  it('accetta JSON puro, dentro code fence e con prosa attorno', () => {
    assert.equal(extractJsonObject('{"a":1}'), '{"a":1}');
    assert.equal(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(extractJsonObject('Ecco: {"a":1} fine'), '{"a":1}');
    assert.equal(extractJsonObject(''), null);
    assert.equal(extractJsonObject('nessun json'), null);
  });

  it('distingue numeri misurati da etichette', () => {
    const tokens = extractMeasuredNumbers('G11 e Target 1, win rate 52,38%, R medio 0.18R, 15 barre');
    const measured = tokens.filter((token) => token.measured).map((token) => token.value);
    assert.deepEqual(measured, [52.38, 0.18]);
  });
});

describe('aiDeskContract — claim ancorati', () => {
  it('accetta un claim con riferimenti esistenti e numeri coerenti', () => {
    const result = parse({
      summary: 'Sintesi.',
      claims: [
        {
          statement: 'R medio 0.18R su 42 casi risolti',
          evidenceRefs: ['shadowV1Live.meanR', 'shadowV1Live.resolved'],
        },
      ],
      dataGaps: [],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.claims.length, 1);
    assert.equal(result.analysis.complete, true);
    assert.deepEqual(result.analysis.evidenceKeysUsed, ['shadowV1Live.meanR', 'shadowV1Live.resolved']);
    assert.equal(result.analysis.contractVersion, AI_DESK_CONTRACT_VERSION);
  });

  it('accetta numeri arrotondati entro la tolleranza', () => {
    const result = parse({
      claims: [{ statement: 'R medio 0.183R', evidenceRefs: ['shadowV1Live.meanR'] }],
    });
    assert.equal(result.ok && result.analysis.claims.length, 1);
  });

  it('rifiuta un numero inventato', () => {
    const result = parse({
      claims: [{ statement: 'Win rate 61,4% nel campione', evidenceRefs: ['shadowV1Live.winRatePct'] }],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.claims.length, 0);
    assert.equal(result.analysis.rejected[0]?.code, 'unsupported_number');
    assert.equal(result.analysis.complete, false);
  });

  it('non valida le etichette senza unita', () => {
    const result = parse({
      claims: [{ statement: 'Il gate G11 e Target 1 compaiono spesso', evidenceRefs: ['journal.n'] }],
    });
    assert.equal(result.ok && result.analysis.claims.length, 1);
  });

  it('rifiuta un riferimento inesistente', () => {
    const result = parse({
      claims: [{ statement: 'Affermazione', evidenceRefs: ['inventata.key'] }],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.claims.length, 0);
    assert.deepEqual(
      result.analysis.rejected.map((item) => item.code),
      ['unknown_ref', 'no_ref']
    );
  });

  it('rifiuta un claim senza riferimenti', () => {
    const result = parse({ claims: [{ statement: 'Senza fonte' }] });
    assert.equal(result.ok && result.analysis.rejected[0]?.code, 'no_ref');
  });

  it('marca insufficienti i claim basati solo su chiavi sotto soglia', () => {
    const result = parse({
      claims: [{ statement: 'Il diario ha 5 trade', evidenceRefs: ['journal.n'] }],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.claims[0]?.insufficient, true);
  });

  it('tronca la sintesi e non propaga campi arbitrari', () => {
    const result = parse({ summary: 'x'.repeat(2000), confidence: 0.97, claims: [] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.summary.length, AI_DESK_MAX_SUMMARY_CHARS);
    assert.equal(JSON.stringify(result.analysis).includes('confidence'), false);
  });

  it('applica il tetto ai claim', () => {
    const claims = Array.from({ length: AI_DESK_MAX_CLAIMS + 4 }, () => ({
      statement: 'affermazione valida',
      evidenceRefs: ['journal.n'],
    }));
    const result = parse({ claims });
    assert.equal(result.ok && result.analysis.claims.length, AI_DESK_MAX_CLAIMS);
  });
});

describe('aiDeskContract — direttive', () => {
  it('accetta una direttiva con predicato ammesso e riferimenti', () => {
    const result = parse({
      proposedDirectives: [
        {
          topic: 'FILTRO_EU',
          market: 'EU',
          predicateId: 'MARKET_EU',
          directive: 'Preferire i setup EU quando il campione lo sostiene.',
          evidenceRefs: ['veto.EU.SUPERTREND_OPPOSED.meanRMarket'],
        },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.proposedDirectives.length, 1);
  });

  it('rifiuta predicato fuori enum, mercato invalido e riferimenti assenti', () => {
    const result = parse({
      proposedDirectives: [
        { topic: 'T1', market: 'EU', predicateId: 'INVENTATO', directive: 'x', evidenceRefs: ['journal.n'] },
        { topic: 'T2', market: 'ASIA', predicateId: 'MARKET_EU', directive: 'x', evidenceRefs: ['journal.n'] },
        { topic: 'T3', market: 'EU', predicateId: 'MARKET_EU', directive: 'x', evidenceRefs: [] },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.proposedDirectives.length, 0);
    assert.deepEqual(
      result.analysis.rejected.map((item) => item.code),
      ['invalid_predicate', 'invalid_market', 'no_ref']
    );
  });

  it('applica il tetto alle direttive', () => {
    const proposedDirectives = Array.from({ length: AI_DESK_MAX_DIRECTIVES + 3 }, () => ({
      topic: 'T',
      market: 'EU',
      predicateId: 'MARKET_EU',
      directive: 'd',
      evidenceRefs: ['journal.n'],
    }));
    const result = parse({ proposedDirectives });
    assert.equal(result.ok && result.analysis.proposedDirectives.length, AI_DESK_MAX_DIRECTIVES);
  });
});

describe('aiDeskContract — sintesi ancorata al fascicolo', () => {
  it('la sintesi senza summaryRefs non e verificata, anche senza numeri', () => {
    const result = parse({ summary: 'Il desk ha operato con disciplina.' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.summaryVerified, false);
    assert.deepEqual(result.analysis.summaryDeclaredRefs, []);
    assert.deepEqual(result.analysis.summaryEvidenceRefs, []);
    assert.equal(result.analysis.verified, false);
  });

  it('la sintesi con summaryRefs e numeri del fascicolo e verificata', () => {
    const result = parse({
      summary: 'Win rate 52,38% con R medio 0.18R.',
      summaryRefs: ['shadowV1Live.winRatePct'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.summaryVerified, true);
    assert.deepEqual(result.analysis.summaryDeclaredRefs, ['shadowV1Live.winRatePct']);
    assert.deepEqual(result.analysis.summaryEvidenceRefs, [
      'shadowV1Live.meanR',
      'shadowV1Live.winRatePct',
    ]);
    assert.deepEqual(result.analysis.summaryUnsupportedNumbers, []);
  });

  it('un summaryRefs inesistente non verifica la sintesi', () => {
    const result = parse({
      summary: 'Il desk ha operato con disciplina.',
      summaryRefs: ['chiave.inventata'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.analysis.summaryDeclaredRefs, []);
    assert.equal(result.analysis.summaryVerified, false);
  });

  it('una sintesi con un numero inventato e marcata non verificata', () => {
    const result = parse({
      summary: 'Win rate 61,4% nel campione.',
      summaryRefs: ['shadowV1Live.winRatePct'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.summaryVerified, false);
    assert.deepEqual(result.analysis.summaryUnsupportedNumbers, ['61,4%']);
    assert.equal(result.analysis.verified, false);
  });

  it('un claim valido non basta se la sintesi non e ancorata', () => {
    const result = parse({
      summary: 'R medio 9,99R',
      summaryRefs: ['shadowV1Live.meanR'],
      claims: [{ statement: 'R medio 0.18R', evidenceRefs: ['shadowV1Live.meanR'] }],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.claims.length, 1);
    assert.equal(result.analysis.complete, true);
    assert.equal(result.analysis.verified, false);
  });
});

describe('aiDeskContract — riuso della risposta gia ottenuta', () => {
  it('accetta la forma storica executiveSummary/newDirectives senza richiamare la LLM', () => {
    const result = parse({
      executiveSummary: 'Sintesi del Risk Officer: win rate 52,38%.',
      strengths: ['x'],
      failurePatterns: ['y'],
      tacticalAdvice: 'z',
      newDirectives: [
        { topic: 'T', market: 'EU', predicateId: 'MARKET_EU', directive: 'd' },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.summary, 'Sintesi del Risk Officer: win rate 52,38%.');
    // Forma storica: nessun summaryRefs, quindi sintesi non verificata.
    assert.equal(result.analysis.summaryVerified, false);
    assert.deepEqual(result.analysis.summaryDeclaredRefs, []);
    assert.equal(result.analysis.proposedDirectives.length, 0);
    assert.deepEqual(
      result.analysis.rejected.map((item) => item.code),
      ['no_ref']
    );
    assert.equal(result.analysis.complete, false);
  });
});

describe('aiDeskContract — contratto nella stessa chiamata LLM', () => {
  it("l'addendum porta fascicolo, summaryRefs ed evidenceRefs senza secondo giro", () => {
    const addendum = buildEvidencePromptAddendum(makePack(), { predicateIds: PREDICATES });
    assert.match(addendum, /FASCICOLO PROBATORIO/);
    assert.match(addendum, /"summaryRefs"/);
    assert.match(addendum, /"evidenceRefs"/);
    assert.match(addendum, /MARKET_EU/);
    assert.match(addendum, /NON VERIFICATA/);
    const base = 'Istruzioni originali del desk.';
    assert.equal((base + addendum).indexOf(base), 0);
  });

  it('una direttiva con evidenceRefs validi passa, una senza refs viene scartata', () => {
    const result = parse({
      summary: 'Win rate 52,38% sulle operazioni chiuse.',
      summaryRefs: ['shadowV1Live.winRatePct'],
      newDirectives: [
        {
          topic: 'Filtro trend',
          market: 'EU',
          predicateId: 'MARKET_EU',
          directive: 'Non aprire contro il SuperTrend.',
          evidenceRefs: ['shadowV1Live.winRatePct'],
        },
        {
          topic: 'Senza fonte',
          market: 'EU',
          predicateId: 'MARKET_EU',
          directive: 'Regola non ancorata.',
        },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.analysis.proposedDirectives.length, 1);
    assert.deepEqual(result.analysis.rejected.map((item) => item.code), ['no_ref']);
    assert.equal(result.analysis.summaryVerified, true);
    assert.equal(result.analysis.verified, false);
  });
});

describe('aiDeskContract — dataGaps e input non validi', () => {
  it('limita i dataGaps a sei voci', () => {
    const result = parse({ dataGaps: Array.from({ length: 9 }, (_, index) => `gap ${index}`) });
    assert.equal(result.ok && result.analysis.dataGaps.length, 6);
  });

  it('testo vuoto o JSON invalido non lanciano', () => {
    const empty = parseDeskAnalysis('', { pack: makePack(), predicateIds: PREDICATES });
    assert.deepEqual(empty.ok ? null : empty.error, 'empty');
    const broken = parseDeskAnalysis('{non json}', { pack: makePack(), predicateIds: PREDICATES });
    assert.deepEqual(broken.ok ? null : broken.error, 'invalid_json');
  });

  it('input non oggetto produce un analisi vuota invece di un crash', () => {
    const analysis = validateDeskAnalysis('stringa', { pack: makePack(), predicateIds: PREDICATES });
    assert.equal(analysis.claims.length, 0);
    assert.equal(analysis.summary, '');
    assert.equal(analysis.complete, true);
  });

  it('senza chiavi citate non si producono riferimenti inventati', () => {
    const analysis = validateDeskAnalysis(
      { claims: [{ statement: 'x', evidenceRefs: ['journal.n'] }] },
      { pack: makePack(), predicateIds: [] }
    );
    assert.deepEqual(analysis.evidenceKeysUsed, ['journal.n']);
  });
});
