/**
 * Intraday Radar - Parametri Operativi di Trading (Specifica Fase 1)
 * Data ultima modifica: 2026-10-26T00:45:00Z
 * Autore: Sistema Quantitativo Intraday Radar
 */

export interface GapAtrTier {
  readonly minRatio: number;
  readonly points: number;
}

export interface RvolTier {
  readonly minRvol: number;
  readonly points: number;
}

export interface TradingParamsConfig {
  SPEC_VERSION: string;
  LAST_MODIFIED: string;
  EPSILON: number;

  // Parametri di Rischio e Derivati Turbo Knock-Out
  LMAX: number;
  LEVE: readonly number[];
  LEVA_MIN_PRUDENTE: number;

  // Soglie Gate Operative (Provvisorie - da validare empiricamente in Fase 2)
  LIQ_MIN_EUR: number;
  LIQ_BARS_REQUIRED: number;
  ATR_PERIOD: number;
  ATR_MIN_BARS: number;
  ADR_PERIOD: number;
  EST_MAX: number;
  ADR_MAX: number;
  ADR_OPTIMAL_MAX_PCT: number;
  FRESH_MIN: number;
  BUF_BAR: number;
  STOP_BUF: number;

  // Moltiplicatori di Target e Uscita
  T1_R: number;
  T2_R: number;
  EXIT_T1_PCT: number;

  // Stima Limiti Volatilità Implicita (IV) e IV Rank (server.ts)
  IV_ESTIMATED_HIGH_HV_MULT: number;
  IV_ESTIMATED_HIGH_IV_MULT: number;
  IV_ESTIMATED_HIGH_MIN_FLOOR: number;

  // Soglie Safety Ratio Barriera KO vs Stop Distance
  KO_SAFETY_RATIO_CRITICAL: number;
  KO_SAFETY_RATIO_WARNING: number;

  // Parametri di Costo Operativo e Commissioni
  SPREAD_EUR: number;
  BROKER_FEE_PER_SIDE_EUR: number;

  // Soglie Minime di RVOL per Mercato
  MIN_RVOL_EU: number;
  MIN_RVOL_US: number;
  RVOL_USA_MULTIPLIER: number; // rapporto minRvolUSA / minRvolEurope

  // Soglie Minime di Punteggio per Mercato (Unica Fonte di Verità)
  MIN_SCORE_EU: number;
  MIN_SCORE_US: number;

  // Banda di Neutralità Futures Benchmark e Punti Futures
  FUT_NEUTRAL_BAND: number;
  FUT_SCORE_NEUTRAL: number;
  FUT_SCORE_ALIGNED: number;
  FUT_SCORE_DIVERGENT: number;
  FUT_SCORE_MISSING: number;

  // Finestra Temporale ORB e Orari Borsa / Freeze
  ORB_MINUTES: number;
  MANUAL_FREEZE_BARS_1M: number;
  EU_OPEN_HOUR: number;
  EU_OPEN_MINUTE: number;
  EU_CLOSE_HOUR: number;
  EU_CLOSE_MINUTE: number;
  US_OPEN_HOUR: number;
  US_OPEN_MINUTE: number;
  US_CLOSE_HOUR: number;
  US_CLOSE_MINUTE: number;

  // Scaline Gap / ATR e RVOL e Componenti Punteggio
  GAP_ATR_TIERS: readonly GapAtrTier[];
  GAP_ATR_MIN_POINTS: number;
  RVOL_TIERS: readonly RvolTier[];
  RVOL_MIN_POINTS: number;
  RVOL_SPIKE_20M_THRESHOLD: number;
  RVOL_SPIKE_20M_BONUS: number;
  LEVEL_PROXIMITY_FACTOR: number;
  ORDER_FLOW_STRONG_PCT: number;
  ORDER_FLOW_MOD_PCT: number;
  SCORE_MAX_COMPONENTS: {
    readonly GAP: number;
    readonly RVOL: number;
    readonly LIQUIDITY: number;
    readonly FUTURES: number;
    readonly LEVELS: number;
    readonly RSI: number;
    readonly NEWS: number;
    readonly TREND: number;
    readonly ORDER_FLOW: number;
    readonly VWAP: number;
    readonly SUPERTREND: number;
    readonly ADX: number;
    readonly STOCH_RSI: number;
    readonly PSAR: number;
    readonly RAW_MAX: number;
    readonly CAPPED_MAX: number;
  };

