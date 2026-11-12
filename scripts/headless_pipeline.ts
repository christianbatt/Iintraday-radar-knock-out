#!/usr/bin/env bun
/**
 * scripts/headless_pipeline.ts — Passo H-bis / I0
 *
 * Harness comportamentale: riesegue la pipeline REALE (importata da src/, non
 * riscritta) su uno snapshot registrato, e produce un output canonico
 * confrontabile byte per byte.
 *
 * Catena riprodotta (App.tsx -> src/), nell'ordine effettivo:
 *   1. fetchMarketData            src/services/api.ts:88        (sostituita dallo snapshot)
 *   2. getDualTopCandidates       src/utils/calculator.ts:1589 (App.tsx:780)
 *      -> rankMarketCandidates   src/utils/calculator.ts:1468
 *      -> rankTopCandidates      src/utils/calculator.ts:1532
 *      -> calculateCandidateScore src/utils/calculator.ts:704
 *      -> isCandidateCompliantWithParameters src/utils/calculator.ts:1183
 *   3. buildExecutionSetup        src/utils/calculator.ts:1941 (App.tsx:907)
 *      -> checkQuoteStaleness    src/utils/calculator.ts:2124
 *      -> G13                    src/utils/calculator.ts:2285
 *   4. applyCalendarSelector      src/utils/setupSelector.ts:14  (dentro buildExecutionSetup)
 *
 * Nessuna soglia, nessun gate, nessuna decisione e' reimplementata: le uniche
 * funzioni scritte qui sono (a) il caricamento dello snapshot, (b) la traduzione
 * barre->quota per la modalita' replay (I3), (c) la serializzazione canonica.
 *
 * Determinismo: currentTime non e' l'orologio ma `snapshot.recordedAt`, e in
 * modalita' replay e' il `decisionTs` richiesto. Nessun timestamp di esecuzione
 * entra nell'output.
 *
 * Uso:
 *   bun scripts/headless_pipeline.ts --record --app-base=http://localhost:3000
 *   bun scripts/headless_pipeline.ts                       # stampa sha256 + output
 *   bun scripts/headless_pipeline.ts --fixture=... --out=...
 *   bun scripts/headless_pipeline.ts --aged                # genera la fixture derivata
 *   bun scripts/headless_pipeline.ts --staleness-flag=on   # I2b
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildExecutionSetup,
  calculateOrbFromIntradayBars,
  computeSessionVwap,
  DEFAULT_SYSTEM_PARAMETERS,
  getDualTopCandidates,
} from '../src/utils/calculator';
import { computeSetupIndicators } from '../src/utils/indicators';
import { getExchangeDateStr, getMarketTime } from '../src/utils/timezone';
import { DEFAULT_TRADE_REPUBLIC_UNDERLYINGS } from '../src/data/defaultUnderlyings';
import type { ExecutionSetup, RawQuoteData, SystemParameters } from '../src/types/radar';

export type Bar5m = { t: number; o: number; h: number; l: number; c: number; v: number };

export type RawMeta = {
  regularMarketTime: number | null;
  exchangeTimezoneName: string | null;
  currency: string | null;
  marketState: string | null;
  exchangeDataDelayedBy: number | null;
};

export type Snapshot = {
  recordedAt: string;
  capturedAt: string;
  parameters: SystemParameters;
  quotes: RawQuoteData[];
  bars5m: Record<string, Bar5m[]>;
  rawMeta: Record<string, RawMeta>;
  basket: string[];
  note?: string;
};

const FIXTURE_PATH = 'src/utils/__tests__/fixtures/pipeline_snapshot.json';
const AGED_PATH = 'src/utils/__tests__/fixtures/pipeline_snapshot_aged.json';

// Basket EU usato per la registrazione: .MI e .DE, nessun simbolo USA.
// Motivo dichiarato: la pipeline usa un istante di replay unico (recordedAt);
// mescolare mercati con chiusure diverse renderebbe G13 stantio per costruzione
// su un lato. Il ramo USA resta coperto dai test esistenti (phase1.test.ts).
const RECORD_BASKET = ['ENI.MI', 'UCG.MI', 'BAMI.MI', 'RHM.DE', 'SAP.DE'];

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Serializzazione canonica: chiavi ordinate, numeri a precisione fissa, niente orologio. */
export function canonical(value: unknown): string {
  const round = (n: number): number => {
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 1e6) / 1e6;
  };
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return round(v);
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) out[key] = walk(v[key]);
      return out;
    }
    return String(v);
  };
  return `${JSON.stringify(walk(value), null, 2)}\n`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function loadSnapshot(path: string): Snapshot {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isObj(raw)) throw new Error(`snapshot non valido: ${path}`);
  if (!Array.isArray(raw.quotes)) throw new Error(`snapshot senza quotes: ${path}`);
  return raw as unknown as Snapshot;
}

