/**
 * Ancoraggio comportamentale della pipeline (Passo H-bis / I0 + I2b).
 *
 * Il baseline storico 003c53e0 e' PERDUTO e non rigenerabile (il harness che lo
 * produceva non e' mai stato versionato). Da questo passo l'ancoraggio e' il
 * sha256 dell'output canonico dell'harness sullo snapshot versionato:
 * non e' confrontabile con 003c53e0 in nessun modo.
 *
 * ---------------------------------------------------------------------------
 * COSA BASELINE_OFF DIMOSTRA E COSA NON DIMOSTRA (Passo H-ter / I0-bis)
 *
 * BASELINE_OFF e' un'ancora di REGRESSIONE DELL'HARNESS in modalita' from-bars:
 * fissa il comportamento della catena di scoring/gate ricostruita dalle barre
 * versionate, cosi' che una modifica futura che cambia quei numeri faccia
 * fallire questo test invece di passare inosservata.
 *
 * NON e' una prova di parita' con la pipeline LIVE. Le ragioni sono due,
 * entrambe verificate e non dedotte:
 *
 *  1. La modalita' 'as-recorded', cioe' rialimentare le quote registrate, e'
 *     DEGENERE: tutte le quote risultano warmupIncomplete, nessun Top Pick
 *     viene prodotto e i gate non vengono mai eseguiti. Il baseline sarebbe
 *     stato il vuoto. Per questo la modalita' di default e' 'from-bars'.
 *  2. Il parity test qui sotto ("l harness coincide con la ricostruzione
 *     diretta della catena di App.tsx") confronta l'harness con una
 *     RICOSTRUZIONE della catena fatta con le stesse funzioni di src/, non con
 *     l'output dell'app live. Un parity test LIVE non e' stato eseguito:
 *     richiederebbe un'istanza del server che serva quote live nello stesso
 *     istante del replay, e lato client non esiste alcun seam di barre in
 *     memoria (l'unico inMemoryBars e' dentro server.ts).
 *
 * In sintesi: verde qui = la catena non e' regredita rispetto a se stessa.
 * Verde qui != la catena live si comporta come l'harness.
 *
 * Il parity test LIVE non esiste in questo repo e il test di wiring qui sotto
 * NON lo sostituisce: nessuna asserzione di questo file confronta l'output
 * dell'harness con quello dell'app.
 * ---------------------------------------------------------------------------
 *
 * Runner: npx tsx src/utils/__tests__/pipeline_baseline.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildExecutionSetup, DEFAULT_SYSTEM_PARAMETERS, getDualTopCandidates } from '../calculator';
import {
  canonical,
  canonicalSetup,
  quotesAtRecordedInstant,
  runPipeline,
  sha256,
  type Snapshot,
} from '../../../scripts/headless_pipeline';

const read = (name: string): Snapshot =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Snapshot;

const SNAP = read('pipeline_snapshot.json');
const AGED = read('pipeline_snapshot_aged.json');

// Valori asseriti. BASELINE_ON coincide con BASELINE_OFF: con marketTs fresco
// G13 passa in entrambe le modalita', quindi il flag non cambia nulla.
const BASELINE_OFF = '3ea7044adddcb1c38c0a07bb6f6b8ad6c4d4f7e9e828b9963e0f3e3faa8b92ee';
const BASELINE_ON = '3ea7044adddcb1c38c0a07bb6f6b8ad6c4d4f7e9e828b9963e0f3e3faa8b92ee';
const BASELINE_ON_AGED = '728e93d26d6966e669fa8a99c3b616562f3134331780007cc0c1fd08759d65fa';

function run(snapshot: Snapshot, stalenessFlag?: 'on' | 'off'): string {
  return canonical(
    runPipeline(quotesAtRecordedInstant(snapshot), {
      currentTime: new Date(snapshot.recordedAt),
      entryMode: 'SNAPSHOT_0915',
      futuresChange: { EU: 0, US: 0 },
      ...(stalenessFlag === undefined ? {} : { stalenessFlag }),
    }),
  );
}

function euSetup(text: string): Record<string, any> {
  return (JSON.parse(text) as any).EU.setup;
}

describe('I0 — harinnes deterministico e baseline', () => {
  it('due esecuzioni sullo stesso snapshot sono byte-identiche', () => {
    assert.equal(run(SNAP), run(SNAP));
  });

  it('BASELINE_OFF: output canonico invariato', () => {
    assert.equal(sha256(run(SNAP)), BASELINE_OFF);
  });

  it('la pipeline esercita davvero i gate (G1..G13 presenti)', () => {
    const setup = euSetup(run(SNAP));
    const keys = Object.keys(setup.gateResults);
    for (const g of ['G1', 'G2', 'G4', 'G11', 'G12', 'G13']) {
      assert.ok(keys.includes(g), `gate ${g} assente: ${keys.join(',')}`);
    }
    assert.ok(setup.ticker !== null, 'nessun Top Pick: la fixture non esercita la pipeline');
  });

  it('wiring: l harness chiama le stesse funzioni della catena, nello stesso ordine', () => {
    const quotes = quotesAtRecordedInstant(SNAP);
    const dual = getDualTopCandidates(quotes, { EU: 0, US: 0 }, {
      parameters: DEFAULT_SYSTEM_PARAMETERS,
    });
    const direct = buildExecutionSetup(dual.topEU, null, 'EU', DEFAULT_SYSTEM_PARAMETERS, {
      entryMode: 'SNAPSHOT_0915',
      currentTime: new Date(SNAP.recordedAt),
    });
    assert.deepEqual(euSetup(run(SNAP)), JSON.parse(canonical(canonicalSetup(direct))));
  });
});

describe('I2b — flag STALENESS_USE_MARKET_TS', () => {
  it('PROVA A: flag off/assente -> BASELINE_OFF', () => {
    assert.equal(sha256(run(SNAP)), BASELINE_OFF);
    assert.equal(sha256(run(SNAP, 'off')), BASELINE_OFF);
  });

  it('PROVA A bis: con flag off la fixture aged non cambia nulla', () => {
    assert.equal(sha256(run(AGED, 'off')), BASELINE_OFF);
    assert.equal(sha256(run(AGED)), BASELINE_OFF);
  });

  it('PROVA B: flag on sullo snapshot normale -> BASELINE_ON', () => {
    assert.equal(sha256(run(SNAP, 'on')), BASELINE_ON);
    assert.equal(euSetup(run(SNAP, 'on')).gateResults.G13.passed, true);
  });

  it('PROVA C: flag on sulla fixture aged -> G13 rifiuta', () => {
    const text = run(AGED, 'on');
    assert.equal(sha256(text), BASELINE_ON_AGED);
    const setup = euSetup(text);
    assert.equal(setup.gateResults.G13.passed, false, 'G13 non ha rifiutato la quota invecchiata');
    assert.match(String(setup.gateResults.G13.message), /ritardo/i);
    // Onesta' del dato: il setup era gia' bloccato prima di G13.
    assert.equal(setup.blockedGate, 'G4');
  });
});
