/**
 * SHADOW V1 LIVE — nucleo puro del lifecycle di un setup emesso dal radar.
 *
 * SOLO CALCOLO: nessun I/O, nessuna rete, nessun orologio globale, nessuno stato
 * globale. Tutti gli istanti arrivano dal chiamante (`decidedAtMs`, `nowMs`,
 * `sessionCloseMs`). Il modulo non e' importato dal radar, dal client o dal server:
 * e' la base di misura di una fase successiva.
 *
 * Metodo, con le fonti nel repository:
 * - Fill (D1): limit-fill. Il setup e' filled alla prima barra chiusa successiva
 *   alla decisione che tocca l'entry: long se `h >= entry`, short se `l <= entry`.
 *   L'ingresso e' registrato al livello `entry` del setup, come nel metodo storico
 *   (`scripts/shadow_report.ts:118`): un'apertura oltre il livello non migliora il
 *   prezzo di ingresso registrato.
 * - Target (D3): si usa il `target1Level` effettivo del setup. Il metodo storico
 *   misurava a `k = 1.6` multipli di rischio (`scripts/shadow_report.ts:39, 184`);
 *   poiche' oggi `TRADING_PARAMS.T1_R = 1.6` (`src/config/tradingParams.ts:221`) le
 *   due misure coincidono, ma con un `target1Multiplier` diverso da 1.6 questo
 *   risultato NON e' omogeneo con l'artefatto storico V1 che usa k = 1.6.
 * - Stop prima del target sulla stessa barra (D6), come `walkR`
 *   (`scripts/shadow_report.ts:120-123`). Stop raggiunto in gap: −1 R, come `walkR`.
 * - Terminazione (D2/D9): a sessione finita, uscita al close dell'ultima barra
 *   chiusa disponibile (EXPIRED). Nessuna barra utile e sessione finita: NOT_FILLED
 *   (D7), senza R.
 * - Deduplica (D4): `ticker|entry|stop|giorno UTC`, giorno da `decidedAtMs`, regola
 *   "prima emissione" come `scripts/emission_guard.ts:33-41`.
 *
 * Barra chiusa e della sessione: `t + barMs <= nowMs` e `t + barMs <= sessionCloseMs`,
 * con `barMs = IND_BAR_MS` (`src/config/tradingParams.ts:335`); stessa validita' OHLC
 * di `filterClosedBarsV2` (`src/knowledge/shadowV2.ts:168-182`). Le barre con
 * `t <= decidedAtMs` sono escluse: il cammino parte dalla prima barra successiva.
 * Barre duplicate sullo stesso `t`: vince l'ultima in ordine di input, convenzione di
 * `recordClosedBarsForShadowV2` (`src/server/shadowV2Collector.ts:41-57`); l'input non
 * viene mai mutato.
 *
 * Limite noto: il chiamante deve fornire `sessionCloseMs` corretto per fuso, ora
 * legale e festivi. Il modulo non conosce calendari e non li inventa.
 */

import { IND_BAR_MS } from '../config/tradingParams';
import type { ExecutionSetup, IndicatorBarInput } from '../types/radar';

/** Barra 5m: sottoinsieme strutturale di IndicatorBarInput, senza il volume. */
export type ShadowV1LiveBar = Pick<IndicatorBarInput, 't' | 'o' | 'h' | 'l' | 'c'>;

/** Sottoinsieme del setup radar realmente usato dal lifecycle. */
export type ShadowV1LiveSetup = Pick<
  ExecutionSetup,
  'decision' | 'direction' | 'entryLevel' | 'triggerLevel' | 'stopLossLevel' | 'target1Level'
> & {
  candidate: Pick<ExecutionSetup['candidate'], 'ticker'>;
};

export interface ShadowV1LiveInput {
  setup: ShadowV1LiveSetup;
  /** Istante di emissione del setup, in millisecondi (D8). */
  decidedAtMs: number;
  /** Istante di chiusura della sessione del simbolo, in millisecondi (D9). */
  sessionCloseMs: number;
  /** Istante di valutazione, in millisecondi: serve a escludere le barre non chiuse. */
  nowMs: number;
  /** Barre note al chiamante, in qualsiasi ordine. Non vengono mutate. */
  bars: readonly ShadowV1LiveBar[];
  /** Chiavi gia' consumate dal chiamante: nessuno stato globale nel modulo (D4). */
  seenKeys?: readonly string[];
}

