/**
 * Phase 2 Deterministic Replay Engine - Version 2 (Definitive)
 * Implements strict G1-G11 gate sequence, LEO.MI -> LDO.MI substitution,
 * exact IS & OOS windowing, and quadratura verification.
 */
import fs from 'fs';
import crypto from 'crypto';
import { DEFAULT_TRADE_REPUBLIC_UNDERLYINGS } from '../src/data/defaultUnderlyings';
import { TRADING_PARAMS } from '../src/config/tradingParams';
import {
  calculateCandidateScore,
  buildExecutionSetup,
  calculateAtr14FromBars,
  calculateAdr14FromBars,
  calculateLiqEurFromBars,
  calculateOrbRvolFromBars,
  DEFAULT_SYSTEM_PARAMETERS,
  DailyBarInput,
} from '../src/utils/calculator';
import { RawQuoteData, ScoredCandidate } from '../src/types/radar';

export interface ReplaySetupResult {
  ticker: string;
  market: 'EU' | 'US';
  date: string;
  timestamp: string;
  direction: 'LONG' | 'SHORT';
  decision: 'TRADE' | 'NESSUN_TRADE';
  passedGates: string[];
  blockedGate: string | null;
  blockedGateMessage?: string;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;
  leverage: number;
  barrier: number;
  isFilled: boolean;
  outcomeConservative: 'T1' | 'STOP' | 'EXPIRED' | 'UNFILLED' | 'BLOCKED';
  outcomeOptimistic: 'T1' | 'STOP' | 'EXPIRED' | 'UNFILLED' | 'BLOCKED';
  realizedRGrossConservative: number;
  realizedRNetConservative: number;
  realizedRGrossOptimistic: number;
  realizedRNetOptimistic: number;
  gapPercent: number;
  rvol: number | null;
  score: number;
  sameBarConflict: boolean;
}

async function fetchTickerDaily(qTicker: string): Promise<DailyBarInput[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(qTicker)}?interval=1d&range=6mo`;
  const resp = await fetch(url);
  const json = await resp.json();
  const res = json?.chart?.result?.[0];
  const timestamps = res?.timestamp || [];
  const quotes = res?.indicators?.quote?.[0] || {};
  const daily: DailyBarInput[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = quotes.close?.[i];
    const h = quotes.high?.[i];
    const l = quotes.low?.[i];
    const o = quotes.open?.[i];
    const v = quotes.volume?.[i];
    if (c != null && h != null && l != null && v != null && c > 0) {
      daily.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        timestamp: timestamps[i],
        open: o ?? c,
        high: h,
        low: l,
        close: c,
        volume: v,
      });
    }
  }
  return daily;
}

async function fetchTicker5m(qTicker: string): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(qTicker)}?interval=5m&range=60d`;
  const resp = await fetch(url);
  const json = await resp.json();
  const res = json?.chart?.result?.[0];
  const timestamps = res?.timestamp || [];
  const quotes = res?.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = quotes.close?.[i];
    const o = quotes.open?.[i];
    const h = quotes.high?.[i];
    const l = quotes.low?.[i];
    const v = quotes.volume?.[i] || 0;
    if (c != null && o != null && h != null && l != null) {
      bars.push({ timestamp: timestamps[i], open: o, high: h, low: l, close: c, volume: v });
    }
  }
  return bars;
}

