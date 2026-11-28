/**
 * BARRE DEL COSTO PER RIGA — lettura unica per richiesta (Fase 6.3).
 *
 * Il costo per riga (Fase 6.1) ha bisogno delle due barre 5m che contengono il
 * fill. `artifacts/shadow_v1_live/bars.json` e' un file di alcuni MB e la
 * calibrazione ha tre lettori (`readForward`, `readNearMissForward`,
 * `readRejectedForward`): ognuno lo rileggeva e lo riparsava per conto suo,
 * quindi una sola richiesta lo decodificava tre volte.
 *
 * Qui il file si legge UNA volta per richiesta e la mappa risultante si passa ai
 * tre lettori. Il contenuto non cambia: stessa funzione di parsing di prima,
 * stessa mappa per ticker, stesse due barre per fill. Cambia solo quante volte
 * il file viene decodificato.
 *
 * Puro rispetto al disco: nessuna scrittura, nessun orologio. Errori di I/O o
 * JSON illeggibile danno una mappa vuota (ogni riga resta al costo dichiarato),
 * mai un'eccezione.
 */

import fs from 'node:fs';

/** Barra OHLCV minima usata dal proxy di spread. */
export interface ShadowV1LiveCostBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type ShadowV1LiveCostBarsByTicker = Map<string, ShadowV1LiveCostBar[]>;

/**
 * Legge `bars.json` e lo indicizza per ticker. File assente, JSON invalido o
 * barre incomplete non lanciano: la mappa resta vuota (o parziale) e la fonte
 * del costo lo dichiara riga per riga.
 */
export function loadShadowV1LiveBarsByTicker(barsPath: string): ShadowV1LiveCostBarsByTicker {
  const byTicker: ShadowV1LiveCostBarsByTicker = new Map();
  try {
    if (!fs.existsSync(barsPath)) return byTicker;
    const parsed: unknown = JSON.parse(fs.readFileSync(barsPath, 'utf8'));
    const entries = (parsed as { entries?: unknown })?.entries;
    const list = Array.isArray(entries)
      ? entries
      : entries && typeof entries === 'object'
        ? Object.values(entries)
        : [];
    for (const entry of list as Array<{ ticker?: unknown; bars?: unknown }>) {
      if (!entry || typeof entry.ticker !== 'string' || !Array.isArray(entry.bars)) continue;
      const bars = (entry.bars as Array<Record<string, unknown>>).filter(
        (bar) =>
          bar &&
          Number.isFinite(bar.t) &&
          Number.isFinite(bar.h) &&
          Number.isFinite(bar.l) &&
          Number.isFinite(bar.o) &&
          Number.isFinite(bar.c)
      ) as unknown as ShadowV1LiveCostBar[];
      if (bars.length > 0) byTicker.set(entry.ticker, bars);
    }
  } catch {
    // Nessuna barra: il costo resta quello dichiarato, e la fonte lo dice.
  }
  return byTicker;
}

/**
 * Restituisce una funzione che carica la mappa una sola volta. Lo scope e' la
 * richiesta: chi la crea ne crea una per chiamata, non una per processo (le
 * barre crescono nel tempo e una cache di processo servirebbe dati vecchi).
 */
export function createShadowV1LiveBarsOnce(
  load: () => ShadowV1LiveCostBarsByTicker
): () => ShadowV1LiveCostBarsByTicker {
  let cached: ShadowV1LiveCostBarsByTicker | null = null;
  return () => {
    if (cached === null) cached = load();
    return cached;
  };
}

/**
 * Le due barre consecutive che contengono il fill: quella del fill e la
 * precedente. `null` quando il fill non e' databile o la serie non le ha.
 */
export function barsAroundFill(
  bars: readonly ShadowV1LiveCostBar[] | undefined,
  fillBarTs: unknown
): ShadowV1LiveCostBar[] | null {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  if (typeof fillBarTs !== 'number' || !Number.isFinite(fillBarTs)) return null;
  let index = -1;
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i].t <= fillBarTs) index = i;
    else break;
  }
  if (index < 1) return null;
  return [bars[index - 1], bars[index]];
}
