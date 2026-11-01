import {
  calculateOrbFromIntradayBars,
  calculateCandidateScore,
  calculateKnockOutBarrierGuard,
  calculateKnockOutSafety,
  buildExecutionSetup,
  checkQuoteStaleness,
  DEFAULT_SYSTEM_PARAMETERS,
  generatePnLScenarios,
  IntradayCandleInput,
} from '../src/utils/calculator';
import { RawQuoteData } from '../src/types/radar';
import { TRADING_PARAMS } from '../src/config/tradingParams';

console.log('================================================================');
console.log('=== SPRINT 1+2 TEST SUITE: LOGICA & INTEGRITÀ DEI SETUP ===');
console.log('================================================================');

// -----------------------------------------------------------------------------
// PUNTO 1: G5 BREAKOUT NELLA DIREZIONE CORRETTA
// -----------------------------------------------------------------------------
console.log('\n--- PUNTO 1: G5 Breakout Direzionale ---');

const baseDate = new Date('2026-10-26T09:00:00+01:00');
const testBars: IntradayCandleInput[] = [
  // 3 barre ORB 09:00, 09:05, 09:10
  { timestamp: '2026-10-26T09:00:00+01:00', high: 100.0, low: 99.0, close: 99.5 },
  { timestamp: '2026-10-26T09:05:00+01:00', high: 99.8, low: 99.2, close: 99.4 },
  { timestamp: '2026-10-26T09:10:00+01:00', high: 99.9, low: 99.1, close: 99.7 },
  // Post-ORB 09:15: rottura RIBASSISTA sotto orbLow (99.00 -> low 98.50) MA high sotto 100.00
  { timestamp: '2026-10-26T09:15:00+01:00', high: 99.5, low: 98.5, close: 98.8 },
  // Post-ORB 09:20: rottura RIALZISTA sopra orbHigh (100.00 -> high 100.50)
  { timestamp: '2026-10-26T09:20:00+01:00', high: 100.5, low: 99.4, close: 100.2 },
];

const orbLong = calculateOrbFromIntradayBars(testBars, 'EU', baseDate, 'LONG');
const expectedLongTime = new Date('2026-10-26T09:20:00+01:00').toISOString();
if (orbLong.firstBreakoutTime !== expectedLongTime) {
  throw new Error(`Punto 1 Fail: Breakout LONG atteso alle 09:20, ottenuto: ${orbLong.firstBreakoutTime}`);
}
console.log('1.1 Breakout LONG rilevato correttamente:', orbLong.firstBreakoutTime);

const orbShort = calculateOrbFromIntradayBars(testBars, 'EU', baseDate, 'SHORT');
const expectedShortTime = new Date('2026-10-26T09:15:00+01:00').toISOString();
if (orbShort.firstBreakoutTime !== expectedShortTime) {
  throw new Error(`Punto 1 Fail: Breakout SHORT atteso alle 09:15, ottenuto: ${orbShort.firstBreakoutTime}`);
}
console.log('1.2 Breakout SHORT rilevato correttamente:', orbShort.firstBreakoutTime);

const wickOnlyBars: IntradayCandleInput[] = [
  ...testBars.slice(0, 3),
  { timestamp: '2026-10-26T09:15:00+01:00', high: 100.5, low: 98.5, close: 99.5 },
];
const orbWickOnly = calculateOrbFromIntradayBars(wickOnlyBars, 'EU', baseDate);
if (orbWickOnly.firstBreakoutTimeLong !== null || orbWickOnly.firstBreakoutTimeShort !== null) {
  throw new Error('S2.1 Wick oltre ORB con chiusura interna non deve confermare breakout');
}
console.log('S2.1 Wick oltre i livelli con chiusura dentro ORB: PASS (nessun breakout)');

