import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { filterRelevantFreshNews, normalizeFuturesPayload } from '../newsFilter';
import { buildAiEvidencePack, indexAiEvidence } from '../../knowledge/aiEvidencePack';
import { validateDeskAnalysis } from '../../knowledge/aiDeskContract';
import { buildAiCalibration } from '../../server/aiCalibration';
import { ShadowAiCalibrationBlock } from '../../components/ShadowAISection';
import type { TradeJournalEntry } from '../../types/radar';

const NOW_MS = Date.UTC(2026, 10, 27, 9, 30, 0); // 2026-11-27T09:30:00Z

describe('P1 — filterRelevantFreshNews (igiene RSS freschezza e pertinenza ticker)', () => {
  it('scarta articoli obsoleti (>72h) e articoli fuori-ticker su ISP.MI', () => {
    const rawItems = [
      {
        id: 'stale-1',
        title: 'Intesa Sanpaolo stacca dividendo straordinario',
        summary: 'Articolo di giugno rimasto nel feed RSS',
        source: 'Il Sole 24 Ore',
        publishedAt: '2026-06-08T10:00:00.000Z',
      },
      {
        id: 'off-ticker-1',
        title: 'Nvidia giù in Borsa a Wall Street dopo prese di beneficio sul comparto chip',
        summary: 'Vendite sui semiconduttori USA nella seduta serale',
        source: 'FinanzaOnline',
        publishedAt: new Date(NOW_MS - 2 * 3_600_000).toISOString(),
      },
      {
        id: 'fresh-isp',
        title: 'Intesa Sanpaolo (ISP.MI) avvia nuova tranche di buyback dopo ok BCE',
        summary: 'Via libera della vigilanza europea per l istituto guidato da Messina',
        source: 'Reuters',
        publishedAt: new Date(NOW_MS - 4 * 3_600_000).toISOString(),
      },
    ];

    const res = filterRelevantFreshNews(rawItems, 'ISP.MI', 'Intesa Sanpaolo', NOW_MS, 72);
    assert.equal(res.staleCount, 1);
    assert.equal(res.offTickerCount, 1);
    assert.equal(res.fresh.length, 1);
    assert.equal(res.fresh[0].id, 'fresh-isp');
    assert.equal(res.hasRecent24h, true);
    assert.equal(res.hasPrimaryWire, true);
  });

  it('riconosce fonti secondarie tra 24h e 72h per il tetto prudenziale sul bonus', () => {
    const rawItems = [
      {
        id: 'older-blog',
        title: 'NVDA consolidamento tecnico sul settore AI',
        summary: 'Analisi su Nvidia Corp',
        source: 'Blog Finanziario Indipendente',
        publishedAt: new Date(NOW_MS - 36 * 3_600_000).toISOString(),
      },
    ];

    const res = filterRelevantFreshNews(rawItems, 'NVDA', 'NVIDIA Corporation', NOW_MS, 72);
    assert.equal(res.fresh.length, 1);
    assert.equal(res.hasRecent24h, false);
    assert.equal(res.hasPrimaryWire, false);
  });
});

describe('P1 — normalizeFuturesPayload (compatibilità payload completo vs slice EU/US)', () => {
  it('estrae changePercent sia da oggetto completo { europe, usa } sia da slice { dax } / { sp500 }', () => {
    const full = {
      europe: { dax: { changePercent: -0.68 }, eurostoxx: { changePercent: -0.51 } },
      usa: { sp500: { changePercent: 0.44 }, nasdaq: { changePercent: 0.72 } },
    };

    const euFromFull = normalizeFuturesPayload(full, 'EU');
    const euFromSlice = normalizeFuturesPayload(full.europe, 'EU');
    assert.equal(euFromFull.changePercent, -0.68);
    assert.equal(euFromSlice.changePercent, -0.68);
    assert.equal(euFromSlice.benchmarkLabel, 'DAX');

    const usFromFull = normalizeFuturesPayload(full, 'US');
    const usFromSlice = normalizeFuturesPayload(full.usa, 'US');
    assert.equal(usFromFull.changePercent, 0.44);
    assert.equal(usFromSlice.changePercent, 0.44);
    assert.equal(usFromSlice.benchmarkLabel, 'S&P 500');
  });
});

