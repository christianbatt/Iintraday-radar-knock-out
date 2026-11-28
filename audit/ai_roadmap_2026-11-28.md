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
- [ ] **2.6 Veto strutturato.** `vetoReason` (`EARNINGS` / `FUNDAMENTAL` / `NONE`) e `vetoSource` (`llm` / `text-legacy`) al posto della sola euristica testuale in `calculator.ts`: oggi una squalifica può dipendere da `includes('nessuna notizia')`.
- [ ] **2.1 Contratto di log.** `source: 'catalyst'`, `catalystDecision`, `newsBonus` 0–15, `newsBonusBand` (`0` / `1-7` / `8-15`, costante dichiarata), `hasNews`, `vetoReason`, `vetoSource` (`llm` | `text-legacy`), `memoryRuleIds`.
- [ ] **2.2 Wiring in `POST /api/analyze-catalyst`** (`server.ts:4028`): log di ogni esito, inclusi ramo fallback deterministico e `NESSUN_TRADE`; `promptVersion: 'ai-catalyst@1'`; nessun cambio di selezione (test di non-regressione).
- [ ] **2.3 Calibrazione del catalizzatore.** Aggregato `catalyst` nel join esistente, **fuori** dai bucket AZIONE/ATTESA/SCARTO: test gemelli che dimostrano verdetto principale invariato.
- [ ] **2.4 Pannello "Catalizzatore"** in `ShadowAISection`: bande di bonus, `edgeR` alto-vs-zero con IC, falsi veti, quota `text-legacy`.

## Fase 3 — Sicurezza e attribuzione della memoria

- [ ] **3.1 Provenienza estesa:** `writerUid`, `runId`, `datasetHash` (SHA-256 degli `id` ordinati), `minRealizedAt`.
- [ ] **3.2 Memoria per-utente** `ai_memory/{uid}` con fallback `legacy: true` dichiarato; mai mescolanze silenziose.
- [ ] **3.3 Campione canonico**: niente scritture da `req.body`, dedupe per `id`, rifiuto timestamp futuri, `datasetSource` nella risposta, test di poisoning.

## Fase 4 — Ciclo di vita delle regole

- [ ] **4.1 `validUntil` (90 giorni), `lastTestedAt`, `testCount`, `revokedAt` + `isRuleActive(entry, nowMs)` usata dall'iniezione nel prompt.
- [ ] **4.2 Prompt senza percentuali:** estrarre in `src/server/aiMemoryPrompt.ts` (puro), mostrare `q`, `n`, `validUntil`, `model`; test che il blocco non contiene `%`.
- [ ] **4.3 Revoca su re-test fallito**, registro append-only delle revoche.

## Fase 5 — Potenza statistica e falsificazione

- [ ] **5.1 `requiredSampleSize({varianceR, effectR, alpha, power})`** + "servono N trade, ne hai M" nel pannello.
- [ ] **5.2 IC bootstrap deterministico su `avgR(AZIONE)`** + check opzionale `avg_r_ci` (fuori dal verdetto finché non autorizzato).
- [ ] **5.3 Harness Monte Carlo** (`scripts/validator_mc.ts`, seed fisse): falsi positivi a edge nullo e potenza a edge noto, con asserzioni che falliscono se le soglie sono troppo permissive.

## Fase 6 — Costo reale per trade

- [ ] **6.1 `costR` per riga** (fee + spread stimato se le barre hanno OHLC, altrimenti tetto dichiarato; scala con la leva), `costSource` per riga; test di equivalenza col costo costante.
- [ ] **6.2 Convenienza per policy** nel pannello (`meanRNet`, `sumRNet`, quota sotto costo) con `n` visibile.

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
| 2026-11-28 | 2.5 `memoryRuleIds` + prompt senza "score" | vedi commit | tsc, lint, 5 suite AI verdi |
