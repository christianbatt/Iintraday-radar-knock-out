/**
 * PUNTO 4: unico fattore RVOL USA in TRADING_PARAMS (IPOTESI).
 *
 * Verifica che:
 * - il fattore sia esposto da TRADING_PARAMS con il valore storico 1.35;
 * - una proposta minRvol GLOBAL applichi minRvolUSA = round2(minRvolEurope * RVOL_USA_MULTIPLIER);
 * - una proposta minRvol su un solo mercato non tocchi la soglia dell'altro mercato.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { applyOptimizationProposal, DEFAULT_SYSTEM_PARAMETERS } from '../calculator';
import { TRADING_PARAMS } from '../../config/tradingParams';
import type { SystemParameters } from '../../types/radar';

const proposal = (proposedValue: number) => ({
  id: null,
  proposedChanges: [{ parameterKey: 'minRvol' as keyof SystemParameters, proposedValue }],
});

describe('RVOL_USA_MULTIPLIER (IPOTESI)', () => {
  it('il fattore vive in TRADING_PARAMS e vale 1.35', () => {
    assert.strictEqual(TRADING_PARAMS.RVOL_USA_MULTIPLIER, 1.35);
  });

  it('proposta minRvol GLOBAL: minRvolUSA = round2(minRvolEurope * RVOL_USA_MULTIPLIER)', () => {
    const base: SystemParameters = { ...DEFAULT_SYSTEM_PARAMETERS };
    const result = applyOptimizationProposal(base, proposal(0.9), 'GLOBAL');

    assert.strictEqual(result.parameters.minRvolEurope, 0.9);
    assert.strictEqual(
      result.parameters.minRvolUSA,
      Number((0.9 * TRADING_PARAMS.RVOL_USA_MULTIPLIER).toFixed(2))
    );
    console.log(
      `[RVOL_USA_MULTIPLIER] GLOBAL 0.9 -> EU ${result.parameters.minRvolEurope} | USA ${result.parameters.minRvolUSA}`
    );
  });

  it('proposta minRvol su mercato EU non modifica minRvolUSA', () => {
    const base: SystemParameters = { ...DEFAULT_SYSTEM_PARAMETERS };
    const result = applyOptimizationProposal(base, proposal(0.7), 'EU');

    assert.strictEqual(result.parameters.minRvolEurope, 0.7);
    assert.strictEqual(result.parameters.minRvolUSA, base.minRvolUSA);
  });

  it('proposta minRvol su mercato US non modifica minRvolEurope', () => {
    const base: SystemParameters = { ...DEFAULT_SYSTEM_PARAMETERS };
    const result = applyOptimizationProposal(base, proposal(1.6), 'US');

    assert.strictEqual(result.parameters.minRvolUSA, 1.6);
    assert.strictEqual(result.parameters.minRvolEurope, base.minRvolEurope);
  });
});
