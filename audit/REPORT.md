# AUDIT TECNICO E QUANTITATIVO — Shadow V2 / Shadow V1-live

**Repository**: `christianbatt/Iintraday-radar-knock-out` · **branch**: `main` · **HEAD**: `71b5dbe060c32c972ecc1dcc8a32f77d1eceae76`
**Data audit**: 2026-11-18 · **Modalità**: sola lettura (nessun commit, branch, PR, push; nessun file del repo modificato)
**Ambiente**: Node v26.13.0, npm 11.20.0, dipendenze installate con `npm install --no-package-lock` (come fa la CI), `bun install --frozen-lockfile` rifiutato perché `bun.lock` è disallineato.

Legenda evidenze: **VERIFICATO** = letto o eseguito in questa sessione · **IPOTESI** = dedotto dal codice, non eseguito · **NON TROVATO** = assente o non accessibile.

**Documenti collegati**: [ai_calibration_pr_c.md](ai_calibration_pr_c.md) — calibrazione del desk AI (`ai-calibration@1`): join uno-a-uno decisione → esito forward, finestra, soglia, `edgeR`, campo chiuso `decision`, limiti e comandi di verifica.

---

## 1. Sintesi esecutiva

1. Il blocco Shadow è oggi **due motori**: V2 (backtest su barre storiche, con costi e leva KO) e V1-live (osservazione dal vivo del setup emesso dal radar), entrambi attivi di default e senza flag di spegnimento per V2.
2. V1-live è un'aggiunta **ben isolata**: 7 moduli nuovi, nessuna modifica a G1–G13, `tradingParams.ts`, `server.ts` (5 righe additive) e `App.tsx` (7 righe). 12 PR (#89–#100), +6.359/−54 righe, 280 test in CI, tutti verdi.
3. La qualità media è alta sul **nucleo puro** (deterministico, iniettato, senza `any`) e più fragile sull'**I/O**: lo store riscrive l'intero file a ogni cambiamento, senza retention, e il ciclo periodico **non condivide il lock** con la route POST.
4. **Problema più grave**: `runShadowV1LiveRevaluationCycle` (collector:743) e `createObserveHandler` (collector:544) leggono-scrivono lo stesso JSONL senza serializzazione comune → un inserimento può essere sovrascritto (lost update); con più processi il nome del file temporaneo è identico (`store:375`) → rischio di corruzione.
5. **Secondo problema**: la POST `/api/shadow/v1-live/observe` non è autenticata e `calculatedAt` è scelto dal client: chiunque può iniettare setup con sessione arbitraria e inquinare le metriche mostrate nel pannello.
6. La CI **non esegue `tsc`** e usa `npm install` senza lockfile (workflow `param-sync-test.yml`); 7 suite (`sprint1`, `phase1`, `audit`, `audit2`, `learning`, `sprint3`, `firebase-sync`) restano fuori.
7. **Cinque commenti sono ora falsi** dopo l'accensione dei flag (dicono "spento di default" / "attivo solo con 1 o true"): inducono a configurare variabili che non servono.
8. La UI **è stata verificata visivamente** in questa sessione con render statico + CSS reale del build (screenshot `audit/v1live-panel.png`): layout coerente, nessun difetto visivo bloccante; mancano polling, `aria-live` e gestione `Escape` nella modale.
9. Il confronto V1-live/V2 è dichiarato **non disponibile** nel pannello e la dichiarazione è corretta: ingresso, barriera temporale, costi e popolazione differiscono.
10. Voto complessivo **7/10**: correttezza e testabilità alte, sicurezza e osservabilità basse.

---

## 2. Inventario delle modifiche

### 2.1 Cronologia disponibile (clone **shallow**: storia troncata al 2026-11-05)

171 commit totali, 52 merge commit, PR fino alla #100. Le PR #1–#18 **non sono nel clone** (NON TROVATO). Tabella: blocco Shadow e CI.

