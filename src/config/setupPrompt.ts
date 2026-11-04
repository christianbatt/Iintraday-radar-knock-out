/**
 * Blocco di prompt per gli indicatori di setup (Supertrend, ADX, StochRSI, PSAR).
 * Unica fonte di verita' per i nomi dei campi usati anche nello schema JSON della risposta.
 */
import { TRADING_PARAMS } from './tradingParams';

export const SETUP_PROMPT_BLOCK =
  'INDICATORI DI SETUP 5m (gia calcolati dal codice, solo barre chiuse della sessione regolare):\n' +
  '- supertrend: direction (+1 long / -1 short) e barsSinceFlip. Direzione contraria al setup = veto.\n' +
  '- adx: value con plusDI e minusDI. Soglie per mercato (min/strong): EU ' +
  TRADING_PARAMS.ADX_MIN_TREND_EU +
  '/' +
  TRADING_PARAMS.ADX_STRONG_EU +
  ', US ' +
  TRADING_PARAMS.ADX_MIN_TREND_US +
  '/' +
  TRADING_PARAMS.ADX_STRONG_US +
  '. ADX sotto la soglia minima del mercato = trend assente, veto del setup; DI contrario (+DI/-DI) = 0 punti senza veto.\n' +
  '- warmupIncomplete: se true (Supertrend, ADX o StochRSI UNKNOWN) il candidato non e raccomandabile e non puo essere Top Pick, anche se resta visibile con il suo punteggio.\n' +
  '- stochRsi: k, d, lastCross (LONG/SHORT/NONE) e barsSinceCross; un incrocio conta solo entro ' +
  TRADING_PARAMS.STOCH_RSI_CROSS_LOOKBACK +
  ' barre chiuse.\n' +
  '- psar: valore e direction, usato per lo stop e per l uscita: non assegna punti allo score.\n' +
  '- UNKNOWN significa dato assente (barre insufficienti, serie stale, sessione chiusa): NON e un segnale negativo.\n' +
  '- Un candidato con veto non puo essere raccomandato: scrivi "NESSUN_TRADE" e riporta il veto in "rischi".\n' +
  '- Il testo usa gli stessi nomi di campo dello schema JSON: catalizzatore, decisione, direzione, confidenza.';
