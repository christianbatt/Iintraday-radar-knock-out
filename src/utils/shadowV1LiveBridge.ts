/**
 * SHADOW V1 LIVE — ponte client -> server (osservazione passiva).
 *
 * Il client invia al server il setup gia' emesso, senza ricalcolare nulla e senza
 * modificare la decisione: il radar resta identico. Flag `SHADOW_V1_LIVE_BRIDGE`
 * acceso di default (`'on'` in `src/config/shadowV1LiveBridge.ts`; spegnibile
 * impostandolo a `'off'`).
 *
 * Garanzie:
 * - a flag OFF non parte alcuna richiesta di rete e non si alloca stato;
 * - deduplica per chiave del nucleo (`ticker|entry|stop|giorno UTC`): un setup
 *   ricalcolato N volte produce una sola POST quando confermata `2xx`, con
 *   stato `inFlight` separato cosi' un `429`/`5xx`/timeout non brucia la chiave;
 * - fire-and-forget: il chiamante non attende la rete, `notifyShadowV1Live`
 *   ritorna subito un booleano;
 * - timeout breve, al massimo un tentativo di ripetizione su errore di rete/`5xx`,
 *   errori registrati con `console.warn` limitato in frequenza.
 *
 * Payload minimo controllato (solo i sette campi validati dal server) e Bearer
 * token Firebase opzionale via header Authorization quando l'utente e' autenticato.
 */

import { SHADOW_V1_LIVE_BRIDGE } from '../config/shadowV1LiveBridge';
import { shadowV1LiveKeyOf } from '../knowledge/shadowV1Live';
import type { ExecutionSetup } from '../types/radar';

export const SHADOW_V1_LIVE_BRIDGE_ENDPOINT = '/api/shadow/v1-live/observe';

/** Tetto della deduplica in memoria (chiavi gia' inviate con successo). */
export const SHADOW_V1_LIVE_BRIDGE_MAX_KEYS = 500;

/** Timeout della singola richiesta. */
export const SHADOW_V1_LIVE_BRIDGE_TIMEOUT_MS = 3000;

/** Distanza minima fra due `console.warn` del ponte. */
export const SHADOW_V1_LIVE_BRIDGE_WARN_INTERVAL_MS = 60_000;

export type ShadowV1LiveMarket = 'EU' | 'US';

export interface ShadowV1LiveBridgePayload {
  ticker: string;
  market: ShadowV1LiveMarket;
  direction: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  target: number;
  calculatedAt: string;
}

export interface BridgeResponse {
  status: number;
}

export type BridgeFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<BridgeResponse>;

export type AuthTokenGetter = () => Promise<string | null> | string | null;

export interface BridgeDeps {
  /** Override del flag (test). Default: costante `SHADOW_V1_LIVE_BRIDGE`. */
  enabled?: boolean;
  fetchImpl?: BridgeFetch;
  endpoint?: string;
  timeoutMs?: number;
  maxKeys?: number;
  warn?: (message: string) => void;
  now?: () => number;
  getAuthToken?: AuthTokenGetter;
}

const WARN_PREFIX = '[Shadow V1 Live Bridge]';

const sentKeys = new Set<string>();
const inFlightKeys = new Set<string>();
let lastWarnAt = Number.NEGATIVE_INFINITY;
let globalAuthTokenGetter: AuthTokenGetter | null = null;

/** Registra il provider globale per il Bearer token Firebase (usato dal client). */
export function setShadowV1LiveAuthTokenGetter(getter: AuthTokenGetter | null): void {
  globalAuthTokenGetter = getter;
}

/** Svuota deduplica e throttle: usato solo dai test. */
export function resetShadowV1LiveBridgeForTest(): void {
  sentKeys.clear();
  inFlightKeys.clear();
  lastWarnAt = Number.NEGATIVE_INFINITY;
  globalAuthTokenGetter = null;
}

function isPositiveFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Payload minimo o `null` se il setup non e' un'emissione valida. Non inventa
 * campi: senza `calculatedAt` parsabile non si invia nulla.
 */
