/**
 * Passo X — copertura del volume 5m rispetto al volume giornaliero Yahoo.
 *
 * Solo dati: legge le barre 5m in cache, scarica le barre 1d Yahoo per gli
 * stessi simboli e confronta, giorno per giorno, volume 5m aggregato e volume
 * giornaliero. Non tocca src/, gate o soglie.
 *
 * Uso:
 *   bun scripts/liq_coverage.ts [--symbols=...] [--range=60d] [--out=artifacts/liq_coverage.json]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ART = 'artifacts';
const BARSD = join(ART, 'bars');
const ARGS = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const [k, ...v] = a.slice(2).split('=');
    ARGS.set(k, v.join('='));
  }
}
const SYMBOLS = (ARGS.get('symbols') ?? 'ENI.MI,UCG.MI,BAMI.MI,RHM.DE,SAP.DE,BAYN.DE,LDO.MI,SIE.DE,STLAM.MI').split(',').filter(Boolean);
const RANGE = ARGS.get('range') ?? '60d';
const OUT = ARGS.get('out') ?? join(ART, 'liq_coverage.json');
const KNOWN = ['ENI.MI', 'UCG.MI', 'BAMI.MI', 'RHM.DE', 'SAP.DE'];
const ADDED = ['BAYN.DE', 'LDO.MI', 'SIE.DE', 'STLAM.MI'];
const EXPECTED_BARS = 102;

type Bar5 = { t: number; o: number; h: number; l: number; c: number; v: number };
type DayRow = { date: string; barsVolume: number; barsCount: number; yahooVolume: number; yahooClose: number; ratio: number };
type Slot = { slot: string; daysPresent: number; volume: number; bars: number };

function dayInTz(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts * 1000));
}
function slotInTz(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts * 1000));
}
function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

async function fetchDaily(sym: string): Promise<{ tz: string; days: Map<string, { volume: number; close: number }> }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${encodeURIComponent(RANGE)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${sym}`);
  const j: any = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`no chart result for ${sym}`);
  const tz = r.meta?.exchangeTimezoneName || 'Europe/Rome';
  const ts: number[] = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const days = new Map<string, { volume: number; close: number }>();
  for (let i = 0; i < ts.length; i++) {
    const v = q.volume?.[i];
    const c = q.close?.[i];
    if (typeof v !== 'number' || typeof c !== 'number') continue;
    days.set(dayInTz(ts[i], tz), { volume: v, close: c });
  }
  return { tz, days };
}

const result: any[] = [];
for (const sym of SYMBOLS) {
  const p = join(BARSD, `${sym}_30d.json`);
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  const bars = JSON.parse(readFileSync(p, 'utf8')) as Bar5[];
  const { tz, days: ydays } = await fetchDaily(sym);
  const byDay = new Map<string, Bar5[]>();
  for (const b of bars) {
    const d = dayInTz(b.t, tz);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(b);
  }
  const rows: DayRow[] = [];
  for (const [date, dayBars] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const y = ydays.get(date);
    if (!y) continue;
    const barsVolume = dayBars.reduce((a, b) => a + b.v, 0);
    rows.push({
      date,
      barsVolume,
      barsCount: dayBars.length,
      yahooVolume: y.volume,
      yahooClose: y.close,
      ratio: y.volume > 0 ? barsVolume / y.volume : 0,
    });
  }
  const ratios = rows.map(r => r.ratio);
  const slots = new Map<string, Slot>();
  const slotDays = new Map<string, Set<string>>();
  for (const [date, dayBars] of byDay) {
    for (const b of dayBars) {
      const slot = slotInTz(b.t, tz);
      if (!slots.has(slot)) {
        slots.set(slot, { slot, daysPresent: 0, volume: 0, bars: 0 });
        slotDays.set(slot, new Set());
      }
      const s = slots.get(slot)!;
      s.volume += b.v;
      s.bars++;
      slotDays.get(slot)!.add(date);
    }
  }
  for (const s of slots.values()) s.daysPresent = slotDays.get(s.slot)!.size;
  const slotList = [...slots.values()].sort((a, b) => a.slot.localeCompare(b.slot));
  result.push({
    symbol: sym,
    group: KNOWN.includes(sym) ? 'known' : ADDED.includes(sym) ? 'added' : 'other',
    timezone: tz,
    days: rows,
    stats: {
      nDays: rows.length,
      median: ratios.length ? quantile(ratios, 0.5) : null,
      min: ratios.length ? Math.min(...ratios) : null,
      max: ratios.length ? Math.max(...ratios) : null,
      shareIn060_075: ratios.length ? ratios.filter(r => r >= 0.60 && r <= 0.75).length / ratios.length : null,
      meanBars: rows.length ? mean(rows.map(r => r.barsCount)) : null,
      expectedBars: EXPECTED_BARS,
      daysBelowExpectedBars: rows.filter(r => r.barsCount < EXPECTED_BARS).length,
    },
    slots: slotList,
    firstDate: rows[0]?.date ?? null,
    lastDate: rows[rows.length - 1]?.date ?? null,
  });
  console.error(`${sym}: ${rows.length} giorni, mediana ${ratios.length ? quantile(ratios, 0.5).toFixed(4) : 'n/a'}, barre medie ${rows.length ? mean(rows.map(r => r.barsCount)).toFixed(1) : 'n/a'}`);
}

writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  range: RANGE,
  expectedBars: EXPECTED_BARS,
  symbols: result,
}, null, 2) + '\n');
console.log(`scritto ${OUT}`);
