# Post-mortem Passo N — riparare le emissioni

Data: 2026-11-12. Base: `8b0d8e0b1fb29d609bbfda884a9b1037d9c3a827` (merge PR #47, Passo M).
Branch: `feat/live-v1-passo-n`.

Numeri incollati da `bun scripts/ai_cycle.ts reemission`, `bun scripts/ai_cycle.ts reasons`,
`bun scripts/ai_cycle.ts deathcheck` e dal confronto diretto dei due `setups.json`.

## 1. La riemissione intraday

### 1.1 Dove viene emesso

`scripts/replay_adapter.ts:72` — `emitted: decision === 'TRADE'` — una riga per ogni
`(symbol, decisionTs)` della griglia. Nessuna guardia su `(symbol, setupKey, giorno)`
esisteva prima di questo passo.

Catena: `delay_replay.ts` → `replay_adapter.runPipeline` → `headless_pipeline.runPipelineFromBars`
→ `calculator.getDualTopCandidates` / `buildExecutionSetup` (le stesse funzioni che
`App.tsx` chiama alle righe 780 e 907). **L'analisi e' condivisa con il live;
l'emissione no**: l'append di una riga per `decisionTs` appartiene solo al replay,
l'app live non ha un ledger che scrive una riga per scansione. Il difetto e' del
replay: `productionDefect: false`.

### 1.2 Profilo dei 15 gruppi

    gruppo | n | minTs | maxTs | spreadMin | barre | giorno
    SAP.DE|187.380005|188.596441       3   1790925900  1790926500  10        3      2026-10-02
    BAMI.MI|15.275|15.15962            16  1791185700  1791211500  430       87     2026-10-05
    SAP.DE|185.059998|186.873          11  1791202500  1791211500  150       31     2026-10-05
    BAMI.MI|15.33|15.20952             7   1791271200  1791276600  90        19     2026-10-06
    SAP.DE|186.039993|187.734721       22  1791357300  1791382200  415       84     2026-10-07
    SAP.DE|187|188.676603              12  1791458400  1791468900  175       36     2026-10-08
    BAMI.MI|14.795|14.6706             15  1791530100  1791552000  365       74     2026-10-09
    BAMI.MI|15.005|14.89515            6   1791875700  1791880500  80        17     2026-10-13
    SAP.DE|196.259995|197.734676       12  1791962700  1791989400  445       90     2026-10-14
    SAP.DE|199.639999|201.602397       4   1792134900  1792159800  415       84     2026-10-16
    BAMI.MI|14.1|14.00194              1   1792140000  1792140000  0         1      2026-10-16
    BAMI.MI|13.075|12.95903            5   1792575600  1792577100  25        6      2026-10-21
    SAP.DE|212.449997|214.277706       1   1793016600  1793016600  0         1      2026-10-26
    RHM.DE|1024|1013.968               6   1793194200  1793195700  25        6      2026-10-28
    BAMI.MI|13.385|13.28338            2   1793710500  1793710800  5         2      2026-11-03

Un gruppo resta acceso fino a **445 minuti** (90 barre da 5 minuti). Non e' un
doppione: e' la stessa configurazione ri-emessa per una giornata intera.

### 1.3 Effetto della correzione

    (1.5) emissioni spurie: 123 - 15 = 108
          per giorno: 2026-10-02=2 2026-10-05=25 2026-10-06=6 2026-10-07=21 2026-10-08=11
          2026-10-09=14 2026-10-13=5 2026-10-14=11 2026-10-16=3 2026-10-21=4
          2026-10-26=0 2026-10-28=5 2026-11-03=1

Replay rigenerato in `artifacts/replay_i3_30d_reason/`:

    OLD rows 15160 emitted 123
    NEW rows 27288 emitted 15 reemissione 108
    NEW with reason 15145
    BIT-IDENTICAL fields mismatches: 0

I 15 setup emessi hanno `decisionTs`, `entry`, `stop`, `target`, `direction` e
`symbol` **identici** alla prima riga di ciascun gruppo nel replay vecchio: zero
discrepanze su 15 × 6 campi. Il numero di righe totali cambia (27.288 contro
15.160) perche' la finestra di 30 giorni ora copre giorni in piu': non e' una
regressione, e' un dataset piu' lungo.

### 1.4 Prima o ultima emissione: la scelta conta

    (6.3) meanR netto per k: righe | setup-prima | setup-ultima
     k=0.5 righe=-0.534 prima=-0.522 ultima=-0.322 |prima-ultima|=0.200
     k=1   righe=-0.566 prima=-0.722 ultima=-0.189 |prima-ultima|=0.533
     k=1.6 righe=-0.612 prima=-0.602 ultima=-0.256 |prima-ultima|=0.347
     k=2   righe=-0.875 prima=-0.522 ultima=-0.522 |prima-ultima|=0.000

La deduplica di Passo M teneva gia' la **prima** emissione (`-0.522/-0.722/-0.602/-0.522`,
identici alla colonna "prima"): delta 0.000. Ma la scelta non e' indifferente:
tenere l'ultima sposta `meanR` di **0.533 R** a `k=1.0`. Da ora la regola e'
scritta (`keptRow: first_decisionTs`).

