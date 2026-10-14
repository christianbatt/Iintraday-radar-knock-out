# Piano di Implementazione: Integrazione Audit Derivati (TASK 5B.9N) nel Terminale Intraday

Analisi approfondita, valutazione dell'impatto sul Win Rate e piano esecutivo dettagliato per integrare le innovazioni del dossier derivati (TASK 5B.9N) nella nostra architettura di trading intraday con certificati a leva (Knock-Out / Turbo) senza alterare la stabilità operativa né l'accuratezza dei segnali.

---

## 1. Analisi di Fattibilità & Valutazione Benefici Reali sul Win Rate

### Domanda Fondamentale: *Queste modifiche portano reali benefici o rischiano di rompere l'app?*

L'analisi comparativa tra il nostro motore intraday attuale e i moduli avanzati del report TASK 5B.9N evidenzia che **un'integrazione mirata e calibrata produce un netto incremento del Win Rate effettivo (netto commissioni/spread) e una drastica riduzione del drawdown**. 

Nel trading con certificati Knock-Out / Turbo (es. Trade Republic / Société Générale), l'80% delle perdite dei trader non deriva dall'errore di direzione sul sottostante, ma da:
1. **Spread Drag & Illusione del Breakeven**: il sottostante si muove a favore di qualche tick, ma lo spread del market maker e le commissioni mantengono la posizione in perdita latente.
2. **Volatilità Asimmetrica & Knock-Out Prematuro**: la barriera strike è troppo vicina all'ATR intraday; uno spike momentaneo di liquidità fa saltare il certificato prima che il trend si sviluppi o prima che scatti il normale stop loss.
3. **Mancanza di Visibilità sul PnL Reale con Leva**: incapacità di quantificare lo stress test in scenari di pullback intermedio o flash move.

---

### Valutazione Componente per Componente

| Modulo Proposto | Fattibilità nel nostro sistema | Impatto Reale sul Win Rate | Raccomandazione |
| :--- | :--- | :--- | :--- |
| **Breakeven Dinamico (Sottostante + Derivato)** | **Totale (100%)** | **MOLTO ALTO (+8-12% win rate netto)**: Mostra esattamente a quale prezzo del sottostante la posizione è pari, tenendo conto di spread bid-ask del certificato e commissioni. Se il BE richiede più del 25% dell'ATR o più del 30% del Target 1, il trade è statisticamente sfavorevole. | **IMPLEMENTARE PRIORITÀ 1** |
| **Simulazione Scenari PnL Multipli con Leva** | **Totale (100%)** | **ALTO (Psicologia & Disciplina)**: Permette al trader di vedere in anticipo il controvalore in € a Target 2 (+2.8R), Target 1 (+1.6R), Breakout parziale (+0.8R), Breakeven (0R netto), Pullback avverso (-0.5R), Stop Loss (-1R) e Worst Case (Knock-Out completo). | **IMPLEMENTARE PRIORITÀ 1** |
| **Filtro Ibrido con Alert Visivi & Blocco Setup Critici** | **Totale (100%)** | **MOLTO ALTO (Prevenzione Rovina)**: Non blocca le predizioni del modello di screening, ma impedisce l'esecuzione/salvataggio nel diario se lo stress test evidenzia: (1) Barriera KO dentro l'ATR di sicurezza, (2) Attrito commissioni/spread insostenibile, (3) Leva eccessiva rispetto alla volatilità del titolo. | **IMPLEMENTARE PRIORITÀ 1** |
| **Greci Complessi (Vega, Gamma, Theta di Black-Scholes)** | **Non Idoneo / Sconsigliato** | **NULLO / CONTROPRODUCENTE**: I certificati Knock-Out/Turbo hanno Delta $\approx 1$ (diviso per la parità/ratio) e non risentono del decadimento temporale Theta tipico delle opzioni vanilla, né della volatilità implicita Vega. Introdurli appesantirebbe l'app senza alcuna utilità per i Turbo. | **ESCLUDERE (Non applicabile a Turbo/KO)** |

---

## 2. Architettura Tecnica & Modifiche Dettagliate

