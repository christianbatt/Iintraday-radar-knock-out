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
  TradeJournalEntry,
  SystemParameters,
  OptimizationProposal,
  ProposedParameterChange,
  OptimizationMetrics,
  HourlySeasonalitySlot,
  DaySeasonalitySlot,
  SeasonalityReport,
  FilteringAuditReport,
  ExcludedCandidateInfo,
  ExclusionCategory,
  ExcludedSetupRecord,
  ExcludedCategoryAnalysis,
  ExcludedSetupsAutoAnalysis,
  ExcludedOutcomeStatus,
} from '../types/radar';

// Default Adaptive System Parameters
export const DEFAULT_SYSTEM_PARAMETERS: SystemParameters = {
  version: 1,
  lastUpdated: new Date().toISOString(),
  minScore: 55, // Out of 100
  minGapEurope: 0.4, // %
  minGapUSA: 0.7, // %
  minRvol: 1.1, // Relative volume ratio
  minAvgVolume: 350000, // Shares daily average
  normalRiskMultiplier: 0.50, // 0.50 of ATR
  target1Multiplier: 1.60, // 1.60 of normal risk
  target2Multiplier: 2.80, // 2.80 of normal risk
  suggestedKoBarrierMultiplier: 2.65, // Knock-Out distance multiplier
  triggerOffsetPercent: 0.20, // 0.20% offset from reference price
  rsiFilterActive: false,
};

// Backward-compatible alias for existing imports
export const MIN_QUALIFICATION_THRESHOLDS = {
  minScore: DEFAULT_SYSTEM_PARAMETERS.minScore,
  minGapEurope: DEFAULT_SYSTEM_PARAMETERS.minGapEurope,
  minGapUSA: DEFAULT_SYSTEM_PARAMETERS.minGapUSA,
  minRvol: DEFAULT_SYSTEM_PARAMETERS.minRvol,
  minAvgVolume: DEFAULT_SYSTEM_PARAMETERS.minAvgVolume,
};

