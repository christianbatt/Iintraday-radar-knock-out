/**
 * COSTO PER TRADE, PER RIGA (Fase 6.1).
 *
 * La calibrazione sottraeva a ogni abbinamento un costo COSTANTE di 0,36 R:
 * fee reale 0,20 R (2 EUR round-trip sul rischio di riferimento 10 EUR) + 0,16 R
 * di proxy spread al tetto dichiarato. Il tetto e' conservativo, ma e' anche
 * l'unico numero disponibile: un desk che paga 0,36 R su ogni trade sembra
 * perdente per costruzione, e non si puo' sapere quali setup valgono il pedaggio.
 *
 * Qui il costo si calcola sulla RIGA, riusando i componenti che Shadow V2
 * dichiara gia' (nessuna costante nuova inventata):
 *
 *   costo = fee (0,20 R) + spread sottostante + spread certificato
 *
 * - **spread sottostante**: Corwin-Schultz sulle due barre 5m consecutive che
 *   contengono il fill, diviso per la distanza dello stop in percentuale
 *   (`cs / stopPct`), come fa Shadow V2. Se le barre mancano o non sono
 *   utilizzabili si usa il TETTO dichiarato `UNDERLYING_SPREAD_MAX_R` (0,16 R),
 *   che e' esattamente il valore del modello costante: cosi' una riga senza
 *   dati non diventa piu' conveniente per omissione.
 * - **spread certificato KO**: 0,2% del prezzo del certificato per lato, cioe'
 *   `2 * KO_SPREAD_CERT_PCT_PER_SIDE / (leva * stopPct)`. E' il termine che
 *   scala con la leva: a parita' di stop, piu' leva significa certificato piu'
 *   caro in prezzo ma con escursione minore, quindi spread in R piu' piccolo.
 *   Senza la leva della riga il termine non viene contato e la fonte lo dice.
 * - **tetto totale**: `VAR_SPREAD_MAX_R` (0,25 R) sullo spread complessivo,
 *   come Shadow V2. Oltre, il costo non e' piu' una stima ma un'altra cosa.
 *
 * FONTE DICHIARATA (`costSource`):
 * - `per_row_cs_leverage`: spread misurato sulle barre + leva nota;
 * - `per_row_cs`: spread misurato, leva assente (termine certificato non contato);
 * - `per_row_leverage`: barre assenti (tetto sottostante) ma leva nota;
 * - `declared_ceiling`: nessun dato di riga -> costo identico al modello
 *   costante di prima (equivalenza garantita e verificata nei test).
 *
 * Limiti dichiarati: Corwin-Schultz e' una STIMA, non una misura del book; le
 * barre sono a 5 minuti, quindi lo spread intraday piu' fine non si vede; il
 * costo in R non e' un P&L (manca il moltiplicatore del certificato sull'esito).
 * Puro e deterministico: nessun I/O, nessun orologio, nessuna scrittura.
 */

import { SHADOW_V2_HYPOTHESES } from '../knowledge/shadowV2';
import { corwinSchultzSpreadProxy, type KnowledgeBar } from '../knowledge/shadowAlgorithms';

/** Fee round-trip reale in R sul rischio di riferimento (2 EUR su 10 EUR). */
export const AI_TRADE_COST_FEE_R =
  Math.round(
    (SHADOW_V2_HYPOTHESES.FEE_ROUNDTRIP_EUR /
      (SHADOW_V2_HYPOTHESES.REFERENCE_CAPITAL_EUR * SHADOW_V2_HYPOTHESES.RISK_PCT)) *
      10_000
  ) / 10_000;
/** Tetto del proxy spread sottostante, usato quando le barre non ci sono. */
export const AI_TRADE_COST_SPREAD_CEILING_R = SHADOW_V2_HYPOTHESES.UNDERLYING_SPREAD_MAX_R;
/** Tetto dello spread complessivo (sottostante + certificato), da Shadow V2. */
export const AI_TRADE_COST_TOTAL_CEILING_R = SHADOW_V2_HYPOTHESES.VAR_SPREAD_MAX_R;
/** Costo del modello dichiarato: fee + tetto del sottostante = 0,36 R. */
export const AI_TRADE_COST_DECLARED_R =
  Math.round((AI_TRADE_COST_FEE_R + AI_TRADE_COST_SPREAD_CEILING_R) * 10_000) / 10_000;
/** Distanza massima fra le due barre usate per la stima (5m + tolleranza). */
export const AI_TRADE_COST_MAX_BAR_GAP_MS = 15 * 60 * 1000;

export type AiTradeCostSource =
  | 'per_row_cs_leverage'
  | 'per_row_cs'
  | 'per_row_leverage'
  | 'declared_ceiling';

export interface AiTradeCostInput {
  /** Prezzo di ingresso dichiarato dall'esito forward. */
  entry?: number | null;
  /** Stop dichiarato: la sua distanza da `entry` e' il denominatore dell'R. */
  stop?: number | null;
  /** Leva del certificato, quando la riga la conosce (griglia KO). */
  leverage?: number | null;
  /** Due barre OHLC consecutive che contengono il fill. */
  bars?: readonly KnowledgeBar[] | null;
}

