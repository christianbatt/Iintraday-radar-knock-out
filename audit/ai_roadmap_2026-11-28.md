# Roadmap AI — piano operativo a fasi

**Stato:** attivo · **Creato:** 2026-11-28 · **Riferimento:** `audit/ai_calibration_pr_c.md` (storia delle decisioni), audit del desk AI del 2026-11-28.
Questo file è la **memoria di lavoro**: si aggiorna a ogni passo concluso, segnando la casella e la data. Se un passo cambia forma, si aggiorna qui *prima* di scrivere codice.

## Regole di ingaggio (valgono per ogni passo)

1. Un passo = un commit, con footer `🤖 Generated with Codebuff` + `Co-Authored-By: Codebuff <noreply@codebuff.com>`. Push su `main` solo via `cloud_git`; CI verde **sul nuovo SHA** prima del passo successivo.
2. Sempre additivo: nessun passo tocca i gate G1–G13, `tradingParams.ts`, la selezione dei setup o i punteggi esistenti. Le uniche eccezioni (Fase 7 e Fase 8) richiedono autorizzazione esplicita dell'utente e restano dietro flag.
3. Definizione di "fatto": `npx tsc --noEmit` exit 0 → test mirati → i 31 passi CI in locale → push → CI verde. Mai "dovrebbe funzionare".
4. Dimensione massima di un passo: ≤ 3 file di produzione e ≤ ~400 righe nette, altrimenti si spezza.
5. Nessun passo dipende da una chiave LLM. Se una chiave manca, il passo resta verde e la vista resta `INSUFFICIENTE`: è un esito corretto.
6. Nessun numero inventato: ogni soglia nuova è una costante con nome, dichiarata prima di guardare i dati e testata sul bordo.

## Stato dei dati (verificato il 2026-11-28)

- `shadow_ai_scans.jsonl`: 160 righe, **0 valutate**, **0 con `decision`**.
- `artifacts/shadow_v1_live/signals.jsonl`: 10 segnali (5 STOP, 2 EXPIRED, 3 TARGET), R medio lordo **+0,034**.
- `artifacts/shadow_v1_live/near_miss.jsonl`: 19 record, 15 risolti, R medio **−0,040**.
- `ai_specialization_memory.json`: 3 regole, tutte `confidence: null` (ipotesi scritte a mano).
- `shadow_ai_log.jsonl`: **assente**.
- `artifacts/shadow_v1_live/bars.json`: **24.000 barre 5m su 40 ticker, con OHLC** (2,4 MB). Verificato dalla baseline: il file è una mappa verso liste di wrapper `{ ticker, market, bars: [...], updatedAt }`, non una lista di barre — srotolarlo è obbligatorio, altrimenti si contano gli involucri. Da questo dato dipendono la Fase 6 (spread stimato) e la Fase 8 (dataset event-based): **entrambe sono possibili**.
- Costo dichiarato per trade: **0,36 R** (0,20 fee + 0,16 spread al tetto non misurato).
- **Chiavi LLM:** `OPENROUTER_API_KEY` / `GEMINI_API_KEY` **non presenti in questo worktree**; vivono nei project secrets di Google AI Studio / Cloud Run. Nessuna chiave va mai scritta in chat, in un file del repo o in un comando.

---

## Fase 0 — Baseline verificabile

- [x] **0.1 Fotografia e verifica dei dati disponibili.** *(fatto 2026-11-28)* `src/server/aiBaseline.ts` (puro, iniettabile), `scripts/ai_baseline.ts`, test, `artifacts/audit/baseline_*.json`. Serve a sapere *davvero* cosa c'è (OHLC nelle barre? quanti ticker? quante righe?) prima di progettare Fase 6 e Fase 8.

## Fase 1 — Verità economica

- [x] **1.1 Check `net_profitability` nel validatore.** *(fatto 2026-11-28)* `AI_DESK_VALIDATION_MIN_NET_R = 0.1`, check su `meanRNet(AZIONE)`; assente ⇒ `insufficient` (mai `CONFERMATO` senza il dato); bump `ai-desk-validation@1` → `@2` e aggiornamento di test, UI e commenti.
- [x] **1.2 UI onesta.** *(fatto 2026-11-28)* `DeskPostMortemCard`: rimuovere "Ora attive per filtrare…"; badge "non misurata" sulle regole senza `confidence`; `n` sempre accanto ai numeri.

## Fase 2 — Misurare l'AI che decide (catalizzatore)

