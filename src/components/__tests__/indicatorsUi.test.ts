import { describe, it } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IndicatorBadges, ScoreBreakdownPanel } from '../IndicatorsPanel';
import { TRADING_PARAMS } from '../../config/tradingParams';
import type { ScoreBreakdown, SetupIndicators } from '../../types/radar';

const P = TRADING_PARAMS;

const indicators = (direction: 1 | -1 = 1): SetupIndicators => ({
  barsUsed: 104,
  rangeUsed: '5d',
  priorSessionsUsed: 1,
  atr: { value: 0.4, status: 'OK', reason: null },
  supertrend: { status: 'OK', reason: null, direction, barsSinceFlip: 2, value: 97.5 },
  adx: {
    status: 'OK',
    reason: null,
    value: 17,
    plusDI: direction === 1 ? 30 : 10,
    minusDI: direction === 1 ? 10 : 30,
  },
  stochRsi: {
    status: 'OK',
    reason: null,
    k: direction === 1 ? 40 : 60,
    d: direction === 1 ? 35 : 65,
    lastCross: direction === 1 ? 'LONG' : 'SHORT',
    barsSinceCross: 1,
  },
  psar: { status: 'OK', reason: null, value: 96.8, direction, barsSinceFlip: 3 },
  adxThreshold: { min: 16, strong: 20 },
});

const unknownIndicators = (): SetupIndicators => ({
  barsUsed: 4,
  rangeUsed: '1mo',
  priorSessionsUsed: 0,
  atr: { value: null, status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS' },
  supertrend: { status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS', direction: 0, barsSinceFlip: null, value: null },
  adx: { status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS', value: null, plusDI: null, minusDI: null },
  stochRsi: {
    status: 'UNKNOWN',
    reason: 'INSUFFICIENT_BARS',
    k: null,
    d: null,
    lastCross: 'NONE',
    barsSinceCross: null,
  },
  psar: { status: 'UNKNOWN', reason: 'INSUFFICIENT_BARS', value: null, direction: 0, barsSinceFlip: null },
  adxThreshold: { min: 20, strong: 25 },
});

const breakdown = (total: number): ScoreBreakdown => ({
  gapScore: 0,
  rvolScore: 0,
  liquidityScore: 0,
  futuresScore: 0,
  levelScore: 0,
  total,
  details: [],
  scoreBreakdown: {
    gap: 12,
    rvol: 14,
    vwap: 10,
    supertrend: 12,
    adx: 4,
    stochRsi: 9,
    psar: 0,
    levels: 6,
    futures: 12,
    news: 0,
    orderFlow: 8,
    liquidity: 0,
    rsi: 0,
    trend: 0,
  },
});

const vwapState = (direction: 1 | -1) =>
  direction === 1
    ? { state: 'ABOVE' as const, distAtr: 0.5, slopeAtr: 0.2, coverage: 1, volumeRatio: 2.1, flags: [], vwapLevel: 102 }
    : { state: 'BELOW' as const, distAtr: -0.5, slopeAtr: -0.2, coverage: 1, volumeRatio: 2.1, flags: [], vwapLevel: 98 };

const render = (element: React.ReactElement): string => renderToStaticMarkup(element);

describe('Indicatori in UI: rendering da fixture, nessuna rete', () => {
  it('U1: candidato long con indicatori OK mostra VWAP, Supertrend, ADX con soglie, StochRSI e PSAR', () => {
    const html = render(
      React.createElement(IndicatorBadges, {
        indicators: indicators(1),
        vwapState: vwapState(1),
        direction: 'LONG',
      })
    );
    assert.ok(html.includes('VWAP'), 'VWAP mancante');
    assert.ok(html.includes('ABOVE'), 'stato VWAP mancante');
    assert.ok(html.includes('0.50 ATR'), 'distanza ATR mancante');
    assert.ok(html.includes('LONG'), 'direzione mancante');
    assert.ok(html.includes('ADX'), 'ADX mancante');
    assert.ok(html.includes('17.0'), 'valore ADX mancante');
    assert.ok(html.includes('soglia 16/20'), 'soglie ADX dal payload mancanti');
    assert.ok(html.includes('K 40/D 35'), 'Stoch RSI mancante');
    assert.ok(html.includes('PSAR'), 'PSAR mancante');
    assert.ok(!html.includes('n.d.'), 'nessun valore dovrebbe essere n.d.');
  });

  it('U2: candidato short mostra la direzione short e il VWAP sotto', () => {
    const html = render(
      React.createElement(IndicatorBadges, {
        indicators: indicators(-1),
        vwapState: vwapState(-1),
        direction: 'SHORT',
      })
    );
    assert.ok(html.includes('SHORT'));
    assert.ok(html.includes('BELOW'));
    assert.ok(html.includes('-0.50 ATR'));
  });

  it('U3: indicatori UNKNOWN -> tutti n.d. in grigio con tooltip dato assente', () => {
    const html = render(React.createElement(IndicatorBadges, { indicators: unknownIndicators() }));
    const count = (html.match(/n\.d\./g) ?? []).length;
    assert.ok(count >= 5, `n.d. presenti: ${count}`);
    assert.ok(html.includes('dato assente'), 'tooltip dato assente mancante');
    assert.ok(!html.includes('text-rose-300'), 'UNKNOWN non deve essere rosso');
  });

  it('U4: veto ADX_BELOW_MARKET_THRESHOLD -> etichetta italiana in badge', () => {
    const html = render(
      React.createElement(IndicatorBadges, {
        indicators: indicators(1),
        vwapState: vwapState(1),
        veto: 'ADX_BELOW_MARKET_THRESHOLD',
      })
    );
    assert.ok(html.includes('VETO'));
    assert.ok(html.includes('ADX sotto la soglia del mercato'));
  });

  it('U5: veto SUPERTREND_OPPOSED -> etichetta italiana in badge', () => {
    const html = render(
      React.createElement(IndicatorBadges, {
        indicators: indicators(-1),
        vwapState: vwapState(1),
        veto: 'SUPERTREND_OPPOSED',
      })
    );
    assert.ok(html.includes('Supertrend contrario al setup'));
  });

  it('U6: WARMUP_INCOMPLETE -> badge dedicato', () => {
    const html = render(
      React.createElement(IndicatorBadges, { indicators: unknownIndicators(), warmupIncomplete: true })
    );
    assert.ok(html.includes('WARMUP incompleto'));
    assert.ok(html.includes('non raccomandabile'));
  });

  it('U7: pannello score mostra punti/max per componente e totale', () => {
    const html = render(React.createElement(ScoreBreakdownPanel, { score: breakdown(87) }));
    assert.ok(html.includes('87/100'), 'totale mancante');
    assert.ok(html.includes('Supertrend'), 'componente supertrend mancante');
    assert.ok(html.includes(`${12}/${P.W_SUPERTREND}`), 'punti/max supertrend mancanti');
    assert.ok(html.includes(`${4}/${P.W_ADX}`), 'punti/max ADX mancanti');
    assert.ok(html.includes('VWAP'), 'componente VWAP mancante');
  });

  it('U8: pannello score con veto e warmup incompleto mostra le etichette italiane', () => {
    const score = { ...breakdown(0), veto: 'VWAP_OPPOSED' as const, warmupIncomplete: true };
    const html = render(React.createElement(ScoreBreakdownPanel, { score }));
    assert.ok(html.includes('VETO'));
    assert.ok(html.includes('VWAP contraria'));
    assert.ok(html.includes('WARMUP incompleto'));
  });
});

console.log('ALL INDICATORS UI TESTS PASS!');
