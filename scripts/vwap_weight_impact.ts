/**
 * Impatto del peso VWAP sullo score (per il report della PR).
 * Confronta VWAP_SCORE_WEIGHT = 0 (prima) e 10 (dopo) sugli stessi candidati.
 * Esecuzione: npx tsx scripts/vwap_weight_impact.ts
 */
import { calculateCandidateScore, rankMarketCandidates } from '../src/utils/calculator';
import { TRADING_PARAMS } from '../src/config/tradingParams';
import { RawQuoteData, VwapSignalState } from '../src/types/radar';

const vwapState = (over: Partial<VwapSignalState> = {}): VwapSignalState => ({
  state: 'ABOVE',
  distAtr: 0.5,
  slopeAtr: 0.2,
  coverage: 1,
  volumeRatio: 2.1,
  flags: [],
  vwapLevel: 100,
  ...over,
});

const quote = (ticker: string, over: Partial<RawQuoteData> = {}): RawQuoteData => ({
  ticker,
  name: `${ticker} Inc.`,
  market: 'US',
  currency: 'USD',
  prevClose: 100,
  currentPrice: 103,
  preMarketPrice: null,
  prevHigh: 99,
  prevLow: 95,
  preMarketHigh: null,
  preMarketLow: null,
  todayOpen: 101,
  todayHigh: 104,
  todayLow: 100,
  vwap: 102,
  ema20Daily: 98,
  avgVolume20d: 5_000_000,
  preMarketVolume: 100_000,
  atr14: 2,
  gapPercent: 1.0,
  rvol: 1.6,
  rsi5m: 55,
  rsi14: 55,
  orderFlow: null,
  timestamp: new Date().toISOString(),
  source: 'impact',
  ...over,
});

const withWeight = <T>(weight: number, fn: () => T): T => {
  const original = TRADING_PARAMS.VWAP_SCORE_WEIGHT;
  TRADING_PARAMS.VWAP_SCORE_WEIGHT = weight;
  try {
    return fn();
  } finally {
    TRADING_PARAMS.VWAP_SCORE_WEIGHT = original;
  }
};

const samples = [
  { label: 'ABOVE confermato (dist 0.5)', q: quote('ABOVE', { vwapState: vwapState({ state: 'ABOVE', distAtr: 0.5 }) }) },
  { label: 'UNKNOWN after-hours', q: quote('UNKNOWN', { vwapState: vwapState({ state: 'UNKNOWN', flags: ['AFTER_HOURS'] }) }) },
  { label: 'BELOW confermato (dist -0.8)', q: quote('BELOW', { vwapState: vwapState({ state: 'BELOW', distAtr: -0.8 }) }) },
];

console.log(`Peso VWAP corrente: ${TRADING_PARAMS.VWAP_SCORE_WEIGHT} (prima: 0)\n`);
console.log('Candidato                         | total 0 -> 10 | delta | VWAP line (peso 10)');
for (const s of samples) {
  const before = withWeight(0, () => calculateCandidateScore(s.q, 0.30, null));
  const after = withWeight(10, () => calculateCandidateScore(s.q, 0.30, null));
  console.log(
    `${s.label.padEnd(33)} | ${String(before.total).padStart(4)} -> ${String(after.total).padEnd(3)} ` +
      `| ${String(after.total - before.total).padStart(5)} | ${after.vwapLine}`
  );
}

const universe = [
  quote('A_ABOVE_08', { vwapState: vwapState({ state: 'ABOVE', distAtr: 0.8 }) }),
  quote('B_ABOVE_03', { vwapState: vwapState({ state: 'ABOVE', distAtr: 0.3 }) }),
  quote('C_PULLBACK', { vwapState: vwapState({ state: 'PULLBACK', distAtr: 0.6 }) }),
  quote('D_NEUTRAL', { vwapState: vwapState({ state: 'ABOVE', distAtr: 0.05 }) }),
  quote('E_UNKNOWN', { vwapState: vwapState({ state: 'UNKNOWN', flags: ['AFTER_HOURS'] }) }),
  quote('F_BELOW', { vwapState: vwapState({ state: 'BELOW', distAtr: -0.9 }) }),
];

const rankOf = (weight: number): string[] =>
  withWeight(weight, () => rankMarketCandidates(universe, 'US', 0.30).map((c) => c.quote.ticker));

const before = rankOf(0);
const after = rankOf(10);
const changed = before.filter((t, i) => after[i] !== t).length;

console.log('\nRanking top-6 (peso 0):', before.join(' > '));
console.log('Ranking top-6 (peso 10):', after.join(' > '));
console.log(`Posizioni cambiate: ${changed}/${before.length}`);
