# Post-mortem del 2026-11-13

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

## 8. Payoff al NETTO dei costi

`bun scripts/ai_cycle.ts payoff --net=0.05,0.10,0.15,0.20`. `f_i = frictionPct / stopPct_i`, `netWin = k - f_i`,
`netLoss = -(1 + f_i)`, `hit*_net = (1 + mean f) / (1 + k)`.

| f% | k | hit | hit*_net | gap pt | meanR lordo | meanR netto | CI95 netto |
|---|---|---|---|---|---|---|---|
| 0.1 | 0.25 | 49.6% | 89.5% | 39.94 | -0.380 | -0.499 | [-0.610, -0.388] |
| 0.1 | 0.5 | 39.0% | 74.6% | 35.59 | -0.415 | -0.534 | [-0.664, -0.404] |
| 0.1 | 0.75 | 30.9% | 64.0% | 33.06 | -0.459 | -0.578 | [-0.723, -0.434] |
| 0.1 | 1 | 27.6% | 56.0% | 28.31 | -0.447 | -0.566 | [-0.726, -0.407] |
| 0.1 | 1.25 | 26.8% | 49.7% | 22.91 | -0.396 | -0.515 | [-0.694, -0.337] |
| 0.1 | 1.5 | 19.5% | 44.8% | 25.25 | -0.512 | -0.631 | [-0.809, -0.454] |
| 0.1 | 1.6 | 19.5% | 43.0% | 23.53 | -0.493 | -0.612 | [-0.796, -0.427] |
| 0.1 | 2 | 8.1% | 37.3% | 29.17 | -0.756 | -0.875 | [-1.022, -0.729] |
| 0.1 | 2.5 | 8.1% | 32.0% | 23.85 | -0.715 | -0.835 | [-1.006, -0.664] |
| 0.1 | 3 | 5.7% | 28.0% | 22.29 | -0.772 | -0.891 | [-1.058, -0.725] |

f_i a 0.10%: media 0.119 R, mediana 0.119 R, p90 0.133 R.
corr(f_i, R realizzato) = 0.103.

_nota: sezione netto ripresa dall'ultimo run con `--net` (non ricalcolata in questo run)._

**Frizione dell'app implicita per trade: NON RICAVABILE.** `frictionEur` dipende da
`suggestedCertificates` e `totalInvestedEur` (calculator.ts:2405), che non esistono negli
artefatti del replay: vale la banda parametrica, non una misura di spread reale.

## 9. Superficie stopPct × k (al netto)

`bun scripts/ai_cycle.ts surface`. Decili di stopPct, k in {0.5, 1.0, 1.6, 2.0}, celle con n<10 ignorate.

| popolazione | n | celle n>=10 | celle con meanR_net>0 | massimo |
|---|---|---|---|---|
| EMESSI | 123 | 36 | 5 | k=1.6 d5 meanR_net=1.282 |
| BLOCCATI_G8 | 2038 | 40 | 4 | k=1.6 d4 meanR_net=0.091 |

bloccati G8: netto -0.456 (lordo -0.382) · emessi: netto -0.612 (lordo -0.493) · delta netto 0.155, delta lordo 0.111.

Le celle positive sono selezionate **ex post** su 36-40 celle e non hanno holdout:
con 4-5 celle su 40 e nessuna correzione per test multipli, il rumore basta a spiegarle.
Nessun selettore è addestrato su queste celle (vincolo del passo).

## 10. Popolazioni del ciclo

`bun scripts/ai_cycle.ts population`.

| pop | n | meanR lordo | meanR netto | hit | f mediano | giorni |
|---|---|---|---|---|---|---|
| A | 0 | n/a | n/a | 0.0% | n/a | 0 |
| B | 5543 | -0.031 | -0.132 | 36.8% | 0.084 | 30 |
| C | 123 | -0.493 | -0.612 | 19.5% | 0.119 | 13 |
| D | 5666 | -0.041 | -0.142 | 36.4% | 0.087 | 30 |

A = `excludedRecords` (scarti pre-gate): vivono in `localStorage` (`src/App.tsx:248`),
non su disco — **non misurabili offline**, ed è questa l'unica popolazione che il
ciclo esistente analizza. B = 5544 setup bloccati da G1-G13, C = emessi, D = candidati.

split temporale: 20/30 giorni di formazione, holdout dal 2026-10-29.
proposta formata sul train: rimozione di G4 (delta netto train 1.555).
holdout: pool netto 0.160 vs emessi 1.468 → NON regge; nullo p95 -0.280, p=0.0010 → batte il nullo.

**Il verdetto è formale, non empirico:** l'holdout contiene 2 soli trade emessi (train 121). Contro una baseline di 2 trade nessun confronto regge, in nessuna direzione.
Questo è il fatto più importante della sezione: **le emissioni si fermano dopo il 2026-10-28**
(121 dei 123 setup emessi sono prima della cesura), mentre i candidati bloccati continuano.
verdetto popolazione: **rejected**. Nessuna attivazione, nessuna scrittura di parametri.

## 11. Cosa i dati NON dicono

1. **La frizione è un'assunzione parametrica, non una misura di spread.** `SPREAD_EUR` 0.02 €
   e `BROKER_FEE_PER_SIDE_EUR` 1.00 € (tradingParams.ts:235-236) sono costanti, e la
   conversione in R dipende dal numero di certificati, che il replay non ha.
2. **13 giorni, 13 cluster.** Le barre coprono 30 giorni di calendario ma solo 13
   contengono setup emessi: nessuna conclusione su regimi diversi.
3. **Solo simboli europei.** La sessione USA non è misurata: nessun numero di questo
   file si trasferisce al mercato americano.
4. **L'R è misurato su barre a 5 minuti.** Con stop mediano ~0.85% la distanza di stop è
   dello stesso ordine del rumore intra-barra: vale l'ipotesi pessimistica (stop per primo).
5. **G4 non è giudicato.** Con fill onesto blocca trade a −0.129 R e 400 su 1837 sono
   irraggiungibili per costruzione: non seleziona, ma non è nemmeno dimostrato colpevole.
6. **Le 9493 righe senza setup restano non attribuibili.** Il campo `reason` non è stato
   introdotto in questo passo: gli artefatti non hanno ORB, prezzo, ATR, ADR, volume, barre.
7. **Il BE è un trigger fisso**, non `calculateDynamicBreakeven`: non è l'expectancy
   della strategia.
8. **La popolazione A non è misurata.** È quella su cui il ciclo esistente propone
   modifiche: senza di essa, il confronto con il percorso vecchio non è possibile.

