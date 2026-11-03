import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateOpenPositionLifecycle } from '../calculator';
import { TradeJournalEntry, RawQuoteData, SessionInfo } from '../../types/radar';

function createMockTrade(overrides: Partial<TradeJournalEntry> = {}): TradeJournalEntry {
  return {
    id: 'trade-test-1',
    timestamp: '2026-11-03T09:30:00.000Z',
    date: '03/11/2026',
    session: 'EU',
    market: 'EU',
    ticker: 'SAP.DE',
    direction: 'LONG',
    strategy: 'Opening Range Breakout',
    entryPrice: 100,
    exitPrice: 103,
    stopLoss: 98,
    target1: 103,
    pnlEur: 0,
    rMultiple: 0,
    outcome: 'BREAKEVEN',
    status: 'OPEN',
    notes: 'Test trade',
    isPaper: true,
    potentialLossEur: 100,
    maxRiskEur: 100,
    frictionEur: 2,
    ...overrides,
  };
}

function createMockQuote(overrides: Partial<RawQuoteData> = {}): RawQuoteData {
  return {
    ticker: 'SAP.DE',
    name: 'SAP SE',
    market: 'EU',
    currency: 'EUR',
    currentPrice: 100,
    preMarketPrice: null,
    prevClose: 99.5,
    prevHigh: 101,
    prevLow: 99,
    preMarketHigh: null,
    preMarketLow: null,
    avgVolume20d: 1000000,
    preMarketVolume: 50000,
    atr14: 2.0,
    gapPercent: 0.5,
    rvol: 1.2,
    timestamp: '2026-11-03T09:35:00.000Z',
    source: 'Test Feed',
    ...overrides,
  };
}

console.log('--- RUNNING POSITION LIFECYCLE TESTS ---');

// Test 1: Stop Colpito (exact stop touch)
{
  const trade = createMockTrade({ direction: 'LONG', entryPrice: 100, stopLoss: 98, target1: 103 });
  const quote = createMockQuote({ currentPrice: 98.0 });
  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T10:00:00.000Z'));

  assert.strictEqual(res.wasClosed, true, 'Position must be closed on stop hit');
  assert.strictEqual(res.updatedTrade.status, 'CLOSED');
  assert.strictEqual(res.updatedTrade.outcome, 'LOSS');
  assert.strictEqual(res.updatedTrade.closeReason, 'STOP_HIT');
  assert.strictEqual(res.updatedTrade.rMultiple, -1.0);
  assert.strictEqual(res.updatedTrade.exitPrice, 98.0);
  assert.strictEqual(res.updatedTrade.slippagePrice, undefined);
  assert.ok(res.updatedTrade.closedAt != null);
  assert.ok(res.updatedTrade.stateHistory && res.updatedTrade.stateHistory.length > 0);
  console.log('[T1_stop_hit_exact] PASS');
}

// Test 2: Target Colpito (WIN)
{
  const trade = createMockTrade({ direction: 'LONG', entryPrice: 100, stopLoss: 98, target1: 103 });
  const quote = createMockQuote({ currentPrice: 103.5 });
  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T10:15:00.000Z'));

  assert.strictEqual(res.wasClosed, true, 'Position must be closed on target hit');
  assert.strictEqual(res.updatedTrade.status, 'CLOSED');
  assert.strictEqual(res.updatedTrade.outcome, 'WIN');
  assert.strictEqual(res.updatedTrade.closeReason, 'TARGET_HIT');
  assert.strictEqual(res.updatedTrade.rMultiple, 1.5);
  assert.strictEqual(res.updatedTrade.exitPrice, 103.5);
  assert.ok(res.updatedTrade.mfe != null && res.updatedTrade.mfe >= 1.5);
  console.log('[T2_target_hit] PASS');
}

