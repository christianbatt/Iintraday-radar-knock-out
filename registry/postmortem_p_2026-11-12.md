# Post-mortem Passo P — 2026-11-12

## Sezione 1 — Su quale universo

- Perimetro: OLD 15160 righe, NEW 27288 righe, stessi 30 giorni distinti
  (2026-10-01..2026-11-11). La crescita e' nei (symbol,giorno): 150 -> 270.
  Comando: `python3 scratchpad/old_universe.py` / `step1.py`.
- reason sul nuovo: 15145 righe con reason (55.5%), 0 con `missing_input`, 12143
  senza campo (44.5%). `15145 + 15 = 15160`. Comando: `python3 scratchpad/step1.py`.
- 12128 == (270-150) x (27288/270) = 120 x 101.07. Il 44.44% e' il delta di
  copertura (4 simboli x 30 giorni), non un valore del campo. Comando: come sopra.
- Distribuzione cause sui 30 giorni (comando step1.py): Nessun titolo 9493
  (34.8%), barriera 2039 (7.5%), leva 1837 (6.7%), G11 795 (2.9%), G7 380
  (1.4%), G10 302 (1.1%), G2 191 (0.7%), REEMISSIONE 108 (0.4%), None 12143
  (44.5%).
- Primi 15 giorni del nuovo: 13509 righe; None 6016 (44.5%), barriera 787
  (5.8%), leva 811 (6.0%). Passo N before: barriera 5.7%, leva 7.2%. Non
  riproduce esattamente. Comando: `python3 scratchpad/step1b.py`.
- Cache: 9 simboli x 30 giorni distinti (3059-3061 barre/simbodo). Replay nuovo:
  30 giorni. Date mancanti: nessuna. Comando: `python3 scratchpad/step2.py`.
- Stop: 15 valori in bp: 64.9, 69.5, 73.2, 75.1, 75.5, 75.9, 78.6, 84.1,
  86.0, 88.7, 89.7, 91.1, 98.0, 98.0, 98.3. min 0.649, max 0.983, media
  0.831, sd 0.108, range 33.4 bp. Bande: [0.5,0.75)=3, [0.75,1.0)=12, altre 0.
  Attesa nella banda migliore sotto normalita': 0.716; osservata: 0.800.
  Celle strutturalmente irraggiungibili: 24 su 32. Comando: `python3 scratchpad/step3.py` / `step3b.py`.

## Sezione 2 — Quanto manca davvero

- Tre letture dei giorni per 30 setup in una cella:
  (i) aggregata: 30 setup -> 26.0 giorni con emissione / 60 giorni di calendario;
  (ii) banda (12/15): 37.5 setup -> 32.5 / 75;
  (iii) decile (4/15): 112.5 setup -> 97.5 / 225.
  Comando: `python3 scratchpad/step4` (calcolo manuale verificato).
- Il criterio scritto richiede il decile: la cella pre-registrata e' il decile.
  Passo O aveva riportato 112.5 setup con 60/26 giorni: incoerenza dichiarata.
- Potenza: a alpha Bonferroni-32 (0.0015625) servono 62 setup per l'80% di
  potenza (vs 26 ad alpha 0.05). Fattore vs soglia 30 = 2.07. Giorni per 62
  setup con concentrazione banda: 1116 symbol-day. Comando: `python3 scratchpad/step5.py`.
- Leva simboli: 15/(9x30) = 0.0556 setup per symbol-day. Scenario 10 simbodi:
  111.6 giorni; 40: 27.9; 100: 11.2. Rischio: la distribuzione degli stop
  potrebbe cambiare con altri simbodo e la concentrazione 12/15 potrebbe non
  reggere. Comando: `python3 scratchpad/step6.py`.
- Flag: SETUP_SELECTOR_LIVE = off, STALENESS_USE_MARKET_TS = off. i3_barrier
  intatto: -43.953 / -57.432 / -60.546, exit 0.