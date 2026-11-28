/**
 * HARNESS MONTE CARLO DEL VALIDATORE (Fase 5.3).
 *
 * Domanda: le soglie fisse di `ai-desk-validation@2` sono troppo permissive?
 * Con un edge VERO nullo, quanto spesso il validator direbbe CONFERMATO? E con
 * un edge noto, quanto spesso lo riconosce?
 *
 * Metodo dichiarato:
 * - R per trade estratti da una normale (Box-Muller) con la PRNG deterministica
 *   mulberry32 e seed fissa: nessun orologio, stesso output a ogni esecuzione;
 * - scenari riprodotti indipendentemente, e ogni replica passa dallo STESSO
 *   `validateAiDeskSample` della produzione (nessuna soglia duplicata qui);
 * - il tasso di falsi positivi e' la quota di repliche con edge nullo in cui il
 *   verdetto e' CONFERMATO;
 * - la potenza e' la quota di repliche con un edge vero (AZIONE +1.0 R,
 *   SCARTO 0 R) in cui il verdetto e' CONFERMATO.
 *
 * Limiti dichiarati: la normale sui R e' un'ipotesi (i R reali hanno code
 * grasse e dipendenza fra trade), e i bucket sono indipendenti. Il numero qui
 * sotto misura le SOGLIE, non il desk. Se il campione reale non rispetta
 * l'ipotesi, questo harness non lo scopre.
 *
 * Esce con codice 1 se una delle asserzioni dichiarate fallisce: e' il modo in
 * cui un allentamento delle soglie diventa visibile in CI.
 */

import { bootstrapEdgeInterval } from '../src/server/aiCalibration';
import {
  AI_DESK_VALIDATION_MIN_CLASSIFIED,
  AI_DESK_VALIDATION_MIN_PER_BUCKET,
  AI_DESK_VALIDATION_MIN_EDGE_R,
  AI_DESK_VALIDATION_MIN_NET_R,
  AI_DESK_VALIDATION_MIN_WIN_RATE_GAP_PCT,
  validateAiDeskSample,
  type AiDeskValidationBucket,
} from '../src/server/aiDeskValidator';

/** Seed fissa: l'harness non e' casuale, e' solo pseudo-casuale e ripetibile. */
const SEED = 0x5eed1a7e;
/** Repliche per scenario: 400 da' un errore standard ~2,2 punti sul 5%. */
const NULL_REPLICATIONS = 400;
const POWER_REPLICATIONS = 300;
/** Casi per lato nello scenario nullo (sopra la soglia minima per bucket). */
const NULL_BUCKET_N = 20;
/** Casi per lato nello scenario con edge vero. */
const POWER_BUCKET_N = 100;
/** Edge vero dello scenario di potenza, in R netti per trade. */
const POWER_TRUE_EDGE_R = 1;

/**
 * Soglie di accettazione dichiarate PRIMA di guardare l'output, con margine
 * sull'errore di campionamento: un validatore che conferma piu' del 5% delle
 * volte su edge nullo non distingue il rumore da un risultato.
 */
const MAX_FALSE_POSITIVE_RATE = 0.05;
/** Con un edge di 1 R su 100 casi per lato il validatore deve accorgersene. */
const MIN_DETECTION_RATE = 0.9;

