import {
  calculateCandidateScore,
  buildExecutionSetup,
  filterCompletedBars,
  calculateAtr14FromBars,
  calculateAdr14FromBars,
  calculateLiqEurFromBars,
  calculateOrbFromIntradayBars,
  calculateOrbRvolFromBars,
  calculateManualFreezeLevels,
  validateBarrierSafety,
  createJournalEntryFromSetup,
  isCandidateCompliantWithParameters,
  DEFAULT_SYSTEM_PARAMETERS,
  evaluateSessionOptimization,
  evaluateDualSystemOptimization,
  DailyBarInput,
  IntradayCandleInput,
} from '../calculator';
import { getUsOrbCloseTimeInfo, getMarketTime } from '../timezone';
import { getHeroMinScore } from '../../components/DualExecutionHero';
import { TRADING_PARAMS } from '../../config/tradingParams';
import { RawQuoteData, ScoredCandidate, EntryMode, TradeJournalEntry } from '../../types/radar';

/**
 * FIXTURE BASE LONG EU (Specifica Fase D)
 * now = 2026-10-26 09:40 Europe/Rome (2026-10-26T08:40:00.000Z, CET = UTC+1)
 * T = 100.00; E = 100.00; S = 99.60 (dS 0.40%)
 * Tb = 09:30 Rome (2026-10-26T08:30:00.000Z)
 * P_t = 100.10; H_sess = 100.10; L_sess = 99.90
 * ADR14 = 10.00; ATR14 = 1.30; C_ieri = 99.00; Liq€ = 5,000,000; volume = 250,000
 * Campi non di gate per punteggio senza liquidità >= MIN_SCORE_EU:
 *   todayOpen = 100.00, gapPercent = 1.01 (ratio ~0.77 -> gapScore 25)
 *   rvol = 1.50 (-> rvolScore 20)
 *   futuresChange = +0.30% (-> futuresScore 20)
 *   prevHigh = 99.50, prevLow = 98.00 (-> levelScore 10)
 *   rsi5m = 55 (-> rsiScore 10)
 *   ema20Daily = 98.00 (-> trendScore 8)
 *   Totale senza liquidità = 93
 */
export const BASE_NOW_ROME = new Date('2026-10-26T09:40:00+01:00');
export const BASE_FUTURES_CHANGE = 0.30;

export function createBaseFixtureQuote(overrides: Partial<RawQuoteData> = {}): RawQuoteData {
  const base: RawQuoteData = {
    ticker: 'TEST.MI',
    name: 'Test Long EU S.p.A.',
    market: 'EU',
    currency: 'EUR',
    prevClose: 99.00,
    currentPrice: 100.10,
    preMarketPrice: 100.00,
    prevHigh: 99.50,
    prevLow: 98.00,
    preMarketHigh: 100.00,
    preMarketLow: 99.50,
    todayOpen: 100.00,
    todayHigh: 100.10,
    todayLow: 99.90,
    vwap: 100.00,
    ema20Daily: 98.00,
    avgVolume20d: 250_000,
    preMarketVolume: 50_000,
    atr14: 1.30,
    adr14: 10.00,
    liqEur20d: 5_000_000,
    completedBarsCount: 20,
    orbHigh: 100.00,
    orbLow: 99.799599,
    T: 100.00,
    E: 100.00,
    S: 99.60,
    orbBreakoutTime: new Date('2026-10-26T09:30:00+01:00').toISOString(),
    gapPercent: 1.01,
    rvol: 1.50,
    rvol20m: 1.20,
    rsi14: 55,
    rsi5m: 55,
    orderFlow: null,
    timestamp: BASE_NOW_ROME.toISOString(),
    source: 'Fixture Fase D',
  };
  return { ...base, ...overrides };
}

export function buildCandidateFromQuote(
  quote: RawQuoteData,
  futuresChange: number | null | undefined = BASE_FUTURES_CHANGE,
  newsBonus: number | null = null
): ScoredCandidate {
  const score = calculateCandidateScore(quote, futuresChange, newsBonus);
  return {
    quote,
    score,
    rank: 1,
  };
}

interface TestRecord {
  id: string;
  description: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  passed: boolean;
}

const results: TestRecord[] = [];

function recordTest(
  id: string,
  description: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  passed: boolean
) {
  results.push({ id, description, input, expected, actual, passed });
  const status = passed ? 'PASS' : 'FAIL';
  console.log(`[${id}] ${status} | ${description}`);
  console.log(`  INPUT:    ${JSON.stringify(input)}`);
  console.log(`  EXPECTED: ${JSON.stringify(expected)}`);
  console.log(`  ACTUAL:   ${JSON.stringify(actual)}`);
}

