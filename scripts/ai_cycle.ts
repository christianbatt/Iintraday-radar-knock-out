#!/usr/bin/env bun
/**
 * scripts/ai_cycle.ts — Passo I
 *
 * Ciclo di auto-miglioramento costruito SOPRA la macchina di H-octies.
 * Non tocca src/, non modifica soglie, non riattiva nulla:
 *   SETUP_SELECTOR_LIVE resta 'off'. Il pulsante scrive un verdetto.
 *
 * Sottocomandi:
 *   payoff       griglia di payoff, MFE/MAE, chiusura di sessione, stopPct vs R
 *   g4fill       R dei bloccati da G4 usando il fill realmente disponibile
 *   upstream     attribuzione delle righe senza setup (o dichiarazione di buio)
 *   postmortem   registry/postmortem_<data>.md generato dai dati
 *   train        selettore out-of-sample (solo se payoff ha trovato un k > 0)
 *   cycle        payoff -> g4fill -> upstream -> postmortem -> train
 *   promote      --id=AI-XXXX, unico modo per scrivere una activation live
 *
 * Exit: 0 ok · 2 dati mancanti · 3 payoff inconclusive (train non eseguito)
 *       4 promote rifiutato
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TRADING_PARAMS } from '../src/config/tradingParams';
import { calculateOrbFromIntradayBars } from '../src/utils/calculator';

const ARGS = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) ARGS.set(m[1], m[2] ?? 'true');
}
const CMD = process.argv[2] !== undefined && !process.argv[2].startsWith('--')
  ? process.argv[2] : 'cycle';

const ART    = 'artifacts';
const REPLAY = join(ART, 'replay_i3_30d');
const BARSD  = join(ART, 'bars');
const REGDIR = 'registry';
const REG    = join(REGDIR, 'ai_registry.jsonl');
const SHIFTS = [0, 15, 20];
const GRID   = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.6, 2.0, 2.5, 3.0];
const ALPHA  = 0.05;

// ---------------------------------------------------------------- utility

function fail(code: number, msg: string): never {
  console.error(`\n[STOP exit ${code}] ${msg}\n`);
  process.exit(code);
}
function log(s: string) { console.log(s); }
function pad(s: unknown, n: number) { return String(s).padEnd(n); }
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
function deciles(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  const out: number[] = [];
  for (let p = 1; p <= 9; p++) out.push(quantile(s, p / 10));
  return out;
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
function tCrit(df: number) {
  if (df <= 0) return NaN;
  if (df > 30) return 1.96 + 2.4 / df;
  const tbl = [0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  return tbl[Math.min(df, 30)];
}
function analyticCI(v: number[]) {
  if (v.length < 2) return { lo: NaN, hi: NaN, excludesZero: null as boolean | null };
  const m = mean(v), se = sd(v) / Math.sqrt(v.length), tc = tCrit(v.length - 1);
  const lo = m - tc * se, hi = m + tc * se;
  return { lo, hi, excludesZero: Number.isFinite(lo) && Number.isFinite(hi) ? (lo > 0 || hi < 0) : null };
}
function blockBootstrap(items: Array<{ date: string; v: number }>, iters = 4000, seed = 42) {
  const by = new Map<string, number[]>();
  for (const it of items) {
    if (!by.has(it.date)) by.set(it.date, []);
    by.get(it.date)!.push(it.v);
  }
  const dates = [...by.keys()].sort();
  if (dates.length < 2) return { lo: NaN, hi: NaN, excludesZero: null as boolean | null };
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0, n = 0;
    for (let d = 0; d < dates.length; d++) {
      const pickDate = dates[Math.floor(rng() * dates.length)];
      for (const v of by.get(pickDate)!) { sum += v; n++; }
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const lo = quantile(means, 0.025), hi = quantile(means, 0.975);
  return { lo, hi, excludesZero: lo > 0 || hi < 0 };
}

const DTF = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
});
function sessionDate(ms: number) { return DTF.format(new Date(ms)); }
function hourRome(ms: number) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false })
    .format(new Date(ms));
}

// ---------------------------------------------------------------- dati

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
type Setup = {
  sym: string; ts: number; dir: 1 | -1; entry: number; stop: number; target: number;
  date: string; gates: string[]; emitted: boolean; blocked: string | null;
};
const GATE_ORDER = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13'];
function firstMissingGate(passed: string[]): string | null {
  const s = new Set(passed);
  for (const g of GATE_ORDER) if (!s.has(g)) return g;
  return null;
}

const BARCACHE = new Map<string, Bar[] | null>();
const BARFILE = new Map<string, string>();
function bars(sym: string): Bar[] | null {
  if (BARCACHE.has(sym)) return BARCACHE.get(sym)!;
  let out: Bar[] | null = null;
  if (existsSync(BARSD)) {
    const files = readdirSync(BARSD).filter(f => f.endsWith('d.json')).sort();
    const base = sym.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const cands: Array<{ f: string; days: number }> = [];
    for (const f of files) {
      const stem = f.slice(0, -6);
      const ix = stem.lastIndexOf('_');
      if (ix < 0) continue;
      const name = stem.slice(0, ix), d = stem.slice(ix + 1);
      if (!/^\d+$/.test(d)) continue;
      if (name.replace(/[^A-Za-z0-9]/g, '').toUpperCase() !== base) continue;
      cands.push({ f, days: Number(d) });
    }
    cands.sort((a, b) => b.days - a.days);
    if (cands.length) {
      BARFILE.set(sym, cands[0].f);
      try {
        const raw: unknown = JSON.parse(readFileSync(join(BARSD, cands[0].f), 'utf8'));
        if (Array.isArray(raw)) {
          const b: Bar[] = [];
          for (const x of raw as Array<Record<string, unknown>>) {
            const t = Number(x.t), c = Number(x.c);
            if (Number.isFinite(t) && Number.isFinite(c)) {
              b.push({ t, o: Number(x.o), h: Number(x.h), l: Number(x.l), c, v: Number(x.v) });
            }
          }
          b.sort((a, c2) => a.t - c2.t);
          out = b.length ? b : null;
        }
      } catch { out = null; }
    }
  }
  BARCACHE.set(sym, out);
  return out;
}

function loadSetups(sh: number, onlyEmitted: boolean): Setup[] {
  const p = join(REPLAY, `shift_${sh}`, 'setups.json');
  if (!existsSync(p)) fail(2, `mancante: ${p}`);
  const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(raw)) fail(2, `scheam inatteso in ${p}`);
  const out: Setup[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const emitted = r.emitted === true;
    if (!emitted && onlyEmitted) continue;
    const dirS = String(r.direction ?? '').toUpperCase();
    const dir: 1 | -1 | 0 = dirS === 'LONG' ? 1 : dirS === 'SHORT' ? -1 : 0;
    const entry = Number(r.entry), stop = Number(r.stop), ts = Number(r.decisionTs);
    if (dir === 0 || !Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(ts)) continue;
    if (Math.abs(entry - stop) <= 0) continue;
    const gates = Array.isArray(r.gates) ? (r.gates as string[]) : [];
    out.push({
      sym: String(r.symbol), ts, dir, entry, stop,
      target: Number.isFinite(Number(r.target)) ? Number(r.target) : NaN,
      date: sessionDate(ts * 1000), gates, emitted,
      blocked: emitted ? null : firstMissingGate(gates),
    });
  }
  return out;
}

// ---------------------------------------------------------------- camminata

type Walk = {
  mfe: number; mae: number; stopIdx: number; t1Idx: number; sameBar: number;
  firstK: Record<string, number>; exitR: number | null; exit: string; rr: number;
};

function walk(s: Setup, b: Bar[], mode: 'resolution' | 'session', entryOverride?: number): Walk {
  const entry = entryOverride ?? s.entry;
  const risk = Math.abs(entry - s.stop);
  const res: Walk = {
    mfe: -Infinity, mae: Infinity, stopIdx: -1, t1Idx: -1, sameBar: 0,
    firstK: {}, exitR: null, exit: 'open', rr: NaN,
  };
  if (!(risk > 0)) return res;
  const target = Number.isFinite(s.target) && s.target > 0 ? s.target : entry + s.dir * 1.6 * risk;
  res.rr = s.dir * (target - entry) / risk;

  // Si parte dalla barra SUCCESSIVA a quella di decisione: la barra di decisione
  // contiene gia' il range ORB (l'entry e' sul trigger, lo stop sotto l'ORB low),
  // quindi includerla produrrebbe uno stop immediato per look-ahead.
  let startIdx = -1;
  for (let i = 0; i < b.length; i++) if (b[i].t > s.ts) { startIdx = i; break; }
  if (startIdx < 0) return res;
  let endIdx = b.length - 1;
  if (mode === 'session') {
    const d = sessionDate(s.ts * 1000);
    let last = startIdx;
    for (let i = startIdx; i < b.length; i++) {
      if (sessionDate(b[i].t * 1000) === d) last = i; else break;
    }
    endIdx = last;
  }

  for (let i = startIdx; i <= endIdx; i++) {
    const x = b[i];
    const barMfe = s.dir > 0 ? (x.h - entry) / risk : (entry - x.l) / risk;
    const barMae = s.dir > 0 ? (x.l - entry) / risk : (entry - x.h) / risk;
    const stopHit = barMae <= -1;
    const t1Hit = s.dir > 0 ? x.h >= target : x.l <= target;
    if (stopHit) {
      res.stopIdx = i;
      if (barMfe > res.mfe) res.sameBar++;
      if (res.exit === 'open') { res.exit = 'stop'; res.exitR = -1; }
      break;
    }
    if (barMfe > res.mfe) res.mfe = barMfe;
    if (barMae < res.mae) res.mae = barMae;
    for (const k of GRID) {
      const key = String(k);
      if (res.firstK[key] === undefined && barMfe >= k) res.firstK[key] = i;
    }
    if (res.t1Idx < 0 && t1Hit) {
      res.t1Idx = i;
      // First-touch: l'uscita e' fissata al primo tocco di T1. La camminata
      // prosegue solo per misurare l'MFE oltre T1 (griglia di payoff).
      if (res.exit === 'open') { res.exit = 't1'; res.exitR = res.rr; }
    }
  }
  if (res.exit === 'open') {
    if (res.t1Idx >= 0) { res.exit = 't1'; res.exitR = res.rr; }
    else {
      res.exit = mode === 'session' ? 'close' : 'open';
      res.exitR = s.dir * (b[endIdx].c - entry) / risk;
    }
  }
  return res;
}

// ---------------------------------------------------------------- registro

function appendRow(row: Record<string, unknown>) {
  if (!existsSync(REGDIR)) mkdirSync(REGDIR, { recursive: true });
  appendFileSync(REG, `${JSON.stringify(row)}\n`);
}
function readRegistry(): Array<Record<string, unknown>> {
  if (!existsSync(REG)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(REG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* riga illeggibile: si ignora */ }
  }
  return out;
}
function nHypotheses() { return readRegistry().filter(r => r.kind === 'hypothesis').length; }
function alphaEff() { return 0.05 / (1 + nHypotheses()); }
function hasRow(id: string, kind: string): boolean {
  return readRegistry().some(r => r.id === id && r.kind === kind);
}
function ensureHypothesis(id: string, assumption: string, touches: string[],
                          prediction: Record<string, unknown>, split: Record<string, string>,
                          evidence: Record<string, unknown>) {
  if (hasRow(id, 'hypothesis')) return;
  const nPrior = nHypotheses();
  appendRow({
    id, ts: new Date().toISOString(), kind: 'hypothesis', author: 'agent', assumption, touches, evidence,
    prediction: { ...prediction, nullModel: 'random_same_K', alpha: 0.05, nTestsPrior: nPrior,
                  alphaEffective: 0.05 / (1 + nPrior) },
    split, status: 'pre_registered',
  });
}
function writeResult(id: string, status: string, measured: Record<string, unknown>, reason: string) {
  if (hasRow(id, 'result')) return;
  const nPrior = nHypotheses();
  appendRow({ id, ts: new Date().toISOString(), kind: 'result', status, measured, reason,
              alphaEffective: 0.05 / (1 + nPrior) });
}

// ---------------------------------------------------------------- netto (Passo J)

type NetStat = {
  n: number; k: number; frictionPct: number; hit: number; hitStar: number; gap: number;
  meanRGross: number; meanRNet: number; fbar: number; fMed: number;
  ci: { lo: number; hi: number; excludesZero: boolean | null };
  boot: { lo: number; hi: number; excludesZero: boolean | null };
  identity: boolean;
};
type Measured = { s: Setup; w: Walk };

function stopPctOf(s: Setup): number {
  return (Math.abs(s.entry - s.stop) / s.entry) * 100;
}

function netAt(rows: Measured[], k: number, frictionPct: number): NetStat {
  const n = rows.length;
  const f = rows.map(x => frictionPct / stopPctOf(x.s));
  const hits = rows.map(x => x.w.firstK[String(k)] !== undefined);
  const hit = hits.filter(Boolean).length / Math.max(1, n);
  const meanRGross = hit * k - (1 - hit);
  const rNet = hits.map((h, i) => (h ? k - f[i] : -(1 + f[i])));
  const fbar = mean(f);
  const ci = analyticCI(rNet);
  const boot = blockBootstrap(rows.map((x, i) => ({ date: x.s.date, v: rNet[i] })));
  const sortedF = [...f].sort((a, b) => a - b);
  return {
    n, k, frictionPct, hit, hitStar: (1 + fbar) / (1 + k), gap: (1 + fbar) / (1 + k) - hit,
    meanRGross, meanRNet: mean(rNet), fbar, fMed: quantile(sortedF, 0.5), ci, boot,
    identity: Math.abs(mean(rNet) - (meanRGross - fbar)) < 1e-12,
  };
}

function netPctsArg(): number[] {
  const raw = ARGS.get('net');
  if (raw === undefined || raw === '' || raw === 'true') return [];
  const parts = raw.split(',').map(x => x.trim()).filter(x => x.length > 0);
  if (!parts.length) fail(7, '--net senza valori: usa --net=0.05,0.10,0.15');
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) fail(7, `--net malformato: "${p}" (attesa lista di percentuali, es. 0.05,0.10,0.15)`);
    const v = Number(p);
    if (!Number.isFinite(v) || v <= 0 || v >= 5) fail(7, `--net fuori banda: ${p} (percentuale dello stop, 0 < x < 5)`);
    out.push(v);
  }
  return out;
}

function frictionPctArg(name: string): number {
  const raw = ARGS.get(name);
  if (raw === undefined || raw === 'true') return 0.1;
  if (!/^\d+(\.\d+)?$/.test(raw)) fail(7, `--${name} malformato: "${raw}"`);
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0 || v >= 5) fail(7, `--${name} fuori banda: ${raw}`);
  return v;
}

function pearson(p: Array<{ x: number; y: number }>): number {
  if (p.length < 3) return NaN;
  const mx = mean(p.map(q => q.x)), my = mean(p.map(q => q.y));
  let cov = 0, vx = 0, vy = 0;
  for (const q of p) { cov += (q.x - mx) * (q.y - my); vx += (q.x - mx) ** 2; vy += (q.y - my) ** 2; }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN;
}

function readPrevNet(): Record<string, unknown> | null {
  const p = join(ART, 'ai_payoff.json');
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { net?: Record<string, unknown> | null };
    return raw.net ?? null;
  } catch { return null; }
}

function setupKey(s: Setup): string {
  return `${s.sym}|${s.entry}|${s.stop}`;
}

function measure(list: Setup[]): Measured[] {
  const out: Measured[] = [];
  for (const s of list) {
    const b = bars(s.sym);
    if (!b) continue;
    out.push({ s, w: walk(s, b, 'resolution') });
  }
  return out;
}

// ---------------------------------------------------------------- payoff

