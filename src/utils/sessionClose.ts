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
 * cadono in ore notturne: 17:30 Rome e 16:00 New York (o 13:00 nelle mezze
 * giornate US) non sono mai orari ambigui o inesistenti. La guardia di rilettura
 * resta comunque attiva.
 *
 * Calendario di borsa (P1.4):
 * - Esclude sabato, domenica e le festivita' ufficiali annuali di mercato:
 *   - US (NYSE/Nasdaq): Capodanno (osservato), MLK Day, Presidents' Day,
 *     Venerdi' Santo, Memorial Day, Juneteenth (dal 2022, osservato), 4 luglio
 *     (osservato), Labor Day, Thanksgiving, Natale (osservato).
 *   - EU (borse cash europee principali, es. Borsa Italiana / Xetra / Euronext):
 *     Capodanno, Venerdi' Santo, Lunedi' dell'Angelo, 1 maggio, Vigilia di Natale
 *     (24/12), Natale (25/12), Santo Stefano (26/12), San Silvestro (31/12).
 * - Mezze giornate US (chiusura anticipata alle 13:00 America/New_York):
 *   - 3 luglio se cade lunedi'-giovedi' (vigilia di Independence Day, quando il
 *     4 luglio e' mar-ven), venerdi' dopo Thanksgiving (Black Friday), e 24
 *     dicembre se cade lunedi'-giovedi'.
 * - Limiti residui dichiarati:
 *   - Festivita' straordinarie una tantum (es. lutto nazionale) o differenze fra
 *     singole piazze EU locali (es. 15 agosto attivo su Xetra ma non su MTA) non
 *     sono modellate qui e dipendono dal feed di borsa.
 *   - Chiusura piena (campanella), non la barriera di V2 a `close - 15 min`
 *     (`src/knowledge/shadowV2.ts:56, :832`, `EXIT_BEFORE_CLOSE_MIN`).
 */

import { TRADING_PARAMS } from '../config/tradingParams';

export type SessionMarket = 'EU' | 'US';

export interface SessionSchedule {
  closed: boolean;
  earlyClose: boolean;
  closeMinutes: number | null;
  reason: string | null;
}

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

const US_EARLY_CLOSE_MINUTES = 13 * 60;

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

function weekdayUtc(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay();
}

/** Pasqua gregoriana (algoritmo anonimo di Meeus/Jones/Butcher), come timestamp UTC a mezzogiorno. */
function gregorianEasterUtcNoonMs(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day, 12, 0, 0);
}

