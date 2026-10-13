import {
  RawQuoteData,
  ScoredCandidate,
  ScoreBreakdown,
  ExecutionSetup,
  GeminiCatalystAnalysis,
  KnockOutCalculatorInput,
  KnockOutSafetyCheck,
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

export function rankMarketCandidates(
  quotes: RawQuoteData[],
  market: 'EU' | 'US',
  futuresChange: number | { EU: number; US: number }
): ScoredCandidate[] {
  const marketQuotes = quotes.filter((q) => q.market === market);
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
  futuresChange: number | { EU: number; US: number }
): ScoredCandidate[] {
  const scored = quotes.map((quote) => {
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
  futuresChange: number | { EU: number; US: number }
): {
  topEU: ScoredCandidate | null;
  topUS: ScoredCandidate | null;
  rankedEU: ScoredCandidate[];
  rankedUS: ScoredCandidate[];
  allRanked: ScoredCandidate[];
} {
  const rankedEU = rankMarketCandidates(quotes, 'EU', futuresChange);
  const rankedUS = rankMarketCandidates(quotes, 'US', futuresChange);
  const allRanked = rankTopCandidates(quotes, futuresChange);

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

  if (entryPrice <= 0 || stopLoss <= 0 || barrierStrike <= 0) {
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
    };
  }

  const stopDistance = Math.abs(entryPrice - stopLoss);
  const barrierDistance = Math.abs(entryPrice - barrierStrike);

  // Safety ratio: Barrier distance vs Stop Loss distance
  const safetyRatio = stopDistance > 0 ? +(barrierDistance / stopDistance).toFixed(2) : 0;
  const isSafe = safetyRatio >= 2.0 && (isLong ? barrierStrike < stopLoss : barrierStrike > stopLoss);

  let warningMessage: string | undefined;
  if (!isSafe) {
    if (isLong && barrierStrike >= stopLoss) {
      warningMessage = `ALLARME CRITICO: La barriera strike (${barrierStrike}) è superiore o uguale al tuo Stop Loss (${stopLoss})! Il certificato Knock-Out esploderà PRIMA che scatti lo stop.`;
    } else if (!isLong && barrierStrike <= stopLoss) {
      warningMessage = `ALLARME CRITICO: La barriera strike (${barrierStrike}) è inferiore o uguale al tuo Stop Loss (${stopLoss})! Il certificato Knock-Out esploderà PRIMA che scatti lo stop.`;
    } else {
      warningMessage = `PERICOLO KNOCK-OUT: La barriera dista solo ${safetyRatio}x lo stop loss (minimo richiesto: 2.0x). Rischio elevato di liquidazione improvvisa su spike di spread Trade Republic.`;
    }
  }

  // 1% Risk Position Sizing
  const maxRiskEur = +(input.accountCapital * (input.maxRiskPercent / 100)).toFixed(2);

  // Estimate KO certificate price if not supplied (typical TR KO price = distance to strike / ratio, approx ~ distance)
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
  };
}

function formatCompactNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(0) + 'k';
  return num.toString();
}