export interface AiTradeCost {
  costR: number;
  feeR: number;
  spreadR: number;
  /** Componente spread sottostante effettivamente applicata, in R. */
  underlyingSpreadR: number;
  /** Componente spread certificato KO, in R (0 quando la leva non e' nota). */
  certSpreadR: number;
  /** Distanza dello stop in percentuale del prezzo, se ricavabile. */
  stopPct: number | null;
  leverage: number | null;
  /** `true` solo quando lo spread viene da Corwin-Schultz sulle barre. */
  estimatedSpread: boolean;
  /**
   * `true` quando la stima e' 0 perche' Corwin-Schultz e' andato sotto zero e la
   * formula lo azzera: e' un PAVIMENTO, non una misura. Il costo scende a 0,20 R
   * e il numero va letto come limite inferiore, non come spread nullo certo.
   */
  spreadAtFloor: boolean;
  costSource: AiTradeCostSource;
  detail: string;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Spread relativo stimato dalle due barre, oppure `null`.
 * Le barre devono essere consecutive entro `AI_TRADE_COST_MAX_BAR_GAP_MS`:
 * applicare Corwin-Schultz a due barre separate da un giorno produrrebbe un
 * numero che sembra una stima e non lo e'.
 */
function spreadFromBars(bars: readonly KnowledgeBar[] | null | undefined): number | null {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const previous = bars[bars.length - 2];
  const current = bars[bars.length - 1];
  if (!previous || !current) return null;
  if (!Number.isFinite(previous.t) || !Number.isFinite(current.t)) return null;
  const gap = current.t - previous.t;
  if (!(gap > 0) || gap > AI_TRADE_COST_MAX_BAR_GAP_MS) return null;
  const estimate = corwinSchultzSpreadProxy([previous, current]).at(-1) ?? null;
  return typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0
    ? estimate
    : null;
}

const DECLARED_DETAIL =
  'nessun prezzo (entry/stop) o stop non positivo: si applica il costo dichiarato ' +
  `${AI_TRADE_COST_FEE_R} R di fee + ${AI_TRADE_COST_SPREAD_CEILING_R} R di spread al tetto`;

/**
 * Costo in R di un singolo trade. Stesso input => stesso output: nessuna
 * casualita', nessun accesso a file o orologio.
 */
export function resolveTradeCost(input: AiTradeCostInput = {}): AiTradeCost {
  const entry = positive(input?.entry);
  const stop = positive(input?.stop);
  const leverage = positive(input?.leverage);
  const stopPct = entry !== null && stop !== null ? round4(Math.abs(entry - stop) / entry) : null;

  if (stopPct === null || stopPct <= 0) {
    return {
      costR: AI_TRADE_COST_DECLARED_R,
      feeR: AI_TRADE_COST_FEE_R,
      spreadR: AI_TRADE_COST_SPREAD_CEILING_R,
      underlyingSpreadR: AI_TRADE_COST_SPREAD_CEILING_R,
      certSpreadR: 0,
      stopPct: null,
      leverage,
      estimatedSpread: false,
      spreadAtFloor: false,
      costSource: 'declared_ceiling',
      detail: DECLARED_DETAIL,
    };
  }

  const measured = spreadFromBars(input.bars);
  const underlying = round4(
    measured === null
      ? AI_TRADE_COST_SPREAD_CEILING_R
      : Math.min(measured / stopPct, AI_TRADE_COST_SPREAD_CEILING_R)
  );
  const cert = round4(
    leverage === null
      ? 0
      : (2 * SHADOW_V2_HYPOTHESES.KO_SPREAD_CERT_PCT_PER_SIDE) / (leverage * stopPct)
  );
  const spread = round4(Math.min(underlying + cert, AI_TRADE_COST_TOTAL_CEILING_R));

  const costSource: AiTradeCostSource =
    measured !== null
      ? leverage !== null
        ? 'per_row_cs_leverage'
        : 'per_row_cs'
      : leverage !== null
        ? 'per_row_leverage'
        : 'declared_ceiling';

  const spreadAtFloor = measured === 0;
  const parts = [
    `fee ${AI_TRADE_COST_FEE_R} R`,
    measured === null
      ? `spread sottostante al tetto ${underlying} R (barre assenti)`
      : `spread sottostante stimato ${underlying} R (Corwin-Schultz / stop ${round4(stopPct * 100)}%)` +
        (spreadAtFloor ? ' al pavimento: stima non distinguibile da zero' : ''),
    leverage === null
      ? 'spread certificato non conteggiato: leva non nota'
      : `spread certificato ${cert} R (leva ${leverage})`,
  ];
  if (underlying + cert > AI_TRADE_COST_TOTAL_CEILING_R) {
    parts.push(`spread complessivo limitato al tetto ${AI_TRADE_COST_TOTAL_CEILING_R} R`);
  }

  return {
    costR: round4(AI_TRADE_COST_FEE_R + spread),
    feeR: AI_TRADE_COST_FEE_R,
    spreadR: spread,
    underlyingSpreadR: underlying,
    certSpreadR: cert,
    stopPct,
    leverage,
    estimatedSpread: measured !== null,
    spreadAtFloor,
    costSource,
    detail: parts.join(' + '),
  };
}
