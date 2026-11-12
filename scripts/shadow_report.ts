/**
 * shadow_report.ts — artefatto di sola lettura per il pannello Shadow.
 *
 * PRINCIPIO: questo script NON calcola un edge, non addestra, non applica.
 * Esegue le 11 regole di src/knowledge/shadowAlgorithms.ts sui dati disponibili
 * e registra per ognuna lo stato (computed / insufficient_sample / missing_input /
 * not_invocable). Un input mancante produce `missing_input`, mai un default.
 *
 * Uso: bun scripts/shadow_report.ts
 * Exit: 0 artefatto scritto (anche con regole in missing_input)
 *       3 cache barre mancante · 7 schema non producibile
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  amihudIlliquidity,
  approximateVolumeBars,
  corwinSchultzSpreadProxy,
  cusumEventIndices,
  deflatedSharpeRatio,
  expectancyBootstrap,
  fractionalKelly,
  isHighProbabilityWindow,
  normalCdf,
  purgedKFold,
  sampleUniquenessWeights,
  tripleBarrierLabels,
  TRIPLE_BARRIER_LOWER_HYPOTHESIS,
  TRIPLE_BARRIER_UPPER_HYPOTHESIS,
  TRIPLE_BARRIER_VERTICAL_BARS_HYPOTHESIS,
} from '../src/knowledge/shadowAlgorithms';

const ART = 'artifacts';
const REPLAY = join(ART, 'replay_i3_30d');
const BARSD = join(ART, 'bars');
const REG = join('registry', 'ai_registry.jsonl');
const PARAMETRIC_PCT = 0.1; // banda di frizione usata nei passi I/J (percentuale del prezzo)
const GRID = [0.5, 1.0, 1.6, 2.0];
const GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13'];

function fail(code: number, msg: string): never {
  console.error(`\n[STOP exit ${code}] ${msg}\n`);
  process.exit(code);
}

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
type Setup = { sym: string; ts: number; dir: 1 | -1; entry: number; stop: number; target: number; date: string; gates: string[]; emitted: boolean };

const DTF = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' });
const sessionDate = (ms: number) => DTF.format(new Date(ms));

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

function loadRegistry(): Array<Record<string, unknown>> {
  if (!existsSync(REG)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(REG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* riga illeggibile */ }
  }
  return out;
}

function loadBars(): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  if (!existsSync(BARSD)) return out;
  for (const f of readdirSync(BARSD).sort()) {
    if (!f.endsWith('.json')) continue;
    const sym = f.slice(0, f.lastIndexOf('_'));
    if (out.has(sym)) continue; // primo file per simbolo (ordinamento stabile)
    const raw = readJson<Array<Record<string, unknown>>>(join(BARSD, f));
    if (!Array.isArray(raw)) continue;
    const b: Bar[] = [];
    for (const x of raw) {
      const t = Number(x.t), c = Number(x.c);
      if (Number.isFinite(t) && Number.isFinite(c)) {
        b.push({ t, o: Number(x.o), h: Number(x.h), l: Number(x.l), c, v: Number(x.v) });
      }
    }
    if (b.length) out.set(sym, b.sort((p, q) => p.t - q.t));
  }
  return out;
}

function loadSetups(): Array<Record<string, unknown>> {
  const p = join(REPLAY, 'shift_0', 'setups.json');
  if (!existsSync(p)) fail(3, `manca la cache del replay: ${p}`);
  const raw = readJson<unknown>(p);
  if (!Array.isArray(raw)) fail(7, `schema inatteso in ${p}`);
  return raw as Array<Record<string, unknown>>;
}

function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(a: number[]): number { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }
function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

/** Camminata identica a `ai_cycle.ts payoff`: t > decisionTs, first touch, stop per primo. */
function walkR(s: Setup, b: Bar[], k: number): number | null {
  const risk = Math.abs(s.entry - s.stop);
  if (!(risk > 0)) return null;
  let start = -1;
  for (let i = 0; i < b.length; i++) if (b[i].t > s.ts) { start = i; break; }
  if (start < 0) return null;
  const target = s.dir > 0 ? s.entry + k * risk : s.entry - k * risk;
  for (let i = start; i < b.length; i++) {
    const x = b[i];
    const barMae = s.dir > 0 ? (x.l - s.entry) / risk : (s.entry - x.h) / risk;
    if (barMae <= -1) return -1;
    const hit = s.dir > 0 ? x.h >= target : x.l <= target;
    if (hit) return k;
  }
  return s.dir * (b[b.length - 1].c - s.entry) / risk;
}

