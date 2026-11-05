/**
 * Caratterizzazione del filtro contrarian sul bonus notizie (calculateCandidateScore).
 *
 * Fissa gli output attuali per i candidati coinvolti dal filtro: punteggio totale,
 * bonus notizie e riduzione del bonus quando la direzione del catalizzatore e'
 * contraria all'azione di prezzo. Serve come rete di sicurezza prima di passare
 * il filtro da quote.vwap a quote.vwapCumulative.
 *
 * Esecuzione: npx tsx src/utils/__tests__/contrarian_vwap.test.ts
 * Modalita' stampa baseline: CHAR_BASELINE=print npx tsx src/utils/__tests__/contrarian_vwap.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { calculateCandidateScore } from '../calculator';
import { RawQuoteData } from '../../types/radar';

const baseQuote = (over: Partial<RawQuoteData> = {}): RawQuoteData =>
  ({
    ticker: 'AAPL',
    name: 'Apple Inc.',
    market: 'US',
    currency: 'USD',
    prevClose: 100,
    currentPrice: 103,
    preMarketPrice: null,
    prevHigh: 99,
    prevLow: 95,
    preMarketHigh: null,
    preMarketLow: null,
    todayOpen: 101,
    todayHigh: 104,
    todayLow: 100,
    vwap: 102,
    ema20Daily: 98,
    avgVolume20d: 5_000_000,
    preMarketVolume: 100_000,
    atr14: 2,
    gapPercent: 1.0,
    rvol: 1.6,
    rsi5m: 55,
    rsi14: 55,
    orderFlow: null,
    timestamp: new Date().toISOString(),
    source: 'test',
    ...over,
  } as RawQuoteData);

const catalyst = (direzione: 'LONG' | 'SHORT', newsBonusScore = 12) =>
  ({ direzione, newsBonusScore } as unknown as Parameters<typeof calculateCandidateScore>[2]);

interface Case {
  name: string;
  q: RawQuoteData;
  c: Parameters<typeof calculateCandidateScore>[2];
}

const CASES: Case[] = [
  {
    // Catalizzatore LONG, gap negativo: contrarian per gap sia prima sia dopo.
    name: 'A_LONG_GAP_NEGATIVO',
    q: baseQuote({ ticker: 'A', gapPercent: -0.5, currentPrice: 103, vwap: 102, vwapCumulative: 104.5 }),
    c: catalyst('LONG'),
  },
  {
    // Catalizzatore LONG: prezzo sotto la VWAP "classica" (typical price), sopra la cumulativa.
    name: 'B_LONG_VWAP_CLASSICA_CONTRARIA',
    q: baseQuote({ ticker: 'B', gapPercent: 0.2, currentPrice: 100, vwap: 101, vwapCumulative: 99.5 }),
    c: catalyst('LONG'),
  },
  {
    // Catalizzatore LONG: prezzo sopra la VWAP "classica", sotto la cumulativa.
    name: 'C_LONG_VWAP_CUMULATIVA_CONTRARIA',
    q: baseQuote({ ticker: 'C', gapPercent: 0.2, currentPrice: 100, vwap: 98, vwapCumulative: 101 }),
    c: catalyst('LONG'),
  },
  {
    // Catalizzatore SHORT: prezzo sotto la VWAP "classica", sopra la cumulativa.
    name: 'D_SHORT_VWAP_CUMULATIVA_CONTRARIA',
    q: baseQuote({ ticker: 'D', gapPercent: -0.2, currentPrice: 100, vwap: 102, vwapCumulative: 98.5 }),
    c: catalyst('SHORT'),
  },
  {
    // Nessuna VWAP cumulativa: il filtro deve usare il fallback su quote.vwap.
    name: 'E_SENZA_CUMULATIVA_FALLBACK',
    q: baseQuote({ ticker: 'E', gapPercent: 0.2, currentPrice: 100, vwap: 101, vwapCumulative: null }),
    c: catalyst('LONG'),
  },
  {
    // Catalizzatore SHORT: prezzo sopra la VWAP "classica", sotto la cumulativa.
    name: 'F_SHORT_VWAP_CLASSICA_CONTRARIA',
    q: baseQuote({ ticker: 'F', gapPercent: -0.2, currentPrice: 100, vwap: 98, vwapCumulative: 101.5 }),
    c: catalyst('SHORT'),
  },
];

interface Snapshot {
  total: number;
  newsScore: number;
  contrarianReduced: boolean;
  reducedTo: number | null;
}

function snapshot(c: Case): Snapshot {
  const s = calculateCandidateScore(c.q, 0.3, c.c);
  const reducedLine = s.details.find((d) => d.includes('bonus ridotto a'));
  return {
    total: s.total,
    newsScore: s.newsScore ?? 0,
    contrarianReduced: Boolean(reducedLine),
    reducedTo: reducedLine ? Number(/bonus ridotto a (\d+)pt/.exec(reducedLine)![1]) : null,
  };
}

// Valori fissati sul codice PRIMA della modifica del filtro (commit di caratterizzazione).
const BASELINE: Record<string, Snapshot> = {
  // A/E invariati: il gap negativo (A) e il fallback su quote.vwap (E) restano contrarian.
  A_LONG_GAP_NEGATIVO: { total: 34, newsScore: 2, contrarianReduced: true, reducedTo: 3 },
  // Delta accettato (vwapCumulative): sopra la VWAP di sessione -> catalizzatore LONG non piu' contrarian.
  B_LONG_VWAP_CLASSICA_CONTRARIA: { total: 38, newsScore: 8, contrarianReduced: false, reducedTo: null },
  // Delta accettato (vwapCumulative): sotto la VWAP di sessione -> catalizzatore LONG ora contrarian.
  C_LONG_VWAP_CUMULATIVA_CONTRARIA: { total: 32, newsScore: 2, contrarianReduced: true, reducedTo: 3 },
  // Delta accettato (vwapCumulative): sopra la VWAP di sessione -> catalizzatore SHORT ora contrarian.
  D_SHORT_VWAP_CUMULATIVA_CONTRARIA: { total: 19, newsScore: 2, contrarianReduced: true, reducedTo: 3 },
  E_SENZA_CUMULATIVA_FALLBACK: { total: 32, newsScore: 2, contrarianReduced: true, reducedTo: 3 },
  // Delta accettato (vwapCumulative): sotto la VWAP di sessione -> catalizzatore SHORT non piu' contrarian.
  F_SHORT_VWAP_CLASSICA_CONTRARIA: { total: 25, newsScore: 8, contrarianReduced: false, reducedTo: null },
};

describe('Filtro contrarian - caratterizzazione', () => {
  it('fissa punteggio, bonus notizie ed esito del filtro per ogni candidato', () => {
    const actual: Record<string, Snapshot> = {};
    for (const c of CASES) actual[c.name] = snapshot(c);

    console.log(JSON.stringify(actual, null, 2));

    if (process.env.CHAR_BASELINE === 'print') return;
    for (const name of Object.keys(actual)) {
      assert.deepStrictEqual(actual[name], BASELINE[name], `baseline diversa per ${name}`);
    }
  });
});