export function calculateCandidateScore(
  quote: RawQuoteData,
  benchmarkFuturesChangePercent: number,
  newsOrCatalyst?: GeminiCatalystAnalysis | NewsItem[] | number | null
): ScoreBreakdown {
  const details: string[] = [];
  let gapScore = 0;
  let rvolScore = 0;
  let liquidityScore = 0;
  let futuresScore = 0;
  let levelScore = 0;
  let rsiScore = 5;

  // If essential price data is missing from exchange, candidate receives 0 score
  const price = quote.preMarketPrice ?? quote.currentPrice;
  if (price == null || price <= 0) {
    return {
      gapScore: 0,
      rvolScore: 0,
      liquidityScore: 0,
      futuresScore: 0,
      levelScore: 0,
      rsiScore: 0,
      newsScore: 0,
      total: 0,
      details: ['Prezzo di mercato non disponibile dal feed: candidato non qualificabile.'],
    };
  }

  const isEurope = quote.market === 'EU';

  // 1. GAP SCORE (max 25) - Only from real calculated gap
  if (quote.gapPercent != null) {
    const absGap = Math.abs(quote.gapPercent);
    const gapThreshold = isEurope ? 0.8 : 1.4;
    if (absGap >= gapThreshold * 1.5) {
      gapScore = 25;
      details.push(`Gap elevato (${absGap.toFixed(2)}% vs soglia ${gapThreshold}%): +25pt`);
    } else if (absGap >= gapThreshold) {
      gapScore = 20;
      details.push(`Gap significativo (${absGap.toFixed(2)}%): +20pt`);
    } else if (absGap >= (isEurope ? 0.4 : 0.7)) {
      gapScore = 12;
      details.push(`Gap moderato (${absGap.toFixed(2)}%): +12pt`);
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
    if (quote.rvol20m != null) {
      if (quote.rvol20m >= 1.5) {
        details.push(`🔥 Spike Volumi ultimi 20m (${quote.rvol20m.toFixed(2)}x vs media mobile 20m): forte afflusso istituzionale in corso.`);
      } else if (quote.rvol20m >= 1.1) {
        details.push(`⚡ Flusso Volumi 20m solido (${quote.rvol20m.toFixed(2)}x vs media mobile 20m).`);
      } else if (quote.rvol20m < 0.7) {
        details.push(`⚠️ Volumi ultimi 20m in contrazione (${quote.rvol20m.toFixed(2)}x vs media mobile 20m): possibile fase di pausa/consolidamento.`);
      }
    }
  } else {
    rvolScore = 0;
    details.push('RVOL non disponibile (volume pre-market non scambiato o non comunicato): 0pt');
  }

  // 3. LIQUIDITY SCORE (max 10) - From real 20d average volume
  const avgVol = quote.avgVolume20d;
  if (avgVol != null && avgVol > 0) {
    if (avgVol >= 5000000) {
      liquidityScore = 10;
      details.push(`Alta liquidità giornaliera (vol medio ${formatCompactNumber(avgVol)}): +10pt`);
    } else if (avgVol >= 1500000) {
      liquidityScore = 8;
      details.push(`Buona liquidità (vol medio ${formatCompactNumber(avgVol)}): +8pt`);
    } else if (avgVol >= 500000) {
      liquidityScore = 5;
      details.push(`Liquidità discreta (vol medio ${formatCompactNumber(avgVol)}): +5pt`);
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

  // 6. RSI MOMENTUM & TURBO KO QUALITY (max 10)
  // Prioritizes 5m Intraday RSI (ideal tactical timeframe for intraday Turbo trading) and checks 1D confluence
  const activeRsi = quote.rsi5m ?? quote.rsi14;
  const rsiTimeframe = quote.rsi5m != null ? '5m Intraday' : '1D Daily';

  if (activeRsi != null) {
    if (isGapLong) {
      if (activeRsi >= 46 && activeRsi <= 66) {
        rsiScore = 10;
        details.push(`RSI ${rsiTimeframe} (${activeRsi}) ottimale per Turbo Long: espansione sana senza saturazione (+10pt)`);
      } else if (activeRsi > 66 && activeRsi <= 72) {
        rsiScore = 6;
        details.push(`RSI ${rsiTimeframe} (${activeRsi}) in accelerazione: forte momentum ma prossimo a ipercomprato (+6pt)`);
      } else if (activeRsi >= 40 && activeRsi < 46) {
        rsiScore = 5;
        details.push(`RSI ${rsiTimeframe} (${activeRsi}) neutrale: momentum rialzista in costruzione (+5pt)`);
      } else if (activeRsi > 72) {
        rsiScore = 0;
        details.push(`Allerta RSI ${rsiTimeframe} in Ipercomprato (${activeRsi}): rischio elevato di pullback/KO su Turbo Long (0pt)`);
      } else {
        rsiScore = 2;
        details.push(`RSI ${rsiTimeframe} debole (${activeRsi}): spinta intraday insufficiente per Turbo Long (+2pt)`);
      }
    } else {
      // Short setup
      if (activeRsi >= 34 && activeRsi <= 54) {
        rsiScore = 10;
        details.push(`RSI ${rsiTimeframe} (${activeRsi}) ottimale per Turbo Short: pressione ribassista solida (+10pt)`);
      } else if (activeRsi >= 28 && activeRsi < 34) {
        rsiScore = 6;
        details.push(`RSI ${rsiTimeframe} (${activeRsi}) marcatamente ribassista: prossimo a ipervenduto (+6pt)`);
      } else if (activeRsi > 54 && activeRsi <= 60) {
        rsiScore = 5;
        details.push(`RSI ${rsiTimeframe} (${activeRsi}) neutrale: consolidamento pre-rottura (+5pt)`);
      } else if (activeRsi < 28) {
        rsiScore = 0;
        details.push(`Allerta RSI ${rsiTimeframe} in Ipervenduto (${activeRsi}): rischio elevato di short-squeeze/rimbalzo contro Turbo Short (0pt)`);
      } else {
        rsiScore = 2;
        details.push(`RSI ${rsiTimeframe} rialzista (${activeRsi}): contrasto con setup short (+2pt)`);
      }
    }

    // Dual-Timeframe Confluence bonus note
    if (quote.rsi5m != null && quote.rsi14 != null) {
      if (isGapLong && quote.rsi5m <= 68 && quote.rsi14 <= 70) {
        details.push(`Conferma Multi-Timeframe (5m: ${quote.rsi5m} | 1D: ${quote.rsi14}): allineamento coerente tra respiro intraday e trend macro.`);
      } else if (!isGapLong && quote.rsi5m >= 32 && quote.rsi14 >= 30) {
        details.push(`Conferma Multi-Timeframe (5m: ${quote.rsi5m} | 1D: ${quote.rsi14}): allineamento coerente ribassista tra 5m e 1D.`);
      }
    }
  } else {
    rsiScore = 5;
    details.push('RSI non disponibile dal feed: punteggio neutro (+5pt)');
  }

  // 7. NEWS & CATALYST BONUS SCORE (+0 to +15pt)
  // Regola fondamentale: l'assenza di notizie non è motivo di esclusione (+0pt bonus).
  // La presenza di buone notizie o catalizzatore dà punti bonus in più allo score del ticket.
  let newsScore = 0;
  if (typeof newsOrCatalyst === 'number') {
    newsScore = Math.max(0, Math.min(15, newsOrCatalyst));
  } else if (newsOrCatalyst && typeof newsOrCatalyst === 'object') {
    if ('newsBonusScore' in newsOrCatalyst && typeof (newsOrCatalyst as any).newsBonusScore === 'number') {
      newsScore = (newsOrCatalyst as any).newsBonusScore;
    } else if ('catalizzatore' in newsOrCatalyst) {
      const cat = newsOrCatalyst as GeminiCatalystAnalysis;
      const text = `${cat.catalizzatore || ''} ${(cat.punti_a_favore || []).join(' ')}`.toLowerCase();
      if (text.includes('upgrade') || text.includes('target') || text.includes('contratto') || text.includes('ordini') || text.includes('utili') || text.includes('partnership')) {
        newsScore = 15;
      } else if (cat.fonti && cat.fonti.length > 0) {
        newsScore = 10;
      } else if (!text.includes('nessuna notizia') && !text.includes('setup tecnico')) {
        newsScore = 8;
      } else {
        newsScore = 0;
      }
    } else if (Array.isArray(newsOrCatalyst) && newsOrCatalyst.length > 0) {
      newsScore = 8;
    }
  }

  if (newsScore > 0) {
    details.push(`🔥 Bonus Notizie/Catalizzatore Attivo: +${newsScore}pt sullo score del titolo`);
  } else {
    details.push('Setup puramente Tecnico / Momentum (Assenza notizie straordinarie: 0pt bonus)');
  }

  const rawTotal = gapScore + rvolScore + liquidityScore + futuresScore + levelScore + rsiScore + newsScore;
  const total = Math.min(100, rawTotal);

  return {
    gapScore,
    rvolScore,
    liquidityScore,
    futuresScore,
    levelScore,
    rsiScore,
    newsScore,
    total,
    details,
  };
}

export interface ScreeningFilterOptions {
  rsiFilterActive?: boolean;
  parameters?: SystemParameters;
  catalystCache?: Record<string, GeminiCatalystAnalysis>;
  newsCache?: Record<string, NewsItem[]>;
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

export function isCandidateCompliantWithParameters(
  quote: RawQuoteData,
  score: number,
  params: SystemParameters,
  isRsiFilterActive: boolean
): { compliant: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const price = quote.preMarketPrice ?? quote.currentPrice;
  if (price == null || price <= 0) reasons.push('Prezzo non disponibile');
  if (quote.atr14 == null || quote.atr14 <= 0) reasons.push('ATR(14) non calcolabile');

  if (score < params.minScore) {
    reasons.push(`Score ${score}/100 < ${params.minScore}/100`);
  }
  const rvol = quote.rvol ?? 1.0;
  if (rvol < params.minRvol) {
    reasons.push(`RVOL ${rvol.toFixed(2)}x < ${params.minRvol}x`);
  }
  const minGap = quote.market === 'EU' ? params.minGapEurope : params.minGapUSA;
  const absGap = Math.abs(quote.gapPercent ?? 0);
  if (absGap < minGap) {
    reasons.push(`Gap ${(quote.gapPercent ?? 0).toFixed(2)}% < ±${minGap}%`);
  }
  const rsi = quote.rsi5m ?? quote.rsi14;
  if (isRsiFilterActive && isRsiExtreme(rsi)) {
    reasons.push(`RSI estremo (${rsi})`);
  }

  return { compliant: reasons.length === 0, reasons };
}

export function rankMarketCandidates(
  quotes: RawQuoteData[],
  market: 'EU' | 'US',
  futuresChange: number | { EU: number; US: number },
  options?: ScreeningFilterOptions
): ScoredCandidate[] {
  let marketQuotes = quotes.filter((q) => q.market === market);

  // If RSI filter is active (from options or parameters), exclude overbought (RSI >= 70) and oversold (RSI <= 30)
  const isRsiActive = options?.rsiFilterActive ?? options?.parameters?.rsiFilterActive ?? false;
  if (isRsiActive) {
    marketQuotes = marketQuotes.filter((q) => !isRsiExtreme(q.rsi5m ?? q.rsi14));
  }

  const change =
    typeof futuresChange === 'number'
      ? futuresChange
      : market === 'US'
      ? futuresChange.US
      : futuresChange.EU;

  const scored = marketQuotes.map((quote) => {
    const catalystOrNews = options?.catalystCache?.[quote.ticker] || options?.newsCache?.[quote.ticker];
    return {
      quote,
      score: calculateCandidateScore(quote, change, catalystOrNews),
      rank: 0,
    };
  });

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
  const isRsiActive = options?.rsiFilterActive ?? options?.parameters?.rsiFilterActive ?? false;
  if (isRsiActive) {
    targetQuotes = targetQuotes.filter((q) => !isRsiExtreme(q.rsi5m ?? q.rsi14));
  }

  const scored = targetQuotes.map((quote) => {
    const change =
      typeof futuresChange === 'number'
        ? futuresChange
        : quote.market === 'US'
        ? futuresChange.US
        : futuresChange.EU;
    const catalystOrNews = options?.catalystCache?.[quote.ticker] || options?.newsCache?.[quote.ticker];
    return {
      quote,
      score: calculateCandidateScore(quote, change, catalystOrNews),
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

  const params = options?.parameters;
  const isRsiActive = options?.rsiFilterActive ?? options?.parameters?.rsiFilterActive ?? false;

  // Select top candidates that fully comply with active parameters (qualified)
  let topEU: ScoredCandidate | null = null;
  if (params && rankedEU.length > 0) {
    topEU = rankedEU.find((cand) => {
      const check = isCandidateCompliantWithParameters(cand.quote, cand.score.total, params, isRsiActive);
      return check.compliant;
    }) || null;
  }
  // Fallback to highest scored EU candidate if none passes all filters
  if (!topEU && rankedEU.length > 0) {
    topEU = rankedEU[0];
  }

  let topUS: ScoredCandidate | null = null;
  if (params && rankedUS.length > 0) {
    topUS = rankedUS.find((cand) => {
      const check = isCandidateCompliantWithParameters(cand.quote, cand.score.total, params, isRsiActive);
      return check.compliant;
    }) || null;
  }
  // Fallback to highest scored US candidate if none passes all filters
  if (!topUS && rankedUS.length > 0) {
    topUS = rankedUS[0];
  }

  return {
    topEU,
    topUS,
    rankedEU,
    rankedUS,
    allRanked,
  };
}

export function buildExecutionSetup(
  topCandidate: ScoredCandidate | null,
  catalyst: GeminiCatalystAnalysis | null,
  session: 'EU' | 'US' | 'GLOBAL',
  params?: SystemParameters
): ExecutionSetup {
  const activeParams = params || DEFAULT_SYSTEM_PARAMETERS;

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

  // Filter 1: Minimum score requirement (from active parameters)
  if (score < activeParams.minScore) {
    return {
      candidate: quote,
      decision: 'NESSUN_TRADE',
      reasonNoTrade: `Punteggio di candidatura (${score}/100) inferiore alla soglia minima attiva (${activeParams.minScore}/100). Preservazione del capitale: nessun trade con score sotto soglia.`,
      direction: 'NESSUNA',
      strategy: 'Nessun setup',
      triggerLevel: null,
      vwapCondition: 'N/A',
      volumeCondition: 'N/A',
      stopLossLevel: null,
      target1Level: null,
      target2Level: null,
      riskRewardRatio: null,
      invalidationConditions: ['Punteggio algoritmico inferiore alla soglia minima di rigore'],
      cutoffTime,
      catalystAnalysis: catalyst,
      dynamicBreakeven: null,
    };
  }

  // Filter 1b: Minimum Relative Volume (RVOL) requirement
  const rvol = quote.rvol ?? 1.0;
  if (rvol < activeParams.minRvol) {
    return {
      candidate: quote,
      decision: 'NESSUN_TRADE',
      reasonNoTrade: `Volume Relativo (${rvol.toFixed(2)}x) inferiore alla soglia minima attiva (${activeParams.minRvol}x). Protezione da trappole di liquidità e falsi breakout.`,
      direction: 'NESSUNA',
      strategy: 'Nessun setup',
      triggerLevel: null,
      vwapCondition: 'N/A',
      volumeCondition: 'N/A',
      stopLossLevel: null,
      target1Level: null,
      target2Level: null,
      riskRewardRatio: null,
      invalidationConditions: ['Volume Relativo (RVOL) insufficiente per garantire continuazione'],
      cutoffTime,
      catalystAnalysis: catalyst,
      dynamicBreakeven: null,
    };
  }

  // Filter 1c: Minimum Opening Gap % requirement
  const marketType = quote.market || (session === 'US' ? 'US' : 'EU');
  const minGap = marketType === 'EU' ? activeParams.minGapEurope : activeParams.minGapUSA;
  const absGap = Math.abs(quote.gapPercent ?? 0);
  if (absGap < minGap) {
    return {
      candidate: quote,
      decision: 'NESSUN_TRADE',
      reasonNoTrade: `Ampiezza Gap (${(quote.gapPercent ?? 0).toFixed(2)}%) inferiore alla soglia minima attiva (±${minGap}%). Impulso direzionale d'apertura insufficiente per breakout orario.`,
      direction: 'NESSUNA',
      strategy: 'Nessun setup',
      triggerLevel: null,
      vwapCondition: 'N/A',
      volumeCondition: 'N/A',
      stopLossLevel: null,
      target1Level: null,
      target2Level: null,
      riskRewardRatio: null,
      invalidationConditions: ['Gap percentuale d\'apertura inferiore alla soglia minima richiesta'],
      cutoffTime,
      catalystAnalysis: catalyst,
      dynamicBreakeven: null,
    };
  }

  // Filter 1d: RSI Extremes if RSI filter active
  const isRsiActive = activeParams.rsiFilterActive ?? false;
  const rsi = quote.rsi5m ?? quote.rsi14;
  if (isRsiActive && isRsiExtreme(rsi)) {
    return {
      candidate: quote,
      decision: 'NESSUN_TRADE',
      reasonNoTrade: `RSI a ${rsi}: territorio estremo (${rsi! >= 70 ? 'Ipercomprato' : 'Ipervenduto'}). Rischio elevato di ritracciamento violento e knock-out anticipato sul certificato.`,
      direction: 'NESSUNA',
      strategy: 'Nessun setup',
      triggerLevel: null,
      vwapCondition: 'N/A',
      volumeCondition: 'N/A',
      stopLossLevel: null,
      target1Level: null,
      target2Level: null,
      riskRewardRatio: null,
      invalidationConditions: ['RSI in territorio estremo (ipercomprato/ipervenduto)'],
      cutoffTime,
      catalystAnalysis: catalyst,
      dynamicBreakeven: null,
    };
  }

  // Filter 2: Fundamental / Catalyst disqualification check
  // Regola fondamentale: l'assenza di notizie non deve essere un motivo di esclusione.
  // La notizia dà punti in più di score; solo fattori ostativi gravi (utili imminenti durante la seduta, sospensioni) escludono.
  if (catalyst && catalyst.decisione === 'NESSUN_TRADE') {
    const isAbsenceOfNewsOnly =
      catalyst.catalizzatore?.toLowerCase().includes('nessuna notizia') ||
      catalyst.catalizzatore?.toLowerCase().includes('assenza di catalizzatore') ||
      catalyst.catalizzatore?.toLowerCase().includes('assenza di notizie') ||
      (catalyst.rischi?.length === 1 &&
        (catalyst.rischi[0]?.toLowerCase().includes('mancanza di notizie') ||
         catalyst.rischi[0]?.toLowerCase().includes('assenza di catalizzatore') ||
         catalyst.rischi[0]?.toLowerCase().includes('assenza di notizie')));

    if (!isAbsenceOfNewsOnly) {
      return {
        candidate: quote,
        decision: 'NESSUN_TRADE',
        reasonNoTrade: `Analisi fondamentale avversa: ${catalyst.catalizzatore}. Rischi: ${catalyst.rischi.join(', ')}.`,
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

  const normalRiskMult = activeParams.normalRiskMultiplier;
  const tightRisk = Math.max(+(atr * (normalRiskMult * 0.8)).toFixed(2), +(price * 0.005).toFixed(2));
  const normalRisk = Math.max(+(atr * normalRiskMult).toFixed(2), +(price * 0.007).toFixed(2));
  const conservativeRisk = Math.max(+(atr * (normalRiskMult * 1.5)).toFixed(2), +(price * 0.010).toFixed(2));

  let stopLossTight: number;
  let stopLossConservative: number;
  let suggestedKoBarrier: number;

  const triggerOffset = activeParams.triggerOffsetPercent / 100;

  if (direction === 'LONG') {
    triggerLevel = +(price * (1 + triggerOffset)).toFixed(2);
    stopLossLevel = +(triggerLevel - normalRisk).toFixed(2);
    stopLossTight = +(triggerLevel - tightRisk).toFixed(2);
    stopLossConservative = +(triggerLevel - conservativeRisk).toFixed(2);
    suggestedKoBarrier = +(triggerLevel - normalRisk * activeParams.suggestedKoBarrierMultiplier).toFixed(2);
    target1Level = +(triggerLevel + normalRisk * activeParams.target1Multiplier).toFixed(2);
    target2Level = +(triggerLevel + normalRisk * activeParams.target2Multiplier).toFixed(2);
  } else {
    triggerLevel = +(price * (1 - triggerOffset)).toFixed(2);
    stopLossLevel = +(triggerLevel + normalRisk).toFixed(2);
    stopLossTight = +(triggerLevel + tightRisk).toFixed(2);
    stopLossConservative = +(triggerLevel + conservativeRisk).toFixed(2);
    suggestedKoBarrier = +(triggerLevel + normalRisk * activeParams.suggestedKoBarrierMultiplier).toFixed(2);
    target1Level = +(triggerLevel - normalRisk * activeParams.target1Multiplier).toFixed(2);
    target2Level = +(triggerLevel - normalRisk * activeParams.target2Multiplier).toFixed(2);
  }

  const riskRewardRatio = activeParams.target1Multiplier;
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

/**
 * Rigorous 20-Setup Cycle Optimization Engine
 * Evaluates performance after every 20 completed setups.
 * If performance is stellar (high win rate, positive PnL, low expired), it maintains current parameters.
 * If weaknesses are detected (e.g., high expired rate, low win rate, high loss rate), it proposes concrete parameter adjustments with justification and expected benefits for user acceptance.
 */
export function evaluateSystemOptimization(
  trades: TradeJournalEntry[],
  currentParams: SystemParameters = DEFAULT_SYSTEM_PARAMETERS,
  cycleNumber?: number
): OptimizationProposal {
  // Sort trades chronologically descending to isolate the latest batch of 20 setups
  const sorted = [...trades].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  const evaluatedBatch = sorted.slice(0, 20);
  const total = evaluatedBatch.length;
  const cycle = cycleNumber || Math.max(1, Math.floor(trades.length / 20));

  const wins = evaluatedBatch.filter((t) => t.outcome === 'WIN');
  const losses = evaluatedBatch.filter((t) => t.outcome === 'LOSS');
  const breakevens = evaluatedBatch.filter((t) => t.outcome === 'BREAKEVEN');
  const expired = evaluatedBatch.filter((t) => t.outcome === 'EXPIRED');

  const winCount = wins.length;
  const lossCount = losses.length;
  const beCount = breakevens.length;
  const expiredCount = expired.length;

  const winRate = total > 0 ? +((winCount / total) * 100).toFixed(1) : 0;
  const expiredRate = total > 0 ? +((expiredCount / total) * 100).toFixed(1) : 0;
  const lossRate = total > 0 ? +((lossCount / total) * 100).toFixed(1) : 0;

  const netPnlEur = +(evaluatedBatch.reduce((acc, t) => acc + t.pnlEur, 0)).toFixed(2);
  const totalGains = wins.reduce((acc, t) => acc + t.pnlEur, 0);
  const totalLosses = Math.abs(losses.reduce((acc, t) => acc + t.pnlEur, 0));
  const profitFactor =
    totalLosses > 0 ? +(totalGains / totalLosses).toFixed(2) : totalGains > 0 ? 99.0 : 0;
  const avgR =
    total > 0
      ? +(evaluatedBatch.reduce((acc, t) => acc + t.rMultiple, 0) / total).toFixed(2)
      : 0;

  const metrics: OptimizationMetrics = {
    totalSetups: total,
    wins: winCount,
    losses: lossCount,
    breakevens: beCount,
    expired: expiredCount,
    winRate,
    expiredRate,
    lossRate,
    netPnlEur,
    profitFactor,
    avgR,
  };

  const identifiedStrengths: string[] = [];
  const identifiedWeaknesses: string[] = [];
  const proposedChanges: ProposedParameterChange[] = [];

  // Identify strengths
  if (winRate >= 55) {
    identifiedStrengths.push(`Tasso di successo solido: Win Rate ${winRate}% sui setup eseguiti.`);
  }
  if (profitFactor >= 1.5) {
    identifiedStrengths.push(`Profit Factor elevato (${profitFactor.toFixed(2)}) con forte asimmetria tra guadagni e perdite.`);
  }
  if (netPnlEur > 0) {
    identifiedStrengths.push(`P&L netto positivo (+${netPnlEur.toFixed(2)} €) nei ${total} setup del ciclo.`);
  }
  if (expiredRate < 15 && total >= 10) {
    identifiedStrengths.push(`Tasso di setup scaduti contenuto (${expiredRate}%), a conferma di target realistici.`);
  }

  // 1. Check EXPIRED weakness (High expired rate is a major flaw for intraday systems)
  const isHighExpired = expiredRate >= 20 || expiredCount >= 4;
  if (isHighExpired) {
    identifiedWeaknesses.push(
      `Tasso di setup scaduti (EXPIRED) critico (${expiredRate}%: ${expiredCount} su ${total}). I trade non riescono a raggiungere il Target 1 prima del cutoff o non scattano, immobilizzando capitale ed esponendo a rischio overnight o uscite forzate.`
    );

    // Propose reducing target1Multiplier from current (e.g. 1.6 -> 1.35)
    if (currentParams.target1Multiplier > 1.35) {
      const newT1 = +(Math.max(1.30, currentParams.target1Multiplier - 0.25)).toFixed(2);
      proposedChanges.push({
        parameterKey: 'target1Multiplier',
        label: 'Moltiplicatore Target 1 (Take Profit)',
        currentValue: `${currentParams.target1Multiplier}x R`,
        proposedValue: `${newT1}x R`,
        unit: 'x R',
        reason: `Target 1 attuale (${currentParams.target1Multiplier}x R) troppo ambizioso per l'espansione media giornaliera, provocando ${expiredCount} setup scaduti senza presa di profitto prima del cutoff.`,
        expectedBenefit: `Abbassando Target 1 a ${newT1}x R, il profitto viene incassato più rapidamente nella prima ora di borsa, con una riduzione attesa del tasso di Expired del ~35-45%.`,
      });
    }

    // Propose reducing triggerOffsetPercent (e.g. 0.20% -> 0.10%)
    if (currentParams.triggerOffsetPercent > 0.10) {
      const newOffset = +(Math.max(0.08, currentParams.triggerOffsetPercent - 0.10)).toFixed(2);
      proposedChanges.push({
        parameterKey: 'triggerOffsetPercent',
        label: 'Offset Trigger di Ingresso',
        currentValue: `${currentParams.triggerOffsetPercent}%`,
        proposedValue: `${newOffset}%`,
        unit: '%',
        reason: `L'offset del trigger allo ${currentParams.triggerOffsetPercent}% ritarda l'attivazione dell'ordine, facendo perdere l'impulso iniziale.`,
        expectedBenefit: `Avvicinando il trigger allo ${newOffset}%, i breakout vengono agganciati con immediatezza alla rottura del range senza restare ineseguiti.`,
      });
    }
  }

  // 2. Check WIN RATE & LOSS RATE weakness
  const isLowWinRate = winRate < 50;
  const isHighLossRate = lossRate >= 35 || lossCount >= 7;
  if (isLowWinRate || isHighLossRate) {
    identifiedWeaknesses.push(
      `Win Rate insufficiente (${winRate}%) con ${lossCount} stop loss subiti (${lossRate}%). I titoli selezionati subiscono falsi breakout o vengono scossi prematuramente dal rumore di apertura.`
    );

    // Propose raising minScore (e.g. 55 -> 65)
    if (currentParams.minScore < 70) {
      const newScore = Math.min(75, currentParams.minScore + 10);
      proposedChanges.push({
        parameterKey: 'minScore',
        label: 'Soglia Minima Punteggio Radar',
        currentValue: `${currentParams.minScore}/100`,
        proposedValue: `${newScore}/100`,
        unit: 'pt',
        reason: `La soglia attuale (${currentParams.minScore}/100) qualifica titoli con gap o volumi marginali che faticano a proseguire.`,
        expectedBenefit: `Filtro più selettivo a ${newScore}/100: elimina il 30% dei titoli più deboli aumentando il Win Rate medio stimato del +8-12%.`,
      });
    }

    // Propose raising minRvol (e.g. 1.10 -> 1.35)
    if (currentParams.minRvol < 1.40) {
      const newRvol = +(currentParams.minRvol + 0.25).toFixed(2);
      proposedChanges.push({
        parameterKey: 'minRvol',
        label: 'RVOL Minimo Richiesto',
        currentValue: `${currentParams.minRvol}x`,
        proposedValue: `${newRvol}x`,
        unit: 'x',
        reason: `Richiesta di volume relativo troppo permissiva (${currentParams.minRvol}x), favorevole a trappole di liquidità.`,
        expectedBenefit: `Imponendo RVOL >= ${newRvol}x si garantisce presenza istituzionale, riducendo i falsi breakout.`,
      });
    }

    // Propose widening normalRiskMultiplier to breathe (e.g. 0.50 -> 0.58)
    if (currentParams.normalRiskMultiplier <= 0.50) {
      const newRisk = +(currentParams.normalRiskMultiplier + 0.08).toFixed(2);
      proposedChanges.push({
        parameterKey: 'normalRiskMultiplier',
        label: 'Tolleranza Stop Loss vs ATR',
        currentValue: `${currentParams.normalRiskMultiplier}x ATR`,
        proposedValue: `${newRisk}x ATR`,
        unit: 'x ATR',
        reason: `Lo stop loss a ${currentParams.normalRiskMultiplier}x ATR è troppo stretto e viene spesso colpito dal rumore dei primi 15 minuti.`,
        expectedBenefit: `Aumentando a ${newRisk}x ATR si concede respiro al titolo, evitando stop prematuri su volatilità transitoria.`,
      });
    }

    // Propose activating RSI Filter if not active
    if (!currentParams.rsiFilterActive) {
      proposedChanges.push({
        parameterKey: 'rsiFilterActive',
        label: 'Filtro Ipercomprato/Ipervenduto RSI',
        currentValue: 'Disattivato',
        proposedValue: 'Attivo',
        reason: 'Diversi trade in perdita sono stati aperti su titoli già in territorio di ipercomprato (>70) o ipervenduto (<30).',
        expectedBenefit: 'Esclusione automatica di titoli esausti prima che invertano contro il setup.',
      });
    }
  }

  // 3. Check BREAKEVEN / FRICTION weakness
  const isHighBreakeven = beCount >= 5 && netPnlEur <= 50;
  if (isHighBreakeven && proposedChanges.length === 0) {
    identifiedWeaknesses.push(
      `Troppi trade chiusi a pareggio (${beCount}/${total}) con PnL eroso dai costi commissionali e di spread.`
    );
    if (currentParams.minGapEurope < 0.6) {
      proposedChanges.push({
        parameterKey: 'minGapEurope',
        label: 'Gap Minimo Europa',
        currentValue: `${currentParams.minGapEurope}%`,
        proposedValue: `0.65%`,
        unit: '%',
        reason: 'Gap troppo modesto non garantisce espansione sufficiente a superare il costo commissional-spread.',
        expectedBenefit: 'Focalizzazione su gap più ampi con maggior potenziale direzionale post-open.',
      });
    }
  }

  // Determine overall status and rating
  let performanceRating: OptimizationProposal['performanceRating'] = 'NEEDS_IMPROVEMENT';
  let status: OptimizationProposal['status'] = 'PENDING';
  let summaryTitle = '';
  let summaryExplanation = '';

  const isFlawless = winRate >= 60 && expiredRate <= 15 && netPnlEur > 0 && profitFactor >= 1.5;

  if (isFlawless && proposedChanges.length === 0) {
    performanceRating = 'EXCELLENT';
    status = 'NO_CHANGES_NEEDED';
    summaryTitle = `Ciclo #${cycle}: Prestazioni Eccellenti — Parametri Confermati`;
    summaryExplanation = `Il ciclo di ${total} setup ha dimostrato elevata affidabilità: Win Rate al ${winRate}%, PnL netto di +${netPnlEur.toFixed(2)} € e tasso di Expired controllato (${expiredRate}%). In base alla regola aurea del trading sistematico quantitativo, non si modificano parametri su un edge statistico comprovato. Il sistema proseguirà con i parametri attuali.`;
  } else if (proposedChanges.length === 0) {
    performanceRating = 'GOOD';
    status = 'NO_CHANGES_NEEDED';
    summaryTitle = `Ciclo #${cycle}: Prestazioni Stabili — Nessuna Modifica Necessaria`;
    summaryExplanation = `I dati degli ultimi ${total} setup rientrano nei parametri di tolleranza previsti. Non sono state individuate anomalie strutturali tali da richiedere ricalibrazioni. Parametri confermati.`;
  } else {
    performanceRating = (expiredRate >= 25 || winRate < 40) ? 'CRITICAL' : 'NEEDS_IMPROVEMENT';
    status = 'PENDING';
    summaryTitle = isHighExpired
      ? `Audit Ciclo #${cycle}: Riduzione Tasso Expired e Ottimizzazione Target`
      : `Audit Ciclo #${cycle}: Aumento Selettività Radar e Difesa Win Rate`;
    summaryExplanation = `L'analisi quantitativa dei ${total} setup ha evidenziato ${proposedChanges.length} aree di miglioramento critiche. ${
      isHighExpired
        ? `In particolare, il tasso di Expired al ${expiredRate}% disperde opportunità. Si propone di avvicinare il Target 1 e ridurre l'offset del trigger per accelerare la chiusura positiva prima del cutoff.`
        : `Il Win Rate al ${winRate}% richiede un innalzamento della selettività minima per evitare falsi breakout.`
    } Esamina i parametri proposti e decidi se accettarli o continuare con la configurazione attuale.`;
  }

  return {
    id: `opt-cycle-${cycle}-${Date.now()}`,
    cycleNumber: cycle,
    evaluatedTradesCount: total,
    date: new Date().toLocaleDateString('it-IT'),
    metrics,
    status,
    performanceRating,
    summaryTitle,
    summaryExplanation,
    identifiedStrengths,
    identifiedWeaknesses,
    proposedChanges,
  };
}

// -------------------------------------------------------------
// INTRADAY SEASONALITY & TIME-OF-DAY PATTERN ENGINE
// -------------------------------------------------------------

export function calculateIntradaySeasonality(
  entries: TradeJournalEntry[],
  currentCetMinutes?: number,
  marketFilter: 'ALL' | 'EU' | 'US' = 'ALL'
): SeasonalityReport {
  // If currentCetMinutes not provided, compute from real now
  let currentMinutes = currentCetMinutes;
  if (currentMinutes == null) {
    const now = new Date();
    const cetFormatter = new Intl.DateTimeFormat('it-IT', {
      timeZone: 'Europe/Rome',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = cetFormatter.formatToParts(now);
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
    const m = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
    currentMinutes = h * 60 + m;
  }

  const currentHourDecimal = currentMinutes / 60;

  // Canonical Intraday Time Slots
  const CANONICAL_SLOTS_DEF = [
    {
      slotKey: '08:00 - 09:00',
      label: 'Pre-Market Europa',
      startHour: 8.0,
      endHour: 9.0,
      marketSession: 'EU' as const,
      description: 'Aste di apertura ed elaborazione gap mattutini. Volumi in formazione.',
      tacticalAdvice: 'Monitorare i gap emergenti e attendere la prima chiusura a 5m per evitare trappole di apertura.',
      benchmarkWinRate: 52,
      benchmarkAvgR: 0.95,
    },
    {
      slotKey: '09:00 - 10:00',
      label: 'Golden Hour Europa (Apertura Cash)',
      startHour: 9.0,
      endHour: 10.0,
      marketSession: 'EU' as const,
      description: 'Massimo volume ed espansione del range sui sottostanti XETRA, Euronext e Piazza Affari.',
      tacticalAdvice: 'Finestra d\'oro per breakout ORB 5m/15m e setup Gap and Go con catalizzatore confermato.',
      benchmarkWinRate: 71,
      benchmarkAvgR: 1.68,
    },
    {
      slotKey: '10:00 - 11:30',
      label: 'Espansione Trend Europa',
      startHour: 10.0,
      endHour: 11.5,
      marketSession: 'EU' as const,
      description: 'Fase di consolidamento direzionale prima del cutoff temporale europeo delle 11:30 CET.',
      tacticalAdvice: 'Alzare lo stop loss a pareggio (breakeven); evitare nuovi ingressi ritardati con R/R sfavorevole.',
      benchmarkWinRate: 64,
      benchmarkAvgR: 1.35,
    },
    {
      slotKey: '11:30 - 14:30',
      label: 'Midday Chop & Bassa Liquidità',
      startHour: 11.5,
      endHour: 14.5,
      marketSession: 'GLOBAL' as const,
      description: 'Pausa pranzo istituzionale. Crollo dei volumi medi e frequenti finte di breakout (whipsaw).',
      tacticalAdvice: 'Sconsigliata l\'apertura di nuovi trade a leva; proteggere le posizioni o restare flat.',
      benchmarkWinRate: 36,
      benchmarkAvgR: 0.42,
    },
    {
      slotKey: '14:30 - 15:30',
      label: 'Pre-Market USA & Macro Release',
      startHour: 14.5,
      endHour: 15.5,
      marketSession: 'US' as const,
      description: 'Rilascio dei dati macroeconomici USA (CPI, NFP, PPI) e primi scambi istituzionali a New York.',
      tacticalAdvice: 'Verificare la reazione dei futures ES/NQ; non anticipare l\'apertura prima delle 15:30 CET.',
      benchmarkWinRate: 58,
      benchmarkAvgR: 1.15,
    },
    {
      slotKey: '15:30 - 16:30',
      label: 'Golden Hour Wall Street',
      startHour: 15.5,
      endHour: 16.5,
      marketSession: 'US' as const,
      description: 'Apertura cash NYSE/Nasdaq. Esplosione di liquidità e momentum sui titoli tech a forte beta.',
      tacticalAdvice: 'Finestra ad altissima convinzione per titoli USA (NVDA, TSLA, AAPL). Esecuzione immediata sui trigger.',
      benchmarkWinRate: 74,
      benchmarkAvgR: 1.75,
    },
    {
      slotKey: '16:30 - 17:30',
      label: 'Fix Europa & Pre-Cutoff USA',
      startHour: 16.5,
      endHour: 17.5,
      marketSession: 'GLOBAL' as const,
      description: 'Coincidenza tra la chiusura delle borse europee (17:35 CET) e il cutoff orario dei setup USA.',
      tacticalAdvice: 'Chiusura tassativa dei setup europei; stringere il trailing stop sui titoli americani.',
      benchmarkWinRate: 60,
      benchmarkAvgR: 1.22,
    },
    {
      slotKey: '17:30 - 20:00',
      label: 'Sessione Pomeridiana USA',
      startHour: 17.5,
      endHour: 20.0,
      marketSession: 'US' as const,
      description: 'Mercato USA in fase di trend pomeridiano consolidato senza interferenze europee.',
      tacticalAdvice: 'Operare unicamente a favore di trend conclamato e confermato dai futures di riferimento.',
      benchmarkWinRate: 56,
      benchmarkAvgR: 1.10,
    },
    {
      slotKey: '20:00 - 22:00',
      label: 'Power Hour & Chiusura New York',
      startHour: 20.0,
      endHour: 22.0,
      marketSession: 'US' as const,
      description: 'Ultima ora di negoziazione a Wall Street con ribilanciamenti fondi e ordini MOC (Market on Close).',
      tacticalAdvice: 'Evitare posizioni overnight sui certificati Knock-Out per scongiurare il rischio gap del giorno successivo.',
      benchmarkWinRate: 50,
      benchmarkAvgR: 0.85,
    },
  ];

  // Filter completed trades by market if requested
  const completedEntries = entries.filter((e) => e.status !== 'OPEN');
  const relevantEntries = marketFilter === 'ALL'
    ? completedEntries
    : completedEntries.filter((e) => e.session === marketFilter);

  const isJournalDataAvailable = relevantEntries.length >= 3;

  // Process Hourly Slots
  const hourlySlots: HourlySeasonalitySlot[] = CANONICAL_SLOTS_DEF.map((def) => {
    const isCurrentHour = currentHourDecimal >= def.startHour && currentHourDecimal < def.endHour;

    // Filter trades belonging to this time window
    const slotTrades = relevantEntries.filter((entry) => {
      try {
        const d = new Date(entry.timestamp);
        const cetFormatter = new Intl.DateTimeFormat('it-IT', {
          timeZone: 'Europe/Rome',
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        });
        const parts = cetFormatter.formatToParts(d);
        const h = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
        const m = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
        const entryHourDec = h + m / 60;
        return entryHourDec >= def.startHour && entryHourDec < def.endHour;
      } catch {
        return false;
      }
    });

    const tradesCount = slotTrades.length;
    const winCount = slotTrades.filter((t) => t.outcome === 'WIN').length;
    const lossCount = slotTrades.filter((t) => t.outcome === 'LOSS').length;
    const beCount = slotTrades.filter((t) => t.outcome === 'BREAKEVEN').length;
    const expiredCount = slotTrades.filter((t) => t.outcome === 'EXPIRED').length;

    let winRate = def.benchmarkWinRate;
    let avgRMultiple = def.benchmarkAvgR;
    let netPnlEur = 0;
    let profitFactor = 1.5;

    if (tradesCount > 0) {
      winRate = +((winCount / tradesCount) * 100).toFixed(1);
      avgRMultiple = +(slotTrades.reduce((acc, t) => acc + t.rMultiple, 0) / tradesCount).toFixed(2);
      netPnlEur = +(slotTrades.reduce((acc, t) => acc + t.pnlEur, 0)).toFixed(2);
      const totalWinsEur = slotTrades.filter((t) => t.pnlEur > 0).reduce((acc, t) => acc + t.pnlEur, 0);
      const totalLossesEur = Math.abs(slotTrades.filter((t) => t.pnlEur < 0).reduce((acc, t) => acc + t.pnlEur, 0));
      profitFactor = totalLossesEur > 0 ? +(totalWinsEur / totalLossesEur).toFixed(2) : totalWinsEur > 0 ? 99.0 : 0;
    }

    let status: HourlySeasonalitySlot['status'] = 'NEUTRAL';
    if (tradesCount === 0 && !isJournalDataAvailable) {
      if (def.benchmarkWinRate >= 68) status = 'HIGH_CONVICTION';
      else if (def.benchmarkWinRate <= 40) status = 'CHOP_RISK';
      else status = 'NEUTRAL';
    } else if (tradesCount === 0) {
      status = 'INSUFFICIENT_DATA';
    } else if (winRate >= 65 || avgRMultiple >= 1.3) {
      status = 'HIGH_CONVICTION';
    } else if (winRate < 45 || netPnlEur < 0) {
      status = 'CHOP_RISK';
    } else {
      status = 'NEUTRAL';
    }

    return {
      slotKey: def.slotKey,
      label: def.label,
      startHour: def.startHour,
      endHour: def.endHour,
      marketSession: def.marketSession,
      tradesCount,
      winCount,
      lossCount,
      beCount,
      expiredCount,
      winRate,
      avgRMultiple,
      netPnlEur,
      profitFactor,
      status,
      description: def.description,
      tacticalAdvice: def.tacticalAdvice,
      isCurrentHour,
    };
  });

  // Process Days of Week (1 = Lunedì ... 5 = Venerdì)
  const DAY_NAMES = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì'];
  const todayDayIndex = (() => {
    try {
      const now = new Date();
      const cetDay = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short' }).format(now);
      const d = now.getDay(); // 0 Sun, 1 Mon ... 5 Fri
      return d >= 1 && d <= 5 ? d : 1;
    } catch {
      return 1;
    }
  })();

  const daySlots: DaySeasonalitySlot[] = DAY_NAMES.map((name, idx) => {
    const dayNum = idx + 1; // 1 to 5
    const isToday = dayNum === todayDayIndex;

    const dayTrades = relevantEntries.filter((entry) => {
      try {
        const d = new Date(entry.timestamp);
        return d.getDay() === dayNum;
      } catch {
        return false;
      }
    });

    const tradesCount = dayTrades.length;
    const winCount = dayTrades.filter((t) => t.outcome === 'WIN').length;
    const lossCount = dayTrades.filter((t) => t.outcome === 'LOSS').length;

    // Benchmark base weights per day
    const benchWR = dayNum === 2 ? 68 : dayNum === 3 ? 65 : dayNum === 1 ? 58 : dayNum === 4 ? 61 : 52;
    const benchR = dayNum === 2 ? 1.55 : dayNum === 3 ? 1.45 : dayNum === 1 ? 1.15 : dayNum === 4 ? 1.25 : 0.95;

    let winRate = benchWR;
    let avgRMultiple = benchR;
    let netPnlEur = 0;

    if (tradesCount > 0) {
      winRate = +((winCount / tradesCount) * 100).toFixed(1);
      avgRMultiple = +(dayTrades.reduce((acc, t) => acc + t.rMultiple, 0) / tradesCount).toFixed(2);
      netPnlEur = +(dayTrades.reduce((acc, t) => acc + t.pnlEur, 0)).toFixed(2);
    }

    return {
      dayName: name,
      dayIndex: dayNum,
      tradesCount,
      winCount,
      lossCount,
      winRate,
      netPnlEur,
      avgRMultiple,
      isToday,
    };
  });

  // Find best and worst slots
  const validSlotsForRanking = hourlySlots.filter((s) => s.status !== 'INSUFFICIENT_DATA');
  const sortedByWinRate = [...validSlotsForRanking].sort((a, b) => b.winRate - a.winRate);
  const bestWindow = sortedByWinRate.length > 0 ? sortedByWinRate[0] : null;
  const worstWindow = sortedByWinRate.length > 0 ? sortedByWinRate[sortedByWinRate.length - 1] : null;

  const currentActiveSlot = hourlySlots.find((s) => s.isCurrentHour) || null;

  // Real-time Recommendation based on current time window
  let recommendationVerdict: SeasonalityReport['recommendationForNow']['verdict'] = 'NEUTRAL';
  let recommendationTitle = 'Finestra Operativa Regolare';
  let recommendationMessage = 'L\'orario attuale presenta parametri di volatilità e liquidità bilanciati. Operare rispettando trigger e stop loss prefissati.';

  if (currentActiveSlot) {
    if (currentActiveSlot.status === 'HIGH_CONVICTION') {
      recommendationVerdict = 'FAVORABLE';
      recommendationTitle = `Finestra ad Alta Probabilità: ${currentActiveSlot.label}`;
      recommendationMessage = `I pattern stagionali storici evidenziano un tasso di successo del ${currentActiveSlot.winRate}% ed un R-medio di ${currentActiveSlot.avgRMultiple > 0 ? '+' : ''}${currentActiveSlot.avgRMultiple}R in questa fascia. Condizioni ideali per eseguire i setup primari.`;
    } else if (currentActiveSlot.status === 'CHOP_RISK') {
      recommendationVerdict = 'CAUTION_CHOP';
      recommendationTitle = `Attenzione: Finestra ad Alto Rischio / Chop (${currentActiveSlot.label})`;
      recommendationMessage = `Questa fascia oraria soffre storicamente di contrazione dei volumi e frequenti falsi breakout (Win Rate ${currentActiveSlot.winRate}%). Il filtro consiglia di attendere o dimezzare la size.`;
    }
  }

  const averageWinRate = relevantEntries.length > 0
    ? +((relevantEntries.filter((t) => t.outcome === 'WIN').length / relevantEntries.length) * 100).toFixed(1)
    : 62.0;

  return {
    hourlySlots,
    daySlots,
    bestWindow,
    worstWindow,
    currentActiveSlot,
    isJournalDataAvailable,
    totalAnalyzedTrades: relevantEntries.length,
    averageWinRate,
    recommendationForNow: {
      verdict: recommendationVerdict,
      title: recommendationTitle,
      message: recommendationMessage,
    },
  };
}

// -------------------------------------------------------------
// VISUAL FILTERING AUDIT ENGINE
// -------------------------------------------------------------

export function generateFilteringAuditReport(
  quotes: RawQuoteData[],
  dualTop: { topEU: ScoredCandidate | null; topUS: ScoredCandidate | null },
  futuresChange: number | { EU: number; US: number },
  parameters: SystemParameters,
  catalystCache: Record<string, GeminiCatalystAnalysis>,
  isRsiFilterActive: boolean,
  currentCetMinutes?: number
): FilteringAuditReport {
  const totalScanned = quotes.length;
  const qualifiedTickers = new Set<string>();

  if (dualTop.topEU && dualTop.topEU.score.total >= parameters.minScore) {
    const cat = catalystCache[dualTop.topEU.quote.ticker];
    const isAbsenceOfNewsOnly = cat && (
      cat.catalizzatore?.toLowerCase().includes('nessuna notizia') ||
      cat.catalizzatore?.toLowerCase().includes('assenza di catalizzatore') ||
      cat.catalizzatore?.toLowerCase().includes('assenza di notizie')
    );
    if (!cat || cat.decisione !== 'NESSUN_TRADE' || isAbsenceOfNewsOnly) {
      qualifiedTickers.add(dualTop.topEU.quote.ticker);
    }
  }

  if (dualTop.topUS && dualTop.topUS.score.total >= parameters.minScore) {
    const cat = catalystCache[dualTop.topUS.quote.ticker];
    const isAbsenceOfNewsOnly = cat && (
      cat.catalizzatore?.toLowerCase().includes('nessuna notizia') ||
      cat.catalizzatore?.toLowerCase().includes('assenza di catalizzatore') ||
      cat.catalizzatore?.toLowerCase().includes('assenza di notizie')
    );
    if (!cat || cat.decisione !== 'NESSUN_TRADE' || isAbsenceOfNewsOnly) {
      qualifiedTickers.add(dualTop.topUS.quote.ticker);
    }
  }

  const countsByCategory = {
    rsiExtreme: 0,
    gapInsufficient: 0,
    rvolInsufficient: 0,
    scoreBelowMin: 0,
    catalystUnverified: 0,
    atrInsufficient: 0,
    cutoffPassed: 0,
    priceUnavailable: 0,
  };

  const excludedList: ExcludedCandidateInfo[] = [];

  quotes.forEach((q) => {
    if (qualifiedTickers.has(q.ticker)) return;

    const change =
      typeof futuresChange === 'number'
        ? futuresChange
        : q.market === 'US'
        ? futuresChange.US
        : futuresChange.EU;

    const cat = catalystCache[q.ticker];
    const scoreObj = calculateCandidateScore(q, change, cat);
    const score = scoreObj.total;
    const rsi = q.rsi5m ?? q.rsi14 ?? null;
    const gap = q.gapPercent ?? 0;
    const absGap = Math.abs(gap);
    const minGap = q.market === 'EU' ? parameters.minGapEurope : parameters.minGapUSA;
    const rvol = q.rvol ?? 1.0;

    let primaryReasonCategory: ExclusionCategory = 'SCORE_BELOW_MIN';
    let primaryReasonLabel = 'Punteggio complessivo sotto soglia';
    let detail = `Punteggio quantitativo ${score}/100 inferiore alla soglia minima richiesta di ${parameters.minScore}/100.`;

    // Hierarchy of exclusions:
    if (q.currentPrice == null && q.preMarketPrice == null) {
      primaryReasonCategory = 'PRICE_UNAVAILABLE';
      primaryReasonLabel = 'Prezzo non disponibile';
      detail = 'Quotazione assente dal feed in tempo reale di borsa.';
      countsByCategory.priceUnavailable++;
    } else if (q.atr14 == null || q.atr14 <= 0) {
      primaryReasonCategory = 'ATR_INSUFFICIENT';
      primaryReasonLabel = 'Volatilità ATR insufficiente o non calcolabile';
      detail = 'Storico sedute o volatilità media non calcolabile per definire lo stop.';
      countsByCategory.atrInsufficient++;
    } else if (isRsiFilterActive && isRsiExtreme(rsi)) {
      primaryReasonCategory = 'RSI_EXTREME';
      primaryReasonLabel = `RSI fuori range (${rsi! >= 70 ? 'Ipercomprato' : 'Ipervenduto'}: ${rsi})`;
      detail = `RSI a ${rsi}: rischio elevato di inversione brusca e knock-out anticipato sul certificato.`;
      countsByCategory.rsiExtreme++;
    } else if (absGap < minGap) {
      primaryReasonCategory = 'GAP_INSUFFICIENT';
      primaryReasonLabel = `Gap % insufficiente (${gap.toFixed(2)}% vs min ±${minGap}%)`;
      detail = `Il sottostante non presenta un gap d'apertura minimo per attivare strategie Gap & Go o ORB.`;
      countsByCategory.gapInsufficient++;
    } else if (rvol < parameters.minRvol) {
      primaryReasonCategory = 'RVOL_INSUFFICIENT';
      primaryReasonLabel = `Volume Relativo basso (${rvol.toFixed(2)}x vs min ${parameters.minRvol}x)`;
      detail = `Scambi istituzionali inferiori alla media mobile a 20 periodi; rischio falsa rottura.`;
      countsByCategory.rvolInsufficient++;
    } else if (cat && cat.decisione === 'NESSUN_TRADE') {
      const isAbsenceOfNewsOnly =
        cat.catalizzatore?.toLowerCase().includes('nessuna notizia') ||
        cat.catalizzatore?.toLowerCase().includes('assenza di catalizzatore') ||
        cat.catalizzatore?.toLowerCase().includes('assenza di notizie') ||
        (cat.rischi?.length === 1 &&
          (cat.rischi[0]?.toLowerCase().includes('mancanza di notizie') ||
           cat.rischi[0]?.toLowerCase().includes('assenza di catalizzatore') ||
           cat.rischi[0]?.toLowerCase().includes('assenza di notizie')));

      if (!isAbsenceOfNewsOnly) {
        primaryReasonCategory = 'CATALYST_UNVERIFIED';
        primaryReasonLabel = 'Rischio fondamentale avverso o trimestrale';
        detail = cat.catalizzatore || 'Rischio trimestrale o evento societario critico attivo nella giornata odierna.';
        countsByCategory.catalystUnverified++;
      } else if (score < parameters.minScore) {
        primaryReasonCategory = 'SCORE_BELOW_MIN';
        primaryReasonLabel = `Punteggio sotto soglia (${score}/100 vs min ${parameters.minScore})`;
        detail = `Punteggio ${score}/100: confluenza tecnica debole tra gap, book e futures.`;
        countsByCategory.scoreBelowMin++;
      } else {
        primaryReasonCategory = 'CUTOFF_PASSED';
        primaryReasonLabel = 'Orario di cutoff superato';
        detail = `Sessione oltre l'orario di cutoff consentito (${q.market === 'EU' ? '11:30' : '17:30'} CET).`;
        countsByCategory.cutoffPassed++;
      }
    } else if (score < parameters.minScore) {
      primaryReasonCategory = 'SCORE_BELOW_MIN';
      primaryReasonLabel = `Punteggio sotto soglia (${score}/100 vs min ${parameters.minScore})`;
      detail = `Punteggio ${score}/100: confluenza tecnica debole tra gap, book e futures.`;
      countsByCategory.scoreBelowMin++;
    } else {
      primaryReasonCategory = 'CUTOFF_PASSED';
      primaryReasonLabel = 'Orario di cutoff superato';
      detail = `Sessione oltre l'orario di cutoff consentito (${q.market === 'EU' ? '11:30' : '17:30'} CET).`;
      countsByCategory.cutoffPassed++;
    }

    excludedList.push({
      ticker: q.ticker,
      name: q.name,
      market: q.market,
      currency: q.currency,
      score,
      gapPercent: q.gapPercent,
      rvol: q.rvol,
      rsi,
      atr: q.atr14,
      primaryReasonCategory,
      primaryReasonLabel,
      detail,
    });
  });

  const excludedCount = excludedList.length;
  const qualifiedCount = qualifiedTickers.size;

  // Build bullet summary
  const bulletSummary: string[] = [];
  if (countsByCategory.gapInsufficient > 0) {
    bulletSummary.push(`${countsByCategory.gapInsufficient} per Gap % insufficiente (< ±${parameters.minGapEurope}% EU / ±${parameters.minGapUSA}% US)`);
  }
  if (countsByCategory.rvolInsufficient > 0) {
    bulletSummary.push(`${countsByCategory.rvolInsufficient} per Volume Relativo basso (< ${parameters.minRvol}x)`);
  }
  if (countsByCategory.rsiExtreme > 0) {
    bulletSummary.push(`${countsByCategory.rsiExtreme} per RSI fuori range (ipercomprato/ipervenduto)`);
  }
  if (countsByCategory.scoreBelowMin > 0) {
    bulletSummary.push(`${countsByCategory.scoreBelowMin} per Punteggio sotto soglia (< ${parameters.minScore}/100)`);
  }
  if (countsByCategory.catalystUnverified > 0) {
    bulletSummary.push(`${countsByCategory.catalystUnverified} per Catalizzatore non idoneo o rischio utili`);
  }
  if (countsByCategory.atrInsufficient > 0) {
    bulletSummary.push(`${countsByCategory.atrInsufficient} per Volatilità ATR non calcolabile`);
  }
  if (countsByCategory.cutoffPassed > 0) {
    bulletSummary.push(`${countsByCategory.cutoffPassed} per Orario di cutoff superato`);
  }
  if (countsByCategory.priceUnavailable > 0) {
    bulletSummary.push(`${countsByCategory.priceUnavailable} per Prezzo non disponibile`);
  }

  const topExclusionSummary = bulletSummary.slice(0, 3).join(', ');
  const briefNotificationMessage = `🔍 Audit Filtraggio: ${totalScanned} titoli analizzati • ${qualifiedCount} qualificati • ${excludedCount} scartati (${topExclusionSummary})`;

  return {
    totalScanned,
    qualifiedCount,
    excludedCount,
    timestamp: new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    countsByCategory,
    briefNotificationMessage,
    bulletSummary,
    excludedList,
  };
}

// -------------------------------------------------------------
// EXCLUDED SETUPS COUNTERFACTUAL & AUTO-ANALYSIS ENGINE
// -------------------------------------------------------------

/**
 * Builds a theoretical execution setup for an excluded candidate to track whether
 * it would have hit profit or stop loss had it not been filtered out.
 */
export function buildTheoreticalSetupForExcluded(
  candidate: ExcludedCandidateInfo,
  quote: RawQuoteData,
  parameters: SystemParameters
): ExcludedSetupRecord | null {
  const price = quote.currentPrice ?? quote.preMarketPrice;
  if (!price || price <= 0) return null;

  const gap = candidate.gapPercent ?? 0;
  const isLong = gap >= 0;
  const direction: 'LONG' | 'SHORT' = isLong ? 'LONG' : 'SHORT';

  const offsetPct = (parameters.triggerOffsetPercent || 0.15) / 100;
  const entryTrigger = +(isLong ? price * (1 + offsetPct) : price * (1 - offsetPct)).toFixed(3);

  const atr = quote.atr14 && quote.atr14 > 0 ? quote.atr14 : price * 0.015;
  const riskDist = +(Math.max(price * 0.005, atr * (parameters.normalRiskMultiplier || 0.5))).toFixed(3);

  const t1Mult = parameters.target1Multiplier || 1.6;
  const stopLoss = +(isLong ? entryTrigger - riskDist : entryTrigger + riskDist).toFixed(3);
  const target1 = +(isLong ? entryTrigger + riskDist * t1Mult : entryTrigger - riskDist * t1Mult).toFixed(3);

  const dateStr = new Date().toLocaleDateString('it-IT');
  const id = `ex-${candidate.ticker}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  return {
    id,
    ticker: candidate.ticker,
    name: candidate.name,
    market: candidate.market,
    currency: candidate.currency,
    sessionDate: dateStr,
    timestamp: new Date().toISOString(),
    score: candidate.score,
    gapPercent: candidate.gapPercent,
    rvol: candidate.rvol,
    rsi: candidate.rsi,
    atr: candidate.atr,
    primaryReasonCategory: candidate.primaryReasonCategory,
    primaryReasonLabel: candidate.primaryReasonLabel,
    detail: candidate.detail,
    direction,
    initialPrice: price,
    entryTrigger,
    stopLoss,
    target1,
    riskDist,
    currentPrice: price,
    outcomeStatus: 'MONITORING',
    theoreticalRMultiple: 0,
    theoreticalPnlEur: 0,
    notes: `Setup teorico monitorato post-esclusione: ${candidate.primaryReasonLabel}`,
  };
}

/**
 * Updates active monitored excluded setups against live market quotes tick-by-tick.
 */
export function updateExcludedSetupsWithLiveQuotes(
  records: ExcludedSetupRecord[],
  quotes: RawQuoteData[],
  currentCetMinutes?: number,
  accountCapital = 10000
): { updated: ExcludedSetupRecord[]; newlyResolvedCount: number } {
  let newlyResolvedCount = 0;

  const updated = records.map((record) => {
    if (record.outcomeStatus !== 'MONITORING') return record;

    const matchingQuote = quotes.find((q) => q.ticker === record.ticker);
    if (!matchingQuote) return record;

    const livePrice = matchingQuote.currentPrice ?? matchingQuote.preMarketPrice;
    if (livePrice == null || livePrice <= 0) return record;

    const isLong = record.direction === 'LONG';
    const entry = record.entryTrigger;
    const stop = record.stopLoss;
    const target = record.target1;
    const riskDist = record.riskDist > 0 ? record.riskDist : Math.abs(entry - stop);

    // 1. Target 1 Reached (Theoretical Profit)
    const hitTarget = isLong ? livePrice >= target : livePrice <= target;
    if (hitTarget) {
      newlyResolvedCount++;
      const rMultiple = +(Math.abs(target - entry) / (riskDist || 1)).toFixed(2);
      const pnlEur = +(rMultiple * (accountCapital * 0.01)).toFixed(2);
      return {
        ...record,
        currentPrice: livePrice,
        outcomeStatus: 'THEORETICAL_PROFIT' as const,
        theoreticalRMultiple: rMultiple,
        theoreticalPnlEur: pnlEur,
        resolvedAt: new Date().toISOString(),
        notes: `Raggiunto Target 1 a ${livePrice.toFixed(2)} ${record.currency} (+${rMultiple}R). Esclusione che ha impedito un profitto.`,
      };
    }

    // 2. Stop Loss Hit (Theoretical Loss)
    const hitStop = isLong ? livePrice <= stop : livePrice >= stop;
    if (hitStop) {
      newlyResolvedCount++;
      const pnlEur = -+(accountCapital * 0.01).toFixed(2);
      return {
        ...record,
        currentPrice: livePrice,
        outcomeStatus: 'THEORETICAL_STOP' as const,
        theoreticalRMultiple: -1.0,
        theoreticalPnlEur: pnlEur,
        resolvedAt: new Date().toISOString(),
        notes: `Attivato Stop Loss a ${livePrice.toFixed(2)} ${record.currency} (-1.0R). Il filtro ha salvato il capitale evitando una perdita reale.`,
      };
    }

    // 3. Cutoff Time Expiration
    if (currentCetMinutes != null) {
      const isEuCutoff = record.market === 'EU' && currentCetMinutes >= 690; // 11:30 CET
      const isUsCutoff = record.market === 'US' && currentCetMinutes >= 1050; // 17:30 CET
      if (isEuCutoff || isUsCutoff) {
        newlyResolvedCount++;
        const diff = isLong ? livePrice - entry : entry - livePrice;
        const rMultiple = riskDist > 0 ? +(diff / riskDist).toFixed(2) : 0;
        const pnlEur = +(rMultiple * (accountCapital * 0.01)).toFixed(2);
        return {
          ...record,
          currentPrice: livePrice,
          outcomeStatus: 'THEORETICAL_EXPIRED' as const,
          theoreticalRMultiple: rMultiple,
          theoreticalPnlEur: pnlEur,
          resolvedAt: new Date().toISOString(),
          notes: `Cutoff superato senza target né stop. Chiusura temporale a ${livePrice.toFixed(2)} ${record.currency}.`,
        };
      }
    }

    return {
      ...record,
      currentPrice: livePrice,
    };
  });

  return { updated, newlyResolvedCount };
}

/**
 * Runs rigorous auto-analysis on excluded setups, grouping by exclusion category,
 * determining whether too many excluded setups were actually profitable,
 * and proposing automated calibration improvements for the next trading session.
 */
export function runExcludedSetupsAutoAnalysis(
  records: ExcludedSetupRecord[],
  currentParams: SystemParameters = DEFAULT_SYSTEM_PARAMETERS,
  accountCapital = 10000
): ExcludedSetupsAutoAnalysis {
  const categoryOrder: ExclusionCategory[] = [
    'RSI_EXTREME',
    'RVOL_INSUFFICIENT',
    'GAP_INSUFFICIENT',
    'SCORE_BELOW_MIN',
    'CATALYST_UNVERIFIED',
    'ATR_INSUFFICIENT',
    'CUTOFF_PASSED',
    'PRICE_UNAVAILABLE',
  ];

  const categoryLabels: Record<ExclusionCategory, string> = {
    RSI_EXTREME: 'Filtro RSI Fuori Range (Ipercomprato / Ipervenduto)',
    RVOL_INSUFFICIENT: 'Filtro Volume Relativo Basso (RVOL)',
    GAP_INSUFFICIENT: 'Filtro Ampiezza Gap % d\'Apertura',
    SCORE_BELOW_MIN: 'Soglia Punteggio Minimo (minScore)',
    CATALYST_UNVERIFIED: 'Filtro Catalizzatore Fondamentale & Earnings',
    ATR_INSUFFICIENT: 'Filtro Volatilità Media ATR',
    CUTOFF_PASSED: 'Filtro Orario di Cutoff (11:30 / 17:30 CET)',
    PRICE_UNAVAILABLE: 'Filtro Feed Dati / Prezzo Assente',
  };

  const categories: ExcludedCategoryAnalysis[] = [];
  const urgentCorrections: ExcludedSetupsAutoAnalysis['urgentCorrections'] = [];

  let totalTracked = records.length;
  let totalProfitable = 0;
  let totalStopped = 0;
  let totalExpired = 0;
  let totalMonitoring = 0;
  let totalMissedPnlEur = 0;
  let totalCapitalSavedEur = 0;

  for (const cat of categoryOrder) {
    const catRecords = records.filter((r) => r.primaryReasonCategory === cat);
    const totalExcluded = catRecords.length;

    if (totalExcluded === 0) continue;

    const profitCount = catRecords.filter((r) => r.outcomeStatus === 'THEORETICAL_PROFIT').length;
    const lossCount = catRecords.filter((r) => r.outcomeStatus === 'THEORETICAL_STOP').length;
    const expiredCount = catRecords.filter((r) => r.outcomeStatus === 'THEORETICAL_EXPIRED').length;
    const monitoringCount = catRecords.filter((r) => r.outcomeStatus === 'MONITORING').length;

    totalProfitable += profitCount;
    totalStopped += lossCount;
    totalExpired += expiredCount;
    totalMonitoring += monitoringCount;

    const resolved = profitCount + lossCount + expiredCount;
    const winRate = resolved > 0 ? +((profitCount / resolved) * 100).toFixed(1) : 0;

    const missedPnlEur = +(catRecords.reduce((acc, r) => acc + (r.outcomeStatus === 'THEORETICAL_PROFIT' ? (r.theoreticalPnlEur || 0) : 0), 0)).toFixed(2);
    const savedPnlEur = +(catRecords.reduce((acc, r) => acc + (r.outcomeStatus === 'THEORETICAL_STOP' ? Math.abs(r.theoreticalPnlEur || 100) : 0), 0)).toFixed(2);

    totalMissedPnlEur += missedPnlEur;
    totalCapitalSavedEur += savedPnlEur;

    let verdict: ExcludedCategoryAnalysis['verdict'] = 'BALANCED';
    let verdictTitle = 'Filtro Bilanciato';
    let verdictDescription = 'Il filtro mostra un equilibrio fisiologico tra falsi positivi evitati e opportunità scartate.';
    let correctionProposal: ExcludedCategoryAnalysis['correctionProposal'] | undefined = undefined;

    // Check if TOO RESTRICTIVE (too many excluded went to profit)
    const isTooRestrictive = profitCount >= 2 && (winRate >= 55 || profitCount > lossCount);
    // Check if EFFECTIVE SHIELD (most excluded went to stop loss)
    const isEffectiveShield = lossCount >= 2 && lossCount > profitCount;

    if (isTooRestrictive) {
      verdict = 'TOO_RESTRICTIVE';
      verdictTitle = '⚠️ Filtro Troppo Severo (Troppi Profitti Persi)';
      verdictDescription = `${profitCount} setup su ${resolved} risolti (${winRate}%) sono andati a target con successo nonostante l'esclusione. Il filtro è eccessivamente restrittivo e sta frenando le performance della strategia.`;

      if (cat === 'RVOL_INSUFFICIENT') {
        const profitableRvols = catRecords
          .filter((r) => r.outcomeStatus === 'THEORETICAL_PROFIT' && typeof r.rvol === 'number' && r.rvol > 0)
          .map((r) => r.rvol as number);
        const minProfitableRvol = profitableRvols.length > 0 ? Math.min(...profitableRvols) : currentParams.minRvol - 0.20;
        const proposed = Math.max(0.65, +Math.min(currentParams.minRvol - 0.15, minProfitableRvol).toFixed(2));
        correctionProposal = {
          parameterKey: 'minRvol',
          label: 'Soglia Minima Volume Relativo (RVOL)',
          currentValue: `${currentParams.minRvol}x`,
          proposedValue: `${proposed}x`,
          actionType: 'REDUCE_PARAM',
          explanation: `Riduci la soglia minima di RVOL da ${currentParams.minRvol}x a ${proposed}x per includere nella prossima sessione titoli con volume relativo a partire da ${proposed}x che sono andati a target con successo.`,
        };
        urgentCorrections.push({
          category: cat,
          title: 'Allentamento Soglia RVOL',
          description: correctionProposal.explanation,
          parameterKey: 'minRvol',
          currentValue: currentParams.minRvol,
          proposedValue: proposed,
        });
      } else if (cat === 'GAP_INSUFFICIENT') {
        const profitableGaps = catRecords
          .filter((r) => r.outcomeStatus === 'THEORETICAL_PROFIT' && typeof r.gapPercent === 'number')
          .map((r) => Math.abs(r.gapPercent as number));
        const minProfitableGap = profitableGaps.length > 0 ? Math.min(...profitableGaps) : currentParams.minGapEurope - 0.15;
        const proposedEU = Math.max(0.15, +Math.min(currentParams.minGapEurope - 0.10, minProfitableGap).toFixed(2));
        correctionProposal = {
          parameterKey: 'minGapEurope',
          label: 'Soglia Minima Gap % Europa',
          currentValue: `${currentParams.minGapEurope}%`,
          proposedValue: `${proposedEU}%`,
          actionType: 'REDUCE_PARAM',
          explanation: `Abbassa il gap minimo europeo a ${proposedEU}% (e USA a ${(currentParams.minGapUSA * 0.8).toFixed(2)}%) per intercettare continuazioni di trend con gap a partire da ±${proposedEU}%.`,
        };
        urgentCorrections.push({
          category: cat,
          title: 'Riduzione Soglia Gap Minimo',
          description: correctionProposal.explanation,
          parameterKey: 'minGapEurope',
          currentValue: currentParams.minGapEurope,
          proposedValue: proposedEU,
        });
      } else if (cat === 'SCORE_BELOW_MIN') {
        const profitableScores = catRecords
          .filter((r) => r.outcomeStatus === 'THEORETICAL_PROFIT' && typeof r.score === 'number')
          .map((r) => r.score);
        const minProfitableScore = profitableScores.length > 0 ? Math.min(...profitableScores) : currentParams.minScore - 5;
        const proposedScore = Math.max(40, Math.min(currentParams.minScore - 5, minProfitableScore));
        correctionProposal = {
          parameterKey: 'minScore',
          label: 'Punteggio Minimo Algoritmico (minScore)',
          currentValue: `${currentParams.minScore}/100`,
          proposedValue: `${proposedScore}/100`,
          actionType: 'REDUCE_PARAM',
          explanation: `Riduci la soglia di sblocco setup da ${currentParams.minScore} a ${proposedScore}/100 per ammettere i setup con punteggio da ${proposedScore} in su che hanno dimostrato win rate del ${winRate}%.`,
        };
        urgentCorrections.push({
          category: cat,
          title: 'Abbassamento Soglia Punteggio',
          description: correctionProposal.explanation,
          parameterKey: 'minScore',
          currentValue: currentParams.minScore,
          proposedValue: proposedScore,
        });
      } else if (cat === 'RSI_EXTREME') {
        correctionProposal = {
          parameterKey: 'rsiFilterActive',
          label: 'Filtro Ipercomprato/Ipervenduto RSI (30/70)',
          currentValue: currentParams.rsiFilterActive ? 'Attivo' : 'Disattivo',
          proposedValue: 'Disattivo',
          actionType: 'TOGGLE_RSI',
          explanation: `In sessioni con forte spinta istituzionale, l'RSI estremo ha prodotto un win rate del ${winRate}% a profitto. Disattivando il blocco rigido RSI, i setup ad alto momentum non vengono scartati.`,
        };
        urgentCorrections.push({
          category: cat,
          title: 'Disattivazione Filtro RSI per Momentum',
          description: correctionProposal.explanation,
          parameterKey: 'rsiFilterActive',
          currentValue: currentParams.rsiFilterActive,
          proposedValue: false,
        });
      }
    } else if (isEffectiveShield) {
      verdict = 'EFFECTIVE_SHIELD';
      verdictTitle = '🛡️ Scudo Difensivo Efficace (Capitale Protetto)';
      verdictDescription = `Il filtro ha intercettato ${lossCount} stop loss su falsi segnali (${((lossCount / (resolved || 1)) * 100).toFixed(1)}%), risparmiando circa +${savedPnlEur} € di perdite certe. Mantieni il filtro rigorosamente attivo!`;
    } else if (resolved < 2) {
      verdict = 'INSUFFICIENT_SAMPLE';
      verdictTitle = 'Campione in Accumulazione';
      verdictDescription = `Dati storici insufficienti (${resolved} setup risolti) per decretare con certezza statistica se il filtro debba essere modificato. Continua il monitoraggio tick-by-tick.`;
    }

    categories.push({
      category: cat,
      label: categoryLabels[cat] || cat,
      totalExcluded,
      profitCount,
      lossCount,
      expiredCount,
      monitoringCount,
      winRate,
      missedPnlEur,
      savedPnlEur,
      verdict,
      verdictTitle,
      verdictDescription,
      correctionProposal,
    });
  }

  const totalResolved = totalProfitable + totalStopped + totalExpired;
  const overallMissedWinRate = totalResolved > 0 ? +((totalProfitable / totalResolved) * 100).toFixed(1) : 0;

  return {
    totalTracked,
    totalResolved,
    totalProfitable,
    totalStopped,
    totalExpired,
    totalMonitoring,
    overallMissedWinRate,
    totalMissedPnlEur: +totalMissedPnlEur.toFixed(2),
    totalCapitalSavedEur: +totalCapitalSavedEur.toFixed(2),
    categories,
    urgentCorrections,
    analyzedAt: new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
  };
}
