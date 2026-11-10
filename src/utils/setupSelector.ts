/**
 * Selettore calendario macro: funzione PURA che marca il setup con lo stato del
 * calendario. Non legge il flag di configurazione (arriva come parametro `live`)
 * e non tocca nessun campo numerico: aggiunge solo metadati.
 *
 * Con `live === false` ritorna lo stesso riferimento, senza aggiungere proprieta':
 * e' questo che rende l'output bit-identico quando SETUP_SELECTOR_LIVE e' "off".
 */
import type { CalendarStatus, ExecutionSetup, MacroCalendarState } from '../types/radar';

export function applyCalendarSelector<T extends ExecutionSetup>(
  setup: T,
  calendar: MacroCalendarState | undefined,
  live: boolean,
): T & { calendarStatus?: CalendarStatus } {
  // Nessuna proprieta' aggiunta, nessun array ricreato: stessa identita'.
  if (!live) {
    return setup;
  }

  if (calendar === undefined) {
    return {
      ...setup,
      calendarStatus: 'absent',
      reasonCodes: [...(setup.reasonCodes ?? []), 'CALENDAR_ABSENT'],
    };
  }

  if (calendar.status === 'unavailable') {
    // Marcatura di degrado, non un gate: il setup resta valido e non viene scartato.
    return {
      ...setup,
      calendarStatus: 'unavailable',
      reasonCodes: [...(setup.reasonCodes ?? []), 'CALENDAR_UNAVAILABLE'],
    };
  }

  return { ...setup, calendarStatus: 'ok' };
}
