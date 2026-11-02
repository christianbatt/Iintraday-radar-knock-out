import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExcludedSetupRecord, TradeJournalEntry } from '../../types/radar';
import { binomialPValue, validateLearningPattern } from '../learningValidator';
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

console.log('=== Tutti i test Learning Validator completati ===');
