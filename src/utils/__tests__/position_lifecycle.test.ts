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

// Test 10: US Soft Cutoff (17:30 CET) - Caso 3.1: R < 0.35 -> Chiudi a mercato, motivo CUTOFF_EXPIRED
{
  const trade = createMockTrade({
    session: 'US',
    market: 'US',
    ticker: 'AAPL',
    direction: 'LONG',
    entryPrice: 200,
    stopLoss: 190, // riskDist = 10
    target1: 220,
  });
  // Price at 202 (+0.20R < +0.35R)
  const quote = createMockQuote({ ticker: 'AAPL', market: 'US', currentPrice: 202 });
  const session1730: SessionInfo = {
    cet: {
      formatted: '17:35',
      date: '03/11/2026',
      hour: 17,
      minute: 35,
      currentMinutes: 1055, // 17:35 CET, past 17:30 (1050)
      isEuropeWindow: false,
      isUSAWindow: true,
      isEuropeLive: false,
      isUSALive: true,
      marketStatusUS: 'OPEN_LIVE',
    },
    recommendedSession: 'US',
  };

  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T16:35:00.000Z'), {
    sessionInfo: session1730,
    usSoftCutoffCET: 1050,
    softCutoffRThreshold: 0.35,
  });

  assert.strictEqual(res.wasClosed, true, 'US trade with R < 0.35 at cutoff must be closed');
  assert.strictEqual(res.updatedTrade.status, 'CLOSED');
  assert.strictEqual(res.updatedTrade.closeReason, 'CUTOFF_EXPIRED');
  assert.strictEqual(res.updatedTrade.rMultiple, 0.2);
  console.log('[T10_us_cutoff_r_below_threshold_expired] PASS');
}

// Test 11: US Soft Cutoff (17:30 CET) - Caso 3.2: R >= 0.35 e momentum >= 0 -> Stop a pareggio, resta aperta
{
  const trade = createMockTrade({
    session: 'US',
    market: 'US',
    ticker: 'MSFT',
    direction: 'LONG',
    entryPrice: 500,
    stopLoss: 490, // riskDist = 10
    target1: 520,
    mfe: 0.8,
  });
  // Price at 508 (+0.80R >= +0.35R, and on peak so proxy momentum >= 0)
  const quote = createMockQuote({ ticker: 'MSFT', market: 'US', currentPrice: 508 });
  const session1730: SessionInfo = {
    cet: {
      formatted: '17:35',
      date: '03/11/2026',
      hour: 17,
      minute: 35,
      currentMinutes: 1055,
      isEuropeWindow: false,
      isUSAWindow: true,
      isUSALive: true,
      marketStatusUS: 'OPEN_LIVE',
    },
    recommendedSession: 'US',
  };

  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T16:35:00.000Z'), {
    sessionInfo: session1730,
    usSoftCutoffCET: 1050,
    softCutoffRThreshold: 0.35,
    momentum: 0.25, // momentum positivo esplicito
  });

  assert.strictEqual(res.wasClosed, false, 'US trade with R >= 0.35 and momentum >= 0 must stay open');
  assert.strictEqual(res.updatedTrade.status, 'OPEN');
  assert.strictEqual(res.updatedTrade.softCutoffActive, true);
  assert.strictEqual(res.updatedTrade.isBreakevenLocked, true);
  assert.strictEqual(res.updatedTrade.stopLoss, 500, 'Stop loss must be moved to entry (breakeven)');
  assert.strictEqual(res.reason, 'SOFT_CUTOFF_ACTIVATED');
  console.log('[T11_us_cutoff_r_above_threshold_positive_momentum_stays_open] PASS');
}

