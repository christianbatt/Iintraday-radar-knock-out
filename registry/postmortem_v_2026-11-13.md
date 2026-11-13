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
