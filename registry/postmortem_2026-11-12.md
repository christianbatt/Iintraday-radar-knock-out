# Post-mortem del 2026-11-12

Generato da `bun scripts/ai_cycle.ts postmortem`. Ogni numero è ricalcolabile
con i comandi citati accanto; nessuna frase è sostenuta da altro che questi numeri.

## 1. Copertura

| voce | n | fonte |
|---|---|---|
| righe di valutazione | 15160 | `artifacts/replay_i3_30d/shift_0/setups.json` |
| setup costruiti (campi completi) | 5667 | `bun scripts/i3_barrier.ts --counterfactual` |
| emessi | 123 | idem |
| pass rate | 0.81% | calcolo |
| righe senza setup | 9493 | `bun scripts/ai_cycle.ts upstream` |

## 2. Esiti (camminata a risoluzione, shift 0, BE off)

| metrica | valore |
|---|---|
| n | 123 |
| meanR | -0.493 |
| sd | 1.035 |
| hit (>0) | 19.5% |
| meanWin / meanLoss | 1.600 / -1.000 |
| W/L | 1.60 |
| W/L richiesto | 4.13 |
| uscite | t1=24 stop=99 |
| campione | 13 giorni |

## 3. Per simbolo

| simbolo | n | meanR | hit |
|---|---|---|---|
| BAMI.MI | 52 | -0.150 | 32.7% |
| RHM.DE | 6 | -1.000 | 0.0% |
| SAP.DE | 65 | -0.720 | 10.8% |

## 4. Per giorno — 3 migliori e 3 peggiori

| giorno | n | meanR |
|---|---|---|
| 2026-10-05 (peggiore) | 27 | -1.000 |
| 2026-10-06 (peggiore) | 7 | -1.000 |
| 2026-10-07 (peggiore) | 22 | -1.000 |
| 2026-10-21 (migliore) | 5 | 1.600 |
| 2026-11-03 (migliore) | 2 | 1.600 |
| 2026-10-02 (migliore) | 3 | 1.600 |

## 5. Per gate bloccante

| gate | n | meanR | hit |
|---|---|---|---|
| G2 | 191 | -0.061 | 36.1% |
| G4 | 1837 | 0.858 | 71.2% |
| G7 | 380 | -0.918 | 3.2% |
| G8 | 2038 | -0.382 | 22.8% |
| G10 | 302 | -1.000 | 0.0% |
| G11 | 795 | -0.385 | 23.6% |
| G4 (fill disponibile) | 1837 | -0.129 | 49.5% |

## 6. Concentrazione

I 3 giorni peggiori contengono 56 setup su 123 (45.5%) e -56.000 di -60.601 R totali.

## 7. Griglia di payoff (k | hit | meanR)

| k | hit | meanR | CI95 | esclude 0 |
|---|---|---|---|---|
| 0.25 | 49.6% | -0.380 | [-0.492, -0.268] | si |
| 0.5 | 39.0% | -0.415 | [-0.546, -0.283] | si |
| 0.75 | 30.9% | -0.459 | [-0.604, -0.314] | si |
| 1 | 27.6% | -0.447 | [-0.607, -0.287] | si |
| 1.25 | 26.8% | -0.396 | [-0.575, -0.218] | si |
| 1.5 | 19.5% | -0.512 | [-0.690, -0.335] | si |
| 1.6 | 19.5% | -0.493 | [-0.677, -0.308] | si |
| 2 | 8.1% | -0.756 | [-0.903, -0.609] | si |
| 2.5 | 8.1% | -0.715 | [-0.887, -0.544] | si |
| 3 | 5.7% | -0.772 | [-0.938, -0.606] | si |

## 8. Cosa i dati NON dicono

1. **Il campione è di 13 giorni su 5 simboli.** Le barre in cache coprono 30 giorni
   di calendario ma solo 13 contengono setup emessi: nessuna conclusione su regimi
   diversi, e 13 cluster sono pochi per una CI.
2. **L'R è misurato su barre a 5 minuti.** Con stop mediano ~0.85% la distanza di
   stop è dello stesso ordine del rumore intra-barra: dentro la barra l'ordine
   stop/target non è risolvibile e vale l'ipotesi pessimistica (stop per primo).
3. **Il conterfactual su G4 non è un giudizio su G4.** Il fill assunto non era
   disponibile per costruzione: serve la variante con fill reale (vedi sezione 5).
4. **Le 9493 righe senza setup non sono attribuibili.** Gli artefatti non hanno un
   campo `reason`: manca ORB, prezzo, ATR, ADR, volume e conteggio barre.
5. **Il BE è un trigger fisso**, non `calculateDynamicBreakeven`: non è l'expectancy
   della strategia.