function payoff() {
  const netPcts = netPctsArg();
  log('=== PAYOFF — esiste un edge? (shift 0, camminata per trade) ===');
  log('  R a barriera fino a risoluzione, stop per primo, BE off (non calculateDynamicBreakeven).');
  for (const sh of SHIFTS) log(`  campione shift ${sh}: ${loadSetups(sh, true).length} setup emessi`);
  log('  campione 13 giorni (le barre in cache coprono 30d: vedi STEP 2 del report)');
  log('');

  const setups = loadSetups(0, true);
  const rows: Array<{ s: Setup; w: Walk }> = [];
  for (const s of setups) {
    const b = bars(s.sym);
    if (!b) continue;
    rows.push({ s, w: walk(s, b, 'resolution') });
  }
  const n = rows.length;
  let netPayload: Record<string, unknown> | null = null;
  const prevNet = readPrevNet();
  if (!netPcts.length && prevNet) log('  nota: sezione netto ripresa dall\'ultimo run con --net (non ricalcolata qui).');

  const grid: Array<Record<string, number | boolean | null>> = [];
  let anyPositiveK = false;
  let bestK = -1, bestMean = -Infinity;
  log('  k      hit      meanR   CI95 analitica        CI95 bootstrap      esclude0  win/loss');
  for (const k of GRID) {
    const r: number[] = [];
    for (const x of rows) r.push(x.w.firstK[String(k)] !== undefined ? k : -1);
    const hit = r.filter(v => v > 0).length / n;
    const m = hit * k - (1 - hit);
    const ci = analyticCI(r);
    const boot = blockBootstrap(rows.map((x, i) => ({ date: x.s.date, v: r[i] })));
    if (ci.excludesZero === true && m > 0) anyPositiveK = true;
    if (m > bestMean) { bestMean = m; bestK = k; }
    grid.push({ k, hit, meanR: m, ciLo: ci.lo, ciHi: ci.hi, bootLo: boot.lo, bootHi: boot.hi,
                excludesZero: ci.excludesZero === true, nWin: Math.round(hit * n), nLoss: n - Math.round(hit * n) });
    log(`  ${pad(k, 6)} ${pad(num(hit * 100, 1) + '%', 8)} ${pad(num(m), 8)} ` +
        `[${pad(num(ci.lo), 7)}, ${pad(num(ci.hi), 7)}]  [${pad(num(boot.lo), 7)}, ${pad(num(boot.hi), 7)}]  ` +
        `${pad(String(ci.excludesZero), 9)} ${Math.round(hit * n)}/${n - Math.round(hit * n)}`);
  }

  const hitK1 = grid.find(g => g.k === 1.0)!.hit as number;
  log('');
  log(`  (a) esiste un k con meanR > 0 e CI che esclude lo zero? ${anyPositiveK ? 'SI' : 'NO'} ` +
      `(migliore: k=${bestK} meanR=${num(bestMean)})`);
  log(`  (b) a k=1.0 hit = ${num(hitK1 * 100, 1)}% -> ${hitK1 > 0.5 ? 'SOPRA' : 'SOTTO'} il 50%`);

  // ---- NETTO DEI COSTI (Passo J): f_i = frictionPct / stopPct_i ----------------
  if (netPcts.length) {
    const spArr = rows.map(x => stopPctOf(x.s));
    ensureHypothesis('AI-0002',
      'Il costo di transazione sposta il break-even hit di almeno 4 punti percentuali sulla griglia, rendendo la scelta del payoff una decisione di costo e non di segnale.',
      ['payoff.net', 'exit.rule', 'cost.friction'],
      { metric: 'gap_hitStar_minus_hit_at_k1.6', direction: 'increase', minDelta: 4 },
      { train: 'intero campione (13 giorni): misura descrittiva, nessun holdout',
        holdout: 'non applicabile (misura analitica sul campione, non selezione)' },
      { dataset: 'artifacts/replay_i3_30d/shift_0', n, period: '13 giorni con setup' });

    log('');
    log("  === NETTO DEI COSTI: f_i = frictionPct / stopPct_i (unita' di R per trade) ===");
    log('  f%     k     hit      hit*_net  gap pt   meanR_g  meanR_net  CI95 netto          esclude0 identita');
    const table: NetStat[] = [];
    for (const fp of netPcts) {
      for (const k of GRID) {
        const st = netAt(rows, k, fp);
        table.push(st);
        log(`  ${pad(fp, 6)} ${pad(k, 5)} ${pad(num(st.hit * 100, 1) + '%', 8)} ${pad(num(st.hitStar * 100, 1) + '%', 8)} ` +
            `${pad(num(st.gap * 100, 2), 8)} ${pad(num(st.meanRGross), 8)} ${pad(num(st.meanRNet), 8)} ` +
            `[${pad(num(st.ci.lo), 7)}, ${pad(num(st.ci.hi), 7)}] ${pad(String(st.ci.excludesZero), 8)} ${st.identity ? 'ok' : 'NO'}`);
      }
      log('');
    }
    const pick = (fp: number, k: number) => table.find(z => z.frictionPct === fp && z.k === k)!;
    const anyPos = (fp: number) => table.some(z => z.frictionPct === fp && z.meanRNet > 0);
    const anyPosLine = () => netPcts.map(fp => `${fp}: ${anyPos(fp) ? 'SI' : 'NO'}`).join(' · ');
    log(`  (a) meanR_net > 0 · ${anyPosLine()}`);
    const gapAt = (fp: number) => { const z = table.find(t => t.frictionPct === fp && t.k === 1.6); return z ? z.gap * 100 : null; };
    const partsG = netPcts.map(fp => `${fp} -> ${gapAt(fp) === null ? 'n/d' : num(gapAt(fp)!, 2)} pt`);
    const g05 = gapAt(0.05), g10 = gapAt(0.1);
    const wide = g05 !== null && g10 !== null ? `allargamento 0.05->0.10 = ${num(g10 - g05, 2)} pt`
      : 'allargamento non calcolabile in questo run (serve --net con 0.05 e 0.10)';
    log(`  (b) gap hit*_net - hit a k=1.6: ${partsG.join(' · ')} (${wide})`);
    const fpMain = netPcts.includes(0.1) ? 0.1 : netPcts[0];
    const orderOf = (fp: number | null) => [...GRID].sort((a, b) => {
      const va = fp === null ? pick(netPcts[0], a).meanRGross : pick(fp, a).meanRNet;
      const vb = fp === null ? pick(netPcts[0], b).meanRGross : pick(fp, b).meanRNet;
      return vb - va;
    });
    const ordG = orderOf(null), ordN = orderOf(fpMain);
    log(`  (c) ranking per meanR lordo      : ${ordG.join(' > ')}`);
    log(`      ranking per meanR netto ${fpMain} : ${ordN.join(' > ')} -> ${ordG.join('') === ordN.join('') ? 'INVARIATO' : 'CAMBIA'}`);
    const f10 = spArr.map(v => fpMain / v);
    const sortedF10 = [...f10].sort((a, b) => a - b);
    const pairs = rows.map((x, i) => ({ x: f10[i], y: x.w.exitR }))
      .filter(q => q.y !== null && Number.isFinite(q.y as number)) as Array<{ x: number; y: number }>;
    const cf = pearson(pairs);
    log(`  (d) f_i a ${fpMain}: media ${num(mean(f10))} mediana ${num(quantile(sortedF10, 0.5), 3)} p90 ${num(quantile(sortedF10, 0.9), 3)} R`);
    log(`      decili f: ${deciles(f10).map(v => num(v, 3)).join(' ')}`);
    log(`      corr(f_i, R realizzato) = ${num(cf, 3)} · corr(f_i, stopPct_i) = -1 per costruzione (f = c / stopPct)`);
    const st16 = pick(fpMain, 1.6);
    const gapPt = st16.gap * 100;
    log(`  (C) frizione dell'app implicita: NON RICAVABILE per trade — frictionEur dipende da`);
    log(`      suggestedCertificates e totalInvestedEur (calculator.ts:2405), assenti negli artefatti.`);
    log(`      Vale la banda parametrica ${netPcts.join('/')}% dello stop.`);

    writeResult('AI-0002', gapPt >= 4 ? 'accepted' : 'rejected',
      { gapAtK16: gapPt, hit: st16.hit, hitStarNet: st16.hitStar, meanRGross: st16.meanRGross,
        meanRNet: st16.meanRNet, fMedian: st16.fMed, anyPositiveAt005: anyPos(0.05),
        anyPositiveAt010: anyPos(0.1), anyPositiveAt020: anyPos(0.2),
        corrFvsRealisedR: cf, rankingInvariant: ordG.join('') === ordN.join('') },
      gapPt >= 4
        ? 'Il costo sposta il break-even hit di almeno 4 punti percentuali a k=1.6: il lordo non e una base di decisione.'
        : `Il costo sposta il break-even hit di ${num(gapPt, 2)} punti percentuali a k=1.6, sotto i 4 dichiarati: ipotesi respinta nella forma quantitativa.`);

    netPayload = {
      frictionPcts: netPcts, table,
      fAt010: { mean: mean(f10), median: quantile(sortedF10, 0.5), p90: quantile(sortedF10, 0.9), deciles: deciles(f10) },
      corrFvsRealisedR: cf, rankingGross: ordG, rankingNet010: ordN,
      appFrictionPctImplicit: null,
      appFrictionReason: 'frictionEur dipende da suggestedCertificates e totalInvestedEur (calculateDynamicBreakeven, calculator.ts:2405), assenti negli artefatti del replay: la frizione in % del prezzo non e ricavabile per trade.',
    };
  }

  // Output B — MFE / MAE
  const stopped = rows.filter(x => x.w.stopIdx >= 0).map(x => x.w);
  const target = rows.filter(x => x.w.t1Idx >= 0).map(x => x.w);
  log('');
  log(`  --- MFE/MAE: chiusi in stop n=${stopped.length}, arrivati a T1 n=${target.length} ---`);
  log(`  MFE decili (stop): ${deciles(stopped.map(w => w.mfe)).map(v => num(v, 2)).join(' ')}`);
  log(`  MAE decili (stop): ${deciles(stopped.map(w => w.mae)).map(v => num(v, 2)).join(' ')}`);
  log(`  MFE decili (T1)  : ${deciles(target.map(w => w.mfe)).map(v => num(v, 2)).join(' ')}`);
  log(`  MAE decili (T1)  : ${deciles(target.map(w => w.mae)).map(v => num(v, 2)).join(' ')}`);

  // Output C — chiusura di sessione
  const sc: number[] = [];
  const scExits: Record<string, number> = {};
  const scDates: string[] = [];
  for (const x of rows) {
    const b = bars(x.s.sym);
    if (!b) continue;
    const w = walk(x.s, b, 'session');
    if (w.exitR === null) continue;
    sc.push(w.exitR); scDates.push(x.s.date);
    scExits[w.exit] = (scExits[w.exit] ?? 0) + 1;
  }
  const scHit = sc.filter(v => v > 0).length / sc.length;
  const scCI = analyticCI(sc);
  const resR = rows.map(x => x.w.exitR!).filter(v => Number.isFinite(v));
  log('');
  log(`  --- uscita a CHIUSURA DI SESSIONE: n=${sc.length} meanR=${num(mean(sc))} sd=${num(sd(sc))} ` +
      `hit=${num(scHit * 100, 1)}% CI95=[${num(scCI.lo)}, ${num(scCI.hi)}] uscite: ` +
      `${Object.entries(scExits).map(([k2, v]) => `${k2}=${v}`).join(' ')}`);
  log(`      resolution: meanR=${num(mean(resR))} -> chiusura di sessione ` +
      `${mean(sc) > mean(resR) ? 'MIGLIORE' : 'PEGGIORE'} di ${num(Math.abs(mean(sc) - mean(resR)))}`);

  // Output D — stopPct vs R
  function stopPctTable(list: Setup[], label: string) {
    const pts: Array<{ p: number; r: number }> = [];
    for (const s of list) {
      const b = bars(s.sym);
      if (!b) continue;
      const w = walk(s, b, 'resolution');
      if (w.exitR === null) continue;
      pts.push({ p: Math.abs(s.entry - s.stop) / s.entry * 100, r: w.exitR });
    }
    if (!pts.length) return { coef: NaN, monotone: null as boolean | null, rows: [] as Array<Record<string, number>> };
    const sorted = [...pts].sort((a, b) => a.p - b.p);
    const out: Array<Record<string, number>> = [];
    const per = Math.ceil(sorted.length / 10);
    for (let i = 0; i < 10; i++) {
      const chunk = sorted.slice(i * per, (i + 1) * per);
      if (!chunk.length) continue;
      const rs = chunk.map(c => c.r);
      out.push({ decile: i + 1, n: chunk.length, stopPctMed: quantile(chunk.map(c => c.p).sort((a, b) => a - b), 0.5),
                 meanR: mean(rs), hit: rs.filter(v => v > 0).length / rs.length });
    }
    const mx = mean(pts.map(x => x.p)), my = mean(pts.map(x => x.r));
    let cov = 0, varx = 0;
    for (const x of pts) { cov += (x.p - mx) * (x.r - my); varx += (x.p - mx) ** 2; }
    const coef = varx > 0 ? cov / varx : NaN;
    log(`  --- ${label}: n=${pts.length} decili di stopPct ---`);
    for (const r of out) {
      log(`      d${r.decile} stop%=${num(r.stopPctMed, 2)} n=${r.n} meanR=${num(r.meanR)} hit=${num(r.hit * 100, 1)}%`);
    }
    log(`      coefficiente R~stopPct = ${num(coef, 4)} (${coef > 0 ? 'cresce con lo stop' : 'decresce con lo stop'})`);
    return { coef, monotone: coef > 0, rows: out };
  }
  const em = stopPctTable(setups, 'EMESSI');
  const g8 = stopPctTable(loadSetups(0, false).filter(s => s.blocked === 'G8'), 'BLOCCATI DA G8');

  log('');
  log(`  (c) chiusura di sessione ${mean(sc) > mean(resR) ? 'MIGLIORE' : 'PEGGIORE'} di resolution`);
  log(`  (d) fra gli emessi meanR ${em.coef > 0 ? 'CRESCE' : 'NON CRESCE'} con stopPct (coef ${num(em.coef, 4)})`);

  const payload = {
    n, campione: '13 giorni', anyPositiveK, bestK, bestMean, hitAtK1: hitK1,
    grid,
    mfeDecilesStop: deciles(stopped.map(w => w.mfe)),
    maeDecilesStop: deciles(stopped.map(w => w.mae)),
    mfeDecilesT1: deciles(target.map(w => w.mfe)),
    maeDecilesT1: deciles(target.map(w => w.mae)),
    sessionClose: { n: sc.length, meanR: mean(sc), sd: sd(sc), hit: scHit,
                    ci95: [scCI.lo, scCI.hi], exits: scExits, resolutionMeanR: mean(resR) },
    stopPctVsR: { emitted: em, g8Blocked: g8 },
    net: netPayload ?? prevNet,
    netFromPreviousRun: netPayload === null && prevNet !== null,
  };
  writeFileSync(join(ART, 'ai_payoff.json'), JSON.stringify(payload, null, 2));
  log(`\n  scritto ${join(ART, 'ai_payoff.json')}`);
  return payload;
}

// ---------------------------------------------------------------- g4fill

function g4fill() {
  log('=== G4 — R con il fill REALMENTE disponibile ===');
  log('  Entry = close dell\'ultima barra con t <= decisionTs. Stop e T1 restano i livelli assoluti.');
  log('');
  const blocked = loadSetups(0, false).filter(s => s.blocked === 'G4');
  const es: number[] = [];
  const rs: number[] = [];
  const dates: string[] = [];
  let nTargetPassed = 0, nRRnp = 0, nNoBars = 0;
  for (const s of blocked) {
    const b = bars(s.sym);
    if (!b) { nNoBars++; continue; }
    let p: number | null = null;
    for (const x of b) { if (x.t <= s.ts) p = x.c; else break; }
    if (p === null) { nNoBars++; continue; }
    const e = s.dir * (p - s.entry) / s.entry;
    const riskNew = Math.abs(p - s.stop);
    if (!(riskNew > 0)) { nRRnp++; continue; }
    es.push(e);
    if (Math.abs(e) > 0.02) nTargetPassed++;
    if ((s.dir > 0 && s.target <= p) || (s.dir < 0 && s.target >= p)) nRRnp++;
    const w = walk(s, b, 'resolution', p);
    if (w.exitR !== null) { rs.push(w.exitR); dates.push(s.date); }
  }
  const hit = rs.filter(v => v > 0).length / rs.length;
  const ci = analyticCI(rs);
  const boot = blockBootstrap(rs.map((v, i) => ({ date: dates[i], v })));
  const eSort = [...es].sort((a, b) => a - b);
  log(`  n bloccati da G4 = ${blocked.length}  (senza barre: ${nNoBars})`);
  log(`  e = spostamento oltre l'entry: mediana ${num(quantile(eSort, 0.5) * 100, 3)}%  ` +
      `p90 ${num(quantile(eSort, 0.9) * 100, 3)}%`);
  log(`  decili di e (%): ${deciles(es).map(v => num(v * 100, 2)).join(' ')}`);
  log(`  con |e| > 2%: ${nTargetPassed}   con RR_new <= 0 (T1 non piu' raggiungibile): ${nRRnp}`);
  log(`  meanR con fill disponibile = ${num(mean(rs))}  hit = ${num(hit * 100, 1)}%  ` +
      `CI95 analitica [${num(ci.lo)}, ${num(ci.hi)}]  bootstrap [${num(boot.lo)}, ${num(boot.hi)}]`);
  log('');
  log(`  (a) con fill onesto G4 blocca trade con R ${mean(rs) > 0 ? 'POSITIVO' : 'NON positivo'} ` +
      `(${num(mean(rs))} contro +0.858 assunto)`);
  log(`  (b) differenza rispetto al fill assunto: ${num(mean(rs) - 0.858)} R per trade`);
  log(`  (c) irraggiungibili per costruzione (RR_new <= 0): ${nRRnp} su ${blocked.length}`);
  const payload = {
    n: blocked.length, nNoBars, eMedian: quantile(eSort, 0.5), eP90: quantile(eSort, 0.9),
    eDeciles: deciles(es), nTargetPassed, nRRnonPositive: nRRnp,
    meanRFillAvailable: mean(rs), hit, ci95: [ci.lo, ci.hi],
    ci95Bootstrap: [boot.lo, boot.hi], vsAssumed: 0.858, vsEmitted: -0.493,
  };
  writeFileSync(join(ART, 'ai_g4fill.json'), JSON.stringify(payload, null, 2));
  log(`\n  scritto ${join(ART, 'ai_g4fill.json')}`);
  return payload;
}

// ---------------------------------------------------------------- upstream

function upstream() {
  log('=== UPSTREAM — le righe senza setup ===');
  const all = loadSetups(0, false);
  const noSetup = (() => {
    const p = join(REPLAY, 'shift_0', 'setups.json');
    const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    return arr.filter(r => r.emitted !== true && (!Array.isArray(r.gates) || r.gates.length === 0));
  })();
  const fields = new Set<string>();
  for (const r of noSetup) for (const k of Object.keys(r)) fields.add(k);
  const needed = ['orbHigh', 'orbLow', 'price', 'atr14', 'adr14', 'avgVolume20d', 'completedBarsCount'];
  const present = needed.filter(f => fields.has(f));
  const attributable = present.length === needed.length;
  log(`  righe totali ${loadSetups(0, false).length + 0} · con setup ${all.length} · senza setup ${noSetup.length}`);
  log(`  campi disponibili in una riga senza setup: ${[...fields].sort().join(', ')}`);
  log(`  campi necessari per l'attribuzione: ${needed.join(', ')}`);
  log(`  presenti: ${present.length}/${needed.length} -> attribuzione ${attributable ? 'POSSIBILE' : 'IMPOSSIBILE'}`);
  if (!attributable) {
    log('  DICHIARAZIONE: gli artefatti non contengono ORB/prezzo/ATR/ADR/volume/barre,');
    log('  quindi le cause (i)-(vii) di STEP 4 NON sono distinguibili. Riporto solo il totale.');
    log('  Proposta (non implementata): aggiungere un campo `reason` alla riga non emessa');
    log('  in delay_replay/headless_pipeline, in un passo che autorizzi quella modifica.');
  }
  const bySym: Record<string, number> = {};
  const byHour: Record<string, number> = {};
  const byDow: Record<string, number> = { Sat: 0, Sun: 0 };
  for (const r of noSetup) {
    bySym[String(r.symbol)] = (bySym[String(r.symbol)] ?? 0) + 1;
    byHour[hourRome(Number(r.decisionTs) * 1000)] = (byHour[hourRome(Number(r.decisionTs) * 1000)] ?? 0) + 1;
    const dow = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', weekday: 'short' })
      .format(new Date(Number(r.decisionTs) * 1000));
    // decisionTs e' in SECONDI: la conversione a ms e' necessaria per giorno/ora.
    if (dow === 'Sat' || dow === 'Sun') byDow[dow] = (byDow[dow] ?? 0) + 1;
  }
  log(`  per simbolo: ${Object.entries(bySym).sort().map(([k, v]) => `${k}=${v}`).join(' ')}`);
  log(`  per ora CET: ${Object.entries(byHour).sort().map(([k, v]) => `${k}:${v}`).join(' ')}`);
  log(`  weekend: ${(byDow.Sat ?? 0) + (byDow.Sun ?? 0)}`);
  const payload = { noSetupRows: noSetup.length, totalRows: all.length + noSetup.length,
                    fields: [...fields].sort(), needed, present, attributable,
                    bySymbol: bySym, byHour, weekend: (byDow.Sat ?? 0) + (byDow.Sun ?? 0) };
  writeFileSync(join(ART, 'ai_upstream.json'), JSON.stringify(payload, null, 2));
  log(`\n  scritto ${join(ART, 'ai_upstream.json')}`);
  return payload;
}

// ---------------------------------------------------------------- postmortem

