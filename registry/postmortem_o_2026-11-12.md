# Post-mortem Passo O — riconciliazione dei conti di Passo N

Data: 2026-11-12. Base: `ed6a913` (merge PR #48, Passo N).
Branch: `feat/live-v1-passo-o`.

Numeri incollati dall'output dei comandi `bun scripts/ai_cycle.ts` (deathcheck,
surface, population, dedup, payoff, upstream, postmortem, train, cycle) e dal
confronto diretto dei due `setups.json` (OLD `artifacts/replay_i3_30d/`,
NEW `artifacts/replay_i3_30d_reason/`). Nessun numero inventato; i valori non
riverificati in questo passo sono dichiarati tali.

## I conti di Passo N

### 1. Perimetro del replay (STEP 1)

OLD 15160 righe, NEW 27288 righe, ma **stessi 30 giorni distinti**
(2026-10-01 → 2026-11-11) e stesso range di date. La crescita non è una
finestra più lunga: è l'aumento dei `(symbol, giorno)` da 150 a 270. I 12128
righe in più sono calendario, non storia. Il confronto OLD/NEW va fatto sul
numero di giorni, non sul numero di righe.

### 2. Il campo `reason` (STEP 2)

15145 righe portano un `reason`; **0** portano `missing_input` come valore.
`15145 + 15 = 15160` esattamente. Le 12143 righe senza reason sono
l'assenza del campo, non un valore: il 44.4% non è una causa, è un buco di
copertura. Non va trattato come un gate.

### 3. Distribuzione degli stop (STEP 3)

min 0.649%, max 0.983%, media 0.831%, sd 0.108%, range 33.4 bp. La
distribuzione è **strutturale**: guidata dalla formula di selezione della leva
(`dS × L ≤ 10%`, `1/L ≥ dS + 0.1%`), non dal campione. Non è un risultato
statistico da interpretare, è una proprietà del costrutto.

### 4. Giorni necessari (STEP 4)

4 dei 15 setup cadono nella banda migliore `[0.75, 0.80)`: servono **112.5
setup**, cioè 60 giorni di calendario o 26 giorni con emissione (1.154/giorno).
Il valore **260** non è difendibile sotto nessuna delle due assunzioni. La
stima precedente supponeva una distribuzione uniforme dei setup sui 10 decili,
che i dati non supportano.

### 5. Denominatore della griglia (STEP 5)

Pre-registrate 32 celle (8 bande × 4 k), solo 8 non vuote (2 bande
popolate). Per Bonferroni il denominatore corretto è quello pre-registrato:
`0.05 / 32 = 0.0015625`, non `0.05 / 8 = 0.00625`. La soglia non si ricalcola
dopo aver visto quali celle si popolano.

### 6. Prima vs ultima emissione (STEP 6)

L'entry è identica fra prima e ultima emissione in ogni gruppo (diff 0 bp).
Il gap di **0.533 R a k = 1.0** è un look-ahead introdotto dalla scelta
dell'ultima emissione, non una proprietà dell'entry. La deduplica di Passo M
teneva già la prima emissione (`keptRow: first_decisionTs`): delta 0.000.
La regola è ora scritta e testata (`emissionGuard.test.ts`).

## Il vincolo vero: 25 punti base di stop

Il limite non è il numero di giorni né la griglia: è lo **stop**.

Gli stop stanno fra 0.649% e 0.983%: 33.4 bp di range, media 0.831%. Questo
è il vincolo strutturale del sistema. Con uno stop così stretto:

- la barriera di Knock-Out deve stare a meno di ~10 bp dall'entry per le
  leve disponibili (10, 15, 20, 25);
- il target a k = 1.0 è a ~0.83% dall'entry, cioè dentro il rumore intraday;
- nessuna banda di stop raggiunge 30 setup distinti (massimo 12 in una banda);
- il criterio di morte resta `not_yet_evaluable` (15/100 setup, 13/30 giorni,
  0/8 celle a bande, 0/40 decili).

Non è un problema di campione da risolvere con più giorni: è un problema di
**geometria**. Finché lo stop resta sotto ~1%, il target non può distanziarsi
dal rumore e il criterio non può attivarsi. Allargare lo stop non è una
decisione di questo passo (non-obiettivo: nessuna nuova soglia, nessun grid
search), ma è l'unico punto in cui il sistema potrebbe cambiare stato.

## Cosa questo passo non dimostra

- Non dimostra che riparare la barriera riporti le emissioni (co-failure).
- Non dimostra che il campione sia sufficiente: resta 15 setup.
- Non tocca G1–G13: `i3_barrier` resta `-43.953 / -57.432 / -60.546`.
- `SETUP_SELECTOR_LIVE` e `STALENESS_USE_MARKET_TS` restano `off`.
- Nessuna nuova soglia, nessun grid search, nessun nuovo download.