const closeConfirmedBars: IntradayCandleInput[] = [
  ...testBars.slice(0, 3),
  { timestamp: '2026-10-26T09:15:00+01:00', high: 100.5, low: 99.2, close: 100.1 },
  { timestamp: '2026-10-26T09:20:00+01:00', high: 99.8, low: 98.5, close: 98.8 },
];
const orbCloseConfirmed = calculateOrbFromIntradayBars(closeConfirmedBars, 'EU', baseDate);
if (
  orbCloseConfirmed.firstBreakoutTimeLong !== new Date('2026-10-26T09:15:00+01:00').toISOString() ||
  orbCloseConfirmed.firstBreakoutTimeShort !== new Date('2026-10-26T09:20:00+01:00').toISOString()
) {
  throw new Error('S2.2 I breakout devono essere confermati dalle chiusure oltre i livelli ORB');
}
console.log('S2.2 Chiusure oltre ORB confermano LONG e SHORT: PASS');

// 1.3 Solo rottura opposta: se si verifica SOLO un breakdown short, non deve impostare il timestamp LONG
const onlyShortBreakBars: IntradayCandleInput[] = [
  { timestamp: '2026-10-26T09:00:00+01:00', high: 100.0, low: 99.0, close: 99.5 },
  { timestamp: '2026-10-26T09:05:00+01:00', high: 99.8, low: 99.2, close: 99.4 },
  { timestamp: '2026-10-26T09:10:00+01:00', high: 99.9, low: 99.1, close: 99.7 },
  { timestamp: '2026-10-26T09:15:00+01:00', high: 99.5, low: 98.2, close: 98.8 }, // rottura short
];
const orbOnlyShort = calculateOrbFromIntradayBars(onlyShortBreakBars, 'EU', baseDate, 'LONG');
if (orbOnlyShort.firstBreakoutTime !== null) {
  throw new Error(`Punto 1 Fail: rottura SHORT non deve impostare firstBreakoutTime per LONG. Ottenuto: ${orbOnlyShort.firstBreakoutTime}`);
}
if (orbOnlyShort.firstBreakoutTimeLong !== null) {
  throw new Error('Punto 1 Fail: firstBreakoutTimeLong deve essere null');
}
if (orbOnlyShort.firstBreakoutTimeShort === null) {
  throw new Error('Punto 1 Fail: firstBreakoutTimeShort deve registrare il breakdown alle 09:15');
}
console.log('1.3 Rottura opposta isolata non inquina la direzione opposta: PASS');

// 1.4 Nessuna rottura: entrambi null
const noBreakBars: IntradayCandleInput[] = [
  { timestamp: '2026-10-26T09:00:00+01:00', high: 100.0, low: 99.0, close: 99.5 },
  { timestamp: '2026-10-26T09:05:00+01:00', high: 99.8, low: 99.2, close: 99.4 },
  { timestamp: '2026-10-26T09:10:00+01:00', high: 99.9, low: 99.1, close: 99.7 },
  { timestamp: '2026-10-26T09:15:00+01:00', high: 99.8, low: 99.2, close: 99.5 }, // dentro range
];
const orbNoBreak = calculateOrbFromIntradayBars(noBreakBars, 'EU', baseDate);
if (orbNoBreak.firstBreakoutTimeLong !== null || orbNoBreak.firstBreakoutTimeShort !== null) {
  throw new Error('Punto 1 Fail: Nessuna rottura deve restituire timestamp null per entrambi i lati');
}
console.log('1.4 Nessuna rottura: PASS');

// 1.5 G5 scade solo usando il timestamp della direzione selezionata
// Supponiamo che alle 09:15 sia avvenuta rottura SHORT, e alle 09:40 rottura LONG.
// Valutando il setup alle 09:50:
// Per LONG: tempo trascorso dalla rottura LONG (09:40) = 10 min <= FRESH_MIN (30 min) -> G5 PASSA!
// Se avesse usato erroneamente il timestamp SHORT (09:15, diff = 35 min > 30 min), G5 sarebbe scaduto falsamente!
const quoteWithDirectionalBreakouts: RawQuoteData = {
  ticker: 'ENI.MI',
  name: 'Eni S.p.A.',
  market: 'EU',
  currency: 'EUR',
  currentPrice: 100.10,
  prevClose: 99.00,
  preMarketPrice: 100.00,
  prevHigh: 101.00,
  prevLow: 98.00,
  preMarketHigh: 100.00,
  preMarketLow: 99.50,
  todayOpen: 100.00,
  todayHigh: 100.20,
  todayLow: 98.50,
  avgVolume20d: 500000,
  preMarketVolume: 50000,
  atr14: 1.5,
  adr14: 2.0,
  liqEur20d: 5_000_000,
  completedBarsCount: 20,
  gapPercent: 1.0,
  rvol: 1.5,
  orbHigh: 100.00,
  orbLow: 99.00,
  T: 100.00,
  S: 99.00 * (1 - TRADING_PARAMS.STOP_BUF),
  orbBreakoutTime: new Date('2026-10-26T09:15:00+01:00').toISOString(), // SHORT rottura vecchia (35 min fa)
  orbBreakoutTimeShort: new Date('2026-10-26T09:15:00+01:00').toISOString(), // 35m fa
  orbBreakoutTimeLong: new Date('2026-10-26T09:40:00+01:00').toISOString(),  // 10m fa (fresca!)
  timestamp: '2026-10-26T09:50:00+01:00',
  source: 'test',
};

