# Post-mortem Passo S — 2026-11-12

## Risultato
- Universo esteso da 5 a 9 simbodi senza toccare alcun file vietato in `src/`.
- Estensione via dato: `artifacts/snapshot_9.json` (9 quote), `scripts/replay_adapter.ts` punta al nuovo snapshot.
- Bit-identita' del ramo a 5 simbodi verificata: 15160 righe identiche.
- Catena dei gate sui 9 simbodi: 27288 valutazioni, 15 setup, 27273 con reason, 0 missing_input.
- Chi-quadro sui simbodi valutati: 44.4000, gdl=8, p=4.78e-7 (invariato).
- 4 simbodi aggiunti: 0 setup su 12096 righe.
- alphaEffective riconciliato: 0.0016667 = 0.05/30 per 33 ipotesi; valore corretto 0.05/33 = 0.0015152.
- Test: 36 file / 36 pass.

## Errori dichiarati
- Passo R aveva registrato AI-0033 result su un esperimento mai eseguito; rettificato con riga `not_evaluable`.
- `alphaEffective` non era stato aggiornato fra P, Q, R.
EOF