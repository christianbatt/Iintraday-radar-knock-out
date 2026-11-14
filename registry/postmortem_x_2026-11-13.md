# Postmortem Passo X — causa del 0.68, incertezza di adr14, permutazione per simbolo

Data: 2026-11-13/14. Base: `origin/main` = `1ce0a62b268f549b81ffd30693e1e588ff5077f3`,
tree `862c9f3488fa304f697db2c7215c9f667184faac`. Branch `feat/live-v1-passo-x`.
Perimetro: 9 simboli, 27.288 righe, 3.032 righe/simbolo, 16 setup
(BAMI 7, SAP 7, RHM 1, SIE 1). Nessuna modifica a `src/`, `tradingParams.ts`,
`knowledge/`, G1-G13 o soglie.

## 0. Risultato in una riga

La causa del rapporto `liq daily/vero ≈ 0.68` e' la **copertura delle barre 5m**:
le barre ci sono (102/giorno) ma il loro volume aggregato e' una frazione del
volume giornaliero Yahoo dello stesso giorno (mediana 0,509-0,847). Non e' un
denominatore di calendario e non e' un disallineamento di finestra. La
correzione `snapshot9liqtd` era un **no-op** (entrambi i percorsi usano 20 barre
giornaliere), quindi AI-0054 e' `not_evaluable`, non `falsified`.

## 1. STEP 1 — `snapshot9liqtd` e' un no-op

- `snapshot9` e `snapshot9liqtd` usano lo stesso `dailyLiq` a **20 barre
  giornaliere**; il denominatore stampato e' 20 per simbolo in entrambi.
- `snapshot9liqtd` vs `snapshot_9_daily3.json`: delta **0.00%** sui 4 aggiunti
  (atteso +46,6% se il denominatore fosse 13-14).
- Conclusione: il comando riusa lo stesso percorso di codice. La correzione di
  calendario era gia' presente. AI-0054: `not_evaluable` con `rejection_note`
  (la riga originale resta nel registro; la correzione e' una riga appesa con
  `supersedes`).

## 2. STEP 2 — discriminazione a tre vie

Finestra comune: 2026-10-01..2026-11-11 (30 giorni per simbolo). Il replay
finisce 2026-11-11; `capturedAt` della fixture e' 2026-11-11T23:51:51Z. **Nessun
disallineamento**: tutti i 30 giorni sono comuni.

| simbolo | mediana 5m/Yahoo | min | max | quota in [0,60;0,75] | barre/giorno | giorni sotto 102 |
|---|---:|---:|---:|---:|---:|---:|
| ENI.MI | 0,7124 | 0,6224 | 1,0766 | 83,33% | 102,03 | 0 |
| UCG.MI | 0,6328 | 0,4811 | 1,0772 | 53,33% | 102,03 | 0 |
| BAMI.MI | 0,6075 | 0,5097 | 0,9508 | 46,67% | 101,97 | 2 |
| RHM.DE | 0,6492 | 0,4689 | 1,1636 | 73,33% | 102,00 | 1 |
| SAP.DE | 0,6550 | 0,4895 | 0,7336 | 70,00% | 102,00 | 1 |
| BAYN.DE | 0,5422 | 0,4183 | 0,7585 | 23,33% | 102,00 | 1 |
| LDO.MI | 0,6524 | 0,5035 | 0,7794 | 70,00% | 102,03 | 0 |
| SIE.DE | 0,5089 | 0,3652 | 0,9696 | 13,33% | 102,00 | 1 |
| STLAM.MI | 0,8468 | 0,6918 | 1,4839 | 3,33% | 102,03 | 0 |

Cause:

1. **Denominatore di calendario: escluso.** Entrambi i comandi usano 20 barre
   giornaliere; il rapporto non e' `13,635/20`. L'argomento
   `0,682 = 13,635/20` era tautologico e **non e' stato usato come prova**.
2. **Disallineamento di finestra: escluso.** La finestra del replay e la
   fixture finiscono lo stesso giorno; i giorni comuni sono tutti i 30. Il
   rapporto non dipende dallo scarto `capturedAt - fine finestra`.
