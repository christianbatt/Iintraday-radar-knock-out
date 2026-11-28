/**
 * Campione canonico per la memoria appresa (Fase 3.3).
 *
 * Il campione che può scrivere una regola deve venire dal diario che il server
 * conserva per quell'utente, non da `req.body`: altrimenti un client fabbrica
 * 30 trade, supera i gate statistici e inietta una regola.
 *
 * Qui vive la sola parte pura: quali righe sono accettabili, quali si scartano
 * e con quale motivo, e l'impronta del campione risultante.
 */

import { computeDatasetHash } from './aiMemoryScope';

/**
 * Tolleranza di orologio: una chiusura datata oltre cinque minuti nel futuro
 * non è un trade avvenuto. Cinque minuti coprono la deriva fra client e server,
 * non la fabbricazione di un esito.
 */
export const CANONICAL_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Campi in cui il diario può dichiarare quando il trade si è chiuso. */
const TIMESTAMP_FIELDS = ['realizedAt', 'exitTime', 'exitAt', 'closedAt', 'date', 'entryTime'] as const;

export interface CanonicalSampleRejections {
  /** Righe che non sono un oggetto con un `id` utilizzabile. */
  invalid: number;
  /** Righe con un `id` già visto: contate una volta, tenuta la prima. */
  duplicates: number;
  /** Righe con una data di chiusura nel futuro. */
  futureTimestamps: number;
}

export interface CanonicalSample {
  trades: unknown[];
  datasetHash: string | null;
  rejected: CanonicalSampleRejections;
  /** Dichiarazione esplicita della fonte, così la risposta non la lascia dedurre. */
  source: 'canonical-journal';
}

type TimestampVerdict = 'ok' | 'future' | 'none';

function timestampVerdict(trade: object, nowMs: number): TimestampVerdict {
  for (const field of TIMESTAMP_FIELDS) {
    const raw = (trade as Record<string, unknown>)[field];
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const ms = typeof raw === 'number' ? raw : Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    if (ms > nowMs + CANONICAL_MAX_CLOCK_SKEW_MS) return 'future';
    return 'ok';
  }
  // Nessuna data dichiarata: non si inventa un rifiuto. La riga resta, e chi
  // legge sa che il campione non è stato datato.
  return 'none';
}

/**
 * Costruisce il campione accettabile da un diario canonico.
 *
 * Non "ripara" nulla: le righe dubbie si scartano e si contano, così la
 * risposta può dichiarare quante e perché.
 */
export function buildCanonicalSample(raw: unknown, nowMs: number): CanonicalSample {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const rejected: CanonicalSampleRejections = { invalid: 0, duplicates: 0, futureTimestamps: 0 };
  const trades: unknown[] = [];
  const seenIds = new Set<string>();

  if (!Array.isArray(raw)) return { trades, datasetHash: null, rejected, source: 'canonical-journal' };

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      rejected.invalid += 1;
      continue;
    }
    const rawId = (entry as Record<string, unknown>).id;
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (id.length === 0) {
      rejected.invalid += 1;
      continue;
    }
    if (seenIds.has(id)) {
      rejected.duplicates += 1;
      continue;
    }
    if (timestampVerdict(entry as object, now) === 'future') {
      rejected.futureTimestamps += 1;
      continue;
    }
    seenIds.add(id);
    trades.push(entry);
  }

  return {
    trades,
    datasetHash: computeDatasetHash(trades),
    rejected,
    source: 'canonical-journal',
  };
}