const setupLong = buildExecutionSetup(
  { quote: quoteWithDirectionalBreakouts, score: { total: 80 } as any, rank: 1 },
  { decisione: 'TRADE', direzione: 'LONG', catalizzatore: '', punti_a_favore: [], rischi: [], condizioni_invalidazione: [], fonti: [] },
  'EU',
  undefined,
  { currentTime: new Date('2026-10-26T09:50:00+01:00') }
);

if (!setupLong.gateResults?.['G5']?.passed) {
  throw new Error('Punto 1 Fail: Il setup LONG non doveva scadere in G5 poiché la rottura LONG è avvenuta solo 10 minuti fa!');
}
console.log('1.5 Setup LONG con rottura fresca non scade per breakdown opposto vecchio: PASS');

const quoteWithShortBreakouts: RawQuoteData = {
  ...quoteWithDirectionalBreakouts,
  gapPercent: -1.0,
  orbBreakoutTimeShort: new Date('2026-10-26T09:40:00+01:00').toISOString(),
  orbBreakoutTimeLong: new Date('2026-10-26T09:45:00+01:00').toISOString(),
};
const setupShortWithLaterLong = buildExecutionSetup(
  { quote: quoteWithShortBreakouts, score: { total: 80 } as any, rank: 1 },
  { decisione: 'TRADE', direzione: 'SHORT', catalizzatore: '', punti_a_favore: [], rischi: [], condizioni_invalidazione: [], fonti: [] },
  'EU',
  undefined,
  { currentTime: new Date('2026-10-26T09:50:00+01:00') }
);
if (!setupShortWithLaterLong.gateResults?.['G5']?.passed) {
  throw new Error('1.6 Setup SHORT con breakout SHORT presente non deve scadere per il timestamp LONG più recente');
}
console.log('1.6 G5 SHORT usa il proprio breakout anche se il LONG è più recente: PASS');

const quoteShortAgainstOlderLong: RawQuoteData = {
  ...quoteWithShortBreakouts,
  orbBreakoutTimeLong: new Date('2026-10-26T09:15:00+01:00').toISOString(),
  orbBreakoutTime: new Date('2026-10-26T09:15:00+01:00').toISOString(),
};
const setupShortAgainstOlderLong = buildExecutionSetup(
  { quote: quoteShortAgainstOlderLong, score: { total: 80 } as any, rank: 1 },
  { decisione: 'TRADE', direzione: 'SHORT', catalizzatore: '', punti_a_favore: [], rischi: [], condizioni_invalidazione: [], fonti: [] },
  'EU',
  undefined,
  { currentTime: new Date('2026-10-26T09:50:00+01:00') }
);
if (!setupShortAgainstOlderLong.gateResults?.['G5']?.passed) {
  throw new Error('1.7 G5 SHORT deve usare il breakout delle 09:40, non il timestamp LONG/generico delle 09:15');
}
console.log('1.7 G5 SHORT 09:40 con LONG/generico 09:15: PASS');

