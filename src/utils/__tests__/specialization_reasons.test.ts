/**
 * ADDITIVO (v9, Parte 5): test dei rami di reason di /api/ai/specialize e del desk
 * sulla funzione pura reale resolveSpecializationOutcome, più i test di
 * applyPredicate per ogni predicato dell'enum chiuso LEARNING_PREDICATES.
 * I rami GATE_NON_SUPERATI e OK_SCRITTO sono esercitati sulle funzioni reali
 * updateAIMemory/validateLearningPattern: copertura della funzione, non dell'handler.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveSpecializationOutcome,
  SPECIALIZATION_REASONS,
  SpecializationOutcomeInput,
} from '../specializationReason';
import {
  validateLearningPattern,
  applyPredicate,
  isLearningPredicateId,
  LEARNING_PREDICATE_IDS,
  LearningResult,
} from '../learningValidator';
import { updateAIMemory } from '../memoryUpdater';
import { TradeJournalEntry } from '../../types/radar';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS | ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL | ${label}${detail ? ` | ${detail}` : ''}`);
  }
}

const base: SpecializationOutcomeInput = {
  hasOpenRouterKey: false,
  geminiAvailable: false,
  llmErrorDetail: null,
  validDirectivesCount: 1,
  discardedCount: 0,
  decisiveSample: 40,
  minSample: 30,
  writtenCount: 0,
};

// 1) CHIAVE_ASSENTE
const r1 = resolveSpecializationOutcome({ ...base });
check('CHIAVE_ASSENTE', r1.reason === 'CHIAVE_ASSENTE', r1.reason);

// 2) LLM_ERRORE con status
const r2 = resolveSpecializationOutcome({ ...base, hasOpenRouterKey: true, llmErrorDetail: 'openrouter:401' });
check('LLM_ERRORE con status', r2.reason === 'LLM_ERRORE' && r2.reasonDetail === 'openrouter:401', `${r2.reason} ${r2.reasonDetail}`);

// 3) LLM_VUOTA (nessuna direttiva, nessuna scartata)
const r3 = resolveSpecializationOutcome({ ...base, hasOpenRouterKey: true, validDirectivesCount: 0, discardedCount: 0 });
check('LLM_VUOTA', r3.reason === 'LLM_VUOTA', r3.reason);

// 4) PREDICATO_NON_VALIDO (tutte le direttive scartate per predicateId)
const r4 = resolveSpecializationOutcome({ ...base, hasOpenRouterKey: true, validDirectivesCount: 0, discardedCount: 2 });
check(
  'PREDICATO_NON_VALIDO solo su invocazione diretta (non emesso dal flusso v10)',
  r4.reason === 'PREDICATO_NON_VALIDO' && r4.reasonDetail === '2/2 direttive scartate: predicateId assente o fuori enum.',
  `${r4.reason} ${r4.reasonDetail}`
);

// 5) CAMPIONE_INSUFFICIENTE (n/30 sul predicato)
const r5 = resolveSpecializationOutcome({ ...base, hasOpenRouterKey: true, decisiveSample: 12 });
check(
  'CAMPIONE_INSUFFICIENTE 12/30',
  r5.reason === 'CAMPIONE_INSUFFICIENTE' && r5.reasonDetail === '12/30 trade decisivi: nessun predicato con campione sufficiente.',
  `${r5.reason} ${r5.reasonDetail}`
);

// 6) GATE_NON_SUPERATI
const r6 = resolveSpecializationOutcome({
  ...base,
  hasOpenRouterKey: true,
  writtenCount: 0,
  gateDetail: 'n=40, q=0.5000, avgR=0.20, profitFactor=2.00',
});
check(
  'GATE_NON_SUPERATI con dettaglio gate',
  r6.reason === 'GATE_NON_SUPERATI' && r6.reasonDetail === 'n=40, q=0.5000, avgR=0.20, profitFactor=2.00',
  `${r6.reason} ${r6.reasonDetail}`
);

// 7) OK_SCRITTO
const r7 = resolveSpecializationOutcome({ ...base, hasOpenRouterKey: true, writtenCount: 2 });
check(
  'OK_SCRITTO con 2 regole',
  r7.reason === 'OK_SCRITTO' && r7.reasonDetail === '2 regola/e scritte in memoria dopo i gate statistici.',
  `${r7.reason} ${r7.reasonDetail}`
);

// 6b) gateDetail coerente: mai "X/30 … nessun predicato" con X >= 30
const r6b = resolveSpecializationOutcome({
  ...base,
  hasOpenRouterKey: true,
  decisiveSample: 40,
  testedCount: 1,
  writtenCount: 0,
  gateDetail: 'PREDICATO MARKET_EU: n=40, q=0.2000, avgR=0.50, profitFactor=1.50',
});
const c1 = resolveSpecializationOutcome({
  ...base,
  hasOpenRouterKey: true,
  decisiveSample: 40,
  testedCount: 1,
  writtenCount: 0,
});
check(
  'gateDetail coerente quando decisiveSample >= 30',
  r6b.reasonDetail === 'PREDICATO MARKET_EU: n=40, q=0.2000, avgR=0.50, profitFactor=1.50' &&
    !r6b.reasonDetail.includes('0/30') &&
    !c1.reasonDetail.includes('40/30'),
  `${r6b.reasonDetail} | ${c1.reasonDetail}`
);

// 6c) CAMPIONE_INSUFFICIENTE con 0 predicati testati
const r6c = resolveSpecializationOutcome({
  ...base,
  hasOpenRouterKey: true,
  decisiveSample: 8,
  testedCount: 0,
});
check(
  'CAMPIONE_INSUFFICIENTE con 0 predicati testati',
  r6c.reason === 'CAMPIONE_INSUFFICIENTE' && r6c.reasonDetail.includes('8/30'),
  `${r6c.reason} ${r6c.reasonDetail}`
);

// 8) TOPIC_NON_FILTRATO non viene più emesso
const topicMatrix: SpecializationOutcomeInput[] = [
  { ...base },
  { ...base, hasOpenRouterKey: true, llmErrorDetail: 'gemini:402/429' },
  { ...base, hasOpenRouterKey: true, validDirectivesCount: 0, discardedCount: 0 },
  { ...base, hasOpenRouterKey: true, validDirectivesCount: 0, discardedCount: 3 },
  { ...base, hasOpenRouterKey: true, decisiveSample: 0 },
  { ...base, hasOpenRouterKey: true, decisiveSample: 40, writtenCount: 0 },
  { ...base, hasOpenRouterKey: true, decisiveSample: 40, writtenCount: 1 },
];
check(
  'TOPIC_NON_FILTRATO non emesso in nessun ramo',
  topicMatrix.every((input) => (resolveSpecializationOutcome(input).reason as string) !== 'TOPIC_NON_FILTRATO') &&
    !Object.prototype.hasOwnProperty.call(SPECIALIZATION_REASONS, 'TOPIC_NON_FILTRATO')
);

// ---- applyPredicate: un caso per ogni predicato dell'enum ----
function makeTrade(over: Partial<TradeJournalEntry> = {}): TradeJournalEntry {
  return {
    id: 't-1',
    timestamp: '2026-10-26T08:40:00.000Z',
    date: '2026-10-26',
    session: 'EU',
    market: 'EU',
    ticker: 'TEST.MI',
    direction: 'LONG',
    strategy: 'Opening Range Breakout (5m / 15m)',
    entryPrice: 100,
    exitPrice: 101,
    stopLoss: 99,
    target1: 101,
    pnlEur: 100,
    rMultiple: 2,
    outcome: 'WIN',
    status: 'CLOSED',
    notes: '',
    isPaper: false,
    selectedLeverage: 10,
    entryMode: 'SNAPSHOT_0915',
    ...over,
  };
}

const predicateFixtures: Array<[string, Partial<TradeJournalEntry>, Partial<TradeJournalEntry>]> = [
  ['MARKET_EU', { market: 'EU' }, { market: 'US' }],
  ['MARKET_US', { market: 'US' }, { market: 'EU' }],
  ['SESSION_EU', { session: 'EU' }, { session: 'US' }],
  ['SESSION_US', { session: 'US' }, { session: 'EU' }],
  ['DIRECTION_LONG', { direction: 'LONG' }, { direction: 'SHORT' }],
  ['DIRECTION_SHORT', { direction: 'SHORT' }, { direction: 'LONG' }],
  ['LEVERAGE_5', { selectedLeverage: 5 }, { selectedLeverage: 10 }],
  ['LEVERAGE_10', { selectedLeverage: 10 }, { selectedLeverage: 5 }],
  ['LEVERAGE_15', { selectedLeverage: 15 }, { selectedLeverage: 10 }],
  ['LEVERAGE_20', { selectedLeverage: 20 }, { selectedLeverage: 10 }],
  ['LEVERAGE_25', { selectedLeverage: 25 }, { selectedLeverage: 10 }],
  ['ENTRY_SNAPSHOT_0915', { entryMode: 'SNAPSHOT_0915' }, { entryMode: 'MANUAL_FREEZE' }],
  ['ENTRY_UNFROZEN_LATE', { entryMode: 'UNFROZEN_LATE' }, { entryMode: 'SNAPSHOT_0915' }],
  ['ENTRY_MANUAL_FREEZE', { entryMode: 'MANUAL_FREEZE' }, { entryMode: 'UNFROZEN_LATE' }],
];

check(
  'applyPredicate copre tutti gli id di LEARNING_PREDICATE_IDS',
  predicateFixtures.length === LEARNING_PREDICATE_IDS.length &&
    LEARNING_PREDICATE_IDS.every((id) => predicateFixtures.some(([fixtureId]) => fixtureId === id)),
  `${predicateFixtures.length}/${LEARNING_PREDICATE_IDS.length}`
);

for (const [predicateId, matching, nonMatching] of predicateFixtures) {
  const winning = makeTrade({ outcome: 'WIN', ...matching });
  const losing = makeTrade({ outcome: 'LOSS', rMultiple: -1, ...matching });
  const negative = makeTrade({ ...nonMatching });
  check(
    `applyPredicate ${predicateId} (vincita, perdita, non corrispondente)`,
    applyPredicate(winning, predicateId) &&
      applyPredicate(losing, predicateId) &&
      !applyPredicate(negative, predicateId)
  );
}

// Campo mancante => false, mai eccezione
const missingFields = makeTrade();
delete (missingFields as any).market;
delete (missingFields as any).selectedLeverage;
delete (missingFields as any).entryMode;
check(
  'applyPredicate campi mancanti => false',
  applyPredicate(missingFields, 'MARKET_EU') === false &&
    applyPredicate(missingFields, 'LEVERAGE_10') === false &&
    applyPredicate(missingFields, 'ENTRY_SNAPSHOT_0915') === false
);
check(
  'applyPredicate predicato fuori enum => false',
  applyPredicate(makeTrade(), 'PREDICATO_LIBERO') === false && isLearningPredicateId('PREDICATO_LIBERO') === false
);

// ---- validateLearningPattern con filtro per predicato ----
const filteredTrades: any[] = Array.from({ length: 40 }, (_, i) => ({
  ...makeTrade({
    id: `p${i}`,
    outcome: i % 2 === 0 ? 'WIN' : 'LOSS',
    rMultiple: i % 2 === 0 ? 1 : -1,
    market: 'EU',
  }),
}));
const validatedEu = validateLearningPattern(filteredTrades, [], 'PREDICATO_EU', 'EU', {}, 'MARKET_EU');
const validatedUs = validateLearningPattern(filteredTrades, [], 'PREDICATO_US', 'US', {}, 'MARKET_US');
check(
  'validateLearningPattern filtra per predicato (EU ok, US vuoto)',
  validatedEu !== null && validatedEu.stats.n === 40 && validatedUs === null,
  `${validatedEu ? validatedEu.stats.n : 'null'} / ${validatedUs ? 'non-null' : 'null'}`
);
check(
  'validateLearningPattern predicateId fuori enum => null',
  validateLearningPattern(filteredTrades, [], 'X', 'EU', {}, 'PREDICATO_LIBERO' as any) === null
);

// ---- GATE_NON_SUPERATI / OK_SCRITTO sulle funzioni reali di persistenza ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specreason-'));
const gateFile = path.join(dir, 'memory.json');
fs.writeFileSync(gateFile, '[]', 'utf8');
const gateResult: LearningResult = {
  topic: 'GATE_TEST',
  market: 'EU',
  directive: 'x',
  confidence: 0.5,
  evidence: [],
  expectancy: null,
  deflatedSharpe: { value: null, trials: 1, note: 'test' } as any,
  counterfactualShared: false,
  stats: {
    n: 40,
    wins: 20,
    losses: 20,
    breakevens: 0,
    winRate: 0.5,
    avgR: 0.2,
    profitFactor: 2,
    pValue: 0.5,
    adjustedPValue: 0.5,
    counterfactual: { n: 0, wins: 0, losses: 0, expired: 0 },
  },
};
updateAIMemory([gateResult], gateFile);
check('GATE_NON_SUPERATI non scrive (q=0.5)', JSON.parse(fs.readFileSync(gateFile, 'utf8')).length === 0);

const okResult: LearningResult = {
  ...gateResult,
  topic: 'OK_TEST',
  stats: { ...gateResult.stats, adjustedPValue: 0.01, pValue: 0.01 },
};
updateAIMemory([okResult], gateFile);
const written = JSON.parse(fs.readFileSync(gateFile, 'utf8'));
check('OK_SCRITTO scrive 1 regola con confidence', written.length === 1 && typeof written[0].confidence === 'number');

fs.rmSync(dir, { recursive: true, force: true });

console.log(`=== Specialization reasons: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
if (failures > 0) process.exitCode = 1;
