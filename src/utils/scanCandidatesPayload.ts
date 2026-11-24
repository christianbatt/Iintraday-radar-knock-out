/**
 * ADDITIVO (P2): costruzione del campo `scanCandidates` inviato dal client agli
 * handler AI (`/api/ai/specialize`, `/api/ai/desk-post-mortem`).
 *
 * La scansione del client produce gia' i 40 candidati con punteggio e veto
 * (`scoreAllRadarCandidates`). Questo modulo li converte in un payload
 * serializzabile, senza ricalcolare nulla e senza modificare la selezione dei
 * top setup: sola lettura dei campi gia' presenti.
 */

import type { ScoredCandidate } from '../types/radar';

export interface ScanCandidatePayload {
  ticker: string;
  market: string;
  direction: 'LONG' | 'SHORT' | null;
  score: number | null;
  veto: string | null;
}

/**
 * Converte i candidati ordinati dal client in payload per il body.
 * Stessa semantica delle righe di scansione del server: direzione dal segno
 * del gap, score totale e primo veto gia' calcolati.
 */
export function buildScanCandidatesPayload(
  candidates: ReadonlyArray<ScoredCandidate>
): ScanCandidatePayload[] {
  const out: ScanCandidatePayload[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const quote = candidate.quote;
    const score = candidate.score;
    const ticker = typeof quote?.ticker === 'string' ? quote.ticker.trim() : '';
    if (ticker.length === 0) continue;
    out.push({
      ticker,
      market:
        quote?.market === 'US' || quote?.market === 'EU'
          ? quote.market
          : 'GLOBAL',
      direction:
        typeof quote?.gapPercent === 'number'
          ? quote.gapPercent >= 0
            ? 'LONG'
            : 'SHORT'
          : null,
      score: typeof score?.total === 'number' && Number.isFinite(score.total) ? score.total : null,
      veto: typeof score?.veto === 'string' && score.veto.length > 0 ? score.veto : null,
    });
  }
  return out;
}
