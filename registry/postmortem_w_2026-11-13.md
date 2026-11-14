# Post-mortem Passo W — 2026-11-13

Comandi: `ai_cycle.ts adrdelta`, `snapshot9liqtd`, `counts`, `fisher`,
`bitid`, `gates`. Alpha congelato a 0.05/51 = 0.0009804.
Nessuna modifica a `src/`, soglie o logica G1–G13.

## 1. Provenienza dei valori di riferimento

- Fonte dei 5 noti: `src/utils/__tests__/fixtures/pipeline_snapshot.json`,
  catturato dal server live (`capturedAt` 2026-11-11T23:51:51Z).
- Il server calcola `adr14` e `liqEur20d` da barre **giornaliere** Yahoo
  (`query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=1mo`,
  `server.ts:1296`), con `calculateAdr14FromBars` / `calculateLiqEurFromBars`
  (`server.ts:1399`, `server.ts:1547`). Non sono una riaggregazione delle 5m.
- I 5 noti hanno quindi un vero indipendente. I 4 aggiunti **non hanno** un
  vero indipendente: `snapshot_9.json` deriva dalle barre 5m in cache. Ogni
  confronto dei loro daily con un "vero" inesistente e' circolare.
- AI-0053: **confermata per i 5 noti**; per i 4 aggiunti la validazione resta
  circolare. AI-0048 non e' circolare: usa i 5 noti, non gli aggiunti.

## 2. Legge di aggregazione (AI-0052)

| simbolo | adr daily/5m | sqrt(liq daily/5m) | rapporto |
|---|---:|---:|---:|
| BAYN.DE | 13.49 | 10.859 | 1.242 |
| LDO.MI | 13.14 | 10.245 | 1.283 |
| SIE.DE | 13.71 | 10.261 | 1.336 |
| STLAM.MI | 12.77 | 10.245 | 1.247 |

Media **1.277**, CV **3.4%**. I volumi si aggregano linearmente (rapporto
~105–118), i range in radice (rapporto ~13). L'eccesso 1.277 e' la correzione
di forma, non un errore di denominatore. AI-0052: **confermata**.

## 3. Denominatore di liqEur20d (AI-0054)

`snapshot9liqtd` ricalcola `liqEur20d` sui 4 aggiunti come media di
`close x volume` sulle ultime 20 barre giornaliere disponibili, non su 20
giorni civili. Scrive `artifacts/snapshot_9_daily3.json` (untracked) e non
tocca i 5 noti.

| simbolo | liq daily2 | liq daily3 | delta | volte LIQ_MIN_EUR |
|---|---:|---:|---:|---:|
| BAYN.DE | 82.848.709 | 82.848.709 | 0.0000% | 27.62x |
| LDO.MI | 60.355.565 | 60.355.565 | 0.0000% | 20.12x |
| SIE.DE | 155.317.589 | 155.317.589 | 0.0000% | 51.77x |
| STLAM.MI | 178.579.966 | 178.579.966 | 0.0000% | 59.53x |

Il delta rispetto a daily2 e' **0.00%**, non +46.6%: la correzione di
calendario era gia' stata applicata in Passo U. Tutti e 4 restano sopra
`LIQ_MIN_EUR = 3.000.000` con margine 20x–60x.

La stessa funzione sui 5 noti da' `daily/vero`:

| ENI | UCG | BAMI | RHM | SAP |
|---:|---:|---:|---:|---:|
| 0.7211 | 0.7083 | 0.6312 | 0.7221 | 0.6261 |

Tutti fuori da [0.90, 1.10]. **La funzione e' ancora sbagliata**: le barre 5m
in cache sottostimano il volume giornaliero del 28–37%. Il denominatore
"giorni di borsa" non spiega il residuo. AI-0054: **falsificata**.

## 4. Definizione unica dei conteggi (AI-0055/AI-0056)

Definizione scelta: **raggiunte G7 = `emitted` oppure `reason` G7..G13;
REEMISSIONE esclusa**. Motivo: una re-emissione e' un declassamento della
guardia, non un passaggio di G7; includerla gonfia il pass rate dei noti da
3151/3531 a 3259/3639 e crea la differenza 108.

| simbolo | tot | earlyG1G6 | G7bloc | G8 | G10 | G11 | REEM | EMIT | SESS | somma |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ENI.MI | 3032 | 324 | 20 | 260 | 78 | 392 | 0 | 0 | 1958 | 3032 |
| UCG.MI | 3032 | 472 | 101 | 398 | 47 | 122 | 0 | 0 | 1892 | 3032 |
| BAMI.MI | 3032 | 343 | 29 | 479 | 135 | 138 | 45 | 7 | 1856 | 3032 |
| RHM.DE | 3032 | 603 | 117 | 329 | 8 | 3 | 5 | 1 | 1966 | 3032 |
| SAP.DE | 3032 | 286 | 113 | 573 | 34 | 140 | 58 | 7 | 1821 | 3032 |
| BAYN.DE | 3032 | 463 | 242 | 631 | 20 | 98 | 0 | 0 | 1578 | 3032 |
| LDO.MI | 3032 | 378 | 54 | 525 | 21 | 16 | 0 | 0 | 2038 | 3032 |
| SIE.DE | 3032 | 317 | 66 | 363 | 116 | 316 | 0 | 1 | 1853 | 3032 |
| STLAM.MI | 3032 | 476 | 0 | 600 | 14 | 54 | 0 | 0 | 1888 | 3032 |

