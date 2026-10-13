# Piano di Implementazione: Terminale Intraday Professionale Dual-Market (EU & USA) & PWA

Miglioramento e potenziamento architetturale del terminale di trading intraday con leva per certificati Knock-Out (Trade Republic), eliminando l'errore umano e integrando le migliori pratiche dei trader sistematici intraday (Gap & Go, RVOL istituzionale, VWAP intraday, ATR-calibrated stop loss e catalizzatore certificato).

---

## 1. Architettura Funzionale & Motore Operativo

### A. Selezione Top Setup Dual-Market (Europa & USA)
- **Top Pick Europa**: algoritmo dedicato al mercato europeo (07:30 - 17:35 CET), correlato a FDAX e FESX (Euro Stoxx 50).
- **Top Pick USA**: algoritmo dedicato al mercato statunitense (10:00 - 22:05 CET pre-market e regular session), correlato a ES (S&P 500) e NQ (Nasdaq 100).
- **Dual Hero Execution Cards**: visualizzazione affiancata desktop (o a scorrimento verticale ergonomico su mobile) delle due migliori operazioni assolute con:
  - Ticker, borsa reale, prezzo tick live e valuta (EUR / USD)
  - Direzione univoca (LONG / SHORT) basata su coerenza gap + indice futures + catalizzatore
  - Prezzo di ingresso calcolato (rottura primo pullback/breakout)
  - Stop Loss Anti-Rumore ($0.5 \times \text{ATR}_{14}$) e Stop Conservativo ($0.75 \times \text{ATR}_{14}$)
  - Livello Barriera Knock-Out Trade Republic con calcolo della distanza minima di sicurezza ($> 2.5 \times$ distanza stop)
  - Target Take-Profit a $R:R = 2.0$ e $R:R = 3.0$
  - Dimensionamento posizione in quote/euro calcolato sul rischio fisso in capitale (€ o %)
  - Checklist di invalidazione tecnica immediata

### B. Intraday Live Radar (Mercati Aperti Durante la Giornata)
- Sezione dedicata agli altri titoli monitorati nel paniere, con screening continuo in tempo reale:
  - **Filtri rapidi a switch istantaneo**: Tutti, Solo Europa, Solo USA, Solo con Catalizzatore Confermato, Momentum Forte (RVOL > 1.5).
  - Indicatori quantitativi avanzati visibili: Gap %, RVOL intraday stimato, Volatilità ATR(14) %, Distanza da Massimi/Minimi di ieri, Coerenza con Futures Indice.
  - Possibilità di caricare qualsiasi candidato secondario nel Calcolatore Knock-Out con un singolo tocco.

### C. Motore di Analisi del Catalizzatore & Riconoscimento News
- Rilevazione rigorosa delle fonti giornalistiche certificate (Finnhub, Google News RSS, agenzie di stampa).
- Classificazione del tipo di catalizzatore: Utili/Trimestrale (con avviso rischio spread), Revisione Target/Rating istituzionale, Contratti/Ordini industriali, M&A/Partnership.
- Regola aurea: in assenza di un catalizzatore verificabile e coerente, l'app dichiara `NESSUN_TRADE` e inibisce l'ingresso forzato.

---

## 2. Esperienza Utente & Design System (Frontend Constitution)

- **Layout Responsive & Viewport Presence**:
  - Desktop ($> 1024\text{px}$): Grid a due colonne per le due Hero Card operative (Top EU e Top USA), seguite dalla tabella densa del Live Radar e dal Calcolatore di Rischio KO.
  - Mobile ($375\text{px} - 768\text{px}$): Touch target $\ge 44\text{px}$, bottom bar o sticky action bar per il calcolo del rischio, card a scorrimento verticale con gerarchia chiara, nessun layout rotto né scroll orizzontale non voluto.
- **Disciplina Tipografica & Zero-Slop**:
  - Cifre tabulari con spaziatura fissa (`tabular-nums font-mono`) per tutti i prezzi, tick, percentuali e livelli di stop per evitare layout jitter durante gli aggiornamenti live.
  - Nessun badge statico decorativo o pillola inutile: metadati puliti con separatori tipografici sottili (`·`, `/`).
  - Contrasti ad alta leggibilità conformi a WCAG AA per operare all'aperto o su schermi a luce diurna.

---

## 3. PWA (Progressive Web App) & Aggiornamenti Silenziosi in Background

- **Installabilità Completa (Mobile & Desktop)**:
  - Configurazione `vite-plugin-pwa` con `registerType: 'autoUpdate'`.
  - Web App Manifest standard (`manifest.webmanifest`) con `name: "Intraday Radar"`, `short_name: "Intraday"`, `display: "standalone"`, `theme_color: "#0f172a"`, `background_color: "#020617"`.
  - Icone PWA conformi in formato SVG ad alta definizione e PNG per icone standard (192x192, 512x512) e maskable per Android, oltre ad `apple-touch-icon` per iOS.
- **Aggiornamento Istantaneo in Background con Notifica**:
  - Service Worker registrato che rileva automaticamente quando viene pubblicata una nuova versione.
  - Quando il nuovo Service Worker si attiva in background (`skipWaiting` e `clientsClaim`), l'app mostra una notifica toast elegante: *"Nuova versione disponibile"* con pulsante *"Aggiorna ora"* che ricarica l'app senza doverla disinstallare o riscaricare dal browser.
  - In-app Install Prompt per guidare l'utente all'installazione su Chrome/Edge (pulsante "Installa App") e su Safari iOS (istruzioni native "Aggiungi a schermata Home").

---

## 4. Piano di Rilascio e Fasi di Implementazione

1. **Fase 1: Configurazione PWA & Service Worker**
   - Installazione `vite-plugin-pwa` e configurazione in `vite.config.ts`.
   - Creazione icone vettoriali e raster ad alta risoluzione in `/public/icons/`.
   - Implementazione del listener del Service Worker con banner di auto-aggiornamento e pulsante di installazione nativo.

2. **Fase 2: Motore di Screening Dual-Market & Algoritmo di Selezione Top EU & Top USA**
   - Ottimizzazione di `rankTopCandidates` in `src/utils/calculator.ts` per calcolare separatamente il miglior candidato per l'Europa (`topCandidateEU`) e per gli USA (`topCandidateUS`).
   - Raffinamento dell'analisi catalizzatori e correlazione con i futures rispettivi (DAX/EuroStoxx vs S&P500/Nasdaq).

3. **Fase 3: UI Dual Hero Execution Cards & Switch Radar**
   - Creazione del componente `DualExecutionHero.tsx` con le due schede affiancate (Top EU e Top USA) provviste di livelli di KO, stop loss e ratio R:R.
   - Perfezionamento dei controlli di screening (`ScreeningControls.tsx`) per switchare con transizioni fluide tra Sessione Europa, Sessione USA e Vista Combinata.

4. **Fase 4: Tabella Radar Intraday per i Titoli Aperti Durante la Sessione**
   - Visualizzazione dei titoli secondari con metriche in tempo reale, filtri per mercato e alert di setup.
   - Calibrazione rapida dello stop-loss e caricamento nel calcolatore Trade Republic.

5. **Fase 5: Validazione e Test**
   - Test del flusso PWA e dell'aggiornamento automatico.
   - Verifica di linting TypeScript e compilazione build di produzione.
