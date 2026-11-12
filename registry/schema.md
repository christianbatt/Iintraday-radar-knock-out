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
