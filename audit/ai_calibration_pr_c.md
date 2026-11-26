# PR-C — Calibrazione del desk AI (`ai-calibration@1`)

Documento di riferimento per `src/server/aiCalibration.ts`, la route
`GET /api/shadow/ai-calibration` e la sezione "Calibrazione AI (esplorativa)"
nel pannello Shadow AI. Completa, senza sostituirli, i report
`audit/REPORT.md` e `audit/ai_shadow_log_report_pass2.md`.

## Domanda a cui risponde

Il desk AI, quando decide, distingue i setup buoni dai cattivi? Il log AI
registra la decisione (`shadow_ai_log.jsonl`, `status: NON_VALIDATO`,
`outcome: null`); Shadow V1-live registra l'esito di prezzo dei setup emessi
(`artifacts/shadow_v1_live/signals.jsonl`). La calibrazione unisce le due fonti e
misura lo scarto di rendimento fra ciò che l'AI ha approvato e ciò che ha
scartato.

## Fonte dati

La calibrazione legge le **stesse voci del pannello Shadow AI**
(`readAiShadowLogWithFallback`): file locale `shadow_ai_log.jsonl` **più** i
documenti Firestore quando `SHADOW_AI_LOG_FIRESTORE=1`, deduplicati per doc id e
ordinati per istante. Il tetto è `AI_CALIBRATION_MAX_ENTRIES` (2000), non il
clamp HTTP di 200: l'aggregato ha bisogno di tutte le voci recenti.

Motivo: in produzione il disco può essere effimero. Senza fallback il file
locale sarebbe vuoto e la calibrazione riporterebbe zero valutazioni su dati che
esistono.

Il fallback si dichiara sulle **voci realmente usate**, non sul flag:
`counts.remoteEntries` conta i documenti presi da Firestore dopo la deduplica
(0 se il remoto non ha aggiunto nulla) e `sources.aiLog` diventa
`shadow_ai_log.jsonl + Firestore (fallback)` solo in quel caso, altrimenti resta
`shadow_ai_log.jsonl`. Un flag acceso con Firestore vuoto non produce nessuna
dicitura di fallback, né nella risposta né nel pannello.

Se Firestore non risponde, resta il file locale e la route non fallisce.

Il percorso Firestore è coperto da un test end-to-end senza credenziali
(`ai_calibration_firestore_path.test.ts`): sync su un adapter in memoria,
lettura con `readAiShadowLogFallbackDetailed` che usa la lettura Firestore
reale, verifica di `remoteEntries`, precedenza del file locale sui documenti
già presenti e conteggi della risposta di calibrazione.

Quando la lettura **tocca il tetto** la risposta lo dichiara: `truncated: true`
e `readLimit` (2000), con una riga in `limitations` che parla di campione
potenzialmente incompleto. Il pannello mostra la fonte usata
(`sources.aiLog`) e, quando il fallback è attivo, la dicitura "fallback
attivo"; in caso di troncamento aggiunge un avviso con il tetto raggiunto.
Tetto raggiunto esattamente conta come troncato: meglio un avviso in più che un
campione presentato come completo.

## Join

- **Unità**: la valutazione di un candidato, identificata da `runId:ticker`
  (`candidateKey`). La riga più recente per `candidateKey` vince: una riga di
  scansione non conta due volte lo stesso candidato.
- **Criterio**: stesso ticker e distanza temporale minima fra `timestamp` della
  valutazione e `decidedAtMs` dell'esito; un esito di un altro giorno sullo
  stesso titolo non è l'esito di questa decisione.