const quoteWithoutShortBreakout: RawQuoteData = {
  ...quoteWithShortBreakouts,
  orbBreakoutTimeShort: null,
  orbBreakoutTimeLong: new Date('2026-10-26T09:15:00+01:00').toISOString(),
  orbBreakoutTime: new Date('2026-10-26T09:15:00+01:00').toISOString(),
};
const setupShortWithoutBreakout = buildExecutionSetup(
  { quote: quoteWithoutShortBreakout, score: { total: 80 } as any, rank: 1 },
  { decisione: 'TRADE', direzione: 'SHORT', catalizzatore: '', punti_a_favore: [], rischi: [], condizioni_invalidazione: [], fonti: [] },
  'EU',
  undefined,
  { currentTime: new Date('2026-10-26T09:50:00+01:00') }
);
if (!setupShortWithoutBreakout.gateResults?.['G5']?.passed) {
  throw new Error('1.8 G5 SHORT senza timestamp direzionale deve passare (Tb null)');
}
console.log('1.8 G5 SHORT senza timestamp SHORT: PASS (Tb null)');

// -----------------------------------------------------------------------------
// PUNTO 6: COMPLETEZZA ORB (TRE BARRE 5M COMPLETE E VALIDE)
// -----------------------------------------------------------------------------
console.log('\n--- PUNTO 6: Completezza ORB a 3 barre ---');

// 6.1: 0 barre
const orb0 = calculateOrbFromIntradayBars([], 'EU', baseDate);
if (orb0.orbHigh !== null || orb0.orbLow !== null) throw new Error('6.1 0 barre deve dare null');

// 6.2: 1 barra
const orb1 = calculateOrbFromIntradayBars([testBars[0]], 'EU', baseDate);
if (orb1.orbHigh !== null || orb1.orbLow !== null) throw new Error('6.2 1 barra deve dare null');

// 6.3: 2 barre
const orb2 = calculateOrbFromIntradayBars([testBars[0], testBars[1]], 'EU', baseDate);
if (orb2.orbHigh !== null || orb2.orbLow !== null) throw new Error('6.3 2 barre deve dare null');

// 6.4: 3 barre valide (09:00, 09:05, 09:10)
const valid3Bars: IntradayCandleInput[] = [
  { timestamp: '2026-10-26T09:00:00+01:00', high: 100.0, low: 99.0, close: 99.5 },
  { timestamp: '2026-10-26T09:05:00+01:00', high: 99.8, low: 99.2, close: 99.4 },
  { timestamp: '2026-10-26T09:10:00+01:00', high: 99.9, low: 99.1, close: 99.7 },
];
const orb3 = calculateOrbFromIntradayBars(valid3Bars, 'EU', baseDate);
if (orb3.orbHigh !== 100.0 || orb3.orbLow !== 99.0) {
  throw new Error(`6.4 3 barre valide deve dare High 100 e Low 99, ottenuto ${orb3.orbHigh}, ${orb3.orbLow}`);
}
console.log('6.1-6.4 Conteggio barre 0, 1, 2, 3: PASS');

// 6.5: Barra duplicata (due barre alle 09:05) -> Rifiutare, restituisce null
const dupBars: IntradayCandleInput[] = [
  { timestamp: '2026-10-26T09:00:00+01:00', high: 100.0, low: 99.0, close: 99.5 },
  { timestamp: '2026-10-26T09:05:00+01:00', high: 99.8, low: 99.2, close: 99.4 },
  { timestamp: '2026-10-26T09:05:00+01:00', high: 99.7, low: 99.3, close: 99.4 }, // duplicato
];
const orbDup = calculateOrbFromIntradayBars(dupBars, 'EU', baseDate);
if (orbDup.orbHigh !== null || orbDup.orbLow !== null) {
  throw new Error('6.5 Barra duplicata deve invalidare ORB restituendo null');
}
console.log('6.5 Rifiuto barra duplicata: PASS');

// 6.6: Barra non allineata (09:02 anziché 09:05)
const misalignedBars: IntradayCandleInput[] = [
  { timestamp: '2026-10-26T09:00:00+01:00', high: 100.0, low: 99.0, close: 99.5 },
  { timestamp: '2026-10-26T09:02:00+01:00', high: 99.8, low: 99.2, close: 99.4 }, // non allineata a 5m
  { timestamp: '2026-10-26T09:10:00+01:00', high: 99.9, low: 99.1, close: 99.7 },
];
const orbMisaligned = calculateOrbFromIntradayBars(misalignedBars, 'EU', baseDate);
if (orbMisaligned.orbHigh !== null || orbMisaligned.orbLow !== null) {
  throw new Error('6.6 Barra non allineata (09:02) deve invalidare ORB');
}
console.log('6.6 Rifiuto barra non allineata: PASS');

