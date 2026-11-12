# Registro AI — schema

`registry/ai_registry.jsonl` è **append-only** (JSON Lines, una riga per evento).
Nessuna riga passata viene modificata o cancellata: ogni correzione è una nuova riga.

## kind ammessi

| kind | quando |
|---|---|
| `hypothesis` | **prima** di vedere l'holdout. Pre-registrazione. |
| `result` | dopo la misura, con l'esito `accepted` / `rejected` / `inconclusive` / `insufficient_holdout` / `not_yet_evaluable`. |
| `activation` | solo via `ai_cycle.ts promote --id=AI-XXXX`, mai dal pulsante. |
| `rejection_note` | nota su un'ipotesi scartata, senza riaprirla. |

## Campi

### hypothesis
| campo | significato |
|---|---|
| `id` | `AI-NNNN`, progressivo, immutabile |
| `ts` | ISO 8601 UTC |
| `author` | `agent` oppure `human` |
| `assumption` | frase in italiano, **falsificabile** |
| `touches` | quali parti tocca (es. `selector.feature.stopPct`) |
| `evidence` | `dataset`, `n`, `period` su cui è formulata |
| `prediction` | `metric`, `direction`, `minDelta`, `nullModel`, `alpha`, `nTestsPrior`, `alphaEffective` |
| `split` | `train` e `holdout`, sempre **temporale** |
| `status` | `pre_registered` |

### result
`status`, `measured` (`meanR_train`, `meanR_holdout`, `delta`, `ci95`, `sumR_holdout`, `kSelected`, `nullMean`, `nullP95`, `pValue`), `reason`, `supersedes` (opzionale).

### status `insufficient_holdout`
Un rifiuto **formale** e un rifiuto **empirico** non sono la stessa informazione.
`insufficient_holdout` si usa quando l'holdout esiste ma è troppo piccolo perché il
confronto significhi qualcosa (soglia: meno di 30 campioni). In quel caso
`measured.beatsNull` vale **`null`**, mai `true` o `false`, e `measured.nullReason`
dice perché il confronto non è interpretabile.

### status `not_yet_evaluable`
Usato dal criterio di morte (AI-0005): il trigger non è soddisfatto, quindi non
esiste né un'accettazione né un rifiuto. Non è un fallimento: è l'assenza di giudizio.

### campo `supersedes`
Una `result` può sostituire **lo stato** di una precedente senza toccarla:
`supersedes: "AI-0003"` significa «questa riga corregge lo stato di AI-0003».
La riga originale resta nel file: il registro è append-only, la catena si legge
seguendo gli `supersedes`.

### activation
`configVersion`, `live`, `approvedBy`.

## Correzione per test multipli

`alphaEffective = 0.05 / (1 + nTestsPrior)`, dove `nTestsPrior` è il numero di
`hypothesis` già presenti nel registro **al momento della scrittura**.
Va scritto nella riga: non si ricalcola dopo.

## Regole

1. La prima riga del registro è l'ipotesi sul payoff, non sul selettore.
2. Nessun `result` senza `hypothesis` corrispondente.
3. Nessuna `activation` senza `result` con `status: accepted`.
4. Lo split è temporale; mai casuale.
5. Massimo 4 parametri liberi in `selector_config.json`.
6. `SETUP_SELECTOR_LIVE` resta `off`: il registro documenta, non accende.

## Righe VOID (Passo M)

Due righe `AI-0001 result` sono state prodotte dal bug di idempotenza di
`train` (append non guardato da `hasRow`) fino a Passo M: ogni esecuzione di
`train` ne aggiungeva una. Sono **VOID**: non contano in `nTrials`, non contano
in `alphaEffective`, non contano in nessuna statistica. Restano nel file per
append-only. Il bug è stato corretto in Passo M: `train` non appende se la riga
esiste già. `postmortem` è read-only rispetto al registro.

## Passo O — riconciliazione dei numeri di Passo N

- `replay perimeter`: OLD 15160 righe, NEW 27288 righe, stessi 30 giorni distinti
  (2026-10-01..2026-11-11). La crescita e' nei `(symbol,giorno)` (150 -> 270),
  non un'estensione della finestra.
- `reason` (valore vs assenza): 15145 righe portano un `reason`; 0 portano
  `missing_input` come valore; 12143 non hanno il campo. `15145 + 15 = 15160`.
  Il 44.4% e' l'assenza del campo, non un valore.
- `stop distribution`: min 0.649%, max 0.983%, media 0.831%, sd 0.108%,
  range 33.4 bp. Strutturale (guidata dalla formula), non campionaria.
- `days needed`: 4 dei 15 setup nella banda migliore [0.75,0.80) -> 112.5 setup
  necessari -> 60 giorni di calendario o 26 giorni con emissione. 260 non e'
  difendibile sotto nessuna delle due assunzioni.
- `nCells`: si distingue `preRegistered` (32 = 8 bande x 4 k) da `nonEmpty`
  (8). Bonferroni: 0.05/32 = 0.0015625 (corretto) vs 0.05/8 = 0.00625.
- `keptRow`: resta `first_decisionTs`. L'entry e' identica fra prima e ultima
  emissione (diff 0 bp); il gap di 0.533 R a k=1.0 e' un look-ahead della
  scelta dell'ultima emissione, non una proprieta' dell'entry.

## Passo N — unita', causa, etichette

- `repetitionCause`: ammette `intraday_reemission`. Il valore `replay` scritto
  negli artefatti di Passo M era **errato** (forzato in un enum che non aveva il
  valore giusto): i 15 gruppi hanno `giorni=1` e 13/15 hanno un `decisionTs`
  distinto per riga. Non si corregge in place: si dichiara errato qui.
- `alphaBonferroni`: con 0 celle ammissibili vale la stringa
  `"undefined (0 celle ammissibili)"`, non `null`. `null` significa "non
  calcolabile per input mancante"; `0.05/0` e' indefinito, non nullo.
- `keptRow`: nella deduplica, `"first_decisionTs"` — si tiene la riga con
  `decisionTs` minimo del gruppo `(symbol|entry|stop)`.
- `reason` (replay): una delle 7 cause `liquidita, struttura, leva, rischio,
  orario, barriera, vari`, dal primo gate fallito in ordine numerico, oppure
  `REEMISSIONE` per le righe declassate dalla guardia.
