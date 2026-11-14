# Criterio di decisione per `SETUP_SELECTOR_LIVE` — Passo AA

Questo documento fissa le condizioni numeriche e verificabili che giustificherebbero
il passaggio di `SETUP_SELECTOR_LIVE` da `off` a `on`. **Non modifica
`src/config/liveSelector.ts`**: il criterio e' un documento, non un cambio di
configurazione.

Tutte le misure sono sulla finestra principale `replay_i3_30d_gates_xtrue`
(9 simboli, 27288 righe, 30 sedute, 2026-10-01..2026-11-11), salvo dove indicato.

## Condizioni

| # | condizione | valore richiesto | valore misurato | soddisfatta |
|---|---|---|---|---|
| C1 | setup per settimana | >= 10.0 | 3.73 | NO |
| C2 | simboli con almeno un setup | >= 5 su 9 | 4 su 9 (SAP, BAMI, SIE, RHM) | NO |
| C3 | stabilita' output fra finestre: rapporto setup/settimana holdout / principale | in [0.8, 1.3] | 4.50 / 3.73 = 1.205 | SI |
| C4 | riproducibilita' del tasso: max \|delta G7\| su barre 1d identiche | <= 3.0 pp | 0.00 pp | SI |
| C5 | gate inerti (bloccano zero righe su tutti i 9 simboli) | <= 3 su 13 | 7 su 13 | NO |

## Dettaglio

- **C1** — 16 setup in 30 sedute = 16 / (30/7) = 3.73 setup/settimana. Sotto la
  soglia di 10. Servono ~43 setup nella finestra (2.7x l'attuale).
- **C2** — Solo 4 simboli su 9 emettono almeno un setup; 5 (ENI, UCG, BAYN, LDO,
  STLAM) sono a zero. Serve almeno un quinto simbolo.
- **C3** — Holdout 18 setup in 28 sedute = 4.50/settimana; principale 3.73/settimana;
  rapporto 1.205, dentro [0.8, 1.3].
- **C4** — Due pull nella stessa sessione con barre 1d identiche (stesse date,
  stessi valori) producono un replay bit-identico: delta G7 massimo 0.00 pp. Il
  valore 8.52 pp di Passo Y era un limite superiore contaminato dal rinnovo della
  finestra (3 sedute di calendario), non il rumore vero.
- **C5** — Gate inerti: G1, G3, G5, G6, G9, G12, G13. Attivi: G2, G4, G7, G8, G10,
  G11. Sette gate su tredici non filtrano nulla; la catena effettiva e' di sei gate.

## Esito

**Condizioni soddisfatte: 2 su 5 (C3, C4). Condizioni non soddisfatte: 3 su 5
(C1, C2, C5).**

Il criterio non e' soddisfatto: `SETUP_SELECTOR_LIVE` resta `off`. La condizione
piu' vicina e' **C2**: manca un solo simbolo con almeno un setup (4/9 contro 5/9).
Raggiungerla richiederebbe che uno tra ENI, UCG, BAYN, LDO, STLAM superi i gate
attivi almeno una volta nella finestra; non e' una leva di configurazione, e' un
fatto di perimetro/mercato.

La condizione piu' lontana e' C1: servono ~2.7x i setup attuali, cioe' un
perimetro o una finestra molto piu' grandi, non un aggiustamento di soglia.

## Regola

Nessuna condizione puo' essere rilassata dopo aver visto i dati: i valori
richiesti sono fissati qui, prima della misura, e restano questi. Ogni futura
richiesta di accensione deve citare questa tabella e mostrare i cinque valori
misurati nello stesso formato.
EOF
