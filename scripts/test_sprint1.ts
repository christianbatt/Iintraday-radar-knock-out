import {
  calculateOrbFromIntradayBars,
  calculateCandidateScore,
  calculateKnockOutBarrierGuard,
  IntradayCandleInput,
} from '../src/utils/calculator';
import { RawQuoteData } from '../src/types/radar';

console.log('=== TEST SPRINT 1 VERIFICATION ===');

// 1. G5 Direzionale: rottura ribassista non deve sporcare il breakout LONG
const baseDate = new Date('2026-10-26T09:00:00+01:00');
const testBars: IntradayCandleInput[] = [
  // 3 barre ORB 09:00, 09:05, 09:10
  { timestamp: '2026-10-26T09:00:00+01:00', high: 100.0, low: 99.0, close: 99.5 },
  { timestamp: '2026-10-26T09:05:00+01:00', high: 99.8, low: 99.2, close: 99.4 },
  { timestamp: '2026-10-26T09:10:00+01:00', high: 99.9, low: 99.1, close: 99.7 },
  // Post-ORB 09:15: spike ribassista sotto orbLow (99.00 -> low 98.50) MA high sotto 100.00
  { timestamp: '2026-10-26T09:15:00+01:00', high: 99.5, low: 98.5, close: 99.0 },
  // Post-ORB 09:20: breakout rialzista sopra orbHigh (100.00 -> high 100.50)
  { timestamp: '2026-10-26T09:20:00+01:00', high: 100.5, low: 99.4, close: 100.2 },
];

const orbLong = calculateOrbFromIntradayBars(testBars, 'EU', baseDate, 'LONG');
console.log('1a. orbLong firstBreakoutTime:', orbLong.firstBreakoutTime);
const expectedLongTime = new Date('2026-10-26T09:20:00+01:00').toISOString();
if (orbLong.firstBreakoutTime !== expectedLongTime) {
  throw new Error(`Expected firstBreakoutTime for LONG to be 09:20 (${expectedLongTime}), got ${orbLong.firstBreakoutTime}`);
}

const orbShort = calculateOrbFromIntradayBars(testBars, 'EU', baseDate, 'SHORT');
console.log('1b. orbShort firstBreakoutTime:', orbShort.firstBreakoutTime);
const expectedShortTime = new Date('2026-10-26T09:15:00+01:00').toISOString();
if (orbShort.firstBreakoutTime !== expectedShortTime) {
  throw new Error(`Expected firstBreakoutTime for SHORT to be 09:15 (${expectedShortTime}), got ${orbShort.firstBreakoutTime}`);
}
console.log('-> Punto 1 G5 Direzionale: PASS');

// 2. Completezza ORB: con sole 2 barre 5m restituisce null (Gate G2 attivo)
const incompleteBars: IntradayCandleInput[] = [
  { timestamp: '2026-10-26T09:00:00+01:00', high: 100.0, low: 99.0, close: 99.5 },
  { timestamp: '2026-10-26T09:05:00+01:00', high: 99.8, low: 99.2, close: 99.4 },
];
const orbIncomplete = calculateOrbFromIntradayBars(incompleteBars, 'EU', baseDate, 'LONG');
if (orbIncomplete.orbHigh !== null || orbIncomplete.orbLow !== null) {
  throw new Error(`Expected null ORB with incomplete bars, got orbHigh: ${orbIncomplete.orbHigh}`);
}
console.log('-> Punto 6 Completezza ORB: PASS');

// 3. Unica fonte per barriera, leva e target: calcolo deterministico V112 in knockOutGuard
const quoteWithTS: RawQuoteData = {
  ticker: 'TEST.MI',
  name: 'Test Stock',
  market: 'EU',
  currency: 'EUR',
  currentPrice: 100,
  prevClose: 99,
  preMarketPrice: 100,
  prevHigh: 101,
  prevLow: 98,
  preMarketHigh: 100,
  preMarketLow: 99,
  avgVolume20d: 500000,
  preMarketVolume: 50000,
  atr14: 1.5,
  gapPercent: 1.0,
  rvol: 1.5,
  T: 100,
  S: 99.6, // dS = 0.40%
  timestamp: new Date().toISOString(),
  source: 'test',
};

const guard = calculateKnockOutBarrierGuard(quoteWithTS, 'LONG');
console.log('3. Guard deterministico V112:', guard);
if (guard.maxRecommendedLeverage !== 25) {
  throw new Error(`Expected maxRecommendedLeverage 25, got ${guard.maxRecommendedLeverage}`);
}
if (guard.safeBarrierLevel !== 96.0) {
  throw new Error(`Expected safeBarrierLevel 96.00, got ${guard.safeBarrierLevel}`);
}
console.log('-> Punto 3 Unica fonte barriera e target: PASS');

// 4. Punto 12: Notizie senza keyword ingenua (earnings/utili neutralizzati a 0pt, upgrade a 15pt)
const quoteBase: RawQuoteData = {
  ...quoteWithTS,
  gapPercent: 0.8,
  vwap: 100,
};

// 4a. Catalizzatore con earnings / utili -> bonus neutralizzato a 0pt
const scoreEarnings = calculateCandidateScore(
  quoteBase,
  0.5,
  {
    decisione: 'TRADE',
    direzione: 'LONG',
    catalizzatore: 'Rilascio trimestrale ed earnings oltre le attese',
    punti_a_favore: ['Fatturato in crescita', 'Nuova guidance'],
    rischi: [],
    condizioni_invalidazione: [],
    fonti: [{ title: 'Comunicato Ufficiale' }],
  } as any
);
console.log('4a. Score con earnings:', scoreEarnings.newsScore);
if (scoreEarnings.newsScore !== 0) {
  throw new Error(`Expected newsScore 0 for earnings event, got ${scoreEarnings.newsScore}`);
}

// 4b. Catalizzatore operativo solido: nuovo contratto / upgrade
const scoreUpgrade = calculateCandidateScore(
  quoteBase,
  0.5,
  {
    decisione: 'TRADE',
    direzione: 'LONG',
    catalizzatore: 'Upgrade a Buy da Morgan Stanley con nuovo contratto industriale',
    punti_a_favore: ['Espansione backlog'],
    rischi: [],
    condizioni_invalidazione: [],
    fonti: [{ title: 'Broker note' }],
  } as any
);
console.log('4b. Score con upgrade/contratto:', scoreUpgrade.newsScore);
if (scoreUpgrade.newsScore !== 15) {
  throw new Error(`Expected newsScore 15 for upgrade/contratto, got ${scoreUpgrade.newsScore}`);
}
console.log('-> Punto 12 Neutralizzazione keyword earnings: PASS');

console.log('=== ALL SPRINT 1 TESTS COMPLETED SUCCESSFULLY! ===');
