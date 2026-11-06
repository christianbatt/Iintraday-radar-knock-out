/**
 * Etichetta dello stato della sessione USA per i badge dell'Header.
 *
 * BUGFIX: il badge "Live Globale" mappava "non live" -> "Pre-Mkt", quindi dopo la chiusura
 * cash (16:05 ET) mostrava ancora "US: Pre-Mkt" invece di Post-Mkt/Chiuso. Lo stato viene
 * ora derivato da `marketStatusUS` + `usMinutes` forniti da server.ts.
 *
 * Soglie (coordinate con server.ts:498-501):
 *  - Pre-Market: 04:00–09:29 ET (240–569 minuti)
 *  - Live:       09:30–16:05 ET (570–965 minuti)
 *  - Post-Market: 16:06–20:00 ET (966–1200 minuti) [IPOTESI: durata del post-market USA,
 *    non definita in server.ts; usata solo per l'etichetta, non per i gate di trading]
 *  - Chiuso: fuori da questi intervalli
 */
export const US_PRE_MARKET_OPEN_MINUTES = 240;
export const US_OPEN_MINUTES = 570;
export const US_LIVE_END_MINUTES = 965;
export const US_POST_MARKET_END_MINUTES = 1200; // [IPOTESI]

export type USSessionLabel = 'Aperto' | 'Pre-Mkt' | 'Post-Mkt' | 'Chiuso';
export type USMarketStatus = 'PRE_MARKET' | 'OPEN_LIVE' | 'CLOSED';

/**
 * Traduce lo stato USA in etichetta UI. `usMinutes` (minuti dalla mezzanotte ET) ha
 * precedenza perche' distingue post-market da chiuso; senza di esso si usa lo stato del server.
 */
export function usSessionLabel(
  status: USMarketStatus | null | undefined,
  usMinutes: number | null | undefined
): USSessionLabel {
  if (usMinutes != null && Number.isFinite(usMinutes)) {
    if (usMinutes >= US_PRE_MARKET_OPEN_MINUTES && usMinutes < US_OPEN_MINUTES) return 'Pre-Mkt';
    if (usMinutes >= US_OPEN_MINUTES && usMinutes <= US_LIVE_END_MINUTES) return 'Aperto';
    if (usMinutes > US_LIVE_END_MINUTES && usMinutes <= US_POST_MARKET_END_MINUTES) return 'Post-Mkt';
    return 'Chiuso';
  }
  if (status === 'OPEN_LIVE') return 'Aperto';
  if (status === 'PRE_MARKET') return 'Pre-Mkt';
  return 'Chiuso';
}
