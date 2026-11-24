import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginScanRun,
  createScanRunIdHandle,
  getLastScanRunId,
  resetLastScanCandidates,
  setHandlerScanInput,
  consumeHandlerScanInput,
  resetHandlerScanInput,
} from '../../server/aiScanEvaluation';

describe('P3-fix — runId locale alla richiesta di scansione', () => {
  it('beginScanRun genera un runId, lo assegna all’handle e aggiorna l’ultimo di processo', () => {
    resetLastScanCandidates();
    const handle = createScanRunIdHandle();
    assert.equal(handle.value, null);
    const runId = beginScanRun(handle);
    assert.equal(typeof runId, 'string');
    assert.ok(runId.length > 0);
    assert.equal(handle.value, runId);
    assert.equal(getLastScanRunId(), runId);
  });

  it('due handle distinti conservano il proprio runId anche se il globale cambia', () => {
    resetLastScanCandidates();
    const a = createScanRunIdHandle();
    const b = createScanRunIdHandle();
    const runA = beginScanRun(a);
    const runB = beginScanRun(b);
    assert.notEqual(runA, runB);
    assert.equal(a.value, runA);
    assert.equal(b.value, runB);
    // lo stato di processo riflette solo l'ultimo: è il motivo per cui la
    // risposta HTTP deve leggere l'handle e non `getLastScanRunId()`.
    assert.equal(getLastScanRunId(), runB);
    assert.notEqual(getLastScanRunId(), a.value);
  });

  it('due scansioni concorrenti sulla stessa istanza ricevono ciascuna il proprio runId', async () => {
    resetLastScanCandidates();
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // Riproduce l'ordine reale: la scansione lenta parte per prima e termina per
    // ultima; la veloce genera il proprio runId mentre la lenta è in volo e
    // sovrascrive lo stato di processo.
    const scan = async (handle: ReturnType<typeof createScanRunIdHandle>, ms: number) => {
      const runId = beginScanRun(handle);
      await delay(ms);
      return { runId, fromHandle: handle.value, globalAtReturn: getLastScanRunId() };
    };

    const slowHandle = createScanRunIdHandle();
    const fastHandle = createScanRunIdHandle();
    const [slow, fast] = await Promise.all([
      scan(slowHandle, 60),
      scan(fastHandle, 5),
    ]);

    assert.notEqual(slow.runId, fast.runId);
    assert.equal(slow.fromHandle, slow.runId);
    assert.equal(fast.fromHandle, fast.runId);
    // il valore globale al ritorno della scansione lenta è quello della veloce:
    // leggere il globale avrebbe restituito un runId sbagliato.
    assert.equal(slow.globalAtReturn, fast.runId);
    assert.equal(fast.globalAtReturn, fast.runId);
    assert.equal(slowHandle.value, slow.runId);
    assert.equal(fastHandle.value, fast.runId);
  });

  it('generatore iniettabile: runId deterministico nel test', () => {
    resetLastScanCandidates();
    const handle = createScanRunIdHandle();
    const runId = beginScanRun(handle, () => 'run-fisso');
    assert.equal(runId, 'run-fisso');
    assert.equal(handle.value, 'run-fisso');
    assert.equal(getLastScanRunId(), 'run-fisso');
  });

  it('senza handle il runId resta solo diagnostico e non rompe la generazione', () => {
    resetLastScanCandidates();
    const runId = beginScanRun(null, () => 'run-senza-handle');
    assert.equal(runId, 'run-senza-handle');
    assert.equal(getLastScanRunId(), 'run-senza-handle');
  });
});

describe('P2 — handoff input handler: nessuna contaminazione, nessun residuo', () => {
  it('due invocazioni in sequenza non si contaminano', () => {
    resetLastScanCandidates();
    setHandlerScanInput([{ ticker: 'AAA' }], 'run-1');
    const first = consumeHandlerScanInput();
    assert.deepEqual(first.bodyCandidates, [{ ticker: 'AAA' }]);
    assert.equal(first.bodyRunId, 'run-1');

    // seconda invocazione senza set: non vede l'input della prima
    const second = consumeHandlerScanInput();
    assert.equal(second.bodyCandidates, undefined);
    assert.equal(second.bodyRunId, undefined);

    setHandlerScanInput([{ ticker: 'BBB' }], 'run-2');
    const third = consumeHandlerScanInput();
    assert.deepEqual(third.bodyCandidates, [{ ticker: 'BBB' }]);
    assert.equal(third.bodyRunId, 'run-2');
  });

  it('resetHandlerScanInput azzera un input non consumato', () => {
    resetLastScanCandidates();
    setHandlerScanInput([{ ticker: 'ZZZ' }], 'run-z');
    resetHandlerScanInput();
    const after = consumeHandlerScanInput();
    assert.equal(after.bodyCandidates, undefined);
    assert.equal(after.bodyRunId, undefined);
  });

  it('un’eccezione durante la lavorazione non lascia input residuo (try/finally)', async () => {
    resetLastScanCandidates();

    // Stessa forma di `logScanCandidateEvaluations`: consumo nello stesso tick,
    // poi `finally` che azzera. Il corpo lancia dopo il consumo.
    const fakeHandler = async (
      body: unknown,
      runId: unknown,
      work: () => Promise<void>
    ): Promise<void> => {
      const { bodyCandidates } = consumeHandlerScanInput();
      try {
        assert.deepEqual(bodyCandidates, body);
        await work();
      } finally {
        resetHandlerScanInput();
      }
    };

    setHandlerScanInput([{ ticker: 'AAA' }], 'run-boom');
    await assert.rejects(
      fakeHandler([{ ticker: 'AAA' }], 'run-boom', async () => {
        throw new Error('boom');
      }),
      /boom/
    );
    const after = consumeHandlerScanInput();
    assert.equal(after.bodyCandidates, undefined);
    assert.equal(after.bodyRunId, undefined);
  });
});