> **Stato 2026-11-28:** il commit `0e5f917` ("update AI models and refresh diagnostics") ha
> implementato gran parte di questa fase, con una forma diversa da quella prevista qui:
> log `source: 'catalyst'` in entrambi i rami (LLM e fallback), `promptVersion` `ai-catalyst@3`,
> `candidateKey` prefissato `catalyst:` per non collide­re con la riga `scan`, `durationMs`,
> `model`, e `catalystLift` (con/senza bonus, allineato/opposto) nella calibrazione con blocco
> nel pannello. Inoltre il bonus è stato limitato (max +5, 0 sotto confidenza 55) e `newsFilter.ts`
> filtra freschezza e pertinenza dei titoli. **Non serve rifare 2.1–2.3:** restano solo le lacune
> elencate sotto (2.5, 2.6).

- [x] **2.1–2.3 Log e calibrazione del catalizzatore.** *(fatto in `0e5f917`, forma: campi in `aiCategory` e `catalystLift`)*
- [x] **2.5 Provenienza della memoria nel prompt.** *(fatto 2026-11-28: `memoryRuleIds` sanificato, dedupe, tetto 8; manca ancora `validUntil` nel log)* `memoryRuleIds` sulla riga del catalizzatore: quali regole apprese sono state iniettate (con `validUntil`), così l'effetto di una regola è attribuibile e non solo ipotizzato.
- [x] **2.6 Veto strutturato.** *(fatto 2026-11-28: `vetoReason` `NO_NEWS` / `COUNTER_REGIME` + `vetoSource`, il testo resta solo fallback)* `vetoReason` (`EARNINGS` / `FUNDAMENTAL` / `NONE`) e `vetoSource` (`llm` / `text-legacy`) al posto della sola euristica testuale in `calculator.ts`: oggi una squalifica può dipendere da `includes('nessuna notizia')`.
- [ ] **2.1 Contratto di log.** `source: 'catalyst'`, `catalystDecision`, `newsBonus` 0–15, `newsBonusBand` (`0` / `1-7` / `8-15`, costante dichiarata), `hasNews`, `vetoReason`, `vetoSource` (`llm` | `text-legacy`), `memoryRuleIds`.
- [ ] **2.2 Wiring in `POST /api/analyze-catalyst`** (`server.ts:4028`): log di ogni esito, inclusi ramo fallback deterministico e `NESSUN_TRADE`; `promptVersion: 'ai-catalyst@1'`; nessun cambio di selezione (test di non-regressione).
- [ ] **2.3 Calibrazione del catalizzatore.** Aggregato `catalyst` nel join esistente, **fuori** dai bucket AZIONE/ATTESA/SCARTO: test gemelli che dimostrano verdetto principale invariato.
- [ ] **2.4 Pannello "Catalizzatore"** in `ShadowAISection`: bande di bonus, `edgeR` alto-vs-zero con IC, falsi veti, quota `text-legacy`.

## Fase 3 — Sicurezza e attribuzione della memoria

- [x] **3.1 Provenienza estesa:** `writerUid`, `runId`, `datasetHash` (SHA-256 degli `id` unici ordinati). *(fatto 2026-11-28; `minRealizedAt` non ancora)*
- [x] **3.2 Memoria per-utente** `users/{uid}/ai_specialization_memory/current` con regole storiche visibili come `legacy: true`, mai riscritte nel documento dell'utente. *(fatto 2026-11-28: `src/server/aiMemoryScope.ts`, migrazione idempotente, file locale per uid)*
- [x] **3.3 Campione canonico.** *(fatto 2026-11-28)* Il campione viene solo da `sharedAppState.journalEntries`; `req.body.trades` non è più una fonte. `buildCanonicalSample` scarta e conta righe senza `id`, duplicati e chiusure oltre 5 minuti nel futuro; la risposta dichiara `datasetSource`, `datasetHash` e `rejectedTrades`. Test di poisoning fra due utenti. Resta aperto solo l'aggiornamento della UI, che ora mostra il 400 quando il diario canonico è vuoto.

## Fase 4 — Ciclo di vita delle regole

