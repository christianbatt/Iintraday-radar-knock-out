/**
 * Test degli algoritmi shadow (registro regole R1–R11).
 *
 * IMPORTANTE: tutti i dati di questo file sono SINTETICI e servono solo a verificare la
 * meccanica degli algoritmi. Nessun test valida una strategia di trading, nessun test misura
 * performance su mercato reale e nessun risultato qui è usabile come segnale operativo.
 *
 * I valori attesi sono calcolati a mano e riportati nel commento di ogni blocco.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  amihudIlliquidity,
  approximateVolumeBars,
  corwinSchultzSpreadProxy,
  cusumEventIndices,
  deflatedSharpeRatio,
  expectancyBootstrap,
  filterClosedBars,
  fractionalKelly,
  isHighProbabilityWindow,
  normalCdf,
  normalQuantile,
  purgedKFold,
  sampleUniquenessWeights,
  tripleBarrierLabels,
} from '../../knowledge/shadowAlgorithms';
import { KNOWLEDGE_RULES, findKnowledgeRule } from '../../knowledge/ai_knowledge_rules';
import { ExcludedSetupRecord, TradeJournalEntry } from '../../types/radar';
import { binomialPValue, validateLearningPattern } from '../learningValidator';

const BAR_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Registro: integrità e isolamento shadow
// ---------------------------------------------------------------------------

console.log('=== Knowledge Rules / Shadow Algorithms Tests ===');

assert.equal(KNOWLEDGE_RULES.length, 11, 'Il registro deve contenere esattamente R1..R11');
const ruleIds = KNOWLEDGE_RULES.map((rule) => rule.id);
assert.deepEqual(
  ruleIds,
  ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11'],
  'Gli id devono essere R1..R11 in ordine'
);
assert.equal(new Set(ruleIds).size, ruleIds.length, 'Id duplicati nel registro');
for (const rule of KNOWLEDGE_RULES) {
  assert.equal(rule.status, 'IPOTESI', `${rule.id}: lo status deve essere IPOTESI`);
  assert.ok(rule.source.length > 10, `${rule.id}: fonte mancante`);
  assert.ok(rule.directive.length > 20, `${rule.id}: direttiva troppo corta`);
  assert.ok(['OHLCV_5m', 'TICK', 'L2'].includes(rule.dataRequirement), `${rule.id}: dataRequirement non valido`);
  assert.ok(rule.implementationNote.includes('IPOTESI') || rule.implementationNote.length > 40, `${rule.id}: nota mancante`);
  if (rule.validatedBy) {
    assert.ok(rule.validatedBy.startsWith('src/utils/__tests__/'), `${rule.id}: validatedBy fuori dai test`);
    assert.ok(rule.validatedBy.includes('#'), `${rule.id}: validatedBy senza id test`);
  }
}
assert.equal(findKnowledgeRule('R9')?.implementable, false, 'R9 (L2) non deve essere implementabile');
assert.equal(findKnowledgeRule('R11')?.implementable, false, 'R11 (earnings) non deve essere implementabile');

// I test citati in validatedBy devono esistere davvero nel file di test corrente.
const selfSource = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
for (const rule of KNOWLEDGE_RULES) {
  if (!rule.validatedBy) continue;
  const testId = rule.validatedBy.split('#')[1];
  assert.ok(selfSource.includes(`"${testId}"`), `${rule.id}: validatedBy ${testId} non esiste nel file di test`);
}
console.log('Test 0 - registro R1..R11 completo, status IPOTESI, validatedBy esistenti: PASS');

// Isolamento shadow: nessun modulo di trading importa il registro o gli algoritmi.
for (const tradingFile of ['../calculator.ts', '../../../server.ts']) {
  const source = fs.readFileSync(fileURLToPath(new URL(tradingFile, import.meta.url)), 'utf8');
  assert.ok(!source.includes('ai_knowledge_rules'), `${tradingFile}: il registro non deve essere importato dal codice di trading`);
  assert.ok(!source.includes('shadowAlgorithms'), `${tradingFile}: gli algoritmi shadow non devono entrare nel codice di trading`);
}
console.log('Test 0b - isolamento shadow (calculator.ts, server.ts): PASS');

// ---------------------------------------------------------------------------
// R1 — Triple barrier
// Dati sintetici: 5 barre 5m, ingressi a 100 / 102.2 / 98, barriere ±2%.
// ---------------------------------------------------------------------------

const barrierBars = [
  { t: 0, o: 100, h: 100.5, l: 99.5, c: 100, v: 1000 },
  { t: BAR_MS, o: 100, h: 101, l: 99.5, c: 100.4, v: 900 },
  { t: 2 * BAR_MS, o: 100.4, h: 102.5, l: 100.2, c: 102.2, v: 800 },
  { t: 3 * BAR_MS, o: 102.2, h: 102.4, l: 100.5, c: 101, v: 700 },
  { t: 4 * BAR_MS, o: 101, h: 101.2, l: 97.5, c: 98, v: 600 },
];
const barrierConfig = { upperFraction: 0.02, lowerFraction: 0.02, verticalBars: 4, barMs: BAR_MS };
const allClosed = 5 * BAR_MS;
const samples = tripleBarrierLabels(barrierBars, [0, 2, 4], barrierConfig, allClosed);

// Evento 0: entry 100, upper 102, lower 98. Barra 2 high 102.5 >= 102 ⇒ +1 con return 2%.
assert.equal(samples[0].label, 1);
assert.equal(samples[0].outcome, 'UPPER');
assert.equal(samples[0].t1Index, 2);
assert.equal(samples[0].t1, 2 * BAR_MS);
assert.ok(Math.abs((samples[0].returnFraction ?? 0) - 0.02) < 1e-12);
// Evento 2: entry 102.2, upper 104.244, lower 100.156. Barra 4 low 97.5 <= 100.156 ⇒ -1.
assert.equal(samples[1].label, -1);
assert.equal(samples[1].outcome, 'LOWER');
assert.equal(samples[1].t1Index, 4);
assert.ok(Math.abs((samples[1].returnFraction ?? 0) + 0.02) < 1e-12);
// Evento 4: la barriera verticale (indice 8) non è raggiungibile ⇒ non etichettato.
assert.equal(samples[2].label, null);
assert.equal(samples[2].outcome, 'UNRESOLVED');
assert.equal(samples[2].t1Index, null);

// Barriera verticale: entry 100, nessuna barriera toccata entro 1 barra ⇒ label 0, exit 100.2.
const verticalBars = [
  { t: 0, o: 100, h: 100.5, l: 99.5, c: 100, v: 1000 },
  { t: BAR_MS, o: 100, h: 100.6, l: 99.6, c: 100.2, v: 900 },
];
const verticalSample = tripleBarrierLabels(verticalBars, [0], { ...barrierConfig, verticalBars: 1 }, 2 * BAR_MS)[0];
assert.equal(verticalSample.label, 0);
assert.equal(verticalSample.outcome, 'VERTICAL');
assert.equal(verticalSample.t1Index, 1);
assert.ok(Math.abs((verticalSample.returnFraction ?? 0) - 0.002) < 1e-12);

// Look-ahead: con nowMs = 1 barra chiusa, la barra 1 (t + BAR_MS > nowMs) non entra nel percorso.
assert.equal(filterClosedBars(barrierBars, BAR_MS, BAR_MS).length, 1);
const lookAheadSample = tripleBarrierLabels(barrierBars, [0], barrierConfig, BAR_MS)[0];
assert.equal(lookAheadSample.label, null, 'Nessuna etichetta se le barre future non sono chiuse');
assert.equal(lookAheadSample.outcome, 'UNRESOLVED');
console.log('Test "R1_triple_barrier" - upper/lower/vertical/unresolved + guardia look-ahead: PASS');

// ---------------------------------------------------------------------------
// R2 — Pesi per unicità
// Due finestre di 3 barre su 4: concorrenza [1,2,2,1] ⇒ peso (1 + 1/2 + 1/2)/3 = 2/3 ciascuna,
// somma 4/3 (= barre distinte coperte / lunghezza finestra = 4/3). Verificato a mano.
// ---------------------------------------------------------------------------

const overlapping = sampleUniquenessWeights([{ startIndex: 0, endIndex: 2 }, { startIndex: 1, endIndex: 3 }], 4);
assert.ok(Math.abs(overlapping[0] - 2 / 3) < 1e-12, `w0=${overlapping[0]}`);
assert.ok(Math.abs(overlapping[1] - 2 / 3) < 1e-12, `w1=${overlapping[1]}`);
assert.ok(Math.abs(overlapping[0] + overlapping[1] - 4 / 3) < 1e-12);

// Tre trade identici su 2 barre: concorrenza 3 ⇒ peso (1/3 + 1/3)/2 = 1/3, somma 1.
const identical = sampleUniquenessWeights(
  [{ startIndex: 0, endIndex: 1 }, { startIndex: 0, endIndex: 1 }, { startIndex: 0, endIndex: 1 }],
  2
);
assert.ok(identical.every((weight) => Math.abs(weight - 1 / 3) < 1e-12));
assert.ok(Math.abs(identical.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);

// Trade disgiunti: concorrenza 1 ⇒ peso 1.
assert.deepEqual(
  sampleUniquenessWeights([{ startIndex: 0, endIndex: 0 }, { startIndex: 1, endIndex: 1 }], 2),
  [1, 1]
);
console.log('Test "R2_uniqueness" - pesi 2/3+2/3 e 1/3×3 verificati a mano: PASS');

// ---------------------------------------------------------------------------
// R3 — Purged k-fold con embargo
// 10 campioni, campione i copre [i, i+2], k=5, embargo 2.
// Fold 0: test [0,1] ⇒ finestra [0,3]; purge = campioni 2 e 3 (intersecano), embargo = 4 e 5
// (iniziano entro 2 barre da 3) ⇒ training [6,7,8,9]. Verificato a mano.
// ---------------------------------------------------------------------------

const spans = Array.from({ length: 10 }, (_, index) => ({ startIndex: index, endIndex: index + 2 }));
const folds = purgedKFold(spans, 5, 2);
assert.equal(folds.length, 5);
assert.deepEqual(folds[0].testIndices, [0, 1]);
assert.deepEqual(folds[0].purgedIndices, [2, 3]);
assert.deepEqual(folds[0].embargoIndices, [4, 5]);
assert.deepEqual(folds[0].trainIndices, [6, 7, 8, 9]);

for (const fold of folds) {
  const testStart = Math.min(...fold.testIndices.map((index) => spans[index].startIndex));
  const testEnd = Math.max(...fold.testIndices.map((index) => spans[index].endIndex));
  for (const index of fold.trainIndices) {
    const overlaps = spans[index].startIndex <= testEnd && spans[index].endIndex >= testStart;
    assert.ok(!overlaps, `fold ${fold.fold}: campione ${index} di training si sovrappone al test`);
    const inEmbargo = spans[index].startIndex > testEnd && spans[index].startIndex <= testEnd + 2;
    assert.ok(!inEmbargo, `fold ${fold.fold}: campione ${index} di training cade nell'embargo`);
    assert.ok(!fold.testIndices.includes(index), `fold ${fold.fold}: campione ${index} in test e training`);
    assert.ok(!fold.purgedIndices.includes(index) && !fold.embargoIndices.includes(index));
  }
}
console.log('Test "R3_purged_kfold" - nessun leakage test/training, purge+embargo attesi: PASS');

// ---------------------------------------------------------------------------
// R4 — Deflated Sharpe Ratio
// Rendimenti sintetici [0.01, -0.01, 0.01, -0.01]: media 0 ⇒ SR = 0, skew 0, kurtosi grezza 1.
// Var[SR] = (1 - 0 + 0)/3 = 1/3. Con T = 2:
//   SR0 = √(1/3)·[0.4228·Φ⁻¹(0.5) + 0.5772·Φ⁻¹(1-1/(2e))]
//       = 0.57735·(0 + 0.5772·0.90045) = 0.57735·0.51974 = 0.30007
//   DSR = Φ((0 - 0.30007)/0.57735) = Φ(-0.51974) = 0.3016
// ---------------------------------------------------------------------------

const dsr = deflatedSharpeRatio([0.01, -0.01, 0.01, -0.01], 2);
assert.equal(dsr.status, 'OK');
assert.ok(Math.abs((dsr.sharpe ?? 1) - 0) < 1e-12, `SR=${dsr.sharpe}`);
assert.ok(Math.abs((dsr.sharpeZero ?? 0) - 0.30007) < 0.001, `SR0=${dsr.sharpeZero}`);
assert.ok(Math.abs((dsr.deflated ?? 0) - 0.3016) < 0.002, `DSR=${dsr.deflated}`);
assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
assert.ok(Math.abs(normalQuantile(0.975) - 1.959964) < 1e-4, `z(0.975)=${normalQuantile(0.975)}`);

// Più prove ⇒ deflazione più severa (DSR monotono decrescente in T).
const positiveReturns = [0.02, 0.01, -0.005, 0.015, 0.005];
const lowTrials = deflatedSharpeRatio(positiveReturns, 2);
const highTrials = deflatedSharpeRatio(positiveReturns, 50);
assert.ok((highTrials.deflated ?? 1) < (lowTrials.deflated ?? 0), 'DSR deve calare al crescere di T');

// Casi limite dichiarati: campione corto, varianza nulla, T < 2.
assert.equal(deflatedSharpeRatio([0.01, 0.02], 2).status, 'INSUFFICIENT_SAMPLE');
assert.equal(deflatedSharpeRatio([0.01, 0.01, 0.01], 2).status, 'ZERO_VARIANCE');
assert.equal(deflatedSharpeRatio(positiveReturns, 1).status, 'INVALID_TRIALS');
console.log('Test "R4_dsr" - valore di riferimento 0.3016 e casi limite: PASS');

// ---------------------------------------------------------------------------
// R5 — Kelly frazionato con tetto (frazione 0.5, tetto 0.25)
// p = 0.5, b = 1 ⇒ f* = 0.5 - 0.5/1 = 0 ⇒ size 0.
// p = 0.6, b = 2 ⇒ f* = 0.6 - 0.4/2 = 0.4 ⇒ 0.5·0.4 = 0.2 (sotto il tetto).
// p = 0.9, b = 3 ⇒ f* = 0.9 - 0.1/3 = 0.8667 ⇒ 0.4333 ⇒ tetto 0.25.
// ---------------------------------------------------------------------------

const coinFlip = fractionalKelly(0.5, 1);
assert.ok(Math.abs(coinFlip.fullKelly) < 1e-12 && coinFlip.size === 0, 'p=0.5, b=1 deve dare 0');
const moderate = fractionalKelly(0.6, 2);
assert.ok(Math.abs(moderate.fullKelly - 0.4) < 1e-12);
assert.ok(Math.abs(moderate.size - 0.2) < 1e-12);
const capped = fractionalKelly(0.9, 3);
assert.ok(capped.size <= capped.cap && Math.abs(capped.size - 0.25) < 1e-12);
assert.equal(capped.status, 'IPOTESI');
// Input non validi ⇒ nessuna size (mai negative).
assert.equal(fractionalKelly(-0.2, 2).size, 0);
assert.equal(fractionalKelly(0.6, 0).size, 0);
assert.equal(fractionalKelly(0.4, 2).size >= 0, true);
console.log('Test "R5_kelly" - tetto 0.25, frazione 0.5, p=0.5 ⇒ 0: PASS');

// ---------------------------------------------------------------------------
// R6 — Filtro CUSUM
// Prezzi [100, 100.5, 101.2, 100.9, 102.5], h = 1:
// +0.5 (no), +1.2 ⇒ evento a 2; poi -0.3, +1.6 ⇒ evento a 4. Attesi [2, 4].
// ---------------------------------------------------------------------------

assert.deepEqual(cusumEventIndices([100, 100.5, 101.2, 100.9, 102.5], 1), [2, 4]);
assert.deepEqual(cusumEventIndices([100, 100.1, 100.2], 1), []);
console.log('Test "R6_cusum" - eventi [2,4] verificati a mano: PASS');

// ---------------------------------------------------------------------------
// R7 — Proxy Corwin-Schultz e Amihud
// Due barre identiche H=101, L=99: con β = 2x², γ = x² e x = ln(101/99) = 0.0200007,
// α = x(3.41421 - 2.41421) = x ⇒ spread = 2(e^x - 1)/(1 + e^x) = 0.02. Verificato a mano.
// Amihud: |101/100 - 1| / (101·1000) · 1e6 = 0.01/101000·1e6 = 0.09901.
// ---------------------------------------------------------------------------

const spreadBars = [
  { t: 0, o: 100, h: 101, l: 99, c: 100, v: 1000 },
  { t: BAR_MS, o: 100, h: 101, l: 99, c: 101, v: 1000 },
];
const spreads = corwinSchultzSpreadProxy(spreadBars);
assert.equal(spreads[0], null);
assert.ok(Math.abs((spreads[1] ?? 0) - 0.02) < 1e-4, `spread=${spreads[1]}`);
const illiquidity = amihudIlliquidity(spreadBars);
assert.equal(illiquidity[0], null);
assert.ok(Math.abs((illiquidity[1] ?? 0) - 0.0990099) < 1e-5, `amihud=${illiquidity[1]}`);
// Volume nullo ⇒ nessuna stima (non zero inventato).
assert.equal(amihudIlliquidity([{ ...spreadBars[0] }, { ...spreadBars[1], v: 0 }])[1], null);
console.log('Test "R7_spread_amihud" - spread 0.02 e Amihud 0.09901: PASS');

// ---------------------------------------------------------------------------
// R8 — Volume bars (solo approssimazione)
// Volumi [100, 100, 100, 100] con target 250: primo bucket completo a 300 (3 barre),
// il quarto resta incompleto e viene scartato ⇒ 1 barra sintetica.
// ---------------------------------------------------------------------------

const volumeBars = [
  { t: 0, o: 10, h: 11, l: 9.5, c: 10.5, v: 100 },
  { t: BAR_MS, o: 10.5, h: 11.2, l: 10.2, c: 10.8, v: 100 },
  { t: 2 * BAR_MS, o: 10.8, h: 11.4, l: 10.6, c: 11, v: 100 },
  { t: 3 * BAR_MS, o: 11, h: 11.1, l: 10.9, c: 11, v: 100 },
];
const volumeApprox = approximateVolumeBars(volumeBars, 250);
assert.equal(volumeApprox.length, 1);
assert.equal(volumeApprox[0].v, 300);
assert.equal(volumeApprox[0].sourceBars, 3);
assert.equal(volumeApprox[0].t, 2 * BAR_MS);
assert.equal(volumeApprox[0].o, 10);
assert.equal(volumeApprox[0].c, 11);
assert.equal(volumeApprox[0].h, 11.4);
assert.equal(volumeApprox[0].l, 9.5);
assert.equal(volumeApprox[0].exact, false, 'La barra deve dichiararsi approssimata');
console.log('Test "R8_volume_bars" - bucket 300 su target 250, coda incompleta scartata: PASS');

// ---------------------------------------------------------------------------
// R10 — Finestra oraria (IPOTESI, nessuna validazione statistica)
// 05/11/2026 è in EST (UTC-5): 14:45Z = 09:45 ET ⇒ dentro; 15:45Z = 10:45 ET ⇒ fuori.
// ---------------------------------------------------------------------------

const usMorning = Date.UTC(2026, 10, 5, 14, 45);
assert.equal(isHighProbabilityWindow(usMorning, 'US', usMorning + BAR_MS), true);
assert.equal(isHighProbabilityWindow(Date.UTC(2026, 10, 5, 15, 45), 'US', Date.UTC(2026, 10, 5, 15, 45) + BAR_MS), false);
assert.equal(isHighProbabilityWindow(Date.UTC(2026, 10, 5, 14, 0), 'US', Date.UTC(2026, 10, 5, 14, 0) + BAR_MS), false);
// Barra non ancora chiusa ⇒ mai dentro la finestra (guardia look-ahead).
assert.equal(isHighProbabilityWindow(usMorning, 'US', usMorning + 1000), false);
// EU: 08:30Z = 09:30 Rome (CET, UTC+1) ⇒ dentro.
const euMorning = Date.UTC(2026, 10, 5, 8, 30);
assert.equal(isHighProbabilityWindow(euMorning, 'EU', euMorning + BAR_MS), true);
console.log('Test "R10_hypothesis_window" - finestre ET/CET e guardia look-ahead: PASS');

// ---------------------------------------------------------------------------
// Validatore: campi informativi aggiunti (nessun gate nuovo)
// Dati sintetici: 30 trade finti, 22 WIN a +1.6R e 8 LOSS a -1R.
// mean R = (22·1.6 - 8)/30 = 0.9067; p binomiale esistente resta il gate FDR di sempre.
// ---------------------------------------------------------------------------

function createTrade(index: number, outcome: 'WIN' | 'LOSS'): TradeJournalEntry {
  const rMultiple = outcome === 'WIN' ? 1.6 : -1;
  return {
    id: `synthetic-${index}`,
    timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    date: '01/01/2026',
    session: 'EU',
    market: 'EU',
    ticker: `SYN${index}.MI`,
    direction: 'LONG',
    strategy: 'ORB_BREAKOUT',
    entryPrice: 100,
    exitPrice: outcome === 'WIN' ? 101.6 : 99,
    stopLoss: 99,
    target1: 101.6,
    pnlEur: rMultiple * 50,
    rMultiple,
    outcome,
    status: 'CLOSED',
    notes: '',
    isPaper: false,
  };
}

function createExcluded(index: number): ExcludedSetupRecord {
  return {
    id: `synthetic-excluded-${index}`,
    ticker: `EX${index}.MI`,
    name: `Excluded ${index}`,
    market: 'EU',
    currency: 'EUR',
    sessionDate: '01/01/2026',
    timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    score: 60,
    gapPercent: 0.5,
    rvol: 1,
    rsi: 50,
    atr: 1,
    primaryReasonCategory: 'RVOL_INSUFFICIENT',
    primaryReasonLabel: 'RVOL insufficiente',
    detail: 'Fixture sintetica',
    direction: 'LONG',
    initialPrice: 100,
    entryTrigger: 100,
    stopLoss: 99,
    target1: 101,
    riskDist: 1,
    outcomeStatus: 'THEORETICAL_PROFIT',
    theoreticalRMultiple: 1,
  };
}

const syntheticTrades = Array.from({ length: 30 }, (_, index) => createTrade(index, index < 22 ? 'WIN' : 'LOSS'));
const syntheticExcluded = Array.from({ length: 5 }, (_, index) => createExcluded(index));

const validated = validateLearningPattern(syntheticTrades, syntheticExcluded, 'SYNTHETIC_TOPIC', 'EU');
assert.ok(validated !== null);

// Regressione: la metrica pValue usata dai gate esistenti è invariata (binomiale 22/30).
assert.equal(validated.stats.pValue, binomialPValue(22, 30, 0.5), 'stats.pValue non deve cambiare');
assert.equal(validated.stats.n, 30);
assert.ok(Math.abs(validated.stats.avgR - (22 * 1.6 - 8) / 30) < 1e-12);
assert.equal(validated.stats.counterfactual.n, 5);

// Soglia minima invariata: 29 trade restano insufficienti.
assert.equal(validateLearningPattern(syntheticTrades.slice(0, 29), [], 'SHORT_SAMPLE', 'EU'), null);

// Campi nuovi: expectancy bootstrap con p-value, DSR informativo, flag controfattuali.
assert.ok(validated.expectancy !== null);
assert.equal(validated.expectancy?.method, 'BOOTSTRAP_SIGN_FLIP');
assert.ok((validated.expectancy?.pValue ?? 1) < 0.05, `expectancy p=${validated.expectancy?.pValue}`);
assert.equal(validated.expectancy?.significant, true);
assert.equal(validated.expectancy?.status, 'IPOTESI');
assert.ok(Math.abs((validated.expectancy?.meanR ?? 0) - (22 * 1.6 - 8) / 30) < 1e-12);

// Determinismo del bootstrap: stesso seed ⇒ stesso p-value.
const bootstrapA = expectancyBootstrap([1.6, 1.6, -1, 1.6]);
const bootstrapB = expectancyBootstrap([1.6, 1.6, -1, 1.6]);
assert.ok(bootstrapA !== null && bootstrapB !== null);
assert.equal(bootstrapA.pValue, bootstrapB.pValue);
assert.equal(expectancyBootstrap([1]), null);

// DSR: senza T dichiarato resta informativo e nullo; con T dichiarato è calcolato.
assert.equal(validated.deflatedSharpe.status, 'INVALID_TRIALS');
assert.equal(validated.deflatedSharpe.deflated, null);
const withTrials = validateLearningPattern(syntheticTrades, syntheticExcluded, 'SYNTHETIC_TOPIC', 'EU', {
  dsrTrials: 5,
  counterfactualShared: true,
});
assert.equal(withTrials?.deflatedSharpe.status, 'OK');
assert.ok((withTrials?.deflatedSharpe.deflated ?? 0) > 0 && (withTrials?.deflatedSharpe.deflated ?? 0) <= 1);
assert.equal(withTrials?.counterfactualShared, true);
assert.equal(validated.counterfactualShared, false, 'Default: controfattuali non condivisi');

console.log('Test "validator_shadow_fields" - expectancy, DSR, counterfactualShared, gate invariati: PASS');
console.log('=== Tutti i test knowledge rules completati ===');
