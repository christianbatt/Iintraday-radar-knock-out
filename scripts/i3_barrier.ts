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
const PROBE          = ARGS.has('probe');
const COUNTERFACTUAL = ARGS.has('counterfactual');
const JACKKNIFE      = ARGS.has('jackknife');

// Orizzonte della BARRIERA: numero di secondi oppure 'resolution'
// (cammina le barre fino a stop/T1/fine serie, senza limite di tempo).
const HORIZON_RAW  = ARGS.get('horizon') ?? '3600';
const HORIZON_MODE: 'resolution' | 'fixed' =
  HORIZON_RAW === 'resolution' ? 'resolution' : 'fixed';
const HORIZON = HORIZON_MODE === 'resolution' ? Infinity : Number(HORIZON_RAW);
if (HORIZON_MODE === 'fixed' && !Number.isFinite(HORIZON)) {
  fail(7, `--horizon non valido: '${HORIZON_RAW}'. Usa un numero di secondi oppure 'resolution'.`);
}
// Il MARK resta definito a 3600s (delay_replay.ts:60, default di --horizon):
// la modalita' resolution non deve cambiare la validazione della FASE 0.
const MARK_HORIZON = 3600;

// BE: assente o 'off' -> null; numero >= 0 -> quel valore; altro -> exit 7 (niente NaN).
const BE_RAW = ARGS.has('be-trigger') ? (ARGS.get('be-trigger') ?? '') : null;
let BE_TRIGGER: number | null = null;
if (BE_RAW !== null && BE_RAW !== 'off') {
  const v = Number(BE_RAW);
  if (BE_RAW.trim() === '' || !Number.isFinite(v) || v < 0) {
    fail(7, `--be-trigger non valido: '${BE_RAW}'. Usa 'off' oppure un numero >= 0.`);
  }
  BE_TRIGGER = v;
}
const BOOT       = Number(ARGS.get('boot') ?? 10000);
const PAIR_KEY   = ARGS.get('pair-key') ?? 'ts-norm|dir';
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
  barrierTs?: number | null; barrierSameBar?: boolean;
  emitted?: boolean; gates?: string[]; blockedGate?: string | null;
}

type Variant = 'direct' | 'markRReplay' | 'lastBefore' | 'firstAfter' | 'nearest';

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
const BAR_FILE = new Map<string, string>();
function loadBars(symbol: string): Bar[] | null {
  if (BAR_CACHE.has(symbol)) return BAR_CACHE.get(symbol)!;
  let result: Bar[] | null = null;
  if (existsSync(BARSD)) {
    const files = readdirSync(BARSD).filter(f => f.endsWith('.json')).sort();
    const base = symbol.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const cands = files.map(f => {
        const m = f.match(/^(.+)_(\d+)d\.json$/);
        if (!m) return null;
        const s = m[1].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        return s === base ? { f, days: Number(m[2]) } : null;
      })
      .filter((x): x is { f: string; days: number } => x !== null)
      .sort((a, b) => b.days - a.days);
    const hit = cands.length > 0 ? cands[0].f : null;
    if (hit) {
      BAR_FILE.set(symbol, hit);
      try { result = normBars(JSON.parse(readFileSync(join(BARSD, hit), 'utf8'))); }
      catch { result = null; }
      if (result && result.length === 0) result = null;
    }
  }
  BAR_CACHE.set(symbol, result);
  return result;
}

/**
 * Tabella dei gate G1..G13, letta da src/utils/calculator.ts:2153-2316 (sola lettura).
 * `gates` negli artefatti = gate PASSATI: bloccante = primo assente in quest'ordine.
 */
