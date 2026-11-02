import { ExcludedSetupRecord, TradeJournalEntry } from '../types/radar';

export const MIN_REAL_TRADE_SAMPLE = 30;

export interface LearningResult {
  topic: string;
  market: 'EU' | 'US' | 'GLOBAL';
  directive: string;
  confidence: number;
  evidence: string[];
  stats: {
    n: number;
    wins: number;
    losses: number;
    breakevens: number;
    winRate: number;
    avgR: number;
    profitFactor: number;
    pValue: number;
    adjustedPValue: number;
    counterfactual: {
      n: number;
      wins: number;
      losses: number;
      expired: number;
    };
  };
}

export function validateLearningPattern(
  trades: TradeJournalEntry[],
  excluded: ExcludedSetupRecord[],
  topic: string,
  market: 'EU' | 'US' | 'GLOBAL'
): LearningResult | null {
  const actualTrades = trades.filter((trade) =>
    trade.isPaper === false &&
    trade.status !== 'OPEN' &&
    (trade.outcome === 'WIN' || trade.outcome === 'LOSS' || trade.outcome === 'BREAKEVEN' || trade.outcome === 'EXPIRED') &&
    Number.isFinite(trade.rMultiple) &&
    typeof trade.id === 'string' &&
    trade.id.length > 0
  );
  const wins = actualTrades.filter((trade) => trade.outcome === 'WIN');
  const losses = actualTrades.filter((trade) => trade.outcome === 'LOSS');
  const breakevens = actualTrades.filter((trade) => trade.outcome === 'BREAKEVEN' || trade.outcome === 'EXPIRED');
  const decisiveTrades = wins.length + losses.length;

  if (actualTrades.length < MIN_REAL_TRADE_SAMPLE || decisiveTrades < MIN_REAL_TRADE_SAMPLE) {
    return null;
  }

  const avgR = actualTrades.reduce((sum, trade) => sum + trade.rMultiple, 0) / actualTrades.length;
  const positiveR = actualTrades
    .filter((trade) => trade.rMultiple > 0)
    .reduce((sum, trade) => sum + trade.rMultiple, 0);
  const negativeR = Math.abs(actualTrades
    .filter((trade) => trade.rMultiple < 0)
    .reduce((sum, trade) => sum + trade.rMultiple, 0));
  const profitFactor = negativeR > 0 ? positiveR / negativeR : positiveR > 0 ? 99 : 0;
  const pValue = binomialPValue(wins.length, decisiveTrades, 0.5);

  const resolvedExcluded = excluded.filter((item) =>
    item.outcomeStatus !== 'MONITORING' &&
    item.outcomeStatus !== 'INSUFFICIENT_DATA' &&
    typeof item.theoreticalRMultiple === 'number' &&
    Number.isFinite(item.theoreticalRMultiple)
  );
  const counterfactual = {
    n: resolvedExcluded.length,
    wins: resolvedExcluded.filter((item) => item.outcomeStatus === 'THEORETICAL_PROFIT').length,
    losses: resolvedExcluded.filter((item) => item.outcomeStatus === 'THEORETICAL_STOP').length,
    expired: resolvedExcluded.filter((item) => item.outcomeStatus === 'THEORETICAL_EXPIRED').length,
  };

  const winRate = wins.length / decisiveTrades;
  const directive =
    `Osservazione esplorativa per ${topic} (${market}): ${(winRate * 100).toFixed(1)}% win rate, ` +
    `avg R ${avgR.toFixed(2)} su ${actualTrades.length} trade chiusi. ` +
    'Non modificare automaticamente soglie o regole operative; rivalutare con nuovi trade reali.';

  return {
    topic,
    market,
    directive,
    confidence: 1 - pValue,
    evidence: actualTrades.map((trade) => trade.id),
    stats: {
      n: actualTrades.length,
      wins: wins.length,
      losses: losses.length,
      breakevens: breakevens.length,
      winRate,
      avgR,
      profitFactor,
      pValue,
      adjustedPValue: pValue,
      counterfactual,
    },
  };
}

export function binomialPValue(wins: number, total: number, p0 = 0.5): number {
  if (
    !Number.isInteger(wins) ||
    !Number.isInteger(total) ||
    total <= 0 ||
    wins < 0 ||
    wins > total ||
    p0 <= 0 ||
    p0 >= 1
  ) {
    return 1;
  }

  const logFactorials = new Array<number>(total + 1).fill(0);
  for (let value = 2; value <= total; value++) {
    logFactorials[value] = logFactorials[value - 1] + Math.log(value);
  }
  const logProbability = (successes: number) =>
    logFactorials[total] -
    logFactorials[successes] -
    logFactorials[total - successes] +
    successes * Math.log(p0) +
    (total - successes) * Math.log(1 - p0);

  const observedLogProbability = logProbability(wins);
  let tailProbability = 0;
  for (let successes = 0; successes <= total; successes++) {
    const candidateLogProbability = logProbability(successes);
    if (candidateLogProbability <= observedLogProbability + 1e-12) {
      tailProbability += Math.exp(candidateLogProbability);
    }
  }
  return Math.min(1, tailProbability);
}
