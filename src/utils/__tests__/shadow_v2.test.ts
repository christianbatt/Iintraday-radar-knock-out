import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  clusterBootstrapSignFlipPValue,
  evaluateShadowV2OnBars,
  filterClosedBarsV2,
  mulberry32,
  selectShadowV2KoLeverage,
  SHADOW_V2_BAR_MS,
  SHADOW_V2_HYPOTHESES,
  summarizeShadowV2,
  type ShadowV2Record,
} from '../../knowledge/shadowV2';
import {
  calculateImpliedVolatilityMetrics,
  calculateIntradaySeasonality,
  calculateOrbFromIntradayBars,
  DEFAULT_SYSTEM_PARAMETERS,
  generateFilteringAuditReport,
} from '../calculator';
import type { IndicatorBarInput, RawQuoteData, ScoredCandidate } from '../../types/radar';

// ---------------------------------------------------------------------------
// Helper per costruire serie sintetiche realistiche su barre 5m chiuse (US ET)
// 2026-11-05 e 2026-11-06 sono in EST (UTC-5): 09:30 NY = 14:30 UTC.
// ---------------------------------------------------------------------------

function makeBar(ts: number, o: number, h: number, l: number, c: number, v: number): IndicatorBarInput {
  return { t: ts, o, h, l, c, v };
}

/** Record sintetico per il bootstrap: contano solo sessionDate (cluster) e rNet (effetto). */
function mkRecord(id: string, sessionDate: string, rNet: number): ShadowV2Record {
  return {
    id,
    ticker: 'SYNTH',
    market: 'US',
    sessionDate,
    direction: 'LONG',
    triggerType: 'CUSUM_DISPLACEMENT',
    signalBarTs: Date.UTC(2026, 10, 5, 14, 30),
    signalTimeIso: '2026-11-05T14:30:00.000Z',
    entryBarTs: Date.UTC(2026, 10, 5, 14, 35),
    refSignalClose: 100,
    entryPrice: 100,
    structuralStop: 99,
    target1: 102,
    riskDist: 1,
    leverage: 1,
    koBarrier: 98,
    status: 'RESOLVED',
    outcome: 'TARGET_1',
    blockedReason: null,
    exitBarTs: Date.UTC(2026, 10, 5, 14, 40),
    exitPrice: 102,
    barsHeld: 1,
    rGross: rNet,
    rNet,
    csSpreadPct: 0,
    amihud: 0,
    varSpreadR: 0,
    totalFrictionR: 0,
    totalFrictionR2500: 0,
    diagnostics: {
      vwapAtSignal: 100,
      atr5mAtSignal: 1,
      adxAtSignal: 20,
      pullbackDistAtr: 0,
      pullbackVolRatio: 1,
      reclaimVolRatio: 1,
      cusumZ: 2,
      gapPct: 0,
    },
  };
}

/**
 * Costruisce:
 * - Giorno 1 (2026-11-05): 30 barre di trend morbido per warm-up ATR/ADX/Supertrend/VolSMA20.
 * - Giorno 2 (2026-11-06): impulso direzionale CUSUM (+ oppure -), poi pullback a basso volume vicino VWAP,
 *   poi reclaim ad alto volume con CLV favorevole, seguito da ingresso all'apertura successiva e hit su TARGET_1.
 */