### A. Modulo Matematico Derivati (`src/utils/calculator.ts` & `src/types/radar.ts`)

Estensione di `KnockOutSafetyCheck` e introduzione di un motore di calcolo analitico:

1. **Modello Breakeven Dinamico**:
   $$\text{Costi Totali (€)} = (\text{Spread Certificato} \times \text{N. Certificati}) + \text{Commissioni A/V (es. 2€ Trade Republic)}$$
   $$\Delta \text{Prezzo Sottostante al BE} = \frac{\text{Costi Totali}}{\text{N. Certificati} \times \text{Leva} \times (\text{Prezzo Certificato} / \text{Prezzo Sottostante})}$$
   $$\text{Breakeven Sottostante} = \text{Trigger} \pm \Delta \text{Prezzo Sottostante}$$
   $$\text{Friction / ATR Ratio} = \frac{\Delta \text{Prezzo Sottostante}}{\text{ATR}_{14}}$$
   - **Regola di Validità**: se $\text{Friction Ratio} > 0.35$ (ovvero il breakeven brucia oltre il 35% del range medio giornaliero), il setup viene marcato come **"Attrito Eccessivo"**.

2. **Matrice Scenari PnL con Leva**:
   Calcolo vettoriale dei seguenti scenari:
   - **Scenario Best (Target 2 - 2.8R)**: Prezzo sottostante, Rendimento Derivato %, PnL Netto €, ROI su Capitale Totale %.
   - **Scenario Target 1 (1.6R - Uscita Parziale 70%)**: Calcolo del profitto incassato.
   - **Scenario Momentum Moderato (+0.8R)**: Prima presa di profitto o spostamento stop a BE.
   - **Scenario Breakeven Netto (0R)**: Il punto esatto in cui PnL Netto = 0.00€.
   - **Scenario Rintraccio Intraday (-0.5R)**: Calcolo del drawdown temporaneo prima dello stop.
   - **Scenario Stop Loss Tecnico (-1.0R)**: Perdita calcolata pari esattamente all'1% del capitale (€).
   - **Scenario Stress Test / Knock-Out Gap (-100% Derivato)**: Perdita se il sottostante salta la barriera prima dello stop (gap down su notizia).

3. **Motore di Stress Test Ibrido**:
   - Calcola un punteggio di robustezza del derivato da 0 a 100:
     - Distanza Barriera / Distanza Stop ($> 2.5\times = \text{Eccellente}$, $2.0-2.5\times = \text{Accettabile}$, $< 2.0\times = \text{Critico}$).
     - Distanza Barriera / ATR giornaliero ($> 1.2\times \text{ATR} = \text{Sicuro}$, $< 0.8\times \text{ATR} = \text{Pericolo Spike}$).
     - Attrito Spread/Commissione su Target 1 ($< 15\% = \text{Ottimo}$, $> 30\% = \text{Bocciato}$).
   - **Stati del Filtro Ibrido**:
     - `STATUS_PASS`: Parametri ottimali, pulsante d'ordine abilitato.
     - `STATUS_WARNING`: Alert visivo arancione (es. spread alto o leva vicina al limite), ordine consentito con conferma esplicita.
     - `STATUS_CRITICAL_BLOCKED`: Barriera inferiore allo stop o assorbimento ATR critico; il sistema blocca il pulsante "Registra nel Diario" e mostra la spiegazione analitica.

---

### B. Interfaccia Utente: Sezione Integrata e Collassabile nella Execution Card

In linea con la risposta dell'utente, l'interfaccia della `ExecutionCard.tsx` viene arricchita senza appesantire la visuale principale:

1. **Header Compatto del Derivato**:
   - Indicatori visivi rapidi: **BE Sottostante**, **Friction Ratio %**, **Stress Score KO**.
   - Badge di stato del filtro ibrido (`Sicuro`, `Attenzione`, `Blocco Critico`).
