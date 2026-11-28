/**
 * Intervallo bootstrap della media (Fase 5.2).
 *
 * Il pannello mostrava `edgeR` come numero puntuale: +0,25 senza sapere se è
 * +0,25 ± 0,1 o ± 0,8. Qui la stessa infrastruttura deterministica della
 * calibrazione (seed fissa, nessun orologio) applicata a una singola media.
 */

export const AI_MEAN_INTERVAL_ITERATIONS = 2000;
export const AI_MEAN_INTERVAL_SEED = 0x5eed1a7e;
export const AI_MEAN_INTERVAL_CONFIDENCE = 0.95;

/** PRNG deterministico (mulberry32): stessa seed, stesso risultato. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index];
}

export interface MeanInterval {
  lower: number;
  upper: number;
  mean: number;
  n: number;
  method: 'bootstrap-percentile';
  iterations: number;
  seed: number;
  confidence: number;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Intervallo percentile della media. `null` sotto due valori: con un solo
 * numero l'intervallo sarebbe una certezza finta.
 *
 * Nota onesta: descrive l'incertezza campionaria del segno, non una probabilità
 * di profitto.
 */
export function bootstrapMeanInterval(
  values: readonly number[],
  options: { iterations?: number; seed?: number; confidence?: number } = {}
): MeanInterval | null {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length < 2) return null;
  const iterations = Math.max(100, Math.floor(options.iterations ?? AI_MEAN_INTERVAL_ITERATIONS));
  const seed = Number.isFinite(options.seed) ? Number(options.seed) : AI_MEAN_INTERVAL_SEED;
  const confidence =
    Number.isFinite(options.confidence) && Number(options.confidence) > 0 && Number(options.confidence) < 1
      ? Number(options.confidence)
      : AI_MEAN_INTERVAL_CONFIDENCE;

  const random = mulberry32(seed);
  const means: number[] = new Array(iterations);
  const n = clean.length;
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < n; j += 1) sum += clean[Math.floor(random() * n)];
    means[i] = sum / n;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const mean = clean.reduce((sum, value) => sum + value, 0) / n;
  return {
    lower: round4(percentile(means, alpha)),
    upper: round4(percentile(means, 1 - alpha)),
    mean: round4(mean),
    n,
    method: 'bootstrap-percentile',
    iterations,
    seed,
    confidence,
  };
}