| PR | SHA | Data | Titolo | File | ± |
|---|---|---|---|---|---|
| #19 | `745cd00` | 2026-11-05 | Merge `fix/warmup-ui-guards` (più vecchio disponibile) | — | — |
| #82 | `65bb39c` | 2026-11-17 | ci: cablare i test shadow su main e PR | workflow, package.json | +6/−1 |
| #83 | `e2a5f23` | 2026-11-17 | fix(shadow): mulberry32 nel bootstrap sign-flip V2 | shadowV2 | — |
| #84 | `a87da0c` | 2026-11-17 | test(orb): regressioni ORB | test orb | — |
| #85 | `dd75c27` | 2026-11-17 | fix(shadow-v2): panel honesty (disclaimer, n, limiti) | ShadowResearchPanel | — |
| #86 | `7ce177f` | 2026-11-18 | fix: rifiuto OHLC ORB non finiti | orb | — |
| #87 | `887f8dc` | 2026-11-18 | test: shadow panel in CI | workflow | — |
| #88 | `498bdb2` | 2026-11-18 | fix(shadow-panel): confronto V1/V2 senza etichette errate | panel + test | +134/−20 |
| #89 | `899c9b9` | 2026-11-18 | feat(v1-live): nucleo puro lifecycle | nucleo + test | +695 |
| #90 | `3f420b7` | 2026-11-18 | feat(v1-live): rifiuto livelli incoerenti | nucleo + test + CI | +136 |
| #91 | `0976e82` | 2026-11-18 | feat(session-close): chiusura EU/US con ora legale | sessionClose + test | +327 |
| #92 | `c80a918` | 2026-11-18 | feat(store): persistenza con idempotenza e terminali immutabili | store + test | +948 |
| #93 | `8c2fbb7` | 2026-11-18 | feat: collector passivo dietro flag | collector + server.ts + test | +1.433 |
| #94 | `5751d45` | 2026-11-18 | feat: ponte client→server dietro flag | bridge + config + App.tsx + test | +518 |
| #95 | `72f7575` | 2026-11-18 | feat: vista GET read-only dietro flag | view + server.ts + test | +818 |
| #96 | `109061c` | 2026-11-18 | feat: pannello read-only dietro flag | panel + config + modale + test | +598 |
| #97 | `3477e96` | 2026-11-18 | fix: guardia di copertura barre | collector + test | +552/−7 |
| #98 | `b937591` | 2026-11-18 | feat: ritardo di osservazione, esclusione late | view + panel + test | +234/−4 |
| #99 | `fe43be7` | 2026-11-18 | chore: accensione flag client | 2 config + test | +38/−14 |
| #100 | `71b5dbe` | 2026-11-18 | feat: flag server ON di default, OFF con 0/false | collector, view, test | +62/−29 |

**Commit fuori processo (VERIFICATO)**: `39b3c5a` (2026-11-17, "feat: enhance shadow collection and update screening logic") ha introdotto **Shadow V2** (`src/knowledge/shadowV2.ts` 1.089 righe, `src/server/shadowV2Collector.ts`, `scripts/shadow_v2.ts`) con un messaggio vago, **senza numero di PR**, insieme a 17 cancellazioni (fra cui `scripts/replay_results.json` da 49.863 righe) e a modifiche a `src/components/ImpliedVolatilityGauge.tsx` (+56/−…). È il commit più rischioso della storia recente per tracciabilità.

### 2.2 Aree funzionali

| Area | Cosa fa | File principali |
|---|---|---|
| Nucleo V1-live | lifecycle puro: fill limit, stop prima del target, scadenza sessione, deduplica, coerenza livelli | `src/knowledge/shadowV1Live.ts` |
| Chiusura sessione | istante di chiusura EU/US in UTC con ora legale (solo weekend) | `src/utils/sessionClose.ts` |
| Store | JSONL con idempotenza, transizioni monotone, terminali immutabili | `src/server/shadowV1LiveStore.ts` |
| Collector | POST `/api/shadow/v1-live/observe`, archivio barre gemello, guardia copertura, ciclo 60 s | `src/server/shadowV1LiveCollector.ts` |
| Ponte client | POST fire-and-forget del setup emesso, deduplica, retry singolo | `src/utils/shadowV1LiveBridge.ts`, `src/config/shadowV1LiveBridge.ts` |
| Vista | GET `/api/shadow/v1-live/signals`, conteggi, metriche, late | `src/server/shadowV1LiveView.ts` |
| Pannello | tabella read-only + riferimento V2, nessun ricalcolo | `src/components/ShadowV1LivePanel.tsx`, `src/config/shadowV1LiveView.ts` |
| V2 | motore su barre storiche, costi/leva KO, summary | `src/knowledge/shadowV2.ts`, `src/server/shadowV2Collector.ts`, `src/components/ShadowV2Section.tsx` |

### 2.3 Punti di aggancio (VERIFICATO)

| Punto | File:riga | Effetto |
|---|---|---|
| Alimentazione barre | `server.ts:1201` | `recordBarsForShadowV1Live(ticker, market, barsForShadowV2)` — stesso array di V2 |
| Registrazione route + timer | `server.ts:3412` | `registerShadowV1LiveCollector(app)` (dopo `apiLimiter`) |
| Registrazione vista | `server.ts:3413` | `registerShadowV1LiveViewRoute(app)` |
| Ponte client | `src/App.tsx:1186-1187` | `notifyShadowV1Live(setupEU/setupUS)` in un solo `useEffect` |
| Pannello | `src/components/ShadowResearchModal.tsx:87` | `<ShadowV1LivePanel />` montato sempre dentro la modale aperta |

### 2.4 Flag e variabili

| Nome | Default | Dove letto | Quando |
|---|---|---|---|
| `SHADOW_V1_LIVE_BRIDGE` (costante) | `'on'` | `config/shadowV1LiveBridge.ts:13` | a ogni chiamata del ponte (bundled) |
| `SHADOW_V1_LIVE_VIEW_PANEL` (costante) | `'on'` | `config/shadowV1LiveView.ts:10` | al render |
| `SHADOW_V1_LIVE_COLLECT` (env) | **ON** (assente/vuota = ON; OFF solo `0`/`false`) | collector:72-77 | handler a ogni richiesta; timer **al boot** |
| `SHADOW_V1_LIVE_VIEW` (env) | **ON** | view:51-60 | a ogni GET |
| `PORT`, `VALID_API_KEYS`, `EXTERNAL_FETCH_TIMEOUT_MS`, `YAHOO_CACHE_TTL_MS` | vedi `.env.example` | `server.ts` | boot |

