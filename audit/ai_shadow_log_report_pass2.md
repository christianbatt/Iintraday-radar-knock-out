# AI Shadow Log — Passo 2 (hook scansione, rotazione, copertura)

Generato: 2026-11-23T23:45:53+00:00

## File creati/modificati (git diff --stat main...feat/ai-shadow-log)
```
 .gitignore                                         |   4 +
 server.ts                                          |  96 ++++++
 src/components/ShadowAISection.tsx                 | 152 ++++++++++
 src/components/ShadowResearchModal.tsx             |   2 +
 src/components/__tests__/shadowAISection.test.tsx  |  96 ++++++
 src/config/shadowAiSection.ts                      |   9 +
 src/server/aiShadowLog.ts                          | 317 +++++++++++++++++++
 src/utils/__tests__/ai_shadow_log.test.ts          | 334 +++++++++++++++++++++
 src/utils/__tests__/ai_shadow_log_coverage.test.ts | 112 +++++++
 9 files changed, 1122 insertions(+)
```

## Commit
```
b0db5b5 test(ai-shadow): fase 6 — rotazione a soglia e copertura dei 40 candidati
7bada97 fix(ai-shadow): fase 4 — source scan e categoria assente nella sezione AI
abf9016 feat(ai-shadow): fase 1-2 — hook scansione su tutti i candidati e rotazione a 5 MB
f2be23c test(ai-shadow): fase 4 — evaluated, safeAppend, clamp e flag on
3e886fd fix(ai-shadow): fase 3 — flag on e conteggio non valutate
777ed65 fix(ai-shadow): fase 1 — evaluated, safeAppend e hook prima dei filtri
f699619 fix(ai-shadow): fase 4 — test nuovi allineati a API e nuovi casi
2e1c18d fix(ai-shadow): fase 3 — flag default off, conteggi scartate/esiti noti
298a73d fix(ai-shadow): fase 1 — percorso radice, schema discarded, firma singola, hook e endpoint
236e868 test(ai-shadow): log NON_VALIDATO e flag spento (Fase 4)
a134748 feat(ai-shadow): sezione AI nella dashboard Shadow Research (Fase 3)
871e45b feat(ai-shadow): log shadow AI (Fase 1) — append-only NON_VALIDATO, hook specialize/desk, GET /api/shadow/ai-log
```

## Mappa pipeline (grep con numero di riga)
```
47:  safeAppendAiShadowLog,
49:  buildScanCandidateEntries,
2299:async function executeMarketDataScan(underlyings: any[], bypass: boolean): Promise<any[]> {
2340:  // selezione non cambia: safeAppendAiShadowLog non lancia mai.
2341:  safeAppendAiShadowLog(
2342:    buildScanCandidateEntries(
2362:    const scanScores = results.map((quote) => ({
2487:  await observeShadowV1LiveScan(results, futuresScan);
2818:    safeAppendAiShadowLog(
2822:    const shapeValidDirectives = rawDirectives.filter(
3040:    safeAppendAiShadowLog(
3044:    const shapeValidDirectives = rawDirectives.filter(
---
1477:export function rankMarketCandidates(
2022:export function buildExecutionSetup(
2383:  const gateKeys = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13'];
2384:  const firstFailedKey = gateKeys.find((k) => !gateResults[k].passed);
---
2218:  const gateResults: Record<string, { passed: boolean; label: string; message?: string }> = {};
2375:  // G13: quote non stantia
```

## 0.3 memoria AI: git grep nel modulo di log
```
GREP_EXIT=1
```

## 0.7 deploy
```
11:import cron from 'node-cron';
3713:app.post('/api/ai/learning/run', requireServerApiKey, async (_req: Request, res: Response) => {
3722:if (process.env.K_SERVICE) {
3723:  console.warn('[Cron] Cloud Run: configura Cloud Scheduler su POST /api/ai/learning/run (cron in-process disabilitato per evitare duplicati e cold start).');
```

## 0.6 script package.json
```
{
  "dev": "tsx server.ts",
  "start": "tsx server.ts",
  "gcp-build": "npm run build",
  "build": "vite build",
  "preview": "vite preview",
  "clean": "rm -rf dist server.js",
  "lint": "tsc --noEmit",
  "test:sprint1": "tsx scripts/test_sprint1.ts",
  "test:phase1": "tsx src/utils/__tests__/phase1.test.ts",
  "test:audit": "tsx src/utils/__tests__/audit_residui.test.ts",
  "test:audit2": "npx tsx src/utils/__tests__/audit_round2.test.ts",
  "test:learning": "tsx src/utils/__tests__/learningValidator.test.ts",
  "test:sprint3": "tsx scripts/test_sprint3.ts",
  "test:firebase-sync": "tsx src/services/__tests__/firebaseSync.test.ts",
  "test:shadow": "tsx src/utils/__tests__/shadow_route.test.ts && tsx src/utils/__tests__/knowledge_rules.test.ts && tsx src/utils/__tests__/shadow_panel_honesty.test.tsx",
  "test:shadow-panel": "tsx src/components/__tests__/shadowPanel.test.tsx && tsx src/components/__tests__/shadowModal.test.tsx",
  "test:features-v2": "tsx src/utils/__tests__/features_v2.test.ts",
  "test:shadowv2": "tsx src/utils/__tests__/shadow_v2.test.ts",
  "test:shadowv1live": "tsx src/utils/__tests__/shadow_v1_live.test.ts",
  "test:sessionclose": "tsx src/utils/__tests__/session_close.test.ts",
  "test:shadowv1livestore": "tsx src/utils/__tests__/shadow_v1_live_store.test.ts",
  "test:shadowv1livecollector": "tsx src/utils/__tests__/shadow_v1_live_collector.test.ts",
  "test:shadowv1livebridge": "tsx src/utils/__tests__/shadow_v1_live_bridge.test.ts",
  "test:shadowv1liveview": "tsx src/utils/__tests__/shadow_v1_live_view.test.ts",
  "test:shadowv1livepanel": "tsx src/components/__tests__/shadowV1LivePanel.test.tsx",
  "test:orb": "tsx src/utils/__tests__/orb_regression.test.ts",
  "learning:nightly": "tsx scripts/nightly_learning.ts"
}
```

## 6.2 npx tsc --noEmit
```
EXIT_CODE=0
```

## 6.1/6.3 Test (output integrale, exit code per file)

