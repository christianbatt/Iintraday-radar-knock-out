/**
 * SHADOW V1 LIVE MARKS — fotografia in sola lettura dei prezzi correnti e
 * variazione non realizzata (R / %) per le posizioni V1-live attive (`OPEN` e
 * `PENDING_FILL`).
 *
 * Calcolata esclusivamente dai prezzi già scaricati da `/api/market-data` e
 * dalle barre 5m chiuse in RAM: zero chiamate API esterne aggiuntive e nessun
 * livello grezzo (`entry`, `stop`, `target`) esposto sulla risposta.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ShadowV1LiveBar } from '../knowledge/shadowV1Live';
import type { RawQuoteData } from '../types/radar';
import { barsForShadowV1Live, type Market } from './shadowV1LiveCollector';
import {
  loadRecords,
  shadowV1LiveTmpPath,
  SHADOW_V1_LIVE_SIGNALS_PATH,
  type PersistedShadowV1LiveRecord,
} from './shadowV1LiveStore';

/** Percorso dell'artefatto relativo alla directory degli artefatti (`artifactDir`). */
export const SHADOW_V1_LIVE_MARKS_RELATIVE_PATH = 'shadow_v1_live/live_marks.json';

export const SHADOW_V1_LIVE_MARKS_PATH = `artifacts/${SHADOW_V1_LIVE_MARKS_RELATIVE_PATH}`;

export interface ShadowV1LiveMark {
  key: string;
  ticker: string;
  market: Market;
  direction: 'LONG' | 'SHORT';
  status: 'PENDING_FILL' | 'OPEN';
  currency: string;
  lastPrice: number;
  lastPriceAtMs: number | null;
  unrealizedR: number | null;
  pctFromEntry: number | null;
  priceSource: 'quote' | 'bar5m';
}

export interface ShadowV1LiveMarksPayload {
  version: 1;
  updatedAt: string;
  marks: ShadowV1LiveMark[];
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function currencyOf(market: Market, quoteCurrency?: string | null): string {
  if (typeof quoteCurrency === 'string' && quoteCurrency.trim().length > 0) {
    return quoteCurrency.trim().toUpperCase();
  }
  return market === 'EU' ? 'EUR' : 'USD';
}

export function computeShadowV1LiveMarks(
  records: readonly PersistedShadowV1LiveRecord[],
  quotes: readonly Pick<RawQuoteData, 'ticker' | 'market' | 'currency' | 'currentPrice' | 'marketTs'>[],
  getBars: (ticker: string, market: Market) => readonly ShadowV1LiveBar[],
  nowMs: number = Date.now()
): ShadowV1LiveMark[] {
  const quoteByTicker = new Map<string, Pick<RawQuoteData, 'ticker' | 'market' | 'currency' | 'currentPrice' | 'marketTs'>>();
  for (const q of quotes) {
    if (q && typeof q.ticker === 'string' && typeof q.currentPrice === 'number' && Number.isFinite(q.currentPrice) && q.currentPrice > 0) {
      quoteByTicker.set(q.ticker.trim().toUpperCase(), q);
    }
  }

  const out: ShadowV1LiveMark[] = [];
  for (const rec of records) {
    if (rec.status !== 'OPEN' && rec.status !== 'PENDING_FILL') continue;

    const quote = quoteByTicker.get(rec.ticker.trim().toUpperCase());
    let lastPrice: number | null =
      quote && typeof quote.currentPrice === 'number' && Number.isFinite(quote.currentPrice) && quote.currentPrice > 0
        ? quote.currentPrice
        : null;
    let lastPriceAtMs: number | null =
      lastPrice !== null && typeof quote?.marketTs === 'number' && Number.isFinite(quote.marketTs)
        ? quote.marketTs * 1000
        : lastPrice !== null
        ? nowMs
        : null;
    let priceSource: 'quote' | 'bar5m' = 'quote';

    if (lastPrice === null) {
      const bars = getBars(rec.ticker, rec.market);
      const lastBar = bars.length > 0 ? bars[bars.length - 1] : null;
      if (lastBar && Number.isFinite(lastBar.c) && lastBar.c > 0) {
        lastPrice = lastBar.c;
        lastPriceAtMs = Number.isFinite(lastBar.t) ? lastBar.t : null;
        priceSource = 'bar5m';
      }
    }

    if (lastPrice === null) continue;

    const dir = rec.direction === 'LONG' ? 1 : -1;
    const risk = Math.abs(rec.entry - rec.stop);
    const unrealizedR =
      rec.status === 'OPEN' && risk > 0
        ? round((dir * (lastPrice - rec.entry)) / risk, 2)
        : null;
    const pctFromEntry =
      rec.entry > 0 ? round((dir * ((lastPrice - rec.entry) / rec.entry)) * 100, 2) : null;

    out.push({
      key: rec.key,
      ticker: rec.ticker,
      market: rec.market,
      direction: rec.direction,
      status: rec.status,
      currency: currencyOf(rec.market, quote?.currency),
      lastPrice: round(lastPrice, 4),
      lastPriceAtMs,
      unrealizedR,
      pctFromEntry,
      priceSource,
    });
  }

  return out;
}

export function updateShadowV1LiveMarksOnDisk(
  quotes: readonly Pick<RawQuoteData, 'ticker' | 'market' | 'currency' | 'currentPrice' | 'marketTs'>[],
  options: {
    rootDir?: string;
    nowMs?: number;
    getBars?: (ticker: string, market: Market) => readonly ShadowV1LiveBar[];
  } = {}
): ShadowV1LiveMarksPayload | null {
  try {
    const rootDir = options.rootDir ?? process.cwd();
    const nowMs = options.nowMs ?? Date.now();
    const signalsPath = path.join(rootDir, SHADOW_V1_LIVE_SIGNALS_PATH);
    const marksPath = path.join(rootDir, SHADOW_V1_LIVE_MARKS_PATH);

    const records = fs.existsSync(signalsPath) ? loadRecords(signalsPath).records : [];
    const marks = computeShadowV1LiveMarks(
      records,
      quotes,
      options.getBars ?? ((t, m) => barsForShadowV1Live(t, m)),
      nowMs
    );

    if (marks.length === 0) {
      if (!fs.existsSync(marksPath)) return null;
      const prev = JSON.parse(fs.readFileSync(marksPath, 'utf8')) as Partial<ShadowV1LiveMarksPayload> | null;
      if (Array.isArray(prev?.marks) && prev.marks.length === 0) return null;
    }

    const payload: ShadowV1LiveMarksPayload = {
      version: 1,
      updatedAt: new Date(nowMs).toISOString(),
      marks,
    };
    const dir = path.dirname(marksPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = shadowV1LiveTmpPath(marksPath);
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpPath, marksPath);
    return payload;
  } catch {
    return null;
  }
}
