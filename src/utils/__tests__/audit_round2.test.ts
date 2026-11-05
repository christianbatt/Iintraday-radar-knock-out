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
import { mergeTradesWithTombstones } from '../tradeMerge';
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

// ---------------------------------------------------------------- VOCE 4
// Tombstone: un trade eliminato non deve risorgere dallo snapshot cloud.
{
  const mk = (id: string, ts: string): TradeJournalEntry => ({ ...tradeForKo(), id, timestamp: ts });
  const local = [mk('A', '2026-11-04T09:00:00.000Z'), mk('LOCAL', '2026-11-04T09:10:00.000Z')];
  const cloud = [mk('A', '2026-11-04T09:00:00.000Z'), mk('B', '2026-11-04T09:20:00.000Z')];

  const merged = mergeTradesWithTombstones(local, cloud, ['A']);
  assert.equal(merged.some((t) => t.id === 'A'), false, 'V4: trade cancellato non risorge');
  assert.equal(merged.some((t) => t.id === 'B'), true, 'V4: trade nuovo nel cloud aggiunto');
  assert.equal(merged.some((t) => t.id === 'LOCAL'), true, 'V4: trade solo locale conservato');
  assert.equal(merged[0].id, 'B', 'V4: merge ordinato per timestamp decrescente');

  const noTombs = mergeTradesWithTombstones(local, cloud, []);
  assert.equal(noTombs.length, 3, 'V4: senza tombstone il merge resta quello di prima');
  console.log('[V4_tombstone_merge] PASS');
}

// ---------------------------------------------------------------- VOCE 5
// La scansione legge lo stato variabile da ref: dipendenze invariate, nessun loop.
{
  const src = fs.readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes('macroCalendarRef.current?.events'), 'V5: macro calendario letto da ref');
  assert.ok(src.includes('catalystCacheRef.current'), 'V5: cache catalyst letta da ref');
  assert.ok(src.includes('newsCacheRef.current'), 'V5: cache news letta da ref');
  assert.ok(src.includes('sessionInfoRef.current?.cet?.currentMinutes'), 'V5: sessione letta da ref');
  assert.ok(
    src.includes('}, [underlyings, currentSession, futures, rsiFilterActive, parameters, journalEntries]);'),
    'V5: dipendenze della scansione invariate (nessun rilancio automatico)',
  );
  console.log('[V5_scan_refs] PASS');
}

// ---------------------------------------------------------------- VOCE 6
// Nessun side effect negli updater; abort della scansione precedente.
{
  const src = fs.readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes('new AbortController()'), 'V6: AbortController presente');
  assert.ok(src.includes('scanAbortRef.current?.abort()'), 'V6: nuova scansione annulla la precedente');
  assert.ok(src.includes('if (!isAlive()) return;'), 'V6: guardia signal.aborted prima dei setState');
  assert.equal(src.includes('setAutoRefreshCountdown((prev) => {'), false, 'V6: nessun side effect nel countdown');
  assert.equal(src.includes('setJournalEntries((prevEntries) => {'), false, 'V6: nessun side effect nel monitor');
  assert.equal(src.includes('return updatedList;'), false, 'V6: il monitor non ritorna da un updater');
  console.log('[V6_no_side_effect_in_updater] PASS');
}

console.log('audit_round2: 4 gruppi OK');
