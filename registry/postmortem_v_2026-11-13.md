# Post-mortem Passo V — 2026-11-13

Comandi: `bun scripts/ai_cycle.ts adrfrac --replay=artifacts/replay_i3_30d_gates_daily`,
`gates`, `liquidity`, `exacttest`. Alpha congelato a 0.05/46 = 0.0010870.

## La decomposizione a due fattori e il cross-check

- `daily / 5m` su `liqEur20d` = **108.30**.
- `vero / daily` sui 5 noti = **1.4730**.
- Prodotto: **108.30 × 1.4730 = 159.5**.
- Valore misurato in Passo T: **159.8**.
- Rapporto: **0.998**.

La decomposizione regge aritmeticamente. Non dimostra pero' che il residuo
`vero/daily = 1.4730` sia un effetto del denominatore civile: la correzione
eseguita in Passo V non e' stata completata per la regola di stop sotto.

## G7 prima e dopo

Prima (replay `gates_daily`):

- G7 aggiunti: **3137/3137** bloccate, pass rate **0.00%**.
- G7 noti: **380/3639** bloccate, pass rate **89.56%**.
- Righe che raggiungono G7: **25.87%** negli aggiunti, **24.00%** nei noti.

Distribuzione di `adrConsumptionFraction` (`adrfrac`, soglia
`TRADING_PARAMS.ADR_MAX = 0.6`):

| simbolo | n | p5 | p25 | p50 | p75 | p95 | min | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ENI.MI | 750 | 0.1666 | 0.2120 | 0.2801 | 0.3331 | 0.5073 | 0.1666 | 0.7950 |
| UCG.MI | 668 | 0.2193 | 0.2891 | 0.3788 | 0.5134 | 0.7077 | 0.1844 | 0.7077 |
| BAMI.MI | 788 | 0.1968 | 0.2362 | 0.3674 | 0.5510 | 0.5904 | 0.1837 | 0.6954 |
| RHM.DE | 458 | 0.2748 | 0.3042 | 0.4269 | 0.6030 | 0.6777 | 0.2135 | 1.7450 |
| SAP.DE | 867 | 0.2224 | 0.2805 | 0.3592 | 0.4995 | 1.0434 | 0.1437 | 1.1460 |
| BAYN.DE | 991 | 2.6425 | 4.7956 | 6.0680 | 7.8296 | 18.2038 | 2.5446 | 18.2038 |
| LDO.MI | 616 | 2.8575 | 4.2442 | 4.9585 | 6.1352 | 14.2033 | 2.7314 | 17.9853 |
| SIE.DE | 862 | 2.1065 | 3.2332 | 4.3109 | 5.7806 | 9.3078 | 1.8125 | 9.4058 |
| STLAM.MI | 668 | 2.1432 | 2.9648 | 3.4648 | 3.9292 | 6.3581 | 1.6788 | 6.5010 |

- Mediana aggiunti: **4.8935**; mediana originali: **0.3339**;
  rapporto: **14.65**.
- Aggiunte sopra soglia: **3137/3137**; mediana frazione/soglia: **8.16**.
- AI-0049: **falsificata**. La mediane aggiunte non e' > 20 e il rapporto
  non e' > 20. Per la regola di stop, **AI-0050 e' not_evaluable** e la
  correzione a due fattori non e' stata eseguita.

Dopo: **non misurato**, per la regola di stop.

## Verdetto sullo zero

- Setup nei 4 aggiunti: **0** (invariato).
- G7 resta il gate che blocca la maggioranza delle righe che raggiungono la
  catena: **3137/3137**, pass rate **0.00%**.
- Lo zero **non e' spiegato da adr14** secondo il criterio del passo: il
  rapporto delle mediane e' **14.65**, sotto la soglia 20.
- Lo zero resta **non misurato** nella sua causa. Non e' "strutturale" e non
  e' "negativo": e' un esito con la correzione non eseguita.
- G8, G10, G11 nei 4 aggiunti restano a **0 righe raggiunte**: sono **non
  misurati**, non evidenza.

## Contaminazione

La contaminazione da `liqEur20d` 5m e' stata **rimossa in Passo U** (G1 passa
da 4771 bloccate a 0). La contaminazione da `adr14` 5m **non e' stata rimossa
in Passo V**: la correzione e' stata fermata dalla regola di stop. Non e'
corretto dire che la contaminazione non sia mai esistita: la stima 5m l'aveva
prodotta, come stabilito in Passo T.

## Ripresa dopo la regola di stop (override esplicito)

La regola di stop e' stata superata su richiesta esplicita. Comandi eseguiti:

