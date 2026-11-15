#!/usr/bin/env bun
/**
 * scripts/score_deciles.ts — Passo H-septies
 *
 * MISURA DESCRITTIVA, NON UN TEST.
 * Non entra nel denominatore Bonferroni, non consuma holdout, non tocca soglie.
 *
 * Domanda unica: il punteggio che G11 usa come SOGLIA ordina gli esiti?
 * Se il decile alto guadagna e il decile basso perde, il punteggio porta
 * informazione di ordinamento. Se la curva e' piatta, non ne porta.
 *
 * Fasi:
 *   0. VALIDAZIONE  riproduce i sumR pubblicati con il mark a orizzonte fisso.
 *                   Se non li riproduce: exit 2, nessun numero.
 *   1. DECILI       R a barriera per decile di punteggio, shift primario.
 *   2. CURVA TOP-K  expectancy se si prende solo il top 10/20/30/50%.
 *   3. STABILITA'   gli stessi tagli applicati agli shift 15 e 20.
 *   4. ETICHETTA    quanto divergono mark (fisso) e barriera (path-dependent).
 *
 * Uso:
 *   bun scripts/score_deciles.ts --probe
 *   bun scripts/score_deciles.ts
 *   bun scripts/score_deciles.ts --score=scoreSenzaLiquidita --horizon=resolution
 *   bun scripts/score_deciles.ts --deciles=5 --min-n=30 --boot=20000
 *
 * Exit:
 *   0 ok
 *   2 validazione fallita (sumR non riprodotto)
 *   3 artefatti mancanti
 *   4 schema non riconosciuto (campo punteggio assente)
 *   6 copertura barre incompleta
 *   7 argomento non valido
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- argomenti

const ARGS = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) ARGS.set(m[1], m[2] ?? 'true');
}
const PROBE           = ARGS.has('probe');
const INCLUDE_BLOCKED = ARGS.has('include-blocked');
const G4_REALIZABLE   = ARGS.has('g4-realizable');
const CROSS_TAB       = ARGS.has('cross-tab');
const FILL_CONDITIONAL = ARGS.has('fill-conditional');
const TARGET_SWEEP     = ARGS.has('target-sweep');
const EXCLUDE_G4       = ARGS.has('exclude-g4');

const HORIZON_RAW  = ARGS.get('horizon') ?? 'resolution';
const HORIZON_MODE: 'resolution' | 'fixed' = HORIZON_RAW === 'resolution' ? 'resolution' : 'fixed';
const HORIZON = HORIZON_MODE === 'resolution' ? Infinity : Number(HORIZON_RAW);
if (HORIZON_MODE === 'fixed' && !Number.isFinite(HORIZON)) {
  fail(7, `--horizon non valido: '${HORIZON_RAW}'. Usa un numero di secondi oppure 'resolution'.`);
}
const MARK_HORIZON = 3600;

const BE_RAW = ARGS.has('be-trigger') ? (ARGS.get('be-trigger') ?? '') : null;
let BE_TRIGGER: number | null = null;
if (BE_RAW !== null && BE_RAW !== 'off') {
  const v = Number(BE_RAW);
  if (BE_RAW.trim() === '' || !Number.isFinite(v) || v < 0) {
    fail(7, `--be-trigger non valido: '${BE_RAW}'. Usa 'off' oppure un numero >= 0.`);
  }
  BE_TRIGGER = v;
}

const BOOT          = Number(ARGS.get('boot') ?? 10000);
const NDEC          = Math.max(2, Math.min(20, Number(ARGS.get('deciles') ?? 10)));
const MIN_N         = Math.max(1, Number(ARGS.get('min-n') ?? 15));
const PRIMARY_SHIFT = Number(ARGS.get('shift') ?? 0);
const SHIFTS        = [0, 15, 20];
const SCORE_FIELD   = ARGS.get('score') ?? null;
const TOPS = (ARGS.get('tops') ?? '0.1,0.2,0.3,0.5')
  .split(',').map(Number).filter(x => Number.isFinite(x) && x > 0 && x <= 1);

const ART    = 'artifacts';
const REPLAY = ARGS.get('replay-dir') ?? join(ART, 'replay_i3_30d');
const BARSD  = join(ART, 'bars');
const OUT    = ARGS.get('out') ?? join(ART, 'score_deciles.json');

const SUMP_TOL = Number(ARGS.get('sumr-tol') ?? 0.10);

// Nomi candidati del punteggio. Se nessuno esiste, exit 4 con le chiavi reali.
const SCORE_CANDIDATES = [
  'score', 'scoreSenzaLiquidita', 'scoreSenzaLiq', 'scoreNoLiq', 'score_no_liq',
  'totalScore', 'finalScore', 'qualityScore', 'setupScore', 'scoreTotal', 'points',
];

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

function rankAvg(a: number[]): number[] {
  const idx = a.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
  const r = new Array<number>(a.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k].i] = avg;
    i = j + 1;
  }
  return r;
}
function spearman(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 3) return NaN;
  const rx = rankAvg(x), ry = rankAvg(y);
  const mx = mean(rx), my = mean(ry);
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    n += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? n / Math.sqrt(dx * dy) : NaN;
}
function olsSlope(x: number[], y: number[]): number {
  if (x.length < 2) return NaN;
  const mx = mean(x), my = mean(y);
  let n = 0, d = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); d += (x[i] - mx) ** 2; }
  return d > 0 ? n / d : NaN;
}

/**
 * I sumR di riferimento vengono dal summary.json dello STESSO run che ha
 * prodotto gli artefatti. La validazione e' quindi auto-coerente: non dipende
 * da numeri storici non riproducibili. --expected-sumr li forza a mano.
 */
function loadExpectedSumR(): Record<number, number> {
  const override = ARGS.get('expected-sumr');
  if (override) {
    const out: Record<number, number> = {};
    for (const part of override.split(',')) {
      const [k, v] = part.split(':');
      const sh = Number(k), val = Number(v);
      if (!Number.isFinite(sh) || !Number.isFinite(val)) {
        fail(7, `--expected-sumr non valido: '${part}'. Formato: 0:-4.909,15:-8.371,20:-7.955`);
      }
      out[sh] = val;
    }
    return out;
  }
  const p = join(REPLAY, 'summary.json');
  if (!existsSync(p)) {
    fail(3, `mancante: ${p}. Passa --expected-sumr=0:<v>,15:<v>,20:<v>.`);
  }
  const s = JSON.parse(readFileSync(p, 'utf8'));
  const out: Record<number, number> = {};
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) visit(x); return; }
    // delay_replay scrive 'shiftMin'; restano accettati 'shift' e 'shiftSec'.
    const sh = node.shift ?? node.shiftSec ?? node.shiftMin;
    const sum = node.sumR ?? node.sum_r;
    if (sh !== undefined && sum !== undefined) {
      const a = Number(sh), b = Number(sum);
      if (Number.isFinite(a) && Number.isFinite(b)) out[a] = b;
    }
    for (const v of Object.values(node)) visit(v);
  };
  visit(s);
  if (Object.keys(out).length === 0) {
    fail(3, `summary.json non contiene coppie {shift, sumR}. Chiavi di primo livello: ${Object.keys(s).join(', ')}. Passa --expected-sumr.`);
  }
  return out;
}

