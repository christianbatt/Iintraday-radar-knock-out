/**
 * I2c-bis — Il flag STALENESS_USE_MARKET_TS deve cambiare l'ESITO, non solo il
 * verdetto di G13.
 *
 * ATENZIONE: questo test NON usa le fixture di pipeline_baseline e NON tocca lo
 * snapshot. La quota qui sotto e' SINTETICA: costruita a mano campo per campo
 * per soddisfare G1-G12, cosi' che G13 sia l'ultimo gate rimasto e possa
 * diventare il PRIMO blocco. Serve a provare il flip in isolamento; non e' un
 * dato di mercato e non dice nulla sulla frequenza reale del caso.
 *
 * Perche' una quota sintetica e non una fixture: nello snapshot registrato il
 * candidato (ENI.MI) e' gia' oltre il trigger e fallisce G4/G8/G9, quindi la'
 * G13 non puo' essere il primo blocco per costruzione. Vedi report H-ter, I2c.
 *
 * Runner: npx tsx src/utils/__tests__/g13_flip.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionSetup, DEFAULT_SYSTEM_PARAMETERS } from '../calculator';
import type {
  ExecutionSetup,
  RawQuoteData,
  ScoredCandidate,
  ScoreBreakdown,
} from '../../types/radar';

// Mercoledi' 11/11/2026, 10:30 Europe/Rome (09:30 UTC): sessione EU aperta e ORB
// gia' chiuso, cosi' G3 (!isBeforeOrb) e' soddisfatto senza toccare nulla.
const NOW = new Date('2026-11-11T09:30:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

/**
 * Quota sintetica che soddisfa G1-G12. I valori di E e S sono espliciti (campi
 * T/E/S di RawQuoteData) per non dipendere dal calcolo ORB:
 *
 *   E = 100, S = 99.5  -> dS = 0.005
 *   G8 : dS <= LMAX / min(LEVE) = 0.10 / 10 = 0.01          -> 0.005 <= 0.01   OK
 *   G9 : leve ammesse {10,15,20}: 0.005*L <= 0.10 e 1/L >= 0.005+0.001
 *        -> L_sel = 20, B_rec = 95.00, S - B_rec = 4.5 >= 0.001*100 = 0.1   OK
 *   G4 : price(100) == E -> estensione 0.00% <= 0.40%                        OK
 *   G12: T1 = 100 + 1.6*0.5 = 100.8, distanza 0.8 <= spazio ADR residuo(99)  OK
 *   G1 : liqEur20d 5.0 M EUR >= 3.0 M EUR                                    OK
 *   G2 : ORB, ATR14, ADR14, prevClose, avgVolume20d, liqEur, barre 20 tutte ok
 *   G6 : todayHigh 100.5 < T1 100.8 -> T1 non ancora raggiunto                OK
 *   G7 : (todayHigh - todayLow) / adr14 = 1.0/100 = 1% <= 60%                OK
 *   G10: price 100 > S 99.5                                                  OK
 *   G11: score 60 >= MIN_SCORE_EU 48                                          OK
 */
function syntheticQuote(overrides: Partial<RawQuoteData> = {}): RawQuoteData {
  return {
    ticker: 'SYNTH.MI',
    name: 'Quota sintetica di test',
    market: 'EU',
    currency: 'EUR',
    prevClose: 99.5,
    currentPrice: 100,
    preMarketPrice: null,
    prevHigh: 100.2,
    prevLow: 99.4,
    preMarketHigh: null,
    preMarketLow: null,
    todayOpen: 99.6,
    todayHigh: 100.5,
    todayLow: 99.5,
    avgVolume20d: 10_000_000,
    preMarketVolume: 0,
    atr14: 0.8,
    adr14: 100,
    liqEur20d: 5_000_000,
    completedBarsCount: 20,
    orbHigh: 100.2,
    orbLow: 99.4,
    orbBreakoutTime: null,
    orbBreakoutTimeLong: null,
    orbBreakoutTimeShort: null,
    T: 100,
    E: 100,
    S: 99.5,
    gapPercent: 0.005,
    rvol: 1.2,
    timestamp: new Date(NOW.getTime() - 60_000).toISOString(),
    source: 'synthetic',
    ...overrides,
  };
}

function candidate(quote: RawQuoteData): ScoredCandidate {
  return {
    quote,
    // Solo score.total e' letto da buildExecutionSetup (G11); il resto del
    // breakdown non partecipa ai gate.
    score: { total: 60 } as unknown as ScoreBreakdown,
    rank: 1,
  };
}

function setup(quote: RawQuoteData, stalenessFlag: 'on' | 'off'): ExecutionSetup {
  return buildExecutionSetup(candidate(quote), null, 'EU', DEFAULT_SYSTEM_PARAMETERS, {
    entryMode: 'SNAPSHOT_0915',
    currentTime: NOW,
    stalenessFlag,
  });
}

type GateMap = Record<string, { passed: boolean; message?: string | null }>;

function gatesOf(s: ExecutionSetup): GateMap {
  return (s as unknown as { gateResults?: GateMap }).gateResults ?? {};
}

describe('I2c-bis — flip di G13 su quota SINTETICA', () => {
  it('la quota sintetica passa davvero G1-G12 (altrimenti il test non prova nulla)', () => {
    const s = setup(syntheticQuote({ marketTs: NOW_SEC }), 'on');
    const gates = gatesOf(s);
    const falliti = Object.keys(gates)
      .filter((k) => k !== 'G13' && !gates[k].passed)
      .sort();
    assert.deepEqual(falliti, [], `gate falliti: ${falliti.join(',')}`);
    assert.equal(gates.G13.passed, true);
    assert.equal(s.blockedGate, null);
    assert.equal(s.decision, 'TRADE');
  });

  it("flag 'off' + marketTs VECCHIO: G13 non guarda marketTs, setup EMESSO", () => {
    const quote = syntheticQuote({ marketTs: NOW_SEC - 3600 });
    const s = setup(quote, 'off');
    assert.equal(gatesOf(s).G13.passed, true, 'con off G13 deve ignorare marketTs');
    assert.equal(s.blockedGate, null);
    assert.equal(s.decision, 'TRADE');
  });

  it("flag 'on' + marketTs VECCHIO: G13 e' il PRIMO blocco, setup NON emesso", () => {
    const quote = syntheticQuote({ marketTs: NOW_SEC - 3600 });
    const s = setup(quote, 'on');
    const gates = gatesOf(s);
    assert.equal(gates.G13.passed, false, 'con on G13 deve rifiutare marketTs vecchio');
    assert.match(String(gates.G13.message), /ritardo/i);
    assert.equal(s.blockedGate, 'G13', 'G13 deve essere il PRIMO gate di blocco');
    assert.equal(s.decision, 'NESSUN_TRADE');
  });

  it("flag 'on' + marketTs FRESCO: nessun falso positivo, setup emesso", () => {
    const s = setup(syntheticQuote({ marketTs: NOW_SEC - 60 }), 'on');
    assert.equal(gatesOf(s).G13.passed, true);
    assert.equal(s.blockedGate, null);
    assert.equal(s.decision, 'TRADE');
  });

  it('il flip: stessa quota, solo il flag cambia l esito', () => {
    const quote = syntheticQuote({ marketTs: NOW_SEC - 3600 });
    const off = setup(quote, 'off');
    const on = setup(quote, 'on');
    assert.equal(off.decision, 'TRADE');
    assert.equal(on.decision, 'NESSUN_TRADE');
    assert.equal(off.blockedGate, null);
    assert.equal(on.blockedGate, 'G13');
  });
});