describe('P1 — AiEvidencePack + validazione riepilogo deterministico post-mortem', () => {
  it('indicizza journal.winRateAllPct, journal.netPnlEur e calibration.catalystLift.* senza falsi positivi', () => {
    const trades: TradeJournalEntry[] = [
      {
        id: 't1',
        timestamp: '2026-11-26T09:30:00Z',
        date: '2026-11-26',
        session: 'EU',
        market: 'EU',
        ticker: 'ISP.MI',
        direction: 'LONG',
        strategy: 'ORB',
        entryPrice: 3.5,
        exitPrice: 3.6,
        stopLoss: 3.45,
        target1: 3.6,
        pnlEur: 120.5,
        rMultiple: 2,
        outcome: 'WIN',
        notes: '',
        isPaper: false,
      } as TradeJournalEntry,
      {
        id: 't2',
        timestamp: '2026-11-26T10:30:00Z',
        date: '2026-11-26',
        session: 'EU',
        market: 'EU',
        ticker: 'UCG.MI',
        direction: 'LONG',
        strategy: 'ORB',
        entryPrice: 38,
        exitPrice: 37.5,
        stopLoss: 37.5,
        target1: 39,
        pnlEur: -85.25,
        rMultiple: -1,
        outcome: 'LOSS',
        notes: '',
        isPaper: false,
      } as TradeJournalEntry,
      {
        id: 't3',
        timestamp: '2026-11-26T11:30:00Z',
        date: '2026-11-26',
        session: 'EU',
        market: 'EU',
        ticker: 'ENI.MI',
        direction: 'SHORT',
        strategy: 'ORB',
        entryPrice: 14,
        exitPrice: 14,
        stopLoss: 14.2,
        target1: 13.6,
        pnlEur: -4,
        rMultiple: 0,
        outcome: 'EXPIRED',
        notes: '',
        isPaper: true,
      } as TradeJournalEntry,
    ];

    const pack = buildAiEvidencePack({
      generatedAtMs: NOW_MS,
      journal: { trades, excluded: [] },
      calibration: {
        available: true,
        verdict: 'insufficient',
        counts: { matched: 6, classified: 6 },
        catalystLift: {
          matchedCatalysts: 4,
          verdict: 'insufficient',
          bonusLiftRNet: 0.42,
          alignmentLiftRNet: 0.35,
        },
      },
    });

    const idx = indexAiEvidence(pack);
    assert.equal(idx.get('journal.winRateAllPct')?.value, 33.33);
    assert.equal(idx.get('journal.netPnlEur')?.value, 31.25);
    assert.equal(idx.get('calibration.catalystLift.matched')?.value, 4);
    assert.equal(idx.get('calibration.catalystLift.bonusLiftRNet')?.value, 0.42);

    const j = pack.sections.journal!;
    const fallbackSummary =
      `LLM non disponibile: riepilogo deterministico delle sessioni GLOBAL. ` +
      `${j.n} trade chiusi analizzati (${j.wins} win, ${j.losses} loss, ${j.breakevens} BE, ${j.expired} scaduti), ` +
      `win rate ${j.winRateAllPct}% sui trade chiusi, P&L netto ${j.netPnlEur} €, R medio ${j.avgR?.toFixed(2)}R.`;

    const validated = validateDeskAnalysis(
      {
        summary: fallbackSummary,
        summaryRefs: ['journal.n', 'journal.winRateAllPct', 'journal.netPnlEur', 'journal.avgR'],
        claims: [],
        proposedDirectives: [],
        dataGaps: ['LLM in cooldown'],
      },
      { pack, predicateIds: [] }
    );

    assert.equal(validated.summaryUnsupportedNumbers.length, 0);
    assert.equal(validated.summaryVerified, true);
  });
});

describe('P1/P2 — Coesistenza candidateKey scan vs catalyst e rendering UI catalystLift', () => {
  it('non sovrascrive la riga scan quando catalyst usa il prefisso catalyst:<runId>:<ticker>', () => {
    const tIso = new Date(NOW_MS).toISOString();
    const tPlus1Iso = new Date(NOW_MS + 5_000).toISOString();

    const cal = buildAiCalibration({
      entries: [
        {
          id: 'scan-1',
          timestamp: tIso,
          ticker: 'NVDA',
          market: 'US',
          direction: 'LONG',
          source: 'scan',
          aiOutcome: 'setup pulito',
          decision: 'AZIONE',
          evaluated: true,
          candidateKey: 'run-42:NVDA',
        },
        {
          id: 'cat-1',
          timestamp: tPlus1Iso,
          ticker: 'NVDA',
          market: 'US',
          direction: 'LONG',
          source: 'catalyst',
          aiOutcome: 'Upgrade primario Reuters',
          aiCategory: 'newsBonus=12;dirMatch=aligned;regime=aligned',
          decision: 'AZIONE',
          evaluated: true,
          candidateKey: 'catalyst:run-42:NVDA',
        },
      ],
      forward: [
        {
          key: 'sig-nvda-1',
          ticker: 'NVDA',
          decidedAtMs: NOW_MS + 10_000,
          r: 1.8,
          status: 'TARGET',
          source: 'signals',
        },
      ],
      nowMs: NOW_MS + 60_000,
      generatedAt: tPlus1Iso,
    });

    assert.equal(cal.counts.dedupedEntries, 2, 'scan e catalyst devono restare entrambi presenti');
    assert.equal(cal.catalystLift.matchedCatalysts, 1);
    assert.equal(cal.catalystLift.withBonus.n, 1);
  });

  it('ShadowAiCalibrationBlock mostra il blocco lift catalizzatore quando matchedCatalysts > 0', () => {
    const html = renderToStaticMarkup(
      React.createElement(ShadowAiCalibrationBlock, {
        calibration: {
          available: true,
          verdict: 'insufficient',
          minSample: 30,
          counts: { matched: 5, classified: 5 },
          catalystLift: {
            matchedCatalysts: 3,
            verdict: 'insufficient',
            bonusLiftRNet: 0.55,
            alignmentLiftRNet: 0.28,
          },
        },
      })
    );

    assert.ok(html.includes('shadow-ai-calibration-catalyst-lift'));
    assert.ok(html.includes('0.55'));
    assert.ok(html.includes('0.28'));
  });
});
