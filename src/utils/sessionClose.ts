/**
 * SESSION CLOSE — istante di chiusura della sessione regolare per EU e US.
 *
 * Nucleo puro: nessun I/O, nessuna rete, nessun orologio globale. Tutti gli istanti
 * arrivano dal chiamante e gli orari di chiusura vengono dalle costanti esistenti
 * (`TRADING_PARAMS.EU_CLOSE_HOUR/MINUTE` = 17:30, `US_CLOSE_HOUR/MINUTE` = 16:00,
 * `src/config/tradingParams.ts:260-265`): qui non si duplica nessun valore.
 *
 * Conversione di fuso: `Intl.DateTimeFormat` con `timeZone` esplicito
 * (`Europe/Rome` per EU, `America/New_York` per US), quindi l'ora legale e' gestita
 * dall'engine e non da tabelle scritte a mano. L'offset viene risolto in modo
 * deterministico: si parte dall'ora locale desiderata interpretata come UTC, si
 * sottrae l'offset locale a quell'istante e si ripete la correzione (l'offset cambia
 * di al massimo un'ora, quindi due/tre iterazioni convergono). Il risultato viene
 * poi riletto in ora locale: se non corrisponde esattamente alla data e all'orario
 * richiesti (orario locale inesistente, caso teorico di cambio ora), si restituisce
 * `null`.
 *
 * Cambi d'ora: le transizioni EU e US avvengono di domenica (ultima domenica di
 * marzo / ottobre in EU; seconda domenica di marzo / prima di novembre in US) e
 * cadono in ore notturne: 17:30 Rome e 16:00 New York non sono mai orari ambigui o
 * inesistenti. La guardia di rilettura resta comunque attiva.
 *
 * Limiti dichiarati (E2):
 * - Nessun calendario di festivita' e nessuna mezza giornata: si escludono soltanto
 *   sabato e domenica, gli unici giorni determinabili senza calendario. In un
 *   festivo o in una mezza giornata questa funzione restituisce comunque un istante:
 *   il chiamante deve sapere che quel giorno non arriveranno barre (o arriveranno
 *   solo fino alla chiusura anticipata) e che il nucleo produrra' `NOT_FILLED`.
 * - Chiusura piena (campanella), non la barriera di V2 a `close - 15 min`
 *   (`src/knowledge/shadowV2.ts:56, :832`, `EXIT_BEFORE_CLOSE_MIN`). I due metodi
 *   non sono omogenei e non vanno confrontati come se lo fossero.
 */

import { TRADING_PARAMS } from '../config/tradingParams';

export type SessionMarket = 'EU' | 'US';

const MARKET_TIMEZONE: Record<SessionMarket, string> = {
  EU: 'Europe/Rome',
  US: 'America/New_York',
};

const formatters: Record<SessionMarket, Intl.DateTimeFormat> = {
  EU: new Intl.DateTimeFormat('en-GB', {
    timeZone: MARKET_TIMEZONE.EU,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }),
  US: new Intl.DateTimeFormat('en-GB', {
    timeZone: MARKET_TIMEZONE.US,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }),
};

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(market: SessionMarket, instantMs: number): LocalParts {
  const parts = formatters[market].formatToParts(new Date(instantMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: parseInt(map.year ?? '0', 10),
    month: parseInt(map.month ?? '0', 10),
    day: parseInt(map.day ?? '0', 10),
    hour: parseInt(map.hour ?? '0', 10),
    minute: parseInt(map.minute ?? '0', 10),
    second: parseInt(map.second ?? '0', 10),
  };
}

/** Offset `locale - UTC` in millisecondi per un istante, al secondo esatto. */
function offsetMsAt(market: SessionMarket, instantMs: number): number {
  const p = localParts(market, instantMs);
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const instantSec = Math.floor(instantMs / 1000) * 1000;
  return localAsUtc - instantSec;
}

/** Minuti dalla mezzanotte locale dell'orario di chiusura, dalle costanti del progetto. */
function closeMinutesOf(market: SessionMarket): number {
  return market === 'US'
    ? TRADING_PARAMS.US_CLOSE_HOUR * 60 + TRADING_PARAMS.US_CLOSE_MINUTE
    : TRADING_PARAMS.EU_CLOSE_HOUR * 60 + TRADING_PARAMS.EU_CLOSE_MINUTE;
}

const SESSION_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Data `YYYY-MM-DD` valida e realmente esistente (round-trip), altrimenti null. */
function parseSessionDate(sessionDate: string): { year: number; month: number; day: number } | null {
  if (typeof sessionDate !== 'string') return null;
  const m = SESSION_DATE_RE.exec(sessionDate);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null; // es. 2026-02-30
  }
  return { year, month, day };
}

/**
 * Istante UTC (ms) in cui l'orologio locale del mercato raggiunge l'orario di
 * chiusura regolare di `sessionDate` (`YYYY-MM-DD`, data locale del mercato).
 *
 * Restituisce `null` per sabato, domenica, date malformate o inesistenti, e per
 * orari locali non rappresentabili (guardia di rilettura). Non legge l'orologio.
 */
export function sessionCloseMsFor(market: SessionMarket, sessionDate: string): number | null {
  if (market !== 'EU' && market !== 'US') return null;
  const parsed = parseSessionDate(sessionDate);
  if (parsed === null) return null;

  const weekday = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12, 0, 0)).getUTCDay();
  if (weekday === 0 || weekday === 6) return null; // domenica, sabato

  const closeMin = closeMinutesOf(market);
  const targetHour = Math.floor(closeMin / 60);
  const targetMinute = closeMin % 60;
  const localAsUtc = Date.UTC(parsed.year, parsed.month - 1, parsed.day, targetHour, targetMinute, 0);

  let instant = localAsUtc;
  for (let i = 0; i < 3; i++) {
    instant = localAsUtc - offsetMsAt(market, instant);
  }

  // Rilettura: deve essere esattamente la data e l'orario richiesti in ora locale.
  const check = localParts(market, instant);
  if (
    check.year !== parsed.year ||
    check.month !== parsed.month ||
    check.day !== parsed.day ||
    check.hour !== targetHour ||
    check.minute !== targetMinute ||
    check.second !== 0
  ) {
    return null;
  }

  return instant;
}

/**
 * Data locale del mercato (`YYYY-MM-DD`) a cui appartiene un istante UTC.
 * `null` se l'istante non e' finito. Non legge l'orologio.
 */
export function sessionDateFor(market: SessionMarket, instantMs: number): string | null {
  if (market !== 'EU' && market !== 'US') return null;
  if (typeof instantMs !== 'number' || !Number.isFinite(instantMs)) return null;
  const p = localParts(market, instantMs);
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${p.year}-${mm}-${dd}`;
}
