import {
  RawQuoteData,
  ScoredCandidate,
  ScoreBreakdown,
  ExecutionSetup,
  GeminiCatalystAnalysis,
  KnockOutCalculatorInput,
  KnockOutSafetyCheck,
  PnLScenario,
  DynamicBreakevenInfo,
  DerivativeStressReport,
  ImpliedVolatilityMetrics,
} from '../types/radar';

// Minimum criteria for candidacy qualification
export const MIN_QUALIFICATION_THRESHOLDS = {
  minScore: 55, // Out of 100
  minGapEurope: 0.4, // %
  minGapUSA: 0.7, // %
  minRvol: 1.1, // Relative volume
  minAvgVolume: 350000, // Shares daily average
};

export function calculateCandidateScore(
  quote: RawQuoteData,
  benchmarkFuturesChangePercent: number
): ScoreBreakdown {
  const details: string[] = [];
  let gapScore = 0;
  let rvolScore = 0;
  let liquidityScore = 0;
  let futuresScore = 0;
  let levelScore = 0;

  // If essential price data is missing from exchange, candidate receives 0 score
  const price = quote.preMarketPrice ?? quote.currentPrice;
  if (price == null || price <= 0) {
    return {
      gapScore: 0,
      rvolScore: 0,
      liquidityScore: 0,
      futuresScore: 0,
      levelScore: 0,
      total: 0,
      details: ['Prezzo di mercato non disponibile dal feed: candidato non qualificabile.'],
    };
  }

  const isEurope = quote.market === 'EU';

  // 1. GAP SCORE (max 30) - Only from real calculated gap
  if (quote.gapPercent != null) {
    const absGap = Math.abs(quote.gapPercent);
    const gapThreshold = isEurope ? 0.8 : 1.4;
    if (absGap >= gapThreshold * 1.5) {
      gapScore = 30;
      details.push(`Gap elevato (${absGap.toFixed(2)}% vs soglia ${gapThreshold}%): +30pt`);
    } else if (absGap >= gapThreshold) {
      gapScore = 24;
      details.push(`Gap significativo (${absGap.toFixed(2)}%): +24pt`);
    } else if (absGap >= (isEurope ? 0.4 : 0.7)) {
      gapScore = 15;
      details.push(`Gap moderato (${absGap.toFixed(2)}%): +15pt`);
    } else {
      gapScore = 4;
      details.push(`Gap debole o piatto (${absGap.toFixed(2)}%): +4pt`);
    }
  } else {
    gapScore = 0;
    details.push('Gap % non disponibile dal mercato: 0pt');
  }

  // 2. RVOL SCORE (max 25) - Only from real volume
  if (quote.rvol != null) {
    const rvol = quote.rvol;
    if (rvol >= 2.0) {
      rvolScore = 25;
      details.push(`Relative Volume sostenuto (RVOL ${rvol.toFixed(2)}x): +25pt`);
    } else if (rvol >= 1.4) {
      rvolScore = 20;
      details.push(`Relative Volume sopra media (RVOL ${rvol.toFixed(2)}x): +20pt`);
    } else if (rvol >= 1.1) {
      rvolScore = 14;
      details.push(`Relative Volume nella media (RVOL ${rvol.toFixed(2)}x): +14pt`);
    } else {
      rvolScore = 5;
      details.push(`Relative Volume debole (RVOL ${rvol.toFixed(2)}x): +5pt`);
    }
  } else {
    rvolScore = 0;
    details.push('RVOL non disponibile (volume pre-market non scambiato o non comunicato): 0pt');
  }

  // 3. LIQUIDITY SCORE (max 15) - From real 20d average volume
  const avgVol = quote.avgVolume20d;
  if (avgVol != null && avgVol > 0) {
    if (avgVol >= 5000000) {
      liquidityScore = 15;
      details.push(`Alta liquidità giornaliera (vol medio ${formatCompactNumber(avgVol)}): +15pt`);
    } else if (avgVol >= 1500000) {
      liquidityScore = 12;
      details.push(`Buona liquidità (vol medio ${formatCompactNumber(avgVol)}): +12pt`);
    } else if (avgVol >= 500000) {
      liquidityScore = 8;
      details.push(`Liquidità discreta (vol medio ${formatCompactNumber(avgVol)}): +8pt`);
    } else {
      liquidityScore = 2;
      details.push(`Liquidità ridotta (vol medio ${formatCompactNumber(avgVol)}): +2pt`);
    }
  } else {
    liquidityScore = 0;
    details.push('Volume medio 20gg non disponibile: 0pt');
  }

  // 4. FUTURES COHERENCE (max 20)
  const isGapLong = (quote.gapPercent ?? 0) > 0;
  const isFuturesGreen = benchmarkFuturesChangePercent > 0.15;
  const isFuturesRed = benchmarkFuturesChangePercent < -0.15;

  if ((isGapLong && isFuturesGreen) || (!isGapLong && isFuturesRed)) {
    futuresScore = 20;
    details.push(`Allineamento totale titolo/futures indice (${benchmarkFuturesChangePercent > 0 ? '+' : ''}${benchmarkFuturesChangePercent.toFixed(2)}%): +20pt`);
  } else if (Math.abs(benchmarkFuturesChangePercent) <= 0.15) {
    futuresScore = 12;
    details.push(`Futures indice neutrali (${benchmarkFuturesChangePercent.toFixed(2)}%): +12pt`);
  } else {
    futuresScore = 4;
    details.push(`Divergenza con futures indice (${benchmarkFuturesChangePercent > 0 ? '+' : ''}${benchmarkFuturesChangePercent.toFixed(2)}%): +4pt (rischio fade)`);
  }

  // 5. KEY LEVELS PROXIMITY (max 10) - Real yesterday High / Low
  const prevHigh = quote.prevHigh;
  const prevLow = quote.prevLow;

  if (price > 0 && prevHigh != null && prevLow != null) {
    if (isGapLong && price >= prevHigh) {
      levelScore = 10;
      details.push(`Rottura/apertura sopra il Massimo reale di ieri: +10pt`);
    } else if (!isGapLong && price <= prevLow) {
      levelScore = 10;
      details.push(`Rottura/apertura sotto il Minimo reale di ieri: +10pt`);
    } else {
      levelScore = 5;
      details.push(`Prezzo all'interno del range di ieri: +5pt`);
    }
  } else {
    levelScore = 2;
    details.push('Livelli High/Low ieri non disponibili: +2pt');
  }

  // 6. RSI (14) MOMENTUM QUALITY
  if (quote.rsi14 != null) {
    if (quote.rsi14 >= 70) {
      details.push(`RSI(14) in Ipercomprato (${quote.rsi14}): rischio pullback/esaurimento momentum.`);
    } else if (quote.rsi14 <= 30) {
      details.push(`RSI(14) in Ipervenduto (${quote.rsi14}): rischio rimbalzo contro-trend.`);
    } else {
      details.push(`RSI(14) in zona sana di espansione (${quote.rsi14}): momentum equilibrato.`);
    }
  }

  const total = gapScore + rvolScore + liquidityScore + futuresScore + levelScore;

  return {
    gapScore,
    rvolScore,
    liquidityScore,
    futuresScore,
    levelScore,
    total,
    details,
  };
}

