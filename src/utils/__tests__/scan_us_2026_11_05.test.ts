/**
 * Test di regressione per la scansione US del 05/11/2026 (NVDA).
 *
 * Copre i tre bug corretti:
 *  1. coverage 0.038/0.000 in computeSessionVwap con cutoff anticipato;
 *  2. computeVwapDataQuality che scartava l'intero feed per una barra 5m con campi null;
 *  3. badge Header "US: Pre-Mkt" dopo la chiusura cash (16:05 ET).
 *
 * Gli istanti ET sono costruiti con getMarketTime (nessun offset fisso), le barre sono le
 * tre barre Yahoo 5m reali del 05/11/2026 piu' serie sintetiche per i casi limite.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  computeSessionVwap,
  computeVwapDataQuality,
  buildExecutionSetup,
} from '../calculator';
import type { VwapBar } from '../calculator';
import { getMarketTime } from '../timezone';
import { Header } from '../../components/Header';
import { usSessionLabel } from '../sessionBadge';
import type { RawQuoteData, ScoredCandidate, SessionInfo } from '../../types/radar';

const SESSION_DATE = '2026-11-05';

/** Istante UTC il cui orologio ET del 05/11/2026 segna `totalMinutes` (nessun offset fisso). */
function etInstant(totalMinutes: number): Date {
  let t = Date.UTC(2026, 10, 5, 14, 0, 0);
  for (let i = 0; i < 4; i++) {
    const mt = getMarketTime('US', new Date(t));
    if (mt.dateFormatted !== SESSION_DATE) throw new Error(`data ET inattesa: ${mt.dateFormatted}`);
    const delta = totalMinutes - mt.totalMinutes;
    if (delta === 0) return new Date(t);
    t += delta * 60_000;
  }
  throw new Error(`impossibile costruire l'istante ET ${totalMinutes}`);
}

// Barre Yahoo 5m reali NVDA 05/11/2026 (open-time UTC: 14:30, 14:35, 14:40 = 09:30/09:35/09:40 ET).
const NVDA_BARS: VwapBar[] = [
  {
    timestamp: 1793889000,
    open: 195.1,
    high: 196.22500610351562,
    low: 193.6199951171875,
    close: 193.63499450683594,
    volume: 14685212,
  },
  {
    timestamp: 1793889300,
    open: 193.65,
    high: 194.22999572753906,
    low: 191.64999389648438,
    close: 192.39010620117188,
    volume: 6949204,
  },
  {
    timestamp: 1793889600,
    open: 192.4,
    high: 192.82000732421875,
    low: 191.51010131835938,
    close: 192.0800018310547,
    volume: 28130058,
  },
];

/** Serie 5m regolare della sessione USA: `count` barre da 09:30 ET. */
function usSeries(count: number, override: (i: number) => Partial<VwapBar> = () => ({}) ): VwapBar[] {
  return Array.from({ length: count }, (_, i) => {
    const base: VwapBar = {
      timestamp: Math.floor(etInstant(570 + i * 5).getTime() / 1000),
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1000,
    };
    return { ...base, ...override(i) };
  });
}

describe('BUG 1 - coverage computeSessionVwap con cutoff anticipato (NVDA 05/11/2026)', () => {
  it('cutoff 09:45 ET: 3 barre su 3 attese -> coverage ~1.0 e vwap non null', () => {
    const res = computeSessionVwap(NVDA_BARS, 'US', SESSION_DATE, { nowMinutes: 585 });
    assert.strictEqual(res.barsUsed, 3);
    assert.strictEqual(res.barsWithVolume, 3);
    assert.ok(res.vwap != null && res.vwap > 0, 'vwap atteso non null');
    assert.ok(
      Math.abs((res.coverage ?? 0) - 1) < 1e-9,
      `coverage atteso ~1.0, ricevuto ${res.coverage}`
    );
  });

  it('senza nowMinutes (chiamata del bug) il coverage resta ~1.0 e non 0.038', () => {
    const res = computeSessionVwap(NVDA_BARS, 'US', SESSION_DATE);
    assert.strictEqual(res.barsWithVolume, 3);
    assert.ok(
      Math.abs((res.coverage ?? 0) - 1) < 1e-9,
      `coverage atteso ~1.0, ricevuto ${res.coverage}`
    );
  });

  it('cutoff 13:00 ET: 42 barre regolari e coverage 1', () => {
    const cutoff = 780; // 13:00 ET = 18:00 UTC
    // 1. Feed completo di giornata (78 barre) valutato al cutoff: entrano solo le 42 chiuse.
    const fullDay = computeSessionVwap(usSeries(78), 'US', SESSION_DATE, { nowMinutes: cutoff });
    assert.strictEqual(fullDay.barsUsed, 42);
    assert.strictEqual(fullDay.coverage, 1);

    // 2. Feed cosi' come arriva alle 13:00 ET (42 barre) senza nowMinutes: era il caso del bug.
    const bars = usSeries(42);
    const withoutNow = computeSessionVwap(bars, 'US', SESSION_DATE);
    assert.strictEqual(withoutNow.barsUsed, 42);
    assert.strictEqual(withoutNow.coverage, 1);

    const quality = computeVwapDataQuality(
      bars,
      { currentPrice: 100.5, vwap: withoutNow.vwap },
      'US',
      etInstant(cutoff)
    );
    assert.strictEqual(quality.ok, true);
    assert.strictEqual(quality.coverage, 1);
  });
});

