# Piano: Integrazione FinanceCalendar API & Precisione Temporale Radar

Integrazione del feed economico reale di **FinanceCalendar.com** per la rilevazione affidabile dei market mover macroeconomici (USA, Germania, Italia, Francia, Eurozona), rimozione degli eventi fittizi nei giorni non di contrattazione (es. domenica) e sincronizzazione rigorosa del calendario operativo intraday (orari di sessione, weekend e blackout dinamico per certificati Knock-Out).

---

## Decisioni Utente Confermate (Fase 1)

> [!IMPORTANT]
> **Scelte operative confermate dall'utente per la gestione temporale e macro:**
> - **Gestione Weekend & Festività**: Blocco rigoroso dell'operatività durante i weekend e giorni di borsa chiusa. L'interfaccia mostrerà esplicitamente lo stato di **MERCATO CHIUSO** con countdown verso la riapertura della prossima sessione utile.
> - **Aree Geografiche Macro**: Monitoraggio focalizzato su **Stati Uniti** (`US`) ed **Eurozona** (`DE`, `IT`, `FR`, `EU`).
> - **Finestra di Blackout Knock-Out**: **Dinamica al 100%**, calcolata unicamente in presenza di eventi reali ad alto impatto (`HIGH` / `EXTREME`) a calendario per la giornata odierna, con finestra di protezione attiva da 15 minuti prima a 15 minuti dopo il rilascio effettivo.

---

## 1. Panoramica & Obiettivo del Progetto

### Il Problema Attuale
1. **Eventi Macro Fittizi nel Weekend**: L'endpoint `/api/macro-calendar` restituiva un elenco cablato fisso di eventi (CPI, Tassi Fed, ECB) anche di domenica o nei giorni festivi, provocando falsi allarmi e disallineamenti con i calendari reali delle banche centrali e degli istituti statistici.
2. **Finestre di Blackout Fisse e Statiche**: La funzione `getMacroBlackoutStatus` in `src/utils/calculator.ts` attivava lo stato di blackout ad orari prefissati (14:15–14:45 e 19:45–20:30 CET) basandosi unicamente sull'orologio, anche quando nessun dato macro era previsto per la sessione o nei giorni di mercato chiuso.
3. **Gestione Orari e Date Weekend**: L'orologio di sessione (`getCETTime` in `server.ts`) calcolava i minuti intraday senza verificare `dayOfWeek` (0 per domenica, 6 per sabato), segnalando sessioni aperte (`isEuropeLive: true`, `isUSALive: true`) anche nel fine settimana.

### La Soluzione
- Integrazione server-side dell'API gratuita **FinanceCalendar.com** (`https://www.financecalendar.com/wp-json/fc/v1/calendar` e `/today`).
- Caching intelligente in memoria sul server (TTL di 30 minuti con refresh automatico pre-market) per garantire massima reattività e rispettare il limite gratuito di 2.000 chiamate/giorno per IP senza necessità di chiavi API.
- Riconoscimento solido dei giorni festivi e weekend tramite `dayOfWeek` e orari ufficiali di borsa (Xetra, Borsa Italiana, Euronext, NYSE, Nasdaq).
- Generazione automatica dei blackout solo per eventi reali di giornata catalogati con impatto elevato (`high`/`extreme`) nei paesi selezionati.

---

## 2. Esperienza Utente & Design Visivo

### Flussi Utente Principali

1. **Stato Weekend / Borsa Chiusa (Sabato & Domenica)**:
   - L'hero bar superiore mostra badge chiaro: `MERCATO CHIUSO (Weekend)` con indicazione della prossima apertura (`Lunedì ore 08:00 CET per Pre-Market EU`).
   - La schermata non genera falsi segnali di trading orari né avvisi di blackout inesistenti.
   - Il banner degli eventi macro segnala: `Nessun market mover ad alto impatto programmato per oggi` oppure, se consultata la settimana, mostra l'anteprima degli appuntamenti principali da lunedì a venerdì.

