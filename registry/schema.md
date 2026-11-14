# Registro AI — schema

`registry/ai_registry.jsonl` è **append-only** (JSON Lines, una riga per evento).
Nessuna riga passata viene modificata o cancellata: ogni correzione è una nuova riga.

## kind ammessi

| kind | quando |
|---|---|
| `hypothesis` | **prima** di vedere l'holdout. Pre-registrazione. |
| `result` | dopo la misura, con l'esito `accepted` / `rejected` / `inconclusive` / `insufficient_holdout` / `not_yet_evaluable`. |
| `activation` | solo via `ai_cycle.ts promote --id=AI-XXXX`, mai dal pulsante. |
| `rejection_note` | nota su un'ipotesi scartata, senza riaprirla. |

## Campi

### hypothesis
| campo | significato |
|---|---|
| `id` | `AI-NNNN`, progressivo, immutabile |
| `ts` | ISO 8601 UTC |
| `author` | `agent` oppure `human` |
| `assumption` | frase in italiano, **falsificabile** |
| `touches` | quali parti tocca (es. `selector.feature.stopPct`) |
| `evidence` | `dataset`, `n`, `period` su cui è formulata |
| `prediction` | `metric`, `direction`, `minDelta`, `nullModel`, `alpha`, `nTestsPrior`, `alphaEffective` |
| `split` | `train` e `holdout`, sempre **temporale** |
| `status` | `pre_registered` |

### result
`status`, `measured` (`meanR_train`, `meanR_holdout`, `delta`, `ci95`, `sumR_holdout`, `kSelected`, `nullMean`, `nullP95`, `pValue`), `reason`, `supersedes` (opzionale).

### status `insufficient_holdout`
Un rifiuto **formale** e un rifiuto **empirico** non sono la stessa informazione.
`insufficient_holdout` si usa quando l'holdout esiste ma è troppo piccolo perché il
confronto significhi qualcosa (soglia: meno di 30 campioni). In quel caso
`measured.beatsNull` vale **`null`**, mai `true` o `false`, e `measured.nullReason`
dice perché il confronto non è interpretabile.

### status `not_yet_evaluable`
Usato dal criterio di morte (AI-0005): il trigger non è soddisfatto, quindi non
esiste né un'accettazione né un rifiuto. Non è un fallimento: è l'assenza di giudizio.

### campo `supersedes`
Una `result` può sostituire **lo stato** di una precedente senza toccarla:
`supersedes: "AI-0003"` significa «questa riga corregge lo stato di AI-0003».
La riga originale resta nel file: il registro è append-only, la catena si legge
seguendo gli `supersedes`.

### activation
`configVersion`, `live`, `approvedBy`.

## Correzione per test multipli

`alphaEffective = 0.05 / (1 + nTestsPrior)`, dove `nTestsPrior` è il numero di
`hypothesis` già presenti nel registro **al momento della scrittura**.
Va scritto nella riga: non si ricalcola dopo.

## Regole

1. La prima riga del registro è l'ipotesi sul payoff, non sul selettore.
2. Nessun `result` senza `hypothesis` corrispondente.
3. Nessuna `activation` senza `result` con `status: accepted`.
4. Lo split è temporale; mai casuale.
5. Massimo 4 parametri liberi in `selector_config.json`.
6. `SETUP_SELECTOR_LIVE` resta `off`: il registro documenta, non accende.

## Righe VOID (Passo M)

Due righe `AI-0001 result` sono state prodotte dal bug di idempotenza di
`train` (append non guardato da `hasRow`) fino a Passo M: ogni esecuzione di
`train` ne aggiungeva una. Sono **VOID**: non contano in `nTrials`, non contano
in `alphaEffective`, non contano in nessuna statistica. Restano nel file per
append-only. Il bug è stato corretto in Passo M: `train` non appende se la riga
esiste già. `postmortem` è read-only rispetto al registro.

## Passo O — riconciliazione dei numeri di Passo N

- `replay perimeter`: OLD 15160 righe, NEW 27288 righe, stessi 30 giorni distinti
  (2026-10-01..2026-11-11). La crescita e' nei `(symbol,giorno)` (150 -> 270),
  non un'estensione della finestra.
- `reason` (valore vs assenza): 15145 righe portano un `reason`; 0 portano
  `missing_input` come valore; 12143 non hanno il campo. `15145 + 15 = 15160`.
  Il 44.4% e' l'assenza del campo, non un valore.
