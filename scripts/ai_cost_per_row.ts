/**
 * QUANTO VALE IL COSTO PER RIGA SUI DATI REALI (Fase 6.1, misura).
 *
 * Legge le sole fonti che esistono in `artifacts/shadow_v1_live/` e calcola il
 * costo di ogni esito con `resolveTradeCost`, la stessa funzione che usa la
 * calibrazione: nessuna formula duplicata qui.
 *
 * Popolazioni:
 * - `signals.jsonl`: setup emessi (hanno `entry` / `stop`);
 * - `near_miss.jsonl`: setup bloccati da un gate (`entryLevel` / `stopLossLevel`);
 * - `rejected.jsonl`: altri scarti (`entryLevel` / `stopLossLevel`).
 *
 * Per ogni popolazione: distribuzione di `costSource`, costo medio/min/max,
 * quante righe hanno lo spread al PAVIMENTO di Corwin-Schultz (stima 0, cioe'
 * "non distinguibile da zero"), e la media alternativa che si otterrebbe
 * trattando quel pavimento come "non misurabile" (tetto dichiarato 0,16 R).
 * Le due medie sono il intervallo onesto: il costo per riga non e' un numero
 * solo.
 *
 * Deterministico e in sola lettura. Scrive solo il JSON del report in
 * `artifacts/audit/` (committabile). Uscita: tabella su stdout.
 */

import fs from 'node:fs';
import path from 'node:path';

import { corwinSchultzSpreadProxy, type KnowledgeBar } from '../src/knowledge/shadowAlgorithms';
import {
  AI_TRADE_COST_DECLARED_R,
  resolveTradeCost,
  type AiTradeCostSource,
} from '../src/server/aiTradeCost';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'artifacts', 'audit');
const OUT_PATH = path.join(OUT_DIR, 'cost-per-row-2026-11-28.json');

interface RawRecord {
  ticker?: unknown;
  status?: unknown;
  r?: unknown;
  entry?: unknown;
  stop?: unknown;
  entryLevel?: unknown;
  stopLossLevel?: unknown;
  fillBarTs?: unknown;
  decidedAtMs?: unknown;
}

function readJsonl(relativePath: string): RawRecord[] {
  const full = path.join(ROOT, relativePath);
  if (!fs.existsSync(full)) return [];
  return fs
    .readFileSync(full, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawRecord);
}

function readBarsByTicker(): Map<string, KnowledgeBar[]> {
  const full = path.join(ROOT, 'artifacts', 'shadow_v1_live', 'bars.json');
  const byTicker = new Map<string, KnowledgeBar[]>();
  if (!fs.existsSync(full)) return byTicker;
  const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as { entries?: unknown };
  const entries = Array.isArray(parsed.entries)
    ? parsed.entries
    : parsed.entries && typeof parsed.entries === 'object'
      ? Object.values(parsed.entries)
      : [];
  for (const entry of entries as Array<{ ticker?: unknown; bars?: unknown }>) {
    if (!entry || typeof entry.ticker !== 'string' || !Array.isArray(entry.bars)) continue;
    byTicker.set(entry.ticker, entry.bars as KnowledgeBar[]);
  }
  return byTicker;
}

function around(
  bars: readonly KnowledgeBar[] | undefined,
  fillBarTs: unknown
): KnowledgeBar[] | null {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  if (typeof fillBarTs !== 'number' || !Number.isFinite(fillBarTs)) return null;
  let index = -1;
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i].t <= fillBarTs) index = i;
    else break;
  }
  if (index < 1) return null;
  return [bars[index - 1], bars[index]];
}

const RESOLVED = new Set(['STOP', 'TARGET', 'EXPIRED']);

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

interface RowMeasurement {
  population: 'signals' | 'near_miss' | 'rejected';
  ticker: string | null;
  status: string;
  r: number;
  entry: number | null;
  stop: number | null;
  stopPct: number | null;
  corwinSchultz: number | null;
  costR: number;
  costSource: AiTradeCostSource;
  spreadAtFloor: boolean;
  rNet: number;
}

function measurePopulation(
  population: RowMeasurement['population'],
  records: RawRecord[],
  barsByTicker: Map<string, KnowledgeBar[]>
): RowMeasurement[] {
  const rows: RowMeasurement[] = [];
  for (const record of records) {
    if (typeof record.status !== 'string' || !RESOLVED.has(record.status)) continue;
    if (typeof record.r !== 'number' || !Number.isFinite(record.r)) continue;
    const ticker = typeof record.ticker === 'string' ? record.ticker : null;
    const entry = positive(record.entry) ?? positive(record.entryLevel);
    const stop = positive(record.stop) ?? positive(record.stopLossLevel);
    const bars = ticker ? around(barsByTicker.get(ticker), record.fillBarTs) : null;
    const cs = bars ? (corwinSchultzSpreadProxy(bars).at(-1) ?? null) : null;
    const cost = resolveTradeCost({ entry, stop, leverage: null, bars });
    rows.push({
      population,
      ticker,
      status: record.status,
      r: record.r,
      entry,
      stop,
      stopPct: cost.stopPct,
      corwinSchultz: cs,
      costR: cost.costR,
      costSource: cost.costSource,
      spreadAtFloor: cost.spreadAtFloor,
      rNet: Math.round((record.r - cost.costR) * 10_000) / 10_000,
    });
  }
  return rows;
}