- **Uno-a-uno**: coppie ordinate per distanza crescente (spareggio: istante,
  ordine nel log, chiave dell'esito), assegnazione greedy con decisione ed esito
  consumabili una sola volta. Nessun esito viene attribuito a due decisioni e
  nessuna decisione consuma due esiti.
- **Solo valutazioni di candidato**: righe `source: 'scan'` o con
  `candidateKey`. Le direttive in prosa (`specialize`/`desk`) restano
  `SCONOSCIUTO`, non si abbinano e sono contate in `counts.directivesIgnored`:
  una frase come «non comprare contro il trend» non è un esito.

## Campo chiuso `decision`

Ogni riga del log AI shadow può portare `decision`, con tre soli valori:
`AZIONE`, `ATTESA`, `SCARTO`.

- è **scritto dall'handler** che riceve la risposta del modello: il prompt dei
  batch di scansione chiede `decision` per ogni candidato e il parser accetta
  solo quei tre valori (`isAiShadowDecision`); qualunque altra cosa diventa
  `null`;
- la calibrazione lo usa come **fonte di verità** (`classifyEntryDecision`), ma solo dopo aver escluso la prosa: una `decision` chiusa su una riga `specialize`/`desk` è un dato incoerente e resta `SCONOSCIUTO`;
- il pannello Shadow AI lo mostra accanto a ogni riga (`—` quando è `null`), così il valore scritto dall'handler è ispezionabile;
- la classificazione testuale dell'`aiOutcome` resta solo per le **righe
  storiche** prive del campo, e per la prosa (`specialize`/`desk`) il risultato è
  comunque `SCONOSCIUTO`;
- le direttive non hanno `decision`: sono prosa, non esiti.

## Finestra

`AI_CALIBRATION_MATCH_WINDOW_MS = 30 minuti`, fissa e inclusiva sul bordo
(`delta <= finestra`), decisa prima di guardare i dati e non adattiva. Fuori
finestra la valutazione è `unmatchedAiEntries`, mai zero.

## Soglia

`AI_CALIBRATION_MIN_SAMPLE = 30` casi **classificati** (`AZIONE` + `ATTESA` +
`SCARTO`, campo `counts.classified`). Le righe in `SCONOSCIUTO` sono abbinate ma
non sono un giudizio: non avvicinano il campione alla soglia. Sotto soglia il
verdetto è `insufficient`, `edgeR` resta calcolabile ma non è presentato come
risultato (nel pannello: "non un risultato"). Il pannello mostra `classificati: X /
min 30` come riga della soglia e, separatamente, `abbinamenti esclusi
(SCONOSCIUTO): N su M`: gli abbinati non vengono mai confrontati con la soglia.

## Allarmi di formato

Un degrado degli handler non deve finire silenziosamente nei non classificati.
La risposta porta `alerts[]`, vuoto quando non c'è nulla da segnalare:

| Codice | Quota | Soglia | Cosa indica |
|---|---|---|---|
| `UNKNOWN_SHARE_HIGH` | SCONOSCIUTO / abbinati | 30% | il campo `decision` non arriva più, o gli `aiOutcome` storici sono illeggibili |
| `DIRECTIVES_SHARE_HIGH` | righe prosa / righe dedup | 50% | il log è quasi tutto direttive: poche decisioni su cui misurare |

Ogni allarme porta `code`, `ratio`, `threshold`, `numerator`, `denominator` e un
`message` leggibile; il pannello li mostra con `⚠` in rosso. Sotto
`AI_CALIBRATION_ALERT_MIN_SAMPLE` (10) righe di denominatore non si allarma:
una percentuale su 2 righe sarebbe rumore.

## `edgeR`

```
edgeR = meanR(AZIONE) − meanR(SCARTO)
```

con `meanR` media aritmetica dell'R di prezzo sui soli casi abbinati del bucket.
`null` se manca uno dei due campioni. Positivo = il desk ha approvato setup
migliori di quelli che ha scartato; negativo = li ha approvati peggiori.
`ATTESA` e `SCONOSCIUTO` non entrano nel calcolo.

## Rendiconto dei conteggi

| Campo | Significato |
|---|---|
| `counts.aiEntries` | righe lette dal log |
| `counts.dedupedEntries` | righe dopo il dedup per `candidateKey` |
| `counts.directivesIgnored` | direttive in prosa, mai classificate |
| `counts.skippedAiEntries` | valutazioni senza ticker o timestamp valido |
| `counts.forwardPoints` | esiti forward terminali con `r` finito |
| `counts.matched` | abbinamenti uno-a-uno effettuati |
| `counts.classified` | abbinamenti con decisione utilizzabile: base della soglia |
| `counts.unmatchedAiEntries` | valutazioni di candidato rimaste senza esito |
| `counts.forwardWithoutDecision` | esiti che nessuna decisione ha rivendicato |

**Invariante**: `sum(buckets[].n) === counts.matched`. I bucket sono
`AZIONE`, `ATTESA`, `SCARTO`, `SCONOSCIUTO`; l'ultimo esiste proprio perché una
valutazione abbinata con esito illeggibile non sparisca dal rendiconto.

## Limiti

- Il join è per ticker e prossimità temporale: non dimostra causalità fra
  decisione AI ed esito.
- L'R di Shadow V1-live è di prezzo (senza costi né leva) e riguarda solo setup
  emessi con decisione `TRADE`: gli altri candidati restano non abbinati, tranne
i near-miss e gli altri scarti (esiti controfattuali, dichiarati in
`limitations`).
- `SCONOSCIUTO` non è un giudizio: se cresce, il problema è nel formato
  dell'`aiOutcome` o nelle direttive scritte in prosa, non nel desk.
- Il desk resta `NON_VALIDATO` finché il validatore deterministico non conferma:
  questa vista è esplorativa e non cambia gate, memoria AI o selezione dei setup.
- La calibrazione non ha ancora prodotto numeri reali: `shadow_ai_log.jsonl` era
  vuoto al momento della stesura, quindi `available: false` ed `edgeR: null`.

## Seconda fonte forward: i near-miss

Il tracker `src/server/shadowV1LiveNearMiss.ts` registra gia' i candidati bloccati
da **un solo** gate selezionabile (`ADX_BORDERLINE`, `G4_EXTENDED`,
`G5_EXPIRED`, `G7_ADR_HIGH`, `G8_STOP_WIDE`, `G11_SCORE`) e ne segue l'esito
reale sulle barre chiuse con lo stesso motore deterministico di V1-live. Sono
esattamente gli esiti che mancavano al bucket `SCARTO`: setup mai emessi, quindi
assenti da `signals.jsonl`.

La calibrazione li legge dallo stesso file gia' persistito
(`artifacts/shadow_v1_live/near_miss.jsonl`, via `loadNearMissRecords`) e li
converte con `mapNearMissForwardPoints`:

- solo `TARGET`/`STOP`/`EXPIRED` con `r` finito; `PENDING_FILL`, `OPEN` e
  `NOT_FILLED` non hanno esito e restano fuori (non sono zero);
- chiave `near_miss:<id>`, prefissata per non collidere con le chiavi dei
  segnali; in caso di chiave duplicata vince il segnale emesso;
- nessun nuovo file, nessuna nuova scansione, nessuna scrittura: si riusa il
  macchinario gia' esistente.

La risposta lo dichiara sui **fatti**, non sulla disponibilita' del file:
`counts.nearMissForwardPoints` sono i punti forniti, `counts.nearMissMatched`
quelli davvero usati in un abbinamento. `sources.forward` diventa
`artifacts/shadow_v1_live/signals.jsonl + near_miss.jsonl (controfattuale)` solo
se `nearMissMatched > 0`, e in quel caso una riga di `limitations` ricorda che
l'esito e' controfattuale (il setup non e' mai stato emesso) e che l'R e' di
prezzo, senza costi ne' leva. Il pannello mostra `esiti controfattuali
(near-miss): N su M` solo quando N > 0.

Se la lettura dei near-miss fallisce, la calibrazione resta quella dei segnali
(un `console.warn`, nessuna 500).

Limite che resta: i near-miss coprono solo i blocchi da singolo gate della
whitelist, con livelli validi e al massimo `SHADOW_V1_NEAR_MISS_MAX_RECORDS`
(400) record. Il registro degli altri scarti (sotto) ha lo stesso tetto, quindi
i due file possono contenere fino a 400 righe ciascuno. Gli altri scarti sono
coperti dal registro descritto sotto.

## Terza fonte forward: gli altri scarti

I near-miss coprono solo una parte dei candidati scartati. `src/server/shadowV1LiveRejected.ts`
registra in un file dedicato (`artifacts/shadow_v1_live/rejected.jsonl`, tetto
`SHADOW_V1_REJECTED_MAX_RECORDS` = 400) i candidati scartati che il near-miss
lascia fuori e ne segue l'esito con lo stesso motore deterministico
(`evaluateShadowV1Live`, barre 5m chiuse, zero look-ahead).

Chi entra nel registro, in ordine di esclusione:

- niente candidati `TRADE` (non sono scartati) e niente warmup incompleto
  (indicatori non affidabili);
- niente livelli entry/stop/target incoerenti: un setup non valutabile non ha
  un esito, e non viene inventato;
- niente doppioni con il near-miss: se `classifyNearMissCandidate` riconosce il
  candidato, il record resta di competenza del near-miss (il join e' uno-a-uno);
- tutto il resto con almeno un veto o un gate fallito: multi-gate, gate fuori
  whitelist, veti (`VETO:<nome>` in `blockedGates`).

I due registri condividono il nucleo `src/server/shadowV1LiveRecords.ts`:
stati del ciclo di vita, lettura/scrittura JSONL atomica, rivalutazione dei
record aperti sulle barre 5m chiuse (`evaluateShadowV1Live`, zero look-ahead),
merge monotono e validazione dei documenti Firestore. Cambiano solo file,
collezione, tetto e criteri di ingresso, non il motore di esito: una correzione
all'uno vale per entrambi.

Una riga per ticker e sessione (`US|AAPL|2026-11-25`): lo stesso titolo scartato
piu' volte nella giornata e' lo stesso candidato. Lo stato segue lo stesso ciclo
del near-miss (`PENDING_FILL` -> `OPEN` -> `TARGET`/`STOP`/`EXPIRED`, piu'
`NOT_FILLED`); gli stati non terminali restano fuori dagli esiti.

Persistenza a doppia tenuta come il near-miss: file locale piu' collezione
Firestore `_system/shadow_v1_live/rejected`, fusa all'avvio da
`hydrateAllShadowStateFromFirestore` (`report.v1RejectedMerged`). Un errore di
lettura o scrittura non blocca la scansione.

La calibrazione la legge come terza fonte (`readRejectedForward` nel cablaggio
di `server.ts`) e la dichiara sui fatti:
`counts.rejectedForwardPoints` (punti forniti), `counts.rejectedMatched`
(abbinamenti che li hanno usati). `sources.forward` aggiunge `rejected.jsonl`
solo se `rejectedMatched > 0`, e una riga di `limitations` ricorda che l'esito e'
controfattuale (il setup non e' mai stato emesso) e di prezzo. Il pannello mostra
`esiti controfattuali (altri scartati): N su M` solo quando N > 0, separato
dalla riga near-miss.

Limite: il registro non copre i candidati senza livelli coerenti (non hanno un
esito calcolabile) e, oltre il tetto di 400 record, tiene solo i piu' recenti.

## Come verificare

```bash
npx tsc --noEmit
npm run -s test:ai-calibration      # calibrazione + render del blocco
npm run -s test:shadowv1liverejected # registro controfattuale degli altri scarti
npm run -s test:ai-forward         # entrambe le suite sopra, in un comando
npm run -s test:ai-desk && npm run -s test:ai-shadow && npm run -s test:shadow-panel

# route read-only, con server avviato
curl -s http://127.0.0.1:3000/api/shadow/ai-calibration | head -c 400
```

Flag: `SHADOW_AI_CALIBRATION` (accesa di default, spenta con `0`/`false`; a flag
off la route risponde 404 senza leggere nulla).
