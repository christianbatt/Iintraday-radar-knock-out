#!/usr/bin/env bun
/**
 * scripts/news_bonus_lift.ts — misura il lift del bonus notizia sul libro USA.
 *
 * Contesto: il replay `scripts/universe_replay.ts` gira senza catalyst AI
 * (W_NEWS = 0), quindi sul libro USA produce 0 emissioni su 669 setup: il
 * bonus notizia e' l'unico ingresso che potrebbe far passare la soglia.
 * Questo script misura, sugli stessi setup e con gli stessi esiti forward:
 *   - quanti setup sono bloccati SOLO dal punteggio (tutti gli altri gate
 *     passati, nessun veto), cioe' la popolazione che il bonus puo' ammettere;
 *   - per ogni bonus Δ da 0 a 10 punti: emissioni, R medio del libro e R medio
 *     della coorte marginale (quella che passa solo grazie al bonus).
 *
 * Misura del R: fill A MERCATO (chiusura della barra della decisione), stop
 * strutturale del setup, target a T1_R R, orizzonte 60 minuti. E' la stessa
 * convenzione con cui il replay ha mostrato che i numeri "al trigger" sono un
 * artefatto.
 *
 * Limite dichiarato: il bonus notizia non e' solo punteggio. Il catalyst puo'
 * anche INVERTIRE la direzione del setup, cosa che qui non e' modellabile
 * (il replay non contiene la direzione del catalyst). Il lift misurato qui e'
 * quindi il lift "a direzione invariata": un limite superiore/inferiore a
 * seconda che il catalyst confermi o inverta il gap.
 *
 * Uso: npx tsx scripts/news_bonus_lift.ts [--market=US] [--replay=...] [--out=...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { TRADING_PARAMS } from '../src/config/tradingParams';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const REPLAY = arg('replay', 'artifacts/universe_replay.json');
const CACHE = arg('cache', 'artifacts/universe');
const OUT = arg('out', 'artifacts/news_bonus_lift.json');
const MARKET = arg('market', 'US') === 'EU' ? 'EU' : 'US';
const HORIZON_SEC = 3600;

interface Row {
  symbol: string;
  market: 'EU' | 'US';
  day: string;
  decisionTs: number;
  emitted: boolean;
  direction: string | null;
  entry: number | null;
  stop: number | null;
  score: number | null;
  veto: string | null;
  blockedGate: string | null;
  reason: string | null;
}

interface Bar {
  t: number;
  h: number;
  l: number;
  c: number;
}

const replay = JSON.parse(fs.readFileSync(REPLAY, 'utf-8')) as { rows: Row[] };
const threshold = MARKET === 'US' ? TRADING_PARAMS.MIN_SCORE_US : TRADING_PARAMS.MIN_SCORE_EU;

// Deduplica identica al replay: la stessa riga viene rivalutata a ogni passo.
const seen = new Set<string>();
const setups: Row[] = [];
for (const row of replay.rows) {
  if (row.market !== MARKET) continue;
  const key = [row.symbol, row.day, row.entry, row.stop, row.veto, row.blockedGate].join('|');
  if (seen.has(key)) continue;
  seen.add(key);
  setups.push(row);
}

const barsBySymbol = new Map<string, Bar[]>();
function bars(symbol: string): Bar[] | null {
  const cached = barsBySymbol.get(symbol);
  if (cached != null) return cached;
  const file = path.join(CACHE, `${symbol}_5m.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const result = raw?.chart?.result?.[0];
    const ts: number[] = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0] ?? {};
    const out: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      if (typeof h !== 'number' || typeof l !== 'number' || typeof c !== 'number') continue;
      out.push({ t: ts[i] * 1000, h, l, c });
    }
    barsBySymbol.set(symbol, out);
    return out;
  } catch {
    return null;
  }
}

/** R con fill a mercato: chiusura della barra della decisione, stop strutturale, target T1_R. */
function marketFillR(row: Row): number | null {
  if (row.direction !== 'LONG' && row.direction !== 'SHORT') return null;
  if (row.stop == null || !(row.stop > 0)) return null;
  const series = bars(row.symbol);
  if (series == null || series.length === 0) return null;
  const decisionMs = row.decisionTs < 1e11 ? row.decisionTs * 1000 : row.decisionTs;
  let entry: number | null = null;
  for (const bar of series) {
    if (bar.t <= decisionMs) entry = bar.c;
    else break;
  }
  if (entry == null) return null;
  const dir: 1 | -1 = row.direction === 'SHORT' ? -1 : 1;
  const risk = Math.abs(entry - row.stop);
  if (!(risk > 0)) return null;
  const target = entry + dir * TRADING_PARAMS.T1_R * risk;
  const end = decisionMs + HORIZON_SEC * 1000;
  let last = entry;
  for (const bar of series) {
    if (bar.t <= decisionMs) continue;
    if (bar.t > end) break;
    if (dir === 1 ? bar.l <= row.stop : bar.h >= row.stop) return -1;
    if (dir === 1 ? bar.h >= target : bar.l <= target) return (dir * (target - entry)) / risk;
    last = bar.c;
  }
  return (dir * (last - entry)) / risk;
}

