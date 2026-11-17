import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildExecutionSetup,
  calculateKnockOutSafety,
  computeKoPresetFromLeverage,
  evaluateEarningsRisk,
  TRADE_REPUBLIC_KO_LEVERAGE_GRID,
} from '../calculator';
import {
  formatShadowV2SignalsCsv,
  formatShadowV2SignalsJsonl,
  type ShadowV2Record,
} from '../../knowledge/shadowV2';
import {
  buildNotificationKey,
  shouldNotifyOnce,
} from '../browserNotifications';
import {
  PairedV1VsV2Section,
  ShadowResearchPanel,
  type ShadowPanelData,
} from '../../components/ShadowResearchPanel';
import type { ExecutionSetup, RawQuoteData, ScoredCandidate } from '../../types/radar';

function makeQuote(overrides: Partial<RawQuoteData> = {}): RawQuoteData {
  return {
    ticker: 'NVDA',
    name: 'NVIDIA Corporation',
    market: 'US',
    currency: 'USD',
    prevClose: 140,
    currentPrice: 145,
    preMarketPrice: 145,
    prevHigh: 142,
    prevLow: 138,
    preMarketHigh: 146,
    preMarketLow: 143,
    todayOpen: 144,
    todayHigh: 145.8,
    todayLow: 143.5,
    avgVolume20d: 35_000_000,
    preMarketVolume: 2_500_000,
    atr14: 4.5,
    adr14: 4.8,
    liqEur20d: 4_500_000_000,
    fxRate: 1.12,
    orbHigh: 144.8,
    orbLow: 143.5,
    completedBarsCount: 20,
    gapPercent: 2.8,
    rvol: 1.85,
    timestamp: '2026-11-16T15:05:00.000Z',
    source: 'Test Feed',
    ...overrides,
  };
}

describe('Feature 1 — Pre-Trade Knock-Out Trade Republic Simulator', () => {
  it('computeKoPresetFromLeverage calcola barriera e prezzo certificato EUR coerenti con leva e FX live', () => {
    assert.deepEqual([...TRADE_REPUBLIC_KO_LEVERAGE_GRID], [5, 7, 10, 15, 20, 25]);
    const preset10x = computeKoPresetFromLeverage(150, 'LONG', 10, 0.1, true, 1.12);
    // 150 * (1 - 0.10) = 135.00; dist = 15; (15 * 0.1) / 1.12 = 1.34 EUR
    assert.equal(preset10x.barrierStrike, 135);
    assert.equal(preset10x.theoreticalCertPriceEur, 1.34);

    const presetShort = computeKoPresetFromLeverage(100, 'SHORT', 5, 1, false, 1.0);
    // 100 * (1 + 0.20) = 120.00; dist = 20 * 1 = 20.00 EUR
    assert.equal(presetShort.barrierStrike, 120);
    assert.equal(presetShort.theoreticalCertPriceEur, 20);
  });

  it('calculateKnockOutSafety calcola commissioni TR A/R (€2.00), netRT1/netRT2 e fxRateUsed reale', () => {
    const setup: ExecutionSetup = {
      candidate: makeQuote({ fxRate: 1.12 }),
      decision: 'TRADE',
      direction: 'LONG',
      strategy: 'Opening Range Breakout (5m / 15m)',
      triggerLevel: 144.8,
      entryLevel: 144.8,
      vwapCondition: 'Sopra VWAP',
      volumeCondition: 'RVOL >= 1.5x',
      stopLossLevel: 143.3,
      target1Level: 147.8, // +2R (dist 1.5 -> 3.0)
      target2Level: 149.3, // +3R (dist 1.5 -> 4.5)
      riskRewardRatio: 2.0,
      invalidationConditions: ['Stop loss'],
      cutoffTime: '11:30 NY',
      catalystAnalysis: null,
    };

    const ko = calculateKnockOutSafety(setup, {
      barrierStrike: 130.32, // ~10x
      leverage: 10,
      accountCapital: 2000,
      maxRiskPercent: 1.0, // maxRiskEur = 20.00
      spreadEur: 0.02,
      brokerFeeEur: 1.0, // A/R = 2.00 EUR
      ratio: 0.1,
      fxRateEurUsd: 1.12,
    });

    assert.equal(ko.fxRateUsed, 1.12);
    assert.equal(ko.maxRiskEur, 20);
    assert.ok(ko.breakeven.totalFrictionEur >= 2.0, 'la frizione include almeno 2 EUR di fee A/R');
    assert.ok((ko.frictionR ?? 0) > 0, 'frictionR deve essere positivo');
    assert.equal(ko.netGainT1Eur, +(ko.potentialGainT1Eur - ko.breakeven.totalFrictionEur).toFixed(2));
    assert.ok((ko.netRT1 ?? 0) < 2.0, 'R netto a T1 deve essere inferiore al R lordo per via di fee TR + spread');
    assert.ok((ko.netRT2 ?? 0) > (ko.netRT1 ?? 0));
  });
});

