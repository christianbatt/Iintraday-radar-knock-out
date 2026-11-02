import { createJournalEntryFromSetup, DEFAULT_SYSTEM_PARAMETERS } from '../src/utils/calculator';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const baseTrade = {
  id: 'sprint3-trade',
  timestamp: '2026-11-01T10:00:00.000Z',
  session: 'EU' as const,
  ticker: 'TEST.MI',
  direction: 'LONG' as const,
  strategy: 'ORB_BREAKOUT',
  entryPrice: 100,
  entryLevel: 100,
  triggerLevel: 100,
  stopLoss: 99,
  stopLossLevel: 99,
  target1: 101.6,
  target1Level: 101.6,
  potentialLossEur: 40,
  potentialGainT1Eur: 64,
  potentialGainT2Eur: 112,
  frictionEur: 3,
  isPaper: true,
  entryMode: 'MANUAL_FREEZE' as const,
};

const now = new Date('2026-11-01T10:01:00.000Z');
const win = createJournalEntryFromSetup({ ...baseTrade, outcome: 'WIN' }, DEFAULT_SYSTEM_PARAMETERS, now);
assert(win.pnlEur === 61, `WIN deve registrare gain netto 64-3=61, ottenuto ${win.pnlEur}`);
assert(win.rMultiple === 1.6, `WIN deve registrare il moltiplicatore T1, ottenuto ${win.rMultiple}`);
assert(win.potentialLossEur === 40 && win.potentialGainT2Eur === 112, 'I valori rischio/target devono essere conservati nel Journal');
console.log('S3.1 PnL WIN netto da gain e attrito reali: PASS');

const loss = createJournalEntryFromSetup({ ...baseTrade, outcome: 'LOSS' }, DEFAULT_SYSTEM_PARAMETERS, now);
assert(loss.pnlEur === -43, `LOSS deve registrare perdita 40+3=43, ottenuto ${loss.pnlEur}`);
console.log('S3.2 PnL LOSS da rischio monetario e attrito: PASS');

const expired = createJournalEntryFromSetup({ ...baseTrade, outcome: 'EXPIRED' }, DEFAULT_SYSTEM_PARAMETERS, now);
assert(expired.pnlEur === -3 && expired.rMultiple === 0, 'EXPIRED deve registrare solo l’attrito disponibile');
console.log('S3.3 PnL EXPIRED senza costo fittizio: PASS');

let missingRiskRejected = false;
try {
  createJournalEntryFromSetup({ ...baseTrade, outcome: 'LOSS', potentialLossEur: undefined, maxRiskEur: undefined, frictionEur: undefined }, DEFAULT_SYSTEM_PARAMETERS, now);
} catch (error) {
  missingRiskRejected = error instanceof Error && error.message.includes('rischio monetario effettivo');
}
assert(missingRiskRejected, 'LOSS senza rischio monetario deve essere rifiutata, non stimata con importi fissi');
console.log('S3.4 PnL LOSS senza rischio non viene inventato: PASS');

console.log('=== Tutti i test Sprint 3 Journal completati ===');
