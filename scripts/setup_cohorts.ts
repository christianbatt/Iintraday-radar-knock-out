#!/usr/bin/env bun
/**
 * scripts/setup_cohorts.ts — analisi descrittiva delle coorti di setup EMESSI.
 *
 * Legge i setup emessi gia' registrati dal replay REALE
 * (artifacts/replay_i3_30d|holdout/shift_0/setups.json), li arricchisce con le
 * barre (prezzo all'ingresso) e con lo snapshot (ATR14, EMA20 daily), calcola
 * l'R come delay_replay (close dell'ultima barra con t <= decisionTs + horizon)
 * e stampa le medie per coorte.
 *
 * Non e' un test e non valida un filtro: i campioni sono piccoli (n accanto a
 * ogni media) e serve a scegliere le modifiche con i numeri in mano.
 *
 * Uso:
 *   npx tsx scripts/setup_cohorts.ts --replay=artifacts/replay_i3_30d
 *   npx tsx scripts/setup_cohorts.ts --replay=artifacts/replay_holdout --range=holdout
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
type SetupRow = {
  symbol: string;
  decisionTs: number;
  emitted: boolean;
  direction: string | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  score: number | null;
};

const REPLAY = arg('replay', 'artifacts/replay_i3_30d');
const RANGE = arg('range', '30d');
const HORIZON_SEC = Number(arg('horizon', '3600'));
const SNAPSHOT_PATH = arg('snapshot', 'artifacts/snapshot_9.json');
const OUT = arg('out', `artifacts/setup_cohorts_${RANGE}.json`);
// Controfattuale: distanza minima dello stop in multipli di ATR14 (0 = nessuna).
const STOP_ATR = Number(arg('stop-atr', '0'));
// Cap di dS ammesso dalla leva minima (EU 10x -> 1.0%, US 5x -> 2.0%).
const MAX_DS_PCT = Number(arg('max-ds', '1.0'));
// Modalita' esperimento pre-registrato (stop floor x target x orizzonte).
const EXPERIMENT = arg('experiment', '') === 'true';
// Controfattuale di direzione: entra contro il breakout (fade) invece che a favore.
const MIRROR = arg('mirror', '') === 'true';

const setupPath = join(REPLAY, 'shift_0', 'setups.json');
if (!existsSync(setupPath)) throw new Error(`mancante ${setupPath}`);
const all = JSON.parse(readFileSync(setupPath, 'utf8')) as SetupRow[];
const emitted = all.filter(
  (r) => r.emitted && r.entry != null && r.stop != null && r.entry !== r.stop
);

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as {
  quotes: Array<{ ticker: string; atr14?: number | null; ema20Daily?: number | null }>;
};

function barsFor(sym: string): Bar[] {
  for (const name of [`${sym}_${RANGE}.json`, `${sym}_holdout.json`]) {
    const p = join('artifacts/bars', name);
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Bar[] | { bars: Bar[] };
      return Array.isArray(raw) ? raw : raw.bars;
    }
  }
  throw new Error(`barre mancanti per ${sym} (${RANGE})`);
}

const cache = new Map<string, Bar[]>();
function getBars(sym: string): Bar[] {
  let b = cache.get(sym);
  if (b === undefined) {
    b = barsFor(sym);
    cache.set(sym, b);
  }
  return b;
}

function closeAt(bars: Bar[], ts: number): number | null {
  let out: number | null = null;
  for (const b of bars) {
    if (b.t <= ts) out = b.c;
    else break;
  }
  return out;
}

function stopped(bars: Bar[], entryTs: number, dir: 1 | -1, stop: number): boolean {
  const end = entryTs + HORIZON_SEC * 1000;
  for (const b of bars) {
    if (b.t <= entryTs) continue;
    if (b.t > end) break;
    if (dir === 1 ? b.l <= stop : b.h >= stop) return true;
  }
  return false;
}

/** ATR classico su barre 5m chiuse, saltando le barre a range nullo (fill di feed). */
function atr5mAt(bars: Bar[], ts: number, period = 14): number | null {
  const closed: Bar[] = [];
  for (const b of bars) {
    if (b.t > ts) break;
    if (b.h > b.l) closed.push(b);
  }
  if (closed.length < period + 1) return null;
  let sum = 0;
  for (let i = closed.length - period; i < closed.length; i += 1) {
    const b = closed[i];
    const prev = closed[i - 1];
    sum += Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
  }
  return sum / period;
}

