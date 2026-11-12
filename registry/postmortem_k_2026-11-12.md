# Post-mortem Passo K — osservabilità

Due sezioni in più rispetto a `registry/postmortem_2026-11-12.md` (che resta quello del
Passo J). Ogni numero qui sotto è prodotto da `bun scripts/shadow_report.ts` o
`bun scripts/ai_cycle.ts deathcheck` sui dati in `artifacts/`, oppure ricalcolato da
`artifacts/replay_i3_30d/shift_0/setups.json`; il comando è citato accanto a ogni tabella.

## 1. La cesura del 2026-10-28

### 1.1 Copertura: esclusa

`artifacts/bars/*.json` — primo e ultimo giorno per simbolo (calcolato sui `t` delle barre):

| simbolo | barre | dal | al |
|---|---|---|---|
| BAMI.MI | 3059 | 2026-10-01 | 2026-11-11 |
| BAYN.DE | 3060 | 2026-10-01 | 2026-11-11 |
| ENI.MI | 3061 | 2026-10-01 | 2026-11-11 |
| LDO.MI | 3061 | 2026-10-01 | 2026-11-11 |
| RHM.DE | 3060 | 2026-10-01 | 2026-11-11 |
| SAP.DE | 3060 | 2026-10-01 | 2026-11-11 |
| SIE.DE | 3060 | 2026-10-01 | 2026-11-11 |
| STLAM.MI | 3059 | 2026-10-01 | 2026-11-11 |
| UCG.MI | 3061 | 2026-10-01 | 2026-11-11 |

Le barre arrivano **13 giorni oltre** la cesura. Quindi la cesura **non è copertura**:
il passo prosegue con le ipotesi sulla pipeline.

### 1.2 Emissioni per giorno

`bun scripts/shadow_report.ts`, sezione `emissionsByDay` dell'artefatto
`artifacts/shadow/shadow_2026-11-12.json`. `cand` = righe di valutazione,
`em` = setup emessi, `blk` = non emessi, `primo gate` = gate mancante più frequente
fra le righe **con direzione** (null se nessuna riga ha direzione).

| giorno | cand | em | blk | primo gate |
|---|---|---|---|---|
| 2026-10-01 | 365 | 0 | 365 | G1 |
| 2026-10-02 | 510 | 3 | 507 | G7 |
| 2026-10-05 | 510 | 27 | 483 | G11 |
| 2026-10-06 | 510 | 7 | 503 | G8 |
| 2026-10-07 | 510 | 22 | 488 | G4 |
| 2026-10-08 | 510 | 12 | 498 | G8 |
| 2026-10-09 | 510 | 15 | 495 | G8 |
| 2026-10-12 | 510 | 0 | 510 | G4 |
| 2026-10-13 | 510 | 6 | 504 | G11 |
| 2026-10-14 | 510 | 12 | 498 | G11 |
| 2026-10-15 | 510 | 0 | 510 | G4 |
| 2026-10-16 | 510 | 5 | 505 | G4 |
| 2026-10-19 | 510 | 0 | 510 | G4 |
| 2026-10-20 | 510 | 0 | 510 | G8 |
| 2026-10-21 | 510 | 5 | 505 | G8 |
| 2026-10-22 | 510 | 0 | 510 | G4 |
| 2026-10-23 | 510 | 0 | 510 | G4 |
| 2026-10-26 | 510 | 1 | 509 | G4 |
| 2026-10-27 | 510 | 0 | 510 | G4 |
| **2026-10-28** | 510 | **6** | 504 | G8 |
| 2026-10-29 | 510 | 0 | 510 | G7 |
| 2026-10-30 | 510 | 0 | 510 | G8 |
| 2026-11-02 | 510 | 0 | 510 | G8 |
| 2026-11-03 | 510 | 2 | 508 | G4 |
| 2026-11-04 | 510 | 0 | 510 | G4 |
| 2026-11-05 | 510 | 0 | 510 | G8 |
| 2026-11-06 | 510 | 0 | 510 | G8 |
| 2026-11-09 | 510 | 0 | 510 | G2 |
| 2026-11-10 | 510 | 0 | 510 | G8 |
| 2026-11-11 | 515 | 0 | 515 | G8 |

