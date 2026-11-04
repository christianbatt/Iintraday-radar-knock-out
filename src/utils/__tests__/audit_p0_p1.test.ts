/**
 * Regressioni per l'audit P0/P1 (voci 1-5 e 8).
 * Runner: tsx (nessun vitest/jest nel progetto) — `npx tsx src/utils/__tests__/audit_p0_p1.test.ts`.
 */
import assert from 'node:assert/strict';
import {
  evaluateOpenPositionLifecycle,
  calculateKnockOutSafety,
  calculateOrbFromIntradayBars,
} from '../calculator';
import { selectWarmupBars } from '../indicators';
import type { TradeJournalEntry } from '../../types/radar';

const baseTrade = (over: Partial<TradeJournalEntry> = {}): TradeJournalEntry =>
  ({
    id: 'T1',
    timestamp: '2026-11-04T08:30:00Z',
    date: '04/11/2026',
    session: 'EU',
    market: 'EU',
    ticker: 'TEST',
    direction: 'LONG',
    strategy: 'test',
    entryPrice: 100,
    exitPrice: 0,
    stopLoss: 99,
    target1: 102,
    pnlEur: 0,
    rMultiple: 0,
    outcome: 'BREAKEVEN',
    status: 'OPEN',
    notes: '',
    isPaper: true,
    ...over,
  } as TradeJournalEntry);

// ---------------------------------------------------------------- VOCE 1
// Una quote senza prezzo operativo (solo prevClose) non deve chiudere nulla.
{
  const trade = baseTrade();
  const res = evaluateOpenPositionLifecycle(
    trade,
    { ticker: 'TEST', market: 'EU', prevClose: 99.5 } as any,
    new Date('2026-11-04T10:45:00Z') // 11:45 Roma, oltre il soft cutoff EU
  );
  assert.equal(res.wasClosed, false, 'V1: nessun prezzo operativo -> nessuna chiusura');
  assert.equal(res.updatedTrade.status, 'OPEN', 'V1: il trade resta OPEN (non valutabile)');
  assert.equal(res.updatedTrade.pnlEur, 0, 'V1: nessun PnL inventato');
}

// ---------------------------------------------------------------- VOCE 2
// entry == stop e T1 == entry sono setup invalidi: non si valuta, nessun fallback.
{
  const resA = evaluateOpenPositionLifecycle(
    baseTrade({ stopLoss: 100 }),
    { ticker: 'TEST', market: 'EU', currentPrice: 101 } as any,
    new Date('2026-11-04T08:30:00Z')
  );
  assert.equal(resA.wasClosed, false, 'V2: entry == stop -> non valutabile');

  const resB = evaluateOpenPositionLifecycle(
    baseTrade({ target1: 100 }),
    { ticker: 'TEST', market: 'EU', currentPrice: 101 } as any,
    new Date('2026-11-04T08:30:00Z')
  );
  assert.equal(resB.wasClosed, false, 'V2: T1 == entry -> non valutabile');
}

// ---------------------------------------------------------------- VOCE 3
// Safety KO calcolata sul prezzo di entry operativo (E), non sul trigger (T).
{
  const setup = {
    candidate: { ticker: 'TEST', market: 'EU', currentPrice: 101.5, preMarketPrice: 101.5 } as any,
    direction: 'LONG',
    triggerLevel: 100,
    entryLevel: 101.5,
    stopLossLevel: 99,
    atrValue: 1,
  } as any;
  const safety = calculateKnockOutSafety(setup, {
    barrierStrike: 95,
    leverage: 10,
    certificates: 10,
    investedEur: 1000,
  } as any);
  assert.equal(safety.entryPrice, 101.5, 'V3: entryPrice = entryLevel operativo, non il trigger');
}