### src/utils/__tests__/ai_shadow_log.test.ts
```
▶ aiShadowLog — scrittura
  ✔ scrive entry con status NON_VALIDATO e outcome null (3.473568ms)
  ✔ append multipli accumulano righe (0.755928ms)
  ✔ errore di I/O non lancia (path non scrivibile) (0.611989ms)
  ✔ nessuna scrittura in memoria: il modulo non importa memoryUpdater (0.264867ms)
  ✔ registra anche proposte scartate (discarded true, discardReason valorizzato) (0.791345ms)
  ✔ registra proposte non valutate (evaluated false, discardReason valorizzato) (0.795002ms)
  ✔ discarded non specificato dal chiamante => derivato dalla shape (0.672312ms)
  ✔ readAiShadowLog(limit) restituisce le ultime N (0.620435ms)
  ✔ rotazione a soglia: oltre 5 MB il file diventa .1 e il nuovo file riparte (11.861068ms)
  ✔ rotazione: mantiene al massimo tre archivi, elimina il piu' vecchio (18.171319ms)
  ✔ nessuna scrittura su file memoria: append non tocca ai_specialization_memory.json (0.715904ms)
✔ aiShadowLog — scrittura (40.817635ms)
▶ aiShadowLog — safeAppend
  ✔ mock che lancia: non propaga, ritorna ok:false, usa console.warn (2.783023ms)
  ✔ scrittura normale: ok:true e nessun warning (0.50671ms)
✔ aiShadowLog — safeAppend (3.475272ms)
▶ aiShadowLog — endpoint /api/shadow/ai-log
  ✔ clamp del limite: default 50, massimo 200, minimo 1, non numerico => default (0.276268ms)
  ✔ risposta con conteggi per status, discarded ed evaluated (0.750509ms)
  ✔ file assente: risposta vuota senza errori (0.994146ms)
  ✔ percorso di default: radice del repo, non artifacts/ (0.137377ms)
✔ aiShadowLog — endpoint /api/shadow/ai-log (2.363935ms)
ℹ tests 17
ℹ suites 3
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 56.704184
EXIT_CODE=0
```

### src/utils/__tests__/ai_shadow_log_coverage.test.ts
```
▶ aiShadowLog — copertura di tutti i candidati (40 titoli)
  ✔ tutti e 40 i candidati arrivano al log prima del filtro, uno per titolo (4.174954ms)
  ✔ errore di scrittura del log non altera la lista dei top setup (1.551762ms)
  ✔ wiring reale: server.ts invoca buildScanCandidateEntries prima del filtro shape (0.82658ms)
✔ aiShadowLog — copertura di tutti i candidati (40 titoli) (8.081104ms)
ℹ tests 3
ℹ suites 1
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 17.400934
EXIT_CODE=0
```

### src/components/__tests__/shadowModal.test.tsx
```
▶ M1 — il pannello e’ raggiungibile dalla UI
  ✔ espone un trigger nella navigazione (7.646538ms)
✔ M1 — il pannello e’ raggiungibile dalla UI (8.961406ms)
▶ M2 — available:true mostra le sezioni (V2 inclusa)
  ✔ rende sample, fill, death, emissions, rules, spread, proposals (41.455212ms)
✔ M2 — available:true mostra le sezioni (V2 inclusa) (41.732531ms)
▶ M5 — V1-live e V2 nella stessa modale (P7)
  ✔ con la costante di config accesa la modale rende V2 e V1-live insieme (7.74797ms)
  ✔ vista V1-live indisponibile (404): stato esplicito nel pannello, V2 intatta (2.075725ms)
✔ M5 — V1-live e V2 nella stessa modale (P7) (10.147652ms)
▶ M3 — available:false mostra “nessun artefatto”
  ✔ non crasha e mantiene il pannello (5.282142ms)
✔ M3 — available:false mostra “nessun artefatto” (5.598747ms)
▶ M4 — errore di rete: messaggio, nessun crash
  ✔ mostra l’errore invece del pannello (2.06766ms)
  ✔ evita doppio fetch di /api/shadow/latest e date hardcoded in ShadowResearchPanel (0.912963ms)
✔ M4 — errore di rete: messaggio, nessun crash (3.425898ms)
ℹ tests 7
ℹ suites 5
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 92.105206
EXIT_CODE=0
```

### src/utils/__tests__/shadow_panel_honesty.test.tsx
```
▶ C1 — disclaimer: ricerca esplorativa, non segnale operativo
  ✔ è presente con dati completi, con shadowV2 assente, con zero segnali e con artefatto nullo (18.386082ms)
✔ C1 — disclaimer: ricerca esplorativa, non segnale operativo (19.479973ms)
▶ C2 — ogni p-value mostrato è accompagnato da n
  ✔ il cluster bootstrap p porta accanto il numero di trade risolti (5.597655ms)
  ✔ anche il p-value del confronto V1/V2 è accompagnato da n (2.901394ms)
✔ C2 — ogni p-value mostrato è accompagnato da n (8.799983ms)
▶ C3 — i limiti forniti dai dati sono tutti visibili
  ✔ rende ogni stringa di shadowV2.limitations, senza accorciarla (3.689364ms)
  ✔ non inventa una sezione limiti quando i dati non ne forniscono (2.139244ms)
✔ C3 — i limiti forniti dai dati sono tutti visibili (6.069139ms)
▶ C4 — dati vuoti o assenti: nessun valore di default presentato come risultato
  ✔ zero segnali: messaggio esplicito e nessun numero di default (1.61986ms)
  ✔ shadowV2 assente: solo il messaggio, nessuna metrica (1.596396ms)
  ✔ integrità del fill non disponibile: nessun "0 violazioni" dichiarato (2.736274ms)
✔ C4 — dati vuoti o assenti: nessun valore di default presentato come risultato (6.365375ms)
▶ C5 — nessuna dicitura di evidenza, edge o raccomandazione
  ✔ non contiene le diciture vietate (2.623462ms)
  ✔ la parola "segnale" compare solo nella negazione del disclaimer (2.428979ms)
✔ C5 — nessuna dicitura di evidenza, edge o raccomandazione (5.263427ms)
▶ C6 — soglia di campione ridotto già esistente (nDays/nClusters < 30)
  ✔ sotto soglia mostra il banner di campione insufficiente (3.342402ms)
  ✔ sopra soglia non mostra il banner (1.920884ms)
✔ C6 — soglia di campione ridotto già esistente (nDays/nClusters < 30) (5.407476ms)
▶ C7 — riepilogo in parole semplici con equivalenti in Euro
  ✔ mostra gli equivalenti in Euro su shadowV2 valorizzato e li nasconde a zero segnali (2.934286ms)
✔ C7 — riepilogo in parole semplici con equivalenti in Euro (3.028523ms)
▶ C8 — pairing 90m Base vs 120m Trail su TRAIL_BE_120M
  ✔ mostra il confronto finestra uguale vs estesa senza violare la regola sul termine segnale (2.549364ms)
✔ C8 — pairing 90m Base vs 120m Trail su TRAIL_BE_120M (2.642808ms)
ℹ tests 14
ℹ suites 8
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 77.133611
EXIT_CODE=0
```

