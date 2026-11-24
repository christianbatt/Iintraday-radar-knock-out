/**
 * Test dello scanner server-side SHADOW V1 LIVE su tutto il paniere.
 *
 * Tutto l'I/O usa `os.tmpdir()` rimosso a fine test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RawQuoteData } from '../../types/radar';
import {
  clearShadowV1LiveBarsForTest,
  recordBarsForShadowV1Live,
  registerShadowV1LiveCollector,
} from '../../server/shadowV1LiveCollector';
import {
  observeShadowV1LiveScan,
  SHADOW_V1_LIVE_DIAGNOSTICS_PATH,
  SHADOW_V1_LIVE_SCAN_SAMPLE_SIZE,
} from '../../server/shadowV1LiveScanner';
import { loadRecords } from '../../server/shadowV1LiveStore';
import { SHADOW_V1_LIVE_MARKS_PATH } from '../../server/shadowV1LiveMarks';
import { getShadowLatest } from '../../server/shadowRoute';

// --- P11: valori dichiarati delle costanti (guardia di non regressione) -------

test('P11 costanti scanner: campione e path diagnostica invariati', () => {
  assert.equal(SHADOW_V1_LIVE_SCAN_SAMPLE_SIZE, 12);
  assert.equal(SHADOW_V1_LIVE_DIAGNOSTICS_PATH, 'artifacts/shadow_v1_live/scan_diagnostics.json');
});

const D0 = Date.UTC(2026, 2, 16, 15, 0, 0); // 10:00 ET (US attiva dopo ORB 09:45)
const BAR_MS = 5 * 60_000;

function makeQuote(over: Partial<RawQuoteData> & { ticker: string }): RawQuoteData {
  const { ticker, ...rest } = over;
  return {
    ticker,
    name: ticker,
    market: 'US',
    currency: 'USD',
    currentPrice: 100.2,
    prevClose: 99,
    preMarketPrice: 100,
    prevHigh: 99.8,
    prevLow: 98.4,
    preMarketHigh: 100.2,
    preMarketLow: 99.4,
    preMarketVolume: 250_000,
    todayOpen: 100,
    todayHigh: 100.6,
    todayLow: 99.6,
    atr14: 2.0,
    adr14: 4.0,
    avgVolume20d: 1_000_000,
    liqEur20d: 80_000_000,
    completedBarsCount: 20,
    rvol: 2.2,
    rvol20m: 2.0,
    gapPercent: 1.01,
    rsi14: 58,
    rsi5m: 58,
    orbHigh: 100.1,
    orbLow: 99.5,
    orbBreakoutTime: new Date(D0 - 15 * 60_000).toISOString(),
    orbBreakoutTimeLong: new Date(D0 - 15 * 60_000).toISOString(),
    orbBreakoutTimeShort: null,
    vwapCumulative: 99.8,
    lastBarTime: Math.floor((D0 - 2 * 60_000) / 1000),
    marketTs: Math.floor((D0 - 60_000) / 1000),
    timestamp: new Date(D0).toISOString(),
    source: 'YAHOO',
    vwapState: {
      state: 'ABOVE',
      vwapLevel: 99.8,
      distAtr: 0.4,
      slopeAtr: 0.1,
      coverage: 1,
      volumeRatio: 1.8,
      flags: [],
    },
    orderFlow: {
      buyerVolumePercent: 62,
      sellerVolumePercent: 38,
      netDeltaPercent: 24,
      cvdTrend: 'EXPANDING_UP',
      vpocPrice: 99.9,
      isPriceAboveVpoc: true,
      flowQuality: 'INSTITUTIONAL_BUYING',
      summary: 'Flusso acquirente positivo',
    },
    setupIndicators: {
      barsUsed: 60,
      priorSessionsUsed: 3,
      recentBars: [],
      atr: { value: 0.4, status: 'OK', reason: null },
      supertrend: { status: 'OK', reason: null, direction: 1, barsSinceFlip: 2, value: 99.2 },
      adx: { status: 'OK', reason: null, value: 28, plusDI: 30, minusDI: 12 },
      stochRsi: { status: 'OK', reason: null, k: 45, d: 35, lastCross: 'LONG', barsSinceCross: 1 },
      psar: { status: 'OK', reason: null, direction: 1, barsSinceFlip: 2, value: 99.3 },
    },
    ...rest,
  };
}

function makeBars(nowMs: number) {
  return [
    { t: nowMs - 3 * BAR_MS, o: 99.8, h: 100.2, l: 99.6, c: 100.1 },
    { t: nowMs - 2 * BAR_MS, o: 100.1, h: 100.4, l: 99.9, c: 100.2 },
    { t: nowMs - BAR_MS, o: 100.2, h: 100.3, l: 100.0, c: 100.2 },
  ];
}

function fakeTimers() {
  return {
    setInterval: () => ({ unref: () => undefined }),
    clearInterval: () => undefined,
  };
}

test('scanner server V1-live: flag OFF ritorna null e non scrive nulla', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1scan-off-'));
  try {
    const out = await observeShadowV1LiveScan([makeQuote({ ticker: 'NVDA' })], null, {
      rootDir: dir,
      nowMs: D0,
      env: { SHADOW_V1_LIVE_COLLECT: '0' },
    });
    assert.equal(out, null);
    assert.equal(fs.existsSync(path.join(dir, SHADOW_V1_LIVE_DIAGNOSTICS_PATH)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanner server V1-live: valuta tutto il paniere (anche non Top-1), persiste TRADE e salva diagnostica blocchi', async () => {
  clearShadowV1LiveBarsForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1scan-on-'));
  const app = { post: () => undefined };
  const reg = registerShadowV1LiveCollector(app, {
    root: dir,
    env: { SHADOW_V1_LIVE_COLLECT: '1' },
    timers: fakeTimers(),
    now: () => D0,
    fetchMissingBars: null,
  });

  try {
    // 1. NVDA: Top-1 US ma esteso oltre EST_MAX -> bloccato su G4 (simulando un Top-1 bloccato)
    const nvdaBlocked = makeQuote({
      ticker: 'NVDA',
      gapPercent: 3.2,
      currentPrice: 104.5, // esteso +4.4% rispetto a orbHigh 100.1
      todayHigh: 104.6,
    });
    // 2. AAPL: non Top-1 (score piu' basso), ma setup valido dentro tutti i gate -> TRADE
    const aaplValid = makeQuote({
      ticker: 'AAPL',
      gapPercent: 1.1,
      currentPrice: 100.2,
    });
    // 3. MSFT: in warmup incompleto -> bloccato su WARMUP_INCOMPLETE
    const msftWarmup = makeQuote({
      ticker: 'MSFT',
      setupIndicators: {
        barsUsed: 0,
        priorSessionsUsed: 0,
        recentBars: [],
        atr: { value: null, status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS' },
        supertrend: { status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS', direction: 0, barsSinceFlip: null, value: null },
        adx: { status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS', value: null, plusDI: null, minusDI: null },
        stochRsi: { status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS', k: null, d: null, lastCross: 'NONE', barsSinceCross: null },
        psar: { status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS', value: null, direction: 0, barsSinceFlip: null },
      },
    });

    recordBarsForShadowV1Live('AAPL', 'US', makeBars(D0), D0, { SHADOW_V1_LIVE_COLLECT: '1' });

    const diag = await observeShadowV1LiveScan(
      [nvdaBlocked, aaplValid, msftWarmup],
      { usa: { sp500: { changePercent: 0.4 } } },
      { rootDir: dir, nowMs: D0, env: { SHADOW_V1_LIVE_COLLECT: '1' } }
    );

    assert.ok(diag);
    assert.equal(diag.scannedTickers, 3);
    assert.equal(diag.emittedThisScan, 1);
    assert.equal(diag.persistedThisScan, 1);
    assert.equal(diag.blockedThisScan, 2);
    assert.equal(diag.topUS, 'NVDA');

    // AAPL deve essere stato persistito anche se NVDA era Top-1!
    const loaded = loadRecords(path.join(dir, 'artifacts/shadow_v1_live/signals.jsonl'));
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0].ticker, 'AAPL');

    // Diagnostica su disco leggibile da shadowRoute
    const diagFile = path.join(dir, SHADOW_V1_LIVE_DIAGNOSTICS_PATH);
    assert.equal(fs.existsSync(diagFile), true);
    const parsedDiag = JSON.parse(fs.readFileSync(diagFile, 'utf8'));
    assert.ok(parsedDiag.gateCounts.some((g: { gate: string }) => g.gate === 'G4'));
    assert.ok(parsedDiag.gateCounts.some((g: { gate: string }) => g.gate === 'WARMUP_INCOMPLETE'));

    const latest = getShadowLatest({
      fs: {
        existsSync: (p) => fs.existsSync(path.join(dir, p)),
        readFileSync: (p, enc) => fs.readFileSync(path.join(dir, p), enc),
        readdirSync: (p) => fs.readdirSync(path.join(dir, p)),
      },
      artifactDir: 'artifacts',
      registryPath: 'registry/ai_registry.jsonl',
      deathcheckPath: 'artifacts/ai_deathcheck.json',
      flags: { SETUP_SELECTOR_LIVE: 'off', STALENESS_USE_MARKET_TS: 'off' },
    });
    assert.equal((latest.body.v1LiveDiagnostics as { emittedThisScan: number }).emittedThisScan, 1);
  } finally {
    reg.stop?.();
    clearShadowV1LiveBarsForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanner server V1-live: invia oltre 10 TRADE nella stessa scansione senza 429', async () => {
  clearShadowV1LiveBarsForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1scan-bulk-'));
  const app = { post: () => undefined };
  const reg = registerShadowV1LiveCollector(app, {
    root: dir,
    env: { SHADOW_V1_LIVE_COLLECT: '1' },
    timers: fakeTimers(),
    now: () => D0,
    fetchMissingBars: null,
  });

  try {
    const quotes: RawQuoteData[] = [];
    for (let i = 1; i <= 14; i += 1) {
      const ticker = `T${i}`;
      recordBarsForShadowV1Live(ticker, 'US', makeBars(D0), D0, { SHADOW_V1_LIVE_COLLECT: '1' });
      quotes.push(makeQuote({ ticker, gapPercent: 1.0 + i * 0.01 }));
    }

    const diag = await observeShadowV1LiveScan(
      quotes,
      { usa: { sp500: { changePercent: 0.5 } } },
      { rootDir: dir, nowMs: D0, env: { SHADOW_V1_LIVE_COLLECT: '1' } }
    );

    assert.ok(diag);
    assert.equal(diag.emittedThisScan, 14);
    assert.equal(diag.persistedThisScan, 14);
    const loaded = loadRecords(path.join(dir, 'artifacts/shadow_v1_live/signals.jsonl'));
    assert.equal(loaded.records.length, 14);
  } finally {
    reg.stop?.();
    clearShadowV1LiveBarsForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanner server V1-live: scansioni concorrenti serializzano segnali e marks senza collisioni sui temporanei', async () => {
  clearShadowV1LiveBarsForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1scan-race-'));
  const env = { SHADOW_V1_LIVE_COLLECT: '1' };
  const reg = registerShadowV1LiveCollector({ post: () => undefined }, {
    root: dir,
    env,
    timers: fakeTimers(),
    now: () => D0,
    fetchMissingBars: null,
  });

  try {
    const quotes = ['RACE1', 'RACE2'].map((ticker, i) => {
      recordBarsForShadowV1Live(ticker, 'US', makeBars(D0), D0, env);
      return makeQuote({ ticker, gapPercent: 1.02 + i * 0.01 });
    });

    // File estraneo con lo stesso nome del vecchio tmp (`pid`): non va toccato.
    const diagPath = path.join(dir, SHADOW_V1_LIVE_DIAGNOSTICS_PATH);
    fs.mkdirSync(path.dirname(diagPath), { recursive: true });
    const decoy = `${diagPath}.tmp-${process.pid}`;
    fs.writeFileSync(decoy, 'DECOY', 'utf8');

    const runs = await Promise.all(
      [0, 1, 2].map(() =>
        observeShadowV1LiveScan(quotes, null, { rootDir: dir, nowMs: D0, env })
      )
    );
    assert.equal(runs.filter((r) => r !== null).length, 3);

    const loaded = loadRecords(path.join(dir, 'artifacts/shadow_v1_live/signals.jsonl'));
    assert.equal(loaded.records.length, quotes.length, 'chiavi idempotenti: nessun doppione concorrente');

    const marks = JSON.parse(fs.readFileSync(path.join(dir, SHADOW_V1_LIVE_MARKS_PATH), 'utf8'));
    assert.deepEqual(
      marks.marks.map((m: { ticker: string }) => m.ticker).sort(),
      quotes.map((q) => q.ticker).sort(),
      'l ultima scrittura accodata vede tutti i segnali gia persistiti'
    );

    assert.equal(fs.readFileSync(decoy, 'utf8'), 'DECOY', 'il file estraneo non viene ne sovrascritto ne consumato');
    const leftovers = fs
      .readdirSync(path.dirname(diagPath))
      .filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [path.basename(decoy)], 'nessun temporaneo residuo dopo scansioni concorrenti');
  } finally {
    reg.stop?.();
    clearShadowV1LiveBarsForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanner server V1-live: distingue MARKET_CLOSED_OR_STALE, rispetta veto ADX, preserva diagnostica off-hours e registra Near-Miss', async () => {
  clearShadowV1LiveBarsForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1scan-upgrades-'));
  const env = { SHADOW_V1_LIVE_COLLECT: '1' };
  const reg = registerShadowV1LiveCollector({ post: () => undefined }, {
    root: dir,
    env,
    timers: fakeTimers(),
    now: () => D0,
    fetchMissingBars: null,
  });

  try {
    // 1. Titolo con reason STALE -> deve essere classificato MARKET_CLOSED_OR_STALE, non WARMUP_INCOMPLETE
    const staleQuote = makeQuote({
      ticker: 'ENI.MI',
      market: 'EU',
      currency: 'EUR',
      setupIndicators: {
        barsUsed: 0,
        priorSessionsUsed: 0,
        recentBars: [],
        atr: { value: null, status: 'UNKNOWN', reason: 'STALE' },
        supertrend: { status: 'UNKNOWN', reason: 'STALE', direction: 0, barsSinceFlip: null, value: null },
        adx: { status: 'UNKNOWN', reason: 'STALE', value: null, plusDI: null, minusDI: null },
        stochRsi: { status: 'UNKNOWN', reason: 'STALE', k: null, d: null, lastCross: 'NONE', barsSinceCross: null },
        psar: { status: 'UNKNOWN', reason: 'STALE', value: null, direction: 0, barsSinceFlip: null },
      },
    });

    // 2. Titolo con ADX borderline (16 < soglia US 20): veto score attivo -> bloccato e catturato in Near-Miss!
    const borderlineAdxQuote = makeQuote({
      ticker: 'MSFT',
      gapPercent: 1.05,
      currentPrice: 100.2,
      setupIndicators: {
        barsUsed: 60,
        priorSessionsUsed: 3,
        recentBars: [],
        atr: { value: 0.4, status: 'OK', reason: null },
        supertrend: { status: 'OK', reason: null, direction: 1, barsSinceFlip: 2, value: 99.2 },
        adx: { status: 'OK', reason: null, value: 16.5, plusDI: 24, minusDI: 18 },
        stochRsi: { status: 'OK', reason: null, k: 45, d: 35, lastCross: 'LONG', barsSinceCross: 1 },
        psar: { status: 'OK', reason: null, direction: 1, barsSinceFlip: 2, value: 99.3 },
      },
    });

    recordBarsForShadowV1Live('MSFT', 'US', makeBars(D0), D0, env);

    const diag = await observeShadowV1LiveScan(
      [staleQuote, borderlineAdxQuote],
      { usa: { sp500: { changePercent: 0.5 } } },
      { rootDir: dir, nowMs: D0, env }
    );
    assert.ok(diag);
    assert.equal(diag.emittedThisScan, 0, 'veto ADX e dati stale non devono emettere TRADE');
    assert.ok(
      diag.gateCounts.some((g) => g.gate === 'MARKET_CLOSED_OR_STALE'),
      'STALE deve essere classificato MARKET_CLOSED_OR_STALE'
    );
    assert.equal(
      diag.gateCounts.some((g) => g.gate === 'WARMUP_INCOMPLETE'),
      false,
      'STALE non deve falsare WARMUP_INCOMPLETE'
    );
    assert.ok(
      diag.gateCounts.some((g) => g.gate === 'ADX_BELOW_MARKET_THRESHOLD'),
      'veto ADX deve comparire esplicitamente in gateCounts'
    );

    const latestAfterOpen = getShadowLatest({
      fs: {
        existsSync: (p) => fs.existsSync(path.join(dir, p)),
        readFileSync: (p, enc) => fs.readFileSync(path.join(dir, p), enc),
        readdirSync: (p) => fs.readdirSync(path.join(dir, p)),
      },
      artifactDir: 'artifacts',
      registryPath: 'registry/ai_registry.jsonl',
      deathcheckPath: 'artifacts/ai_deathcheck.json',
      flags: { SETUP_SELECTOR_LIVE: 'off', STALENESS_USE_MARKET_TS: 'off' },
    });
    const nm = latestAfterOpen.body.v1NearMiss as { totalRecords: number; recent: Array<{ ticker: string; nearMissGate: string }> };
    assert.ok(nm && nm.totalRecords >= 1, 'MSFT ADX 16.5 deve essere registrato in v1NearMiss');
    assert.equal(nm.recent[0].ticker, 'MSFT');
    assert.equal(nm.recent[0].nearMissGate, 'ADX_BORDERLINE');

    // 3. Scansione notturna off-hours (03:00 UTC di lunedi'): non deve sovrascrivere scan_diagnostics.json dell ultima sessione aperta!
    const offHoursMs = Date.UTC(2026, 2, 16, 3, 0, 0);
    await observeShadowV1LiveScan([staleQuote], null, { rootDir: dir, nowMs: offHoursMs, env });
    const persistedDiag = JSON.parse(fs.readFileSync(path.join(dir, SHADOW_V1_LIVE_DIAGNOSTICS_PATH), 'utf8'));
    assert.equal(persistedDiag.lastScanAt, new Date(D0).toISOString(), 'off-hours non deve sovrascrivere la diagnostica della sessione aperta');
  } finally {
    reg.stop?.();
    clearShadowV1LiveBarsForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanner server V1-live: sblocca titoli US con leva KO 5x e ADR_MAX_US, cattura G8_STOP_WIDE e bilancia sampleCandidates', async () => {
  clearShadowV1LiveBarsForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1scan-us-'));
  const env = { SHADOW_V1_LIVE_COLLECT: '1' };
  const reg = registerShadowV1LiveCollector({ post: () => undefined }, {
    root: dir,
    env,
    timers: fakeTimers(),
    now: () => D0,
    fetchMissingBars: null,
  });

  try {
    // 1. NVDA: dS = ~1.50% (bloccato su 10x EU, valido su 5x LEVE_US) e ADR consumato 67.5% (< 78% ADR_MAX_US, > 60% EU) con spazio residuo per T1 -> TRADE!
    const nvdaValid5x = makeQuote({
      ticker: 'NVDA',
      market: 'US',
      currentPrice: 100.2,
      orbHigh: 100.1,
      orbLow: 98.8, // stop ~= 98.60 -> dS ~= 1.50% (passa con LEVE_US min 5x => max 2.00%)
      adr14: 8.0,
      todayHigh: 100.3,
      todayLow: 94.9, // (100.3 - 94.9)/8.0 = 67.5% ADR consumato (residuo 2.60 > T1, sotto T1 per G6)
      atr14: 1.5,
      gapPercent: 1.8,
    });

    // 2. TSLA: dS = ~2.25% (oltre 2.00% della 5x, entro 2.50%) -> catturato come near-miss G8_STOP_WIDE!
    const tslaWideStop = makeQuote({
      ticker: 'TSLA',
      market: 'US',
      currentPrice: 100.2,
      orbHigh: 100.1,
      orbLow: 98.05, // stop ~= 97.85 -> dS ~= 2.25% (blocca G8+G9, entro NEAR_MISS_G8_STOP_MAX_PCT=2.5%)
      adr14: 8.0,
      todayHigh: 101.0,
      todayLow: 98.05,
      gapPercent: 1.6,
    });

    // 3. 8 titoli EU per verificare il bilanciamento EU/US in sampleCandidates (max 12)
    const euQuotes = Array.from({ length: 8 }, (_, idx) =>
      makeQuote({
        ticker: `EU${idx}.MI`,
        market: 'EU',
        currency: 'EUR',
        gapPercent: 1.1 + idx * 0.02,
      })
    );

    recordBarsForShadowV1Live('NVDA', 'US', makeBars(D0), D0, env);
    recordBarsForShadowV1Live('TSLA', 'US', makeBars(D0), D0, env);

    const diag = await observeShadowV1LiveScan(
      [nvdaValid5x, tslaWideStop, ...euQuotes],
      { usa: { sp500: { changePercent: 0.6 } }, europe: { dax: { changePercent: 0.2 } } },
      { rootDir: dir, nowMs: D0, env }
    );

    assert.ok(diag);
    assert.ok(
      diag.sampleCandidates.some((c) => c.ticker === 'NVDA' && c.decision === 'TRADE'),
      'NVDA con dS 1.50% e ADR 68% deve produrre TRADE US con leva KO 5x'
    );
    assert.ok(
      diag.sampleCandidates.some((c) => c.market === 'US') &&
        diag.sampleCandidates.some((c) => c.market === 'EU'),
      'sampleCandidates deve bilanciare EU e US'
    );

    const loaded = loadRecords(path.join(dir, 'artifacts/shadow_v1_live/signals.jsonl')).records;
    assert.ok(loaded.some((r) => r.ticker === 'NVDA' && r.market === 'US'), 'NVDA US persistito in signals.jsonl');

    const latest = getShadowLatest({
      fs: {
        existsSync: (p) => fs.existsSync(path.join(dir, p)),
        readFileSync: (p, enc) => fs.readFileSync(path.join(dir, p), enc),
        readdirSync: (p) => fs.readdirSync(path.join(dir, p)),
      },
      artifactDir: 'artifacts',
      registryPath: 'registry/ai_registry.jsonl',
      deathcheckPath: 'artifacts/ai_deathcheck.json',
      flags: { SETUP_SELECTOR_LIVE: 'off', STALENESS_USE_MARKET_TS: 'off' },
    });
    const nm = latest.body.v1NearMiss as { recent: Array<{ ticker: string; nearMissGate: string }> };
    assert.ok(
      nm.recent.some((r) => r.ticker === 'TSLA' && r.nearMissGate === 'G8_STOP_WIDE'),
      'TSLA bloccato su coppia G8+G9 entro 2.5% deve comparire in near_miss come G8_STOP_WIDE'
    );
  } finally {
    reg.stop?.();
    clearShadowV1LiveBarsForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