export function buildShadowV1LivePayload(
  setup: ExecutionSetup | null | undefined
): ShadowV1LiveBridgePayload | null {
  if (!setup || setup.decision !== 'TRADE') return null;
  if (setup.direction !== 'LONG' && setup.direction !== 'SHORT') return null;

  const ticker = setup.candidate?.ticker;
  if (typeof ticker !== 'string' || ticker.trim().length === 0) return null;

  const entry = setup.entryLevel ?? setup.triggerLevel;
  const stop = setup.stopLossLevel;
  const target = setup.target1Level;
  if (!isPositiveFinite(entry) || !isPositiveFinite(stop) || !isPositiveFinite(target)) {
    return null;
  }

  const calculatedAt = setup.calculatedAt;
  if (typeof calculatedAt !== 'string' || !Number.isFinite(Date.parse(calculatedAt))) {
    return null;
  }

  const market = setup.marketType ?? setup.candidate?.market;
  if (market !== 'EU' && market !== 'US') return null;

  return {
    ticker: ticker.trim(),
    market,
    direction: setup.direction,
    entry,
    stop,
    target,
    calculatedAt,
  };
}

function remember(key: string, maxKeys: number): boolean {
  if (sentKeys.has(key)) return false;
  sentKeys.add(key);
  if (sentKeys.size > maxKeys) {
    const oldest = sentKeys.values().next();
    if (!oldest.done) sentKeys.delete(oldest.value);
  }
  return true;
}

function warnThrottled(message: string, deps: BridgeDeps): void {
  const now = deps.now ? deps.now() : Date.now();
  if (now - lastWarnAt < SHADOW_V1_LIVE_BRIDGE_WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  warn(message);
}

async function resolveHeaders(deps: BridgeDeps): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const getter = deps.getAuthToken ?? globalAuthTokenGetter;
  if (getter) {
    try {
      const token = await getter();
      if (typeof token === 'string' && token.trim().length > 0) {
        headers.Authorization = `Bearer ${token.trim()}`;
      }
    } catch {
      // Fall back without auth header so send handles HTTP 401 cleanly
    }
  }
  return headers;
}

async function postOnce(
  payload: ShadowV1LiveBridgePayload,
  url: string,
  headers: Record<string, string>,
  deps: BridgeDeps
): Promise<BridgeResponse> {
  const timeoutMs = deps.timeoutMs ?? SHADOW_V1_LIVE_BRIDGE_TIMEOUT_MS;
  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  }

  try {
    const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as BridgeFetch);
    return await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function send(
  payload: ShadowV1LiveBridgePayload,
  key: string,
  maxKeys: number,
  deps: BridgeDeps
): Promise<void> {
  const url = deps.endpoint ?? SHADOW_V1_LIVE_BRIDGE_ENDPOINT;

  try {
    const headers = await resolveHeaders(deps);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await postOnce(payload, url, headers, deps);
        if (res.status >= 200 && res.status < 300) {
          remember(key, maxKeys);
          return;
        }
        // 4xx: richiesta rifiutata (429/401/413/400), nessuna ripetizione immediata ne' blocco chiave.
        if (res.status >= 400 && res.status < 500) {
          warnThrottled(`${WARN_PREFIX} richiesta rifiutata (${res.status}) per ${payload.ticker}`, deps);
          return;
        }
        // 5xx: un solo tentativo in piu'.
        if (res.status >= 500 && attempt === 0) continue;
        warnThrottled(`${WARN_PREFIX} errore server (${res.status}) per ${payload.ticker}`, deps);
        return;
      } catch (err) {
        if (attempt === 0) continue;
        const message = err instanceof Error ? err.message : String(err);
        warnThrottled(`${WARN_PREFIX} invio non riuscito: ${message}`, deps);
        return;
      }
    }
  } finally {
    inFlightKeys.delete(key);
  }
}

/**
 * Invia il setup emesso, se il ponte e' attivo e il setup e' valido. Ritorna
 * `true` se l'invio e' stato accodato. Non attende la rete e non lancia mai.
 */
export function notifyShadowV1Live(
  setup: ExecutionSetup | null | undefined,
  deps: BridgeDeps = {}
): boolean {
  const enabled = deps.enabled ?? SHADOW_V1_LIVE_BRIDGE === 'on';
  if (!enabled) return false;

  const payload = buildShadowV1LivePayload(setup);
  if (!payload) return false;

  const decidedAtMs = Date.parse(payload.calculatedAt);
  const key = shadowV1LiveKeyOf(payload.ticker, payload.entry, payload.stop, decidedAtMs);
  if (sentKeys.has(key) || inFlightKeys.has(key)) return false;

  const maxKeys = deps.maxKeys ?? SHADOW_V1_LIVE_BRIDGE_MAX_KEYS;
  inFlightKeys.add(key);

  try {
    void send(payload, key, maxKeys, deps);
  } catch (err) {
    inFlightKeys.delete(key);
    const message = err instanceof Error ? err.message : String(err);
    warnThrottled(`${WARN_PREFIX} invio non avviato: ${message}`, deps);
    return false;
  }
  return true;
}