function gateSummary(setup: ExecutionSetup): Record<string, unknown> {
  const gates: Record<string, unknown> = {};
  const results = setup.gateResults ?? {};
  for (const key of Object.keys(results).sort()) {
    const g = results[key];
    gates[key] = { passed: g.passed, label: g.label, message: g.message ?? null };
  }
  return gates;
}

/** Forma canonica del setup: solo campi deterministici, nessun calculatedAt. */
export function canonicalSetup(setup: ExecutionSetup | null): Record<string, unknown> | null {
  if (setup === null) return null;
  return {
    ticker: setup.candidate?.ticker ?? null,
    decision: setup.decision,
    direction: setup.direction,
    strategy: setup.strategy,
    blockedGate: setup.blockedGate ?? null,
    reasonNoTrade: setup.reasonNoTrade ?? null,
    triggerLevel: setup.triggerLevel,
    entryLevel: setup.entryLevel ?? null,
    stopLossLevel: setup.stopLossLevel,
    target1Level: setup.target1Level,
    target2Level: setup.target2Level ?? null,
    riskRewardRatio: setup.riskRewardRatio ?? null,
    cutoffTime: setup.cutoffTime,
    gateResults: gateSummary(setup),
  } as Record<string, unknown>;
}

export type PipelineOptions = {
  currentTime?: Date;
  entryMode?: 'SNAPSHOT_0915' | 'UNFROZEN_LATE' | 'MANUAL_FREEZE' | null;
  futuresChange?: number | { EU: number; US: number };
  /** I2b: forza il valore del flag STALENESS_USE_MARKET_TS per questa esecuzione. */
  stalenessFlag?: 'on' | 'off';
};

/**
 * Unico punto in cui la pipeline viene eseguita: importa getDualTopCandidates e
 * buildExecutionSetup, esattamente come App.tsx:780 e App.tsx:907.
 */
export function runPipeline(
  quotes: RawQuoteData[],
  options: PipelineOptions = {}
): Record<string, unknown> {
  const futuresChange = options.futuresChange ?? { EU: 0, US: 0 };
  const params = DEFAULT_SYSTEM_PARAMETERS;
  const dual = getDualTopCandidates(quotes, futuresChange, { parameters: params });
  const currentTime = options.currentTime ?? new Date();

  const build = (market: 'EU' | 'US') => {
    const top = market === 'EU' ? dual.topEU : dual.topUS;
    // Le opzioni sono costruite come variabile (non come literal) perche'
    // `stalenessFlag` viene aggiunto alla firma in I2b: cosi' l'harness compila
    // sia prima sia dopo, senza cambiare l'output con flag assente.
    const buildOptions: NonNullable<Parameters<typeof buildExecutionSetup>[4]> = {
      entryMode: options.entryMode ?? 'SNAPSHOT_0915',
      currentTime,
    };
    if (options.stalenessFlag !== undefined) {
      (buildOptions as { stalenessFlag?: 'on' | 'off' }).stalenessFlag = options.stalenessFlag;
    }
    const setup = buildExecutionSetup(top, null, market, params, buildOptions);
    return {
      topTicker: top?.quote.ticker ?? null,
      topScore: top?.score.total ?? null,
      setup: canonicalSetup(setup),
    };
  };

  return {
    futuresChange,
    EU: build('EU'),
    US: build('US'),
  };
}