// Test 12: US Soft Cutoff (17:30 CET) - Caso 3.3: R >= 0.35 e momentum < 0 -> Chiudi a mercato, motivo CUTOFF_MOMENTUM_LOSS
{
  const trade = createMockTrade({
    session: 'US',
    market: 'US',
    ticker: 'NVDA',
    direction: 'LONG',
    entryPrice: 100,
    stopLoss: 90, // riskDist = 10
    target1: 120,
    mfe: 1.2, // aveva toccato 112 (+1.2R)
  });
  // Price now dropped back to 105 (+0.50R >= +0.35R, but retraced from +1.2R -> negative momentum)
  const quote = createMockQuote({ ticker: 'NVDA', market: 'US', currentPrice: 105 });
  const session1730: SessionInfo = {
    cet: {
      formatted: '17:35',
      date: '03/11/2026',
      hour: 17,
      minute: 35,
      currentMinutes: 1055,
      isEuropeWindow: false,
      isUSAWindow: true,
      isUSALive: true,
      marketStatusUS: 'OPEN_LIVE',
    },
    recommendedSession: 'US',
  };

  // Test con momentum < 0 (sia via proxy arretramento MFE che con parametro momentum: -0.30)
  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T16:35:00.000Z'), {
    sessionInfo: session1730,
    usSoftCutoffCET: 1050,
    softCutoffRThreshold: 0.35,
    momentum: -0.30,
  });

  assert.strictEqual(res.wasClosed, true, 'US trade with R >= 0.35 and momentum < 0 must be closed');
  assert.strictEqual(res.updatedTrade.status, 'CLOSED');
  assert.strictEqual(res.updatedTrade.closeReason, 'CUTOFF_MOMENTUM_LOSS');
  assert.strictEqual(res.updatedTrade.exitPrice, 105);
  assert.strictEqual(res.updatedTrade.rMultiple, 0.5);
  console.log('[T12_us_cutoff_r_above_threshold_negative_momentum_closed] PASS');
}

// Test 13: Verifica tassativa R <= -1 si chiude sullo stop e non resta mai IN CORSO
{
  const trade = createMockTrade({
    direction: 'LONG',
    entryPrice: 100,
    stopLoss: 95, // riskDist = 5
    target1: 110,
  });
  // Price at 95.00 (exact -1.0R)
  const quoteExact = createMockQuote({ currentPrice: 95.00 });
  const resExact = evaluateOpenPositionLifecycle(trade, quoteExact, new Date('2026-11-03T10:00:00.000Z'));
  assert.strictEqual(resExact.wasClosed, true);
  assert.strictEqual(resExact.updatedTrade.status, 'CLOSED');
  assert.strictEqual(resExact.updatedTrade.outcome, 'LOSS');
  assert.strictEqual(resExact.updatedTrade.rMultiple, -1.0);

  // Price at 90.00 (gap to -2.0R <= -1.0R)
  const quoteGap = createMockQuote({ currentPrice: 90.00 });
  const resGap = evaluateOpenPositionLifecycle(trade, quoteGap, new Date('2026-11-03T10:00:00.000Z'));
  assert.strictEqual(resGap.wasClosed, true);
  assert.strictEqual(resGap.updatedTrade.status, 'CLOSED');
  assert.strictEqual(resGap.updatedTrade.outcome, 'LOSS');
  assert.strictEqual(resGap.updatedTrade.closeReason, 'STOP_GAP_SLIPPAGE');
  assert.strictEqual(resGap.updatedTrade.rMultiple, -2.0);
  console.log('[T13_strict_r_below_minus_1_closed] PASS');
}

// Test 14: Proxy momentum (soglia default usMomentumRetraceR = 0.25) - arretramento 0.10R -> resta aperta
{
  const trade = createMockTrade({
    session: 'US',
    market: 'US',
    ticker: 'TSLA',
    direction: 'LONG',
    entryPrice: 100,
    stopLoss: 90, // riskDist = 10
    target1: 120,
    mfe: 0.7, // picco +0.70R, prezzo attuale +0.60R => arretramento 0.10R
  });
  const quote = createMockQuote({ ticker: 'TSLA', market: 'US', currentPrice: 106 }); // +0.60R
  const session1735: SessionInfo = {
    cet: {
      formatted: '17:35',
      date: '03/11/2026',
      hour: 17,
      minute: 35,
      currentMinutes: 1055,
      isEuropeWindow: false,
      isUSAWindow: true,
      isEuropeLive: false,
      isUSALive: true,
      marketStatusUS: 'OPEN_LIVE',
    },
    recommendedSession: 'US',
  };

  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T16:35:00.000Z'), {
    sessionInfo: session1735,
    usSoftCutoffCET: 1050,
    softCutoffRThreshold: 0.35,
  });

  assert.strictEqual(res.wasClosed, false, 'Retracement 0.10R below 0.25R threshold must keep position open');
  assert.strictEqual(res.updatedTrade.status, 'OPEN');
  assert.strictEqual(res.updatedTrade.softCutoffActive, true);
  console.log('[T14_momentum_proxy_retrace_010_stays_open] PASS');
}

