import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEmissionGuard,
  reasonFromGates,
  setupKeyOf,
  dayOf,
  type Row,
} from '../../../scripts/emission_guard';

const DAY = 1760000000; // 2025-10-09, un solo giorno
const groups: Array<{ symbol: string; entry: number; stop: number; n: number }> = [
  { symbol: 'SAP.DE', entry: 186.04, stop: 187.73, n: 22 },
  { symbol: 'BAMI.MI', entry: 15.275, stop: 15.16, n: 16 },
  { symbol: 'BAMI.MI', entry: 14.795, stop: 14.67, n: 15 },
  { symbol: 'SAP.DE', entry: 187, stop: 188.68, n: 12 },
  { symbol: 'SAP.DE', entry: 196.26, stop: 197.73, n: 12 },
  { symbol: 'SAP.DE', entry: 185.06, stop: 186.87, n: 11 },
  { symbol: 'BAMI.MI', entry: 15.33, stop: 15.21, n: 7 },
  { symbol: 'BAMI.MI', entry: 15.005, stop: 14.895, n: 6 },
  { symbol: 'RHM.DE', entry: 1024, stop: 1013.97, n: 6 },
  { symbol: 'BAMI.MI', entry: 13.075, stop: 12.959, n: 5 },
  { symbol: 'SAP.DE', entry: 199.64, stop: 201.6, n: 4 },
  { symbol: 'SAP.DE', entry: 187.38, stop: 188.6, n: 3 },
  { symbol: 'BAMI.MI', entry: 13.385, stop: 13.283, n: 2 },
  { symbol: 'BAMI.MI', entry: 14.1, stop: 14.002, n: 1 },
  { symbol: 'SAP.DE', entry: 212.45, stop: 214.28, n: 1 },
];

function fixture(): Row[] {
  const rows: Row[] = [];
  for (const g of groups) {
    for (let i = 0; i < g.n; i++) {
      rows.push({
        symbol: g.symbol,
        decisionTs: DAY + i * 300,
        emitted: true,
        direction: g.entry > g.stop ? 'SHORT' : 'LONG',
        entry: g.entry,
        stop: g.stop,
        target: g.entry,
        gates: ['G1'],
        reason: null,
      });
    }
  }
  return rows;
}

describe('N1 — con la guardia il replay produce 15 righe invece di 123', () => {
  it('conta le emissioni declassate', () => {
    const input = fixture();
    assert.equal(input.length, 123);
    assert.equal(input.filter(r => r.emitted).length, 123);
    const out = applyEmissionGuard(input);
    assert.equal(out.length, 123, 'nessuna riga cancellata');
    assert.equal(out.filter(r => r.emitted).length, 15);
    assert.equal(out.filter(r => r.reason === 'REEMISSIONE').length, 108);
  });
});

describe('N2 — le 15 righe hanno il decisionTs minimo del gruppo', () => {
  it('vince la prima emissione', () => {
    const out = applyEmissionGuard(fixture());
    const kept = out.filter(r => r.emitted);
    for (const r of kept) {
      const same = out.filter(x => setupKeyOf(x) === setupKeyOf(r));
      const min = Math.min(...same.map(x => x.decisionTs));
      assert.equal(r.decisionTs, min, `gruppo ${setupKeyOf(r)}`);
    }
    const byKey = new Map<string, number>();
    for (const r of kept) byKey.set(setupKeyOf(r), (byKey.get(setupKeyOf(r)) ?? 0) + 1);
    assert.equal(byKey.size, 15);
    assert.ok([...byKey.values()].every(v => v === 1));
  });
});

describe('N3 — i campi delle 15 righe sono identici alla prima riga del gruppo', () => {
  it('symbol, entry, stop, direzione invariati', () => {
    const input = fixture();
    const out = applyEmissionGuard(input);
    for (const r of out.filter(x => x.emitted)) {
      const key = setupKeyOf(r);
      const first = input.filter(x => setupKeyOf(x) === key).sort((a, b) => a.decisionTs - b.decisionTs)[0];
      assert.equal(r.symbol, first.symbol);
      assert.equal(r.entry, first.entry);
      assert.equal(r.stop, first.stop);
      assert.equal(r.direction, first.direction);
      assert.equal(dayOf(r.decisionTs), dayOf(first.decisionTs));
    }
  });

  it('la mappatura gate -> causa e’ quella dichiarata', () => {
    assert.equal(reasonFromGates({ G1: { passed: false } }), 'liquidita');
    assert.equal(reasonFromGates({ G4: { passed: false }, G1: { passed: true } }), 'leva');
    assert.equal(reasonFromGates({ G3: { passed: false }, G2: { passed: false } }), 'struttura');
    assert.equal(reasonFromGates({ G9: { passed: false }, G8: { passed: false } }), 'barriera');
    assert.equal(reasonFromGates({ G12: { passed: false } }), 'vari');
    assert.equal(reasonFromGates(null), null);
    assert.equal(reasonFromGates({ G1: { passed: true } }), null);
  });
});