### src/utils/__tests__/shadow_route.test.ts
```
▶ T1 — artefatto valido: campi propagati
  ✔ restituisce i campi dell’artefatto con available true e status 200 (1.261107ms)
✔ T1 — artefatto valido: campi propagati (2.386849ms)
▶ T2 — artefatto assente: available false, HTTP 200, nessuna eccezione
  ✔ non lancia e risponde 200 con reason (0.200117ms)
✔ T2 — artefatto assente: available false, HTTP 200, nessuna eccezione (0.380695ms)
▶ T3 — JSON malformato: available false, nessuna eccezione
  ✔ non lancia e dichiara l’artefatto illeggibile (0.263845ms)
✔ T3 — JSON malformato: available false, nessuna eccezione (0.462126ms)
▶ T4 — il modulo non raggiunge applyOptimizationProposal né promote
  ✔ il sorgente del handler non li importa e non li chiama (0.350388ms)
✔ T4 — il modulo non raggiunge applyOptimizationProposal né promote (0.510809ms)
▶ T5 — nessuna route POST per /api/shadow
  ✔ la tabella delle route contiene solo GET e la registrazione non espone POST (0.88472ms)
✔ T5 — nessuna route POST per /api/shadow (1.1134ms)
▶ P17 — cold start: summary.json mancante
  ✔ readJsonSafe non legge un file assente e propaga null a shadowV2 (0.241963ms)
✔ P17 — cold start: summary.json mancante (0.408678ms)
▶ P17 — cold start: GET /api/shadow/latest su directory vuota
  ✔ risponde HTTP 200 con available:false e shadowV2:null da server http reale (36.452783ms)
✔ P17 — cold start: GET /api/shadow/latest su directory vuota (36.690499ms)
ℹ tests 7
ℹ suites 7
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 47.92412
EXIT_CODE=0
```

### src/components/__tests__/shadowV1LivePanel.test.tsx
```
✔ P11 costanti pannello: gate mostrati invariati (1.324877ms)
▶ ShadowV1LivePanel — flag
  ✔ default ON (P7) e nessun markup a flag OFF esplicito (5.145827ms)
  ✔ flag ON rende il pannello marcato sola lettura (6.178253ms)
✔ ShadowV1LivePanel — flag (11.715885ms)
▶ ShadowV1LivePanel — stati
  ✔ loading (1.155548ms)
  ✔ errore HTTP o di rete (1.765263ms)
  ✔ vista non disponibile con motivo dichiarato (1.301463ms)
  ✔ nessun dato senza errore (1.383125ms)
  ✔ dati parziali: troncamento e righe ignorate dichiarati (2.525249ms)
✔ ShadowV1LivePanel — stati (8.845589ms)
▶ ShadowV1LivePanel — record e stati
  ✔ una riga per record, etichette di stato e R solo dove esiste (3.395913ms)
  ✔ stale mostrato solo dove il server lo dichiara (2.398ms)
  ✔ nessun record persistito (1.409936ms)
  ✔ le metriche mostrate sono quelle del server, non ricalcolate (1.593229ms)
✔ ShadowV1LivePanel — record e stati (9.204712ms)
▶ ShadowV1LivePanel — confronto V1/V2
  ✔ dichiara il confronto quantitativo non disponibile e mostra i campioni separati (2.705698ms)
  ✔ non espone alcun delta o rapporto derivato tra le due popolazioni (1.652532ms)
  ✔ senza dati V2 resta il divieto di confronto e i valori diventano n/d (1.676917ms)
✔ ShadowV1LivePanel — confronto V1/V2 (6.265087ms)
▶ ShadowV1LivePanel — aggiornamento e campi
  ✔ in modalita live offre il comando di aggiornamento; con dati iniettati no (1.52455ms)
  ✔ a flag OFF non parte alcuna richiesta: guardia prima di ogni fetch (0.384342ms)
  ✔ non mostra livelli o campi non previsti dalla vista (1.187037ms)
✔ ShadowV1LivePanel — aggiornamento e campi (3.312856ms)
▶ ShadowV1LivePanel — ritardo di osservazione
  ✔ mostra la colonna ritardo, il marcatore late e i due conteggi (2.447402ms)
  ✔ senza record late il conteggio esclusi e zero (1.28442ms)
  ✔ il pannello non ricalcola le metriche ne i ritardi (0.786696ms)
  ✔ mostra la diagnostica server quando fornita senza violare i divieti di confronto (1.000808ms)
  ✔ mostra prezzo corrente e variazione non realizzata per record aperti senza violare i divieti (1.125352ms)
✔ ShadowV1LivePanel — ritardo di osservazione (6.932118ms)
✔ P18 metodo: ogni record dichiara il metodo che lo ha prodotto (1.232262ms)
✔ P18b metriche: il metodo precedente ha una sezione separata (2.048584ms)
ℹ tests 25
ℹ suites 6
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 72.373368
EXIT_CODE=0
```

### src/components/__tests__/shadowAISection.test.tsx
```
▶ ShadowAISection — flag
  ✔ flag off: non renderizza nulla (4.858407ms)
  ✔ flag on: renderizza sezione (4.039399ms)
✔ ShadowAISection — flag (10.131301ms)
▶ ShadowAISection — flag di config
  ✔ default 'on' come deciso dall'utente (0.15988ms)
✔ ShadowAISection — flag di config (0.339939ms)
▶ ShadowAISection — nuovi casi
  ✔ flag off: non renderizza e non fa fetch (0.493075ms)
  ✔ stato caricamento (0.584658ms)
  ✔ stato errore (0.477456ms)
  ✔ stato vuoto (0.644018ms)
  ✔ stato dati: mostra NON VALIDATO e conteggi (1.058346ms)
  ✔ conteggio proposte non valutate dall'LLM (0.641192ms)
✔ ShadowAISection — nuovi casi (4.484625ms)
ℹ tests 9
ℹ suites 3
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 26.957446
EXIT_CODE=0
```

### src/utils/__tests__/learningValidator.test.ts
```
=== Learning Validator Tests ===
Test 1 - binomiale 20/30 non significativa: PASS
Test 2 - binomiale 15/30 p-value 1: PASS
Test 2b - correzione Benjamini-Hochberg monotona: PASS
Test 3 - esclusi non gonfiano il campione reale: PASS
Test 3b - paper trade inclusi correttamente nell'analisi: PASS
Test 4 - pattern significativo basato solo su Journal: PASS
Test 5 - upsert memoria e rifiuto pattern non significativo FDR: PASS
Test 6 - scan: tutti i predicati sotto MIN => non testati, p=1, nessun vincente: PASS
Test 7 - scan: MARKET_EU forte testato e vincente, famiglia 14, non testati mai vincenti: PASS
Test 8 - scan: qValue calcolato da benjaminiHochberg sulla famiglia di 14: PASS
=== Tutti i test Learning Validator completati ===
EXIT_CODE=0
```