2. **Sessione Feriale con Evento Reale Programmato**:
   - Se ad esempio alle 14:30 CET è previsto il CPI USA, la tabella market mover mostra l'evento reale con valuta `USD`, impatto `HIGH`, orario effettivo e fonte istituzionale.
   - Alle 14:15 CET scatta la notifica visiva: `Blackout Knock-Out: Rilascio US CPI alle 14:30 CET (+/- 15m). Spread allargati e divieto nuovi ingressi`.
   - Alle 14:45 CET il blackout si spegne automaticamente e il trading torna regolare.

3. **Sessione Feriale Senza Eventi HIGH**:
   - Nessun blocco immotivato dell'operatività intraday. Il banner conferma: `Calendario Macro Regolare: Nessun rilascio critico oggi`.

### Identità Visiva & Visual Discipline
- **Tabular Numerals**: Orari di rilascio, countdown e impatti formattati rigorosamente con `font-mono tabular-nums`.
- **Zero-Pill Discipline**: Indicatori temporali puliti e leggibili con separatori discreti (`14:30 CET · USD · Alta Volatilità`), eliminando capsule colorate ridondanti.
- **Palette Tematica**: Slate neutro (`#0F172A`), accenti ambra (`#D97706`) riservati esclusivamente alla finestra di blackout attiva, e verde scuro/blu per le sessioni regolari.

---

## 3. Decisioni Tecniche Chiave & Trade-Offs

| Decisione | Soluzione Scelta | Motivazione & Trade-Off |
|---|---|---|
| **Punto di Chiamata API** | Server Express (`server.ts` proxy `/api/macro-calendar`) | Evita problemi di CORS dal browser, isola l'IP del server e protegge la quota di 2.000 chiamate/giorno con cache condivisa tra tutte le sessioni utente. |
| **Strategia di Caching** | Cache in memoria sul server con TTL 30 minuti | Le pubblicazioni macro della giornata non cambiano ogni secondo. Una cache di 30m riduce le chiamate esterne a ~48 al giorno, ampiamente sotto il limite di 2.000. |
| **Fallback di Rete** | Se l'API esterna è irraggiungibile o va in timeout (3s), fallback sicuro a lista vuota | Evita il blocco dell'applicazione; registra errore nel server log senza inventare dati fasulli. |
| **Rilevamento Weekend** | Verifica `dayOfWeek === 0 || dayOfWeek === 6` in ora locale di Roma/New York | Risolve all'origine il bug segnalato dall'utente il 1° novembre. |
| **Blackout Dinamico** | Calcolato a runtime confrontando l'ora CET corrente con gli orari degli eventi reali di giornata | Addio finestre statiche fisse: il blackout scatta solo se l'evento è oggi e solo tra `[time - 15m, time + 15m]`. |

---

## 4. Architettura Tecnica & Diagramma di Sistema

