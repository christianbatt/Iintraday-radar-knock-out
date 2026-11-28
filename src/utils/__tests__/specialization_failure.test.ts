/**
 * Messaggio di errore della specializzazione (Fase 3.3, lato UI).
 *
 * Un 400 per diario canonico vuoto non è un errore di rete: la UI deve dire
 * che il campione non viene dal browser e cosa fare.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { specializationFailureMessage } from '../specializationFailure';

describe('diario canonico vuoto', () => {
  it('dice che il campione non viene dal browser e cosa fare', () => {
    const message = specializationFailureMessage({
      message: 'Nessun trade nel diario canonico del server',
      datasetSource: 'canonical-journal',
      rejectedTrades: { invalid: 0, duplicates: 0, futureTimestamps: 0 },
    });
    assert.ok(message.includes('diario canonico del server'));
    assert.ok(message.includes('non legge i trade inviati dal browser'));
    assert.ok(message.includes('Sincronizza il diario'));
    assert.equal(message.includes('Scartati dal diario'), false, 'senza scarti non si citano');
  });

  it('elenca gli scarti realmente avvenuti', () => {
    const message = specializationFailureMessage({
      datasetSource: 'canonical-journal',
      rejectedTrades: { invalid: 2, duplicates: 1, futureTimestamps: 3 },
    });
    assert.ok(message.includes('Scartati dal diario: 2 senza id, 1 duplicati, 3 con data nel futuro.'));
  });

  it('non cita gli scarti a zero', () => {
    const message = specializationFailureMessage({
      datasetSource: 'canonical-journal',
      rejectedTrades: { invalid: 0, duplicates: 4, futureTimestamps: 0 },
    });
    assert.ok(message.includes('Scartati dal diario: 4 duplicati.'));
    assert.equal(message.includes('senza id'), false);
    assert.equal(message.includes('data nel futuro'), false);
  });
});

describe('altri errori', () => {
  it('un errore non legato al campione passa il proprio messaggio', () => {
    assert.equal(
      specializationFailureMessage({ message: 'Modello AI temporaneamente non disponibile' }),
      'Modello AI temporaneamente non disponibile'
    );
  });

  it('senza messaggio non resta una stringa vuota', () => {
    assert.equal(specializationFailureMessage({}), 'Operazione completata.');
  });
});
