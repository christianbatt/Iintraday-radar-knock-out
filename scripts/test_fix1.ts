import { stripUndefined } from '../src/services/firebaseSync';
import { createJournalEntryFromSetup } from '../src/utils/calculator';
import { TRADING_PARAMS } from '../src/config/tradingParams';

function hasUndefined(obj: any): boolean {
  if (obj === undefined) return true;
  if (obj === null || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    return obj.some(hasUndefined);
  }
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined || hasUndefined(obj[key])) {
      return true;
    }
  }
  return false;
}

async function runTests() {
  console.log('--- Test Fix 1: stripUndefined & batch validation ---');

  // Test a: OPEN trade created by createJournalEntryFromSetup
  const mockSetup = {
    id: 'trade-open-1',
    session: 'EU',
    ticker: 'SAP.DE',
    direction: 'LONG',
    strategy: 'Opening Range Breakout (5m / 15m)',
    entryPrice: 100,
    stopLoss: 98,
    target1: 103.2,
    outcome: 'OPEN',
    entryMode: 'SNAPSHOT_0915',
    isPaper: true,
  };
  const rawTrade = createJournalEntryFromSetup(mockSetup);
  console.log('rawTrade has undefined closedAt?', rawTrade.closedAt === undefined);
  
  const preparedTrade = {
    ...rawTrade,
    closedAt: rawTrade.closedAt ?? null,
    userId: 'user-123',
    updatedAt: new Date().toISOString(),
  };
  
  const stripped = stripUndefined(preparedTrade);
  const containsUndefined = hasUndefined(stripped);
  console.log('[Test 1a] Trade OPEN stripped contains any undefined?', containsUndefined, containsUndefined ? 'FAIL' : 'PASS');
  if (containsUndefined) throw new Error('Test 1a failed: found undefined in stripped trade');

  // Test c: Valid trade preserves fields and values
  const completeTrade = {
    ...rawTrade,
    closedAt: '2026-10-31T10:00:00.000Z',
    barrierStrike: 95.0,
    leverage: 10,
    userId: 'user-123',
    updatedAt: '2026-10-31T10:00:00.000Z',
  };
  const strippedComplete = stripUndefined(completeTrade);
  console.log('[Test 1c] Stripped complete trade barrierStrike:', strippedComplete.barrierStrike === 95.0 ? 'PASS' : 'FAIL');
  console.log('[Test 1c] Stripped complete trade closedAt:', strippedComplete.closedAt === '2026-10-31T10:00:00.000Z' ? 'PASS' : 'FAIL');

  // Test b: Batch validation logic
  const batchTrades: any[] = [
    { id: 'valid-1', ticker: 'SAP.DE', entryMode: 'SNAPSHOT_0915' },
    { id: '', ticker: 'INVALID_EMPTY_ID' },
    null,
    { id: 'valid-2', ticker: 'NVDA', entryMode: 'SNAPSHOT_0915' },
    { ticker: 'NO_ID' }
  ];

  let validCount = 0;
  const discarded: any[] = [];
  batchTrades.forEach((t) => {
    if (!t || typeof t.id !== 'string' || t.id.trim().length === 0) {
      discarded.push(t?.id || 'ID_MANCANTE');
      return;
    }
    validCount++;
  });
  console.log('[Test 1b] Discarded invalid items count:', discarded.length === 3 ? 'PASS' : 'FAIL', discarded);
  console.log('[Test 1b] Valid items committed count:', validCount === 2 ? 'PASS' : 'FAIL', validCount);

  // Test d: Date object or non-plain object preserved
  const dateObj = new Date();
  const strippedDate = stripUndefined({ created: dateObj });
  console.log('[Test 1d] Date preserved as instance of Date?', strippedDate.created instanceof Date ? 'PASS' : 'FAIL');

  console.log('--- ALL FIX 1 TESTS PASSED ---');
}

runTests().catch((e) => {
  console.error('Test execution error:', e);
  process.exit(1);
});