describe('Feature 2 — Real Earnings Proximity Risk & Blocker', () => {
  it('classify via evaluateEarningsRisk gestisce 0gg, 1-2gg, 3-7gg e null senza dati sintetici', () => {
    const today = evaluateEarningsRisk({ nextEarningsDate: '2026-11-16', daysToEarnings: 0, earningsRiskLevel: 'IMMINENT_0_2D' });
    assert.equal(today?.level, 'IMMINENT_0_2D');
    assert.match(today?.label || '', /TRIMESTRALE OGGI/);

    const twoDays = evaluateEarningsRisk({ nextEarningsDate: '2026-11-18', daysToEarnings: 2, earningsRiskLevel: 'IMMINENT_0_2D' });
    assert.equal(twoDays?.level, 'IMMINENT_0_2D');
    assert.match(twoDays?.label || '', /TRA 2 GIORNI/);

    const fiveDays = evaluateEarningsRisk({ nextEarningsDate: '2026-11-21', daysToEarnings: 5, earningsRiskLevel: 'UPCOMING_7D' });
    assert.equal(fiveDays?.level, 'UPCOMING_7D');

    const absent = evaluateEarningsRisk({ nextEarningsDate: null, daysToEarnings: null, earningsRiskLevel: null });
    assert.equal(absent, null);

    const farAway = evaluateEarningsRisk({ nextEarningsDate: '2027-01-15', daysToEarnings: 60, earningsRiskLevel: 'CLEAR' });
    assert.equal(farAway, null);
  });

  it('buildExecutionSetup allega earningsWarning e condizione di invalidazione quando daysToEarnings <= 2', () => {
    const cand: ScoredCandidate = {
      quote: makeQuote({ nextEarningsDate: '2026-11-17', daysToEarnings: 1, earningsRiskLevel: 'IMMINENT_0_2D' }),
      score: { gapScore: 15, rvolScore: 15, liquidityScore: 10, futuresScore: 10, levelScore: 10, total: 80, details: [] },
      rank: 1,
    };
    const setup = buildExecutionSetup(cand, null, 'US', undefined, {
      currentTime: new Date('2026-11-16T15:05:00Z'),
    });
    assert.equal(setup.earningsWarning?.level, 'IMMINENT_0_2D');
    assert.equal(setup.earningsWarning?.nextEarningsDate, '2026-11-17');
    assert.ok(
      setup.invalidationConditions.some((c) => c.includes('2026-11-17') && c.includes('Trimestrale')),
      'earningsWarning imminente aggiunto alle invalidationConditions'
    );
  });
});