// ---------------------------------------------------------------- tipi

interface Bar { t: number; o: number; h: number; l: number; c: number }
interface Setup {
  raw: any; symbol: string; dir: 1 | -1;
  entry: number; stop: number; target: number;
  entryTs: number; date: string;
  score: number | null; scoreKey: string;
  markR: number | null;
  barrierR: number | null; barrierExit: string;
  emitted: boolean;
}
interface Item { s: Setup; r: number | null; exit: string }
interface DecileRow {
  decile: number; n: number; nResolved: number; nCensored: number;
  meanR: number; sumR: number; hitRate: number;
  meanWin: number; meanLoss: number; wlRatio: number;
  exits: Record<string, number>;
  ci95: [number, number]; excludesZero: boolean | null; nBlocks: number;
  interpretable: boolean;
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
    const t = b.t ?? b.ts ?? b.timestamp ?? b.time ?? b.date ?? b.datetime ?? b.start;
    const o = b.o ?? b.open;
    const h = b.h ?? b.high;
    const l = b.l ?? b.low;
    const c = b.c ?? b.close;
    if (t === undefined || o === undefined || h === undefined || l === undefined || c === undefined) continue;
    const ms = toMs(t);
    if (!Number.isFinite(ms)) continue;
    out.push({ t: ms, o: +o, h: +h, l: +l, c: +c });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const BAR_CACHE = new Map<string, Bar[] | null>();
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
      try { result = normBars(JSON.parse(readFileSync(join(BARSD, hit), 'utf8'))); }
      catch { result = null; }
      if (result && result.length === 0) result = null;
    }
  }
  BAR_CACHE.set(symbol, result);
  return result;
}

// ---------------------------------------------------------------- punteggio

function scoreOf(raw: any): { key: string; value: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const names = SCORE_FIELD ? [SCORE_FIELD] : SCORE_CANDIDATES;
  for (const n of names) {
    if (!Object.prototype.hasOwnProperty.call(raw, n)) continue;
    const v = raw[n];
    let x: number;
    if (typeof v === 'number') x = v;
    else if (v && typeof v === 'object') x = Number(v.value ?? v.total ?? v.score);
    else x = Number(v);
    if (Number.isFinite(x)) return { key: n, value: x };
  }
  return null;
}

// ---------------------------------------------------------------- R mark

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
  const raw = s.raw ?? {};
  for (const k of ['r', 'rMultiple', 'r_multiple', 'markR', 'R', 'rMark']) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) {
      const v = Number(raw[k]);
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}

// ---------------------------------------------------------------- R a barriera

type BarrierResult = { r: number | null; exit: string; nBars: number };

function barrierR(s: Setup, bars: Bar[], horizonSec: number, beTrigger: number | null): BarrierResult {
  const risk = Math.abs(s.entry - s.stop);
  if (!(risk > 0)) return { r: null, exit: 'unresolved', nBars: 0 };
  const bounded = Number.isFinite(horizonSec);
  const tEnd = bounded ? s.entryTs + horizonSec * 1000 : Infinity;
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
    if (stopHit || t1Hit) {
      if (stopHit) return { r: s.dir * (stop - s.entry) / risk, exit: beArmed ? 'be' : 'stop', nBars };
      return { r: s.dir * (target - s.entry) / risk, exit: 't1', nBars };
    }

    // BE armato a fine barra, valido dalle barre successive.
    if (beTrigger !== null && !beArmed) {
      const reached = s.dir > 0
        ? (b.h - s.entry) / risk >= beTrigger
        : (s.entry - b.l) / risk >= beTrigger;
      if (reached) { beArmed = true; stop = s.entry; }
    }
  }

  if (lastClose === null) return { r: null, exit: 'unresolved', nBars };
  return { r: s.dir * (lastClose - s.entry) / risk, exit: bounded ? 'time' : 'censored', nBars };
}

// ---------------------------------------------------------------- bootstrap

