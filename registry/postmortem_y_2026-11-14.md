# Postmortem Passo Y — tier, pavimento, bootstrap, 2x2, holdout

Data: 2026-11-14. Base: `origin/main` = `aa3fb2ec15488fcfee187062e2be71d5a2b9bf76`,
tree `e27acb95f9ab507cc0755acd8d3a1ef7d448a6d7`. Branch `feat/live-v1-passo-y`.
Perimetro: 9 simboli, 27.288 righe, 3.032/simbolo, 16 setup
(BAMI 7, SAP 7, RHM 1, SIE 1). Nessuna modifica a `src/`, `tradingParams.ts`,
`knowledge/`, G1-G13 o soglie.

## 0. Risultato in una riga

Il test di permutazione a 9 simboli non poteva rifiutare (p minimo 0,00794 >
alpha 0,000893): AI-0061 e' `not_evaluable`. Il bootstrap sui simboli sostituisce
il p come misura di incertezza. Il disegno 2x2 mostra che il guadagno G7 da
daily3 a xtrue e' **quasi tutto interazione** (+3,76 pp), non periodo (+2,16) o
fonte (+1,88): AI-0063 falsificata. Il primo holdout fuori campione **non
riproduce** i tassi: solo 3/9 simboli hanno |delta G7| < 10 pp; AI-0065
falsificata. L'asimmetria delle date di riferimento cambia G7 fino a 8,52 pp:
AI-0067 falsificata, limite permanente.

## 1. Stato di partenza e sostituzione del nome snapshot

Tutti i preconditions coincidevano tranne lo snapshot: `artifacts/snapshot_9_xtrue.json`
non esisteva. Il replay `xtrue` usa `artifacts/snapshot_9_dailyx.json` (md5
`1417b9576f2449766ef7768e27e50d1f`); su conferma esplicita, `dailyx` e' stato
trattato come `xtrue`. Nessun dato e' stato riscritto: e' lo stesso file usato
dal replay.

## 2. STEP 1 — Pavimento della permutazione

| n | C(n,4) | p minimo 1/C(n,4) | <= alpha 0,000892857? |
|---:|---:|---:|---|
| 9 | 126 | 0,007936508 | no |
| 10 | 210 | 0,004761905 | no |
| 11 | 330 | 0,003030303 | no |
| 12 | 495 | 0,002020202 | no |
| 13 | 715 | 0,001398601 | no |
| 14 | 1001 | 0,000999001 | no |
| 15 | 1365 | 0,000732601 | **si** |
| 16 | 1820 | 0,000549451 | si |
| 20 | 4845 | 0,000206398 | si |

Con 9 simboli il test non ha massa nella coda richiesta: AI-0061 e'
`not_evaluable` per costruzione. La riga `AI-0061-c` e' appesa con
`supersedes: "AI-0061"`; la riga originale resta. La permutazione a 9 simboli
**non** e' stata rieseguita come test di conferma.

## 3. Riforma dell'alpha e tier

- `tier` aggiunto alle nuove ipotesi: `confirmatory` | `exploratory`.
- Le 56 ipotesi pre-Y restano `confirmatory` per dichiarazione retroattiva; le
  righe del registro non sono state riscritte.
- `alphaEffective` si calcola solo sulle confirmatory: resta
  `0.05/56 = 0.000892857`.
- AI-0062 e' `confirmatory` ma **fuori denominatore** per congelamento
  dell'alpha; AI-0063..AI-0067 sono `exploratory` e non entrano nel denominatore.
- Le exploratory si riportano come stime con IC, non come test che rifiutano.

## 4. STEP 2 — Bootstrap sui simboli

10000 repliche, seed 42, gruppi 4 aggiunti + 5 noti, IC 95% percentile.

| Stadio | Diff pp | SD pp | IC95 basso | IC95 alto | Larghezza |
|---|---:|---:|---:|---:|---:|
| G7 pass | +5,83 | 4,13 | -1,42 | +14,49 | 15,91 |
| G8 | +10,69 | 13,26 | -16,72 | +35,07 | 51,79 |
| G10 | -3,07 | 3,53 | -9,72 | +4,05 | 13,76 |
| G11 | -7,22 | 10,53 | -27,58 | +13,23 | 40,81 |
| emissione | -0,40 | 0,19 | -0,77 | -0,03 | 0,74 |

**AI-0064 — confermata.** L'IC G8 contiene zero. Con 9 unita' l'IC e' largo
(51,79 pp) e ha esso stesso incertezza: e' una misura di indeterminazione, non
un test. L'emissione esclude zero, ma e' exploratory e la differenza e' 0,40 pp.

## 5. STEP 3 — Permutazione sullo stato finale (`xtrue`)

