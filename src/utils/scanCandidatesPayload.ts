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
  /**
   * ADDITIVO (gate nel log AI): gate G1-G13, presente solo se la sorgente lo
   * espone gia'. Il client non calcola i gate, quindi il campo resta assente e
   * il server lo riempie dalla propria diagnostica Shadow V1, per ticker.
   */
  gate?: string | null;
  /** ADDITIVO (gate nel log AI): motivo del gate, stesse regole di `gate`. */
  gateReason?: string | null;
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
    const row: ScanCandidatePayload = {
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
    };
    // ADDITIVO (gate nel log AI): copia solo se la sorgente li porta gia'; la
    // forma del payload resta invariata quando i gate non sono disponibili.
    // Un candidato con `decision: "TRADE"` non ha gate: il payload lo scrive
    // come `nessuno`, mentre un gate sconosciuto resta assente (`n.d.` a valle).
    const withGate = candidate as unknown as {
      gate?: unknown;
      gateReason?: unknown;
      decision?: unknown;
    };
    const gate = typeof withGate.gate === 'string' ? withGate.gate : null;
    const gateReason = typeof withGate.gateReason === 'string' ? withGate.gateReason : null;
    if (withGate.decision === 'TRADE') {
      row.gate = 'nessuno';
      row.gateReason = 'nessuno';
    } else {
      if (gate !== null) row.gate = gate;
      if (gateReason !== null) row.gateReason = gateReason;
    }
    out.push(row);
  }
  return out;
}
