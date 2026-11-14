/**
 * Passo X — valori giornalieri "veri" da Yahoo 1d.
 *
 * Scarica barre 1d per i simboli, calcola adr14 e liqEur20d sulle ultime 20
 * sedute (stessa formula del server) e, per i soli 4 aggiunti, li scrive in uno
 * snapshot. I 5 noti sono usati solo per validare la funzione contro la fixture.
 *
 * Uso:
 *   bun scripts/daily_true.ts [--symbols=...] [--range=60d]
 *     [--out=artifacts/daily_true.json]
 *     [--snapshot=artifacts/snapshot_9_daily3.json]
 *     [--snapshotOut=artifacts/snapshot_9_dailyx.json]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ART = 'artifacts';
const ARGS = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const [k, ...v] = a.slice(2).split('=');
    ARGS.set(k, v.join('='));
  }
}
const SYMBOLS = (ARGS.get('symbols') ?? 'ENI.MI,UCG.MI,BAMI.MI,RHM.DE,SAP.DE,BAYN.DE,LDO.MI,SIE.DE,STLAM.MI').split(',').filter(Boolean);
const RANGE = ARGS.get('range') ?? '60d';
const ADR_DAYS = Number(ARGS.get('adrDays') ?? '14');
const OUT = ARGS.get('out') ?? join(ART, 'daily_true.json');
const SNAP_IN = ARGS.get('snapshot') ?? join(ART, 'snapshot_9_daily3.json');
const SNAP_OUT = ARGS.get('snapshotOut') ?? join(ART, 'snapshot_9_dailyx.json');
const APPLY = ARGS.get('apply') ?? 'added';
const KNOWN = ['ENI.MI', 'UCG.MI', 'BAMI.MI', 'RHM.DE', 'SAP.DE'];
const ADDED = ['BAYN.DE', 'LDO.MI', 'SIE.DE', 'STLAM.MI'];

type Daily = { date: string; high: number; low: number; close: number; volume: number };
type TrueRow = { symbol: string; adr14: number; liqEur20d: number; avgVolume20d: number; days: number; first: string; last: string; source: string };

function dayInTz(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts * 1000));
}
function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }

async function fetchDaily(sym: string): Promise<{ tz: string; currency: string; rows: Daily[] }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${encodeURIComponent(RANGE)}`;
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
    const h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (typeof h !== 'number' || typeof l !== 'number' || typeof c !== 'number' || typeof v !== 'number') continue;
    rows.push({ date: dayInTz(ts[i], tz), high: h, low: l, close: c, volume: v });
  }
  return { tz, currency, rows };
}

const out: TrueRow[] = [];
const snap = existsSync(SNAP_IN) ? JSON.parse(readFileSync(SNAP_IN, 'utf8')) as { quotes: Array<any> } : null;
for (const sym of SYMBOLS) {
  const { tz, currency, rows } = await fetchDaily(sym);
  // Allineamento alla finestra del replay: ultima data delle barre in cache.
  const barsPath = join(ART, 'bars', `${sym}_30d.json`);
  let lastDate = rows[rows.length - 1]?.date ?? '';
  if (existsSync(barsPath)) {
    const bars = JSON.parse(readFileSync(barsPath, 'utf8')) as Array<{ t: number }>;
    if (bars.length) {
      const lastBar = bars.reduce((a, b) => (a.t > b.t ? a : b));
      lastDate = dayInTz(lastBar.t, tz);
    }
  }
  const window = rows.filter(r => r.date <= lastDate).slice(-20);
  if (window.length < 20) throw new Error(`${sym}: only ${window.length} daily bars up to ${lastDate}`);
  // Server: calculateAdr14FromBars usa 14 sedute; calculateLiqEurFromBars usa 20.
  const adrWindow = window.slice(-ADR_DAYS);
  const liqWindow = window.slice(-20);
  const adr14 = mean(adrWindow.map(r => r.high - r.low));
  const liq = mean(liqWindow.map(r => r.volume * r.close));
  const avgVol = mean(liqWindow.map(r => r.volume));
  out.push({ symbol: sym, adr14, liqEur20d: liq, avgVolume20d: avgVol, days: 20, first: window[0].date, last: window[window.length - 1].date, source: `Yahoo 1d ${currency} ${tz}` });
  console.log(`${sym}: adr14=${adr14.toFixed(6)} liq=${liq.toFixed(0)} days=${window.length} ${window[0].date}..${window[window.length - 1].date}`);
}

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), range: RANGE, symbols: out }, null, 2) + '\n');
console.log(`scritto ${OUT}`);

if (snap) {
  for (const sym of (APPLY === 'all' ? SYMBOLS : ADDED)) {
    const t = out.find(x => x.symbol === sym);
    if (!t) throw new Error(`missing true row ${sym}`);
    const q = snap.quotes.find(x => x.ticker === sym);
    if (!q) throw new Error(`missing snapshot quote ${sym}`);
    const oldAdr = q.adr14, oldLiq = q.liqEur20d;
    q.adr14 = t.adr14;
    q.liqEur20d = t.liqEur20d;
    q.avgVolume20d = Math.round(t.avgVolume20d);
    console.log(`  apply ${sym}: adr ${oldAdr} -> ${t.adr14.toFixed(6)} ; liq ${oldLiq} -> ${t.liqEur20d.toFixed(0)}`);
  }
  writeFileSync(SNAP_OUT, JSON.stringify(snap, null, 2) + '\n');
  console.log(`scritto ${SNAP_OUT}`);
}

const truth = JSON.parse(readFileSync('src/utils/__tests__/fixtures/pipeline_snapshot.json', 'utf8')) as { quotes: Array<{ ticker: string; adr14: number; liqEur20d: number }> };
console.log('validazione 5 noti: daily_true / fixture');
for (const sym of KNOWN) {
  const t = out.find(x => x.symbol === sym)!;
  const f = truth.quotes.find(q => q.ticker === sym)!;
  console.log(`  ${sym} adr ${t.adr14.toFixed(6)} vs ${f.adr14.toFixed(6)} ratio ${(t.adr14 / f.adr14).toFixed(4)} ; liq ratio ${(t.liqEur20d / f.liqEur20d).toFixed(4)}`);
}
