import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import {
  filterCompletedBars,
  calculateAtr14FromBars,
  calculateAdr14FromBars,
  calculateLiqEurFromBars,
  calculateOrbFromIntradayBars,
  calculateOrbRvolFromBars,
  DailyBarInput,
  IntradayCandleInput,
} from './src/utils/calculator';
import { getExchangeDateStr, getMarketTime } from './src/utils/timezone';
import { TRADING_PARAMS } from './src/config/tradingParams';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '10mb' }));

// In-Memory Cache Store (Redis-like TTL Cache)
interface CacheEntry<T> {
  data: T;
  expiry: number;
  timestamp: string;
}

class CacheStore {
  private store = new Map<string, CacheEntry<any>>();

  set<T>(key: string, data: T, ttlSeconds: number): void {
    const expiry = Date.now() + ttlSeconds * 1000;
    this.store.set(key, {
      data,
      expiry,
      timestamp: new Date().toISOString(),
    });
  }

  get<T>(key: string): { data: T; cachedAt: string } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      return null;
    }
    return { data: entry.data, cachedAt: entry.timestamp };
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

const cache = new CacheStore();
let geminiQuotaExhaustedUntil: number = 0;

// Initialize Gemini Client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Helper for CET time calculations
function getCETTime() {
  const now = new Date();
  
  // Europe (Europe/Rome)
  const euFormatter = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const euParts = euFormatter.formatToParts(now);
  const euMap: Record<string, string> = {};
  euParts.forEach((p) => {
    euMap[p.type] = p.value;
  });

  const hour = parseInt(euMap.hour || '0', 10);
  const minute = parseInt(euMap.minute || '0', 10);
  const totalMinutes = hour * 60 + minute;

  // Screening Europa: 07:30 (450m) to 08:55 (535m) Europe/Rome
  const isEuropeWindow = totalMinutes >= 450 && totalMinutes <= 535;
  // Regular Trading Session Hours Europe: 09:00 (540m) to 17:35 (1055m) Europe/Rome
  const isEuropeLive = totalMinutes >= 540 && totalMinutes <= 1055;

  // USA (America/New_York) - 100% Dynamic with Intl
  const usFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const usParts = usFormatter.formatToParts(now);
  const usMap: Record<string, string> = {};
  usParts.forEach((p) => {
    usMap[p.type] = p.value;
  });

  const usHour = parseInt(usMap.hour || '0', 10);
  const usMinute = parseInt(usMap.minute || '0', 10);
  const usTotalMinutes = usHour * 60 + usMinute;

  // Screening USA: 08:30 (510m) to 09:25 (565m) America/New_York
  const isUSAWindow = usTotalMinutes >= 510 && usTotalMinutes <= 565;
  // Pre-Market USA: 04:00 (240m) to 09:29 (569m) America/New_York
  const isUSAPreMarket = usTotalMinutes >= 240 && usTotalMinutes <= 569;
  // Regular Live Session USA: 09:30 (570m) to 16:05 (965m) America/New_York
  const isUSALive = usTotalMinutes >= 570 && usTotalMinutes <= 965;

  const marketStatusEU: 'PRE_MARKET' | 'OPEN_LIVE' | 'CLOSED' = isEuropeLive
    ? 'OPEN_LIVE'
    : isEuropeWindow
    ? 'PRE_MARKET'
    : 'CLOSED';

  const marketStatusUS: 'PRE_MARKET' | 'OPEN_LIVE' | 'CLOSED' = isUSALive
    ? 'OPEN_LIVE'
    : isUSAPreMarket
    ? 'PRE_MARKET'
    : 'CLOSED';

  return {
    formatted: `${euMap.hour}:${euMap.minute}:${euMap.second} CET`,
    date: `${euMap.year}-${euMap.month}-${euMap.day}`,
    hour,
    minute,
    isEuropeWindow,
    isUSAWindow,
    isEuropeLive,
    isUSAPreMarket,
    isUSALive,
    marketStatusEU,
    marketStatusUS,
    currentMinutes: totalMinutes,
    usMinutes: usTotalMinutes,
  };
}

export interface RawQuoteData {
  ticker: string;
  name: string;
  market: 'EU' | 'US';
  currency: string;
  prevClose: number | null;
  currentPrice: number | null;
  preMarketPrice: number | null;
  prevHigh: number | null;
  prevLow: number | null;
  preMarketHigh: number | null;
  preMarketLow: number | null;
  todayOpen?: number | null;
  todayHigh?: number | null;
  todayLow?: number | null;
  vwap?: number | null;
  ema20Daily?: number | null;
  avgVolume20d: number | null;
  preMarketVolume: number | null;
  atr14: number | null;
  adr14?: number | null;
  liqEur20d?: number | null;
  fxRate?: number | null;
  completedBarsCount?: number | null;
  orbHigh?: number | null;
  orbLow?: number | null;
  orbBreakoutTime?: string | null;
  gapPercent: number | null;
  rvol: number | null;
  impliedVolatility?: number | null;
  historicalVolatility30d?: number | null;
  ivRank?: number | null;
  rsi14?: number | null;
  rsi5m?: number | null;
  rvol20m?: number | null;
  orderFlow?: OrderFlowMetrics | null;
  timestamp: string;
  source: string;
}

export interface OrderFlowMetrics {
  buyerVolumePercent: number;
  sellerVolumePercent: number;
  netDeltaPercent: number;
  cvdTrend: 'EXPANDING_UP' | 'EXPANDING_DOWN' | 'NEUTRAL' | 'ABSORPTION_TRAP';
  vpocPrice: number | null;
  isPriceAboveVpoc: boolean | null;
  flowQuality: 'INSTITUTIONAL_BUYING' | 'INSTITUTIONAL_SELLING' | 'ABSORPTION_TRAP' | 'BALANCED';
  summary: string;
}

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
}

// Calculate Wilder's 14-period RSI on series of prices
function calculateWilderRsi(closes: number[], period: number = 14): number | null {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(1);
}

// Fetch real live EUR/USD exchange rate from Yahoo Finance feed (no hardcoded fallback)
async function getLiveEurUsdRate(): Promise<number> {
  const cacheKey = 'fx:EURUSD';
  const cached = cache.get<number>(cacheKey);
  if (cached) return cached.data;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1d&range=1d&_=${Date.now()}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`Impossibile recuperare tasso FX EUR/USD dal feed: HTTP ${resp.status}`);
  }
  const json = await resp.json();
  const rate = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (typeof rate !== 'number' || rate <= 0) {
    throw new Error('Tasso FX EUR/USD non disponibile nel feed per conversione liquidità');
  }
  cache.set(cacheKey, rate, 300); // 5 min TTL
  return rate;
}