---

## 3. Flusso e architettura

```
[radar client]
  screening → setupEU / setupUS (decision TRADE)
        │  App.tsx:1186 useEffect
        ▼
[shadowV1LiveBridge]  dedupe ticker|entry|stop|UTC-day (Set, tetto 500)
        │  POST /api/shadow/v1-live/observe  (fire-and-forget, timeout 3s, 1 retry su 5xx)
        ▼
[express] apiLimiter 60/min  →  route collector
        │  body ≤ 8192 B?  →  rate 10/min per IP  →  schema 7 campi
        │  sessionDateFor + sessionCloseMsFor  (Europe/Rome 17:30 · America/New_York 16:00)
        ▼
[queue del handler]  ←─ unico punto serializzato (solo POST)
        │  loadRecords(JSONL) → evaluateShadowV1Live() → coverage guard → upsert → writeRecordsAtomic
        ▼
artifacts/shadow_v1_live/signals.jsonl   (riscrittura completa, tmp+rename)
        ▲
        │  ogni 60 s (setInterval, unref) — SENZA passare dalla queue
[runShadowV1LiveRevaluationCycle]  rivaluta PENDING_FILL/OPEN con barsForShadowV1Live()

[server.ts:1199] barsForShadowV2 ──┬─→ recordClosedBarsForShadowV2 (archivio V2)
                                   └─→ recordBarsForShadowV1Live (archivio gemello V1, tetto 600)
        ▼
GET /api/shadow/v1-live/signals  →  buildShadowV1LiveView (conteggi, meanR, winRate, maxDD, late)
        ▼
ShadowV1LivePanel (fetch di 2 endpoint all'apertura della modale, refresh manuale)
```

**Dipendenze**: `shadowV1Live.ts` non importa nulla del server; `sessionClose.ts` importa solo `tradingParams`; `store` importa i tipi del nucleo; `collector` importa nucleo+sessionClose+store; `view` importa solo store; `panel` importa solo tipi. Nessun ciclo. Il nucleo V1-live **non** è importato da V2 e viceversa (VERIFICATO).

---

## 4. Verifiche eseguite

| Comando | Exit | Esito |
|---|---|---|
| `npx tsc --noEmit` | **0** | nessun errore |
| `npm run build` (vite) | **0** | `dist/assets/index-*.js` 1.789 KB, CSS 104 KB, PWA 17 entry |
| `param_merge.test.ts` | **0** | ALL PASS |
| `test:shadow` | 0 | 5 pass / 0 fail |
| `test:shadowv2` | 0 | 13 / 0 |
| `test:orb` | 0 | 15 / 0 |
| `test:shadow-panel` | 0 | 13 / 0 |
| `test:features-v2` | 0 | 7 / 0 |
| `test:shadowv1live` | 0 | 48 / 0 |
| `test:sessionclose` | 0 | 21 / 0 |
| `test:shadowv1livestore` | 0 | 40 / 0 |
| `test:shadowv1livecollector` | 0 | 60 / 0 |
| `test:shadowv1livebridge` | 0 | 17 / 0 |
| `test:shadowv1liveview` | 0 | 21 / 0 |
| `test:shadowv1livepanel` | 0 | 20 / 0 |
| **Totale suite CI** | — | **280 pass / 0 fail** |
| `test:sprint1`, `test:phase1`, `test:audit`, `test:audit2`, `test:learning`, `test:sprint3`, `test:firebase-sync` | 0 | tutte verdi, **non in CI** |
| `bun install --frozen-lockfile` | **1** | `bun.lock` disallineato (`esbuild ^0.25.0` → `^0.28.0`) |

**Test NON eseguiti in CI** (VERIFICATO dal workflow): le 7 suite sopra, più `tsc`. La CI esegue solo 12 script + `param_merge`.
**Nessun test end-to-end**: la route reale non viene mai montata su express nei test; il cablaggio in `server.ts`/`App.tsx` è verificato **leggendo il sorgente con una regex** (collector test:1013-1031, view test:395-397, bridge test:266-275).

---

## 5. Hardcoded