// Test 3: Gap oltre -1R per SHORT (Slippage estremo, simile a RHM.DE)
{
  const trade = createMockTrade({
    ticker: 'RHM.DE',
    direction: 'SHORT',
    entryPrice: 991.20,
    stopLoss: 993.18, // riskDist = 1.98
    target1: 988.52,
    potentialLossEur: 100,
  });
  // Price jumps to 1004.80 (adverse gap for SHORT)
  const quote = createMockQuote({ ticker: 'RHM.DE', currentPrice: 1004.80 });
  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T09:25:00.000Z'));

  assert.strictEqual(res.wasClosed, true, 'Position must be closed when price jumps beyond stop');
  assert.strictEqual(res.updatedTrade.status, 'CLOSED');
  assert.strictEqual(res.updatedTrade.outcome, 'LOSS');
  assert.strictEqual(res.updatedTrade.closeReason, 'STOP_GAP_SLIPPAGE');
  assert.strictEqual(res.updatedTrade.exitPrice, 1004.80);
  assert.ok(res.updatedTrade.rMultiple < -1.0, `rMultiple should be worse than -1R (was ${res.updatedTrade.rMultiple})`);
  assert.ok(res.updatedTrade.slippagePrice != null && res.updatedTrade.slippagePrice > 10.0, 'Slippage price recorded');
  assert.ok(res.updatedTrade.slippageEur != null && res.updatedTrade.slippageEur > 0, 'Slippage EUR recorded');
  console.log('[T3_gap_beyond_stop_slippage_short] PASS');
}

// Test 4: Gap oltre -1R per LONG (Slippage estremo, simile a MSFT)
{
  const trade = createMockTrade({
    ticker: 'MSFT',
    session: 'US',
    market: 'US',
    direction: 'LONG',
    entryPrice: 520.97,
    stopLoss: 519.93, // riskDist = 1.04
    target1: 522.38,
    potentialLossEur: 100,
  });
  // Price drops sharply to 517.76
  const quote = createMockQuote({ ticker: 'MSFT', market: 'US', currency: 'USD', currentPrice: 517.76 });
  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T19:20:00.000Z'));

  assert.strictEqual(res.wasClosed, true, 'Position must be closed on adverse gap drop');
  assert.strictEqual(res.updatedTrade.status, 'CLOSED');
  assert.strictEqual(res.updatedTrade.outcome, 'LOSS');
  assert.strictEqual(res.updatedTrade.closeReason, 'STOP_GAP_SLIPPAGE');
  assert.strictEqual(res.updatedTrade.exitPrice, 517.76);
  assert.strictEqual(res.updatedTrade.rMultiple, -3.09);
  assert.ok(res.updatedTrade.slippagePrice != null && res.updatedTrade.slippagePrice > 2.0);
  console.log('[T4_gap_beyond_stop_slippage_long] PASS');
}

// Test 5: Chiusura EOD per sessione EU (dopo 17:30 CET)
{
  const trade = createMockTrade({
    session: 'EU',
    market: 'EU',
    direction: 'LONG',
    entryPrice: 100,
    stopLoss: 98,
    target1: 103,
  });
  const quote = createMockQuote({ currentPrice: 100.50 });
  const mockSessionInfo: SessionInfo = {
    cet: {
      formatted: '17:45',
      date: '03/11/2026',
      hour: 17,
      minute: 45,
      currentMinutes: 1065, // 17:45 CET, past 17:30 (1050)
      isEuropeWindow: false,
      isUSAWindow: true,
      isEuropeLive: false,
      marketStatusEU: 'CLOSED',
    },
    recommendedSession: 'US',
  };

  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T16:45:00.000Z'), {
    sessionInfo: mockSessionInfo,
  });

  assert.strictEqual(res.wasClosed, true, 'Open EU trade must close at EOD');
  assert.strictEqual(res.updatedTrade.status, 'CLOSED');
  assert.strictEqual(res.updatedTrade.closeReason, 'EOD_CUTOFF');
  assert.strictEqual(res.updatedTrade.exitPrice, 100.50);
  assert.strictEqual(res.updatedTrade.rMultiple, 0.25);
  console.log('[T5_eod_closure_eu] PASS');
}