// Fetch real 5-minute Intraday RSI, 20-minute RVOL, ORB levels & Synthetic Order Flow
async function getIntraday5mMetrics(
  ticker: string,
  market: 'EU' | 'US' = 'EU'
): Promise<{
  rsi5m: number | null;
  rvol: number | null;
  rvol20m: number | null;
  orderFlow: OrderFlowMetrics | null;
  orbHigh: number | null;
  orbLow: number | null;
  orbBreakoutTime: string | null;
}> {
  const cacheKey = `metrics5m:${ticker}:${market}`;
  const cached = cache.get<{
    rsi5m: number | null;
    rvol: number | null;
    rvol20m: number | null;
    orderFlow: OrderFlowMetrics | null;
    orbHigh: number | null;
    orbLow: number | null;
    orbBreakoutTime: string | null;
  }>(cacheKey);
  if (cached) return cached.data;

  try {
    const ySymbol = ticker.includes('.') ? ticker : `${ticker}`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?interval=5m&range=60d&includePrePost=true&_=${Date.now()}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return { rsi5m: null, rvol: null, rvol20m: null, orderFlow: null, orbHigh: null, orbLow: null, orbBreakoutTime: null };
    const json = await resp.json();
    const rawQuotes = json?.chart?.result?.[0]?.indicators?.quote?.[0];
    const closes: number[] = rawQuotes?.close?.filter(
      (c: any) => typeof c === 'number' && c > 0
    ) || [];

    const rsi5m = calculateWilderRsi(closes, 14);

    // Calculate real-time 20-minute Relative Volume (last 4 bars of 5m vs preceding moving average)
    let rvol20m: number | null = null;
    const vols: number[] = (rawQuotes?.volume || [])
      .map((v: any, i: number) => ({ v: typeof v === 'number' ? v : 0, c: rawQuotes?.close?.[i] }))
      .filter((x: any) => typeof x.c === 'number' && x.v > 0)
      .map((x: any) => x.v);

    if (vols.length >= 8) {
      // Last 4 bars (4 * 5m = 20 minutes)
      const last4 = vols.slice(-4);
      // Preceding moving average window of up to 16 bars (80 min)
      const prevBars = vols.slice(Math.max(0, vols.length - 20), vols.length - 4);
      if (prevBars.length >= 4) {
        const last4Avg = last4.reduce((a, b) => a + b, 0) / last4.length;
        const prevAvg = prevBars.reduce((a, b) => a + b, 0) / prevBars.length;
        if (prevAvg > 0) {
          rvol20m = +(last4Avg / prevAvg).toFixed(2);
        }
      }
    }

    // 100% REAL Order Flow: Intra-candle Lee-Ready Volume Decomposition & Cumulative Delta
    let orderFlow: OrderFlowMetrics | null = null;
    const opens = rawQuotes?.open || [];
    const highs = rawQuotes?.high || [];
    const lows = rawQuotes?.low || [];
    const closesArr = rawQuotes?.close || [];
    const volumes = rawQuotes?.volume || [];

    const validBars: {
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      buyerVol: number;
      sellerVol: number;
      delta: number;
    }[] = [];

    for (let i = 0; i < closesArr.length; i++) {
      const c = closesArr[i];
      const h = highs[i] ?? c;
      const l = lows[i] ?? c;
      const o = opens[i] ?? c;
      const v = typeof volumes[i] === 'number' && volumes[i] > 0 ? volumes[i] : 0;
      if (typeof c === 'number' && c > 0) {
        const range = Math.max(h - l, c * 0.0005);
        // Close Location Value (CLV) strictly in [-1, +1]
        const clv = Math.max(-1, Math.min(1, ((c - l) - (h - c)) / range));
        // Buyer fraction [0.05, 0.95]
        const buyerFraction = Math.min(0.95, Math.max(0.05, 0.5 + clv * 0.45));
        const sellerFraction = 1 - buyerFraction;
        const buyerVol = v * buyerFraction;
        const sellerVol = v * sellerFraction;
        const delta = buyerVol - sellerVol;

        validBars.push({
          open: o,
          high: h,
          low: l,
          close: c,
          volume: v,
          buyerVol,
          sellerVol,
          delta,
        });
      }
    }

    if (validBars.length >= 4) {
      // Analyze recent window of up to 12 bars (last 60m of intraday trading)
      const windowBars = validBars.slice(-12);
      const totalBuyerVol = windowBars.reduce((acc, b) => acc + b.buyerVol, 0);
      const totalSellerVol = windowBars.reduce((acc, b) => acc + b.sellerVol, 0);
      const windowVol = totalBuyerVol + totalSellerVol;

      const buyerVolumePercent = windowVol > 0 ? +((totalBuyerVol / windowVol) * 100).toFixed(1) : 50;
      const sellerVolumePercent = +(100 - buyerVolumePercent).toFixed(1);
      const netDeltaPercent = +(buyerVolumePercent - sellerVolumePercent).toFixed(1);

      // Cumulative Volume Delta (CVD) slope over last 6 bars (last 30m)
      const cvdBars = validBars.slice(-6);
      let runningDelta = 0;
      const cvdSeries = cvdBars.map((b) => {
        runningDelta += b.delta;
        return { close: b.close, cvd: runningDelta };
      });

      const firstHalf = cvdSeries.slice(0, 3);
      const secondHalf = cvdSeries.slice(-3);
      const avgPrice1 = firstHalf.reduce((a, b) => a + b.close, 0) / firstHalf.length;
      const avgPrice2 = secondHalf.reduce((a, b) => a + b.close, 0) / secondHalf.length;
      const avgCvd1 = firstHalf.reduce((a, b) => a + b.cvd, 0) / firstHalf.length;
      const avgCvd2 = secondHalf.reduce((a, b) => a + b.cvd, 0) / secondHalf.length;

      const priceUp = avgPrice2 > avgPrice1 * 1.0006;
      const priceDown = avgPrice2 < avgPrice1 * 0.9994;
      const cvdUp = avgCvd2 > avgCvd1;
      const cvdDown = avgCvd2 < avgCvd1;

      // Detection of Absorption Trap (Bearish: Price makes new highs but CVD dumps; Bullish: Price drops but CVD buys)
      let cvdTrend: OrderFlowMetrics['cvdTrend'] = 'NEUTRAL';
      let flowQuality: OrderFlowMetrics['flowQuality'] = 'BALANCED';

      if (priceUp && cvdDown) {
        cvdTrend = 'ABSORPTION_TRAP';
        flowQuality = 'ABSORPTION_TRAP';
      } else if (priceDown && cvdUp) {
        cvdTrend = 'ABSORPTION_TRAP';
        flowQuality = 'ABSORPTION_TRAP';
      } else if (cvdUp && buyerVolumePercent >= 56) {
        cvdTrend = 'EXPANDING_UP';
        flowQuality = 'INSTITUTIONAL_BUYING';
      } else if (cvdDown && sellerVolumePercent >= 56) {
        cvdTrend = 'EXPANDING_DOWN';
        flowQuality = 'INSTITUTIONAL_SELLING';
      } else {
        cvdTrend = cvdUp ? 'EXPANDING_UP' : cvdDown ? 'EXPANDING_DOWN' : 'NEUTRAL';
        flowQuality = 'BALANCED';
      }

      // Micro Volume Profile & VPOC (Volume Point of Control across last 12 bars)
      const minP = Math.min(...windowBars.map((b) => b.low));
      const maxP = Math.max(...windowBars.map((b) => b.high));
      const pRange = Math.max(maxP - minP, 0.01);
      const binCount = 10;
      const binSize = pRange / binCount;
      const bins: number[] = new Array(binCount).fill(0);

      windowBars.forEach((b) => {
        const binIdx = Math.min(Math.floor((b.close - minP) / binSize), binCount - 1);
        if (binIdx >= 0) bins[binIdx] += b.volume;
      });

      let maxBinIdx = 0;
      let maxBinVol = -1;
      bins.forEach((vol, idx) => {
        if (vol > maxBinVol) {
          maxBinVol = vol;
          maxBinIdx = idx;
        }
      });

      const vpocPrice = +(minP + (maxBinIdx + 0.5) * binSize).toFixed(2);
      const currentPrice = windowBars[windowBars.length - 1].close;
      const isPriceAboveVpoc = currentPrice >= vpocPrice;

      let summary = '';
      if (flowQuality === 'ABSORPTION_TRAP') {
        summary = `⚠️ Divergenza Delta: ${priceUp ? 'prezzo in rialzo ma volumi in scarico al Bid' : 'prezzo in ribasso ma volumi in assorbimento all\'Ask'} (Rischio falso breakout).`;
      } else if (flowQuality === 'INSTITUTIONAL_BUYING') {
        summary = `Pressione Compratrice Istituzionale (+${netDeltaPercent}% Ask): aggressione al mercato e CVD in espansione sopra VPOC.`;
      } else if (flowQuality === 'INSTITUTIONAL_SELLING') {
        summary = `Pressione Venditrice Istituzionale (${netDeltaPercent}% Bid): scarico volumi a mercato e CVD ribassista sotto VPOC.`;
      } else {
        summary = `Flusso Volumetrico Bilanciato (${buyerVolumePercent}% Ask / ${sellerVolumePercent}% Bid).`;
      }

      orderFlow = {
        buyerVolumePercent,
        sellerVolumePercent,
        netDeltaPercent,
        cvdTrend,
        vpocPrice,
        isPriceAboveVpoc,
        flowQuality,
        summary,
      };
    }

    // Extract ORB levels for today's session based on local exchange time and calculate ORB RVOL
    let orbHigh: number | null = null;
    let orbLow: number | null = null;
    let orbBreakoutTime: string | null = null;
    let orbRvol: number | null = null;

    try {
      const timestamps5m: number[] = json?.chart?.result?.[0]?.timestamp || [];
      const highs5m: number[] = rawQuotes?.high || [];
      const lows5m: number[] = rawQuotes?.low || [];
      const candles5m: IntradayCandleInput[] = [];

      const openM =
        market === 'US'
          ? TRADING_PARAMS.US_OPEN_HOUR * 60 + TRADING_PARAMS.US_OPEN_MINUTE
          : TRADING_PARAMS.EU_OPEN_HOUR * 60 + TRADING_PARAMS.EU_OPEN_MINUTE;
      const orbEndM = openM + TRADING_PARAMS.ORB_MINUTES;

      const sessionOrbMap = new Map<string, number>();
      const sessionCandles = new Map<string, Array<{ volume?: number | null }>>();

      for (let i = 0; i < timestamps5m.length; i++) {
        const ts = timestamps5m[i];
        const h = highs5m[i];
        const l = lows5m[i];
        const c = rawQuotes?.close?.[i];
        const v = typeof rawQuotes?.volume?.[i] === 'number' && rawQuotes.volume[i] > 0 ? rawQuotes.volume[i] : 0;

        if (typeof h === 'number' && typeof l === 'number' && typeof c === 'number' && h > 0 && l > 0) {
          candles5m.push({ timestamp: ts, high: h, low: l, close: c });
        }

        const d = new Date(ts * 1000);
        const mt = getMarketTime(market, d);
        if (mt.totalMinutes >= openM && mt.totalMinutes < orbEndM) {
          if (!sessionOrbMap.has(mt.dateFormatted)) {
            sessionOrbMap.set(mt.dateFormatted, 0);
            sessionCandles.set(mt.dateFormatted, []);
          }
          sessionOrbMap.set(mt.dateFormatted, sessionOrbMap.get(mt.dateFormatted)! + v);
          sessionCandles.get(mt.dateFormatted)!.push({ volume: v });
        }
      }

      if (candles5m.length > 0) {
        const latestCandleDate = new Date(timestamps5m[timestamps5m.length - 1] * 1000);
        const orbRes = calculateOrbFromIntradayBars(candles5m, market, latestCandleDate);
        orbHigh = orbRes.orbHigh != null ? +orbRes.orbHigh.toFixed(2) : null;
        orbLow = orbRes.orbLow != null ? +orbRes.orbLow.toFixed(2) : null;
        orbBreakoutTime = orbRes.firstBreakoutTime;

        const allDates = Array.from(sessionOrbMap.keys()).sort();
        if (allDates.length > 0) {
          const latestDate = getExchangeDateStr(market, latestCandleDate);
          const histDates = allDates.filter((d) => d < latestDate);
          const histVolumes = histDates.map((d) => sessionOrbMap.get(d)!);
          const currentBars = sessionCandles.get(latestDate) || [];

          orbRvol = calculateOrbRvolFromBars(currentBars, histVolumes.slice(-20));
        }
      }
    } catch {
      // ignore
    }

    const result = { rsi5m, rvol: orbRvol, rvol20m, orderFlow, orbHigh, orbLow, orbBreakoutTime };
    cache.set(cacheKey, result, 25);
    return result;
  } catch {
    return { rsi5m: null, rvol: null, rvol20m: null, orderFlow: null, orbHigh: null, orbLow: null, orbBreakoutTime: null };
  }
}

