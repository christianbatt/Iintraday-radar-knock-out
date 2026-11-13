# Post-mortem Passo T — 2026-11-13

Comandi: `bun scripts/ai_cycle.ts gates`, `rowsper`, `liquidity`, `exacttest`,
`alpha`, `tests`, `daysneeded`. Ogni cifra è incollata dal loro output.

## Sezione 1 — Il gate che ha respinto i 4 simboli

`gates` su `artifacts/replay_i3_30d_gates/shift_0/setups.json`: 27288 righe.
Matrice simbolo x gate (G1..G13, SESSION, REEMISSIONE, EMITTED):

| simbolo | G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 | G9 | G10 | G11 | G12 | G13 | SESSION | REEMISSIONE | EMITTED |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ENI.MI | 0 | 15 | 0 | 309 | 0 | 0 | 20 | 260 | 0 | 78 | 392 | 0 | 0 | 1958 | 0 | 0 |
| UCG.MI | 0 | 22 | 0 | 450 | 0 | 0 | 101 | 398 | 0 | 47 | 122 | 0 | 0 | 1892 | 0 | 0 |
| BAMI.MI | 0 | 106 | 0 | 237 | 0 | 0 | 29 | 479 | 0 | 135 | 138 | 0 | 0 | 1856 | 45 | 7 |
| RHM.DE | 0 | 19 | 0 | 584 | 0 | 0 | 117 | 329 | 0 | 8 | 3 | 0 | 0 | 1966 | 5 | 1 |
| SAP.DE | 0 | 29 | 0 | 257 | 0 | 0 | 113 | 573 | 0 | 34 | 140 | 0 | 0 | 1821 | 58 | 7 |
| BAYN.DE | 1454 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1578 | 0 | 0 |
| LDO.MI | 994 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2038 | 0 | 0 |
| SIE.DE | 1179 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1853 | 0 | 0 |
| STLAM.MI | 1144 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1888 | 0 | 0 |

- Gate dominante nei 4 aggiunti: **G1** con **4771** righe (39.34% di 12128).
- Gate dominante nei 5 originali: **G8** con **2039** righe.
- Nei 4 aggiunti la reason più frequente è SESSION (**7357/12128**, 60.66%),
  ma fra i gate effettivamente valutati G1 è il primo e l'unico.
- Nei 5 originali SESSION è **9493/15160** (62.62%); fra i gate G8 è il primo.
- G1 usa `liqEur20d`, che in `snapshot_9.json` è **stimato** dalle barre.
- `liquidity`: sui 5 noti il vero `liqEur20d` supera G1 **5/5**; lo stimato
  **0/5**. Delta medio **-99.3742%**. Sui 4 aggiunti lo stimato è sotto
  **3.000.000** per **4/4**: BAYN.DE 702578, LDO.MI 574953, SIE.DE 1475151,
  STLAM.MI 1701478.
- Conclusione: lo zero dei 4 aggiunti è **contaminato** dalla stima di
  `liqEur20d`. Non è un fatto sul mercato; è "non misurabile con lo snapshot
  attuale". La stima non viene corretta in questo passo.

## Sezione 2 — Il null corretto e il verdetto che cambia

- `exacttest`: 15 setup su 9 celle, atteso per cella **1.667**; celle con
  atteso < 5: **9/9**, quindi `approxValid=false`.
- Chi-quadro asintotico: **44.4000**, df **8**, p **4.780e-7**. Non ammissibile.
- Test esatto multinomiale P(al più 3 occupati): **5.819728e-6**.
- I tre null per i 4 aggiunti:
  - Poisson uniforme λ=12: **6.144e-6**
  - multinomiale uniforme (5/9)^15: **1.482e-4**
  - empirico 0.4^4: **0.0256**
- `alpha` con formula dichiarata 0.05/n, n=41: **0.0012195**.
- Sotto il null empirico 0.0256 > 0.0012195: **non significativo**.
- Verdetto: **nullo**, non negativo. Passo S aveva "0 setup = morti"; il
  valore corretto è "0 setup, non distinguibile dal null empirico".