export type ShadowV1LiveStatus =
  | 'INVALID_SETUP'
  | 'DUPLICATE'
  | 'PENDING_FILL'
  | 'OPEN'
  | 'STOP'
  | 'TARGET'
  | 'EXPIRED'
  | 'NOT_FILLED';

export interface ShadowV1LiveResult {
  status: ShadowV1LiveStatus;
  /** Chiave di deduplica; null quando il setup non e' valido. */
  key: string | null;
  /** Motivazione leggibile per stati non conclusivi o invalidi; null per gli esiti. */
  reason: string | null;
  /** R in unita' di rischio, senza costi; null se non determinabile. */
  r: number | null;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  /** |entry − stop|, in unita' di prezzo; null se non determinabile. */
  riskPerUnit: number | null;
  fillBarTs: number | null;
  exitBarTs: number | null;
  exitPrice: number | null;
}

/** Giorno di calendario UTC di un istante in millisecondi, come `dayOf` del replay. */
export function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Chiave di deduplica approvata: ticker|entry|stop|giorno UTC (D4). */
export function shadowV1LiveKeyOf(
  ticker: string,
  entry: number,
  stop: number,
  decidedAtMs: number
): string {
  return `${ticker}|${entry}|${stop}|${utcDayOf(decidedAtMs)}`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidBar(b: ShadowV1LiveBar): boolean {
  return (
    isFiniteNumber(b.t) &&
    b.t > 0 &&
    isFiniteNumber(b.o) &&
    isFiniteNumber(b.h) &&
    isFiniteNumber(b.l) &&
    isFiniteNumber(b.c) &&
    b.o > 0 &&
    b.h > 0 &&
    b.l > 0 &&
    b.c > 0 &&
    b.h >= b.l
  );
}

/** Barre utilizzabili: chiuse, della sessione, successive alla decisione, ordinate e deduplicate. */
function usableBars(
  bars: readonly ShadowV1LiveBar[],
  decidedAtMs: number,
  sessionCloseMs: number,
  nowMs: number
): ShadowV1LiveBar[] {
  const byTs = new Map<number, ShadowV1LiveBar>();
  for (const b of bars) {
    if (!isValidBar(b)) continue;
    if (!(b.t > decidedAtMs)) continue;
    if (b.t + IND_BAR_MS > sessionCloseMs) continue;
    if (b.t + IND_BAR_MS > nowMs) continue;
    byTs.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  return Array.from(byTs.values()).sort((x, y) => x.t - y.t);
}

function invalid(reason: string): ShadowV1LiveResult {
  return {
    status: 'INVALID_SETUP',
    key: null,
    reason,
    r: null,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    riskPerUnit: null,
    fillBarTs: null,
    exitBarTs: null,
    exitPrice: null,
  };
}

/**
 * Valuta il lifecycle di un setup su barre chiuse note.
 *
 * Deterministico: stesso input -> stesso output. Non legge l'orologio e non tiene
 * memoria fra le chiamate; la deduplica richiede che il chiamante passi `seenKeys`.
 */
export function evaluateShadowV1Live(input: ShadowV1LiveInput): ShadowV1LiveResult {
  const { setup, decidedAtMs, sessionCloseMs, nowMs, bars } = input;

  const ticker = setup?.candidate?.ticker;
  const entryLevel = setup?.entryLevel ?? setup?.triggerLevel ?? null;
  const stopLossLevel = setup?.stopLossLevel ?? null;
  const target1Level = setup?.target1Level ?? null;
  const direction = setup?.direction;
  const decision = setup?.decision;

  // Ordine di validazione (D5), motivazioni distinte e leggibili.
  if (!isFiniteNumber(entryLevel)) return invalid('entry mancante o non finito');
  if (!isFiniteNumber(stopLossLevel)) return invalid('stop mancante o non finito');
  if (!isFiniteNumber(target1Level)) return invalid('target1Level mancante o non finito');
  if (typeof ticker !== 'string' || ticker.length === 0) return invalid('ticker vuoto o non stringa');
  if (direction !== 'LONG' && direction !== 'SHORT') return invalid('direction assente o NESSUNA');
  if (decision !== 'TRADE') return invalid('setup non emesso (decision diversa da TRADE)');
  if (!isFiniteNumber(decidedAtMs)) return invalid('decidedAtMs non finito');
  if (!isFiniteNumber(sessionCloseMs)) return invalid('sessionCloseMs non finito');
  if (!isFiniteNumber(nowMs)) return invalid('nowMs non finito');

  const risk = Math.abs(entryLevel - stopLossLevel);
  if (!(risk > 0)) return invalid('distanza entry-stop nulla: R non definito');

  const key = shadowV1LiveKeyOf(ticker, entryLevel, stopLossLevel, decidedAtMs);

  const seen = input.seenKeys ?? [];
  if (seen.includes(key)) {
    return {
      status: 'DUPLICATE',
      key,
      reason: 'emissione gia\' vista (ticker|entry|stop|giorno UTC)',
      r: null,
      entryPrice: entryLevel,
      stopPrice: stopLossLevel,
      targetPrice: target1Level,
      riskPerUnit: risk,
      fillBarTs: null,
      exitBarTs: null,
      exitPrice: null,
    };
  }

  const usable = usableBars(bars ?? [], decidedAtMs, sessionCloseMs, nowMs);
  const sessionOver = nowMs >= sessionCloseMs;
  const dir = direction === 'LONG' ? 1 : -1;
  const targetR = Math.abs(target1Level - entryLevel) / risk;

  let filled = false;
  let fillBarTs: number | null = null;
  let status: 'STOP' | 'TARGET' | null = null;
  let exitBarTs: number | null = null;
  let exitPrice: number | null = null;
  let r: number | null = null;

  for (const bar of usable) {
    if (!filled) {
      const touches = dir === 1 ? bar.h >= entryLevel : bar.l <= entryLevel;
      if (!touches) continue;
      filled = true;
      fillBarTs = bar.t;
    }

    // D6: la barra di fill entra nella verifica; lo stop ha la precedenza.
    const hitStop = dir === 1 ? bar.l <= stopLossLevel : bar.h >= stopLossLevel;
    if (hitStop) {
      status = 'STOP';
      exitBarTs = bar.t;
      exitPrice = stopLossLevel;
      r = -1;
      break;
    }

    const hitTarget = dir === 1 ? bar.h >= target1Level : bar.l <= target1Level;
    if (hitTarget) {
      status = 'TARGET';
      exitBarTs = bar.t;
      exitPrice = target1Level;
      r = targetR;
      break;
    }
  }

  if (!filled) {
    return {
      status: sessionOver ? 'NOT_FILLED' : 'PENDING_FILL',
      key,
      reason: sessionOver
        ? 'sessione finita: l\'entry non e\' stato toccato da nessuna barra chiusa successiva alla decisione'
        : 'nessun fill: l\'entry non e\' ancora stato toccato',
      r: null,
      entryPrice: entryLevel,
      stopPrice: stopLossLevel,
      targetPrice: target1Level,
      riskPerUnit: risk,
      fillBarTs: null,
      exitBarTs: null,
      exitPrice: null,
    };
  }

  if (status !== null) {
    return {
      status,
      key,
      reason: null,
      r,
      entryPrice: entryLevel,
      stopPrice: stopLossLevel,
      targetPrice: target1Level,
      riskPerUnit: risk,
      fillBarTs,
      exitBarTs,
      exitPrice,
    };
  }

  if (sessionOver) {
    // D2: uscita al close dell'ultima barra chiusa disponibile (almeno la barra di fill).
    const last = usable[usable.length - 1];
    return {
      status: 'EXPIRED',
      key,
      reason: null,
      r: (dir * (last.c - entryLevel)) / risk,
      entryPrice: entryLevel,
      stopPrice: stopLossLevel,
      targetPrice: target1Level,
      riskPerUnit: risk,
      fillBarTs,
      exitBarTs: last.t,
      exitPrice: last.c,
    };
  }

  return {
    status: 'OPEN',
    key,
    reason: 'posizione aperta: nessun tocco di stop o target nelle barre chiuse disponibili',
    r: null,
    entryPrice: entryLevel,
    stopPrice: stopLossLevel,
    targetPrice: target1Level,
    riskPerUnit: risk,
    fillBarTs,
    exitBarTs: null,
    exitPrice: null,
  };
}
