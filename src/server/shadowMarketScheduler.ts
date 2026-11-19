/**
 * SHADOW MARKET SCHEDULER — selezione oraria dei mercati attivi per scansione passiva.
 *
 * Deterministico e puro: usa il calendario festivo/early-close di `sessionClose.ts`
 * e le costanti di apertura/chiusura di `TRADING_PARAMS`. Nessuna chiamata fuori orario
 * cash, nei weekend o nei giorni festivi, e filtro selettivo sui soli mercati aperti per
 * contenere la quota API Yahoo Finance.
 */

import { TRADING_PARAMS } from '../config/tradingParams';
import type { UnderlyingItem } from '../types/radar';
import {
  getSessionSchedule,
  sessionDateFor,
  type SessionMarket,
} from '../utils/sessionClose';

/** Intervallo standard tra scansioni passive di background (10 minuti: cattura ogni finestra ORB G5 da 60m). */
export const SHADOW_MARKET_SCAN_INTERVAL_MS = 10 * 60_000;

/** Posticipo minimo dall'apertura prima della prima barra 5m utile. */
const OPEN_WARMUP_OFFSET_MIN = 5;
/** Estensione oltre la campanella di chiusura per cogliere l'ultima barra delayed. */
const CLOSE_SETTLE_BUFFER_MIN = 5;

const TIMEZONES: Record<SessionMarket, string> = {
  EU: 'Europe/Rome',
  US: 'America/New_York',
};

const timeFormatters: Record<SessionMarket, Intl.DateTimeFormat> = {
  EU: new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONES.EU,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }),
  US: new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONES.US,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }),
};

function localMinutesOf(market: SessionMarket, nowMs: number): number | null {
  if (!Number.isFinite(nowMs)) return null;
  const parts = timeFormatters[market].formatToParts(new Date(nowMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const h = parseInt(map.hour ?? '', 10);
  const m = parseInt(map.minute ?? '', 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function isMarketScanWindowOpen(market: SessionMarket, nowMs: number): boolean {
  const sessionDate = sessionDateFor(market, nowMs);
  if (!sessionDate) return false;
  const sched = getSessionSchedule(market, sessionDate);
  if (sched.closed || sched.closeMinutes === null) return false;

  const currentMin = localMinutesOf(market, nowMs);
  if (currentMin === null) return false;

  const openMin =
    (market === 'US'
      ? TRADING_PARAMS.US_OPEN_HOUR * 60 + TRADING_PARAMS.US_OPEN_MINUTE
      : TRADING_PARAMS.EU_OPEN_HOUR * 60 + TRADING_PARAMS.EU_OPEN_MINUTE) +
    OPEN_WARMUP_OFFSET_MIN;
  const closeMin = sched.closeMinutes + CLOSE_SETTLE_BUFFER_MIN;

  return currentMin >= openMin && currentMin <= closeMin;
}

/** Ritorna i mercati cash attualmente nella finestra utile di scansione passiva. */
export function getActiveMarketsAt(nowMs: number): SessionMarket[] {
  const active: SessionMarket[] = [];
  if (isMarketScanWindowOpen('EU', nowMs)) active.push('EU');
  if (isMarketScanWindowOpen('US', nowMs)) active.push('US');
  return active;
}

/** Filtra il paniere ai soli titoli appartenenti a mercati aperti in quell'istante. */
export function filterUnderlyingsForActiveMarkets(
  underlyings: readonly UnderlyingItem[],
  nowMs: number
): { activeMarkets: SessionMarket[]; items: UnderlyingItem[] } {
  const activeMarkets = getActiveMarketsAt(nowMs);
  if (activeMarkets.length === 0) {
    return { activeMarkets, items: [] };
  }
  const activeSet = new Set<SessionMarket>(activeMarkets);
  const items = underlyings.filter((u) => activeSet.has(u.mercato));
  return { activeMarkets, items };
}
