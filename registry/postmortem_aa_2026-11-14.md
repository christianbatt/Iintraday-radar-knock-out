# Post-mortem Passo AA — 2026-11-14

## 1. Ritiro degli undici verdetti esplorativi

Il campo `verdict` e' ammesso solo per `tier: confirmatory`. Le righe exploratory
con verdetto sono **undici**, non sei:

- Passo Y: `AI-0063`, `AI-0064`, `AI-0065`, `AI-0066`, `AI-0067`;
- Passo Z: `AI-0068`, `AI-0069`, `AI-0070`, `AI-0071`, `AI-0072`, `AI-0073`.

Per ciascuna e' appesa una riga `AI-00XX-r` con `verdict: null`,
`retracted_reason: "prediction_supplied_in_registration_block"`,
`retracted_in: "AA"`. Le righe originali restano intatte (append-only).

**Il difetto nasce in Passo Y, non in Passo Z.** In Passo Y si e' iniziato a
registrare ipotesi exploratory con una `prediction` che era gia' il numero
misurato nel blocco di registrazione; Passo Z ha ereditato la stessa forma. Un
verdetto su una predizione che coincide con il valore fornito non e' un test: e'
una trascrizione. Per questo i sei verdetti di Passo Z sono ritirati insieme ai
cinque di Passo Y, e la regola vale per il futuro: una prediction exploratory e'
direzionale, mai un valore gia' calcolato.

## 2. Rumore vero contro 8.52 pp

Due pull completi di `adr14` e `liqEur20d` per tutti i 9 simboli, nella stessa
sessione e con le stesse barre 1d (date `2026-10-15..2026-11-11`, valori
identici), producono snapshot con lo stesso md5
(`048e5cb64364f21a8a067bed5661ee40`) e un replay bit-identico.

| misura | valore |
|---|---|
| delta G7 massimo fra i due pull, barre identiche | **0.00 pp** |
| simboli con delta esattamente 0 | 9/9 |
| delta G7 fra 2026-11-11 e 2026-11-14 (Passo Y) | 8.52 pp |

**8.52 pp era un limite superiore, non il rumore.** In 3 sedute di calendario si
rinnova 3/14 = 21.4% di `adr14` e 3/20 = 15% di `liqEur20d`: il delta misurava il
rinnovo della finestra, non il disordine dell'endpoint. Il pavimento di
riproducibilita' misurato e' **0.00 pp** su barre identiche; 8.52 pp resta solo
come limite superiore fra date diverse. AI-0074 confermata.

## 3. Censo dei gate (percentuale bloccata)

| gate | ENI | UCG | BAMI | RHM | SAP | BAYN | LDO | SIE | STLAM |
|---|---|---|---|---|---|---|---|---|---|
| G1 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| G2 | 1.40 | 1.93 | 9.37 | 1.79 | 2.52 | 1.86 | 3.12 | 2.37 | 2.19 |
| G3 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| G4 | 29.18 | 40.25 | 23.12 | 56.05 | 22.86 | 30.55 | 36.03 | 25.11 | 40.30 |
| G5 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| G6 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| G7 | 2.67 | 15.12 | 3.68 | 25.55 | 13.03 | 8.27 | 8.77 | 7.66 | 0.00 |
| G8 | 35.62 | 70.19 | 63.11 | 96.48 | 75.99 | 87.02 | 93.42 | 45.60 | 89.82 |
| G9 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| G10 | 16.60 | 27.81 | 48.21 | 66.67 | 18.78 | 16.95 | 56.76 | 26.79 | 20.59 |
| G11 | 100.00 | 100.00 | 95.17 | 75.00 | 95.24 | 100.00 | 100.00 | 99.68 | 100.00 |
| G12 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| G13 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |

**Sette gate inerti su tredici** (G1, G3, G5, G6, G9, G12, G13). Attivi: G2, G4,
G7, G8, G10, G11. La catena effettiva e' di sei gate, non tredici.

Classificazione:

