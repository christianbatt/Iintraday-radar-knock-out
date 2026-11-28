/**
 * Veto del catalizzatore (Passo 2.6).
 *
 * Il titolo resta eleggibile solo quando il `NESSUN_TRADE` significa "non ci
 * sono notizie". Prima lo si capiva cercando tre frasi nella prosa del modello:
 * una riformulazione cambiava l'esito. Con `vetoReason` la decisione e'
 * deterministica; il testo resta solo come fallback per le risposte storiche.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isCatalystAbsenceOfNewsOnly } from '../calculator';

describe('isCatalystAbsenceOfNewsOnly — campo strutturato', () => {
  it('NO_NEWS e assenza di notizie anche con prosa muta', () => {
    assert.equal(isCatalystAbsenceOfNewsOnly({ vetoReason: 'NO_NEWS', catalizzatore: 'x' }), true);
  });

  it('un altro motivo vince sulla prosa che parla di assenza di notizie', () => {
    assert.equal(
      isCatalystAbsenceOfNewsOnly({
        vetoReason: 'COUNTER_REGIME',
        catalizzatore: 'Assenza di notizie verificate nelle ultime 72 ore',
      }),
      false
    );
  });

  it('catalizzatore assente: nessuna eleggibilita per caso', () => {
    assert.equal(isCatalystAbsenceOfNewsOnly(null), false);
    assert.equal(isCatalystAbsenceOfNewsOnly(undefined), false);
  });
});

describe('isCatalystAbsenceOfNewsOnly — fallback testuale invariato', () => {
  it('frase storica nel catalizzatore', () => {
    assert.equal(
      isCatalystAbsenceOfNewsOnly({
        catalizzatore: 'Assenza di notizie verificate nelle ultime 72 ore per UCG.MI',
      }),
      true
    );
  });

  it('unico rischio di mancanza notizie', () => {
    assert.equal(isCatalystAbsenceOfNewsOnly({ rischi: ['Mancanza di notizie rilevanti'] }), true);
  });

  it('catalizzatore negativo: bloccante', () => {
    assert.equal(
      isCatalystAbsenceOfNewsOnly({
        catalizzatore: 'Downgrade severo con target ridotto',
        rischi: ['Conti in calo', 'Contenzioso aperto'],
      }),
      false
    );
  });

  it('campo vuoto non vale come motivo dichiarato', () => {
    assert.equal(isCatalystAbsenceOfNewsOnly({ vetoReason: '', catalizzatore: 'Assenza di notizie' }), true);
  });
});
