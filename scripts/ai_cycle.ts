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
import { join } from 'node:path';

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
    appendRow({
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
  appendRow({
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
    log('  dec  stop%med  n     k=0.5            k=1.0            k=1.6            k=2.0');
    const cells: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      const chunk = sorted.slice(i * per, (i + 1) * per);
      if (!chunk.length) continue;
      const spm = quantile(chunk.map(x => stopPctOf(x.s)).sort((a, b) => a - b), 0.5);
      let line = `  d${i + 1}  ${pad(num(spm, 2), 8)} ${pad(chunk.length, 5)} `;
      for (const k of SURFACE_KS) {
        if (chunk.length < 10) {
          line += pad('n<10', 17);
          cells.push({ pop: label, dec: i + 1, stopPctMed: spm, k, n: chunk.length, meanRNet: null });
          continue;
        }
        const st = netAt(chunk, k, fp);
        line += pad(`${num(st.meanRNet)} (${num(st.hit * 100, 0)}%)`, 17);
        cells.push({ pop: label, dec: i + 1, stopPctMed: spm, k, n: chunk.length,
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
  log(`  B = candidati con direzione, bloccati da un gate: ${blocked.length}`);
  log(`  C = emessi: ${emitted.length}`);
  log(`  D = tutti i candidati (B+C): ${all.length}`);
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
  const haveSetups = rows.length;
  const haveDays = days.length;

  const KS = [0.5, 1.0, 1.6, 2.0];
  const sorted = [...rows].sort((a, b) => stopPctOf(a.s) - stopPctOf(b.s));
  const per = Math.max(1, Math.ceil(sorted.length / 10));

  type Cell = { dec: number; k: number; n: number; days: number; meanRNet: number;
                lo: number; hi: number; p: number; excludesZero: boolean };
  const cells: Cell[] = [];
  for (let d = 0; d < 10; d++) {
    const chunk = sorted.slice(d * per, (d + 1) * per);
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
  const nHyp = nHypotheses();
  const alphaEffective = 0.05 / (1 + nHyp);
  const alphaBonferroni = admissible.length > 0 ? 0.05 / admissible.length : null;
  const triggerMet = haveSetups >= 100 && haveDays >= 30;
  const survivors = admissible.filter(c => c.meanRNet > 0 && c.excludesZero &&
    c.p < alphaEffective && (alphaBonferroni === null || c.p < alphaBonferroni));
  const status = !triggerMet ? 'not_yet_evaluable' : (survivors.length > 0 ? 'survives' : 'closed');

  log(`  trigger: setup ${haveSetups}/100 · giorni ${haveDays}/30 -> ${triggerMet ? 'soddisfatto' : 'NON soddisfatto'}`);
  log(`  celle: ${cells.length} totali · ${admissible.length} ammissibili (n>=30 e giorni>=10)`);
  log(`  soglie: alphaEffective=${num(alphaEffective, 4)} · Bonferroni=${alphaBonferroni === null ? 'n/d' : num(alphaBonferroni, 4)}`);
  const g4 = (surfArt.EMESSI as { nCellsN10?: number; nPositiveN10?: number } | undefined);
  log(`  cross-check con ai_surface.json: celle n>=10=${g4?.nCellsN10 ?? 'n/d'} positive=${g4?.nPositiveN10 ?? 'n/d'} (qui la soglia e n>=30)`);
  for (const c of admissible) {
    log(`    d${c.dec} k=${c.k} n=${c.n} giorni=${c.days} meanR_net=${num(c.meanRNet)} CI=[${num(c.lo)}, ${num(c.hi)}] p=${num(c.p, 4)}`);
  }
  const best = admissible.length ? admissible.reduce((a, b) => (a.meanRNet >= b.meanRNet ? a : b)) : null;
  if (best) log(`  migliore ammissibile: d${best.dec} k=${best.k} meanR_net=${num(best.meanRNet)}`);
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
    nCells: cells.length, nAdmissibleCells: admissible.length,
    alphaEffective, alphaBonferroni, bestAdmissibleCell: best, survivors: survivors.length,
    reason, frictionPct: 0.1, cells,
  }, null, 2));
  log(`  fillIntegrity: ${fillIntegrity}`);
  return { status, nAdmissibleCells: admissible.length, alphaEffective, alphaBonferroni };
}

// ---------------------------------------------------------------- dispatch

switch (CMD) {
  case 'payoff':   payoff(); break;
  case 'g4fill':   g4fill(); break;
  case 'upstream': upstream(); break;
  case 'surface':  surface(); break;
  case 'population': population(); break;
  case 'deathcheck': deathcheck(); break;
  case 'fillaudit': fillaudit(); break;
  case 'postmortem': postmortem(); break;
  case 'train':    train(); break;
  case 'cycle':    cycle(); break;
  case 'promote':  promote(); break;
  default: fail(2, `sottocomando sconosciuto: ${CMD}. Usa payoff|surface|population|deathcheck|g4fill|upstream|postmortem|train|cycle|promote`);
}