### src/utils/__tests__/phase1.test.ts
```
================================================================
ESECUZIONE SUITE TEST FASE D (T01–T50)
================================================================
FIXTURE BASE JSON:
{
  "ticker": "TEST.MI",
  "name": "Test Long EU S.p.A.",
  "market": "EU",
  "currency": "EUR",
  "prevClose": 99,
  "currentPrice": 100.1,
  "preMarketPrice": 100,
  "prevHigh": 99.5,
  "prevLow": 98,
  "preMarketHigh": 100,
  "preMarketLow": 99.5,
  "todayOpen": 100,
  "todayHigh": 100.1,
  "todayLow": 99.9,
  "vwap": 100,
  "ema20Daily": 98,
  "avgVolume20d": 250000,
  "preMarketVolume": 50000,
  "atr14": 1.3,
  "adr14": 10,
  "liqEur20d": 5000000,
  "completedBarsCount": 20,
  "orbHigh": 100,
  "orbLow": 99.799599,
  "T": 100,
  "E": 100,
  "S": 99.6,
  "orbBreakoutTime": "2026-10-26T08:30:00.000Z",
  "gapPercent": 1.01,
  "rvol": 1.5,
  "rvol20m": 1.2,
  "rsi14": 55,
  "rsi5m": 55,
  "orderFlow": null,
  "setupIndicators": {
    "barsUsed": 120,
    "atr": {
      "value": 1.3,
      "status": "OK",
      "reason": null
    },
    "supertrend": {
      "status": "OK",
      "reason": null,
      "direction": 1,
      "barsSinceFlip": 2,
      "value": 99.5
    },
    "adx": {
      "status": "OK",
      "reason": null,
      "value": 28,
      "plusDI": 30,
      "minusDI": 12
    },
    "stochRsi": {
      "status": "OK",
      "reason": null,
      "k": 45,
      "d": 40,
      "lastCross": "LONG",
      "barsSinceCross": 1
    },
    "psar": {
      "status": "OK",
      "reason": null,
      "value": 99.2,
      "direction": 1,
      "barsSinceFlip": 4
    }
  },
  "vwapState": {
    "state": "ABOVE",
    "distAtr": 0.5,
    "slopeAtr": 0.1,
    "coverage": 1,
    "volumeRatio": 2.1,
    "flags": [],
    "vwapLevel": 100
  },
  "timestamp": "2026-10-26T08:40:00.000Z",
  "source": "Fixture Fase D"
}
----------------------------------------------------------------
[T01] PASS | P_t = 100.30, H_sess = 100.30 -> G4 passa, setup generato
  INPUT:    {"P_t":100.3,"H_sess":100.3,"T":100}
  EXPECTED: {"g4Pass":true,"decision":"TRADE","extensionPct":0.3}
  ACTUAL:   {"g4Pass":true,"decision":"TRADE","extensionPct":0.3}
[T02] PASS | P_t = 100.50, H_sess = 100.50 -> G4 TRIGGER GIÀ SUPERATO
  INPUT:    {"P_t":100.5,"H_sess":100.5,"T":100}
  EXPECTED: {"g4Pass":false,"message":"TRIGGER GIÀ SUPERATO","decision":"NESSUN_TRADE"}
  ACTUAL:   {"g4Pass":false,"message":"TRIGGER GIÀ SUPERATO","decision":"NESSUN_TRADE"}
[T03] PASS | now = 11:30 Rome (120 min da Tb 09:30) -> G5 TRIGGER SCADUTO
  INPUT:    {"now":"11:30 Rome","Tb":"09:30 Rome","elapsedMin":120}
  EXPECTED: {"g5Pass":false,"message":"TRIGGER SCADUTO","blockedGate":"G5"}
  ACTUAL:   {"g5Pass":false,"message":"TRIGGER SCADUTO","blockedGate":"G5"}
[T04] PASS | now = 10:30 Rome (esattamente 60 min da Tb 09:30) -> G5 passa
  INPUT:    {"now":"10:30 Rome","Tb":"09:30 Rome","elapsedMin":60}
  EXPECTED: {"g5Pass":true,"decision":"TRADE"}
  ACTUAL:   {"g5Pass":true,"decision":"TRADE"}
[T05] PASS | now = 10:31 Rome (61 min da Tb 09:30) -> G5 TRIGGER SCADUTO
  INPUT:    {"now":"10:31 Rome","Tb":"09:30 Rome","elapsedMin":61}
  EXPECTED: {"g5Pass":false,"message":"TRIGGER SCADUTO","blockedGate":"G5"}
  ACTUAL:   {"g5Pass":false,"message":"TRIGGER SCADUTO","blockedGate":"G5"}
[T06] PASS | H_sess = 100.64 (uguale a T1) -> G6 T1 RAGGIUNTO
  INPUT:    {"H_sess":100.64,"T1":100.64}
  EXPECTED: {"g6Pass":false,"message":"T1 RAGGIUNTO","blockedGate":"G6"}
  ACTUAL:   {"g6Pass":false,"message":"T1 RAGGIUNTO","blockedGate":"G6"}
[T07] PASS | H_sess = 100.63 (< T1 100.64) -> G6 passa
  INPUT:    {"H_sess":100.63,"T1":100.64}
  EXPECTED: {"g6Pass":true,"decision":"TRADE"}
  ACTUAL:   {"g6Pass":true,"decision":"TRADE"}
[T08] PASS | H_sess = 100.10, L_sess = 94.20 (range 5.90 = 59%) -> G7 passa
  INPUT:    {"H_sess":100.1,"L_sess":94.2,"adr14":10}
  EXPECTED: {"g7Pass":true,"adrConsumptionPct":59,"decision":"TRADE"}
  ACTUAL:   {"g7Pass":true,"adrConsumptionPct":59,"decision":"TRADE"}
[T09] PASS | H_sess = 100.10, L_sess = 94.00 (range 6.10 = 61%) -> G7 RANGE ESAURITO
  INPUT:    {"H_sess":100.1,"L_sess":94,"adr14":10}
  EXPECTED: {"g7Pass":false,"message":"RANGE ESAURITO","adrConsumptionPct":61,"blockedGate":"G7"}
  ACTUAL:   {"g7Pass":false,"message":"RANGE ESAURITO","adrConsumptionPct":61,"blockedGate":"G7"}
[T10] PASS | ATR14 = null -> G2 DATI INSUFFICIENTI (e gapScore = 0)
  INPUT:    {"atr14":null}
  EXPECTED: {"g2Pass":false,"message":"DATI INSUFFICIENTI","blockedGate":"G2","gapScore":0}
  ACTUAL:   {"g2Pass":false,"message":"DATI INSUFFICIENTI","blockedGate":"G2","gapScore":0}
[T11] PASS | ADR14 = null -> G2 DATI INSUFFICIENTI (e adrInfo = null)
  INPUT:    {"adr14":null}
  EXPECTED: {"g2Pass":false,"message":"DATI INSUFFICIENTI","blockedGate":"G2","adrInfo":null}
  ACTUAL:   {"g2Pass":false,"message":"DATI INSUFFICIENTI","blockedGate":"G2","adrInfo":null}
[T12] PASS | C_ieri = null -> G2 DATI INSUFFICIENTI
  INPUT:    {"prevClose":null}
  EXPECTED: {"g2Pass":false,"message":"DATI INSUFFICIENTI","blockedGate":"G2"}
  ACTUAL:   {"g2Pass":false,"message":"DATI INSUFFICIENTI","blockedGate":"G2"}
[T13] PASS | barre complete per volume = 19 -> G2 DATI INSUFFICIENTI, non G1
  INPUT:    {"completedBarsCount":19,"computedLiqEur":null}
  EXPECTED: {"g1Pass":true,"g2Pass":false,"blockedGate":"G2","message":"DATI INSUFFICIENTI"}
  ACTUAL:   {"g1Pass":true,"g2Pass":false,"blockedGate":"G2","message":"DATI INSUFFICIENTI"}
[T14] PASS | ORB assente (orbHigh = null, orbLow = null) -> G2 DATI INSUFFICIENTI
  INPUT:    {"orbHigh":null,"orbLow":null}
  EXPECTED: {"g2Pass":false,"message":"DATI INSUFFICIENTI","blockedGate":"G2"}
  ACTUAL:   {"g2Pass":false,"message":"DATI INSUFFICIENTI","blockedGate":"G2"}
[T15] PASS | Liq€ = 2,900,000 -> G1 LIQUIDITÀ INSUFFICIENTE
  INPUT:    {"liqEur20d":2900000}
  EXPECTED: {"g1Pass":false,"message":"LIQUIDITÀ INSUFFICIENTE","blockedGate":"G1"}
  ACTUAL:   {"g1Pass":false,"message":"LIQUIDITÀ INSUFFICIENTE","blockedGate":"G1"}
[T16] PASS | Liq€ = 3,100,000 -> G1 passa
  INPUT:    {"liqEur20d":3100000}
  EXPECTED: {"g1Pass":true,"decision":"TRADE"}
  ACTUAL:   {"g1Pass":true,"decision":"TRADE"}
[T17] PASS | S = 98.80 (dS 1.20%) -> G8 STOP TROPPO LONTANO
  INPUT:    {"S":98.8,"E":100}
  EXPECTED: {"dS_pct":1.2,"g8Pass":false,"message":"STOP TROPPO LONTANO","blockedGate":"G8"}
  ACTUAL:   {"dS_pct":1.2,"g8Pass":false,"message":"STOP TROPPO LONTANO","blockedGate":"G8"}
[T18] PASS | S = 99.00 (dS 1.00%) -> passa; L_sel 10; perdita 10.00%; barriera 90.00
  INPUT:    {"S":99,"E":100}
  EXPECTED: {"decision":"TRADE","L_sel":10,"perditaPct":10,"barrierRecommended":90}
  ACTUAL:   {"decision":"TRADE","L_sel":10,"perditaPct":10,"barrierRecommended":90}
[T19] PASS | S = 98.90 (dS 1.10%) -> G8 STOP TROPPO LONTANO
  INPUT:    {"S":98.9,"E":100}
  EXPECTED: {"dS_pct":1.1,"g8Pass":false,"message":"STOP TROPPO LONTANO","blockedGate":"G8"}
  ACTUAL:   {"dS_pct":1.1,"g8Pass":false,"message":"STOP TROPPO LONTANO","blockedGate":"G8"}
[T20] PASS | S = 99.60 (dS 0.40%) -> L_sel 25; perdita 10.00%; barriera 96.00; leva prudente 10 con barriera 90.00
  INPUT:    {"S":99.6,"E":100}
  EXPECTED: {"L_sel":25,"perditaPct":10,"barrierRecommended":96,"prudentLeverage":10,"prudentBarrier":90}
  ACTUAL:   {"L_sel":25,"perditaPct":10,"barrierRecommended":96,"prudentLeverage":10,"prudentBarrier":90}
[T21] PASS | S = 99.50 (dS 0.50%) -> L_sel 20; perdita 10.00%; barriera 95.00
  INPUT:    {"S":99.5,"E":100}
  EXPECTED: {"L_sel":20,"perditaPct":10,"barrierRecommended":95}
  ACTUAL:   {"L_sel":20,"perditaPct":10,"barrierRecommended":95}
[T22] PASS | S = 99.40 (dS 0.60%) -> L_sel 15; perdita 9.00%; barriera 93.33
  INPUT:    {"S":99.4,"E":100}
  EXPECTED: {"L_sel":15,"perditaPct":9,"barrierRecommended":93.33}
  ACTUAL:   {"L_sel":15,"perditaPct":9,"barrierRecommended":93.33}
[T23] PASS | LEVE forzato a [25], S = 99.50 (test di ramo dichiarato) -> G9 LEVA NON COMPATIBILE
  INPUT:    {"S":99.5,"customLeve":[25]}
  EXPECTED: {"g9Pass":false,"message":"LEVA NON COMPATIBILE","blockedGate":"G9"}
  ACTUAL:   {"g9Pass":false,"message":"LEVA NON COMPATIBILE","blockedGate":"G9"}
[T24] PASS | validateBarrierSafety diretta (E=100, S=99.50) nei tre rami: B=99.45 (dist 0.05<0.10 -> non valida), B=99.35 (dist 0.15>=0.10 -> valida), B=99.55 (lato errato -> non valida)
  INPUT:    {"E":100,"S":99.5,"bufBar":0.001,"B_cases":[99.45,99.35,99.55]}
  EXPECTED: {"b9945":{"valid":false,"message":"BARRIERA NON VALIDA"},"b9935":{"valid":true},"b9955":{"valid":false,"message":"BARRIERA NON VALIDA"}}
  ACTUAL:   {"b9945":{"valid":false,"message":"BARRIERA NON VALIDA"},"b9935":{"valid":true},"b9955":{"valid":false,"message":"BARRIERA NON VALIDA"}}
[T25] PASS | P_t = 99.60 (uguale a S) -> G10 STOP GIÀ RAGGIUNTO
  INPUT:    {"P_t":99.6,"S":99.6}
  EXPECTED: {"g10Pass":false,"message":"STOP GIÀ RAGGIUNTO","blockedGate":"G10"}
  ACTUAL:   {"g10Pass":false,"message":"STOP GIÀ RAGGIUNTO","blockedGate":"G10"}
[T26] PASS | P_t = 99.61 (> S 99.60) -> G10 passa
  INPUT:    {"P_t":99.61,"S":99.6}
  EXPECTED: {"g10Pass":true,"decision":"TRADE"}
  ACTUAL:   {"g10Pass":true,"decision":"TRADE"}
[T27] PASS | score senza liquidità = 47 -> G11 PUNTEGGIO SOTTO SOGLIA
  INPUT:    {"calculatedScore":47,"minScoreEU":48}
  EXPECTED: {"score":47,"g11Pass":false,"message":"PUNTEGGIO SOTTO SOGLIA","blockedGate":"G11"}
  ACTUAL:   {"score":47,"g11Pass":false,"message":"PUNTEGGIO SOTTO SOGLIA","blockedGate":"G11"}
[T28] PASS | score senza liquidità = 48 -> G11 passa
  INPUT:    {"calculatedScore":48,"minScoreEU":48}
  EXPECTED: {"score":48,"g11Pass":true,"decision":"TRADE"}
  ACTUAL:   {"score":48,"g11Pass":true,"decision":"TRADE"}
[T29] PASS | componenti 12, 14, 0, 12, 6, 0, 10, 0, 8 + 12/7/9 + VWAP 10 -> raw 100, total 100
  INPUT:    {"components":[12,14,0,12,6,0,10,0,8,12,7,9,10]}
  EXPECTED: {"rawTotal":100,"liquidityScore":0,"total":100}
  ACTUAL:   {"rawTotal":100,"liquidityScore":0,"total":100}
[T30] PASS | futures con variazione mancante -> 0 punti futures
  INPUT:    {"benchmarkFuturesChangePercent":null}
  EXPECTED: {"futuresScore":0}
  ACTUAL:   {"futuresScore":0}
[T31] PASS | futures con variazione 0.10% (<= banda 0.15%) -> 7 punti futures (peso W_FUTURES 12)
  INPUT:    {"benchmarkFuturesChangePercent":0.1,"neutralBand":0.15}
  EXPECTED: {"futuresScore":7}
  ACTUAL:   {"futuresScore":7}
[T32] PASS | ATR% 1.00, gap +0.75% (ratio 0.75) -> 12 punti gap (peso W_GAP)
  INPUT:    {"atrPct":1,"gapPercent":0.75,"ratio":0.75}
  EXPECTED: {"gapScore":12}
  ACTUAL:   {"gapScore":12}
[T33] PASS | ATR% 1.00, gap +0.149% (ratio 0.149 < 0.15) -> 1 punto gap
  INPUT:    {"atrPct":1,"gapPercent":0.149,"ratio":0.149}
  EXPECTED: {"gapScore":1}
  ACTUAL:   {"gapScore":1}
[T34] PASS | now = 09:14:59 Rome -> G3 ATTENDERE CHIUSURA ORB
  INPUT:    {"now":"09:14:59"}
  EXPECTED: {"g3Pass":false,"message":"ATTENDERE CHIUSURA ORB","blockedGate":"G3"}
  ACTUAL:   {"g3Pass":false,"message":"ATTENDERE CHIUSURA ORB","blockedGate":"G3"}
[T35] PASS | now = 09:15:00 Rome -> G3 passa
  INPUT:    {"now":"09:15:00"}
  EXPECTED: {"g3Pass":true,"decision":"TRADE"}
  ACTUAL:   {"g3Pass":true,"decision":"TRADE"}
[T36] PASS | ORB 09:00/09:05/09:10 (esclusa 09:15) -> T=100.00, min ORB=99.5, S=99.301, dS=0.699%, L_sel=10, perdita=6.99%
  INPUT:    {"barsCount":4,"bar0915High":102,"bar0915Low":98}
  EXPECTED: {"T":100,"minOrb":99.5,"S":99.301,"dS_pct":0.699,"L_sel":10,"perditaPct":6.99}
  ACTUAL:   {"T":100,"minOrb":99.5,"S":99.301,"dS_pct":0.699,"L_sel":10,"perditaPct":6.99}
[T37] PASS | 15 barre complete con TR = 3.00 + barra odierna range 20 -> ATR14 = 3.00
  INPUT:    {"totalBars":16,"completedBars":15,"todayBarRange":20}
  EXPECTED: {"atr14":3}
  ACTUAL:   {"atr14":3}
[T38] PASS | 14 barre complete con range 2.00 + barra odierna range 50 -> ADR14 = 2.00
  INPUT:    {"totalBars":15,"completedBars":14,"todayBarRange":50}
  EXPECTED: {"adr14":2}
  ACTUAL:   {"adr14":2}
[T39] PASS | 20 barre complete (vol 100k * close 50) + barra odierna vol 10M -> Liq€ = 5,000,000
  INPUT:    {"totalBars":21,"completedBars":20,"todayVolume":10000000}
  EXPECTED: {"liqEur":5000000}
  ACTUAL:   {"liqEur":5000000}
[T40] PASS | freeze USA del 16/03/2026 -> ORB chiude 14:45 CET (13:45 UTC)
  INPUT:    {"sessionDate":"2026-03-16","nyClose":"09:45 NY"}
  EXPECTED: {"romeFormatted":"14:45 CET","utcFormatted":"13:45 UTC"}
  ACTUAL:   {"romeFormatted":"14:45 CET","utcFormatted":"13:45 UTC"}
[T41] PASS | freeze USA del 26/10/2026 -> ORB chiude 14:45 CET (13:45 UTC)
  INPUT:    {"sessionDate":"2026-10-26","nyClose":"09:45 NY"}
  EXPECTED: {"romeFormatted":"14:45 CET","utcFormatted":"13:45 UTC"}
  ACTUAL:   {"romeFormatted":"14:45 CET","utcFormatted":"13:45 UTC"}
[T42] PASS | freeze USA del 06/07/2026 -> ORB chiude 15:45 CEST (13:45 UTC)
  INPUT:    {"sessionDate":"2026-07-06","nyClose":"09:45 NY"}
  EXPECTED: {"romeFormatted":"15:45 CEST","utcFormatted":"13:45 UTC"}
  ACTUAL:   {"romeFormatted":"15:45 CEST","utcFormatted":"13:45 UTC"}
[T43] PASS | freeze manuale alle 10:00 Rome (09:45-09:59 incluse, 10:00 esclusa) -> T = 105.50, S = 103.9916
  INPUT:    {"totalInputBars":16,"includedBars":15,"bar1000High":106}
  EXPECTED: {"T":105.5,"S":103.9916,"includedBarsCount":15}
  ACTUAL:   {"T":105.5,"S":103.9916,"includedBarsCount":15}
[T44] PASS | ORB T = 100.00, prima rottura 09:20, nuovo high 101.00 alle 09:30 -> T e Tb invariati
  INPUT:    {"highAt0920":100.25,"highAt0930":101}
  EXPECTED: {"T_before":100,"T_after":100,"Tb_before":"2026-10-26T08:20:00.000Z","Tb_after":"2026-10-26T08:20:00.000Z"}
  ACTUAL:   {"T_before":100,"T_after":100,"Tb_before":"2026-10-26T08:20:00.000Z","Tb_after":"2026-10-26T08:20:00.000Z"}
[T45] PASS | entryMode nei tre casi salvato con tag corretto; setup senza entryMode -> errore esplicito e nessun record
  INPUT:    {"testMissingMode":true,"modes":["SNAPSHOT_0915","UNFROZEN_LATE","MANUAL_FREEZE"]}
  EXPECTED: {"missingThrows":true,"recordCreatedForMissing":false,"savedModes":["SNAPSHOT_0915","UNFROZEN_LATE","MANUAL_FREEZE"],"T":100,"E":100,"S":99.6,"B_rec":96,"L_sel":25,"gatesCount":13}
  ACTUAL:   {"missingThrows":true,"recordCreatedForMissing":false,"savedModes":["SNAPSHOT_0915","UNFROZEN_LATE","MANUAL_FREEZE"],"T":100,"E":100,"S":99.6,"B_rec":96,"L_sel":25,"gatesCount":13}
[T46] PASS | TRADING_PARAMS.MIN_SCORE_EU impostato a 50 -> aggiorna buildExecutionSetup e DualExecutionHero
  INPUT:    {"candidateScore":49,"newMinScoreEU":50}
  EXPECTED: {"beforeDecision":"TRADE","afterDecision":"NESSUN_TRADE","afterBlockedGate":"G11","heroMinAfter":50}
  ACTUAL:   {"beforeDecision":"TRADE","afterDecision":"NESSUN_TRADE","afterBlockedGate":"G11","heroMinAfter":50}
[T47] PASS | Ottimizzazione parametri: target1Multiplier dinamico applicato a Target 1 e Risk/Reward
  INPUT:    {"defaultTarget1Mult":1.6,"acceptedTarget1Mult":1.35}
  EXPECTED: {"defaultT1":100.64,"defaultRR":1.6,"optimizedT1":100.54,"optimizedRR":1.35}
  ACTUAL:   {"defaultT1":100.64,"defaultRR":1.6,"optimizedT1":100.54,"optimizedRR":1.35}
[T48] PASS | Ottimizzazione parametri: minScoreEurope dinamico blocca Gate G11 e compliance
  INPUT:    {"candidateScore":49,"defaultMin":48,"acceptedMin":52}
  EXPECTED: {"defaultDecision":"TRADE","defaultCompliant":true,"acceptedDecision":"NESSUN_TRADE","acceptedBlockedGate":"G11","acceptedCompliant":false}
  ACTUAL:   {"defaultDecision":"TRADE","defaultCompliant":true,"acceptedDecision":"NESSUN_TRADE","acceptedBlockedGate":"G11","acceptedCompliant":false}
[T49] PASS | Ottimizzazione Sessione: 3 trade EU (< 5 minimi) -> Dati Insufficienti, 0 proposte fittizie
  INPUT:    {"market":"EU","tradeCount":3,"minRequired":5}
  EXPECTED: {"market":"EU","evaluatedCount":3,"status":"NO_CHANGES_NEEDED","proposedChangesCount":0,"titleContainsInsufficient":true}
  ACTUAL:   {"market":"EU","evaluatedCount":3,"status":"NO_CHANGES_NEEDED","proposedChangesCount":0,"titleContainsInsufficient":true}
[T50] PASS | Ottimizzazione Duale: 6 trade EU -> proposta minScoreEurope; 2 trade US -> Dati Insufficienti isolati
  INPUT:    {"euTradeCount":6,"usTradeCount":2,"minRequired":5}
  EXPECTED: {"euStatus":"PENDING","euHasTargetedChange":true,"usStatus":"NO_CHANGES_NEEDED","usProposedCount":0,"usTitleContainsInsufficient":true}
  ACTUAL:   {"euStatus":"PENDING","euHasTargetedChange":true,"usStatus":"NO_CHANGES_NEEDED","usProposedCount":0,"usTitleContainsInsufficient":true}
[T51] PASS | Barra iniziale a volume 0: contribuisce 0 al cumulato (25.000) e non produce rvol = 0 (rvol = 1.25x)
  INPUT:    {"orbVolumes":[0,10000,15000],"histAvg":20000}
  EXPECTED: {"expectedRvol":1.25,"nonZero":true}
  ACTUAL:   {"actualRvol":1.25,"nonZero":true}
[T52] PASS | Cumulato corretto: 3 barre 5m (100.000) / media storica ORB 20 sessioni (50.000) -> rvol = 2.00x
  INPUT:    {"orbVolumes":[20000,30000,50000],"histAvg":50000}
  EXPECTED: {"expectedRvol":2}
  ACTUAL:   {"actualRvol":2}
[T53] PASS | RVOL non disponibile: restituisce null (mai 0), tier mostra N/D e applica punteggio neutro (0pt)
  INPUT:    {"histBarsCount":10,"quoteRvol":null}
  EXPECTED: {"rvolIsNull":true,"rvolScore":0,"detailHasNd":true}
  ACTUAL:   {"rvolIsNull":true,"rvolScore":0,"detailHasNd":true}
[T54] PASS | Verifica soglia EU effettiva RVOL di pre-screening pari a 0.85 (0.84x respinto, 0.85x ammesso)
  INPUT:    {"expectedThreshold":0.85,"belowRvol":0.84,"passRvol":0.85}
  EXPECTED: {"paramVal":0.85,"belowBlocked":true,"passAllowed":true}
  ACTUAL:   {"paramVal":0.85,"belowBlocked":true,"passAllowed":true}
[T55] PASS | Costruzione quote live da barre reali SAP.DE (28/10/2026): rvol = 0.46x; storico <20 sessioni -> rvol = null (mai fallback)
  INPUT:    {"fullHistCount":20,"partialHistCount":10,"cumVol":18961,"histAvg":41536}
  EXPECTED: {"expectedRvolFull":0.46,"expectedRvolPartial":null,"rvolScorePartial":0}
  ACTUAL:   {"rvolFull":0.46,"rvolInsufficient":null,"rvolScorePartial":0}
================================================================
RISULTATO COMPLESSIVO: 55 / 55 PASS
================================================================
EXIT_CODE=0
```