| # | File:riga | Valore | Motivo | Proposta | Giudizio |
|---|---|---|---|---|---|
| H1 | `collector:60` | `SHADOW_V1_LIVE_BAR_MS = 5*60*1000` | duplica `IND_BAR_MS` (`tradingParams.ts:335`) | usare `IND_BAR_MS` | **da eliminare** |
| H2 | `collector:63` | `MAX_BARS_PER_TICKER = 600` | duplica V2 (`shadowV2Collector.ts:29`) | costante condivisa in `src/config` | da centralizzare |
| H3 | `collector:838` | `\`${root}/artifacts/shadow_v1_live/signals.jsonl\`` | terza copia dello stesso path (store:45, view:source) | usare `SHADOW_V1_LIVE_SIGNALS_PATH` | **da eliminare** |
| H4 | `collector:49` + `bridge:25` | `/api/shadow/v1-live/observe` | endpoint definito due volte (server e client) | unica costante condivisa | da centralizzare |
| H5 | `collector:52` | `8192` | limite body della route | env con default | legittimo, documentare |
| H6 | `collector:55` | `10/min` | rate proprio della route | env con default | legittimo |
| H7 | `collector:66` | `60_000` ciclo | periodo rivalutazione | env con default | legittimo |
| H8 | `collector:189` | `60_000` warn copertura | throttle log | — | legittimo |
| H9 | `collector:364` | `TICKER_MAX_LENGTH = 20` | limite ticker | allineare al validatore ticker esistente | da verificare col proprietario |
| H10 | `view:38` | `500` record massimi | tetto risposta | env | legittimo |
| H11 | `view:47` | `LATE_THRESHOLD_MS = 600_000` | soglia late, **pre-registrata** | non toccare senza nuova pre-registrazione | **legittimo e da congelare** |
| H12 | `bridge:28` | `500` chiavi dedupe | tetto memoria | — | legittimo |
| H13 | `bridge:34` | `60_000` throttle warn | — | — | legittimo |
| H14 | `bridge:33` | `3000` timeout | — | — | legittimo |
| H15 | `sessionClose.ts:24-25` | `Europe/Rome`, `America/New_York` | fusi | costante esportata | legittimo, estrarre |
| H16 | `sessionClose.ts:120` | `3` iterazioni offset | convergenza DST | — | legittimo |
| H17 | `panel:63,237` | `60_000` | conversione minuti | — | legittimo |
| H18 | `panel:98-101` | URL API | percorso client | costanti condivise | da centralizzare |
| H19 | `.gitignore` | manca `artifacts/` | dati non ignorati; `artifacts/shadow_v2/summary.json` è **tracciato** | aggiungere `artifacts/` | **da correggere** |
| H20 | workflow | `node-version: 22`, `npm install` | nessun lockfile | `npm ci` con lock o `bun install --frozen-lockfile` | **da correggere** |

Chiusura sessione (17:30 / 16:00) **non** è hardcoded: viene da `TRADING_PARAMS` (`tradingParams.ts:260-264`). Corretto.

---

## 6. Punti di forza

1. **Separazione netta**: il nucleo V1-live è puro (nessun I/O, nessun orologio, nessuno stato globale) e non è importato da radar/server/client (VERIFICATO).
2. **Dependency injection sistematica**: collector, view, store e bridge accettano `now`, `bars`, `readRecords`, `writeRecords`, `timers`, `coverage` → test deterministici e veloci (280 test in ~2 s totali).
3. **Zero `any`** nei 7 moduli nuovi (VERIFICATO con grep) e tipi derivati dai tipi reali (`Pick<ExecutionSetup, …>`).
4. **Onestà metodologica**: `NOT_FILLED`, `PENDING_FILL` e `OPEN` esclusi dal denominatore e non contati come zero (view:183-240); il pannello dichiara che il confronto V1/V2 non è disponibile invece di simularlo (`panel:300-330`).
5. **Guardia di copertura barre** (collector:219-320): impedisce di dichiarare `EXPIRED`/`STOP` su serie incomplete. È la difesa più intelligente del blocco.
6. **Isolamento degli errori**: ogni percorso I/O restituisce invece di lanciare; un file rotto non ferma né il radar né V2.
7. **Validazione stretta del payload** (collector:392-460): 7 campi, nessun extra, ISO 8601 obbligatoria, nessun fallback all'orologio del server.
8. **Terminali immutabili** (store:252): un esito non può essere riscritto; `decidedAtMs` è il primo osservato.
9. **Soglia late pre-registrata** a 600.000 ms e dichiarata nella risposta (`lateThresholdMs`), così il client non la duplica.
10. **CI verde e riproducibile sul contenuto**: 12 suite shadow in workflow, tutte passate in questa sessione.

---

## 7. Problemi per gravità

### CRITICO

**C1 — Lost update fra ciclo periodico e route POST (nessuna serializzazione comune).**
Evidenza: `collector:544` crea `chain` **dentro** `createObserveHandler`; `collector:743-800` esegue `readRecords` → `upsert` → `writeRecordsAtomic` **senza** passare da quella coda; il timer `collector:868` chiama il ciclo ogni 60 s.
Impatto: il ciclo legge lo snapshot S0, cede il controllo a un `await`, la POST inserisce un record e scrive S1, il ciclo scrive S0′ → **il record nuovo sparisce silenziosamente**. Secondario: `store:375` usa `signals.jsonl.tmp-${process.pid}`; due processi (cluster/pm2) scrivono lo stesso tmp → rename incrociato e possibile corruzione dell'unico artefatto.
Probabilità: media in single process, alta con più istanze o I/O lento.
Riproduzione: seed di un file con 1 record `PENDING_FILL`, `readRecords` iniettato con `await Promise.resolve()` e una POST concorrente; il file finale non contiene la chiave nuova. I test di concorrenza esistenti (collector test: "richieste concorrenti …") coprono **solo POST vs POST**.

### ALTO