// 6.7: Barra ancora in formazione al momento asOf (es. asOf alle 09:14, la barra 09:10 termina alle 09:15)
const asOfForming = new Date('2026-10-26T09:14:00+01:00');
const orbForming = calculateOrbFromIntradayBars(valid3Bars, 'EU', baseDate, 'LONG', asOfForming);
if (orbForming.orbHigh !== null || orbForming.orbLow !== null) {
  throw new Error('6.7 Barra 09:10 ancora in formazione alle 09:14 deve risultare incompleta (null)');
}

const asOfCompleted = new Date('2026-10-26T09:15:00+01:00');
const orbCompleted = calculateOrbFromIntradayBars(valid3Bars, 'EU', baseDate, 'LONG', asOfCompleted);
if (orbCompleted.orbHigh !== 100.0 || orbCompleted.orbLow !== 99.0) {
  throw new Error('6.7 Alle 09:15 la barra 09:10 è terminata e ORB deve risultare valido');
}
console.log('6.7 Controllo completamento intervallo asOfTime: PASS');

// 6.8: ORB USA (09:30, 09:35, 09:40)
const usDate = new Date('2026-10-26T09:30:00-04:00');
const usBars: IntradayCandleInput[] = [
  { timestamp: '2026-10-26T09:30:00-04:00', high: 200.0, low: 198.0, close: 199.0 },
  { timestamp: '2026-10-26T09:35:00-04:00', high: 201.0, low: 198.5, close: 200.5 },
  { timestamp: '2026-10-26T09:40:00-04:00', high: 200.8, low: 199.0, close: 199.5 },
];
const orbUS = calculateOrbFromIntradayBars(usBars, 'US', usDate);
if (orbUS.orbHigh !== 201.0 || orbUS.orbLow !== 198.0) {
  throw new Error(`6.8 ORB US deve dare High 201 e Low 198, ottenuto ${orbUS.orbHigh}, ${orbUS.orbLow}`);
}
console.log('6.8 ORB USA valido: PASS');

// -----------------------------------------------------------------------------
// PUNTO 3: UNICA FONTE AUTOREVOLE PER BARRIERA, LEVA E TARGET
// -----------------------------------------------------------------------------
console.log('\n--- PUNTO 3: Unica fonte barriera, leva e target ---');

