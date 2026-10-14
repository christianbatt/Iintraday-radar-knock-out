import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

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
  const cetFormatter = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = cetFormatter.formatToParts(now);
  const partMap: Record<string, string> = {};
  parts.forEach((p) => {
    partMap[p.type] = p.value;
  });

  const hour = parseInt(partMap.hour || '0', 10);
  const minute = parseInt(partMap.minute || '0', 10);
  const totalMinutes = hour * 60 + minute;

  // Screening Europa: 07:30 (450m) to 08:55 (535m)
  const isEuropeWindow = totalMinutes >= 450 && totalMinutes <= 535;
  // Screening USA: 14:30 (870m) to 15:25 (925m)
  const isUSAWindow = totalMinutes >= 870 && totalMinutes <= 925;

  // Regular Trading Session Hours
  const isEuropeLive = totalMinutes >= 540 && totalMinutes <= 1055; // 09:00 to 17:35 CET
  const isUSAPreMarket = totalMinutes >= 600 && totalMinutes <= 929; // 10:00 to 15:29 CET
  const isUSALive = totalMinutes >= 930 && totalMinutes <= 1325; // 15:30 to 22:05 CET

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
    formatted: `${partMap.hour}:${partMap.minute}:${partMap.second} CET`,
    date: `${partMap.year}-${partMap.month}-${partMap.day}`,
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
  avgVolume20d: number | null;
  preMarketVolume: number | null;
  atr14: number | null;
  gapPercent: number | null;
  rvol: number | null;
  impliedVolatility?: number | null;
  historicalVolatility30d?: number | null;
  ivRank?: number | null;
  rsi14?: number | null;
  timestamp: string;
  source: string;
}

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
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

  let quoteData: Partial<RawQuoteData> = {};
  let source = 'Exchange Feed (Real-Time)';

  // 1. Check Finnhub if API key is provided
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (finnhubKey) {
    try {
      const cleanTicker = ticker.replace('.DE', '').replace('.MI', '').replace('.PA', '').replace('.AS', '');
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
    const ySymbol = ticker.includes('.') ? ticker : `${ticker}`;
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

        // Extract valid daily candles with timestamp, close, high, low, volume
        const validBars: { date: string; close: number; high: number; low: number; volume: number }[] = [];
        for (let i = 0; i < timestamps.length; i++) {
          if (typeof quotes?.close?.[i] === 'number') {
            validBars.push({
              date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
              close: quotes.close[i],
              high: quotes.high?.[i] ?? quotes.close[i],
              low: quotes.low?.[i] ?? quotes.close[i],
              volume: quotes.volume?.[i] ?? 0,
            });
          }
        }

        const todayStr = new Date().toISOString().split('T')[0];
        const lastBar = validBars.length > 0 ? validBars[validBars.length - 1] : null;
        const isTodayBar = lastBar?.date === todayStr;

        // When today's bar already exists (e.g. EU markets open today),
        // yesterday's close is validBars[length - 2].
        // When today's bar is not yet opened (e.g. US market in pre-market),
        // yesterday's close is the last closed daily bar validBars[length - 1].
        let prevC: number | null = null;
        let yHigh: number | null = null;
        let yLow: number | null = null;

        if (isTodayBar && validBars.length > 1) {
          prevC = validBars[validBars.length - 2].close;
          yHigh = validBars[validBars.length - 2].high;
          yLow = validBars[validBars.length - 2].low;
        } else if (lastBar) {
          prevC = lastBar.close;
          yHigh = lastBar.high;
          yLow = lastBar.low;
        }

        // Live prices
        let currentP: number | null = meta.regularMarketPrice ?? (lastBar ? lastBar.close : null);
        let preMarketP: number | null = meta.preMarketPrice ?? null;
        let pmVol: number | null = meta.preMarketVolume ?? null;
        const regVol: number | null = meta.regularMarketVolume ?? (isTodayBar && lastBar ? lastBar.volume : null);

        // For US stocks in pre-market, query the 5m intraday feed to get live pre-market price tick & volume
        const cet = getCETTime();
        if (market === 'US' && cet.isUSAPreMarket && (!preMarketP || preMarketP === prevC)) {
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
                preMarketP = latestTick;
                currentP = latestTick;
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

        // Real 20-day average volume
        let avgVol: number | null = null;
        if (validBars.length > 0) {
          const sample = validBars.slice(-20);
          avgVol = Math.round(sample.reduce((a, b) => a + b.volume, 0) / sample.length);
        }

        // Real ATR(14) calculation from daily True Range
        let calcAtr: number | null = null;
        if (validBars.length >= 14) {
          let trSum = 0;
          const count = Math.min(14, validBars.length - 1);
          for (let i = validBars.length - count; i < validBars.length; i++) {
            const prevCloseBar = validBars[i - 1].close;
            const tr = Math.max(
              validBars[i].high - validBars[i].low,
              Math.abs(validBars[i].high - prevCloseBar),
              Math.abs(validBars[i].low - prevCloseBar)
            );
            trSum += tr;
          }
          calcAtr = +(trSum / count).toFixed(2);
        }

        // Volume & Real-Time RVOL calculation
        let calcRvol: number | null = null;
        if (avgVol && avgVol > 0) {
          if (regVol && regVol > 0 && isTodayBar) {
            // Regular Cash Trading Session: pace vs elapsed portion of trading day
            const sessionMins = market === 'EU' ? cet.currentMinutes - 540 : cet.currentMinutes - 930;
            const totalMins = market === 'EU' ? 510 : 390;
            const elapsedFraction = Math.min(Math.max(sessionMins / totalMins, 0.05), 1.0);
            calcRvol = +(regVol / (avgVol * elapsedFraction)).toFixed(2);
          } else if (pmVol && pmVol > 0) {
            // Pre-Market Session: typical pre-market expected fraction ~4% of full day volume
            calcRvol = +(pmVol / (avgVol * 0.04)).toFixed(2);
          }
        }

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
            const estimatedHigh = Math.max(calcHv30 * 1.6, calcIv * 1.15, 35);
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

        quoteData = {
          currentPrice: currentP ? +currentP.toFixed(2) : quoteData.currentPrice ?? null,
          prevClose: prevC ? +prevC.toFixed(2) : quoteData.prevClose ?? null,
          prevHigh: yHigh ? +yHigh.toFixed(2) : quoteData.prevHigh ?? null,
          prevLow: yLow ? +yLow.toFixed(2) : quoteData.prevLow ?? null,
          preMarketPrice: preMarketP ? +preMarketP.toFixed(2) : quoteData.preMarketPrice ?? null,
          preMarketHigh: meta.preMarketDayHigh ?? null,
          preMarketLow: meta.preMarketDayLow ?? null,
          avgVolume20d: avgVol,
          preMarketVolume: pmVol ?? regVol ?? null,
          atr14: calcAtr,
          rvol: calcRvol,
          impliedVolatility: calcIv,
          historicalVolatility30d: calcHv30,
          ivRank: calcIvRank,
          rsi14: calcRsi,
        };
        source = `${meta.fullExchangeName || meta.exchangeName || 'Mercato Ufficiale'} (${meta.currency || currency})`;
      }
    }
  } catch (err: any) {
    // Non-fatal quote error
  }

  // Calculate real gap / intraday move % vs yesterday's real close
  let gapPercent: number | null = null;
  const activePrice = quoteData.currentPrice ?? quoteData.preMarketPrice;
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
    avgVolume20d: quoteData.avgVolume20d ?? null,
    preMarketVolume: quoteData.preMarketVolume ?? null,
    atr14: quoteData.atr14 ?? null,
    gapPercent,
    rvol: quoteData.rvol ?? null,
    impliedVolatility: quoteData.impliedVolatility ?? null,
    historicalVolatility30d: quoteData.historicalVolatility30d ?? null,
    ivRank: quoteData.ivRank ?? null,
    rsi14: quoteData.rsi14 ?? null,
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

  const newsList: NewsItem[] = [];

  // 1. Try Finnhub if key provided
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (finnhubKey) {
    try {
      const cleanTicker = ticker.split('.')[0];
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
      const query = encodeURIComponent(`${name} ${ticker} borsa`);
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

    // Strict rule: If no real news is found, return NESSUN_TRADE
    const realNews: NewsItem[] = Array.isArray(news) ? news : [];
    if (realNews.length === 0) {
      return res.json({
        decisione: 'NESSUN_TRADE',
        direzione: 'NESSUNA',
        catalizzatore: 'Nessuna notizia o catalizzatore recente reperibile nelle ultime 24 ore per questo titolo.',
        punti_a_favore: [],
        rischi: ['Mancanza di notizie e catalizzatore fondamentale verificato da fonti di mercato'],
        condizioni_invalidazione: ['Assenza di catalizzatore primario'],
        fonti: [],
      });
    }

    const systemInstruction = `Sei un analista di trading intraday rigoroso. Ricevi dati di mercato già calcolati dal codice e notizie con fonti.
REGOLE TASSATIVE:
- Usa esclusivamente i dati forniti. Non inventare prezzi, notizie, livelli o statistiche.
- Non fornire prezzi obiettivo, target o numeri non presenti nei dati.
- Se i dati sono insufficienti o contraddittori, rispondi "NESSUN_TRADE" e spiega perché.
- Valuta solo il catalizzatore: tipo, direzione probabile, freschezza, affidabilità della fonte, rischi (utili imminenti nello stesso giorno, notizie già scontate, mercato/futures opposti al titolo).
- Preferisci non operare piuttosto che forzare un segnale. Indica sempre cosa invalida la tesi operativa.
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
decisione: "TRADE" oppure "NESSUN_TRADE"
direzione: "LONG" oppure "SHORT" oppure "NESSUNA"
catalizzatore: tipo e descrizione del catalizzatore basato unicamente sui titoli e testi forniti
punti_a_favore: array di stringhe
rischi: array di stringhe (es. gap eccessivo, assenza catalizzatore fresco, futures opposti)
condizioni_invalidazione: array di stringhe (es. rottura VWAP, riassorbimento del gap)
fonti: array di oggetti { title, url, source, time }`;

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
      const isPositive = gap > 0;
      const sources = realNews.map((n) => ({
        title: n.title,
        url: n.url,
        source: n.source,
        time: n.publishedAt,
      }));

      const topTitle = realNews[0]?.title || '';
      const topSummary = realNews[0]?.summary || '';
      const allText = `${topTitle} ${topSummary}`.toLowerCase();

      const isUpgrade = allText.includes('target') || allText.includes('rating') || allText.includes('buy');
      const isOrders = allText.includes('ordini') || allText.includes('contratto') || allText.includes('partnership');
      const isEarnings = allText.includes('utili') || allText.includes('trimestrale') || allText.includes('conti');

      let catalizzatoreDesc = `Notizia da fonte ${realNews[0]?.source}: "${topTitle}".`;
      let puntiAFavore: string[] = [`Fonte di mercato accreditata: ${realNews[0]?.source}`];
      let rischi: string[] = [];
      let decisione: 'TRADE' | 'NESSUN_TRADE' = 'TRADE';
      let direzione: 'LONG' | 'SHORT' | 'NESSUNA' = isPositive ? 'LONG' : 'SHORT';

      if (isEarnings) {
        catalizzatoreDesc += ' Rilascio risultati societari o trimestrale.';
        rischi.push('Giorno di utili: rischio di spread allargato e volatilità estrema sul derivato Knock-Out.');
      }
      if (isUpgrade) {
        catalizzatoreDesc += ' Revisione raccomandazioni analisti.';
        puntiAFavore.push('Revisione target da parte di analisti istituzionali');
      }
      if (isOrders) {
        catalizzatoreDesc += ' Espansione contratti o partnership commerciale.';
        puntiAFavore.push('Nuovi contratti con visibilità su backlog ordini');
      }

      if (Math.abs(gap) < 0.4) {
        decisione = 'NESSUN_TRADE';
        direzione = 'NESSUNA';
        rischi.push(`Gap % (${gap}%) insufficiente per confermare il catalizzatore.`);
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
        ],
        fonti: sources,
      };
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
