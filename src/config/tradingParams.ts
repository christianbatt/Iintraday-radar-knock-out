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
    readonly RAW_MAX: number;
    readonly CAPPED_MAX: number;
  };
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
    GAP: 25,
    RVOL: 25,
    LIQUIDITY: 0,
    FUTURES: 20,
    LEVELS: 10,
    RSI: 10,
    NEWS: 15,
    TREND: 8,
    ORDER_FLOW: 10,
    RAW_MAX: 123,
    CAPPED_MAX: 100,
  },
};

export type TradingParams = typeof TRADING_PARAMS;
