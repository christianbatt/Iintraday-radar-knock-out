import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExcludedSetupRecord, TradeJournalEntry } from '../../types/radar';
import { binomialPValue, validateLearningPattern, scanLearningPredicates, LEARNING_PREDICATE_IDS } from '../learningValidator';
import { updateAIMemory } from '../memoryUpdater';
import { benjaminiHochberg } from '../../../scripts/nightly_learning';

function createTrade(index: number, outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' = 'WIN'): TradeJournalEntry {
  const rMultiple = outcome === 'WIN' ? 1.6 : outcome === 'LOSS' ? -1 : 0;
  return {
    id: `trade-${index}`,
    timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    date: '01/01/2026',
    session: 'EU',
    market: 'EU',
    ticker: `TEST${index}.MI`,
    direction: 'LONG',
    strategy: 'ORB_BREAKOUT',
    entryPrice: 100,
    exitPrice: outcome === 'WIN' ? 101.6 : outcome === 'LOSS' ? 99 : 100,
    stopLoss: 99,
    target1: 101.6,
    pnlEur: rMultiple * 50,
    rMultiple,
    outcome,
    status: 'CLOSED',
    notes: '',
    isPaper: false,
  };
}

function createExcluded(index: number, outcome: 'THEORETICAL_PROFIT' | 'THEORETICAL_STOP'): ExcludedSetupRecord {
  return {
    id: `excluded-${index}`,
    ticker: `EX${index}.MI`,
    name: `Excluded ${index}`,
    market: 'EU',
    currency: 'EUR',
    sessionDate: '01/01/2026',
    timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    score: 60,
    gapPercent: 0.5,
    rvol: 1,
    rsi: 50,
    atr: 1,
    primaryReasonCategory: 'RVOL_INSUFFICIENT',
    primaryReasonLabel: 'RVOL insufficiente',
    detail: 'Fixture controfattuale',
    direction: 'LONG',
    initialPrice: 100,
    entryTrigger: 100,
    stopLoss: 99,
    target1: 101,
    riskDist: 1,
    outcomeStatus: outcome,
    theoreticalRMultiple: outcome === 'THEORETICAL_PROFIT' ? 1 : -1,
  };
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

console.log('=== Learning Validator Tests ===');

const pValueTwentyOfThirty = binomialPValue(20, 30, 0.5);
assert(pValueTwentyOfThirty > 0.05, '20/30 non deve superare la soglia bilaterale 0.05');
console.log('Test 1 - binomiale 20/30 non significativa: PASS');

const pValueFifteenOfThirty = binomialPValue(15, 30, 0.5);
assert(Math.abs(pValueFifteenOfThirty - 1) < 1e-10, '15/30 deve avere p-value 1');
console.log('Test 2 - binomiale 15/30 p-value 1: PASS');

const adjustedQValues = benjaminiHochberg([0.01, 0.04, 0.2]);
assert(
  Math.abs(adjustedQValues[0] - 0.03) < 1e-10 &&
  Math.abs(adjustedQValues[1] - 0.06) < 1e-10 &&
  Math.abs(adjustedQValues[2] - 0.2) < 1e-10,
  `BH q-values inattesi: ${adjustedQValues.join(', ')}`
);
console.log('Test 2b - correzione Benjamini-Hochberg monotona: PASS');

const insufficient = validateLearningPattern(
  Array.from({ length: 20 }, (_, index) => createTrade(index)),
  Array.from({ length: 20 }, (_, index) => createExcluded(index, 'THEORETICAL_PROFIT')),
  'ORB_BREAKOUT_LONG_MORNING_EU',
  'EU'
);
assert(insufficient === null, 'I controfattuali esclusi non devono completare il minimo di 30 trade reali');
console.log('Test 3 - esclusi non gonfiano il campione reale: PASS');

const paperOnly = validateLearningPattern(
  Array.from({ length: 40 }, (_, index) => ({ ...createTrade(index, index < 28 ? 'WIN' : 'LOSS'), isPaper: true })),
  [],
  'PAPER_ONLY',
  'EU'
);
assert(paperOnly !== null, 'I trade in paper trading devono essere inclusi nella validazione dell\'apprendimento');
assert(paperOnly.stats.n === 40, 'Il campione deve includere tutti i 40 trade in paper trading');
console.log('Test 3b - paper trade inclusi correttamente nell\'analisi: PASS');

const actualTrades = Array.from({ length: 30 }, (_, index) =>
  createTrade(index, index < 22 ? 'WIN' : 'LOSS')
);
const excluded = Array.from({ length: 15 }, (_, index) =>
  createExcluded(index, index < 10 ? 'THEORETICAL_PROFIT' : 'THEORETICAL_STOP')
);
const result = validateLearningPattern(actualTrades, excluded, 'ORB_BREAKOUT_LONG_MORNING_EU', 'EU');
assert(result !== null, 'Il pattern con 30 trade reali e expectancy positiva deve essere analizzato');
assert(result.stats.n === 30, 'Il campione n deve contare solo trade reali');
assert(result.evidence.length === 30 && result.evidence.every((id) => id.startsWith('trade-')), 'Evidence deve contenere ID Journal reali');
assert(result.stats.counterfactual.n === 15, 'I controfattuali devono restare riportati separatamente');
assert(result.stats.pValue < 0.05 && result.stats.avgR > 0 && result.stats.profitFactor > 1, 'Metriche pattern attese positive');
console.log('Test 4 - pattern significativo basato solo su Journal: PASS');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-memory-'));
try {
  const memoryPath = path.join(temporaryDirectory, 'memory.json');
  fs.writeFileSync(memoryPath, JSON.stringify([
    { id: 'hypothesis', topic: 'HYPOTHESIS', confidence: null },
  ]));
  updateAIMemory([result], memoryPath);
  const memory = JSON.parse(fs.readFileSync(memoryPath, 'utf8')) as Array<{ topic: string; confidence: number | null }>;
  assert(memory.length === 2, 'Updater deve preservare ipotesi e aggiungere il pattern validato');
  assert(memory.find((item) => item.topic === 'HYPOTHESIS')?.confidence === null, 'Updater deve preservare confidence null');
  assert(typeof memory.find((item) => item.topic === result.topic)?.confidence === 'number', 'Pattern validato deve avere confidence numerica');
  const nonSignificantAfterFdr = {
    ...result,
    stats: { ...result.stats, adjustedPValue: 0.08 },
  };
  updateAIMemory([nonSignificantAfterFdr], memoryPath);
  const unchangedMemory = JSON.parse(fs.readFileSync(memoryPath, 'utf8')) as Array<{ topic: string }>;
  assert(unchangedMemory.length === 2, 'Updater non deve persistere un pattern con q-value >= 0.05');
  console.log('Test 5 - upsert memoria e rifiuto pattern non significativo FDR: PASS');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

// ---- ADDITIVO (P8): provenienza della direttiva in memoria ----
const provenanceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-provenance-'));
try {
  const memoryPath = path.join(provenanceDirectory, 'memory.json');
  updateAIMemory(
    [
      {
        ...result,
        provenance: {
          promptVersion: ' ai-specialize@1 ',
          model: 'openrouter:m1',
          evidenceRefs: [
            'calibration.edgeRNet',
            'calibration.edgeRNet',
            '  ',
            'veto.EU.SUPERTREND_OPPOSED.meanRMarket',
          ],
        },
      },
    ],
    memoryPath
  );
  type Stored = {
    topic: string;
    provenance?: { promptVersion: string | null; model: string | null; evidenceRefs: string[] };
  };
  const withProvenance = JSON.parse(fs.readFileSync(memoryPath, 'utf8')) as Stored[];
  const stored = withProvenance.find((item) => item.topic === result.topic)!;
  assert(stored.provenance !== undefined && stored.provenance !== null, 'La regola scritta deve portare la provenienza');
  assert(stored.provenance!.promptVersion === 'ai-specialize@1', 'Versione del prompt trimmata');
  assert(stored.provenance!.model === 'openrouter:m1', 'Modello conservato');
  assert(
    JSON.stringify(stored.provenance!.evidenceRefs) ===
      JSON.stringify([
        'calibration.edgeRNet',
        'veto.EU.SUPERTREND_OPPOSED.meanRMarket',
      ]),
    'Chiavi citate deduplicate e senza stringhe vuote'
  );
  console.log('Test 5b - provenienza di prompt, modello e chiavi citate: PASS');

  // Provenienza assente: la regola resta nello schema storico, senza campi finti.
  updateAIMemory([{ ...result, provenance: null }], memoryPath);
  const withoutProvenance = JSON.parse(fs.readFileSync(memoryPath, 'utf8')) as Stored[];
  assert(
    withoutProvenance.find((item) => item.topic === result.topic)?.provenance === undefined,
    'Senza provenienza non si scrive un oggetto vuoto'
  );

  // Versione vuota e modello vuoto diventano null, non stringhe vuote.
  updateAIMemory(
    [{ ...result, provenance: { promptVersion: '   ', model: '', evidenceRefs: [] } }],
    memoryPath
  );
  const emptyProvenance = JSON.parse(fs.readFileSync(memoryPath, 'utf8')) as Stored[];
  const empty = emptyProvenance.find((item) => item.topic === result.topic)!.provenance!;
  assert(empty.promptVersion === null && empty.model === null, 'Stringhe vuote = non attribuibile');
  assert(empty.evidenceRefs.length === 0, 'Nessuna chiave inventata');
  console.log('Test 5c - provenienza assente o non attribuibile: PASS');
} finally {
  fs.rmSync(provenanceDirectory, { recursive: true, force: true });
}

// ---- ADDITIVO (v10, Parte 4.1): scansione deterministica dei predicati ----
const weakTrades: TradeJournalEntry[] = Array.from({ length: 15 }, (_, index) => ({
  ...createTrade(index, index % 2 === 0 ? 'WIN' : 'LOSS'),
  market: 'EU',
  session: 'EU',
  direction: 'LONG',
  entryMode: 'SNAPSHOT_0915',
  selectedLeverage: 10,
}));
const weakScan = scanLearningPredicates(weakTrades, []);
assert(weakScan.length === 14, `La famiglia deve essere fissa a 14, trovati ${weakScan.length}`);
assert(
  weakScan.every((entry) => entry.tested === false && entry.pValue === 1),
  'Con campione sotto MIN tutti i predicati devono essere non testati con p=1'
);
assert(weakScan.every((entry) => entry.passesGates === false), 'Nessun predicato deve passare con campione insufficiente');
assert(
  weakScan.some((entry) => entry.predicateId === 'MARKET_EU' && entry.n === 15),
  'Il conteggio decisivo del predicato MARKET_EU deve essere 15'
);
console.log('Test 6 - scan: tutti i predicati sotto MIN => non testati, p=1, nessun vincente: PASS');

const strongTrades: TradeJournalEntry[] = Array.from({ length: 40 }, (_, index) => ({
  ...createTrade(1000 + index, index < 34 ? 'WIN' : 'LOSS'),
  market: 'EU',
  session: 'GLOBAL',
  direction: index % 2 === 0 ? 'LONG' : 'SHORT',
  entryMode: null,
  selectedLeverage: null,
}));
const strongScan = scanLearningPredicates(strongTrades, []);
const marketEu = strongScan.find((entry) => entry.predicateId === 'MARKET_EU');
assert(strongScan.length === 14, `La famiglia deve essere fissa a 14, trovati ${strongScan.length}`);
assert(marketEu !== undefined && marketEu.tested === true, 'MARKET_EU deve essere testato con 40 trade decisivi');
assert(marketEu !== undefined && marketEu.n === 40, 'MARKET_EU deve avere n=40');
assert(marketEu !== undefined && marketEu.passesGates === true, 'MARKET_EU forte deve superare i gate');
assert(
  strongScan.filter((entry) => entry.passesGates).every((entry) => entry.tested),
  'Nessun predicato non testato deve comparire tra i vincenti'
);
assert(
  strongScan.filter((entry) => entry.passesGates).length === 1 &&
    strongScan.filter((entry) => entry.passesGates)[0].predicateId === 'MARKET_EU',
  'Solo MARKET_EU deve essere vincente in questa fixture'
);
console.log('Test 7 - scan: MARKET_EU forte testato e vincente, famiglia 14, non testati mai vincenti: PASS');

const expectedQValues = benjaminiHochberg(strongScan.map((entry) => entry.pValue));
assert(expectedQValues.length === 14, 'BH deve essere applicata alla famiglia fissa di 14 p-value');
assert(
  strongScan.every((entry, index) => Math.abs(entry.qValue - expectedQValues[index]) < 1e-12),
  'qValue deve derivare da benjaminiHochberg sulla famiglia di 14, non da un valore hardcoded'
);
assert(
  marketEu !== undefined && Math.abs(marketEu.qValue - expectedQValues[LEARNING_PREDICATE_IDS.indexOf('MARKET_EU')]) < 1e-12,
  'Il q-value di MARKET_EU deve coincidere con la posizione nella famiglia BH'
);
console.log('Test 8 - scan: qValue calcolato da benjaminiHochberg sulla famiglia di 14: PASS');

console.log('=== Tutti i test Learning Validator completati ===');
