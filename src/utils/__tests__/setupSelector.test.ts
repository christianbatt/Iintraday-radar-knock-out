/**
 * Test isolati del selettore calendario: funzione pura, nessun import di App o React.
 *
 * Runner: npx tsx src/utils/__tests__/setupSelector.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyCalendarSelector } from '../setupSelector';
import type { MacroCalendarState } from '../../types/radar';

type CalendarLike = Pick<MacroCalendarState, 'status'> & Partial<MacroCalendarState>;

function makeCalendar(status: 'ok' | 'unavailable'): MacroCalendarState {
  const calendar: CalendarLike = {
    status,
    events: [],
    activeBlackoutEvent: null,
    isBlackoutActive: false,
    spreadWarningTradeRepublic: null,
  };
  return calendar as MacroCalendarState;
}

type SetupShape = {
  candidate: { ticker: string };
  decision: 'TRADE';
  direction: 'LONG';
  entryLevel: number;
  triggerLevel: number;
  stopLossLevel: number;
  target1Level: number;
  target2Level: number;
  riskRewardRatio: number;
  selectedLeverage: number;
  estimatedStopLossPct: number;
  atrValue: number;
  gateResults: Record<string, { passed: boolean; label: string }>;
  reasonCodes?: string[];
};

function makeSetup(): SetupShape {
  return {
    candidate: { ticker: 'TEST' },
    decision: 'TRADE',
    direction: 'LONG',
    entryLevel: 10.5,
    triggerLevel: 10.4,
    stopLossLevel: 10,
    target1Level: 11,
    target2Level: 11.5,
    riskRewardRatio: 2,
    selectedLeverage: 5,
    estimatedStopLossPct: 4.76,
    atrValue: 0.3,
    gateResults: { G1: { passed: true, label: 'vwap' } },
  };
}

function numericSnapshot(setup: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(setup)) {
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

describe('applyCalendarSelector - live=false', () => {
  it('ritorna lo STESSO riferimento e non aggiunge chiavi', () => {
    const setup = makeSetup();
    const before = JSON.parse(JSON.stringify(setup));

    const result = applyCalendarSelector(setup, makeCalendar('unavailable'), false);

    assert.equal(result, setup, 'identita referenziale persa');
    assert.deepEqual(Object.keys(result).sort(), Object.keys(setup).sort());
    assert.equal('calendarStatus' in result, false, 'calendarStatus aggiunto con flag off');
    assert.equal('reasonCodes' in result, false, 'reasonCodes aggiunto con flag off');
    assert.deepEqual(JSON.parse(JSON.stringify(setup)), before, 'setup mutato con flag off');
  });

  it('ignora anche calendar undefined (nessuna marcatura)', () => {
    const setup = makeSetup();
    const result = applyCalendarSelector(setup, undefined, false);

    assert.equal(result, setup);
    assert.equal('calendarStatus' in result, false);
    assert.equal('reasonCodes' in result, false);
  });
});

describe('applyCalendarSelector - live=true', () => {
  it('calendar undefined -> calendarStatus absent + CALENDAR_ABSENT', () => {
    const setup = makeSetup();
    const numericBefore = numericSnapshot(setup);

    const result = applyCalendarSelector(setup, undefined, true) as typeof setup & {
      calendarStatus?: string;
      reasonCodes?: string[];
    };

    assert.equal(result.calendarStatus, 'absent');
    assert.deepEqual(result.reasonCodes, ['CALENDAR_ABSENT']);
    assert.deepEqual(numericSnapshot(result), numericBefore, 'campo numerico cambiato');
    assert.equal(result.decision, 'TRADE');
    assert.equal('calendarStatus' in setup, false, 'setup originale mutato');
  });

  it('unavailable -> calendarStatus unavailable + CALENDAR_UNAVAILABLE, setup NON scartato', () => {
    const setup = makeSetup();
    const numericBefore = numericSnapshot(setup);

    const result = applyCalendarSelector(setup, makeCalendar('unavailable'), true) as typeof setup & {
      calendarStatus?: string;
      reasonCodes?: string[];
    };

    assert.equal(result.calendarStatus, 'unavailable');
    assert.deepEqual(result.reasonCodes, ['CALENDAR_UNAVAILABLE']);
    assert.equal(result.decision, 'TRADE', 'il setup e stato declassato a NESSUN_TRADE');
    assert.deepEqual(result.gateResults, setup.gateResults, 'gateResults modificati');
    assert.deepEqual(numericSnapshot(result), numericBefore, 'campo numerico cambiato');
  });

  it('ok -> calendarStatus ok e NESSUN reason code aggiunto', () => {
    const setup = makeSetup();
    const numericBefore = numericSnapshot(setup);

    const result = applyCalendarSelector(setup, makeCalendar('ok'), true) as typeof setup & {
      calendarStatus?: string;
    };

    assert.equal(result.calendarStatus, 'ok');
    assert.equal('reasonCodes' in result, false, 'reasonCodes aggiunto con status ok');
    assert.deepEqual(numericSnapshot(result), numericBefore, 'campo numerico cambiato');
  });

  it('reasonCodes preesistenti vengono accodati, non sostituiti', () => {
    const setup = { ...makeSetup(), reasonCodes: ['PRE_EXISTING'] };

    const result = applyCalendarSelector(setup, makeCalendar('unavailable'), true) as typeof setup & {
      reasonCodes?: string[];
    };

    assert.deepEqual(result.reasonCodes, ['PRE_EXISTING', 'CALENDAR_UNAVAILABLE']);
  });
});
