/**
 * Test di `sessionCloseMsFor` / `sessionDateFor`.
 *
 * I valori attesi sono costanti UTC scritte a mano (orario di chiusura + offset
 * noto della data), non ricavati dalla funzione sotto test. EU chiude alle 17:30
 * Europe/Rome, US alle 16:00 America/New_York.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getSessionSchedule, sessionCloseMsFor, sessionDateFor } from '../sessionClose';

/** Costante UTC esplicita: `YYYY-MM-DDTHH:MM` in UTC, indipendente da Intl. */
const utc = (y: number, mo: number, d: number, h: number, mi: number): number =>
  Date.UTC(y, mo - 1, d, h, mi, 0);

describe('sessionClose — EU con ora legale (CET +60 / CEST +120)', () => {
  it('2026-03-27 (CET) chiude 17:30 Rome = 16:30 UTC', () => {
    assert.equal(sessionCloseMsFor('EU', '2026-03-27'), utc(2026, 3, 27, 16, 30));
  });

  it('2026-03-30 (CEST, dopo il cambio del 29/03) chiude 17:30 Rome = 15:30 UTC', () => {
    assert.equal(sessionCloseMsFor('EU', '2026-03-30'), utc(2026, 3, 30, 15, 30));
  });

  it('2026-10-23 (CEST) chiude 17:30 Rome = 15:30 UTC', () => {
    assert.equal(sessionCloseMsFor('EU', '2026-10-23'), utc(2026, 10, 23, 15, 30));
  });

  it('2026-10-26 (CET, dopo il ritorno del 25/10) chiude 17:30 Rome = 16:30 UTC', () => {
    assert.equal(sessionCloseMsFor('EU', '2026-10-26'), utc(2026, 10, 26, 16, 30));
  });
});

describe('sessionClose — US con ora legale (EST -300 / EDT -240)', () => {
  it('2026-03-06 (EST) chiude 16:00 NY = 21:00 UTC', () => {
    assert.equal(sessionCloseMsFor('US', '2026-03-06'), utc(2026, 3, 6, 21, 0));
  });

  it('2026-03-09 (EDT, dopo il cambio dell\'08/03) chiude 16:00 NY = 20:00 UTC', () => {
    assert.equal(sessionCloseMsFor('US', '2026-03-09'), utc(2026, 3, 9, 20, 0));
  });

  it('2026-10-30 (EDT) chiude 16:00 NY = 20:00 UTC', () => {
    assert.equal(sessionCloseMsFor('US', '2026-10-30'), utc(2026, 10, 30, 20, 0));
  });

  it('2026-11-02 (EST, dopo il ritorno del 01/11) chiude 16:00 NY = 21:00 UTC', () => {
    assert.equal(sessionCloseMsFor('US', '2026-11-02'), utc(2026, 11, 2, 21, 0));
  });
});

describe('sessionClose — sfasamento EU/US (cambi in date diverse)', () => {
  it('2026-03-16: EU ancora CET (16:30 UTC), US già EDT (20:00 UTC)', () => {
    assert.equal(sessionCloseMsFor('EU', '2026-03-16'), utc(2026, 3, 16, 16, 30));
    assert.equal(sessionCloseMsFor('US', '2026-03-16'), utc(2026, 3, 16, 20, 0));
  });

  it('2026-10-28: EU già CET (16:30 UTC), US ancora EDT (20:00 UTC)', () => {
    assert.equal(sessionCloseMsFor('EU', '2026-10-28'), utc(2026, 10, 28, 16, 30));
    assert.equal(sessionCloseMsFor('US', '2026-10-28'), utc(2026, 10, 28, 20, 0));
  });
});