function buildDirectionalSeries(direction: 'LONG' | 'SHORT'): {
  bars: IndicatorBarInput[];
  lastClosedBarEndMs: number;
} {
  const dir = direction === 'LONG' ? 1 : -1;
  const bars: IndicatorBarInput[] = [];

  // Giorno 1: warm-up (30 barre a partire dalle 09:30 NY = 14:30 UTC)
  const day1Open = Date.UTC(2026, 10, 5, 14, 30);
  let price = 100;
  for (let i = 0; i < 30; i++) {
    const t = day1Open + i * SHADOW_V2_BAR_MS;
    const step = dir * 0.12;
    const o = price;
    const c = +(price + step).toFixed(4);
    const h = +(Math.max(o, c) + 0.15).toFixed(4);
    const l = +(Math.min(o, c) - 0.12).toFixed(4);
    bars.push(makeBar(t, o, h, l, c, 10_000));
    price = c;
  }

  // Giorno 2: 2026-11-06 09:30 NY = 14:30 UTC
  const day2Open = Date.UTC(2026, 10, 6, 14, 30);

  // Barre 0..3 (09:30..09:45): impulso iniziale direzionale con espansione volume -> CUSUM >= 1.5 e Supertrend allineato
  for (let i = 0; i < 4; i++) {
    const t = day2Open + i * SHADOW_V2_BAR_MS;
    const o = price;
    const c = +(price + dir * 0.65).toFixed(4);
    const h = +(Math.max(o, c) + 0.1).toFixed(4);
    const l = +(Math.min(o, c) - 0.1).toFixed(4);
    bars.push(makeBar(t, o, h, l, c, 16_000));
    price = c;
  }

  // Barre 4..5 (09:50..09:55): pullback verso VWAP a BASSO volume (<= 0.95 * VolSMA20)
  // Scende fino a ~105.05 (entro [-0.35, +0.40] ATR dalla VWAP ~104.95) senza invertire Supertrend
  const pbBase = price;
  const pullTargets = [pbBase - dir * 0.65, pbBase - dir * 1.15];
  for (let j = 0; j < pullTargets.length; j++) {
    const t = day2Open + (4 + j) * SHADOW_V2_BAR_MS;
    const o = price;
    const c = +pullTargets[j].toFixed(4);
    const h = +(Math.max(o, c) + 0.08).toFixed(4);
    const l = +(Math.min(o, c) - 0.08).toFixed(4);
    bars.push(makeBar(t, o, h, l, c, 6_000)); // 60% del volume medio -> pullback quieto
    price = c;
  }

  // Barra 6 (10:00 NY = 15:00 UTC, dentro finestra US 09:45-15:30): Reclaim sopra/sotto VWAP ad ALTO volume (>= 1.35x)
  const tSignal = day2Open + 6 * SHADOW_V2_BAR_MS;
  const sigOpen = price;
  const sigClose = +(pbBase + dir * 0.55).toFixed(4);
  const sigHigh = dir === 1 ? sigClose : +(sigOpen + 0.05).toFixed(4);
  const sigLow = dir === 1 ? +(sigOpen - 0.05).toFixed(4) : sigClose;
  bars.push(makeBar(tSignal, sigOpen, sigHigh, sigLow, sigClose, 25_000));
  price = sigClose;

  // Barra 7 (10:05 NY): Fill su O_{t*+1} e proseguimento fino a TARGET_1
  const tEntry = day2Open + 7 * SHADOW_V2_BAR_MS;
  const entryOpen = +(price + dir * 0.02).toFixed(4);
  bars.push(
    makeBar(
      tEntry,
      entryOpen,
      dir === 1 ? +(entryOpen + 0.6).toFixed(4) : +(entryOpen + 0.1).toFixed(4),
      dir === 1 ? +(entryOpen - 0.1).toFixed(4) : +(entryOpen - 0.6).toFixed(4),
      +(entryOpen + dir * 0.4).toFixed(4),
      18_000
    )
  );

  // Barra 8 (10:10 NY): ampia estensione a Target
  const tFollow = day2Open + 8 * SHADOW_V2_BAR_MS;
  bars.push(
    makeBar(
      tFollow,
      +(entryOpen + dir * 0.4).toFixed(4),
      dir === 1 ? +(entryOpen + 6.0).toFixed(4) : +(entryOpen + 0.2).toFixed(4),
      dir === 1 ? +(entryOpen - 0.1).toFixed(4) : +(entryOpen - 6.0).toFixed(4),
      +(entryOpen + dir * 4.0).toFixed(4),
      20_000
    )
  );

  return { bars, lastClosedBarEndMs: tFollow + SHADOW_V2_BAR_MS };
}

