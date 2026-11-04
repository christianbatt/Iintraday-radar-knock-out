/**
 * Etichette condivise per gli indicatori di setup e i veti (IPOTESI).
 * Unica fonte di verita' per i testi mostrati in UI: i reason code restano quelli del payload.
 */
import { TRADING_PARAMS } from './tradingParams';

export const UNKNOWN_LABEL = 'n.d.';
export const UNKNOWN_HINT = 'dato assente';

/** Nota da mostrare sui tooltip dei parametri nuovi: sono in calibrazione. */
export const INDICATOR_HINT = 'Soglie in calibrazione (IPOTESI)';

export const SETUP_VETO_LABELS: Record<string, string> = {
  ADX_BELOW_MARKET_THRESHOLD: 'ADX sotto la soglia del mercato (trend assente)',
  SUPERTREND_OPPOSED: 'Supertrend contrario al setup',
  VWAP_OPPOSED: 'VWAP contraria con volume confermato',
};

export const WARMUP_INCOMPLETE_LABEL = 'WARMUP incompleto';
export const WARMUP_INCOMPLETE_HINT =
  'Supertrend/ADX/StochRSI non tutti disponibili: candidato visibile ma non raccomandabile e non Top Pick';

export const SCORE_COMPONENT_LABELS: Record<string, string> = {
  gap: 'Gap',
  rvol: 'RVOL',
  vwap: 'VWAP',
  supertrend: 'Supertrend',
  adx: 'ADX',
  stochRsi: 'Stoch RSI',
  psar: 'PSAR',
  levels: 'Livelli',
  futures: 'Futures',
  news: 'News',
  orderFlow: 'Order Flow',
  liquidity: 'Liquidita',
  rsi: 'RSI',
  trend: 'Trend',
};

/** Massimo per componente: pesi correnti della configurazione, non soglie di mercato. */
export const SCORE_COMPONENT_MAX: Record<string, number> = {
  gap: TRADING_PARAMS.W_GAP,
  rvol: TRADING_PARAMS.W_RVOL,
  vwap: TRADING_PARAMS.W_VWAP,
  supertrend: TRADING_PARAMS.W_SUPERTREND,
  adx: TRADING_PARAMS.W_ADX,
  stochRsi: TRADING_PARAMS.W_STOCH_RSI,
  psar: TRADING_PARAMS.W_PSAR,
  levels: TRADING_PARAMS.W_LEVELS,
  futures: TRADING_PARAMS.W_FUTURES,
  news: TRADING_PARAMS.W_NEWS,
  orderFlow: TRADING_PARAMS.W_ORDER_FLOW,
  liquidity: TRADING_PARAMS.W_LIQUIDITY,
  rsi: TRADING_PARAMS.W_RSI,
  trend: TRADING_PARAMS.W_TREND,
};

/** Etichetta italiana di un reason code di veto; null se non c'e' veto. */
export function vetoLabel(code?: string | null): string | null {
  if (!code) return null;
  return SETUP_VETO_LABELS[code] ?? code;
}