3. **Copertura: confermata.** Il volume 5m aggregato e' 0,509-0,847 del volume
   Yahoo dello stesso giorno; le barre ci sono (101,97-102,03 vs 102 attese),
   quindi il volume manca **dentro** le barre, non per giorni o barre assenti.
   STLAM e' l'eccezione (0,847): il fattore non e' uniforme.

**AI-0057 — falsificata come formulata.** La mediana cade in [0,60;0,75] ma la
quota di giorni in quell'intervallo e' >=80% solo per ENI (83,33%); UCG 53,33%,
BAMI 46,67%, RHM 73,33%, SAP 70,00%. Inoltre le barre/giorno non sono
inferiori a 102. Il **meccanismo** (copertura) e' supportato; la predizione
numerica no. Da qui `falsified_as_stated`, non `confirmed`.

## 3. STEP 3 — localizzazione del deficit

- 102 slot effettivi/giorno; `09:00` e `17:30` sono placeholder a volume zero
  (29/30 giorni per `09:00`, 1/30 per `17:30`). Nessuna barra contigua mancante
  in testa o in coda.
- Profilo contro un null uniforme (volume Yahoo/102 per slot, 5 noti):
  rapporto complessivo 0,6845; `09:05` 1,4045; `17:25` 1,6076; media del
  tratto centrale 0,6612. Il minimo e' `12:25` (0,3219); i 10 slot peggiori
  sono 12:20-13:50.
- Sotto null uniforme, la fascia 12:20-13:50 assorbe **34,59%** del deficit
  totale; la testa 09:05-09:35 ha deficit **negativo** (-1,79%, cioe' volume in
  eccesso) e la coda 16:55-17:25 **-4,25%**. Il deficit non e' in testa o in
  coda.
- Il null uniforme non e' il vero profilo intraday (le 5m hanno forma a U):
  quindi la concentrazione a meta' giornata e' **condizionata al null**, non
  una misura del volume vero per barra.

**AI-0058 — falsificata come formulata.** La finestra di asta non e'
aggiungibile (i due slot di asta sono placeholder a zero) e le barre assenti
non sono contigue in testa/coda (non manca nessuna barra). La parte
"concentrazione identificabile" e' visibile solo sotto null uniforme e indica
la meta' giornata, non l'asta/la prima/l'ultima barra. La predizione
operativa fallisce.

## 4. STEP 4 — robustezza di G1 sotto incertezza di liq

`LIQ_MIN_EUR = 3.000.000`. Estremi richiesti:
`liq_true_low = liq_5m / 0,722`, `liq_true_high = liq_5m / 0,626`.

| simbolo | liq 5m | vero 1d | low | high | margine low | margine high | vero/5m |
|---|---:|---:|---:|---:|---:|---:|---:|
| BAYN.DE | 82.848.709 | 145.067.699 | 114.748.904 | 132.346.180 | 38,25x | 44,12x | 1,751 |
| LDO.MI | 60.355.565 | 94.330.497 | 83.594.966 | 96.414.641 | 27,86x | 32,14x | 1,563 |
| SIE.DE | 155.317.589 | 295.066.026 | 215.121.315 | 248.111.165 | 71,71x | 82,70x | 1,900 |
| STLAM.MI | 178.579.966 | 196.375.601 | 247.340.672 | 285.271.510 | 82,45x | 95,09x | 1,100 |

