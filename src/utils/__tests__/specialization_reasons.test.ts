/**
 * ADDITIVO (Parte 2 v6): test dei rami di reason di /api/ai/specialize.
 * I primi 4 rami sono testati sulla funzione pura reale usata dal handler
 * (src/utils/specializationReason.ts). I rami GATE_NON_SUPERATI e OK_SCRITTO
 * sono testati sulle funzioni reali di persistenza (updateAIMemory) e validazione
 * (validateLearningPattern), non su logica copiata.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSpecializationReason } from '../specializationReason';
import { validateLearningPattern, LearningResult } from '../learningValidator';
import { updateAIMemory } from '../memoryUpdater';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS | ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL | ${label}${detail ? ` | ${detail}` : ''}`);
  }
}

const base = {
  hasOpenRouterKey: false,
  geminiAvailable: false,
  llmErrorDetail: null as string | null,
  proposedDirectivesCount: 1,
  decisiveSample: 40,
  minSample: 30,
};

// 1) CHIAVE_ASSENTE
const r1 = resolveSpecializationReason({ ...base });
check('CHIAVE_ASSENTE', r1.reason === 'CHIAVE_ASSENTE', r1.reason);

// 2) LLM_ERRORE con status
const r2 = resolveSpecializationReason({ ...base, hasOpenRouterKey: true, llmErrorDetail: 'openrouter:401' });
check('LLM_ERRORE con status', r2.reason === 'LLM_ERRORE' && r2.reasonDetail === 'openrouter:401', `${r2.reason} ${r2.reasonDetail}`);

// 3) LLM_VUOTA
const r3 = resolveSpecializationReason({ ...base, hasOpenRouterKey: true, proposedDirectivesCount: 0 });
check('LLM_VUOTA', r3.reason === 'LLM_VUOTA', r3.reason);

// 4) CAMPIONE_INSUFFICIENTE (n/30)
const r4 = resolveSpecializationReason({ ...base, hasOpenRouterKey: true, decisiveSample: 12 });
check('CAMPIONE_INSUFFICIENTE 12/30', r4.reason === 'CAMPIONE_INSUFFICIENTE' && r4.reasonDetail === '12/30 trade chiusi decisivi (WIN/LOSS).', `${r4.reason} ${r4.reasonDetail}`);

// 4a) TOPIC_NON_FILTRATO: campione sufficiente, ma il validatore non filtra per topic
const rTopic = resolveSpecializationReason({ ...base, hasOpenRouterKey: true, decisiveSample: 40 });
check('TOPIC_NON_FILTRATO', rTopic.reason === 'TOPIC_NON_FILTRATO', rTopic.reason);

// 4b) validateLearningPattern restituisce null con campione reale insufficiente
const fewTrades: any[] = Array.from({ length: 5 }, (_, i) => ({
  id: `t${i}`,
  status: 'CLOSED',
  outcome: i % 2 === 0 ? 'WIN' : 'LOSS',
  rMultiple: 1,
}));
check('validateLearningPattern null con 5 trade', validateLearningPattern(fewTrades, [], 'TOPIC_TEST', 'EU') === null);

// 5) GATE_NON_SUPERATI: campione sufficiente ma q/avgR/PF sotto gate
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specreason-'));
const gateFile = path.join(dir, 'memory.json');
fs.writeFileSync(gateFile, '[]', 'utf8');
const gateResult: LearningResult = {
  topic: 'GATE_TEST',
  market: 'EU',
  directive: 'x',
  confidence: 0.5,
  evidence: [],
  expectancy: null,
  deflatedSharpe: { value: null, trials: 1, note: 'test' } as any,
  counterfactualShared: false,
  stats: {
    n: 40,
    wins: 20,
    losses: 20,
    breakevens: 0,
    winRate: 0.5,
    avgR: 0.2,
    profitFactor: 2,
    pValue: 0.5,
    adjustedPValue: 0.5,
    counterfactual: { n: 0, wins: 0, losses: 0, expired: 0 },
  },
};
updateAIMemory([gateResult], gateFile);
check('GATE_NON_SUPERATI non scrive (q=0.5)', JSON.parse(fs.readFileSync(gateFile, 'utf8')).length === 0);

// 6) OK_SCRITTO: stessi dati ma gate superati
const okResult: LearningResult = {
  ...gateResult,
  topic: 'OK_TEST',
  stats: { ...gateResult.stats, adjustedPValue: 0.01, pValue: 0.01 },
};
updateAIMemory([okResult], gateFile);
const written = JSON.parse(fs.readFileSync(gateFile, 'utf8'));
check('OK_SCRITTO scrive 1 regola con confidence', written.length === 1 && typeof written[0].confidence === 'number');

fs.rmSync(dir, { recursive: true, force: true });

console.log(`=== Specialization reasons: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
if (failures > 0) process.exitCode = 1;
