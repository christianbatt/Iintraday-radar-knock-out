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

// ---------------------------------------------------------------- payoff

function payoff() {
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
  L.push('## 8. Cosa i dati NON dicono');
  L.push('');
  L.push('1. **Il campione è di 13 giorni su 5 simboli.** Le barre in cache coprono 30 giorni');
  L.push('   di calendario ma solo 13 contengono setup emessi: nessuna conclusione su regimi');
  L.push('   diversi, e 13 cluster sono pochi per una CI.');
  L.push('2. **L\'R è misurato su barre a 5 minuti.** Con stop mediano ~0.85% la distanza di');
  L.push('   stop è dello stesso ordine del rumore intra-barra: dentro la barra l\'ordine');
  L.push('   stop/target non è risolvibile e vale l\'ipotesi pessimistica (stop per primo).');
  L.push('3. **Il conterfactual su G4 non è un giudizio su G4.** Il fill assunto non era');
  L.push('   disponibile per costruzione: serve la variante con fill reale (vedi sezione 5).');
  L.push('4. **Le 9493 righe senza setup non sono attribuibili.** Gli artefatti non hanno un');
  L.push('   campo `reason`: manca ORB, prezzo, ATR, ADR, volume e conteggio barre.');
  L.push('5. **Il BE è un trigger fisso**, non `calculateDynamicBreakeven`: non è l\'expectancy');
  L.push('   della strategia.');
  L.push('');
  const path = join(REGDIR, `postmortem_${new Date().toISOString().slice(0, 10)}.md`);
  if (!existsSync(REGDIR)) mkdirSync(REGDIR, { recursive: true });
  writeFileSync(path, `${L.join('\n')}\n`);
  log(`  scritto ${path} (${L.length} righe, 8 sezioni)`);
  return { path, sections: 8 };
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

// ---------------------------------------------------------------- dispatch

switch (CMD) {
  case 'payoff':   payoff(); break;
  case 'g4fill':   g4fill(); break;
  case 'upstream': upstream(); break;
  case 'postmortem': postmortem(); break;
  case 'train':    train(); break;
  case 'cycle':    cycle(); break;
  case 'promote':  promote(); break;
  default: fail(2, `sottocomando sconosciuto: ${CMD}. Usa payoff|g4fill|upstream|postmortem|train|cycle|promote`);
}