function main() {
  const setupsRaw = loadSetups();
  const bars = loadBars();
  if (!bars.size) fail(3, `nessuna barra in ${BARSD}`);

  const registry = loadRegistry();
  const nHypotheses = registry.filter(r => r.kind === 'hypothesis').length;
  const alphaEffective = nHypotheses > 0 ? 0.05 / (1 + nHypotheses) : null;

  // ---------------------------------------------------------------- campione
  const emitted: Setup[] = [];
  const dayMap = new Map<string, { candidates: number; emitted: number; blocked: number; gateCount: Record<string, number>; directional: number }>();

  for (const r of setupsRaw) {
    const ts = Number(r.decisionTs);
    if (!Number.isFinite(ts)) continue;
    const date = sessionDate(ts * 1000);
    if (!dayMap.has(date)) dayMap.set(date, { candidates: 0, emitted: 0, blocked: 0, gateCount: {}, directional: 0 });
    const d = dayMap.get(date)!;
    d.candidates += 1;
    const dirS = String(r.direction ?? '').toUpperCase();
    const dir: 1 | -1 | 0 = dirS === 'LONG' ? 1 : dirS === 'SHORT' ? -1 : 0;
    const gates = Array.isArray(r.gates) ? (r.gates as string[]) : [];
    if (r.emitted === true) {
      d.emitted += 1;
      if (dir !== 0) {
        emitted.push({
          sym: String(r.symbol), ts, dir, entry: Number(r.entry), stop: Number(r.stop),
          target: Number(r.target), date, gates, emitted: true,
        });
      }
    } else {
      d.blocked += 1;
      if (dir !== 0) {
        d.directional += 1;
        const passed = new Set(gates);
        for (const g of GATES) if (!passed.has(g)) { d.gateCount[g] = (d.gateCount[g] ?? 0) + 1; break; }
      }
    }
  }

  const days = [...dayMap.keys()].sort();
  const emissionDays = days.filter(d => dayMap.get(d)!.emitted > 0);
  const emissionsByDay = days.map(d => {
    const o = dayMap.get(d)!;
    const top = Object.entries(o.gateCount).sort((a, b) => b[1] - a[1])[0];
    return {
      day: d, candidates: o.candidates, emitted: o.emitted, blocked: o.blocked,
      firstFailingGate: o.directional > 0 && top ? top[0] : null,
    };
  });

  const measured: Array<{ s: Setup; r: number; stopPct: number }> = [];
  for (const s of emitted) {
    const b = bars.get(s.sym);
    if (!b) continue;
    const r = walkR(s, b, 1.6);
    if (r !== null && Number.isFinite(r)) {
      measured.push({ s, r, stopPct: (Math.abs(s.entry - s.stop) / s.entry) * 100 });
    }
  }
  const rMultiples: number[] = measured.map(m => m.r);
  const stopPcts: number[] = measured.map(m => m.stopPct);

  const sample = {
    nDays: days.length,
    nSetups: emitted.length,
    nClusters: emissionDays.length,
    symbols: [...new Set(emitted.map(s => s.sym))].sort(),
    barMinutes: 5,
    windowStart: days[0] ?? null,
    windowEnd: days[days.length - 1] ?? null,
  };

  // ---------------------------------------------------------------- criterio di morte
  const cells: Array<{ dec: number; k: number; n: number; days: number; meanRNet: number }> = [];
  {
    const sorted = [...measured].sort((a, b) => a.stopPct - b.stopPct);
    const per = Math.max(1, Math.ceil(sorted.length / 10));
    for (let d = 0; d < 10; d++) {
      const chunk = sorted.slice(d * per, (d + 1) * per);
      if (!chunk.length) continue;
      for (const k of GRID) {
        const net = chunk.map(c => c.r - PARAMETRIC_PCT / c.stopPct);
        cells.push({
          dec: d + 1, k, n: chunk.length,
          days: new Set(chunk.map(c => c.s.date)).size,
          meanRNet: mean(net),
        });
      }
    }
  }
  const admissible = cells.filter(c => c.n >= 30 && c.days >= 10);
  const trigger = { needSetups: 100, haveSetups: emitted.length, needDays: 30, haveDays: emissionDays.length };
  const triggerMet = trigger.haveSetups >= trigger.needSetups && trigger.haveDays >= trigger.needDays;
  const alphaBonferroni = admissible.length > 0 ? 0.05 / admissible.length : null;
  const deathStatus = !triggerMet ? 'not_yet_evaluable' : (admissible.length === 0 ? 'closed' : 'closed');
  const deathReason = !triggerMet
    ? `trigger non soddisfatto: ${trigger.haveDays}/${trigger.needDays} giorni con almeno un setup emesso (${trigger.haveSetups}/${trigger.needSetups} setup). Celle ammissibili (n>=30 e giorni>=10): ${admissible.length} su ${cells.length}. Nessun giudizio: il criterio non e valutabile su questo campione.`
    : `trigger soddisfatto; celle ammissibili ${admissible.length} su ${cells.length}; soglie alphaEffective=${alphaEffective} e Bonferroni=${alphaBonferroni}.`;

  // ---------------------------------------------------------------- regole
  type RuleRow = {
    id: string; name: string; family: string;
    status: 'computed' | 'insufficient_sample' | 'missing_input' | 'not_invocable';
    value: number | null; unit: string | null; n: number | null; ci95: [number | null, number | null];
    inputsRequired: string[]; inputsAvailable: string[]; note: string;
  };
  const rules: RuleRow[] = [];
  const add = (r: RuleRow) => rules.push(r);

  const kbars = new Map<string, Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>>();
  for (const [sym, b] of bars) kbars.set(sym, b.map(x => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v })));

  // S01 Triple barrier
  {
    const labels: Array<1 | -1 | 0 | null> = [];
    for (const s of emitted) {
      const b = bars.get(s.sym);
      if (!b) continue;
      let ix = -1;
      for (let i = b.length - 1; i >= 0; i--) if (b[i].t <= s.ts) { ix = i; break; }
      if (ix < 0) continue;
      const samples = tripleBarrierLabels(
        kbars.get(s.sym)!,
        [ix],
        {
          upperFraction: TRIPLE_BARRIER_UPPER_HYPOTHESIS,
          lowerFraction: TRIPLE_BARRIER_LOWER_HYPOTHESIS,
          verticalBars: TRIPLE_BARRIER_VERTICAL_BARS_HYPOTHESIS,
          barMs: 5 * 60 * 1000,
        },
        b[b.length - 1].t * 1000 + 1,
      );
      if (samples[0]) labels.push(samples[0].label);
    }
    const resolved = labels.filter((l): l is 1 | -1 | 0 => l !== null);
    const upper = resolved.filter(l => l === 1).length;
    add({
      id: 'S01', name: 'tripleBarrierLabels', family: 'STIMATORE',
      status: resolved.length >= 30 ? 'computed' : 'insufficient_sample',
      value: resolved.length ? upper / resolved.length : null, unit: 'share UPPER', n: resolved.length,
      ci95: [null, null],
      inputsRequired: ['barre 5m', 'indice evento', 'barriere 2%/2%/48 barre'],
      inputsAvailable: ['barre 5m (30d, 5 simboli)', 'decisionTs dei 123 setup'],
      note: 'barriere a ±2% e 48 barre sono IPOTESI di modulo, non calibrate: il valore misura la regola, non la strategia.',
    });
  }

  // S02 Uniqueness weights
  {
    const spans: Array<{ startIndex: number; endIndex: number }> = [];
    for (const s of emitted) {
      const b = bars.get(s.sym);
      if (!b) continue;
      let ix = -1;
      for (let i = b.length - 1; i >= 0; i--) if (b[i].t <= s.ts) { ix = i; break; }
      if (ix < 0) continue;
      spans.push({ startIndex: ix, endIndex: Math.min(b.length - 1, ix + TRIPLE_BARRIER_VERTICAL_BARS_HYPOTHESIS) });
    }
    const w = spans.length ? sampleUniquenessWeights(spans, Math.max(...spans.map(x => x.endIndex)) + 1) : [];
    add({
      id: 'S02', name: 'sampleUniquenessWeights', family: 'PROTOCOLLO',
      status: w.length >= 30 ? 'computed' : 'insufficient_sample',
      value: w.length ? mean(w) : null, unit: 'peso medio', n: w.length, ci95: [null, null],
      inputsRequired: ['finestra [start,end] per campione'], inputsAvailable: ['123 finestre da decisionTs + 48 barre'],
      note: 'pesi < 1 segnalano sovrapposizione delle etichette: con setup ravvicinati e inevitabile.',
    });
  }

  // S03 Purged K-Fold
  {
    const spans: Array<{ startIndex: number; endIndex: number }> = [];
    for (const s of emitted) {
      const b = bars.get(s.sym);
      if (!b) continue;
      let ix = -1;
      for (let i = b.length - 1; i >= 0; i--) if (b[i].t <= s.ts) { ix = i; break; }
      if (ix < 0) continue;
      spans.push({ startIndex: ix, endIndex: Math.min(b.length - 1, ix + TRIPLE_BARRIER_VERTICAL_BARS_HYPOTHESIS) });
    }
    const folds = spans.length >= 30 ? purgedKFold(spans, 3, 12) : [];
    add({
      id: 'S03', name: 'purgedKFold', family: 'PROTOCOLLO',
      status: folds.length ? 'computed' : 'insufficient_sample',
      value: folds.length ? folds.length : null, unit: 'fold', n: spans.length, ci95: [null, null],
      inputsRequired: ['finestre campione', 'n fold', 'embargo barre'], inputsAvailable: ['123 finestre', '3 fold, 12 barre embargo (IPOTESI)'],
      note: 'la purga e calcolata sulle finestre, non sui giorni: e un protocollo, non una misura.',
    });
  }

  // S04 Deflated Sharpe
  let dsrValue: number | null = null, dsrP: number | null = null, dsrSharpe: number | null = null;
  {
    const res = rMultiples.length >= 3 ? deflatedSharpeRatio(rMultiples, Math.max(1, nHypotheses)) : null;
    dsrSharpe = res?.sharpe ?? null;
    dsrValue = res?.deflated ?? null;
    dsrP = res?.deflated !== null && res?.deflated !== undefined && Number.isFinite(res.deflated) ? 1 - normalCdf(res.deflated) : null;
    add({
      id: 'S04', name: 'deflatedSharpeRatio', family: 'CORREZIONE',
      status: res && res.status === 'OK' ? 'computed' : (res ? 'insufficient_sample' : 'missing_input'),
      value: dsrValue, unit: 'DSR (z)', n: rMultiples.length, ci95: [null, null],
      inputsRequired: ['serie di rendimenti', 'numero di prove'], inputsAvailable: [`${rMultiples.length} R a k=1.6`, `nTrials=${nHypotheses} dal registro`],
      note: `sharpe=${dsrSharpe === null ? 'n/d' : dsrSharpe.toFixed(3)}; p a una coda = 1 - Phi(DSR) = ${dsrP === null ? 'n/d' : dsrP.toFixed(4)}. nTrials letto dal registro, non hardcoded.`,
    });
  }

  // S05 Fractional Kelly
  {
    const wins = rMultiples.filter(r => r > 0), losses = rMultiples.filter(r => r < 0);
    const p = rMultiples.length ? wins.length / rMultiples.length : NaN;
    const b = losses.length ? mean(wins) / Math.abs(mean(losses)) : NaN;
    const k = Number.isFinite(p) && Number.isFinite(b) ? fractionalKelly(p, b) : null;
    add({
      id: 'S05', name: 'fractionalKelly', family: 'STIMATORE',
      status: k ? 'computed' : 'missing_input',
      value: k ? k.size : null, unit: 'frazione di capitale', n: rMultiples.length, ci95: [null, null],
      inputsRequired: ['hit rate', 'payoff ratio'], inputsAvailable: ['R a k=1.6', 'hit e payoff calcolati su 123'],
      note: `hit=${Number.isFinite(p) ? p.toFixed(3) : 'n/d'}, payoff=${Number.isFinite(b) ? b.toFixed(3) : 'n/d'} -> fullKelly=${k ? k.fullKelly.toFixed(4) : 'n/d'}. Con edge negativo la size e 0 per costruzione.`,
    });
  }

  // S06 CUSUM
  {
    let events = 0, barsUsed = 0;
    for (const [sym, b] of bars) {
      const rng = median(b.slice(1).map((x, i) => Math.abs(x.c - b[i].c)));
      if (!(rng > 0)) continue;
      const ev = cusumEventIndices(b.map(x => x.c), rng * 10);
      events += ev.length; barsUsed += b.length;
      void sym;
    }
    add({
      id: 'S06', name: 'cusumEventIndices', family: 'FILTRO',
      status: events > 0 ? 'computed' : 'insufficient_sample',
      value: events, unit: 'eventi CUSUM', n: barsUsed, ci95: [null, null],
      inputsRequired: ['serie di prezzi', 'soglia'],
      inputsAvailable: ['close 5m per 9 simboli', 'soglia = 10x range mediano (IPOTESI)'],
      note: 'la soglia e arbitraria e non calibrata: il conteggio dice quanto spesso il filtro guarderebbe, non se convenga.',
    });
  }

  // S07 Corwin-Schultz
  const perSymbolSpread: Array<{ symbol: string; spreadPct: number | null; n: number | null }> = [];
  {
    for (const [sym, b] of kbars) {
      const proxy = corwinSchultzSpreadProxy(b).filter((v): v is number => v !== null && Number.isFinite(v));
      if (!proxy.length) { perSymbolSpread.push({ symbol: sym, spreadPct: null, n: 0 }); continue; }
      perSymbolSpread.push({ symbol: sym, spreadPct: median(proxy) * 100, n: proxy.length });
    }
    const vals = perSymbolSpread.map(x => x.spreadPct).filter((v): v is number => v !== null);
    add({
      id: 'S07', name: 'corwinSchultzSpreadProxy', family: 'STIMATORE',
      status: vals.length ? 'computed' : 'missing_input',
      value: vals.length ? median(vals) : null, unit: '% di prezzo (mediana fra simboli)', n: vals.length, ci95: [null, null],
      inputsRequired: ['high/low per barra'], inputsAvailable: ['barre 5m, 30 giorni, 9 simboli'],
      note: 'stimatore pensato per barre giornaliere: su 5 minuti sovrastima per rumore di microstruttura. Ordine di grandezza, non misura.',
    });
  }

  // S08 Amihud
  {
    let n = 0;
    const meds: number[] = [];
    for (const [, b] of kbars) {
      const v = amihudIlliquidity(b).filter((x): x is number => x !== null && Number.isFinite(x));
      if (!v.length) continue;
      meds.push(median(v)); n += v.length;
    }
    add({
      id: 'S08', name: 'amihudIlliquidity', family: 'STIMATORE',
      status: meds.length ? 'computed' : 'missing_input',
      value: meds.length ? median(meds) : null, unit: '|r|/volume x 1e6 (mediana)', n, ci95: [null, null],
      inputsRequired: ['close', 'volume'], inputsAvailable: ['barre 5m con volume'],
      note: 'la scala 1e6 e arbitraria (IPOTESI di modulo): confrontabile fra simboli, non in assoluto.',
    });
  }

  // S09 Volume bars
  {
    let total = 0, src = 0;
    for (const [, b] of kbars) {
      const vols = b.map(x => x.v).filter(v => Number.isFinite(v) && v > 0);
      if (!vols.length) continue;
      const target = median(vols) * 78;
      const vb = approximateVolumeBars(b, target);
      total += vb.length; src += b.length;
    }
    add({
      id: 'S09', name: 'approximateVolumeBars', family: 'STIMATORE',
      status: total > 0 ? 'computed' : 'insufficient_sample',
      value: total, unit: 'barre di volume approssimate', n: src, ci95: [null, null],
      inputsRequired: ['volume per barra', 'target volume'],
      inputsAvailable: ['volume 5m', 'target = volume mediano x 78 (IPOTESI)'],
      note: 'ricostruzione dichiarata approssimata (exact:false): l ordine intrabar e ignoto, il confine del bucket non e un clock informativo.',
    });
  }

  // S10 High probability window
  {
    let inside = 0, tot = 0;
    const now = Date.now() + 365 * 24 * 3600 * 1000;
    for (const s of emitted) {
      tot += 1;
      if (isHighProbabilityWindow(s.ts * 1000, 'EU', now, 5 * 60 * 1000)) inside += 1;
    }
    add({
      id: 'S10', name: 'isHighProbabilityWindow', family: 'FILTRO',
      status: tot ? 'computed' : 'missing_input',
      value: tot ? inside / tot : null, unit: 'share dentro la finestra', n: tot, ci95: [null, null],
      inputsRequired: ['timestamp', 'mercato'], inputsAvailable: ['decisionTs dei 123 setup'],
      note: 'finestra EU = 09:00-09:59 (540-599 minuti, IPOTESI di modulo): misura quanto la regola sia coercitiva, non se aiuti.',
    });
  }

  // S11 Expectancy bootstrap
  {
    const res = rMultiples.length >= 2 ? expectancyBootstrap(rMultiples) : null;
    add({
      id: 'S11', name: 'expectancyBootstrap', family: 'PROTOCOLLO',
      status: res ? 'computed' : 'insufficient_sample',
      value: res ? res.pValue : null, unit: 'p-value segni alternati', n: rMultiples.length, ci95: [null, null],
      inputsRequired: ['serie di R'], inputsAvailable: [`${rMultiples.length} R a k=1.6`],
      note: res ? `meanR=${res.meanR.toFixed(4)}, significant=${res.significant} a alpha=${res.alpha}. Test di segno, non di profittabilita al netto.` : 'serie troppo corta.',
    });
  }

  const counts = { computed: 0, insufficient_sample: 0, missing_input: 0, not_invocable: 0 };
  for (const r of rules) counts[r.status] += 1;

  // ---------------------------------------------------------------- proposte
  const proposals: Array<Record<string, unknown>> = [];
  const superseded = new Set(registry.map(r => r.supersedes).filter((x): x is string => typeof x === 'string'));
  const ids = [...new Set(registry.map(r => String(r.id)))].filter(id => !superseded.has(id));
  for (const id of ids) {
    const rows = registry.filter(r => String(r.id) === id);
    const last = rows[rows.length - 1];
    const hyp = rows.find(r => r.kind === 'hypothesis');
    const res = rows.filter(r => r.kind === 'result').slice(-1)[0];
    const measured = (res?.measured ?? {}) as Record<string, unknown>;
    const split = (hyp?.split ?? {}) as Record<string, unknown>;
    const holdoutN = typeof measured.nHoldout === 'number' ? measured.nHoldout
      : (typeof measured.nA === 'number' ? (measured.nC as number) : null);
    const holdoutDays = typeof split.holdout === 'string' ? split.holdout : null;
    const beats = typeof holdoutN === 'number' && holdoutN < 30 ? null : (measured.beatsNull as boolean | undefined) ?? null;
    proposals.push({
      hypothesisId: id,
      status: String(last?.status ?? 'hypothesis'),
      formationDays: typeof split.train === 'string' ? split.train : null,
      holdoutDays,
      holdoutN,
      meanRHoldout: typeof measured.meanR_holdout === 'number' ? measured.meanR_holdout : null,
      meanRNullP95: typeof measured.nullP95 === 'number' ? measured.nullP95 : null,
      alphaEffective: typeof last?.alphaEffective === 'number' ? last.alphaEffective : null,
      beatsNull: beats,
      nullReason: beats === null ? `holdout con ${holdoutN ?? 'n/d'} campioni: sotto 30 il confronto col nullo non e interpretabile` : null,
      verdict: String(last?.verdict ?? last?.status ?? 'hypothesis'),
    });
  }

  const artifact = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    sample,
    emissionsByDay,
    deathCriterion: {
      status: deathStatus,
      population: 'C',
      trigger,
      nCells: cells.length,
      nAdmissibleCells: admissible.length,
      alphaEffective,
      alphaBonferroni,
      bestAdmissibleCell: admissible.length
        ? admissible.reduce((a, b) => (a.meanRNet >= b.meanRNet ? a : b))
        : null,
      reason: deathReason,
    },
    rules,
    spreadEstimate: {
      method: 'corwin_schultz',
      perSymbol: perSymbolSpread.sort((a, b) => a.symbol.localeCompare(b.symbol)),
      vsParametricPct: PARAMETRIC_PCT,
      deltaPct: (() => {
        const vals = perSymbolSpread.map(x => x.spreadPct).filter((v): v is number => v !== null);
        return vals.length ? median(vals) - PARAMETRIC_PCT : null;
      })(),
      caveat: 'stimatore pensato per barre giornaliere; su barre a 5 minuti sovrastima per rumore di microstruttura. vsParametricPct e la banda di frizione usata nei passi I/J (percentuale del prezzo), non uno spread quotato.',
    },
    deflatedSharpe: {
      nTrials: nHypotheses || null,
      nTrialsSource: 'registry/ai_registry.jsonl',
      sharpe: dsrSharpe,
      dsr: dsrValue,
      pValue: dsrP,
      alphaBonferroni,
      alphaEffective,
      note: 'nTrials letto dal registro, non hardcoded. pValue = 1 - Phi(DSR) a una coda.',
    },
    proposals,
    limitations: [
      `campione: ${sample.nDays} giorni di calendario, ${sample.nClusters} giorni con almeno un setup emesso, ${sample.nSetups} setup emessi`,
      'barre a 5 minuti: dentro la barra l ordine stop/target non e risolvibile, vale l ipotesi pessimistica (stop per primo)',
      'solo simboli europei: la sessione USA non e misurata',
      'frizione parametrica (0.10% del prezzo), non una misura di spread quotato',
      'G4 non giudicato: con fill onesto -0.129 R, ma 400/1837 irraggiungibili per costruzione',
      'popolazione A (excludedRecords) non disponibile su disco: vive in localStorage (src/App.tsx:248)',
      'emissionsByDay: "blocked" include le righe senza direzione; firstFailingGate e calcolato solo sulle righe con direzione, altrimenti vale null',
      'le 11 regole shadow sono eseguite con parametri IPOTESI del modulo, non calibrati: gli stati dicono cosa e calcolabile, non cosa convenga',
    ],
  };

  if (!existsSync(join(ART, 'shadow'))) mkdirSync(join(ART, 'shadow'), { recursive: true });
  const path = join(ART, 'shadow', `shadow_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log('=== SHADOW REPORT ===');
  console.log(`  campione: ${sample.nDays} giorni · ${sample.nSetups} setup · ${sample.nClusters} cluster · barre ${sample.barMinutes}m`);
  console.log(`  simboli: ${sample.symbols.join(' ')} · finestra ${sample.windowStart} -> ${sample.windowEnd}`);
  for (const e of emissionsByDay) {
    console.log(`  ${e.day}  cand=${String(e.candidates).padStart(4)} em=${String(e.emitted).padStart(3)} blk=${String(e.blocked).padStart(4)} primo_gate=${e.firstFailingGate ?? 'null'}`);
  }
  console.log(`\n  criterio di morte: ${deathStatus} · ${deathReason}`);
  console.log(`  regole: computed=${counts.computed} insufficient_sample=${counts.insufficient_sample} missing_input=${counts.missing_input} not_invocable=${counts.not_invocable} (somma ${rules.length})`);
  for (const r of rules) console.log(`  ${r.id} ${r.name.padEnd(28)} ${r.family.padEnd(11)} ${r.status.padEnd(19)} value=${r.value === null ? 'null' : Number(r.value).toFixed(4)} n=${r.n ?? 'null'}`);
  const spreads = perSymbolSpread.map(x => `${x.symbol}=${x.spreadPct === null ? 'n/d' : x.spreadPct.toFixed(4)}%`).join(' ');
  console.log(`\n  spread stimato: ${spreads}`);
  console.log(`  parametrico assunto=${PARAMETRIC_PCT}% delta=${artifact.spreadEstimate.deltaPct === null ? 'n/d' : artifact.spreadEstimate.deltaPct.toFixed(4)} pt`);
  console.log(`  DSR: nTrials=${nHypotheses} sharpe=${dsrSharpe === null ? 'n/d' : dsrSharpe.toFixed(3)} dsr=${dsrValue === null ? 'n/d' : dsrValue.toFixed(3)} p=${dsrP === null ? 'n/d' : dsrP.toFixed(4)}`);
  console.log(`  proposte: ${proposals.map(p => `${p.hypothesisId}=${p.status}`).join(' ') || 'nessuna'}`);
  console.log(`\n  scritto ${path}`);
}

main();