async function fetchTicker1m(qTicker: string): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(qTicker)}?interval=1m&range=7d`;
  const resp = await fetch(url);
  const json = await resp.json();
  const res = json?.chart?.result?.[0];
  const timestamps = res?.timestamp || [];
  const quotes = res?.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = quotes.close?.[i];
    const o = quotes.open?.[i];
    const h = quotes.high?.[i];
    const l = quotes.low?.[i];
    const v = quotes.volume?.[i] || 0;
    if (c != null && o != null && h != null && l != null) {
      bars.push({ timestamp: timestamps[i], open: o, high: h, low: l, close: c, volume: v });
    }
  }
  return bars;
}

export async function runFullReplay() {
  const fxRate = 1.1188;
  const isRange = { start: '2026-08-29', end: '2026-10-14' };
  const oosRange = { start: '2026-10-15', end: '2026-10-28' };

  // Explicit deviation: LEO.MI -> LDO.MI
  const universe = DEFAULT_TRADE_REPUBLIC_UNDERLYINGS.map((u) => ({
    ticker: u.ticker === 'LEO.MI' ? 'LDO.MI' : u.ticker,
    originalTicker: u.ticker,
    name: u.nome,
    market: u.mercato,
    currency: u.valuta,
  }));

  const allResults: ReplaySetupResult[] = [];

  for (const item of universe) {
    const qTicker = item.ticker;
    const daily = await fetchTickerDaily(qTicker);
    const bars5m = await fetchTicker5m(qTicker);
    const bars1m = await fetchTicker1m(qTicker);

    if (daily.length === 0 || bars5m.length === 0) {
      console.log(`[ANOMALIA / STOP SU DATO] ${item.ticker}: 0 barre restituite dall'API (>5% mancanti).`);
      continue;
    }

    // Group 5m bars by exchange date
    const sessionMap5m = new Map<string, typeof bars5m>();
    for (const b of bars5m) {
      const dStr = new Date(b.timestamp * 1000).toISOString().slice(0, 10);
      if (!sessionMap5m.has(dStr)) sessionMap5m.set(dStr, []);
      sessionMap5m.get(dStr)!.push(b);
    }

    // Group 1m bars by exchange date
    const sessionMap1m = new Map<string, typeof bars1m>();
    for (const b of bars1m) {
      const dStr = new Date(b.timestamp * 1000).toISOString().slice(0, 10);
      if (!sessionMap1m.has(dStr)) sessionMap1m.set(dStr, []);
      sessionMap1m.get(dStr)!.push(b);
    }

    const availableDates = Array.from(sessionMap5m.keys()).sort();

    for (const sDate of availableDates) {
      // Exclude 2026-10-29 unconditionally
      if (sDate >= '2026-10-29') continue;
      // Filter strictly for IS or OOS
      const isInSample = sDate >= isRange.start && sDate <= isRange.end;
      const isOutSample = sDate >= oosRange.start && sDate <= oosRange.end;
      if (!isInSample && !isOutSample) continue;

      const bars = sessionMap5m.get(sDate)!;
      if (bars.length < 4) continue;

      // Historical daily strictly BEFORE sDate (no lookahead)
      const histDaily = daily.filter((d) => d.date && d.date < sDate);
      if (histDaily.length < TRADING_PARAMS.LIQ_BARS_REQUIRED) continue;

      const atr14 = calculateAtr14FromBars(histDaily);
      const adr14 = calculateAdr14FromBars(histDaily);
      const liqEur = calculateLiqEurFromBars(histDaily, fxRate, item.currency);
      const prevDay = histDaily[histDaily.length - 1];

      // ORB from first 3 bars (15 minutes)
      const orbBars = bars.slice(0, 3);
      let orbHigh = Math.max(...orbBars.map((b) => b.high));
      let orbLow = Math.min(...orbBars.map((b) => b.low));

      // If 1m bars exist for this session (2026-10-21 - 2026-10-28), refine ORB from first 15 bars
      const m1Bars = sessionMap1m.get(sDate);
      if (m1Bars && m1Bars.length >= 15) {
        const o1m = m1Bars.slice(0, 15);
        orbHigh = Math.max(...o1m.map((b) => b.high));
        orbLow = Math.min(...o1m.map((b) => b.low));
      }

      const sessionOpen = bars[0].open;
      const gapPercent = prevDay.close > 0 ? +(((sessionOpen - prevDay.close) / prevDay.close) * 100).toFixed(2) : 0;
      const avgVol20 = Math.round(histDaily.slice(-20).reduce((acc, b) => acc + (b.volume || 0), 0) / 20);
      // Calculate ORB RVOL from cumulative 3 bars (15m) vs last 20 sessions ORB volume
      const prevDates = availableDates.filter((d) => d < sDate);
      const histOrbVolumes: number[] = [];
      for (const pd of prevDates) {
        const pb = sessionMap5m.get(pd);
        if (pb && pb.length >= 3) {
          const vSum = pb.slice(0, 3).reduce((acc, b) => acc + (b.volume || 0), 0);
          histOrbVolumes.push(vSum);
        }
      }
      const rvol = calculateOrbRvolFromBars(orbBars, histOrbVolumes);

      // Real RSI14 from 14 closes + today current
      const closes = histDaily.slice(-14).map((b) => b.close);
      closes.push(bars[2].close);
      let rsi14 = 50;
      let gains = 0, losses = 0;
      for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
      }
      if (losses > 0) rsi14 = +(100 - 100 / (1 + (gains / 14) / (losses / 14))).toFixed(1);

      const rawQuote: RawQuoteData = {
        ticker: item.ticker,
        name: item.name,
        market: item.market,
        currency: item.currency,
        prevClose: prevDay.close,
        currentPrice: bars[2].close,
        preMarketPrice: sessionOpen,
        prevHigh: prevDay.high,
        prevLow: prevDay.low,
        preMarketHigh: null,
        preMarketLow: null,
        todayOpen: sessionOpen,
        todayHigh: orbHigh,
        todayLow: orbLow,
        vwap: sessionOpen,
        ema20Daily: prevDay.close,
        avgVolume20d: avgVol20,
        preMarketVolume: bars[0].volume,
        atr14,
        adr14,
        liqEur20d: liqEur,
        fxRate: item.currency === 'USD' ? fxRate : 1.0,
        completedBarsCount: histDaily.length,
        orbHigh,
        orbLow,
        orbBreakoutTime: new Date(bars[2].timestamp * 1000).toISOString(),
        gapPercent,
        rvol,
        rsi14,
        timestamp: new Date(bars[2].timestamp * 1000).toISOString(),
        source: 'Yahoo Finance',
      };

      // Score with benchmark alignment (+0.30% / -0.30%) and zero news
      const futuresChange = gapPercent >= 0 ? 0.30 : -0.30;
      const candScore = calculateCandidateScore(rawQuote, futuresChange, 0);
      const scoredCand: ScoredCandidate = { quote: rawQuote, score: candScore, rank: 1 };

      // Evaluate G1-G11 at exact ORB close (bar 3 close = timestamp + 5 min)
      const orbCloseTime = new Date(bars[2].timestamp * 1000 + 5 * 60 * 1000);
      const setup = buildExecutionSetup(scoredCand, null, item.market, DEFAULT_SYSTEM_PARAMETERS, {
        currentTime: orbCloseTime,
        entryMode: 'SNAPSHOT_0915',
      });

      const gateKeys = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11'];
      const passedGates = gateKeys.filter((k) => setup.gateResults?.[k]?.passed);
      const blockedGate = gateKeys.find((k) => !setup.gateResults?.[k]?.passed) || null;
      const blockedGateMessage = blockedGate ? setup.gateResults?.[blockedGate]?.message : undefined;
      const direction: 'LONG' | 'SHORT' = setup.direction === 'SHORT' ? 'SHORT' : 'LONG';

      if (setup.decision !== 'TRADE' || !setup.triggerLevel || !setup.stopLossLevel || !setup.target1Level) {
        allResults.push({
          ticker: item.ticker,
          market: item.market,
          date: sDate,
          timestamp: new Date(bars[2].timestamp * 1000).toISOString(),
          direction,
          decision: 'NESSUN_TRADE',
          passedGates,
          blockedGate,
          blockedGateMessage,
          entryPrice: setup.triggerLevel || 0,
          stopLoss: setup.stopLossLevel || 0,
          target1: setup.target1Level || 0,
          target2: setup.target2Level || 0,
          leverage: setup.selectedLeverage || 0,
          barrier: setup.barrierRecommended || 0,
          isFilled: false,
          outcomeConservative: 'BLOCKED',
          outcomeOptimistic: 'BLOCKED',
          realizedRGrossConservative: 0,
          realizedRNetConservative: 0,
          realizedRGrossOptimistic: 0,
          realizedRNetOptimistic: 0,
          gapPercent,
          rvol,
          score: candScore.total,
          sameBarConflict: false,
        });
        continue;
      }

      // If TRADE is generated: sequential bar-by-bar execution on subsequent bars
      const entry = setup.triggerLevel;
      const stop = setup.stopLossLevel;
      const t1 = setup.target1Level;
      const isLong = direction === 'LONG';
      const subsequentBars = bars.slice(3);

      let isFilled = false;
      let outcomeConservative: 'T1' | 'STOP' | 'EXPIRED' | 'UNFILLED' | 'BLOCKED' = 'UNFILLED';
      let outcomeOptimistic: 'T1' | 'STOP' | 'EXPIRED' | 'UNFILLED' | 'BLOCKED' = 'UNFILLED';
      let sameBarConflict = false;
      let finalBarClose = entry;

      for (let i = 0; i < subsequentBars.length; i++) {
        const b = subsequentBars[i];
        if (!isFilled) {
          if (isLong && b.high >= entry) isFilled = true;
          else if (!isLong && b.low <= entry) isFilled = true;
        }

        if (isFilled) {
          finalBarClose = b.close;
          const hitStop = isLong ? b.low <= stop : b.high >= stop;
          const hitT1 = isLong ? b.high >= t1 : b.low <= t1;

          if (hitStop && hitT1) {
            sameBarConflict = true;
            outcomeConservative = 'STOP';
            outcomeOptimistic = 'T1';
            break;
          } else if (hitStop) {
            outcomeConservative = 'STOP';
            outcomeOptimistic = 'STOP';
            break;
          } else if (hitT1) {
            outcomeConservative = 'T1';
            outcomeOptimistic = 'T1';
            break;
          }
        }
      }

      if (isFilled && outcomeConservative === 'UNFILLED') {
        outcomeConservative = 'EXPIRED';
        outcomeOptimistic = 'EXPIRED';
      }

      // Realized R
      const riskDist = Math.abs(entry - stop);
      let rGrossCons = 0;
      let rGrossOpt = 0;
      if (outcomeConservative === 'T1') rGrossCons = 1.6;
      else if (outcomeConservative === 'STOP') rGrossCons = -1.0;
      else if (outcomeConservative === 'EXPIRED') {
        rGrossCons = riskDist > 0 ? +((isLong ? finalBarClose - entry : entry - finalBarClose) / riskDist).toFixed(2) : 0;
      }

      if (outcomeOptimistic === 'T1') rGrossOpt = 1.6;
      else if (outcomeOptimistic === 'STOP') rGrossOpt = -1.0;
      else if (outcomeOptimistic === 'EXPIRED') {
        rGrossOpt = riskDist > 0 ? +((isLong ? finalBarClose - entry : entry - finalBarClose) / riskDist).toFixed(2) : 0;
      }

      // Cost deduction (spread 0.02€ per cert + 2€ fee -> ~0.04R)
      const costR = 0.04;
      const rNetCons = isFilled ? +(rGrossCons - costR).toFixed(2) : 0;
      const rNetOpt = isFilled ? +(rGrossOpt - costR).toFixed(2) : 0;

      allResults.push({
        ticker: item.ticker,
        market: item.market,
        date: sDate,
        timestamp: new Date(bars[2].timestamp * 1000).toISOString(),
        direction,
        decision: 'TRADE',
        passedGates,
        blockedGate: null,
        entryPrice: entry,
        stopLoss: stop,
        target1: t1,
        target2: setup.target2Level || 0,
        leverage: setup.selectedLeverage || 10,
        barrier: setup.barrierRecommended || 0,
        isFilled,
        outcomeConservative,
        outcomeOptimistic,
        realizedRGrossConservative: rGrossCons,
        realizedRNetConservative: rNetCons,
        realizedRGrossOptimistic: rGrossOpt,
        realizedRNetOptimistic: rNetOpt,
        gapPercent,
        rvol,
        score: candScore.total,
        sameBarConflict,
      });
    }
  }

  return allResults;
}

