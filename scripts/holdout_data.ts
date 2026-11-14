/**
 * Passo Y — dati della finestra di holdout.
 *
 * Finestra scelta: 2026-08-24..2026-09-30 (28 sedute), la massima finestra
 * disgiunta da 2026-10-01..2026-11-11 ottenibile con Yahoo 5m range=60d.
 * Scarica 1d e 5m, calcola adr14 (14 sedute) e liqEur20d (20 sedute) con la
 * stessa formula del server, e scrive:
 *   artifacts/bars/<sym>_holdout.json
 *   artifacts/snapshot_9_holdout.json
 *
 * Uso: bun scripts/holdout_data.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ART = 'artifacts';
const START = '2026-08-24';
const END = '2026-09-30';
const SYMBOLS = ['ENI.MI', 'UCG.MI', 'BAMI.MI', 'RHM.DE', 'SAP.DE', 'BAYN.DE', 'LDO.MI', 'SIE.DE', 'STLAM.MI'];
const SNAP_IN = join(ART, 'snapshot_9_dailyx.json');
const SNAP_OUT = join(ART, 'snapshot_9_holdout.json');
const DATA_OUT = join(ART, 'holdout_data.json');
const BARS_DIR = join(ART, 'bars');

type Daily = { date: string; open: number; high: number; low: number; close: number; volume: number };
type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
function dayInTz(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ts * 1000));
}
function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }

async function fetchDaily(sym: string): Promise<{ tz: string; currency: string; rows: Daily[] }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=6mo`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${sym}`);
  const j: any = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`no chart result for ${sym}`);
  const tz = r.meta?.exchangeTimezoneName || 'Europe/Rome';
  const currency = r.meta?.currency || 'EUR';
  const ts: number[] = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const rows: Daily[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if ([o, h, l, c, v].some(x => typeof x !== 'number')) continue;
    rows.push({ date: dayInTz(ts[i], tz), open: o, high: h, low: l, close: c, volume: v });
  }
  return { tz, currency, rows };
}

async function fetchBars(sym: string): Promise<{ tz: string; bars: Bar[] }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=60d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${sym}`);
  const j: any = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`no chart result for ${sym}`);
  const tz = r.meta?.exchangeTimezoneName || 'Europe/Rome';
  const ts: number[] = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if ([o, h, l, c].some(x => typeof x !== 'number')) continue;
    const day = dayInTz(ts[i], tz);
    if (day < START || day > END) continue;
    bars.push({ t: ts[i], o, h, l, c, v: v ?? 0 });
  }
  bars.sort((a, b) => a.t - b.t);
  return { tz, bars };
}

if (!existsSync(SNAP_IN)) throw new Error(`missing ${SNAP_IN}`);
const snap = JSON.parse(readFileSync(SNAP_IN, 'utf8')) as { quotes: Array<any>; recordedAt?: string; capturedAt?: string };
const out: Array<any> = [];
for (const sym of SYMBOLS) {
  const { tz, currency, rows } = await fetchDaily(sym);
  const daily = rows.filter(r => r.date <= END);
  if (daily.length < 20) throw new Error(`${sym}: only ${daily.length} daily bars`);
  const w = daily.slice(-20);
  const adrWindow = w.slice(-14);
  const adr14 = mean(adrWindow.map(r => r.high - r.low));
  const liq = mean(w.map(r => r.volume * r.close));
  const avgVol = mean(w.map(r => r.volume));
  const last = w[w.length - 1];
  const prev = w[w.length - 2];
  const q = snap.quotes.find(x => x.ticker === sym);
  if (!q) throw new Error(`missing snapshot quote ${sym}`);
  q.adr14 = adr14;
  q.liqEur20d = Math.round(liq);
  q.avgVolume20d = Math.round(avgVol);
  q.prevClose = prev.close;
  q.currentPrice = last.close;
  q.todayOpen = last.open;
  q.todayHigh = last.high;
  q.todayLow = last.low;
  q.prevHigh = prev.high;
  q.prevLow = prev.low;
  q.completedBarsCount = 20;
  q.timestamp = `${END}T23:51:51.000Z`;
  const { bars } = await fetchBars(sym);
  writeFileSync(join(BARS_DIR, `${sym}_holdout.json`), `${JSON.stringify(bars)}\n`);
  out.push({ symbol: sym, adr14, liqEur20d: Math.round(liq), avgVolume20d: Math.round(avgVol), days: w.length, first: w[0].date, last: last.date, bars: bars.length, source: `Yahoo 1d/5m ${currency} ${tz}` });
  console.log(`${sym}: adr14=${adr14.toFixed(6)} liq=${liq.toFixed(0)} days=${w.length} ${w[0].date}..${last.date} bars5m=${bars.length}`);
}
snap.recordedAt = `${END}T23:51:51.000Z`;
snap.capturedAt = `${END}T23:51:51.000Z`;
writeFileSync(SNAP_OUT, JSON.stringify(snap, null, 2) + '\n');
writeFileSync(DATA_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), start: START, end: END, symbols: out }, null, 2) + '\n');
console.log(`scritto ${SNAP_OUT} e ${DATA_OUT}`);