  // Massimi legacy dei componenti storici: servono solo alla conversione proporzionale
  // component = min(W_x, oldPoints * W_x / oldMax).
  SCORE_LEGACY_MAX: {
    readonly GAP: number;
    readonly RVOL: number;
    readonly LEVELS: number;
    readonly FUTURES: number;
    readonly NEWS: number;
    readonly ORDER_FLOW: number;
  };

  // VWAP di sessione: contributo allo score e stato per candidato (TUTTE IPOTESI, da validare empiricamente)
  VWAP_SCORE_WEIGHT: number;
  VWAP_NEUTRAL_BAND_ATR: number;
  VWAP_MIN_VOLUME_RATIO: number;
  VWAP_AFTER_HOURS_VOL_RATIO: number;
  VWAP_SOURCE: 'session' | 'withPre';
  VWAP_MIN_COVERAGE: number;
  VWAP_MAX_ZERO_VOLUME_BARS: number;
  VWAP_MAX_STALE_MIN: number;
  VWAP_MAX_QUOTE_DRIFT_PCT: number;
  VWAP_NEAR_ATR: number;
  VWAP_REJECT_VOL_MULT: number;
  VWAP_SLOPE_BARS: number;
  VWAP_OPEN_WINDOW_MIN: number;
  VWAP_OPEN_WEIGHT_FACTOR: number;
  VWAP_HARD_GATE: boolean;

  // Indicatori di setup 5m (TUTTE IPOTESI: periodi e soglie da validare empiricamente)
  ST_PERIOD: number; // periodo ATR del Supertrend
  ST_FACTOR: number; // moltiplicatore ATR delle bande (alternativa 3.5 selezionabile)
  ST_FLIP_RECENT_BARS: number; // flip considerato "recente" entro N barre chiuse
  ADX_PERIOD: number;
  ADX_MIN_TREND_EU: number; // IPOTESI: sotto questa soglia il trend e' assente in EU: veto del setup
  ADX_MIN_TREND_US: number; // soglia US (invariata rispetto al precedente ADX_MIN_TREND 20)
  ADX_STRONG_EU: number; // IPOTESI: trend forte EU (punteggio pieno ADX)
  ADX_STRONG_US: number; // soglia di trend forte US (invariata rispetto al precedente ADX_STRONG 25)
  STOCH_RSI_RSI_LEN: number;
  STOCH_RSI_STOCH_LEN: number;
  STOCH_RSI_K: number;
  STOCH_RSI_D: number;
  STOCH_RSI_LONG_CROSS_MAX: number; // incrocio long valido solo se K <= soglia
  STOCH_RSI_SHORT_CROSS_MIN: number; // incrocio short valido solo se K >= soglia
  STOCH_RSI_EXTREME_HI: number;
  STOCH_RSI_EXTREME_LO: number;
  STOCH_RSI_CROSS_LOOKBACK: number; // barre chiuse entro cui l'incrocio e' valido
  PSAR_START: number;
  PSAR_STEP: number;
  PSAR_MAX: number;
  IND_BAR_MS: number; // IPOTESI: durata della barra 5m in millisecondi (chiusura della barra = apertura + IND_BAR_MS)
  IND_MIN_BARS: number; // barre 5m complete richieste (sessione precedente inclusa)
  IND_MAX_STALE_MIN: number; // ultima barra piu' vecchia di N minuti = serie STALE
  WARMUP_RANGE_5M: string; // IPOTESI: range Yahoo della serie 5m usata dagli indicatori
  WARMUP_RANGE_FALLBACK_5M: string; // IPOTESI: fallback se con WARMUP_RANGE_5M le barre complete sono < IND_MIN_BARS
  WARMUP_MAX_PRIOR_SESSIONS: number; // IPOTESI: massimo sessioni regolari precedenti usate nel warm-up
  WARMUP_INCOMPLETE: 'WARMUP_INCOMPLETE'; // flag del candidato con Supertrend/ADX/StochRSI UNKNOWN
  VWAP_VETO_ENABLED: boolean; // veto se VWAP contraria con volume confermato

  // Pesi dello score (somma = 100, TUTTE IPOTESI)
  W_GAP: number;
  W_RVOL: number;
  W_VWAP: number;
  W_SUPERTREND: number;
  W_ADX: number;
  W_STOCH_RSI: number;
  W_LEVELS: number;
  W_FUTURES: number;
  W_NEWS: number;
  W_ORDER_FLOW: number;
  W_LIQUIDITY: number;
  W_PSAR: number;
  W_RSI: number;
  W_TREND: number;
}