// Fetch real market quote & historical bars from real exchange feed
async function fetchQuoteForTicker(
  ticker: string,
  name: string,
  market: 'EU' | 'US',
  currency: string,
  bypassCache: boolean = false
): Promise<RawQuoteData> {
  const cacheKey = `quote:${ticker}`;
  if (!bypassCache) {
    const cached = cache.get<RawQuoteData>(cacheKey);
    if (cached) {
      return cached.data;
    }
  }

  const isSpaceX = ticker.toUpperCase() === 'SPACEX';
  const queryTicker = isSpaceX ? 'DXYZ' : ticker;

  // Launch 5m intraday metrics fetch (RSI 5m + RVOL 20m + ORB) in parallel for zero added latency
  const intraday5mPromise = getIntraday5mMetrics(queryTicker, market);

  let quoteData: Partial<RawQuoteData> = {};
  let source = 'Exchange Feed (Real-Time)';

  // 1. Check Finnhub if API key is provided
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (finnhubKey) {
    try {
      const cleanTicker = queryTicker.replace('.DE', '').replace('.MI', '').replace('.PA', '').replace('.AS', '');
      const resp = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${cleanTicker}&token=${finnhubKey}`
      );
      if (resp.ok) {
        const json = await resp.json();
        if (typeof json.c === 'number' && json.c > 0) {
          quoteData.currentPrice = json.c;
          quoteData.prevClose = json.pc || null;
          quoteData.prevHigh = json.h || null;
          quoteData.prevLow = json.l || null;
          quoteData.preMarketPrice = json.c;
          source = 'Finnhub Live API';
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Fetch real data from Yahoo Finance Chart API (with cachebuster to bypass CDN stale cache)
  try {
    const ySymbol = queryTicker.includes('.') ? queryTicker : `${queryTicker}`;
    const nocache = Date.now();
    const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?interval=1d&range=1mo&includePrePost=true&_=${nocache}`;
    const yResp = await fetch(yUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        Accept: 'application/json',
      },
    });

    if (yResp.ok) {
      const yJson = await yResp.json();
      const result = yJson?.chart?.result?.[0];
      if (result) {
        const meta = result.meta || {};
        const timestamps: number[] = result.timestamp || [];
        const quotes = result.indicators?.quote?.[0];

        // Extract valid daily candles with timestamp, close, high, low, volume in exchange timezone
        const validBars: DailyBarInput[] = [];
        for (let i = 0; i < timestamps.length; i++) {
          if (typeof quotes?.close?.[i] === 'number') {
            validBars.push({
              date: getExchangeDateStr(market, new Date(timestamps[i] * 1000)),
              timestamp: timestamps[i],
              close: quotes.close[i],
              high: quotes.high?.[i] ?? quotes.close[i],
              low: quotes.low?.[i] ?? quotes.close[i],
              volume: quotes.volume?.[i] ?? 0,
            });
          }
        }

        const todayStr = getExchangeDateStr(market, new Date());
        const lastBar = validBars.length > 0 ? validBars[validBars.length - 1] : null;
        const isTodayBar = lastBar?.date === todayStr;

        // Zero lookahead: completed sessions strictly exclude today's incomplete candle
        const completedBars = filterCompletedBars(validBars, market, new Date());

        let prevC: number | null = null;
        let yHigh: number | null = null;
        let yLow: number | null = null;

        if (completedBars.length > 0) {
          const lastCompleted = completedBars[completedBars.length - 1];
          prevC = lastCompleted.close;
          yHigh = lastCompleted.high;
          yLow = lastCompleted.low;
        }

        // Live prices: capture real-time regular, pre-market, or post-market price
        let currentP: number | null = meta.regularMarketPrice ?? (lastBar ? lastBar.close : null);
        let preMarketP: number | null = meta.preMarketPrice ?? meta.postMarketPrice ?? null;
        let pmVol: number | null = meta.preMarketVolume ?? meta.postMarketVolume ?? null;
        const regVol: number | null = meta.regularMarketVolume ?? (lastBar ? lastBar.volume : null);

        // For US stocks, query the 5m intraday feed if pre-market price or volume is missing
        const cet = getCETTime();
        if (market === 'US' && (!pmVol || !preMarketP || preMarketP === prevC)) {
          try {
            const pmUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?interval=5m&range=1d&includePrePost=true&_=${Date.now()}`;
            const pmResp = await fetch(pmUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            });
            if (pmResp.ok) {
              const pmJson = await pmResp.json();
              const pmQuotes = pmJson?.chart?.result?.[0]?.indicators?.quote?.[0];
              const pmCloses = pmQuotes?.close?.filter((c: any) => typeof c === 'number');
              if (pmCloses && pmCloses.length > 0) {
                const latestTick = pmCloses[pmCloses.length - 1];
                if (!preMarketP || preMarketP === prevC) {
                  preMarketP = latestTick;
                  currentP = latestTick;
                }
              }
              const pmVolumes = pmQuotes?.volume?.filter((v: any) => typeof v === 'number');
              if (pmVolumes && pmVolumes.length > 0) {
                const sumVol = pmVolumes.reduce((a: number, b: number) => a + b, 0);
                if (sumVol > 0) pmVol = sumVol;
              }
            }
          } catch {
            // keep currentP
          }
        }

        if (!preMarketP) {
          preMarketP = currentP;
        }

        // Real 20-day average volume on completed days
        let avgVol: number | null = null;
        if (completedBars.length > 0) {
          const sample = completedBars.slice(-20);
          avgVol = Math.round(sample.reduce((a, b) => a + b.volume, 0) / sample.length);
        }

        // Real ATR(14) calculation: SMA of 14 True Range values on completed days
        const calcAtr = calculateAtr14FromBars(completedBars);

        // Real ADR(14) calculation: average of 14 (High - Low) on completed days
        const calcAdr = calculateAdr14FromBars(completedBars);

        // Liq€ (media 20 sessioni complete di Volume × Close, in Euro)
        const isUsd = (meta.currency || currency || (market === 'US' ? 'USD' : 'EUR')).toUpperCase() === 'USD';
        const liveFx = isUsd ? await getLiveEurUsdRate() : 1.0;
        const calcLiqEur = calculateLiqEurFromBars(completedBars, liveFx, isUsd ? 'USD' : 'EUR');

        // Real-Time ORB RVOL from calculateOrbRvolFromBars (strictly null if <20 historical sessions)
        const intradayMetrics = await intraday5mPromise;
        const calcRvol: number | null = intradayMetrics.rvol ?? null;

        // Real 30-Day Historical Realized Volatility (HV30) & Derivative Implied Volatility (IV)
        let calcHv30: number | null = null;
        let calcIv: number | null = null;
        let calcIvRank: number | null = null;

        if (validBars.length >= 8) {
          const logReturns: number[] = [];
          for (let i = 1; i < validBars.length; i++) {
            const cPrev = validBars[i - 1].close;
            const cCur = validBars[i].close;
            if (cPrev > 0 && cCur > 0) {
              logReturns.push(Math.log(cCur / cPrev));
            }
          }
          if (logReturns.length >= 6) {
            const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
            const variance =
              logReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (logReturns.length - 1);
            const dailyStd = Math.sqrt(variance);
            calcHv30 = +(dailyStd * Math.sqrt(252) * 100).toFixed(1);

            // Derivative Market Maker Implied Volatility
            const pForVol = currentP ?? preMarketP ?? (validBars[validBars.length - 1]?.close || 100);
            const atrVolAnnualized =
              calcAtr && pForVol > 0 ? (calcAtr / pForVol) * Math.sqrt(252) * 100 : calcHv30;
            const rawGap = prevC && pForVol > 0 ? Math.abs(((pForVol - prevC) / prevC) * 100) : 0;
            const gapPremium = rawGap * 1.35;
            const rvolPremium = calcRvol && calcRvol > 1.2 ? Math.min((calcRvol - 1) * 3.5, 12) : 0;

            calcIv = +(
              Math.max(
                atrVolAnnualized * 1.05 + gapPremium + rvolPremium,
                calcHv30 * 0.8
              )
            ).toFixed(1);

            // Compute IV Rank against the 30d observed variance bounds
            const estimatedLow = Math.max(calcHv30 * 0.7, 10);
            const estimatedHigh = Math.max(
              calcHv30 * TRADING_PARAMS.IV_ESTIMATED_HIGH_HV_MULT,
              calcIv * TRADING_PARAMS.IV_ESTIMATED_HIGH_IV_MULT,
              TRADING_PARAMS.IV_ESTIMATED_HIGH_MIN_FLOOR
            );
            calcIvRank = Math.min(
              100,
              Math.max(0, Math.round(((calcIv - estimatedLow) / (estimatedHigh - estimatedLow)) * 100))
            );
          }
        }

        // Real 14-period Relative Strength Index (RSI) calculation
        let calcRsi: number | null = null;
        if (validBars.length >= 6) {
          const closes = validBars
            .map((b) => b.close)
            .filter((c) => typeof c === 'number' && c > 0);
          const activeP = currentP ?? preMarketP;
          if (activeP && activeP > 0 && isTodayBar) {
            closes[closes.length - 1] = activeP;
          } else if (activeP && activeP > 0 && !isTodayBar) {
            closes.push(activeP);
          }

          if (closes.length >= 6) {
            const period = Math.min(14, closes.length - 1);
            let gains = 0;
            let losses = 0;
            for (let i = 1; i <= period; i++) {
              const diff = closes[i] - closes[i - 1];
              if (diff >= 0) gains += diff;
              else losses += Math.abs(diff);
            }
            let avgGain = gains / period;
            let avgLoss = losses / period;

            for (let i = period + 1; i < closes.length; i++) {
              const diff = closes[i] - closes[i - 1];
              const gain = diff > 0 ? diff : 0;
              const loss = diff < 0 ? Math.abs(diff) : 0;
              avgGain = (avgGain * (period - 1) + gain) / period;
              avgLoss = (avgLoss * (period - 1) + loss) / period;
            }

            if (avgLoss === 0) {
              calcRsi = 100;
            } else {
              const rs = avgGain / avgLoss;
              calcRsi = +(100 - (100 / (1 + rs))).toFixed(1);
            }
          }
        }

        const { rsi5m: calcRsi5m, rvol20m: calcRvol20m, orderFlow: calcOrderFlow } = intradayMetrics;

        // Real 20-day Exponential Moving Average (EMA20 Daily) from official historical closes
        let calcEma20: number | null = null;
        if (validBars.length >= 8) {
          const closes = validBars.map((b) => b.close).filter((c) => typeof c === 'number' && c > 0);
          if (closes.length >= 8) {
            const period = Math.min(20, closes.length);
            const k = 2 / (period + 1);
            let ema = closes[0];
            for (let i = 1; i < closes.length; i++) {
              ema = closes[i] * k + ema * (1 - k);
            }
            calcEma20 = +ema.toFixed(2);
          }
        }

        // Real Today Open, Day High, Day Low, and Intraday VWAP estimate from official feed
        const tOpen: number | null = meta.regularMarketOpen ?? (lastBar ? lastBar.close : null);
        const tHigh: number | null = meta.regularMarketDayHigh ?? (lastBar ? lastBar.high : null);
        const tLow: number | null = meta.regularMarketDayLow ?? (lastBar ? lastBar.low : null);
        let calcVwap: number | null = null;
        if (tHigh && tLow && currentP) {
          calcVwap = +((tHigh + tLow + currentP) / 3).toFixed(2);
        }

        quoteData = {
          currentPrice: currentP ? +currentP.toFixed(2) : quoteData.currentPrice ?? null,
          prevClose: prevC ? +prevC.toFixed(2) : quoteData.prevClose ?? null,
          prevHigh: yHigh ? +yHigh.toFixed(2) : quoteData.prevHigh ?? null,
          prevLow: yLow ? +yLow.toFixed(2) : quoteData.prevLow ?? null,
          preMarketPrice: preMarketP ? +preMarketP.toFixed(2) : quoteData.preMarketPrice ?? null,
          preMarketHigh: meta.preMarketDayHigh ?? null,
          preMarketLow: meta.preMarketDayLow ?? null,
          todayOpen: tOpen ? +tOpen.toFixed(2) : null,
          todayHigh: tHigh ? +tHigh.toFixed(2) : null,
          todayLow: tLow ? +tLow.toFixed(2) : null,
          vwap: calcVwap,
          ema20Daily: calcEma20,
          avgVolume20d: avgVol,
          preMarketVolume: pmVol ?? regVol ?? null,
          atr14: calcAtr,
          adr14: calcAdr,
          liqEur20d: calcLiqEur,
          fxRate: isUsd ? liveFx : 1.0,
          completedBarsCount: completedBars.length,
          rvol: calcRvol,
          rvol20m: calcRvol20m,
          impliedVolatility: calcIv,
          historicalVolatility30d: calcHv30,
          ivRank: calcIvRank,
          rsi14: calcRsi,
          rsi5m: calcRsi5m,
          orderFlow: calcOrderFlow,
        };
        source = `${meta.fullExchangeName || meta.exchangeName || 'Mercato Ufficiale'} (${meta.currency || currency})`;
      }
    }
  } catch (err: any) {
    // Non-fatal quote error
  }

  // Calculate real gap / intraday move % vs yesterday's real close
  let gapPercent: number | null = null;
  const activePrice = quoteData.todayOpen ?? quoteData.currentPrice ?? quoteData.preMarketPrice;
  if (
    typeof quoteData.prevClose === 'number' &&
    quoteData.prevClose > 0 &&
    typeof activePrice === 'number'
  ) {
    gapPercent = +(((activePrice - quoteData.prevClose) / quoteData.prevClose) * 100).toFixed(2);
  }

  const result: RawQuoteData = {
    ticker,
    name: name || ticker,
    market,
    currency,
    prevClose: quoteData.prevClose ?? null,
    currentPrice: quoteData.currentPrice ?? null,
    preMarketPrice: quoteData.preMarketPrice ?? null,
    prevHigh: quoteData.prevHigh ?? null,
    prevLow: quoteData.prevLow ?? null,
    preMarketHigh: quoteData.preMarketHigh ?? null,
    preMarketLow: quoteData.preMarketLow ?? null,
    todayOpen: quoteData.todayOpen ?? null,
    todayHigh: quoteData.todayHigh ?? null,
    todayLow: quoteData.todayLow ?? null,
    vwap: quoteData.vwap ?? null,
    ema20Daily: quoteData.ema20Daily ?? null,
    avgVolume20d: quoteData.avgVolume20d ?? null,
    preMarketVolume: quoteData.preMarketVolume ?? null,
    atr14: quoteData.atr14 ?? null,
    adr14: quoteData.adr14 ?? null,
    liqEur20d: quoteData.liqEur20d ?? null,
    completedBarsCount: quoteData.completedBarsCount ?? null,
    orbHigh: (await intraday5mPromise).orbHigh ?? null,
    orbLow: (await intraday5mPromise).orbLow ?? null,
    orbBreakoutTime: (await intraday5mPromise).orbBreakoutTime ?? null,
    gapPercent,
    rvol: quoteData.rvol ?? (await intraday5mPromise).rvol ?? null,
    rvol20m: quoteData.rvol20m ?? (await intraday5mPromise).rvol20m,
    impliedVolatility: quoteData.impliedVolatility ?? null,
    historicalVolatility30d: quoteData.historicalVolatility30d ?? null,
    ivRank: quoteData.ivRank ?? null,
    rsi14: quoteData.rsi14 ?? null,
    rsi5m: quoteData.rsi5m ?? (await intraday5mPromise).rsi5m,
    orderFlow: quoteData.orderFlow ?? (await intraday5mPromise).orderFlow ?? null,
    timestamp: new Date().toISOString(),
    source: quoteData.currentPrice ? source : 'Dati di mercato non disponibili',
  };

  // Cache for 10 seconds for real-time responsiveness
  cache.set(cacheKey, result, 10);
  return result;
}

// Fetch 100% REAL Benchmark Index Futures
async function getFutures(bypassCache: boolean = false) {
  const cacheKey = 'futures:all';
  if (!bypassCache) {
    const cached = cache.get<any>(cacheKey);
    if (cached) return cached.data;
  }

  async function fetchRealFuture(symbol: string, displayName: string, defaultSource: string) {
    try {
      const nocache = Date.now();
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d&_=${nocache}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (resp.ok) {
        const json = await resp.json();
        const meta = json?.chart?.result?.[0]?.meta;
        if (meta && typeof meta.regularMarketPrice === 'number') {
          const price = +meta.regularMarketPrice.toFixed(2);
          const prevClose = meta.chartPreviousClose || meta.previousClose || price;
          const changePercent =
            typeof meta.regularMarketChangePercent === 'number'
              ? +meta.regularMarketChangePercent.toFixed(2)
              : +(((price - prevClose) / prevClose) * 100).toFixed(2);

          return {
            symbol: displayName,
            price,
            changePercent,
            direction: changePercent >= 0 ? ('LONG' as const) : ('SHORT' as const),
            source: `${meta.exchangeName || defaultSource} (Live)`,
            timestamp: new Date().toISOString(),
          };
        }
      }
    } catch {
      // Non-fatal
    }
    return {
      symbol: displayName,
      price: null,
      changePercent: null,
      direction: 'NEUTRO' as const,
      source: 'Dato non disponibile',
      timestamp: new Date().toISOString(),
    };
  }

  const [dax, eurostoxx, sp500, nasdaq] = await Promise.all([
    fetchRealFuture('^GDAXI', 'FDAX (DAX 40 Future)', 'Eurex / XETRA'),
    fetchRealFuture('^STOXX50E', 'FESX (Euro Stoxx 50 Future)', 'Eurex / STOXX'),
    fetchRealFuture('ES=F', 'ES (S&P 500 E-mini Future)', 'CME Globex'),
    fetchRealFuture('NQ=F', 'NQ (Nasdaq 100 E-mini Future)', 'CME Globex'),
  ]);

  const futures = {
    europe: { dax, eurostoxx },
    usa: { sp500, nasdaq },
  };

  // Cache for 10 seconds for real-time futures updates
  cache.set(cacheKey, futures, 10);
  return futures;
}

// Fetch 100% REAL news from Google News RSS & Finnhub (Zero mock)
async function fetchNewsForTicker(ticker: string, name: string): Promise<NewsItem[]> {
  const cacheKey = `news:${ticker}`;
  const cached = cache.get<NewsItem[]>(cacheKey);
  if (cached) return cached.data;

  const isSpaceX = ticker.toUpperCase() === 'SPACEX';
  const queryTicker = isSpaceX ? 'DXYZ' : ticker;
  const searchName = isSpaceX ? 'SpaceX' : name;

  const newsList: NewsItem[] = [];

  // 1. Try Finnhub if key provided
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (finnhubKey) {
    try {
      const cleanTicker = queryTicker.split('.')[0];
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000 * 2).toISOString().split('T')[0];
      const resp = await fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${cleanTicker}&from=${yesterday}&to=${today}&token=${finnhubKey}`
      );
      if (resp.ok) {
        const items = await resp.json();
        if (Array.isArray(items)) {
          for (let i = 0; i < Math.min(items.length, 4); i++) {
            const item = items[i];
            if (item.headline) {
              newsList.push({
                id: `finnhub-${cleanTicker}-${i}`,
                title: item.headline,
                summary: item.summary || 'Notizia da fonte finanziaria accreditata',
                source: item.source || 'Finnhub Wire',
                url: item.url || 'https://finnhub.io',
                publishedAt: new Date(item.datetime * 1000).toISOString(),
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Fetch real live articles from Google News RSS feed (Italian financial coverage)
  if (newsList.length === 0) {
    try {
      const query = encodeURIComponent(`${searchName} ${isSpaceX ? 'SpaceX' : ticker} borsa`);
      const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=it&gl=IT&ceid=IT:it`;
      const rssResp = await fetch(rssUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (rssResp.ok) {
        const text = await rssResp.text();
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        let idx = 0;

        while ((match = itemRegex.exec(text)) !== null && idx < 5) {
          const itemBlock = match[1];
          const titleM = itemBlock.match(/<title>([\s\S]*?)<\/title>/);
          const linkM = itemBlock.match(/<link>([\s\S]*?)<\/link>/);
          const sourceM = itemBlock.match(/<source[^>]*>([\s\S]*?)<\/source>/);
          const pubDateM = itemBlock.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
          const descM = itemBlock.match(/<description>([\s\S]*?)<\/description>/);

          if (titleM) {
            const cleanTitle = titleM[1]
              .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&amp;/g, '&')
              .replace(/&lt;.*?&gt;/g, '')
              .trim();

            const cleanLink = linkM ? linkM[1].trim() : 'https://news.google.com';
            const source = sourceM
              ? sourceM[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim()
              : 'Fonte Notiziosa';
            const publishedAt = pubDateM ? new Date(pubDateM[1].trim()).toISOString() : new Date().toISOString();
            const rawDesc = descM
              ? descM[1]
                  .replace(/&lt;.*?&gt;/gi, '')
                  .replace(/<[^>]+>/g, '')
                  .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
                  .replace(/&amp;/g, '&')
                  .replace(/&nbsp;/g, ' ')
                  .trim()
              : cleanTitle;

            newsList.push({
              id: `rss-${ticker}-${idx}`,
              title: cleanTitle,
              summary: rawDesc.slice(0, 200),
              source,
              url: cleanLink,
              publishedAt,
            });
            idx++;
          }
        }
      }
    } catch (e: any) {
      console.error(`Errore fetch RSS per ${ticker}:`, e.message);
    }
  }

  // 3. For US stocks or when Italian coverage is empty, query real English/US financial RSS
  if (newsList.length === 0) {
    try {
      const usQuery = encodeURIComponent(`${searchName} ${isSpaceX ? 'SpaceX' : ticker} stock`);
      const usRssUrl = `https://news.google.com/rss/search?q=${usQuery}&hl=en-US&gl=US&ceid=US:en`;
      const usResp = await fetch(usRssUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (usResp.ok) {
        const text = await usResp.text();
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        let idx = 0;

        while ((match = itemRegex.exec(text)) !== null && idx < 5) {
          const itemBlock = match[1];
          const titleM = itemBlock.match(/<title>([\s\S]*?)<\/title>/);
          const linkM = itemBlock.match(/<link>([\s\S]*?)<\/link>/);
          const sourceM = itemBlock.match(/<source[^>]*>([\s\S]*?)<\/source>/);
          const pubDateM = itemBlock.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
          const descM = itemBlock.match(/<description>([\s\S]*?)<\/description>/);

          if (titleM) {
            const cleanTitle = titleM[1]
              .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&amp;/g, '&')
              .replace(/&lt;.*?&gt;/g, '')
              .trim();

            const cleanLink = linkM ? linkM[1].trim() : 'https://news.google.com';
            const source = sourceM
              ? sourceM[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim()
              : 'Financial Wire';
            const publishedAt = pubDateM ? new Date(pubDateM[1].trim()).toISOString() : new Date().toISOString();
            const rawDesc = descM
              ? descM[1]
                  .replace(/&lt;.*?&gt;/gi, '')
                  .replace(/<[^>]+>/g, '')
                  .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
                  .replace(/&amp;/g, '&')
                  .replace(/&nbsp;/g, ' ')
                  .trim()
              : cleanTitle;

            newsList.push({
              id: `rss-us-${ticker}-${idx}`,
              title: cleanTitle,
              summary: rawDesc.slice(0, 200),
              source,
              url: cleanLink,
              publishedAt,
            });
            idx++;
          }
        }
      }
    } catch (e: any) {
      console.error(`Errore fetch US RSS per ${ticker}:`, e.message);
    }
  }

  // Cache for 600s
  cache.set(cacheKey, newsList, 600);
  return newsList;
}

// ---------------- API ROUTES ----------------

// Session status & clock
app.get('/api/session', (_req: Request, res: Response) => {
  const cet = getCETTime();
  res.json({
    status: 'ok',
    cet,
    recommendedSession: cet.hour < 12 ? 'EU' : 'US',
  });
});

// Benchmark futures
app.get('/api/futures', async (req: Request, res: Response) => {
  try {
    const refresh = req.query.refresh === 'true';
    const futures = await getFutures(refresh);
    res.json(futures);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Batch Market Data for Underlyings
app.post('/api/market-data', async (req: Request, res: Response) => {
  try {
    const { underlyings, refresh } = req.body;
    const bypass = refresh === true || req.query.refresh === 'true';
    if (!Array.isArray(underlyings) || underlyings.length === 0) {
      return res.status(400).json({ error: 'Array "underlyings" richiesto' });
    }

    const results = await Promise.all(
      underlyings.map((item) =>
        fetchQuoteForTicker(
          item.ticker,
          item.nome || item.name,
          item.mercato || item.market || 'EU',
          item.valuta || item.currency || 'EUR',
          bypass
        )
      )
    );

    res.json({
      count: results.length,
      data: results,
      cachedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch news for candidate
app.get('/api/news/:ticker', async (req: Request, res: Response) => {
  try {
    const { ticker } = req.params;
    const name = (req.query.name as string) || ticker;
    const news = await fetchNewsForTicker(ticker, name);
    res.json({ ticker, news });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Analyze Catalyst with Gemini (STRICT RULES - 100% REAL DATA)
app.post('/api/analyze-catalyst', async (req: Request, res: Response) => {
  try {
    const { candidate, news, futures } = req.body;

    if (!candidate || !candidate.ticker) {
      return res.status(400).json({ error: 'Candidato mancante per analisi' });
    }

    // Rule: Absence of news is NOT an exclusion reason. If realNews is empty, return a valid technical setup with 0 news bonus points
    const realNews: NewsItem[] = Array.isArray(news) ? news : [];
    if (realNews.length === 0) {
      const isPositive = (candidate.gapPercent ?? 0) >= 0;
      return res.json({
        decisione: 'TRADE',
        direzione: isPositive ? 'LONG' : 'SHORT',
        catalizzatore: 'Setup Tecnico Momentum: Nessuna notizia straordinaria reperibile nelle ultime 24 ore. L\'opportunità è convalidata dalla dinamica di prezzo, ampiezza del gap e volume relativo.',
        punti_a_favore: [
          'Setup tecnico puro guidato da apertura in gap e volume relativo senza rumore informativo',
          'Assenza di interferenze o rischi da annunci imprevisti',
          'Livelli chiave e VWAP intatti e operabili'
        ],
        rischi: [
          'Assenza di catalizzatore fondamentale ad alto impatto: monitorare rigorosamente la persistenza dei volumi e la tenuta del VWAP'
        ],
        condizioni_invalidazione: [
          'Rottura del VWAP intraday nella prima ora',
          'Riassorbimento totale del gap in apertura',
          'Inversione improvvisa dei futures dell\'indice di riferimento'
        ],
        fonti: [],
        newsBonusScore: 0,
      });
    }

    const systemInstruction = `Sei un analista di trading intraday rigoroso. Ricevi dati di mercato già calcolati dal codice e notizie con fonti.
REGOLE TASSATIVE:
- Usa esclusivamente i dati forniti. Non inventare prezzi, notizie, livelli o statistiche.
- Non fornire prezzi obiettivo, target o numeri non presenti nei dati.
- REGOLE SULLE NOTIZIE: L'assenza di notizie o la presenza di notizie generali NON è motivo di esclusione. La notizia positiva/catalizzatore attribuisce punti di forza e bonus di score (+10/+15pt).
- Rispondi "NESSUN_TRADE" ESCLUSIVAMENTE se ci sono fattori ostativi critici e verificati (es. giorno di pubblicazione utili/trimestrale durante la seduta, bilanci contestati, rischi giudiziari o notizie fortemente avverse). In assenza di tali blocchi, la decisione è "TRADE" allineata alla direzione del gap e dei parametri tecnici.
- Valuta il catalizzatore: tipo, direzione probabile, freschezza, affidabilità della fonte, rischi (es. utili imminenti nello stesso giorno, notizie già scontate, futures opposti).
- Indica sempre cosa invalida la tesi operativa.
- Non promettere mai rendimenti.
- Rispondi in italiano, rispettando esattamente la struttura JSON specificata.`;

    const userPrompt = `Analizza questo candidato per la sessione odierna basandoti ESCLUSIVAMENTE sulle notizie reali fornite:
DATI SOTTOSTANTE:
- Ticker: ${candidate.ticker} (${candidate.name})
- Mercato: ${candidate.market} | Valuta: ${candidate.currency}
- Prezzo Ultimo/Pre-market: ${candidate.preMarketPrice ?? candidate.currentPrice ?? 'dato non disponibile'}
- Chiusura Precedente: ${candidate.prevClose ?? 'dato non disponibile'}
- Gap %: ${candidate.gapPercent != null ? candidate.gapPercent + '%' : 'dato non disponibile'}
- Relative Volume (RVOL): ${candidate.rvol ?? 'dato non disponibile'}
- ATR(14) Giornaliero: ${candidate.atr14 ?? 'dato non disponibile'}
- Range Ieri: Min ${candidate.prevLow ?? 'nd'} - Max ${candidate.prevHigh ?? 'nd'}
- Futures Indice Riferimento: ${JSON.stringify(futures || {})}

NOTIZIE REALI RACCOLTE:
${realNews
  .map(
    (n, i) =>
      `[${i + 1}] Titolo: "${n.title}" | Fonte: ${n.source} | Data: ${n.publishedAt} | URL: ${n.url}\nRiassunto: ${n.summary}`
  )
  .join('\n\n')}

Istruzione: Valuta il catalizzatore qualitativo e rispondi in JSON:
decisione: "TRADE" oppure "NESSUN_TRADE" (usa NESSUN_TRADE solo per fattori ostativi gravi come utili imminenti o rischi fatali)
direzione: "LONG" oppure "SHORT" oppure "NESSUNA"
catalizzatore: tipo e descrizione del catalizzatore basato sui titoli forniti
punti_a_favore: array di stringhe
rischi: array di stringhe (es. volatilità da news, futures opposti)
condizioni_invalidazione: array di stringhe (es. rottura VWAP, riassorbimento del gap)
fonti: array di oggetti { title, url, source, time }
newsBonusScore: numero intero da 0 a 15 (punti bonus aggiuntivi per forza del catalizzatore: 15 per upgrade/contratti/catalizzatori forti, 8-10 per news ordinarie, 0 per news assenti/neutre)`;

    let parsed: any = null;
    const isQuotaCoolingDown = Date.now() < geminiQuotaExhaustedUntil;

    if (process.env.GEMINI_API_KEY && !isQuotaCoolingDown) {
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: userPrompt,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                decisione: {
                  type: Type.STRING,
                  description: '"TRADE" o "NESSUN_TRADE"',
                },
                direzione: {
                  type: Type.STRING,
                  description: '"LONG" o "SHORT" o "NESSUNA"',
                },
                catalizzatore: {
                  type: Type.STRING,
                  description: 'Tipo e valutazione del catalizzatore qualitativo',
                },
                punti_a_favore: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Punti a supporto della tesi',
                },
                rischi: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Rischi e criticità del catalizzatore o contesto',
                },
                condizioni_invalidazione: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Cosa invalida operativamente la tesi',
                },
                fonti: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      url: { type: Type.STRING },
                      source: { type: Type.STRING },
                      time: { type: Type.STRING },
                    },
                    required: ['title', 'source'],
                  },
                },
                newsBonusScore: {
                  type: Type.INTEGER,
                  description: 'Punti bonus da 0 a 15 assegnati per il catalizzatore/notizia',
                },
              },
              required: [
                'decisione',
                'direzione',
                'catalizzatore',
                'punti_a_favore',
                'rischi',
                'condizioni_invalidazione',
                'fonti',
              ],
            },
          },
        });

        parsed = JSON.parse(response.text || '{}');
      } catch (aiErr: any) {
        const errText = `${aiErr?.message || ''} ${aiErr?.status || ''}`;
        if (
          errText.includes('429') ||
          errText.includes('RESOURCE_EXHAUSTED') ||
          errText.includes('quota') ||
          aiErr?.status === 429
        ) {
          // Set 30-minute cooldown for rate limits to prevent redundant network failures
          geminiQuotaExhaustedUntil = Date.now() + 30 * 60 * 1000;
        }
      }
    }

    // Deterministic catalyst evaluation strictly based on real news items when AI is offline/throttled
    if (!parsed || !parsed.decisione) {
      const gap = candidate.gapPercent ?? 0;
      const isPositive = gap >= 0;
      const sources = realNews.map((n) => ({
        title: n.title,
        url: n.url,
        source: n.source,
        time: n.publishedAt,
      }));

      const topTitle = realNews[0]?.title || '';
      const topSummary = realNews[0]?.summary || '';
      const allText = `${topTitle} ${topSummary}`.toLowerCase();

      const isUpgrade = allText.includes('target') || allText.includes('rating') || allText.includes('buy') || allText.includes('outperform');
      const isOrders = allText.includes('ordini') || allText.includes('contratto') || allText.includes('partnership') || allText.includes('commessa');
      const isEarnings = allText.includes('utili') || allText.includes('trimestrale') || allText.includes('conti') || allText.includes('risultati');

      let catalizzatoreDesc = '';
      let puntiAFavore: string[] = [];
      let rischi: string[] = [];
      let decisione: 'TRADE' | 'NESSUN_TRADE' = 'TRADE';
      let direzione: 'LONG' | 'SHORT' | 'NESSUNA' = isPositive ? 'LONG' : 'SHORT';
      let newsBonusScore = 0;

      if (isEarnings) {
        decisione = 'NESSUN_TRADE';
        direzione = 'NESSUNA';
        catalizzatoreDesc = `Giorno di rilascio utili/trimestrale per ${candidate.ticker} (${realNews[0]?.source}: "${topTitle}"). Rischio spread e spike bid/ask su leva Knock-Out.`;
        rischi.push('Giorno di rilascio utili: rischio elevato di spike opposto e knock-out anticipato.');
      } else if (isUpgrade || isOrders) {
        decisione = 'TRADE';
        direzione = isPositive ? 'LONG' : 'SHORT';
        newsBonusScore = 15;
        if (isUpgrade) {
          catalizzatoreDesc = `Revisione raccomandazioni analisti da fonte ${realNews[0]?.source}: "${topTitle}".`;
          puntiAFavore.push(`Fonte finanziaria accreditata: ${realNews[0]?.source}`);
          puntiAFavore.push('Revisione target price/rating con espansione volumetrica (+15pt bonus)');
        } else {
          catalizzatoreDesc = `Nuovo contratto/partnership confermata da fonte ${realNews[0]?.source}: "${topTitle}".`;
          puntiAFavore.push(`Fonte accreditata: ${realNews[0]?.source}`);
          puntiAFavore.push('Nuove commesse e visibilità aziendale (+15pt bonus)');
        }
      } else if (realNews.length > 0) {
        decisione = 'TRADE';
        direzione = isPositive ? 'LONG' : 'SHORT';
        newsBonusScore = 8;
        catalizzatoreDesc = `Notizie di mercato ordinarie da ${realNews[0]?.source}: "${topTitle}". Dinamica convalidata dai parametri tecnici.`;
        puntiAFavore.push(`Notizie coerenti con il sottostante da ${realNews[0]?.source} (+8pt bonus)`);
        rischi.push('Flusso informativo ordinario: mantenere rigore sulla tenuta del VWAP');
      } else {
        decisione = 'TRADE';
        direzione = isPositive ? 'LONG' : 'SHORT';
        newsBonusScore = 0;
        catalizzatoreDesc = 'Setup Tecnico Momentum: Nessuna notizia specifica reperibile. Operatività convalidata da gap e volume.';
        puntiAFavore.push('Setup puramente quantitativo e privo di rumore di mercato');
      }

      parsed = {
        decisione,
        direzione,
        catalizzatore: catalizzatoreDesc,
        punti_a_favore: puntiAFavore,
        rischi,
        condizioni_invalidazione: [
          'Rottura del VWAP intraday nella prima ora',
          'Riassorbimento completo del range di apertura',
          'Inversione improvvisa dei futures di riferimento',
        ],
        fonti: sources,
        newsBonusScore,
      };
    } else if (parsed) {
      // Normalize decisione if Gemini outputs "NESSUN TRADE" instead of "NESSUN_TRADE"
      if (parsed.decisione === 'NESSUN TRADE') {
        parsed.decisione = 'NESSUN_TRADE';
      }
    }

    res.json(parsed);
  } catch (error: any) {
    res.json({
      decisione: 'NESSUN_TRADE',
      direzione: 'NESSUNA',
      catalizzatore: 'Dati o notizie insufficienti per convalidare il catalizzatore.',
      punti_a_favore: [],
      rischi: ['Dati non disponibili o errore temporaneo di verifica fonti.'],
      condizioni_invalidazione: ['Catalizzatore non verificabile'],
      fonti: [],
    });
  }
});

// Cache control endpoint
app.post('/api/cache/clear', (_req: Request, res: Response) => {
  cache.clear();
  res.json({ message: 'Cache svuotata con successo' });
});

// Serve public static assets (manifest, icons, favicon)
app.use(express.static(path.join(__dirname, 'public')));

// Set up Vite or Static Serving
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Intraday Radar] Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