Lettura: i **candidati sono 510-515 ogni giorno** per tutto il periodo, weekend esclusi
(il 2026-10-01 ne ha 365 perché è il primo giorno della cache, con meno barre a monte).
La cesura non è nemmeno un crollo dell'imbuto a monte: l'imbuto riceve la stessa materia
prima e dopo. **121 dei 123 setup emessi sono prima del 29 ottobre.**

### 1.3 Quale gate cambia stato

Tasso di passaggio per gate fra le righe **con direzione** (stessa fonte, prima / dopo la
cesura). n = 3612 direzionali prima, 1932 dopo.

| gate | prima | dopo | delta |
|---|---|---|---|
| G1 | 100.0% | 100.0% | 0.0 |
| G2 | 98.0% | 93.8% | −4.2 |
| G3 | 98.0% | 98.1% | +0.1 |
| G4 | 65.4% | 69.5% | **+4.1** |
| G5 | 100.0% | 100.0% | 0.0 |
| G6 | 100.0% | 100.0% | 0.0 |
| G7 | 91.1% | 81.6% | −9.5 |
| **G8** | **39.8%** | **22.0%** | **−17.8** |
| G9 | 39.8% | 22.0% | −17.8 |
| G10 | 87.0% | 92.8% | +5.8 |
| G11 | 12.3% | 14.5% | +2.2 |
| **G12** | **61.1%** | **45.8%** | **−15.3** |
| G13 | 100.0% | 100.0% | 0.0 |

**Nessun gate va a zero.** G1, G5, G6 e G13 passano sempre il 100% delle righe con
direzione: non sono loro il vincolo.

(Nota: nella tabella 1.2 il «primo gate» G1 compare per le righe **senza** direzione solo
il primo giorno; da lì in poi il primo gate mancante fra le righe direzionali è G2..G12.
Il G1 al 100% e il G1 «primo gate» convivono perché il primo si riferisce alle sole righe
direzionali, il secondo a tutte.)

### 1.4 Quanto della caduta spiegano le marginali

Prodotto dei tre gate più selettivi:

- prima: `0.123 (G11) × 0.398 (G8/9) × 0.611 (G12) = 2.99%`
- dopo: `0.145 × 0.220 × 0.458 = 1.46%`

Tasso osservato: `121/3612 = 3.35%` prima, `2/1932 = 0.10%` dopo. Il modello indipendente
**azzecca il periodo prima e sbaglia di 15 volte quello dopo**. Il fattore osservato è 33,
quello spiegato dalle marginali è 2.

Conclusione, secca: la cesura è **pipeline**, non copertura e non un gate singolo. Le
marginali spiegano un fattore 2 su 33; il resto è **struttura di co-fallimento** (gli stessi
giorni in cui fallisce G8 falliscono anche G9 e G12), che non è osservabile senza il campo
`reason` — lo STEP 4 che il Passo J non ha eseguito.

### 1.5 Cosa manca al trigger del criterio di morte

`bun scripts/ai_cycle.ts deathcheck`:

| requisito | serve | c'è | manca |
|---|---|---|---|
| setup emessi (popolazione C) | 100 | **123** | 0 |
| giorni distinti con almeno un setup emesso | 30 | **13** | **17** |
| celle ammissibili (n≥30 e giorni≥10) | ≥1 | **0 su 40** | 40 |

Servono **17 giorni** di emissioni in più. Con il tasso attuale (0.10% di 1932 direzionali
dopo la cesura = 2 setup su 10 giorni) servirebbero circa **85 giorni di mercato** per
tornare a 123+100; con il tasso pre-cesura (3.35%, cioè 6.05 setup/giorno) ne servirebbero
**17**. La differenza fra 17 e 85 giorni è tutta nella cesura: è la ragione per cui la
diagnosi veniva prima del pannello.

## 2. Modulo shadow: cosa è calcolabile e cosa no

`bun scripts/shadow_report.ts` → `artifacts/shadow/shadow_2026-11-12.json`, `schemaVersion: 2`.

### 2.1 Il fatto principale

