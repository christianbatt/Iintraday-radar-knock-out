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

/** User-Agent condiviso per le richieste Yahoo Finance. */
export const DEFAULT_YAHOO_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
 * Invalida esplicitamente il crumb corrente (es. dopo 401/403 da Yahoo)
 * cosi' un eventuale fallimento temporaneo del refresh non lascia in cache
 * una coppia revocata fino alla scadenza del TTL.
 */
export function invalidateYahooCrumb(): void {
  cached = null;
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

export interface FetchYahooCrumbOptions {
  forceRefresh?: boolean;
  nowMs?: number;
  userAgent?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Unico punto di handshake cookie + crumb Yahoo Finance condiviso da server e
 * collector V1-live. Se `forceRefresh` e' true invalida prima la voce stantia.
 */
export async function fetchAndCacheYahooCrumb(
  options: FetchYahooCrumbOptions = {}
): Promise<YahooCrumbPair | null> {
  const forceRefresh = options.forceRefresh ?? false;
  const nowMs = options.nowMs ?? Date.now();
  const userAgent = options.userAgent ?? DEFAULT_YAHOO_USER_AGENT;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (forceRefresh) {
    invalidateYahooCrumb();
  } else {
    const valid = readYahooCrumb(nowMs);
    if (valid) return valid;
  }

  return resolveYahooCrumbOnce(async () => {
    try {
      const cRes = await fetchImpl('https://fc.yahoo.com', {
        headers: { 'User-Agent': userAgent },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const getSetCookie = (cRes.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
      const cookie =
        typeof getSetCookie === 'function'
          ? getSetCookie.call(cRes.headers).map((c: string) => c.split(';')[0]).join('; ')
          : (cRes.headers.get('set-cookie') || '').split(',')[0].split(';')[0];
      if (!cookie) return null;

      const crRes = await fetchImpl('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: {
          'User-Agent': userAgent,
          Cookie: cookie,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!crRes.ok) return null;
      const crumb = (await crRes.text()).trim();
      if (!crumb || crumb.startsWith('<')) return null;

      return storeYahooCrumb({ cookie, crumb }, nowMs);
    } catch {
      return null;
    }
  });
}

/** Solo per i test: azzera voce e richiesta in corso. */
export function resetYahooCrumbCache(): void {
  cached = null;
  inFlight = null;
}