/** R realizzato con le regole di uscita: stop, target k*R, altrimenti close a orizzonte. */
function realizedR(
  bars: Bar[],
  entryTs: number,
  dir: 1 | -1,
  entry: number,
  stop: number,
  target: number,
  horizonSec: number
): number {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return 0;
  const end = entryTs + horizonSec * 1000;
  let last: number = entry;
  for (const b of bars) {
    if (b.t <= entryTs) continue;
    if (b.t > end) break;
    // conservativo: se entrambi toccati nella stessa barra, conta lo stop
    if (dir === 1 ? b.l <= stop : b.h >= stop) return -1;
    if (dir === 1 ? b.h >= target : b.l <= target) return (dir * (target - entry)) / risk;
    last = b.c;
  }
  return (dir * (last - entry)) / risk;
}

type Enriched = {
  symbol: string;
  decisionTs: number;
  direction: 'LONG' | 'SHORT';
  score: number | null;
  entry: number;
  stop: number;
  stopPct: number;
  atr5mPct: number | null;
  stopAtr5mRatio: number | null;
  extensionPct: number | null;
  aligned: boolean | null;
  stopAtrRatio: number | null;
  hour: number;
  markR: number | null;
  movePct: number | null;
  realized: number;
  stopped: boolean;
};

// Copia grezza per gli esperimenti: barre, entryTs, direzione, entry, stop strutturale.
type Raw = {
  symbol: string;
  decisionTs: number;
  dir: 1 | -1;
  entry: number;
  stop: number;
};
const rawRows: Raw[] = [];

const rows: Enriched[] = [];
let skippedCap = 0;
for (const r of emitted) {
  const dir: 1 | -1 = r.direction === 'SHORT' ? -1 : 1;
  const entry = Number(r.entry);
  const stop = Number(r.stop);
  const bars = getBars(r.symbol);
  const close = closeAt(bars, r.decisionTs);
  const exit = closeAt(bars, r.decisionTs + HORIZON_SEC);
  const meta = snapshot.quotes.find((q) => q.ticker === r.symbol);
  const atr = Number(meta?.atr14 ?? NaN);
  const ema = Number(meta?.ema20Daily ?? NaN);
  // Controfattuale: stop portato ad almeno STOP_ATR x ATR14 dal prezzo di ingresso.
  const structuralD = Math.abs(entry - stop);
  const atrFloorD =
    STOP_ATR > 0 && Number.isFinite(atr) && atr > 0 ? STOP_ATR * atr : structuralD;
  const effectiveD = Math.max(structuralD, atrFloorD);
  const cappedStop = entry - dir * effectiveD;
  const dS = (effectiveD / entry) * 100;
  if (STOP_ATR > 0 && dS > MAX_DS_PCT + 1e-9) {
    skippedCap += 1;
    continue;
  }
  const exitAdj = exit;
  const atr5 = atr5mAt(bars, r.decisionTs);
  rawRows.push({ symbol: r.symbol, decisionTs: r.decisionTs, dir, entry, stop });
  rows.push({
    symbol: r.symbol,
    decisionTs: r.decisionTs,
    direction: dir === 1 ? 'LONG' : 'SHORT',
    score: r.score,
    entry,
    stop,
    stopPct: dS,
    atr5mPct: atr5 === null ? null : (atr5 / entry) * 100,
    stopAtr5mRatio: atr5 === null || atr5 <= 0 ? null : Math.abs(entry - stop) / atr5,
    extensionPct:
      close === null ? null : ((close - entry) / entry) * 100 * dir,
    aligned:
      !Number.isFinite(ema) || ema <= 0
        ? null
        : dir === 1
        ? entry >= ema
        : entry <= ema,
    stopAtrRatio: Number.isFinite(atr) && atr > 0 ? Math.abs(entry - stop) / atr : null,
    hour: Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Rome',
        hour: '2-digit',
        hour12: false,
      }).format(new Date(r.decisionTs * 1000))
    ),
    markR: exitAdj === null ? null : (dir * (exitAdj - entry)) / effectiveD,
    movePct: exitAdj === null ? null : ((dir * (exitAdj - entry)) / entry) * 100,
    realized: realizedR(bars, r.decisionTs, dir, entry, cappedStop, entry + dir * 1.6 * effectiveD, HORIZON_SEC),
    stopped: stopped(bars, r.decisionTs, dir, cappedStop),
  });
}

function stats(values: (number | null)[]) {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  if (v.length === 0) return { n: 0, mean: null, sum: 0, hit: 0, ci: null as [number, number] | null };
  const sum = v.reduce((a, b) => a + b, 0);
  const mean = sum / v.length;
  const variance = v.length > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1) : 0;
  const se = v.length > 1 ? Math.sqrt(variance / v.length) : 0;
  return {
    n: v.length,
    mean,
    sum,
    hit: v.filter((x) => x > 0).length / v.length,
    ci: (v.length > 1 ? [mean - 1.96 * se, mean + 1.96 * se] : null) as [number, number] | null,
  };
}