describe('Shadow V2 — Strategia Parallela & Regressioni Critiche', () => {
  it('T1: guardia anti look-ahead e fill onesto solo all’apertura della barra successiva chiusa', () => {
    const { bars } = buildDirectionalSeries('LONG');
    const signalBar = bars[bars.length - 3]; // barra 6 giorno 2

    // Se nowMs coincide con chiusura barra segnale (entryBar non ancora chiusa): record resta PENDING_OPEN
    const atSignalClose = signalBar.t + SHADOW_V2_BAR_MS;
    assert.equal(filterClosedBarsV2(bars, atSignalClose).length, bars.length - 2);

    const pending = evaluateShadowV2OnBars('NVDA', 'US', bars, { nowMs: atSignalClose });
    assert.ok(pending.length >= 1, 'Deve rilevare almeno un segnale alla chiusura della barra signal');
    const lastPending = pending[pending.length - 1];
    assert.equal(lastPending.status, 'PENDING_OPEN');
    assert.equal(lastPending.entryPrice, null);

    // Se barra segnale non è ancora chiusa (nowMs = signalBar.t + 60_000): NON deve apparire affatto
    const midSignalBar = evaluateShadowV2OnBars('NVDA', 'US', bars, { nowMs: signalBar.t + 60_000 });
    assert.equal(
      midSignalBar.some((r) => r.signalBarTs === signalBar.t),
      false,
      'Nessun segnale prima che la barra t* sia effettivamente chiusa'
    );
  });

  it('T2: rilevazione simmetrica LONG e SHORT con CUSUM + Pullback-Reclaim + Triple Barrier + Costi Reali', () => {
    for (const dir of ['LONG', 'SHORT'] as const) {
      const { bars, lastClosedBarEndMs } = buildDirectionalSeries(dir);
      const recs = evaluateShadowV2OnBars(dir === 'LONG' ? 'NVDA' : 'AMD', 'US', bars, {
        nowMs: lastClosedBarEndMs,
      });
      const hit = recs.find((r) => r.direction === dir && r.status === 'RESOLVED');
      assert.ok(hit, `Deve produrre un trade ${dir} risolto su barre sintetiche controllate`);
      assert.equal(hit.outcome, 'TARGET_1');
      assert.ok(hit.entryPrice != null && hit.structuralStop > 0 && hit.target1 != null);
      assert.ok(hit.leverage != null && hit.koBarrier != null);
      assert.ok((hit.rGross ?? 0) > 1.3, `rGross atteso > 1.3R, ottenuto ${hit.rGross}`);
      assert.ok(hit.totalFrictionR != null && hit.totalFrictionR > 0.15 && hit.totalFrictionR <= 0.35);
      assert.ok((hit.rNet ?? 0) < (hit.rGross ?? 0), 'rNet deve scontare commissioni e spread');
      assert.ok((hit.rNet ?? 0) > 0.9, `rNet atteso positivo dopo costi, ottenuto ${hit.rNet}`);
    }
  });

  it('T3: barriera tripla pessimistica — Stop vince su Target nella stessa barra, gap su apertura blocca o fa KO_HIT', () => {
    const { bars } = buildDirectionalSeries('LONG');
    const entryBarIdx = bars.length - 2;

    // Modifica barra di ingresso per toccare sia high molto alto (sopra T1) sia low molto basso (sotto structuralStop)
    const poisoned = bars.map((b, idx) =>
      idx === entryBarIdx
        ? { ...b, h: b.o + 15.0, l: b.o - 15.0, c: b.o + 5.0 } // tocca BOTH stop/KO e Target nella stessa barra!
        : b
    );

    const recs = evaluateShadowV2OnBars('NVDA', 'US', poisoned, {
      nowMs: poisoned[poisoned.length - 1].t + SHADOW_V2_BAR_MS,
    });
    const last = recs[recs.length - 1];
    assert.ok(last, 'Record deve esistere');
    assert.notEqual(last.outcome, 'TARGET_1', 'Con violazione Stop e Target sulla stessa barra non puo vincere TARGET_1');
    assert.ok(last.outcome === 'KO_HIT' || last.outcome === 'STOP', `Esito pessimistico atteso KO_HIT/STOP, ricevuto ${last.outcome}`);
    assert.ok((last.rGross ?? 0) < 0);

    // Verifica selectShadowV2KoLeverage: rispetta distanza sicurezza dKO >= 1.25 * dS
    const ko = selectShadowV2KoLeverage(100, 98.5, 0.4, 'LONG'); // dS = 1.5 (1.5%), minDist = 1.875% -> 1/25 = 4% -> leva 25 ok
    assert.equal(ko.leverage, 25);
    assert.equal(ko.barrier, 96);
    const tooTight = selectShadowV2KoLeverage(100, 80, 1.0, 'LONG'); // dS = 20% -> nemmeno leva 5 (20%) copre 1.25*20% = 25%
    assert.equal(tooTight.leverage, null);
    assert.equal(tooTight.reason, 'KO_BARRIER_TOO_CLOSE');
  });

  it('T4: summarizeShadowV2 onesto su DSR e Cluster Bootstrap (null quando cluster < 2 o n < 5)', () => {
    const { bars, lastClosedBarEndMs } = buildDirectionalSeries('LONG');
    const oneTrade = evaluateShadowV2OnBars('NVDA', 'US', bars, { nowMs: lastClosedBarEndMs });
    const summaryOne = summarizeShadowV2(oneTrade);
    assert.equal(summaryOne.dsr, null, 'Con n < 5 il DSR non va inventato');
    assert.equal(summaryOne.clusterBootstrapPValue, null, 'Con < 2 cluster giornalieri il bootstrap non va calcolato');
    assert.ok(summaryOne.limitations.length >= 3);
  });

  it('T5: fix calculateOrbFromIntradayBars su serie 60d — barre storiche rotte e pre-market null non corrompono ORB di oggi', () => {
    // Simuliamo giorno 2026-11-06 US: apertura 14:30 UTC (09:30 NY)
    const todayOpen = Date.UTC(2026, 10, 6, 14, 30);
    const yesterdayOpen = Date.UTC(2026, 10, 5, 14, 30);

    const bars = [
      // Barra corrotta di IERI (high < low) che prima del fix avvelenava tutto lo storico ORB!
      { timestamp: Math.floor(yesterdayOpen / 1000), open: 90, high: 88, low: 92, close: 89, volume: 1000 },
      // Placeholder null pre-market di oggi alle 08:00 NY (13:00 UTC)
      { timestamp: Math.floor((todayOpen - 90 * 60_000) / 1000), open: null as unknown as number, high: null as unknown as number, low: null as unknown as number, close: null as unknown as number, volume: 0 },
      // 3 barre ORB regolari valide di OGGI (09:30, 09:35, 09:40 NY)
      { timestamp: Math.floor(todayOpen / 1000), open: 100, high: 102, low: 99.5, close: 101, volume: 50_000 },
      { timestamp: Math.floor((todayOpen + 5 * 60_000) / 1000), open: 101, high: 103, low: 100.5, close: 102.5, volume: 45_000 },
      { timestamp: Math.floor((todayOpen + 10 * 60_000) / 1000), open: 102.5, high: 103.5, low: 101.8, close: 103.0, volume: 40_000 },
    ];

    const orb = calculateOrbFromIntradayBars(bars, 'US', new Date(todayOpen + 20 * 60_000), 'LONG');
    assert.equal(orb.orbHigh, 103.5);
    assert.equal(orb.orbLow, 99.5);
  });

  it('T6: zero benchmark inventati in Audit Report, Seasonality e IV Gauge', () => {
    // 6a. generateFilteringAuditReport: rvol null -> RVOL_INSUFFICIENT (nessun 1.0x inventato) + secondo qualificato non etichettato CUTOFF_PASSED
    const makeQuote = (ticker: string, price: number, rvol: number | null, gapPercent: number): RawQuoteData => ({
      ticker,
      name: ticker,
      market: 'US',
      currency: 'USD',
      prevClose: price / (1 + gapPercent / 100),
      currentPrice: price,
      preMarketPrice: price,
      prevHigh: price + 1,
      prevLow: price - 1,
      preMarketHigh: null,
      preMarketLow: null,
      avgVolume20d: 1_000_000,
      preMarketVolume: null,
      atr14: 2.0,
      gapPercent,
      rvol,
      rsi5m: 58,
      setupIndicators: {
        barsUsed: 40,
        priorSessionsUsed: 2,
        rangeUsed: '5d',
        atr: { status: 'OK', reason: null, value: 0.45 },
        supertrend: { status: 'OK', reason: null, direction: 1, barsSinceFlip: 4, value: price - 1.5 },
        adx: { status: 'OK', reason: null, value: 28, plusDI: 30, minusDI: 12 },
        stochRsi: { status: 'OK', reason: null, k: 65, d: 55, lastCross: 'LONG', barsSinceCross: 2 },
        psar: { status: 'OK', reason: null, direction: 1, value: price - 1.2, barsSinceFlip: 4 },
      },
      timestamp: new Date().toISOString(),
      source: 'test',
    });

    const qNoRvol = makeQuote('NORVOL', 100, null, 3.0);
    const qTop1 = makeQuote('TOP1', 100, 2.5, 4.0);
    const qTop2 = makeQuote('TOP2', 100, 2.4, 3.8);

    const fakeScore = {
      gapScore: 20,
      rvolScore: 20,
      liquidityScore: 15,
      futuresScore: 10,
      levelScore: 10,
      total: 80,
      details: [],
      veto: null,
      warmupIncomplete: false,
    };
    const top1Scored: ScoredCandidate = {
      quote: qTop1,
      score: fakeScore,
      rank: 1,
    };

    const audit = generateFilteringAuditReport(
      [qNoRvol, qTop1, qTop2],
      { topEU: null, topUS: top1Scored },
      { EU: 0.2, US: 0.3 },
      DEFAULT_SYSTEM_PARAMETERS,
      {},
      true,
      new Date(Date.UTC(2026, 10, 6, 15, 0)) // 10:00 NY (finestra US attiva)
    );

    const noRvolEntry = audit.excludedList.find((e) => e.ticker === 'NORVOL');
    assert.ok(noRvolEntry, 'Ticker con rvol null deve comparire negli esclusi');
    assert.equal(noRvolEntry.primaryReasonCategory, 'RVOL_INSUFFICIENT');

    // TOP2 con score 80, RVOL 2.4, gap 3.8 è qualificato anche se secondo: non deve finire in CUTOFF_PASSED!
    const top2Excluded = audit.excludedList.find((e) => e.ticker === 'TOP2');
    assert.equal(top2Excluded, undefined, 'Secondo ticker qualificato non deve mai essere scartato con motivo CUTOFF_PASSED');
    assert.equal(audit.qualifiedCount, 2);

    // 6b. Seasonality con 0 trade -> 0 e INSUFFICIENT_DATA (solo pausa pranzo strutturale 11:30-14:30 resta CHOP_RISK con 0 metriche), nessun benchmark inventato (62.0 / 1.5)
    const seas = calculateIntradaySeasonality([]);
    assert.equal(seas.isJournalDataAvailable, false);
    assert.equal(seas.averageWinRate, 0);
    assert.ok(
      seas.hourlySlots.every(
        (s) =>
          s.winRate === 0 &&
          s.profitFactor === 0 &&
          (s.slotKey === '11:30 - 14:30' ? s.status === 'CHOP_RISK' : s.status === 'INSUFFICIENT_DATA')
      )
    );

    // 6c. IV Metrics senza HV30/ATR14 -> dataAvailable: false (nessun 22.0 / 22.5 inventato)
    const ivMissing = calculateImpliedVolatilityMetrics({ ...qTop1, atr14: null, historicalVolatility30d: null, impliedVolatility: null });
    assert.equal(ivMissing.dataAvailable, false);
    assert.equal(ivMissing.impliedVol, 0);
    assert.equal(ivMissing.avg30dVol, 0);
  });

  it('T7: isolamento rigoroso — nessuna importazione di shadowAlgorithms o ai_knowledge_rules in Shadow V2', () => {
    const v2Source = fs.readFileSync(fileURLToPath(new URL('../../knowledge/shadowV2.ts', import.meta.url)), 'utf8');
    const collectorSource = fs.readFileSync(fileURLToPath(new URL('../../server/shadowV2Collector.ts', import.meta.url)), 'utf8');
    assert.equal(v2Source.includes('shadowAlgorithms'), false);
    assert.equal(v2Source.includes('ai_knowledge_rules'), false);
    assert.equal(collectorSource.includes('shadowAlgorithms'), false);
    assert.equal(collectorSource.includes('ai_knowledge_rules'), false);
  });

  it('T8: pipeline end-to-end collector su disco temporaneo -> getShadowLatest -> ShadowResearchPanel', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const {
      clearShadowV2BarsForTest,
      observeShadowV2Scan,
      recordClosedBarsForShadowV2,
    } = await import('../../server/shadowV2Collector');
    const { getShadowLatest } = await import('../../server/shadowRoute');
    const { ShadowResearchPanel } = await import('../../components/ShadowResearchPanel');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-v2-e2e-'));
    try {
      clearShadowV2BarsForTest();
      const { bars, lastClosedBarEndMs } = buildDirectionalSeries('LONG');
      recordClosedBarsForShadowV2('NVDA', 'US', bars, lastClosedBarEndMs);

      const summary = observeShadowV2Scan([{ ticker: 'NVDA', market: 'US' }], tmpRoot, lastClosedBarEndMs);
      assert.ok(summary && summary.nSignals >= 1, 'Collector deve persistere summary.json');
      assert.ok(fs.existsSync(path.join(tmpRoot, 'artifacts/shadow_v2/signals.jsonl')));
      assert.ok(fs.existsSync(path.join(tmpRoot, 'artifacts/shadow_v2/summary.json')));

      const resp = getShadowLatest({
        fs: {
          existsSync: (p) => fs.existsSync(p),
          readFileSync: (p, e) => fs.readFileSync(p, e),
          readdirSync: (p) => fs.readdirSync(p),
        },
        artifactDir: path.join(tmpRoot, 'artifacts'),
        registryPath: path.join(tmpRoot, 'registry/ai_registry.jsonl'),
        deathcheckPath: path.join(tmpRoot, 'artifacts/ai_deathcheck.json'),
        flags: { SETUP_SELECTOR_LIVE: 'off', STALENESS_USE_MARKET_TS: 'off' },
      });

      assert.equal(resp.status, 200);
      assert.ok(resp.body.shadowV2 != null, 'getShadowLatest deve propagare shadowV2 anche se shadow V1 assente');

      const html = renderToStaticMarkup(React.createElement(ShadowResearchPanel, { data: resp.body as never }));
      assert.ok(html.includes('data-section="shadow-v2"'));
      assert.ok(html.includes('NVDA'));
      assert.ok(html.includes('TARGET_1'));
    } finally {
      clearShadowV2BarsForTest();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('T9: bootstrap sign-flip deterministico a parità di input e seed', () => {
    const recs = [
      mkRecord('a', '2026-11-05', 0.9),
      mkRecord('b', '2026-11-05', 0.1),
      mkRecord('c', '2026-11-06', -0.4),
      mkRecord('d', '2026-11-07', 0.7),
      mkRecord('e', '2026-11-08', -0.2),
      mkRecord('f', '2026-11-09', 0.3),
    ];
    const first = clusterBootstrapSignFlipPValue(recs);
    const second = clusterBootstrapSignFlipPValue(recs);
    assert.equal(first.pValue, second.pValue);
    // 'a' e 'b' cadono lo stesso giorno: i cluster sono 5 sessioni distinte, non 6 record.
    assert.equal(first.nDayClusters, 5);
    assert.ok(first.pValue != null && first.pValue > 0 && first.pValue <= 1);

    // Il generatore è deterministico: due istanze con lo stesso seed danno la stessa sequenza.
    const g1 = mulberry32(SHADOW_V2_HYPOTHESES.BOOTSTRAP_SEED);
    const g2 = mulberry32(SHADOW_V2_HYPOTHESES.BOOTSTRAP_SEED);
    const seq1 = Array.from({ length: 50 }, () => g1());
    const seq2 = Array.from({ length: 50 }, () => g2());
    assert.deepEqual(seq1, seq2);
    assert.equal(new Set(seq1).size, 50, 'Nessuna collisione su 50 estrazioni consecutive');
  });

  it('T10: i segni del bootstrap sono bilanciati (|media| < 0.1 su 2000 estrazioni)', () => {
    const rng = mulberry32(SHADOW_V2_HYPOTHESES.BOOTSTRAP_SEED);
    const n = 2000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rng() < 0.5 ? 1 : -1;
    const mean = sum / n;
    assert.ok(Math.abs(mean) < 0.1, `media dei segni = ${mean}`);
  });

  it('T11: nessuna alternanza forzata — autocorrelazione lag-1 dei segni |r| < 0.1', () => {
    const rng = mulberry32(SHADOW_V2_HYPOTHESES.BOOTSTRAP_SEED);
    const n = 2000;
    const signs: number[] = [];
    for (let i = 0; i < n; i++) signs.push(rng() < 0.5 ? 1 : -1);
    const mean = signs.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const d = signs[i] - mean;
      den += d * d;
      if (i > 0) num += d * (signs[i - 1] - mean);
    }
    const r = num / den;
    assert.ok(Math.abs(r) < 0.1, `autocorrelazione lag-1 = ${r}`);
  });

  it('T12: dati nulli simmetrici attorno a 0 — il p-value non è estremo (> 0.05)', () => {
    const recs: ShadowV2Record[] = [];
    for (let d = 0; d < 20; d++) {
      recs.push(mkRecord(`n${d}`, `2026-11-${String(d + 1).padStart(2, '0')}`, d % 2 === 0 ? 0.5 : -0.5));
    }
    const { pValue, nDayClusters } = clusterBootstrapSignFlipPValue(recs);
    assert.equal(nDayClusters, 20);
    assert.ok(pValue != null && pValue > 0.05, `p-value su dati nulli = ${pValue}`);
  });

  it('T13: effetto positivo netto e coerente su molti cluster — p-value < 0.05', () => {
    const recs: ShadowV2Record[] = [];
    for (let d = 0; d < 20; d++) {
      recs.push(mkRecord(`p${d}`, `2026-11-${String(d + 1).padStart(2, '0')}`, 1.0));
    }
    const { pValue, nDayClusters } = clusterBootstrapSignFlipPValue(recs);
    assert.equal(nDayClusters, 20);
    assert.ok(pValue != null && pValue < 0.05, `p-value su effetto reale = ${pValue}`);
  });
});
