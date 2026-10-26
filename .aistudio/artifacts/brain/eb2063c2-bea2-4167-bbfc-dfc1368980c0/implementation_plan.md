# Ottimizzazione Sistemica Duale: Separazione Analitica Sessione Europa e Sessione USA

Implementazione della segmentazione quantitativa per mercato (Europa vs USA) all'interno del motore di auto-miglioramento algoritmico, dell'audit dei filtri e del modal di ricalibrazione parametri, preservando il rigore deterministico dei gate G1–G11 (zero mock, zero dati sintetici, 100% feed reale).

---

## User Review & Critical Decisions

> [!IMPORTANT]
> **Decisioni confermate nella fase di chiarimento**:
> - **Visualizzazione Modal**: Navigazione a **Schede Separate** (`Tab Europa` e `Tab USA`) all'interno di `SystemOptimizerModal`, per consentire all'operatore di esaminare la diagnosi e accettare/rifiutare le proposte di calibrazione in modo selettivo e indipendente per ciascun mercato.
> - **Soglia di Attivazione Storica**: **Almeno 5 trade chiusi** registrati nel diario per quello specifico mercato (`market === 'EU'` o `market === 'US'`). Se un mercato conta meno di 5 trade risolti, il motore non genera stime fittizie ma espone lo stato trasparente `DATI_INSUFFICIENTI`, mantenendo inalterati i parametri di base (`TRADING_PARAMS`).

---

## 1. Overview & Core Concept

- **Problema**: L'attuale motore di auto-miglioramento aggrega tutti i trade eseguiti in un unico paniere indistinto. Questa commistione causa distorsioni: stop loss subiti a Wall Street rischiano di inasprire inutilmente i parametri europei della mattina, mentre trade scaduti (Expired) per scarsa estensione europea rischiano di ridurre il target di profitto dei trend americani.
- **Soluzione**: Separare in modo simmetrico l'analisi quantitativa e la generazione delle proposte di ricalibrazione tra **Mercato Europa (EU)** e **Mercato USA (US)**. Ciascuna sessione calcola metriche autonome (Win Rate, Profit Factor, Tasso Expired, P&L netto) e propone modifiche ai soli parametri di competenza (`minScoreEurope` vs `minScoreUSA`, `minGapEurope` vs `minGapUSA`, `minRvolEurope` vs `minRvolUSA`, `target1MultiplierEU` vs `target1MultiplierUS`).
- **Valore per l'Operatore**: Diagnosi chirurgica dei punti deboli specifici per orario e asset class, senza inquinamento incrociato tra le due borse.

---

## 2. User Experience & Visual Design

### Navigazione a Schede nel Modal (`SystemOptimizerModal.tsx`)
1. **Selettore di Mercato Superiore**:
   - Tab **Sessione Europa (09:00 - 11:30 CET)** con badge di stato metriche (es. `5 Trade Analizzati • Win Rate 60%`).
   - Tab **Sessione USA (15:30 - 17:30 CET)** con badge di stato metriche (es. `3 Trade Analizzati • Dati Insufficienti`).
2. **Card Diagnostica Indipendente**:
   - Per ciascuna scheda: riassunto del ciclo (P&L netto in Euro, Profit Factor, % Win, % Loss, % Expired).
   - Elenco dei punti di forza riscontrati e dei colli di bottiglia specifici per quel mercato.
   - Tabella delle variazioni proposte con confronto chiaro: `Valore Attuale` $\rightarrow$ `Nuovo Valore Proposto`, motivazione del trade-off e beneficio atteso.
3. **Pulsante di Approvazione Indipendente**:
   - `Applica Parametri Europa`: aggiorna selettivamente la configurazione europea e ricomputa `DualExecutionHero` EU e tabella EU.
   - `Applica Parametri USA`: aggiorna la configurazione americana e ricomputa `DualExecutionHero` US e tabella US.
   - Nessun'azione incrociata: l'approvazione di una calibrazione europea lascia inalterati i parametri statunitensi.

---

## 3. Key Product Decisions & Trade-Offs

- **Decisione 1: Soglia minima di 5 trade per mercato**:
  - *Scelta*: Per formulare una proposta di calibrazione statistica, il diario deve contenere almeno 5 trade completati per quel mercato specifico.
  - *Perché*: 5 trade è il compromesso ideale tra reattività empirica e affidabilità statistica minima, evitando over-fitting su 1 o 2 trade isolati.
  - *Alternativa scartata*: Valutazione cumulativa (scartata perché generava inquinamento incrociato).