**A1 — POST `/api/shadow/v1-live/observe` senza autenticazione, con `calculatedAt` scelto dal client.**
Evidenza: `collector:566-620` (nessun `requireApiAuth`, a differenza di `server.ts:2450`, `2466`, `3019`, `3337`); `sessionDateFor(setup.market, setup.decidedAtMs)` deriva la sessione dal timestamp del client.
Impatto: iniezione di setup arbitrari (ticker, livelli, data) → inquinamento dello store e delle metriche mostrate nel pannello; `r` e `meanR` non sono più riferibili a emissioni reali del radar. Il rate limit (10/min per IP) non ferma un attore distribuito.
Probabilità: alta (endpoint pubblico, nessun segreto richiesto).

**A2 — Riscrittura completa del file a ogni cambiamento, senza retention.**
Evidenza: `store:368-390` ricostruisce l'intero contenuto e `rename`; `collector:612-700` riscrive a ogni upsert; `view:361-380` legge tutto il file a ogni GET.
Impatto: costo O(n) per evento e per lettura, crescita illimitata; con mesi di esercizio il JSONL diventa il collo di bottiglia e il rischio di troncamento in scrittura cresce. Nessun limite dichiarato oltre i 500 record **mostrati** (view:38), che non limitano il file.

**A3 — Limite body inefficace.**
Evidenza: `server.ts:167` `express.json({ limit: '10mb' })` è globale e gira **prima** della route; il controllo a 8192 byte (`collector:571`) avviene su un body già parsato in memoria.
Impatto: una POST da 9 MB viene allocata e poi rifiutata con 413; la protezione dichiarata nel commento (`collector:51`) non esiste nella pratica.

### MEDIO

**M1 — `loadRecords` valida solo `v` e `key`.**
`store:328-360`: un record con `status` valido ma `decidedAtMs` mancante passa; `byOrder` (store:152) confronta `undefined` → `NaN` → ordinamento instabile, e la vista lo mostra con date `Invalid Date`. Riproduzione: aggiungere a mano `{"v":1,"key":"x","status":"OPEN"}` al file.

**M2 — Finestra di fill che esclude la barra della decisione.**
`shadowV1Live.ts:152` (`b.t > decidedAtMs`): se il setup è emesso alle 10:03, la barra 10:00–10:05 è esclusa e un tocco alle 10:04 è ignorato. Bias: fill mancanti, non fill falsi (conservativo), ma la popolazione V1-live non è quella realmente operabile.

**M3 — Stop in gap liquidato al livello di stop (−1 R).**
`shadowV1Live.ts:275-276`: `exitPrice = stopLossLevel`, `r = -1` anche quando la barra apre sotto lo stop. V2 tratta il gap correttamente (`shadowV2.ts:862-866` e `:893-897`, `exitPrice = barK.o`). Conseguenza: il R di V1-live è **ottimista** nei gap, e la differenza con V2 non è solo "costi/leva" come dice il pannello.

**M4 — Nessun calendario festività / mezze giornate.**
`sessionClose.ts:10-20` lo dichiara. Su un festivo non arrivano barre → la guardia di copertura blocca `EXPIRED`/`NOT_FILLED` → il record resta `PENDING_FILL` per sempre, marcato `stale`. Non produce risultati falsi (bene), ma produce record non conclusi permanenti e un conteggio `stale` che cresce senza spiegazione in UI.

**M5 — CI senza typecheck e senza lockfile.**
`param-sync-test.yml`: nessuno step `tsc`; `npm install` senza lock (esiste solo `bun.lock`, per giunta disallineato: `esbuild ^0.25.0` vs `^0.28.0`). Un errore di tipo o una major incompatibile entrano in `main` verdi.

**M6 — Cinque commenti falsi dopo l'accensione dei flag.**
`collector:9` ("Tutto e' spento di default … attivo solo con '1' o 'true'"), `view:6` (idem), `src/utils/shadowV1LiveBridge.ts:5-6` ("Tutto e' spento di default"), `panel:21` ("default 'off'"), `App.tsx:1184` ("spenta di default"). Inducono a impostare env inutili o a credere la funzione spenta.

**M7 — Test che leggono il sorgente.**
`collector` test:1013-1031, `view` test:395-397, `bridge` test:266-275 verificano il cablaggio con `regex` su `server.ts`/`App.tsx`. Qualsiasi riformattazione rompe la suite senza che nulla sia rotto; e non verificano il comportamento (la route non viene mai montata su express).

**M8 — `artifacts/` non è in `.gitignore` e un artefatto è tracciato.**
`.gitignore:1-11`; `git ls-files artifacts registry` → 24 file, fra cui `artifacts/shadow_v2/summary.json`. Rischio di committare dati di mercato e output sperimentali.

**M9 — Il ponte scarta in silenzio i setup non EU/US.**
`bridge:113` accetta `setup.marketType ?? candidate.market`, ma `candidate.market` è `'EU' | 'US' | 'GLOBAL'` (`types/radar.ts:306`); con `GLOBAL` il payload è `null` e non parte nulla, senza contatore né log (solo il caso "invio non riuscito" è loggato).

### BASSO

