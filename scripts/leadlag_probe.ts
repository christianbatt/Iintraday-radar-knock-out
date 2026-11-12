#!/usr/bin/env bun
/**
 * scripts/leadlag_probe.ts — Passo H-bis / I4 (v2)
 *
 * Due correzioni rispetto alla v1:
 *  1. --window=15:30-17:30 (CET): la v1 correlava l'intera sessione, non la
 *     finestra di sovrapposizione con New York.
 *  2. Criterio di affidabilita': un lag e' credibile solo se
 *     corr(lag) >= --min-abs-corr (default 0.30) ASSOLUTO
 *     E corr(lag) - corr(0) >= --min-delta (default 0.05).
 *     Il criterio v1 (solo il delta) promuoveva rumore quando corr(0) era
 *     negativa: il caso ENI, lag 125 min con corr 0.053.
 *
 * Uso:
 *   bun scripts/leadlag_probe.ts --targets=ENI.MI,UCG.MI --proxy=EWI --range=30d
 *
 * Output: artifacts/leadlag_<data>.json. Non committare.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Bar = { t: number; c: number };

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const TARGETS = arg('targets', 'ENI.MI,UCG.MI')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const PROXY = arg('proxy', 'EWI');
const RANGE = arg('range', '30d');
const WINDOW = arg('window', '15:30-17:30');
const MAX_LAG_BARS = Number(arg('max-lag', '40'));
const MIN_ABS_CORR = Number(arg('min-abs-corr', '0.30'));
const MIN_DELTA = Number(arg('min-delta', '0.05'));
const DIV_WINDOW_BARS = Number(arg('div-window', '6'));
const DIV_PROXY_PCT = Number(arg('div-proxy-pct', '1.5'));
const DIV_TARGET_PCT = Number(arg('div-target-pct', '0.3'));
const TIMEOUT_MS = Number(arg('timeout', '20000'));
const OUT = arg('out', `artifacts/leadlag_${new Date().toISOString().slice(0, 10)}.json`);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function round(v: number | null, digits: number): number | null {
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function parseWindow(w: string): { startMin: number; endMin: number } {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(w.trim());
  if (m === null) return { startMin: 930, endMin: 1050 };
  return {
    startMin: Number(m[1]) * 60 + Number(m[2]),
    endMin: Number(m[3]) * 60 + Number(m[4]),
  };
}

const WIN = parseWindow(WINDOW);

function romeMinutes(tsSec: number): { minutes: number; dow: number } {
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

function inWindow(tsSec: number): boolean {
  const { minutes, dow } = romeMinutes(tsSec);
  if (dow < 1 || dow > 5) return false;
  return minutes >= WIN.startMin && minutes <= WIN.endMin;
}

async function fetchBars(symbol: string): Promise<Bar[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=5m&range=${RANGE}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; leadlag-probe/2.0)',
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
  const closes = Array.isArray(q0.close) ? q0.close : [];
  const out: Bar[] = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const t = num(stamps[i]);
    const c = num(closes[i]);
    if (t === null || c === null || c <= 0) continue;
    out.push({ t, c });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 10) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

async function main(): Promise<void> {
  console.log(`proxy: ${PROXY}  target: ${TARGETS.join(' ')}  range: ${RANGE}`);
  console.log(`finestra: ${WINDOW} CET  min-abs-corr: ${MIN_ABS_CORR}  min-delta: ${MIN_DELTA}`);

  let proxyBars: Bar[];
  try {
    proxyBars = await fetchBars(PROXY);
  } catch (e: unknown) {
    console.log(`proxy ${PROXY} non risolve: ${e instanceof Error ? e.message : String(e)}`);
    console.log('H5 non eseguibile con questo proxy. Prova --proxy=...');
    process.exit(2);
  }
  const proxyWin = proxyBars.filter((b) => inWindow(b.t));
  console.log(`proxy ${PROXY}: ${proxyBars.length} barre totali, ${proxyWin.length} in finestra`);
  if (proxyWin.length < 50) {
    console.log('proxy con troppe poche barre in finestra: H5 non affidabile, mi fermo.');
    process.exit(2);
  }

  const proxyMap = new Map<number, number>();
  for (const b of proxyWin) proxyMap.set(b.t, b.c);

  const targetsOut: Record<string, unknown> = {};

  for (const sym of TARGETS) {
    let bars: Bar[];
    try {
      bars = await fetchBars(sym);
    } catch (e: unknown) {
      console.log(`  ${sym}: ERRORE ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const aligned: { t: number; target: number; proxy: number }[] = [];
    for (const b of bars) {
      if (!inWindow(b.t)) continue;
      const p = proxyMap.get(b.t);
      if (p !== undefined) aligned.push({ t: b.t, target: b.c, proxy: p });
    }
    if (aligned.length < 50) {
      console.log(`  ${sym}: solo ${aligned.length} barre allineate in finestra, salto`);
      continue;
    }

    const rTarget: number[] = [];
    const rProxy: number[] = [];
    for (let i = 1; i < aligned.length; i += 1) {
      rTarget.push(Math.log(aligned[i].target / aligned[i - 1].target));
      rProxy.push(Math.log(aligned[i].proxy / aligned[i - 1].proxy));
    }

    const corr0 = pearson(rTarget, rProxy);
    let bestLag = 0;
    let bestCorr: number | null = corr0;
    for (let lag = 1; lag <= MAX_LAG_BARS; lag += 1) {
      if (rTarget.length - lag < 30) break;
      const xs = rTarget.slice(lag);
      const ys = rProxy.slice(0, rProxy.length - lag);
      const c = pearson(xs, ys);
      if (c !== null && (bestCorr === null || c > bestCorr)) {
        bestCorr = c;
        bestLag = lag;
      }
    }

    const divs: { t: string; proxyPct: number; targetPct: number }[] = [];
    for (let i = DIV_WINDOW_BARS; i < aligned.length; i += 1) {
      const pRet = (aligned[i].proxy / aligned[i - DIV_WINDOW_BARS].proxy - 1) * 100;
      const tRet = (aligned[i].target / aligned[i - DIV_WINDOW_BARS].target - 1) * 100;
      if (Math.abs(pRet) >= DIV_PROXY_PCT && Math.abs(tRet) < DIV_TARGET_PCT) {
        divs.push({
          t: new Date(aligned[i].t * 1000).toISOString(),
          proxyPct: round(pRet, 2) ?? 0,
          targetPct: round(tRet, 2) ?? 0,
        });
      }
    }

    const delta = corr0 !== null && bestCorr !== null ? bestCorr - corr0 : null;
    const trustworthy =
      bestLag > 0 &&
      bestCorr !== null &&
      bestCorr >= MIN_ABS_CORR &&
      delta !== null &&
      delta >= MIN_DELTA;

    console.log('');
    console.log(`  ${sym}`);
    console.log(`    barre allineate in finestra: ${aligned.length}`);
    console.log(`    corr lag 0: ${round(corr0, 3) ?? '-'}`);
    console.log(`    lag ottimo: ${bestLag} barre (${bestLag * 5} min)  corr: ${round(bestCorr, 3) ?? '-'}`);
    console.log(`    delta corr: ${round(delta, 3) ?? '-'}  (soglie: abs>=${MIN_ABS_CORR}, delta>=${MIN_DELTA})`);
    console.log(`    lag credibile: ${trustworthy ? 'SI' : 'NO'}`);
    console.log(`    divergenze proxy-su / target-fermo: ${divs.length}`);

    targetsOut[sym] = {
      alignedBarsInWindow: aligned.length,
      corr0: round(corr0, 3),
      bestLagBars: bestLag,
      bestLagMinutes: bestLag * 5,
      bestCorr: round(bestCorr, 3),
      corrDelta: round(delta, 3),
      minAbsCorr: MIN_ABS_CORR,
      minDelta: MIN_DELTA,
      trustworthy,
      divergenceCount: divs.length,
      divergenceExamples: divs.slice(0, 5),
    };
  }

  const report = {
    proxy: PROXY,
    range: RANGE,
    window: WINDOW,
    maxLagBars: MAX_LAG_BARS,
    minAbsCorr: MIN_ABS_CORR,
    minDelta: MIN_DELTA,
    targets: targetsOut,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log('');
  console.log(`report scritto in ${OUT}`);
  console.log('Nota: il proxy e\' un paniere in USD, non il sottostante. Un lag e\' credibile');
  console.log('solo se corr(lag) >= soglia assoluta E batte corr(0) in modo netto.');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
