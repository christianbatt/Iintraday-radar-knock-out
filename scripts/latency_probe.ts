#!/usr/bin/env bun
/**
 * scripts/latency_probe.ts — Passo H-bis / I1 (v2)
 *
 * Sei modifiche rispetto alla v1:
 *  1. probeApp usa POST (la v1 usava GET su un endpoint POST -> 404).
 *  2. sessionOpen e' salvato in OGNI campione; il verdetto si calcola SOLO sui
 *     campioni in sessione, e i due blocchi sono stampati separatamente.
 *  3. Ogni campione salva exchangeDataDelayedBy, exchangeTimezoneName, currency,
 *     marketState (null se assenti).
 *  4. --pairs=A:B,C:D registra per ogni coppia i due quoteTs, il delta in secondi
 *     e la distanza percentuale fra i due lastPrice.
 *  5. distinctPrices si conta solo sui campioni in sessione.
 *  6. Exit code: 0 se >=20 campioni in sessione, 4 se 1..19, 3 se 0.
 *
 * Uso:
 *   bun scripts/latency_probe.ts --interval=30
 *   bun scripts/latency_probe.ts --pairs=ENI.MI:ENIM.XD,UCG.MI:UCGM.XD
 *   bun scripts/latency_probe.ts --app-base=http://localhost:3000 --app-body='{"tickers":["ENI.MI"]}'
 *
 * Output:
 *   artifacts/latency_<YYYY-MM-DD>.jsonl
 *   artifacts/latency_<YYYY-MM-DD>.summary.json
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_SYMBOLS = [
  'STMMI.MI', 'LDO.MI', 'ENI.MI', 'ENEL.MI', 'ISP.MI',
  'RACE.MI', 'UCG.MI', 'STLAM.MI', 'BAMI.MI',
  'SAP.DE', 'RHM.DE', 'SIE.DE', 'MBG.DE', 'ALV.DE', 'NOV.DE', 'BAYN.DE',
];

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const SYMBOLS = arg('symbols', DEFAULT_SYMBOLS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const PAIRS = arg('pairs', '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.includes(':'))
  .map((s) => {
    const idx = s.indexOf(':');
    return { a: s.slice(0, idx).trim(), b: s.slice(idx + 1).trim() };
  });

const ALL: string[] = [];
for (const s of SYMBOLS) if (!ALL.includes(s)) ALL.push(s);
for (const p of PAIRS) {
  if (!ALL.includes(p.a)) ALL.push(p.a);
  if (!ALL.includes(p.b)) ALL.push(p.b);
}

const INTERVAL_SEC = Number(arg('interval', '30'));
const DURATION_SEC = Number(arg('duration', '0'));
const TIMEOUT_MS = Number(arg('timeout', '10000'));
const APP_BASE = arg('app-base', '');
const APP_BODY = arg('app-body', '');
const OUT = arg('out', `artifacts/latency_${new Date().toISOString().slice(0, 10)}.jsonl`);
const SUMMARY_OUT = OUT.replace(/\.jsonl$/, '.summary.json');

const STALE_THRESHOLD_SEC = 300;
const MIN_IN_SESSION = 20;

type Sample = {
  ts: string;
  symbol: string;
  sessionOpen: boolean;
  httpStatus: number;
  quoteTs: number | null;
  ageSec: number | null;
  lastPrice: number | null;
  barTs: number | null;
  barAgeSec: number | null;
  delayedBy: number | null;
  tz: string | null;
  currency: string | null;
  marketState: string | null;
  appStatus: number | null;
  appBytes: number | null;
  appAsOf: string | null;
  err: string | null;
};

type PairRow = {
  ts: string;
  a: string;
  b: string;
  aQuoteTs: number | null;
  bQuoteTs: number | null;
  deltaSec: number | null;
  aPrice: number | null;
  bPrice: number | null;
  pctDist: number | null;
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function yahooUrl(symbol: string): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
}

function romeClock(): { minutes: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    dow: dows.indexOf(get('weekday')),
  };
}

function sessionOpen(): boolean {
  const { minutes, dow } = romeClock();
  return dow >= 1 && dow <= 5 && minutes >= 540 && minutes <= 1050;
}

async function probeApp(): Promise<{ status: number; bytes: number; asOf: string | null }> {
  if (APP_BODY.length === 0) {
    return { status: 0, bytes: 0, asOf: null };
  }
  try {
    const res = await fetch(`${APP_BASE}/api/market-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: APP_BODY,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let asOf: string | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isObj(parsed)) {
        asOf =
          str(parsed.asOf) ??
          str(parsed.timestamp) ??
          str(parsed.generatedAt) ??
          str(parsed.lastUpdate);
        if (asOf === null && Array.isArray(parsed.data)) {
          const first = parsed.data.length > 0 ? parsed.data[0] : null;
          if (isObj(first)) asOf = str(first.timestamp);
        }
      }
    } catch {
      asOf = null;
    }
    return { status: res.status, bytes: text.length, asOf };
  } catch {
    return { status: 0, bytes: 0, asOf: null };
  }
}

async function probeOne(symbol: string): Promise<Sample> {
  const nowMs = Date.now();
  const ts = new Date(nowMs).toISOString();
  const inSession = sessionOpen();
  const base: Sample = {
    ts,
    symbol,
    sessionOpen: inSession,
    httpStatus: 0,
    quoteTs: null,
    ageSec: null,
    lastPrice: null,
    barTs: null,
    barAgeSec: null,
    delayedBy: null,
    tz: null,
    currency: null,
    marketState: null,
    appStatus: null,
    appBytes: null,
    appAsOf: null,
    err: null,
  };

  let sample: Sample = base;

  try {
    const res = await fetch(yahooUrl(symbol), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; latency-probe/2.0)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      sample = { ...base, httpStatus: res.status, err: `HTTP ${res.status}` };
    } else {
      const json: unknown = await res.json();
      const chart = isObj(json) ? json.chart : undefined;
      const results = isObj(chart) ? chart.result : undefined;
      const first = Array.isArray(results) && isObj(results[0]) ? results[0] : null;
      const meta = first !== null && isObj(first.meta) ? first.meta : null;

      const quoteTs = meta === null ? null : num(meta.regularMarketTime);
      const lastPrice = meta === null ? null : num(meta.regularMarketPrice);
      const delayedBy = meta === null ? null : num(meta.exchangeDataDelayedBy);
      const tz = meta === null ? null : str(meta.exchangeTimezoneName);
      const currency = meta === null ? null : str(meta.currency);
      const marketState = meta === null ? null : str(meta.marketState);

      const rawStamps = first !== null && Array.isArray(first.timestamp) ? first.timestamp : [];
      const indicators = first !== null && isObj(first.indicators) ? first.indicators : null;
      const quoteArr =
        indicators !== null && Array.isArray(indicators.quote) ? indicators.quote : [];
      const q0 = quoteArr.length > 0 && isObj(quoteArr[0]) ? quoteArr[0] : null;
      const closes = q0 !== null && Array.isArray(q0.close) ? q0.close : [];

      let barTs: number | null = null;
      for (let i = rawStamps.length - 1; i >= 0; i -= 1) {
        const t = num(rawStamps[i]);
        const c = num(closes[i]);
        if (t !== null && c !== null) {
          barTs = t;
          break;
        }
      }

      const nowSec = Math.floor(nowMs / 1000);
      sample = {
        ...base,
        httpStatus: res.status,
        quoteTs,
        ageSec: quoteTs === null ? null : nowSec - quoteTs,
        lastPrice,
        barTs,
        barAgeSec: barTs === null ? null : nowSec - barTs,
        delayedBy,
        tz,
        currency,
        marketState,
      };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    sample = { ...base, err: msg };
  }

  if (APP_BASE.length > 0 && APP_BODY.length > 0) {
    const app = await probeApp();
    sample = { ...sample, appStatus: app.status, appBytes: app.bytes, appAsOf: app.asOf };
  }

  return sample;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function pad(v: string | number | null, width: number): string {
  const s = v === null ? '-' : String(v);
  return s.padStart(width);
}

function round(v: number | null, digits: number): number | null {
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

const samples: Sample[] = [];
const pairRows: PairRow[] = [];
let stop = false;

process.on('SIGINT', () => {
  stop = true;
});

function buildPairRows(batch: Sample[]): PairRow[] {
  const rows: PairRow[] = [];
  for (const p of PAIRS) {
    const a = batch.find((s) => s.symbol === p.a);
    const b = batch.find((s) => s.symbol === p.b);
    if (a === undefined || b === undefined) continue;
    const deltaSec =
      a.quoteTs !== null && b.quoteTs !== null ? a.quoteTs - b.quoteTs : null;
    const pctDist =
      a.lastPrice !== null && b.lastPrice !== null && b.lastPrice !== 0
        ? ((a.lastPrice - b.lastPrice) / b.lastPrice) * 100
        : null;
    rows.push({
      ts: a.ts,
      a: p.a,
      b: p.b,
      aQuoteTs: a.quoteTs,
      bQuoteTs: b.quoteTs,
      deltaSec,
      aPrice: a.lastPrice,
      bPrice: b.lastPrice,
      pctDist: round(pctDist, 4),
    });
  }
  return rows;
}

function statsBlock(rows: Sample[], title: string): {
  title: string;
  lines: string[];
  worstMedian: number | null;
  frozen: string[];
} {
  const lines: string[] = [];
  const perSymbol: {
    symbol: string;
    n: number;
    nErr: number;
    median: number | null;
    p90: number | null;
    max: number | null;
    pctOver: number | null;
    barMed: number | null;
    distinct: number;
  }[] = [];

  for (const sym of ALL) {
    const all = rows.filter((s) => s.symbol === sym);
    if (all.length === 0) continue;
    const ages = all
      .map((s) => s.ageSec)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const barAges = all
      .map((s) => s.barAgeSec)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const prices = new Set(all.map((s) => s.lastPrice).filter((v): v is number => v !== null));
    const over = ages.filter((v) => v > STALE_THRESHOLD_SEC).length;
    perSymbol.push({
      symbol: sym,
      n: all.length,
      nErr: all.filter((s) => s.err !== null).length,
      median: percentile(ages, 50),
      p90: percentile(ages, 90),
      max: ages.length > 0 ? ages[ages.length - 1] : null,
      pctOver: ages.length > 0 ? Math.round((over / ages.length) * 1000) / 10 : null,
      barMed: percentile(barAges, 50),
      distinct: prices.size,
    });
  }

  lines.push(title);
  if (perSymbol.length === 0) {
    lines.push('  (nessun campione)');
    return { title, lines, worstMedian: null, frozen: [] };
  }
  lines.push('  simbolo      n  err  mediana   p90     max  %>300s  barMed  prezzi');
  for (const r of perSymbol) {
    lines.push(
      `  ${r.symbol.padEnd(10)}${pad(r.n, 4)}${pad(r.nErr, 5)}${pad(r.median, 8)}` +
        `${pad(r.p90, 6)}${pad(r.max, 8)}${pad(r.pctOver, 8)}` +
        `${pad(r.barMed, 8)}${pad(r.distinct, 8)}`,
    );
  }
  const medians = perSymbol.map((r) => r.median).filter((v): v is number => v !== null);
  const worstMedian = medians.length > 0 ? Math.max(...medians) : null;
  const frozen = perSymbol.filter((r) => r.distinct === 1 && r.n > 5).map((r) => r.symbol);
  return { title, lines, worstMedian, frozen };
}

async function main(): Promise<void> {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, '');

  const header = {
    kind: 'header',
    startedAt: new Date().toISOString(),
    symbols: ALL,
    pairs: PAIRS,
    intervalSec: INTERVAL_SEC,
    durationSec: DURATION_SEC,
    endpoint: 'yahoo-chart-v8-5m',
    appBase: APP_BASE.length > 0 ? APP_BASE : null,
    appBodyProvided: APP_BODY.length > 0,
    sessionOpen: sessionOpen(),
  };
  appendFileSync(OUT, `${JSON.stringify(header)}\n`);

  if (!header.sessionOpen) {
    console.log('ATTENZIONE: sessione chiusa (atteso 09:00-17:30 CET, lun-ven).');
    console.log('I campioni raccolti ora finiscono nel blocco "fuori sessione" e NON');
    console.log('producono alcun verdetto. Exit code atteso: 3.');
  }
  console.log(`simboli: ${ALL.join(' ')}`);
  if (PAIRS.length > 0) {
    console.log(`coppie: ${PAIRS.map((p) => `${p.a}:${p.b}`).join(' ')}`);
  }
  console.log(`intervallo: ${INTERVAL_SEC}s  durata: ${DURATION_SEC === 0 ? 'fino a Ctrl-C' : `${DURATION_SEC}s`}`);
  console.log(`output: ${OUT}`);

  const startedAt = Date.now();

  while (!stop) {
    const batch = await Promise.all(ALL.map(probeOne));
    for (const s of batch) {
      samples.push(s);
      appendFileSync(OUT, `${JSON.stringify(s)}\n`);
    }
    const pr = buildPairRows(batch);
    for (const r of pr) {
      pairRows.push(r);
      appendFileSync(OUT, `${JSON.stringify({ kind: 'pair', ...r })}\n`);
    }
    const line = batch
      .map((s) => `${s.symbol}:${s.ageSec === null ? (s.err === null ? '?' : 'ERR') : `${s.ageSec}s`}`)
      .join('  ');
    console.log(`[${new Date().toISOString()}] ${line}`);

    if (DURATION_SEC > 0 && (Date.now() - startedAt) / 1000 >= DURATION_SEC) break;
    if (stop) break;
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
  }

  const inSession = samples.filter((s) => s.sessionOpen);
  const outSession = samples.filter((s) => !s.sessionOpen);

  const blockIn = statsBlock(inSession, '=== IN SESSIONE ===');
  const blockOut = statsBlock(outSession, '=== FUORI SESSIONE (non produce verdetto) ===');

  console.log('');
  for (const l of blockIn.lines) console.log(l);
  console.log('');
  for (const l of blockOut.lines) console.log(l);

  console.log('');
  if (inSession.length < MIN_IN_SESSION) {
    console.log(
      `NESSUN VERDETTO: ${inSession.length} campioni in sessione (minimo ${MIN_IN_SESSION}).`,
    );
    console.log('Il ritardo non e\' valutabile con questi dati. Rilancia a mercato aperto.');
  } else if (blockIn.worstMedian === null) {
    console.log('NESSUN VERDETTO: campioni in sessione senza eta\' valida.');
  } else if (blockIn.worstMedian <= STALE_THRESHOLD_SEC) {
    console.log(
      `VERDETTO: mediana massima in sessione ${blockIn.worstMedian}s <= ${STALE_THRESHOLD_SEC}s. Ritardo non materiale.`,
    );
  } else {
    console.log(
      `VERDETTO: mediana massima in sessione ${blockIn.worstMedian}s > ${STALE_THRESHOLD_SEC}s. Ritardo materiale.`,
    );
  }
  if (blockIn.frozen.length > 0) {
    console.log(`ATTENZIONE: prezzo invariato in sessione per ${blockIn.frozen.join(', ')}.`);
  }

  if (pairRows.length > 0) {
    const withDelta = pairRows.filter((r) => r.deltaSec !== null);
    console.log('');
    console.log('=== COPPIE .MI vs .XD ===');
    console.log('  coppia                    n  deltaMed(s)  deltaMin  deltaMax  distMed(%)');
    for (const p of PAIRS) {
      const rows = withDelta.filter((r) => r.a === p.a && r.b === p.b);
      if (rows.length === 0) {
        console.log(`  ${`${p.a}:${p.b}`.padEnd(24)}  0  (nessun campione)`);
        continue;
      }
      const deltas = rows.map((r) => r.deltaSec).filter((v): v is number => v !== null).sort((a, b) => a - b);
      const dists = rows.map((r) => r.pctDist).filter((v): v is number => v !== null).sort((a, b) => a - b);
      console.log(
        `  ${`${p.a}:${p.b}`.padEnd(24)}${pad(rows.length, 3)}${pad(percentile(deltas, 50), 12)}` +
          `${pad(deltas.length > 0 ? deltas[0] : null, 10)}` +
          `${pad(deltas.length > 0 ? deltas[deltas.length - 1] : null, 10)}` +
          `${pad(percentile(dists, 50), 11)}`,
      );
    }
    console.log('  delta positivo = .MI piu\' fresco di .XD; negativo = .XD piu\' fresco.');
  }

  const delayed = inSession.filter((s) => s.delayedBy !== null);
  console.log('');
  if (delayed.length === 0) {
    console.log('exchangeDataDelayedBy: assente su tutti i campioni in sessione.');
  } else {
    const uniq = Array.from(new Set(delayed.map((s) => `${s.symbol}=${s.delayedBy}`)));
    console.log(`exchangeDataDelayedBy osservato: ${uniq.join(' ')}`);
  }

  const summary = {
    kind: 'summary',
    finishedAt: new Date().toISOString(),
    intervalSec: INTERVAL_SEC,
    staleThresholdSec: STALE_THRESHOLD_SEC,
    minInSession: MIN_IN_SESSION,
    inSessionSamples: inSession.length,
    outSessionSamples: outSession.length,
    inSessionWorstMedianSec: blockIn.worstMedian,
    inSessionFrozen: blockIn.frozen,
    pairs: PAIRS,
    pairSamples: pairRows.length,
  };
  writeFileSync(SUMMARY_OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`riepilogo scritto in ${SUMMARY_OUT}`);

  if (inSession.length >= MIN_IN_SESSION) process.exit(0);
  if (inSession.length === 0) process.exit(3);
  process.exit(4);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