## 7.2 Nessun file di log tracciato
```
GREP_EXIT=1
```

## 0.2 Esito della mappa della pipeline

**Esiste un punto in cui sono disponibili TUTTI i candidati prima di qualunque filtro? Sì.**

- `server.ts:2299` — `executeMarketDataScan` scarica le quote di tutti gli underlyings attivi (40 titoli: `DEFAULT_TRADE_REPUBLIC_UNDERLYINGS`, `server.ts:81`, selezionati da `filterUnderlyingsForActiveMarkets` in `server.ts:2498`).
- `server.ts:2338-2353` — subito dopo il fetch e prima di qualunque gate/scoring/log si trova il hook `safeAppendAiShadowLog(buildScanCandidateEntries(...))`: qui sono presenti tutti i candidati, non filtrati.
- `server.ts:2362` — `scanScores` è costruito su `results` completo (mappa 1:1, nessun filtro); i filtri di selezione vivono più avanti e a valle.
- `src/utils/calculator.ts:1477` — `rankMarketCandidates` (ranking/veto lato client).
- `src/utils/calculator.ts:2022` — `buildExecutionSetup`; i gate G1-G13 sono valutati in sequenza in `src/utils/calculator.ts:2217-2381`, il primo fallito determina `blockedGate` in `src/utils/calculator.ts:2382-2385`. Qui il flusso di selezione si ferma e restano i top setup.
- `src/App.tsx:809` e `src/App.tsx:908-923` — `getDualTopCandidates` e `isCandidateCompliantWithParameters` sul client: selezione dei top setup, invariata.
- `/api/ai/specialize`: input `req.body.trades` / `req.body.excluded` (fallback `sharedAppState`, `server.ts:2735-2736`); l'LLM riceve statistiche e al massimo 3-4 esempi, non i 40 candidati (`server.ts:2748-2780`).
- `/api/ai/desk-post-mortem`: input `req.body.trades` filtrato per `market` in `sessionTrades` (`server.ts:2931-2940`); stessa logica di prompt/esempi.
- Parsing/filtro: `buildAiShadowLogEntries` (`server.ts:2689`), `rawDirectives` (`server.ts:2815` e `:3038`), `shapeValidDirectives` (`server.ts:2822` e `:3044`).
- Persistenza/risposta: `GET /api/shadow/ai-log` (`server.ts:3771`) con `buildAiShadowLogResponse`; `/api/shadow/latest` invariato (`src/server/shadowRoute.ts:64-119`), nessun campo AI.