// ---------------------------------------------------------------- VOCE 4
// Le barre non databili non entrano nel warm-up.
{
  const bars = [
    { t: Date.parse('2026-11-03T09:00:00Z'), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
    { t: Number.NaN, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
    { t: Date.parse('2026-11-03T09:05:00Z'), o: 1, h: 2, l: 0.5, c: 1.6, v: 10 },
  ] as any[];
  const sel = selectWarmupBars(bars, 'EU', { now: new Date('2026-11-04T09:00:00Z') });
  assert.equal(sel.bars.length, 2, 'V4: la barra con timestamp NaN e\' esclusa');
  assert.ok(
    sel.bars.every((b) => Number.isFinite(new Date(b.t).getTime())),
    'V4: nessuna barra non databile nel risultato'
  );
}

// ---------------------------------------------------------------- VOCE 5
// ORB: nessun breakout after-hours e nessun breakout su barra non ancora chiusa.
{
  const d = (iso: string) => new Date(iso);
  const orbBars = [
    { timestamp: d('2026-11-04T08:00:00Z'), high: 101, low: 100, close: 100.5, volume: 10 }, // 09:00 Roma
    { timestamp: d('2026-11-04T08:05:00Z'), high: 102, low: 100, close: 101, volume: 10 }, // 09:05
    { timestamp: d('2026-11-04T08:10:00Z'), high: 101.5, low: 99, close: 100, volume: 10 }, // 09:10
  ];

  const afterHours = calculateOrbFromIntradayBars(
    [
      ...orbBars,
      { timestamp: d('2026-11-04T16:45:00Z'), high: 120, low: 119, close: 119.5, volume: 10 }, // 17:45 Roma
    ],
    'EU',
    d('2026-11-04T08:00:00Z'),
    'LONG',
    d('2026-11-04T18:00:00Z')
  );
  assert.equal(afterHours.orbHigh, 102, 'V5: ORB calcolato sui 3 slot');
  assert.equal(afterHours.firstBreakoutTime, null, 'V5: breakout after-hours ignorato');

  const inSession = calculateOrbFromIntradayBars(
    [
      ...orbBars,
      { timestamp: d('2026-11-04T08:15:00Z'), high: 105, low: 102, close: 104, volume: 10 }, // 09:15
    ],
    'EU',
    d('2026-11-04T08:00:00Z'),
    'LONG',
    d('2026-11-04T08:20:00Z')
  );
  assert.equal(
    inSession.firstBreakoutTime,
    d('2026-11-04T08:15:00Z').toISOString(),
    'V5: breakout in sessione su barra chiusa registrato'
  );

  const notClosedYet = calculateOrbFromIntradayBars(
    [
      ...orbBars,
      { timestamp: d('2026-11-04T08:15:00Z'), high: 105, low: 102, close: 104, volume: 10 },
    ],
    'EU',
    d('2026-11-04T08:00:00Z'),
    'LONG',
    d('2026-11-04T08:16:00Z') // la barra 09:15 chiude alle 09:20
  );
  assert.equal(notClosedYet.firstBreakoutTime, null, 'V5: barra non ancora chiusa ignorata');
}

// ---------------------------------------------------------------- VOCE 8
// Un R negativo e' LOSS, non BREAKEVEN/EXPIRED.
{
  const res = evaluateOpenPositionLifecycle(
    baseTrade(),
    { ticker: 'TEST', market: 'EU', currentPrice: 99.5 } as any, // R = -0.5
    new Date('2026-11-04T10:45:00Z') // 11:45 Roma: soft cutoff EU superato
  );
  assert.equal(res.wasClosed, true, 'V8: il trade viene chiuso al cutoff');
  assert.equal(res.updatedTrade.outcome, 'LOSS', 'V8: R negativo -> LOSS');
  assert.equal(res.updatedTrade.rMultiple, -0.5, 'V8: R registrato correttamente');
  assert.equal(res.updatedTrade.closeReason, 'CUTOFF_EXPIRED', 'V8: motivo di chiusura invariato');

  const positive = evaluateOpenPositionLifecycle(
    baseTrade(),
    { ticker: 'TEST', market: 'EU', currentPrice: 100.05 } as any, // R = +0.05
    new Date('2026-11-04T10:45:00Z')
  );
  assert.equal(positive.updatedTrade.outcome, 'BREAKEVEN', 'V8: R positivo minimo resta pareggio tecnico');
}

console.log('audit_p0_p1: 6 gruppi di regressione OK (voci 1,2,3,4,5,8)');
