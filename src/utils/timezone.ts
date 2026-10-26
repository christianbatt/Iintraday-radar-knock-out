/**
 * Intraday Radar - Gestione Fusi Orari Ufficiali con Intl.DateTimeFormat
 * Europa: 'Europe/Rome'
 * USA: 'America/New_York'
 */

import { TRADING_PARAMS } from '../config/tradingParams';

export interface MarketTimeDetails {
  market: 'EU' | 'US';
  timeZone: string;
  hour: number;
  minute: number;
  second: number;
  totalMinutes: number; // Minuti trascorsi dalle 00:00 nel fuso locale di borsa
  timeFormatted: string; // HH:mm:ss
  dateFormatted: string; // YYYY-MM-DD
  isOrbWindow: boolean;
  isBeforeOrb: boolean;
  isAfterOrb: boolean;
  isSessionActive: boolean;
  orbCloseFormatted: string;
}

export function getExchangeDateStr(market: 'EU' | 'US', date: Date = new Date()): string {
  const timeZone = market === 'US' ? 'America/New_York' : 'Europe/Rome';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

export function getMarketTime(market: 'EU' | 'US', date: Date = new Date()): MarketTimeDetails {
  const timeZone = market === 'US' ? 'America/New_York' : 'Europe/Rome';

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const hour = parseInt(partMap.hour || '0', 10);
  const minute = parseInt(partMap.minute || '0', 10);
  const second = parseInt(partMap.second || '0', 10);
  const totalMinutes = hour * 60 + minute;

  const dateFormatted = `${partMap.year}-${partMap.month}-${partMap.day}`;
  const timeFormatted = `${partMap.hour}:${partMap.minute}:${partMap.second}`;

  let isOrbWindow = false;
  let isBeforeOrb = false;
  let isAfterOrb = false;
  let isSessionActive = false;
  let orbCloseFormatted = '';

  if (market === 'EU') {
    const openM = TRADING_PARAMS.EU_OPEN_HOUR * 60 + TRADING_PARAMS.EU_OPEN_MINUTE;
    const orbEndM = openM + TRADING_PARAMS.ORB_MINUTES;
    const closeM = TRADING_PARAMS.EU_CLOSE_HOUR * 60 + TRADING_PARAMS.EU_CLOSE_MINUTE;

    isBeforeOrb = totalMinutes < orbEndM;
    isOrbWindow = totalMinutes >= openM && totalMinutes < orbEndM;
    isAfterOrb = totalMinutes >= orbEndM;
    isSessionActive = totalMinutes >= openM && totalMinutes <= closeM;
    orbCloseFormatted = '09:15 Rome';
  } else {
    const openM = TRADING_PARAMS.US_OPEN_HOUR * 60 + TRADING_PARAMS.US_OPEN_MINUTE;
    const orbEndM = openM + TRADING_PARAMS.ORB_MINUTES;
    const closeM = TRADING_PARAMS.US_CLOSE_HOUR * 60 + TRADING_PARAMS.US_CLOSE_MINUTE;

    isBeforeOrb = totalMinutes < orbEndM;
    isOrbWindow = totalMinutes >= openM && totalMinutes < orbEndM;
    isAfterOrb = totalMinutes >= orbEndM;
    isSessionActive = totalMinutes >= openM && totalMinutes <= closeM;
    orbCloseFormatted = '09:45 NY';
  }

  return {
    market,
    timeZone,
    hour,
    minute,
    second,
    totalMinutes,
    timeFormatted,
    dateFormatted,
    isOrbWindow,
    isBeforeOrb,
    isAfterOrb,
    isSessionActive,
    orbCloseFormatted,
  };
}

/**
 * Calcola dinamicamente l'istante di chiusura ORB USA (09:45 America/New_York)
 * per una data YYYY-MM-DD usando esclusivamente Intl.DateTimeFormat,
 * restituendo l'orario convertito in Europe/Rome (CET/CEST) e UTC.
 */
export function getUsOrbCloseTimeInfo(sessionDateStr: string): {
  sessionDate: string;
  nyFormatted: string;
  romeFormatted: string;
  utcFormatted: string;
  closeInstant: Date;
} {
  const targetNyMinutes =
    TRADING_PARAMS.US_OPEN_HOUR * 60 + TRADING_PARAMS.US_OPEN_MINUTE + TRADING_PARAMS.ORB_MINUTES;
  const targetHour = Math.floor(targetNyMinutes / 60);
  const targetMinute = targetNyMinutes % 60;

  // Cerca l'istante UTC su quella giornata in cui America/New_York segna esattamente targetHour:targetMinute:00
  const baseUtcMs = Date.parse(`${sessionDateStr}T12:00:00Z`);
  let foundInstant = new Date(baseUtcMs);

  for (let offsetMinutes = -120; offsetMinutes <= 240; offsetMinutes++) {
    const candidate = new Date(baseUtcMs + offsetMinutes * 60_000);
    const mt = getMarketTime('US', candidate);
    if (mt.dateFormatted === sessionDateStr && mt.hour === targetHour && mt.minute === targetMinute) {
      foundInstant = candidate;
      break;
    }
  }

  // Formatta l'istante in Europe/Rome tramite Intl.DateTimeFormat
  const romeParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
  }).formatToParts(foundInstant);
  const rMap: Record<string, string> = {};
  for (const p of romeParts) rMap[p.type] = p.value;
  const tzOffsetStr = rMap.timeZoneName || '';
  const romeTzLabel = tzOffsetStr.includes('+2') ? 'CEST' : 'CET';
  const romeFormatted = `${rMap.hour}:${rMap.minute} ${romeTzLabel}`;

  // Formatta l'istante in UTC tramite Intl.DateTimeFormat
  const utcParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(foundInstant);
  const uMap: Record<string, string> = {};
  for (const p of utcParts) uMap[p.type] = p.value;
  const utcFormatted = `${uMap.hour}:${uMap.minute} UTC`;

  const nyDetails = getMarketTime('US', foundInstant);
  const nyFormatted = `${String(nyDetails.hour).padStart(2, '0')}:${String(nyDetails.minute).padStart(2, '0')} NY`;

  return {
    sessionDate: sessionDateStr,
    nyFormatted,
    romeFormatted,
    utcFormatted,
    closeInstant: foundInstant,
  };
}

/**
 * Converte l'orario di un timestamp o Date nel fuso di Roma
 */
export function formatInRomeTime(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}