## Copertura: quanti candidati

Il hook registra **1 voce per ciascun titolo restituito dalla scansione** (40 sul capitale attivo, meno i titoli senza quota). Nel test di copertura 40/40. Ogni voce ha `source: "scan"`, `evaluated: false`, `discarded: false`, `discardReason: "NON_INVIATO_ALLA_LLM"`, `status: "NON_VALIDATO"`, `outcome: null` (`src/server/aiShadowLog.ts:198-229`).

## Fase 2 — modulo

- Percorso `shadow_ai_log.jsonl` in radice (`src/server/aiShadowLog.ts:54`), ignorato in `.gitignore` insieme agli archivi `shadow_ai_log.*.jsonl`.
- Rotazione: soglia `AI_SHADOW_LOG_MAX_BYTES = 5 * 1024 * 1024` (`src/server/aiShadowLog.ts:58`), tre archivi (`:60`), funzione `rotateIfOversized` (`:177`), nomi `shadow_ai_log.1.jsonl` … `.3.jsonl` (`aiShadowLogArchivePath`, `:165`).
- `appendAiShadowLog`, `readAiShadowLog`, `safeAppendAiShadowLog` sono le uniche funzioni di I/O pubbliche; `buildScanCandidateEntries`, `clampAiShadowLogLimit`, `buildAiShadowLogResponse` sono pure.

