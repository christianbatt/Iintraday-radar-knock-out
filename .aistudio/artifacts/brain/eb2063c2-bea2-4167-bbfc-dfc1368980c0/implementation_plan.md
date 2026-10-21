# Resoconto Esecutivo: 5 Migliorie di Qualità, Precisione e Win-Rate (100% Dati Reali)

Implementazione completata nel terminale intraday per elevare la precisione e il win-rate operativo sui certificati Turbo Knock-Out, preservando la generazione costante dei setup Top 1 EU e Top 1 US tramite Confluenza Ponderata (senza filtri binari distruttivi).

---

## 1. Architettura delle 5 Migliorie Implementate

### 1. Confluenza Trend Macro Giornaliero (EMA 20 Daily)
- **Logica**: Nel calcolo dello score di candidatura, il prezzo di mercato reale viene confrontato con l'EMA(20) giornaliera reale (calcolata su 20 candele daily chiuse dal feed Yahoo Finance).
- **Punteggio**: Assegna un bonus fino a +8pt per i titoli allineati al trend macro (Long sopra EMA20 o Short sotto EMA20) e applica prudenza (+2pt) per titoli in contro-tendenza, senza mai escludere a priori un'opportunità valida.
- **Badge Visivo**: Nella card operativa viene mostrato l'indicatore in tempo reale `"Confluenza Trend Daily EMA(20): Allineato Rialzista/Ribassista"`.

### 2. Valutazione della Freschezza del Catalizzatore News
- **Logica**: L'analizzatore parsa il timestamp effettivo di pubblicazione delle notizie verificate:
  - Notizie fresche (< 4 ore): **+15pt** (massimo impulso catalizzatore intraday).
  - Notizie di seduta (4 - 12 ore): **+10pt**.
  - Notizie pregresse (> 12 ore): **+6pt** (catalizzatore parzialmente assorbito).
  - Setup puramente tecnico/momentum (nessuna notizia straordinaria): **0pt bonus** (nessuna penalità o esclusione ingiustificata).

### 3. Stop Loss Strutturale Protetto su Minimi/Massimi e VWAP
- **Logica**: Invece di un calcolo rigidamente fisso su frazioni di ATR, lo stop loss viene ancorato ai livelli strutturali di prezzo della seduta corrente:
  - **Setup LONG**: ancorato sotto il `todayLow` (minimo reale di seduta) o sotto il `vwap` intraday con un cuscinetto protettivo anti-caccia del **0.2%** (se distante tra 0.3x e 1.8x del rischio normale).
  - **Setup SHORT**: ancorato sopra il `todayHigh` (massimo reale di seduta) o sopra il `vwap` intraday con un cuscinetto del **+0.2%**.
  - In assenza di estremi consolidati, fallback su ATR(14) 0.5x.
- **Adeguamento Dinamico**: Ricalibra Target 1 (+1.6R), Target 2 (+2.8R) e Barriera Knock-Out protetta sulla base della reale distanza di rischio strutturale.

### 4. Tracking delle Fasi Operative ORB a 15 Minuti (Timezone CET)
- **Logica**: Traccia in tempo reale la finestra oraria della sessione europea (apertura 09:00 CET, range 09:15 CET, cutoff 11:30 CET) e americana (apertura 15:30 CET, range 15:45 CET, cutoff 17:30 CET):
  - **Fase 0 - Pre-Market Monitoring**: Monitoraggio book e volumi pre-apertura.
  - **Fase 1 - Formazione Range 15m**: Prime candele in corso; segnalazione visiva ambra pulsante di non anticipare prima del consolidamento del range.
  - **Fase 2 - Finestra Operativa Attiva**: Esecuzione autorizzata alla rottura confermata del trigger con volumi e VWAP a favore.
  - **Cutoff Raggiunto**: Finestra primaria terminata per prevenire chop e falsi breakout.

### 5. Sincronizzazione Multi-Device Firebase & Continuità Operativa
- **Sincronizzazione Real-Time**: Tutti i trade registrati a giornale da PC desktop, tablet o smartphone vengono sincronizzati istantaneamente sul database cloud Firebase Firestore. Ogni dispositivo condivide lo stesso stato.
- **Raggiungimento dei 2 Trade Giornalieri**: Al completamento dei 2 trade limite, il radar non si blocca ma attiva la modalità osservazione/monitoraggio continuo, continuando a tracciare i prezzi live dei trade salvati e a segnalare nuovi setup senza forzature.

---

## 2. Garanzia Rigorosa: 100% Dati Reali & Zero Mock

- Tutti i parametri derivano da feed reali: Yahoo Finance (prezzi, chiusure storiche, gap, volume, ATR, EMA20), Finnhub API (notizie e sentiment), e Google News RSS.
- Nessun dato simulato o hardcoded.
- Compilazione e linting verificati con successo.
