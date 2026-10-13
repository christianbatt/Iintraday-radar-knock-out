# ⚡ Intraday Radar Pro — Terminale di Screening & Execution Dual-Market

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19.x-61dafb.svg?logo=react&logoColor=black)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-v4-38bdf8.svg?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Vite PWA](https://img.shields.io/badge/PWA-Ready-10b981.svg?logo=pwa&logoColor=white)](https://vite-pwa-org.netlify.app/)
[![Google Gemini](https://img.shields.io/badge/AI-Gemini%203.8%20Flash-4285f4.svg?logo=google&logoColor=white)](https://ai.google.dev/)
[![License](https://img.shields.io/badge/License-MIT-slate.svg)](LICENSE)

> **Terminale intraday istituzionale per la selezione, il calcolo e il dimensionamento del rischio su certificati Turbo Knock-Out (Trade Republic) e derivati a leva sui mercati Europeo (EU) e Americano (US).**

---

## ⚠️ Avviso Legale & Natura Dimostrativa (DEMO)

> **IMPORTANTE — NESSUNA CONSULENZA FINANZIARIA**:
> 
> **Christian Battistoni non effettua alcun tipo di consulenza finanziaria**, gestione patrimoniale né sollecitazione al pubblico risparmio. 
> Questa applicazione è **esclusivamente un progetto dimostrativo / demo** sviluppato a scopo tecnologico, educativo e di portfolio software, concepito per illustrare le potenzialità del **Vibe Coding avanzato**, dell'**AI Orchestration** e dell'elaborazione di dati quantitativi in tempo reale.
> 
> Nessun dato, punteggio di screening, livello di Knock-Out o piano operativo generato costituisce raccomandazione o invito a investire denaro reale. Il trading su strumenti a leva (certificati Turbo Knock-Out, CFD) comporta un rischio elevato di perdita integrale del capitale.

---

## 🎯 Panoramica dell'Applicazione

Intraday Radar Pro è un'applicazione web e PWA ad alta intensità tecnologica che elimina l'emotività e l'errore umano nella selezione dei setup di trading intraday. 

Il sistema combina:
1. **Analisi Quantitativa Real-Time**: monitoraggio di gap percentuali, Relative Volume (RVOL), Average True Range (ATR a 14 periodi) e correlazione con i futures benchmark (FDAX, FESX, ES, NQ).
2. **Setup Dual-Market Affiancati**: selezione algoritmica e contestuale del miglior setup per il mercato **Europeo (Top EU)** e per il mercato **Americano (Top US)**, ciascuno calcolato con Trigger d'ingresso, Stop Loss tecnico, Target (1.5R e 2.5R) e calcolo automatico della **Barriera di Knock-Out consigliata** con cuscinetto di sicurezza.
3. **Screening Continuo a Mercati Aperti**: tabella interattiva dei titoli filtrabili per categoria (*Top Gap & Go*, *Alto Volume Relativo*, *Espansione ATR*, *Momentum*).
4. **Analizzatore di Catalizzatori Gemini AI**: modulo di validazione rigorosa che analizza notizie ufficiali e feed finanziari in tempo reale, restituendo un output JSON deterministico (`TRADE` o `NESSUN_TRADE`), evidenziando rischi, invalidazioni e fonti verificate.
5. **Governance di Rischio Integrata**: limite invalicabile di 2 trade al giorno, Circuit Breaker con blocco automatico al raggiungimento del -2% di perdita giornaliera sul capitale, calcolatore di size monetaria e Trade Journal completo.
6. **PWA Offline & Auto-Update**: installabile su smartphone (iOS/Android) e computer (Windows/macOS/Linux), con aggiornamenti automatici in background e avviso di reload immediato.

---

## 💎 Caratteristiche Principali

### 1. Dual-Market Top Execution Cards
- **Schede Affiancate (Top 1 EU & Top 1 US)**: visualizzazione simultanea dei due migliori titoli della sessione, con indicazione chiara del timing (orari CET di contrattazione e pre-market).
- **Livelli Operativi Millimetrici**:
  - Prezzo di Trigger (Breakout / Pre-market High o Low)
  - Stop Loss Tecnico ancorato alla volatilità reale
  - Distanza R e rapporto Rischio/Rendimento (1:1.5 fino a 1:2.5)
  - **Livello Knock-Out Consigliato**: calcolato con una distanza di sicurezza pari a $2.65 \times \text{distanza SL}$ o $1.2 \times \text{ATR}$, per evitare lo stop out prematuro su spike di volatilità.
  - Calcolatore di quote e capitale impegnato in base al rischio massimo per operazione impostato dall'utente (es. 1% del conto).

### 2. Dati Reali al 100% (Zero Mock, Zero Hardcoded)
- Dati storici e intraday sincronizzati direttamente dai mercati borsistici mondiali (XETRA, Euronext, Piazza Affari, NYSE, Nasdaq).
- Monitoraggio live dei futures di riferimento:
  - **FDAX** (DAX Futures)
  - **FESX** (EuroStoxx 50 Futures)
  - **ES** (E-Mini S&P 500)
  - **NQ** (E-Mini Nasdaq 100)
- Feed notizie aggregate in tempo reale tramite Google News Financial RSS e fallback Finnhub.

### 3. Rigore dell'Analisi Catalizzatori (Gemini 3.8 Flash)
Il modello opera secondo vincoli etici e professionali ferrei:
- **Nessuna invenzione**: valuta esclusivamente dati e notizie fornite dal feed.
- **Rifiuto del trade ambiguo**: se le notizie mancano, sono datate o contraddittorie, risponde tassativamente `"NESSUN_TRADE"` motivando la causa.
- **Formato JSON strutturato**:
  ```json
  {
    "decisione": "TRADE",
    "direzione": "LONG",
    "catalizzatore": "Guidance rialzista e trimestrale sopra le attese",
    "punti_a_favore": ["Forte gap rialzista confermato da volumi istituzionali", "Catalizzatore fresco pubblicato da meno di 2 ore"],
    "rischi": ["Resistenza tecnica sul massimo della settimana precedente"],
    "condizioni_invalidazione": "Rientro del prezzo sotto il VWAP di sessione",
    "fonti": ["Reuters", "Bloomberg"]
  }
  ```

### 4. PWA Installabile con Aggiornamenti Silenziosi
- Configurato con `vite-plugin-pwa` e strategia `registerType: 'autoUpdate'`.
- Icone maskable e standard conformi alle specifiche W3C.
- Il service worker controlla automaticamente le nuove release e notifica all'utente la disponibilità del nuovo codice con un click.

### 5. Performance Summary & Visual Analytics (Recharts)
- **Trend P&L Cumulato**: grafico ad area interattivo con progressione del capitale netto (€ e %), baseline iniziale e indicazione dei drawdown.
- **Distribuzione R-Multiple**: istogramma delle frequenze per scaglioni di rendimento effettivo (`<-1.5R`, `-1R`, `0R BE`, `+1R`, `+2R`, `>2.5R`).
- **Metriche Quantitative di Performance**: Calcolo automatico dell'Aspettativa Statistica (EV in R per trade), Profit Factor, Win Rate, Max Drawdown, media guadagni vs perdite e selezione automatica del Best/Worst Trade.
- **Vista Tripla Flessibile**: passaggio istantaneo tra "Performance Summary" (grafici Recharts), "Registro Esecuzioni" (tabella dettagliata) e "Vista Completa" per desktop terminal.

---

## 🔒 Sicurezza & Gestione API Keys

Per garantire la massima sicurezza nella pubblicazione su repository pubbliche GitHub:
- **Nessuna API key è hardcodata nel codice sorgente**.
- Tutte le variabili sensibili sono protette dal `.gitignore`:
  ```gitignore
  node_modules/
  dist/
  .env*
  !.env.example
  ```
- Tutte le chiamate verso provider esterni avvengono tramite il backend proxy (`server.ts`), evitando l'esposizione di token nel browser.

---

## 🚀 Guida all'Installazione & Avvio Locale

### Prerequisiti
- **Node.js** versione 18.0.0 o superiore
- **npm** o **bun**

### 1. Clonare la Repository
```bash
git clone https://github.com/christianbattistoni/intraday-radar.git
cd intraday-radar
```

### 2. Configurare le Variabili d'Ambiente
Copia il file di esempio `.env.example` in `.env`:
```bash
cp .env.example .env
```

Modifica `.env` inserendo la tua chiave Google Gemini (e opzionalmente Finnhub):
```env
# Google Gemini API Key (per l'analisi AI del catalizzatore)
GEMINI_API_KEY="la_tua_gemini_api_key"

# Opzionali (se omessi, l'app usa il motore finanziario integrato con cache)
FINNHUB_API_KEY=""
TWELVEDATA_API_KEY=""
```

### 3. Installare le Dipendenze
```bash
npm install
```

### 4. Avviare l'Applicazione in Locale
```bash
npm run dev
```
L'applicazione sarà accessibile all'indirizzo: **`http://localhost:3000`**.

### 5. Compilazione per la Produzione
```bash
npm run build
```

---

## 🛠️ Stack Tecnologico

| Componente | Tecnologia | Ruolo |
|---|---|---|
| **Frontend** | React 19 + TypeScript | Interfaccia utente interattiva e tipizzata |
| **Styling** | Tailwind CSS v4 | Design moderno in dark mode istituzionale |
| **Backend & Proxy** | Node.js + Express + tsx | Proxy server per dati di mercato, RSS e AI |
| **AI Engine** | Google Gemini 3.8 Flash (`@google/genai`) | Valutazione rigorosa del catalizzatore e rischi |
| **PWA & Offline** | `vite-plugin-pwa` + Workbox | Installazione desktop/mobile e auto-update |
| **Icone** | Lucide React | Iconografia tecnica di borsa |

---

## 👨‍💻 Sviluppatore & Creator

### **Christian Battistoni**
*AI Orchestrator • AI Prompt Engineer • Vibe Coding Specialist*

Specializzato nella progettazione e realizzazione di applicazioni software ad alte prestazioni attraverso metodologie avanzate di **Vibe Coding**, orchestrazione di agenti AI, integrazione di Large Language Models (LLM) di ultima generazione e sistemi quantitativi in tempo reale.

- 🌐 **Specializzazioni**:
  - Full-Stack Vibe Coding & Rapid Prototyping
  - AI Orchestration & Multi-Model Workflow Architecture
  - Advanced Prompt Engineering & Structured Reasoning
  - FinTech & Quantitative Intraday Systems
  - Progressive Web Applications (PWA) & Cloud Deployments
- ✉️ **Contatto Diretto Email**: [christian.battistoni.eu@gmail.com](mailto:christian.battistoni.eu@gmail.com)

> 💡 *All'interno dell'applicazione è presente un pulsante interattivo **"Creator & Info"** con modulo di contatto diretto per richiedere collaborazioni, sviluppo di soluzioni personalizzate con Vibe Coding o informazioni tecniche sui progetti.*

---

## 📜 Licenza

Questo progetto è distribuito sotto licenza **MIT**. Consulta il file `LICENSE` per ulteriori dettagli.