function runAllTests() {
  console.log('================================================================');
  console.log('ESECUZIONE SUITE TEST FASE D (T01–T50)');
  console.log('================================================================');
  console.log('FIXTURE BASE JSON:');
  console.log(JSON.stringify(createBaseFixtureQuote(), null, 2));
  console.log('----------------------------------------------------------------');

  // T01 | P_t = 100.30, H_sess = 100.30 | G4 passa, setup generato
  {
    const q = createBaseFixtureQuote({ currentPrice: 100.30, todayHigh: 100.30 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g4 = setup.gateResults?.['G4'];
    const passed = g4?.passed === true && setup.decision === 'TRADE' && setup.extensionPct === 0.3;
    recordTest(
      'T01',
      'P_t = 100.30, H_sess = 100.30 -> G4 passa, setup generato',
      { P_t: q.currentPrice, H_sess: q.todayHigh, T: q.T },
      { g4Pass: true, decision: 'TRADE', extensionPct: 0.3 },
      { g4Pass: g4?.passed, decision: setup.decision, extensionPct: setup.extensionPct },
      passed
    );
  }

  // T02 | P_t = 100.50, H_sess = 100.50 | G4 TRIGGER GIÀ SUPERATO
  {
    const q = createBaseFixtureQuote({ currentPrice: 100.50, todayHigh: 100.50 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g4 = setup.gateResults?.['G4'];
    const passed =
      g4?.passed === false &&
      g4?.message === 'TRIGGER GIÀ SUPERATO' &&
      setup.decision === 'NESSUN_TRADE' &&
      setup.reasonNoTrade === 'TRIGGER GIÀ SUPERATO';
    recordTest(
      'T02',
      'P_t = 100.50, H_sess = 100.50 -> G4 TRIGGER GIÀ SUPERATO',
      { P_t: q.currentPrice, H_sess: q.todayHigh, T: q.T },
      { g4Pass: false, message: 'TRIGGER GIÀ SUPERATO', decision: 'NESSUN_TRADE' },
      { g4Pass: g4?.passed, message: g4?.message, decision: setup.decision },
      passed
    );
  }

  // T03 | now = 11:30 | G5 TRIGGER SCADUTO
  {
    const now1130 = new Date('2026-10-26T11:30:00+01:00');
    const q = createBaseFixtureQuote();
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: now1130 });
    const g5 = setup.gateResults?.['G5'];
    const passed =
      g5?.passed === false &&
      g5?.message === 'TRIGGER SCADUTO' &&
      setup.decision === 'NESSUN_TRADE' &&
      setup.blockedGate === 'G5';
    recordTest(
      'T03',
      'now = 11:30 Rome (120 min da Tb 09:30) -> G5 TRIGGER SCADUTO',
      { now: '11:30 Rome', Tb: '09:30 Rome', elapsedMin: 120 },
      { g5Pass: false, message: 'TRIGGER SCADUTO', blockedGate: 'G5' },
      { g5Pass: g5?.passed, message: g5?.message, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T04 | now = 10:30 (60 min) | G5 passa
  {
    const now1030 = new Date('2026-10-26T10:30:00+01:00');
    const q = createBaseFixtureQuote();
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: now1030 });
    const g5 = setup.gateResults?.['G5'];
    const passed = g5?.passed === true && setup.decision === 'TRADE';
    recordTest(
      'T04',
      'now = 10:30 Rome (esattamente 60 min da Tb 09:30) -> G5 passa',
      { now: '10:30 Rome', Tb: '09:30 Rome', elapsedMin: 60 },
      { g5Pass: true, decision: 'TRADE' },
      { g5Pass: g5?.passed, decision: setup.decision },
      passed
    );
  }

  // T05 | now = 10:31 (61 min) | G5 TRIGGER SCADUTO
  {
    const now1031 = new Date('2026-10-26T10:31:00+01:00');
    const q = createBaseFixtureQuote();
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: now1031 });
    const g5 = setup.gateResults?.['G5'];
    const passed =
      g5?.passed === false &&
      g5?.message === 'TRIGGER SCADUTO' &&
      setup.decision === 'NESSUN_TRADE' &&
      setup.blockedGate === 'G5';
    recordTest(
      'T05',
      'now = 10:31 Rome (61 min da Tb 09:30) -> G5 TRIGGER SCADUTO',
      { now: '10:31 Rome', Tb: '09:30 Rome', elapsedMin: 61 },
      { g5Pass: false, message: 'TRIGGER SCADUTO', blockedGate: 'G5' },
      { g5Pass: g5?.passed, message: g5?.message, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T06 | H_sess = 100.64 (uguale a T1) | G6 T1 RAGGIUNTO
  {
    const q = createBaseFixtureQuote({ todayHigh: 100.64 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g6 = setup.gateResults?.['G6'];
    const passed =
      setup.target1Level === 100.64 &&
      g6?.passed === false &&
      g6?.message === 'T1 RAGGIUNTO' &&
      setup.blockedGate === 'G6';
    recordTest(
      'T06',
      'H_sess = 100.64 (uguale a T1) -> G6 T1 RAGGIUNTO',
      { H_sess: q.todayHigh, T1: setup.target1Level },
      { g6Pass: false, message: 'T1 RAGGIUNTO', blockedGate: 'G6' },
      { g6Pass: g6?.passed, message: g6?.message, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T07 | H_sess = 100.63 | G6 passa
  {
    const q = createBaseFixtureQuote({ todayHigh: 100.63 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g6 = setup.gateResults?.['G6'];
    const passed = setup.target1Level === 100.64 && g6?.passed === true && setup.decision === 'TRADE';
    recordTest(
      'T07',
      'H_sess = 100.63 (< T1 100.64) -> G6 passa',
      { H_sess: q.todayHigh, T1: setup.target1Level },
      { g6Pass: true, decision: 'TRADE' },
      { g6Pass: g6?.passed, decision: setup.decision },
      passed
    );
  }

  // T08 | H_sess = 100.10, L_sess = 94.20 (range 5.90 = 59%) | G7 passa
  {
    const q = createBaseFixtureQuote({ todayHigh: 100.10, todayLow: 94.20 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g7 = setup.gateResults?.['G7'];
    const passed = g7?.passed === true && setup.adrConsumptionPct === 59 && setup.decision === 'TRADE';
    recordTest(
      'T08',
      'H_sess = 100.10, L_sess = 94.20 (range 5.90 = 59%) -> G7 passa',
      { H_sess: q.todayHigh, L_sess: q.todayLow, adr14: q.adr14 },
      { g7Pass: true, adrConsumptionPct: 59, decision: 'TRADE' },
      { g7Pass: g7?.passed, adrConsumptionPct: setup.adrConsumptionPct, decision: setup.decision },
      passed
    );
  }

  // T09 | H_sess = 100.10, L_sess = 94.00 (range 6.10 = 61%) | G7 RANGE ESAURITO
  {
    const q = createBaseFixtureQuote({ todayHigh: 100.10, todayLow: 94.00 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g7 = setup.gateResults?.['G7'];
    const passed =
      g7?.passed === false &&
      g7?.message === 'RANGE ESAURITO' &&
      setup.adrConsumptionPct === 61 &&
      setup.blockedGate === 'G7';
    recordTest(
      'T09',
      'H_sess = 100.10, L_sess = 94.00 (range 6.10 = 61%) -> G7 RANGE ESAURITO',
      { H_sess: q.todayHigh, L_sess: q.todayLow, adr14: q.adr14 },
      { g7Pass: false, message: 'RANGE ESAURITO', adrConsumptionPct: 61, blockedGate: 'G7' },
      { g7Pass: g7?.passed, message: g7?.message, adrConsumptionPct: setup.adrConsumptionPct, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T10 | ATR14 = null | G2 DATI INSUFFICIENTI
  {
    const q = createBaseFixtureQuote({ atr14: null });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g2 = setup.gateResults?.['G2'];
    const passed =
      g2?.passed === false &&
      g2?.message === 'DATI INSUFFICIENTI' &&
      setup.blockedGate === 'G2' &&
      cand.score.gapScore === 0;
    recordTest(
      'T10',
      'ATR14 = null -> G2 DATI INSUFFICIENTI (e gapScore = 0)',
      { atr14: q.atr14 },
      { g2Pass: false, message: 'DATI INSUFFICIENTI', blockedGate: 'G2', gapScore: 0 },
      { g2Pass: g2?.passed, message: g2?.message, blockedGate: setup.blockedGate, gapScore: cand.score.gapScore },
      passed
    );
  }

  // T11 | ADR14 = null | G2 DATI INSUFFICIENTI
  {
    const q = createBaseFixtureQuote({ adr14: null });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g2 = setup.gateResults?.['G2'];
    const passed =
      g2?.passed === false &&
      g2?.message === 'DATI INSUFFICIENTI' &&
      setup.blockedGate === 'G2' &&
      setup.adrInfo === null;
    recordTest(
      'T11',
      'ADR14 = null -> G2 DATI INSUFFICIENTI (e adrInfo = null)',
      { adr14: q.adr14 },
      { g2Pass: false, message: 'DATI INSUFFICIENTI', blockedGate: 'G2', adrInfo: null },
      { g2Pass: g2?.passed, message: g2?.message, blockedGate: setup.blockedGate, adrInfo: setup.adrInfo },
      passed
    );
  }

  // T12 | C_ieri = null | G2 DATI INSUFFICIENTI
  {
    const q = createBaseFixtureQuote({ prevClose: null });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g2 = setup.gateResults?.['G2'];
    const passed =
      g2?.passed === false && g2?.message === 'DATI INSUFFICIENTI' && setup.blockedGate === 'G2';
    recordTest(
      'T12',
      'C_ieri = null -> G2 DATI INSUFFICIENTI',
      { prevClose: q.prevClose },
      { g2Pass: false, message: 'DATI INSUFFICIENTI', blockedGate: 'G2' },
      { g2Pass: g2?.passed, message: g2?.message, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T13 | barre complete per volume = 19 | G2 DATI INSUFFICIENTI, non G1
  {
    const bars19: DailyBarInput[] = Array.from({ length: 19 }, (_, idx) => ({
      date: `2026-10-${String(idx + 1).padStart(2, '0')}`,
      high: 102,
      low: 98,
      close: 100,
      volume: 100_000,
    }));
    const computedLiq = calculateLiqEurFromBars(bars19, 1.0);
    const q = createBaseFixtureQuote({
      completedBarsCount: bars19.length,
      liqEur20d: computedLiq,
    });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g1 = setup.gateResults?.['G1'];
    const g2 = setup.gateResults?.['G2'];
    const passed =
      computedLiq === null &&
      g1?.passed === true &&
      g2?.passed === false &&
      g2?.message === 'DATI INSUFFICIENTI' &&
      setup.blockedGate === 'G2';
    recordTest(
      'T13',
      'barre complete per volume = 19 -> G2 DATI INSUFFICIENTI, non G1',
      { completedBarsCount: bars19.length, computedLiqEur: computedLiq },
      { g1Pass: true, g2Pass: false, blockedGate: 'G2', message: 'DATI INSUFFICIENTI' },
      { g1Pass: g1?.passed, g2Pass: g2?.passed, blockedGate: setup.blockedGate, message: setup.reasonNoTrade },
      passed
    );
  }

  // T14 | ORB assente | G2 DATI INSUFFICIENTI
  {
    const q = createBaseFixtureQuote({ orbHigh: null, orbLow: null });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g2 = setup.gateResults?.['G2'];
    const passed =
      g2?.passed === false && g2?.message === 'DATI INSUFFICIENTI' && setup.blockedGate === 'G2';
    recordTest(
      'T14',
      'ORB assente (orbHigh = null, orbLow = null) -> G2 DATI INSUFFICIENTI',
      { orbHigh: q.orbHigh, orbLow: q.orbLow },
      { g2Pass: false, message: 'DATI INSUFFICIENTI', blockedGate: 'G2' },
      { g2Pass: g2?.passed, message: g2?.message, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T15 | Liq€ = 2,900,000 | G1 LIQUIDITÀ INSUFFICIENTE
  {
    const q = createBaseFixtureQuote({ liqEur20d: 2_900_000 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g1 = setup.gateResults?.['G1'];
    const passed =
      g1?.passed === false &&
      g1?.message === 'LIQUIDITÀ INSUFFICIENTE' &&
      setup.blockedGate === 'G1';
    recordTest(
      'T15',
      'Liq€ = 2,900,000 -> G1 LIQUIDITÀ INSUFFICIENTE',
      { liqEur20d: q.liqEur20d },
      { g1Pass: false, message: 'LIQUIDITÀ INSUFFICIENTE', blockedGate: 'G1' },
      { g1Pass: g1?.passed, message: g1?.message, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T16 | Liq€ = 3,100,000 | G1 passa
  {
    const q = createBaseFixtureQuote({ liqEur20d: 3_100_000 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g1 = setup.gateResults?.['G1'];
    const passed = g1?.passed === true && setup.decision === 'TRADE';
    recordTest(
      'T16',
      'Liq€ = 3,100,000 -> G1 passa',
      { liqEur20d: q.liqEur20d },
      { g1Pass: true, decision: 'TRADE' },
      { g1Pass: g1?.passed, decision: setup.decision },
      passed
    );
  }

  // T17 | S = 98.80 (dS 1.20%) | G8 STOP TROPPO LONTANO
  {
    const q = createBaseFixtureQuote({ S: 98.80 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g8 = setup.gateResults?.['G8'];
    const passed =
      setup.stopDistancePct === 1.2 &&
      g8?.passed === false &&
      g8?.message === 'STOP TROPPO LONTANO' &&
      setup.blockedGate === 'G8';
    recordTest(
      'T17',
      'S = 98.80 (dS 1.20%) -> G8 STOP TROPPO LONTANO',
      { S: q.S, E: q.E },
      { dS_pct: 1.2, g8Pass: false, message: 'STOP TROPPO LONTANO', blockedGate: 'G8' },
      { dS_pct: setup.stopDistancePct, g8Pass: g8?.passed, message: g8?.message, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T18 | S = 99.00 (dS 1.00%) | passa; L_sel 10; perdita 10.00%; barriera 90.00
  {
    const q = createBaseFixtureQuote({ S: 99.00 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const passed =
      setup.decision === 'TRADE' &&
      setup.stopDistancePct === 1 &&
      setup.selectedLeverage === 10 &&
      setup.estimatedStopLossPct === 10 &&
      setup.barrierRecommended === 90.0;
    recordTest(
      'T18',
      'S = 99.00 (dS 1.00%) -> passa; L_sel 10; perdita 10.00%; barriera 90.00',
      { S: q.S, E: q.E },
      { decision: 'TRADE', L_sel: 10, perditaPct: 10, barrierRecommended: 90 },
      {
        decision: setup.decision,
        L_sel: setup.selectedLeverage,
        perditaPct: setup.estimatedStopLossPct,
        barrierRecommended: setup.barrierRecommended,
      },
      passed
    );
  }

  // T19 | S = 98.90 (dS 1.10%) | G8 STOP TROPPO LONTANO
  {
    const q = createBaseFixtureQuote({ S: 98.90 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g8 = setup.gateResults?.['G8'];
    const passed =
      setup.stopDistancePct === 1.1 &&
      g8?.passed === false &&
      g8?.message === 'STOP TROPPO LONTANO' &&
      setup.blockedGate === 'G8';
    recordTest(
      'T19',
      'S = 98.90 (dS 1.10%) -> G8 STOP TROPPO LONTANO',
      { S: q.S, E: q.E },
      { dS_pct: 1.1, g8Pass: false, message: 'STOP TROPPO LONTANO', blockedGate: 'G8' },
      { dS_pct: setup.stopDistancePct, g8Pass: g8?.passed, message: g8?.message, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T20 | S = 99.60 (dS 0.40%) | L_sel 25; perdita 10.00%; barriera 96.00; leva prudente 10 con barriera 90.00
  {
    const q = createBaseFixtureQuote({ S: 99.60 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const passed =
      setup.decision === 'TRADE' &&
      setup.selectedLeverage === 25 &&
      setup.estimatedStopLossPct === 10 &&
      setup.barrierRecommended === 96.0 &&
      setup.prudentLeverage === 10 &&
      setup.prudentBarrier === 90.0;
    recordTest(
      'T20',
      'S = 99.60 (dS 0.40%) -> L_sel 25; perdita 10.00%; barriera 96.00; leva prudente 10 con barriera 90.00',
      { S: q.S, E: q.E },
      { L_sel: 25, perditaPct: 10, barrierRecommended: 96, prudentLeverage: 10, prudentBarrier: 90 },
      {
        L_sel: setup.selectedLeverage,
        perditaPct: setup.estimatedStopLossPct,
        barrierRecommended: setup.barrierRecommended,
        prudentLeverage: setup.prudentLeverage,
        prudentBarrier: setup.prudentBarrier,
      },
      passed
    );
  }

  // T21 | S = 99.50 (dS 0.50%) | L_sel 20; perdita 10.00%; barriera 95.00
  {
    const q = createBaseFixtureQuote({ S: 99.50 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const passed =
      setup.decision === 'TRADE' &&
      setup.selectedLeverage === 20 &&
      setup.estimatedStopLossPct === 10 &&
      setup.barrierRecommended === 95.0;
    recordTest(
      'T21',
      'S = 99.50 (dS 0.50%) -> L_sel 20; perdita 10.00%; barriera 95.00',
      { S: q.S, E: q.E },
      { L_sel: 20, perditaPct: 10, barrierRecommended: 95 },
      {
        L_sel: setup.selectedLeverage,
        perditaPct: setup.estimatedStopLossPct,
        barrierRecommended: setup.barrierRecommended,
      },
      passed
    );
  }

  // T22 | S = 99.40 (dS 0.60%) | L_sel 15; perdita 9.00%; barriera 93.33
  {
    const q = createBaseFixtureQuote({ S: 99.40 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const passed =
      setup.decision === 'TRADE' &&
      setup.selectedLeverage === 15 &&
      setup.estimatedStopLossPct === 9 &&
      setup.barrierRecommended === 93.33;
    recordTest(
      'T22',
      'S = 99.40 (dS 0.60%) -> L_sel 15; perdita 9.00%; barriera 93.33',
      { S: q.S, E: q.E },
      { L_sel: 15, perditaPct: 9, barrierRecommended: 93.33 },
      {
        L_sel: setup.selectedLeverage,
        perditaPct: setup.estimatedStopLossPct,
        barrierRecommended: setup.barrierRecommended,
      },
      passed
    );
  }

  // T23 | LEVE forzato a [25], S = 99.50 | LEVA NON COMPATIBILE (test di ramo, dichiarato)
  {
    const q = createBaseFixtureQuote({ S: 99.50 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, {
      currentTime: BASE_NOW_ROME,
      customLeve: [25],
    });
    const g9 = setup.gateResults?.['G9'];
    const passed =
      g9?.passed === false &&
      g9?.message === 'LEVA NON COMPATIBILE' &&
      setup.blockedGate === 'G9';
    recordTest(
      'T23',
      'LEVE forzato a [25], S = 99.50 (test di ramo dichiarato) -> G9 LEVA NON COMPATIBILE',
      { S: q.S, customLeve: [25] },
      { g9Pass: false, message: 'LEVA NON COMPATIBILE', blockedGate: 'G9' },
      { g9Pass: g9?.passed, message: g9?.message, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T24 | verifica barriera KO con validateBarrierSafety (S = 99.50, E = 100.00, BUF_BAR = 0.001) nei tre rami della specifica
  {
    // Ramo 1: B = 99.45 -> distanza 0.05 < 0.10 -> BARRIERA NON VALIDA
    const check1 = validateBarrierSafety('LONG', 100.00, 99.50, 99.45, TRADING_PARAMS.BUF_BAR);
    // Ramo 2: B = 99.35 -> distanza 0.15 >= 0.10 -> valida
    const check2 = validateBarrierSafety('LONG', 100.00, 99.50, 99.35, TRADING_PARAMS.BUF_BAR);
    // Ramo 3: B = 99.55 -> barriera sopra stop loss (S - B = -0.05 < 0) -> BARRIERA NON VALIDA
    const check3 = validateBarrierSafety('LONG', 100.00, 99.50, 99.55, TRADING_PARAMS.BUF_BAR);

    const passed =
      check1.valid === false &&
      check1.message === 'BARRIERA NON VALIDA' &&
      check2.valid === true &&
      check3.valid === false &&
      check3.message === 'BARRIERA NON VALIDA';

    recordTest(
      'T24',
      'validateBarrierSafety diretta (E=100, S=99.50) nei tre rami: B=99.45 (dist 0.05<0.10 -> non valida), B=99.35 (dist 0.15>=0.10 -> valida), B=99.55 (lato errato -> non valida)',
      { E: 100.00, S: 99.50, bufBar: TRADING_PARAMS.BUF_BAR, B_cases: [99.45, 99.35, 99.55] },
      {
        b9945: { valid: false, message: 'BARRIERA NON VALIDA' },
        b9935: { valid: true },
        b9955: { valid: false, message: 'BARRIERA NON VALIDA' },
      },
      {
        b9945: { valid: check1.valid, message: check1.message },
        b9935: { valid: check2.valid },
        b9955: { valid: check3.valid, message: check3.message },
      },
      passed
    );
  }

  // T25 | P_t = 99.60 (uguale a S) | G10 STOP GIÀ RAGGIUNTO
  {
    const q = createBaseFixtureQuote({ currentPrice: 99.60 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g10 = setup.gateResults?.['G10'];
    const passed =
      g10?.passed === false &&
      g10?.message === 'STOP GIÀ RAGGIUNTO' &&
      setup.blockedGate === 'G10';
    recordTest(
      'T25',
      'P_t = 99.60 (uguale a S) -> G10 STOP GIÀ RAGGIUNTO',
      { P_t: q.currentPrice, S: q.S },
      { g10Pass: false, message: 'STOP GIÀ RAGGIUNTO', blockedGate: 'G10' },
      { g10Pass: g10?.passed, message: g10?.message, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T26 | P_t = 99.61 | G10 passa
  {
    const q = createBaseFixtureQuote({ currentPrice: 99.61 });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g10 = setup.gateResults?.['G10'];
    const passed = g10?.passed === true && setup.decision === 'TRADE';
    recordTest(
      'T26',
      'P_t = 99.61 (> S 99.60) -> G10 passa',
      { P_t: q.currentPrice, S: q.S },
      { g10Pass: true, decision: 'TRADE' },
      { g10Pass: g10?.passed, decision: setup.decision },
      passed
    );
  }

  // T27 | score senza liquidità = 47 | G11 PUNTEGGIO SOTTO SOGLIA
  {
    // Componenti reali: gap=20 (ratio 0.60), rvol=14 (1.20), fut=4 (-0.30%), lvl=7 (100.10 >= 100.20*0.995), rsi=0, news=0, trend=2 (sotto ema20), of=0 -> Totale = 47
    const q47 = createBaseFixtureQuote({
      prevClose: 100.00,
      todayOpen: 100.60,
      gapPercent: 0.60,
      atr14: 1.00,
      rvol: 1.20,
      rvol20m: null,
      prevHigh: 100.20,
      prevLow: 99.00,
      rsi5m: null,
      rsi14: null,
      ema20Daily: 101.00,
      orderFlow: null,
    });
    const cand47 = buildCandidateFromQuote(q47, -0.30, null);
    const setup = buildExecutionSetup(cand47, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g11 = setup.gateResults?.['G11'];
    const targetScore = TRADING_PARAMS.MIN_SCORE_EU - 1;
    const passed =
      cand47.score.total === targetScore &&
      g11?.passed === false &&
      g11?.message === 'PUNTEGGIO SOTTO SOGLIA' &&
      setup.blockedGate === 'G11';
    recordTest(
      'T27',
      'score senza liquidità = 47 -> G11 PUNTEGGIO SOTTO SOGLIA',
      { calculatedScore: cand47.score.total, minScoreEU: TRADING_PARAMS.MIN_SCORE_EU },
      { score: targetScore, g11Pass: false, message: 'PUNTEGGIO SOTTO SOGLIA', blockedGate: 'G11' },
      { score: cand47.score.total, g11Pass: g11?.passed, message: g11?.message, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T28 | score senza liquidità = 48 | G11 passa
  {
    // Componenti reali: gap=20 (ratio 0.60), rvol=14 (1.20), fut=4 (-0.30%), lvl=10 (100.10 >= prevHigh 100.00), rsi=0, news=0, trend=0 (ema20 null), of=0 -> Totale = 48
    const q48 = createBaseFixtureQuote({
      prevClose: 100.00,
      todayOpen: 100.60,
      gapPercent: 0.60,
      atr14: 1.00,
      rvol: 1.20,
      rvol20m: null,
      prevHigh: 100.00,
      prevLow: 99.00,
      rsi5m: null,
      rsi14: null,
      ema20Daily: null,
      orderFlow: null,
    });
    const cand48 = buildCandidateFromQuote(q48, -0.30, null);
    const setup = buildExecutionSetup(cand48, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const g11 = setup.gateResults?.['G11'];
    const passed =
      cand48.score.total === TRADING_PARAMS.MIN_SCORE_EU &&
      g11?.passed === true &&
      setup.decision === 'TRADE';
    recordTest(
      'T28',
      'score senza liquidità = 48 -> G11 passa',
      { calculatedScore: cand48.score.total, minScoreEU: TRADING_PARAMS.MIN_SCORE_EU },
      { score: TRADING_PARAMS.MIN_SCORE_EU, g11Pass: true, decision: 'TRADE' },
      { score: cand48.score.total, g11Pass: g11?.passed, decision: setup.decision },
      passed
    );
  }

  // T29 | componenti 25, 25, 0, 20, 10, 10, 15, 8, 10 | raw 123, liquidityScore 0, total 100 (cap invariato)
  {
    const qMax = createBaseFixtureQuote({
      prevClose: 100.00,
      todayOpen: 101.00,
      gapPercent: 1.00,
      atr14: 1.00,
      rvol: 2.50,
      prevHigh: 99.50,
      prevLow: 98.00,
      rsi5m: 55,
      ema20Daily: 98.00,
      orderFlow: {
        buyerVolumePercent: 65,
        sellerVolumePercent: 35,
        netDeltaPercent: 30,
        cvdTrend: 'EXPANDING_UP',
        vpocPrice: 99.80,
        isPriceAboveVpoc: true,
        flowQuality: 'INSTITUTIONAL_BUYING',
        summary: 'Institutional buying',
      },
    });
    const scoreMax = calculateCandidateScore(qMax, 0.50, 15);
    const passed =
      scoreMax.gapScore === 25 &&
      scoreMax.rvolScore === 25 &&
      scoreMax.liquidityScore === 0 &&
      scoreMax.futuresScore === 20 &&
      scoreMax.levelScore === 10 &&
      scoreMax.rsiScore === 10 &&
      scoreMax.newsScore === 15 &&
      scoreMax.trendScore === 8 &&
      scoreMax.orderFlowScore === 10 &&
      scoreMax.rawTotal === 123 &&
      scoreMax.total === 100;
    recordTest(
      'T29',
      'componenti 25, 25, 0, 20, 10, 10, 15, 8, 10 -> raw 123, liquidityScore 0, total 100',
      {
        components: [
          scoreMax.gapScore,
          scoreMax.rvolScore,
          scoreMax.liquidityScore,
          scoreMax.futuresScore,
          scoreMax.levelScore,
          scoreMax.rsiScore,
          scoreMax.newsScore,
          scoreMax.trendScore,
          scoreMax.orderFlowScore,
        ],
      },
      { rawTotal: 123, liquidityScore: 0, total: 100 },
      { rawTotal: scoreMax.rawTotal, liquidityScore: scoreMax.liquidityScore, total: scoreMax.total },
      passed
    );
  }

  // T30 | futures con variazione mancante | 0 punti futures
  {
    const q = createBaseFixtureQuote();
    const scoreMissingFut = calculateCandidateScore(q, null, null);
    const passed = scoreMissingFut.futuresScore === 0;
    recordTest(
      'T30',
      'futures con variazione mancante -> 0 punti futures',
      { benchmarkFuturesChangePercent: null },
      { futuresScore: 0 },
      { futuresScore: scoreMissingFut.futuresScore },
      passed
    );
  }

  // T31 | futures con variazione 0.10% | 12 punti futures
  {
    const q = createBaseFixtureQuote();
    const scoreNeutralFut = calculateCandidateScore(q, 0.10, null);
    const passed = scoreNeutralFut.futuresScore === 12;
    recordTest(
      'T31',
      'futures con variazione 0.10% (<= banda 0.15%) -> 12 punti futures',
      { benchmarkFuturesChangePercent: 0.10, neutralBand: TRADING_PARAMS.FUT_NEUTRAL_BAND },
      { futuresScore: 12 },
      { futuresScore: scoreNeutralFut.futuresScore },
      passed
    );
  }

  // T32 | ATR% 1.00, gap +0.75% | 25 punti gap
  {
    const q = createBaseFixtureQuote({
      prevClose: 100.00,
      atr14: 1.00,
      todayOpen: 100.75,
      gapPercent: 0.75,
    });
    const score = calculateCandidateScore(q, BASE_FUTURES_CHANGE, null);
    const passed = score.gapScore === 25;
    recordTest(
      'T32',
      'ATR% 1.00, gap +0.75% (ratio 0.75) -> 25 punti gap',
      { atrPct: 1.00, gapPercent: 0.75, ratio: 0.75 },
      { gapScore: 25 },
      { gapScore: score.gapScore },
      passed
    );
  }

  // T33 | ATR% 1.00, gap +0.149% | 2 punti gap
  {
    const q = createBaseFixtureQuote({
      prevClose: 100.00,
      atr14: 1.00,
      todayOpen: 100.149,
      gapPercent: 0.149,
    });
    const score = calculateCandidateScore(q, BASE_FUTURES_CHANGE, null);
    const passed = score.gapScore === 2;
    recordTest(
      'T33',
      'ATR% 1.00, gap +0.149% (ratio 0.149 < 0.15) -> 2 punti gap',
      { atrPct: 1.00, gapPercent: 0.149, ratio: 0.149 },
      { gapScore: 2 },
      { gapScore: score.gapScore },
      passed
    );
  }

  // T34 | now = 09:14:59 Rome | ATTENDERE CHIUSURA ORB
  {
    const now091459 = new Date('2026-10-26T09:14:59+01:00');
    const q = createBaseFixtureQuote();
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: now091459 });
    const g3 = setup.gateResults?.['G3'];
    const passed =
      g3?.passed === false &&
      g3?.message === 'ATTENDERE CHIUSURA ORB' &&
      setup.blockedGate === 'G3';
    recordTest(
      'T34',
      'now = 09:14:59 Rome -> G3 ATTENDERE CHIUSURA ORB',
      { now: getMarketTime('EU', now091459).timeFormatted },
      { g3Pass: false, message: 'ATTENDERE CHIUSURA ORB', blockedGate: 'G3' },
      { g3Pass: g3?.passed, message: g3?.message, blockedGate: setup.blockedGate },
      passed
    );
  }

  // T35 | now = 09:15:00 Rome | G3 passa
  {
    const now091500 = new Date('2026-10-26T09:15:00+01:00');
    const q = createBaseFixtureQuote({
      orbBreakoutTime: new Date('2026-10-26T09:15:00+01:00').toISOString(),
    });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: now091500 });
    const g3 = setup.gateResults?.['G3'];
    const passed = g3?.passed === true && setup.decision === 'TRADE';
    recordTest(
      'T35',
      'now = 09:15:00 Rome -> G3 passa',
      { now: getMarketTime('EU', now091500).timeFormatted },
      { g3Pass: true, decision: 'TRADE' },
      { g3Pass: g3?.passed, decision: setup.decision },
      passed
    );
  }

  // T36 | barre 5 min ORB 09:00/09:05/09:10 con high 99.8/100.00/99.9 e low 99.5/99.7/99.6; barra 09:15 con high 102.00 e low 98.00 | T = 100.00, min ORB = 99.5, S = 99.301, dS 0.699%, L_sel 10, perdita 6.99%
  {
    const bars5m: IntradayCandleInput[] = [
      { timestamp: '2026-10-26T09:00:00+01:00', high: 99.80, low: 99.50, close: 99.70 },
      { timestamp: '2026-10-26T09:05:00+01:00', high: 100.00, low: 99.70, close: 99.90 },
      { timestamp: '2026-10-26T09:10:00+01:00', high: 99.90, low: 99.60, close: 99.80 },
      { timestamp: '2026-10-26T09:15:00+01:00', high: 102.00, low: 98.00, close: 100.10 },
    ];
    const orbRes = calculateOrbFromIntradayBars(bars5m, 'EU', BASE_NOW_ROME, 'LONG');
    const q = createBaseFixtureQuote({
      orbHigh: orbRes.orbHigh,
      orbLow: orbRes.orbLow,
      T: null,
      E: null,
      S: null,
    });
    const cand = buildCandidateFromQuote(q);
    const setup = buildExecutionSetup(cand, null, 'EU', undefined, { currentTime: BASE_NOW_ROME });
    const passed =
      orbRes.triggerLevel === 100.00 &&
      orbRes.orbLow === 99.50 &&
      setup.stopLossLevel === 99.301 &&
      setup.stopDistancePct === 0.699 &&
      setup.selectedLeverage === 10 &&
      setup.estimatedStopLossPct === 6.99;
    recordTest(
      'T36',
      'ORB 09:00/09:05/09:10 (esclusa 09:15) -> T=100.00, min ORB=99.5, S=99.301, dS=0.699%, L_sel=10, perdita=6.99%',
      { barsCount: bars5m.length, bar0915High: 102, bar0915Low: 98 },
      { T: 100, minOrb: 99.5, S: 99.301, dS_pct: 0.699, L_sel: 10, perditaPct: 6.99 },
      {
        T: setup.triggerLevel,
        minOrb: orbRes.orbLow,
        S: setup.stopLossLevel,
        dS_pct: setup.stopDistancePct,
        L_sel: setup.selectedLeverage,
        perditaPct: setup.estimatedStopLossPct,
      },
      passed
    );
  }

  // T37 | 15 barre complete con TR = 3.00 (high 101.50, low 98.50, close 100.00); barra odierna high 120, low 100, close 110 | ATR14 = 3.00
  {
    const bars: DailyBarInput[] = [];
    for (let i = 1; i <= 15; i++) {
      bars.push({
        date: `2026-10-${String(i).padStart(2, '0')}`,
        high: 101.50,
        low: 98.50,
        close: 100.00,
        volume: 100_000,
      });
    }
    bars.push({
      date: '2026-10-26',
      high: 120.00,
      low: 100.00,
      close: 110.00,
      volume: 500_000,
    });
    const completed = filterCompletedBars(bars, 'EU', BASE_NOW_ROME);
    const atr14 = calculateAtr14FromBars(completed);
    const passed = completed.length === 15 && atr14 === 3.00;
    recordTest(
      'T37',
      '15 barre complete con TR = 3.00 + barra odierna range 20 -> ATR14 = 3.00',
      { totalBars: bars.length, completedBars: completed.length, todayBarRange: 20 },
      { atr14: 3 },
      { atr14 },
      passed
    );
  }

  // T38 | 14 barre complete con range 2.00; barra odierna con range 50 | ADR14 = 2.00
  {
    const bars: DailyBarInput[] = [];
    for (let i = 1; i <= 14; i++) {
      bars.push({
        date: `2026-10-${String(i).padStart(2, '0')}`,
        high: 101.00,
        low: 99.00,
        close: 100.00,
        volume: 100_000,
      });
    }
    bars.push({
      date: '2026-10-26',
      high: 150.00,
      low: 100.00,
      close: 125.00,
      volume: 500_000,
    });
    const completed = filterCompletedBars(bars, 'EU', BASE_NOW_ROME);
    const adr14 = calculateAdr14FromBars(completed);
    const passed = completed.length === 14 && adr14 === 2.00;
    recordTest(
      'T38',
      '14 barre complete con range 2.00 + barra odierna range 50 -> ADR14 = 2.00',
      { totalBars: bars.length, completedBars: completed.length, todayBarRange: 50 },
      { adr14: 2 },
      { adr14 },
      passed
    );
  }

  // T39 | 20 barre complete con volume 100,000 e close 50; volume odierno 10,000,000 | Liq€ = 5,000,000
  {
    const bars: DailyBarInput[] = [];
    for (let i = 1; i <= 20; i++) {
      bars.push({
        date: `2026-10-${String(i).padStart(2, '0')}`,
        high: 51.00,
        low: 49.00,
        close: 50.00,
        volume: 100_000,
      });
    }
    bars.push({
      date: '2026-10-26',
      high: 55.00,
      low: 45.00,
      close: 50.00,
      volume: 10_000_000,
    });
    const completed = filterCompletedBars(bars, 'EU', BASE_NOW_ROME);
    const liqEur = calculateLiqEurFromBars(completed, 1.0);
    const passed = completed.length === 20 && liqEur === 5_000_000;
    recordTest(
      'T39',
      '20 barre complete (vol 100k * close 50) + barra odierna vol 10M -> Liq€ = 5,000,000',
      { totalBars: bars.length, completedBars: completed.length, todayVolume: 10_000_000 },
      { liqEur: 5_000_000 },
      { liqEur },
      passed
    );
  }

  // T40 | freeze USA del 16/03/2026 | ORB chiude 14:45 CET (13:45 UTC)
  {
    const info = getUsOrbCloseTimeInfo('2026-03-16');
    const passed = info.romeFormatted === '14:45 CET' && info.utcFormatted === '13:45 UTC';
    recordTest(
      'T40',
      'freeze USA del 16/03/2026 -> ORB chiude 14:45 CET (13:45 UTC)',
      { sessionDate: '2026-03-16', nyClose: info.nyFormatted },
      { romeFormatted: '14:45 CET', utcFormatted: '13:45 UTC' },
      { romeFormatted: info.romeFormatted, utcFormatted: info.utcFormatted },
      passed
    );
  }

  // T41 | freeze USA del 26/10/2026 | ORB chiude 14:45 CET (13:45 UTC)
  {
    const info = getUsOrbCloseTimeInfo('2026-10-26');
    const passed = info.romeFormatted === '14:45 CET' && info.utcFormatted === '13:45 UTC';
    recordTest(
      'T41',
      'freeze USA del 26/10/2026 -> ORB chiude 14:45 CET (13:45 UTC)',
      { sessionDate: '2026-10-26', nyClose: info.nyFormatted },
      { romeFormatted: '14:45 CET', utcFormatted: '13:45 UTC' },
      { romeFormatted: info.romeFormatted, utcFormatted: info.utcFormatted },
      passed
    );
  }

  // T42 | freeze USA del 06/07/2026 | ORB chiude 15:45 CEST (13:45 UTC)
  {
    const info = getUsOrbCloseTimeInfo('2026-07-06');
    const passed = info.romeFormatted === '15:45 CEST' && info.utcFormatted === '13:45 UTC';
    recordTest(
      'T42',
      'freeze USA del 06/07/2026 -> ORB chiude 15:45 CEST (13:45 UTC)',
      { sessionDate: '2026-07-06', nyClose: info.nyFormatted },
      { romeFormatted: '15:45 CEST', utcFormatted: '13:45 UTC' },
      { romeFormatted: info.romeFormatted, utcFormatted: info.utcFormatted },
      passed
    );
  }

  // T43 | freeze manuale alle 10:00 Rome; minuti 09:45–09:59 con max high 105.50 (barra 09:50) e min low 104.20 (barra 09:58); barra 10:00 con high 106.00 esclusa | T = 105.50, S = 103.9916
  {
    const bars1m: IntradayCandleInput[] = [];
    for (let m = 45; m <= 59; m++) {
      bars1m.push({
        timestamp: `2026-10-26T09:${String(m).padStart(2, '0')}:00+01:00`,
        high: m === 50 ? 105.50 : 105.00,
        low: m === 58 ? 104.20 : 104.50,
        close: 104.80,
      });
    }
    // Barra 10:00 in corso (deve essere esclusa)
    bars1m.push({
      timestamp: '2026-10-26T10:00:00+01:00',
      high: 106.00,
      low: 103.00,
      close: 105.90,
    });

    const freezeInstant = new Date('2026-10-26T10:00:00+01:00');
    const mf = calculateManualFreezeLevels(bars1m, freezeInstant, 'LONG');
    const passed =
      mf.includedBarsCount === 15 &&
      mf.triggerLevel === 105.50 &&
      mf.stopLossLevel === 103.9916;
    recordTest(
      'T43',
      'freeze manuale alle 10:00 Rome (09:45-09:59 incluse, 10:00 esclusa) -> T = 105.50, S = 103.9916',
      { totalInputBars: bars1m.length, includedBars: mf.includedBarsCount, bar1000High: 106.00 },
      { T: 105.5, S: 103.9916, includedBarsCount: 15 },
      { T: mf.triggerLevel, S: mf.stopLossLevel, includedBarsCount: mf.includedBarsCount },
      passed
    );
  }

  // T44 | ORB con T = 100.00; rottura alle 09:20 (Tb = 09:20); alle 09:30 high 101.00 | T e Tb invariati (100.00, 09:20)
  {
    const barsAt0925: IntradayCandleInput[] = [
      { timestamp: '2026-10-26T09:00:00+01:00', high: 99.80, low: 99.40, close: 99.60 },
      { timestamp: '2026-10-26T09:05:00+01:00', high: 100.00, low: 99.50, close: 99.90 },
      { timestamp: '2026-10-26T09:10:00+01:00', high: 99.90, low: 99.60, close: 99.80 },
      { timestamp: '2026-10-26T09:15:00+01:00', high: 99.95, low: 99.70, close: 99.85 },
      { timestamp: '2026-10-26T09:20:00+01:00', high: 100.25, low: 99.90, close: 100.15 },
    ];
    const barsAt0935: IntradayCandleInput[] = [
      ...barsAt0925,
      { timestamp: '2026-10-26T09:25:00+01:00', high: 100.50, low: 100.05, close: 100.40 },
      { timestamp: '2026-10-26T09:30:00+01:00', high: 101.00, low: 100.30, close: 100.90 },
    ];

    const orb1 = calculateOrbFromIntradayBars(barsAt0925, 'EU', BASE_NOW_ROME, 'LONG');
    const orb2 = calculateOrbFromIntradayBars(barsAt0935, 'EU', BASE_NOW_ROME, 'LONG');
    const expectedTbIso = new Date('2026-10-26T09:20:00+01:00').toISOString();
    const passed =
      orb1.triggerLevel === 100.00 &&
      orb2.triggerLevel === 100.00 &&
      orb1.firstBreakoutTime === expectedTbIso &&
      orb2.firstBreakoutTime === expectedTbIso;
    recordTest(
      'T44',
      'ORB T = 100.00, prima rottura 09:20, nuovo high 101.00 alle 09:30 -> T e Tb invariati',
      { highAt0920: 100.25, highAt0930: 101.00 },
      { T_before: 100, T_after: 100, Tb_before: expectedTbIso, Tb_after: expectedTbIso },
      {
        T_before: orb1.triggerLevel,
        T_after: orb2.triggerLevel,
        Tb_before: orb1.firstBreakoutTime,
        Tb_after: orb2.firstBreakoutTime,
      },
      passed
    );
  }

  // T45 | entryMode nei tre casi: chiusura ORB automatica (SNAPSHOT_0915), scongelamento dopo 2 ore (UNFROZEN_LATE), freeze manuale (MANUAL_FREEZE) | record salvato con entryMode, timestamp, T, E, S, B_rec, L_sel, gateResults
  {
    const modes: EntryMode[] = ['SNAPSHOT_0915', 'UNFROZEN_LATE', 'MANUAL_FREEZE'];
    const q = createBaseFixtureQuote();
    const cand = buildCandidateFromQuote(q);

    // 1. Setup senza entryMode: la creazione del record deve lanciare errore e NON creare record
    let missingModeError: string | null = null;
    let recordCreatedForMissing = false;
    try {
      const setupNoMode = buildExecutionSetup(cand, null, 'EU', undefined, {
        currentTime: BASE_NOW_ROME,
      });
      createJournalEntryFromSetup(
        {
          session: 'EU',
          ticker: q.ticker,
          direction: setupNoMode.direction,
          strategy: setupNoMode.strategy,
          entryPrice: setupNoMode.triggerLevel,
          stopLoss: setupNoMode.stopLossLevel,
          target1: setupNoMode.target1Level,
          entryMode: setupNoMode.entryMode, // null
        },
        undefined,
        BASE_NOW_ROME
      );
      recordCreatedForMissing = true;
    } catch (err: any) {
      missingModeError = err?.message || String(err);
    }

    // 2. I tre casi con entryMode specificato
    const savedRecords = modes.map((mode) => {
      const setup = buildExecutionSetup(cand, null, 'EU', undefined, {
        currentTime: BASE_NOW_ROME,
        entryMode: mode,
      });
      return createJournalEntryFromSetup(
        {
          session: 'EU',
          ticker: q.ticker,
          direction: setup.direction,
          strategy: setup.strategy,
          entryPrice: setup.triggerLevel,
          stopLoss: setup.stopLossLevel,
          target1: setup.target1Level,
          isPaper: true,
          outcome: 'OPEN',
          entryMode: setup.entryMode,
          triggerLevel: setup.triggerLevel,
          entryLevel: setup.entryLevel,
          stopLossLevel: setup.stopLossLevel,
          barrierRecommended: setup.barrierRecommended,
          selectedLeverage: setup.selectedLeverage,
          gateResults: setup.gateResults,
        },
        undefined,
        BASE_NOW_ROME
      );
    });

    const passed =
      recordCreatedForMissing === false &&
      missingModeError !== null &&
      missingModeError.includes('entryMode obbligatorio') &&
      savedRecords[0].entryMode === 'SNAPSHOT_0915' &&
      savedRecords[1].entryMode === 'UNFROZEN_LATE' &&
      savedRecords[2].entryMode === 'MANUAL_FREEZE' &&
      savedRecords.every(
        (r) =>
          typeof r.timestamp === 'string' &&
          r.triggerLevel === 100.00 &&
          r.entryLevel === 100.00 &&
          r.stopLossLevel === 99.60 &&
          r.barrierRecommended === 96.00 &&
          r.selectedLeverage === 25 &&
          r.gateResults != null &&
          Object.keys(r.gateResults).length === 11
      );

    recordTest(
      'T45',
      'entryMode nei tre casi salvato con tag corretto; setup senza entryMode -> errore esplicito e nessun record',
      {
        testMissingMode: true,
        modes,
      },
      {
        missingThrows: true,
        recordCreatedForMissing: false,
        savedModes: ['SNAPSHOT_0915', 'UNFROZEN_LATE', 'MANUAL_FREEZE'],
        T: 100,
        E: 100,
        S: 99.6,
        B_rec: 96,
        L_sel: 25,
        gatesCount: 11,
      },
      {
        missingThrows: missingModeError !== null,
        recordCreatedForMissing,
        savedModes: savedRecords.map((r) => r.entryMode),
        T: savedRecords[0].triggerLevel,
        E: savedRecords[0].entryLevel,
        S: savedRecords[0].stopLossLevel,
        B_rec: savedRecords[0].barrierRecommended,
        L_sel: savedRecords[0].selectedLeverage,
        gatesCount: Object.keys(savedRecords[0].gateResults || {}).length,
      },
      passed
    );
  }

  // T46 | TRADING_PARAMS.MIN_SCORE_EU impostato a 50 nel test | la soglia cambia sia in buildExecutionSetup sia in DualExecutionHero, senza valori 48 cablati
  {
    const originalMinEU = TRADING_PARAMS.MIN_SCORE_EU;
    try {
      // Candidato con punteggio reale 49: gap=20, rvol=14, fut=4, lvl=7, rsi=2, news=0, trend=2, of=0 -> 49
      const q49 = createBaseFixtureQuote({
        prevClose: 100.00,
        todayOpen: 100.60,
        gapPercent: 0.60,
        atr14: 1.00,
        rvol: 1.20,
        rvol20m: null,
        prevHigh: 100.20,
        prevLow: 99.00,
        rsi5m: 35,
        rsi14: 35,
        ema20Daily: 101.00,
        orderFlow: null,
      });
      const cand49 = buildCandidateFromQuote(q49, -0.30, null);
      const setupBefore = buildExecutionSetup(cand49, null, 'EU', undefined, {
        currentTime: BASE_NOW_ROME,
      });
      const heroMinBefore = getHeroMinScore('EU');

      // Modifica dinamica della singola fonte di verità
      TRADING_PARAMS.MIN_SCORE_EU = 50;

      const setupAfter = buildExecutionSetup(cand49, null, 'EU', undefined, {
        currentTime: BASE_NOW_ROME,
      });
      const heroMinAfter = getHeroMinScore('EU');

      const passed =
        cand49.score.total === 49 &&
        setupBefore.decision === 'TRADE' &&
        heroMinBefore === originalMinEU &&
        setupAfter.decision === 'NESSUN_TRADE' &&
        setupAfter.blockedGate === 'G11' &&
        setupAfter.reasonNoTrade === 'PUNTEGGIO SOTTO SOGLIA' &&
        heroMinAfter === 50;

      recordTest(
        'T46',
        'TRADING_PARAMS.MIN_SCORE_EU impostato a 50 -> aggiorna buildExecutionSetup e DualExecutionHero',
        { candidateScore: cand49.score.total, newMinScoreEU: 50 },
        {
          beforeDecision: 'TRADE',
          afterDecision: 'NESSUN_TRADE',
          afterBlockedGate: 'G11',
          heroMinAfter: 50,
        },
        {
          beforeDecision: setupBefore.decision,
          afterDecision: setupAfter.decision,
          afterBlockedGate: setupAfter.blockedGate,
          heroMinAfter,
        },
        passed
      );
    } finally {
      TRADING_PARAMS.MIN_SCORE_EU = originalMinEU;
    }
  }

  // -------------------------------------------------------------
  // T47: Sistema Ottimizzazione - target1Multiplier dinamico in buildExecutionSetup
  // Quando l'utente accetta la proposta del motore di ottimizzazione (es. target1Multiplier = 1.35),
  // buildExecutionSetup calcola Target 1 = E + 1.35 * R e riskRewardRatio = 1.35 (invece del default 1.60)
  // -------------------------------------------------------------
  {
    const cand = buildCandidateFromQuote(createBaseFixtureQuote());
    const setupDefault = buildExecutionSetup(cand, null, 'EU', undefined, {
      currentTime: BASE_NOW_ROME,
    });

    const acceptedParams = {
      ...DEFAULT_SYSTEM_PARAMETERS,
      target1Multiplier: 1.35,
    };
    const setupOptimized = buildExecutionSetup(cand, null, 'EU', acceptedParams, {
      currentTime: BASE_NOW_ROME,
    });

    const passed =
      setupDefault.target1Level === 100.64 &&
      setupDefault.riskRewardRatio === 1.6 &&
      setupOptimized.target1Level === 100.54 &&
      setupOptimized.riskRewardRatio === 1.35;

    recordTest(
      'T47',
      'Ottimizzazione parametri: target1Multiplier dinamico applicato a Target 1 e Risk/Reward',
      { defaultTarget1Mult: 1.6, acceptedTarget1Mult: 1.35 },
      {
        defaultT1: 100.64,
        defaultRR: 1.6,
        optimizedT1: 100.54,
        optimizedRR: 1.35,
      },
      {
        defaultT1: setupDefault.target1Level,
        defaultRR: setupDefault.riskRewardRatio,
        optimizedT1: setupOptimized.target1Level,
        optimizedRR: setupOptimized.riskRewardRatio,
      },
      passed
    );
  }

  // -------------------------------------------------------------
  // T48: Sistema Ottimizzazione - minScore dinamico in Gate G11 e isCandidateCompliantWithParameters
  // Quando i parametri accettati alzano minScoreEurope a 52, un candidato con punteggio 49
  // viene bloccato da Gate G11 e isCandidateCompliantWithParameters restituisce false
  // -------------------------------------------------------------
  {
    const q49 = createBaseFixtureQuote({
      prevClose: 100.00,
      todayOpen: 100.60,
      gapPercent: 0.60,
      atr14: 1.00,
      rvol: 1.20,
      rvol20m: null,
      prevHigh: 100.20,
      prevLow: 99.00,
      rsi5m: 35,
      rsi14: 35,
      ema20Daily: 101.00,
      orderFlow: null,
    });
    const cand49 = buildCandidateFromQuote(q49, -0.30, null);

    const setupDefault = buildExecutionSetup(cand49, null, 'EU', DEFAULT_SYSTEM_PARAMETERS, {
      currentTime: BASE_NOW_ROME,
    });
    const compliantDefault = isCandidateCompliantWithParameters(
      cand49.quote,
      cand49.score.total,
      DEFAULT_SYSTEM_PARAMETERS,
      false
    ).compliant;

    const acceptedParams = {
      ...DEFAULT_SYSTEM_PARAMETERS,
      minScoreEurope: 52,
    };
    const setupWithAccepted = buildExecutionSetup(cand49, null, 'EU', acceptedParams, {
      currentTime: BASE_NOW_ROME,
    });
    const compliantWithAccepted = isCandidateCompliantWithParameters(
      cand49.quote,
      cand49.score.total,
      acceptedParams,
      false
    ).compliant;

    const passed =
      cand49.score.total === 49 &&
      setupDefault.decision === 'TRADE' &&
      compliantDefault === true &&
      setupWithAccepted.decision === 'NESSUN_TRADE' &&
      setupWithAccepted.blockedGate === 'G11' &&
      setupWithAccepted.reasonNoTrade === 'PUNTEGGIO SOTTO SOGLIA' &&
      compliantWithAccepted === false;

    recordTest(
      'T48',
      'Ottimizzazione parametri: minScoreEurope dinamico blocca Gate G11 e compliance',
      { candidateScore: cand49.score.total, defaultMin: 48, acceptedMin: 52 },
      {
        defaultDecision: 'TRADE',
        defaultCompliant: true,
        acceptedDecision: 'NESSUN_TRADE',
        acceptedBlockedGate: 'G11',
        acceptedCompliant: false,
      },
      {
        defaultDecision: setupDefault.decision,
        defaultCompliant: compliantDefault,
        acceptedDecision: setupWithAccepted.decision,
        acceptedBlockedGate: setupWithAccepted.blockedGate,
        acceptedCompliant: compliantWithAccepted,
      },
      passed
    );
  }

  // -------------------------------------------------------------
  // T49: Ottimizzazione Sessione - Soglia minima di 5 trade per mercato
  // Con 3 trade chiusi per l'Europa (< 5 minimi), evaluateSessionOptimization
  // restituisce 'Dati Insufficienti' con zero proposte e zero stime fittizie.
  // -------------------------------------------------------------
  {
    const sampleTradeEU: TradeJournalEntry = {
      id: 'trade-eu-1',
      date: '2026-10-26',
      session: 'EU',
      ticker: 'ENI.MI',
      direction: 'LONG',
      strategy: 'Opening Range Breakout (5m / 15m)',
      market: 'EU',
      timestamp: new Date().toISOString(),
      entryPrice: 14.50,
      stopLoss: 14.30,
      target1: 14.82,
      status: 'CLOSED',
      outcome: 'WIN',
      exitPrice: 14.82,
      pnlEur: 160.0,
      rMultiple: 1.6,
      entryMode: 'SNAPSHOT_0915',
      notes: 'EU test trade',
      isPaper: true,
    };
    const trades3 = [
      { ...sampleTradeEU, id: 't1' },
      { ...sampleTradeEU, id: 't2' },
      { ...sampleTradeEU, id: 't3' },
    ];

    const prop = evaluateSessionOptimization(trades3, 'EU', DEFAULT_SYSTEM_PARAMETERS, 5);

    const passed =
      prop.market === 'EU' &&
      prop.evaluatedTradesCount === 3 &&
      prop.status === 'NO_CHANGES_NEEDED' &&
      prop.proposedChanges.length === 0 &&
      prop.summaryTitle.includes('Dati Insufficienti');

    recordTest(
      'T49',
      'Ottimizzazione Sessione: 3 trade EU (< 5 minimi) -> Dati Insufficienti, 0 proposte fittizie',
      { market: 'EU', tradeCount: 3, minRequired: 5 },
      {
        market: 'EU',
        evaluatedCount: 3,
        status: 'NO_CHANGES_NEEDED',
        proposedChangesCount: 0,
        titleContainsInsufficient: true,
      },
      {
        market: prop.market,
        evaluatedCount: prop.evaluatedTradesCount,
        status: prop.status,
        proposedChangesCount: prop.proposedChanges.length,
        titleContainsInsufficient: prop.summaryTitle.includes('Dati Insufficienti'),
      },
      passed
    );
  }

  // -------------------------------------------------------------
  // T50: Ottimizzazione Duale - Isolamento perfetto Europa vs USA
  // 6 trade EU (2 WIN, 4 LOSS) e 2 trade USA (2 WIN):
  // Europa genera proposta PENDING con inasprimento minScoreEurope/minRvolEurope;
  // USA restituisce Dati Insufficienti con zero modifiche (nessuna contaminazione incrociata).
  // -------------------------------------------------------------
  {
    const makeEUTrade = (id: string, outcome: 'WIN' | 'LOSS'): TradeJournalEntry => ({
      id,
      date: '2026-10-26',
      session: 'EU',
      ticker: 'STM.MI',
      direction: 'LONG',
      strategy: 'Opening Range Breakout (5m / 15m)',
      market: 'EU',
      timestamp: new Date().toISOString(),
      entryPrice: 25.0,
      stopLoss: 24.6,
      target1: 25.64,
      status: 'CLOSED',
      outcome,
      exitPrice: outcome === 'WIN' ? 25.64 : 24.60,
      pnlEur: outcome === 'WIN' ? 160.0 : -100.0,
      rMultiple: outcome === 'WIN' ? 1.6 : -1.0,
      entryMode: 'SNAPSHOT_0915',
      notes: 'EU test trade',
      isPaper: true,
    });

    const makeUSTrade = (id: string): TradeJournalEntry => ({
      id,
      date: '2026-10-26',
      session: 'US',
      ticker: 'NVDA',
      direction: 'LONG',
      strategy: 'Opening Range Breakout (5m / 15m)',
      market: 'US',
      timestamp: new Date().toISOString(),
      entryPrice: 120.0,
      stopLoss: 118.5,
      target1: 122.4,
      status: 'CLOSED',
      outcome: 'WIN',
      exitPrice: 122.4,
      pnlEur: 160.0,
      rMultiple: 1.6,
      entryMode: 'SNAPSHOT_0915',
      notes: 'US test trade',
      isPaper: true,
    });

    const mixedTrades: TradeJournalEntry[] = [
      makeEUTrade('eu1', 'WIN'),
      makeEUTrade('eu2', 'WIN'),
      makeEUTrade('eu3', 'LOSS'),
      makeEUTrade('eu4', 'LOSS'),
      makeEUTrade('eu5', 'LOSS'),
      makeEUTrade('eu6', 'LOSS'),
      makeUSTrade('us1'),
      makeUSTrade('us2'),
    ];

    const dual = evaluateDualSystemOptimization(mixedTrades, DEFAULT_SYSTEM_PARAMETERS, 5);

    const euValid = dual.eu !== null;
    const usValid = dual.us !== null;

    const euHasScoreOrRvolChange = euValid && dual.eu!.proposedChanges.some(
      (c) => c.parameterKey === 'minScoreEurope' || c.parameterKey === 'minRvolEurope'
    );
    const usIsInsufficient =
      usValid &&
      dual.us!.status === 'NO_CHANGES_NEEDED' &&
      dual.us!.proposedChanges.length === 0 &&
      dual.us!.summaryTitle.includes('Dati Insufficienti');

    const passed =
      euValid &&
      usValid &&
      dual.eu!.market === 'EU' &&
      dual.eu!.evaluatedTradesCount === 6 &&
      dual.eu!.status === 'PENDING' &&
      euHasScoreOrRvolChange &&
      dual.us!.market === 'US' &&
      dual.us!.evaluatedTradesCount === 2 &&
      usIsInsufficient;

    recordTest(
      'T50',
      'Ottimizzazione Duale: 6 trade EU -> proposta minScoreEurope; 2 trade US -> Dati Insufficienti isolati',
      { euTradeCount: 6, usTradeCount: 2, minRequired: 5 },
      {
        euStatus: 'PENDING',
        euHasTargetedChange: true,
        usStatus: 'NO_CHANGES_NEEDED',
        usProposedCount: 0,
        usTitleContainsInsufficient: true,
      },
      {
        euStatus: dual.eu ? dual.eu.status : 'null',
        euHasTargetedChange: euHasScoreOrRvolChange,
        usStatus: dual.us ? dual.us.status : 'null',
        usProposedCount: dual.us ? dual.us.proposedChanges.length : -1,
        usTitleContainsInsufficient: dual.us ? dual.us.summaryTitle.includes('Dati Insufficienti') : false,
      },
      passed
    );
  }

  // --------------------------------------------------------------------------
  // TEST T51: Barra iniziale a volume 0 non azzera RVOL
  // --------------------------------------------------------------------------
  {
    const orbBarsWithZeroStart = [{ volume: 0 }, { volume: 10000 }, { volume: 15000 }];
    const histVolumes20d = Array(20).fill(20000); // media storica = 20000
    const rvol = calculateOrbRvolFromBars(orbBarsWithZeroStart, histVolumes20d);
    // Cumulato = 25000, media = 20000 -> rvol = 1.25x (non azzera)
    const passed = rvol === 1.25;

    recordTest(
      'T51',
      'Barra iniziale a volume 0: contribuisce 0 al cumulato (25.000) e non produce rvol = 0 (rvol = 1.25x)',
      { orbVolumes: [0, 10000, 15000], histAvg: 20000 },
      { expectedRvol: 1.25, nonZero: true },
      { actualRvol: rvol, nonZero: rvol !== 0 },
      passed
    );
  }

  // --------------------------------------------------------------------------
  // TEST T52: Cumulato corretto delle 3 barre ORB 15m / media storica 20 sessioni
  // --------------------------------------------------------------------------
  {
    const orbBars = [{ volume: 20000 }, { volume: 30000 }, { volume: 50000 }];
    const histVolumes20d = Array(20).fill(50000); // cumulato = 100000, media = 50000 -> rvol = 2.00x
    const rvol = calculateOrbRvolFromBars(orbBars, histVolumes20d);
    const passed = rvol === 2.0;

    recordTest(
      'T52',
      'Cumulato corretto: 3 barre 5m (100.000) / media storica ORB 20 sessioni (50.000) -> rvol = 2.00x',
      { orbVolumes: [20000, 30000, 50000], histAvg: 50000 },
      { expectedRvol: 2.0 },
      { actualRvol: rvol },
      passed
    );
  }

  // --------------------------------------------------------------------------
  // TEST T53: Dati non disponibili -> rvol = null (mai 0) e punteggio neutro (0pt)
  // --------------------------------------------------------------------------
  {
    const orbBars = [{ volume: 10000 }];
    const incompleteHist = Array(10).fill(50000); // meno di 20 sessioni
    const rvolNull = calculateOrbRvolFromBars(orbBars, incompleteHist);
    const qWithNullRvol = createBaseFixtureQuote({ rvol: null, rvol20m: null });
    const score = calculateCandidateScore(qWithNullRvol, 0.30, null);
    const hasNeutralMsg = score.details.some((d) => d.includes('N/D') && d.includes('0pt'));
    const passed = rvolNull === null && score.rvolScore === 0 && hasNeutralMsg;

    recordTest(
      'T53',
      'RVOL non disponibile: restituisce null (mai 0), tier mostra N/D e applica punteggio neutro (0pt)',
      { histBarsCount: 10, quoteRvol: null },
      { rvolIsNull: true, rvolScore: 0, detailHasNd: true },
      { rvolIsNull: rvolNull === null, rvolScore: score.rvolScore, detailHasNd: hasNeutralMsg },
      passed
    );
  }

  // --------------------------------------------------------------------------
  // TEST T54: Soglia effettiva RVOL Europa di pre-screening pari a 0.85
  // --------------------------------------------------------------------------
  {
    const paramVal = TRADING_PARAMS.MIN_RVOL_EU;

    // Candidato EU con RVOL = 0.84 (sotto soglia 0.85) -> respinto per RVOL
    const quoteEuBelow = createBaseFixtureQuote({
      market: 'EU',
      rvol: 0.84,
    });
    const checkBelow = isCandidateCompliantWithParameters(
      quoteEuBelow,
      60,
      DEFAULT_SYSTEM_PARAMETERS,
      false
    );
    const belowBlocked = !checkBelow.compliant && checkBelow.reasons.some((r) => r.includes('RVOL 0.84x < 0.85x (EU)'));

    // Candidato EU con RVOL = 0.85 (alla soglia 0.85) -> ammesso (nessun motivo RVOL)
    const quoteEuPass = createBaseFixtureQuote({
      market: 'EU',
      rvol: 0.85,
    });
    const checkPass = isCandidateCompliantWithParameters(
      quoteEuPass,
      60,
      DEFAULT_SYSTEM_PARAMETERS,
      false
    );
    const passAllowed = !checkPass.reasons.some((r) => r.includes('RVOL'));

    const passed = paramVal === 0.85 && belowBlocked && passAllowed;
    recordTest(
      'T54',
      'Verifica soglia EU effettiva RVOL di pre-screening pari a 0.85 (0.84x respinto, 0.85x ammesso)',
      { expectedThreshold: 0.85, belowRvol: 0.84, passRvol: 0.85 },
      { paramVal: 0.85, belowBlocked: true, passAllowed: true },
      { paramVal, belowBlocked, passAllowed },
      passed
    );
  }

  // --------------------------------------------------------------------------
  // TEST T55: Costruzione Quote Live con barre reali SAP.DE (sessione 28/10/2026)
  // --------------------------------------------------------------------------
  {
    // Barre reali 5m ORB di SAP.DE del 2026-10-28 (barra 1 a volume 0)
    const realOrbBars20261028 = [
      { volume: 0 },
      { volume: 9567 },
      { volume: 9394 },
    ];
    // Storico reale dei 20 volumi ORB precedenti di SAP.DE (media = 39.294)
    const realHistOrb20d = [
      67347, 19740, 31765, 57129, 14574,
      20514, 30369, 29626, 12658, 107971,
      31367, 31478, 23840, 128961, 28098,
      22953, 40376, 14288, 84719, 32948,
    ];

    // Con storico completo a 20 sessioni -> rvol calcolato esattamente (18.961 / 41.536 = 0.46x)
    const rvolFull = calculateOrbRvolFromBars(realOrbBars20261028, realHistOrb20d);

    // Con storico insufficiente (< 20 sessioni, es. 10 sessioni) -> rvol = null (MAI fallback 1.0 né 0)
    const insufficientHist = realHistOrb20d.slice(-10);
    const rvolInsufficient = calculateOrbRvolFromBars(realOrbBars20261028, insufficientHist);

    // Costruzione quote live con rvol calcolato da calculateOrbRvolFromBars
    const liveQuote = createBaseFixtureQuote({
      ticker: 'SAP.DE',
      market: 'EU',
      rvol: rvolFull,
    });

    const liveQuoteInsufficient = createBaseFixtureQuote({
      ticker: 'SAP.DE',
      market: 'EU',
      rvol: rvolInsufficient,
    });

    const scoreInsufficient = calculateCandidateScore(liveQuoteInsufficient, 0.20, null);

    const passed =
      rvolFull === 0.46 &&
      rvolInsufficient === null &&
      liveQuote.rvol === 0.46 &&
      liveQuoteInsufficient.rvol === null &&
      scoreInsufficient.rvolScore === 0;

    recordTest(
      'T55',
      'Costruzione quote live da barre reali SAP.DE (28/10/2026): rvol = 0.46x; storico <20 sessioni -> rvol = null (mai fallback)',
      { fullHistCount: 20, partialHistCount: 10, cumVol: 18961, histAvg: 41536 },
      { expectedRvolFull: 0.46, expectedRvolPartial: null, rvolScorePartial: 0 },
      { rvolFull, rvolInsufficient, rvolScorePartial: scoreInsufficient.rvolScore },
      passed
    );
  }

  const passedCount = results.filter((r) => r.passed).length;
  console.log('================================================================');
  console.log(`RISULTATO COMPLESSIVO: ${passedCount} / ${results.length} PASS`);
  console.log('================================================================');

  if (passedCount !== results.length) {
    process.exit(1);
  }
}

runAllTests();