- `stop distribution`: min 0.649%, max 0.983%, media 0.831%, sd 0.108%,
  range 33.4 bp. Strutturale (guidata dalla formula), non campionaria.
- `days needed`: 4 dei 15 setup nella banda migliore [0.75,0.80) -> 112.5 setup
  necessari -> 60 giorni di calendario o 26 giorni con emissione. 260 non e'
  difendibile sotto nessuna delle due assunzioni.
- `nCells`: si distingue `preRegistered` (32 = 8 bande x 4 k) da `nonEmpty`
  (8). Bonferroni: 0.05/32 = 0.0015625 (corretto) vs 0.05/8 = 0.00625.
- `keptRow`: resta `first_decisionTs`. L'entry e' identica fra prima e ultima
  emissione (diff 0 bp); il gap di 0.533 R a k=1.0 e' un look-ahead della
  scelta dell'ultima emissione, non una proprieta' dell'entry.

## Passo R — catena dei gate, eterogeneita, giorni per cella

- `reason`: symbolsWithReasonBefore=5, symbolsWithReasonAfter=5.
  righe con reason=15145, missing_input=0, senza reason=12143.
  I 4 simbodi aggiunti hanno 0 reason (gate mai girati: snapshot con 5 simbodi,
  replay_adapter.ts:54 ritorna null senza quote).
- `perSymbol`: setup per simbodo su 30 symbol-day:
  BAMI.MI 7, BAYN.DE 0, ENI.MI 0, LDO.MI 0, RHM.DE 1, SAP.DE 7,
  SIE.DE 0, STLAM.MI 0, UCG.MI 0. Tasso medio 0.0556/symbol-day.
  chi-quadro=44.4000 gdl=8 p=4.78e-7: tasso non uniforme.
- `daysNeeded`: definizione setupTotali = setupPerCella / frazioneBanda.
  frazioneBanda=0.7157. setupPerCella 30 -> 41.9; 62 -> 86.6.
  giorni emitting: 36.3 / 75.1. giorni calendario: 83.8 / 173.3.
  Q riportava 41.9 -> 36.3/83.8 (corretto) e 62 -> 53.7/124.0 (errato).
- `elasticity`: simbodi con reason prima=5, dopo=5; setup nei 4 aggiunti=0;
  non misurabile; limite superiore 3/120=0.025 setup/symbol-day;
  leva 173.3 gg (elasticita 0) vs 86.6 gg (elasticita 1).

## Passo Q — perimetro per simbodi

- `perimeter`: symbolsOld=5, symbolsNew=9, daysOld=30, daysNew=30.
  OLD 15160 = 5 x 30 x 101.07; NEW 27288 = 9 x 30 x 101.07.
  La crescita e' interamente attribuibile ai 4 simbodi aggiunti
  (BAYN.DE, LDO.MI, SIE.DE, STLAM.MI). Passo O e la lettura precedente
  avevano attribuito la crescita ai giorni: errore dichiarato.
- `reason` (per simbodo): i 4 simbodi aggiunti hanno 0 candidati e 0 reason
  (non misurati: snapshot con 5 simbodi). Le 12128 righe senza reason sono
  esattamente le loro righe. 'missing_input' come valore: 0 righe.
- `concentration`: expected=0.7157, observed=0.800, z=0.724. Non anomala.
  Il fatto strutturale e' il range 33.4 bp su bande da 25 bp.

## Passo P — reason sull'universo nuovo

- `reason` (perimetro): contato sull'universo nuovo (27288 righe, 9 simboli x
  30 giorni). 15145 righe portano un `reason` (55.5%); 0 portano `missing_input`
  come valore; 12143 non hanno il campo (44.5%). `15145 + 15 = 15160`.
  Il 44.5% e' il delta di copertura (4 simboli x 30 giorni = 120 symbol-day),
  non un valore del campo. La diagnosi della cessazione descrive 15 giorni su 27
  solo se ristretta ai primi 15 giorni; sui 30 giorni il motivo dominante resta
  `Nessun titolo presente o analizzato per la sessione` (9493, 34.8%).
- `nCells`: si distingue `preRegistered` (32 = 8 bande x 4 k), `nonEmpty`
  (8), e `structurallyUnreachable` (24): dato il range osservato (33.4 bp) e
  la larghezza delle bande (25 bp), solo 2 bande su 8 possono contenere dati.
  Bonferroni-32 penalizza test che nessun dato potra' mai produrre.