/** PRNG deterministico (mulberry32): stessa seed, stessa sequenza. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normale standard da due uniformi (Box-Muller). */
function normal(random: () => number): number {
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function bucketOf(decision: string, values: readonly number[]): AiDeskValidationBucket {
  const n = values.length;
  const sum = values.reduce((total, value) => total + value, 0);
  const mean = sum / n;
  const wins = values.filter((value) => value > 0).length;
  return {
    decision,
    n,
    meanR: round(mean, 4),
    meanRNet: round(mean, 4),
    winRatePct: round((wins / n) * 100, 2),
    winRateNetPct: round((wins / n) * 100, 2),
  };
}

interface ScenarioResult {
  confirmations: number;
  replications: number;
  rate: number;
  /** Conferme con le sole stime puntuali, senza il gate IC sull'edge. */
  withoutCi: number;
}

function runScenario(
  seed: number,
  replications: number,
  bucketN: number,
  meanAction: number,
  meanSkip: number
): ScenarioResult {
  const random = mulberry32(seed);
  let confirmations = 0;
  let withoutCi = 0;
  for (let i = 0; i < replications; i += 1) {
    const action: number[] = [];
    for (let j = 0; j < bucketN; j += 1) action.push(meanAction + normal(random));
    const skip: number[] = [];
    for (let j = 0; j < bucketN; j += 1) skip.push(meanSkip + normal(random));
    const actionBucket = bucketOf('AZIONE', action);
    const skipBucket = bucketOf('SCARTO', skip);
    // Come la calibrazione: `edgeR` e' un input dichiarato, non un numero che il
    // validatore ricava da solo.
    const edgeRNet = round((actionBucket.meanRNet ?? 0) - (skipBucket.meanRNet ?? 0), 4);
    // Stessa sequenza della produzione: l'IC sull'edge e' un check decisivo.
    // La seed varia per replica, altrimenti la stessa estrazione casuale del
    // bootstrap si ripeterebbe identica su campioni diversi.
    const edgeInterval = bootstrapEdgeInterval(
      action.map((value) => value),
      skip.map((value) => value),
      SEED + 1000 + i
    );
    const verdict = validateAiDeskSample({
      classified: bucketN * 2,
      buckets: [actionBucket, skipBucket],
      edgeR: edgeRNet,
      edgeRNet,
      uncertainty: { edgeR: edgeInterval },
    });
    if (verdict.verdict === 'CONFERMATO') confirmations += 1;
    const pointOnly = validateAiDeskSample({
      classified: bucketN * 2,
      buckets: [actionBucket, skipBucket],
      edgeR: edgeRNet,
      edgeRNet,
    });
    if (pointOnly.verdict === 'CONFERMATO') withoutCi += 1;
  }
  return {
    confirmations,
    replications,
    rate: round(confirmations / replications, 4),
    withoutCi,
  };
}

function pct(rate: number): string {
  return `${round(rate * 100, 1)}%`;
}

const failures: string[] = [];

const nullScenario = runScenario(SEED, NULL_REPLICATIONS, NULL_BUCKET_N, 0, 0);
const powerScenario = runScenario(SEED + 1, POWER_REPLICATIONS, POWER_BUCKET_N, POWER_TRUE_EDGE_R, 0);
// Determinismo: stessa seed => stesso risultato. Se cambia, l'harness e' rotto
// e i numeri sopra non sono riproducibili.
const nullAgain = runScenario(SEED, NULL_REPLICATIONS, NULL_BUCKET_N, 0, 0);

console.log('== Validatore AI — Monte Carlo deterministico (Fase 5.3) ==');
console.log(
  `soglie: classificati >= ${AI_DESK_VALIDATION_MIN_CLASSIFIED}, per bucket >= ${AI_DESK_VALIDATION_MIN_PER_BUCKET}, ` +
    `edge >= ${AI_DESK_VALIDATION_MIN_EDGE_R} R, divario >= ${AI_DESK_VALIDATION_MIN_WIN_RATE_GAP_PCT} punti, ` +
    `netto AZIONE >= ${AI_DESK_VALIDATION_MIN_NET_R} R`
);
console.log(
  `edge nullo (0 R, ${NULL_BUCKET_N} per lato, ${NULL_REPLICATIONS} repliche): ` +
    `${nullScenario.confirmations}/${nullScenario.replications} CONFERMATO = ${pct(nullScenario.rate)} ` +
    `(tetto dichiarato ${pct(MAX_FALSE_POSITIVE_RATE)})`
);
console.log(
  `edge vero ${POWER_TRUE_EDGE_R} R (${POWER_BUCKET_N} per lato, ${POWER_REPLICATIONS} repliche): ` +
    `${powerScenario.confirmations}/${powerScenario.replications} CONFERMATO = ${pct(powerScenario.rate)} ` +
    `(minimo dichiarato ${pct(MIN_DETECTION_RATE)})`
);
console.log(
  `di cui senza il gate IC sull'edge (solo stime puntuali, NON e' il percorso di produzione): ` +
    `edge nullo ${pct(round(nullScenario.withoutCi / nullScenario.replications, 4))}, ` +
    `edge vero ${pct(round(powerScenario.withoutCi / powerScenario.replications, 4))}`
);
console.log(`riproducibilita: ${nullAgain.confirmations}/${nullAgain.replications} alla seconda esecuzione`);

if (nullScenario.rate > MAX_FALSE_POSITIVE_RATE) {
  failures.push(
    `falsi positivi ${pct(nullScenario.rate)} sopra il tetto ${pct(MAX_FALSE_POSITIVE_RATE)}: le soglie lasciano passare il rumore`
  );
}
if (powerScenario.rate < MIN_DETECTION_RATE) {
  failures.push(
    `potenza ${pct(powerScenario.rate)} sotto il minimo ${pct(MIN_DETECTION_RATE)}: il validatore non riconosce un edge di ${POWER_TRUE_EDGE_R} R`
  );
}
if (
  nullAgain.confirmations !== nullScenario.confirmations ||
  nullAgain.replications !== nullScenario.replications
) {
  failures.push('harness non deterministico: la stessa seed ha prodotto un risultato diverso');
}

if (failures.length > 0) {
  console.error('FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('PASS');
