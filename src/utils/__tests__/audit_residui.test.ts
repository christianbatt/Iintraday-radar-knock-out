/**
 * Regressioni per i residui dell'audit P0/P1: voci 6, 7, 9, 10, 11, 13.
 * Runner: tsx (nessun vitest/jest nel progetto) — `npm run test:audit`.
 */
import assert from 'node:assert/strict';
import {
  computeSessionVwap,
  computeVwapState,
  calculateVwapScoreContribution,
  rankMarketCandidates,
  isCandidateCompliantWithParameters,
  isRsiExtreme,
  calculateRsiFromPrices,
  DEFAULT_SYSTEM_PARAMETERS,
  evaluateOpenPositionLifecycle,
  applyOptimizationProposal,
} from '../calculator';
import { wilderRsiSeries } from '../indicators';
import { TRADING_PARAMS } from '../../config/tradingParams';
import type { TradeJournalEntry, VwapSignalState } from '../../types/radar';

const sec = (iso: string) => Date.parse(iso) / 1000;

// ---------------------------------------------------------------- VOCE 6
// VWAP: la barra in formazione e quella futura non devono entrare nel calcolo.
{
  const bars = [
    { timestamp: sec('2026-11-04T08:00:00Z'), high: 100, low: 100, close: 100, volume: 1 }, // 09:00 Roma
    { timestamp: sec('2026-11-04T08:05:00Z'), high: 101, low: 101, close: 101, volume: 1 }, // 09:05
    { timestamp: sec('2026-11-04T08:10:00Z'), high: 102, low: 102, close: 102, volume: 1 }, // 09:10
    { timestamp: sec('2026-11-04T08:15:00Z'), high: 110, low: 110, close: 110, volume: 1 }, // 09:15 IN FORMAZIONE a 09:15
    { timestamp: sec('2026-11-04T08:20:00Z'), high: 111, low: 111, close: 111, volume: 1 }, // 09:20 FUTURA
  ];

  // Alle 09:15 la barra 09:15 non e' ancora chiusa (chiude 09:20): restano 3 barre.
  const cum = computeSessionVwap(bars, 'EU', '2026-11-04', { nowMinutes: 555 });
  assert.equal(cum.barsWithVolume, 3, 'V6: barra in formazione e futura escluse dalla VWAP cumulata');
  assert.equal(cum.vwap, 101, 'V6: VWAP calcolata solo sulle barre chiuse (100+101+102)/3');

  const state = computeVwapState(bars, {
    market: 'EU',
    sessionDate: '2026-11-04',
    atr5m: 1,
    coverage: 1,
    nowMinutes: 555,
  });
  assert.equal(state.vwapLevel, 101, 'V6: la VWAP di stato ignora la barra in formazione');
}

// ---------------------------------------------------------------- VOCE 7
// VWAP NEUTRAL = 0 punti su 10 (IPOTESI confermata).
{
  const neutralState: VwapSignalState = {
    state: 'NEUTRAL',
    distAtr: 0.05,
    slopeAtr: 0,
    coverage: 1,
    volumeRatio: 2,
    flags: [],
    vwapLevel: 100,
  };
  const contrib = calculateVwapScoreContribution(neutralState, 'LONG');
  const weight = TRADING_PARAMS.VWAP_SCORE_WEIGHT;
  assert.equal(weight, 10, 'V7: il peso VWAP atteso e\' 10');
  assert.equal(contrib.score, 0, 'V7: NEUTRAL non regala punti');
  assert.equal(contrib.state, 'NEUTRAL');
  assert.ok(contrib.detail.includes(`0/${weight}`), `V7: detail riporta 0/${weight}`);
}

// ---------------------------------------------------------------- VOCE 9
// RSI piatto = 50 (neutro), non 100; RSI_EXTREME non scatta.
{
  const flat = new Array(25).fill(100);
  const series = wilderRsiSeries(flat, 14);
  for (let i = 14; i < series.length; i++) {
    assert.equal(series[i], 50, 'V9: serie piatta -> 50 in wilderRsiSeries');
  }
  assert.equal(calculateRsiFromPrices(flat, 14), 50, 'V9: serie piatta -> 50 nel calculator');
  assert.equal(isRsiExtreme(50), false, 'V9: RSI 50 non e\' estremo (nessun veto RSI_EXTREME)');

  const rising = Array.from({ length: 25 }, (_, i) => 100 + i);
  assert.equal(calculateRsiFromPrices(rising, 14), 100, 'V9: serie solo crescente resta 100 (nessuna perdita)');
}