## Fase 5 — Persistenza (limite)

`server.ts:3722` (`if (process.env.K_SERVICE)`) dichiara il deploy su Cloud Run: il filesystem del container è **effimero**. Quindi `shadow_ai_log.jsonl` e i suoi archivi possono sparire a riavvio/cold start e ogni istanza ha il proprio file; `GET /api/shadow/ai-log` legge solo l'istanza che serve la richiesta. Non è stato introdotto alcun database o storage esterno.

## NON VERIFICATO

1. **Comportamento reale degli handler HTTP** (`/api/ai/specialize`, `/api/ai/desk-post-mortem`, `/api/shadow/ai-log`) e del hook dentro `executeMarketDataScan`: server non avviato per vincolo esplicito; nessuna chiamata HTTP reale eseguita.
2. **Scrittura effettiva del log in produzione**: dipende dal filesystem effimero di Cloud Run (sopra); non osservata su istanza reale.
3. **Cron reale**: `server.ts:3722-3723` disabilita il cron in-process su Cloud Run e rinvia a Cloud Scheduler su `POST /api/ai/learning/run`; la configurazione Cloud Scheduler non è nel repo, quindi non verificabile qui.
4. **Invio dei 40 candidati all'LLM**: non implementato per scelta (Fase 1.3); restano registrati come `NON_INVIATO_ALLA_LLM`.

## Rischi residui

- **Candidati non inviati all'LLM (1.3)**: il log copre i 40 titoli, ma la valutazione AI continua a vedere solo trade/esclusi aggregati. Proposta separata (non implementata): passare alla LLM un riassunto compatto dei candidati scansionati, cambiando il prompt e quindi il comportamento dell'AI; richiede autorizzazione.
- **Filesystem effimero (0.7/Fase 5)**: perdita del log a riavvio e letture per-istanza. Opzioni, solo se autorizzate: bucket/GCS o Firestore (costi non stimabili senza dati d'uso verificabili).
- **Volume**: ogni scansione schedulata scrive ~40 righe; la rotazione a 5 MB limita la crescita a ~20 MB totali (corrente + 3 archivi).
- **Errori di I/O silenziosi**: solo `console.warn`, per non alterare la risposta.

## Domande aperte

1. Autorizzi `git push origin feat/ai-shadow-log`?
2. Autorizzi, separatamente, il merge su `main`?
