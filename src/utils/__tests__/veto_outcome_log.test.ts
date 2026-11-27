/**
 * Test del log dei veti misurati in produzione (src/server/vetoOutcomeLog.ts).
 *
 * Coprono: esito forward (target, stop, scadenza, fill al trigger vs a
 * mercato), mark a orizzonte, monotonia degli stati, parsing tollerante e
 * deduplica del log append-only.
 *
 * Uso: npx tsx src/utils/__tests__/veto_outcome_log.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  foldVetoLog,
  logVetoOutcomes,
  mergeVetoState,
  simulateVetoForward,
  summarizeVetoOutcomes,
  vetoRecordId,
  type VetoDecisionRecord,
  type VetoState,
} from '../../server/vetoOutcomeLog';
import type { RawQuoteData, ScoreBreakdown } from '../../types/radar';

const T0 = 1_790_000_000_000;
const MIN = 60_000;

function decision(overrides: Partial<VetoDecisionRecord> = {}): VetoDecisionRecord {
  const base: VetoDecisionRecord = {
    type: 'decide',
    id: 'EU|TEST.MI|2026-11-24|SUPERTREND_OPPOSED|LONG|E101.00|S99.00',
    decidedAtMs: T0,
    sessionDay: '2026-11-24',
    ticker: 'TEST.MI',
    market: 'EU',
    direction: 'LONG',
    veto: 'SUPERTREND_OPPOSED',
    score: 52,
    context: {
      vetoReasons: ['SUPERTREND_OPPOSED'],
      supertrendDirection: -1,
      supertrendBarsSinceFlip: 3,
      adx: 21.4,
      adxThreshold: 16,
      plusDI: 20,
      minusDI: 24,
      vwapState: 'BELOW',
      vwapDistAtr: -0.4,
      setupIndicators: undefined as any,      vwapVolumeRatio: 1.9,
    },
    levels: { markerPrice: 100, entry: 101, stop: 99, target1: 104.2, stopDistancePct: 1.98 },
    hypothetical: { decision: 'TRADE', blockedGate: null, minScoreApplied: 48 },
  };
  return {
    ...base,
    ...overrides,
    levels: { ...base.levels, ...(overrides.levels ?? {}) },
  };
}

describe('Veto outcome log', () => {
  it('V1: esito forward con target — fill al trigger e a mercato, mark e MFE/MAE', () => {
    const bars = [
      { t: T0 + 5 * MIN, h: 101.2, l: 99.5, c: 100.4 },
      { t: T0 + 10 * MIN, h: 102, l: 100, c: 101.8 },
      { t: T0 + 30 * MIN, h: 104.5, l: 101, c: 104.3 },
    ];
    const state = simulateVetoForward(decision(), bars, T0 + 61 * MIN);
    assert.strictEqual(state.triggerFilled, true);
    assert.strictEqual(state.fillBarTs, T0 + 5 * MIN);
    assert.strictEqual(state.status, 'TARGET');
    assert.strictEqual(state.exitBarTs, T0 + 10 * MIN);
    assert.strictEqual(state.rMarket, 1.6, 'target a 1.6R dal prezzo della decisione');
    assert.strictEqual(state.rTrigger, 1.6, 'target del setup raggiunto dopo il fill');
    assert.strictEqual(state.marks['15'], 4.3, 'mark a +15m sulla prima barra disponibile');
    assert.strictEqual(state.marks['30'], 4.3);
    assert.strictEqual(state.marks['60'], null, 'nessuna barra a +60m: null, mai una stima');
    assert.strictEqual(state.mfeR, 4.5);
    assert.strictEqual(state.maeR, -0.5);
    assert.strictEqual(state.barsSeen, 3);
  });

  it('V2: senza fill al trigger non esiste R al trigger, ma il mark forward resta misurabile', () => {
    const bars = [
      { t: T0 + 5 * MIN, h: 100.6, l: 100.1, c: 100.4 },
      { t: T0 + 20 * MIN, h: 100.8, l: 99.8, c: 99.9 },
    ];
    const state = simulateVetoForward(decision(), bars, T0 + 70 * MIN);
    assert.strictEqual(state.triggerFilled, false);
    assert.strictEqual(state.rTrigger, null);
    assert.strictEqual(state.status, 'EXPIRED');
    // Mark a +15m = prima chiusura disponibile a/ dopo l'orizzonte (barra a +20m).
    assert.strictEqual(state.marks['15'], -0.1);
    assert.strictEqual(state.marks['30'], null, 'nessuna chiusura a/ dopo +30m');
    assert.ok(state.rMarket != null && state.rMarket < 0);
  });

  it('V3: dentro la stessa barra lo stop ha precedenza sul target', () => {
    const bars = [{ t: T0 + 5 * MIN, h: 105, l: 98.9, c: 104 }];
    const state = simulateVetoForward(decision(), bars, T0 + 15 * MIN);
    assert.strictEqual(state.status, 'STOP');
    assert.strictEqual(state.rMarket, -1);
    assert.strictEqual(state.rTrigger, -1);
  });

  it('V4: senza livelli lo stato e NO_LEVELS e nessun R inventato', () => {
    const state = simulateVetoForward(
      decision({ levels: { markerPrice: 100, entry: null, stop: null, target1: null, stopDistancePct: null } }),
      [{ t: T0 + 5 * MIN, h: 101, l: 99, c: 100.5 }],
      T0 + 10 * MIN
    );
    assert.strictEqual(state.status, 'NO_LEVELS');
    assert.strictEqual(state.rMarket, null);
    assert.strictEqual(state.rTrigger, null);
  });

  it('V5: gli stati terminali non tornano indietro e i valori noti non diventano null', () => {
    const previous: VetoState = {
      status: 'TARGET',
      triggerFilled: true,
      fillBarTs: T0 + MIN,
      rTrigger: 1.6,
      rMarket: 1.6,
      exitBarTs: T0 + 2 * MIN,
      exitPrice: 101.6,
      marks: { '15': 1.6, '30': null, '60': null },
      mfeR: 1.8,
      maeR: -0.2,
      barsSeen: 3,
      updatedAtMs: T0 + 3 * MIN,
    };
    const later = simulateVetoForward(decision(), [], T0 + 90 * MIN);
    const merged = mergeVetoState(previous, later);
    assert.deepStrictEqual(merged, previous);
  });

  it('V6: parsing tollerante e stato ricostruito dall ultima riga valida', () => {
    const decide = JSON.stringify(decision());
    const update = JSON.stringify({
      type: 'update',
      id: 'EU|TEST.MI|2026-11-24|SUPERTREND_OPPOSED|LONG|E101.00|S99.00',
      state: {
        status: 'OPEN',
        triggerFilled: false,
        marks: { '15': -0.3, '30': null, '60': null },
        mfeR: 0.2,
        maeR: -0.5,
        barsSeen: 2,
        updatedAtMs: T0 + 15 * MIN,
      },
    });
    const fold = foldVetoLog(`non-json\n\n${decide}\n{"type":"update"}\n${update}\n`);
    assert.strictEqual(fold.size, 1);
    const entry = [...fold.values()][0];
    assert.strictEqual(entry.latest.status, 'OPEN');
    assert.strictEqual(entry.latest.marks['15'], -0.3);
    assert.strictEqual(entry.decision.context.adx, 21.4);
  });

  it('V7: la sintesi per veto/mercato misura n, esiti e R medi', () => {
    const fold = foldVetoLog(
      [
        JSON.stringify(decision()),
        JSON.stringify({
          type: 'update',
          id: 'EU|TEST.MI|2026-11-24|SUPERTREND_OPPOSED|LONG|E101.00|S99.00',
          state: {
            status: 'STOP',
            triggerFilled: true,
            rMarket: -1,
            rTrigger: -1,
            marks: { '15': -0.6, '30': -1, '60': -1 },
            mfeR: 0.1,
            maeR: -1,
            barsSeen: 4,
            updatedAtMs: T0 + 60 * MIN,
          },
        }),
      ].join('\n')
    );
    const rows = summarizeVetoOutcomes(fold);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].veto, 'SUPERTREND_OPPOSED');
    assert.strictEqual(rows[0].market, 'EU');
    assert.strictEqual(rows[0].n, 1);
    assert.strictEqual(rows[0].stop, 1);
    assert.strictEqual(rows[0].triggerFillPct, 100);
    assert.strictEqual(rows[0].meanRMarket, -1);
    assert.strictEqual(rows[0].meanMark30, -1);
  });

  it('V8: id stabile sui livelli arrotondati', () => {
    const base = { ticker: 'TEST.MI', market: 'EU' as const, day: '2026-11-24', veto: 'VWAP_OPPOSED' as const, direction: 'SHORT' as const };
    assert.strictEqual(
      vetoRecordId({ ...base, entry: 100.001, stop: 101.004 }),
      vetoRecordId({ ...base, entry: 100.004, stop: 101.0 })
    );
  });

  it('V9: il log append-only non duplica lo stesso veto nella stessa seduta', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veto-log-'));
    const logPath = path.join(dir, 'veto_outcome_log.jsonl');
    const quote = {
      ticker: 'TEST.MI',
      name: 'Test S.p.A.',
      market: 'EU',
      currency: 'EUR',
      prevClose: 99.0,
      currentPrice: 100.1,
      preMarketPrice: 100.0,
      prevHigh: 99.5,
      prevLow: 98.0,
      preMarketHigh: 100.0,
      preMarketLow: 99.5,
      todayOpen: 100.0,
      todayHigh: 100.1,
      todayLow: 99.9,
      vwap: 100.0,
      ema20Daily: 98.0,
      avgVolume20d: 250_000,
      preMarketVolume: 50_000,
      atr14: 1.3,
      adr14: 10.0,
      liqEur20d: 5_000_000,
      completedBarsCount: 20,
      orbHigh: 100.0,
      orbLow: 99.799599,
      T: 100.0,
      E: 100.0,
      S: 99.0,
      orbBreakoutTime: new Date(T0).toISOString(),
      gapPercent: 1.2,
      rvol: 1.5,
      rvol20m: 1.2,
      rsi14: 55,
      setupIndicators: {
        barsUsed: 60,
        adx: { status: 'OK', reason: null, value: 12, plusDI: 18, minusDI: 30 },
        supertrend: { status: 'OK', reason: null, direction: -1, barsSinceFlip: 4, value: 99 },
        stochRsi: { status: 'OK', reason: null, k: 40, d: 45, lastCross: 'NONE', barsSinceCross: null },
        psar: { status: 'OK', reason: null, value: 99, direction: -1, barsSinceFlip: 2 },
        atr: { value: 1.2, status: 'OK', reason: null },
        recentBars: [{ t: T0 - 5 * MIN, h: 100.5, l: 99.5, c: 100 }],
      },
      vwapState: { state: 'BELOW', distAtr: -0.5, slopeAtr: -0.1, coverage: 1, volumeRatio: 2, flags: [], vwapLevel: 101 },
      timestamp: new Date(T0).toISOString(),
      source: 'veto_outcome_log fixture',
    } as unknown as RawQuoteData;
    const score = {
      total: 50,
      veto: 'ADX_BELOW_MARKET_THRESHOLD',
      vetoReasons: ['ADX_BELOW_MARKET_THRESHOLD', 'SUPERTREND_OPPOSED'],
      warmupIncomplete: false,
    } as unknown as ScoreBreakdown;

    const first = logVetoOutcomes({ scored: [{ quote, score }], nowMs: T0, logPath, market: 'EU' });
    assert.strictEqual(first.added, 1);
    assert.ok(fs.existsSync(logPath));

    const second = logVetoOutcomes({ scored: [{ quote, score }], nowMs: T0 + 5 * MIN, logPath, market: 'EU' });
    assert.strictEqual(second.added, 0, 'stesso veto/livelli nella stessa seduta: nessun duplicato');

    const fold = foldVetoLog(fs.readFileSync(logPath, 'utf-8'));
    assert.strictEqual(fold.size, 1);
    const entry = [...fold.values()][0];
    assert.strictEqual(entry.decision.veto, 'ADX_BELOW_MARKET_THRESHOLD');
    assert.deepStrictEqual(entry.decision.context.vetoReasons, [
      'ADX_BELOW_MARKET_THRESHOLD',
      'SUPERTREND_OPPOSED',
    ]);
    assert.strictEqual(entry.decision.context.adx, 12);
    assert.strictEqual(entry.decision.context.adxThreshold, 16);
    // Controfattuale costruito dalla pipeline reale: livelli presenti, non inventati.
    assert.ok(entry.decision.levels.entry != null, 'entry calcolata da buildExecutionSetup');
    assert.ok(entry.decision.levels.stop != null, 'stop calcolato da buildExecutionSetup');
    assert.ok(entry.decision.levels.target1 != null, 'target calcolato da buildExecutionSetup');
    assert.ok(entry.decision.levels.stopDistancePct != null && entry.decision.levels.stopDistancePct > 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('V10: normalizzazione in R corretta quando riskMarket != 1 (mark, MFE, MAE e rMarket)', () => {
    const dec = decision({
      levels: { markerPrice: 200, entry: 202, stop: 196, target1: 211.6, stopDistancePct: 2.97 },
    });
    // riskMarket = |200 - 196| = 4; riskTrigger = |202 - 196| = 6; targetR = 9.6/6 = 1.6; targetMarket = 206.4
    const bars = [
      { t: T0 + 5 * MIN, h: 204, l: 198, c: 202 },
      { t: T0 + 15 * MIN, h: 208, l: 201, c: 206 },
    ];
    const state = simulateVetoForward(dec, bars, T0 + 20 * MIN);
    assert.strictEqual(state.status, 'TARGET');
    assert.strictEqual(state.rMarket, 1.6);
    assert.strictEqual(state.marks['15'], 1.5, '(206-200)/4 = +1.5R, non +6');
    assert.strictEqual(state.mfeR, 2, '(208-200)/4 = +2R');
    assert.strictEqual(state.maeR, -0.5, '(198-200)/4 = -0.5R');
  });

  it('V11: SHORT MFE/MAE calcolati su low favorevole e high avverso', () => {
    const dec = decision({
      direction: 'SHORT',
      levels: { markerPrice: 100, entry: 99, stop: 102, target1: 94.2, stopDistancePct: 3.03 },
    });
    // riskMarket = 2; favourable move down to 96 => +2R; adverse move up to 101 => -0.5R
    const bars = [{ t: T0 + 15 * MIN, h: 101, l: 96, c: 97 }];
    const state = simulateVetoForward(dec, bars, T0 + 20 * MIN);
    assert.strictEqual(state.marks['15'], 1.5);
    assert.strictEqual(state.mfeR, 2);
    assert.strictEqual(state.maeR, -0.5);
  });

  it('V12: logVetoOutcomes ignora candidati senza veto o con warmupIncomplete e preserva market US', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veto-log-us-'));
    const logPath = path.join(dir, 'veto_outcome_log.jsonl');
    const makeQuote = (ticker: string, market: 'EU' | 'US') =>
      ({
        ticker,
        name: ticker,
        market,
        currency: market === 'US' ? 'USD' : 'EUR',
        prevClose: 100,
        currentPrice: 101,
        todayOpen: 100.5,
        todayHigh: 101.2,
        todayLow: 100.2,
        vwap: 100.8,
        atr14: 1.5,
        adr14: 3.0,
        orbHigh: 101,
        orbLow: 100.2,
        gapPercent: 1.0,
        rvol: 1.8,
        rsi14: 55,
        setupIndicators: {
          barsUsed: 40,
          adx: { status: 'OK', reason: null, value: 14, plusDI: 18, minusDI: 22 },
          supertrend: { status: 'OK', reason: null, direction: -1, barsSinceFlip: 2, value: 102 },
          recentBars: [],
        },
        vwapState: { state: 'BELOW', distAtr: -0.3, volumeRatio: 1.5 },
        timestamp: new Date(T0).toISOString(),
      }) as unknown as RawQuoteData;

    const res = logVetoOutcomes({
      nowMs: T0,
      logPath,
      scored: [
        { quote: makeQuote('CLEAN.US', 'US'), score: { total: 80, veto: null, vetoReasons: [], warmupIncomplete: false } as unknown as ScoreBreakdown },
        { quote: makeQuote('WARMUP.US', 'US'), score: { total: 40, veto: 'VWAP_OPPOSED', vetoReasons: ['VWAP_OPPOSED'], warmupIncomplete: true } as unknown as ScoreBreakdown },
        { quote: makeQuote('NVDA', 'US'), score: { total: 55, veto: 'VWAP_OPPOSED', vetoReasons: ['VWAP_OPPOSED'], warmupIncomplete: false } as unknown as ScoreBreakdown },
      ],
    });
    assert.strictEqual(res.added, 1, 'solo il candidato con veto reale e warmup completo');
    const entry = [...res.fold.values()][0];
    assert.strictEqual(entry.decision.ticker, 'NVDA');
    assert.strictEqual(entry.decision.market, 'US');
    assert.strictEqual(entry.decision.context.adxThreshold, 20, 'soglia ADX US reale');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('V13: record terminali NON vengono cancellati al giro successivo e veto_state usa gli id reali', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veto-log-term-'));
    const logPath = path.join(dir, 'veto_outcome_log.jsonl');
    const statePath = path.join(dir, 'veto_state.json');
    const dec = decision();
    fs.writeFileSync(logPath, JSON.stringify(dec) + '\n', 'utf8');

    const barsByTicker = new Map([
      ['TEST.MI', [{ t: T0 + 5 * MIN, h: 105, l: 98.5, c: 99 }]],
    ]);
    const step1 = logVetoOutcomes({ nowMs: T0 + 10 * MIN, scored: [], logPath, barsByTicker });
    assert.strictEqual(step1.fold.get(dec.id)?.latest.status, 'STOP');

    // Seconda scansione vuota: il record STOP deve restare nel JSONL e in veto_state.json
    const step2 = logVetoOutcomes({ nowMs: T0 + 20 * MIN, scored: [], logPath });
    assert.strictEqual(step2.fold.size, 1);
    assert.strictEqual(step2.fold.get(dec.id)?.latest.status, 'STOP');
    const persistedFold = foldVetoLog(fs.readFileSync(logPath, 'utf8'));
    assert.strictEqual(persistedFold.size, 1);
    assert.strictEqual(persistedFold.get(dec.id)?.latest.status, 'STOP');
    const stateJson = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(dec.id in stateJson, 'veto_state.json indicizzato per id reale');
    assert.strictEqual('record' in stateJson, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('V14: foldVetoLog scarta righe corrotte con id o ticker vuoto', () => {
    const corrupt = JSON.stringify({ type: 'decide', id: '', ticker: '', market: 'EU', veto: 'SUPERTREND_OPPOSED' });
    const fold = foldVetoLog(`${corrupt}\n${JSON.stringify(decision())}\n`);
    assert.strictEqual(fold.size, 1);
  });
});