`bun scripts/ai_cycle.ts adrdelta`,
`bun scripts/ai_cycle.ts snapshot9daily2`,
`REPLAY_SNAPSHOT=artifacts/snapshot_9_daily2.json bun scripts/delay_replay.ts ... --out=artifacts/replay_i3_30d_gates_daily2`,
`bun scripts/ai_cycle.ts gates --replay=artifacts/replay_i3_30d_gates_daily2`,
`bun scripts/ai_cycle.ts adrfrac --replay=artifacts/replay_i3_30d_gates_daily2 --snapshot=artifacts/snapshot_9_daily2.json`,
`bun scripts/ai_cycle.ts exacttest --replay=artifacts/replay_i3_30d_gates_daily2`,
`bun scripts/ai_cycle.ts bitid`.

### Diagnosi adr14

`adrdelta` sui 5 noti: `daily/5m` = 12.86, 12.01, 14.62, 13.93, 12.35;
`vero/daily` = 0.8776-1.1025; `20*daily/vero` = 18.14-22.79. La divergenza
`adr14`/`liqEur20d` sui 4 aggiunti e' 86.98-88.56%. AI-0047 e AI-0048:
**falsificate**. `adr14` non scala come `liqEur20d`: e' una media per barra,
non un aggregato giornaliero con lo stesso fattore 108.

### Correzione congiunta

`snapshot9daily2` porta `adr14` a 20 giorni di borsa: BAYN 0.102176 -> 1.378499,
LDO 0.118986 -> 1.562999, SIE 0.510327 -> 6.996247, STLAM 0.013998 -> 0.178750
(delta +1177%..+1271%). `liqEur20d` era gia' daily in Passo U: delta **0.00%**,
non +46.7% come atteso dal prompt. Il replay `daily2` produce **16 setup**
(contro 15 nel ramo a 5) e **4 simboli occupati** (BAMI 7, RHM 1, SAP 7, SIE 1).

### G7 dopo la correzione

| simbolo | raggiunte | bloccate G7 | pass | pass% | setup |
|---|---:|---:|---:|---:|---:|
| ENI.MI | 750 | 20 | 730 | 97.33 | 0 |
| UCG.MI | 668 | 101 | 567 | 84.88 | 0 |
| BAMI.MI | 788 | 29 | 759 | 96.32 | 7 |
| RHM.DE | 458 | 117 | 341 | 74.45 | 1 |
| SAP.DE | 867 | 113 | 754 | 86.97 | 7 |
| BAYN.DE | 991 | 242 | 749 | 75.58 | 0 |
| LDO.MI | 616 | 54 | 562 | 91.23 | 0 |
| SIE.DE | 862 | 66 | 796 | 92.34 | 1 |
| STLAM.MI | 668 | 0 | 668 | 100.00 | 0 |

- G7 aggiunti: **2775/3137 = 88.46%**; sola correzione di calendario:
  **0/3137 = 0.00%**. AI-0050: **confermata**.
- `adrConsumptionFraction` aggiunti: mediana **0.3636**, originali **0.3339**,
  rapporto **1.09**; sopra soglia **362/3137**; mediana frazione/soglia
  **1.13**. AI-0049: **falsificata** (anche dopo la correzione).
- Gate dominante aggiunti: **G8** con 2119 righe; G10 171, G11 484.
- Partizione: ogni simbolo chiude a 3032 righe (early + reached + session +
  reemissione).

### Zero e bit-identita'

- Setup nei 4 aggiunti: **1** (SIE.DE), non piu' 0. Lo zero e' **rotto**,
  quindi **non strutturale**; resta un campione piccolo (1 setup su 4 simboli),
  non un esito negativo.
- Ramo a 5: **15160 righe**, **15 setup**, hash
  `7fd90b4dfcedeeb761ba681d0d9ff7570f83a2756017a6ff1c07969c23495a0b`
  identico al replay pre-correzione. AI-0051: **confermata**.

### Test esatto

16 setup, 4 simboli occupati, celle attese 1.778; chi-quadro 40.2500 df 8
(p asintotico 2.878e-6) ma **9/9 celle con atteso <5**, quindi non valido.
P(al piu' 3 occupati) = **1.943729e-6**; null Poisson lambda=12 =
**6.144e-6**; null multinomiale (5/9)^16 = **8.235e-5** (il valore
precedente 1.482e-4 era hardcoded a 15 setup); null empirico 0.4^4 =
**0.0256**. Alpha 0.0010870. Verdetto del comando: **nullo** (null empirico
sopra alpha).
