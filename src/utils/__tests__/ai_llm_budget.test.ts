/**
 * Test del budget LLM, del retry e della validazione dello schema (P10).
 *
 * Tutto puro: il tempo e' iniettato, nessuna rete, nessun file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_LLM_ENDPOINT_MAX_TOKENS,
  AI_LLM_MAX_CALLS_PER_REQUEST,
  AI_LLM_MAX_CALLS_PER_USER,
  AI_LLM_RETRY_BASE_MS,
  AI_LLM_RETRY_MAX_ATTEMPTS,
  AI_LLM_RETRY_MAX_DELAY_MS,
  aiLlmRetryDelayMs,
  createAiLlmBudgetLedger,
  isRetryableLlmStatus,
  parseRetryAfterMs,
} from '../../server/aiLlmBudget';
import {
  AI_LLM_SCHEMAS,
  parseAiLlmJson,
  validateAiLlmObject,
  validateScanEvaluationRow,
} from '../../server/aiLlmResponseSchema';
import { parseScanEvaluations } from '../../server/aiScanEvaluation';
import { AI_SHADOW_DECISIONS } from '../../server/aiShadowLog';

// --- maxTokens per endpoint ---------------------------------------------------

test('P10 maxTokens: un valore dichiarato per ogni endpoint, uguale a quello storico', () => {
  assert.deepEqual(AI_LLM_ENDPOINT_MAX_TOKENS, {
    'ai-specialize': 2500,
    'ai-desk-post-mortem': 2500,
    'ai-catalyst': 2500,
    'ai-scan-batch': 2800,
    'ai-test-openrouter': 300,
  });
  for (const value of Object.values(AI_LLM_ENDPOINT_MAX_TOKENS)) {
    assert.ok(Number.isInteger(value) && value > 0);
  }
});

// --- Tetto per richiesta ------------------------------------------------------

test('P10 budget di richiesta: il tetto ferma la chiamata successiva', () => {
  const ledger = createAiLlmBudgetLedger({ maxCallsPerRequest: 3, maxCallsPerUser: 100 });
  const budget = ledger.openRequest('u1');
  assert.equal(budget.tryConsume().ok, true);
  assert.equal(budget.tryConsume().ok, true);
  assert.equal(budget.tryConsume().ok, true);
  const denied = budget.tryConsume();
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.scope, 'request');
  assert.equal(budget.used(), 3);
});

test('P10 peek: non consuma e riflette il tetto per richiesta', () => {
  const ledger = createAiLlmBudgetLedger({ maxCallsPerRequest: 1 });
  const budget = ledger.openRequest(null);
  assert.equal(budget.peek().ok, true);
  assert.equal(budget.used(), 0, 'peek non consuma');
  assert.equal(budget.tryConsume().ok, true);
  const after = budget.peek();
  assert.equal(after.ok, false);
  assert.equal(after.ok === false && after.scope, 'request');
});

test('P10 due richieste distinte non condividono il tetto per richiesta', () => {
  const ledger = createAiLlmBudgetLedger({ maxCallsPerRequest: 1, maxCallsPerUser: 100 });
  assert.equal(ledger.openRequest('u1').tryConsume().ok, true);
  assert.equal(ledger.openRequest('u1').tryConsume().ok, true);
});

// --- Tetto per utente ---------------------------------------------------------

test('P10 finestra per utente: tetto, scadenza e isolamento fra utenti', () => {
  let now = 1_000_000;
  const ledger = createAiLlmBudgetLedger({
    now: () => now,
    maxCallsPerRequest: 100,
    maxCallsPerUser: 2,
    userWindowMs: 60_000,
  });

  assert.equal(ledger.openRequest('u1').tryConsume().ok, true);
  assert.equal(ledger.openRequest('u1').tryConsume().ok, true);
  const denied = ledger.openRequest('u1').tryConsume();
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.scope, 'user');
  assert.equal(ledger.userCallsInWindow('u1'), 2);
  assert.equal(denied.ok === false && denied.limit, 2);

  // Un altro utente non e' toccato.
  assert.equal(ledger.openRequest('u2').tryConsume().ok, true);

  // Dopo la finestra la quota torna.
  now += 60_001;
  assert.equal(ledger.openRequest('u1').peek().ok, true);
  assert.equal(ledger.openRequest('u1').tryConsume().ok, true);
  assert.equal(ledger.userCallsInWindow('u1'), 1, 'gli istanti vecchi vengono potati');
});

test('P10 senza utente (percorso automatico) vale solo il tetto per richiesta', () => {
  const ledger = createAiLlmBudgetLedger({ maxCallsPerRequest: 2, maxCallsPerUser: 1 });
  const automatic = ledger.openRequest(null);
  assert.equal(automatic.tryConsume().ok, true);
  assert.equal(automatic.tryConsume().ok, true);
  assert.equal(automatic.tryConsume().ok, false);
  assert.equal(ledger.userCallsInWindow('u1'), 0);
});

test('P10 i valori di default sono dichiarati e coerenti con il caso normale', () => {
  // Caso normale peggiore: 2 provider per la chiamata principale + 4 batch x 2.
  assert.ok(AI_LLM_MAX_CALLS_PER_REQUEST >= 10);
  assert.ok(AI_LLM_MAX_CALLS_PER_USER > AI_LLM_MAX_CALLS_PER_REQUEST);
});

// --- Retry e backoff ----------------------------------------------------------

test('P10 retry: solo i codici transitori', () => {
  assert.equal(isRetryableLlmStatus(429), true);
  assert.equal(isRetryableLlmStatus(503), true);
  for (const status of [400, 401, 402, 404, 500]) {
    assert.equal(isRetryableLlmStatus(status), false, String(status));
  }
});

test('P10 backoff: esponenziale dalla base, con tetto dichiarato', () => {
  assert.equal(aiLlmRetryDelayMs(0), AI_LLM_RETRY_BASE_MS);
  assert.equal(aiLlmRetryDelayMs(1), AI_LLM_RETRY_BASE_MS * 2);
  assert.equal(aiLlmRetryDelayMs(10), AI_LLM_RETRY_MAX_DELAY_MS);
  assert.ok(AI_LLM_RETRY_MAX_ATTEMPTS >= 1);
});

test('P10 backoff: Retry-After ha la precedenza, jitter esplicito e tetto rispettato', () => {
  assert.equal(aiLlmRetryDelayMs(3, 250), 250);
  assert.equal(aiLlmRetryDelayMs(0, null, 120), AI_LLM_RETRY_BASE_MS + 120);
  assert.equal(aiLlmRetryDelayMs(0, 99_000), AI_LLM_RETRY_MAX_DELAY_MS);
  assert.equal(aiLlmRetryDelayMs(0, -5), AI_LLM_RETRY_BASE_MS, 'negativo = ignorato');
});

test('P10 Retry-After: secondi, data HTTP, valori non interpretabili', () => {
  assert.equal(parseRetryAfterMs('3'), 3000);
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', Date.UTC(2026, 0, 1, 0, 0, 0)), 10_000);
  assert.equal(parseRetryAfterMs(''), null);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs('boh'), null);
});

// --- Schema prima del parse ---------------------------------------------------

test('P10 schema: JSON valido con la forma giusta passa', () => {
  const out = parseAiLlmJson(
    '```json\n{"scanEvaluations":[{"ticker":"AAPL","aiOutcome":"rialzo"}]}\n```',
    AI_LLM_SCHEMAS['ai-scan-batch']
  );
  assert.equal(out.ok, true);
  assert.equal(out.ok && Array.isArray(out.value.scanEvaluations), true);
});

test('P10 schema: JSON invalido e forma sbagliata hanno motivi distinti e stabili', () => {
  const schema = AI_LLM_SCHEMAS['ai-scan-batch'];
  const broken = parseAiLlmJson('{non json', schema);
  assert.equal(broken.ok, false);
  assert.equal(broken.ok === false && broken.reason, 'json');

  const noList = parseAiLlmJson('{"scanEvaluations":"no"}', schema);
  assert.equal(noList.ok === false && noList.reason, 'field:scanEvaluations');

  const missing = parseAiLlmJson('{"altro":1}', schema);
  assert.equal(missing.ok === false && missing.reason, 'missing:scanEvaluations');

  const notObject = parseAiLlmJson('[1,2,3]', schema);
  assert.equal(notObject.ok === false && notObject.reason, 'not_object');
});

test('P10 schema catalizzatore: decisione nell\u2019enum e bonus dentro il tetto', () => {
  const schema = AI_LLM_SCHEMAS['ai-catalyst'];
  assert.equal(validateAiLlmObject({ decisione: 'TRADE' }, schema).ok, true);
  assert.equal(validateAiLlmObject({ decisione: 'NESSUN_TRADE' }, schema).ok, true);

  const badDecision = validateAiLlmObject({ decisione: 'FORSE' }, schema);
  assert.equal(badDecision.ok === false && badDecision.reason, 'field:decisione');

  const noDecision = validateAiLlmObject({ newsBonusScore: 5 }, schema);
  assert.equal(noDecision.ok === false && noDecision.reason, 'missing:decisione');

  const bonusOut = validateAiLlmObject({ decisione: 'TRADE', newsBonusScore: 16 }, schema);
  assert.equal(bonusOut.ok === false && bonusOut.reason, 'field:newsBonusScore');

  const bonusType = validateAiLlmObject({ decisione: 'TRADE', newsBonusScore: '5' }, schema);
  assert.equal(bonusType.ok === false && bonusType.reason, 'field:newsBonusScore');
});

test('P10 schema post-mortem: uno fra executiveSummary e summary', () => {
  const schema = AI_LLM_SCHEMAS['ai-desk-post-mortem'];
  assert.equal(validateAiLlmObject({ executiveSummary: 'x' }, schema).ok, true);
  assert.equal(validateAiLlmObject({ summary: 'x' }, schema).ok, true);
  const neither = validateAiLlmObject({ altro: 1 }, schema);
  assert.equal(neither.ok === false && neither.reason, 'any_of');
  const empty = validateAiLlmObject({ executiveSummary: '   ' }, schema);
  assert.equal(empty.ok === false && empty.reason, 'any_of');

  // Uno vuoto e l'altro valido: la risposta resta usabile, come nel handler.
  assert.equal(validateAiLlmObject({ executiveSummary: '   ', summary: 'ok' }, schema).ok, true);
});

test('P10 schema specializzazione: newDirectives obbligatorio e array', () => {
  const schema = AI_LLM_SCHEMAS['ai-specialize'];
  assert.equal(validateAiLlmObject({ newDirectives: [] }, schema).ok, true);
  const wrongType = validateAiLlmObject({ newDirectives: 'x' }, schema);
  assert.equal(wrongType.ok === false && wrongType.reason, 'field:newDirectives');
});

test('P10 riga di scanEvaluations: ticker e aiOutcome obbligatori, decision leniente', () => {
  const ok = validateScanEvaluationRow({ ticker: 'AAPL', aiOutcome: 'rialzo', decision: 'AZIONE' }, AI_SHADOW_DECISIONS);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.decision, 'AZIONE');

  const noTicker = validateScanEvaluationRow({ aiOutcome: 'x' }, AI_SHADOW_DECISIONS);
  assert.equal(noTicker.ok === false && noTicker.reason, 'field:ticker');

  const noOutcome = validateScanEvaluationRow({ ticker: 'AAPL' }, AI_SHADOW_DECISIONS);
  assert.equal(noOutcome.ok === false && noOutcome.reason, 'field:aiOutcome');

  // Un quarto valore non fa scartare la riga: diventa `null`, come prima.
  const weird = validateScanEvaluationRow(
    { ticker: 'AAPL', aiOutcome: 'x', decision: 'COMPRA' },
    AI_SHADOW_DECISIONS
  );
  assert.equal(weird.ok, true);
  assert.equal(weird.ok && weird.decision, null);
});

// --- Aggancio reale: il parser dei batch --------------------------------------

test('P10 parseScanEvaluations usa lo schema condiviso: gli stessi numeri di prima', () => {
  const good = parseScanEvaluations(
    JSON.stringify({
      scanEvaluations: [
        { ticker: 'AAPL', aiOutcome: 'spinta long', aiCategory: 'news', decision: 'AZIONE' },
        { ticker: 'ENI.MI', aiOutcome: 'neutro' },
        { ticker: 'BAD', aiOutcome: '   ' },
        { aiOutcome: 'senza ticker' },
      ],
    })
  );
  assert.equal(good.ok, true);
  assert.equal(good.evaluations.length, 2, 'le righe senza ticker o esito vengono scartate');
  assert.equal(good.evaluations[0].decision, 'AZIONE');
  assert.equal(good.evaluations[1].decision, null);

  const notJson = parseScanEvaluations('risposta in prosa');
  assert.equal(notJson.ok, false);
  assert.deepEqual(notJson.evaluations, []);

  const noList = parseScanEvaluations('{"altro":[1]}');
  assert.equal(noList.ok, false);
});
