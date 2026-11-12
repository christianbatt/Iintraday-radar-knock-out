# Registro AI — schema

`registry/ai_registry.jsonl` è **append-only** (JSON Lines, una riga per evento).
Nessuna riga passata viene modificata o cancellata: ogni correzione è una nuova riga.

## kind ammessi

| kind | quando |
|---|---|
| `hypothesis` | **prima** di vedere l'holdout. Pre-registrazione. |
| `result` | dopo la misura, con l'esito `accepted` / `rejected` / `inconclusive`. |
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
`status`, `measured` (`meanR_train`, `meanR_holdout`, `delta`, `ci95`, `sumR_holdout`, `kSelected`, `nullMean`, `nullP95`, `pValue`), `reason`.

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