function isSameUtcDate(ms: number, year: number, month: number, day: number): boolean {
  const d = new Date(ms);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function isNthWeekdayOfMonth(
  year: number,
  month: number,
  day: number,
  targetMonth: number,
  targetWeekday: number,
  nth: number
): boolean {
  if (month !== targetMonth) return false;
  if (weekdayUtc(year, month, day) !== targetWeekday) return false;
  return Math.floor((day - 1) / 7) + 1 === nth;
}

function isLastWeekdayOfMonth(
  year: number,
  month: number,
  day: number,
  targetMonth: number,
  targetWeekday: number
): boolean {
  if (month !== targetMonth) return false;
  if (weekdayUtc(year, month, day) !== targetWeekday) return false;
  const nextWeek = new Date(Date.UTC(year, month - 1, day + 7, 12, 0, 0));
  return nextWeek.getUTCMonth() !== month - 1;
}

/** Festivita' fissa NYSE/Nasdaq con regola di osservanza ven/lun (eccetto 1 gen di sabato: ven 31 dic resta aperto). */
function matchesUsObservedFixedHoliday(
  year: number,
  month: number,
  day: number,
  holidayMonth: number,
  holidayDay: number,
  observeFridayIfSaturday: boolean
): boolean {
  const wd = weekdayUtc(year, holidayMonth, holidayDay);
  if (month === holidayMonth && day === holidayDay && wd >= 1 && wd <= 5) return true;
  if (wd === 0) {
    // Domenica -> osservato lunedi' successivo
    const obs = new Date(Date.UTC(year, holidayMonth - 1, holidayDay + 1, 12, 0, 0));
    if (obs.getUTCMonth() === month - 1 && obs.getUTCDate() === day && obs.getUTCFullYear() === year) {
      return true;
    }
  }
  if (wd === 6 && observeFridayIfSaturday) {
    // Sabato -> osservato venerdi' precedente
    const obs = new Date(Date.UTC(year, holidayMonth - 1, holidayDay - 1, 12, 0, 0));
    if (obs.getUTCMonth() === month - 1 && obs.getUTCDate() === day && obs.getUTCFullYear() === year) {
      return true;
    }
  }
  return false;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pianificazione della sessione regolare per `market` e `sessionDate` (`YYYY-MM-DD`).
 * Deterministica e pura: non legge l'orologio globale.
 */
export function getSessionSchedule(market: SessionMarket, sessionDate: string): SessionSchedule {
  if (market !== 'EU' && market !== 'US') {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'invalid_market' };
  }
  const parsed = parseSessionDate(sessionDate);
  if (parsed === null) {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'invalid_date' };
  }

  const { year, month, day } = parsed;
  const weekday = weekdayUtc(year, month, day);
  if (weekday === 0 || weekday === 6) {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'weekend' };
  }

  const easterNoon = gregorianEasterUtcNoonMs(year);
  const goodFridayNoon = easterNoon - 2 * DAY_MS;
  const easterMondayNoon = easterNoon + 1 * DAY_MS;

  if (market === 'EU') {
    if (month === 1 && day === 1) {
      return { closed: true, earlyClose: false, closeMinutes: null, reason: 'eu_new_years_day' };
    }
    if (isSameUtcDate(goodFridayNoon, year, month, day)) {
      return { closed: true, earlyClose: false, closeMinutes: null, reason: 'eu_good_friday' };
    }
    if (isSameUtcDate(easterMondayNoon, year, month, day)) {
      return { closed: true, earlyClose: false, closeMinutes: null, reason: 'eu_easter_monday' };
    }
    if (month === 5 && day === 1) {
      return { closed: true, earlyClose: false, closeMinutes: null, reason: 'eu_labour_day' };
    }
    if (month === 12 && (day === 24 || day === 25 || day === 26 || day === 31)) {
      return { closed: true, earlyClose: false, closeMinutes: null, reason: 'eu_year_end_holiday' };
    }
    return {
      closed: false,
      earlyClose: false,
      closeMinutes: closeMinutesOf('EU'),
      reason: null,
    };
  }

  // US (NYSE / Nasdaq)
  if (matchesUsObservedFixedHoliday(year, month, day, 1, 1, false)) {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'us_new_years_day' };
  }
  if (isNthWeekdayOfMonth(year, month, day, 1, 1, 3)) {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'us_mlk_day' };
  }
  if (isNthWeekdayOfMonth(year, month, day, 2, 1, 3)) {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'us_presidents_day' };
  }
  if (isSameUtcDate(goodFridayNoon, year, month, day)) {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'us_good_friday' };
  }
  if (isLastWeekdayOfMonth(year, month, day, 5, 1)) {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'us_memorial_day' };
  }
  if (year >= 2022 && matchesUsObservedFixedHoliday(year, month, day, 6, 19, true)) {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'us_juneteenth' };
  }
  if (matchesUsObservedFixedHoliday(year, month, day, 7, 4, true)) {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'us_independence_day' };
  }
  if (isNthWeekdayOfMonth(year, month, day, 9, 1, 1)) {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'us_labor_day' };
  }
  if (isNthWeekdayOfMonth(year, month, day, 11, 4, 4)) {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'us_thanksgiving' };
  }
  if (matchesUsObservedFixedHoliday(year, month, day, 12, 25, true)) {
    return { closed: true, earlyClose: false, closeMinutes: null, reason: 'us_christmas' };
  }

  // US Early closes (13:00 America/New_York):
  // 1) 3 luglio se lun-gio (il 4 luglio e' mar-ven)
  if (month === 7 && day === 3 && weekday >= 1 && weekday <= 4) {
    return {
      closed: false,
      earlyClose: true,
      closeMinutes: US_EARLY_CLOSE_MINUTES,
      reason: 'us_early_close_july3',
    };
  }
  // 2) Venerdi' successivo a Thanksgiving (Black Friday)
  if (month === 11 && weekday === 5 && isNthWeekdayOfMonth(year, 11, day - 1, 11, 4, 4)) {
    return {
      closed: false,
      earlyClose: true,
      closeMinutes: US_EARLY_CLOSE_MINUTES,
      reason: 'us_early_close_black_friday',
    };
  }
  // 3) 24 dicembre se lun-gio
  if (month === 12 && day === 24 && weekday >= 1 && weekday <= 4) {
    return {
      closed: false,
      earlyClose: true,
      closeMinutes: US_EARLY_CLOSE_MINUTES,
      reason: 'us_early_close_christmas_eve',
    };
  }

  return {
    closed: false,
    earlyClose: false,
    closeMinutes: closeMinutesOf('US'),
    reason: null,
  };
}

/**
 * Istante UTC (ms) in cui l'orologio locale del mercato raggiunge l'orario di
 * chiusura regolare di `sessionDate` (`YYYY-MM-DD`, data locale del mercato).
 *
 * Restituisce `null` per sabato, domenica, festivita' di mercato, date
 * malformate o inesistenti, e per orari locali non rappresentabili. Nelle
 * mezze giornate US restituisce le 13:00 America/New_York. Non legge l'orologio.
 */
export function sessionCloseMsFor(market: SessionMarket, sessionDate: string): number | null {
  if (market !== 'EU' && market !== 'US') return null;
  const parsed = parseSessionDate(sessionDate);
  if (parsed === null) return null;

  const schedule = getSessionSchedule(market, sessionDate);
  if (schedule.closed || schedule.closeMinutes === null) return null;

  const closeMin = schedule.closeMinutes;
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
