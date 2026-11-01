import { getMacroBlackoutStatus } from '../src/utils/calculator';
import { MacroEvent } from '../src/types/radar';

console.log('--- TEST MACRO CALENDAR & DYNAMIC BLACKOUT ---');

// 1. Weekend Test (Sunday, 1 November 2026)
const sundayDate = new Date('2026-11-01T14:30:00Z');
const sundayStatus = getMacroBlackoutStatus([], sundayDate);
console.log('1. Weekend Sunday status:', sundayStatus);
if (sundayStatus.isBlackoutActive !== false) {
  throw new Error(`Expected isBlackoutActive to be false on Sunday, got ${sundayStatus.isBlackoutActive}`);
}
if (!sundayStatus.label.includes('Mercato Chiuso')) {
  throw new Error(`Expected label to indicate Mercato Chiuso, got "${sundayStatus.label}"`);
}

// 2. Weekday without high-impact events (e.g. Tuesday 2026-11-03 14:30 CET)
const weekdayDate = new Date('2026-11-03T13:30:00Z'); // 14:30 CET
const emptyStatus = getMacroBlackoutStatus([], weekdayDate);
console.log('2. Weekday empty events status:', emptyStatus);
if (emptyStatus.isBlackoutActive !== false) {
  throw new Error(`Expected isBlackoutActive to be false with no events, got ${emptyStatus.isBlackoutActive}`);
}

// 3. Weekday with real scheduled event: US CPI at 14:30 CET
const sampleEvent: MacroEvent = {
  id: 'us-cpi-test',
  timeCET: '14:30',
  event: 'US Consumer Price Index (CPI)',
  currency: 'USD',
  impact: 'HIGH',
  description: 'Inflazione USA',
  isBlackoutNow: false,
  minutesToEvent: 0,
};

// 3a. 14:10 CET (20 minutes before -> blackout should NOT be active)
const time1410 = new Date('2026-11-04T13:10:00Z'); // 14:10 CET
const status1410 = getMacroBlackoutStatus([sampleEvent], time1410);
if (status1410.isBlackoutActive !== false) {
  throw new Error(`Expected blackout false at 14:10 CET, got ${status1410.isBlackoutActive}`);
}

// 3b. 14:16 CET (14 minutes before -> blackout MUST be active)
const time1416 = new Date('2026-11-04T13:16:00Z'); // 14:16 CET
const status1416 = getMacroBlackoutStatus([sampleEvent], time1416);
if (status1416.isBlackoutActive !== true) {
  throw new Error(`Expected blackout true at 14:16 CET, got ${status1416.isBlackoutActive}`);
}
if (!status1416.label.includes('14:30 CET')) {
  throw new Error(`Expected label to mention 14:30 CET, got "${status1416.label}"`);
}

// 3c. 14:30 CET (exact release time -> blackout MUST be active)
const time1430 = new Date('2026-11-04T13:30:00Z'); // 14:30 CET
const status1430 = getMacroBlackoutStatus([sampleEvent], time1430);
if (status1430.isBlackoutActive !== true) {
  throw new Error(`Expected blackout true at 14:30 CET, got ${status1430.isBlackoutActive}`);
}

// 3d. 14:44 CET (14 minutes after release -> blackout MUST be active)
const time1444 = new Date('2026-11-04T13:44:00Z'); // 14:44 CET
const status1444 = getMacroBlackoutStatus([sampleEvent], time1444);
if (status1444.isBlackoutActive !== true) {
  throw new Error(`Expected blackout true at 14:44 CET, got ${status1444.isBlackoutActive}`);
}

// 3e. 14:46 CET (16 minutes after release -> blackout MUST be deactivated)
const time1446 = new Date('2026-11-04T13:46:00Z'); // 14:46 CET
const status1446 = getMacroBlackoutStatus([sampleEvent], time1446);
if (status1446.isBlackoutActive !== false) {
  throw new Error(`Expected blackout false at 14:46 CET, got ${status1446.isBlackoutActive}`);
}

console.log('ALL MACRO CALENDAR TESTS PASSED VERIFIED!');
