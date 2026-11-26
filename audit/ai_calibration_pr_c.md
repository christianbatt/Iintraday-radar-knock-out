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
esistono. Il campo `sources.aiLog` dichiara quale fonte ha risposto
(`shadow_ai_log.jsonl` oppure `shadow_ai_log.jsonl + Firestore (fallback)`).

Se Firestore non risponde, resta il file locale e la route non fallisce.

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
  emessi con decisione `TRADE`: i candidati mai emessi non hanno esito forward e
  restano non abbinati.
- `SCONOSCIUTO` non è un giudizio: se cresce, il problema è nel formato
  dell'`aiOutcome` o nelle direttive scritte in prosa, non nel desk.
- Il desk resta `NON_VALIDATO` finché il validatore deterministico non conferma:
  questa vista è esplorativa e non cambia gate, memoria AI o selezione dei setup.
- La calibrazione non ha ancora prodotto numeri reali: `shadow_ai_log.jsonl` era
  vuoto al momento della stesura, quindi `available: false` ed `edgeR: null`.

## Come verificare

```bash
npx tsc --noEmit
npm run -s test:ai-calibration      # calibrazione + render del blocco
npm run -s test:ai-desk && npm run -s test:ai-shadow && npm run -s test:shadow-panel

# route read-only, con server avviato
curl -s http://127.0.0.1:3000/api/shadow/ai-calibration | head -c 400
```

Flag: `SHADOW_AI_CALIBRATION` (accesa di default, spenta con `0`/`false`; a flag
off la route risponde 404 senza leggere nulla).