// Test 15: Proxy momentum - arretramento 0.30R (> soglia 0.25R) -> chiusura CUTOFF_MOMENTUM_LOSS
{
  const trade = createMockTrade({
    session: 'US',
    market: 'US',
    ticker: 'AMD',
    direction: 'LONG',
    entryPrice: 100,
    stopLoss: 90, // riskDist = 10
    target1: 120,
    mfe: 0.9, // picco +0.90R, prezzo attuale +0.60R => arretramento 0.30R
  });
  const quote = createMockQuote({ ticker: 'AMD', market: 'US', currentPrice: 106 }); // +0.60R
  const session1735: SessionInfo = {
    cet: {
      formatted: '17:35',
      date: '03/11/2026',
      hour: 17,
      minute: 35,
      currentMinutes: 1055,
      isEuropeWindow: false,
      isUSAWindow: true,
      isEuropeLive: false,
      isUSALive: true,
      marketStatusUS: 'OPEN_LIVE',
    },
    recommendedSession: 'US',
  };

  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T16:35:00.000Z'), {
    sessionInfo: session1735,
    usSoftCutoffCET: 1050,
    softCutoffRThreshold: 0.35,
  });

  assert.strictEqual(res.wasClosed, true, 'Retracement 0.30R above 0.25R threshold must close position');
  assert.strictEqual(res.updatedTrade.status, 'CLOSED');
  assert.strictEqual(res.updatedTrade.closeReason, 'CUTOFF_MOMENTUM_LOSS');
  assert.strictEqual(res.updatedTrade.rMultiple, 0.6);
  console.log('[T15_momentum_proxy_retrace_030_closes] PASS');
}

// Test 16: Hard ceiling US 21:30 con R = 0.6 e momentum >= 0 -> CUTOFF_EXPIRED (non CUTOFF_MOMENTUM_LOSS)
{
  const trade = createMockTrade({
    session: 'US',
    market: 'US',
    ticker: 'META',
    direction: 'LONG',
    entryPrice: 100,
    stopLoss: 90, // riskDist = 10
    target1: 120,
    mfe: 0.7, // arretramento 0.10R => momentum >= 0
  });
  const quote = createMockQuote({ ticker: 'META', market: 'US', currentPrice: 106 }); // +0.60R
  const session2135: SessionInfo = {
    cet: {
      formatted: '21:35',
      date: '03/11/2026',
      hour: 21,
      minute: 35,
      currentMinutes: 1295, // 21:35 CET, oltre hard ceiling 1290 e prima di EOD 1320
      isEuropeWindow: false,
      isUSAWindow: true,
      isEuropeLive: false,
      isUSALive: true,
      marketStatusUS: 'OPEN_LIVE',
    },
    recommendedSession: 'US',
  };

  const res = evaluateOpenPositionLifecycle(trade, quote, new Date('2026-11-03T20:35:00.000Z'), {
    sessionInfo: session2135,
    usSoftCutoffCET: 1050,
    usHardCeilingCET: 1290,
    softCutoffRThreshold: 0.35,
  });

  assert.strictEqual(res.wasClosed, true, 'Position must close at US hard ceiling');
  assert.strictEqual(res.updatedTrade.status, 'CLOSED');
  assert.strictEqual(res.updatedTrade.closeReason, 'CUTOFF_EXPIRED', 'Expiry at 21:30 must not be reported as momentum loss');
  assert.strictEqual(res.updatedTrade.rMultiple, 0.6);
  assert.ok(
    typeof res.notification === 'string' && res.notification.includes('21:30'),
    'Notification must reference the 21:30 hard ceiling'
  );
  console.log('[T16_us_hard_ceiling_expired_not_momentum_loss] PASS');
}

console.log('ALL POSITION LIFECYCLE TESTS PASS!');
