/**
 * STALENESS_USE_MARKET_TS — Passo H-bis / I2b.
 *
 * 'off' (default): G13 legge `quote.timestamp`, cioe' l'orario di risposta del
 *                  server. E' il comportamento storico: bit-identico a main.
 * 'on'           : G13 legge `quote.marketTs`, cioe' il tempo di mercato
 *                  dichiarato dal feed. Cosi' il gate puo' scattare davvero su
 *                  un feed in ritardo.
 *
 * Non e' un interruttore di soglie: le soglie restano in tradingParams.ts.
 * Do not change without a reviewed commit.
 */
export const STALENESS_USE_MARKET_TS: 'on' | 'off' = 'off';