**B1** — Mappa del rate limit per IP mai ripulita (`collector:542`): crescita illimitata in memoria a ogni IP visto.
**B2** — `getShadowV1LiveCoverageStats` (collector:326) è esportata ma nessuna route o consumatore la usa: contatori invisibili in produzione (osservabilità).
**B3** — Chiave di deduplica con float grezzi (`shadowV1Live.ts:112`): `100` vs `100.0000001` → due record.
**B4** — Nessun polling nel pannello (`panel:143-152`): solo "Aggiorna" manuale, il conteggio resta fermo finché l'utente non ricarica.
**B5** — Accessibilità: la modale non gestisce `Escape`, non intrappola il focus, non ha `aria-modal`; la tabella non ha `caption`/`scope="col"`; caricamento/errore senza `aria-live` (`ShadowResearchModal.tsx:56-90`, `panel:160-175`).
**B6** — Etichetta ambigua "Con esito / non riempiti" = `terminal − notFilled` (`panel:189-194`): mescola due categorie in un unico numero.
**B7** — `delayMs` e le date sono mostrati in UTC con suffisso `Z` (`panel:57`), senza indicazione locale: coerente ma da etichettare esplicitamente.
**B8** — Componente pannello da 335 righe con markup ripetuto (4+4 card identiche): estraibile in un sottocomponente.
**B9** — `Market` ridefinito in collector (`:69`) e bridge (`:39`) invece di riusare `types/radar.ts:11`.

---

## 8. Voti

| Dimensione | Voto | Motivazione |
|---|---|---|
| Correttezza | **8** | nucleo deterministico, ordine stop/target corretto, DST gestito da `Intl`, deduplica e terminali immutabili testati; penalizzato da M2/M3 (finestra fill, gap stop) |
| Robustezza | **6** | nessuna eccezione propagata e guardia copertura ottima, ma lost update C1, riscrittura integrale A2, validazione lettura debole M1 |
| Sicurezza | **4** | POST aperta con timestamp client (A1), body limit inefficace (A3), GET pubblica, nessuna provenance |
| Manutenibilità | **7** | moduli piccoli e ben documentati, ma 5 commenti falsi (M6), costanti duplicate (H1-H4), path in tre punti |
| Testabilità | **8** | DI capillare, 280 test verdi; penalizzata dai test sul sorgente (M7) e dall'assenza di E2E |
| Osservabilità | **5** | solo `console.warn` con throttle; contatori copertura non esposti (B2); nessun log strutturato, nessuna metrica di drop (M9) |
| UX | **6** | chiara, onesta, gerarchia visiva corretta (verificata con screenshot); senza polling, con etichette ambigue e a11y carente |
| **Complessivo** | **7/10** | funzione matura nel calcolo, acerba nell'I/O e nella sicurezza |

---

## 9. Piano di interventi

Tipo: bug / debolezza / hardcoded / miglioramento / sicurezza / test / documentazione. Effort: S (<½ giornata), M (1–2), L (>2).