function blockBootstrap(items: Array<{ date: string; v: number }>, iters: number, seed = 42) {
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

// ---------------------------------------------------------------- setup

const EMITTED_COUNT: Record<number, number> = {};

function buildSetups(raw: any[], shift: number, includeBlocked: boolean): Setup[] {
  const out: Setup[] = [];
  let skipped = 0, notEmitted = 0, noScore = 0;
  for (const r of raw) {
    const wasEmitted = r?.emitted === true;
    if (!wasEmitted && !includeBlocked) { notEmitted++; continue; }
    const sym   = r?.symbol ?? r?.ticker ?? r?.sym ?? r?.underlying;
    const dirR  = r?.direction ?? r?.side ?? r?.dir ?? r?.signal;
    const entry = r?.entry ?? r?.entryPrice ?? r?.entry_price ?? r?.entryPx;
    const stop  = r?.stop ?? r?.stopPrice ?? r?.stop_price ?? r?.stopPx ?? r?.stopLoss;
    const tgt   = r?.target ?? r?.t1 ?? r?.targetPrice ?? r?.t1Price ?? r?.takeProfit;
    const ts    = r?.decisionTs ?? r?.entryTs ?? r?.ts ?? r?.timestamp ?? r?.decisionTime ?? r?.time;
    const dir   = dirR !== undefined ? normDir(dirR) : null;
    if (sym === undefined || !dir || entry === undefined || stop === undefined || ts === undefined) {
      skipped++; continue;
    }
    const entryTs = toMs(ts);
    const e = Number(entry), s = Number(stop);
    if (!Number.isFinite(entryTs) || !Number.isFinite(e) || !Number.isFinite(s)) { skipped++; continue; }
    if (Math.abs(e - s) <= 0) { skipped++; continue; }
    const sc = scoreOf(r);
    if (sc === null) noScore++;
    out.push({
      raw: r, symbol: String(sym), dir,
      entry: e, stop: s,
      target: tgt !== undefined ? Number(tgt) : NaN,
      entryTs, date: sessionDate(entryTs),
      score: sc ? sc.value : null,
      scoreKey: sc ? sc.key : '',
      markR: null, barrierR: null, barrierExit: '',
      emitted: wasEmitted,
    });
  }
  if (!includeBlocked) EMITTED_COUNT[shift] = raw.length - notEmitted;
  log(`  (shift ${shift}: ${raw.length} righe, ${notEmitted} non emesse, ${skipped} scartate ` +
      `per campi mancanti, ${noScore} senza punteggio, ${out.length} valide)`);
  return out;
}

// ---------------------------------------------------------------- probe

function probe() {
  log('=== PROBE — schema artefatti e campo punteggio ===\n');
  const p0 = join(REPLAY, 'shift_0', 'setups.json');
  if (!existsSync(p0)) fail(3, `mancante: ${p0}`);
  const raw = JSON.parse(readFileSync(p0, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.setups ?? raw.rows ?? raw.data ?? [];
  log(`setups.json: ${Array.isArray(raw) ? 'array' : 'oggetto, chiavi: ' + Object.keys(raw).join(', ')}`);
  log(`righe: ${arr.length}`);
  const emitted = arr.filter((r: any) => r?.emitted === true);
  log(`emesse: ${emitted.length}`);

  log('\n--- chiavi della prima riga EMESSA (valore di esempio) ---');
  const first = emitted[0] ?? arr[0] ?? {};
  for (const k of Object.keys(first)) log(`  ${pad(k, 30)} = ${JSON.stringify(first[k])}`);

  log('\n--- rilevamento punteggio ---');
  const sc = scoreOf(first);
  if (sc) log(`  TROVATO: '${sc.key}' = ${sc.value}`);
  else {
    log('  NON TROVATO fra i candidati: ' + SCORE_CANDIDATES.join(', '));
    log('  Passa --score=<nome> con una delle chiavi qui sopra.');
  }
  const withScore = emitted.filter((r: any) => scoreOf(r) !== null).length;
  log(`  righe emesse con punteggio: ${withScore}/${emitted.length}`);

  log('\n--- distribuzione del punteggio (emesse) ---');
  const vals = emitted.map((r: any) => scoreOf(r)?.value).filter((x: any) => Number.isFinite(x)) as number[];
  if (vals.length) {
    const srt = [...vals].sort((a, b) => a - b);
    log(`  n=${srt.length} min=${num(srt[0], 1)} p10=${num(quantile(srt, 0.10), 1)} ` +
        `p25=${num(quantile(srt, 0.25), 1)} med=${num(quantile(srt, 0.5), 1)} ` +
        `p75=${num(quantile(srt, 0.75), 1)} p90=${num(quantile(srt, 0.90), 1)} max=${num(srt[srt.length - 1], 1)}`);
    const uniq = new Set(srt).size;
    log(`  valori distinti: ${uniq} su ${srt.length}${uniq < srt.length / 2 ? '  ATTENZIONE: molti pareggi, i decili saranno irregolari' : ''}`);
  }

  log('\n--- file barre ---');
  if (!existsSync(BARSD)) log(`  directory assente: ${BARSD}`);
  else {
    const files = readdirSync(BARSD).filter(f => f.endsWith('.json'));
    log(`  ${files.length} file`);
    if (files.length) {
      const b = normBars(JSON.parse(readFileSync(join(BARSD, files[0]), 'utf8')));
      log(`  ${files[0]}: ${b.length} barre normalizzate`);
    }
  }
  log('\n=== fine probe ===');
}

// ---------------------------------------------------------------- decili

function decileRows(items: Item[], cuts: number[], ndec: number): DecileRow[] {
  // Stesso raggruppamento di FASE 7: una sola implementazione (groupByDecile).
  const buckets = groupByDecile(items, cuts, ndec);
  const rows: DecileRow[] = [];
  for (let i = 0; i < ndec; i++) {
    const b = buckets[i];
    const resolved = b.filter(x => x.r !== null && x.exit !== 'censored');
    const rs = resolved.map(x => x.r!);
    const wins = rs.filter(r => r > 0), losses = rs.filter(r => r < 0);
    const exits: Record<string, number> = {};
    for (const x of b) exits[x.exit] = (exits[x.exit] ?? 0) + 1;
    const boot = blockBootstrap(resolved.map(x => ({ date: x.s.date, v: x.r! })), BOOT);
    rows.push({
      decile: i + 1,
      n: b.length,
      nResolved: resolved.length,
      nCensored: b.length - resolved.length,
      meanR: mean(rs),
      sumR: rs.reduce((a, x) => a + x, 0),
      hitRate: rs.length ? wins.length / rs.length : NaN,
      meanWin: mean(wins),
      meanLoss: Math.abs(mean(losses)),
      wlRatio: wins.length && losses.length ? mean(wins) / Math.abs(mean(losses)) : NaN,
      exits,
      ci95: [boot.lo, boot.hi],
      excludesZero: boot.excludesZero,
      nBlocks: boot.nBlocks,
      interpretable: resolved.length >= MIN_N,
    });
  }
  return rows;
}

function printDeciles(rows: DecileRow[], label: string) {
  log(`  --- ${label} ---`);
  log(`  ${pad('dec', 4)} ${pad('n', 5)} ${pad('ris', 5)} ${pad('meanR', 9)} ${pad('sumR', 9)} ` +
      `${pad('hit%', 7)} ${pad('win', 7)} ${pad('loss', 7)} ${pad('W/L', 6)} ` +
      `${pad('stop', 5)} ${pad('t1', 4)} ${pad('time', 5)} ${pad('cens', 5)} CI95`);
  for (const r of rows) {
    if (!r.n) { log(`  ${pad(r.decile, 4)} 0`); continue; }
    log(`  ${pad(r.decile, 4)} ${pad(r.n, 5)} ${pad(r.nResolved, 5)} ${pad(num(r.meanR), 9)} ` +
        `${pad(num(r.sumR, 2), 9)} ${pad(num(r.hitRate * 100, 1), 7)} ${pad(num(r.meanWin, 2), 7)} ` +
        `${pad(num(r.meanLoss, 2), 7)} ${pad(num(r.wlRatio, 2), 6)} ` +
        `${pad(r.exits['stop'] ?? 0, 5)} ${pad(r.exits['t1'] ?? 0, 4)} ` +
        `${pad(r.exits['time'] ?? 0, 5)} ${pad(r.exits['censored'] ?? 0, 5)} ` +
        `[${num(r.ci95[0])}, ${num(r.ci95[1])}]${r.interpretable ? '' : '  [n<' + MIN_N + ': non interpretabile]'}`);
  }
}

function topK(items: Item[], frac: number) {
  const valid = items.filter(x => x.s.score !== null);
  const sorted = [...valid].sort((a, b) => (b.s.score! - a.s.score!));
  const k = Math.max(1, Math.ceil(sorted.length * frac));
  const sel = sorted.slice(0, k);
  const resolved = sel.filter(x => x.r !== null && x.exit !== 'censored');
  const rs = resolved.map(x => x.r!);
  const boot = blockBootstrap(resolved.map(x => ({ date: x.s.date, v: x.r! })), BOOT);
  return {
    frac, n: sel.length, nResolved: resolved.length,
    meanR: mean(rs), hitRate: rs.length ? rs.filter(r => r > 0).length / rs.length : NaN,
    ci95: [boot.lo, boot.hi] as [number, number],
    excludesZero: boot.excludesZero,
  };
}

function reasonRows(items: Item[]) {
  const groups = new Map<string, Item[]>();
  for (const it of items) {
    const raw = (it.s.raw as any)?.reason;
    const key = raw === null || raw === undefined ? 'EMESSO' : String(raw);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(it);
  }
  const out: Array<{
    reason: string; n: number; nResolved: number;
    meanR: number; hitRate: number; ci95: [number, number];
  }> = [];
  for (const [reason, arr] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const resolved = arr.filter(x => x.r !== null && x.exit !== 'censored');
    const rs = resolved.map(x => x.r!);
    const boot = blockBootstrap(resolved.map(x => ({ date: x.s.date, v: x.r! })), BOOT);
    out.push({
      reason, n: arr.length, nResolved: resolved.length,
      meanR: mean(rs),
      hitRate: rs.length ? rs.filter(r => r > 0).length / rs.length : NaN,
      ci95: [boot.lo, boot.hi] as [number, number],
    });
  }
  return out;
}

// ---------------------------------------------------------------- resolver / G4

/**
 * Convenzione identica a scripts/delay_replay.ts:205-212 (priceAt): ultima barra
 * con t <= istante, si prende la close. `t` qui e' in millisecondi.
 */
function priceAtClose(bars: Bar[], tsMs: number): number | null {
  let best: number | null = null;
  for (const b of bars) {
    if (b.t <= tsMs) best = b.c;
    else break;
  }
  return best;
}

/**
 * Prima barra successiva alla decisione in cui il trigger viene toccato.
 * Fill su high/low (le barre hanno h e l): un trigger toccato solo intra-barra
 * viene visto, ma resta un'approssimazione al minuto del campione (barre a 5m).
 */
function findFillBar(s: Setup, bars: Bar[]): { bar: Bar; idx: number } | null {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.t <= s.entryTs) continue;
    const touched = s.dir > 0 ? b.h >= s.entry : b.l <= s.entry;
    if (touched) return { bar: b, idx: i };
  }
  return null;
}

/**
 * Firma del resolver: un Item e' risolto da barrierR(s, bars, HORIZON, BE_TRIGGER),
 * esattamente come nella FASE 1/5. Estratta perche' la FASE 6 la riusa con
 * l'entry realizzabile, senza duplicare la logica di barriera.
 */
function resolveR(s: Setup, bars: Bar[]): { r: number | null; exit: string } {
  const b = barrierR(s, bars, HORIZON, BE_TRIGGER);
  s.barrierR = b.r;
  s.barrierExit = b.exit;
  return { r: b.r, exit: b.exit };
}

function decileAssign(score: number, cuts: number[], ndec: number): number {
  let d = 1;
  for (const c of cuts) if (score > c) d++;
  return Math.min(d, ndec);
}

function groupByDecile(items: Item[], cuts: number[], ndec: number): Item[][] {
  const buckets: Item[][] = Array.from({ length: ndec }, () => []);
  for (const it of items) {
    if (it.s.score === null) continue;
    buckets[decileAssign(it.s.score, cuts, ndec) - 1].push(it);
  }
  return buckets;
}

/** Sintesi di monotonicita' per un insieme gia' raggruppato (stessi tagli della FASE 1). */
function decileSummary(buckets: Item[][]) {
  const rows = buckets.map((b, i) => {
    const res = b.filter(x => x.r !== null && x.exit !== 'censored');
    return { decile: i + 1, n: b.length, nResolved: res.length, meanR: mean(res.map(x => x.r!)) };
  });
  const interp = rows.filter(r => r.nResolved >= MIN_N);
  const rho = spearman(interp.map(r => r.decile), interp.map(r => r.meanR));
  const slope = olsSlope(interp.map(r => r.decile), interp.map(r => r.meanR));
  const ne = rows.filter(r => r.n > 0);
  const spread = ne.length >= 2 ? ne[ne.length - 1].meanR - ne[0].meanR : NaN;
  const at = (d: number) => rows[d - 1]?.meanR ?? NaN;
  return { rows, rho, slope, spread, decile1: at(1), decileLast: at(rows.length) };
}

// ---------------------------------------------------------------- main

function main() {
  log(`score_deciles — inizio ${new Date().toISOString()} (Europe/Rome: ${romeNow()})`);
  log(`parametri: horizon=${HORIZON_MODE === 'resolution' ? 'resolution' : HORIZON + 's'} ` +
      `be-trigger=${BE_TRIGGER ?? 'off'} decili=${NDEC} min-n=${MIN_N} boot=${BOOT} ` +
      `shift-primario=${PRIMARY_SHIFT}${INCLUDE_BLOCKED ? ' include-blocked' : ''}`);
  log('');

  if (PROBE) { probe(); return; }

  // ---- caricamento
  const data: Record<number, Setup[]> = {};
  for (const sh of SHIFTS) {
    const raw = loadSetups(sh);
    data[sh] = buildSetups(raw, sh, INCLUDE_BLOCKED);
  }
  log('');

  // ---- campo punteggio
  const all = SHIFTS.flatMap(sh => data[sh]);
  const withScore = all.filter(s => s.score !== null);
  if (withScore.length === 0) {
    const first = all[0];
    fail(4, [
      'Nessun setup ha un campo punteggio riconosciuto.',
      `Candidati provati: ${SCORE_CANDIDATES.join(', ')}`,
      first ? `Chiavi disponibili nella prima riga: ${Object.keys(first.raw ?? {}).join(', ')}` : '',
      'Usa --probe per l\'elenco completo, poi --score=<nome>.',
      'NON procedo: senza punteggio non c\'e\' ordinamento da misurare.',
    ].filter(Boolean).join('\n'));
  }
  const scoreKey = withScore[0].scoreKey;
  log(`campo punteggio: '${scoreKey}'  (${withScore.length}/${all.length} setup con punteggio)`);
  if (withScore.length < all.length) {
    log(`  ATTENZIONE: ${all.length - withScore.length} setup senza punteggio, esclusi dai decili.`);
  }
  log('');

  const EXPECTED_SUMR = loadExpectedSumR();
  for (const sh of SHIFTS) {
    if (!Number.isFinite(EXPECTED_SUMR[sh])) {
      fail(3, `manca il sumR atteso per lo shift ${sh}. Trovati: ${Object.keys(EXPECTED_SUMR).join(', ')}. Passa --expected-sumr.`);
    }
  }

  // ---- FASE 0: validazione del mark
  log('=== FASE 0 — validazione (riproduzione dei sumR pubblicati, sempre sui soli emessi) ===');
  const direct = data[PRIMARY_SHIFT][0] ? directR(data[PRIMARY_SHIFT][0]) !== null : false;
  const candidates: Array<'direct' | 'markRReplay' | 'lastBefore' | 'firstAfter' | 'nearest'> = direct
    ? ['direct', 'markRReplay', 'lastBefore', 'firstAfter', 'nearest']
    : ['markRReplay', 'lastBefore', 'firstAfter', 'nearest'];

  let chosen: typeof candidates[number] | null = null;
  let chosenSums: Record<number, number> | null = null;

  for (const v of candidates) {
    const sums: Record<number, number> = {};
    const counts: Record<number, number> = {};
    for (const sh of SHIFTS) {
      let sum = 0, n = 0;
      for (const s of data[sh].filter(x => x.emitted)) {
        let r: number | null = null;
        if (v === 'direct') r = directR(s);
        else {
          const bars = loadBars(s.symbol);
          if (bars) r = v === 'markRReplay' ? markRReplay(s, bars) : markRAt(s, bars, MARK_HORIZON, v);
        }
        if (r !== null && Number.isFinite(r)) { sum += r; n++; }
      }
      sums[sh] = sum; counts[sh] = n;
    }
    const ok = SHIFTS.every(sh => Math.abs(sums[sh] - EXPECTED_SUMR[sh]) <= SUMP_TOL);
    log(`  ${pad(v, 12)} sumR: ${SHIFTS.map(sh => `${sh}=${num(sums[sh])} (n=${counts[sh]})`).join('  ')}  ${ok ? '<<< MATCH' : ''}`);
    if (ok && chosen === null) { chosen = v; chosenSums = sums; }
  }

  const coverageGaps: string[] = [];
  for (const sh of SHIFTS) {
    if (INCLUDE_BLOCKED) break;
    const nEm = EMITTED_COUNT[sh] ?? NaN;
    if (data[sh].length !== nEm) {
      coverageGaps.push(`[COPERTURA] shift ${sh}: n_validi=${data[sh].length} n_emessi=${nEm} mancanti=${nEm - data[sh].length}`);
    }
  }
  if (coverageGaps.length) for (const g of coverageGaps) log(g);
  else log(`[COPERTURA] completa: ${SHIFTS.map(sh => `${sh}: ${data[sh].length}/${EMITTED_COUNT[sh] ?? 'n/a'}`).join('  ')}`);

  if (chosen === null) {
    log('');
    if (coverageGaps.length) {
      fail(6, ['Copertura barre INCOMPLETA e validazione mark fallita.',
               coverageGaps.join('\n'),
               'La diagnosi e\' copertura, non popolazione.'].join('\n'));
    }
    fail(2, [
      `Nessuna variante riproduce i sumR pubblicati entro ${SUMP_TOL}.`,
      `Attesi: ${SHIFTS.map(sh => `${sh}=${EXPECTED_SUMR[sh]}`).join(', ')}`,
      'NON procedo: nessun numero prodotto. Usa --probe e --score per correggere i campi.',
    ].join('\n'));
  }
  log(`\n  variante validata: ${chosen}`);
  log(`  sumR riprodotti: ${SHIFTS.map(sh => `${sh}=${num(chosenSums![sh])}`).join(', ')}\n`);

  // ---- assegnazione markR e barrierR
  const items: Record<number, Item[]> = {};
  let unresolved = 0;
  for (const sh of SHIFTS) {
    items[sh] = [];
    for (const s of data[sh]) {
      if (chosen === 'direct') s.markR = directR(s);
      else {
        const bars = loadBars(s.symbol);
        s.markR = bars ? (chosen === 'markRReplay' ? markRReplay(s, bars) : markRAt(s, bars, MARK_HORIZON, chosen)) : null;
      }
      const bars = loadBars(s.symbol);
      if (!bars) { unresolved++; items[sh].push({ s, r: null, exit: 'unresolved' }); continue; }
      const b = resolveR(s, bars);
      items[sh].push({ s, r: b.r, exit: b.exit });
    }
  }
  if (unresolved) log(`ATTENZIONE: ${unresolved} setup senza barre, esclusi.\n`);

  // ---- FASE 4: divergenza fra le due etichette
  log('=== FASE 4 — divergenza fra mark (fisso) e barriera (path-dependent) ===');
  for (const sh of SHIFTS) {
    const both = items[sh].filter(x => x.s.markR !== null && x.r !== null && x.exit !== 'censored');
    if (!both.length) { log(`  shift ${sh}: nessun setup con entrambe le etichette`); continue; }
    const signDiff = both.filter(x => Math.sign(x.s.markR!) !== Math.sign(x.r!)).length;
    const absDiff = mean(both.map(x => Math.abs(x.s.markR! - x.r!)));
    log(`  shift ${pad(sh, 3)} n=${pad(both.length, 4)} segno diverso=${pad(signDiff, 4)} ` +
        `(${num(signDiff / both.length * 100, 1)}%)  |mark-barriera| medio=${num(absDiff)}  ` +
        `meanMark=${num(mean(both.map(x => x.s.markR!)))}  meanBarriera=${num(mean(both.map(x => x.r!)))}`);
  }
  log('');

  // ---- FASE 5: R per motivo di blocco
  log(`=== FASE 5 — R per motivo (shift ${PRIMARY_SHIFT}) ===`);
  const reasonStats = reasonRows(items[PRIMARY_SHIFT]);
  log(`  ${pad('motivo', 54)} ${pad('n', 5)} ${pad('ris', 5)} ${pad('meanR', 9)} ${pad('hit%', 7)} CI95`);
  for (const r of reasonStats) {
    log(`  ${pad(r.reason.slice(0, 52), 54)} ${pad(r.n, 5)} ${pad(r.nResolved, 5)} ${pad(num(r.meanR), 9)} ` +
        `${pad(num(r.hitRate * 100, 1), 7)} [${num(r.ci95[0])}, ${num(r.ci95[1])}]`);
  }
  log('');

  // Tagli dei decili: stessa definizione della FASE 1, calcolati qui perche'
  // FASE 6/7 li usano prima.
  const primary = items[PRIMARY_SHIFT].filter(x => x.s.score !== null);
  const scores = primary.map(x => x.s.score!).sort((a, b) => a - b);
  const cuts: number[] = [];
  for (let k = 1; k < NDEC; k++) cuts.push(quantile(scores, k / NDEC));

  // ---- FASE 6: G4 con entry realizzabile
  const g4Realizable: Record<string, unknown> = {};
  if (G4_REALIZABLE) {
    log(`=== FASE 6 — G4 con entry realizzabile (shift ${PRIMARY_SHIFT}) ===`);
    const isG4 = (it: Item) => {
      const raw = (it.s.raw as any)?.reason;
      return typeof raw === 'string' && raw.startsWith('leva:G4:');
    };
    const g4 = items[PRIMARY_SHIFT].filter(isG4);
    let skippedNoPrice = 0, skippedZeroRisk = 0, valutati = 0;
    const regR: number[] = [];
    const realR: Array<{ date: string; v: number }> = [];
    const slips: number[] = [];
    const lowSlipR: number[] = [];
    for (const it of g4) {
      if (it.r !== null && it.exit !== 'censored') regR.push(it.r);
      const st = it.s;
      const bars = loadBars(st.symbol);
      const entryReal = bars ? priceAtClose(bars, st.entryTs) : null;
      if (entryReal === null || bars === null ||
          !Number.isFinite(st.stop) || !Number.isFinite(st.target) || !Number.isFinite(st.entry)) {
        skippedNoPrice++;
        continue;
      }
      const riskReg = Math.abs(st.entry - st.stop);
      const riskReal = Math.abs(entryReal - st.stop);
      if (!(riskReal > 0) || !(riskReg > 0)) { skippedZeroRisk++; continue; }
      const slip = st.dir * (entryReal - st.entry) / riskReg;
      slips.push(slip);
      const clone: Setup = { ...st, entry: entryReal };
      const b = resolveR(clone, bars);
      valutati++;
      if (b.r !== null && b.exit !== 'censored') {
        realR.push({ date: st.date, v: b.r });
        if (slip <= 0.25) lowSlipR.push(b.r);
      }
    }
    const control = mean(regR);
    const realVals = realR.map(x => x.v);
    const boot = blockBootstrap(realR, BOOT);
    const srtSlip = [...slips].sort((a, b) => a - b);
    const shareOver05 = slips.length ? slips.filter(x => x > 0.5).length / slips.length * 100 : NaN;
    log(`  setup G4: ${g4.length}   valutati: ${valutati}   skippedNoPrice: ${skippedNoPrice}   skippedZeroRisk: ${skippedZeroRisk}`);
    log(`  controllo entry registrato:  meanR=${control >= 0 ? '+' : ''}${num(control)}  hit%=${num(regR.filter(r => r > 0).length / regR.length * 100, 1)}   (deve coincidere con FASE 5)`);
    log(`  entry realizzabile:          meanR=${num(mean(realVals))}       hit%=${num(realVals.filter(r => r > 0).length / realVals.length * 100, 1)}      CI95=[${num(boot.lo)}, ${num(boot.hi)}]`);
    log(`  slippage (R, positivo=avverso): media=${num(mean(slips))}  mediana=${num(quantile(srtSlip, 0.5))}  p90=${num(quantile(srtSlip, 0.9))}  max=${num(srtSlip[srtSlip.length - 1] ?? NaN)}`);
    log(`  quota di setup con slippage > 0.5R: ${num(shareOver05, 1)}%`);
    log(`  R realizzabile medio con slippage <= 0.25R: ${num(mean(lowSlipR))} (n=${lowSlipR.length}, hit%=${num(lowSlipR.filter(r => r > 0).length / lowSlipR.length * 100, 1)})`);
    log('');
    Object.assign(g4Realizable, {
      nG4: g4.length, valutati, skippedNoPrice, skippedZeroRisk,
      controlMeanR: control, controlHitRate: regR.filter(r => r > 0).length / regR.length,
      realMeanR: mean(realVals), realHitRate: realVals.filter(r => r > 0).length / realVals.length,
      realCi95: [boot.lo, boot.hi],
      slipMean: mean(slips), slipMedian: quantile(srtSlip, 0.5), slipP90: quantile(srtSlip, 0.9),
      slipMax: srtSlip[srtSlip.length - 1] ?? null, shareOver05,
      lowSlipMeanR: mean(lowSlipR), lowSlipN: lowSlipR.length,
    });
  }

  // ---- FASE 7: composizione dei decili e confondimento
  const crossTab: Record<string, unknown> = {};
  if (CROSS_TAB) {
    log(`=== FASE 7 — composizione e confondimento (shift ${PRIMARY_SHIFT}) ===`);
    const primaryAll = items[PRIMARY_SHIFT].filter(x => x.s.score !== null);
    const buckets = groupByDecile(primaryAll, cuts, NDEC);
    const shortReason = (raw: any): string => {
      const v = raw?.reason;
      if (v === null || v === undefined) return 'EMESSO';
      const m = String(v).match(/G(\d+)/);
      return m ? `G${m[1]}` : String(v).slice(0, 12);
    };
    const THRESH: Record<number, number> = { 1: 44.4, 2: 27.5 };
    log('  --- 7a: composizione dei decili ---');
    const comp: Record<string, unknown> = {};
    for (const d of [1, 2, 10]) {
      const b = buckets[d - 1] ?? [];
      const resolved = b.filter(x => x.r !== null && x.exit !== 'censored');
      const counts = new Map<string, number>();
      for (const x of resolved) {
        const k = shortReason(x.s.raw);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const parts = [...counts.entries()].sort((a, b2) => b2[1] - a[1])
        .map(([k, v]) => `${k} ${num(v / resolved.length * 100, 1)}%`);
      const g4share = resolved.length ? (counts.get('G4') ?? 0) / resolved.length * 100 : NaN;
      const thr = THRESH[d];
      log(`  decile ${d} (n=${b.length}, risolte ${resolved.length}): ${parts.join('  ')}` +
          (thr !== undefined ? `   [quota G4 misurata ${num(g4share, 1)}% vs soglia ${thr}%]` : ''));
      comp[`decile${d}`] = { n: b.length, nResolved: resolved.length, shares: Object.fromEntries(counts), g4share };
    }
    log('  --- 7b: decili senza G4 ---');
    const noG4 = primaryAll.filter(x => shortReason(x.s.raw) !== 'G4');
    const sum7b = decileSummary(groupByDecile(noG4, cuts, NDEC));
    log(`  rho=${num(sum7b.rho, 3)}  pendenza=${num(sum7b.slope, 4)}  spread=${num(sum7b.spread)}  decile1 meanR=${num(sum7b.decile1)}  decile10 meanR=${num(sum7b.decileLast)}   (n=${noG4.length})`);
    log('  --- 7c: decili dentro G4 ---');
    const onlyG4 = primaryAll.filter(x => shortReason(x.s.raw) === 'G4');
    const sum7c = decileSummary(groupByDecile(onlyG4, cuts, NDEC));
    log(`  rho=${num(sum7c.rho, 3)}  pendenza=${num(sum7c.slope, 4)}  decile1 meanR=${num(sum7c.decile1)}  decile10 meanR=${num(sum7c.decileLast)}   (n=${onlyG4.length})`);
    log('');
    Object.assign(crossTab, {
      composition: comp,
      noG4: { n: noG4.length, rho: sum7b.rho, slope: sum7b.slope, spread: sum7b.spread, decile1: sum7b.decile1, decileLast: sum7b.decileLast },
      onlyG4: { n: onlyG4.length, rho: sum7c.rho, slope: sum7c.slope, decile1: sum7c.decile1, decileLast: sum7c.decileLast },
    });
  }

  // ---- FASE 8/9/10: fill del trigger, popolazione realizzabile, sweep del target
  const fillStats: Record<string, unknown> = {};
  const targetSweep: Array<Record<string, number>> = [];
  const filledSample: Array<{ s: Setup; bars: Bar[] }> = [];
  if (FILL_CONDITIONAL || TARGET_SWEEP) {
    log(`=== FASE 8 — R condizionato al fill (shift ${PRIMARY_SHIFT}) ===`);
    // --exclude-g4: le tre fasi vetrino gli stessi setup. G4 e' l'unico motivo
    // con distR < 0 (trigger gia' dietro il mercato), quindi l'unico che il
    // fill non puo' correggere: escluderlo mostra il resto della popolazione.
    const all = EXCLUDE_G4
      ? items[PRIMARY_SHIFT].filter(it => !String((it.s.raw as any)?.reason ?? '').startsWith('leva:G4:'))
      : items[PRIMARY_SHIFT];
    if (EXCLUDE_G4) log(`  [--exclude-g4] setup leva:G4 esclusi: ${items[PRIMARY_SHIFT].length - all.length}`);
    const distAll: number[] = [];
    const barsToFillAll: number[] = [];
    const comeSeR: number[] = [];
    const noFillR: number[] = [];
    const filledR: Array<{ date: string; v: number }> = [];
    let noFillCount = 0;
    const byReason = new Map<string, { n: number; filled: number; dist: number[]; r: Array<{ date: string; v: number }> }>();
    for (const it of all) {
      const st = it.s;
      const rawReason = (st.raw as any)?.reason;
      const key = typeof rawReason === 'string' ? rawReason : 'EMESSO';
      if (!byReason.has(key)) byReason.set(key, { n: 0, filled: 0, dist: [], r: [] });
      const g = byReason.get(key)!;
      g.n++;
      if (it.r !== null && it.exit !== 'censored') comeSeR.push(it.r);
      const risk = Math.abs(st.entry - st.stop);
      const bars = loadBars(st.symbol);
      if (!(risk > 0) || bars === null) { noFillCount++; continue; }
      const p0 = priceAtClose(bars, st.entryTs);
      if (p0 === null) { noFillCount++; continue; }
      const distR = st.dir * (st.entry - p0) / risk;
      distAll.push(distR);
      g.dist.push(distR);
      const fill = findFillBar(st, bars);
      if (fill === null) {
        noFillCount++;
        if (it.r !== null && it.exit !== 'censored') noFillR.push(it.r);
        continue;
      }
      let barsFromDecision = 0;
      for (const b of bars) { if (b.t > st.entryTs && b.t <= fill.bar.t) barsFromDecision++; }
      barsToFillAll.push(barsFromDecision);
      // Il resolver riparte dalla barra di fill: stessa barrierR, horizon che
      // decorre dal fill (nessuna riga di barrierR modificata).
      const fromFill: Setup = { ...st, entryTs: fill.bar.t - 1 };
      const res = resolveR(fromFill, bars);
      g.filled++;
      if (res.r !== null && res.exit !== 'censored') {
        filledR.push({ date: st.date, v: res.r });
        g.r.push({ date: st.date, v: res.r });
      }
      filledSample.push({ s: fromFill, bars });
    }
    const filledCount = barsToFillAll.length;
    const srtDist = [...distAll].sort((a, b) => a - b);
    const srtBars = [...barsToFillAll].sort((a, b) => a - b);
    log(`  setup: ${all.length}   con fill: ${filledCount} (${num(filledCount / all.length * 100, 1)}%)   noFill: ${noFillCount} (${num(noFillCount / all.length * 100, 1)}%)`);
    log(`  barre al fill: mediana=${num(quantile(srtBars, 0.5), 1)}  p90=${num(quantile(srtBars, 0.9), 1)}`);
    log(`  distR (trigger davanti al mercato): media=${num(mean(distAll))}  mediana=${num(quantile(srtDist, 0.5))}  p10=${num(quantile(srtDist, 0.1))}  p90=${num(quantile(srtDist, 0.9))}`);
    log('  --- per motivo ---');
    log(`  ${pad('motivo', 46)} ${pad('n', 6)} ${pad('fill%', 7)} ${pad('distR med', 10)} ${pad('meanR fill', 11)} ${pad('hit%', 7)} CI95`);
    const reasonRowsOut: Array<Record<string, unknown>> = [];
    for (const [reason, g] of [...byReason.entries()].sort((a, b) => b[1].n - a[1].n)) {
      const gs = [...g.dist].sort((a, b) => a - b);
      const gm = mean(g.r.map(x => x.v));
      const ghit = g.r.length ? g.r.filter(x => x.v > 0).length / g.r.length : NaN;
      const gboot = blockBootstrap(g.r, BOOT);
      log(`  ${pad(reason.slice(0, 44), 46)} ${pad(g.n, 6)} ${pad(num(g.filled / g.n * 100, 1), 7)} ${pad(num(quantile(gs, 0.5)), 10)} ${pad(num(gm), 11)} ${pad(num(ghit * 100, 1), 7)} [${num(gboot.lo)}, ${num(gboot.hi)}]`);
      reasonRowsOut.push({ reason, n: g.n, filled: g.filled, distMedian: quantile(gs, 0.5), meanR: gm, hitRate: ghit, ci95: [gboot.lo, gboot.hi] });
    }
    const comeSeAll = mean(comeSeR);
    const meanFilled = mean(filledR.map(x => x.v));
    log('  --- confronto ---');
    log(`  meanR "come se" (tutti):        ${num(comeSeAll)}`);
    log(`  meanR con fill (solo fillati):  ${num(meanFilled)}`);
    log(`  meanR dei noFill "come se":     ${num(mean(noFillR))}   (n=${noFillR.length})`);
    log('');
    Object.assign(fillStats, {
      excludeG4: EXCLUDE_G4,
      n: all.length, filled: filledCount, noFill: noFillCount,
      fillPct: filledCount / all.length * 100,
      barsToFillMedian: quantile(srtBars, 0.5), barsToFillP90: quantile(srtBars, 0.9),
      distMean: mean(distAll), distMedian: quantile(srtDist, 0.5),
      distP10: quantile(srtDist, 0.1), distP90: quantile(srtDist, 0.9),
      meanComeSe: comeSeAll, meanFilled, meanNoFill: mean(noFillR), nNoFillResolved: noFillR.length,
      byReason: reasonRowsOut,
    });

    if (FILL_CONDITIONAL) {
      log(`=== FASE 9 — popolazione realizzabile (shift ${PRIMARY_SHIFT}) ===`);
      const popR: Array<{ date: string; v: number }> = [];
      for (const it of all) {
        const st = it.s;
        const isG4 = String((st.raw as any)?.reason ?? '').startsWith('leva:G4:');
        const bars = loadBars(st.symbol);
        if (bars === null) continue;
        let target: Setup = st;
        if (isG4) {
          const e = priceAtClose(bars, st.entryTs);
          if (e === null) continue;
          target = { ...st, entry: e };
        }
        const res = resolveR(target, bars);
        if (res.r !== null && res.exit !== 'censored') popR.push({ date: st.date, v: res.r });
      }
      const popVals = popR.map(x => x.v);
      const popHit = popVals.filter(x => x > 0).length / popVals.length;
      const popBoot = blockBootstrap(popR, BOOT);
      const breakeven = 1 / (1 + 1.6);
      log(`  n=${popVals.length}  meanR=${num(mean(popVals))}  hit%=${num(popHit * 100, 1)}  CI95=[${num(popBoot.lo)}, ${num(popBoot.hi)}]`);
      log(`  breakeven a W/L 1.60: ${num(breakeven * 100, 2)}%`);
      log(`  gap: ${num((popHit - breakeven) * 100, 1)} punti percentuali`);
      log('');
      Object.assign(fillStats, {
        realizable: { n: popVals.length, meanR: mean(popVals), hitRate: popHit, ci95: [popBoot.lo, popBoot.hi], breakeven, gapPoints: (popHit - breakeven) * 100 },
      });
    }

    if (TARGET_SWEEP) {
      log(`=== FASE 10 — sweep del multiplo target (shift ${PRIMARY_SHIFT}, solo fillati) ===`);
      log(`  ${pad('k', 5)} ${pad('n', 6)} ${pad('meanR', 9)} ${pad('hit%', 7)} ${pad('breakeven', 11)} CI95`);
      for (const k of [1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.5, 3.0]) {
        const vals: Array<{ date: string; v: number }> = [];
        for (const f of filledSample) {
          const risk = Math.abs(f.s.entry - f.s.stop);
          if (!(risk > 0)) continue;
          const clone: Setup = { ...f.s, target: f.s.entry + f.s.dir * k * risk };
          const res = resolveR(clone, f.bars);
          if (res.r !== null && res.exit !== 'censored') vals.push({ date: f.s.date, v: res.r });
        }
        const kv = vals.map(x => x.v);
        const kHit = kv.length ? kv.filter(x => x > 0).length / kv.length : NaN;
        const kBoot = blockBootstrap(vals, BOOT);
        const be = 1 / (1 + k);
        log(`  ${pad(k.toFixed(1), 5)} ${pad(kv.length, 6)} ${pad(num(mean(kv)), 9)} ${pad(num(kHit * 100, 1), 7)} ${pad(num(be * 100, 2) + '%', 11)} [${num(kBoot.lo)}, ${num(kBoot.hi)}]`);
        targetSweep.push({ k, n: kv.length, meanR: mean(kv), hitRate: kHit, breakeven: be, ciLo: kBoot.lo, ciHi: kBoot.hi });
      }
      log('');
    }
  }

  // ---- FASE 1: decili
  log(`=== FASE 1 — decili di punteggio, shift ${PRIMARY_SHIFT} (${primary.length} setup) ===`);
  log(`  tagli: ${cuts.map(c => num(c, 1)).join(' | ')}`);
  const rowsPrimary = decileRows(primary, cuts, NDEC);
  printDeciles(rowsPrimary, `shift ${PRIMARY_SHIFT}`);
  log('');

  // ---- monotonicità
  const interp = rowsPrimary.filter(r => r.interpretable);
  const rho = spearman(interp.map(r => r.decile), interp.map(r => r.meanR));
  const slope = olsSlope(interp.map(r => r.decile), interp.map(r => r.meanR));
  const nonEmpty = rowsPrimary.filter(r => r.n > 0);
  const spread = nonEmpty.length >= 2
    ? nonEmpty[nonEmpty.length - 1].meanR - nonEmpty[0].meanR
    : NaN;
  log(`  monotonicita': rho=${num(rho, 3)} su ${interp.length} decili interpretabili  ` +
      `pendenza=${num(slope, 4)} R/decile  spread(top-bottom)=${num(spread)}`);
  log('');

  // ---- FASE 2: curva top-k
  log(`=== FASE 2 — curva di selezione, shift ${PRIMARY_SHIFT} ===`);
  log(`  ${pad('top', 7)} ${pad('n', 5)} ${pad('meanR', 9)} ${pad('hit%', 7)} CI95`);
  const curve = TOPS.map(f => topK(primary, f));
  for (const c of curve) {
    log(`  ${pad((c.frac * 100).toFixed(0) + '%', 7)} ${pad(c.n, 5)} ${pad(num(c.meanR), 9)} ` +
        `${pad(num(c.hitRate * 100, 1), 7)} [${num(c.ci95[0])}, ${num(c.ci95[1])}] esclude0=${c.excludesZero}`);
  }
  const base = topK(primary, 1);
  log(`  ${pad('100%', 7)} ${pad(base.n, 5)} ${pad(num(base.meanR), 9)} ${pad(num(base.hitRate * 100, 1), 7)} ` +
      `[${num(base.ci95[0])}, ${num(base.ci95[1])}]  <- popolazione intera`);
  log('');

  // ---- FASE 3: stabilità dell'ordinamento sotto ritardo
  log('=== FASE 3 — stabilita\' dell\'ordinamento sotto ritardo ===');
  const stability: Record<string, any> = {};
  for (const sh of SHIFTS) {
    if (sh === PRIMARY_SHIFT) continue;
    const rows = decileRows(items[sh].filter(x => x.s.score !== null), cuts, NDEC);
    printDeciles(rows, `shift ${sh} (stessi tagli)`);
    const a = rowsPrimary.filter(r => r.n > 0).map(r => r.meanR);
    const b = rows.filter(r => r.n > 0).map(r => r.meanR);
    const rhoShift = a.length === b.length ? spearman(a, b) : NaN;
    stability[`shift${sh}`] = { rho: rhoShift, rows };
    log(`  rho fra i decili di shift ${PRIMARY_SHIFT} e shift ${sh}: ${num(rhoShift, 3)}`);
    log('');
  }

  // ---- verdetto
  log('=== VERDETTO ===');
  const topDecile = nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : null;
  let verdict: string;
  if (interp.length < 5) {
    verdict = `INDETERMINATO — solo ${interp.length} decili con n>=${MIN_N}. Aumenta la popolazione o riduci --deciles.`;
  } else if (!Number.isFinite(rho)) {
    verdict = 'INDETERMINATO — rho non calcolabile.';
  } else if (rho >= 0.7 && spread > 0) {
    verdict = `ORDINA — rho=${num(rho, 3)}, spread=${num(spread)}. Il punteggio separa gli esiti.`;
  } else if (Math.abs(rho) < 0.3) {
    verdict = `NON ORDINA — rho=${num(rho, 3)}. La curva e' piatta: il punteggio non separa gli esiti.`;
  } else {
    verdict = `DEBOLE — rho=${num(rho, 3)}. Ordinamento parziale, non sfruttabile come selezione.`;
  }
  log(`  ${verdict}`);
  if (topDecile && Number.isFinite(topDecile.meanR) && topDecile.meanR <= 0) {
    log(`  ATTENZIONE: il decile piu' alto ha meanR=${num(topDecile.meanR)} <= 0.`);
    log('  Anche se l\'ordinamento esiste, non c\'e\' un decile positivo da selezionare:');
    log('  il problema e\' la popolazione emessa, non il filtro.');
  }
  log('');

  // ---- output
  const report = {
    generatedAt: new Date().toISOString(),
    params: {
      horizon: HORIZON_MODE === 'resolution' ? 'resolution' : HORIZON,
      markHorizon: MARK_HORIZON, beTrigger: BE_TRIGGER, boot: BOOT,
      deciles: NDEC, minN: MIN_N, primaryShift: PRIMARY_SHIFT,
      includeBlocked: INCLUDE_BLOCKED, scoreField: scoreKey,
      validatedVariant: chosen,
    },
    validation: { expectedSumR: EXPECTED_SUMR, reproducedSumR: chosenSums, tolerance: SUMP_TOL },
    labelDivergence: Object.fromEntries(SHIFTS.map(sh => {
      const both = items[sh].filter(x => x.s.markR !== null && x.r !== null && x.exit !== 'censored');
      return [sh, {
        n: both.length,
        signDiff: both.filter(x => Math.sign(x.s.markR!) !== Math.sign(x.r!)).length,
        meanAbsDiff: mean(both.map(x => Math.abs(x.s.markR! - x.r!))),
        meanMark: mean(both.map(x => x.s.markR!)),
        meanBarrier: mean(both.map(x => x.r!)),
      }];
    })),
    deciles: { cuts, primary: rowsPrimary, ...stability },
    reasonStats,
    // Presenti solo se i rami sono attivi: senza flag il report resta identico.
    ...(Object.keys(g4Realizable).length ? { g4Realizable } : {}),
    ...(Object.keys(crossTab).length ? { crossTab } : {}),
    ...(Object.keys(fillStats).length ? { fillStats } : {}),
    ...(targetSweep.length ? { targetSweep } : {}),
    selectionCurve: { tops: curve, full: base },
    monotonicity: { rho, slope, spread, interpretableDeciles: interp.length },
    verdict,
  };
  if (!existsSync(ART)) mkdirSync(ART, { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  log(`report scritto in ${OUT}`);
  log(`score_deciles — fine ${new Date().toISOString()} (Europe/Rome: ${romeNow()})`);
}

main();
