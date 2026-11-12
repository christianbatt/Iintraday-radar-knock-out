# Post-mortem Passo M — l'unita' di misura

Data: 2026-11-12. Base: `b9837a6d077734cbd55a2e6a3f730211cda6a591` (merge PR #46, Passo L).
Branch: `feat/live-v1-passo-m`.

Questo passo non cerca un edge. Rende onesto cio' che era gia' misurato: le righe
emesse non sono le unita' indipendenti. Ogni numero qui sotto e' incollato
dall'output di `bun scripts/ai_cycle.ts dedup` e `bun scripts/ai_cycle.ts deathcheck`.

## 1. L'unita' di misura

### 1.1 La definizione

Unita' primaria: **setup distinto per `(symbol, entry, stop)`**. Una sola
definizione nel codice (`setupKey()` in `scripts/ai_cycle.ts`), riusata da
`dedup`, `deathcheck` e `fillaudit`.

    (1.1) unita primaria: setup distinto per (symbol, entry, stop). 15 gruppi su 123 righe.

### 1.2 La ripetizione e' intraday, non persistenza

    (1.2) diagnosi della ripetizione:
        SAP.DE|187.380005|188.596441       n=3   giorni=1 tsDistinti=3
        BAMI.MI|15.275|15.15962            n=16  giorni=1 tsDistinti=16
        SAP.DE|185.059998|186.873          n=11  giorni=1 tsDistinti=11
        BAMI.MI|15.33|15.20952             n=7   giorni=1 tsDistinti=7
        SAP.DE|186.039993|187.734721       n=22  giorni=1 tsDistinti=22
        SAP.DE|187|188.676603              n=12  giorni=1 tsDistinti=12
        BAMI.MI|14.795|14.6706             n=15  giorni=1 tsDistinti=15
        BAMI.MI|15.005|14.89515            n=6   giorni=1 tsDistinti=6
        SAP.DE|196.259995|197.734676       n=12  giorni=1 tsDistinti=12
        SAP.DE|199.639999|201.602397       n=4   giorni=1 tsDistinti=4
        BAMI.MI|14.1|14.00194              n=1   giorni=1 tsDistinti=1
        BAMI.MI|13.075|12.95903            n=5   giorni=1 tsDistinti=5
        SAP.DE|212.449997|214.277706       n=1   giorni=1 tsDistinti=1
        RHM.DE|1024|1013.968               n=6   giorni=1 tsDistinti=6
        BAMI.MI|13.385|13.28338            n=2   giorni=1 tsDistinti=2
    replay (1 ts): 2/15 · persistenza (>1 giorno): 0/15 -> mixed

Tutti i 15 gruppi stanno in **un solo giorno** (`giorni=1` su ogni riga): la
ripetizione non e' il livello che persiste su giorni diversi. Non e' nemmeno lo
stesso `decisionTs` ripetuto: 13 gruppi su 15 hanno un timestamp distinto per
riga (fino a 22 timestamp distinti per 22 righe). E' **riemissione intraday**:
lo stesso setup viene riemesso a decisioni successive della stessa sessione.
Il comando stampa `mixed` perche' due gruppi hanno una sola emissione, non
perche' esista persistenza: `persistenza (>1 giorno): 0/15`.

### 1.3 Ricalcolo affiancato

    (1.3) ricalcolo affiancato (righe | setup), frictionPct=0.10:
        k=0.5 n_righe=123 n_setup=15 hit_righe=39.0% hit_setup=40.0% meanNet_righe=-0.534 meanNet_setup=-0.522
        k=1 n_righe=123 n_setup=15 hit_righe=27.6% hit_setup=20.0% meanNet_righe=-0.566 meanNet_setup=-0.722
        k=1.6 n_righe=123 n_setup=15 hit_righe=19.5% hit_setup=20.0% meanNet_righe=-0.612 meanNet_setup=-0.602
        k=2 n_righe=123 n_setup=15 hit_righe=8.1% hit_setup=20.0% meanNet_righe=-0.875 meanNet_setup=-0.522

Il segno non cambia: **netto negativo a ogni k, su righe e su setup**. Cambia
l'ampiezza: a `k=2.0` la versione a righe da' `-0.875` e quella a setup
`-0.522`, perche' le righe ripetute appartengono ai setup che a quel livello
perdono di piu'. La CI bootstrap e' calcolata sui 15 setup (2000 repliche,
resampling dei setup, non delle righe): e' in `artifacts/ai_dedup.json` campo
`byK[].ciSetups`.

### 1.4 Superficie e concentrazione

    (1.4) superficie: max setup distinti per cella=4 · celle con <10 setup=10/10 · celle con >=30 righe ma <10 setup=0
    (1.5) concentrazione: top3 righe=53/123 (43.1%) · setup per 50% righe=4 · HHI=0.1025

Il decile piu' popolato ha **4 setup distinti**. Nessuna cella arriva a 10.
Nessuna cella ha 30 righe: l'intera superficie e' 123 righe su 15 setup, quindi
il criterio `n>=30` non e' mai stato vicino all'essere soddisfatto nemmeno
contando righe. Tre setup fanno 53 righe (43.1%); quattro setup fanno il 50%
delle righe. HHI `0.1025` su 15 unita' (uniforme sarebbe `0.0667`).

### 1.6 Popolazione B

    (1.6) popolazione B: righe=5544 setup_distinti=277 deduplicabile=true
           C: righe=123 setup_distinti=15

B e' deduplicabile (entry e stop presenti su tutte le righe) e si riduce da
5544 a **277** setup distinti. C resta 15. Il rapporto righe/setup e' 20.0 in B
e 8.2 in C: la riemissione e' piu' aggressiva fra i bloccati. Il confronto B vs
C non ha un segno da ribaltare: B e' bloccata prima dell'esecuzione, non ha un
R misurabile.

## 2. Il criterio di morte con l'unita' corretta

    trigger: setup 15/100 · giorni 13/30 -> NON soddisfatto
    celle: 40 totali · 0 ammissibili (n>=30 e giorni>=10)
    giorni per 30 setup distinti in UNA cella: 260 (assunzione: uniforme su 10 decili, ritmo 1.154 setup/giorno)
    STATO: not_yet_evaluable — trigger non soddisfatto (15/100 setup, 13/30 giorni) e 0 celle ammissibili su 40

Lo status non cambia, ma cambia cosa significa: prima il trigger sembrava
superato (123/100), ora e' a **15/100**. Con l'unita' corretta il criterio e'
irraggiungibile su questi dati: 15 setup totali, soglia 30 per cella.

**Giorni necessari: 260.** Assunzione dichiarata: i setup distinti si
distribuiscono uniformemente sui 10 decili (1.5 setup/giorno diviso 10 =
0.115 per cella al giorno; 30 / 0.115 = 260). Se la distribuzione non e'
uniforme, il numero sale per le celle meno popolate e scende per quelle piu'
popolate: con 4 setup nel decile migliore, il ritmo reale e' 4/13 = 0.31 al
giorno e servono 98 giorni **solo se** quel decile resta quello piu' popolato.

### 2.3 L'emendamento

Testo registrato (riga `AI-0005`, `kind: supersession`, `supersededBy: AI-0013`):

> l'unita' era mal definita, non la soglia: la regola diceva '100 setup' e
> 'n>=30' senza specificare se righe o setup distinti. La correzione avviene
> dopo aver osservato che righe != setup (Passo L) e PRIMA di sapere se il
> criterio corretto passa o fallisce.

Le due soglie non si sono mosse: `needSetups: 100`, `needDays: 30`, `n>=30` per
cella. Cambia solo cosa conta come unita'. `alphaEffective` scende da `0.00625`
a `0.0036` perche' le ipotesi registrate passano da 10 a 13 (`0.05 / 14`).

## 3. Cosa questo passo non dimostra

- Non dimostra che la strategia perda meno di quanto sembrava: a `k=1.0` la
  versione a setup e' **peggiore** (`-0.722` contro `-0.566`).
- Non dimostra che il criterio passera': con 260 giorni necessari e le emissioni
  ferme, il criterio e' bloccato dal cantiere delle emissioni (Passo N), non dal
  tempo.
- Non tocca G1–G13, non rigenera il replay: `i3_barrier` resta
  `-43.953 / -57.432 / -60.546`.
