#!/usr/bin/env bun
/**
 * scripts/delay_replay.ts — Passo H / H3
 *
 * Rigenera le decisioni della pipeline su tre dataset identici tranne il ritardo
 * (shift 0 / 15 / 20 minuti) e conta quante decisioni cambiano.
 *
 * Semantica dello shift: la decisione al tempo T usa solo barre con t <= T - shift.
 * Non si spostano i timestamp: si toglie informazione futura, che e' esattamente
 * quello che fa un feed in ritardo.
 *
 * Due modalita':
 *   --mode=adapter  (default) importa scripts/replay_adapter.ts, che devi scrivere tu
 *                   in H3 sulla base di STEP 1(h). Interfaccia in fondo a questo file.
 *   --mode=runner   invoca uno script di replay esistente con --runner="...{input}...{out}"
 *                   e confronta gli output byte per byte. Nessun R-multiple.
 *
 * Uso:
 *   bun scripts/delay_replay.ts --range=30d --shifts=0,15,20
 *   bun scripts/delay_replay.ts --mode=runner --runner="bun scripts/phase2_replay_v2.ts --input={input} --out={out}"
 *
 * Output: artifacts/replay_<data>/ (dataset, risultati, summary.json). Non committare.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { applyEmissionGuard } from './emission_guard';

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

type SetupOut = {
  symbol: string;
  decisionTs: number;
  emitted: boolean;
  direction: string | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  gates: string[] | null;
  reason: string | null;
};

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const SYMBOLS = arg(
  'symbols',
  'ENI.MI,UCG.MI,BAMI.MI,LDO.MI,STLAM.MI,RHM.DE,SAP.DE,SIE.DE,BAYN.DE',
)
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const RANGE = arg('range', '30d');
const SHIFTS = arg('shifts', '0,15,20')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0);
const STEP_SEC = Number(arg('step', '300'));
const HORIZON_SEC = Number(arg('horizon', '3600'));
const MIN_BARS = Number(arg('min-bars', '30'));
const MODE = arg('mode', 'adapter');
const RUNNER = arg('runner', '');
const CACHE_DIR = arg('cache', 'artifacts/bars');
const OUT_DIR = arg('out', `artifacts/replay_${new Date().toISOString().slice(0, 10)}`);
const TIMEOUT_MS = Number(arg('timeout', '20000'));

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function romeHM(tsSec: number): { minutes: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date(tsSec * 1000));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    dow: dows.indexOf(get('weekday')),
  };
}

function inSession(tsSec: number): boolean {
  const { minutes, dow } = romeHM(tsSec);
  return dow >= 1 && dow <= 5 && minutes >= 540 && minutes <= 1050;
}

function cachePath(symbol: string): string {
  return join(CACHE_DIR, `${symbol.replace(/[^A-Za-z0-9._-]/g, '_')}_${RANGE}.json`);
}

async function fetchBars(symbol: string): Promise<Bar[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=5m&range=${RANGE}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; delay-replay/1.0)',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} per ${symbol}`);
  const json: unknown = await res.json();
  const chart = isObj(json) ? json.chart : undefined;
  const results = isObj(chart) ? chart.result : undefined;
  const first = Array.isArray(results) && isObj(results[0]) ? results[0] : null;
  if (first === null) throw new Error(`risposta senza result per ${symbol}`);

  const stamps = Array.isArray(first.timestamp) ? first.timestamp : [];
  const indicators = isObj(first.indicators) ? first.indicators : null;
  const quoteArr =
    indicators !== null && Array.isArray(indicators.quote) ? indicators.quote : [];
  const q0 = quoteArr.length > 0 && isObj(quoteArr[0]) ? quoteArr[0] : null;
  if (q0 === null) throw new Error(`risposta senza quote per ${symbol}`);

  const o = Array.isArray(q0.open) ? q0.open : [];
  const h = Array.isArray(q0.high) ? q0.high : [];
  const l = Array.isArray(q0.low) ? q0.low : [];
  const c = Array.isArray(q0.close) ? q0.close : [];
  const v = Array.isArray(q0.volume) ? q0.volume : [];

  const bars: Bar[] = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const t = num(stamps[i]);
    const bo = num(o[i]);
    const bh = num(h[i]);
    const bl = num(l[i]);
    const bc = num(c[i]);
    const bv = num(v[i]);
    if (t === null || bo === null || bh === null || bl === null || bc === null) continue;
    bars.push({ t, o: bo, h: bh, l: bl, c: bc, v: bv ?? 0 });
  }
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

async function loadOrFetch(symbol: string): Promise<Bar[]> {
  const path = cachePath(symbol);
  if (existsSync(path)) {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(raw)) {
      const out: Bar[] = [];
      for (const item of raw) {
        if (!isObj(item)) continue;
        const t = num(item.t);
        const bo = num(item.o);
        const bh = num(item.h);
        const bl = num(item.l);
        const bc = num(item.c);
        if (t === null || bo === null || bh === null || bl === null || bc === null) continue;
        out.push({ t, o: bo, h: bh, l: bl, c: bc, v: num(item.v) ?? 0 });
      }
      return out;
    }
  }
  const bars = await fetchBars(symbol);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(bars)}\n`);
  return bars;
}

function truncate(bars: Bar[], cutoffTs: number): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    if (b.t <= cutoffTs) out.push(b);
    else break;
  }
  return out;
}

function priceAt(bars: Bar[], tsSec: number): number | null {
  let best: number | null = null;
  for (const b of bars) {
    if (b.t <= tsSec) best = b.c;
    else break;
  }
  return best;
}

function rMultiple(setup: SetupOut, exitPrice: number | null): number | null {
  if (exitPrice === null) return null;
  if (setup.entry === null || setup.stop === null) return null;
  const dir = (setup.direction ?? '').toLowerCase();
  if (dir === 'long') {
    const risk = setup.entry - setup.stop;
    if (risk <= 0) return null;
    return (exitPrice - setup.entry) / risk;
  }
  if (dir === 'short') {
    const risk = setup.stop - setup.entry;
    if (risk <= 0) return null;
    return (setup.entry - exitPrice) / risk;
  }
  return null;
}

type Adapter = {
  runPipeline(input: { symbol: string; decisionTs: number; bars: Bar[] }): SetupOut | null;
};

async function loadAdapter(): Promise<Adapter> {
  // Path non letterale: l'adapter e' opzionale e viene scritto solo se STEP 1(h) esiste.
  // Con un import letterale tsc fallirebbe quando scripts/replay_adapter.ts non esiste.
  const adapterPath = `./replay_adapter.ts`;
  const mod: unknown = await import(/* @vite-ignore */ adapterPath);
  if (!isObj(mod) || typeof mod.runPipeline !== 'function') {
    throw new Error(
      'scripts/replay_adapter.ts deve esportare runPipeline(input): SetupOut | null',
    );
  }
  return mod as unknown as Adapter;
}