describe('BUG 2 - barre 5m incomplete non scartano il feed', () => {
  it('una barra con campi null viene esclusa dal calcolo e contata in nullFields', () => {
    const bars = usSeries(20, (i) =>
      i === 5 ? { high: null, low: null, close: null, volume: null } : {}
    );
    const dq = computeVwapDataQuality(bars, { currentPrice: 100.5, vwap: null }, 'US', etInstant(670));
    assert.strictEqual(dq.ok, true, `atteso feed accettato, ricevuto ${dq.reason}`);
    assert.strictEqual(dq.reason, null);
    assert.strictEqual(dq.nullFields, 1);
    assert.strictEqual(dq.coverage, 0.95);
  });

  it('nessuna barra utilizzabile -> resta NON_FINITE', () => {
    const bars = usSeries(6, () => ({ high: null, low: null, close: null, volume: null }));
    const dq = computeVwapDataQuality(bars, { currentPrice: 100.5, vwap: null }, 'US', etInstant(600));
    assert.strictEqual(dq.ok, false);
    assert.strictEqual(dq.reason, 'NON_FINITE');
    assert.strictEqual(dq.nullFields, 6);
  });
});

describe('BUG 3 - badge Header dopo le 16:05 ET', () => {
  it('usSessionLabel: 16:04 ET live, 16:06 ET post-market, 23:00 ET chiuso', () => {
    assert.strictEqual(usSessionLabel('OPEN_LIVE', 964), 'Aperto');
    assert.strictEqual(usSessionLabel('CLOSED', 966), 'Post-Mkt');
    assert.strictEqual(usSessionLabel('CLOSED', 1000), 'Post-Mkt');
    assert.strictEqual(usSessionLabel('CLOSED', 1380), 'Chiuso');
    assert.strictEqual(usSessionLabel('PRE_MARKET', 480), 'Pre-Mkt');
  });

  it('Header (sessione GLOBAL) alle 16:10 ET non mostra "Pre-Mkt" per gli USA', () => {
    const sessionInfo = {
      cet: {
        formatted: '22:10:00 CET',
        date: SESSION_DATE,
        hour: 22,
        minute: 10,
        dayOfWeek: 'Giovedì',
        isWeekend: false,
        isEuropeWindow: false,
        isUSAWindow: false,
        isEuropeLive: false,
        isUSAPreMarket: false,
        isUSALive: false,
        marketStatusEU: 'CLOSED',
        marketStatusUS: 'CLOSED',
        currentMinutes: 1330,
        usMinutes: 970, // 16:10 ET
      },
    } as unknown as SessionInfo;

    const html = renderToStaticMarkup(
      React.createElement(Header, {
        sessionInfo,
        onOpenCsvManager: () => {},
        underlyingsCount: 0,
        isPaperMode: true,
        onTogglePaperMode: () => {},
        tradesTodayCount: 0,
        dailyPnlPercent: 0,
        isCircuitBreakerActive: false,
        onResetCache: () => {},
        currentSession: 'GLOBAL' as const,
      })
    );

    assert.ok(html.includes('Post-Mkt'), `atteso "Post-Mkt" nel badge, html: ${html}`);
    assert.ok(!html.includes('Pre-Mkt'), `il badge non deve mostrare "Pre-Mkt", html: ${html}`);
  });
});

describe('Gate G2 sul caso NVDA 05/11/2026', () => {
  it('il motivo di esclusione restituito dal codice e\' DATI INSUFFICIENTI o LOW_COVERAGE', () => {
    // Feed NVDA al cutoff 09:45 ET: barre complete, ma senza Liq€20d (non ricavabile dal feed barre).
    const quality = computeVwapDataQuality(
      NVDA_BARS,
      { currentPrice: 192.08, vwap: null },
      'US',
      etInstant(585)
    );
    const quote = {
      ticker: 'NVDA',
      name: 'NVIDIA Corporation',
      market: 'US',
      currency: 'USD',
      prevClose: 195.0,
      currentPrice: 192.08,
      preMarketPrice: null,
      prevHigh: 196.5,
      prevLow: 192.0,
      preMarketHigh: null,
      preMarketLow: null,
      todayOpen: 195.1,
      todayHigh: 196.225,
      todayLow: 191.51,
      vwap: quality.ok ? 192.9187 : null,
      vwapDataQuality: quality,
      avgVolume20d: 20000000,
      preMarketVolume: 0,
      atr14: 5.2,
      adr14: 6.1,
      liqEur20d: null, // assente -> il gate dati non puo' essere soddisfatto
      orbHigh: 196.225,
      orbLow: 193.62,
      completedBarsCount: 3,
      gapPercent: -1.5,
      rvol: 1.4,
      timestamp: etInstant(585).toISOString(),
      source: 'yahoo',
    } as unknown as RawQuoteData;

    const candidate = {
      quote,
      score: { total: 65 },
      rank: 1,
    } as unknown as ScoredCandidate;

    const setup = buildExecutionSetup(candidate, null, 'US', undefined, {
      currentTime: etInstant(585),
    });

    // Il motivo non va dedotto dal codice: si legge il valore restituito.
    // eslint-disable-next-line no-console
    console.log(`[gate] block=${setup.blockedGate} reason=${setup.reasonNoTrade}`);
    assert.strictEqual(setup.decision, 'NESSUN_TRADE');
    assert.ok(setup.blockedGate, 'atteso un gate bloccante');
    assert.ok(
      setup.reasonNoTrade === 'DATI INSUFFICIENTI' || setup.reasonNoTrade === 'LOW_COVERAGE',
      `motivo inatteso: ${setup.reasonNoTrade}`
    );
    assert.strictEqual(quality.ok, true, 'le 3 barre complete devono passare il quality gate');
  });
});