```
┌────────────────────────────────────────────────────────────────────────┐
│                          ARCHITETTURA CALENDARIO & ORARI               │
└────────────────────────────────────────────────────────────────────────┘

 [FinanceCalendar.com API]
   (https://www.financecalendar.com/wp-json/fc/v1/calendar)
   (country=US,DE,IT,FR,EU & impact=high & tz=Europe/Rome)
                 │
                 ▼ (HTTP GET con timeout 3.5s)
┌────────────────────────────────────────────────────────────────────────┐
│                        SERVER BACKEND (server.ts)                      │
│                                                                        │
│  ┌────────────────────────┐         ┌───────────────────────────────┐  │
│  │ Macro Cache (30m TTL)  │ ◄─────► │ getMacroCalendarState()       │  │
│  └────────────────────────┘         │ - Riconosce Weekday/Weekend   │  │
│                                     │ - Normalizza eventi JSON      │  │
│                                     │ - Calcola activeBlackoutEvent │  │
│                                     └───────────────────────────────┘  │
│                                                     │                  │
│  ┌────────────────────────┐                         │                  │
│  │ getCETTime()           │                         ▼                  │
│  │ - dayOfWeek check      │            Route Express:                  │
│  │ - isWeekend flag       │            GET /api/macro-calendar         │
│  │ - marketStatusEU/US    │            GET /api/session-clock          │
│  └────────────────────────┘                         │                  │
└─────────────────────────────────────────────────────┼──────────────────┘
                                                      │
                                                      ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React + Vite)                         │
│                                                                        │
│  ┌────────────────────────┐         ┌───────────────────────────────┐  │
│  │ Session Clock Bar      │         │ MacroCalendarBanner           │  │
│  │ - "Mercato Chiuso"     │         │ - Elenco eventi reali         │  │
│  │ - Countdown apertura   │         │ - Avviso Spread Broker TR     │  │
│  └────────────────────────┘         └───────────────────────────────┘  │
│                                                     ▲                  │
│                                                     │                  │
│  ┌──────────────────────────────────────────────────┴───────────────┐  │
│  │ getMacroBlackoutStatus(events, now) in calculator.ts             │  │
│  │ - Finestra dinamica +/- 15 minuti sull'evento reale HIGH/EXTREME │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Piano di Esecuzione Dettagliato

### Step 1: Estensione `server.ts` con integrazione FinanceCalendar
- Implementare funzione `fetchFinanceCalendarEvents(targetDate: string)` con parametri `country=US,DE,IT,FR,EU`, `impact=high`, `from=YYYY-MM-DD`, `to=YYYY-MM-DD`.
- Aggiungere cache in memoria `macroEventsCache` con timestamp di aggiornamento e TTL di 30 minuti.
- Aggiornare `getCETTime()`:
  - Rilevare `dayOfWeek` in fuso `Europe/Rome` e `America/New_York`.
  - Se sabato o domenica, impostare `marketStatusEU = 'CLOSED'`, `marketStatusUS = 'CLOSED'`, `isWeekend = true`.
- Aggiornare `getMacroCalendarState()`:
  - Se è weekend (`dayOfWeek === 0 || dayOfWeek === 6`), restituire `events: []`, `isBlackoutActive: false`, `activeBlackoutEvent: null`.
  - Nei giorni feriali, restituire gli eventi filtrati dall'API per la data odierna.

### Step 2: Riforma `getMacroBlackoutStatus` in `src/utils/calculator.ts`
- Modificare la firma di `getMacroBlackoutStatus` per accettare opzionalmente l'array degli eventi macro reali (`events?: MacroEvent[]`).
- Se `events` è vuoto o assente (o è weekend), restituire `isBlackoutActive: false`.
- Se è presente un evento ad alto impatto oggi, calcolare la distanza in minuti tra l'ora attuale e l'evento:
  - Se `diffMinutes >= -15 && diffMinutes <= 15`, attivare blackout dinamico con etichetta puntuale (es. `Blackout Macro Imminente: US CPI (14:15 - 14:45 CET)`).

### Step 3: Allineamento UI in `App.tsx` e `MacroCalendarBanner.tsx`
- Aggiornare `MacroCalendarBanner.tsx` per gestire chiaramente lo stato vuoto del weekend con messaggio positivo: `Nessun market mover programmato per oggi (Mercato Chiuso)`.
- Nel componente Session Clock, mostrare l'indicazione `MERCATO CHIUSO (Weekend)` quando `isWeekend === true`.

### Step 4: Suite di Test & Verifica Rigorosa
- Creare script di test dedicato `scripts/test_macro_calendar.ts`:
  - Test weekend (domenica): verificare che gli eventi siano vuoti e nessun blackout attivo.
  - Test giorno con evento (es. mercoledì con CPI alle 14:30): verificare attivazione blackout alle 14:20 e disattivazione alle 14:50.
  - Test fuso orario e parsing eventi FinanceCalendar.
- Esecuzione `npx tsc --noEmit` per garantire zero regressioni sui tipi.
- Esecuzione `npx tsx src/utils/__tests__/phase1.test.ts` per confermare che i 55 test di baseline rimangano 55/55 PASS.
- Verifica conservazione SHA-256 di `src/config/tradingParams.ts`.