export const TRADING_PARAMS: TradingParamsConfig = {
  // Data e versione della specifica
  SPEC_VERSION: '1.0.0-phase1-final',
  LAST_MODIFIED: '2026-10-26T00:45:00Z',
  EPSILON: 1e-9, // Tolleranza confronti floating point ai confini

  // Parametri di Rischio e Derivati Turbo Knock-Out
  LMAX: 0.10, // Perdita massima consentita sul certificato allo stop (10%)
  LEVE: [10, 15, 20, 25], // Griglia leve standard ammesse per selezione
  LEVA_MIN_PRUDENTE: 10, // Leva prudente minima dell'insieme valido

  // Soglie Gate Operative (Provvisorie - da validare empiricamente in Fase 2)
  LIQ_MIN_EUR: 3_000_000, // Media 20 giorni completati di (Volume × Close daily) in Euro [Provvisorio]
  LIQ_BARS_REQUIRED: 20, // Sessioni complete richieste per calcolo Liq€
  ATR_PERIOD: 14, // Periodo media semplice True Range (ATR14)
  ATR_MIN_BARS: 15, // Barre complete richieste per ATR14 (14 TR + 1 close precedente)
  ADR_PERIOD: 14, // Barre complete richieste per ADR14 (14 High - Low)
  EST_MAX: 0.004, // Estensione massima tollerata oltre il trigger (0.40%) [Provvisorio]
  ADR_MAX: 0.60, // Consumo massimo tollerato dell'ADR14 prima dell'ingresso (60%) [Provvisorio]
  ADR_OPTIMAL_MAX_PCT: 45, // Soglia % per stato OPTIMAL/MODERATE in calculateAdrInfo [Provvisorio, non in specifica base]
  FRESH_MIN: 60, // Minuti massimi trascorsi dalla prima rottura del trigger Tb prima di decadenza [Provvisorio]
  BUF_BAR: 0.001, // Distanza minima barriera KO oltre lo stop, come frazione del prezzo di entrata (0.1%) [Provvisorio]
  STOP_BUF: 0.002, // Buffer di sicurezza oltre il minimo/massimo ORB per posizionare lo stop S (0.2%) [Provvisorio]

  // Moltiplicatori di Target e Uscita
  T1_R: 1.6, // Target 1 espresso in multipli di R (1.6R)
  T2_R: 2.8, // Target 2 espresso in multipli di R (2.8R)
  EXIT_T1_PCT: 70, // Percentuale di monetizzazione della posizione raggiunta su T1 (70%)

  // Stima Limiti Volatilità Implicita (IV) e IV Rank (server.ts)
  IV_ESTIMATED_HIGH_HV_MULT: 1.6, // Moltiplicatore HV30 per limite superiore IV
  IV_ESTIMATED_HIGH_IV_MULT: 1.15, // Moltiplicatore IV per limite superiore IV
  IV_ESTIMATED_HIGH_MIN_FLOOR: 35, // Floor minimo percentuale per stima limite superiore IV Rank

  // Soglie Safety Ratio Barriera KO vs Stop Distance
  KO_SAFETY_RATIO_CRITICAL: 1.6, // Ratio minimo barriera/stop al di sotto del quale il margine è critico
  KO_SAFETY_RATIO_WARNING: 2.2, // Ratio prudente consigliato

  // Parametri di Costo Operativo e Commissioni
  SPREAD_EUR: 0.02, // Spread tipico Knock-Out Turbo per certificato (0.02 €)
  BROKER_FEE_PER_SIDE_EUR: 1.00, // Commissione Trade Republic per lato (1.00 € entrata + 1.00 € uscita)

  // Soglie Minime di RVOL per Mercato
  MIN_RVOL_EU: 0.85, // Soglia minima RVOL per Europa (0.85x)
  MIN_RVOL_US: 1.15, // Soglia minima RVOL per USA (1.15x)
  // IPOTESI: rapporto minRvolUSA / minRvolEurope (calculator e UI). Valore storico 1.35, non validato empiricamente.
  RVOL_USA_MULTIPLIER: 1.35,

  // Soglie Minime di Punteggio per Mercato (Unica Fonte di Verità)
  MIN_SCORE_EU: 48, // Punteggio minimo qualificazione Top Pick Europa (senza punti liquidità)
  MIN_SCORE_US: 58, // Punteggio minimo qualificazione Top Pick USA (senza punti liquidità)

  // Banda di Neutralità Futures Benchmark
  FUT_NEUTRAL_BAND: 0.15, // Percentuale futures considerata neutrale (|chg| <= 0.15% -> 12pt)
  FUT_SCORE_NEUTRAL: 12,
  FUT_SCORE_ALIGNED: 20,
  FUT_SCORE_DIVERGENT: 4,
  FUT_SCORE_MISSING: 0,

  // Finestra Temporale ORB (Opening Range Breakout) e Orari Borsa / Freeze
  ORB_MINUTES: 15, // Durata in minuti dell'ORB iniziale
  MANUAL_FREEZE_BARS_1M: 15, // Candele da 1 minuto complete precedenti il freeze manuale
  EU_OPEN_HOUR: 9,
  EU_OPEN_MINUTE: 0,
  EU_CLOSE_HOUR: 17,
  EU_CLOSE_MINUTE: 30,
  US_OPEN_HOUR: 9,
  US_OPEN_MINUTE: 30,
  US_CLOSE_HOUR: 16,
  US_CLOSE_MINUTE: 0,

  // Scaline Gap / ATR e RVOL e Componenti Punteggio
  GAP_ATR_TIERS: [
    { minRatio: 0.75, points: 25 },
    { minRatio: 0.50, points: 20 },
    { minRatio: 0.30, points: 12 },
    { minRatio: 0.15, points: 6 },
  ],
  GAP_ATR_MIN_POINTS: 2,
  RVOL_TIERS: [
    { minRvol: 2.0, points: 25 },
    { minRvol: 1.4, points: 20 },
    { minRvol: 1.1, points: 14 },
  ],
  RVOL_MIN_POINTS: 5,
  RVOL_SPIKE_20M_THRESHOLD: 1.5,
  RVOL_SPIKE_20M_BONUS: 3,
  LEVEL_PROXIMITY_FACTOR: 0.005, // 0.5% di prossimità a High/Low ieri
  ORDER_FLOW_STRONG_PCT: 58,
  ORDER_FLOW_MOD_PCT: 53,
  SCORE_MAX_COMPONENTS: {
    GAP: 12,
    RVOL: 14,
    LIQUIDITY: 0,
    FUTURES: 12,
    LEVELS: 6,
    RSI: 0,
    NEWS: 10,
    TREND: 0,
    ORDER_FLOW: 8,
    VWAP: 10,
    SUPERTREND: 12,
    ADX: 7,
    STOCH_RSI: 9,
    PSAR: 0,
    RAW_MAX: 100,
    CAPPED_MAX: 100,
  },

  SCORE_LEGACY_MAX: {
    GAP: 25,
    RVOL: 25,
    LEVELS: 10,
    FUTURES: 20,
    NEWS: 15,
    ORDER_FLOW: 10,
  },

  // Indicatori di setup 5m (TUTTE IPOTESI)
  ST_PERIOD: 14,
  ST_FACTOR: 3, // alternativa 3.5 selezionabile
  ST_FLIP_RECENT_BARS: 6,
  ADX_PERIOD: 14,
  ADX_MIN_TREND_EU: 16, // IPOTESI: il 5m EU e' meno direzionale del US
  ADX_MIN_TREND_US: 20, // invariato rispetto al precedente ADX_MIN_TREND
  ADX_STRONG_EU: 20, // IPOTESI
  ADX_STRONG_US: 25, // invariato rispetto al precedente ADX_STRONG
  STOCH_RSI_RSI_LEN: 14,
  STOCH_RSI_STOCH_LEN: 14,
  STOCH_RSI_K: 3,
  STOCH_RSI_D: 3,
  STOCH_RSI_LONG_CROSS_MAX: 50,
  STOCH_RSI_SHORT_CROSS_MIN: 50,
  STOCH_RSI_EXTREME_HI: 80,
  STOCH_RSI_EXTREME_LO: 20,
  STOCH_RSI_CROSS_LOOKBACK: 3,
  PSAR_START: 0.02,
  PSAR_STEP: 0.02,
  PSAR_MAX: 0.2,
  IND_BAR_MS: 5 * 60_000, // IPOTESI: durata della barra 5m (300s); chiusura = apertura + IND_BAR_MS
  IND_MIN_BARS: 60,
  IND_MAX_STALE_MIN: 15,
  WARMUP_RANGE_5M: '5d', // IPOTESI: ~5 sessioni regolari di barre 5m
  WARMUP_RANGE_FALLBACK_5M: '1mo', // IPOTESI: fallback se le barre complete sono < IND_MIN_BARS
  WARMUP_MAX_PRIOR_SESSIONS: 5, // IPOTESI
  WARMUP_INCOMPLETE: 'WARMUP_INCOMPLETE',
  VWAP_VETO_ENABLED: true,

  // Pesi dello score: somma esattamente 100 (test dedicato)
  W_GAP: 12,
  W_RVOL: 14,
  W_VWAP: 10,
  W_SUPERTREND: 12,
  W_ADX: 7,
  W_STOCH_RSI: 9,
  W_LEVELS: 6,
  W_FUTURES: 12,
  W_NEWS: 10,
  W_ORDER_FLOW: 8,
  W_LIQUIDITY: 0,
  W_PSAR: 0,
  W_RSI: 0,
  W_TREND: 0,

  // VWAP di sessione (contributo separato nello score + contesto per l'AI)
  // IPOTESI: 10 = 10% del punteggio massimo totale (CAPPED_MAX 100 ricavato dal codice: 0.10 * 100 = 10).
  // Il contributo VWAP e' quindi al massimo +/-10 punti su una scala 0..100. DA VALIDARE empiricamente.
  VWAP_SCORE_WEIGHT: 10,
  VWAP_NEUTRAL_BAND_ATR: 0.1, // IPOTESI: |distAtr| < 0.1 = NEUTRAL (nessun contributo)
  VWAP_MIN_VOLUME_RATIO: 1.5, // IPOTESI: volume confermato solo se barra 5m >= 1.5x media 5m
  VWAP_AFTER_HOURS_VOL_RATIO: 0.1, // IPOTESI: volume barra < 10% della media di sessione = barra illiquida (after-market) -> stato UNKNOWN
  VWAP_SOURCE: 'session', // IPOTESI: 'session' (US 09:30-16:00 / EU 09:00-17:30) oppure 'withPre' (solo US, dalle 04:00 NY)
  VWAP_MIN_COVERAGE: 0.8, // IPOTESI: sotto questa quota di barre presenti/attese lo stato VWAP e' UNKNOWN
  VWAP_MAX_ZERO_VOLUME_BARS: 0, // IPOTESI: barre a volume 0 tollerate in sessione (0 = una sola barra a volume 0 invalida la serie)
  VWAP_MAX_STALE_MIN: 10, // IPOTESI: ultima barra piu' vecchia di 10 minuti in sessione = serie STALE
  VWAP_MAX_QUOTE_DRIFT_PCT: 0.005, // IPOTESI: scostamento massimo ammesso tra ultima chiusura 5m e prezzo quote (0.5%)
  VWAP_NEAR_ATR: 0.1, // IPOTESI: prossimita' alla VWAP per riconoscere un PULLBACK (in ATR 5m)
  VWAP_REJECT_VOL_MULT: 1.5, // IPOTESI: volume della barra >= 1.5x media 5m per validare RECLAIM/REJECT
  VWAP_SLOPE_BARS: 6, // IPOTESI: barre 5m indietro per il calcolo della pendenza (30 minuti)
  VWAP_OPEN_WINDOW_MIN: 30, // IPOTESI: primi minuti di sessione in cui il contributo e' ridotto
  VWAP_OPEN_WEIGHT_FACTOR: 0.5, // IPOTESI: moltiplicatore del contributo nella finestra di apertura
  VWAP_HARD_GATE: false, // IPOTESI: true = scarta i candidati con stato VWAP contrario alla direzione (non validato: resta false)
}
export const IND_BAR_MS = TRADING_PARAMS.IND_BAR_MS;

export type TradingParams = typeof TRADING_PARAMS;

/**
 * Soglie ADX per mercato (IPOTESI): per ogni mercato MIN < STRONG, vincolo verificato dai test.
 * EU piu' permissivo del US: 16/20 contro 20/25.
 */
export function adxThresholds(market: 'EU' | 'US'): { min: number; strong: number } {
  return market === 'EU'
    ? { min: TRADING_PARAMS.ADX_MIN_TREND_EU, strong: TRADING_PARAMS.ADX_STRONG_EU }
    : { min: TRADING_PARAMS.ADX_MIN_TREND_US, strong: TRADING_PARAMS.ADX_STRONG_US };
}