La somma dei terminali **senza SESSION** non chiude (es. ENI 1074/3032):
la lista del prompt omette SESSION, che e' un terminale. Con SESSION la
partizione chiude a 3032 per tutti e 9.

## 5. Due campioni, stadio per stadio

Definizione scelta (re-emissioni escluse):

| stadio | aggiunti | noti | diff pp |
|---|---:|---:|---:|
| G7 pass | 2775/3137 = 88.46% | 3151/3531 = 89.24% | −0.78 |
| G8 blocco | 2119/2775 = 76.36% | 2039/3151 = 64.71% | +11.65 |
| G10 blocco | 171/2775 = 6.16% | 302/3151 = 9.58% | −3.42 |
| G11 blocco | 484/2775 = 17.44% | 795/3151 = 25.23% | −7.79 |
| emissione | 1/2775 = 0.04% | 15/3151 = 0.48% | −0.44 |

Con la definizione che include le re-emissioni, i noti sono 3259/3639 =
89.56% su G7 e 2039/3259 = 62.58% su G8: il divario G8 scende a +13.78 pp.
La definizione scelta e' quella senza re-emissioni.

## 6. Fisher a livello di simbolo (AI-0055)

Simboli con almeno un setup: noti **3/5** (BAMI, RHM, SAP), aggiunti **1/4**
(SIE).

- Fisher unilaterale (noti > aggiunti): **p = 0.357143**.
- Fisher bilaterale: **p = 0.523810**.
- P(al più 1 simbolo con setup su 4) sotto null empirico 0.4: **0.4752**.

Nessuna evidenza di differenza. AI-0055: **confermata**. Lo zero assoluto e'
rotto (1 setup), ma l'equivalenza fra i due gruppi non e' dimostrata con 4
simboli.

## 7. G8 per simbolo (AI-0056)

| simbolo | G8 / pass G7 | tasso |
|---|---:|---:|
| ENI.MI | 260/730 | 35.62% |
| UCG.MI | 398/567 | 70.19% |
| BAMI.MI | 479/759 | 63.11% |
| RHM.DE | 329/341 | 96.48% |
| SAP.DE | 573/754 | 75.99% |
| BAYN.DE | 631/749 | 84.25% |
| LDO.MI | 525/562 | 93.42% |
| SIE.DE | 363/796 | 45.60% |
| STLAM.MI | 600/668 | 89.82% |

Intervallo noti: **[35.62%, 96.48%]**. Tutti e 4 gli aggiunti sono dentro.
Il divario di gruppo +11.65 pp e' minore della variabilita' interna (range
noti 60.86 pp, range aggiunti 47.82 pp). AI-0056: **confermata**.

## 8. Ritiro del test di uniformita'

Il test `exacttest` e' **ritirato** e non e' stato rieseguito:

1. il null di uniformita' fra 9 celle non e' plausibile: 2 dei 5 noti
   producono zero setup e la distribuzione e' {0, 0, 1, 7, 7};
2. il null multinomiale (5/9)^n testa lo stato pre-correzione, non il
   campione corrente;
3. il chi-quadro non e' ammissibile: 9/9 celle con atteso 1.778 < 5;
4. P(al più 3 occupati) e' una coda, non il p del risultato osservato (4
   simboli occupati).

Sostituzione: confronto a due campioni stadio per stadio (sezione 5) e Fisher
a livello di simbolo (sezione 6). Il verdetto sullo zero non dipende piu' dal
test ritirato.

## 9. Cosa resta non misurabile

- Il vero `liqEur20d` dei 4 aggiunti non esiste: la fonte indipendente copre
  solo i 5 noti. La loro liquidita' daily3 e' una stima da 5m, non un vero.
- Il residuo 0.63–0.72 di `daily/vero` sui noti non e' spiegato dal
  denominatore di calendario: manca una fonte di volume giornaliero per i 4
  aggiunti.
- Con 4 simboli, il Fisher non puo' dimostrare equivalenza; puo' solo non
  rifiutare l'indistinguibilita'.
- Il divario G8 e' compatibile con la varianza fra simboli, ma il campione
  (1 setup aggiunto) non permette una stima stabile del tasso di gruppo.
