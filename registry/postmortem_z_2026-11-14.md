# Post-mortem Passo Z — 2026-11-14

## 1. Scomposizione 2x2 corretta e errore dei 7.80

Celle (G7 pass): A=89.79, B=90.07, C=89.79, D=93.83 (4 aggiunti vs 5 noti).
- S = C - A = 0.00 pp (effetto fonte)
- P = B - A = 0.28 pp (effetto periodo)
- I = (D - C) - (B - A) = 3.76 pp (interazione)
- S + P + I = 4.04 pp = D - A. Verificato.

I valori riportati (1.88 / 2.16 / 3.76) sommavano 7.80 contro un totale di 4.04:
erano effetti semplici mediati contenenti I/2 (S+I/2=1.88, P+I/2=2.16). La loro somma
con 3.76 non decompone il totale. L'interazione e' il termine dominante.

## 2. Concentrazione su BAYN

- BAYN: 75.58 -> 91.73 (+16.15 pp) su 991 righe raggiunte = +160 righe.
- Aggregato: +126.7 righe. Altri 8 simbodi: -33.3 righe su 2146 = -1.55 pp.
- Escludendo BAYN il delta aggregato e' negativo (-1.55 pp).
- Il +4.04 pp di Passo Y non e' un effetto della fonte ne' del periodo, ma un
  attraversamento di soglia su BAYN. La 2x2 non e' stimabile con questo perimetro.

## 3. G8 holdout 9/9 e p

- Holdout G8: media -14.91, SD 12.64, giu' 9/9, segno p bilaterale = 0.00391.
- Conteggio corretto (non 8/9). Non supera alpha (0.000877).
- Lo spostamento e' un effetto di regime (volatilita' differisce fra le finestre),
  non un errore.

## 4. Tabella MDE vs effetti osservati

| sigma | MDE 80% (alpha 0.05) | MDE 80% (alpha 0.000877) | diff osservata |
|---|---|---|---|
| 11.68 (G7 finestre) | 21.94 | 30.71 | G7 +5.83 |
| 12.64 (G8 finestre) | 23.74 | 33.24 | G8 +10.69 |
| 21.33 (G8 simbodo) | 40.06 | 56.09 | G10 -3.07, G11 -7.22, emissione -0.40 |

Tutte le differenze osservate sono sotto il MDE minimo (21.94 pp). Nessuna conclusione
comparativa dei Passi S-Z sopravvive al MDE.

## 5. Pavimento di riproducibilita'

- Refetch a 3 giorni: G7 spostato di +8.52 pp (RHM), -6.35 pp (SAP).
- Pavimento di riproducibilita' = 8.52 pp: soglia minima per qualunque confronto futuro.
- AI-0072 confermata (>=2 simbodo con |delta| >= 5 pp).

## 6. Riconciliazione bootstrap / permutazione

| stadio | IC bootstrap | p permutazione | esclude zero? |
|---|---|---|---|
| G7 | [-1.42, 14.49] | 0.3016 | no |
| G8 | [-16.72, 35.07] | 0.5000 | no |
| G10 | [-9.72, 4.05] | 0.4444 | no |
| G11 | [-27.58, 13.23] | 0.5635 | no |
| emissione | [-0.77, -0.03] | 0.2063 | si (bootstrap) |

Divergenza solo su emissione. Regola: la permutazione esatta prevale, il bootstrap e'
diagnostica di ampiezza.

## 7. Decisione sul perimetro

Scelta: (A) congelare il perimetro a 9 simbodo e smettere di aggiungere ipotesi
comparative, dedicando i passi successivi alla sola misura del rumore.

Motivo: il MDE (21.94 pp minimo) supera tutte le differenze osservate (<=11 pp) e il
pavimento di riproducibilita' (8.52 pp) e' dell'ordine delle differenze. Con 9 simbodo
la permutazione non puo' rifiutare per costruzione (p minimo 0.0079365 > alpha).

Costo: non si potra' mai affermare un effetto di gruppo con questo perimetro.

Cosa diventa non piu' affermabile: nessuna conclusione comparativa dei Passi S-Z
sopravvive (G7/G8/G10/G11/emissione). Restano valide solo le stime per simbodo con IC.

## 8. Bit-identita' ramo a 5

15160 righe, 15 setup, hash 7fd90b4dfcedeeb761ba681d0d9ff7570f83a2756017a6ff1c07969c23495a0b.
Bit-identico: si.

## 9. Conclusioni non sopravviventi al MDE

Tutte le conclusioni comparative dei Passi S-Z (G7, G8, G10, G11, emissione, fonte vs
periodo, asimmetria) non sopravvivono. Il +4.04 pp di Passo Y e' un attraversamento di
soglia su BAYN, non un effetto.
EOF
echo "written"