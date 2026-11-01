import { generatePnLScenarios } from '../src/utils/calculator';
import { ExecutionSetup, KnockOutCalculatorInput } from '../src/types/radar';

console.log('Testing Fix 4: generatePnLScenarios net = gross - friction for every non-KO scenario...');

const mockSetup: ExecutionSetup = {
  candidate: {
    ticker: 'TEST.MI',
    name: 'Test Stock',
    market: 'EU',
    currency: 'EUR',
    currentPrice: 100,
    prevClose: 98,
    gapPercent: 1.02,
    atr14: 2.0,
    rvol: 1.5,
  } as unknown as any,
  decision: 'TRADE',
  direction: 'LONG',
  strategy: 'Opening Range Breakout (5m / 15m)',
  triggerLevel: 100,
  vwapCondition: 'Sopra VWAP',
  volumeCondition: 'RVOL > 1.2',
  stopLossLevel: 98, // stopDistance = 2.0
  target1Level: 103.2,
  target2Level: 105.6,
  riskRewardRatio: 1.6,
  invalidationConditions: [],
  cutoffTime: '11:30',
  catalystAnalysis: null,
};

const mockInput: KnockOutCalculatorInput = {
  accountCapital: 10000,
  maxRiskPercent: 1.0,
  barrierStrike: 94,
  leverage: 10,
  certificatePrice: 6.0,
};

const certPrice = 6.0;
const suggestedCertificates = 83; // 83 * (6 * 0.02 * 10) = 99.60 Eur
const totalInvestedEur = 498;
const frictionEur = 5.90; // spread + broker fee
const breakevenPoints = 0.12;
const stopDistance = 2.0;
const potentialLossEur = 100;

const scenarios = generatePnLScenarios(
  mockSetup,
  mockInput,
  certPrice,
  suggestedCertificates,
  totalInvestedEur,
  frictionEur,
  breakevenPoints,
  stopDistance,
  potentialLossEur
);

for (const sc of scenarios) {
  if (sc.id === 'ko') {
    if (sc.netPnlEur !== -totalInvestedEur || sc.grossPnlEur !== -totalInvestedEur) {
      throw new Error(`FAIL KO scenario: netPnlEur=${sc.netPnlEur}, expected ${-totalInvestedEur}`);
    }
    console.log(`PASS: KO scenario wipeout handled correctly (-${totalInvestedEur} €)`);
  } else {
    const expectedNet = +(sc.grossPnlEur - frictionEur).toFixed(2);
    if (Math.abs(sc.netPnlEur - expectedNet) > 0.001) {
      throw new Error(`FAIL scenario ${sc.id} (${sc.label}): gross=${sc.grossPnlEur}, friction=${frictionEur}, net=${sc.netPnlEur}, expected ${expectedNet}`);
    }
    console.log(`PASS: scenario ${sc.id.padEnd(8)} | gross: ${sc.grossPnlEur.toFixed(2).padStart(7)} € | friction: ${frictionEur.toFixed(2)} € | net: ${sc.netPnlEur.toFixed(2).padStart(7)} € (net = gross - friction)`);
  }
}

// Check specifically that STOP scenario includes friction
const stopSc = scenarios.find((s) => s.id === 'stop');
if (!stopSc) throw new Error('Stop scenario not found');
if (stopSc.grossPnlEur !== -potentialLossEur) {
  throw new Error(`Expected stop grossPnlEur to be -${potentialLossEur}, got ${stopSc.grossPnlEur}`);
}
if (stopSc.netPnlEur !== -105.90) {
  throw new Error(`Expected stop netPnlEur to be -105.90, got ${stopSc.netPnlEur}`);
}
// Check specifically that BREAKEVEN scenario has gross 0 and net -friction
const beSc = scenarios.find((s) => s.id === 'be');
if (!beSc) throw new Error('Breakeven scenario not found');
if (beSc.grossPnlEur !== 0) {
  throw new Error(`Expected be grossPnlEur to be 0, got ${beSc.grossPnlEur}`);
}
if (beSc.netPnlEur !== -frictionEur) {
  throw new Error(`Expected be netPnlEur to be -${frictionEur}, got ${beSc.netPnlEur}`);
}

console.log('ALL FIX 4 TESTS PASSED VERIFIED!');