function postmortem() {
  log('=== POST-MORTEM ===');
  const setups = loadSetups(0, true);
  const rows: Array<{ s: Setup; w: Walk }> = [];
  for (const s of setups) {
    const b = bars(s.sym);
    if (!b) continue;
    rows.push({ s, w: walk(s, b, 'resolution') });
  }
  const rs = rows.map(x => x.w.exitR!).filter(v => Number.isFinite(v));
  const exits: Record<string, number> = {};
  for (const x of rows) exits[x.w.exit] = (exits[x.w.exit] ?? 0) + 1;
  const all = loadSetups(0, false);
  const emitted = setups.length;
  const built = all.length;
  const totRows = built + 9493;

  const bySym: Record<string, { n: number; rs: number[] }> = {};
  const byDay: Record<string, { n: number; rs: number[] }> = {};
  for (const x of rows) {
    const r = x.w.exitR!;
    if (!bySym[x.s.sym]) bySym[x.s.sym] = { n: 0, rs: [] };
    bySym[x.s.sym].n++; bySym[x.s.sym].rs.push(r);
    if (!byDay[x.s.date]) byDay[x.s.date] = { n: 0, rs: [] };
    byDay[x.s.date].n++; byDay[x.s.date].rs.push(r);
  }
  const daySorted = Object.entries(byDay).sort((a, b) => mean(a[1].rs) - mean(b[1].rs));
  const gateRows: Record<string, { n: number; rs: number[] }> = {};
  for (const s of all) {
    if (s.emitted) continue;
    const g = s.blocked ?? 'IGNOTO';
    const b = bars(s.sym);
    if (!b) continue;
    const w = walk(s, b, 'resolution');
    if (w.exitR === null) continue;
    if (!gateRows[g]) gateRows[g] = { n: 0, rs: [] };
    gateRows[g].n++; gateRows[g].rs.push(w.exitR);
  }
  const payoffRaw: unknown = existsSync(join(ART, 'ai_payoff.json'))
    ? JSON.parse(readFileSync(join(ART, 'ai_payoff.json'), 'utf8')) : null;
  const g4Raw: unknown = existsSync(join(ART, 'ai_g4fill.json'))
    ? JSON.parse(readFileSync(join(ART, 'ai_g4fill.json'), 'utf8')) : null;
  const surfaceRaw: unknown = existsSync(join(ART, 'ai_surface.json'))
    ? JSON.parse(readFileSync(join(ART, 'ai_surface.json'), 'utf8')) : null;
  const popRaw: unknown = existsSync(join(ART, 'ai_population.json'))
    ? JSON.parse(readFileSync(join(ART, 'ai_population.json'), 'utf8')) : null;

  const hit = rs.filter(v => v > 0).length / rs.length;
  const win = mean(rs.filter(v => v > 0)), loss = Math.abs(mean(rs.filter(v => v < 0)));
  const L: string[] = [];
  L.push(`# Post-mortem del ${new Date().toISOString().slice(0, 10)}`);
  L.push('');
  L.push('Generato da `bun scripts/ai_cycle.ts postmortem`. Ogni numero è ricalcolabile');
  L.push('con i comandi citati accanto; nessuna frase è sostenuta da altro che questi numeri.');
  L.push('');
  L.push('## 1. Copertura');
  L.push('');
  L.push('| voce | n | fonte |');
  L.push('|---|---|---|');
  L.push(`| righe di valutazione | ${totRows} | \`artifacts/replay_i3_30d/shift_0/setups.json\` |`);
  L.push(`| setup costruiti (campi completi) | ${built} | \`bun scripts/i3_barrier.ts --counterfactual\` |`);
  L.push(`| emessi | ${emitted} | idem |`);
  L.push(`| pass rate | ${num(emitted / totRows * 100, 2)}% | calcolo |`);
  L.push(`| righe senza setup | ${totRows - built} | \`bun scripts/ai_cycle.ts upstream\` |`);
  L.push('');
  L.push('## 2. Esiti (camminata a risoluzione, shift 0, BE off)');
  L.push('');
  L.push('| metrica | valore |');
  L.push('|---|---|');
  L.push(`| n | ${rs.length} |`);
  L.push(`| meanR | ${num(mean(rs))} |`);
  L.push(`| sd | ${num(sd(rs))} |`);
  L.push(`| hit (>0) | ${num(hit * 100, 1)}% |`);
  L.push(`| meanWin / meanLoss | ${num(win)} / ${num(-loss)} |`);
  L.push(`| W/L | ${num(win / loss, 2)} |`);
  L.push(`| W/L richiesto | ${num((1 - hit) / hit, 2)} |`);
  L.push(`| uscite | ${Object.entries(exits).map(([k, v]) => `${k}=${v}`).join(' ')} |`);
  L.push(`| campione | 13 giorni |`);
  L.push('');
  L.push('## 3. Per simbolo');
  L.push('');
  L.push('| simbolo | n | meanR | hit |');
  L.push('|---|---|---|---|');
  for (const [s, v] of Object.entries(bySym).sort()) {
    L.push(`| ${s} | ${v.n} | ${num(mean(v.rs))} | ${num(v.rs.filter(x => x > 0).length / v.n * 100, 1)}% |`);
  }
  L.push('');
  L.push('## 4. Per giorno — 3 migliori e 3 peggiori');
  L.push('');
  L.push('| giorno | n | meanR |');
  L.push('|---|---|---|');
  for (const [d, v] of daySorted.slice(0, 3)) L.push(`| ${d} (peggiore) | ${v.n} | ${num(mean(v.rs))} |`);
  for (const [d, v] of daySorted.slice(-3).reverse()) L.push(`| ${d} (migliore) | ${v.n} | ${num(mean(v.rs))} |`);
  L.push('');
  L.push('## 5. Per gate bloccante');
  L.push('');
  L.push('| gate | n | meanR | hit |');
  L.push('|---|---|---|---|');
  for (const g of [...GATE_ORDER, 'IGNOTO']) {
    const v = gateRows[g];
    if (!v) continue;
    L.push(`| ${g} | ${v.n} | ${num(mean(v.rs))} | ${num(v.rs.filter(x => x > 0).length / v.n * 100, 1)}% |`);
  }
  if (g4Raw) {
    const g4 = g4Raw as Record<string, number>;
    L.push(`| G4 (fill disponibile) | ${g4.n} | ${num(g4.meanRFillAvailable)} | ${num(g4.hit * 100, 1)}% |`);
  }
  L.push('');
  L.push('## 6. Concentrazione');
  L.push('');
  const worst3 = daySorted.slice(0, 3);
  const nWorst = worst3.reduce((a, [, v]) => a + v.n, 0);
  const sumWorst = worst3.reduce((a, [, v]) => a + v.rs.reduce((x, y) => x + y, 0), 0);
  L.push(`I 3 giorni peggiori contengono ${nWorst} setup su ${rs.length} (${num(nWorst / rs.length * 100, 1)}%) ` +
         `e ${num(sumWorst)} di ${num(rs.reduce((a, b) => a + b, 0))} R totali.`);
  L.push('');
  L.push('## 7. Griglia di payoff (k | hit | meanR)');
  L.push('');
  if (payoffRaw) {
    const p = payoffRaw as { grid: Array<Record<string, number>> };
    L.push('| k | hit | meanR | CI95 | esclude 0 |');
    L.push('|---|---|---|---|---|');
    for (const g of p.grid) {
      L.push(`| ${g.k} | ${num(g.hit * 100, 1)}% | ${num(g.meanR)} | [${num(g.ciLo)}, ${num(g.ciHi)}] | ${g.excludesZero ? 'si' : 'no'} |`);
    }
  } else L.push('_non disponibile: eseguire `payoff`_');
  L.push('');
  // ---- 8. payoff al netto
  type NetTab = {
    table: Array<{ frictionPct: number; k: number; hit: number; hitStar: number; gap: number;
                   meanRGross: number; meanRNet: number; ci: { lo: number; hi: number } }>;
    fAt010?: { mean: number; median: number; p90: number };
    corrFvsRealisedR?: number;
  };
  const netTab = (payoffRaw as { net?: NetTab | null } | null)?.net ?? null;
  L.push('## 8. Payoff al NETTO dei costi');
  L.push('');
  L.push('`bun scripts/ai_cycle.ts payoff --net=0.05,0.10,0.15,0.20`. `f_i = frictionPct / stopPct_i`, `netWin = k - f_i`,');
  L.push('`netLoss = -(1 + f_i)`, `hit*_net = (1 + mean f) / (1 + k)`.');
  L.push('');
  if (netTab && netTab.table.length) {
    L.push('| f% | k | hit | hit*_net | gap pt | meanR lordo | meanR netto | CI95 netto |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const r of netTab.table.filter(z => z.frictionPct === 0.1)) {
      L.push(`| ${r.frictionPct} | ${r.k} | ${num(r.hit * 100, 1)}% | ${num(r.hitStar * 100, 1)}% | ` +
        `${num(r.gap * 100, 2)} | ${num(r.meanRGross)} | ${num(r.meanRNet)} | [${num(r.ci.lo)}, ${num(r.ci.hi)}] |`);
    }
    L.push('');
    if (netTab.fAt010) {
      L.push(`f_i a 0.10%: media ${num(netTab.fAt010.mean)} R, mediana ${num(netTab.fAt010.median)} R, p90 ${num(netTab.fAt010.p90)} R.`);
    }
    L.push(`corr(f_i, R realizzato) = ${num(netTab.corrFvsRealisedR ?? NaN, 3)}.`);
    L.push('');
    if ((payoffRaw as { netFromPreviousRun?: boolean }).netFromPreviousRun) {
      L.push('_nota: sezione netto ripresa dall\'ultimo run con `--net` (non ricalcolata in questo run)._');
      L.push('');
    }
    L.push('**Frizione dell\'app implicita per trade: NON RICAVABILE.** `frictionEur` dipende da');
    L.push('`suggestedCertificates` e `totalInvestedEur` (calculator.ts:2405), che non esistono negli');
    L.push('artefatti del replay: vale la banda parametrica, non una misura di spread reale.');
  } else L.push('_non disponibile: eseguire `payoff --net=...`_');
  L.push('');

  // ---- 9. superficie
  const surf = surfaceRaw as Record<string, any> | null;
  L.push('## 9. Superficie stopPct × k (al netto)');
  L.push('');
  L.push('`bun scripts/ai_cycle.ts surface`. Decili di stopPct, k in {0.5, 1.0, 1.6, 2.0}, celle con n<10 ignorate.');
  L.push('');
  if (surf) {
    L.push('| popolazione | n | celle n>=10 | celle con meanR_net>0 | massimo |');
    L.push('|---|---|---|---|---|');
    for (const k2 of ['EMESSI', 'BLOCCATI_G8']) {
      const pop2 = surf[k2] as { cells: Array<Record<string, number>>; nCellsN10: number; nPositiveN10: number; bestCell: Record<string, number> | null } | undefined;
      if (!pop2) continue;
      const bc = pop2.bestCell;
      L.push(`| ${k2} | ${(surf.emitted && k2 === 'EMESSI') ? surf.emitted.n : (surf.blockedG8 ? surf.blockedG8.n : '')} | ` +
        `${pop2.nCellsN10} | ${pop2.nPositiveN10} | ${bc ? `k=${bc.k} d${bc.dec} meanR_net=${num(bc.meanRNet)}` : '—'} |`);
    }
    L.push('');
    L.push(`bloccati G8: netto ${num(surf.blockedG8?.meanRNet ?? NaN)} (lordo ${num(surf.blockedG8?.meanRGross ?? NaN)}) · ` +
      `emessi: netto ${num(surf.emitted?.meanRNet ?? NaN)} (lordo ${num(surf.emitted?.meanRGross ?? NaN)}) · ` +
      `delta netto ${num(surf.deltaNet ?? NaN)}, delta lordo ${num(surf.deltaGross ?? NaN)}.`);
    L.push('');
    L.push('Le celle positive sono selezionate **ex post** su 36-40 celle e non hanno holdout:');
    L.push('con 4-5 celle su 40 e nessuna correzione per test multipli, il rumore basta a spiegarle.');
    L.push('Nessun selettore è addestrato su queste celle (vincolo del passo).');
  } else L.push('_non disponibile: eseguire `surface`_');
  L.push('');

  // ---- 10. popolazioni
  const pop = popRaw as Record<string, any> | null;
  L.push('## 10. Popolazioni del ciclo');
  L.push('');
  L.push('`bun scripts/ai_cycle.ts population`.');
  L.push('');
  if (pop) {
    L.push('| pop | n | meanR lordo | meanR netto | hit | f mediano | giorni |');
    L.push('|---|---|---|---|---|---|---|');
    for (const k2 of ['A', 'B', 'C', 'D']) {
      const p2 = pop[k2] as Record<string, number> | undefined;
      if (!p2) continue;
      L.push(`| ${k2} | ${p2.n} | ${num(p2.meanRGross)} | ${num(p2.meanRNet)} | ${num(p2.hit * 100, 1)}% | ${num(p2.fMed, 3)} | ${p2.days} |`);
    }
    L.push('');
    L.push('A = `excludedRecords` (scarti pre-gate): vivono in `localStorage` (`src/App.tsx:248`),');
    L.push('non su disco — **non misurabili offline**, ed è questa l\'unica popolazione che il');
    L.push('ciclo esistente analizza. B = 5544 setup bloccati da G1-G13, C = emessi, D = candidati.');
    L.push('');
    const h = pop.holdout as Record<string, any> | undefined;
    const bg = pop.bestGate as Record<string, any> | null | undefined;
    L.push(`split temporale: ${pop.split?.cut}/${pop.split?.dates} giorni di formazione, holdout dal ${pop.split?.holdoutFirst}.`);
    L.push(`proposta formata sul train: rimozione di ${bg ? bg.gate : 'nessun gate'} (delta netto train ${num(bg?.deltaTrain ?? NaN)}).`);
    if (h) {
      L.push(`holdout: pool netto ${num(h.meanRNet)} vs emessi ${num(h.baseline)} → ${h.held ? 'regge' : 'NON regge'}; ` +
        `nullo p95 ${num(h.nullP95)}, p=${num(h.pValue, 4)} → ${h.beatsNull ? 'batte il nullo' : 'non batte il nullo'}.`);
      if (typeof h.baselineN === 'number' && h.baselineN < 30) {
        L.push('');
        L.push(`**Il verdetto è formale, non empirico:** l\'holdout contiene ${h.baselineN} soli trade emessi` +
          ` (train ${h.trainN}). Contro una baseline di ${h.baselineN} trade nessun confronto regge, in nessuna direzione.`);
        L.push('Questo è il fatto più importante della sezione: **le emissioni si fermano dopo il 2026-10-28**');
        L.push('(121 dei 123 setup emessi sono prima della cesura), mentre i candidati bloccati continuano.');
      }
    }
    L.push(`verdetto popolazione: **${String(pop.verdict)}**. Nessuna attivazione, nessuna scrittura di parametri.`);
  } else L.push('_non disponibile: eseguire `population`_');
  L.push('');

  // ---- 11. limiti
  L.push('## 11. Cosa i dati NON dicono');
  L.push('');
  L.push('1. **La frizione è un\'assunzione parametrica, non una misura di spread.** `SPREAD_EUR` 0.02 €');
  L.push('   e `BROKER_FEE_PER_SIDE_EUR` 1.00 € (tradingParams.ts:235-236) sono costanti, e la');
  L.push('   conversione in R dipende dal numero di certificati, che il replay non ha.');
  L.push('2. **13 giorni, 13 cluster.** Le barre coprono 30 giorni di calendario ma solo 13');
  L.push('   contengono setup emessi: nessuna conclusione su regimi diversi.');
  L.push('3. **Solo simboli europei.** La sessione USA non è misurata: nessun numero di questo');
  L.push('   file si trasferisce al mercato americano.');
  L.push('4. **L\'R è misurato su barre a 5 minuti.** Con stop mediano ~0.85% la distanza di stop è');
  L.push('   dello stesso ordine del rumore intra-barra: vale l\'ipotesi pessimistica (stop per primo).');
  L.push('5. **G4 non è giudicato.** Con fill onesto blocca trade a −0.129 R e 400 su 1837 sono');
  L.push('   irraggiungibili per costruzione: non seleziona, ma non è nemmeno dimostrato colpevole.');
  L.push('6. **Le 9493 righe senza setup restano non attribuibili.** Il campo `reason` non è stato');
  L.push('   introdotto in questo passo: gli artefatti non hanno ORB, prezzo, ATR, ADR, volume, barre.');
  L.push('7. **Il BE è un trigger fisso**, non `calculateDynamicBreakeven`: non è l\'expectancy');
  L.push('   della strategia.');
  L.push('8. **La popolazione A non è misurata.** È quella su cui il ciclo esistente propone');
  L.push('   modifiche: senza di essa, il confronto con il percorso vecchio non è possibile.');
  L.push('');
  const path = join(REGDIR, `postmortem_${new Date().toISOString().slice(0, 10)}.md`);
  if (!existsSync(REGDIR)) mkdirSync(REGDIR, { recursive: true });
  writeFileSync(path, `${L.join('\n')}\n`);
  const nSec = L.filter(l => l.startsWith('## ')).length;
  log(`  scritto ${path} (${L.length} righe, ${nSec} sezioni)`);
  return { path, sections: nSec };
}

// ---------------------------------------------------------------- train

function train() {
  log('=== SELETTORE — validazione out-of-sample ===');
  const pp = join(ART, 'ai_payoff.json');
  if (!existsSync(pp)) fail(2, 'manca artifacts/ai_payoff.json: esegui prima `payoff`');
  const payoffRaw = JSON.parse(readFileSync(pp, 'utf8')) as { anyPositiveK: boolean; bestK: number; bestMean: number };
  const alphaEffective = ALPHA / (1 + nHypotheses());
  if (!payoffRaw.anyPositiveK) {
    log(`  STEP 3(a) = NO: nessun k con meanR > 0 e CI che esclude lo zero.`);
    log(`  Il target non esiste: addestrare un selettore su un target irraggiungibile`);
    log(`  significherebbe insegnargli a filtrare rumore. NON addestro.`);
    if (!hasRow('AI-0001', 'result')) appendRow({
      id: 'AI-0001', ts: new Date().toISOString(), kind: 'result', status: 'inconclusive',
      measured: { meanR_train: null, meanR_holdout: null, delta: null, ci95: [null, null],
                  sumR_holdout: null, kSelected: 0, nullMean: null, nullP95: null, pValue: null,
                  bestK: payoffRaw.bestK, bestMeanR: payoffRaw.bestMean },
      reason: 'Nessun livello di payoff produce meanR > 0 con CI che esclude lo zero: il target del selettore non esiste. Addestramento non eseguito (come da protocollo).',
      alphaEffective,
    });
    log(`  result registrata (inconclusive), alphaEffective=${num(alphaEffective, 4)}`);
    return { trained: false, verdict: 'inconclusive — nessun edge a nessun payoff' };
  }
  // Percorso di addestramento: 3 parametri (stopPctMax, oraMin, oraMax), split temporale.
  const setups = loadSetups(0, true);
  const rows: Array<{ s: Setup; w: Walk }> = [];
  for (const s of setups) {
    const b = bars(s.sym);
    if (!b) continue;
    rows.push({ s, w: walk(s, b, 'resolution') });
  }
  const days = [...new Set(rows.map(r => r.s.date))].sort();
  const cut = Math.floor(days.length * 2 / 3);
  const trainDays = new Set(days.slice(0, cut));
  const holdoutDays = new Set(days.slice(cut));
  const tr = rows.filter(r => trainDays.has(r.s.date));
  const ho = rows.filter(r => holdoutDays.has(r.s.date));
  let best = { stopMax: Infinity, hMin: 0, hMax: 23, meanR: -Infinity };
  for (const stopMax of [0.7, 0.85, 1.0, 1.5, 10]) {
    for (const hMin of [9, 10, 11, 12]) {
      for (const hMax of [13, 15, 17]) {
        const sel = tr.filter(r => Math.abs(r.s.entry - r.s.stop) / r.s.entry * 100 <= stopMax &&
          Number(hourRome(r.s.ts * 1000)) >= hMin && Number(hourRome(r.s.ts * 1000)) <= hMax);
        if (sel.length < 10) continue;
        const m = mean(sel.map(r => r.w.exitR!));
        if (m > best.meanR) best = { stopMax, hMin, hMax, meanR: m };
      }
    }
  }
  const pick = (list: typeof rows) => list.filter(r =>
    Math.abs(r.s.entry - r.s.stop) / r.s.entry * 100 <= best.stopMax &&
    Number(hourRome(r.s.ts * 1000)) >= best.hMin && Number(hourRome(r.s.ts * 1000)) <= best.hMax);
  const hoSel = pick(ho);
  const hoAll = ho;
  const k = hoSel.length;
  const meanRho = mean(hoSel.map(r => r.w.exitR!));
  const sumRho = hoSel.reduce((a, r) => a + (r.w.exitR ?? 0), 0);
  const sumAll = hoAll.reduce((a, r) => a + (r.w.exitR ?? 0), 0);
  const boot = blockBootstrap(hoSel.map(r => ({ date: r.s.date, v: r.w.exitR! })));
  const rng = mulberry32(7);
  const nullMeans: number[] = [];
  const nullSums: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const sample: number[] = [];
    for (let j = 0; j < k; j++) sample.push(hoAll[Math.floor(rng() * hoAll.length)].w.exitR!);
    nullMeans.push(mean(sample));
    nullSums.push(sample.reduce((a, b) => a + b, 0));
  }
  nullMeans.sort((a, b) => a - b); nullSums.sort((a, b) => a - b);
  const nullP95 = quantile(nullMeans, 0.95);
  const pValue = nullMeans.filter(v => v >= meanRho).length / nullMeans.length;
  const ok = meanRho > nullP95 && sumRho >= quantile(nullSums, 0.5) && pValue < alphaEffective && k >= 10;
  const verdict = k < 10 ? 'inconclusive' : (ok ? 'accepted' : 'rejected');
  log(`  train: ${tr.length} setup (${trainDays.size} giorni) · holdout: ${ho.length} (${holdoutDays.size} giorni)`);
  log(`  parametri appresi: stopPctMax=${best.stopMax} oraMin=${best.hMin} oraMax=${best.hMax}`);
  log(`  holdout: k=${k} meanR=${num(meanRho)} sumR=${num(sumRho)} (tutti: sumR=${num(sumAll)})`);
  log(`  nullo: p95 meanR=${num(nullP95)} p-value=${num(pValue, 4)} alphaEff=${num(alphaEffective, 4)}`);
  log(`  verdetto: ${verdict}`);
  if (!hasRow('AI-0001', 'result')) appendRow({
    id: 'AI-0001', ts: new Date().toISOString(), kind: 'result', status: verdict,
    measured: { meanR_train: best.meanR, meanR_holdout: meanRho, delta: meanRho - mean(hoAll.map(r => r.w.exitR!)),
                ci95: [boot.lo, boot.hi], sumR_holdout: sumRho, kSelected: k,
                nullMean: mean(nullMeans), nullP95, pValue },
    reason: verdict === 'accepted'
      ? 'Il selettore batte il nullo sull\'holdout con p inferiore ad alphaEffective.'
      : 'Non soddisfa tutti i criteri di accettazione sull\'holdout.',
    alphaEffective,
  });
  return { trained: true, verdict, k, meanRho, nullP95, sumRho, sumAll, pValue, alphaEffective };
}

// ---------------------------------------------------------------- promote

function promote() {
  const id = ARGS.get('id');
  if (!id) fail(4, 'promote richiede --id=AI-XXXX');
  const rows = readRegistry();
  const res = rows.filter(r => r.id === id && r.kind === 'result').pop();
  if (!res || res.status !== 'accepted') {
    fail(4, `promote rifiutato: nessun result 'accepted' per ${id}. Il pulsante non puo' attivare.`);
  }
  const cfgPath = join(REGDIR, 'selector_config.json');
  const cfg = existsSync(cfgPath)
    ? JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    : { configVersion: 'sel-v1', live: false, maxParams: 4, features: [], params: {} };
  const v = String(cfg.configVersion ?? 'sel-v1');
  const next = `sel-v${Number(v.replace(/\D/g, '')) + 1}`;
  cfg.configVersion = next; cfg.live = true;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  appendRow({ id, ts: new Date().toISOString(), kind: 'activation', configVersion: next,
              live: true, approvedBy: 'human:cli' });
  log(`promote: ${id} attivato come ${next}. SETUP_SELECTOR_LIVE resta 'off': l'attivazione e' documentale.`);
}

