import { ExcludedSetupRecord, TradeJournalEntry } from '../types/radar';
import type { DeflatedSharpeResult, ExpectancyBootstrapResult } from '../knowledge/shadowAlgorithms';
import { deflatedSharpeRatio, expectancyBootstrap } from '../knowledge/shadowAlgorithms';
import { benjaminiHochberg } from '../../scripts/nightly_learning';

export const MIN_REAL_TRADE_SAMPLE = 30;

/**
 * ADDITIVO (v9, Parte 2.2): enum CHIUSO dei predicati.
 * Ogni id corrisponde a una condizione semplice su un campo verificato di
 * TradeJournalEntry (src/types/radar.ts:512-575).
 * `score` NON è un campo di TradeJournalEntry: nessun predicato di score è
 * definito qui (dichiarato in Parte 1.3).
 */
export const LEARNING_PREDICATES = {
  MARKET_EU: 'MARKET_EU',
  MARKET_US: 'MARKET_US',
  SESSION_EU: 'SESSION_EU',
  SESSION_US: 'SESSION_US',
  DIRECTION_LONG: 'DIRECTION_LONG',
  DIRECTION_SHORT: 'DIRECTION_SHORT',
  LEVERAGE_5: 'LEVERAGE_5',
  LEVERAGE_10: 'LEVERAGE_10',
  LEVERAGE_15: 'LEVERAGE_15',
  LEVERAGE_20: 'LEVERAGE_20',
  LEVERAGE_25: 'LEVERAGE_25',
  ENTRY_SNAPSHOT_0915: 'ENTRY_SNAPSHOT_0915',
  ENTRY_UNFROZEN_LATE: 'ENTRY_UNFROZEN_LATE',
  ENTRY_MANUAL_FREEZE: 'ENTRY_MANUAL_FREEZE',
} as const;

export type LearningPredicateId = keyof typeof LEARNING_PREDICATES;

export const LEARNING_PREDICATE_IDS: LearningPredicateId[] =
  Object.keys(LEARNING_PREDICATES) as LearningPredicateId[];

export function isLearningPredicateId(value: unknown): value is LearningPredicateId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEARNING_PREDICATES, value);
}

/** Valori di L_sel ammessi dai predicati di leva (chiusi, non arbitrari). */
const PREDICATE_LEVERAGE: Partial<Record<LearningPredicateId, number>> = {
  LEVERAGE_5: 5,
  LEVERAGE_10: 10,
  LEVERAGE_15: 15,
  LEVERAGE_20: 20,
  LEVERAGE_25: 25,
};

/**
 * Funzione pura: vero solo se il trade soddisfa il predicato chiuso.
 * Campo mancante, valore non finito o predicato sconosciuto => false, mai eccezione.
 */
