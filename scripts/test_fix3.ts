import { evaluateSessionOptimization } from '../src/utils/calculator';
import { TradeJournalEntry } from '../src/types/radar';

console.log('Testing Fix 3: evaluateSessionOptimization sample size & OPEN trade exclusion...');

function makeTrade(id: string, market: 'EU' | 'US', outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'EXPIRED', status: 'OPEN' | 'CLOSED'): TradeJournalEntry {
  return {
    id,
    timestamp: new Date().toISOString(),
    date: '2026-11-01',
    session: market,
    market,
    ticker: 'TEST.' + id,
    direction: 'LONG',
    strategy: 'ORB',
    entryPrice: 100,
    exitPrice: outcome === 'WIN' ? 105 : outcome === 'LOSS' ? 95 : 100,
    stopLoss: 95,
    target1: 105,
    pnlEur: outcome === 'WIN' ? 150 : outcome === 'LOSS' ? -100 : 0,
    rMultiple: outcome === 'WIN' ? 1.5 : outcome === 'LOSS' ? -1.0 : 0,
    outcome,
    status,
    notes: 'test',
    isPaper: true,
  };
}

// 1. 35 closed EU trades
const trades35: TradeJournalEntry[] = [];
for (let i = 0; i < 35; i++) {
  trades35.push(makeTrade(`eu-${i}`, 'EU', i < 20 ? 'WIN' : 'LOSS', 'CLOSED'));
}

const prop35 = evaluateSessionOptimization(trades35, 'EU');
if (prop35.evaluatedTradesCount !== 35) {
  throw new Error(`FAIL: Expected evaluatedTradesCount === 35, got ${prop35.evaluatedTradesCount}`);
}
if (prop35.metrics.totalSetups !== 35) {
  throw new Error(`FAIL: Expected metrics.totalSetups === 35, got ${prop35.metrics.totalSetups}`);
}
if (prop35.metrics.wins !== 20 || prop35.metrics.losses !== 15) {
  throw new Error(`FAIL: Expected 20 wins and 15 losses, got wins=${prop35.metrics.wins}, losses=${prop35.metrics.losses}`);
}
console.log('PASS: 35 closed trades evaluated with total = 35 (wins=20, losses=15)');

// 2. Mixed set with OPEN trades
const mixedTrades: TradeJournalEntry[] = [
  ...trades35,
  makeTrade('open-1', 'EU', 'WIN', 'OPEN'),
  makeTrade('open-2', 'EU', 'LOSS', 'OPEN'),
  makeTrade('open-3', 'EU', 'BREAKEVEN', 'OPEN'),
];

const propMixed = evaluateSessionOptimization(mixedTrades, 'EU');
if (propMixed.evaluatedTradesCount !== 35) {
  throw new Error(`FAIL: Expected evaluatedTradesCount === 35 with OPEN trades excluded, got ${propMixed.evaluatedTradesCount}`);
}
if (propMixed.metrics.totalSetups !== 35) {
  throw new Error(`FAIL: Expected metrics.totalSetups === 35, got ${propMixed.metrics.totalSetups}`);
}
if (propMixed.metrics.wins !== 20 || propMixed.metrics.losses !== 15) {
  throw new Error(`FAIL: OPEN trades were not excluded from metrics counts! wins=${propMixed.metrics.wins}, losses=${propMixed.metrics.losses}`);
}
console.log('PASS: OPEN trades strictly excluded from total, wins, losses, breakevens.');

console.log('ALL FIX 3 TESTS PASSED VERIFIED!');
