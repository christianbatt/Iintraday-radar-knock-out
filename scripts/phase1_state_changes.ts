import fs from 'fs';
import path from 'path';
import { DEFAULT_TRADE_REPUBLIC_UNDERLYINGS } from '../src/data/defaultUnderlyings';
import { RawQuoteData } from '../src/types/radar';
import {
  calculateCandidateScore,
  filterCompletedBars,
  calculateAtr14FromBars,
  DailyBarInput,
} from '../src/utils/calculator';
import { TRADING_PARAMS } from '../src/config/tradingParams';
import { getExchangeDateStr } from '../src/utils/timezone';

interface SnapshotTickerData {
  quote: RawQuoteData;
  dailyBars: DailyBarInput[];
}

interface SnapshotFile {
  capturedAt: string;
  futuresChange: { EU: number; US: number };
  items: SnapshotTickerData[];
}

/**
 * Vecchia scala punti liquidità (max 10pt: 10 / 8 / 5 / 2 su avgVolume20d)
 */
function getOldLiquidityPoints(avgVolume20d: number | null | undefined): number {
  if (avgVolume20d == null || avgVolume20d <= 0) return 0;
  if (avgVolume20d >= 2_000_000) return 10;
  if (avgVolume20d >= 500_000) return 8;
  if (avgVolume20d >= 150_000) return 5;
  return 2;
}

async function fetchBarsForTicker(ticker: string, market: 'EU' | 'US'): Promise<DailyBarInput[]> {
  const queryTicker = ticker.toUpperCase() === 'SPACEX' ? 'DXYZ' : ticker;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(queryTicker)}?interval=1d&range=1mo&includePrePost=true`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
    });
    if (!resp.ok) return [];
    const json = await resp.json();
    const res = json?.chart?.result?.[0];
    if (!res) return [];
    const timestamps: number[] = res.timestamp || [];
    const q = res.indicators?.quote?.[0];
    const bars: DailyBarInput[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (typeof q?.close?.[i] === 'number') {
        bars.push({
          date: getExchangeDateStr(market, new Date(timestamps[i] * 1000)),
          timestamp: timestamps[i],
          close: q.close[i],
          high: q.high?.[i] ?? q.close[i],
          low: q.low?.[i] ?? q.close[i],
          volume: q.volume?.[i] ?? 0,
        });
      }
    }
    return bars;
  } catch {
    return [];
  }
}

async function loadOrCaptureSnapshot(): Promise<SnapshotFile> {
  const outDir = path.resolve(process.cwd(), 'scripts/out');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const snapshotPath = path.join(outDir, 'quotes_snapshot.json');

  if (fs.existsSync(snapshotPath)) {
    const raw = fs.readFileSync(snapshotPath, 'utf-8');
    return JSON.parse(raw) as SnapshotFile;
  }

  const res = await fetch('http://localhost:3000/api/market-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ underlyings: DEFAULT_TRADE_REPUBLIC_UNDERLYINGS }),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch market data from localhost:3000: ${res.statusText}`);
  }
  const json = await res.json();
  const quotes: RawQuoteData[] = json.data || [];

  const items: SnapshotTickerData[] = [];
  for (const quote of quotes) {
    const dailyBars = await fetchBarsForTicker(quote.ticker, quote.market);
    items.push({ quote, dailyBars });
  }

  const snapshot: SnapshotFile = {
    capturedAt: new Date().toISOString(),
    futuresChange: { EU: 0.10, US: 0.10 },
    items,
  };

  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  return snapshot;
}