| ID | Titolo | Tipo | Gravità | File | Intervento | Perché preserva la funzione voluta | Rischio | Effort | Dipende da | Criterio di accettazione |
|---|---|---|---|---|---|---|---|---|---|---|
| CON-1 | Coda unica fra handler e ciclo | bug | Critico | collector, store | esportare una `Mutex`/coda di modulo e usarla in entrambi i percorsi | non cambia né stati né metriche: solo l'ordine delle scritture | basso | M | — | test: POST concorrente al ciclo non perde record (file contiene entrambe le chiavi) |
| CON-2 | tmp univoco per scrittura | bug | Critico | store:375 | `tmp-${pid}-${randomUUID()}` | invariato il formato su disco | nullo | S | — | due scrittori concorrenti non producono ENOENT né file misti |
| CON-3 | Sweep della mappa rate limit | debolezza | Basso | collector:542 | TTL + tetto | invariato il comportamento 429 | nullo | S | — | mappa limitata dopo N IP; test dedicato |
| CON-4 | Validazione schema in `loadRecords` | bug | Medio | store:328 | richiedere numerici finiti (`decidedAtMs`, `sessionCloseMs`, livelli) e `status` noto; contare in `skipped` | i record validi sono intatti; quelli rotti sono già ignorati | basso | S | — | record parziale finisce in `skippedLines`, nessun `NaN` nell'ordinamento |
| RET-1 | Retention e compattazione JSONL | miglioramento | Alto | store, collector, view | rotazione per giorno/dimensione (`signals-YYYY-MM.jsonl`) + lettura dei soli ultimi N | i record restano tutti su disco, cambia solo l'organizzazione | medio | L | CON-1 | letture O(ultimi N), file attivo sotto soglia, nessun record perso |
| SIC-1 | Provenance + Origin check sulla POST | sicurezza | Alto | collector, bridge, view | (a) check `Origin`/`Sec-Fetch-Site`, (b) campo `provenance` persistito, (c) metrica separata per record non verificati | le emissioni legittime restano identiche; si aggiunge distinguibilità | basso | M | — | POST da origine estranea → 403; record legacy senza provenance leggibili |
| SIC-2 | Body limit prima del parse | sicurezza | Alto | collector, server.ts | `express.json({limit:'8kb'})` come middleware della sola route | nessun cambio di schema | basso | S | — | body da 9 MB → 413 senza allocazione completa |
| COR-1 | `IND_BAR_MS` al posto della costante duplicata | hardcoded | Basso | collector:60 | importare `IND_BAR_MS` | stessa semantica, una sola fonte | nullo | S | — | test esistenti invariati, `SHADOW_V1_LIVE_BAR_MS` = `IND_BAR_MS` |
| COR-2 | Path e endpoint da costanti uniche | hardcoded | Basso | collector:49/838, bridge:25, view | riusare `SHADOW_V1_LIVE_SIGNALS_PATH` e una costante endpoint condivisa | nessun cambio di URL | nullo | S | — | grep: una sola occorrenza del literal |
| COR-3 | Normalizzazione chiave | debolezza | Basso | nucleo:112 | arrotondare entry/stop al tick nella chiave | deduplica più robusta, stessa semantica | basso | S | — | due setup con differenza < tick → un solo record |
| COR-4 | Finestra di fill include la barra della decisione | bug | Medio | nucleo:152 | usare `b.t + IND_BAR_MS > decidedAtMs` (barra che contiene la decisione) **oppure** dichiarare esplicitamente il vincolo nel report | allinea la popolazione a ciò che è operabile | medio (cambia i numeri storici) | M | decisione proprietario | test dedicato; confronto prima/dopo su fixture |
| COR-5 | Gap oltre lo stop liquidato all'apertura | bug | Medio | nucleo:275 | se `bar.o` oltre lo stop → `exitPrice = bar.o`, `r` calcolato | rimuove il bias ottimista, allinea a V2 | medio (cambia i numeri) | S | decisione proprietario | nuovo test: gap stop → r < −1 |
| CAL-1 | Calendario festività e mezze giornate | miglioramento | Medio | sessionClose | tabella festivi EU/US + chiusura anticipata, iniettata | nessun record non concluso nei festivi | medio | L | decisione proprietario | 25/12 e 24/12 (mezza giornata) → chiusura corretta |
| TST-1 | Test di integrazione su express reale | test | Medio | nuovo test | montare app express con la route e fare `fetch` su porta effimera (nessuna dipendenza nuova) | verifica il cablaggio vero | basso | CON-1 | 201/400/404/413/429 end-to-end |
| TST-2 | Test concorrenza handler↔ciclo | test | Critico | test collector | lettore iniettato con latenza + ciclo concorrente | dimostra CON-1 | nullo | S | CON-1 | nessun record perso |
| TST-3 | Sostituire i test sul sorgente | test | Basso | 3 test | estrarre `registerShadowWiring(app)` in modulo e testare il comportamento | il cablaggio resta identico | basso | M | — | nessuna regex su `server.ts`/`App.tsx` |
| TST-4 | Matrice flag come tabella di casi | test | Basso | test collector/view | casi espliciti: assente, `''`, `0`, `false`, ` FALSE `, `1`, `no` | copre la semantica default-ON | nullo | S | — | 7 casi × 2 moduli |
| UI-1 | Polling opzionale del pannello | miglioramento | Basso | panel | intervallo 30 s solo a modale aperta e tab visibile, con toggle | il refresh manuale resta | basso | M | decisione proprietario | nessuna richiesta a tab nascosta |
| UI-2 | Accessibilità modale e tabella | miglioramento | Basso | modal, panel | `aria-modal`, focus trap, `Escape`, `caption`, `scope`, `aria-live` | nessun cambio visivo | nullo | M | — | tastiera: apertura, Tab, Esc |
| UI-3 | Etichette e fuso espliciti | miglioramento | Basso | panel | separare "con esito" e "non riempiti"; indicare UTC | chiarezza | nullo | S | — | nessun numero ambiguo |
| DOC-1 | Correggere i 5 commenti obsoleti | documentazione | Medio | collector:9, view:6, bridge:5, panel:21, App:1184 | riscrivere la semantica default-ON | nessun cambio di codice | nullo | S | — | nessuna occorrenza di "spento di default" |
| DOC-2 | README operativo Shadow | documentazione | Basso | README | endpoint, flag, rate limit, retention, come spegnere | rende la funzione governabile | nullo | S | — | sezione dedicata |
| REP-1 | `.gitignore` per `artifacts/` | debolezza | Medio | `.gitignore` | aggiungere `artifacts/`; decidere su `summary.json` tracciato | i dati non entrano nel repo | basso | S | decisione proprietario | `git status` pulito dopo una scansione |
| CI-1 | `tsc --noEmit` in CI | test | Medio | workflow | step dopo `npm install` | nessun cambio di codice | nullo | S | — | errore di tipo → CI rossa |
| CI-2 | Eseguire anche le 7 suite escluse | test | Basso | workflow, package.json | aggiungere gli step | invariato | basso | S | — | 19 suite verdi |
| CI-3 | Lockfile riproducibile | debolezza | Medio | bun.lock / package-lock | rigenerare `bun.lock` (esbuild 0.28) o introdurre `package-lock.json` e `npm ci` | dipendenze non cambiano di major senza PR | medio | S | decisione proprietario | `npm ci`/`bun install --frozen-lockfile` exit 0 |

### Raggruppamento in PR e ordine

