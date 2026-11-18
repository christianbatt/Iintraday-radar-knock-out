import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DEFAULT_SYSTEM_PARAMETERS,
  getDualTopCandidates,
  scoreAllRadarCandidates,
} from '../calculator';
import { TopCandidatesTable } from '../../components/TopCandidatesTable';
import { DEFAULT_TRADE_REPUBLIC_UNDERLYINGS } from '../../data/defaultUnderlyings';
import type { RawQuoteData, SetupIndicators, VwapSignalState } from '../../types/radar';

const okIndicators = (dir: 1 | -1 = 1, adxVal = 24): SetupIndicators => ({
  barsUsed: 90,
  rangeUsed: '5d',
  priorSessionsUsed: 1,
  atr: { value: 0.6, status: 'OK', reason: null },
  supertrend: { status: 'OK', reason: null, direction: dir, barsSinceFlip: 2, value: 98 },
  adx: {
    status: 'OK',
    reason: null,
    value: adxVal,
    plusDI: dir === 1 ? 28 : 12,
    minusDI: dir === 1 ? 12 : 28,
  },
  stochRsi: {
    status: 'OK',
    reason: null,
    k: dir === 1 ? 42 : 58,
    d: dir === 1 ? 35 : 65,
    lastCross: dir === 1 ? 'LONG' : 'SHORT',
    barsSinceCross: 1,
  },
  psar: { status: 'OK', reason: null, value: 97, direction: dir, barsSinceFlip: 2 },
  adxThreshold: { min: 16, strong: 20 },
});

const vwapAligned: VwapSignalState = {
  state: 'ABOVE',
  distAtr: 0.4,
  slopeAtr: 0.2,
  coverage: 1,
  volumeRatio: 1.8,
  flags: [],
  vwapLevel: 100,
};

function makeQuote(
  ticker: string,
  name: string,
  market: 'EU' | 'US',
  currency: string,
  mode: 'ELIGIBLE' | 'ST_OPPOSED' | 'ADX_LOW'
): RawQuoteData {
  const setupIndicators =
    mode === 'ST_OPPOSED'
      ? okIndicators(-1, 26)
      : mode === 'ADX_LOW'
      ? okIndicators(1, 11)
      : okIndicators(1, 25);

  return {
    ticker,
    name,
    market,
    currency,
    currentPrice: 102,
    preMarketPrice: 102,
    prevClose: 100,
    prevHigh: 101,
    prevLow: 98,
    preMarketHigh: 102.5,
    preMarketLow: 100.5,
    avgVolume20d: 1_500_000,
    preMarketVolume: 200_000,
    atr14: 2.2,
    gapPercent: 2.0,
    rvol: 1.8,
    rsi14: 55,
    rsi5m: 56,
    liqEur20d: 10_000_000,
    setupIndicators,
    vwapState: vwapAligned,
    timestamp: new Date().toISOString(),
    source: 'test',
  };
}

describe('Visibilita completa paniere (40 titoli) in Live Radar', () => {
  it('mantiene tutti i 40 titoli visibili nel radar ordinando gli idonei prima dei titoli con veto, senza alterare getDualTopCandidates', () => {
    // 17 idonei (9 EU + 8 US) + 23 con veto (11 EU + 12 US) = 40 titoli totali
    let euIdx = 0;
    let usIdx = 0;
    const quotes: RawQuoteData[] = DEFAULT_TRADE_REPUBLIC_UNDERLYINGS.map((u, idx) => {
      const isEligible = u.mercato === 'EU' ? euIdx++ < 9 : usIdx++ < 8;
      const mode = isEligible
        ? 'ELIGIBLE'
        : idx % 2 === 0
        ? 'ST_OPPOSED'
        : 'ADX_LOW';
      return makeQuote(u.ticker, u.nome, u.mercato, u.valuta, mode);
    });

    const dual = getDualTopCandidates(
      quotes,
      { EU: 0.4, US: 0.4 },
      { parameters: DEFAULT_SYSTEM_PARAMETERS }
    );
    assert.equal(dual.allRanked.length, 17, 'allRanked deve restare strettamente filtrato senza veti');
    assert.ok(dual.topEU && dual.topEU.score.veto == null, 'topEU mai con veto');
    assert.ok(dual.topUS && dual.topUS.score.veto == null, 'topUS mai con veto');

    const radarAll = scoreAllRadarCandidates(
      quotes,
      { EU: 0.4, US: 0.4 },
      { parameters: DEFAULT_SYSTEM_PARAMETERS }
    );
    assert.equal(radarAll.length, 40, 'scoreAllRadarCandidates deve restituire tutti i 40 titoli');

    const eligibleCount = radarAll.filter((c) => c.score.veto == null).length;
    const vetoedCount = radarAll.filter((c) => c.score.veto != null).length;
    assert.equal(eligibleCount, 17);
    assert.equal(vetoedCount, 23);

    // Tutti i primi 17 sono senza veto; gli ultimi 23 hanno veto
    assert.ok(radarAll.slice(0, 17).every((c) => c.score.veto == null));
    assert.ok(radarAll.slice(17).every((c) => c.score.veto != null));

    // TopCandidatesTable mostra Tutti i Titoli (40), Idonei (17), Con Veto (23) e blocca i veto
    const html = renderToStaticMarkup(
      React.createElement(TopCandidatesTable, {
        candidates: radarAll,
        selectedCandidate: dual.topEU,
        onSelectCandidate: () => {},
        onViewCatalyst: () => {},
        isLoadingNewsFor: null,
        topEU: dual.topEU,
        topUS: dual.topUS,
      })
    );

    assert.ok(html.includes('Tutti i Titoli (40)'), 'contatore Tutti i Titoli (40) mancante');
    assert.ok(html.includes('(17)'), 'contatore Idonei (17) mancante');
    assert.ok(html.includes('(23)'), 'contatore Con Veto (23) mancante');
    assert.ok(html.includes('VETO ATTIVO'), 'badge VETO ATTIVO mancante per i titoli bloccati');
    assert.ok(html.includes('Bloccato'), 'pulsante Carica Setup disabilitato (Bloccato) mancante');
  });
});

console.log('ALL RADAR VISIBILITY TESTS PASS!');