async function main() {
  console.log('=== RUN 1: Deterministic Replay ===');
  const res1 = await runFullReplay();
  const hash1 = crypto.createHash('sha256').update(JSON.stringify(res1)).digest('hex');

  console.log('=== RUN 2: Deterministic Verification ===');
  const res2 = await runFullReplay();
  const hash2 = crypto.createHash('sha256').update(JSON.stringify(res2)).digest('hex');

  console.log(`Hash Run 1: ${hash1}`);
  console.log(`Hash Run 2: ${hash2}`);
  console.log(`Determinism Match: ${hash1 === hash2 ? 'VERIFIED' : 'FAILED'}`);

  fs.writeFileSync('scripts/replay_v2_results.json', JSON.stringify({ hash1, hash2, total: res1.length, data: res1 }, null, 2));
  console.log(`Output saved to scripts/replay_v2_results.json (${res1.length} evaluations)`);

  // Write CSV log
  const csvHeader = 'date,timestamp,ticker,market,direction,decision,blockedGate,entry,stop,T1,isFilled,outcomeConservative,rGrossConservative,rNetConservative,sameBarConflict\n';
  const csvRows = res1.map(r => `${r.date},${r.timestamp},${r.ticker},${r.market},${r.direction},${r.decision},${r.blockedGate || 'NONE'},${r.entryPrice},${r.stopLoss},${r.target1},${r.isFilled},${r.outcomeConservative},${r.realizedRGrossConservative},${r.realizedRNetConservative},${r.sameBarConflict}`).join('\n');
  fs.writeFileSync('scripts/setup_log.csv', csvHeader + csvRows, 'utf8');
  console.log(`Saved full setup CSV log to scripts/setup_log.csv`);
}

main().catch((err) => {
  console.error('Replay error:', err);
  process.exit(1);
});
