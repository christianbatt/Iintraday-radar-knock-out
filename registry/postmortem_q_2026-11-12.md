# Post-mortem Passo Q — 2026-11-12

## Sezione 1 — Il perimetro era simbodi

- Perimetro: OLD 5 simbodi x 30 giorni = 150 symbol-day = 15160 righe;
  NEW 9 simbodi x 30 giorni = 270 symbol-day = 27288 righe.
  Comando: `bun scripts/ai_cycle.ts perimeter`.
- 4 simbodi aggiunti: BAYN.DE, LDO.MI, SIE.DE, STLAM.MI. Ciascuno 3032 righe.
  Delta 12128 = 4 x 30 x 101.07. Comando: come sopra.
- Passo O e la lettura precedente avevano attribuito la crescita ai giorni
  (15 -> 27). Il valore corretto e': giorni costanti (30 e 30), simbodi
  da 5 a 9. Dichiarazione esplicita di errore.
- Cache: 3059 barre/simbodo, 30 giorni distinti, 0 date mancanti.
  Prima barra di sessione scartata (102 vs 101.07). Comando: `python3 scratchpad/q_step1b.py`.
- I 15 setup sono bit-identici in entrambi gli universi (Passo N).

## Sezione 2 — L'unico esperimento sulla leva

- 15 setup: 7 BAMI.MI, 7 SAP.DE, 1 RHM.DE, 0 nei 4 simbodi aggiunti.
  Comando: `bun scripts/ai_cycle.ts symbols`.
- Attesi nei 4 aggiunti a 0.100/symbol-day: 12. Osservati: 0.
  Poisson P(0) con lambda=12: 6.14e-6. Comando: come sopra.
- I 4 simbodi sono non misurati: 0 candidati, 0 reason, snapshot con 5 simbodi.
  Non sono morti (hanno barre), non sono non produttivi (nessuna valutazione).
- Concentrazione: attesa 0.7157, osservata 0.800, z=0.724. Non anomala.
  Comando: `bun scripts/ai_cycle.ts daysneeded`.
- Griglia: AI-0016 pre-registra 8 bande x 4 k = 32 celle (bande, non decili).
  P STEP 4(d) era errato: il decile non e' la griglia pre-registrata.
- Giorni: 41.9 setup -> 36.3 emitting / 83.8 calendario;
  62 setup -> 53.7 / 124.0. Vincolo che morde: potenza (62). Comando: come sopra.
- Leva: elasticita' osservata 0/4 = 0. Scenari: elasticita' 0 -> 124 gg,
  elasticita' 1 -> 69 gg. Non confermata. Rischio: altri simbodi possono avere
  distribuzione stop diversa e uscire dalla finestra di 25 bp.