| Stadio | Media aggiunti | Media noti | Diff pp | p unilat. | p bilat. | Delta vs daily3 |
|---|---:|---:|---:|---:|---:|---:|
| G7 pass | 93,83% | 87,99% | +5,83 | 0,1508 | 0,3016 | +4,03 |
| G8 | 78,96% | 68,28% | +10,69 | 0,2619 | 0,5000 | +0,70 |
| G10 | 5,65% | 8,72% | -3,07 | 0,2143 | 0,4444 | -0,12 |
| G11 | 15,35% | 22,57% | -7,22 | 0,2937 | 0,5635 | -0,58 |
| emissione | 0,03% | 0,43% | -0,40 | 0,1190 | 0,2063 | 0,00 |

Su daily3 le differenze erano G7 +1,80 e G8 +9,99. Questi p **non sono
interpretabili come test** per il pavimento di STEP 1: descrivono solo la
posizione della differenza nella distribuzione delle 126 assegnazioni.

## 6. STEP 4 — Disegno 2x2 su adr14

Quattro replay sui soli 4 aggiunti; i 5 noti invariati.

| Cella | Fonte | Periodo | G7 pass aggiunti |
|---|---|---|---:|
| A | 5m | 20 sedute | 89,79% |
| B | 5m | 14 sedute | 90,07% |
| C | 1d | 20 sedute | 89,79% |
| D | 1d | 14 sedute | 93,83% |

- Effetto fonte = (C+D)/2 − (A+B)/2 = **+1,88 pp**.
- Effetto periodo = (B+D)/2 − (A+C)/2 = **+2,16 pp**.
- Interazione = (D−C) − (B−A) = **+3,76 pp**.
- Guadagno D−A = **+4,04 pp**.

**AI-0063 — falsificata.** Il periodo supera la fonte di solo **0,28 pp**, sotto
la soglia di 2 pp. Il guadagno e' quasi tutto interazione: cambiare
contemporaneamente fonte e periodo non e' la somma dei due effetti. L'unico
simbolo che si muove e' BAYN (G7 75,58 → 76,69 in B; 91,73 in D); LDO, SIE e
STLAM restano invariati.

## 7. STEP 5 — Incomparabilita' degli endpoint

| Simbolo | Giorni ratio >1,02 | Quota | Moda bin 0,05 | Min | Max |
|---|---:|---:|---:|---:|---:|
| ENI.MI | 1/30 | 3,33% | 0,70 (14) | 0,622 | 1,077 |
| UCG.MI | 1/30 | 3,33% | 0,55 (7) | 0,481 | 1,077 |
| BAMI.MI | 0/30 | 0,00% | 0,55 (9) | 0,510 | 0,951 |
| RHM.DE | 1/30 | 3,33% | 0,60 (9) | 0,469 | 1,164 |
| SAP.DE | 0/30 | 0,00% | 0,65 (12) | 0,489 | 0,734 |
| BAYN.DE | 0/30 | 0,00% | 0,50 (7) | 0,418 | 0,758 |
| LDO.MI | 0/30 | 0,00% | 0,65 (12) | 0,503 | 0,779 |
| SIE.DE | 0/30 | 0,00% | 0,50 (8) | 0,365 | 0,970 |
| STLAM.MI | 4/30 | 13,33% | 0,85 (9) | 0,692 | 1,484 |

Totale: **7/270 giorni** (2,59%) con ratio >1,02; **4/9 simboli** (ENI, UCG,
RHM, STLAM). La coda destra esiste, il segno varia, i minimi scendono a 0,365.
La moda **non** e' un valore fisso (0,50-0,85): non c'e' un unico fattore di
consolidamento. **AI-0062 — confermata.**

Regola scritta nello schema: **nessun campo daily si deriva da barre 5m**.
`adr14`, `liqEur20d`, `avgVolume20d`, `atr14`, `ema20` vengono da Yahoo 1d; le
5m servono solo per prezzi/ORB/VWAP/volume intraday.

## 8. STEP 6 — Primo holdout temporale

Finestra scelta: **2026-08-24..2026-09-30** (28 sedute), la massima disgiunta da
2026-10-01..2026-11-11 ottenibile con Yahoo 5m `range=60d`. Snapshot ricostruito
con la stessa procedura (Yahoo 1d, adr 14, liq 20); barre 5m filtrate sulla
finestra. Replay: **25.443 righe, 18 setup**.

| Simbolo | G7 main | G7 holdout | Δ G7 pp | G8 main | G8 holdout | Δ G8 pp |
|---|---:|---:|---:|---:|---:|---:|
| ENI.MI | 97,33 | 100,00 | +2,67 | 35,62 | 34,65 | -0,97 |
| UCG.MI | 84,88 | 83,37 | -1,51 | 70,19 | 32,40 | -37,79 |
| BAMI.MI | 96,32 | 80,68 | -15,64 | 63,11 | 38,27 | -24,84 |
| RHM.DE | 74,45 | 61,32 | -13,13 | 96,48 | 77,84 | -18,64 |
| SAP.DE | 86,97 | 98,05 | +11,08 | 75,99 | 70,22 | -5,77 |
| BAYN.DE | 75,58 | 87,96 | +12,38 | 84,25 | 69,69 | -14,56 |
| LDO.MI | 91,23 | 72,67 | -18,56 | 93,42 | 93,16 | -0,26 |
| SIE.DE | 92,34 | 95,65 | +3,31 | 45,60 | 21,30 | -24,30 |
| STLAM.MI | 100,00 | 88,07 | -11,93 | 89,82 | 82,76 | -7,06 |