function runRunner(inputPath: string, outPath: string): number {
  const cmd = RUNNER.replace('{input}', inputPath).replace('{out}', outPath);
  const res = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  if (res.stdout !== null && res.stdout.length > 0) process.stdout.write(res.stdout);
  if (res.stderr !== null && res.stderr.length > 0) process.stderr.write(res.stderr);
  return res.status === null ? 1 : res.status;
}

function pad(v: string | number | null, width: number): string {
  const s = v === null ? '-' : String(v);
  return s.padStart(width);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`modalita': ${MODE}`);
  console.log(`simboli: ${SYMBOLS.join(' ')}`);
  console.log(`range: ${RANGE}  shift: ${SHIFTS.join(',')} min  orizzonte: ${HORIZON_SEC}s`);
  console.log(`output: ${OUT_DIR}`);

  const series = new Map<string, Bar[]>();
  for (const sym of SYMBOLS) {
    try {
      const bars = await loadOrFetch(sym);
      const session = bars.filter((b) => inSession(b.t));
      series.set(sym, session);
      console.log(`  ${sym}: ${session.length} barre in sessione (${bars.length} totali)`);
    } catch (e: unknown) {
      console.log(`  ${sym}: ERRORE ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (series.size === 0) throw new Error('nessuna serie disponibile');

  const gridSet = new Set<number>();
  for (const bars of series.values()) {
    for (const b of bars) gridSet.add(b.t);
  }
  const grid = Array.from(gridSet).sort((a, b) => a - b);
  console.log(`griglia decisioni: ${grid.length} timestamp`);

  const adapter = MODE === 'adapter' ? await loadAdapter() : null;
  const results: Record<string, SetupOut[]> = {};

  for (const shiftMin of SHIFTS) {
    const shiftSec = shiftMin * 60;
    const key = `shift_${shiftMin}`;
    const dir = join(OUT_DIR, key);
    mkdirSync(dir, { recursive: true });

    if (MODE === 'runner') {
      if (RUNNER.length === 0) throw new Error('--mode=runner richiede --runner');
      const inputPath = join(dir, 'input.json');
      const outPath = join(dir, 'out.json');
      const payload: Record<string, Bar[]> = {};
      for (const [sym, bars] of series) {
        payload[sym] = bars.map((b) => ({ ...b, t: b.t }));
      }
      writeFileSync(inputPath, `${JSON.stringify({ shiftMin, grid, series: payload })}\n`);
      const code = runRunner(inputPath, outPath);
      console.log(`${key}: runner exit ${code}, out ${existsSync(outPath) ? 'presente' : 'ASSENTE'}`);
      continue;
    }

    const rows: SetupOut[] = [];
    for (const decisionTs of grid) {
      const cutoff = decisionTs - shiftSec;
      for (const [sym, bars] of series) {
        const window = truncate(bars, cutoff);
        if (window.length < MIN_BARS) continue;
        let out: SetupOut | null = null;
        try {
          out = adapter === null ? null : adapter.runPipeline({ symbol: sym, decisionTs, bars: window });
        } catch (e: unknown) {
          out = null;
          if (rows.length === 0) {
            console.log(`  adapter ha lanciato: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        rows.push(
          out ?? {
            symbol: sym,
            decisionTs,
            emitted: false,
            direction: null,
            entry: null,
            stop: null,
            target: null,
            gates: null,
            reason: null,
          },
        );
      }
    }
    // Passo N: una sola emissione per (symbol, setupKey) per giornata.
    const guarded = applyEmissionGuard(rows);
    results[key] = guarded;
    writeFileSync(join(dir, 'setups.json'), `${JSON.stringify(guarded)}\n`);
    console.log(`${key}: ${guarded.filter((r) => r.emitted).length} setup su ${guarded.length} valutazioni (riemissioni declassate: ${guarded.filter((r) => r.reason === 'REEMISSIONE').length})`);
  }

  if (MODE === 'runner') {
    const base = join(OUT_DIR, `shift_${SHIFTS[0]}`, 'out.json');
    const baseText = existsSync(base) ? readFileSync(base, 'utf8') : '';
    const diffRows = SHIFTS.slice(1).map((s) => {
      const p = join(OUT_DIR, `shift_${s}`, 'out.json');
      const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
      return { shift: s, identico: text === baseText, bytes: text.length };
    });
    console.log('');
    console.log('shift  identico  bytes');
    for (const r of diffRows) console.log(`${pad(r.shift, 5)}${pad(String(r.identico), 9)}${pad(r.bytes, 7)}`);
    writeFileSync(join(OUT_DIR, 'summary.json'), `${JSON.stringify({ mode: MODE, diffRows }, null, 2)}\n`);
    return;
  }

  const baseKey = `shift_${SHIFTS[0]}`;
  const baseRows = results[baseKey] ?? [];
  const baseMap = new Map<string, SetupOut>();
  for (const r of baseRows) baseMap.set(`${r.symbol}@${r.decisionTs}`, r);

  const summaryRows = SHIFTS.map((shiftMin) => {
    const key = `shift_${shiftMin}`;
    const rows = results[key] ?? [];
    const emitted = rows.filter((r) => r.emitted);
    const rs: number[] = [];
    for (const r of emitted) {
      const bars = series.get(r.symbol) ?? [];
      const exit = priceAt(bars, r.decisionTs + HORIZON_SEC);
      const rv = rMultiple(r, exit);
      if (rv !== null) rs.push(rv);
    }
    let changed = 0;
    for (const r of rows) {
      const b = baseMap.get(`${r.symbol}@${r.decisionTs}`);
      const same =
        b !== undefined &&
        b.emitted === r.emitted &&
        b.direction === r.direction &&
        b.entry === r.entry;
      if (!same) changed += 1;
    }
    const sumR = rs.reduce((a, b) => a + b, 0);
    return {
      shiftMin,
      evaluations: rows.length,
      setups: emitted.length,
      long: emitted.filter((r) => (r.direction ?? '').toLowerCase() === 'long').length,
      short: emitted.filter((r) => (r.direction ?? '').toLowerCase() === 'short').length,
      withR: rs.length,
      sumR: Math.round(sumR * 1000) / 1000,
      meanR: rs.length > 0 ? Math.round((sumR / rs.length) * 1000) / 1000 : null,
      changedVsBase: changed,
      pctChanged:
        rows.length > 0 ? Math.round((changed / rows.length) * 1000) / 10 : null,
    };
  });

  console.log('');
  console.log('shift  valutaz  setup  long  short  conR   sommaR  mediaR  cambiate  %');
  for (const r of summaryRows) {
    console.log(
      `${pad(r.shiftMin, 5)}${pad(r.evaluations, 9)}${pad(r.setups, 7)}${pad(r.long, 6)}` +
        `${pad(r.short, 7)}${pad(r.withR, 6)}${pad(r.sumR, 9)}${pad(r.meanR, 8)}` +
        `${pad(r.changedVsBase, 10)}${pad(r.pctChanged, 6)}`,
    );
  }

  const worst = summaryRows
    .filter((r) => r.shiftMin !== SHIFTS[0])
    .map((r) => r.pctChanged)
    .filter((v): v is number => v !== null);
  const maxPct = worst.length > 0 ? Math.max(...worst) : null;
  console.log('');
  if (maxPct === null) {
    console.log('VERDETTO: nessun confronto disponibile.');
  } else if (maxPct <= 5) {
    console.log(`VERDETTO: al massimo ${maxPct}% di decisioni cambia con il ritardo. Trascurabile.`);
  } else {
    console.log(`VERDETTO: fino al ${maxPct}% di decisioni cambia con il ritardo. Materiale.`);
  }
  console.log('Nota: R e\' calcolato a orizzonte fisso sulle barre NON shiftate. Serve a confrontare gli shift, non e\' l\'R del trade.');

  writeFileSync(
    join(OUT_DIR, 'summary.json'),
    `${JSON.stringify({ mode: MODE, horizonSec: HORIZON_SEC, rows: summaryRows }, null, 2)}\n`,
  );
  console.log(`riepilogo scritto in ${join(OUT_DIR, 'summary.json')}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

/**
 * INTERFACCIA DELL'ADAPTER (scripts/replay_adapter.ts) — da scrivere in H3
 *
 *   import type { ... } from './delay_replay';   // oppure ridichiara i tipi
 *   export function runPipeline(input: {
 *     symbol: string;
 *     decisionTs: number;
 *     bars: { t: number; o: number; h: number; l: number; c: number; v: number }[];
 *   }): {
 *     symbol: string;
 *     decisionTs: number;
 *     emitted: boolean;
 *     direction: string | null;
 *     entry: number | null;
 *     stop: number | null;
 *     target: number | null;
 *     gates: string[] | null;
 *   } | null;
 *
 * Regole: nessuna soglia nuova, nessuna logica nuova, nessun I/O. Solo la traduzione
 * dalla funzione pura trovata in STEP 1(h) a questa forma. Se la funzione pura non
 * esiste o non e' chiamabile senza stato globale, NON inventarla: usa --mode=runner.
 */