| gate | inerte per | margine |
|---|---|---|
| G1 | costruzione (soglia lontana) | liqEur20d 25.87x-149.12x di LIQ_MIN_EUR (mediana 73.14x) |
| G3 | costruzione (griglia solo post-ORB) | nessuna riga pre-ORB nella griglia |
| G5 | costruzione (Tb recente per costruzione) | nessun trigger scaduto |
| G6 | costruzione (T1 non raggiunto prima della decisione) | T1 sopra il massimo di sessione |
| G9 | costruzione (leva selezionata sempre disponibile) | selectedLeverage non nullo |
| G12 | **caso** (soglia vicina) | in holdout BAMI 38.10% bloccate |
| G13 | costruzione (quote fresche) | nessuna quota stantia |

AI-0076 confermata: 7 inerti >= 5. **Nessun gate e' stato rimosso o modificato:**
il censimento e' documentale.

## 4. Censo dell'output

Finestra principale (30 sedute, 2026-10-01..2026-11-11):

- 16 setup = **3.73 setup/settimana**; un setup ogni ~1.88 giorni.
- Per simbolo: SAP 7, BAMI 7, SIE 1, RHM 1. **SAP+BAMI = 14/16 = 87.5%.**
- Simboli a zero: **5 su 9** (ENI, UCG, BAYN, LDO, STLAM).
- Per settimana ISO: W40 1, W41 7, W42 4, W43 1, W44 2, W45 1.
- Per mese: 2026-10 15, 2026-11 1.
- Giorni con setup: 13 con 1, 3 con 2, 17 con 0 (30 sedute).
- Intervallo fra setup consecutivi: mediana 1.17 giorni, p10 0.13, p90 5.08,
  massimo 5.98.

Holdout (28 sedute, 2026-08-24..2026-09-30):

- 18 setup = **4.50 setup/settimana**.
- Per simbolo: BAMI 13, RHM 3, SIE 2; **6 simboli a zero**.
- Giorni: 16 con 1, 1 con 2, 11 con 0.
- Intervallo: mediana 1.20 giorni, p10 0.91, p90 4.00, massimo 4.08.

AI-0075 confermata: due simboli producono la maggioranza (87.5%) e almeno meta'
dei simboli (5/9) e' a zero. AI-0077 confermata: rapporto setup/settimana
holdout/principale = 4.50 / 3.73 = **1.205**, dentro [0.8, 1.3].

## 5. Criterio di decisione

`registry/decision_criteria.md` fissa cinque condizioni numeriche.

| # | condizione | richiesto | misurato | ok |
|---|---|---|---|---|
| C1 | setup/settimana | >= 10.0 | 3.73 | NO |
| C2 | simboli con >=1 setup | >= 5/9 | 4/9 | NO |
| C3 | stabilita' output (rapporto finestre) | [0.8, 1.3] | 1.205 | SI |
| C4 | riproducibilita' (max \|delta G7\| barre identiche) | <= 3.0 pp | 0.00 pp | SI |
| C5 | gate inerti | <= 3/13 | 7/13 | NO |

**Condizioni soddisfatte: 2 su 5.** Il criterio non e' soddisfatto:
`SETUP_SELECTOR_LIVE` resta `off`. La condizione piu' vicina e' C2 (manca un
simbolo); la piu' lontana e' C1 (servono ~2.7x i setup).

## 6. Cosa resta non misurabile

- Il **rumore dell'endpoint su date diverse** resta un limite superiore (8.52 pp),
  non un pavimento: non e' separabile dal rinnovo della finestra senza una fonte
  di barre 1d congelate.
- La **causa dell'assenza di setup** sui 5 simboli a zero non e' attribuibile a un
  gate specifico: G11 (score) blocca il 95-100% delle righe raggiunte, ma il
  punteggio non e' scomposto negli artefatti.
- Il **comportamento in regime diverso** non e' misurato: una sola finestra
  principale e una sola di holdout.
- La **frizione reale** resta parametrica (nessuna misura di spread).

## 7. L'assenza piu' grave

Dopo otto passi il programma **non ha ancora un criterio per accendere il
selettore**: nessun documento, prima di Passo AA, diceva quali condizioni
numeriche giustificano il passaggio da `off` a `on`. Questa e' l'assenza piu'
grave emersa dalla fase comparativa, piu' di qualunque singolo effetto non
significativo: senza criterio, ogni misura precedente non aveva una conseguenza
operativa. `registry/decision_criteria.md` colma il vuoto, ma il criterio stesso
non e' soddisfatto (2/5).
