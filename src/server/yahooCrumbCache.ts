/**
 * YAHOO CRUMB CACHE — unica cache canonica del cookie+crumb Yahoo Finance.
 *
 * Prima di N6 esistevano due cache indipendenti: `cache['yahoo:crumb']` (TTL
 * 1800 s) in `server.ts` e `collectorYahooCrumbCache` (TTL 30 min) in
 * `shadowV1LiveCollector.ts`. Due copie dello stesso dato significavano due
 * handshake a Yahoo e due scadenze diverse. Qui vive **solo** la cache, con TTL
 * invariato di 30 minuti e coalescing delle richieste parallele; il fetch resta
 * nei chiamanti, che hanno timeout e User-Agent propri.
 */

/** TTL della voce: 30 minuti, invariato rispetto alle due cache precedenti. */
export const YAHOO_CRUMB_TTL_MS = 30 * 60_000;

export interface YahooCrumbPair {
  cookie: string;
  crumb: string;
  expiresAtMs: number;
}

let cached: YahooCrumbPair | null = null;
let inFlight: Promise<YahooCrumbPair | null> | null = null;

/** Voce ancora valida a `nowMs`, altrimenti `null` (assente o scaduta). */
export function readYahooCrumb(nowMs: number = Date.now()): YahooCrumbPair | null {
  return cached !== null && nowMs < cached.expiresAtMs ? cached : null;
}

/**
 * Registra la voce e restituisce quella persistita, con scadenza a TTL pieno
 * calcolata da `nowMs` (lo stesso istante usato dal chiamante per la lettura).
 */
export function storeYahooCrumb(
  pair: Pick<YahooCrumbPair, 'cookie' | 'crumb'>,
  nowMs: number = Date.now()
): YahooCrumbPair {
  const stored: YahooCrumbPair = {
    cookie: pair.cookie,
    crumb: pair.crumb,
    expiresAtMs: nowMs + YAHOO_CRUMB_TTL_MS,
  };
  cached = stored;
  return stored;
}

/**
 * Esegue `loader` al massimo una volta per volta: le chiamate concorrenti
 * ricevono la stessa promise. La cache viene riletta dal chiamante prima di
 * questa funzione, come prima di N6.
 */
export function resolveYahooCrumbOnce(
  loader: () => Promise<YahooCrumbPair | null>
): Promise<YahooCrumbPair | null> {
  if (inFlight) return inFlight;
  const flight = loader().finally(() => {
    if (inFlight === flight) inFlight = null;
  });
  inFlight = flight;
  return flight;
}

/** Solo per i test: azzera voce e richiesta in corso. */
export function resetYahooCrumbCache(): void {
  cached = null;
  inFlight = null;
}