// Test 6: Chiusura EOD per sessione US (dopo 22:00 CET)
{
  const trade = createMockTrade({
    ticker: 'NVDA',
    session: 'US',
    market: 'US',
    direction: 'LONG',
    entryPrice: 140,
    stopLoss: 138,
    target1: 143,
  });
  const quote = createMockQuote({ ticker: 'NVDA', market: 'US', currency: 'USD', currentPrice: 140.80 });
  const mockSessionInfo: SessionInfo = {
    cet: {
      formatted: '22:15',
      date: '03/11/2026',
      hour: 22,
      minute: 15,
      currentMinutes: 1335, // 22:15 CET, past 22:00 (1320)
      isEuropeWindow: false,
      isUSAWindow: false,
      isUSALive: false,
      marketStatusUS: 'CLOSED',
    },
    recommendedSession: 'GLOBAL',
  };

  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T21:15:00.000Z'), {
    sessionInfo: mockSessionInfo,
  });

  assert.strictEqual(res.wasClosed, true, 'Open US trade must close at EOD');
  assert.strictEqual(res.updatedTrade.status, 'CLOSED');
  assert.strictEqual(res.updatedTrade.closeReason, 'EOD_CUTOFF');
  assert.strictEqual(res.updatedTrade.exitPrice, 140.80);
  console.log('[T6_eod_closure_us] PASS');
}

// Test 7: Limite giornaliero raggiunto (2/2 trade) con posizione aperta
{
  // Position monitoring must execute independently of the circuit breaker or daily trades count
  const trade = createMockTrade({ direction: 'LONG', entryPrice: 100, stopLoss: 98, target1: 103 });
  const quote = createMockQuote({ currentPrice: 97.5 });

  // Evaluate directly without blocking by daily count
  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T11:00:00.000Z'), {
    accountCapital: 10000,
  });

  assert.strictEqual(res.wasClosed, true, 'Monitor must resolve trade even if daily limit of new trades was reached');
  assert.strictEqual(res.updatedTrade.status, 'CLOSED');
  assert.strictEqual(res.updatedTrade.outcome, 'LOSS');
  console.log('[T7_daily_trade_limit_reached_with_open_position] PASS');
}

// Test 8: Tracciamento continuo MFE (Massimo Favorevole) e MAE (Massimo Avverso)
{
  let trade = createMockTrade({ direction: 'LONG', entryPrice: 100, stopLoss: 98, target1: 104 }); // riskDist = 2
  // Tick 1: price goes to 101 (+0.5R)
  let quote = createMockQuote({ currentPrice: 101 });
  let res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T09:35:00.000Z'));
  assert.strictEqual(res.wasClosed, false);
  assert.strictEqual(res.updatedTrade.mfe, 0.5);
  assert.strictEqual(res.updatedTrade.mae, 0);
  trade = res.updatedTrade;

  // Tick 2: price drops to 99 (-0.5R)
  quote = createMockQuote({ currentPrice: 99 });
  res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T09:40:00.000Z'));
  assert.strictEqual(res.wasClosed, false);
  assert.strictEqual(res.updatedTrade.mfe, 0.5, 'MFE should stay at peak high 0.5R');
  assert.strictEqual(res.updatedTrade.mae, -0.5, 'MAE should update to new trough -0.5R');
  trade = res.updatedTrade;

  // Tick 3: price rallies to 102 (+1.0R)
  quote = createMockQuote({ currentPrice: 102 });
  res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T09:45:00.000Z'));
  assert.strictEqual(res.wasClosed, false);
  assert.strictEqual(res.updatedTrade.mfe, 1.0, 'MFE should update to new peak 1.0R');
  assert.strictEqual(res.updatedTrade.mae, -0.5, 'MAE should remain at -0.5R');
  console.log('[T8_mfe_and_mae_tracking] PASS');
}

// Test 9: Gestione robusta quando potentialLossEur e maxRiskEur sono assenti o null
{
  const tradeWithoutRisk = createMockTrade({
    potentialLossEur: undefined,
    maxRiskEur: undefined,
    direction: 'LONG',
    entryPrice: 100,
    stopLoss: 98,
    target1: 103,
  });
  const quote = createMockQuote({ currentPrice: 97.9 });
  const res = evaluateOpenPositionLifecycle(tradeWithoutRisk, quote, new Date('2026-11-03T10:00:00.000Z'), {
    accountCapital: 10000,
  });

  assert.strictEqual(res.wasClosed, true, 'Must not abort when potentialLossEur is undefined');
  assert.strictEqual(res.updatedTrade.status, 'CLOSED');
  assert.strictEqual(res.updatedTrade.outcome, 'LOSS');
  assert.ok(res.updatedTrade.pnlEur < 0, 'PnL calculated via fallback capital');
  console.log('[T9_missing_potential_loss_eur_fallback] PASS');
}

console.log('ALL POSITION LIFECYCLE TESTS PASS!');