export interface ScreeningFilterOptions {
  rsiFilterActive?: boolean;
}

export function isRsiExtreme(rsi: number | null | undefined): boolean {
  if (rsi == null) return false;
  return rsi >= 70 || rsi <= 30;
}

export function calculateRsiFromPrices(closes: number[], period: number = 14): number | null {
  if (!closes || closes.length < 6) return null;
  const p = Math.min(period, closes.length - 1);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= p; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / p;
  let avgLoss = losses / p;

  for (let i = p + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(1);
}

export function rankMarketCandidates(
  quotes: RawQuoteData[],
  market: 'EU' | 'US',
  futuresChange: number | { EU: number; US: number },
  options?: ScreeningFilterOptions
): ScoredCandidate[] {
  let marketQuotes = quotes.filter((q) => q.market === market);

  // If RSI filter is active, exclude overbought (RSI >= 70) and oversold (RSI <= 30)
  if (options?.rsiFilterActive) {
    marketQuotes = marketQuotes.filter((q) => !isRsiExtreme(q.rsi14));
  }

  const change =
    typeof futuresChange === 'number'
      ? futuresChange
      : market === 'US'
      ? futuresChange.US
      : futuresChange.EU;

  const scored = marketQuotes.map((quote) => ({
    quote,
    score: calculateCandidateScore(quote, change),
    rank: 0,
  }));

  scored.sort((a, b) => b.score.total - a.score.total);

  return scored.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

export function rankTopCandidates(
  quotes: RawQuoteData[],
  futuresChange: number | { EU: number; US: number },
  options?: ScreeningFilterOptions
): ScoredCandidate[] {
  let targetQuotes = quotes;
  if (options?.rsiFilterActive) {
    targetQuotes = targetQuotes.filter((q) => !isRsiExtreme(q.rsi14));
  }

  const scored = targetQuotes.map((quote) => {
    const change =
      typeof futuresChange === 'number'
        ? futuresChange
        : quote.market === 'US'
        ? futuresChange.US
        : futuresChange.EU;
    return {
      quote,
      score: calculateCandidateScore(quote, change),
      rank: 0,
    };
  });

  scored.sort((a, b) => b.score.total - a.score.total);

  return scored.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

export function getDualTopCandidates(
  quotes: RawQuoteData[],
  futuresChange: number | { EU: number; US: number },
  options?: ScreeningFilterOptions
): {
  topEU: ScoredCandidate | null;
  topUS: ScoredCandidate | null;
  rankedEU: ScoredCandidate[];
  rankedUS: ScoredCandidate[];
  allRanked: ScoredCandidate[];
} {
  const rankedEU = rankMarketCandidates(quotes, 'EU', futuresChange, options);
  const rankedUS = rankMarketCandidates(quotes, 'US', futuresChange, options);
  const allRanked = rankTopCandidates(quotes, futuresChange, options);

  return {
    topEU: rankedEU.length > 0 ? rankedEU[0] : null,
    topUS: rankedUS.length > 0 ? rankedUS[0] : null,
    rankedEU,
    rankedUS,
    allRanked,
  };
}

export function buildExecutionSetup(
  topCandidate: ScoredCandidate | null,
  catalyst: GeminiCatalystAnalysis | null,
  session: 'EU' | 'US' | 'GLOBAL'
): ExecutionSetup {
  const cutoffTime =
    topCandidate?.quote?.market === 'US'
      ? '17:30 CET'
      : topCandidate?.quote?.market === 'EU'
      ? '11:30 CET'
      : session === 'US'
      ? '17:30 CET'
      : '11:30 CET';

  if (!topCandidate) {
    return {
      candidate: {} as RawQuoteData,
      decision: 'NESSUN_TRADE',
      reasonNoTrade: 'Nessun titolo presente o analizzato per la sessione.',
      direction: 'NESSUNA',
      strategy: 'Nessun setup',
      triggerLevel: null,
      vwapCondition: 'N/A',
      volumeCondition: 'N/A',
      stopLossLevel: null,
      target1Level: null,
      target2Level: null,
      riskRewardRatio: null,
      invalidationConditions: ['Nessun titolo idoneo'],
      cutoffTime,
      catalystAnalysis: null,
      dynamicBreakeven: null,
    };
  }

  const quote = topCandidate.quote;
  const score = topCandidate.score.total;

  // Strict Data Completeness Check: Price and ATR must be real numbers
  const price = quote.preMarketPrice ?? quote.currentPrice;
  if (price == null || price <= 0) {
    return {
      candidate: quote,
      decision: 'NESSUN_TRADE',
      reasonNoTrade: `Prezzo di mercato non disponibile dal feed per ${quote.ticker}. Regola ferrea: nessun trade senza prezzo reale certificato.`,
      direction: 'NESSUNA',
      strategy: 'Nessun setup',
      triggerLevel: null,
      vwapCondition: 'N/A',
      volumeCondition: 'N/A',
      stopLossLevel: null,
      target1Level: null,
      target2Level: null,
      riskRewardRatio: null,
      invalidationConditions: ['Prezzo mancante'],
      cutoffTime,
      catalystAnalysis: catalyst,
      dynamicBreakeven: null,
    };
  }

  if (quote.atr14 == null || quote.atr14 <= 0) {
    return {
      candidate: quote,
      decision: 'NESSUN_TRADE',
      reasonNoTrade: `ATR(14) giornaliero non calcolabile per ${quote.ticker} (storico sedute insufficiente o non disponibile). Regola: nessun trade senza misura oggettiva della volatilità.`,
      direction: 'NESSUNA',
      strategy: 'Nessun setup',
      triggerLevel: null,
      vwapCondition: 'N/A',
      volumeCondition: 'N/A',
      stopLossLevel: null,
      target1Level: null,
      target2Level: null,
      riskRewardRatio: null,
      invalidationConditions: ['ATR non disponibile'],
      cutoffTime,
      catalystAnalysis: catalyst,
      dynamicBreakeven: null,
    };
  }

  const isGapLong = (quote.gapPercent ?? 0) >= 0;

  // Filter 1: Minimum score requirement
  if (score < MIN_QUALIFICATION_THRESHOLDS.minScore) {
    return {
      candidate: quote,
      decision: 'NESSUN_TRADE',
      reasonNoTrade: `Punteggio di candidatura (${score}/100) inferiore alla soglia minima di rigore (${MIN_QUALIFICATION_THRESHOLDS.minScore}/100). Preservazione del capitale: nessun trade forzato con score insufficiente.`,
      direction: 'NESSUNA',
      strategy: 'Nessun setup',
      triggerLevel: null,
      vwapCondition: 'N/A',
      volumeCondition: 'N/A',
      stopLossLevel: null,
      target1Level: null,
      target2Level: null,
      riskRewardRatio: null,
      invalidationConditions: ['Filtri minimi di momentum e coerenza non raggiunti'],
      cutoffTime,
      catalystAnalysis: catalyst,
      dynamicBreakeven: null,
    };
  }

  // Filter 2: Gemini catalyst check
  if (catalyst && catalyst.decisione === 'NESSUN_TRADE') {
    return {
      candidate: quote,
      decision: 'NESSUN_TRADE',
      reasonNoTrade: `Analisi catalizzatore negativa o assente: ${catalyst.catalizzatore}. Rischi: ${catalyst.rischi.join(', ')}.`,
      direction: 'NESSUNA',
      strategy: 'Nessun setup',
      triggerLevel: null,
      vwapCondition: 'N/A',
      volumeCondition: 'N/A',
      stopLossLevel: null,
      target1Level: null,
      target2Level: null,
      riskRewardRatio: null,
      invalidationConditions: catalyst.condizioni_invalidazione,
      cutoffTime,
      catalystAnalysis: catalyst,
      dynamicBreakeven: null,
    };
  }

  const direction: 'LONG' | 'SHORT' = catalyst?.direzione === 'SHORT' ? 'SHORT' : isGapLong ? 'LONG' : 'SHORT';
  const atr = quote.atr14;

  // Determine Strategy based on real RVOL and real Gap
  const isGapAndGo = (quote.rvol ?? 1) >= 1.6 && Math.abs(quote.gapPercent ?? 0) >= (session === 'EU' ? 0.9 : 1.5);
  const strategy = isGapAndGo ? 'Gap and Go' : 'Opening Range Breakout (5m / 15m)';

  let triggerLevel: number;
  let stopLossLevel: number;
  let target1Level: number;
  let target2Level: number;

  const tightRisk = Math.max(+(atr * 0.40).toFixed(2), +(price * 0.005).toFixed(2));
  const normalRisk = Math.max(+(atr * 0.50).toFixed(2), +(price * 0.007).toFixed(2));
  const conservativeRisk = Math.max(+(atr * 0.75).toFixed(2), +(price * 0.010).toFixed(2));

  let stopLossTight: number;
  let stopLossConservative: number;
  let suggestedKoBarrier: number;

  if (direction === 'LONG') {
    triggerLevel = +(price * 1.002).toFixed(2);
    stopLossLevel = +(triggerLevel - normalRisk).toFixed(2);
    stopLossTight = +(triggerLevel - tightRisk).toFixed(2);
    stopLossConservative = +(triggerLevel - conservativeRisk).toFixed(2);
    // Knock-Out Barrier must be comfortably below conservative stop (> 2.6x distance)
    suggestedKoBarrier = +(triggerLevel - normalRisk * 2.65).toFixed(2);
    target1Level = +(triggerLevel + normalRisk * 1.6).toFixed(2);
    target2Level = +(triggerLevel + normalRisk * 2.8).toFixed(2);
  } else {
    triggerLevel = +(price * 0.998).toFixed(2);
    stopLossLevel = +(triggerLevel + normalRisk).toFixed(2);
    stopLossTight = +(triggerLevel + tightRisk).toFixed(2);
    stopLossConservative = +(triggerLevel + conservativeRisk).toFixed(2);
    // Knock-Out Barrier must be comfortably above conservative stop (> 2.6x distance)
    suggestedKoBarrier = +(triggerLevel + normalRisk * 2.65).toFixed(2);
    target1Level = +(triggerLevel - normalRisk * 1.6).toFixed(2);
    target2Level = +(triggerLevel - normalRisk * 2.8).toFixed(2);
  }

  const riskRewardRatio = 1.6;
  const atrPercent = price > 0 ? +((atr / price) * 100).toFixed(2) : null;

  const vwapCondition =
    direction === 'LONG'
      ? 'Prezzo stabilmente SOPRA il VWAP intraday dal minuto 5. Non entrare se il prezzo ritraccia sotto il VWAP.'
      : 'Prezzo stabilmente SOTTO il VWAP intraday dal minuto 5. Non entrare se il prezzo risale sopra il VWAP.';

  const volumeCondition =
    direction === 'LONG'
      ? 'Volume sulla candela di breakout almeno 1.5x rispetto al volume medio delle prime candele a 1 minuto.'
      : 'Volume vendite in accelerazione al test del breakdown con spread bid/ask compatto.';

  const invalidationConditions = [
    `Rottura e chiusura 5 min oltre lo Stop Loss sul sottostante a ${stopLossLevel} ${quote.currency}`,
    `Inversione del VWAP intraday con candela di rigetto contraria`,
    `Superamento dell'orario limite di permanenza (${cutoffTime}) senza raggiungimento del Target 1`,
    ...(catalyst?.condizioni_invalidazione || []),
  ];

  // Baseline Trade Republic Knock-Out Dynamic Breakeven (1€ broker fee each way + 0.02€ spread)
  const defaultLeverage = 10;
  const defaultBarrierDist = Math.abs(triggerLevel - suggestedKoBarrier);
  const defaultStopDist = Math.abs(triggerLevel - stopLossLevel);
  const defaultCertPrice = Math.max(+(defaultBarrierDist / defaultLeverage).toFixed(2), 1.5);
  const defaultRiskEur = 100;
  const lossRatioOnCert = triggerLevel > 0 ? defaultStopDist / triggerLevel : 0.01;
  const estimatedLossPerCert = defaultCertPrice * lossRatioOnCert * defaultLeverage;
  const defaultLossPerCert = Math.max(estimatedLossPerCert, 0.2);
  const defaultSuggestedCerts = Math.max(1, Math.floor(defaultRiskEur / defaultLossPerCert));
  const defaultInvestedEur = +(defaultSuggestedCerts * defaultCertPrice).toFixed(2);

  const dynamicBreakeven = calculateDynamicBreakeven(
    triggerLevel,
    direction === 'LONG',
    defaultLeverage,
    defaultCertPrice,
    defaultSuggestedCerts,
    defaultInvestedEur,
    atr,
    0.02,
    1.00
  );

  return {
    candidate: quote,
    decision: 'TRADE',
    direction,
    strategy,
    triggerLevel,
    vwapCondition,
    volumeCondition,
    stopLossLevel,
    stopLossTight,
    stopLossConservative,
    suggestedKoBarrier,
    atrValue: atr,
    atrPercent,
    marketType: quote.market,
    target1Level,
    target2Level,
    riskRewardRatio,
    invalidationConditions,
    cutoffTime,
    catalystAnalysis: catalyst,
    dynamicBreakeven,
  };
}

export function calculateDynamicBreakeven(
  entryPrice: number,
  isLong: boolean,
  leverage: number,
  certPrice: number,
  suggestedCertificates: number,
  totalInvestedEur: number,
  atr: number,
  spreadEur: number = 0.02,
  brokerFeeEur: number = 1.0
): DynamicBreakevenInfo {
  // Roundtrip broker fees (buy + sell, e.g. 1€ + 1€ in Trade Republic)
  const brokerRoundtrip = brokerFeeEur * 2;
  // Total spread cost on all certificates
  const spreadCostEur = spreadEur * suggestedCertificates;
  const totalFrictionEur = +(brokerRoundtrip + spreadCostEur).toFixed(2);

  // Capital moving on the underlying = invested in cert * leverage
  const effectiveCapitalInStock = totalInvestedEur * leverage;

  // Points on underlying needed to offset total friction
  const pointsToBreakeven =
    effectiveCapitalInStock > 0 && entryPrice > 0
      ? +((totalFrictionEur * entryPrice) / effectiveCapitalInStock).toFixed(2)
      : 0;

  const percentToBreakeven =
    entryPrice > 0 ? +((pointsToBreakeven / entryPrice) * 100).toFixed(3) : 0;

  const underlyingBreakevenPrice = isLong
    ? +(entryPrice + pointsToBreakeven).toFixed(2)
    : +(entryPrice - pointsToBreakeven).toFixed(2);

  const frictionVsAtrPercent =
    atr > 0 ? +((pointsToBreakeven / atr) * 100).toFixed(1) : 0;

  let frictionStatus: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' = 'LOW';
  if (frictionVsAtrPercent > 35) {
    frictionStatus = 'CRITICAL';
  } else if (frictionVsAtrPercent > 20) {
    frictionStatus = 'HIGH';
  } else if (frictionVsAtrPercent > 10) {
    frictionStatus = 'MODERATE';
  }

  return {
    spreadEur,
    brokerFeeEur,
    totalFrictionEur,
    underlyingBreakevenPrice,
    pointsToBreakeven,
    percentToBreakeven,
    frictionVsAtrPercent,
    frictionStatus,
  };
}

export function generatePnLScenarios(
  setup: ExecutionSetup,
  input: KnockOutCalculatorInput,
  certPrice: number,
  suggestedCertificates: number,
  totalInvestedEur: number,
  frictionEur: number,
  breakevenPoints: number,
  stopDistance: number,
  potentialLossEur: number
): PnLScenario[] {
  const entryPrice = setup.triggerLevel ?? setup.candidate.preMarketPrice ?? setup.candidate.currentPrice ?? 0;
  const isLong = setup.direction === 'LONG';
  const leverage = input.leverage || 1;
  const capital = input.accountCapital || 10000;

  const buildScenario = (
    id: string,
    label: string,
    rMultiple: number,
    targetPrice: number,
    notes: string,
    opts: { isBreakeven?: boolean; isStop?: boolean; isKnockOut?: boolean } = {}
  ): PnLScenario => {
    const rawDiff = isLong ? targetPrice - entryPrice : entryPrice - targetPrice;
    const underlyingChangePercent = entryPrice > 0 ? +((rawDiff / entryPrice) * 100).toFixed(2) : 0;

    let certEstimatedPrice: number;
    let grossPnlEur: number;
    let netPnlEur: number;

    if (opts.isKnockOut) {
      certEstimatedPrice = 0;
      grossPnlEur = -totalInvestedEur;
      netPnlEur = -totalInvestedEur;
    } else if (opts.isBreakeven) {
      certEstimatedPrice = +(certPrice + frictionEur / Math.max(1, suggestedCertificates)).toFixed(3);
      grossPnlEur = +frictionEur.toFixed(2);
      netPnlEur = 0;
    } else if (opts.isStop) {
      certEstimatedPrice = Math.max(0.01, +(certPrice * (1 + (underlyingChangePercent / 100) * leverage)).toFixed(3));
      grossPnlEur = +(suggestedCertificates * (certEstimatedPrice - certPrice)).toFixed(2);
      netPnlEur = -potentialLossEur;
    } else {
      certEstimatedPrice = Math.max(0.01, +(certPrice * (1 + (underlyingChangePercent / 100) * leverage)).toFixed(3));
      grossPnlEur = +(suggestedCertificates * (certEstimatedPrice - certPrice)).toFixed(2);
      netPnlEur = +(grossPnlEur - frictionEur).toFixed(2);
    }

    const capitalRoiPercent = +((netPnlEur / capital) * 100).toFixed(2);

    return {
      id,
      label,
      rMultiple,
      underlyingPrice: +targetPrice.toFixed(2),
      underlyingChangePercent,
      certEstimatedPrice,
      certChangePercent: +(underlyingChangePercent * leverage).toFixed(2),
      grossPnlEur,
      netPnlEur,
      capitalRoiPercent,
      notes,
      ...opts,
    };
  };

  const t2Price = setup.target2Level ?? (isLong ? entryPrice + stopDistance * 2.8 : entryPrice - stopDistance * 2.8);
  const t1Price = setup.target1Level ?? (isLong ? entryPrice + stopDistance * 1.6 : entryPrice - stopDistance * 1.6);
  const tHalfPrice = isLong ? entryPrice + stopDistance * 0.8 : entryPrice - stopDistance * 0.8;
  const bePrice = isLong ? entryPrice + breakevenPoints : entryPrice - breakevenPoints;
  const pullbackPrice = isLong ? entryPrice - stopDistance * 0.5 : entryPrice + stopDistance * 0.5;
  const stopPrice = setup.stopLossLevel ?? (isLong ? entryPrice - stopDistance : entryPrice + stopDistance);
  const koPrice = input.barrierStrike;

  return [
    buildScenario('t2', 'Target 2 (+2.8R - Trend Esteso)', 2.8, t2Price, 'Massimo target intraday con trailing vwap'),
    buildScenario('t1', 'Target 1 (+1.6R - Presa 70% Profitto)', 1.6, t1Price, 'Target primario: chiusura parziale e stop a BE'),
    buildScenario('half', 'Pullback Favorevole (+0.8R)', 0.8, tHalfPrice, 'Scalping intermedio o gestione protettiva'),
    buildScenario('be', 'Breakeven Dinamico (0.0R Netto)', 0, bePrice, 'Sottostante necessario per assorbire spread e fee', { isBreakeven: true }),
    buildScenario('pullback', 'Drawdown Transitorio (-0.5R)', -0.5, pullbackPrice, 'Rintraccio fisiologico pre-breakout'),
    buildScenario('stop', 'Stop Loss Tecnico (-1.0R)', -1.0, stopPrice, 'Chiusura disciplinata al rischio predefinito 1%', { isStop: true }),
    buildScenario('ko', 'Stress Test Knock-Out (-100% Wipeout)', -100, koPrice, 'Liquidazione totale del certificato per gap o spike', { isKnockOut: true }),
  ];
}

export function calculateDerivativeStressReport(
  entryPrice: number,
  stopLoss: number,
  barrierStrike: number,
  stopDistance: number,
  barrierDistance: number,
  safetyRatio: number,
  isLong: boolean,
  atr: number,
  frictionVsAtrPercent: number,
  leverage: number,
  atrPercent: number | null
): DerivativeStressReport {
  const criticalReasons: string[] = [];
  const warningReasons: string[] = [];
  const passReasons: string[] = [];

  const barrierVsAtrRatio = atr > 0 ? +(barrierDistance / atr).toFixed(2) : 0;

  // 1. Strike vs Stop Loss direct conflict
  if (isLong && barrierStrike >= stopLoss) {
    criticalReasons.push(
      `Barriera strike (${barrierStrike}) superiore o uguale allo Stop Loss (${stopLoss}): il Knock-Out salta prima dello stop!`
    );
  } else if (!isLong && barrierStrike <= stopLoss) {
    criticalReasons.push(
      `Barriera strike (${barrierStrike}) inferiore o uguale allo Stop Loss (${stopLoss}): il Knock-Out salta prima dello stop!`
    );
  }

  // 2. Safety Ratio (Barrier vs Stop Distance)
  if (safetyRatio < 1.6) {
    criticalReasons.push(
      `Distanza barriera critica (${safetyRatio}x vs min 1.6x stop): margine insufficiente contro spike di apertura.`
    );
  } else if (safetyRatio < 2.2) {
    warningReasons.push(
      `Distanza barriera moderata (${safetyRatio}x stop): raccomandato > 2.2x per evitare flash-crash.`
    );
  } else {
    passReasons.push(`Barriera KO distante ${safetyRatio}x lo stop loss (ottimo buffer protettivo).`);
  }

  // 3. Barrier vs ATR
  if (barrierVsAtrRatio < 0.7) {
    criticalReasons.push(
      `Barriera troppo vicina rispetto all'ATR giornaliero (${barrierVsAtrRatio}x ATR vs min 0.7x): vulnerabile alla normale volatilità intraday.`
    );
  } else if (barrierVsAtrRatio < 1.1) {
    warningReasons.push(
      `Barriera entro il range medio giornaliero (${barrierVsAtrRatio}x ATR): monitorare espansione di volatilità.`
    );
  } else {
    passReasons.push(`Barriera oltre 1.1x ATR (${barrierVsAtrRatio}x ATR): eccellente isolamento da rumore statistico.`);
  }

  // 4. Friction vs ATR
  if (frictionVsAtrPercent > 35) {
    criticalReasons.push(
      `Attrito spread e commissioni eccessivo (${frictionVsAtrPercent}% dell'ATR): il trade parte con un handicap matematico proibitivo.`
    );
  } else if (frictionVsAtrPercent > 20) {
    warningReasons.push(
      `Attrito spread significativo (${frictionVsAtrPercent}% dell'ATR): raccomandato eseguire solo con spread compatto.`
    );
  } else {
    passReasons.push(`Attrito ridotto (${frictionVsAtrPercent}% dell'ATR): breakeven rapido e favorevole.`);
  }

  // 5. Excessive Leverage with high ATR
  if (leverage > 25 && (atrPercent ?? 0) > 2.5) {
    warningReasons.push(
      `Leva ${leverage}x elevata su titolo ad alta volatilità (ATR ${atrPercent}%): rischio oscillazione aggressiva.`
    );
  }

  // Calculate stress score (0 to 100)
  let score = 100;
  if (criticalReasons.length > 0) score -= 50 * criticalReasons.length;
  if (safetyRatio < 2.0) score -= 15;
  if (barrierVsAtrRatio < 1.0) score -= 15;
  if (frictionVsAtrPercent > 20) score -= 15;
  if (leverage > 25) score -= 10;
  const stressScore = Math.max(0, Math.min(100, score));

  let filterStatus: 'PASS' | 'WARNING' | 'CRITICAL_BLOCKED' = 'PASS';
  if (criticalReasons.length > 0 || stressScore < 45) {
    filterStatus = 'CRITICAL_BLOCKED';
  } else if (warningReasons.length > 0 || stressScore < 75) {
    filterStatus = 'WARNING';
  }

  const canExecute = filterStatus !== 'CRITICAL_BLOCKED';

  return {
    stressScore,
    filterStatus,
    barrierVsAtrRatio,
    barrierDistancePoints: +barrierDistance.toFixed(2),
    barrierSafetyRatio: safetyRatio,
    criticalReasons,
    warningReasons,
    passReasons,
    canExecute,
  };
}

export function calculateKnockOutSafety(
  setup: ExecutionSetup,
  input: KnockOutCalculatorInput
): KnockOutSafetyCheck {
  const entryPrice = setup.triggerLevel ?? setup.candidate.preMarketPrice ?? setup.candidate.currentPrice ?? 0;
  const stopLoss = setup.stopLossLevel ?? 0;
  const barrierStrike = input.barrierStrike;
  const isLong = setup.direction === 'LONG';
  const atr = setup.atrValue ?? setup.candidate.atr14 ?? (entryPrice * 0.02);
  const spreadEur = input.spreadEur ?? 0.02;
  const brokerFeeEur = input.brokerFeeEur ?? 1.0;

  if (entryPrice <= 0 || stopLoss <= 0 || barrierStrike <= 0) {
    const emptyBreakeven: DynamicBreakevenInfo = {
      spreadEur,
      brokerFeeEur,
      totalFrictionEur: 0,
      underlyingBreakevenPrice: 0,
      pointsToBreakeven: 0,
      percentToBreakeven: 0,
      frictionVsAtrPercent: 0,
      frictionStatus: 'LOW',
    };
    const emptyStress: DerivativeStressReport = {
      stressScore: 0,
      filterStatus: 'CRITICAL_BLOCKED',
      barrierVsAtrRatio: 0,
      barrierDistancePoints: 0,
      barrierSafetyRatio: 0,
      criticalReasons: ['Livelli di ingresso, stop o barriera non disponibili.'],
      warningReasons: [],
      passReasons: [],
      canExecute: false,
    };

    return {
      entryPrice,
      stopLoss,
      barrierStrike,
      stopDistance: 0,
      barrierDistance: 0,
      safetyRatio: 0,
      isSafe: false,
      warningMessage: 'Livelli di ingresso, stop o barriera non disponibili.',
      maxRiskEur: +(input.accountCapital * (input.maxRiskPercent / 100)).toFixed(2),
      suggestedCertificates: 0,
      totalInvestedEur: 0,
      potentialLossEur: 0,
      potentialGainT1Eur: 0,
      potentialGainT2Eur: 0,
      breakeven: emptyBreakeven,
      scenarios: [],
      stressReport: emptyStress,
    };
  }

  const stopDistance = Math.abs(entryPrice - stopLoss);
  const barrierDistance = Math.abs(entryPrice - barrierStrike);

  // Safety ratio: Barrier distance vs Stop Loss distance
  const safetyRatio = stopDistance > 0 ? +(barrierDistance / stopDistance).toFixed(2) : 0;
  const isSafeBasic = safetyRatio >= 2.0 && (isLong ? barrierStrike < stopLoss : barrierStrike > stopLoss);

  // 1% Risk Position Sizing
  const maxRiskEur = +(input.accountCapital * (input.maxRiskPercent / 100)).toFixed(2);

  // Estimate KO certificate price if not supplied
  const certPrice = input.certificatePrice && input.certificatePrice > 0
    ? input.certificatePrice
    : Math.max(+(barrierDistance / (input.leverage > 10 ? 10 : 1)).toFixed(2), 1.5);

  // Estimated loss per certificate if stop triggers
  const lossRatioOnCert = stopDistance / entryPrice; // percentage drop on underlying
  const estimatedLossPerCert = certPrice * lossRatioOnCert * input.leverage;
  const validLossPerCert = Math.max(estimatedLossPerCert, 0.2);

  const suggestedCertificates = Math.max(1, Math.floor(maxRiskEur / validLossPerCert));
  const totalInvestedEur = +(suggestedCertificates * certPrice).toFixed(2);
  const potentialLossEur = Math.min(+(suggestedCertificates * validLossPerCert).toFixed(2), maxRiskEur);

  const rewardRatioT1 = setup.riskRewardRatio || 1.6;
  const potentialGainT1Eur = +(potentialLossEur * rewardRatioT1).toFixed(2);
  const potentialGainT2Eur = +(potentialLossEur * 2.8).toFixed(2);

  // Dynamic Breakeven calculation
  const breakeven = calculateDynamicBreakeven(
    entryPrice,
    isLong,
    input.leverage,
    certPrice,
    suggestedCertificates,
    totalInvestedEur,
    atr,
    spreadEur,
    brokerFeeEur
  );

  // Stress Report & Hybrid Filter
  const stressReport = calculateDerivativeStressReport(
    entryPrice,
    stopLoss,
    barrierStrike,
    stopDistance,
    barrierDistance,
    safetyRatio,
    isLong,
    atr,
    breakeven.frictionVsAtrPercent,
    input.leverage,
    setup.atrPercent ?? null
  );

  // Multi-scenario PnL simulation
  const scenarios = generatePnLScenarios(
    setup,
    input,
    certPrice,
    suggestedCertificates,
    totalInvestedEur,
    breakeven.totalFrictionEur,
    breakeven.pointsToBreakeven,
    stopDistance,
    potentialLossEur
  );

  let warningMessage: string | undefined;
  if (!stressReport.canExecute) {
    warningMessage = stressReport.criticalReasons.join(' | ');
  } else if (stressReport.filterStatus === 'WARNING') {
    warningMessage = stressReport.warningReasons.join(' | ');
  }

  const isSafe = stressReport.canExecute && isSafeBasic;

  return {
    entryPrice,
    stopLoss,
    barrierStrike,
    stopDistance: +stopDistance.toFixed(2),
    barrierDistance: +barrierDistance.toFixed(2),
    safetyRatio,
    isSafe,
    warningMessage,
    maxRiskEur,
    suggestedCertificates,
    totalInvestedEur,
    potentialLossEur,
    potentialGainT1Eur,
    potentialGainT2Eur,
    breakeven,
    scenarios,
    stressReport,
  };
}

export function createDefaultSafetyCheck(
  accountCapital: number = 10000,
  maxRiskPercent: number = 1.0
): KnockOutSafetyCheck {
  return {
    entryPrice: 0,
    stopLoss: 0,
    barrierStrike: 0,
    stopDistance: 0,
    barrierDistance: 0,
    safetyRatio: 0,
    isSafe: false,
    warningMessage: 'Livelli non disponibili.',
    maxRiskEur: +(accountCapital * (maxRiskPercent / 100)).toFixed(2),
    suggestedCertificates: 0,
    totalInvestedEur: 0,
    potentialLossEur: 0,
    potentialGainT1Eur: 0,
    potentialGainT2Eur: 0,
    breakeven: {
      spreadEur: 0.02,
      brokerFeeEur: 1.0,
      totalFrictionEur: 0,
      underlyingBreakevenPrice: 0,
      pointsToBreakeven: 0,
      percentToBreakeven: 0,
      frictionVsAtrPercent: 0,
      frictionStatus: 'LOW',
    },
    scenarios: [],
    stressReport: {
      stressScore: 0,
      filterStatus: 'CRITICAL_BLOCKED',
      barrierVsAtrRatio: 0,
      barrierDistancePoints: 0,
      barrierSafetyRatio: 0,
      criticalReasons: ['Setup non attivo'],
      warningReasons: [],
      passReasons: [],
      canExecute: false,
    },
  };
}

function formatCompactNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(0) + 'k';
  return num.toString();
}

export function calculateImpliedVolatilityMetrics(
  quote: RawQuoteData | undefined | null
): ImpliedVolatilityMetrics {
  if (!quote) {
    return {
      impliedVol: 22.0,
      avg30dVol: 22.0,
      riskPremium: 0,
      riskPremiumPercent: 0,
      ivRank: 50,
      regime: 'FAIR',
      label: 'Neutro (Dati Iniziali)',
      gaugePercent: 45,
      implication: 'Dati di volatilità in caricamento dal feed di mercato.',
    };
  }

  const p = quote.preMarketPrice ?? quote.currentPrice ?? quote.prevClose ?? 100;
  const atr = quote.atr14 ?? (p > 0 ? p * 0.018 : 1.5);

  // 1. Determine Historical 30d Average Volatility
  let avg30d = quote.historicalVolatility30d ?? null;
  if (avg30d == null || avg30d <= 0) {
    // Statistically estimated 30d realized volatility from ATR(14)
    avg30d = p > 0 ? +((atr / p) * Math.sqrt(252) * 100).toFixed(1) : 22.5;
  }
  avg30d = Math.max(8.0, Math.min(avg30d, 120.0));

  // 2. Determine Implied Volatility (IV)
  let iv = quote.impliedVolatility ?? null;
  if (iv == null || iv <= 0) {
    const rawGap = Math.abs(quote.gapPercent ?? 0);
    const gapExp = rawGap * 1.35;
    const rvolExp = (quote.rvol ?? 1) > 1.2 ? Math.min(((quote.rvol ?? 1) - 1) * 3.5, 12) : 0;
    iv = +(avg30d * 1.05 + gapExp + rvolExp).toFixed(1);
  }
  iv = Math.max(9.0, Math.min(iv, 150.0));

  // 3. Compute Risk Premium Spread & %
  const riskPremium = +(iv - avg30d).toFixed(1);
  const riskPremiumPercent = avg30d > 0 ? +((riskPremium / avg30d) * 100).toFixed(1) : 0;

  // 4. Calculate IV Rank
  let ivRank = quote.ivRank;
  if (ivRank == null) {
    const lowerBound = avg30d * 0.75;
    const upperBound = Math.max(avg30d * 1.5, iv * 1.15);
    ivRank = Math.min(
      100,
      Math.max(0, Math.round(((iv - lowerBound) / (upperBound - lowerBound)) * 100))
    );
  }

  // 5. Gauge Position Percentage (0 to 100)
  const normalizedGauge = Math.min(
    100,
    Math.max(0, Math.round(45 + riskPremiumPercent * 1.1))
  );

  // 6. Regime classification & tactical derivatives advice
  let regime: 'COMPRESSED' | 'FAIR' | 'ELEVATED' | 'EXTREME' = 'FAIR';
  let label = 'Premio Equo / Neutro';
  let implication = '';

  if (riskPremiumPercent < -5) {
    regime = 'COMPRESSED';
    label = 'Sconto Volatilità (IV < Media 30gg)';
    implication =
      'Volatilità implicita compressa rispetto alla media 30gg. Spread del market maker sui knock-out ridotto al minimo; favorevole a espansioni direzionali repentine.';
  } else if (riskPremiumPercent <= 12) {
    regime = 'FAIR';
    label = 'Premio Equo / Bilanciato';
    implication =
      'Prezzatura in linea con la norma storica a 30 giorni. Spread equilibrato e attrito ordinario per il trading con certificati a leva intraday.';
  } else if (riskPremiumPercent <= 32) {
    regime = 'ELEVATED';
    label = 'Premio al Rischio Elevato';
    implication =
      `Premio al rischio espanso (+${riskPremiumPercent}% rispetto alla media a 30 giorni). I market maker allargano lo spread bid-ask del knock-out: gestire l'uscita a target rigorosamente.`;
  } else {
    regime = 'EXTREME';
    label = 'Rischio Estremo / Volatilità Espansa';
    implication =
      `Sovrapprezzo estremo (+${riskPremiumPercent}% vs media 30gg). Alto rischio di contrazione della volatilità (IV crush) e spread penalizzante; preferire barriere più conservative.`;
  }

  return {
    impliedVol: iv,
    avg30dVol: avg30d,
    riskPremium,
    riskPremiumPercent,
    ivRank,
    regime,
    label,
    gaugePercent: normalizedGauge,
    implication,
  };
}