async function main() {
  const snapshot = await loadOrCaptureSnapshot();
  console.log('========================================================================');
  console.log(`ANALISI CAMBI DI STATO FASE F (Snapshot: ${snapshot.capturedAt})`);
  console.log(`Totale titoli nello snapshot: ${snapshot.items.length}`);
  console.log('========================================================================\n');

  const refDate = new Date(snapshot.capturedAt);
  const changedByVariant: Record<string, string[]> = {};
  const addVariantChange = (ticker: string, variant: string) => {
    if (!changedByVariant[ticker]) changedByVariant[ticker] = [];
    changedByVariant[ticker].push(variant);
  };

  // ----------------------------------------------------------------------
  // (A) EFFETTO ATR: barra odierna inclusa vs esclusa (stessa funzione calculateAtr14FromBars)
  // ----------------------------------------------------------------------
  console.log('------------------------------------------------------------------------');
  console.log('(A) EFFETTO ATR: Con barra odierna inclusa vs Solo barre complete');
  console.log('    (Stessa funzione calculateAtr14FromBars, liquidità invariata = 0)');
  console.log('------------------------------------------------------------------------');

  let atrStateChangesCount = 0;
  for (const item of snapshot.items) {
    const q = item.quote;
    const fut = q.market === 'US' ? snapshot.futuresChange.US : snapshot.futuresChange.EU;
    const minScore = q.market === 'EU' ? TRADING_PARAMS.MIN_SCORE_EU : TRADING_PARAMS.MIN_SCORE_US;

    // Costruisce la serie con barra odierna sintetica/live se non già presente nell'array daily
    const completedBars = filterCompletedBars(item.dailyBars, q.market, refDate);
    const todayDateStr = getExchangeDateStr(q.market, refDate);
    const barsWithToday: DailyBarInput[] = [...completedBars];
    if (q.currentPrice != null && q.todayHigh != null && q.todayLow != null) {
      barsWithToday.push({
        date: todayDateStr,
        high: q.todayHigh,
        low: q.todayLow,
        close: q.currentPrice,
        volume: q.preMarketVolume ?? 0,
      });
    } else if (item.dailyBars.length > completedBars.length) {
      barsWithToday.push(item.dailyBars[item.dailyBars.length - 1]);
    }

    const atrWithToday = calculateAtr14FromBars(barsWithToday);
    const atrCompletedOnly = calculateAtr14FromBars(completedBars);

    const quoteWithTodayAtr: RawQuoteData = { ...q, atr14: atrWithToday };
    const quoteCompletedAtr: RawQuoteData = { ...q, atr14: atrCompletedOnly };

    const scoreBefore = calculateCandidateScore(quoteWithTodayAtr, fut, null);
    const scoreAfter = calculateCandidateScore(quoteCompletedAtr, fut, null);

    const prevC = q.prevClose || q.currentPrice || 1;
    const absGap = Math.abs(q.gapPercent ?? 0);
    const ratioBefore =
      atrWithToday && prevC > 0 ? +(absGap / ((atrWithToday / prevC) * 100)).toFixed(3) : null;
    const ratioAfter =
      atrCompletedOnly && prevC > 0 ? +(absGap / ((atrCompletedOnly / prevC) * 100)).toFixed(3) : null;

    const statusBefore =
      atrWithToday == null
        ? 'ESCLUSO (G2: DATI INSUFFICIENTI)'
        : scoreBefore.total >= minScore
        ? 'IDONEO'
        : 'ESCLUSO (G11: PUNTEGGIO SOTTO SOGLIA)';
    const statusAfter =
      atrCompletedOnly == null
        ? 'ESCLUSO (G2: DATI INSUFFICIENTI)'
        : scoreAfter.total >= minScore
        ? 'IDONEO'
        : 'ESCLUSO (G11: PUNTEGGIO SOTTO SOGLIA)';

    const changed = statusBefore !== statusAfter || scoreBefore.total !== scoreAfter.total;
    if (changed) {
      atrStateChangesCount++;
      addVariantChange(q.ticker, 'A_ATR');
    }

    console.log(
      `[A] ${q.ticker.padEnd(9)} (${q.market}) | Prima: ${statusBefore.padEnd(36)} | Dopo: ${statusAfter.padEnd(36)} | ATR: ${String(atrWithToday).padEnd(8)} -> ${String(atrCompletedOnly).padEnd(8)} | GapRatio: ${String(ratioBefore).padEnd(6)} -> ${String(ratioAfter).padEnd(6)} | Score: ${scoreBefore.total} -> ${scoreAfter.total}`
    );
  }
  console.log(`Totale titoli con variazione di stato/score per solo ATR (variante A): ${atrStateChangesCount}\n`);

  // ----------------------------------------------------------------------
  // (B) EFFETTO LIQUIDITÀ NELLO SCORE: vecchi punti (10/8/5/2 su avgVolume20d) vs 0
  // ----------------------------------------------------------------------
  console.log('------------------------------------------------------------------------');
  console.log('(B) EFFETTO LIQUIDITÀ NELLO SCORE: Punti vecchi (10/8/5/2) vs 0');
  console.log('    (ATR attuale su sessioni complete invariato)');
  console.log('------------------------------------------------------------------------');

  let rawAbove100Before = 0;
  let rawAbove100After = 0;
  let liqScoreStateChangesCount = 0;

  const rankedBeforeEU: { ticker: string; score: number; raw: number; rvol: number; gap: number }[] = [];
  const rankedAfterEU: { ticker: string; score: number; raw: number; rvol: number; gap: number }[] = [];
  const rankedBeforeUS: { ticker: string; score: number; raw: number; rvol: number; gap: number }[] = [];
  const rankedAfterUS: { ticker: string; score: number; raw: number; rvol: number; gap: number }[] = [];

  for (const item of snapshot.items) {
    const q = item.quote;
    const fut = q.market === 'US' ? snapshot.futuresChange.US : snapshot.futuresChange.EU;
    const minScore = q.market === 'EU' ? TRADING_PARAMS.MIN_SCORE_EU : TRADING_PARAMS.MIN_SCORE_US;

    const scoreAfterObj = calculateCandidateScore(q, fut, null);
    const oldLiqPts = getOldLiquidityPoints(q.avgVolume20d);
    const rawAfter = scoreAfterObj.rawTotal ?? scoreAfterObj.total;
    const rawBefore = +(rawAfter + oldLiqPts).toFixed(1);
    const totalAfter = scoreAfterObj.total;
    const totalBefore = Math.max(0, Math.min(100, Math.round(rawBefore)));

    if (rawBefore > 100) rawAbove100Before++;
    if (rawAfter > 100) rawAbove100After++;

    const statusBefore =
      totalBefore >= minScore ? 'IDONEO (Score >= Min)' : 'ESCLUSO (G11: PUNTEGGIO SOTTO SOGLIA)';
    const statusAfter =
      totalAfter >= minScore ? 'IDONEO (Score >= Min)' : 'ESCLUSO (G11: PUNTEGGIO SOTTO SOGLIA)';

    if (statusBefore !== statusAfter) {
      liqScoreStateChangesCount++;
      addVariantChange(q.ticker, 'B_LIQ_SCORE');
    }

    const entryBefore = {
      ticker: q.ticker,
      score: totalBefore,
      raw: rawBefore,
      rvol: q.rvol ?? 0,
      gap: Math.abs(q.gapPercent ?? 0),
    };
    const entryAfter = {
      ticker: q.ticker,
      score: totalAfter,
      raw: rawAfter,
      rvol: q.rvol ?? 0,
      gap: Math.abs(q.gapPercent ?? 0),
    };

    if (q.market === 'EU') {
      rankedBeforeEU.push(entryBefore);
      rankedAfterEU.push(entryAfter);
    } else {
      rankedBeforeUS.push(entryBefore);
      rankedAfterUS.push(entryAfter);
    }

    const marker = statusBefore !== statusAfter ? ' [CAMBIO STATO]' : '';
    console.log(
      `[B] ${q.ticker.padEnd(9)} (${q.market}) | Prima: ${statusBefore.padEnd(38)} (${String(totalBefore).padStart(2)}pt, OldLiq +${oldLiqPts}pt) | Dopo: ${statusAfter.padEnd(38)} (${String(totalAfter).padStart(2)}pt) | avgVol20d: ${String(q.avgVolume20d).padEnd(10)} | Liq€: ${q.liqEur20d != null ? (q.liqEur20d / 1e6).toFixed(2) + 'M€' : 'null'}${marker}`
    );
  }

  console.log(`\nTotale titoli il cui stato cambia per rimozione punti liquidità (variante B): ${liqScoreStateChangesCount}`);
  console.log(`Titoli con rawTotal > 100 PRIMA (con liquidità): ${rawAbove100Before}`);
  console.log(`Titoli con rawTotal > 100 DOPO (senza liquidità): ${rawAbove100After}\n`);

  // ----------------------------------------------------------------------
  // (C) EFFETTO GATE G1 (Liq€ < LIQ_MIN_EUR): elenco separato esclusi solo da G1 vs G2
  // ----------------------------------------------------------------------
  console.log('------------------------------------------------------------------------');
  console.log('(C) EFFETTO GATE G1 (Liq€ < 3,000,000 €) vs G2 (Liq€ mancante / < 20 barre)');
  console.log('------------------------------------------------------------------------');

  const excludedByG1Only: string[] = [];
  const excludedByG2MissingLiq: string[] = [];

  for (const item of snapshot.items) {
    const q = item.quote;
    const liqEur = q.liqEur20d ?? null;
    const barsCount = q.completedBarsCount ?? item.dailyBars.length;
    if (liqEur == null || barsCount < TRADING_PARAMS.LIQ_BARS_REQUIRED) {
      excludedByG2MissingLiq.push(
        `${q.ticker} (${q.market}): Liq€=${liqEur}, barreComplete=${barsCount} -> G2: DATI INSUFFICIENTI`
      );
      addVariantChange(q.ticker, 'C_G2_DATI');
    } else if (liqEur < TRADING_PARAMS.LIQ_MIN_EUR) {
      excludedByG1Only.push(
        `${q.ticker} (${q.market}): Liq€=${(liqEur / 1e6).toFixed(2)}M€ < 3.00M€ -> G1: LIQUIDITÀ INSUFFICIENTE`
      );
      addVariantChange(q.ticker, 'C_G1_LIQ');
    }
  }

  console.log(`Titoli esclusi specificamente da G1 (Liq€ calcolabile ma < 3.00 M€): ${excludedByG1Only.length}`);
  excludedByG1Only.forEach((line) => console.log(`  - ${line}`));
  console.log(`Titoli esclusi da G2 per Liq€ non calcolabile (< 20 barre o volume assente): ${excludedByG2MissingLiq.length}`);
  excludedByG2MissingLiq.forEach((line) => console.log(`  - ${line}`));

  // ----------------------------------------------------------------------
  // CONFRONTO TOP PICK EU E USA PRIMA E DOPO
  // ----------------------------------------------------------------------
  const sortRank = (a: { score: number; raw: number; rvol: number; gap: number }, b: { score: number; raw: number; rvol: number; gap: number }) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.raw !== a.raw) return b.raw - a.raw;
    if (b.rvol !== a.rvol) return b.rvol - a.rvol;
    return b.gap - a.gap;
  };

  rankedBeforeEU.sort(sortRank);
  rankedAfterEU.sort(sortRank);
  rankedBeforeUS.sort(sortRank);
  rankedAfterUS.sort(sortRank);

  console.log('\n------------------------------------------------------------------------');
  console.log('TOP PICK EUROPA E USA (PRIMA vs DOPO)');
  console.log('------------------------------------------------------------------------');
  console.log(
    `EU Top Pick PRIMA: ${rankedBeforeEU[0]?.ticker} (Score ${rankedBeforeEU[0]?.score}, Raw ${rankedBeforeEU[0]?.raw}) | DOPO: ${rankedAfterEU[0]?.ticker} (Score ${rankedAfterEU[0]?.score}, Raw ${rankedAfterEU[0]?.raw})`
  );
  console.log(
    `US Top Pick PRIMA: ${rankedBeforeUS[0]?.ticker} (Score ${rankedBeforeUS[0]?.score}, Raw ${rankedBeforeUS[0]?.raw}) | DOPO: ${rankedAfterUS[0]?.ticker} (Score ${rankedAfterUS[0]?.score}, Raw ${rankedAfterUS[0]?.raw})`
  );

  // ----------------------------------------------------------------------
  // RIEPILOGO TITOLI CHE CAMBIANO PER PIÙ VARIANTI
  // ----------------------------------------------------------------------
  console.log('\n------------------------------------------------------------------------');
  console.log('RIEPILOGO TITOLI INTERESSATI DA UNA O PIÙ VARIANTI');
  console.log('------------------------------------------------------------------------');
  for (const [ticker, variants] of Object.entries(changedByVariant)) {
    console.log(`  - ${ticker.padEnd(10)}: ${variants.join(', ')}${variants.length > 1 ? ' [MULTI-VARIANTE]' : ''}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
