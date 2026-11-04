/**
 * Blocco di prompt VWAP condiviso tra server e test.
 * Unica fonte di verita' per i nomi di stato e per la regola sul volume.
 */
import { TRADING_PARAMS } from './tradingParams';

// I cinque stati direzionali usati dal prompt e dal payload AI.
export const VWAP_STATE_NAMES = ['ABOVE', 'BELOW', 'PULLBACK', 'RECLAIM', 'REJECT'] as const;

export const VWAP_PROMPT_BLOCK =
  'VWAP DI SESSIONE (contesto gia quantificato dal codice):\n' +
  '- Il punteggio VWAP numerico e gia incluso nello score del candidato: non ricalcolarlo e non modificarlo.\n' +
  '- ABOVE o RECLAIM con volume confermato (volumeRatio >= ' +
  TRADING_PARAMS.VWAP_MIN_VOLUME_RATIO +
  'x la media 5m): sostiene un bias long.\n' +
  '- BELOW o REJECT con volume confermato: sostiene un bias short oppure blocca un long.\n' +
  '- PULLBACK: conta solo se tiene la VWAP, con volume confermato.\n' +
  '- UNCONFIRMED, UNKNOWN o AFTER_HOURS: scrivi "VWAP non disponibile" e non usarlo.\n' +
  '- Ogni setup raccomandato riporta lo stato VWAP nella riga "Motivo".\n' +
  '- Uno stato VWAP contrario abbassa solo la "Confidenza": non rifiuta mai un setup da solo.';