- `days needed`: tre letture — aggregata 30 setup (60 gg calendario / 26 gg
  emissione), banda 37.5 setup (75 / 32.5), decile 112.5 setup (225 / 97.5).
  Il criterio scritto richiede il decile (la cella pre-registrata e' il decile).
- `power`: a alpha Bonferroni-32 (0.0015625) servono 62 setup per l'80% di
  potenza (vs 26 ad alpha 0.05). Fattore 2.07 vs la soglia 30: incoerenza
  dichiarata, non risolta.

## Passo N — unita', causa, etichette

- `repetitionCause`: ammette `intraday_reemission`. Il valore `replay` scritto
  negli artefatti di Passo M era **errato** (forzato in un enum che non aveva il
  valore giusto): i 15 gruppi hanno `giorni=1` e 13/15 hanno un `decisionTs`
  distinto per riga. Non si corregge in place: si dichiara errato qui.
- `alphaBonferroni`: con 0 celle ammissibili vale la stringa
  `"undefined (0 celle ammissibili)"`, non `null`. `null` significa "non
  calcolabile per input mancante"; `0.05/0` e' indefinito, non nullo.
- `keptRow`: nella deduplica, `"first_decisionTs"` — si tiene la riga con
  `decisionTs` minimo del gruppo `(symbol|entry|stop)`.
- `reason` (replay): una delle 7 cause `liquidita, struttura, leva, rischio,
  orario, barriera, vari`, dal primo gate fallito in ordine numerico, oppure
  `REEMISSIONE` per le righe declassate dalla guardia.

## Passo S — gateChain, heterogeneity, alpha

- `gateChain`: ogni riga con `reason` porta la lista ordinata dei gate falliti
  (`gates`), dall'ultimo gate superato al primo gate fallito. Chi-quadro
  calcolato sui soli simbodi con `reason` (non sugli zeri strutturali).
- `heterogeneity`: chi-quadro sui setup per simbodo, gdl = simbodi valutati - 1.
  Dopo l'estensione a 9 simbodi i 4 aggiunti hanno 0 setup, ma restano
  valutati (reason presente); il chi-quadro resta 44.4000, gdl=8, p=4.78e-7.
- `alpha`: `alphaEffective = 0.05 / nHypotheses`, con `nHypotheses` = numero di
  `hypothesis` nel registro al momento della scrittura. Il valore 0.0016667
  corrispondeva a 30 ipotesi; il registro ne contiene 33. Valore corretto
  per Passo S: 0.05/33 = 0.0015152.

## Passo T — reasonByGate, liquidity, heterogeneity esatta, alpha

- `reasonByGate`: matrice simbolo x gate G1..G13, più SESSION, REEMISSIONE ed
  EMITTED. Il gate si legge dal token `G<n>` nel campo `reason`; SESSION =
  "Nessun titolo presente o analizzato per la sessione."; REEMISSIONE = riga
  declassata dalla guardia.
- `liquidity`: per i 5 simboli noti, `true` = liqEur20d dello snapshot a 5,
  `estimated` = volume medio delle barre non nulle x primo close, `deltaPct` =
  (estimated - true) / true * 100. Per i 4 aggiunti si riporta solo lo stimato
  di snapshot_9. Soglia G1: LIQ_MIN_EUR = 3.000.000 EUR.
- `heterogeneity`: `exactP` = P(al più 3 simboli occupati su 9 con 15 setup
  sotto uniformità), calcolato con numeri di Stirling; `approxValid=false`
  perché 9/9 celle hanno atteso 1.667 < 5. Il chi-quadro resta 44.4000, df 8,
  p asintotico 4.78e-7, ma non è ammissibile.
- `alpha`: formula dichiarata `alphaEffective = 0.05 / n`, con `n` = numero di
  ipotesi dopo l'append del blocco. Per il blocco T n=41, alpha=0.0012195.
  `hypothesesCovered=41`. La formula 0.05/33 usata in S copriva 33 ipotesi.

## Passo V — media per barra vs aggregato, giorni civili vs borsa, alpha congelato

- `adrConsumptionFraction`: (high ORB - low ORB) / `adr14`. Se `adr14` e'
  una media per barra 5m invece di un aggregato daily, la frazione e' gonfiata
  di circa il rapporto daily/5m. Il passo V misura questa distribuzione con
  `ai_cycle.ts adrfrac` e la confronta con `TRADING_PARAMS.ADR_MAX`.
- `nHypothesesAtMeasurement`: numero di righe `kind=hypothesis` al momento
  della misura. Per V: **46**; alpha = 0.05/46 = **0.0010869565**. Alpha va
  congelato al momento della misura e non ricalcolato dopo l'append dei
  risultati.
- `denominator`: distinzione fra media su 20 **giorni civili** e media su 20
  **giorni di borsa**. La seconda usa solo sessioni presenti nei timestamp.
- `bitIdentity`: dopo ogni rigenerazione di snapshot, il sottoinsieme dei 5
  simboli originali va filtrato e confrontato con l'artefatto pre-rigenerazione
  (righe, setup, hash). Senza questo confronto la rigenerazione non e'
  chiudibile.
- `gateBlocking` vs `gateUnmeasured`: un gate con 0 righe raggiunte (G8, G10,
  G11 nei 4 aggiunti) e' **non misurato**, non evidenza di pass o fallimento.
  Solo i gate raggiunti possono essere letti come bloccanti.
- `verdict.not_evaluable`: usato quando la regola di stop del passo scatta
  prima della misura prevista; il motivo va scritto nella riga `result`.

### Passo V — ripresa con correzione congiunta

- `adrfrac --snapshot=<path>`: la distribuzione va letta sullo snapshot usato
  dal replay. Dopo la correzione: `--snapshot=artifacts/snapshot_9_daily2.json`.
- `REPLAY_SNAPSHOT=<path>` in `replay_adapter.ts`: seleziona lo snapshot del
  replay senza sovrascrivere `snapshot_9.json`. Il default resta
  `artifacts/snapshot_9.json`.
- `bitid`: confronta il sottoinsieme dei 5 simboli con il replay
  pre-correzione e stampa righe, setup e hash SHA-256. Hash atteso per V:
  `7fd90b4dfcedeeb761ba681d0d9ff7570f83a2756017a6ff1c07969c23495a0b`.
- `adrdelta` distingue tre grandezze: `adr 5m` (media per barra), `adr daily`
  (aggregato su 20 giorni di borsa) e `adr vero` (ADR classico). Il rapporto
  `daily/5m` di `adr14` e' **12.01-14.62**, non 95-120; `liqEur20d` ha
  invece rapporto **104.97-117.92**. Le due grandezze non sono omogenee.
- `snapshot9daily2` e' la correzione congiunta: ricalcola `adr14` a 20 giorni
  di borsa e lascia `liqEur20d` invariato se gia' daily. Delta `liqEur20d` =
  **0.00%** (non +46.7%): la correzione di calendario era gia' stata applicata
  in Passo U.
- Il verdetto sullo zero distingue **zero rotto** (setup > 0 dopo la
  correzione) da **zero strutturale** (setup = 0 con G8/G10/G11 raggiunti a 0).
  Per V: **1 setup**, quindi zero rotto e non strutturale, con campione
  piccolo dichiarato.
- I risultati della ripresa sono righe `kind=result` appese dopo le righe
  `not_evaluable` della prima chiusura. Il registro resta append-only: le righe
  precedenti non vengono riscritte; l'ultima riga `result` per `hypothesisId`
  e' quella valida.

## Passo W — provenienza, denominatore, definizione unica, ritiro uniformita'

- `aggregazione` — i campi derivati dalle barre 5m non seguono la stessa legge:
  i **volumi** si aggregano linearmente sul numero di barre, i **range** in
  radice. Per gli aggiunti `adr daily/5m / sqrt(liq daily/5m)` = **1.242–1.336**,
  media **1.277**, CV **3.4%**. L'eccesso 1.277 e' una correzione di forma, non
  un errore di denominatore.
- `provenienza` — i valori "vero" di `adr14` e `liqEur20d` dei 5 noti vengono da
  `src/utils/__tests__/fixtures/pipeline_snapshot.json`, catturato dal server
  live; il server li calcola da barre **giornaliere** Yahoo (`interval=1d`,
  `range=1mo`), non dalle 5m in cache. Per i 4 aggiunti non esiste un vero
  indipendente: ogni loro validazione contro se stessi e' circolare.
- `denominatore` — `snapshot9liqtd` usa 20 **barre giornaliere** (giorni di
  borsa), non 20 giorni civili. Per gli aggiunti il delta rispetto a daily2 e'
  **0.00%** perche' la correzione di calendario era gia' in Passo U. Sui 5 noti
  `daily/vero` resta **0.6261–0.7221**: la funzione e' ancora sbagliata e il
  residuo non e' spiegato dal calendario.
- `definizione raggiunte G7` — **`emitted` oppure `reason` G7..G13;
  REEMISSIONE esclusa**. La re-emissione e' un declassamento della guardia, non
  un passaggio di G7. Includerla gonfia i noti da 3151/3531 a 3259/3639
  (differenza 108). La partizione completa include **SESSION**: senza SESSION la
  somma dei terminali non chiude a 3032.
- `ritiro uniformita'` — `exacttest` e' ritirato: il null uniforme su 9 celle non
  e' plausibile (2/5 noti a zero setup, distribuzione {0,0,1,7,7}), il
  multinomiale (5/9)^n testa lo stato pre-correzione, il chi-quadro non e'
  ammissibile (9/9 celle attese <5), e P(al piu' 3 occupati) e' una coda, non
  il p del risultato osservato. Sostituito da confronto a due campioni stadio
  per stadio e Fisher a livello di simbolo.
- `cattura exit code replay` — il replay va lanciato con exit code catturato
  esplicitamente (`echo $? > file`); un processo in background senza file di
  exit non e' una misura. `summary.json` va verificato con hash e numero di
  righe indipendenti.
- `alpha` — Passo W: 51 ipotesi, `alphaEffective = 0.05/51 = 0.0009804`, scritto
  nelle righe `hypothesis` e `result`.
- `AI-0047` — la formulazione corretta e': **falsificata la legge lineare,
  confermato il meccanismo per-barra**. Non e' "diagnosi sbagliata".

## Passo X — copertura, denominatore, disallineamento, permutazione per simbolo

- `tre cause` — un rapporto `liq daily/vero < 1` puo' avere tre cause distinte:
  (a) **denominatore di calendario** (giorni civili invece di sedute), (b)
  **copertura** (le barre 5m esistono ma il loro volume aggregato e' una
  frazione del volume giornaliero), (c) **disallineamento di finestra** (la
  finestra del replay e la cattura del vero finiscono in giorni diversi). Si
  distinguono solo misurando: (a) il numero di sedute al denominatore stampato
  per simbolo; (b) il rapporto per-giorno 5m/Yahoo sullo stesso giorno e il
  numero di barre/giorno; (c) la data di fine finestra contro `capturedAt`.
  L'argomento `0,682 = 13,635/20` e' tautologico e non e' una prova.
- `no-op` — prima di accettare una correzione, verificare che il comando non
  riusi lo stesso percorso: due comandi che dovrebbero differire del +46,6%
  ma danno delta 0,00% sono un no-op, non una conferma. In quel caso l'ipotesi
  e' `not_evaluable` con `rejection_note`, non `falsified`.
- `pass robusto su LIQ_MIN_EUR` — un simbolo e' **robusto** se
  `liq_5m / coverage_high > LIQ_MIN_EUR` per TUTTO l'intervallo di copertura
  osservato; **fragile** se passa solo in parte; **mai** se non passa mai. Il
  fattore di copertura va misurato per simbolo: un unico 0,722 non e' un lower
  bound per tutti (STLAM ha copertura 0,847).
- `permutazione per simbolo` — l'unita' e' il simbolo, non la riga. Statistica:
  differenza fra **media non pesata** degli aggiunti e media non pesata dei
  noti. Il test di uniformita' e' ritirato; questa permutazione esatta su
  C(9,4)=126 lo sostituisce come test di eterogeneita'. Riportare sempre anche
  il pooled, che differisce dalla media non pesata.
- `media non pesata` — con 4 aggiunti e 5 noti la media per simbolo e' l'unita'
  di analisi; il pooled e' dominato dai simboli con piu' righe e non e' la
  statistica del test.
- `adr14` — `ADR_PERIOD` del server e' **14** sedute; `snapshot9daily3` usa una
  media di range su **20** sedute. Le due grandezze non sono intercambiabili.
  Il ramo "vero" ricalcola 14 sedute per `adr14` e 20 per `liqEur20d`, come il
  server. Un errore di +-14% sul valore a 20 sedute e' un test di stabilita'
  del valore corrente, non dell'ADR14 del server.
- `copertura vs setup` — la copertura `liq_5m/liq_vero` e' associata
  negativamente ai setup (5 noti rho -0,63, p unilaterale 0,167; 9 simboli
  rho -0,37). Il segno e' stabile, la potenza no: 5-9 simboli non bastano.
- `bit-identita'` — il ramo a 5 resta bit-identico (15.160 righe, 15 setup,
  hash `7fd90b4d...`) anche dopo la rigenerazione dei 4 aggiunti.

## Passo Y — tier, pavimento, bootstrap, 2x2, holdout

- `tier` — ogni ipotesi porta `tier: confirmatory | exploratory`. Le **56**
  ipotesi pre-Y restano `confirmatory` per dichiarazione retroattiva (non si
  riscrive il registro: le righe restano quelle di `origin/main`). Le ipotesi
  del Passo Y sono `exploratory` tranne **AI-0062**, che e' `confirmatory` ma
  resta **fuori dal denominatore** per congelamento dell'alpha: il denominatore
  confirmatory resta **56**, `alphaEffective = 0.05/56 = 0.000892857`. Le
  exploratory non entrano nel denominatore e si riportano come stime con IC.
- `pavimento permutazione` — con 9 simboli C(9,4)=126, p minimo
  **1/126 = 0.0079365 > alpha**. Il test non puo' rifiutare per costruzione.
  Serve **n>=15** (C(15,4)=1365, p minimo 0.0007326) perche' la coda contenga
  alpha. AI-0061 e' quindi `not_evaluable`; la riga `AI-0061-c` lo dichiara e
  la permutazione resta descrittiva, non confermativa.
- `bootstrap sui simboli` — sostituto del p quando n e' piccolo: 10000 repliche,
  ricampionamento con reimmissione dei simboli (4 aggiunti + 5 noti), IC 95%
  percentile della differenza fra medie non pesate. Con 9 unita' anche l'IC ha
  incertezza: si riporta l'ampiezza come indeterminazione, non come test.
- `nessun daily da 5m` — **regola**: nessun campo daily (`adr14`,
  `liqEur20d`, `avgVolume20d`, `atr14`, `ema20`) si costruisce da barre 5m.
  I daily vengono da Yahoo 1d; le 5m servono solo per prezzi/ORB/VWAP/volume
  intraday. Questo elimina la circolarita' e la dipendenza dalla copertura.
- `2x2 fonte/periodo` — per separare fonte (5m vs 1d) e periodo (14 vs 20
  sedute) si usano quattro celle: A 5m/20, B 5m/14, C 1d/20, D 1d/14.
  Effetto fonte = (C+D)/2-(A+B)/2; effetto periodo = (B+D)/2-(A+C)/2;
  interazione = (D-C)-(B-A). Non attribuire a una sola causa un guadagno che
  e' quasi tutto interazione.
- `endpoint incomparabili` — "copertura" era un'etichetta imprecisa: le barre
  5m ci sono tutte (102/giorno), ma il volume 5m e il volume 1d non sono
  confrontabili come sovrainsieme/sottoinsieme. Il rapporto 5m/1d ha coda a
  destra >1 e segno variabile; e' una discrepanza di consolidamento, non un
  buco. Riportare sempre quanti giorni superano 1.02 per simbolo.
- `holdout` — ogni conclusione sui tassi richiede una finestra temporale
  disgiunta, con snapshot e barre ricostruiti con la stessa procedura. La
  finestra va dichiarata; se l'API non consente 30 sedute disgiunte, si riporta
  la durata effettiva (Passo Y: 28 sedute, 2026-08-24..2026-09-30) come limite.
- `asimmetria date` — i 5 noti vengono dalla fixture catturata il 2026-11-11,
  i 4 aggiunti da un pull del 2026-11-14. Ri-tirare i noti alla stessa data
  cambia G7 fino a 8.52 pp: l'asimmetria e' un limite permanente, non si adotta
  in silenzio una data unica. Per il futuro: stessa data di pull per tutti.
- `soglia adrConsumptionFraction` — la soglia 0.6 non compare come `reason` e
  le righe sopra 0.6 sono il 6.44%: e' un diagnostico, non un gate. Non usarla
  come criterio di qualita' o di selezione.
