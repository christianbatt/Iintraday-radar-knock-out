/**
 * Messaggio di errore della specializzazione (Fase 3.3, lato UI).
 *
 * Il server risponde 400 quando il diario canonico è vuoto: il messaggio deve
 * dire cosa fare e non far credere che i trade del browser siano stati usati.
 */

export interface SpecializationFailureLike {
  message?: string;
  datasetSource?: string;
  rejectedTrades?: {
    invalid?: number;
    duplicates?: number;
    futureTimestamps?: number;
  };
}

/**
 * Testo da mostrare quando la specializzazione non va a buon fine.
 * Con `datasetSource: 'canonical-journal'` il motivo è la fonte, non un errore
 * di rete: si dice esplicitamente e si elencano gli scarti.
 */
export function specializationFailureMessage(res: SpecializationFailureLike): string {
  const canonical = res.datasetSource === 'canonical-journal';
  if (!canonical) return res.message || 'Operazione completata.';

  const rejected = res.rejectedTrades ?? {};
  const counts: string[] = [];
  if (typeof rejected.invalid === 'number' && rejected.invalid > 0) {
    counts.push(`${rejected.invalid} senza id`);
  }
  if (typeof rejected.duplicates === 'number' && rejected.duplicates > 0) {
    counts.push(`${rejected.duplicates} duplicati`);
  }
  if (typeof rejected.futureTimestamps === 'number' && rejected.futureTimestamps > 0) {
    counts.push(`${rejected.futureTimestamps} con data nel futuro`);
  }
  const rejectedText = counts.length > 0 ? ` Scartati dal diario: ${counts.join(', ')}.` : '';

  return (
    'Il diario canonico del server non contiene trade utilizzabili: la specializzazione non legge i trade ' +
    'inviati dal browser, quindi non può scrivere regole.' +
    rejectedText +
    ' Sincronizza il diario e registra almeno un trade concluso, poi riprova.'
  );
}