- [x] **4.1** `validUntil` (90 giorni), `lastTestedAt`, `testCount`, `revokedAt` + `isRuleActive(entry, nowMs)` usata dall'iniezione nel prompt. *(fatto 2026-11-28 in `src/server/aiMemoryLifecycle.ts`; le regole storiche ricevono la scadenza derivata da `learnedAt`)* **Corretto il 28/11:** `stampTestedRule` non era mai chiamata, quindi un re-test superato non rinnovava nulla. Ora `renewRulesForPassingPredicates` gira in `/api/ai/specialize` prima della revoca, non dipende dal modello (un re-test deterministico è un fatto) e non resuscita una regola revocata; `updateAIMemory` conserva e incrementa `testCount` quando riscrive la stessa regola.
- [x] **4.2 Prompt senza percentuali.** *(fatto, con una deviazione dichiarata: il blocco vive in `aiMemoryLifecycle.ts` invece che in un nuovo `aiMemoryPrompt.ts`; mostra `q`, `n`, `validUntil`, `model` e un test impone l'assenza di `%`)*
- [x] **4.3 Revoca su re-test fallito**, registro append-only `logs/ai_memory_revocations.jsonl`. *(fatto solo in `/api/ai/specialize`: il post-mortem non revoca)* **Corretto il 28/11:** il mapping era rotto — la scansione scrive il topic come `PREDICATO_<id>`, mentre il confronto usava l'id nudo (`LEVERAGE_5`), quindi la revoca non scattava mai. Ora `ruleTopicForPredicateRow` è l'unico punto che deriva il nome, e il mapping è verificato su una scansione reale (40 vincenti a leva 5, 40 perdenti a leva 10) in `ai_memory_lifecycle.test.ts`.

## Fase 5 — Potenza statistica e falsificazione

- [x] **5.1 `requiredSampleSize({varianceR, effectR, alpha, power})`** + "servono N trade, ne hai M" nel pannello. *(fatto 2026-11-28: `src/utils/aiPowerAnalysis.ts` — non `src/server`, perché il pannello lo importa e il guard client vieta moduli server nel bundle; quantili normali Acklam, formula n = (z_{1-α/2}+z_power)²σ²/δ²; `power` dentro `uncertainty` della calibrazione e riga nel pannello. Approssimazione normale dichiarata, non un test t esatto)*
- [x] **5.2 IC bootstrap deterministico su `avgR(AZIONE)`** *(fatto 2026-11-28: `src/server/aiMeanInterval.ts` agganciato in `buildUncertainty` → `uncertainty.avgRNet`; il validatore espone il check **diagnostico** `avg_r_ci` (`diagnostic: true`, escluso dal calcolo del verdetto) e il pannello mostra media, IC95% e `n` con la dicitura "diagnostica, non entra nel verdetto". Seed derivata `AI_CALIBRATION_BOOTSTRAP_SEED + 2`, nessun orologio)*
- [x] **5.3 Harness Monte Carlo** (`scripts/validator_mc.ts`, seed fisse): falsi positivi a edge nullo e potenza a edge noto, con asserzioni che falliscono se le soglie sono troppo permissive. *(fatto 2026-11-28, `npm run test:validator-mc` in CI. Misurato: edge nullo 20+20 casi, 400 repliche → **3,0% CONFERMATO** (tetto dichiarato 5%); edge vero 1 R, 100+100 casi, 300 repliche → **100% CONFERMATO** (minimo 90%); due esecuzioni identiche. Risultato collaterale dichiarato: senza il gate IC sull'edge le stime puntuali confermano il **12,8%** dei campioni a edge nullo, quindi è l'IC a tenere a bada i falsi positivi. Limiti: R normali e bucket indipendenti, ipotesi non verificabile su dati reali)*

## Fase 6 — Costo reale per trade

- [x] **6.1 `costR` per riga** (fee + spread stimato se le barre hanno OHLC, altrimenti tetto dichiarato; scala con la leva), `costSource` per riga; test di equivalenza col costo costante. *(fatto 2026-11-28: `src/server/aiTradeCost.ts`; fee 0,20 R + Corwin-Schultz/stopPct (tetto 0,16 R) + spread certificato KO 2×0,2%/(leva·stopPct), tetto totale 0,25 R come Shadow V2. Fonti: `per_row_cs_leverage` / `per_row_cs` / `per_row_leverage` / `declared_ceiling`; le righe senza dati valgono **esattamente** 0,36 R, verificato a mano (stop 10% → 0,3063 R). Riepilogo in `costSummary` e riga nel pannello. **Limite dichiarato:** i record di V1-live non registrano la leva, quindi oggi il termine certificato vale 0 e la fonte è `per_row_cs`; il termine è coperto dai test ma non da dati reali)*
- [x] **6.2 Convenienza per policy** nel pannello (`meanRNet`, `sumRNet`, quota sotto costo) con `n` visibile. *(fatto 2026-11-28: `policies[].belowCostPct` = quota di trade con `rNet < 0`; il pannello mostra `CODICE n=… media … · somma … · sotto costo …%`. Test con numeri calcolati a mano: 3 AZIONE a +1,00/+0,10/−1,00 → somma −0,98, media −0,3267, 66,67% sotto costo)*
- [x] **Misura sui dati reali** (`npm run audit:cost-per-row` → `artifacts/audit/cost-per-row-2026-11-28.json`): 57 esiti risolti, **tutti `per_row_cs`**, costo medio **0,2889 R** (min 0,20 max 0,36); 20/57 righe hanno lo spread al **pavimento** di Corwin-Schultz (0 = non misurabile), e trattandole come non misurate la media sale a **0,345 R**. R netto medio −0,113 R contro −0,184 R col costo costante: il desk resta in perdita in entrambi i casi.

## Fase 7 — Dal predicato alla feature ⚠️ richiede autorizzazione

- [ ] **7.1 Lift del predicato** (`avgR(pred) − avgR(complemento)`, IC bootstrap) in `artifacts/`, nessun effetto sulla selezione.
- [ ] **7.2 Peso additivo dietro `AI_PREDICATE_WEIGHT=1`** (default off), tetto ±4 punti su 100, solo regole attive con IC sopra zero; con flag spento output identico (snapshot test).

## Fase 8 — Sperimentale ⚠️ adozione solo con autorizzazione

- [ ] **8.1 Dataset event-based** (`cusumEventIndices` + `tripleBarrierLabels`) in `artifacts/datasets/`, riproducibile, nessun effetto in produzione.
- [ ] **8.2 Meta-modello** logistico in repo, walk-forward `purgedKFold`, report AUC/Brier; sotto AUC 0,5 si archivia.
- [ ] **8.3 Meta-label in shadow** (`TAKE`/`SKIP` + probabilità) nel log e nella UI come informativo; test che la selezione non cambia.
- [ ] **8.4 Conformal (split)** per intervalli a copertura garantita; verifica copertura osservata entro ±5 punti.

## Fase 9 — Igiene operativa

- [ ] **9.1 Budget, schema, retry:** `maxTokens`, tetto chiamate per richiesta/utente, validazione schema prima del parse, backoff su 429, allarme su `ERRORE_PARSING`.
- [ ] **9.2 Champion/challenger** dei prompt con decisione sequenziale (alpha/beta dichiarati) su `edgeRNet`.

---

## Diario dei passi

| Data | Passo | Commit | Esito |
|---|---|---|---|
| 2026-11-28 | piano registrato | — | attivo |
| 2026-11-28 | 0.1 baseline (`ai-baseline@1`) | vedi commit | verde: 12 test, 24.000 barre OHLC |
| 2026-11-28 | 1.1 `net_profitability` (`ai-desk-validation@2`) | vedi commit | verde: 54+20+27 test calibrazione, 11 nuovi test validatore |
| 2026-11-28 | rebase su `0e5f917` + CI dei nuovi test AI | `7e7f0b2` | CI verde: 34 passi in locale, 1 annotazione Node 20 |
| 2026-11-28 | Fase 2 rivalutata: 2.1–2.3 già fatte in `0e5f917` | — | restano 2.5 e 2.6 |
| 2026-11-28 | 1.2 UI onesta (tre frasi + test) | `965c511` | CI verde |
| 2026-11-28 | 2.5 `memoryRuleIds` + prompt senza "score" | `682b1ce` | CI verde |
| 2026-11-28 | 2.6 veto strutturato (`NO_NEWS`/`COUNTER_REGIME`) | `74cd645` | CI verde |
| 2026-11-28 | 3.3 campione canonico + runId reale | `a8494c7` | CI verde |
| 2026-11-28 | UI: messaggio per diario canonico vuoto | vedi commit | formatter puro + test, agganciato al modal |
| 2026-11-28 | Fase 4: un re-test, un conteggio | `e73c162` | CI verde |
| 2026-11-28 | 5.1 potenza + 5.2 modulo intervallo | `414a57a` | tsc, lint, power (19), calibrazione; **CI rossa** sul passo Client process guard |
| 2026-11-28 | correzione: potenza fuori dal perimetro server | `6985af5` | CI verde: 33 passi in locale |
| 2026-11-28 | 5.2 agganciata (`avg_r_ci` diagnostico) + 5.3 Monte Carlo | `ffa04c2` | CI verde, 34 passi; MC: FP 3,0%, potenza 100% |
| 2026-11-28 | 6.1 costo per riga (`aiTradeCost`) + `costSource` | `787cb04` | CI verde, 34 passi; equivalenza col costo costante, stop 10% → 0,3063 R |
| 2026-11-28 | 6.1 misura sui dati reali + 6.2 policy nel pannello | vedi commit | 57 esiti: medio 0,2889 R (0,345 se il pavimento non è misura), 20/57 al pavimento |
| 2026-11-28 | Fase 4 correzioni: rinnovo agganciato + mapping reale | `dc74673` | test su scansione vera, contatore preservato |
| 2026-11-28 | Fase 4 (scadenza, revoca, prompt senza %) | `9ba80bc` | tsc, lint, ai-desk (23 nuove asserzioni), memoria scope/attribuzione |
| 2026-11-28 | 3.1-3.2 memoria per-utente + autore + dataset | `258aaa4` | tsc, lint, ai_memory_scope (17), attribuzione, ai-desk, learningValidator, specialization, ai_shadow_log |
