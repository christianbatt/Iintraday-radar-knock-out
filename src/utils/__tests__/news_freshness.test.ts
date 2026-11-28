/**
 * Test della freschezza delle notizie e del tetto del bonus (P11).
 *
 * Tutto puro: `nowMs` iniettato, nessuna rete, nessun file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRelevantFreshNews,
  formatNewsAge,
  hasNewsWithinHours,
  isIntradayMovingHeadline,
  mergeNewsByRecency,
  NEWS_BONUS_CEILING,
  NEWS_INTRADAY_AGE_HOURS,
  NEWS_MAX_AGE_HOURS,
  NEWS_TODAY_AGE_HOURS,
  newsAgeHours,
  newsBonusPolicy,
  newsRecencyBand,
} from '../newsFilter';

const NOW = Date.parse('2026-11-28T10:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function item(over: Record<string, unknown> = {}) {
  return {
    title: 'Intesa Sanpaolo: upgrade a buy da Deutsche Bank',
    summary: 'Prezzo obiettivo alzato a 5,20 euro.',
    source: 'Reuters',
    url: 'https://example.com/a',
    publishedAt: hoursAgo(2),
    ...over,
  };
}

test('P11 freschezza: le bande hanno bordi inclusivi e dichiarati', () => {
  assert.equal(newsRecencyBand(0), 'intraday');
  assert.equal(newsRecencyBand(NEWS_INTRADAY_AGE_HOURS), 'intraday');
  assert.equal(newsRecencyBand(NEWS_INTRADAY_AGE_HOURS + 0.01), 'today');
  assert.equal(newsRecencyBand(NEWS_TODAY_AGE_HOURS), 'today');
  assert.equal(newsRecencyBand(NEWS_TODAY_AGE_HOURS + 0.01), 'recent');
  assert.equal(newsRecencyBand(NEWS_MAX_AGE_HOURS), 'recent');
  assert.equal(newsRecencyBand(NEWS_MAX_AGE_HOURS + 0.01), 'stale');
  assert.equal(newsRecencyBand(Number.POSITIVE_INFINITY), 'stale');
});

test('P11 eta: etichetta leggibile e null senza data', () => {
  assert.equal(newsAgeHours({ title: 'x' }, NOW), null);
  assert.equal(newsAgeHours({ title: 'x', publishedAt: 'non una data' }, NOW), null);
  assert.equal(formatNewsAge(null), 'età non dichiarata');
  assert.equal(formatNewsAge(0.5), '30 min');
  assert.equal(formatNewsAge(2.44), '2,4h');
  assert.equal(formatNewsAge(60), '2,5 giorni');
});

test('P11 importanza: solo gli eventi che muovono il prezzo contano', () => {
  assert.equal(isIntradayMovingHeadline(item()), true);
  assert.equal(isIntradayMovingHeadline(item({ title: 'Leonardo si aggiudica una commessa da 200 mln', summary: '' })), true);
  assert.equal(isIntradayMovingHeadline(item({ title: 'Stellantis alza la guidance 2026', summary: '' })), true);
  assert.equal(isIntradayMovingHeadline(item({ title: 'Banca, indagine della Consob sul titolo', summary: '' })), true);
  // Contesto, non catalizzatore.
  assert.equal(isIntradayMovingHeadline(item({ title: 'Rassegna stampa: i titoli da seguire oggi', summary: '' })), false);
  assert.equal(isIntradayMovingHeadline(item({ title: 'Analisi tecnica: Enel sopra la media mobile', summary: '' })), false);
  assert.equal(isIntradayMovingHeadline(null), false);
});

test('P11 tetto del bonus: decide eta e importanza, non la buona volonta del modello', () => {
  // Evento rilevante entro 6h: tetto pieno.
  const fresh = newsBonusPolicy([item()], NOW);
  assert.equal(fresh.ceiling, NEWS_BONUS_CEILING.intradayMover);
  assert.equal(fresh.hasIntradayMover, true);
  assert.equal(fresh.hasPrimaryWire, true);

  // Evento rilevante di oggi (8h): alto ma non pieno.
  assert.equal(newsBonusPolicy([item({ publishedAt: hoursAgo(8) })], NOW).ceiling, NEWS_BONUS_CEILING.todayMover);

  // Notizia fresca senza evento: solo contesto.
  const context = newsBonusPolicy([item({ title: 'Enel: presentazione della nuova campagna', summary: '' })], NOW);
  assert.equal(context.ceiling, NEWS_BONUS_CEILING.intradayContext);
  assert.equal(context.hasIntradayMover, false);

  // Notizia di oggi senza evento.
  const todayContext = newsBonusPolicy(
    [item({ title: 'Enel: presentazione della nuova campagna', summary: '', publishedAt: hoursAgo(20) })],
    NOW
  );
  assert.equal(todayContext.ceiling, NEWS_BONUS_CEILING.todayContext);

  // Solo notizie vecchie (30h e 60h): la notizia non e' piu' un catalizzatore.
  const stale = newsBonusPolicy(
    [item({ publishedAt: hoursAgo(30) }), item({ title: 'Enel: commessa', publishedAt: hoursAgo(60) })],
    NOW
  );
  assert.equal(stale.ceiling, 0, 'un evento vecchio non deve poter muovere il punteggio');
  assert.equal(stale.bandCounts.recent, 2);
  assert.equal(stale.freshestAgeHours, 30);

  // Pool vuoto: tetto 0, nessuna eccezione.
  const empty = newsBonusPolicy([], NOW);
  assert.equal(empty.ceiling, 0);
  assert.equal(empty.freshestAgeHours, null);
});

test('P11 tetto del bonus: un articolo vecchio non alza il tetto di uno fresco', () => {
  const mixed = newsBonusPolicy(
    [item({ publishedAt: hoursAgo(40) }), item({ publishedAt: hoursAgo(1) })],
    NOW
  );
  assert.equal(mixed.ceiling, NEWS_BONUS_CEILING.intradayMover);
  assert.equal(mixed.freshestAgeHours, 1);
  assert.equal(mixed.bandCounts.recent, 1);
  assert.equal(mixed.bandCounts.intraday, 1);
});

test('P11 pool di notizie: il filtro tiene solo notizie pertinenti e non future', () => {
  const pool = filterRelevantFreshNews(
    [
      item(),
      item({ title: 'Apple presenta il nuovo iPhone', publishedAt: hoursAgo(1) }),
      item({ title: 'Intesa Sanpaolo: upgrade a buy da Deutsche Bank', publishedAt: hoursAgo(100) }),
    ],
    'ISP.MI',
    'Intesa Sanpaolo',
    NOW,
    72
  );
  assert.equal(pool.fresh.length, 1);
  assert.equal(pool.offTickerCount, 1);
  assert.equal(pool.staleCount, 1);
});

test('P11 merge: tiene la piu fresca per titolo e mette in cima le nuove', () => {
  const merged = mergeNewsByRecency(
    [item({ publishedAt: hoursAgo(20) })],
    [
      item({ publishedAt: hoursAgo(1) }),
      item({ title: 'Leonardo: commessa da 200 mln', summary: '', publishedAt: hoursAgo(3) }),
    ],
    5
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].publishedAt, hoursAgo(1));
  assert.equal(merged[1].publishedAt, hoursAgo(3));

  // Duplicato con data piu' fresca: vince la piu' fresca, una sola riga.
  const dedup = mergeNewsByRecency(
    [item({ publishedAt: hoursAgo(20) })],
    [item({ publishedAt: hoursAgo(2) })],
    5
  );
  assert.equal(dedup.length, 1);
  assert.equal(dedup[0].publishedAt, hoursAgo(2));

  // Il limite si applica dopo l'ordinamento.
  const limited = mergeNewsByRecency([], [item(), item({ title: 'Altro', summary: '' })], 1);
  assert.equal(limited.length, 1);
});

test('P11 merge e freschezza: il pool si arricchisce quando quello esistente e vecchio', () => {
  const stalePool = [item({ publishedAt: hoursAgo(30) })];
  assert.equal(hasNewsWithinHours(stalePool, NOW, NEWS_TODAY_AGE_HOURS), false);
  const enriched = mergeNewsByRecency(stalePool, [item({ publishedAt: hoursAgo(2) })], 5);
  assert.equal(hasNewsWithinHours(enriched, NOW, NEWS_TODAY_AGE_HOURS), true);
  // Il vecchio resta nel pool (e' contesto), ma non e' quello che decide il tetto.
  assert.equal(newsBonusPolicy(enriched, NOW).freshestAgeHours, 2);
});