/**
 * Modalita' replay (I3): traduce (symbol, decisionTs, bars) nella stessa
 * pipeline. Le barre sono GIA' troncate dal chiamante (shift applicato a monte):
 * qui non si sposta nessun timestamp.
 *
 * I campi statici (atr14, avgVolume20d, liqEur20d, prevClose, nome, mercato,
 * valuta, rvol) vengono dallo snapshot: sono aggregati giornalieri, non
 * influenzati da uno shift di 15/20 minuti. Prezzo, ORB e VWAP sono ricalcolati
 * dalle barre con le funzioni di src/, non con formule nuove.
 */
export function quoteFromBars(
  snapshot: Snapshot,
  symbol: string,
  decisionTs: number,
  bars: Bar5m[]
): RawQuoteData | null {
  const base = snapshot.quotes.find((q) => q.ticker === symbol);
  if (base === undefined || bars.length === 0) return null;

  const market: 'EU' | 'US' = base.market;
  const asOf = new Date(decisionTs * 1000);
  const sessionDate = getExchangeDateStr(market, asOf);
  const mt = getMarketTime(market, asOf);

  const candles = bars.map((b) => ({
    timestamp: b.t,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
  }));

  const orb = calculateOrbFromIntradayBars(candles, market, asOf, undefined, asOf);
  const vwap = computeSessionVwap(
    bars.map((b) => ({ timestamp: b.t, high: b.h, low: b.l, close: b.c, volume: b.v })),
    market,
    sessionDate,
    { nowMinutes: mt.totalMinutes }
  );

  // Indicatori 5m: stessa funzione che usa il server (indicators.ts:650), con
  // `now` = istante di decisione. Nessuna soglia passata a mano.
  const indicatorBars = bars.map((b) => ({
    t: b.t * 1000,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
  })) as unknown as Parameters<typeof computeSetupIndicators>[0];
  const setupIndicators = computeSetupIndicators(indicatorBars, { market, now: asOf });

  const todayOpen = bars[0].o;
  const currentPrice = bars[bars.length - 1].c;
  const prevClose = base.prevClose;
  const gapPercent =
    prevClose != null && prevClose > 0
      ? +(((todayOpen - prevClose) / prevClose) * 100).toFixed(2)
      : null;

  return {
    ...base,
    currentPrice,
    preMarketPrice: currentPrice,
    todayOpen,
    todayHigh: orb.orbHigh,
    todayLow: orb.orbLow,
    orbHigh: orb.orbHigh,
    orbLow: orb.orbLow,
    orbBreakoutTime: orb.firstBreakoutTime,
    vwap: vwap.vwap,
    vwapCumulative: vwap.vwap,
    lastBarVolume: bars[bars.length - 1].v,
    lastBarTime: bars[bars.length - 1].t,
    setupIndicators,
    gapPercent,
    timestamp: asOf.toISOString(),
  };
}

export function quotesAtRecordedInstant(snapshot: Snapshot): RawQuoteData[] {
  const asOfSec = Math.floor(new Date(snapshot.recordedAt).getTime() / 1000);
  const out: RawQuoteData[] = [];
  for (const symbol of snapshot.basket) {
    const bars = (snapshot.bars5m[symbol] ?? []).filter((b) => b.t <= asOfSec);
    const quote = quoteFromBars(snapshot, symbol, asOfSec, bars);
    if (quote !== null) out.push(quote);
  }
  return out;
}

export function runPipelineFromBars(
  snapshot: Snapshot,
  symbol: string,
  decisionTs: number,
  bars: Bar5m[],
  options: PipelineOptions = {}
): Record<string, unknown> | null {
  const quote = quoteFromBars(snapshot, symbol, decisionTs, bars);
  if (quote === null) return null;
  return runPipeline([quote], {
    ...options,
    currentTime: new Date(decisionTs * 1000),
  });
}