const GATES: Array<{ sigla: string; label: string; condizione: string; soglia: string; ref: string }> = [
  { sigla: 'G1',  label: 'Liquidita',        condizione: 'liqEur20d >= soglia; se liqEur assente o barre complete < 20 PASSA (cade in G2)', soglia: 'LIQ_MIN_EUR 3.000.000 EUR; LIQ_BARS_REQUIRED 20', ref: 'calculator.ts:2153-2162' },
  { sigla: 'G2',  label: 'Dati',             condizione: 'ORB high/low, prezzo>0, gap%, ATR14>0, ADR14>0, C_ieri>0, volume medio>0, liqEur>0, barre complete >= 20', soglia: 'nessuna soglia numerica', ref: 'calculator.ts:2164-2186' },
  { sigla: 'G3',  label: 'Orario ORB',       condizione: 'non prima della chiusura dell ORB', soglia: 'marketTime.isBeforeOrb', ref: 'calculator.ts:2188-2192' },
  { sigla: 'G4',  label: 'Estensione',       condizione: 'estensione oltre il trigger <= EST_MAX', soglia: 'EST_MAX 0.004 (0.40%)', ref: 'calculator.ts:2194-2200' },
  { sigla: 'G5',  label: 'Freschezza',       condizione: 'minuti da Tb (prima rottura) <= FRESH_MIN', soglia: 'FRESH_MIN 60 min', ref: 'calculator.ts:2202-2214' },
  { sigla: 'G6',  label: 'Target',           condizione: 'T1 non ancora raggiunto in sessione (H_sess < T1 long, L_sess > T1 short)', soglia: 'T1', ref: 'calculator.ts:2216-2225' },
  { sigla: 'G7',  label: 'ADR',              condizione: 'consumo ADR14 <= ADR_MAX', soglia: 'ADR_MAX 0.60', ref: 'calculator.ts:2227-2234' },
  { sigla: 'G8',  label: 'Stop distanza',    condizione: 'dS <= LMAX / min(LEVE)', soglia: 'LMAX 0.10 / 10 = 0.01 (1.0%)', ref: 'calculator.ts:2236-2243' },
  { sigla: 'G9',  label: 'Leva e barriera',  condizione: 'esiste L in LEVE con dS*L <= LMAX e 1/L >= dS+BUF_BAR, e la barriera raccomandata dista >= BUF_BAR*E dallo stop', soglia: 'LEVE [10,15,20,25]; BUF_BAR 0.001 (0.1%)', ref: 'calculator.ts:2245-2268' },
  { sigla: 'G10', label: 'Stop gia toccato', condizione: 'prezzo corrente non oltre lo stop', soglia: 'eps', ref: 'calculator.ts:2270-2278' },
  { sigla: 'G11', label: 'Score',            condizione: 'score senza liquidita >= minScore', soglia: 'MIN_SCORE_EU 48 / MIN_SCORE_US 58', ref: 'calculator.ts:2280-2288' },
  { sigla: 'G12', label: 'T1 vs ADR residuo', condizione: 'distanza T1 <= spazio ADR residuo', soglia: 'ADR_MAX + EPSILON', ref: 'calculator.ts:2290-2299' },
  { sigla: 'G13', label: 'Freshness dati',   condizione: 'quote non stantia', soglia: 'soglia minuti di checkQuoteStaleness; flag STALENESS_USE_MARKET_TS', ref: 'calculator.ts:2301-2307' },
];
const GATE_ORDER = GATES.map(g => g.sigla);

function firstMissingGate(passed: string[]): string | null {
  const set = new Set(passed);
  for (const g of GATE_ORDER) if (!set.has(g)) return g;
  return null;
}

const EMITTED_COUNT: Record<number, number> = {};

function buildSetups(raw: any[], shift: number, includeBlocked = false): Setup[] {
  const out: Setup[] = [];
  let skipped = 0;
  let notEmitted = 0;
  for (const r of raw) {
    const wasEmitted = r?.emitted === true;
    if (!wasEmitted && !includeBlocked) { notEmitted++; continue; }
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
      emitted: wasEmitted,
      gates: Array.isArray(r?.gates) ? (r.gates as string[]) : [],
      blockedGate: wasEmitted ? null : firstMissingGate(Array.isArray(r?.gates) ? r.gates : []),
    });
  }
  if (!includeBlocked) {
    EMITTED_COUNT[shift] = raw.length - notEmitted;
    log(`  (shift ${shift}: ${raw.length} righe, ${notEmitted} non emesse, ` +
        `${skipped} scartate per campi mancanti, ${out.length} valide)`);
  }
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