describe('Feature 3 & 4A — Paired Shadow V1 vs V2 Comparison & CSV/JSONL Export', () => {
  const sampleRecord: Partial<ShadowV2Record> = {
    id: 'sig-1',
    ticker: 'NVDA',
    market: 'US',
    sessionDate: '2026-11-16',
    direction: 'LONG',
    triggerType: 'CUSUM_DISPLACEMENT',
    signalTimeIso: '2026-11-16T15:00:00.000Z',
    status: 'RESOLVED',
    outcome: 'TARGET_1',
    blockedReason: null,
    entryPrice: 145.0,
    structuralStop: 143.5,
    target1: 148.0,
    leverage: 10,
    koBarrier: 130.5,
    exitPrice: 148.0,
    barsHeld: 4,
    rGross: 2.0,
    rNet: 1.78,
    totalFrictionR: 0.22,
    totalFrictionR2500: 0.1,
    varSpreadR: 0.04,
    csSpreadPct: 0.0012,
    diagnostics: {
      vwapAtSignal: 144.2,
      atr5mAtSignal: 0.7,
      adxAtSignal: 28,
      pullbackDistAtr: 0.2,
      pullbackVolRatio: 0.7,
      reclaimVolRatio: 1.6,
      cusumZ: 2.1,
      gapPct: 2.4,
    },
  };

  it('formatShadowV2SignalsCsv e Jsonl generano output valido ed escape CSV corretto', () => {
    const csv = formatShadowV2SignalsCsv([sampleRecord]);
    const lines = csv.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith('id,sessionDate,ticker,market'));
    assert.ok(lines[1].includes('sig-1,2026-11-16,NVDA,US,LONG,CUSUM_DISPLACEMENT'));

    const jsonl = formatShadowV2SignalsJsonl([sampleRecord]);
    const parsed = JSON.parse(jsonl);
    assert.equal(parsed.id, 'sig-1');
    assert.equal(parsed.rNet, 1.78);
  });

  it('PairedV1VsV2Section calcola delta reali se V1 e V2 presenti, e segnala onestamente se V1 assente', () => {
    const v2OnlyPanel: ShadowPanelData = {
      available: false,
      reason: 'missing_v1',
      shadowV2: {
        nSessions: 3,
        nSignals: 5,
        nResolved: 4,
        nOpen: 1,
        nPendingOpen: 0,
        nBlocked: 0,
        wins: 3,
        losses: 1,
        koHits: 0,
        timeouts: 0,
        winRatePct: 75,
        meanRGross: 1.1,
        meanRNet: 0.85,
        medianFrictionR: 0.22,
        medianFrictionR2500: 0.1,
        profitFactor: 2.4,
        maxDrawdownR: 1.1,
        dsr: 0.42,
        clusterBootstrapPValue: 0.041,
        nDayClusters: 3,
        recentSignals: [],
      },
    };
    const htmlV1Absent = renderToStaticMarkup(React.createElement(ShadowResearchPanel, { data: v2OnlyPanel }));
    assert.ok(htmlV1Absent.includes('Artefatto V1 assente'));
    assert.ok(htmlV1Absent.includes('shadow-v2-export-csv'));
    assert.ok(htmlV1Absent.includes('shadow-v2-export-jsonl'));

    const bothPanel: ShadowPanelData = {
      ...v2OnlyPanel,
      available: true,
      sample: { nDays: 10, nSetups: 18, nClusters: 10, barMinutes: 5 },
      deflatedSharpe: {
        nTrials: 12,
        nTrialsSource: 'registry',
        dsr: 0.1,
        pValue: 0.25,
        alphaBonferroni: 0.004,
        alphaEffective: 0.002,
        note: 'test',
      },
      rules: [
        { id: 'S01', name: 'meanR', family: 'expectancy', status: 'computed', value: -0.05, unit: 'R', n: 18, note: '' },
      ],
    };
    const htmlBoth = renderToStaticMarkup(React.createElement(PairedV1VsV2Section, { data: bothPanel }));
    assert.ok(htmlBoth.includes('+0.900R'), 'delta Mean R Netto calcolato correttamente (0.85 - (-0.05) = +0.900R)');
    assert.ok(htmlBoth.includes('+0.320'), 'delta DSR calcolato correttamente (0.42 - 0.10 = +0.320)');
    assert.ok(htmlBoth.includes('-0.2090'), 'delta p-value calcolato correttamente (0.041 - 0.250 = -0.2090)');
  });
});

describe('Feature 4B — Browser Notifications Deduplication', () => {
  it('shouldNotifyOnce impedisce notifiche duplicate per la stessa chiave', () => {
    const reg = new Set<string>();
    const k1 = buildNotificationKey('TRADE_SETUP', 'nvda', '2026-11-16', 'US:LONG');
    const k2 = buildNotificationKey('SHADOW_V2', 'nvda', '2026-11-16', 'sig-1:TARGET_1');

    assert.equal(k1, 'TRADE_SETUP:NVDA:2026-11-16:US:LONG');
    assert.equal(shouldNotifyOnce(k1, reg), true);
    assert.equal(shouldNotifyOnce(k1, reg), false, 'secondo polling non deve reinviare la stessa notifica');
    assert.equal(shouldNotifyOnce(k2, reg), true, 'chiave distinta Shadow V2 deve notificare una volta');
    assert.equal(shouldNotifyOnce(k2, reg), false);
  });
});
