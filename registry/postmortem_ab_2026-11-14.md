# Post-mortem Passo AB — 2026-11-14

Stime per simbolo, senza confronti fra gruppi. Intervalli di Wilson al 95%
(z = 1.959964). Definizioni: reached G7 = `emitted` oppure `reason` G7..G13
(REEMISSIONE esclusa); raggiunti G8 = `emitted` oppure `reason` G8..G13;
emissione = emessi / reached G7.

Nessuna riga di registro: i valori sono gia' noti dal replay, quindi non si
registrano ipotesi (regola di Passo AA: se il valore e' gia' noto, si riporta
come misura).

## Finestra principale (2026-10-01..2026-11-11, 30 sedute)

| simbolo | G7 pass | IC95 G7 | G8 blocco | IC95 G8 | emissione | IC95 emissione | reached G7 |
|---|---|---|---|---|---|---|---|
| ENI.MI | 97.33% | [95.92, 98.27] | 35.62% | [32.23, 39.16] | 0.00% | [0.00, 0.51] | 750 |
| UCG.MI | 84.88% | [81.96, 87.40] | 70.19% | [66.30, 73.81] | 0.00% | [0.00, 0.57] | 668 |
| BAMI.MI | 96.32% | [94.76, 97.43] | 63.11% | [59.62, 66.47] | 0.89% | [0.43, 1.82] | 788 |
| RHM.DE | 74.45% | [70.27, 78.23] | 96.48% | [93.95, 97.98] | 0.22% | [0.04, 1.23] | 458 |
| SAP.DE | 86.97% | [84.56, 89.05] | 75.99% | [72.82, 78.91] | 0.81% | [0.39, 1.66] | 867 |
| BAYN.DE | 91.73% | [89.84, 93.28] | 87.02% | [84.68, 89.05] | 0.00% | [0.00, 0.39] | 991 |
| LDO.MI | 91.23% | [88.74, 93.22] | 93.42% | [91.06, 95.19] | 0.00% | [0.00, 0.62] | 616 |
| SIE.DE | 92.34% | [90.37, 93.94] | 45.60% | [42.17, 49.08] | 0.12% | [0.02, 0.65] | 862 |
| STLAM.MI | 100.00% | [99.43, 100.00] | 89.82% | [87.29, 91.89] | 0.00% | [0.00, 0.57] | 668 |

## Holdout (2026-08-24..2026-09-30, 28 sedute)

| simbolo | G7 pass | IC95 G7 | G8 blocco | IC95 G8 | emissione | IC95 emissione | reached G7 |
|---|---|---|---|---|---|---|---|
| ENI.MI | 100.00% | [99.50, 100.00] | 34.65% | [31.35, 38.11] | 0.00% | [0.00, 0.50] | 759 |
| UCG.MI | 83.37% | [80.67, 85.77] | 32.40% | [29.00, 36.01] | 0.00% | [0.00, 0.47] | 818 |
| BAMI.MI | 80.68% | [77.73, 83.33] | 38.27% | [34.51, 42.18] | 1.71% | [1.00, 2.90] | 761 |
| RHM.DE | 61.32% | [57.28, 65.22] | 77.84% | [73.21, 81.87] | 0.52% | [0.18, 1.53] | 574 |
| SAP.DE | 98.05% | [96.86, 98.80] | 70.22% | [66.98, 73.28] | 0.00% | [0.00, 0.47] | 822 |
| BAYN.DE | 87.96% | [85.41, 90.11] | 69.69% | [66.05, 73.10] | 0.00% | [0.00, 0.52] | 739 |
| LDO.MI | 72.67% | [69.10, 75.97] | 93.16% | [90.51, 95.12] | 0.00% | [0.00, 0.59] | 644 |
| SIE.DE | 95.65% | [94.01, 96.86] | 21.30% | [18.55, 24.33] | 0.25% | [0.07, 0.90] | 805 |
| STLAM.MI | 88.07% | [85.69, 90.10] | 82.76% | [79.86, 85.33] | 0.00% | [0.00, 0.46] | 830 |

## Lettura

- Le stime G7 sono strette (denominatori 458-991): il tasso e' ben determinato
  per simbolo nella singola finestra.
- Le stime di emissione sono larghissime: 0-13 eventi per simbolo. Per la
  maggior parte dei simboli l'intervallo include lo zero o arriva a ~1-3%.
- Non si confrontano le due finestre: gli intervalli si riportano affiancati come
  descrizione. La differenza fra finestre appartiene al rumore gia' misurato e
  alla decisione di perimetro di Passo AA.
- Restano fuori: la scomposizione di G11 (score), il rumore su date diverse e la
  frizione reale.
