# Post-mortem Passo R — 2026-11-12

## Sezione 1 — Il test che condanna il baseline

- Tabella setup per simbodo (30 symbol-day ciascuno):
  BAMI.MI 7, SAP.DE 7, RHM.DE 1, ENI.MI 0, UCG.MI 0,
  BAYN.DE 0, LDO.MI 0, SIE.DE 0, STLAM.MI 0. Totale 15.
  Comando: `bun scripts/ai_cycle.ts persymbol`.
- Chi-quadro di bonta di adattamento su tasso uniforme:
  chi-quadro=44.4000, gdl=8, p=4.78e-7. Metodo: Pearson chi-square
  su conteggi per simbodo con attesi = 15 * (symbol-day_i / 270).
  Comando: come sopra.
- Tre null per P(0 setup nei 4 aggiunti):
  (i) Poisson uniforme 0.100/symbol-day: 6.14e-6.
  (ii) multinomiale uniforme su 9 simbodi: (5/9)^15 = 1.48e-4.
  (iii) eterogeneita empirica 0.4^4 = 2.56e-2.
  Comando: come sopra.
- Reductio: applicando il null (i) a ENI.MI e UCG.MI (baseline, 60
  symbol-day, attesi 6, osservati 0) si ottiene P(0)=2.48e-3. Il test
  di Q condanna 2 simbodi del baseline. Comando: come sopra.
- Null corretto: (iii), perche' il chi-quadro rifiuta l'uniformita
  (p=4.78e-7). I null (i) e (ii) sono falsi per costruzione.

## Sezione 2 — Cosa e' stato misurato e cosa no

- Simbodi con reason prima di STEP 2: 5 (ENI.MI, UCG.MI, BAMI.MI,
  RHM.DE, SAP.DE). Dopo: 5. Estensione non eseguita: snapshot ha 5
  quote, src/ intatto, nessun download. Comando: `bun scripts/ai_cycle.ts reason9`.
- Righe con reason=15145, missing_input=0, senza reason=12143.
  15145 + 12143 = 27288. Comando: come sopra.
- Setup nei 4 aggiunti dopo l'estensione: non misurabile (0, per
  assenza di misura, non per assenza di segnale). Limite superiore del
  tasso: 3/120 = 0.025 setup/symbol-day (regola del tre).
- Elasticita: non misurata. Leva: 173.3 gg a elasticita 0, 86.6 gg a
  elasticita 1, differenza 86.6 gg. Comando: `bun scripts/ai_cycle.ts daysneeded`.
- Giorni necessari con definizione unica
  setupTotali = setupPerCella / frazioneBanda (frazioneBanda=0.7157):
  setupTotali 41.9 (per 30) e 86.6 (per 62); giorni emitting 36.3 e 75.1;
  giorni calendario 83.8 e 173.3. Q riportava 41.9 -> 36.3/83.8 (corretto)
  e 62 -> 53.7/124.0 (errato: +21.4 emitting, +49.3 calendario, fattore 1.40).
  Comando: come sopra.
- Test: 36 file, 195 test (node runner). emissionGuard.test.ts contiene 8 test.
  Passo N riportava 191 (4 test in meno per passo: emissionGuard aveva 4 test
  in N, O ne ha aggiunti 4). Nessun test mancante.
  Comando: `bun scripts/ai_cycle.ts tests`.
- I4: non eseguita (fuori 09:00-16:00 CET).