- **Solo 3/9** simboli hanno |Δ G7| < 10 pp (ENI, UCG, SIE); 6/9 sono oltre.
- G8 scende in **8/9** simboli; i cali maggiori sono UCG -37,79, BAMI -24,84,
  SIE -24,30, RHM -18,64.
- **AI-0065 — falsificata.** La riproduzione fuori campione non c'e'. Questa e'
  la **prima misura fuori campione dell'intero programma**.
- Limite: 28 sedute invece di 30 per il cap Yahoo 5m; la conclusione non cambia
  (6/9 oltre 10 pp con 28 sedute).

## 9. STEP 7 — Soglia adrConsumptionFraction

Nessuna `reason` del replay `xtrue` contiene 0.6 / ADR / consumo: le 9 etichette
sono G/SESSION/REEMISSIONE/EMIT. La soglia **non e' un gate attivo**.

| Simbolo | n | p10 | p50 | p90 | Righe >0,6 |
|---|---:|---:|---:|---:|---:|
| ENI.MI | 750 | 0,1969 | 0,2801 | 0,5073 | 20 |
| UCG.MI | 668 | 0,2392 | 0,3788 | 0,6728 | 101 |
| BAMI.MI | 788 | 0,2099 | 0,3674 | 0,5904 | 29 |
| RHM.DE | 458 | 0,2908 | 0,4269 | 0,6777 | 117 |
| SAP.DE | 867 | 0,2258 | 0,3592 | 0,6072 | 113 |
| BAYN.DE | 991 | 0,2296 | 0,4187 | 0,5876 | 82 |
| LDO.MI | 616 | 0,2560 | 0,3776 | 0,5888 | 54 |
| SIE.DE | 862 | 0,1985 | 0,3012 | 0,5203 | 66 |
| STLAM.MI | 668 | 0,1561 | 0,2442 | 0,4052 | 0 |

Totale aggiunti: **202/3137 = 6,44% < 10%**. **AI-0066 — confermata.** La soglia
e' un diagnostico, non un criterio di qualita' o di selezione.

## 10. STEP 8 — Simmetria delle date di riferimento

Ri-tirati i 5 noti il 2026-11-14 con Yahoo 1d (14 sedute adr, 20 liq), stessi 4
aggiunti.

| Simbolo | Δ adr vs fixture | Δ liq vs fixture | G7 prima | G7 refetch | Δ G7 pp | Δ G8 pp |
|---|---:|---:|---:|---:|---:|---:|
| ENI.MI | +0,05% | -0,21% | 97,33 | 97,33 | 0,00 | 0,00 |
| UCG.MI | -2,67% | +4,04% | 84,88 | 84,88 | 0,00 | 0,00 |
| BAMI.MI | +1,77% | +0,79% | 96,32 | 96,32 | 0,00 | 0,00 |
| RHM.DE | +8,04% | +2,83% | 74,45 | 82,97 | **+8,52** | +0,36 |
| SAP.DE | -8,98% | -0,82% | 86,97 | 80,62 | **-6,35** | -1,88 |

**AI-0067 — falsificata.** La data di riferimento cambia G7 fino a 8,52 pp, molto
oltre i 2 pp. **Decisione:** si documenta l'asimmetria come **limite permanente**;
non si adotta in silenzio una data unica, perche' il refetch sposta RHM/SAP e non
esiste una fonte canonica che dica quale sia la data giusta. Per il futuro:
stessa data di pull per tutti e 9.

## 11. STEP 9 — Bit-identita' del ramo a 5

- Righe: **15.160** (atteso 15.160).
- Setup: **15** (BAMI 7, SAP 7, RHM 1).
- Hash: `7fd90b4dfcedeeb761ba681d0d9ff7570f83a2756017a6ff1c07969c23495a0b`.
- Coincide: **si**.

## 12. Cosa resta non misurabile

- La finestra di holdout e' di **28 sedute**, non 30: Yahoo 5m non espone piu' di
  60 giorni e la parte disgiunta finisce il 2026-09-30.
- L'holdout misura una sola finestra: non e' una serie di holdout indipendenti.
- Il bootstrap a 9 simboli ha IC larghi e incerti; non e' un test.
- L'asimmetria delle date resta: i 5 noti vengono dalla fixture 2026-11-11, i 4
  aggiunti da un pull 2026-11-14.
- La discrepanza 5m/1d e' di consolidamento, non un buco: non si puo' ricostruire
  il volume 1d dalle 5m ne' viceversa.
- Il p di emissione resta non riconciliato (0,2063 vs 0,0873 atteso).
- Il campione resta piccolo: 16 setup nella finestra principale, 18 nell'holdout.