- **Pass robusto: 4/4** (sopra soglia per tutto l'intervallo). Pass fragile: 0.
  Mai sopra: 0.
- Il bias e' conservativo nel senso "vero > stima 5m" per tutti e 4
  (1,10-1,90x). Attenzione: per STLAM la copertura misurata (0,847) e' maggiore
  di 0,722, quindi `liq_5m/0,722` **non e' un vero lower bound** per quel
  simbolo (247,3M > vero 196,4M). Resta comunque 82x la soglia. La regola
  operativa corretta e' usare il **limite superiore di copertura per simbolo**,
  non il minimo di gruppo.
- Regola proposta: un simbolo entra solo se `liq_5m / coverage_high >
  LIQ_MIN_EUR`, con `coverage_high` misurato sulla finestra (non un fattore
  unico 0,722). Per il perimetro attuale tutti e 4 passano anche con questa
  regola.

## 5. STEP 5 — propagazione dell'incertezza di adr14

Tre replay sui soli 4 aggiunti; i 5 noti invariati. `adr14` scalato 0,86 /
1,00 / 1,14 sul valore di `snapshot_9_daily3.json`.

| scenario | setup totali | setup aggiunti | G7 pass aggiunti | righe >0,6 adrfrac |
|---|---:|---:|---:|---:|
| 0,86 | 16 | 1 (SIE) | 84,15% | 538/3137 |
| 1,00 (daily3) | 16 | 1 (SIE) | 89,79% | 362/3137 |
| 1,14 | 16 | 1 (SIE) | 95,25% | 153/3137 |
| vero 1d (14 sedute) | 16 | 1 (SIE) | 93,83% | 202/3137 |

- Setup per simbolo: BAMI 7, SAP 7, RHM 1, SIE 1 in tutti gli scenari. **SIE
  sopravvive in tutti e tre** (e nel vero).
- Variazione massima del pass rate G7 aggiunti: **11,10 pp** (84,15 -> 95,25),
  sopra i 5 pp. Le righe sopra 0,6 passano da 153 a 538 (3,5x).
- **AI-0059 — falsificata.** Il conteggio setup e' stabile, ma il pass rate G7
  non lo e': l'incertezza di `adr14` sposta il verdetto G7 di 11,1 pp e il
  numero di righe sopra soglia di 3,5x. La stabilita' vale per il conteggio
  setup, non per G7.

Nota di definizione: `snapshot_9_daily3.json` chiama `adr14` una media di range
su **20** sedute. Il server (`ADR_PERIOD`) usa **14** sedute. Il ramo "vero"
ricalcola 14 sedute per `adr14` e 20 per `liqEur20d`, come il server. Questo
spiega perche' il vero non coincide con 1,00: e' una base diversa, non solo
rumore.

## 6. STEP 6 — permutazione esatta a livello di simbolo

Unita': simbolo. Statistica: media **non pesata** degli aggiunti meno media non
pesata dei noti. 126 assegnazioni C(9,4).

| stadio | media aggiunti | media noti | diff pp | p unilat. | p bilat. | pooled agg. | pooled noti |
|---|---:|---:|---:|---:|---:|---:|---:|
| G7 pass | 89,79% | 87,99% | +1,80 | 0,3968 | 0,7937 | 88,46% | 89,24% |
| G8 | 78,27% | 68,28% | +9,99 | 0,2698 | 0,5159 | 76,36% | 64,71% |
| G10 | 5,77% | 8,72% | -2,95 | 0,2222 | 0,4603 | 6,16% | 9,58% |
| G11 | 15,93% | 22,57% | -6,64 | 0,3095 | 0,5952 | 17,44% | 25,23% |
| emissione | 0,03% | 0,43% | -0,40 | 0,1190 | 0,2063 | 0,04% | 0,48% |

- I primi quattro p bilaterali coincidono con i valori attesi
  (0,7937 / 0,5159 / 0,4603 / 0,5952). L'emissione **non coincide**:
  misurato 0,2063 (26/126) contro 0,0873 atteso (11/126). Definizione usata:
  `emitted / pass G7`, reemissioni escluse. Con `emitted / reached` il p
  bilaterale e' 0,2857; con "almeno un'emissione" 0,5238. Nessuna definizione
  prova a riprodurre 0,0873; il valore atteso resta non riconciliato.
- Il pooled differisce dalla media non pesata (es. G7 88,46% vs 89,79%): il
  pooled e' dominato dai simboli con piu' righe, la media non pesata no.
- **AI-0061 — confermata.** Nessuno stadio ha p bilaterale <= alpha
  (0,000892857). Il minimo e' 0,2063. Il test di uniformita' resta **ritirato**:
  questa permutazione lo sostituisce come test di eterogeneita' a livello di
  simbolo.

## 7. STEP 7 — confondente qualita' del dato / setup

Copertura = `liq_5m / liq_vero` (piu' bassa = piu' volume mancante).

- 5 noti: rho di Spearman con i setup = **-0,6325**; permutazione esatta 5! =
  120 (30 distinte per i pareggi 0,0 e 7,7): p unilaterale **0,1667**, p
  bilaterale **0,3333**. Il valore pre-registrato era -0,55 / 0,175
  (unilaterale): stesso segno, stessa assenza di significativita'.
- Copertura vs pass rate G7: rho **+0,30** (p bilaterale 0,6833); vs tasso G8:
  rho **-0,10** (p 0,9500). Nessuna associazione forte.
- 9 simboli con il vero per i 4 aggiunti: copertura = 0,721 / 0,708 / 0,631 /
  0,722 / 0,626 / 0,571 / 0,640 / 0,526 / 0,909; rho con i setup = **-0,3689**.
  Il segno negativo persiste.
- **AI-0060 — confermata sul segno, non sulla potenza.** Il falsifier (rho >=0
  o segno invertito) non si verifica. Con 5 simboli il test non ha potenza
  (p unilaterale 0,1667) e va rieseguito quando il perimetro cresce.

## 8. STEP 8 — fonte di liqEur20d: strada B

**Strada scelta: B.** La causa e' la copertura (STEP 2-3), la rete verso
`query1.finance.yahoo.com` e' raggiungibile (curl exit 0), quindi `liqEur20d` e
`adr14` dei 4 aggiunti sono stati rigenerati dalle barre **1d Yahoo** con la
stessa funzione del server (14 sedute per adr, 20 per liq). La circolarita'
"5m -> snapshot -> replay" e' rimossa: i valori veri non derivano dalle 5m.

Validazione sui 5 noti contro fixture:

| simbolo | adr 1d / fixture | liq 1d / fixture |
|---|---:|---:|
| ENI.MI | 1,0005 | 0,9979 |
| UCG.MI | 0,9733 | 1,0404 |
| BAMI.MI | 1,0177 | 1,0079 |
| RHM.DE | 1,0804 | 1,0283 |
| SAP.DE | 0,9102 | 0,9918 |

Le differenze ADR (fino a -9,0% / +8,0%) sono compatibili con fonte/finestra
diversa (Yahoo corrente vs fixture catturata), non con una formula diversa:
la formula e' `mean(high-low)` su 14 sedute. Il liq e' entro il 4,1%.

Effetto misurato del ramo B (replay `xtrue`):

- liq dei 4 aggiunti: BAYN 82,8M -> 145,1M; LDO 60,4M -> 94,3M;
  SIE 155,3M -> 295,1M; STLAM 178,6M -> 196,4M. Tutti sopra `LIQ_MIN_EUR`.
- setup: 16 totali, 1 aggiunto (SIE), invariati per simbolo.
- G7 pass aggiunti: 89,79% -> 93,83% (+4,04 pp). Gli estremi artificiali 0,86/1,14 danno 84,15%-95,25% (11,10 pp); il vero 1d resta dentro i 5 pp.
- righe >0,6 adrfrac: 362 -> 202.
- 5 noti: bit-identici (STEP 9).

## 9. STEP 9 — bit-identita' del ramo a 5

- righe: 15.160 (atteso 15.160)
- setup: 15 (atteso 15); distribuzione BAMI 7, SAP 7, RHM 1
- hash: `7fd90b4dfcedeeb761ba681d0d9ff7570f83a2756017a6ff1c07969c23495a0b`
- coincide: **si**, sia sul replay `xtrue` sia su `daily3`.

## 10. Cosa resta non misurabile

- Il volume vero **per barra 5m**: non esiste una fonte indipendente
  intraday; il profilo di STEP 3 e' condizionato al null uniforme.
- L'asta di chiusura: `17:30` e' un placeholder a volume zero; non si puo'
  aggiungere una finestra che non c'e'.
- La riconciliazione esatta ADR fixture vs Yahoo (fino a 9%): fonte/finestra
  diverse; non e' un test della formula.
- Il p di emissione della permutazione: 0,2063 misurato vs 0,0873 atteso; la
  definizione non e' riconciliata. Non cambia AI-0061 (nessun p <= alpha).
- La potenza del confondente: 5 simboli (e 9) sono pochi; il rho -0,37/-0,63
  non e' significativo.
- La generalizzazione oltre 30 giorni e oltre il perimetro a 9 simboli.