function summarize(rows: RowMeasurement[]) {
  const costs = rows.map((row) => row.costR);
  const mean = (values: number[]) =>
    values.length > 0
      ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10_000) / 10_000
      : null;
  const bySource = new Map<string, number>();
  for (const row of rows) bySource.set(row.costSource, (bySource.get(row.costSource) ?? 0) + 1);
  const floor = rows.filter((row) => row.spreadAtFloor);
  // Media alternativa: il pavimento 0 trattato come "non misurabile" (tetto).
  const alt = rows.map((row) => (row.spreadAtFloor ? AI_TRADE_COST_DECLARED_R : row.costR));
  return {
    rows: rows.length,
    withBars: rows.filter((row) => row.corwinSchultz !== null).length,
    bySource: [...bySource.entries()].map(([source, count]) => ({ source, count })),
    meanCostR: mean(costs),
    minCostR: costs.length > 0 ? Math.min(...costs) : null,
    maxCostR: costs.length > 0 ? Math.max(...costs) : null,
    atFloorRows: floor.length,
    meanCostIfFloorIsUnmeasured: mean(alt),
    tradesBelowCost: rows.filter((row) => row.rNet < 0).length,
    meanRNet: mean(rows.map((row) => row.rNet)),
    sumRNet:
      rows.length > 0
        ? Math.round(rows.reduce((total, row) => total + row.rNet, 0) * 10_000) / 10_000
        : null,
    baselineMeanRNetAt036: mean(rows.map((row) => row.r - AI_TRADE_COST_DECLARED_R)),
    baselineSumRNetAt036:
      rows.length > 0
        ? Math.round(
            rows.reduce((total, row) => total + (row.r - AI_TRADE_COST_DECLARED_R), 0) * 10_000
          ) / 10_000
        : null,
  };
}

const barsByTicker = readBarsByTicker();
const populations: Array<{ name: RowMeasurement['population']; rows: RowMeasurement[] }> = [
  { name: 'signals', rows: measurePopulation('signals', readJsonl('artifacts/shadow_v1_live/signals.jsonl'), barsByTicker) },
  { name: 'near_miss', rows: measurePopulation('near_miss', readJsonl('artifacts/shadow_v1_live/near_miss.jsonl'), barsByTicker) },
  { name: 'rejected', rows: measurePopulation('rejected', readJsonl('artifacts/shadow_v1_live/rejected.jsonl'), barsByTicker) },
];

const summary = populations.map(({ name, rows }) => ({ population: name, ...summarize(rows) }));
const allRows = populations.flatMap((population) => population.rows);

console.log('== Costo per riga sui dati reali (artifacts/shadow_v1_live) ==');
console.log(`costo dichiarato di riferimento: ${AI_TRADE_COST_DECLARED_R} R`);
for (const row of summary) {
  console.log(
    `${row.population}: n=${row.rows} barre=${row.withBars} medio=${row.meanCostR} ` +
      `min=${row.minCostR} max=${row.maxCostR} pavimento0=${row.atFloorRows} ` +
      `(medio se il pavimento non e una misura: ${row.meanCostIfFloorIsUnmeasured}) ` +
      `fonti=${row.bySource.map((s) => `${s.source}:${s.count}`).join(',') || '—'} ` +
      `sottoCosto=${row.tradesBelowCost} sumRNet=${row.sumRNet}`
  );
}
const total = summarize(allRows);
console.log(`TOTALE: n=${total.rows} medio=${total.meanCostR} min=${total.minCostR} max=${total.maxCostR}`);
console.log(`  fonti: ${JSON.stringify(total.bySource)}`);
console.log(`  pavimento 0: ${total.atFloorRows} righe; media alternativa ${total.meanCostIfFloorIsUnmeasured} R`);
console.log(
  `  R netto medio ${total.meanRNet} (con 0,36 sarebbe ${total.baselineMeanRNetAt036}); ` +
    `somma ${total.sumRNet} (0,36: ${total.baselineSumRNetAt036})`
);

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  OUT_PATH,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: 'artifacts/shadow_v1_live/{signals,near_miss,rejected}.jsonl + bars.json',
      declaredCostR: AI_TRADE_COST_DECLARED_R,
      populations: summary,
      total,
    },
    null,
    2
  ) + '\n'
);
console.log(`report: ${path.relative(ROOT, OUT_PATH)}`);