// ---------------------------------------------------------------- VOCE 10
// Direzione operativa = direzione del catalyst (score e veto sullo stesso lato).
{
  const baseQuote: any = {
    ticker: 'AAA',
    market: 'EU',
    currentPrice: 100,
    prevClose: 98,
    gapPercent: 2, // gap positivo...
    atr14: 1,
    rvol: 2,
    liqEur20d: 5_000_000,
    rsi5m: 50,
    T: 100,
    S: 99.5,
    currency: 'EUR',
  };

  // ...ma il catalyst e' SHORT: la barriera KO va calcolata sul lato SHORT (T * (1 + 1/L)).
  const shortCat: any = { direzione: 'SHORT', decisione: 'BUY', catalizzatore: 'test' };
  const ranked = rankMarketCandidates([baseQuote], 'EU', 0, {
    parameters: DEFAULT_SYSTEM_PARAMETERS,
    catalystCache: { AAA: shortCat },
  } as any);
  const withCat = ranked.find((c) => c.quote.ticker === 'AAA');
  assert.ok(withCat, 'V10: candidato presente con catalyst SHORT');
  assert.ok(
    (withCat!.knockOutGuard?.safeBarrierLevel ?? 0) > 100,
    'V10: barriera KO calcolata sul lato SHORT (catalyst), non sul segno del gap'
  );

  const rankedNoCat = rankMarketCandidates([baseQuote], 'EU', 0, {
    parameters: DEFAULT_SYSTEM_PARAMETERS,
  } as any);
  const noCat = rankedNoCat.find((c) => c.quote.ticker === 'AAA');
  assert.ok(noCat, 'V10: candidato presente senza catalyst');
  assert.ok(
    (noCat!.knockOutGuard?.safeBarrierLevel ?? 0) < 100,
    'V10: senza catalyst decide il segno del gap (LONG)'
  );

  // Hard gate VWAP: con VWAP BELOW (ribassista) il candidato SHORT passa, il LONG viene scartato.
  const originalGate = (TRADING_PARAMS as any).VWAP_HARD_GATE;
  try {
    (TRADING_PARAMS as any).VWAP_HARD_GATE = true;
    const bearishQuote: any = {
      ...baseQuote,
      vwapState: { state: 'BELOW', distAtr: 0.5, slopeAtr: 0, coverage: 1, volumeRatio: 2, flags: [], vwapLevel: 99 },
    };
    const keptShort = rankMarketCandidates([bearishQuote], 'EU', 0, {
      parameters: DEFAULT_SYSTEM_PARAMETERS,
      catalystCache: { AAA: shortCat },
    } as any);
    assert.ok(keptShort.some((c) => c.quote.ticker === 'AAA'), 'V10: gate coerente con SHORT (catalyst)');

    const droppedLong = rankMarketCandidates([bearishQuote], 'EU', 0, {
      parameters: DEFAULT_SYSTEM_PARAMETERS,
    } as any);
    assert.equal(
      droppedLong.some((c) => c.quote.ticker === 'AAA'),
      false,
      'V10: con direzione LONG (gap) lo stesso VWAP ribassista e\' scartato dal gate'
    );
  } finally {
    (TRADING_PARAMS as any).VWAP_HARD_GATE = originalGate;
  }
}