## 2. Il campo reason e la cessazione

### 2.1 Per giorno

Colonne: totale · emesso · barriera · leva · vari · struttura · orario ·
missing_input (nessun setup prodotto).

    2026-10-01 657 0 39 28 0 0 0 292
    2026-10-02 918 1 46 48 56 4 51 408
    2026-10-05 918 2 46 17 93 4 0 408
    2026-10-06 918 1 71 14 43 2 0 408
    2026-10-07 918 1 15 96 125 3 0 408
    2026-10-08 918 1 116 63 10 2 0 408
    2026-10-09 918 1 101 16 19 4 0 408
    2026-10-12 918 0 67 82 38 5 0 408
    2026-10-13 918 1 15 3 100 4 0 408
    2026-10-14 918 1 9 60 96 1 0 408
    2026-10-15 918 0 83 95 20 2 29 408
    2026-10-16 918 2 2 78 94 6 0 408
    2026-10-19 918 0 24 67 44 4 39 408
    2026-10-20 918 0 99 92 20 2 0 408
    2026-10-21 918 1 54 52 13 4 50 408
    2026-10-22 918 0 18 99 25 2 20 408
    2026-10-23 918 0 33 85 22 6 54 408
    2026-10-26 918 1 81 118 51 5 0 408
    2026-10-27 918 0 62 124 30 5 0 408
    2026-10-28 918 1 159 11 11 6 0 408
    2026-10-29 918 0 74 38 55 3 105 408
    2026-10-30 918 0 131 0 10 1 0 408
    2026-11-02 918 0 144 34 0 5 0 408
    2026-11-03 918 1 12 122 51 6 15 408
    2026-11-04 918 0 26 134 12 1 0 408
    2026-11-05 918 0 71 38 8 2 17 408
    2026-11-06 918 0 132 80 0 5 0 408
    2026-11-09 918 0 18 55 51 87 0 408
    2026-11-10 918 0 175 49 0 6 0 408
    2026-11-11 927 0 116 39 0 4 0 412

### 2.2 Prima e dopo il 2026-10-28

    (4.2) prima del 2026-10-28: n=17181 · dopo: n=10107
      Nessun titolo presente o analizzato per la sessione. prima=6005   (35.0%) dopo=3488   (34.5%) delta=-0.4 pt
      REEMISSIONE prima=102    (0.6%) dopo=6      (0.1%) delta=-0.5 pt
      barriera   prima=981    (5.7%) dopo=1058   (10.5%) delta=4.8 pt
      emesso     prima=13     (0.1%) dopo=2      (0.0%) delta=-0.1 pt
      leva       prima=1237   (7.2%) dopo=600    (5.9%) delta=-1.3 pt
      missing_input prima=7636   (44.4%) dopo=4492   (44.4%) delta=0.0 pt
      orario     prima=243    (1.4%) dopo=137    (1.4%) delta=-0.1 pt
      struttura  prima=65     (0.4%) dopo=126    (1.2%) delta=0.9 pt
      vari       prima=899    (5.2%) dopo=198    (2.0%) delta=-3.3 pt

### 2.3 Non e' una causa sola

La **barriera** raddoppia (5.7% → 10.5%, +4.8 pt) ed e' il primo gate dopo il 28,
ma non spiega la cessazione da sola: la **leva** resta al 5.9% e la **struttura**
raddoppia (0.4% → 1.2%). Soprattutto, il bacino piu' grande non e' un gate:
`missing_input` 44.4% (righe in cui nessun setup viene prodotto) e "nessun titolo
presente" 34.5%. E' una **co-failure**: barriera + leva su una base di candidati
che non arriva. Le emissioni passano da 13 (0.1%) a 2 (0.0%).

### 2.4 Setup recuperabili rimuovendo la causa dominante: non stimabile

Non e' stimabile senza neutralizzare G8/G9 e ri-eseguire la pipeline, cioe' senza
cambiare un gate: vietato in questo passo (non-obiettivo 3). Quello che si puo'
dire con i numeri: 15 setup su 13 giorni di emissione = **1.154 setup/giorno**
osservati; 1058 blocchi da barriera dopo il 28 su 10107 righe non si traducono in
emissioni senza ri-valutare i gate successivi. Dato mancante dichiarato, non
inventato.

## 3. Cosa questo passo non dimostra

- Non dimostra che riparare la barriera riporti le emissioni: la co-failure ha
  almeno due componenti e un bacino di candidati assente.
- Non dimostra che il campione sia sufficiente: resta 15 setup, e il criterio di
  morte resta `not_yet_evaluable` (15/100, 13/30, 0/40 decili, 0/8 celle a bande,
  massimo 12 setup in una banda contro una soglia di 30).
- Non tocca G1–G13: `i3_barrier` resta `-43.953 / -57.432 / -60.546`.