/**
 * Regola del mark LETTA da scripts/delay_replay.ts:181-204 (non indovinata):
 *   exit = close dell'ultima barra con t <= decisionTs + HORIZON  (priceAt)
 *   R    = dir*(exit - entry)/(entry - stop)                     (rMultiple)
 * Chiamata originale: delay_replay.ts:349-350, priceAt(bars, decisionTs + HORIZON_SEC).
 */
function markRReplay(s: Setup, bars: Bar[]): number | null {
  const risk = Math.abs(s.entry - s.stop);
  if (!(risk > 0)) return null;
  const tgt = s.entryTs + MARK_HORIZON * 1000;
  let exitPrice: number | null = null;
  for (const b of bars) {
    if (b.t <= tgt) exitPrice = b.c;
    else break;
  }
  if (exitPrice === null) return null;
  return s.dir * (exitPrice - s.entry) / risk;
}

function directR(s: Setup): number | null {
  const f = pick(s.raw, ['r', 'rMultiple', 'r_multiple', 'markR', 'R', 'rMark']);
  if (!f) return null;
  const v = Number(f.value);
  return Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------- R a barriera

type BarrierResult = {
  r: number | null; exit: string; nBars: number;
  exitTs: number | null; sameBar: boolean;
};

function barrierR(s: Setup, bars: Bar[], horizonSec: number, beTrigger: number | null): BarrierResult {
  const risk = Math.abs(s.entry - s.stop);
  if (!(risk > 0)) return { r: null, exit: 'unresolved', nBars: 0, exitTs: null, sameBar: false };
  const bounded = Number.isFinite(horizonSec);
  const tEnd = bounded ? s.entryTs + horizonSec * 1000 : Infinity;
  const target = Number.isFinite(s.target) && s.target > 0
    ? s.target
    : s.entry + s.dir * 1.6 * risk;

  let stop = s.stop;
  let beArmed = false;
  let nBars = 0;
  let lastClose: number | null = null;
  let lastTs: number | null = null;

  for (const b of bars) {
    if (b.t <= s.entryTs) continue;
    if (b.t > tEnd) break;
    nBars++;
    lastClose = b.c;
    lastTs = b.t;

    const stopHit = s.dir > 0 ? b.l <= stop : b.h >= stop;
    const t1Hit   = s.dir > 0 ? b.h >= target : b.l <= target;

    // Pessimistico: se stop e target cadono nella stessa barra, vince lo stop.
    if (stopHit || t1Hit) {
      if (stopHit) {
        return {
          r: s.dir * (stop - s.entry) / risk,
          exit: beArmed ? 'be' : 'stop',
          nBars, exitTs: b.t, sameBar: stopHit && t1Hit,
        };
      }
      return { r: s.dir * (target - s.entry) / risk, exit: 't1', nBars, exitTs: b.t, sameBar: false };
    }

    // BE armato a fine barra, valido dalle barre successive (lettura conservativa).
    if (beTrigger !== null && !beArmed) {
      const reached = s.dir > 0
        ? (b.h - s.entry) / risk >= beTrigger
        : (s.entry - b.l) / risk >= beTrigger;
      if (reached) { beArmed = true; stop = s.entry; }
    }
  }

  if (lastClose === null) return { r: null, exit: 'unresolved', nBars, exitTs: null, sameBar: false };
  // Orizzonte finito: 'time' e' un esito censurato dal tempo (contribuisce alla media).
  // Orizzonte 'resolution': le barre finiscono senza stop ne T1 -> 'censored', fuori dalla media.
  return {
    r: s.dir * (lastClose - s.entry) / risk,
    exit: bounded ? 'time' : 'censored',
    nBars, exitTs: lastTs, sameBar: false,
  };
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

// ---------------------------------------------------------------- counterfactual

function cfStats(rows: Array<{ bar: number | null; mark: number | null; censored: boolean }>) {
  const bars = rows.map(r => r.bar).filter((x): x is number => x !== null);
  const marks = rows.map(r => r.mark).filter((x): x is number => x !== null);
  return {
    n: rows.length,
    nBar: bars.length,
    meanRBarrier: mean(bars),
    meanRMark: mean(marks),
    hitBarrier: bars.length ? bars.filter(r => r > 0).length / bars.length : NaN,
    pctCensored: rows.length ? rows.filter(r => r.censored).length / rows.length : NaN,
    sumBarrier: bars.reduce((a, b) => a + b, 0),
  };
}

function runCounterfactual() {
  log(`i3_barrier — counterfactual ${new Date().toISOString()} (Europe/Rome: ${romeNow()})`);
  log('=== COUNTERFACTUAL — R dei setup BLOCCATI ===');
  log('  Popolazione: righe con direction/entry/stop valorizzati, emesse o no.');
  log('  R a barriera fino a RISOLUZIONE, stop per primo, BE off (NON calculateDynamicBreakeven).');
  log('  Le righe senza setup (gates vuoto) non hanno entry/stop: non entrano qui.');
  log('');
  const out: Record<number, any> = {};
  for (const sh of SHIFTS) {
    const raw = loadSetups(sh);
    const cands = buildSetups(raw, sh, true);
    const groups: Record<string, Array<{ bar: number | null; mark: number | null; censored: boolean }>> = {};
    for (const g of GATE_ORDER) groups[g] = [];
    groups['EMESSO'] = [];
    for (const s of cands) {
      const key = s.emitted ? 'EMESSO' : (s.blockedGate ?? 'IGNOTO');
      if (!groups[key]) groups[key] = [];
      const bars = loadBars(s.symbol);
      const mark = bars ? markRReplay(s, bars) : null;
      const b = bars ? barrierR(s, bars, Infinity, null) : { r: null as number | null, exit: 'unresolved' };
      groups[key].push({ bar: b.r, mark, censored: b.exit === 'censored' });
    }
    const emitted = groups['EMESSO'] ?? [];
    const blocked: Array<{ bar: number | null; mark: number | null; censored: boolean }> = [];
    const all: Array<{ bar: number | null; mark: number | null; censored: boolean }> = [];
    for (const [k, v] of Object.entries(groups)) {
      for (const x of v) { all.push(x); if (k !== 'EMESSO') blocked.push(x); }
    }
    log(`  --- shift ${sh}: ${cands.length} setup con campi completi ` +
        `(${emitted.length} emessi, ${blocked.length} bloccati) ---`);
    log('  gate   n     meanR_barrier  meanR_mark  hit     %cens');
    const perGate: Record<string, any> = {};
    for (const g of GATE_ORDER) {
      const rows = groups[g] ?? [];
      if (!rows.length) continue;
      const st = cfStats(rows);
      perGate[g] = st;
      log(`  ${pad(g, 6)} ${pad(st.n, 5)} ${pad(num(st.meanRBarrier), 14)} ${pad(num(st.meanRMark), 11)} ` +
          `${pad(num(st.hitBarrier * 100, 1), 7)} ${num(st.pctCensored * 100, 1)}`);
    }
    const e = cfStats(emitted), bl = cfStats(blocked), al = cfStats(all);
    out[sh] = { emitted: e, blocked: bl, all: al, byGate: perGate };

    if (sh === 0) {
      log('');
      log('  | popolazione | n | meanR_barrier | hit |');
      log(`  | emessi | ${e.n} | ${num(e.meanRBarrier)} | ${num(e.hitBarrier * 100, 1)}% |`);
      log(`  | tutti i candidati | ${al.n} | ${num(al.meanRBarrier)} | ${num(al.hitBarrier * 100, 1)}% |`);
      log(`  | bloccati | ${bl.n} | ${num(bl.meanRBarrier)} | ${num(bl.hitBarrier * 100, 1)}% |`);
      for (const g of ['G8', 'G4', 'G11']) {
        const st = perGate[g];
        if (st) log(`  | bloccati da ${g} | ${st.n} | ${num(st.meanRBarrier)} | ${num(st.hitBarrier * 100, 1)}% |`);
      }
      log('');
      log(`  (a) emessi ${num(e.meanRBarrier)} vs bloccati ${num(bl.meanRBarrier)} -> ` +
          `${e.meanRBarrier > bl.meanRBarrier ? 'EMESSI MIGLIORI' : 'EMESSI PEGGIORI'}`);
      log(`  (b) emessi ${num(e.meanRBarrier)} vs tutti i candidati ${num(al.meanRBarrier)} -> ` +
          `${e.meanRBarrier > al.meanRBarrier ? 'EMESSI MIGLIORI' : 'EMESSI PEGGIORI'}`);
      let bestGate = '', bestDelta = -Infinity;
      for (const g of GATE_ORDER) {
        const st = perGate[g];
        if (!st || !st.nBar) continue;
        const merged = (e.sumBarrier + st.sumBarrier) / (e.nBar + st.nBar);
        const delta = merged - e.meanRBarrier;
        if (delta > bestDelta) { bestDelta = delta; bestGate = g; }
      }
      log(`  (c) gate che, se rimosso, alza di piu' la media del pool: ${bestGate || 'n/a'} -> ` +
          `meanR ${num(e.meanRBarrier + bestDelta)} (delta ${num(bestDelta, 4)})`);
      const pos: string[] = [];
      for (const g of GATE_ORDER) {
        const st = perGate[g];
        if (st && st.nBar && st.meanRBarrier > 0) pos.push(`${g} (n=${st.nBar}, meanR=${num(st.meanRBarrier)})`);
      }
      log(`  (d) gate che bloccano setup con meanR POSITIVO: ${pos.length ? pos.join(', ') : 'nessuno'}`);
    }
    log('');
  }
  if (!existsSync(ART)) mkdirSync(ART, { recursive: true });
  writeFileSync(join(ART, 'i3_barrier_counterfactual.json'), JSON.stringify({ gates: GATES, shifts: out }, null, 2));
  log(`report scritto in ${join(ART, 'i3_barrier_counterfactual.json')}`);
}

// ---------------------------------------------------------------- jackknife

function runJackknife() {
  log(`i3_barrier — jackknife ${new Date().toISOString()} (Europe/Rome: ${romeNow()})`);
  log('=== JACKKNIFE — shift 0, R a barriera, un giorno fuori per volta ===');
  log(`  orizzonte=${HORIZON_MODE === 'resolution' ? 'resolution' : HORIZON + 's'} ` +
      `be-trigger=${BE_TRIGGER ?? 'off'}`);
  log('');
  const setups = buildSetups(loadSetups(0), 0);
  const items: Array<{ date: string; v: number }> = [];
  let censored = 0;
  for (const s of setups) {
    const bars = loadBars(s.symbol);
    if (!bars) continue;
    const b = barrierR(s, bars, HORIZON, BE_TRIGGER);
    if (b.exit === 'censored') { censored++; continue; }
    if (b.r !== null) items.push({ date: s.date, v: b.r });
  }
  const dates = [...new Set(items.map(i => i.date))].sort();
  const perDay: Record<string, number> = {};
  for (const i of items) perDay[i.date] = (perDay[i.date] ?? 0) + 1;
  const counts = dates.map(d => perDay[d]).sort((a, b) => a - b);
  log(`  cluster (giorni): ${dates.length}   setup/giorno min=${counts[0]} ` +
      `med=${quantile(counts, 0.5)} max=${counts[counts.length - 1]}`);
  if (dates.length < 20) {
    log(`  ATTENZIONE: ${dates.length} cluster (<20). CI block-bootstrap con affidabilita' bassa:`);
    log('  il jackknife e\' il controllo primario, non le CI.');
  }
  const full = mean(items.map(i => i.v));
  log(`  meanR completo = ${num(full)}  n=${items.length}  censurati esclusi=${censored}`);
  const means: Array<{ date: string; m: number; n: number }> = [];
  for (const d of dates) {
    const kept = items.filter(i => i.date !== d);
    means.push({ date: d, m: mean(kept.map(i => i.v)), n: kept.length });
  }
  for (const x of means) log(`    senza ${x.date}: meanR=${num(x.m)} (n=${x.n})`);
  const vals = means.map(x => x.m).sort((a, b) => a - b);
  const neg = vals.filter(v => v < 0).length;
  const flips = vals.length - neg;
  log('');
  log(`  jackknife: min=${num(vals[0])} max=${num(vals[vals.length - 1])} ` +
      `mediana=${num(quantile(vals, 0.5))} negativi=${neg}/${vals.length} ribaltano=${flips}`);
  if (flips > 0) log('  ATTENZIONE: almeno un giorno ribalta il segno.');
  if (!existsSync(ART)) mkdirSync(ART, { recursive: true });
  writeFileSync(join(ART, 'i3_barrier_jackknife.json'), JSON.stringify({
    horizon: HORIZON_MODE === 'resolution' ? 'resolution' : HORIZON,
    beTrigger: BE_TRIGGER, nDays: dates.length, meanFull: full, censored,
    min: vals[0], max: vals[vals.length - 1], median: quantile(vals, 0.5),
    signFlips: flips, leaveOneOut: means,
  }, null, 2));
  log(`report scritto in ${join(ART, 'i3_barrier_jackknife.json')}`);
}

// ---------------------------------------------------------------- main

function main() {
  log(`i3_barrier — inizio ${new Date().toISOString()} (Europe/Rome: ${romeNow()})`);
  log(`parametri: horizon=${HORIZON_MODE === 'resolution' ? 'resolution' : HORIZON + 's'} ` +
      `(mark fisso ${MARK_HORIZON}s) be-trigger=${BE_TRIGGER ?? 'off'} boot=${BOOT} pair-key=${PAIR_KEY}`);
  log('');

  if (PROBE) { probe(); return; }
  if (COUNTERFACTUAL) { runCounterfactual(); return; }
  if (JACKKNIFE) { runJackknife(); return; }

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
  let chosen: Variant | null = null;
  let chosenSums: Record<number, number> | null = null;

  const computeSums = (v: Variant) => {
    const sums: Record<number, number> = {};
    const counts: Record<number, number> = {};
    for (const sh of SHIFTS) {
      let sum = 0, n = 0;
      for (const s of data[sh]) {
        let r: number | null = null;
        if (v === 'direct') r = directR(s);
        else if (v === 'markRReplay') {
          const bars = loadBars(s.symbol);
          if (bars) r = markRReplay(s, bars);
        } else {
          const bars = loadBars(s.symbol);
          if (bars) r = markRAt(s, bars, MARK_HORIZON, v);
        }
        if (r !== null && Number.isFinite(r)) { sum += r; n++; }
      }
      sums[sh] = sum; counts[sh] = n;
    }
    return { sums, counts };
  };

  const candidates: Variant[] = direct
    ? ['direct', 'markRReplay', 'lastBefore', 'firstAfter', 'nearest']
    : ['markRReplay', 'lastBefore', 'firstAfter', 'nearest'];

  for (const v of candidates) {
    const { sums, counts } = computeSums(v);
    const ok = SHIFTS.every(sh => Math.abs(sums[sh] - EXPECTED_SUMR[sh]) <= SUMP_TOL);
    log(`  ${pad(v, 12)} sumR: ${SHIFTS.map(sh => `${sh}=${num(sums[sh])} (n=${counts[sh]})`).join('  ')}  ${ok ? '<<< MATCH' : ''}`);
    if (ok && chosen === null) { chosen = v; chosenSums = sums; }
  }

  // COPERTURA: se i setup validi non coincidono con gli emessi, il problema e'
  // barre mancanti, non popolazione. Diagnosi distinta (exit 6).
  const coverageGaps: string[] = [];
  for (const sh of SHIFTS) {
    const nEm = EMITTED_COUNT[sh] ?? NaN;
    const nValid = data[sh].length;
    if (nValid !== nEm) {
      coverageGaps.push(`[COPERTURA] shift ${sh}: n_validi=${nValid} n_emessi=${nEm} ` +
                        `mancanti=${nEm - nValid}`);
    }
  }
  if (coverageGaps.length > 0) {
    for (const g of coverageGaps) log(g);
  } else {
    log(`[COPERTURA] completa: ${SHIFTS.map(sh => `${sh}: ${data[sh].length}/${EMITTED_COUNT[sh] ?? 'n/a'}`).join('  ')}`);
  }

  if (chosen === null) {
    log('');
    if (coverageGaps.length > 0) {
      fail(6, [
        'Copertura barre INCOMPLETA e validazione mark fallita: la diagnosi e\' copertura, non popolazione.',
        coverageGaps.join('\n'),
        'I setup emessi non hanno tutti le barre necessarie: il mark non e\' ricostruibile su tutta la popolazione.',
      ].join('\n'));
    }
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
      else if (chosen === 'markRReplay') {
        const bars = loadBars(s.symbol);
        s.markR = bars ? markRReplay(s, bars) : null;
      } else {
        const bars = loadBars(s.symbol);
        s.markR = bars ? markRAt(s, bars, MARK_HORIZON, chosen) : null;
      }
    }
  }

  // ---- FASE 1: I3-ter, R a barriera
  const horizonLabel = HORIZON_MODE === 'resolution' ? 'FINO A RISOLUZIONE' : `${HORIZON}s`;
  log(`=== FASE 1 (I3-ter) — R a barriera, orizzonte ${horizonLabel} ===`);
  log('  R a barriera, BE fisso, NON calculateDynamicBreakeven. Barre a 5 min: se stop e T1');
  log('  cadono nella stessa barra vince lo stop (limite pessimistico).');
  if (HORIZON_MODE === 'fixed') {
    log(`  ATTENZIONE: a orizzonte fisso ${HORIZON}s le uscite "time" sono CENSURA, non esito.`);
  }

  // Fascia di sensibilita': BE off e BE 0.5 sempre; se ne e' chiesto un altro, si aggiunge.
  const beVariants: Array<{ label: string; be: number | null }> = [
    { label: 'BE off', be: null },
    { label: 'BE 0.5', be: 0.5 },
  ];
  if (BE_TRIGGER !== null && !beVariants.some(v => v.be === BE_TRIGGER)) {
    beVariants.push({ label: `BE ${BE_TRIGGER}`, be: BE_TRIGGER });
  }

  const ter: Record<string, any> = {};
  let unresolved = 0;
  for (const v of beVariants) {
    ter[v.label] = {};
    for (const sh of SHIFTS) {
      const rows: Array<{ s: Setup; r: number | null; exit: string; exitTs: number | null; sameBar: boolean }> = [];
      for (const s of data[sh]) {
        const bars = loadBars(s.symbol);
        if (!bars) { unresolved++; continue; }
        const b = barrierR(s, bars, HORIZON, v.be);
        rows.push({ s, r: b.r, exit: b.exit, exitTs: b.exitTs, sameBar: b.sameBar });
        if (v.be === BE_TRIGGER) {
          s.barrierR = b.r; s.barrierExit = b.exit; s.barrierBars = b.nBars;
          s.barrierTs = b.exitTs; s.barrierSameBar = b.sameBar;
        }
      }
      const resolved = rows.filter(x => x.r !== null && x.exit !== 'censored');
      const rs = resolved.map(x => x.r!);
      const wins = rs.filter(r => r > 0), losses = rs.filter(r => r < 0);
      const exits: Record<string, number> = {};
      for (const x of rows) exits[x.exit] = (exits[x.exit] ?? 0) + 1;
      const boot = blockBootstrap(resolved.map(x => ({ date: x.s.date, v: x.r! })), BOOT);
      const holdMin = resolved
        .map(x => ((x.exitTs ?? x.s.entryTs) - x.s.entryTs) / 60000)
        .sort((a, b) => a - b);
      const markRs = data[sh].map(s => s.markR).filter((r): r is number => r !== null && Number.isFinite(r));
      const t: any = {
        n: rows.length,
        nResolved: resolved.length,
        nCensored: rows.length - resolved.length,
        pctCensored: rows.length ? (rows.length - resolved.length) / rows.length : NaN,
        meanR: mean(rs), sdR: sd(rs),
        hitRate: rs.length ? wins.length / rs.length : NaN,
        meanWin: mean(wins), meanLoss: Math.abs(mean(losses)),
        wlRatio: wins.length && losses.length ? mean(wins) / Math.abs(mean(losses)) : NaN,
        wlRequired: wins.length ? (rs.length - wins.length) / wins.length : NaN,
        ci95: [boot.lo, boot.hi], excludesZero: boot.excludesZero, nBlocks: boot.nBlocks,
        exits,
        holdingMedianMin: quantile(holdMin, 0.5),
        holdingP75Min: quantile(holdMin, 0.75),
        holdingP90Min: quantile(holdMin, 0.90),
        sameBarAmbiguous: rows.filter(x => x.sameBar).length,
        meanMarkR: mean(markRs),
        deltaVsMark: mean(rs) - mean(markRs),
      };
      ter[v.label][sh] = t;
      log(`  ${pad(v.label, 7)} shift ${pad(sh, 3)} n=${pad(t.n, 4)} risolti=${pad(t.nResolved, 4)} ` +
          `censurati=${pad(t.nCensored, 4)} (${num(t.pctCensored * 100, 1)}%) ` +
          `meanR=${pad(num(t.meanR), 8)} sd=${num(t.sdR)} CI95=[${num(boot.lo)}, ${num(boot.hi)}] ` +
          `esclude0=${boot.excludesZero}`);
      log(`           hit=${num(t.hitRate * 100, 1)}% meanWin=${num(t.meanWin)} meanLoss=${num(t.meanLoss)} ` +
          `W/L=${num(t.wlRatio, 2)} richiesto=${num(t.wlRequired, 2)} ` +
          `holding med/p75/p90=${num(t.holdingMedianMin, 0)}/${num(t.holdingP75Min, 0)}/` +
          `${num(t.holdingP90Min, 0)}min sameBar=${t.sameBarAmbiguous}`);
      log(`           uscite: ${Object.entries(exits).map(([k, v2]) => `${k}=${v2}`).join(' ')}  ` +
          `mark=${num(t.meanMarkR)} delta=${num(t.deltaVsMark)}`);
    }
  }
  if (unresolved) log(`  ATTENZIONE: ${unresolved} setup senza R a barriera (barre mancanti o non risolvibili)`);
  log('');

  // ---- FASE 2: I3-quater, confronto appaiato
  log('=== FASE 2 (I3-quater) — confronto appaiato ===');
  // Chiave normalizzata sullo shift: un setup a shift X si riconosce perche'
  // decisionTs - X*60s e' lo stesso istante di mercato. NON si usa
  // symbol|date|direction|ora: collassa setup diversi dello stesso giorno.
  const keyFns: Record<string, (s: Setup, sh: number) => string> = {
    'ts-norm':     (s, sh) => `${s.symbol}|${Math.round((s.entryTs - sh * 60000) / 1000)}`,
    'ts-norm|dir': (s, sh) => `${s.symbol}|${Math.round((s.entryTs - sh * 60000) / 1000)}|${s.dir}`,
  };
  const keyName = PAIR_KEY;
  const keyFn = keyFns[keyName];
  if (!keyFn) fail(4, `--pair-key sconosciuta: ${keyName}. Valori: ${Object.keys(keyFns).join(', ')}`);

  const quater: Record<string, any> = {};
  for (const sh of [15, 20]) {
    const map0 = new Map<string, Setup>();
    for (const s of data[0]) map0.set(keyFn(s, 0), s);
    const mapS = new Map<string, Setup>();
    for (const s of data[sh]) mapS.set(keyFn(s, sh), s);

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
      const r = markRAt(s, bars, MARK_HORIZON, 'lastBefore');
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

  // ---- file barre scelti (deterministico, loggato)
  log('\n  --- file barre scelti per simbolo (BAR_FILE) ---');
  for (const [sym, f] of [...BAR_FILE.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const b = loadBars(sym);
    let info = 'barre non caricate';
    if (b && b.length > 1) {
      const diffs: number[] = [];
      for (let i = 1; i < b.length; i++) diffs.push(b[i].t - b[i - 1].t);
      diffs.sort((x, y) => x - y);
      const med = quantile(diffs, 0.5) / 1000;
      info = `barre=${b.length} intervallo=${med}s (${med / 60} min) ` +
             `${new Date(b[0].t).toISOString()} .. ${new Date(b[b.length - 1].t).toISOString()}`;
    } else if (b) {
      info = `barre=${b.length}`;
    }
    log(`  ${pad(sym, 10)} -> ${pad(f, 18)} ${info}`);
  }

  // ---- output
  const report = {
    generatedAt: new Date().toISOString(),
    params: { horizon: HORIZON_MODE === 'resolution' ? 'resolution' : HORIZON, horizonMode: HORIZON_MODE,
              markHorizon: MARK_HORIZON, beTrigger: BE_TRIGGER, boot: BOOT, pairKey: keyName,
              validatedVariant: chosen },
    gates: GATES,
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