- **Decisione 2: Integrità dei Gate G1–G11**:
  - *Scelta*: I gate G1–G11 continuano a leggere le soglie specifiche dal rispettivo mercato (`minScoreEurope` / `minScoreUSA`).
  - *Perché*: Garantisce che l'ordine sequenziale, la precisione e la conformità al 100% della specifica Fase 1 rimangano inalterati e che tutti i 48 test passino senza modifiche alla logica core.

---

## 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────────────────────┐
│                        TradeJournal (Diario Reale)                     │
│               [Trade 1: EU]  [Trade 2: US]  [Trade 3: EU] ...          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Filtro per market ('EU' | 'US')
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
   ┌──────────────────────────────┐    ┌──────────────────────────────┐
   │    Filtro Trade Europa       │    │      Filtro Trade USA        │
   │    (market === 'EU')         │    │      (market === 'US')       │
   └──────────────┬───────────────┘    └──────────────┬───────────────┘
                  │                                   │
                  ▼                                   ▼
   ┌──────────────────────────────┐    ┌──────────────────────────────┐
   │ evaluateSessionOptimization  │    │ evaluateSessionOptimization  │
   │        (Sessione EU)         │    │        (Sessione US)         │
   │  - Conteggio >= 5 trade      │    │  - Conteggio >= 5 trade      │
   │  - Analisi Win/Loss/Expired  │    │  - Analisi Win/Loss/Expired  │
   │  - Proposte: minScoreEurope, │    │  - Proposte: minScoreUSA,    │
   │    minGapEurope, minRvolEU   │    │    minGapUSA, minRvolUSA     │
   └──────────────┬───────────────┘    └──────────────┬───────────────┘
                  │                                   │
                  └─────────────────┬─────────────────┘
                                    │
                                    ▼
       ┌─────────────────────────────────────────────────────────┐
       │                SystemOptimizerModal (UI)                │
       │    [Tab: Sessione Europa]     [Tab: Sessione USA]       │
       │    [Applica Parametri EU]     [Applica Parametri US]    │
       └────────────────────────────┬────────────────────────────┘
                                    │ handleAcceptProposal(market)
                                    ▼
       ┌─────────────────────────────────────────────────────────┐
       │                    SystemParameters                     │
       │    minScoreEurope, minGapEurope, minRvolEurope          │
       │    minScoreUSA,    minGapUSA,    minRvolUSA             │
       └────────────────────────────┬────────────────────────────┘
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
   ┌──────────────────────────────┐    ┌──────────────────────────────┐
   │  buildExecutionSetup('EU')   │    │  buildExecutionSetup('US')   │
   │   Gate G11 -> minScoreEurope │    │   Gate G11 -> minScoreUSA    │
   └──────────────────────────────┘    └──────────────────────────────┘
```

### Componenti e File Interessati
1. `src/types/radar.ts`:
   - Definizione di `SessionOptimizationProposal` (proposta legata a uno specifico `market: 'EU' | 'US'`).
   - Aggiunta della struttura `DualOptimizationProposals { eu: SessionOptimizationProposal | null; us: SessionOptimizationProposal | null; }`.
2. `src/utils/calculator.ts`:
   - Implementazione di `evaluateSessionOptimization(trades, market, currentParams, minRequiredTrades = 5)`.
   - Aggiornamento di `evaluateSystemOptimization` per restituire le due diagnosi distinte `eu` e `us`.
3. `src/components/SystemOptimizerModal.tsx`:
   - Aggiunta dello switcher a due tab: `Europa` e `USA`.
   - Sezione diagnostica dedicata con badge `DATI INSUFFICIENTI (< 5 trade)` se il campione è ridotto.
   - Pulsanti di azione dedicati per mercato (`Applica modifiche Europa` / `Applica modifiche USA`).
4. `src/App.tsx`:
   - Aggiornamento di `handleAcceptProposal` per accettare il mercato di riferimento e aggiornare in modo atomico le proprietà corrispondenti in `SystemParameters`.
5. `src/utils/__tests__/phase1.test.ts`:
   - Aggiunta di verifiche T49 e T50 per collaudare l'isolamento delle proposte Europa vs USA (zero mock).
