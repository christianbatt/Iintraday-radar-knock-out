#!/usr/bin/env bun
/**
 * scripts/universe_replay.ts — replay della strategia principale sull'INTERO
 * paniere (40 titoli: 20 EU + 20 USA), non sui soli 9 nomi dello snapshot.
 *
 * Differenza chiave rispetto a scripts/delay_replay.ts: i campi statici non
 * vengono da un unico snapshot registrato in una data, ma sono ricostruiti
 * PER OGNI SEDUTA dalle barre giornaliere:
 *   prevClose, ATR14, ADR14, media volumi 20 sedute, liquidità 20 sedute,
 *   EMA20 daily, RVOL cumulato alla decisione, VWAP di stato.
 * Questo elimina il difetto per cui il gap (e quindi la direzione e lo score)
 * era calcolato contro un prevClose fisso di due settimane prima.
 *
 * Pipeline: quella REALE (scripts/headless_pipeline.ts -> src/). Nessuna soglia
 * viene reimplementata qui.
 *
 * Uso:
 *   npx tsx scripts/universe_replay.ts --days=20 --step=15
 *   npx tsx scripts/universe_replay.ts --limit=4            (prova rapida)
 *   npx tsx scripts/universe_replay.ts --symbols=SAP.DE,NVDA
 *
 * Cache: artifacts/universe/<sym>_5m.json e <sym>_1d.json (riusata se presente
 * e piu' recente di --max-age-hours=12).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_TRADE_REPUBLIC_UNDERLYINGS } from '../src/data/defaultUnderlyings';
import {
  buildExecutionSetup,
  calculateCandidateScore,
  computeVwapState,
  DEFAULT_SYSTEM_PARAMETERS,
} from '../src/utils/calculator';
import { getExchangeDateStr, getMarketTime } from '../src/utils/timezone';
import { runPipeline, quoteFromBars, type Bar5m, type Snapshot } from './headless_pipeline';
import { applyEmissionGuard } from './emission_guard';
import type { RawQuoteData } from '../src/types/radar';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const DAYS = Number(arg('days', '20'));
const STEP_MIN = Number(arg('step', '15'));
const LIMIT = Number(arg('limit', '0'));
const HORIZON_SEC = Number(arg('horizon', '3600'));
const CACHE = arg('cache', 'artifacts/universe');
const OUT = arg('out', 'artifacts/universe_replay.json');
const MAX_AGE_H = Number(arg('max-age-hours', '12'));
const ONLY = arg('symbols', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

type Daily = { date: string; o: number; h: number; l: number; c: number; v: number };
type Bar = Bar5m;

mkdirSync(CACHE, { recursive: true });

const TZ: Record<'EU' | 'US', string> = { EU: 'Europe/Rome', US: 'America/New_York' };

function dayInTz(tsSec: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(tsSec * 1000));
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function cacheFresh(path: string): boolean {
  if (!existsSync(path)) return false;
  return Date.now() - statSync(path).mtimeMs < MAX_AGE_H * 3600_000;
}

async function loadSeries(sym: string): Promise<{ bars: Bar[]; daily: Daily[]; tz: string; currency: string }> {
  const p5 = join(CACHE, `${sym}_5m.json`);
  const p1 = join(CACHE, `${sym}_1d.json`);
  let raw5: any;
  let raw1: any;
  if (cacheFresh(p5) && cacheFresh(p1)) {
    raw5 = JSON.parse(readFileSync(p5, 'utf8'));
    raw1 = JSON.parse(readFileSync(p1, 'utf8'));
  } else {
    raw5 = await fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=60d`
    );
    raw1 = await fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=6mo`
    );
    writeFileSync(p5, JSON.stringify(raw5));
    writeFileSync(p1, JSON.stringify(raw1));
  }

  const r5 = raw5?.chart?.result?.[0];
  const r1 = raw1?.chart?.result?.[0];
  if (!r5 || !r1) throw new Error('chart vuoto');
  const tz = r5.meta?.exchangeTimezoneName || 'Europe/Rome';
  const currency = r5.meta?.currency || 'EUR';

  const q5 = r5.indicators?.quote?.[0] ?? {};
  const bars: Bar[] = [];
  const ts5: number[] = r5.timestamp ?? [];
  for (let i = 0; i < ts5.length; i += 1) {
    const o = q5.open?.[i];
    const h = q5.high?.[i];
    const l = q5.low?.[i];
    const c = q5.close?.[i];
    if ([o, h, l, c].some((x) => typeof x !== 'number')) continue;
    bars.push({ t: ts5[i], o, h, l, c, v: typeof q5.volume?.[i] === 'number' ? q5.volume[i] : 0 });
  }
  bars.sort((a, b) => a.t - b.t);

  const q1 = r1.indicators?.quote?.[0] ?? {};
  const ts1: number[] = r1.timestamp ?? [];
  const daily: Daily[] = [];
  for (let i = 0; i < ts1.length; i += 1) {
    const o = q1.open?.[i];
    const h = q1.high?.[i];
    const l = q1.low?.[i];
    const c = q1.close?.[i];
    const v = q1.volume?.[i];
    if ([o, h, l, c, v].some((x) => typeof x !== 'number')) continue;
    daily.push({ date: dayInTz(ts1[i], tz), o, h, l, c, v });
  }
  return { bars, daily, tz, currency };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function atrDaily(rows: Daily[], period = 14): number | null {
  if (rows.length < period + 1) return null;
  let sum = 0;
  for (let i = rows.length - period; i < rows.length; i += 1) {
    const r = rows[i];
    const p = rows[i - 1];
    sum += Math.max(r.h - r.l, Math.abs(r.h - p.c), Math.abs(r.l - p.c));
  }
  return sum / period;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = mean(values.slice(0, period));
  for (let i = period; i < values.length; i += 1) e = values[i] * k + e * (1 - k);
  return e;
}

function atrFromBars(bars: Bar[], period = 14): number | null {
  const valid = bars.filter((b) => b.h > b.l);
  if (valid.length < period + 1) return null;
  let sum = 0;
  for (let i = valid.length - period; i < valid.length; i += 1) {
    const b = valid[i];
    const p = valid[i - 1];
    sum += Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
  }
  return sum / period;
}

function closeAt(bars: Bar[], ts: number): number | null {
  let out: number | null = null;
  for (const b of bars) {
    if (b.t <= ts) out = b.c;
    else break;
  }
  return out;
}

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
  let last = entry;
  for (const b of bars) {
    if (b.t <= entryTs) continue;
    if (b.t > end) break;
    if (dir === 1 ? b.l <= stop : b.h >= stop) return -1;
    if (dir === 1 ? b.h >= target : b.l <= target) return (dir * (target - entry)) / risk;
    last = b.c;
  }
  return (dir * (last - entry)) / risk;
}

type Row = {
  symbol: string;
  market: 'EU' | 'US';
  day: string;
  decisionTs: number;
  hour: number;
  emitted: boolean;
  direction: string | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  score: number | null;
  veto: string | null;
  blockedGate: string | null;
  reason: string | null;
  gates: string[];
  stopPct: number | null;
  markR: number | null;
  realized: number | null;
  stopped: boolean;
  // Controfattuale "veto rimosso": stessi dati, stesso orario, solo score.veto = null.
  hypEmitted: boolean;
  hypBlockedGate: string | null;
  hypDirection: 'LONG' | 'SHORT' | null;
  hypEntry: number | null;
  hypStop: number | null;
  hypTarget: number | null;
  hypRealized: number | null;
};

const basket = DEFAULT_TRADE_REPUBLIC_UNDERLYINGS
  .map((u) => ({ ticker: u.ticker, market: u.mercato as 'EU' | 'US', name: u.nome, currency: u.valuta }))
  .filter((u) => ONLY.length === 0 || ONLY.includes(u.ticker));
const selected = LIMIT > 0 ? basket.slice(0, LIMIT) : basket;

const rows: Row[] = [];
const missing: string[] = [];
const t0 = Date.now();

for (const item of selected) {
  let series: { bars: Bar[]; daily: Daily[]; tz: string; currency: string };
  try {
    series = await loadSeries(item.ticker);
  } catch (e) {
    missing.push(`${item.ticker}: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const { bars, daily, tz, currency } = series;
  if (bars.length === 0 || daily.length < 22) {
    missing.push(`${item.ticker}: dati insufficienti (bars=${bars.length}, daily=${daily.length})`);
    continue;
  }

  // Indici precalcolati una volta per simbolo: data->barre e volume cumulato.
  // (Il calcolo per-decisione con Intl su ogni barra costava ~5s per decisione.)
  const dateOf = new Map<number, string>();
  const byDay = new Map<string, Bar[]>();
  for (const b of bars) {
    const d = dayInTz(b.t, tz);
    dateOf.set(b.t, d);
    const arr = byDay.get(d);
    if (arr === undefined) byDay.set(d, [b]);
    else arr.push(b);
  }
  const cumVol = new Map<string, number[]>();
  for (const [d, arr] of byDay) {
    const cum: number[] = [];
    let acc = 0;
    for (const b of arr) {
      acc += b.v;
      cum.push(acc);
    }
    cumVol.set(d, cum);
  }

  // ultime N sedute presenti nelle barre 5m, dalla piu' vecchia alla piu' recente
  const daysWithBars = Array.from(byDay.keys()).sort();
  const windowDays = daysWithBars.slice(-DAYS);
  const firstIdx = daily.findIndex((d) => d.date >= windowDays[0]);
  if (firstIdx < 21) {
    missing.push(`${item.ticker}: storico daily insufficiente prima di ${windowDays[0]}`);
    continue;
  }

  for (const day of windowDays) {
    const dayBars = byDay.get(day) ?? [];
    if (dayBars.length < 20) continue;
    const dIdx = daily.findIndex((d) => d.date === day);
    if (dIdx < 21) continue;
    const hist = daily.slice(0, dIdx); // sola storia precedente: nessun look-ahead
    const prev = hist[hist.length - 1];
    const atr14 = atrDaily(hist);
    const adrWindow = hist.slice(-14);
    const liqWindow = hist.slice(-20);
    const adr14 = mean(adrWindow.map((r) => r.h - r.l));
    const liq = mean(liqWindow.map((r) => r.v * r.c));
    const avgVol = mean(liqWindow.map((r) => r.v));
    const ema20 = ema(hist.map((r) => r.c), 20);

    // RVOL: volume cumulato di oggi alla decisione / media stesso lasso nelle 10 sedute precedenti
    const priorDayList = daysWithBars.filter((d) => d < day);
    const volDays = priorDayList.slice(-10);
    const priorCum = (elapsedBars: number): number => {
      let total = 0;
      let n = 0;
      for (const pd of volDays) {
        const cum = cumVol.get(pd);
        if (cum === undefined || cum.length === 0) continue;
        total += cum[Math.min(elapsedBars, cum.length) - 1] ?? 0;
        n += 1;
      }
      return n > 0 ? total / n : 0;
    };
    const prevDays = priorDayList.slice(-2);
    const priorBarsForDay: Bar[] = prevDays.flatMap((d) => byDay.get(d) ?? []);

    const market = item.market;
    const cutoff = 690; // 11:30 locale, come getOrbPhaseInfo
    const start = market === 'US' ? 580 : 560; // 09:40 / 09:20 locale
    const offsets = Array.from(new Set(dayBars.map((b) => b.t))).sort((a, b) => a - b);

    for (const t of offsets) {
      const mt = getMarketTime(market, new Date(t * 1000));
      if (mt.totalMinutes < start + STEP_MIN || mt.totalMinutes > cutoff) continue;
      if ((mt.totalMinutes - start) % STEP_MIN !== 0) continue;

      const debug = arg('debug', '') === 'true';
      const tMark = Date.now();
      const idxToday = dayBars.findIndex((b) => b.t === t);
      if (idxToday < 2) continue;
      const todayVol = dayBars.slice(0, idxToday + 1).reduce((a, b) => a + b.v, 0);
      const baseCum = priorCum(idxToday + 1);
      const rvol = baseCum > 0 ? +(todayVol / baseCum).toFixed(2) : null;

      const windowBars = [...priorBarsForDay, ...dayBars.slice(0, idxToday + 1)];
      if (windowBars.length < 60) continue;

      const sessionDate = day;
      // Copertura della sessione: barre presenti / barre attese dall'apertura.
      const sessionStartM = market === 'US' ? 570 : 540;
      const expectedBars = Math.max(1, Math.floor((mt.totalMinutes - sessionStartM) / 5));
      const todayBars = dayBars.slice(0, idxToday + 1).length;
      const coverage = Math.min(1, todayBars / expectedBars);
      const vwapState = computeVwapState(
        windowBars.map((b) => ({ timestamp: b.t, high: b.h, low: b.l, close: b.c, volume: b.v })),
        {
          market,
          sessionDate,
          atr5m: atrFromBars(windowBars),
          coverage,
          nowMinutes: mt.totalMinutes,
        }
      );

      const synthetic: Snapshot = {
        recordedAt: new Date(t * 1000).toISOString(),
        capturedAt: new Date(t * 1000).toISOString(),
        parameters: {} as any,
        quotes: [
          {
            ticker: item.ticker,
            name: item.name,
            market,
            currency,
            prevClose: prev.c,
            currentPrice: dayBars[idxToday].c,
            preMarketPrice: dayBars[0].o,
            prevHigh: prev.h,
            prevLow: prev.l,
            preMarketHigh: dayBars[0].h,
            preMarketLow: dayBars[0].l,
            todayOpen: dayBars[0].o,
            todayHigh: dayBars[idxToday].h,
            todayLow: dayBars.slice(0, idxToday + 1).reduce((a, b) => Math.min(a, b.l), Infinity),
            vwap: null,
            ema20Daily: ema20,
            avgVolume20d: Math.round(avgVol),
            preMarketVolume: null,
            atr14,
            adr14,
            liqEur20d: Math.round(liq),
            completedBarsCount: 20,
            gapPercent: null,
            rvol,
            rvol20m: null,
            rsi14: null,
            rsi5m: null,
            orderFlow: null,
            setupIndicators: null,
            vwapState,
            timestamp: new Date(t * 1000).toISOString(),
            source: 'universe_replay',
            marketTs: null,
          } as unknown as RawQuoteData,
        ],
        bars5m: {},
        rawMeta: {},
        basket: [item.ticker],
      };

      const tQuote = Date.now();
      const quote = quoteFromBars(synthetic, item.ticker, t, windowBars);
      if (quote === null) continue;
      if (debug) {
        const score = (await import('../src/utils/calculator')).calculateCandidateScore(
          quote,
          0,
          null
        );
        console.log(
          `  ${item.ticker} ${day} ${mt.totalMinutes}m prep=${tQuote - tMark}ms quote=${Date.now() - tQuote}ms ` +
            `score=${score.total} veto=${score.veto ?? '-'} warmup=${score.warmupIncomplete} ` +
            `st=${quote.setupIndicators?.supertrend?.status ?? '-'}/${quote.setupIndicators?.adx?.status ?? '-'}` +
            `/vwap=${quote.vwapState?.state ?? '-'}`
        );
      }
      const tPipe = Date.now();

      const preScore = calculateCandidateScore(quote, 0, null);
      let result: Record<string, unknown>;
      try {
        result = runPipeline([quote], {
          currentTime: new Date(t * 1000),
          entryMode: 'SNAPSHOT_0915',
          futuresChange: { EU: 0, US: 0 },
        });
      } catch {
        continue;
      }
      const branch = result[market] as Record<string, unknown> | undefined;
      const setup = (branch?.setup ?? null) as Record<string, unknown> | null;
      if (debug) console.log(`     pipeline=${Date.now() - tPipe}ms decision=${setup?.decision ?? '-'} blocked=${setup?.blockedGate ?? '-'}`);
      if (setup === null) continue;

      const gateResults = (setup.gateResults ?? {}) as Record<string, { passed?: boolean }>;
      const failed = Object.keys(gateResults).find((k) => gateResults[k]?.passed === false) ?? null;
      const decision = typeof setup.decision === 'string' ? setup.decision : 'NESSUN_TRADE';
      const dirRaw = typeof setup.direction === 'string' ? setup.direction : null;
      const entry = typeof setup.entryLevel === 'number' ? setup.entryLevel : null;
      const stop = typeof setup.stopLossLevel === 'number' ? setup.stopLossLevel : null;
      const target = typeof setup.target1Level === 'number' ? setup.target1Level : null;

      // Controfattuale: se il candidato e' stato escluso da un veto di score, si
      // ricostruisce il setup come se il veto non ci fosse (tutto il resto identico).
      let hyp: {
        decision: string;
        blockedGate: string | null;
        direction: 'LONG' | 'SHORT' | null;
        entry: number | null;
        stop: number | null;
        target: number | null;
      } | null = null;
      if (preScore.veto != null) {
        try {
          const s = buildExecutionSetup(
            { quote, score: { ...preScore, veto: null }, rank: 1 },
            null,
            market,
            DEFAULT_SYSTEM_PARAMETERS,
            { currentTime: new Date(t * 1000), entryMode: 'SNAPSHOT_0915' }
          );
          const failedHyp = Object.keys(s.gateResults ?? {}).find(
            (k) => (s.gateResults as Record<string, { passed?: boolean }>)[k]?.passed === false
          );
          hyp = {
            decision: s.decision,
            blockedGate: failedHyp ?? null,
            direction: s.direction === 'SHORT' ? 'SHORT' : s.direction === 'LONG' ? 'LONG' : null,
            entry: typeof s.entryLevel === 'number' ? s.entryLevel : null,
            stop: typeof s.stopLossLevel === 'number' ? s.stopLossLevel : null,
            target: typeof s.target1Level === 'number' ? s.target1Level : null,
          };
        } catch {
          hyp = null;
        }
      }

      rows.push({
        symbol: item.ticker,
        market,
        day,
        decisionTs: t,
        hour: Math.floor(mt.totalMinutes / 60),
        emitted: decision === 'TRADE',
        direction: dirRaw,
        entry,
        stop,
        target,
        score: typeof branch?.topScore === 'number' ? branch.topScore : preScore.total,
        veto: (preScore.veto as string | null | undefined) ?? null,
        blockedGate: failed,
        reason: typeof setup.reasonNoTrade === 'string' ? setup.reasonNoTrade : null,
        gates: Object.keys(gateResults).filter((k) => gateResults[k]?.passed === true),
        stopPct: entry != null && stop != null && entry > 0 ? (Math.abs(entry - stop) / entry) * 100 : null,
        markR: null,
        realized: null,
        stopped: false,
        hypEmitted: hyp?.decision === 'TRADE',
        hypBlockedGate: hyp?.blockedGate ?? null,
        hypDirection: hyp?.direction ?? null,
        hypEntry: hyp?.entry ?? null,
        hypStop: hyp?.stop ?? null,
        hypTarget: hyp?.target ?? null,
        hypRealized: null,
      });
    }
  }
  console.log(
    `${item.ticker.padEnd(9)} ${item.market}  righe=${rows.filter((r) => r.symbol === item.ticker).length}  ` +
      `emessi=${rows.filter((r) => r.symbol === item.ticker && r.emitted).length}  ` +
      `(+${((Date.now() - t0) / 1000).toFixed(0)}s)`
  );
}

// esiti: mark a orizzonte fisso + R realizzato (stop/T1/ora)
const barsBySymbol = new Map<string, Bar[]>();
for (const sym of new Set(rows.map((r) => r.symbol))) {
  try {
    barsBySymbol.set(sym, (await loadSeries(sym)).bars);
  } catch {
    // senza barre l'esito resta null
  }
}
for (const r of rows) {
  const bars = barsBySymbol.get(r.symbol);
  if (bars === undefined) continue;
  const dir: 1 | -1 = r.direction === 'SHORT' ? -1 : 1;
  if (r.entry != null && r.stop != null && r.target != null) {
    const exit = closeAt(bars, r.decisionTs + HORIZON_SEC);
    r.markR = exit == null ? null : (dir * (exit - r.entry)) / Math.abs(r.entry - r.stop);
    r.realized = realizedR(bars, r.decisionTs, dir, r.entry, r.stop, r.target, HORIZON_SEC);
    const end = r.decisionTs + HORIZON_SEC;
    r.stopped = bars.some(
      (b) => b.t > r.decisionTs && b.t <= end && (dir === 1 ? b.l <= r.stop! : b.h >= r.stop!)
    );
  }
  if (r.hypEntry != null && r.hypStop != null && r.hypTarget != null) {
    const hypDir: 1 | -1 = r.hypDirection === 'SHORT' ? -1 : 1;
    r.hypRealized = realizedR(
      bars,
      r.decisionTs,
      hypDir,
      r.hypEntry,
      r.hypStop,
      r.hypTarget,
      HORIZON_SEC
    );
  }
}

const guarded = applyEmissionGuard(
  rows.map((r) => ({
    ...r,
    direction: r.direction,
    entry: r.entry,
    stop: r.stop,
    target: r.target,
    gates: r.gates,
    reason: r.reason,
  }))
) as Row[];

const emitted = guarded.filter((r) => r.emitted);

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

console.log(`\n=== PANIERE ${selected.length} titoli — ${DAYS} sedute, passo ${STEP_MIN} min ===`);
console.log(`valutazioni=${guarded.length}  emessi=${emitted.length}  mancanti=${missing.length}`);
if (missing.length) console.log(`mancanti: ${missing.join(' | ')}`);
for (const market of ['EU', 'US'] as const) {
  const m = guarded.filter((r) => r.market === market);
  const e = m.filter((r) => r.emitted);
  console.log(
    `\n${market}: valutazioni=${m.length} emessi=${e.length} ` +
      `realizzato ${fmt(stats(e.map((r) => r.realized)))} stop=${(
        (e.filter((r) => r.stopped).length / Math.max(1, e.length)) * 100
      ).toFixed(0)}%`
  );
  const reasons = new Map<string, number>();
  for (const r of m) if (!r.emitted) reasons.set(r.blockedGate ?? 'n/d', (reasons.get(r.blockedGate ?? 'n/d') ?? 0) + 1);
  console.log(
    `  blocchi: ${[...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')}`
  );
}

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      days: DAYS,
      stepMin: STEP_MIN,
      horizonSec: HORIZON_SEC,
      basket: selected.map((s) => s.ticker),
      missing,
      evaluations: guarded.length,
      emitted: emitted.length,
      rows: guarded,
    },
    null,
    1
  )}\n`
);
console.log(`\nscritto ${OUT}`);
