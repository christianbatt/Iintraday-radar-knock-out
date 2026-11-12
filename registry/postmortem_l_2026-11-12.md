# Post-mortem Passo L — il pannello esiste

Data: 2026-11-12. Base: `764b234` (merge PR #45, Passo K). Branch: `feat/live-v1-passo-l`.

Questo passo non misura la strategia: collega un display e audita il fill.
Ogni numero qui sotto e' incollato dall'output di `bun scripts/ai_cycle.ts fillaudit`,
`bun scripts/ai_cycle.ts surface`, `bun scripts/ai_cycle.ts deathcheck`,
`bun scripts/shadow_report.ts`, `bun scripts/i3_barrier.ts`.

## 1. Integrita' del fill e identita' dei gate

### 1.1 La barriera e' rispettata

`fillaudit` conta le violazioni di monotonia su tutte le righe emesse: se il
target e' colpito a `k` alto deve esserlo anche a ogni `k` minore.

    (a) violazioni di monotonia su 123 emessi: 0 -> fill COERENTE con la barriera

Zero violazioni. Il first-touch e' un walk su barre successive con `t > decisionTs`,
stop valutato per primo (`walk()` in `scripts/ai_cycle.ts`). L'ipotesi AI-0008 e'
accettata: gli R della superficie non nascono da un target registrato a caso.

Due controlli accessori, dallo stesso output:

    (1.5) entry mai toccata nella sessione: 0/123
          target k=0.5 gia' superato sulla PRIMA barra: 7/123
          target k=1.6 gia' superato sulla PRIMA barra: 0/123

7 righe su 123 hanno il target a 0.5 gia' superato sulla barra di partenza: il
loro esito e' un target raggiunto senza che il prezzo sia mai passato dal punto
di ingresso. Non e' un errore di barriera, e' un problema di ingresso: vale 7/123
e va trattato come tale, non generalizzato.

### 1.2 Il difetto vero: 123 righe, 15 setup

    --- DUPLICATI: 123 righe emesse, 15 setup distinti (symbol|entry|stop) ---
          SAP.DE|186.039993|187.734721       x22
          BAMI.MI|15.275|15.15962            x16
          BAMI.MI|14.795|14.6706             x15
          SAP.DE|187|188.676603              x12
          SAP.DE|196.259995|197.734676       x12
    decile d5: 13 righe, 3 distinti.

Le 123 righe emesse corrispondono a **15 setup distinti** per `(symbol|entry|stop)`.
Lo stesso setup viene riemesso a ogni barra di decisione della sua finestra: il
primo dei cinque duplicati compare 22 volte.

Conseguenza diretta su K: la superficie "123 setup" e' una superficie di 15 unita'
indipendenti ripetute. Ogni `n`, ogni hit rate e ogni `meanR` della superficie
descrivono 15 setup. Il decile d5 — quello del `+1.282` — ha 13 righe e 3 setup
distinti, e 11 di quelle righe sono lo stesso setup BAMI.MI del 2026-10-09 con
entry e stop identici.

Questo NON e' un tetto al target e NON e' un errore di fill (AI-0010 respinta,
AI-0008 accettata): e' un conteggio che sovrastima l'informazione disponibile.

### 1.3 Geometria contro 1/(1+k)

Random walk senza drift: `P(target first) = 1/(1+k)` = 67/50/38/33%.
Scarto in punti percentuali (hit osservata − ideale), per decile:

    d1 n=13 dist=4 stop%=0.73 hit05=0.308 gap05=-35.9 hit10=0.231 gap10=-26.9 hit16=0.231 gap16=-15.4 hit20=0.231 gap20=-10.3
    d2 n=13 dist=2 stop%=0.75 hit05=0.308 gap05=-35.9 hit10=0.000 gap10=-50.0 hit16=0.000 gap16=-38.5 hit20=0.000 gap20=-33.3
    d3 n=13 dist=2 stop%=0.76 hit05=0.923 gap05=+25.6 hit10=0.769 gap10=+26.9 hit16=0.077 gap16=-30.8 hit20=0.077 gap20=-25.6
    d4 n=13 dist=3 stop%=0.79 hit05=0.615 gap05=-5.1  hit10=0.077 gap10=-42.3 hit16=0.077 gap16=-30.8 hit20=0.077 gap20=-25.6
    d5 n=13 dist=3 stop%=0.84 hit05=0.923 gap05=+25.6 hit10=0.923 gap10=+42.3 hit16=0.923 gap16=+53.8 hit20=0.154 gap20=-17.9
    d6 n=13 dist=2 stop%=0.90 hit05=0.385 gap05=-28.2 hit10=0.385 gap10=-11.5 hit16=0.385 gap16=+0.0  hit20=0.231 gap20=-10.3
    d7 n=13 dist=2 stop%=0.91 hit05=0.154 gap05=-51.3 hit10=0.154 gap10=-34.6 hit16=0.154 gap16=-23.1 hit20=0.000 gap20=-33.3
    d8 n=13 dist=2 stop%=0.91 hit05=0.000 gap05=-66.7 hit10=0.000 gap10=-50.0 hit16=0.000 gap16=-38.5 hit20=0.000 gap20=-33.3
    d9 n=13 dist=2 stop%=0.98 hit05=0.000 gap05=-66.7 hit10=0.000 gap10=-50.0 hit16=0.000 gap16=-38.5 hit20=0.000 gap20=-33.3
    d10 n=6 dist=2 stop%=0.98 hit05=0.167 gap05=-50.0 hit10=0.167 gap10=-33.3 hit16=0.000 gap16=-38.5 hit20=0.000 gap20=-33.3
    (b) decili sospetti (scarto > 20 pt su tutti i 4 k, n>=10): 2, 3, 7, 8, 9

Cinque decili su dieci stanno a piu' di 20 punti dall'ideale su tutti e quattro i
livelli. Ma d2, d7, d8 e d9 stanno **sotto**: colpiscono il target molto meno di
quanto farebbe un random walk. Un difetto di fill spingerebbe verso l'alto, non
verso il basso: qui il segno e' coerente con un ingresso che si muove contro e con
15 unita' indipendenti, non con una barriera violata.

d5 e' l'unico decile positivo su tre livelli su quattro (`gap05=+25.6`,
`gap10=+42.3`, `gap16=+53.8`) e crolla a `gap20=-17.9`. Il criterio stretto non
lo nomina (il quarto k scende sotto i 20 pt), la sostanza si': d5 e' il decile
anomalo, ed e' anche quello con 11 righe su 13 identiche.

### 1.4 Nessun tetto al target

    (d) tetto al target: nessuno nella superficie; G6 scarta i setup il cui T1 e gia raggiunto alla decisione.

La superficie calcola `entry + k*risk` e non applica clamp. AI-0010 (tetto al
target) e' respinta. Il crollo fra `k=1.6` e `k=2.0` resta un fatto da spiegare,
ma la spiegazione non e' un cap: e' il campione (3 setup distinti in d5).

### 1.5 G8 e G9 non sono indipendenti

    (c) G9 non e un predicato indipendente: se selectedLeverage e null (cioe se G8 fallisce) G9 fallisce;
        tassi osservati identici (39.8/39.8 prima, 22.0/22.0 dopo) -> G9 ⊆ G8.

- G8: `dS <= LMAX/min(LEVA)` — lo stop e' troppo lontano per qualunque leva.
- G9: `selectedLeverage == null || barrierRecommended == null || !validateBarrierSafety(...)`.

Predicati diversi, ma G9 richiede una leva compatibile: quando G8 fallisce non
esiste leva compatibile, quindi G9 fallisce. I tassi identici a 0.1% in entrambi
i periodi (39.8/39.8, poi 22.0/22.0) sono la firma dell'inclusione.

AI-0009 ("sono lo stesso predicato") e' respinta nella lettera e confermata nella
sostanza: non sono lo stesso predicato, sono uno contenuto nell'altro. Contarli
come due filtri indipendenti gonfia il numero di cause distinte di blocco.

### 1.6 Correzione R5: la pendenza esiste

    (d) fra gli emessi meanR NON CRESCE con stopPct (coef -1.2545)

La frase di K "la superficie non ha gradiente" e' sbagliata. `-1.2545` e' una
pendenza: fra le righe emesse, `meanR` decresce monotonicamente da d5 a d9
(+0.267, -0.535, -0.879, -1.109, -1.102) al crescere di `stopPct`. Il gradiente
esiste e punta agli stop stretti. La correzione pero' non riabilita il segnale:
con 15 setup distinti, quella pendenza e' la pendenza di 15 punti, non di 123.

## 2. Cosa questo passo non dimostra

- Non dimostra che la superficie "batte" qualcosa: 15 setup distinti non
  sostengono inferenza su nessun decile.
- Non dimostra che il fill sia sbagliato: 0 violazioni di monotonia, e la
  geometria va nella direzione opposta a un fill gonfiato.
- Non chiude il criterio di morte: `not_yet_evaluable` con 123/100 setup,
  13/30 giorni, 0/40 celle ammissibili, `alphaEffective=0.0045`. Le emissioni
  sono ferme: non e' un'attesa, e' un cantiere (Passo M).
- Non tocca G1–G13, non rigenera il replay, non addestra nulla:
  `i3_barrier` resta `-43.953 / -57.432 / -60.546`, `<<< MATCH`.