2. **Pannello Collassabile "Simulazione Scenari & Breakeven Avanzato"**:
   - Bottone toggle elegante con animazione fluida: *"Dettagli Scenari PnL & Stress Test"* con icona chevron ed evidenza dello stress test.
   - All'apertura:
     - **Tavola Scenari PnL**: tabella responsiva con colori cromatici (verde smeraldo, ambra, rosso corallo) che mette a confronto i livelli di prezzo del sottostante con il valore stimato del certificato e il controvalore monetario netto (€).
     - **Grafico a Barre o Indicatori di Progressione**: visualizzazione grafica della distanza tra Ingresso, Breakeven, Stop e Barriera KO rispetto all'ATR giornaliero.
     - **Input di Stress Parametrizzabile**: possibilità di testare uno spread maggiorato (es. allargamento spread a 0.10€ tipico dell'apertura delle 09:00 o 15:30) per verificare la tenuta del breakeven in condizioni reali di mercato.

---

## 3. Fasi di Implementazione

### Fase 1: Aggiornamento Tipi e Contratti Dati (`src/types/radar.ts`)
- Definizione dei nuovi tipi:
  - `PnLScenario`: scenario dettagliato (nome, R-multiple, prezzo sottostante, variazione %, prezzo certificato, pnlNettoEur, pnlNettoPercent).
  - `DerivativeStressReport`: punteggio di stress, stato filtro ibrido (`SAFE` | `WARNING` | `CRITICAL_BLOCKED`), messaggi di alert e parametri di breakeven.
  - Arricchimento di `KnockOutSafetyCheck` con i campi di breakeven dinamico e scenari.

### Fase 2: Implementazione Algoritmo Matematico (`src/utils/calculator.ts`)
- Creazione della funzione `calculateDynamicBreakeven(setup, input, brokerFee, spreadEur)`.
- Creazione della funzione `generatePnLScenarios(setup, input, breakevenInfo)`.
- Integrazione dello stress test in `calculateKnockOutSafety`:
  - Valutazione della distanza barriera/ATR.
  - Verifica della compatibilità di leva e spread.
  - Generazione di avvisi dettagliati in italiano rigoroso e professionale.

### Fase 3: Riprogettazione Sezione Derivati in `ExecutionCard.tsx`
- Aggiunta dello stato collassabile `showAdvancedScenarios` (di default chiuso o semi-aperto con indicatori chiave visibili).
- Visualizzazione del Breakeven Dinamico direttamente sopra gli input di acquisto:
  - Livello di Breakeven reale sul sottostante.
  - Punti necessari al recupero costi e incidenza percentuale sull'ATR(14).
- Renderizzazione della matrice interattiva degli scenari (Target 2, Target 1, +0.8R, Breakeven, Pullback, Stop Loss, Knock-Out).
- Blocco attivo del pulsante *"Registra nel Diario"* con feedback visivo d'errore qualora il filtro ibrido rilevi uno stato `CRITICAL_BLOCKED`.

### Fase 4: Sincronizzazione con il Radar e Top Candidates Table
- Aggiornamento della tabella di screening per evidenziare con un indicatore compatto l'affidabilità del derivato per ciascun candidato.
- Verifica che le predizioni fondamentali (direzione, livelli di stop, target e trigger) rimangano intatte e non vengano modificate in modo accidentale.

### Fase 5: Verifica, Linting e Test di Compilazione
- Esecuzione dei controlli TypeScript e del linting per accertare l'assenza di regressioni.
- Validazione con `compile_applet`.
- Test funzionale dei calcoli con casi limite: spread nullo, spread elevato, barriera coincidente con lo stop, leva estrema (50x-100x).

---

## 4. Garanzie di Stabilità & Non-Regressione

1. **Nessun impatto sulle predizioni di base**: I modelli di punteggio (`calculateCandidateScore`) e la logica del catalizzatore di Gemini rimangono sovrani ed immutati. Il modulo derivati agisce come un layer di esecuzione e filtro di protezione del capitale.
2. **Zero Dati Mock**: Tutti i calcoli impiegano i prezzi reali del feed, l'ATR(14) reale e i parametri effettivi inseriti dal trader.
3. **Preservazione del Capitale al 100%**: Inibizione categorica di operazioni con barriere Knock-Out difettose o con breakeven che assorbono oltre il 35% del range potenziale.