const fmt = (s: ReturnType<typeof stats>): string =>
  s.n === 0
    ? 'n=0'
    : `n=${String(s.n).padStart(3)} meanR=${(s.mean ?? 0).toFixed(3).padStart(7)} ` +
      `hit=${(s.hit * 100).toFixed(0).padStart(3)}% ` +
      (s.ci ? `CI95[${s.ci[0].toFixed(2)}, ${s.ci[1].toFixed(2)}]` : 'CI95 n/d');

function by(label: string, key: (r: Enriched) => string): void {
  const groups = new Map<string, Enriched[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }
  console.log(`\n--- ${label}`);
  for (const [k, arr] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${k.padEnd(22)} ${fmt(stats(arr.map((r) => r.markR)))}`);
  }
}

console.log(
  `replay=${REPLAY}  valutazioni=${all.length}  setup emessi=${rows.length}` +
    (STOP_ATR > 0
      ? `  (controfattuale stop>=${STOP_ATR}xATR, cap dS ${MAX_DS_PCT}%: esclusi ${skippedCap})`
      : '')
);
console.log(`TOTALE                 ${fmt(stats(rows.map((r) => r.markR)))}`);
console.log(`R realizzato (stop/T1/ora) ${fmt(stats(rows.map((r) => r.realized)))}`);
const moves = rows.map((r) => r.movePct).filter((x): x is number => x !== null);
console.log(
  `movimento prezzo a ${HORIZON_SEC / 60}min: media ${moves.length ? (moves.reduce((a, b) => a + b, 0) / moves.length).toFixed(3) : 'n/d'}%`
);
console.log(`stop toccato entro ${HORIZON_SEC / 60} min: ${rows.filter((r) => r.stopped).length}/${rows.length}`);

// ------------------------------------------------- esperimento pre-registrato
// Ipotesi (scritte PRIMA di guardare i risultati):
//   U3  uno stop piu' largo del rumore intraday (>= 1x ATR5m) riduce gli stop
//       prematuri e migliora il R realizzato, senza azzerare il campione;
//   U4  una geometria di uscita piu' corta (T1 1.2R, orizzonte 90 min) batte
//       T1 1.6R / 60 min sul R realizzato.
// Regola di decisione: adottare solo se il miglioramento e' positivo su
// ENTRAMBI i campioni (30d e holdout) e il CI95 del delta esclude lo zero.
// Con n=37 totali il CI largamente includera' lo zero: in quel caso si resta
// su "non dimostrato" e non si cambia nulla.
if (EXPERIMENT) {
  const horizons = [60, 90, 120].map((m) => m * 60);
  const ks = [1.0, 1.2, 1.4, 1.6];
  const stopModes: Array<{ id: string; d: (r: Raw) => number }> = [
    { id: 'structural', d: (r) => Math.abs(r.entry - r.stop) },
    { id: 'floor_0.6pct', d: (r) => Math.max(Math.abs(r.entry - r.stop), r.entry * 0.006) },
    {
      id: 'floor_1.0atr5',
      d: (r) => {
        const atr = atr5mAt(getBars(r.symbol), r.decisionTs);
        return Math.max(Math.abs(r.entry - r.stop), atr ?? 0);
      },
    },
    {
      id: 'floor_1.5atr5',
      d: (r) => {
        const atr = atr5mAt(getBars(r.symbol), r.decisionTs);
        return Math.max(Math.abs(r.entry - r.stop), 1.5 * (atr ?? 0));
      },
    },
  ];
  const capPct = Number(arg('exp-cap', '2.0'));

  type Cell = {
    stop: string;
    k: number;
    horizonMin: number;
    n: number;
    excludedCap: number;
    meanR: number | null;
    sumR: number;
    hit: number | null;
    stopRate: number | null;
    ci: [number, number] | null;
    medianDsPct: number | null;
  };
  const cells: Cell[] = [];

  for (const mode of stopModes) {
    for (const k of ks) {
      for (const horizon of horizons) {
        const rs: number[] = [];
        const ds: number[] = [];
        let excludedCap = 0;
        let stops = 0;
        for (const r of rawRows) {
          const d = mode.d(r);
          if (!(d > 0)) continue;
          if ((d / r.entry) * 100 > capPct + 1e-9) {
            excludedCap += 1;
            continue;
          }
          const bars = getBars(r.symbol);
          const dir = (MIRROR ? -r.dir : r.dir) as 1 | -1;
          const target = r.entry + dir * k * d;
          const stop = r.entry - dir * d;
          const rr = realizedR(bars, r.decisionTs, dir, r.entry, stop, target, horizon);
          rs.push(rr);
          ds.push((d / r.entry) * 100);
          if (rr === -1) stops += 1;
        }
        const st = stats(rs);
        ds.sort((a, b) => a - b);
        cells.push({
          stop: mode.id,
          k,
          horizonMin: horizon / 60,
          n: rs.length,
          excludedCap,
          meanR: st.mean,
          sumR: st.sum,
          hit: rs.length ? st.hit : null,
          stopRate: rs.length ? stops / rs.length : null,
          ci: st.ci,
          medianDsPct: ds.length ? ds[Math.floor(ds.length / 2)] : null,
        });
      }
    }
  }

  console.log(
    `\n=== ESPERIMENTO stop floor x target x orizzonte (cap dS ${capPct}%)${MIRROR ? ' — DIREZIONE INVERTITA (fade)' : ''} ===`
  );
  console.log(
    `n totale emessi=${rawRows.length}  ATR5m mediano=${(() => {
      const v = rows.map((r) => r.atr5mPct).filter((x): x is number => x !== null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)].toFixed(3) : 'n/d';
    })()}%  dS/ATR5m mediano=${(() => {
      const v = rows.map((r) => r.stopAtr5mRatio).filter((x): x is number => x !== null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)].toFixed(2) : 'n/d';
    })()}x`
  );
  const relevant = cells.filter((c) => c.horizonMin === 60 || c.horizonMin === 90);
  for (const c of relevant) {
    console.log(
      `  ${c.stop.padEnd(13)} k=${c.k.toFixed(1)} h=${String(c.horizonMin).padStart(3)}m ` +
        `n=${String(c.n).padStart(2)} (esclusi ${c.excludedCap}) ` +
        `meanR=${(c.meanR ?? 0).toFixed(3).padStart(7)} hit=${((c.hit ?? 0) * 100).toFixed(0).padStart(3)}% ` +
        `stop=${((c.stopRate ?? 0) * 100).toFixed(0).padStart(3)}% dSmed=${(c.medianDsPct ?? 0).toFixed(2)}% ` +
        (c.ci ? `CI95[${c.ci[0].toFixed(2)},${c.ci[1].toFixed(2)}]` : 'CI95 n/d')
    );
  }
  const outExp = `${OUT.replace(/\.json$/, '')}_experiment.json`;
  writeFileSync(outExp, `${JSON.stringify({ range: RANGE, capPct, cells }, null, 1)}\n`);
  console.log(`\nscritto ${outExp}`);
  process.exit(0);
}

by('direzione', (r) => r.direction);
by('trend daily EMA20', (r) => (r.aligned === null ? 'n/d' : r.aligned ? 'allineato' : 'controtrend'));
by('estensione oltre trigger', (r) =>
  r.extensionPct === null
    ? 'n/d'
    : r.extensionPct < 0.1
    ? '<0.10%'
    : r.extensionPct < 0.2
    ? '0.10-0.20%'
    : '>=0.20%'
);
by('distanza stop dS', (r) => (r.stopPct < 0.8 ? '<0.8%' : r.stopPct < 1.2 ? '0.8-1.2%' : '>=1.2%'));
by('stop / ATR14 daily', (r) =>
  r.stopAtrRatio === null ? 'n/d' : r.stopAtrRatio < 0.5 ? '<0.5x' : r.stopAtrRatio < 1 ? '0.5-1x' : '>=1x'
);
by('stop / ATR5m (rumore intraday)', (r) =>
  r.stopAtr5mRatio === null
    ? 'n/d'
    : r.stopAtr5mRatio < 2
    ? '<2x'
    : r.stopAtr5mRatio < 4
    ? '2-4x'
    : '>=4x'
);
by('ora locale', (r) => String(r.hour));
by('score', (r) => (r.score == null ? 'n/d' : r.score < 52 ? '48-52' : r.score < 56 ? '52-56' : '>=56'));
by('simbolo', (r) => r.symbol);

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      replay: REPLAY,
      range: RANGE,
      horizonSec: HORIZON_SEC,
      evaluations: all.length,
      setups: rows.length,
      overall: stats(rows.map((r) => r.markR)),
      rows,
    },
    null,
    1
  )}\n`
);
console.log(`\nscritto ${OUT}`);