// ---------------------------------------------------------------- VOCE 11
// RVOL assente = volume non confermato; la soglia arriva dai parameters, non e' hardcoded.
{
  const params = {
    ...DEFAULT_SYSTEM_PARAMETERS,
    minScore: 0,
    minScoreEurope: 0,
    minGapEurope: 0,
    minRvol: 1.4,
    minRvolEurope: 1.4,
  };
  const base: any = {
    ticker: 'BBB',
    market: 'EU',
    currentPrice: 100,
    atr14: 1,
    gapPercent: 0.5,
    rsi5m: 50,
  };

  const missing = isCandidateCompliantWithParameters({ ...base, rvol: null }, 80, params, false);
  assert.equal(missing.compliant, false, 'V11: RVOL null non supera il filtro volume');
  assert.ok(
    missing.reasons.some((r) => r.includes('RVOL non confermato (dato assente)')),
    'V11: motivo esplicito "RVOL non confermato (dato assente)"'
  );

  const above = isCandidateCompliantWithParameters({ ...base, rvol: 1.6 }, 80, params, false);
  assert.equal(above.compliant, true, 'V11: RVOL sopra soglia passa');

  const below = isCandidateCompliantWithParameters({ ...base, rvol: 1.2 }, 80, params, false);
  assert.equal(below.compliant, false, 'V11: RVOL sotto soglia non passa');
  assert.ok(below.reasons.some((r) => r.includes('1.20x < 1.4x')), 'V11: la soglia usata e\' quella dei parameters');

  const lowered = isCandidateCompliantWithParameters(
    { ...base, rvol: 1.2 },
    80,
    { ...params, minRvol: 1.1, minRvolEurope: 1.1 },
    false
  );
  assert.equal(lowered.compliant, true, 'V11: abbassando minRvol nei parameters cambia l\'esito');
}

// ---------------------------------------------------------------- VOCE 13
// MFE/MAE solo nella finestra del trade: gli estremi di sessione non entrano.
{
  const trade = {
    id: 'T13',
    timestamp: '2026-11-04T08:30:00Z',
    date: '04/11/2026',
    session: 'EU',
    market: 'EU',
    ticker: 'CCC',
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
  } as unknown as TradeJournalEntry;

  const res = evaluateOpenPositionLifecycle(
    trade,
    { ticker: 'CCC', market: 'EU', currentPrice: 101, todayHigh: 150, todayLow: 50 } as any,
    new Date('2026-11-04T08:35:00Z')
  );
  assert.equal(res.wasClosed, false, 'V13: il trade resta aperto');
  assert.equal(res.updatedTrade.mfe, 1, 'V13: MFE = escursione del trade (+1R), non todayHigh (150)');
  assert.equal(res.updatedTrade.mae, 0, 'V13: MAE non usa todayLow (50)');
}

// ---------------------------------------------------------------- VOCE 12
// Una proposta accettata scrive i parametri ATTIVI: la selezione cambia davvero.
{
  const baseParams = {
    ...DEFAULT_SYSTEM_PARAMETERS,
    minScore: 0,
    minScoreEurope: 0,
    minGapEurope: 0,
    minRvol: 1.1,
    minRvolEurope: 1.1,
  };
  const quote: any = {
    ticker: 'DDD',
    market: 'EU',
    currentPrice: 100,
    atr14: 1,
    gapPercent: 0.5,
    rsi5m: 50,
    rvol: 1.2,
  };

  const before = isCandidateCompliantWithParameters(quote, 80, baseParams, false);
  assert.equal(before.compliant, true, 'V12: con minRvol 1.1 il candidato a 1.2x e\' selezionabile');

  const proposal = {
    id: 'prop-v12',
    proposedChanges: [
      {
        parameterKey: 'minRvol' as const,
        proposedValue: '1.35x',
      },
    ],
  };
  const applied = applyOptimizationProposal(baseParams, proposal, 'EU');
  assert.equal(applied.parameters.minRvolEurope, 1.35, 'V12: minRvol accettato finisce nei parametri EU attivi');
  assert.equal(applied.parameters.version, baseParams.version + 1, 'V12: la versione avanza');

  const history = applied.parameters.parameterHistory ?? [];
  assert.equal(history.length, 1, 'V12: la calibrazione lascia una traccia');
  const entry = history[0].changes.find((c) => c.parameterKey === 'minRvolEurope');
  assert.ok(entry, 'V12: lo storico contiene la chiave modificata');
  assert.equal(entry!.from, 1.1, 'V12: il valore precedente resta recuperabile');
  assert.equal(entry!.to, 1.35, 'V12: il nuovo valore e\' tracciato');

  const after = isCandidateCompliantWithParameters(quote, 80, applied.parameters, false);
  assert.equal(
    after.compliant,
    false,
    'V12: dopo l\'accettazione lo stesso candidato (1.2x < 1.35x) non passa piu\' la selezione'
  );
}

console.log('audit_residui: 7 gruppi di regressione OK (voci 6,7,9,10,11,12,13)');