describe('sessionClose — giorni e date non negoziabili', () => {
  it('sabato e domenica => null per entrambi i mercati', () => {
    for (const market of ['EU', 'US'] as const) {
      assert.equal(sessionCloseMsFor(market, '2026-11-21'), null); // sabato
      assert.equal(sessionCloseMsFor(market, '2026-11-22'), null); // domenica
    }
  });

  it('date malformate o inesistenti => null', () => {
    for (const bad of ['2026-13-01', 'abc', '', '2026-02-30', '2026-1-1', '2026-01-32']) {
      assert.equal(sessionCloseMsFor('EU', bad), null, bad);
      assert.equal(sessionCloseMsFor('US', bad), null, bad);
    }
  });

  it('festività EU (Capodanno, Venerdì Santo, Lunedì dell’Angelo, 1 maggio, 24-26/12, 31/12) => null', () => {
    for (const h of [
      '2026-01-01',
      '2026-04-03', // Venerdì Santo 2026
      '2026-04-06', // Lunedì dell'Angelo 2026
      '2026-05-01',
      '2026-12-24',
      '2026-12-25',
      '2026-12-31',
    ]) {
      assert.equal(sessionCloseMsFor('EU', h), null, `EU holiday ${h}`);
      assert.equal(getSessionSchedule('EU', h).closed, true, h);
    }
    // Giorno lavorativo regolare US su 1 maggio (US aperto, EU chiuso)
    assert.ok(sessionCloseMsFor('US', '2026-05-01') != null);
    // Lunedì dell'Angelo EU chiuso ma US aperto
    assert.ok(sessionCloseMsFor('US', '2026-04-06') != null);
  });

  it('festività US NYSE/Nasdaq (MLK, Presidents, Good Friday, Memorial, Juneteenth, Jul 4, Labor, Thanksgiving, Natale) => null', () => {
    for (const h of [
      '2026-01-01', // Capodanno
      '2026-01-19', // MLK Day 2026
      '2026-02-16', // Presidents' Day 2026
      '2026-04-03', // Good Friday 2026
      '2026-05-25', // Memorial Day 2026
      '2026-06-19', // Juneteenth 2026
      '2026-07-03', // Independence Day 2026 observed (4 luglio cade sabato)
      '2026-09-07', // Labor Day 2026
      '2026-11-26', // Thanksgiving 2026
      '2026-12-25', // Christmas 2026
    ]) {
      assert.equal(sessionCloseMsFor('US', h), null, `US holiday ${h}`);
      assert.equal(getSessionSchedule('US', h).closed, true, h);
    }
  });

  it('mezze giornate US (chiusura anticipata alle 13:00 America/New_York)', () => {
    // 2026-11-27 (Black Friday, EST -300): 13:00 NY = 18:00 UTC
    const blackFriday = sessionCloseMsFor('US', '2026-11-27');
    assert.equal(blackFriday, utc(2026, 11, 27, 18, 0));
    assert.equal(getSessionSchedule('US', '2026-11-27').earlyClose, true);

    // 2026-12-24 (Vigilia giovedì, EST -300): US 13:00 NY = 18:00 UTC, EU chiuso
    assert.equal(sessionCloseMsFor('US', '2026-12-24'), utc(2026, 12, 24, 18, 0));
    assert.equal(sessionCloseMsFor('EU', '2026-12-24'), null);

    // 2025-07-03 (vigilia giovedì del 4 luglio 2025 venerdì, EDT -240): 13:00 NY = 17:00 UTC
    assert.equal(sessionCloseMsFor('US', '2025-07-03'), utc(2025, 7, 3, 17, 0));
    assert.equal(getSessionSchedule('US', '2025-07-03').earlyClose, true);
  });

  it('istante non finito => sessionDateFor null', () => {
    assert.equal(sessionDateFor('EU', Number.NaN), null);
    assert.equal(sessionDateFor('US', Number.POSITIVE_INFINITY), null);
  });
});

describe('sessionClose — sessionDateFor', () => {
  it('EU: 23:30 UTC del 27/03 è già 00:30 del 28/03 a Roma', () => {
    assert.equal(sessionDateFor('EU', utc(2026, 3, 27, 23, 30)), '2026-03-28');
  });

  it('US: 00:30 UTC del 06/03 è ancora 19:30 del 05/03 a New York', () => {
    assert.equal(sessionDateFor('US', utc(2026, 3, 6, 0, 30)), '2026-03-05');
  });

  it('EU dopo il ritorno a CET: 23:30 UTC del 26/10 resta il 27/10 a Roma', () => {
    assert.equal(sessionDateFor('EU', utc(2026, 10, 26, 23, 30)), '2026-10-27');
  });

  it('US dopo il ritorno a EST: 01:30 UTC del 02/11 è ancora il 01/11 a New York', () => {
    assert.equal(sessionDateFor('US', utc(2026, 11, 2, 1, 30)), '2026-11-01');
  });
});

describe('sessionClose — coerenza, determinismo, purezza', () => {
  const cases: Array<{ market: 'EU' | 'US'; date: string }> = [
    { market: 'EU', date: '2026-03-27' },
    { market: 'EU', date: '2026-03-30' },
    { market: 'EU', date: '2026-10-23' },
    { market: 'EU', date: '2026-10-26' },
    { market: 'US', date: '2026-03-06' },
    { market: 'US', date: '2026-03-09' },
    { market: 'US', date: '2026-10-30' },
    { market: 'US', date: '2026-11-02' },
  ];

  it('sessionDateFor(market, sessionCloseMsFor(market, d)) === d', () => {
    for (const c of cases) {
      const close = sessionCloseMsFor(c.market, c.date);
      assert.ok(close != null, `${c.market} ${c.date}`);
      assert.equal(sessionDateFor(c.market, close as number), c.date, `${c.market} ${c.date}`);
    }
  });

  it('il risultato è un multiplo esatto di minuto', () => {
    for (const c of cases) {
      const close = sessionCloseMsFor(c.market, c.date) as number;
      assert.equal(close % 60_000, 0, `${c.market} ${c.date}`);
    }
  });

  it('deterministico: stessa chiamata, stesso valore', () => {
    assert.equal(sessionCloseMsFor('EU', '2026-03-30'), sessionCloseMsFor('EU', '2026-03-30'));
    assert.equal(sessionDateFor('US', utc(2026, 3, 9, 10, 0)), sessionDateFor('US', utc(2026, 3, 9, 10, 0)));
  });

  it('non legge l\'orologio globale', () => {
    const src = fs.readFileSync(fileURLToPath(new URL('../sessionClose.ts', import.meta.url)), 'utf8');
    assert.equal(src.includes('Date.now'), false);
    assert.equal(src.includes('new Date()'), false);
  });
});