const quoteAuth: RawQuoteData = {
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

// Sprint 2: staleness EU/US e gate G12/G13 con G1-G11 passanti.
console.log('\n--- SPRINT 2: ADR residuo e freschezza quote ---');
const stalenessNow = new Date('2026-10-26T09:50:00+01:00');
const euQuoteFourMinutesOld = {
  ...quoteAuth,
  timestamp: new Date(stalenessNow.getTime() - 4 * 60000).toISOString(),
};
const euQuoteSixMinutesOld = {
  ...quoteAuth,
  timestamp: new Date(stalenessNow.getTime() - 6 * 60000).toISOString(),
};
if (checkQuoteStaleness(euQuoteFourMinutesOld, stalenessNow).isStale) {
  throw new Error('S2.3 Quote EU di 4 minuti deve restare fresca');
}
if (!checkQuoteStaleness(euQuoteSixMinutesOld, stalenessNow).isStale) {
  throw new Error('S2.3 Quote EU di 6 minuti deve risultare stantia');
}
if (!checkQuoteStaleness({ ...euQuoteFourMinutesOld, market: 'US' }, stalenessNow).isStale) {
  throw new Error('S2.3 Quote US di 4 minuti deve superare la soglia di 3 minuti');
}
if (!checkQuoteStaleness({ ...quoteAuth, timestamp: '' }, stalenessNow).isStale) {
  throw new Error('S2.3 Timestamp assente deve risultare stantio/non verificabile');
}
if (!checkQuoteStaleness({ ...quoteAuth, timestamp: 'invalid' }, stalenessNow).isStale) {
  throw new Error('S2.3 Timestamp non valido deve risultare stantio/non verificabile');
}
console.log('S2.3 Soglie EU/US, timestamp assente e non valido: PASS');

const setupForSprint2Gate = (quote: RawQuoteData) =>
  buildExecutionSetup(
    { quote, score: { total: 80 } as any, rank: 1 },
    { decisione: 'TRADE', direzione: 'LONG', catalizzatore: '', punti_a_favore: [], rischi: [], condizioni_invalidazione: [], fonti: [] },
    'EU',
    undefined,
    { currentTime: stalenessNow }
  );

const setupAdrBlocked = setupForSprint2Gate({
  ...quoteAuth,
  currentPrice: 100.1,
  orbHigh: 100,
  orbLow: 99,
  adr14: 1,
  liqEur20d: 5_000_000,
  todayHigh: 100.2,
  todayLow: 99.7,
  timestamp: stalenessNow.toISOString(),
});
if (
  setupAdrBlocked.gateResults?.['G7']?.passed !== true ||
  setupAdrBlocked.gateResults?.['G12']?.passed !== false ||
  setupAdrBlocked.blockedGate !== 'G12' ||
  setupAdrBlocked.decision !== 'NESSUN_TRADE'
) {
  throw new Error(`S2.4 T1 fuori ADR residuo deve bloccare G12, ottenuto ${setupAdrBlocked.blockedGate}`);
}
console.log('S2.4 T1 fuori ADR residuo blocca G12: PASS');

const setupStaleBlocked = setupForSprint2Gate({
  ...quoteAuth,
  currentPrice: 100.1,
  orbHigh: 100,
  orbLow: 99,
  adr14: 10,
  liqEur20d: 5_000_000,
  todayHigh: 100.2,
  todayLow: 99.9,
  timestamp: new Date(stalenessNow.getTime() - 6 * 60000).toISOString(),
});
if (
  setupStaleBlocked.gateResults?.['G12']?.passed !== true ||
  setupStaleBlocked.gateResults?.['G13']?.passed !== false ||
  setupStaleBlocked.blockedGate !== 'G13' ||
  setupStaleBlocked.decision !== 'NESSUN_TRADE'
) {
  throw new Error(`S2.5 Quote stantia deve bloccare G13, ottenuto ${setupStaleBlocked.blockedGate}`);
}
console.log('S2.5 Quote EU stantia blocca G13: PASS');

// 3.1 Long setup canonico
const guardLong = calculateKnockOutBarrierGuard(quoteAuth, 'LONG');
if (guardLong.maxRecommendedLeverage !== 25) {
  throw new Error(`3.1 Attesa leva 25, ottenuta: ${guardLong.maxRecommendedLeverage}`);
}
if (guardLong.safeBarrierLevel !== 96.0) {
  throw new Error(`3.1 Attesa barriera 96.00, ottenuta: ${guardLong.safeBarrierLevel}`);
}
if (guardLong.isExecutableSetup !== true) {
  throw new Error('3.1 isExecutableSetup deve essere true');
}
console.log('3.1 Guard V112 LONG canonico: PASS (Leva 25x, Barriera 96.00)');

// 3.2 Short setup canonico
const guardShort = calculateKnockOutBarrierGuard(quoteAuth, 'SHORT');
// Short: B_rec = T * (1 + 1/25) = 100 * 1.04 = 104.00
if (guardShort.safeBarrierLevel !== 104.0) {
  throw new Error(`3.2 Attesa barriera SHORT 104.00, ottenuta: ${guardShort.safeBarrierLevel}`);
}
console.log('3.2 Guard V112 SHORT canonico: PASS (Leva 25x, Barriera 104.00)');

const setupCustomR = buildExecutionSetup(
  { quote: quoteAuth, score: { total: 80 } as any, rank: 1 },
  { decisione: 'TRADE', direzione: 'LONG', catalizzatore: '', punti_a_favore: [], rischi: [], condizioni_invalidazione: [], fonti: [] },
  'EU',
  { ...DEFAULT_SYSTEM_PARAMETERS, target1Multiplier: 1.35, target2Multiplier: 3.0 },
  { currentTime: new Date('2026-10-26T09:50:00+01:00') }
);
if (setupCustomR.barrierRecommended == null || setupCustomR.selectedLeverage == null) {
  throw new Error('3.5 Setup R configurabile deve fornire barriera e leva per il test');
}
const customRSafety = calculateKnockOutSafety(setupCustomR, {
  barrierStrike: setupCustomR.barrierRecommended,
  leverage: setupCustomR.selectedLeverage,
  certificatePrice: 2.5,
  accountCapital: 10000,
  maxRiskPercent: 1,
});
if (Math.abs(customRSafety.potentialGainT2Eur - customRSafety.potentialLossEur * 3.0) > 0.02) {
  throw new Error(`3.5 Guadagno T2 deve essere coerente con 3R: loss=${customRSafety.potentialLossEur}, gain=${customRSafety.potentialGainT2Eur}`);
}
const customRScenarios = generatePnLScenarios(
  setupCustomR,
  { barrierStrike: setupCustomR.barrierRecommended, leverage: setupCustomR.selectedLeverage, certificatePrice: 2.5, accountCapital: 10000, maxRiskPercent: 1 },
  2.5,
  customRSafety.suggestedCertificates,
  customRSafety.totalInvestedEur,
  0,
  0,
  customRSafety.stopDistance,
  customRSafety.potentialLossEur
);
if (customRScenarios.find((scenario) => scenario.id === 't1')?.rMultiple !== 1.35 || customRScenarios.find((scenario) => scenario.id === 't2')?.rMultiple !== 3.0) {
  throw new Error('3.5 Scenari T1/T2 devono esporre rMultiple 1.35 e 3.0');
}
console.log('3.5 R target configurabili coerenti in guadagni e scenari: PASS');

// 3.3 Setup privo di leva compatibile (L_sel < 1, ad es. stop distance = 50%)
const quoteWideStop: RawQuoteData = {
  ...quoteAuth,
  T: 100,
  S: 50, // dS = 50% -> 1 / (0.50 + 0.001) = 1.99 < LEVE min (5)
};
const guardWide = calculateKnockOutBarrierGuard(quoteWideStop, 'LONG');
if (guardWide.safeBarrierLevel !== null || guardWide.maxRecommendedLeverage !== null || guardWide.isExecutableSetup !== false) {
  throw new Error('3.3 Setup senza leva compatibile deve restituire barriera e leva null, non inventate');
}
console.log('3.3 Setup privo di leva compatibile (L_sel < 1): PASS (restituisce null e non raccomanda barriera)');

// 3.4 Pre-ORB (T ed S null): barriera eseguibile non disponibile
const quotePreOrb: RawQuoteData = {
  ...quoteAuth,
  T: null,
  S: null,
};
const guardPreOrb = calculateKnockOutBarrierGuard(quotePreOrb, 'LONG');
if (guardPreOrb.safeBarrierLevel !== null || guardPreOrb.maxRecommendedLeverage !== null || guardPreOrb.isExecutableSetup !== false) {
  throw new Error('3.4 Pre-ORB senza T/S non deve inventare una barriera eseguibile');
}
console.log('3.4 Pre-ORB senza T/S: PASS (distanza ATR informativa, barriera eseguibile null)');

// -----------------------------------------------------------------------------
// PUNTO 12: NEUTRALIZZAZIONE BONUS NEWS INGANNEVOLI
// -----------------------------------------------------------------------------
console.log('\n--- PUNTO 12: Neutralizzazione bonus keyword news ---');

// 12.1 Parole chiave isolate ("earnings", "utili", "target", "guidance", "upgrade", "contratto") senza bonus esplicito
const scoreKeywordUpgrade = calculateCandidateScore(
  quoteAuth,
  0.5,
  {
    decisione: 'TRADE',
    direzione: 'LONG',
    catalizzatore: 'Forte upgrade a Buy con nuovo target price ambizioso e nuovo contratto industriale',
    punti_a_favore: ['Guidance rialzata'],
    rischi: [],
    condizioni_invalidazione: [],
    fonti: [{ title: 'Broker note' }],
  } as any
);
if (scoreKeywordUpgrade.newsScore !== 0) {
  throw new Error(`12.1 Parole chiave come upgrade/contratto/target devono dare newsScore 0, ottenuto: ${scoreKeywordUpgrade.newsScore}`);
}
console.log('12.1 Parole chiave isolate ("upgrade", "contratto", "target"): PASS (newsScore 0pt)');

// 12.2 Titolo positivo vs titolo negativo con identiche parole chiave -> entrambi 0pt
const scorePos = calculateCandidateScore(quoteAuth, 0.5, {
  decisione: 'TRADE',
  direzione: 'LONG',
  catalizzatore: 'Guidance e target annuale confermati positivi',
  punti_a_favore: [],
  rischi: [],
  condizioni_invalidazione: [],
  fonti: [],
} as any);

const scoreNeg = calculateCandidateScore(quoteAuth, 0.5, {
  decisione: 'NESSUN_TRADE',
  direzione: 'SHORT',
  catalizzatore: 'Guidance e target annuale tagliati drasticamente',
  punti_a_favore: [],
  rischi: [],
  condizioni_invalidazione: [],
  fonti: [],
} as any);

if (scorePos.newsScore !== 0 || scoreNeg.newsScore !== 0) {
  throw new Error(`12.2 Titolo positivo e negativo con parole chiave devono entrambi avere newsScore 0. Ottenuto: ${scorePos.newsScore}, ${scoreNeg.newsScore}`);
}
console.log('12.2 Titolo positivo e negativo con stesse keyword: PASS (entrambi 0pt)');

// 12.3 Notizie recenti ma senza riscontro direzionale (array di NewsItem) -> 0pt
const scoreNewsArray = calculateCandidateScore(quoteAuth, 0.5, [
  { id: '1', title: 'Upgrade a Buy, nuovo target e contratto', summary: '', source: 'Reuters', url: '', publishedAt: new Date().toISOString() },
] as any);
if (scoreNewsArray.newsScore !== 0) {
  throw new Error(`12.3 Array NewsItem con keyword upgrade/target/contratto deve dare newsScore 0, ottenuto: ${scoreNewsArray.newsScore}`);
}
console.log('12.3 Array NewsItem con keyword upgrade/target/contratto: PASS (newsScore 0)');

// 12.4 Assenza notizie -> 0pt
const scoreNoNews = calculateCandidateScore(quoteAuth, 0.5, null);
if (scoreNoNews.newsScore !== 0) {
  throw new Error(`12.4 Assenza notizie deve dare newsScore 0, ottenuto: ${scoreNoNews.newsScore}`);
}
console.log('12.4 Assenza di notizie: PASS (0pt)');

// 12.5 Bonus numerico esplicito valido
const scoreExplicitValid = calculateCandidateScore(quoteAuth, 0.5, 10);
if (scoreExplicitValid.newsScore !== 10) {
  throw new Error(`12.5 Punteggio numerico esplicito 10 deve assegnare 10, ottenuto: ${scoreExplicitValid.newsScore}`);
}
const scoreObjectValid = calculateCandidateScore(quoteAuth, 0.5, {
  decisione: 'TRADE',
  direzione: 'LONG',
  catalizzatore: 'Validato con catalizzatore quantitativo',
  punti_a_favore: [],
  rischi: [],
  condizioni_invalidazione: [],
  fonti: [],
  newsBonusScore: 12,
} as any);
if (scoreObjectValid.newsScore !== 12) {
  throw new Error(`12.5 newsBonusScore esplicito 12 deve assegnare 12, ottenuto: ${scoreObjectValid.newsScore}`);
}
console.log('12.5 Punteggio esplicito validato: PASS (10pt e 12pt)');

// 12.6 Punteggio numerico esplicito fuori scala (vincolo 0..15)
const scoreTooHigh = calculateCandidateScore(quoteAuth, 0.5, 99);
if (scoreTooHigh.newsScore !== 15) {
  throw new Error(`12.6 Bonus 99 deve essere vincolato a 15, ottenuto: ${scoreTooHigh.newsScore}`);
}
const scoreTooLow = calculateCandidateScore(quoteAuth, 0.5, -20);
if (scoreTooLow.newsScore !== 0) {
  throw new Error(`12.6 Bonus -20 deve essere vincolato a 0, ottenuto: ${scoreTooLow.newsScore}`);
}
console.log('12.6 Punteggio numerico fuori scala clippato a [0, 15]: PASS');

console.log('\n================================================================');
console.log('=== TUTTI I TEST DELLO SPRINT 1 HANNO AVUTO ESITO POSITIVO! ===');
console.log('================================================================');