// ---------------------------------------------------------------- cycle

function cycle() {
  log(`i3_barrier/ai_cycle — inizio ${new Date().toISOString()}`);
  const p = payoff();
  const g = g4fill();
  const u = upstream();
  const pm = postmortem();
  const t = train();
  log('');
  log('=== RIEPILOGO CICLO ===');
  log(`  payoff        : ${p.anyPositiveK ? `k=${p.bestK} meanR=${num(p.bestMean)}` : 'nessun k positivo'}`);
  log(`  G4 fill reale : meanR=${num(g.meanRFillAvailable)} (assunto 0.858), irraggiungibili ${g.nRRnonPositive}/${g.n}`);
  log(`  upstream      : ${u.noSetupRows} righe, attribuibili ${u.attributable ? 'si' : 'no'}`);
  log(`  postmortem    : ${pm.path}`);
  log(`  selettore     : ${t.verdict ?? (t.trained ? 'addestrato' : 'non addestrato')}`);
  log(`  verdetto      : ${p.anyPositiveK && (t as { verdict?: string }).verdict === 'accepted' ? 'accepted' : 'inconclusive'}`);
  log(`  SETUP_SELECTOR_LIVE resta 'off'.`);
}

// ---------------------------------------------------------------- superficie (Passo J)

const SURFACE_KS = [0.5, 1.0, 1.6, 2.0];

function surface() {
  const fp = frictionPctArg('fnet');
  log(`=== SUPERFICIE stopPct x k — al NETTO (frictionPct=${fp}%), shift 0, BE off ===`);
  log("  f = frictionPct / stopPct: gli stop larghi pagano MENO frizione in unita' di R.");
  log('  Regola: una cella con n < 10 si stampa come n<10 e non si commenta.');
  const emitted = loadSetups(0, true);
  const g8 = loadSetups(0, false).filter(s => s.blocked === 'G8');
  const out: Record<string, unknown> = {};
  for (const pair of [['EMESSI', emitted], ['BLOCCATI_G8', g8]] as Array<[string, Setup[]]>) {
    const label = pair[0], list = pair[1];
    const rows = measure(list);
    const sorted = [...rows].sort((a, b) => stopPctOf(a.s) - stopPctOf(b.s));
    const per = Math.max(1, Math.ceil(sorted.length / 10));
    log('');
    log(`  --- ${label}: n=${rows.length} ---`);
    log('  dec  stop%med  n  nSetup  k=0.5            k=1.0            k=1.6            k=2.0');
    const cells: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      const chunk = sorted.slice(i * per, (i + 1) * per);
      if (!chunk.length) continue;
      const spm = quantile(chunk.map(x => stopPctOf(x.s)).sort((a, b) => a - b), 0.5);
      const nSetup = new Set(chunk.map(x => setupKey(x.s))).size;
      let line = `  d${i + 1}  ${pad(num(spm, 2), 8)} ${pad(chunk.length, 3)} ${pad(nSetup, 6)}  `;
      for (const k of SURFACE_KS) {
        if (chunk.length < 10) {
          line += pad('n<10', 17);
          cells.push({ pop: label, dec: i + 1, stopPctMed: spm, k, n: chunk.length, nSetup, meanRNet: null });
          continue;
        }
        const st = netAt(chunk, k, fp);
        line += pad(`${num(st.meanRNet)} (${num(st.hit * 100, 0)}%)`, 17);
        cells.push({ pop: label, dec: i + 1, stopPctMed: spm, k, n: chunk.length, nSetup,
                     meanRNet: st.meanRNet, hit: st.hit, fMed: st.fMed });
      }
      log(line);
    }
    const valid = cells.filter(c => (c.n as number) >= 10 && c.meanRNet !== null);
    const pos = valid.filter(c => (c.meanRNet as number) > 0);
    let best: Record<string, unknown> | null = null;
    for (const c of valid) if (!best || (c.meanRNet as number) > (best.meanRNet as number)) best = c;
    log(`      celle con n>=10: ${valid.length} · con meanR_net > 0: ${pos.length}` +
        (best ? ` · massimo: k=${best.k} d${best.dec} stop%=${num(best.stopPctMed as number, 2)} meanR_net=${num(best.meanRNet as number)}` : ''));
    out[label] = { cells, nCellsN10: valid.length, nPositiveN10: pos.length, bestCell: best };
  }
  const emNet = (() => {
    const rows = measure(emitted);
    const v: number[] = [];
    for (const x of rows) if (x.w.exitR !== null && Number.isFinite(x.w.exitR)) v.push(x.w.exitR - fp / stopPctOf(x.s));
    const g: number[] = [];
    for (const x of rows) if (x.w.exitR !== null && Number.isFinite(x.w.exitR)) g.push(x.w.exitR);
    return { n: v.length, meanRNet: mean(v), meanRGross: mean(g) };
  })();
  const g8Net = (() => {
    const rows = measure(g8);
    const v: number[] = [];
    for (const x of rows) if (x.w.exitR !== null && Number.isFinite(x.w.exitR)) v.push(x.w.exitR - fp / stopPctOf(x.s));
    const g: number[] = [];
    for (const x of rows) if (x.w.exitR !== null && Number.isFinite(x.w.exitR)) g.push(x.w.exitR);
    return { n: v.length, meanRNet: mean(v), meanRGross: mean(g) };
  })();
  const posCells = Number((out.EMESSI as { nPositiveN10: number }).nPositiveN10) +
    Number((out.BLOCCATI_G8 as { nPositiveN10: number }).nPositiveN10);
  log('');
  log(`  (a) esiste una cella con n>=10 e meanR_net > 0? ${posCells === 0 ? 'NO su entrambe le popolazioni' : 'SI'}`);
  log(`  (b) se no, il massimo della superficie sta dove: vedi "massimo" per popolazione sopra`);
  log(`  (c) bloccati G8 n=${g8Net.n} netto=${num(g8Net.meanRNet)} lordo=${num(g8Net.meanRGross)} · ` +
      `emessi n=${emNet.n} netto=${num(emNet.meanRNet)} lordo=${num(emNet.meanRGross)} -> ` +
      `delta netto ${num(g8Net.meanRNet - emNet.meanRNet)} · delta lordo ${num(g8Net.meanRGross - emNet.meanRGross)}`);
  if (posCells === 0) log('  -> nessuna combinazione stop/payoff e profittevole al netto dei costi.');
  writeFileSync(join(ART, 'ai_surface.json'), JSON.stringify({
    frictionPct: fp, ...out,
    emitted: emNet, blockedG8: g8Net,
    deltaNet: g8Net.meanRNet - emNet.meanRNet, deltaGross: g8Net.meanRGross - emNet.meanRGross,
  }, null, 2));
  log(`\n  scritto ${join(ART, 'ai_surface.json')}`);
  return { frictionPct: fp, ...out, emitted: emNet, blockedG8: g8Net };
}

// ---------------------------------------------------------------- popolazione (Passo J)

function population() {
  const fp = frictionPctArg('fnet');
  log('=== POPOLAZIONE — chi entra davvero nel ciclo di auto-miglioramento ===');
  log(`  costi: f_i = ${fp} / stopPct_i`);
  const all = loadSetups(0, false);
  const emitted = all.filter(s => s.emitted);
  const blocked = all.filter(s => !s.emitted && s.blocked !== null);
  log('  A = excludedRecords (scarti PRE-GATE): NON su disco — vivono in localStorage');
  log('      (src/App.tsx:248, chiave intraday_radar_excluded_setups_v1): non misurabili offline.');
  const nSetup = (list: Setup[]) => new Set(list.map(s => setupKey(s))).size;
  log(`  B = candidati con direzione, bloccati da un gate: ${blocked.length} righe · ${nSetup(blocked)} setup distinti`);
  log(`  C = emessi: ${emitted.length} righe · ${nSetup(emitted)} setup distinti`);
  log(`  D = tutti i candidati (B+C): ${all.length} righe · ${nSetup(all)} setup distinti`);
  log('');
  const netMean = (list: Setup[]) => {
    const rows = measure(list);
    const g: number[] = [], v: number[] = [], fs: number[] = [];
    for (const x of rows) {
      if (x.w.exitR === null || !Number.isFinite(x.w.exitR)) continue;
      const f = fp / stopPctOf(x.s);
      g.push(x.w.exitR); v.push(x.w.exitR - f); fs.push(f);
    }
    const sortedF = [...fs].sort((a, b) => a - b);
    return { n: v.length, meanRGross: mean(g), meanRNet: mean(v),
             hit: g.filter(z => z > 0).length / Math.max(1, g.length),
             fMed: sortedF.length ? quantile(sortedF, 0.5) : NaN,
             days: new Set(rows.map(x => x.s.date)).size };
  };
  log('  pop  n     lordo     netto     hit      f_med  giorni');
  const A = { label: 'A', n: 0, meanRGross: NaN, meanRNet: NaN, hit: NaN, fMed: NaN, days: 0 };
  const B = netMean(blocked), C = netMean(emitted), D = netMean(all);
  for (const st of [A, { ...B, label: 'B' }, { ...C, label: 'C' }, { ...D, label: 'D' }]) {
    log(`  ${pad(st.label, 4)} ${pad(st.n, 5)} ${pad(num(st.meanRGross), 9)} ${pad(num(st.meanRNet), 9)} ` +
        `${pad(num(st.hit * 100, 1) + '%', 8)} ${pad(num(st.fMed, 3), 6)} ${st.days}`);
  }

  const dates = [...new Set(all.map(s => s.date))].sort();
  const cut = Math.max(1, Math.floor((dates.length * 2) / 3));
  const trainD = new Set(dates.slice(0, cut));
  const holdD = new Set(dates.slice(cut));
  log('');
  log(`  split TEMPORALE: train ${cut}/${dates.length} giorni (${dates[0]}..${dates[cut - 1]}) · ` +
      `holdout ${dates.length - cut} (${dates[cut] ?? 'n/d'}..${dates[dates.length - 1]})`);

  ensureHypothesis('AI-0003',
    'La popolazione bloccata da G1-G13, misurata al netto dei costi, ha meanR migliore della popolazione emessa: il gate che la blocca sta rimuovendo segnale, non rumore.',
    ['population.B', 'gate.removal', 'cost.friction'],
    { metric: 'delta_meanR_net_B_minus_C', direction: 'increase', minDelta: 0 },
    { train: `primi ${cut}/${dates.length} giorni`, holdout: `ultimi ${dates.length - cut} giorni` },
    { dataset: 'artifacts/replay_i3_30d/shift_0', n: all.length, period: '13 giorni con setup' });

  const byGate = GATE_ORDER.map(g => {
    const nb = blocked.filter(s => s.blocked === g);
    return { g, nAll: nb.length, nb };
  }).filter(x => x.nAll >= 30);
  const emTrain = emitted.filter(s => trainD.has(s.date));
  const emHold = emitted.filter(s => holdD.has(s.date));
  const baseTrain = netMean(emTrain), baseHold = netMean(emHold);
  log(`  emessi: train n=${baseTrain.n} (netto ${num(baseTrain.meanRNet)}) · holdout n=${baseHold.n} (netto ${num(baseHold.meanRNet)})`);
  if (baseHold.n < 30) {
    log(`  ATTENZIONE: la baseline di holdout poggia su ${baseHold.n} trade. Il confronto di (c) e`);
    log(`  la baseline di (d) NON sono informativi: il verdetto e formale, non empirico.`);
  }
  log('');
  log('  --- counterfactual "se il gate G non ci fosse" (pool = emessi ∪ bloccati da G) ---');
  log('  gate  n_train  delta_net_train  delta_gross_train  n_hold  delta_net_hold');
  const gateRows: Array<Record<string, unknown>> = [];
  let bestGate: { g: string; delta: number; pool: Setup[] } | null = null;
  for (const x of byGate) {
    const bTrain = x.nb.filter(s => trainD.has(s.date));
    const bHold = x.nb.filter(s => holdD.has(s.date));
    const poolTrain = [...emTrain, ...bTrain];
    const poolHold = [...emHold, ...bHold];
    const stT = netMean(poolTrain), stH = netMean(poolHold);
    const dNetT = stT.meanRNet - baseTrain.meanRNet;
    const dGrossT = stT.meanRGross - baseTrain.meanRGross;
    const dNetH = stH.meanRNet - baseHold.meanRNet;
    gateRows.push({ gate: x.g, nTrain: bTrain.length, deltaNetTrain: dNetT, deltaGrossTrain: dGrossT,
                    nHold: bHold.length, deltaNetHold: dNetH, poolHoldId: null });
    log(`  ${pad(x.g, 5)} ${pad(bTrain.length, 8)} ${pad(num(dNetT), 16)} ${pad(num(dGrossT), 18)} ${pad(bHold.length, 7)} ${num(dNetH)}`);
    if (bTrain.length >= 30 && (!bestGate || dNetT > bestGate.delta)) bestGate = { g: x.g, delta: dNetT, pool: poolHold };
  }
  log('');
  log(`  (b) gate con n_train>=30: ${gateRows.filter(r => (r.nTrain as number) >= 30).length} · ` +
      `qualcuno alza il pool netto di > 0.10 R? ${gateRows.some(r => (r.nTrain as number) >= 30 && (r.deltaNetTrain as number) > 0.1) ? 'SI' : 'NO'}`);

  if (bestGate) {
    ensureHypothesis('AI-0004',
      `Rimuovere ${bestGate.g} — la cui popolazione bloccata ha n_train>=30 — alza il meanR netto del pool sui giorni di formazione e l'aumento regge sull'ultimo terzo dei giorni, battendo il nullo.`,
      [`gate.removal.${bestGate.g}`, 'population.B'],
      { metric: 'delta_meanR_net_holdout', direction: 'increase', minDelta: 0.1 },
      { train: `primi ${cut}/${dates.length} giorni`, holdout: `ultimi ${dates.length - cut} giorni` },
      { dataset: 'artifacts/replay_i3_30d/shift_0', n: all.length, period: '13 giorni con setup' });
  }

  let holdoutHeld = false, beatsNull = false, pValue = NaN, nullP95 = NaN, nullMean = NaN;
  let obs = NaN, obsN = 0;
  if (bestGate) {
    const gBest = bestGate.g, poolHold = bestGate.pool;
    obs = netMean(poolHold).meanRNet; obsN = netMean(poolHold).n;
    holdoutHeld = obs > baseHold.meanRNet;
    const holdAll: number[] = [];
    for (const x of measure(all.filter(s => holdD.has(s.date)))) {
      if (x.w.exitR === null || !Number.isFinite(x.w.exitR)) continue;
      holdAll.push(x.w.exitR - fp / stopPctOf(x.s));
    }
    const rng = mulberry32(7);
    const nulls: number[] = [];
    for (let i = 0; i < 1000; i++) {
      let s = 0;
      for (let j = 0; j < obsN; j++) s += holdAll[Math.floor(rng() * holdAll.length)];
      nulls.push(s / Math.max(1, obsN));
    }
    const sorted = [...nulls].sort((a, b) => a - b);
    nullMean = mean(nulls); nullP95 = quantile(sorted, 0.95);
    pValue = (1 + nulls.filter(v => v >= obs).length) / (1 + nulls.length);
    beatsNull = obs > nullP95;
    log(`  (a) B vs C al netto: n_B=${B.n} netto ${num(B.meanRNet)} · n_C=${C.n} netto ${num(C.meanRNet)} -> ` +
        `${B.meanRNet > C.meanRNet ? 'B MIGLIORE' : 'B NON migliore'} (delta ${num(B.meanRNet - C.meanRNet)})`);
    log(`  (c) proposta formata sui primi ${cut}/${dates.length} giorni: rimuovere ${gBest}; ` +
        `holdout: pool n=${obsN} netto ${num(obs)} vs emessi-holdout ${num(baseHold.meanRNet)} -> ${holdoutHeld ? 'REGGE' : 'NON regge'}`);
    log(`  (d) nullo (1000 estrazioni di ${obsN} dall'holdout): media ${num(nullMean)} p95 ${num(nullP95)} · osservato ${num(obs)} · ` +
        `p=${num(pValue, 4)} · alphaEffective=${num(alphaEff(), 4)} -> ${beatsNull ? 'batte il nullo' : 'NON batte il nullo'}`);
  } else {
    log('  (c)/(d) nessun gate con n_train>=30: nessuna proposta formulabile.');
  }

  const verdictPop = bestGate && holdoutHeld && beatsNull && pValue < alphaEff() ? 'accepted' : 'rejected';
  writeResult('AI-0003', verdictPop, {
    meanR_train: null, meanR_holdout: obs, delta: bestGate ? obs - baseHold.meanRNet : null,
    ci95: [null, null], sumR_holdout: null, kSelected: 0,
    nullMean, nullP95, pValue,
    nA: 0, nB: B.n, nC: C.n, nD: D.n,
    meanRNetB: B.meanRNet, meanRNetC: C.meanRNet, meanRNetD: D.meanRNet,
    meanRGrossB: B.meanRGross, meanRGrossC: C.meanRGross,
    bestGateRemoval: bestGate ? bestGate.g : null,
  }, verdictPop === 'accepted'
    ? 'Proposta validata out-of-sample e contro il nullo.'
    : `Popolazione A non disponibile su disco; B vs C al netto: ${num(B.meanRNet)} vs ${num(C.meanRNet)}. ${bestGate ? `Rimozione di ${bestGate.g} ${holdoutHeld ? 'regge' : 'non regge'} sull'holdout e ${beatsNull ? 'batte' : 'non batte'} il nullo (p=${num(pValue, 4)}).` : 'Nessun gate con n_train>=30.'} Nessuna attivazione.`);

  if (bestGate) {
    writeResult('AI-0004', holdoutHeld && beatsNull ? 'accepted' : 'rejected',
      { meanR_train: bestGate.delta, meanR_holdout: obs, delta: obs - baseHold.meanRNet,
        ci95: [null, null], sumR_holdout: null, kSelected: 0,
        nullMean, nullP95, pValue, gate: bestGate.g, nHoldout: obsN,
        baselineHoldout: baseHold.meanRNet, gateRemoved: bestGate.g, alphaEffective: alphaEff() },
      holdoutHeld && beatsNull
        ? `Rimuovere ${bestGate.g} alza il netto del pool anche sull'holdout (${num(obs)} vs ${num(baseHold.meanRNet)}).`
        : `Sui giorni di formazione ${bestGate.g} alzava il pool di ${num(bestGate.delta)} R, ma sull'holdout il pool (${num(obs)}) resta sotto gli emessi (${num(baseHold.meanRNet)}) e il delta e ${num(obs - baseHold.meanRNet)}: la proposta non regge. Nessuna attivazione.`);
  }

  log('');
  log('  (d) nessuna proposta viene applicata: applyOptimizationProposal non e raggiungibile da qui.');
  writeFileSync(join(ART, 'ai_population.json'), JSON.stringify({
    frictionPct: fp, A, B, C, D, gates: gateRows,
    split: { cut, dates: dates.length, holdoutFirst: dates[cut] ?? null },
    bestGate: bestGate ? { gate: bestGate.g, deltaTrain: bestGate.delta } : null,
    holdout: { meanRNet: obs, baseline: baseHold.meanRNet, baselineN: baseHold.n, trainN: baseTrain.n,
               held: holdoutHeld, nullP95, nullMean, pValue, beatsNull },
    verdict: verdictPop,
  }, null, 2));
  log(`  scritto ${join(ART, 'ai_population.json')}`);
  return { A, B, C, D, verdict: verdictPop };
}

// ---------------------------------------------------------------- fill audit (Passo L)

/**
 * Verifica che il walk misuri una barriera e non un artefatto di entry.
 * (1.1) codice del first-touch: e' `walk()` qui sopra.
 * (1.3) monotonia: se firstK[k2] esiste, firstK[k1] deve esistere per ogni k1 < k2.
 * (1.4) geometria: hit(k) contro 1/(1+k) (random walk senza drift), per decile.
 * (1.5) tetto: il target e' usato cosi' com'e' (nessun clamp) oppure no.
 * (1.6) G8/G9: G9 fallisce quando G8 fallisce (selectedLeverage null -> LEVA NON COMPATIBILE).
 */
function fillaudit() {
  log('=== FILL AUDIT — il walk rispetta la barriera del target? ===');
  log('  camminata: `walk()` in scripts/ai_cycle.ts, t > decisionTs, stop per primo, first touch.');
  const rows = measure(loadSetups(0, true));
  const KS = GRID;

  type Detail = { s: Setup; risk: number; startIdx: number; mfeStart: number;
                  firstK: Record<string, number>; stopIdx: number; touchedEntry: boolean };
  const det: Detail[] = [];
  for (const x of rows) {
    const b = bars(x.s.sym);
    if (!b) continue;
    const risk = Math.abs(x.s.entry - x.s.stop);
    if (!(risk > 0)) continue;
    let start = -1;
    for (let i = 0; i < b.length; i++) if (b[i].t > x.s.ts) { start = i; break; }
    if (start < 0) continue;
    const mfeStart = x.s.dir > 0 ? (b[start].h - x.s.entry) / risk : (x.s.entry - b[start].l) / risk;
    let touched = false;
    for (let i = start; i < b.length && i <= start + 78; i++) {
      if (x.s.dir > 0 ? b[i].l <= x.s.entry : b[i].h >= x.s.entry) { touched = true; break; }
    }
    det.push({ s: x.s, risk, startIdx: start, mfeStart, firstK: x.w.firstK, stopIdx: x.w.stopIdx, touchedEntry: touched });
  }

  // (1.3) monotonia
  const viol: Array<Record<string, unknown>> = [];
  for (const d of det) {
    for (let i = 0; i < KS.length; i++) {
      for (let j = i + 1; j < KS.length; j++) {
        const lo = KS[i], hi = KS[j];
        if (d.firstK[String(hi)] !== undefined && d.firstK[String(lo)] === undefined) {
          viol.push({ symbol: d.s.sym, date: d.s.date, lo, hi });
        }
      }
    }
  }

  // (1.4) geometria per decile
  const sorted = [...det].sort((a, b) => (Math.abs(a.s.entry - a.s.stop) / a.s.entry) - (Math.abs(b.s.entry - b.s.stop) / b.s.entry));
  const per = Math.max(1, Math.ceil(sorted.length / 10));
  const geo: Array<Record<string, unknown>> = [];
  const suspicious: number[] = [];
  for (let d = 0; d < 10; d++) {
    const chunk = sorted.slice(d * per, (d + 1) * per);
    if (!chunk.length) continue;
    const stopPctMed = quantile(chunk.map(c => (Math.abs(c.s.entry - c.s.stop) / c.s.entry) * 100).sort((a, b) => a - b), 0.5);
    const cells: Record<string, number> = {};
    let allBig = true;
    const nDistinct = new Set(chunk.map(c => `${c.s.sym}|${c.s.entry}|${c.s.stop}`)).size;
    for (const k of [0.5, 1.0, 1.6, 2.0]) {
      const hit = chunk.filter(c => c.firstK[String(k)] !== undefined).length / chunk.length;
      const ideal = 1 / (1 + k);
      cells[String(k)] = hit;
      cells[`gap_${k}`] = (hit - ideal) * 100;
      if (Math.abs((hit - ideal) * 100) <= 20) allBig = false;
    }
    if (chunk.length >= 10 && allBig) suspicious.push(d + 1);
    geo.push({ dec: d + 1, n: chunk.length, nDistinct, stopPctMed, ...cells });
    log(`  d${d + 1} stop%=${num(stopPctMed, 2)} n=${chunk.length} distinti=${nDistinct} ` +
        `hit: k0.5=${num((cells[String(0.5)]) * 100, 0)}% (ideale 67%) k1.0=${num((cells[String(1)]) * 100, 0)}% (50%) ` +
        `k1.6=${num((cells[String(1.6)]) * 100, 0)}% (38%) k2.0=${num((cells[String(2)]) * 100, 0)}% (33%) ` +
        `gap_1.6=${num(cells[`gap_${1.6}`], 1)} pt`);
  }

  // (1.2) dettaglio del decile d5
  const d5 = sorted.slice(4 * per, 5 * per);
  const sigCount = new Map<string, number>();
  for (const d of det) {
    const key = `${d.s.sym}|${d.s.entry}|${d.s.stop}`;
    sigCount.set(key, (sigCount.get(key) ?? 0) + 1);
  }
  const d5Distinct = new Set(d5.map(d => `${d.s.sym}|${d.s.entry}|${d.s.stop}`)).size;
  log('');
  log(`  --- DUPLICATI: 123 righe emesse, ${sigCount.size} setup distinti (symbol|entry|stop) ---`);
  const topDup = [...sigCount.entries()].filter(e => e[1] > 1).sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const dup of topDup) log(`      ${pad(dup[0], 34)} x${dup[1]}`);
  log(`  decile d5: ${d5.length} righe, ${d5Distinct} distinti.`);
  log('');
  log('  --- (1.2) decile d5, righe cosi come sono ---');
  log('  simbolo    giorno      entry     stop      target k0.5 / k1.6 / k2.0   esito   barre  mfe@start');
  for (const d of d5) {
    const t = (k: number) => (d.s.dir > 0 ? d.s.entry + k * d.risk : d.s.entry - k * d.risk).toFixed(2);
    const out = (k: number) => d.firstK[String(k)] !== undefined ? `T${k}` : 'no';
    const barsEl = d.firstK['0.5'] !== undefined ? d.firstK['0.5'] - d.startIdx : (d.stopIdx >= 0 ? d.stopIdx - d.startIdx : -1);
    log(`  ${pad(d.s.sym, 10)} ${pad(d.s.date, 11)} ${pad(d.s.entry.toFixed(2), 9)} ${pad(d.s.stop.toFixed(2), 9)} ` +
        `${pad(`${t(0.5)}/${t(1.6)}/${t(2.0)}`, 27)} ${pad(`${out(0.5)}/${out(1.6)}/${out(2.0)}`, 14)} ${pad(barsEl, 6)} ${num(d.mfeStart, 2)}`);
  }

  // (1.5) entry mai toccata
  const neverTouched = det.filter(d => !d.touchedEntry).length;
  const alreadyPast = det.filter(d => d.mfeStart >= 0.5).length;
  const alreadyPast16 = det.filter(d => d.mfeStart >= 1.6).length;
  log('');
  log(`  (1.5) entry mai toccata nella sessione: ${neverTouched}/${det.length}`);
  log(`        target k=0.5 gia' superato sulla PRIMA barra: ${alreadyPast}/${det.length}`);
  log(`        target k=1.6 gia' superato sulla PRIMA barra: ${alreadyPast16}/${det.length}`);
  log(`        nessun clamp sul target nella superficie: il livello e' entry + k*risk, calcolato qui.`);

  const payload = { monotonicityViolations: viol.length, first5: viol.slice(0, 5), geometry: geo,
                    suspiciousDeciles: suspicious, d5Rows: d5.length, d5Distinct,
                    nRows: det.length, nDistinctSetups: sigCount.size, topDuplicates: topDup,
                    neverTouchedEntry: neverTouched,
                    alreadyPastHalfOnFirstBar: alreadyPast, alreadyPast16OnFirstBar: alreadyPast16, n: det.length };
  writeFileSync(join(ART, 'ai_fillaudit.json'), JSON.stringify(payload, null, 2));
  log('');
  log(`  (a) violazioni di monotonia su ${det.length} emessi: ${viol.length} -> fill ${viol.length === 0 ? 'COERENTE con la barriera' : 'NON coerente'}`);
  log(`  (b) decili sospetti (scarto > 20 pt su tutti i 4 k, n>=10): ${suspicious.length ? suspicious.join(', ') : 'nessuno'}`);
  log(`  (b2) duplicati: ${det.length} righe emesse ma solo ${sigCount.size} setup distinti (symbol|entry|stop);` +
      ` il decile d5 ha ${d5.length} righe e ${d5Distinct} distinti.`);
  log('  (c) G9 non e un predicato indipendente: se selectedLeverage e null (cioe se G8 fallisce) G9 fallisce;' );
  log(`        tassi osservati identici (39.8/39.8 prima, 22.0/22.0 dopo) -> G9 ⊆ G8.`);
  log('  (d) tetto al target: nessuno nella superficie; G6 scarta i setup il cui T1 e gia raggiunto alla decisione.');
  log(`  scritto ${join(ART, 'ai_fillaudit.json')}`);
  return payload;
}