interface Stats {
  n: number;
  mean: number | null;
  hit: number | null;
  ci: [number, number] | null;
}

function stats(values: (number | null)[]): Stats {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x));
  if (v.length === 0) return { n: 0, mean: null, hit: null, ci: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.length > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1) : 0;
  const se = v.length > 1 ? Math.sqrt(variance / v.length) : 0;
  return {
    n: v.length,
    mean,
    hit: v.filter((x) => x > 0).length / v.length,
    ci: v.length > 1 ? [mean - 1.96 * se, mean + 1.96 * se] : null,
  };
}

const withR = setups.map((row) => ({ row, r: marketFillR(row) }));

// Il bonus notizia non tocca i veti (ST/ADX/VWAP): con veto attivo il setup
// resta bloccato comunque. Gli altri gate, tranne G11, restano invariati.
const eligible = withR.filter(
  ({ row }) => row.veto == null && (row.blockedGate == null || row.blockedGate === 'G11')
);

const baseline = eligible.filter(({ row }) => (row.score ?? 0) >= threshold);
const actualEmitted = withR.filter(({ row }) => row.emitted);
const scoreGated = eligible.filter(({ row }) => (row.score ?? 0) < threshold);

console.log(`Lift del bonus notizia | mercato ${MARKET} | soglia ${threshold} | ${REPLAY}`);
console.log(
  `setup distinti: ${setups.length} | con R misurabile: ${withR.filter((x) => x.r != null).length} | ` +
    `emessi nel replay: ${actualEmitted.length}`
);
console.log(
  `controllo ricostruzione: sopra soglia+gate ok = ${baseline.length} (replay ${actualEmitted.length}) | ` +
    `bloccati SOLO dal punteggio = ${scoreGated.length} ` +
    `(con livelli ${scoreGated.filter(({ row }) => row.stop != null).length}, con R misurabile ${scoreGated.filter(({ row }) => marketFillR(row) != null).length})`
);

const curve = [];
for (let delta = 0; delta <= 10; delta += 1) {
  const admitted = eligible.filter(({ row }) => Math.min(100, (row.score ?? 0) + delta) >= threshold);
  const marginal = admitted.filter(({ row }) => (row.score ?? 0) < threshold);
  const bookStats = stats(admitted.map((x) => x.r));
  const marginalStats = stats(marginal.map((x) => x.r));
  curve.push({
    bonus: delta,
    emitted: admitted.length,
    emittedWithR: bookStats.n,
    meanR: bookStats.mean,
    ci: bookStats.ci,
    hit: bookStats.hit,
    marginal: marginal.length,
    marginalWithR: marginalStats.n,
    marginalMeanR: marginalStats.mean,
    marginalCi: marginalStats.ci,
    marginalHit: marginalStats.hit,
  });
}

const fmt = (value: number | null, digits = 3) => (value == null ? '   n/d' : value.toFixed(digits).padStart(7));
const pct = (value: number | null) => (value == null ? ' n/d' : `${(value * 100).toFixed(0).padStart(3)}%`);

console.log('\nbonus | emessi | R libro (CI95) | hit | coorte marginale | R marginale (CI95) | hit');
for (const row of curve) {
  const ci = row.ci ? `[${row.ci[0].toFixed(2)}, ${row.ci[1].toFixed(2)}]` : 'n/d';
  const mci = row.marginalCi ? `[${row.marginalCi[0].toFixed(2)}, ${row.marginalCi[1].toFixed(2)}]` : 'n/d';
  console.log(
    `+${String(row.bonus).padStart(2)}pt | ${String(row.emitted).padStart(4)} (${String(row.emittedWithR).padStart(2)} R) | ${fmt(row.meanR)} ${ci.padEnd(16)} | ` +
      `${pct(row.hit)} | ${String(row.marginal).padStart(8)} (${String(row.marginalWithR).padStart(2)} R) | ${fmt(row.marginalMeanR)} ${mci.padEnd(16)} | ${pct(row.marginalHit)}`
  );
}

const payload = {
  generatedAt: new Date().toISOString(),
  market: MARKET,
  threshold,
  replay: REPLAY,
  setups: setups.length,
  measurableR: withR.filter((x) => x.r != null).length,
  emittedInReplay: actualEmitted.length,
  eligibleAboveThreshold: baseline.length,
  scoreGatedOnly: scoreGated.length,
  scoreGatedWithLevels: scoreGated.filter(({ row }) => row.stop != null).length,
  scoreGatedWithR: scoreGated.filter(({ row }) => marketFillR(row) != null).length,
  scoreGatedMeanR: stats(scoreGated.map((x) => x.r)).mean,
  curve,
  limitations: [
    'Il replay non contiene catalyst: la direzione del setup e quella del gap.',
    'Il bonus notizia e modellato come punteggio aggiunto (0-10), non come inversione di direzione.',
    'Il bonus non modifica i veti ST/ADX/VWAP ne gli altri gate.',
  ],
};
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n', 'utf-8');
console.log(`\nscritto ${OUT}`);