// ---------------------------------------------------------------- record ----
async function fetchMetaAndBars(symbol: string): Promise<{ meta: RawMeta; bars: Bar5m[] }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=5d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; headless-pipeline/1.0)', Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} per ${symbol}`);
  const json: unknown = await res.json();
  const chart = isObj(json) ? json.chart : undefined;
  const results = isObj(chart) ? chart.result : undefined;
  const first = Array.isArray(results) && isObj(results[0]) ? results[0] : null;
  const meta = first !== null && isObj(first.meta) ? first.meta : null;
  const stamps = first !== null && Array.isArray(first.timestamp) ? first.timestamp : [];
  const indicators = first !== null && isObj(first.indicators) ? first.indicators : null;
  const q0 =
    indicators !== null && Array.isArray(indicators.quote) && isObj(indicators.quote[0])
      ? indicators.quote[0]
      : null;
  const bars: Bar5m[] = [];
  if (q0 !== null) {
    const arr = (k: string): unknown[] => (Array.isArray(q0[k]) ? (q0[k] as unknown[]) : []);
    const o = arr('open');
    const h = arr('high');
    const l = arr('low');
    const c = arr('close');
    const v = arr('volume');
    for (let i = 0; i < stamps.length; i += 1) {
      const t = num(stamps[i]);
      const bo = num(o[i]);
      const bh = num(h[i]);
      const bl = num(l[i]);
      const bc = num(c[i]);
      if (t === null || bo === null || bh === null || bl === null || bc === null) continue;
      bars.push({ t, o: bo, h: bh, l: bl, c: bc, v: num(v[i]) ?? 0 });
    }
  }
  return {
    meta: {
      regularMarketTime: meta === null ? null : num(meta.regularMarketTime),
      exchangeTimezoneName: meta === null ? null : str(meta.exchangeTimezoneName),
      currency: meta === null ? null : str(meta.currency),
      marketState: meta === null ? null : str(meta.marketState),
      exchangeDataDelayedBy: meta === null ? null : num(meta.exchangeDataDelayedBy),
    },
    bars,
  };
}

async function record(appBase: string, outPath: string): Promise<void> {
  const underlyings = RECORD_BASKET.map((ticker) => {
    const found = DEFAULT_TRADE_REPUBLIC_UNDERLYINGS.find((u) => u.ticker === ticker);
    return found ?? { ticker, nome: ticker, mercato: 'EU' as const, valuta: 'EUR' };
  });

  const res = await fetch(`${appBase}/api/market-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ underlyings, refresh: true }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`record: HTTP ${res.status} da ${appBase}`);
  const json: unknown = await res.json();
  const data = isObj(json) && Array.isArray(json.data) ? json.data : [];
  if (data.length === 0) throw new Error('record: risposta senza data');

  const quotes: RawQuoteData[] = data.filter(isObj) as unknown as RawQuoteData[];
  const bars5m: Record<string, Bar5m[]> = {};
  const rawMeta: Record<string, RawMeta> = {};
  const stamps: number[] = [];

  for (const quote of quotes) {
    const { meta, bars } = await fetchMetaAndBars(quote.ticker);
    rawMeta[quote.ticker] = meta;
    bars5m[quote.ticker] = bars;
    if (meta.regularMarketTime !== null) stamps.push(meta.regularMarketTime);
  }

  // marketTs viene registrato GIA' ORA (campo non ancora nel tipo: arriva in I2a),
  // cosi' I2b non richiede una nuova registrazione dello snapshot.
  const quotesWithMarketTs = quotes.map(
    (q) =>
      ({
        ...q,
        marketTs: rawMeta[q.ticker]?.regularMarketTime ?? null,
      }) as unknown as RawQuoteData
  );

  if (stamps.length === 0) throw new Error('record: nessun regularMarketTime');
  const lastMarketTs = Math.max(...stamps);

  // recordedAt = istante di replay, ancorato all'ultimo tempo di mercato
  // osservato (NON all'orologio): cosi' l'esecuzione e' riproducibile e G13
  // misura il ritardo del feed, non il tempo passato da quando abbiamo registrato.
  const snapshot: Snapshot = {
    recordedAt: new Date(lastMarketTs * 1000).toISOString(),
    capturedAt: new Date().toISOString(),
    parameters: DEFAULT_SYSTEM_PARAMETERS,
    quotes: quotesWithMarketTs,
    bars5m,
    rawMeta,
    basket: RECORD_BASKET,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 1)}\n`);
  console.log(`snapshot scritto in ${outPath}`);
  console.log(`  quote: ${quotes.length}  recordedAt: ${snapshot.recordedAt}`);
  for (const ticker of RECORD_BASKET) {
    const m = rawMeta[ticker];
    console.log(
      `  ${ticker.padEnd(9)} rmt=${m?.regularMarketTime ?? '-'} tz=${m?.exchangeTimezoneName ?? '-'} state=${m?.marketState ?? '-'} delayedBy=${m?.exchangeDataDelayedBy ?? '-'} bars=${bars5m[ticker]?.length ?? 0}`
    );
  }
}

