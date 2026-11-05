/**
 * Audit round 2 — regressioni voci 3, 4, 5, 6.
 * Runner: tsx — `npm run test:audit2`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  calculateKnockOutSafety,
  evaluateOpenPositionLifecycle,
} from '../calculator';
import type { ExecutionSetup, TradeJournalEntry, RawQuoteData } from '../../types/radar';

const setupForKo = (over: Record<string, unknown> = {}): ExecutionSetup =>
  ({
    candidate: { ticker: 'TEST', market: 'EU', currency: 'EUR', currentPrice: 100, preMarketPrice: null, atr14: 2 },
    direction: 'LONG',
    entryLevel: 100,
    stopLossLevel: 50,
    target1Level: 120,
    atrValue: 2,
    ...over,
  } as unknown as ExecutionSetup);

const tradeForKo = (over: Partial<TradeJournalEntry> = {}): TradeJournalEntry =>
  ({
    id: 'T-KO-1',
    timestamp: '2026-11-04T09:30:00.000Z',
    date: '04/11/2026',
    session: 'EU',
    market: 'EU',
    ticker: 'TEST',
    direction: 'LONG',
    strategy: 'test',
    entryPrice: 100,
    exitPrice: 0,
    stopLoss: 50,
    target1: 120,
    pnlEur: 0,
    rMultiple: 0,
    outcome: 'BREAKEVEN',
    status: 'OPEN',
    notes: '',
    isPaper: true,
    potentialLossEur: 25,
    maxRiskEur: 10,
    frictionEur: 0,
    ...over,
  } as TradeJournalEntry);

const quoteAt = (price: number): RawQuoteData =>
  ({
    ticker: 'TEST',
    name: 'TEST',
    market: 'EU',
    currency: 'EUR',
    currentPrice: price,
    preMarketPrice: null,
    prevClose: 100,
    prevHigh: 101,
    prevLow: 99,
    preMarketHigh: null,
    preMarketLow: null,
    avgVolume20d: 1000000,
    preMarketVolume: 50000,
    atr14: 2,
    gapPercent: 0.5,
    rvol: 1.2,
    timestamp: '2026-11-04T09:35:00.000Z',
    source: 'test',
  } as RawQuoteData);

// ---------------------------------------------------------------- VOCE 3
// La perdita KO e' quella reale (quantita' x differenza prezzo), senza clamp a maxRisk.
{
  const ko = calculateKnockOutSafety(setupForKo(), {
    accountCapital: 1000,
    maxRiskPercent: 1,
    leverage: 1,
    barrierStrike: 40,
    certificatePrice: 50,
    ratio: 1,
    spreadEur: 0,
    brokerFeeEur: 0,
  });
  assert.equal(ko.maxRiskEur, 10, 'V3: rischio pianificato 10 EUR');
  assert.equal(ko.suggestedCertificates, 1, 'V3: dimensione minima 1 certificato invariata');
  assert.equal(ko.potentialLossEur, 25, 'V3: perdita riportata reale (1 x 25), senza clamp a 10');
  assert.equal(ko.riskBreached, true, 'V3: riskBreached quando la perdita reale supera maxRisk');

  const res = evaluateOpenPositionLifecycle(tradeForKo(), quoteAt(50), new Date('2026-11-04T10:00:00.000Z'));
  assert.equal(res.wasClosed, true, 'V3: stop colpito chiude la posizione');
  assert.equal(res.updatedTrade.outcome, 'LOSS');
  assert.equal(res.updatedTrade.pnlEur, -25, 'V3: PnL reale -25 EUR');
  assert.equal(res.updatedTrade.rMultiple, -2.5, 'V3: R = PnL reale / rischio pianificato = -25/10');

  // caso sotto maxRisk: comportamento invariato
  const koOk = calculateKnockOutSafety(setupForKo(), {
    accountCapital: 10000,
    maxRiskPercent: 1,
    leverage: 1,
    barrierStrike: 40,
    certificatePrice: 10,
    ratio: 1,
    spreadEur: 0,
    brokerFeeEur: 0,
  });
  assert.equal(koOk.maxRiskEur, 100, 'V3: rischio pianificato 100 EUR');
  assert.equal(koOk.potentialLossEur, 100, 'V3: perdita reale = risco pianificato (nessun clamp necessario)');
  assert.equal(koOk.riskBreached, false, 'V3: nessun breach quando la perdita resta entro maxRisk');
  console.log('[V3_perdita_ko_senza_clamp] PASS');
}

console.log('audit_round2: 1 gruppo OK');
