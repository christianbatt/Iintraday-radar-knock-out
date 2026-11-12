/**
 * G13 — checkQuoteStaleness con e senza tempo di mercato (Passo H-bis / I2b).
 *
 * Con `useMarketTs` assente o false il comportamento deve restare quello
 * storico: si legge `quote.timestamp`. Con `useMarketTs: true` si legge
 * `quote.marketTs`; se manca, fallback su `quote.timestamp`.
 *
 * Runner: npx tsx src/utils/__tests__/g13_market_ts.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuoteStaleness } from '../calculator';
import type { RawQuoteData } from '../../types/radar';

const NOW = new Date('2026-11-11T16:40:00Z');
const respTs = '2026-11-11T16:39:55Z'; // risposta del server: 5s fa
const marketTs = Math.floor(new Date('2026-11-11T16:20:00Z').getTime() / 1000); // 20 min fa

function quote(over: Partial<RawQuoteData> = {}): RawQuoteData {
  return {
    ticker: 'ENI.MI',
    name: 'Eni',
    market: 'EU',
    currency: 'EUR',
    timestamp: respTs,
    source: 'test',
    ...over,
  } as RawQuoteData;
}

describe('checkQuoteStaleness', () => {
  it('senza useMarketTs ignora marketTs (comportamento storico)', () => {
    const r = checkQuoteStaleness(quote({ marketTs }), NOW);
    assert.equal(r.isStale, false);
    assert.ok(r.minutesDelay !== null && r.minutesDelay < 0.2, `delay ${r.minutesDelay}`);
  });

  it('useMarketTs false ignora marketTs', () => {
    const r = checkQuoteStaleness(quote({ marketTs }), NOW, { useMarketTs: false });
    assert.equal(r.isStale, false);
  });

  it('useMarketTs true legge marketTs e fa scattare il gate', () => {
    const r = checkQuoteStaleness(quote({ marketTs }), NOW, { useMarketTs: true });
    assert.equal(r.isStale, true);
    assert.ok(r.minutesDelay !== null && Math.abs(r.minutesDelay - 20) < 0.2, `delay ${r.minutesDelay}`);
    assert.match(String(r.warning), /ritardo/i);
  });

  it('useMarketTs true con marketTs null fa fallback sul timestamp', () => {
    const r = checkQuoteStaleness(quote({ marketTs: null }), NOW, { useMarketTs: true });
    assert.equal(r.isStale, false);
    const missing = checkQuoteStaleness(quote({ marketTs: null, timestamp: '' }), NOW, {
      useMarketTs: true,
    });
    assert.equal(missing.isStale, true);
    assert.match(String(missing.warning), /Timestamp assente/);
  });

  it('marketTs non finito non viene usato', () => {
    const r = checkQuoteStaleness(quote({ marketTs: Number.NaN }), NOW, { useMarketTs: true });
    assert.equal(r.isStale, false);
  });
});