/** Fixture derivata: stessa cosa con marketTs spostato indietro di --aged-seconds. */
function writeAged(src: string, dst: string, seconds: number): void {
  const snapshot = loadSnapshot(src);
  const aged: Snapshot = {
    ...snapshot,
    note:
      'FIXTURE DERIVATA a scopo di test: identica a pipeline_snapshot.json tranne ' +
      `marketTs spostato indietro di ${seconds}s. NON e' un dato di mercato.`,
    quotes: snapshot.quotes.map((q) => {
      const current = (q as unknown as { marketTs?: number | null }).marketTs;
      const fallback = snapshot.rawMeta[q.ticker]?.regularMarketTime ?? null;
      const value = current ?? fallback;
      return {
        ...q,
        marketTs: value === null ? null : value - seconds,
      } as unknown as RawQuoteData;
    }),
  };
  writeFileSync(dst, `${JSON.stringify(aged, null, 1)}\n`);
  console.log(`fixture derivata scritta in ${dst} (marketTs -${seconds}s, recordedAt invariato: ${aged.recordedAt})`);
}

async function main(): Promise<void> {
  const appBase = arg('app-base', 'http://localhost:3000');
  const fixture = resolve(arg('fixture', FIXTURE_PATH));
  const outPath = arg('out', '');
  const stalenessFlag = arg('staleness-flag', '') as '' | 'on' | 'off';

  if (flag('record')) {
    await record(appBase, fixture);
    return;
  }
  if (flag('aged')) {
    const seconds = Number(arg('aged-seconds', '3600'));
    writeAged(fixture, resolve(arg('aged-out', AGED_PATH)), seconds);
    return;
  }
  if (!existsSync(fixture)) {
    throw new Error(`snapshot assente: ${fixture}. Esegui prima --record.`);
  }

  const snapshot = loadSnapshot(fixture);
  const asOf = new Date(snapshot.recordedAt);
  const asOfSec = Math.floor(asOf.getTime() / 1000);

  // Due modalita', entrambe deterministiche:
  //  as-recorded : usa le quote cosi' come sono state registrate (istantanea del feed)
  //  from-bars   : ricostruisce le quote all'istante `recordedAt` dalle barre 5m,
  //                usando le funzioni di src/ (ORB, VWAP, indicatori). E' la
  //                modalita' che esercita davvero i gate, ed e' anche il percorso
  //                usato dall'adapter di I3.
  const asRecorded = flag('as-recorded');
  const quotes: RawQuoteData[] = asRecorded
    ? [...snapshot.quotes]
    : quotesAtRecordedInstant(snapshot);

  const output = canonical(
    runPipeline(quotes, {
      currentTime: asOf,
      entryMode: 'SNAPSHOT_0915',
      futuresChange: { EU: 0, US: 0 },
      ...(stalenessFlag === 'on' || stalenessFlag === 'off'
        ? { stalenessFlag }
        : {}),
    })
  );

  console.log(`fixture: ${fixture}`);
  console.log(`modalita': ${asRecorded ? 'as-recorded' : 'from-bars'}`);
  console.log(`asOf: ${snapshot.recordedAt}  quote: ${quotes.length}`);
  console.log(`sha256: ${sha256(output)}`);
  if (outPath.length > 0) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, output);
    console.log(`output scritto in ${outPath}`);
  } else {
    process.stdout.write(output);
  }
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