| PR | Contenuto | Ordine | Parallelo con |
|---|---|---|---|
| **PR-1 «store-sicuro»** | CON-1, CON-2, CON-4, CON-3, TST-2 | 1 | PR-3, PR-4, PR-9, PR-10 |
| **PR-2 «body-e-origine»** | SIC-2, SIC-1 | 2 | PR-5 |
| **PR-3 «costanti»** | COR-1, COR-2, COR-3, H2, B9 | 2 | PR-1 |
| **PR-4 «osservabilità»** | B2 (route o log dei contatori), M9 (contatore drop), log strutturati | 3 | PR-2 |
| **PR-5 «correttezza-nucleo»** | COR-4, COR-5 (dopo decisione) | 3 | PR-7 |
| **PR-6 «retention»** | RET-1 | 4 (dopo PR-1) | PR-5 |
| **PR-7 «test-integrazione»** | TST-1, TST-3, TST-4 | 4 | PR-5 |
| **PR-8 «UI»** | UI-1, UI-2, UI-3, B8 | 5 | PR-6 |
| **PR-9 «documentazione»** | DOC-1, DOC-2, REP-1 | 2 | qualunque |
| **PR-10 «CI»** | CI-1, CI-2, CI-3 | 1 | qualunque |
| **PR-11 «calendario»** | CAL-1 (dopo decisione) | 5 | PR-8 |

Nessun intervento tocca `tradingParams.ts`, G1–G13, core search/scoring, `ImpliedVolatilityGauge.tsx`, `shadowV2*.ts` o i componenti V2: la deduplica dell'archivio barre (H2) è proposta **solo** come costante condivisa, non come modifica a V2.

---

## 10. Decisioni richieste al proprietario

| # | Decisione | Opzioni | Pro | Contro |
|---|---|---|---|---|
| D1 | Autenticazione della POST, che nasce dal browser | A) `Origin`/`Sec-Fetch-Site` + provenance (nessun segreto) · B) `x-api-key` come le altre route, ma la chiave finirebbe nel bundle client · C) emissione server-side (il server genera i setup, il client non invia nulla) | A: costo basso, alza l'asticella · C: unica soluzione realmente solida | A: aggirabile da un client che non è un browser · B: falso senso di sicurezza · C: effort L e duplicazione della logica del radar |
| D2 | Finestra di fill (COR-4) | A) includere la barra della decisione · B) lasciare com'è e dichiararlo | A: popolazione operabile | A: i numeri cambiano e non sono più confrontabili con quelli già raccolti |
| D3 | Gap stop (COR-5) | A) liquidare all'apertura (come V2) · B) mantenere −1 R | A: onestà | A: peggiora il R storico, rompe la continuità del campione |
| D4 | Retention (RET-1) | A) rotazione mensile · B) tetto per numero di record con compattazione · C) nessuna retention e solo tetto di lettura | A/B: file governabile | perdita dell'accesso "tutto in un file"; serve un lettore multi-file |
| D5 | Calendario festività (CAL-1) | A) tabella statica EU/US · B) API esterna · C) nessuna | A: nessuna dipendenza | manutenzione annuale |
| D6 | Polling del pannello (UI-1) | A) 30 s a modale aperta · B) solo manuale | A: dati vivi | A: più carico su route non autenticata |
| D7 | Lockfile (CI-3) | A) rigenerare `bun.lock` · B) passare a `package-lock.json` + `npm ci` | A: coerente con bun presente | A: aggiorna esbuild 0.25→0.28 (major) |
| D8 | `artifacts/` e `summary.json` tracciato (REP-1) | A) ignorare tutto · B) ignorare tutto e rimuovere `summary.json` dal tracking | A: nessun dato nel repo | B: rompe chi legge l'artefatto da git |

---

## 11. Limiti dell'audit

1. **Storia troncata**: clone shallow; le PR #1–#18 e i commit precedenti al 2026-11-05 **non sono disponibili** (NON TROVATO). L'inventario parte da `745cd00`.
2. **Nessuna verifica in produzione**: non è stato avviato `server.ts` contro dati di mercato reali; il comportamento su festivi, mezze giornate e gap reali è dedotto (IPOTESI).
3. **C1 non riprodotto empiricamente**: la race è dimostrata per lettura del codice (assenza di lock condiviso) e dalla presenza di un'unica coda locale all'handler; la riproduzione deterministica richiede l'iniezione di latenza descritta in TST-2.
4. **UI**: verificata **solo** come render statico del componente con dati di esempio e il CSS reale del build (`audit/v1live-panel.png`); non sono stati esercitati fetch reali, loading, errori di rete, refresh, tastiera o responsive. Le schermate della modale completa con dati veri non sono state prodotte.
5. **Metriche**: nessun dato reale in `artifacts/shadow_v1_live/` (la cartella non esiste in questo worktree); non è possibile dire nulla sulla numerosità o sulla significatività del campione raccolto finora.
6. **`vite build`** è verde ma non prova il funzionamento a runtime; `npm install` è stato eseguito senza lockfile, quindi le versioni installate possono differire da una build futura (è esattamente il problema CI-3).
7. **V2** è stato auditato solo per i punti di contatto (ingresso, barriera, costi, summary) e non come motore: non era l'oggetto della richiesta e non va modificato senza autorizzazione.
8. Il repository **non è stato modificato**: l'unica scrittura è il presente report e lo screenshot in `audit/`.

---

*Ricerca esplorativa. Sotto 30 occorrenze indipendenti il campione è insufficiente. Non indica un vantaggio operativo.*
