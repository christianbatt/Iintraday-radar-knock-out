import {
  createAIMemoryPayload,
  db,
  pullAIMemoryFromFirebase,
  syncAIMemoryToFirebase,
} from '../firebaseSync';
import { AILearnedInsight } from '../../types/radar';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const sampleMemory: AILearnedInsight[] = [
  {
    id: 'ai-hypothesis',
    learnedAt: '2026-11-02T00:00:00.000Z',
    market: 'EU',
    topic: 'HYPOTHESIS',
    directive: 'Ipotesi non ancora verificata.',
    confidence: null,
    sampleEvidence: 'Nessun trade reale di riferimento.',
  },
  {
    id: 'ai-statistical',
    learnedAt: '2026-11-02T00:00:00.000Z',
    market: 'US',
    topic: 'STATISTICAL_PATTERN',
    directive: 'Pattern statistico candidato.',
    confidence: 96,
    sampleEvidence: 'Trade IDs: trade-1, trade-2.',
  },
];

async function run(): Promise<void> {
  const payload = createAIMemoryPayload(sampleMemory, 7);
  assert(payload.memory.length === 2, 'Payload deve contenere due regole');
  assert(payload.version === 7, 'Payload deve mantenere la versione');
  assert(payload.rulesCount === 2, 'rulesCount deve corrispondere alla memoria');
  assert(payload.validatedCount === 1, 'confidence null non deve essere conteggiata come validata');
  assert(Number.isFinite(Date.parse(payload.updatedAt)), 'updatedAt deve essere ISO valido');
  console.log('Test 1 - payload AI memory e conteggi: PASS');

  await expectNoThrow(syncAIMemoryToFirebase('', sampleMemory));
  assert(await pullAIMemoryFromFirebase('') === null, 'UID vuoto deve restituire null');
  console.log('Test 2 - UID assente non accede a Firestore: PASS');

  if (!db) {
    await expectNoThrow(syncAIMemoryToFirebase('test-uid', sampleMemory));
    assert(await pullAIMemoryFromFirebase('test-uid') === null, 'Senza Firestore configurato deve fare fallback null');
    console.log('Test 3 - Firestore non configurato, fallback non bloccante: PASS');
    console.log('Test d’integrazione Firestore remoto: NON ESEGUITO (emulatore/credenziali non configurati)');
  } else {
    console.log('Test d’integrazione Firestore remoto: NON ESEGUITO per evitare scritture su un progetto configurato');
  }
}

async function expectNoThrow(operation: Promise<void>): Promise<void> {
  await operation;
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