`src/knowledge/shadowAlgorithms.ts` (716 righe) ha **11 funzioni-algoritmo** e **un solo
consumatore** in tutto il repository: `src/utils/learningValidator.ts`, che ne importa due
(`deflatedSharpeRatio`, `expectancyBootstrap`) come **tipi e funzioni di supporto**, non
come processo. Nessuno script lo esegue. `src/knowledge/ai_knowledge_rules.ts` lo cita solo
in un commento. **Prima di questo passo il modulo non produceva alcun output: era una
libreria, non un processo.** La prova è il file: nessun artefatto lo referenziava, e il test
`knowledge_rules.test.ts:77` verifica che il codice di trading **non** lo importi.

### 2.2 Matrice regola × stato

| id | nome | famiglia | stato | valore | n |
|---|---|---|---|---|---|
| S01 | tripleBarrierLabels | STIMATORE | computed | 0.179 (share UPPER) | 123 |
| S02 | sampleUniquenessWeights | PROTOCOLLO | computed | 0.174 (peso medio) | 123 |
| S03 | purgedKFold | PROTOCOLLO | computed | 3 fold | 123 |
| S04 | deflatedSharpeRatio | CORREZIONE | computed | 0.000 (DSR) | 123 |
| S05 | fractionalKelly | STIMATORE | computed | 0.000 (size) | 123 |
| S06 | cusumEventIndices | FILTRO | computed | 1240 eventi | 27543 |
| S07 | corwinSchultzSpreadProxy | STIMATORE | computed | 0.019% mediana | 9 simboli |
| S08 | amihudIlliquidity | STIMATORE | computed | 0.0012 | 27244 |
| S09 | approximateVolumeBars | STIMATORE | computed | 533 barre | 27543 |
| S10 | isHighProbabilityWindow | FILTRO | computed | 0.252 (share in finestra) | 123 |
| S11 | expectancyBootstrap | PROTOCOLLO | computed | p = 0.0005 | 123 |

Conteggi: `computed = 11`, `insufficient_sample = 0`, `missing_input = 0`,
`not_invocable = 0` — somma **11**. Tutte le regole sono invocabili sui dati presenti;
nessuna è forzata, nessun parametro inventato: i parametri IPOTESI del modulo (barriere
±2%, 48 barre, soglia CUSUM = 10 range mediani, target volume = volume mediano × 78,
finestra EU = 540-599 minuti) sono **quelli già scritti nel modulo** e sono dichiarati
nella `note` di ogni riga.

### 2.3 Le due famiglie di stato

- **CALCOLABILE e informativo**: S06, S09, S10 dicono *quanto spesso* la regola
  guarderebbe; S07, S08 danno ordini di grandezza di spread e illiquidità.
- **CALCOLABILE ma senza potere**: S04 (DSR = 0.000, p = 0.5000), S05 (Kelly = 0), S11
  (p = 0.0005 ma con R **lordo** e meanR negativo). Sono calcolabili perché la serie di R
  esiste; non dicono nulla di positivo perché la serie ha media negativa. **Nessuno dei tre
  cambia la conclusione del registro.**

### 2.4 Limiti di questa sezione (dichiarati)

1. Le 11 regole girano con parametri IPOTESI del modulo, non calibrati: lo stato dice cosa
   è calcolabile, non cosa convenga.
2. S07 è uno stimatore pensato per barre giornaliere applicato a barre da 5 minuti:
   sovrastima per rumore di microstruttura. Il valore 0.019% va letto come ordine di
   grandezza, non come misura.
3. Il confronto spread/parametrico mette a confronto due grandezze diverse: lo stimatore
   misura lo **spread**, la banda 0.10% misura **spread + commissioni**. Con 2 € di
   roundtrip (`BROKER_FEE_PER_SIDE_EUR` = 1.00 × 2) la banda 0.10% corrisponde a circa
   **2000 €** di esposizione: sotto quella size la frizione reale è maggiore, sopra minore.
4. S01-S03 usano le finestre ricostruite da `decisionTs` + 48 barre, non etichette fornite
   dalla pipeline: misurano la regola, non la strategia.
5. Campione: 13 giorni con setup, 5 simboli emessi su 9 in cache, barre a 5 minuti.
6. Il criterio di morte è calcolato da `ai_cycle.ts deathcheck` sulla formula del payoff
   (`k − f`), mentre `shadow_report.ts` usa l'R realizzato (`R − f`): con 0 celle
   ammissibili su 40 entrambi danno `not_yet_evaluable`, e l'accordo è verificato a runtime.