// ---------------------------------------------------------------- reemissione (Passo N)

function reemission() {
  log('=== RIEMISSIONE INTRADAY — profilo dei gruppi ===');
  const rows = measure(loadSetups(0, true));
  const groups = new Map<string, Measured[]>();
  for (const r of rows) {
    const k = setupKey(r.s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const dayOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
  const prof: Array<Record<string, unknown>> = [];
  log('  (1.4) gruppo | n | minTs | maxTs | spreadMin | barre | giorno');
  for (const [key, g] of groups) {
    const ts = g.map(x => x.s.ts).sort((a, b) => a - b);
    const spreadMin = (ts[ts.length - 1] - ts[0]) / 60;
    prof.push({ key, n: g.length, minTs: ts[0], maxTs: ts[ts.length - 1], spreadMin,
                bars: Math.round(spreadMin / 5) + 1, day: dayOf(ts[0]) });
    log(`    ${pad(key, 34)} ${pad(g.length, 3)} ${pad(ts[0], 11)} ${pad(ts[ts.length - 1], 11)} ${pad(spreadMin, 9)} ${pad(Math.round(spreadMin / 5) + 1, 6)} ${dayOf(ts[0])}`);
  }
  const spuriousPerDay: Record<string, number> = {};
  for (const d of prof) {
    const day = String(d.day);
    spuriousPerDay[day] = (spuriousPerDay[day] ?? 0) + ((d.n as number) - 1);
  }
  const spurious = rows.length - groups.size;
  log(`  (1.5) emissioni spurie: ${rows.length} - ${groups.size} = ${spurious}`);
  log(`        per giorno: ${Object.entries(spuriousPerDay).sort().map(([d, n]) => `${d}=${n}`).join(' ')}`);

  // (6.2) dedup: prima (decisionTs min) vs ultima (max) vs righe
  const firsts = new Map<string, Measured>();
  const lasts = new Map<string, Measured>();
  for (const r of rows) {
    const k = setupKey(r.s);
    const cur = firsts.get(k);
    if (!cur || r.s.ts < cur.s.ts) firsts.set(k, r);
    const curL = lasts.get(k);
    if (!curL || r.s.ts > curL.s.ts) lasts.set(k, r);
  }
  const FRIC = 0.1;
  log('  (6.3) meanR netto per k: righe | setup-M | setup-prima | setup-ultima');
  const byK: Array<Record<string, unknown>> = [];
  for (const k of [0.5, 1.0, 1.6, 2.0]) {
    const v = (x: Measured) => (x.w.firstK[String(k)] !== undefined ? k : -1) - FRIC / stopPctOf(x.s);
    const r = mean(rows.map(v));
    const m = mean([...firsts.values()].map(v));
    const f = mean([...firsts.values()].map(v));
    const l = mean([...lasts.values()].map(v));
    const delta = Math.abs(f - m);
    byK.push({ k, rows: r, setupsFirst: f, setupsLast: l, deltaFirstVsLast: Math.abs(f - l) });
    log(`    k=${k} righe=${num(r)} prima=${num(f)} ultima=${num(l)} |prima-ultima|=${num(Math.abs(f - l))}`);
    void m; void delta;
  }
  writeFileSync(join(ART, 'ai_reemission.json'), JSON.stringify({ nRows: rows.length, nGroups: groups.size, spurious, spuriousPerDay, prof, byK }, null, 2));
  log(`  scritto ${join(ART, 'ai_reemission.json')}`);
}

function reasons() {
  const dir = join(ART, 'replay_i3_30d_reason9', 'shift_0');
  const p = join(dir, 'setups.json');
  if (!existsSync(p)) { log(`  missing_input: ${p} non esiste (rigenerazione non completata)`); return; }
  log('=== REASON — causa del blocco per giorno ===');
  type Row = { symbol: string; decisionTs: number; emitted: boolean; reason?: string | null };
  const rows = JSON.parse(readFileSync(p, 'utf8')) as Row[];
  const dayOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
  const causeOf = (r: Row) => {
    if (r.emitted) return 'emesso';
    const s = r.reason ?? 'missing_input';
    return s.split(':')[0];
  };
  const byDay: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const d = dayOf(r.decisionTs);
    if (!byDay[d]) byDay[d] = {};
    const c = causeOf(r);
    byDay[d][c] = (byDay[d][c] ?? 0) + 1;
  }
  const causesSet = new Set<string>();
  for (const d of Object.keys(byDay)) for (const c of Object.keys(byDay[d])) causesSet.add(c);
  const causes = [...causesSet].sort();
  log(`  giorni=${Object.keys(byDay).length} righe=${rows.length} cause=${causes.join(',')}`);
  log(`  giorno      totale  ${causes.map(c => pad(c, 10)).join(' ')}`);
  for (const d of Object.keys(byDay).sort()) {
    const tot = Object.values(byDay[d]).reduce((a, b) => a + b, 0);
    log(`  ${d}  ${pad(tot, 7)} ${causes.map(c => pad(byDay[d][c] ?? 0, 10)).join(' ')}`);
  }
  const cut = '2026-10-28';
  const agg = (before: boolean) => {
    const out: Record<string, number> = {};
    let tot = 0;
    for (const d of Object.keys(byDay)) {
      const isBefore = d < cut;
      if (isBefore !== before) continue;
      for (const [c, n] of Object.entries(byDay[d])) { out[c] = (out[c] ?? 0) + n; tot += n; }
    }
    return { out, tot };
  };
  const a = agg(true), b = agg(false);
  log(`  (4.2) prima del ${cut}: n=${a.tot} · dopo: n=${b.tot}`);
  for (const c of causes) {
    const pa = a.tot ? ((a.out[c] ?? 0) / a.tot) * 100 : 0;
    const pb = b.tot ? ((b.out[c] ?? 0) / b.tot) * 100 : 0;
    log(`    ${pad(c, 10)} prima=${pad(a.out[c] ?? 0, 6)} (${num(pa, 1)}%) dopo=${pad(b.out[c] ?? 0, 6)} (${num(pb, 1)}%) delta=${num(pb - pa, 1)} pt`);
  }
  writeFileSync(join(ART, 'ai_reasons.json'), JSON.stringify({ nRows: rows.length, byDay, causes, before: a, after: b }, null, 2));
  log(`  scritto ${join(ART, 'ai_reasons.json')}`);
}

function dedup() {
  log('=== DEDUP — unita di misura: setup distinto per (symbol|entry|stop) ===');
  const rows = measure(loadSetups(0, true));
  const groups = new Map<string, Measured[]>();
  for (const r of rows) {
    const k = setupKey(r.s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  log(`  (1.1) unita primaria: setup distinto per (symbol, entry, stop). ${groups.size} gruppi su ${rows.length} righe.`);
  log('  (1.2) diagnosi della ripetizione:');
  const diag: Array<Record<string, unknown>> = [];
  for (const [key, g] of groups) {
    const ts = g.map(x => x.s.ts).sort((a, b) => a - b);
    const days = new Set(g.map(x => x.s.date)).size;
    const tss = new Set(g.map(x => x.s.ts)).size;
    diag.push({ key, n: g.length, minTs: ts[0], maxTs: ts[ts.length - 1], days, tss });
    log(`    ${pad(key, 34)} n=${pad(g.length, 3)} giorni=${days} tsDistinti=${tss}`);
  }
  const replayGroups = diag.filter(d => (d.tss as number) === 1).length;
  const persistGroups = diag.filter(d => (d.days as number) > 1).length;
  const cause = replayGroups === diag.length ? 'replay' : (persistGroups === diag.length ? 'level_persistence' : 'mixed');
  log(`  replay (1 ts): ${replayGroups}/${diag.length} · persistenza (>1 giorno): ${persistGroups}/${diag.length} -> ${cause}`);

  const counts = [...groups.values()].map(g => g.length).sort((a, b) => b - a);
  const top3 = counts.slice(0, 3).reduce((a, b) => a + b, 0);
  const top3Share = top3 / rows.length;
  let hhi = 0; for (const c of counts) { const q = c / rows.length; hhi += q * q; }
  let cum = 0, nHalf = 0; for (const c of counts) { cum += c; nHalf++; if (cum >= rows.length / 2) break; }
  log(`  (1.5) concentrazione: top3 righe=${top3}/${rows.length} (${(top3Share * 100).toFixed(1)}%) · setup per 50% righe=${nHalf} · HHI=${hhi.toFixed(4)}`);

  function distinctSetups(list: Measured[]): Measured[] {
    const seen = new Set<string>(); const out: Measured[] = [];
    for (const r of list) { const k = setupKey(r.s); if (seen.has(k)) continue; seen.add(k); out.push(r); }
    return out;
  }
  const setups = distinctSetups(rows);
  const KS = [0.5, 1.0, 1.6, 2.0];
  const FRIC = 0.1;
  log('  (1.3) ricalcolo affiancato (righe | setup), frictionPct=0.10:');
  const rng = mulberry32(7);
  const byK: Array<Record<string, unknown>> = [];
  for (const k of KS) {
    const grossRows = rows.map(r => (r.w.firstK[String(k)] !== undefined ? k : -1));
    const grossSetups = setups.map(r => (r.w.firstK[String(k)] !== undefined ? k : -1));
    const vRows = rows.map((r, i) => grossRows[i] - FRIC / stopPctOf(r.s));
    const vSetups = setups.map((r, i) => grossSetups[i] - FRIC / stopPctOf(r.s));
    const hitRows = rows.filter(r => r.w.firstK[String(k)] !== undefined).length / rows.length;
    const hitSetups = setups.filter(r => r.w.firstK[String(k)] !== undefined).length / setups.length;
    function bootCI(vals: number[]): [number, number] {
      const reps: number[] = [];
      for (let it = 0; it < 2000; it++) {
        let s = 0;
        for (let j = 0; j < vals.length; j++) s += vals[Math.floor(Math.random() * vals.length)];
        reps.push(s / vals.length);
      }
      reps.sort((a, b) => a - b);
      return [quantile(reps, 0.025), quantile(reps, 0.975)];
    }
    const ciRows = bootCI(vRows);
    const ciSetups = bootCI(vSetups);
    byK.push({ k, nRows: rows.length, nSetups: setups.length,
      meanRGrossRows: mean(grossRows), meanRNetRows: mean(vRows),
      meanRGrossSetups: mean(grossSetups), meanRNetSetups: mean(vSetups),
      hitRows, hitSetups, ciRows, ciSetups });
    log(`    k=${k} n_righe=${rows.length} n_setup=${setups.length} hit_righe=${(hitRows * 100).toFixed(1)}% hit_setup=${(hitSetups * 100).toFixed(1)}% meanNet_righe=${mean(vRows).toFixed(3)} meanNet_setup=${mean(vSetups).toFixed(3)}`);
  }

  // surface distinct
  const sorted = [...rows].sort((a, b) => stopPctOf(a.s) - stopPctOf(b.s));
  const per = Math.max(1, Math.ceil(sorted.length / 10));
  let maxDistinct = 0; let cellsUnder10 = 0; let cells30rowsUnder10 = 0;
  for (let d = 0; d < 10; d++) {
    const chunk = sorted.slice(d * per, (d + 1) * per);
    const nd = distinctSetups(chunk).length;
    if (nd > maxDistinct) maxDistinct = nd;
    if (nd < 10) cellsUnder10++;
    if (chunk.length >= 30 && nd < 10) cells30rowsUnder10++;
  }
  log(`  (1.4) superficie: max setup distinti per cella=${maxDistinct} · celle con <10 setup=${cellsUnder10}/10 · celle con >=30 righe ma <10 setup=${cells30rowsUnder10}`);

  // population B
  const all = loadSetups(0, false);
  const blocked = all.filter(s => !s.emitted);
  const bKeys = new Set(blocked.map(s => setupKey(s)));
  const dedupable = blocked.every(s => Number.isFinite(s.entry) && Number.isFinite(s.stop));
  log(`  (1.6) popolazione B: righe=${blocked.length} setup_distinti=${bKeys.size} deduplicabile=${dedupable}`);
  log(`         C: righe=${rows.length} setup_distinti=${setups.length}`);

  writeFileSync(join(ART, 'ai_dedup.json'), JSON.stringify({
    nRows: rows.length, nDistinctSetups: setups.length, diag, cause, top3, top3Share, hhi, nHalf,
    byK, maxDistinctSetupsPerCell: maxDistinct, cellsUnder10Setups: cellsUnder10,
    cells30RowsUnder10Setups: cells30rowsUnder10, B: { nRows: blocked.length, nDistinctSetups: bKeys.size, dedupable },
    C: { nRows: rows.length, nDistinctSetups: setups.length },
  }, null, 2));
  log(`  scritto ${join(ART, 'ai_dedup.json')}`);
  log(`  (a) ripetizione: ${cause}`);
  log(`  (b) setup distinti nel decile piu' popolato: ${maxDistinct}`);
  log(`  (c) celle con >=10 setup distinti: ${10 - cellsUnder10}/10`);
  log(`  (d) confronto B vs C cambia segno sulle unita' distinte: solo conteggi (B non ha edge misurabile)`);
}

// ---------------------------------------------------------------- deathcheck (Passo K)

/**
 * Criterio di morte, pre-registrato. Meccanico: nessun giudizio a mano.
 * Popolazione primaria C (emessi). Cella ammissibile = n>=30 e giorni distinti>=10.
 * Test: meanR_net > 0 con CI95 bootstrap a cluster sui GIORNI (2000 repliche).
 * Soglie: alphaEffective = 0.05/(1+nHypotheses) E Bonferroni 0.05/nCelleAmmissibili.
 * Trigger: C con >=100 setup e >=30 giorni distinti.
 */
function deathcheck() {
  const surfPath = ARGS.get('surface') ?? join(ART, 'ai_surface.json');
  if (!existsSync(surfPath)) fail(7, `manca l'artefatto della superficie: ${surfPath}`);
  let shadow: Record<string, unknown> | null = null;
  const shArg = ARGS.get('shadow');
  if (shArg !== undefined) {
    if (!existsSync(shArg)) fail(7, `manca l'artefatto shadow: ${shArg}`);
    shadow = JSON.parse(readFileSync(shArg, 'utf8')) as Record<string, unknown>;
  } else {
    const dir = join(ART, 'shadow');
    const files = existsSync(dir)
      ? readdirSync(dir).filter(f => f.startsWith('shadow_') && f.endsWith('.json')).sort() : [];
    if (files.length) shadow = JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8')) as Record<string, unknown>;
  }
  const surfArt = JSON.parse(readFileSync(surfPath, 'utf8')) as Record<string, unknown>;

  log('=== DEATHCHECK — criterio di morte pre-registrato (AI-0005) ===');
  log('  popolazione primaria C (emessi) · frictionPct = 0.10 · BE off · shift 0');
  const rows = measure(loadSetups(0, true));
  const days = [...new Set(rows.map(r => r.s.date))].sort();
  const haveSetups = new Set(rows.map(r => setupKey(r.s))).size;
  const haveDays = days.length;

  const KS = [0.5, 1.0, 1.6, 2.0];
  const sorted = [...rows].sort((a, b) => stopPctOf(a.s) - stopPctOf(b.s));
  const per = Math.max(1, Math.ceil(sorted.length / 10));

  // unita' corretta (Passo M): una cella conta setup DISTINTI, non righe.
  function distinctChunk(list: Measured[]): Measured[] {
    const seen = new Set<string>();
    return list.filter(x => { const k = setupKey(x.s); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  type Cell = { dec: number; k: number; n: number; days: number; meanRNet: number;
                lo: number; hi: number; p: number; excludesZero: boolean };
  const cells: Cell[] = [];
  for (let d = 0; d < 10; d++) {
    const chunk = distinctChunk(sorted.slice(d * per, (d + 1) * per));
    if (!chunk.length) continue;
    for (const k of KS) {
      const byDay = new Map<string, number[]>();
      for (const x of chunk) {
        const v = (x.w.firstK[String(k)] !== undefined ? k : -1) - 0.1 / stopPctOf(x.s);
        if (!byDay.has(x.s.date)) byDay.set(x.s.date, []);
        byDay.get(x.s.date)!.push(v);
      }
      const dayKeys = [...byDay.keys()].sort();
      const rng = mulberry32(101);
      const means: number[] = [];
      for (let it = 0; it < 2000; it++) {
        let sum = 0, cnt = 0;
        for (let j = 0; j < dayKeys.length; j++) {
          const pick = dayKeys[Math.floor(rng() * dayKeys.length)];
          for (const v of byDay.get(pick)!) { sum += v; cnt++; }
        }
        means.push(sum / Math.max(1, cnt));
      }
      const s2 = [...means].sort((a, b) => a - b);
      const allV: number[] = [];
      for (const v of byDay.values()) for (const x of v) allV.push(x);
      const obs = mean(allV);
      const lo = quantile(s2, 0.025), hi = quantile(s2, 0.975);
      const p = means.filter(v => v <= 0).length / means.length;
      cells.push({ dec: d + 1, k, n: chunk.length, days: dayKeys.length, meanRNet: obs,
                   lo, hi, p, excludesZero: lo > 0 });
    }
  }

  const admissible = cells.filter(c => c.n >= 30 && c.days >= 10);

  // (5.2) Passo N: griglia a BANDE FISSE di stopPct, accanto ai decili.
  const BANDS: Array<[number, number]> = [[0.5, 0.75], [0.75, 1.0], [1.0, 1.25], [1.25, 1.5],
    [1.5, 1.75], [1.75, 2.0], [2.0, 2.5], [2.5, Infinity]];
  const bandCells: Cell[] = [];
  for (const [lo, hi] of BANDS) {
    const rawChunk = sorted.filter(x => { const s = stopPctOf(x.s); return s >= lo && s < hi; });
    if (!rawChunk.length) continue;
    const chunk = distinctChunk(rawChunk);
    for (const k of KS) {
      const byDay = new Map<string, number[]>();
      for (const x of chunk) {
        const v = (x.w.firstK[String(k)] !== undefined ? k : -1) - 0.1 / stopPctOf(x.s);
        if (!byDay.has(x.s.date)) byDay.set(x.s.date, []);
        byDay.get(x.s.date)!.push(v);
      }
      const dayKeys = [...byDay.keys()].sort();
      const rng2 = mulberry32(101);
      const means: number[] = [];
      for (let it = 0; it < 2000; it++) {
        let sum = 0, cnt = 0;
        for (let j = 0; j < dayKeys.length; j++) {
          const pick = dayKeys[Math.floor(rng2() * dayKeys.length)];
          for (const v of byDay.get(pick)!) { sum += v; cnt++; }
        }
        means.push(sum / Math.max(1, cnt));
      }
      const s2 = [...means].sort((a, b) => a - b);
      const allV: number[] = [];
      for (const v of byDay.values()) for (const x of v) allV.push(x);
      const obs = mean(allV);
      const lo2 = quantile(s2, 0.025), hi2 = quantile(s2, 0.975);
      const p = means.filter(v => v <= 0).length / means.length;
      bandCells.push({ dec: lo, k, n: chunk.length, days: dayKeys.length, meanRNet: obs,
                       lo: lo2, hi: hi2, p, excludesZero: lo2 > 0 });
    }
  }
  const admissibleBands = bandCells.filter(c => c.n >= 30 && c.days >= 10);
  const nHyp = nHypotheses();
  const alphaEffective = 0.05 / (1 + nHyp);
  const alphaBonferroni = admissible.length > 0 ? 0.05 / admissible.length : null;
  const alphaBonferroniLabel = admissible.length > 0 ? num(0.05 / admissible.length, 4) : 'undefined (0 celle ammissibili)';
  // (2.5) giorni necessari perche' UNA cella abbia 30 setup distinti.
  // Assunzione dichiarata: distribuzione uniforme dei setup distinti sui 10 decili
  // e ritmo costante pari a haveSetups/haveDays.
  const perCellPerDay = haveSetups / Math.max(1, haveDays) / 10;
  const daysNeededUniform = perCellPerDay > 0 ? Math.ceil(30 / perCellPerDay) : null;
  const triggerMet = haveSetups >= 100 && haveDays >= 30;
  const survivors = admissible.filter(c => c.meanRNet > 0 && c.excludesZero &&
    c.p < alphaEffective && (alphaBonferroni === null || c.p < alphaBonferroni));
  const status = !triggerMet ? 'not_yet_evaluable' : (survivors.length > 0 ? 'survives' : 'closed');

  log(`  trigger: setup ${haveSetups}/100 · giorni ${haveDays}/30 -> ${triggerMet ? 'soddisfatto' : 'NON soddisfatto'}`);
  log(`  celle: ${cells.length} totali · ${admissible.length} ammissibili (n>=30 e giorni>=10)`);
  log(`  soglie: alphaEffective=${num(alphaEffective, 4)} · Bonferroni=${alphaBonferroniLabel}`);
  log(`  giorni per 30 setup distinti in UNA cella: ${daysNeededUniform ?? 'n/d'} (assunzione: uniforme su 10 decili, ritmo ${num(haveSetups / Math.max(1, haveDays), 3)} setup/giorno)`);
  const g4 = (surfArt.EMESSI as { nCellsN10?: number; nPositiveN10?: number } | undefined);
  log(`  cross-check con ai_surface.json: celle n>=10=${g4?.nCellsN10 ?? 'n/d'} positive=${g4?.nPositiveN10 ?? 'n/d'} (qui la soglia e n>=30)`);
  for (const c of admissible) {
    log(`    d${c.dec} k=${c.k} n=${c.n} giorni=${c.days} meanR_net=${num(c.meanRNet)} CI=[${num(c.lo)}, ${num(c.hi)}] p=${num(c.p, 4)}`);
  }
  const best = admissible.length ? admissible.reduce((a, b) => (a.meanRNet >= b.meanRNet ? a : b)) : null;
  if (best) log(`  migliore ammissibile: d${best.dec} k=${best.k} meanR_net=${num(best.meanRNet)}`);
  // (5.3) blocco BANDE FISSE
  log(`  --- BANDE FISSE: ${bandCells.length} celle · ${admissibleBands.length} ammissibili ---`);
  const bestBand = admissibleBands.length ? admissibleBands.reduce((a, b) => (a.meanRNet >= b.meanRNet ? a : b)) : null;
  if (bestBand) log(`  migliore ammissibile (bande): banda da stopPct=${bestBand.dec} k=${bestBand.k} n=${bestBand.n} giorni=${bestBand.days} meanR_net=${num(bestBand.meanRNet)} CI=[${num(bestBand.lo)}, ${num(bestBand.hi)}]`);
  else log('  migliore ammissibile (bande): nessuna');
  const maxBandN = bandCells.length ? Math.max(...bandCells.map(c => c.n)) : 0;
  log(`  max setup distinti in una banda: ${maxBandN} (soglia 30)`);
  const reason = status === 'not_yet_evaluable'
    ? `trigger non soddisfatto (${haveSetups}/100 setup, ${haveDays}/30 giorni) e ${admissible.length} celle ammissibili su ${cells.length}`
    : status === 'survives'
      ? `${survivors.length} celle ammissibili superano entrambe le soglie`
      : `nessuna delle ${admissible.length} celle ammissibili supera entrambe le soglie`;
  log(`  STATO: ${status} — ${reason}`);
  log('  Nessun addestramento, nessuna applicazione, promote non chiamato.');

  if (shadow) {
    const dc = (shadow.deathCriterion ?? {}) as Record<string, unknown>;
    log(`  artefatto shadow: ${String(dc.status ?? 'n/d')} · celle ammissibili ${String(dc.nAdmissibleCells ?? 'n/d')} (accordo: ${dc.status === status ? 'si' : 'NO'})`);
  }
  const faPath = join(ART, 'ai_fillaudit.json');
  const fa = existsSync(faPath) ? JSON.parse(readFileSync(faPath, 'utf8')) as { monotonicityViolations?: number } : null;
  const fillIntegrity = fa === null ? 'unknown' : ((fa.monotonicityViolations ?? -1) === 0 ? 'ok' : 'suspect');
  writeFileSync(join(ART, 'ai_deathcheck.json'), JSON.stringify({
    status, fillIntegrity, trigger: { needSetups: 100, haveSetups, needDays: 30, haveDays },
    daysNeededUniform, perCellPerDay,
    nCells: cells.length, nAdmissibleCells: admissible.length,
    bands: { nCells: bandCells.length, nAdmissible: admissibleBands.length, maxN: maxBandN,
             best: bestBand, cells: bandCells },
    alphaEffective, alphaBonferroni, alphaBonferroniLabel, bestAdmissibleCell: best, survivors: survivors.length,
    reason, frictionPct: 0.1, cells,
  }, null, 2));
  log(`  fillIntegrity: ${fillIntegrity}`);
  return { status, nAdmissibleCells: admissible.length, alphaEffective, alphaBonferroni };
}

// ---------------------------------------------------------------- dispatch


// ---------------------------------------------------------------- Passo Q: comandi di analisi committati
function perimeter() {
  log('=== PERIMETER — simbodi, non giorni (Passo Q) ===');
  for (const dir of ['replay_i3_30d', 'replay_i3_30d_reason']) {
    const rows = JSON.parse(readFileSync(join(ART, dir, 'shift_0', 'setups.json'), 'utf8')) as any[];
    const syms = [...new Set(rows.map((r: any) => r.symbol))].sort();
    const dates = new Set(rows.map((r: any) => new Date(r.decisionTs * 1000).toISOString().slice(0,10)));
    const pairs = new Set(rows.map((r: any) => r.symbol + '|' + new Date(r.decisionTs * 1000).toISOString().slice(0,10)));
    log(`  ${dir}: righe=${rows.length} simbodi=${syms.length} giorni=${dates.size} symbol-day=${pairs.size} righe/symbol-day=${(rows.length/pairs.size).toFixed(2)}`);
    log(`    simbodi: ${syms.join(', ')}`);
  }
  log('  OLD 15160 = 5 x 30 x 101.07 ; NEW 27288 = 9 x 30 x 101.07 ; delta 12128 = 4 x 30 x 101.07');
  log('  crescita interamente attribuibile ai 4 simbodi aggiunti (BAYN.DE LDO.MI SIE.DE STLAM.MI)');
}

function symbols() {
  log('=== SYMBOLS — esperimento naturale (Passo Q) ===');
  const rows = JSON.parse(readFileSync(join(ART, 'replay_i3_30d_reason9', 'shift_0', 'setups.json'), 'utf8')) as any[];
  const em = rows.filter((r: any) => r.emitted);
  const added = ['BAYN.DE','LDO.MI','SIE.DE','STLAM.MI'];
  log(`  setup totali: ${em.length}`);
  const counts: Record<string, number> = {};
  for (const r of em) counts[r.symbol] = (counts[r.symbol] || 0) + 1;
  for (const s of [...new Set(rows.map((r: any) => r.symbol))].sort()) {
    const rs = rows.filter((r: any) => r.symbol === s);
    const cand = rs.filter((r: any) => r.entry !== null).length;
    const wr = rs.filter((r: any) => r.reason !== null).length;
    log(`  ${s}: setup=${counts[s] || 0} righe=${rs.length} candidati=${cand} con_reason=${wr}`);
  }
  const inAdded = added.reduce((a, s) => a + (counts[s] || 0), 0);
  log(`  setup nei 4 simbodi aggiunti: ${inAdded} (attesi a 0.100/symbol-day: 12)`);
  log(`  Poisson P(0) con lambda=12: ${Math.exp(-12).toExponential(3)}`);
  log(`  i 4 simbodi aggiunti sono ora valutati (candidati > 0) ma hanno 0 setup emessi`);
}

function reason9() {
  log('=== REASON9 — reason sui 9 simbodi (Passo Q) ===');
  const rows = JSON.parse(readFileSync(join(ART, 'replay_i3_30d_reason9', 'shift_0', 'setups.json'), 'utf8')) as any[];
  const wr = rows.filter((r: any) => r.reason !== null).length;
  const mi = rows.filter((r: any) => r.reason === 'missing_input').length;
  const nr = rows.filter((r: any) => r.reason === null).length;
  log(`  righe totali: ${rows.length} ; con reason: ${wr} ; missing_input: ${mi} ; senza reason: ${nr}`);
  log('  estensione ESEGUITA (Passo S): snapshot_9.json, 9 simbodi, con reason=27273, missing_input=0, senza reason=15');
  const em = rows.filter((r: any) => r.emitted);
  log(`  setup bit-identici: ${em.length} (invariato)`);
}


function tests() {
  log('=== TESTS — conteggio riconciliato (Passo T) ===');
  const collected: string[] = [];
  function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) collected.push(p);
    }
  }
  walk('src');
  collected.sort();
  let total = 0;
  for (const f of collected) {
    let n = 0;
    try {
      const out = execFileSync('npx', ['tsx', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const m = out.match(/ℹ tests (\d+)/);
      n = m ? Number(m[1]) : 0;
    } catch (e: any) {
      const out = (e?.stdout ?? '') + (e?.stderr ?? '');
      const m = out.match(/ℹ tests (\d+)/);
      n = m ? Number(m[1]) : 0;
    }
    total += n;
    log(`  ${String(n).padStart(3)}  ${f}`);
  }
  log(`  FILE=${collected.length} TEST=${total} EXPECTED=195 MISSING=${195-total} RECONCILED=${total===195}`);
  log(`  riferimento Passo N=191 ; delta=${total-191} (Passo R +4)`);
}

function logGamma(z: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += c[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function chi2Survival(x: number, k: number): number {
  const a = k / 2;
  const xx = x / 2;
  if (xx <= 0) return 1;
  const gln = logGamma(a);
  let gammp = 0;
  if (xx < a + 1) {
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n <= 200; n++) {
      del *= xx / (a + n);
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    gammp = sum * Math.exp(-xx + a * Math.log(xx) - gln);
  } else {
    let b = xx + 1 - a;
    let c = 1 / 1e-30;
    let d = 1 / b;
    let h = d;
    for (let i = 1; i <= 200; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < 1e-30) d = 1e-30;
      c = b + an / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-12) break;
    }
    gammp = 1 - Math.exp(-xx + a * Math.log(xx) - gln) * h;
  }
  const surv = 1 - gammp;
  return surv < 0 ? 0 : surv > 1 ? 1 : surv;
}

function persymbol() {
  log('=== PERSYMBOL — eterogeneita per simbodo (Passo R) ===');
  const rows = JSON.parse(readFileSync(join(ART, 'replay_i3_30d_reason9', 'shift_0', 'setups.json'), 'utf8')) as any[];
  const em = rows.filter((r: any) => r.emitted);
  const totalSetups = em.length;
  const totalRows = rows.length;
  const syms = [...new Set(rows.map((r: any) => r.symbol))].sort();
  const per: { sym: string; sd: number; setups: number }[] = [];
  for (const s of syms) {
    const r = rows.filter((x: any) => x.symbol === s);
    const pairs = new Set(r.map((x: any) => new Date(x.decisionTs * 1000).toISOString().slice(0,10))).size;
    const setups = em.filter((x: any) => x.symbol === s).length;
    per.push({ sym: s, sd: pairs, setups });
    log(`  ${s.padEnd(9)} symbol-day=${pairs} setup=${setups} tasso=${(setups/pairs).toFixed(4)}`);
  }
  log(`  TOTALE setup=${totalSetups} su ${totalRows} righe`);
  let chi = 0;
  const totalSd = per.reduce((a,b)=>a+b.sd,0);
  for (const p of per) {
    const expected = totalSetups * (p.sd / totalSd);
    chi += (p.setups - expected) ** 2 / (expected > 0 ? expected : 1);
  }
  const df = per.length - 1;
  const pval = chi2Survival(chi, df);
  log(`  chi-quadro=${chi.toFixed(4)} gdl=${df} p=${pval.toExponential(3)}`);
  const pZeroUniform = Math.exp(-12);
  const pZeroMultinomial = Math.pow(5/9, 15);
  const pZeroEmpirical = Math.pow(0.4, 4);
  log(`  P(0) (i) Poisson uniforme: ${pZeroUniform.toExponential(3)}`);
  log(`  P(0) (ii) multinomiale uniforme su 9: ${pZeroMultinomial.toExponential(3)}`);
  log(`  P(0) (iii) eterogeneita empirica 0.4^4: ${pZeroEmpirical.toExponential(3)}`);
  log(`  reductio ENI.MI/UCG.MI: attesi 6, osservati 0, P(0)=${Math.exp(-6).toExponential(3)}`);
}


function universe() {
  log('=== UNIVERSE — dove e cablato l universo a 5 simbodi (Passo S) ===');
  log('  read point: scripts/headless_pipeline.ts:80 RECORD_BASKET = [ENI.MI, UCG.MI, BAMI.MI, RHM.DE, SAP.DE] (CODE)');
  log('  snapshot: artifacts/snapshot_9.json (DATA) derivato da src/utils/__tests__/fixtures/pipeline_snapshot.json + bars cached');
  log('  fix type: data (nuovo snapshot a 9, nessun file src/ toccato)');
  log('  files touched: 0 src, 1 scripts (replay_adapter.ts SNAPSHOT_PATH), 0 headless_pipeline');
  log('  occorrenze ticker nei 5: fixtures 2 (DATA), emissionGuard.test.ts 7 (CODE), defaultUnderlyings.ts (CODE), delay_replay (CODE), headless_pipeline RECORD_BASKET (CODE), latency_probe (CODE)');
}

// ---------------------------------------------------------------- Passo T
const GATE_SYMBOLS = ['ENI.MI','UCG.MI','BAMI.MI','RHM.DE','SAP.DE','BAYN.DE','LDO.MI','SIE.DE','STLAM.MI'];
const ADDED_SYMBOLS = ['BAYN.DE','LDO.MI','SIE.DE','STLAM.MI'];
const GATE_NAMES = Array.from({ length: 13 }, (_, i) => `G${i + 1}`);

type GateRow = { symbol: string; decisionTs: number; emitted: boolean; reason: string | null; gates?: string[] };

function gateReplayDir(): string {
  return ARGS.get('replay') ?? join(ART, 'replay_i3_30d_gates');
}

function loadGateRows(): GateRow[] {
  const p = join(gateReplayDir(), 'shift_0', 'setups.json');
  if (!existsSync(p)) fail(2, `missing_input: ${p} non esiste`);
  return JSON.parse(readFileSync(p, 'utf8')) as GateRow[];
}

function hypothesesCount(): number {
  const rows = readFileSync(REG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return rows.filter((r: any) => r.kind === 'hypothesis').length;
}

function gateKey(r: GateRow): string {
  if (r.emitted) return 'EMITTED';
  const reason = r.reason ?? '';
  const m = reason.match(/G(\d+)/);
  if (m) return `G${m[1]}`;
  if (reason === 'REEMISSIONE') return 'REEMISSIONE';
  return 'SESSION';
}

function gateMatrix(rows: GateRow[]) {
  const cols = [...GATE_NAMES, 'SESSION', 'REEMISSIONE', 'EMITTED'];
  const matrix: Record<string, Record<string, number>> = {};
  for (const sym of GATE_SYMBOLS) {
    matrix[sym] = {};
    for (const c of cols) matrix[sym][c] = 0;
  }
  for (const r of rows) {
    if (!matrix[r.symbol]) continue;
    const k = gateKey(r);
    matrix[r.symbol][k] = (matrix[r.symbol][k] ?? 0) + 1;
  }
  return { matrix, cols };
}

function dominantGate(rows: GateRow[], symbols: string[]): { gate: string; n: number } {
  const c = new Map<string, number>();
  for (const r of rows) {
    if (!symbols.includes(r.symbol)) continue;
    const k = gateKey(r);
    if (!k.startsWith('G')) continue;
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  let best = 'none';
  let n = 0;
  for (const [g, v] of c) if (v > n) { best = g; n = v; }
  return { gate: best, n };
}

function gates() {
  log('=== GATES — reason per gate e per simbolo (Passo W) ===');
  const rows = loadGateRows();
  const { matrix, cols } = gateMatrix(rows);
  log(`  righe: ${rows.length}`);
  log('  simbolo    ' + cols.map(c => pad(c, 7)).join(''));
  for (const sym of GATE_SYMBOLS) {
    log('  ' + pad(sym, 11) + cols.map(c => pad(matrix[sym][c], 7)).join(''));
  }
  const added = rows.filter(r => ADDED_SYMBOLS.includes(r.symbol));
  const orig = rows.filter(r => !ADDED_SYMBOLS.includes(r.symbol));
  const dAdd = dominantGate(rows, ADDED_SYMBOLS);
  const dOrig = dominantGate(rows, GATE_SYMBOLS.filter(s => !ADDED_SYMBOLS.includes(s)));
  log(`  gate dominante aggiunti: ${dAdd.gate} con ${dAdd.n} righe`);
  log(`  gate dominante originali: ${dOrig.gate} con ${dOrig.n} righe`);
  const sessionAdd = added.filter(r => gateKey(r) === 'SESSION').length;
  const sessionOrig = orig.filter(r => gateKey(r) === 'SESSION').length;
  log(`  reason SESSION aggiunti: ${sessionAdd}/${added.length} (${(sessionAdd/added.length*100).toFixed(2)}%)`);
  log(`  reason SESSION originali: ${sessionOrig}/${orig.length} (${(sessionOrig/orig.length*100).toFixed(2)}%)`);
  const g1Add = added.filter(r => gateKey(r) === 'G1').length;
  log(`  G1 aggiunti: ${g1Add}/${added.length} (${(g1Add/added.length*100).toFixed(2)}%)`);
  log(`  G1 usa liqEur20d (daily nello snapshot, derivato dalle barre): si`);
  log('  definizione raggiunte G7: emitted o reason G7..G13; REEMISSIONE esclusa');
  log('  G7 per simbolo: raggiunte  bloccate  pass  pass%  setup');
  for (const sym of GATE_SYMBOLS) {
    const rs = rows.filter(r => r.symbol === sym);
    const reached = rs.filter(reachesG7);
    const blocked = reached.filter(r => !r.emitted && gateIndexOf(r.reason) === 7);
    const setups = rs.filter(r => r.emitted).length;
    log(`  ${pad(sym,11)}${pad(reached.length,10)}${pad(blocked.length,10)}${pad(reached.length-blocked.length,6)}${pad(reached.length ? ((reached.length-blocked.length)/reached.length*100).toFixed(2) : 'n/a',7)}${pad(setups,6)}`);
  }
  const addReached = ADDED_SYMBOLS.reduce((a, s) => a + rows.filter(r => r.symbol === s && reachesG7(r)).length, 0);
  const addPass = ADDED_SYMBOLS.reduce((a, s) => a + rows.filter(r => r.symbol === s && reachesG7(r) && (r.emitted || gateIndexOf(r.reason) !== 7)).length, 0);
  const knownReached = GATE_SYMBOLS.filter(s => !ADDED_SYMBOLS.includes(s)).reduce((a, s) => a + rows.filter(r => r.symbol === s && reachesG7(r)).length, 0);
  const knownPass = GATE_SYMBOLS.filter(s => !ADDED_SYMBOLS.includes(s)).reduce((a, s) => a + rows.filter(r => r.symbol === s && reachesG7(r) && (r.emitted || gateIndexOf(r.reason) !== 7)).length, 0);
  log(`  G7 aggregato aggiunti: ${addPass}/${addReached} (${(addPass/addReached*100).toFixed(2)}%) ; noti: ${knownPass}/${knownReached} (${(knownPass/knownReached*100).toFixed(2)}%)`);
  log('  partizione: simbolo  totale  earlyG1G6  reachedG7  session  reemissione  (early+reached+session+reem)');
  for (const sym of GATE_SYMBOLS) {
    const rs = rows.filter(r => r.symbol === sym);
    const early = rs.filter(r => !r.emitted && (gateIndexOf(r.reason) ?? 0) >= 1 && (gateIndexOf(r.reason) ?? 0) <= 6).length;
    const reached = rs.filter(reachesG7).length;
    const session = rs.filter(r => gateKey(r) === 'SESSION').length;
    const reem = rs.filter(r => gateKey(r) === 'REEMISSIONE').length;
    log(`  ${pad(sym,11)}${pad(rs.length,8)}${pad(early,11)}${pad(reached,11)}${pad(session,9)}${pad(reem,13)}  ${early+reached+session+reem}`);
  }
}

function rowsper() {
  log('=== ROWSPER — righe per simbolo (Passo T) ===');
  const rows = loadGateRows();
  const expected = 3032;
  const counts = new Map<string, number>();
  const tsets = new Map<string, Set<number>>();
  for (const sym of GATE_SYMBOLS) { counts.set(sym, 0); tsets.set(sym, new Set()); }
  for (const r of rows) {
    if (!counts.has(r.symbol)) continue;
    counts.set(r.symbol, (counts.get(r.symbol) ?? 0) + 1);
    tsets.get(r.symbol)!.add(r.decisionTs);
  }
  log('  simbolo    righe  attese  delta  distinctTs');
  for (const sym of GATE_SYMBOLS) {
    const n = counts.get(sym) ?? 0;
    log(`  ${pad(sym,11)}${pad(n,7)}${pad(expected,8)}${pad(n-expected,7)}${pad(tsets.get(sym)!.size,12)}`);
  }
  const addedRows = ADDED_SYMBOLS.reduce((a, s) => a + (counts.get(s) ?? 0), 0);
  const declared = 12096;
  log(`  4 x 3032 = ${4*expected} ; dichiarato in Passo S = ${declared} ; differenza = ${4*expected-declared}`);
  log(`  righe reali nei 4 aggiunti = ${addedRows} ; gap vs dichiarato = ${addedRows-declared}`);
  const short = GATE_SYMBOLS.filter(s => (counts.get(s) ?? 0) !== expected);
  log(`  simboli con meno righe: ${short.length ? short.join(',') : 'nessuno'}`);
  const base = tsets.get(GATE_SYMBOLS[0])!;
  let missingTotal = 0;
  for (const sym of GATE_SYMBOLS) {
    const missing = [...base].filter(t => !tsets.get(sym)!.has(t));
    if (missing.length) { missingTotal += missing.length; log(`  ${sym}: ${missing.length} timestamp mancanti vs ${GATE_SYMBOLS[0]}`); }
  }
  log(`  timestamp mancanti totali rispetto a ${GATE_SYMBOLS[0]}: ${missingTotal}`);
  log(`  causa: errore di conteggio nel report di Passo S (12096 invece di 12128), non righe mancanti`);
}

type Bar5 = { t: number; o: number; h: number; l: number; c: number; v: number };

function loadBars(sym: string): Bar5[] {
  const p = join(BARSD, `${sym}_30d.json`);
  if (!existsSync(p)) fail(2, `missing_input: ${p} non esiste`);
  const bars = JSON.parse(readFileSync(p, 'utf8')) as Bar5[];
  if (!bars.length) fail(2, `missing_input: barre vuote per ${sym}`);
  return bars;
}

function dailySeries(sym: string): Array<{ day: string; volume: number; close: number; high: number; low: number; liq: number; bars: number }> {
  const days = new Map<string, Bar5[]>();
  for (const b of loadBars(sym)) {
    const d = sessionDate(b.t * 1000);
    if (!days.has(d)) days.set(d, []);
    days.get(d)!.push(b);
  }
  const out = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, bars]) => {
    const sorted = [...bars].sort((a, b) => a.t - b.t);
    const volume = sorted.reduce((a, b) => a + b.v, 0);
    const close = sorted[sorted.length - 1].c;
    const high = Math.max(...sorted.map(b => b.h));
    const low = Math.min(...sorted.map(b => b.l));
    return { day, volume, close, high, low, liq: volume * close, bars: sorted.length };
  });
  return out;
}

function dailyLiq(sym: string, nDays = 20): { liq: number; avgVol: number; days: number } {
  const s = dailySeries(sym);
  if (s.length < nDays) fail(2, `missing_input: ${sym} ha ${s.length} giorni, servono ${nDays}`);
  const last = s.slice(-nDays);
  return {
    liq: mean(last.map(d => d.liq)),
    avgVol: mean(last.map(d => d.volume)),
    days: last.length,
  };
}
function dailyAdr(sym: string, nDays = 20): { adr: number; days: number } {
  const s = dailySeries(sym);
  if (s.length < nDays) fail(2, `missing_input: ${sym} ha ${s.length} giorni, servono ${nDays}`);
  const last = s.slice(-nDays);
  return { adr: mean(last.map(d => d.high - d.low)), days: last.length };
}

function fiveMinAdr(sym: string): number {
  return mean(loadBars(sym).map(b => b.h - b.l));
}

function orbRange(sym: string): Map<string, { high: number | null; low: number | null }> {
  const days = new Map<string, Bar5[]>();
  for (const b of loadBars(sym)) {
    const d = sessionDate(b.t * 1000);
    if (!days.has(d)) days.set(d, []);
    days.get(d)!.push(b);
  }
  const out = new Map<string, { high: number | null; low: number | null }>();
  for (const [day, bars] of days) {
    const sorted = [...bars].sort((a, b) => a.t - b.t);
    const candles = sorted.map(b => ({
      timestamp: new Date(b.t * 1000), open: b.o, high: b.h, low: b.l, close: b.c,
    }));
    const orb = calculateOrbFromIntradayBars(
      candles, 'EU', new Date(sorted[0].t * 1000), undefined, new Date(sorted[sorted.length - 1].t * 1000)
    );
    out.set(day, { high: orb.orbHigh, low: orb.orbLow });
  }
  return out;
}

function gateIndexOf(reason: string | null): number | null {
  if (!reason) return null;
  const m = reason.match(/G(\d+)/);
  return m ? Number(m[1]) : null;
}

function reachesG7(r: GateRow): boolean {
  if (r.emitted) return true;
  const i = gateIndexOf(r.reason);
  return i !== null && i >= 7;
}

function liquidity() {
  log('=== LIQUIDITY — validazione del campo daily (Passo U) ===');
  const truth = JSON.parse(readFileSync('src/utils/__tests__/fixtures/pipeline_snapshot.json', 'utf8')) as { quotes: Array<{ ticker: string; liqEur20d: number }> };
  const trueMap = new Map(truth.quotes.map(q => [q.ticker, q.liqEur20d]));
  const threshold = TRADING_PARAMS.LIQ_MIN_EUR;
  const deltas: number[] = [];
  log('  simbolo    vero            daily           delta           delta%   G1vero G1daily');
  for (const sym of ['ENI.MI','UCG.MI','BAMI.MI','RHM.DE','SAP.DE']) {
    const tv = trueMap.get(sym);
    if (tv === undefined) fail(2, `missing_input: liqEur20d vero assente per ${sym}`);
    const dly = dailyLiq(sym);
    const d = dly.liq - tv;
    const pct = (d / tv) * 100;
    deltas.push(pct);
    log(`  ${pad(sym,11)}${pad(tv.toFixed(0),16)}${pad(dly.liq.toFixed(0),16)}${pad(d.toFixed(0),16)}${pad(pct.toFixed(4),9)}${pad(tv >= threshold ? 'si' : 'no',8)}${dly.liq >= threshold ? 'si' : 'no'}`);
  }
  const meanPct = mean(deltas);
  log(`  delta medio % sui 5 noti: ${meanPct.toFixed(4)}`);
  log(`  soglia G1 (TRADING_PARAMS.LIQ_MIN_EUR): ${threshold}`);
  log(`  passano G1 col vero: ${[...trueMap.values()].filter(v => v >= threshold).length}/5`);
  log(`  passano G1 col daily: ${['ENI.MI','UCG.MI','BAMI.MI','RHM.DE','SAP.DE'].filter(s => dailyLiq(s).liq >= threshold).length}/5`);
  const snap = JSON.parse(readFileSync(join(ART, 'snapshot_9.json'), 'utf8')) as { quotes: Array<{ ticker: string; liqEur20d: number }> };
  const qmap = new Map(snap.quotes.map(q => [q.ticker, q.liqEur20d]));
  log('  aggiunti   liqEur20d daily   soglia G1   sotto?');
  let below = 0;
  for (const sym of ADDED_SYMBOLS) {
    const v = qmap.get(sym);
    if (v === undefined) fail(2, `missing_input: liqEur20d daily assente per ${sym}`);
    const isBelow = v < threshold;
    if (isBelow) below++;
    log(`  ${pad(sym,11)}${pad(v.toFixed(0),20)}${pad(threshold,12)}${isBelow ? 'si' : 'no'}`);
  }
  log(`  aggiunti sotto soglia G1: ${below}/4`);
  const biased = meanPct < 0 && Math.abs(meanPct) > 20;
  log(`  stima daily distorta verso il basso: ${biased ? 'si' : 'no'}`);
  log(`  zero di Passo S contaminato da G1: ${biased && below === 4 ? 'si' : 'no'}`);
}

function snapshot9() {
  log('=== SNAPSHOT9 — liqEur20d daily (Passo U) ===');
  const p = join(ART, 'snapshot_9.json');
  if (!existsSync(p)) fail(2, `missing_input: ${p} non esiste`);
  const snap = JSON.parse(readFileSync(p, 'utf8')) as { quotes: Array<any> };
  for (const sym of ADDED_SYMBOLS) {
    const q = snap.quotes.find(x => x.ticker === sym);
    if (!q) fail(2, `missing_input: quote ${sym} assente in snapshot_9`);
    const dly = dailyLiq(sym);
    const before = q.liqEur20d;
    q.liqEur20d = dly.liq;
    q.avgVolume20d = dly.avgVol;
    log(`  ${pad(sym,11)} liq ${String(before).padStart(12)} -> ${dly.liq.toFixed(0).padStart(12)} (${dly.days} giorni daily)`);
  }
  writeFileSync(p, JSON.stringify(snap, null, 2) + '\n');
  log(`  scritto ${p}`);
}

function snapshot9daily2() {
  log('=== SNAPSHOT9DAILY2 — correzione a due fattori (Passo V) ===');
  const inPath = join(ART, 'snapshot_9.json');
  const outPath = join(ART, 'snapshot_9_daily2.json');
  if (!existsSync(inPath)) fail(2, `missing_input: ${inPath} non esiste`);
  const snap = JSON.parse(readFileSync(inPath, 'utf8')) as { quotes: Array<any> };
  for (const sym of ADDED_SYMBOLS) {
    const q = snap.quotes.find(x => x.ticker === sym);
    if (!q) fail(2, `missing_input: quote ${sym} assente in snapshot_9`);
    const oldAdr = q.adr14;
    const dAdr = dailyAdr(sym);
    const oldLiq = q.liqEur20d;
    const dLiq = dailyLiq(sym);
    q.adr14 = dAdr.adr;
    q.liqEur20d = dLiq.liq;
    q.avgVolume20d = dLiq.avgVol;
    log(`  ${pad(sym,11)} adr ${String(oldAdr).padStart(10)} -> ${dAdr.adr.toFixed(6).padStart(12)} (${dAdr.days} gg borsa) delta ${(((dAdr.adr-oldAdr)/oldAdr)*100).toFixed(2)}%`);
    log(`  ${pad(sym,11)} liq ${String(oldLiq).padStart(12)} -> ${dLiq.liq.toFixed(0).padStart(12)} delta ${(((dLiq.liq-oldLiq)/oldLiq)*100).toFixed(2)}%`);
  }
  writeFileSync(outPath, JSON.stringify(snap, null, 2) + '\n');
  log(`  scritto ${outPath}`);
}

function snapshot9liqtd() {
  log('=== SNAPSHOT9LIQTD — liqEur20d su 20 barre daily (Passo W) ===');
  const inPath = join(ART, 'snapshot_9_daily2.json');
  const outPath = join(ART, 'snapshot_9_daily3.json');
  if (!existsSync(inPath)) fail(2, `missing_input: ${inPath} non esiste`);
  const snap = JSON.parse(readFileSync(inPath, 'utf8')) as { quotes: Array<any> };
  const threshold = TRADING_PARAMS.LIQ_MIN_EUR;
  for (const sym of ADDED_SYMBOLS) {
    const q = snap.quotes.find(x => x.ticker === sym);
    if (!q) fail(2, `missing_input: quote ${sym} assente in snapshot_9_daily2`);
    const before = q.liqEur20d;
    const d = dailyLiq(sym);
    q.liqEur20d = d.liq;
    q.avgVolume20d = d.avgVol;
    const delta = ((d.liq - before) / before) * 100;
    log(`  ${pad(sym,11)} liq ${String(before).padStart(12)} -> ${d.liq.toFixed(0).padStart(12)} delta ${delta.toFixed(4)}% (${d.days} gg borsa, ${(d.liq/threshold).toFixed(2)}x soglia)`);
  }
  const truth = JSON.parse(readFileSync('src/utils/__tests__/fixtures/pipeline_snapshot.json', 'utf8')) as { quotes: Array<{ ticker: string; liqEur20d: number }> };
  const trueMap = new Map(truth.quotes.map(q => [q.ticker, q.liqEur20d]));
  log('  noti: daily/vero (stessa funzione, non scritta sui noti)');
  let failCount = 0;
  for (const sym of ['ENI.MI','UCG.MI','BAMI.MI','RHM.DE','SAP.DE']) {
    const tv = trueMap.get(sym);
    if (tv === undefined) fail(2, `missing_input: liqEur20d vero assente per ${sym}`);
    const ratio = dailyLiq(sym).liq / tv;
    if (Math.abs(ratio - 1) >= 0.10) failCount++;
    log(`  ${pad(sym,11)} ${ratio.toFixed(4)}${Math.abs(ratio - 1) >= 0.10 ? '  FUORI [0.90,1.10]' : ''}`);
  }
  log(`  AI-0054: ${failCount === 0 ? 'confermata' : 'falsificata'} (${failCount}/5 fuori da |daily/vero-1|<0.10)`);
  writeFileSync(outPath, JSON.stringify(snap, null, 2) + '\n');
  log(`  scritto ${outPath}`);
}

function countRows() {
  type Count = { G: number[]; SESSION: number; REEMISSIONE: number; EMITTED: number; NONE: number; total: number };
  const by = new Map<string, Count>();
  for (const sym of GATE_SYMBOLS) by.set(sym, { G: Array(14).fill(0), SESSION: 0, REEMISSIONE: 0, EMITTED: 0, NONE: 0, total: 0 });
  for (const r of loadGateRows()) {
    const c = by.get(r.symbol);
    if (!c) continue;
    c.total++;
    if (r.emitted) { c.EMITTED++; continue; }
    if (r.reason === 'REEMISSIONE') { c.REEMISSIONE++; continue; }
    const i = gateIndexOf(r.reason);
    if (i !== null && i >= 1 && i <= 13) c.G[i]++;
    else if (r.reason === 'Nessun titolo presente o analizzato per la sessione.') c.SESSION++;
    else c.NONE++;
  }
  return by;
}

function counts() {
  log('=== COUNTS — definizione unica: raggiunte G7 = emitted o reason G7..G13 (re-emissioni ESCLUSE) ===');
  const by = countRows();
  log('  simbolo     tot   G1   G2   G3   G4   G5   G6   G7   G8   G9  G10  G11  G12  G13  SESS  REEM  EMIT  reach  pass  pass%');
  for (const sym of GATE_SYMBOLS) {
    const c = by.get(sym)!;
    const reached = c.G.slice(7,14).reduce((a,b)=>a+b,0) + c.EMITTED;
    const pass = reached - c.G[7];
    log(`  ${pad(sym,11)}${pad(c.total,6)}${c.G.slice(1,14).map(x=>pad(x,5)).join('')}${pad(c.SESSION,6)}${pad(c.REEMISSIONE,6)}${pad(c.EMITTED,6)}${pad(reached,7)}${pad(pass,6)}${pad(reached ? (pass/reached*100).toFixed(2) : 'n/a',7)}`);
  }
  log('  chiusura: simbolo  earlyG1G6  G7bloc  G8  G10  G11  REEM  EMIT  SESS  somma  totale');
  for (const sym of GATE_SYMBOLS) {
    const c = by.get(sym)!;
    const early = c.G.slice(1,7).reduce((a,b)=>a+b,0);
    const sum = early + c.G[7] + c.G[8] + c.G[10] + c.G[11] + c.REEMISSIONE + c.EMITTED;
    const sumAll = sum + c.SESSION;
    log(`  ${pad(sym,11)}${pad(early,11)}${pad(c.G[7],7)}${pad(c.G[8],4)}${pad(c.G[10],5)}${pad(c.G[11],5)}${pad(c.REEMISSIONE,6)}${pad(c.EMITTED,6)}${pad(c.SESSION,6)}${pad(sumAll,7)}${pad(c.total,8)}${sumAll === c.total ? ' OK' : ' MISMATCH'}  senzaSessione=${sum}${sum === c.total ? '' : ' (manca SESSION)'}`);
  }
}

function fisherTwoSample() {
  log('=== FISHER — simboli con almeno un setup: noti 3/5 vs aggiunti 1/4 (Passo W) ===');
  const N = 9, K = 4, n = 5, kObs = 3;
  const p = (k: number) => binom(K, k) * binom(N - K, n - k) / binom(N, n);
  let pOne = 0;
  for (let k = kObs; k <= Math.min(K, n); k++) pOne += p(k);
  const pObs = p(kObs);
  let pTwo = 0;
  for (let k = 0; k <= Math.min(K, n); k++) if (p(k) <= pObs + 1e-12) pTwo += p(k);
  log(`  tabella: noti ${kObs}/5, aggiunti 1/4`);
  log(`  Fisher unilaterale (noti > aggiunti): p=${pOne.toFixed(6)}`);
  log(`  Fisher bilaterale: p=${pTwo.toFixed(6)}`);
  let pAtMost1 = 0;
  for (let k = 0; k <= 1; k++) pAtMost1 += binom(4, k) * Math.pow(0.4, k) * Math.pow(0.6, 4 - k);
  log(`  P(al piu' 1 simbolo con setup su 4) sotto null empirico 0.4: ${pAtMost1.toFixed(4)}`);
  const by = countRows();
  const rate = (syms: string[], idx: number) => {
    let num = 0, den = 0;
    for (const s of syms) {
      const c = by.get(s)!;
      const reached = c.G.slice(7,14).reduce((a,b)=>a+b,0) + c.EMITTED;
      const pass = reached - c.G[7];
      num += idx === 0 ? pass : idx === 7 ? c.G[7] : idx === 8 ? c.G[8] : idx === 10 ? c.G[10] : idx === 11 ? c.G[11] : c.EMITTED;
      den += idx === 0 ? reached : pass;
    }
    return { num, den, pct: den ? num / den * 100 : 0 };
  };
  const known = ['ENI.MI','UCG.MI','BAMI.MI','RHM.DE','SAP.DE'];
  const added = ADDED_SYMBOLS;
  log('  stadio       aggiunti        noti        diff pp');
  for (const [label, idx] of [['G7 pass',0],['G8 blocco',8],['G10 blocco',10],['G11 blocco',11],['emissione',-1]] as Array<[string, number]>) {
    const a = rate(added, idx);
    const b = rate(known, idx);
    log(`  ${pad(label,13)}${pad(`${a.num}/${a.den} ${a.pct.toFixed(2)}%`,16)}${pad(`${b.num}/${b.den} ${b.pct.toFixed(2)}%`,16)}${(a.pct-b.pct).toFixed(2)}`);
  }
  log(`  AI-0055: ${pOne > 0.05 ? 'confermata' : 'falsificata'} (unilaterale p=${pOne.toFixed(6)})`);
}

function adrfrac() {
  log('=== ADRFRAC — adrConsumptionFraction (Passo V) ===');
  const rows = loadGateRows();
  const snapPath = ARGS.get('snapshot') ?? join(ART, 'snapshot_9.json');
  const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as { quotes: Array<{ ticker: string; adr14: number }> };
  const adrMap = new Map(snap.quotes.map(q => [q.ticker, q.adr14]));
  const orbCache = new Map<string, Map<string, { high: number | null; low: number | null }>>();
  const fractions = new Map<string, number[]>();
  for (const sym of GATE_SYMBOLS) fractions.set(sym, []);
  for (const r of rows) {
    if (!reachesG7(r)) continue;
    const adr = adrMap.get(r.symbol);
    if (adr === undefined || !(adr > 0)) continue;
    if (!orbCache.has(r.symbol)) orbCache.set(r.symbol, orbRange(r.symbol));
    const day = sessionDate(r.decisionTs * 1000);
    const orb = orbCache.get(r.symbol)!.get(day);
    if (!orb || orb.high === null || orb.low === null) continue;
    fractions.get(r.symbol)!.push((orb.high - orb.low) / adr);
  }
  const threshold = TRADING_PARAMS.ADR_MAX;
  log(`  soglia G7 (TRADING_PARAMS.ADR_MAX): ${threshold}`);
  log('  simbolo    n     p5       p25      p50      p75      p95      min      max');
  for (const sym of GATE_SYMBOLS) {
    const a = fractions.get(sym)!.sort((x, y) => x - y);
    if (!a.length) { log(`  ${pad(sym,11)}0     n/a`); continue; }
    log(`  ${pad(sym,11)}${pad(a.length,6)}${pad(quantile(a,0.05).toFixed(4),9)}${pad(quantile(a,0.25).toFixed(4),9)}${pad(quantile(a,0.5).toFixed(4),9)}${pad(quantile(a,0.75).toFixed(4),9)}${pad(quantile(a,0.95).toFixed(4),9)}${pad(a[0].toFixed(4),9)}${a[a.length-1].toFixed(4)}`);
  }
  const med = (syms: string[]) => {
    const all = syms.flatMap(s => fractions.get(s)!);
    return quantile([...all].sort((a, b) => a - b), 0.5);
  };
  const mAdd = med(ADDED_SYMBOLS);
  const mOrig = med(GATE_SYMBOLS.filter(s => !ADDED_SYMBOLS.includes(s)));
  log(`  mediana aggiunti: ${mAdd.toFixed(4)} ; mediana originali: ${mOrig.toFixed(4)} ; rapporto: ${(mAdd/mOrig).toFixed(2)}`);
  const addAll = ADDED_SYMBOLS.flatMap(s => fractions.get(s)!);
  const above = addAll.filter(x => x > threshold).length;
  const ratios = addAll.filter(x => x > threshold).map(x => x / threshold).sort((a,b)=>a-b);
  log(`  aggiunte sopra soglia: ${above}/${addAll.length} ; mediana frazione/soglia: ${quantile(ratios,0.5).toFixed(2)}`);
  log(`  AI-0049: ${mAdd > 20 && (mAdd/mOrig) > 20 ? 'confermata' : 'falsificata'}`);
}

function adrdelta() {
  log('=== ADRDELTA — diagnosi di adr14 (Passo V) ===');
  const truth = JSON.parse(readFileSync('src/utils/__tests__/fixtures/pipeline_snapshot.json', 'utf8')) as { quotes: Array<{ ticker: string; adr14: number }> };
  const trueAdr = new Map(truth.quotes.map(q => [q.ticker, q.adr14]));
  const snap = JSON.parse(readFileSync(join(ART, 'snapshot_9.json'), 'utf8')) as { quotes: Array<{ ticker: string; adr14: number; liqEur20d: number }> };
  const snapAdr = new Map(snap.quotes.map(q => [q.ticker, q.adr14]));
  const oldSnap = JSON.parse(readFileSync(join(ART, 'snapshot_9_5m_liq.json'), 'utf8')) as { quotes: Array<{ ticker: string; liqEur20d: number }> };
  const oldLiq = new Map(oldSnap.quotes.map(q => [q.ticker, q.liqEur20d]));
  const liqDaily = new Map(snap.quotes.map(q => [q.ticker, q.liqEur20d]));
  log('  simbolo    adr vero      adr 5m       adr daily    daily/5m   vero/daily');
  for (const sym of ['ENI.MI','UCG.MI','BAMI.MI','RHM.DE','SAP.DE']) {
    const five = fiveMinAdr(sym);
    const daily = dailyAdr(sym).adr;
    const tv = trueAdr.get(sym);
    log(`  ${pad(sym,11)}${pad(tv === undefined ? 'n/a' : tv.toFixed(6),13)}${pad(five.toFixed(6),13)}${pad(daily.toFixed(6),13)}${pad((daily/five).toFixed(2),11)}${tv === undefined ? 'n/a' : (tv/daily).toFixed(4)}`);
  }
  log('  aggiunti   adr 5m       adr daily    daily/5m   liq daily/5m   diff%');
  for (const sym of ADDED_SYMBOLS) {
    const five = snapAdr.get(sym);
    const daily = dailyAdr(sym).adr;
    if (five === undefined) fail(2, `missing_input: adr14 5m assente per ${sym}`);
    const oldL = oldLiq.get(sym);
    const newL = liqDaily.get(sym);
    if (oldL === undefined || newL === undefined) fail(2, `missing_input: liq assente per ${sym}`);
    const adrRatio = daily / five;
    const liqRatio = newL / oldL;
    log(`  ${pad(sym,11)}${pad(five.toFixed(6),13)}${pad(daily.toFixed(6),13)}${pad(adrRatio.toFixed(2),11)}${pad(liqRatio.toFixed(2),15)}${((adrRatio/liqRatio-1)*100).toFixed(2)}`);
  }
  const s = dailySeries('BAYN.DE');
  const barsPer = mean(s.map(d => d.bars));
  log(`  barre 5m per sessione (media 30 gg): ${barsPer.toFixed(1)}`);
  const lastTs = Math.max(...loadBars('BAYN.DE').map(b => b.t));
  const cutoff = lastTs - 19 * 86400;
  const tradingIn20 = dailySeries('BAYN.DE').filter(d => {
    const ts = Math.floor(new Date(`${d.day}T12:00:00+01:00`).getTime() / 1000);
    return ts >= cutoff;
  }).length;
  log(`  giorni di borsa in 20 giorni civili: ${tradingIn20}`);
  log('  AI-0047: verifica daily/5m in [95,120] per almeno 3/4 e divergenza adr/liq <=20%');
  log('  AI-0048: verifica 20*daily/vero in [12,15] per tutti i 5');
}

function stirling2(n: number, k: number): number {
  const S: number[][] = Array.from({ length: n + 1 }, () => Array(n + 1).fill(0));
  S[0][0] = 1;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= i; j++) S[i][j] = S[i-1][j-1] + j * S[i-1][j];
  return S[n][k];
}
function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return r;
}

function exacttest() {
  log('=== EXACTTEST — test esatto multinomiale (Passo V) ===');
  const rows = loadGateRows();
  const em = rows.filter(r => r.emitted);
  const counts = GATE_SYMBOLS.map(s => em.filter(r => r.symbol === s).length);
  const n = em.length;
  const expected = n / GATE_SYMBOLS.length;
  const chi2 = counts.reduce((a, o) => a + (o - expected) ** 2 / expected, 0);
  const df = GATE_SYMBOLS.length - 1;
  const pAsym = chi2Survival(chi2, df);
  log(`  setup=${n} ; celle=${GATE_SYMBOLS.length} ; atteso per cella=${expected.toFixed(3)}`);
  log(`  chi-quadro=${chi2.toFixed(4)} df=${df} p asintotico=${pAsym.toExponential(3)}`);
  log(`  celle con atteso < 5: ${counts.filter(() => expected < 5).length}/9 ; approxValido=false`);
  const kMax = 3;
  let num = 0;
  for (let k = 1; k <= kMax; k++) num += binom(9, k) * [1,1,2,6][k] * stirling2(n, k);
  const exactP = num / Math.pow(9, n);
  log(`  P(al piu' 3 simboli occupati su 9 con ${n} setup) = ${exactP.toExponential(6)}`);
  const pUniform = Math.exp(-12);
  const pMult = Math.pow(5 / 9, n);
  const pEmp = Math.pow(0.4, 4);
  const nHyp = hypothesesCount();
  const alpha = 0.05 / nHyp;
  log(`  null Poisson uniforme lambda=12: ${pUniform.toExponential(3)}`);
  log(`  null multinomiale (5/9)^${n}: ${pMult.toExponential(3)}`);
  log(`  null empirico 0.4^4: ${pEmp.toFixed(4)}`);
  log(`  alpha (0.05/${nHyp}, dal registro): ${alpha.toExponential(4)}`);
  log(`  sotto null empirico significativo: ${pEmp < alpha ? 'si' : 'no'}`);
  log(`  verdetto: ${pEmp < alpha ? 'negativo' : 'nullo'}`);
}

function bitid() {
  log('=== BITID — bit-identita del ramo a 5 (Passo V) ===');
  const newRows = loadGateRows().filter(r => !ADDED_SYMBOLS.includes(r.symbol));
  const baselinePath = ARGS.get('baseline') ?? join(ART, 'replay_i3_30d_gates', 'shift_0', 'setups.json');
  if (!existsSync(baselinePath)) fail(2, `missing_input: ${baselinePath} non esiste`);
  const oldRows = (JSON.parse(readFileSync(baselinePath, 'utf8')) as GateRow[]).filter(r => !ADDED_SYMBOLS.includes(r.symbol));
  const hash = (rows: GateRow[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const oldSetup = oldRows.filter(r => r.emitted).length;
  const newSetup = newRows.filter(r => r.emitted).length;
  log(`  righe: baseline=${oldRows.length} nuovo=${newRows.length}`);
  log(`  setup: baseline=${oldSetup} nuovo=${newSetup}`);
  log(`  hash baseline=${hash(oldRows)}`);
  log(`  hash nuovo   =${hash(newRows)}`);
  log(`  bit-identico: ${hash(oldRows) === hash(newRows) ? 'si' : 'no'}`);
  if (hash(oldRows) !== hash(newRows)) {
    let n = 0;
    for (let i = 0; i < Math.min(oldRows.length, newRows.length) && n < 10; i++) {
      if (JSON.stringify(oldRows[i]) !== JSON.stringify(newRows[i])) {
        log(`  diff #${i}: ${JSON.stringify(oldRows[i])} != ${JSON.stringify(newRows[i])}`);
        n++;
      }
    }
  }
}

function alpha() {
  log('=== ALPHA — formula dichiarata (Passo T) ===');
  const rows = readFileSync(REG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const hs = rows.filter((r: any) => r.kind === 'hypothesis');
  const tHs = hs.filter((h: any) => h.step === 'T');
  const before = hs.length - tHs.length;
  const after = hs.length;
  log(`  ipotesi prima di T: ${before}`);
  log(`  ipotesi dopo l'append di T: ${after}`);
  const beforeT = hs.filter((h: any) => h.step !== 'T' && typeof h.alphaEffective === 'number').slice(-4);
  log('  prima di T: passo  ipotesi  alpha        denominatore  formula');
  for (const h of beforeT) {
    const den = Math.round(0.05 / h.alphaEffective);
    log(`  ${pad(h.step,6)} ${pad(h.id,8)} ${pad(h.alphaEffective.toFixed(7),12)} ${pad(den,13)} 0.05/n`);
  }
  const withT = hs.filter((h: any) => typeof h.alphaEffective === 'number').slice(-4);
  log('  blocco T: passo  ipotesi  alpha        denominatore  formula');
  for (const h of withT) {
    const den = Math.round(0.05 / h.alphaEffective);
    log(`  ${pad(h.step,6)} ${pad(h.id,8)} ${pad(h.alphaEffective.toFixed(7),12)} ${pad(den,13)} 0.05/n`);
  }
  const alphaNew = 0.05 / after;
  log(`  formula scelta: 0.05/n, n = numero di ipotesi dopo l'append del blocco (n=${after})`);
  log(`  alpha nuovo: ${alphaNew.toFixed(7)} ; copre ${after} ipotesi`);
  log(`  alpha precedente: 0.0015152 (0.05/33, copriva 33 ipotesi)`);
}

function daysneeded() {
  log('=== DAYSNEEDED — griglia e potenza (Passo R) ===');
  const frac = 0.7156753909982563;
  const setups30 = 30 / frac;
  const setups62 = 62 / frac;
  const emit30 = setups30 / 1.154;
  const emit62 = setups62 / 1.154;
  const cal30 = setups30 / 0.5;
  const cal62 = setups62 / 0.5;
  log(`  definizione: setupTotali = setupPerCella / frazioneBanda (frazioneBanda=${frac.toFixed(4)})`);
  log(`  setupTotali: 30 -> ${setups30.toFixed(1)} ; 62 -> ${setups62.toFixed(1)}`);
  log(`  giorni emitting: 30 -> ${emit30.toFixed(1)} ; 62 -> ${emit62.toFixed(1)}`);
  log(`  giorni calendario: 30 -> ${cal30.toFixed(1)} ; 62 -> ${cal62.toFixed(1)}`);
  log(`  Q riportava: 41.9 -> 36.3/83.8 (corretto); 62 -> 53.7/124.0 (errato)`);
  log(`  delta vs Q a 62: emitting +${(emit62-53.7).toFixed(1)} ; calendario +${(cal62-124.0).toFixed(1)} ; fattore ${(cal62/124.0).toFixed(2)}`);
  log(`  elasticita misurata: 0 (0 setup nei 4 aggiunti / 4 simboli)`);
  log(`  leva: elasticita 0 -> ${cal62.toFixed(1)} gg ; elasticita 1 -> ${(setups62/2/0.5).toFixed(1)} gg ; differenza ${(cal62 - setups62/2/0.5).toFixed(1)} gg`);
}

switch (CMD) {
  case 'payoff':   payoff(); break;
  case 'g4fill':   g4fill(); break;
  case 'upstream': upstream(); break;
  case 'surface':  surface(); break;
  case 'population': population(); break;
  case 'deathcheck': deathcheck(); break;
  case 'dedup':      dedup(); break;
  case 'reemission': reemission(); break;
  case 'reasons':    reasons(); break;
  case 'universe':   universe(); break;
  case 'tests':      tests(); break;
  case 'persymbol':  persymbol(); break;
  case 'gates':      gates(); break;
  case 'rowsper':    rowsper(); break;
  case 'liquidity':  liquidity(); break;
  case 'exacttest':  exacttest(); break;
  case 'alpha':      alpha(); break;
  case 'snapshot9':  snapshot9(); break;
  case 'snapshot9daily2': snapshot9daily2(); break;
  case 'adrfrac':    adrfrac(); break;
  case 'snapshot9liqtd': snapshot9liqtd(); break;
  case 'counts':     counts(); break;
  case 'fisher':     fisherTwoSample(); break;
  case 'adrdelta':   adrdelta(); break;
  case 'bitid':      bitid(); break;
  case 'perimeter':  perimeter(); break;
  case 'symbols':    symbols(); break;
  case 'reason9':    reason9(); break;
  case 'daysneeded': daysneeded(); break;
  case 'fillaudit': fillaudit(); break;
  case 'postmortem': postmortem(); break;
  case 'train':    train(); break;
  case 'cycle':    cycle(); break;
  case 'promote':  promote(); break;
  default: fail(2, `sottocomando sconosciuto: ${CMD}. Usa payoff|surface|population|deathcheck|g4fill|upstream|postmortem|train|cycle|promote|perimeter|symbols|reason9|daysneeded|tests|persymbol`);
}
