#!/usr/bin/env bun
/**
 * scripts/i3_barrier.ts — Passo H-sexies
 *
 * Post-processing PURO sugli artefatti del replay I3.
 * Non tocca src/, non rigenera il replay, non modifica soglie.
 *
 * Fasi:
 *   0. VALIDAZIONE  ricostruisce l'R mark e verifica di riprodurre i sumR
 *                   pubblicati. Se non li riproduce: exit 2, nessun numero.
 *   1. I3-ter       R a barriera reale (stop / T1 / BE / tempo) camminando le barre.
 *   2. I3-quater    confronto APPAIATO fra shift (separa latenza da composizione).
 *   3. I3-quinquies intervallo t conservativo, per-simbolo, meccanismo.
 *
 * Uso:
 *   bun scripts/i3_barrier.ts --probe
 *   bun scripts/i3_barrier.ts
 *   bun scripts/i3_barrier.ts --horizon=3600 --be-trigger=0.5 --boot=10000
 *   bun scripts/i3_barrier.ts --map=symbol=ticker,entry=entryPrice,stop=stopPrice
 *   bun scripts/i3_barrier.ts --pair-key=symbol|date|direction
 *
 * Exit:
 *   0 ok
 *   2 validazione fallita (sumR non riprodotto)
 *   3 artefatti mancanti
 *   4 schema non riconosciuto
 *   5 appaiamento insufficiente
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- argomenti

const ARGS = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) ARGS.set(m[1], m[2] ?? 'true');
}
const PROBE      = ARGS.has('probe');
const HORIZON    = Number(ARGS.get('horizon') ?? 3600);
const BE_TRIGGER = ARGS.has('be-trigger') ? Number(ARGS.get('be-trigger')) : null;
const BOOT       = Number(ARGS.get('boot') ?? 10000);
const PAIR_KEY   = ARGS.get('pair-key') ?? 'auto';
const SHIFTS     = [0, 15, 20];

const MAP = new Map<string, string>();
for (const pair of (ARGS.get('map') ?? '').split(',').filter(Boolean)) {
  const [k, v] = pair.split('=');
  if (k && v) MAP.set(k.trim(), v.trim());
}

const ART    = 'artifacts';
const REPLAY = join(ART, 'replay_i3_30d');
const BARSD  = join(ART, 'bars');
const OUT    = join(ART, 'i3_barrier_report.json');

// sumR pubblicati e validati in H-bis/H-quinquies (riferimento di validazione)
const EXPECTED_SUMR: Record<number, number> = { 0: -43.953, 15: -57.432, 20: -60.546 };
const SUMP_TOL = 0.10;

// ---------------------------------------------------------------- utility

function fail(code: number, msg: string): never {
  console.error(`\n[STOP exit ${code}] ${msg}\n`);
  process.exit(code);
}
function log(s: string) { console.log(s); }
function pad(s: any, n: number) { return String(s).padEnd(n); }
function num(x: number | null | undefined, d = 3) {
  return x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(d);
}

function pick(o: any, names: string[]): { key: string; value: any } | null {
  if (!o || typeof o !== 'object') return null;
  for (const n of names) {
    if (MAP.has(n) && Object.prototype.hasOwnProperty.call(o, MAP.get(n)!)) {
      return { key: MAP.get(n)!, value: o[MAP.get(n)!] };
    }
  }
  for (const n of names) {
    if (Object.prototype.hasOwnProperty.call(o, n)) return { key: n, value: o[n] };
  }
  return null;
}

function toMs(v: any): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== '') return n < 1e12 ? n * 1000 : n;
    return Date.parse(v);
  }
  return NaN;
}

function normDir(v: any): 1 | -1 | null {
  const s = String(v).trim().toUpperCase();
  if (['LONG', 'BUY', 'L', 'TRADE_LONG', 'UP'].includes(s)) return 1;
  if (['SHORT', 'SELL', 'S', 'TRADE_SHORT', 'DOWN'].includes(s)) return -1;
  return null;
}

const DTF = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
});
function sessionDate(ms: number) { return DTF.format(new Date(ms)); }
function romeNow() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'medium',
  }).format(new Date());
}

function mean(a: number[]) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }
function sd(a: number[]) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function quantile(sorted: number[], p: number) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// t_{0.975, df} per df 1..30
const T975: number[] = [
  0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];
function tCrit(df: number) {
  if (df < 1) return NaN;
  if (df <= 30) return T975[df];
  return 1.96 + 2.4 / df; // approssimazione per df > 30
}

// ---------------------------------------------------------------- tipi

interface Bar { t: number; o: number; h: number; l: number; c: number; }
interface Setup {
  raw: any; symbol: string; dir: 1 | -1;
  entry: number; stop: number; target: number;
  entryTs: number; date: string; key: string;
  markR: number | null;
  barrierR: number | null; barrierExit: string; barrierBars: number;
}

// ---------------------------------------------------------------- caricamento

function loadSetups(shift: number): any[] {
  const p = join(REPLAY, `shift_${shift}`, 'setups.json');
  if (!existsSync(p)) fail(3, `artefatto mancante: ${p}`);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const arr = Array.isArray(raw) ? raw
    : Array.isArray(raw.setups) ? raw.setups
    : Array.isArray(raw.rows) ? raw.rows
    : Array.isArray(raw.data) ? raw.data
    : null;
  if (!arr) fail(4, `struttura non riconosciuta in ${p}. Chiavi: ${Object.keys(raw).join(', ')}`);
  return arr;
}

function normBars(raw: any): Bar[] {
  const arr = Array.isArray(raw) ? raw
    : Array.isArray(raw.bars) ? raw.bars
    : Array.isArray(raw.data) ? raw.data
    : Array.isArray(raw.rows) ? raw.rows
    : null;
  if (!arr) return [];
  const out: Bar[] = [];
  for (const b of arr) {
    const t = pick(b, ['t', 'ts', 'timestamp', 'time', 'date', 'datetime', 'start']);
    const o = pick(b, ['o', 'open']);
    const h = pick(b, ['h', 'high']);
    const l = pick(b, ['l', 'low']);
    const c = pick(b, ['c', 'close']);
    if (!t || !o || !h || !l || !c) continue;
    const ms = toMs(t.value);
    if (!Number.isFinite(ms)) continue;
    out.push({ t: ms, o: +o.value, h: +h.value, l: +l.value, c: +c.value });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const BAR_CACHE = new Map<string, Bar[] | null>();
function loadBars(symbol: string): Bar[] | null {
  if (BAR_CACHE.has(symbol)) return BAR_CACHE.get(symbol)!;
  let result: Bar[] | null = null;
  if (existsSync(BARSD)) {
    const files = readdirSync(BARSD).filter(f => f.endsWith('.json'));
    const norm = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const target = norm(symbol);
    const hit = files.find(f => norm(f).startsWith(target))
             ?? files.find(f => norm(f).includes(target));
    if (hit) {
      try { result = normBars(JSON.parse(readFileSync(join(BARSD, hit), 'utf8'))); }
      catch { result = null; }
      if (result && result.length === 0) result = null;
    }
  }
  BAR_CACHE.set(symbol, result);
  return result;
}

function buildSetups(raw: any[], shift: number): Setup[] {
  const out: Setup[] = [];
  let skipped = 0;
  for (const r of raw) {
    const sym   = pick(r, ['symbol', 'ticker', 'sym', 'underlying']);
    const dirR  = pick(r, ['direction', 'side', 'dir', 'signal']);
    const entry = pick(r, ['entry', 'entryPrice', 'entry_price', 'entryPx']);
    const stop  = pick(r, ['stop', 'stopPrice', 'stop_price', 'stopPx', 'stopLoss']);
    const tgt   = pick(r, ['target', 't1', 'targetPrice', 't1Price', 'takeProfit']);
    const ts    = pick(r, ['decisionTs', 'entryTs', 'ts', 'timestamp', 'decisionTime', 'time']);
    const dir   = dirR ? normDir(dirR.value) : null;
    if (!sym || !dir || !entry || !stop || !ts) { skipped++; continue; }
    const entryTs = toMs(ts.value);
    const e = Number(entry.value), s = Number(stop.value);
    if (!Number.isFinite(entryTs) || !Number.isFinite(e) || !Number.isFinite(s)) { skipped++; continue; }
    if (Math.abs(e - s) <= 0) { skipped++; continue; }
    out.push({
      raw: r, symbol: String(sym.value), dir,
      entry: e, stop: s,
      target: tgt ? Number(tgt.value) : NaN,
      entryTs, date: sessionDate(entryTs), key: '',
      markR: null, barrierR: null, barrierExit: '', barrierBars: 0,
    });
  }
  if (skipped) log(`  (shift ${shift}: ${skipped} righe scartate per campi mancanti o non validi)`);
  return out;
}

// ---------------------------------------------------------------- R mark

function markRAt(s: Setup, bars: Bar[], horizonSec: number,
                 variant: 'lastBefore' | 'firstAfter' | 'nearest'): number | null {
  const risk = Math.abs(s.entry - s.stop);
  if (!(risk > 0)) return null;
  const tgt = s.entryTs + horizonSec * 1000;
  let bar: Bar | null = null;
  if (variant === 'lastBefore') {
    for (const b of bars) { if (b.t <= tgt) bar = b; else break; }
  } else if (variant === 'firstAfter') {
    for (const b of bars) { if (b.t >= tgt) { bar = b; break; } }
  } else {
    let best = Infinity;
    for (const b of bars) { const d = Math.abs(b.t - tgt); if (d < best) { best = d; bar = b; } }
  }
  if (!bar) return null;
  return s.dir * (bar.c - s.entry) / risk;
}

function directR(s: Setup): number | null {
  const f = pick(s.raw, ['r', 'rMultiple', 'r_multiple', 'markR', 'R', 'rMark']);
  if (!f) return null;
  const v = Number(f.value);
  return Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------- R a barriera

function barrierR(s: Setup, bars: Bar[], horizonSec: number, beTrigger: number | null) {
  const risk = Math.abs(s.entry - s.stop);
  if (!(risk > 0)) return { r: null as number | null, exit: 'unresolved', nBars: 0 };
  const tEnd = s.entryTs + horizonSec * 1000;
  const target = Number.isFinite(s.target) && s.target > 0
    ? s.target
    : s.entry + s.dir * 1.6 * risk;

  let stop = s.stop;
  let beArmed = false;
  let nBars = 0;
  let lastClose: number | null = null;

  for (const b of bars) {
    if (b.t <= s.entryTs) continue;
    if (b.t > tEnd) break;
    nBars++;
    lastClose = b.c;

    const stopHit = s.dir > 0 ? b.l <= stop : b.h >= stop;
    const t1Hit   = s.dir > 0 ? b.h >= target : b.l <= target;

    // Pessimistico: se stop e target cadono nella stessa barra, vince lo stop.
    if (stopHit) {
      return {
        r: s.dir * (stop - s.entry) / risk,
        exit: beArmed ? 'be' : 'stop',
        nBars,
      };
    }
    if (t1Hit) {
      return { r: s.dir * (target - s.entry) / risk, exit: 't1', nBars };
    }

    // BE armato a fine barra, valido dalle barre successive (lettura conservativa).
    if (beTrigger !== null && !beArmed) {
      const reached = s.dir > 0
        ? (b.h - s.entry) / risk >= beTrigger
        : (s.entry - b.l) / risk >= beTrigger;
      if (reached) { beArmed = true; stop = s.entry; }
    }
  }

  if (lastClose === null) return { r: null as number | null, exit: 'unresolved', nBars };
  return { r: s.dir * (lastClose - s.entry) / risk, exit: 'time', nBars };
}

// ---------------------------------------------------------------- bootstrap

function blockBootstrap(items: { date: string; v: number }[], iters: number, seed = 42) {
  const byDate = new Map<string, number[]>();
  for (const it of items) {
    if (!byDate.has(it.date)) byDate.set(it.date, []);
    byDate.get(it.date)!.push(it.v);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return { lo: NaN, hi: NaN, nBlocks: dates.length, excludesZero: null as boolean | null };
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0, n = 0;
    for (let d = 0; d < dates.length; d++) {
      const pickDate = dates[Math.floor(rng() * dates.length)];
      for (const v of byDate.get(pickDate)!) { sum += v; n++; }
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const lo = quantile(means, 0.025), hi = quantile(means, 0.975);
  return { lo, hi, nBlocks: dates.length, excludesZero: lo > 0 || hi < 0 };
}

function tInterval(items: { date: string; v: number }[]) {
  const byDate = new Map<string, number[]>();
  for (const it of items) {
    if (!byDate.has(it.date)) byDate.set(it.date, []);
    byDate.get(it.date)!.push(it.v);
  }
  const daily = [...byDate.values()].map(mean);
  const df = daily.length - 1;
  const m = mean(daily), s = sd(daily);
  const se = s / Math.sqrt(daily.length);
  const tc = tCrit(df);
  const lo = m - tc * se, hi = m + tc * se;
  return { nDays: daily.length, df, meanDaily: m, sdDaily: s, se, tCrit: tc, lo, hi,
           excludesZero: Number.isFinite(lo) && Number.isFinite(hi) ? (lo > 0 || hi < 0) : null };
}

// ---------------------------------------------------------------- probe

function probe() {
  log('=== PROBE — schema artefatti ===\n');

  const p0 = join(REPLAY, 'shift_0', 'setups.json');
  if (!existsSync(p0)) fail(3, `mancante: ${p0}`);
  const raw = JSON.parse(readFileSync(p0, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.setups ?? raw.rows ?? raw.data ?? [];
  log(`setups.json: ${Array.isArray(raw) ? 'array' : 'oggetto, chiavi: ' + Object.keys(raw).join(', ')}`);
  log(`righe: ${arr.length}`);
  log('\n--- chiavi della prima riga (valore di esempio) ---');
  const first = arr[0] ?? {};
  for (const k of Object.keys(first)) log(`  ${pad(k, 28)} = ${JSON.stringify(first[k])}`);

  log('\n--- file barre ---');
  if (!existsSync(BARSD)) { log(`  directory assente: ${BARSD}`); }
  else {
    const files = readdirSync(BARSD).filter(f => f.endsWith('.json'));
    log(`  ${files.length} file: ${files.join(', ')}`);
    if (files.length) {
      const b = normBars(JSON.parse(readFileSync(join(BARSD, files[0]), 'utf8')));
      log(`  ${files[0]}: ${b.length} barre normalizzate`);
      if (b.length > 2) {
        const diffs: number[] = [];
        for (let i = 1; i < b.length; i++) diffs.push(b[i].t - b[i - 1].t);
        diffs.sort((x, y) => x - y);
        const med = quantile(diffs, 0.5) / 1000;
        log(`  intervallo mediano: ${med}s (${med / 60} min)`);
        log(`  prima barra: ${new Date(b[0].t).toISOString()}  ultima: ${new Date(b[b.length - 1].t).toISOString()}`);
        log(`  esempio: ${JSON.stringify(b[0])}`);
      }
      if (b.length === 0) log('  ATTENZIONE: normalizzazione fallita, chiavi non riconosciute');
    }
  }

  log('\n--- chiavi di appaiamento candidate (shift 0 vs 15) ---');
  const s0 = buildSetups(loadSetups(0), 0);
  const s15 = buildSetups(loadSetups(15), 15);
  const cands: Record<string, (s: Setup) => string> = {
    'symbol|date|direction': s => `${s.symbol}|${s.date}|${s.dir}`,
    'symbol|date':           s => `${s.symbol}|${s.date}`,
    'symbol|direction':      s => `${s.symbol}|${s.dir}`,
  };
  for (const [name, fn] of Object.entries(cands)) {
    const k0 = new Set(s0.map(fn)), k15 = new Set(s15.map(fn));
    let inter = 0;
    for (const k of k0) if (k15.has(k)) inter++;
    log(`  ${pad(name, 24)} n0=${k0.size} n15=${k15.size} appaiati=${inter}`);
  }

  log('\n--- R diretto presente nei setup? ---');
  log(`  ${directR(s0[0]) !== null ? 'SI (campo R trovato)' : 'NO (va ricostruito dalle barre)'}`);

  log('\n=== fine probe ===');
}

// ---------------------------------------------------------------- main

function main() {
  log(`i3_barrier — inizio ${new Date().toISOString()} (Europe/Rome: ${romeNow()})`);
  log(`parametri: horizon=${HORIZON}s be-trigger=${BE_TRIGGER ?? 'off'} boot=${BOOT} pair-key=${PAIR_KEY}`);
  log('');

  if (PROBE) { probe(); return; }

  // ---- caricamento
  const data: Record<number, Setup[]> = {};
  for (const sh of SHIFTS) {
    const raw = loadSetups(sh);
    data[sh] = buildSetups(raw, sh);
    log(`shift ${sh}: ${data[sh].length} setup validi su ${raw.length} righe`);
  }
  log('');

  // ---- FASE 0: validazione del metodo
  log('=== FASE 0 — validazione (riproduzione dei sumR pubblicati) ===');
  const direct = directR(data[0][0] ?? { raw: {} } as Setup) !== null;
  const variants: Array<'lastBefore' | 'firstAfter' | 'nearest'> =
    ['lastBefore', 'firstAfter', 'nearest'];
  let chosen: 'direct' | 'lastBefore' | 'firstAfter' | 'nearest' | null = null;
  let chosenSums: Record<number, number> | null = null;

  const computeSums = (v: 'direct' | 'lastBefore' | 'firstAfter' | 'nearest') => {
    const sums: Record<number, number> = {};
    const counts: Record<number, number> = {};
    for (const sh of SHIFTS) {
      let sum = 0, n = 0;
      for (const s of data[sh]) {
        let r: number | null = null;
        if (v === 'direct') r = directR(s);
        else {
          const bars = loadBars(s.symbol);
          if (bars) r = markRAt(s, bars, HORIZON, v);
        }
        if (r !== null && Number.isFinite(r)) { sum += r; n++; }
      }
      sums[sh] = sum; counts[sh] = n;
    }
    return { sums, counts };
  };

  const candidates: Array<'direct' | 'lastBefore' | 'firstAfter' | 'nearest'> =
    direct ? ['direct', 'lastBefore', 'firstAfter', 'nearest']
           : ['lastBefore', 'firstAfter', 'nearest'];

  for (const v of candidates) {
    const { sums, counts } = computeSums(v);
    const ok = SHIFTS.every(sh => Math.abs(sums[sh] - EXPECTED_SUMR[sh]) <= SUMP_TOL);
    log(`  ${pad(v, 12)} sumR: ${SHIFTS.map(sh => `${sh}=${num(sums[sh])} (n=${counts[sh]})`).join('  ')}  ${ok ? '<<< MATCH' : ''}`);
    if (ok && chosen === null) { chosen = v; chosenSums = sums; }
  }

  if (chosen === null) {
    log('');
    fail(2, [
      'Nessuna variante riproduce i sumR pubblicati entro la tolleranza ' + SUMP_TOL + '.',
      `Attesi: ${SHIFTS.map(sh => `${sh}=${EXPECTED_SUMR[sh]}`).join(', ')}`,
      'Cause possibili: (a) le barre in cache non coprono gli stessi intervalli del replay;',
      '(b) il campo di entry/stop usato non e\' quello del replay;',
      '(c) l\'orizzonte del mark non e\' 3600s; (d) la definizione di R differisce.',
      'NON procedo: nessun numero prodotto. Usa --probe e --map per correggere i campi,',
      'oppure --horizon=<altro> se il mark usa un orizzonte diverso.',
    ].join('\n'));
  }
  log(`\n  variante validata: ${chosen}`);
  log(`  sumR riprodotti: ${SHIFTS.map(sh => `${sh}=${num(chosenSums![sh])}`).join(', ')}\n`);

  // assegna markR
  for (const sh of SHIFTS) {
    for (const s of data[sh]) {
      if (chosen === 'direct') s.markR = directR(s);
      else {
        const bars = loadBars(s.symbol);
        s.markR = bars ? markRAt(s, bars, HORIZON, chosen) : null;
      }
    }
  }

  // ---- FASE 1: I3-ter, R a barriera
  log('=== FASE 1 (I3-ter) — R a barriera reale ===');
  let unresolved = 0;
  for (const sh of SHIFTS) {
    for (const s of data[sh]) {
      const bars = loadBars(s.symbol);
      if (!bars) { unresolved++; continue; }
      const b = barrierR(s, bars, HORIZON, BE_TRIGGER);
      s.barrierR = b.r; s.barrierExit = b.exit; s.barrierBars = b.nBars;
      if (b.r === null) unresolved++;
    }
  }
  if (unresolved) log(`  ATTENZIONE: ${unresolved} setup senza R a barriera (barre mancanti o non risolvibili)`);

  const ter: Record<number, any> = {};
  for (const sh of SHIFTS) {
    const valid = data[sh].filter(s => s.barrierR !== null);
    const rs = valid.map(s => s.barrierR!);
    const wins = rs.filter(r => r > 0), losses = rs.filter(r => r < 0);
    const exits: Record<string, number> = {};
    for (const s of valid) exits[s.barrierExit] = (exits[s.barrierExit] ?? 0) + 1;
    const boot = blockBootstrap(valid.map(s => ({ date: s.date, v: s.barrierR! })), BOOT);
    const markRs = data[sh].map(s => s.markR).filter((r): r is number => r !== null && Number.isFinite(r));
    ter[sh] = {
      n: valid.length,
      meanR: mean(rs), sdR: sd(rs),
      hitRate: rs.length ? wins.length / rs.length : NaN,
      meanWin: mean(wins), meanLoss: Math.abs(mean(losses)),
      wlRatio: wins.length && losses.length ? mean(wins) / Math.abs(mean(losses)) : NaN,
      wlRequired: wins.length ? (rs.length - wins.length) / wins.length : NaN,
      ci95: [boot.lo, boot.hi], excludesZero: boot.excludesZero, nBlocks: boot.nBlocks,
      exits,
      meanMarkR: mean(markRs),
      deltaVsMark: mean(rs) - mean(markRs),
    };
    log(`  shift ${pad(sh, 3)} n=${pad(valid.length, 4)} meanR=${pad(num(ter[sh].meanR), 8)} ` +
        `CI95=[${num(boot.lo)}, ${num(boot.hi)}] esclude0=${boot.excludesZero} ` +
        `hit=${num(ter[sh].hitRate * 100, 1)}% ` +
        `uscite: ${Object.entries(exits).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    log(`           mark=${num(ter[sh].meanMarkR)}  delta(barriera-mark)=${num(ter[sh].deltaVsMark)}`);
  }
  log('');

  // ---- FASE 2: I3-quater, confronto appaiato
  log('=== FASE 2 (I3-quater) — confronto appaiato ===');
  const keyFns: Record<string, (s: Setup) => string> = {
    'symbol|date|direction': s => `${s.symbol}|${s.date}|${s.dir}`,
    'symbol|date':           s => `${s.symbol}|${s.date}`,
    'symbol|direction':      s => `${s.symbol}|${s.dir}`,
  };
  let keyName = PAIR_KEY;
  if (PAIR_KEY === 'auto') {
    // sceglie la chiave con il maggior numero di appaiati senza superare il minimo dei due shift
    let best = '', bestScore = -1;
    for (const [name, fn] of Object.entries(keyFns)) {
      const k0 = new Set(data[0].map(fn)), k15 = new Set(data[15].map(fn));
      let inter = 0;
      for (const k of k0) if (k15.has(k)) inter++;
      const score = inter;
      log(`  chiave ${pad(name, 24)} appaiati=${inter}`);
      if (score > bestScore) { bestScore = score; best = name; }
    }
    keyName = best;
    log(`  chiave scelta: ${keyName}\n`);
  }
  const keyFn = keyFns[keyName];
  if (!keyFn) fail(4, `--pair-key sconosciuta: ${keyName}. Valori: ${Object.keys(keyFns).join(', ')}`);

  const quater: Record<string, any> = {};
  for (const sh of [15, 20]) {
    const map0 = new Map<string, Setup>();
    for (const s of data[0]) map0.set(keyFn(s), s);
    const mapS = new Map<string, Setup>();
    for (const s of data[sh]) mapS.set(keyFn(s), s);

    const paired: Array<{ date: string; dMark: number; dBarrier: number }> = [];
    const onlyNew: Setup[] = [];
    let onlyOld = 0;
    for (const [k, s] of mapS) {
      const s0 = map0.get(k);
      if (!s0) { onlyNew.push(s); continue; }
      const dMark = (s.markR !== null && s0.markR !== null) ? s.markR - s0.markR : NaN;
      const dBar  = (s.barrierR !== null && s0.barrierR !== null) ? s.barrierR - s0.barrierR : NaN;
      if (Number.isFinite(dMark) || Number.isFinite(dBar)) {
        paired.push({ date: s.date, dMark, dBarrier: dBar });
      }
    }
    for (const k of map0.keys()) if (!mapS.has(k)) onlyOld++;

    const dMarkVals = paired.filter(p => Number.isFinite(p.dMark)).map(p => ({ date: p.date, v: p.dMark }));
    const dBarVals  = paired.filter(p => Number.isFinite(p.dBarrier)).map(p => ({ date: p.date, v: p.dBarrier }));
    const bootMark = blockBootstrap(dMarkVals, BOOT);
    const bootBar  = blockBootstrap(dBarVals, BOOT);

    const newRs = onlyNew.map(s => s.barrierR).filter((r): r is number => r !== null);
    const newMarkRs = onlyNew.map(s => s.markR).filter((r): r is number => r !== null);
    const newBySymbol: Record<string, number> = {};
    for (const s of onlyNew) newBySymbol[s.symbol] = (newBySymbol[s.symbol] ?? 0) + 1;
    const newByDate: Record<string, number> = {};
    for (const s of onlyNew) newByDate[s.date] = (newByDate[s.date] ?? 0) + 1;

    quater[`shift${sh}`] = {
      nPaired: paired.length,
      nOnlyNew: onlyNew.length,
      nOnlyOld: onlyOld,
      meanDiffMark: mean(dMarkVals.map(x => x.v)),
      ci95DiffMark: [bootMark.lo, bootMark.hi],
      excludesZeroMark: bootMark.excludesZero,
      meanDiffBarrier: mean(dBarVals.map(x => x.v)),
      ci95DiffBarrier: [bootBar.lo, bootBar.hi],
      excludesZeroBarrier: bootBar.excludesZero,
      nBlocks: bootMark.nBlocks,
      meanRNewBarrier: mean(newRs),
      meanRNewMark: mean(newMarkRs),
      newBySymbol, newByDate,
    };
    const q = quater[`shift${sh}`];
    log(`  shift 0 vs ${sh}: appaiati=${q.nPaired}  solo-nuovi=${q.nOnlyNew}  solo-vecchi=${q.nOnlyOld}`);
    log(`    costo appaiato (mark)    = ${num(q.meanDiffMark)}  CI95=[${num(q.ci95DiffMark[0])}, ${num(q.ci95DiffMark[1])}] esclude0=${q.excludesZeroMark}`);
    log(`    costo appaiato (barriera)= ${num(q.meanDiffBarrier)}  CI95=[${num(q.ci95DiffBarrier[0])}, ${num(q.ci95DiffBarrier[1])}] esclude0=${q.excludesZeroBarrier}`);
    log(`    nuovi setup: meanR barriera=${num(q.meanRNewBarrier)} mark=${num(q.meanRNewMark)}`);
    log(`    nuovi per simbolo: ${Object.entries(newBySymbol).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    log(`    nuovi per giorno:   ${Object.entries(newByDate).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  }
  log('');

  // ---- FASE 3: I3-quinquies, robustezza e meccanismo
  log('=== FASE 3 (I3-quinquies) — robustezza e meccanismo ===');
  const quinquies: Record<number, any> = {};
  for (const sh of SHIFTS) {
    const valid = data[sh].filter(s => s.barrierR !== null);
    const ti = tInterval(valid.map(s => ({ date: s.date, v: s.barrierR! })));
    const boot = blockBootstrap(valid.map(s => ({ date: s.date, v: s.barrierR! })), BOOT);
    quinquies[sh] = {
      tInterval: ti,
      bootstrap: { lo: boot.lo, hi: boot.hi },
      cambiaVerdetto: ti.excludesZero !== boot.excludesZero,
    };
    log(`  shift ${pad(sh, 3)} t-intervallo [${num(ti.lo)}, ${num(ti.hi)}] (df=${ti.df}, t=${num(ti.tCrit)}) ` +
        `bootstrap [${num(boot.lo)}, ${num(boot.hi)}]  verdetto cambia: ${quinquies[sh].cambiaVerdetto ? 'SI' : 'NO'}`);
  }

  log('\n  --- per simbolo (shift 0, R a barriera) ---');
  const bySym: Record<string, any> = {};
  const symbols = [...new Set(data[0].map(s => s.symbol))];
  for (const sym of symbols) {
    const ss = data[0].filter(s => s.symbol === sym && s.barrierR !== null);
    if (!ss.length) continue;
    const rs = ss.map(s => s.barrierR!);
    const stopPct = ss.map(s => Math.abs(s.entry - s.stop) / s.entry * 100);
    const move1h = ss.map(s => {
      const bars = loadBars(s.symbol);
      if (!bars) return NaN;
      const r = markRAt(s, bars, HORIZON, 'lastBefore');
      return r === null ? NaN : Math.abs(r) * Math.abs(s.entry - s.stop) / s.entry * 100;
    }).filter(Number.isFinite);
    bySym[sym] = {
      n: ss.length, meanR: mean(rs), sdR: sd(rs),
      hitRate: rs.filter(r => r > 0).length / rs.length,
      stopPctMedian: quantile([...stopPct].sort((a, b) => a - b), 0.5),
      move1hPctMean: mean(move1h),
    };
    const b = bySym[sym];
    log(`  ${pad(sym, 10)} n=${pad(b.n, 4)} meanR=${pad(num(b.meanR), 8)} hit=${pad(num(b.hitRate * 100, 1), 6)}% ` +
        `stop%=${pad(num(b.stopPctMedian, 2), 6)} move1h%=${num(b.move1hPctMean, 3)}`);
  }

  // ---- output
  const report = {
    generatedAt: new Date().toISOString(),
    params: { horizon: HORIZON, beTrigger: BE_TRIGGER, boot: BOOT, pairKey: keyName, validatedVariant: chosen },
    validation: { expectedSumR: EXPECTED_SUMR, reproducedSumR: chosenSums, tolerance: SUMP_TOL },
    i3ter: ter,
    i3quater: quater,
    i3quinquies: { shifts: quinquies, perSymbol: bySym },
  };
  if (!existsSync(ART)) mkdirSync(ART, { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  log(`\nreport scritto in ${OUT}`);
  log(`i3_barrier — fine ${new Date().toISOString()} (Europe/Rome: ${romeNow()})`);
}

main();