export function applyPredicate(trade: TradeJournalEntry, predicateId: string): boolean {
  if (!trade || typeof trade !== 'object') return false;
  if (!isLearningPredicateId(predicateId)) return false;
  try {
    const leverage = PREDICATE_LEVERAGE[predicateId];
    if (leverage !== undefined) {
      return typeof trade.selectedLeverage === 'number' && Number.isFinite(trade.selectedLeverage) && trade.selectedLeverage === leverage;
    }
    switch (predicateId) {
      case 'MARKET_EU':
        return trade.market === 'EU';
      case 'MARKET_US':
        return trade.market === 'US';
      case 'SESSION_EU':
        return trade.session === 'EU';
      case 'SESSION_US':
        return trade.session === 'US';
      case 'DIRECTION_LONG':
        return trade.direction === 'LONG';
      case 'DIRECTION_SHORT':
        return trade.direction === 'SHORT';
      case 'ENTRY_SNAPSHOT_0915':
        return trade.entryMode === 'SNAPSHOT_0915';
      case 'ENTRY_UNFROZEN_LATE':
        return trade.entryMode === 'UNFROZEN_LATE';
      case 'ENTRY_MANUAL_FREEZE':
        return trade.entryMode === 'MANUAL_FREEZE';
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * IPOTESI: opzioni informative della validazione. Non cambiano i gate esistenti
 * (MIN_REAL_TRADE_SAMPLE, q-value FDR, avgR, profit factor): aggiungono solo campi al risultato.
 */
export interface LearningValidationOptions {
  /** IPOTESI: numero di prove indipendenti dichiarato dal chiamante per il DSR (T < 2 ⇒ null). */
  dsrTrials?: number;
  /**
   * IPOTESI: true quando i controfattuali arrivano dal raggruppamento per mercato, direzione e
   * finestra oraria (stesso insieme condiviso fra più topic della stessa chiave di contesto).
   */
  counterfactualShared?: boolean;
}

export interface LearningResult {
  topic: string;
  market: 'EU' | 'US' | 'GLOBAL';
  directive: string;
  confidence: number;
  evidence: string[];
  /** IPOTESI: test di expectancy sugli R-multipli; informativo, non è un gate. */
  expectancy: ExpectancyBootstrapResult | null;
  /** IPOTESI: Deflated Sharpe Ratio; informativo, non è un gate. */
  deflatedSharpe: DeflatedSharpeResult;
  /** IPOTESI: i controfattuali sono condivisi per chiave mercato+direzione+finestra. */
  counterfactualShared: boolean;
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
  market: 'EU' | 'US' | 'GLOBAL',
  options: LearningValidationOptions = {},
  predicateId?: LearningPredicateId
): LearningResult | null {
  // ADDITIVO (v9, Parte 2.2): predicato fuori enum => nessun risultato (nessuna scrittura).
  if (predicateId !== undefined && !isLearningPredicateId(predicateId)) return null;
  const candidateTrades = predicateId
    ? trades.filter((trade) => applyPredicate(trade, predicateId))
    : trades;
  const actualTrades = candidateTrades.filter((trade) =>
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

  const rMultiples = actualTrades.map((trade) => trade.rMultiple);
  const expectancy = expectancyBootstrap(rMultiples);
  const deflatedSharpe = deflatedSharpeRatio(rMultiples, options.dsrTrials ?? 1);

  return {
    topic,
    market,
    directive,
    confidence: 1 - pValue,
    evidence: actualTrades.map((trade) => trade.id),
    expectancy,
    deflatedSharpe,
    counterfactualShared: options.counterfactualShared === true,
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

export interface PredicateScanEntry {
  predicateId: LearningPredicateId;
  /** Trade decisivi (WIN/LOSS con rMultiple finito) del predicato. */
  n: number;
  pValue: number;
  qValue: number;
  avgR: number;
  profitFactor: number;
  tested: boolean;
  passesGates: boolean;
  /** Risultato completo del validatore quando tested, altrimenti null. */
  result: LearningResult | null;
}

/** Soglia q identica a quella applicata da updateAIMemory (src/utils/memoryUpdater.ts:25). */
const SCAN_Q_THRESHOLD = 0.05;

/**
 * ADDITIVO (v10, Parte 2.1): scansione deterministica dei predicati chiusi.
 *
 * - Ogni id di LEARNING_PREDICATE_IDS viene filtrato con applyPredicate e validato
 *   riusando validateLearningPattern (nessuna logica statistica duplicata).
 * - Campione decisivo < MIN_REAL_TRADE_SAMPLE => pValue = 1, tested = false.
 * - Benjamini-Hochberg è applicata alla famiglia FISSA di 14 p-value, incluse le
 *   ipotesi non testate (p = 1), non al solo sottoinsieme testato.
 * - Limite noto dichiarato: la famiglia è corretta per la singola esecuzione; la
 *   ripetizione della scansione nel tempo NON è corretta (nessun correction
 *   across-occasion), quindi il q-value non tiene conto di quante volte la stessa
 *   famiglia viene ricalcolata su dati che crescono.
 * - Nessuna soglia nuova: q <= 0.05 (stessa di updateAIMemory), avgR > 0,
 *   profitFactor > 1, n >= MIN_REAL_TRADE_SAMPLE.
 */
export function scanLearningPredicates(
  trades: TradeJournalEntry[],
  excluded: ExcludedSetupRecord[]
): PredicateScanEntry[] {
  const raw = LEARNING_PREDICATE_IDS.map((predicateId) => {
    const filtered = trades.filter((trade) => applyPredicate(trade, predicateId));
    const decisive = filtered.filter(
      (trade) =>
        trade &&
        trade.status !== 'OPEN' &&
        (trade.outcome === 'WIN' || trade.outcome === 'LOSS') &&
        Number.isFinite(trade.rMultiple) &&
        typeof trade.id === 'string' &&
        trade.id.length > 0
    ).length;
    const result = validateLearningPattern(
      filtered,
      excluded,
      `PREDICATO_${predicateId}`,
      'GLOBAL',
      {},
      predicateId
    );
    return { predicateId, decisive, result };
  });

  const adjusted = benjaminiHochberg(raw.map((entry) => (entry.result ? entry.result.stats.pValue : 1)));

  return raw.map((entry, index) => {
    const qValue = adjusted[index];
    const tested = entry.result !== null;
    const stats = entry.result?.stats;
    const avgR = stats ? stats.avgR : 0;
    const profitFactor = stats ? stats.profitFactor : 0;
    const n = stats ? stats.n : entry.decisive;
    const passesGates =
      tested &&
      n >= MIN_REAL_TRADE_SAMPLE &&
      qValue <= SCAN_Q_THRESHOLD &&
      avgR > 0 &&
      profitFactor > 1;
    return {
      predicateId: entry.predicateId,
      n,
      pValue: stats ? stats.pValue : 1,
      qValue,
      avgR,
      profitFactor,
      tested,
      passesGates,
      result: entry.result,
    };
  });
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
