/**
 * SHADOW_V1_LIVE_BRIDGE — interruttore del ponte client -> server.
 *
 * 'off' (default): il client non invia nulla, nessuna richiesta di rete, nessuna
 *                  allocazione di stato. Comportamento identico a prima.
 * 'on'           : ogni setup emesso (decision === 'TRADE') viene inviato una
 *                  sola volta alla route server-side, in modo passivo.
 *
 * Convenzione del repo per i feature flag client (`stalenessFlag.ts:12`,
 * `liveSelector.ts:2`): costante tipizzata, non variabile d'ambiente.
 * Do not change without a reviewed commit.
 */
export const SHADOW_V1_LIVE_BRIDGE: 'on' | 'off' = 'off';
