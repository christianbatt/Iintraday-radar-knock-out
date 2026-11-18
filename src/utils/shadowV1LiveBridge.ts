/**
 * SHADOW V1 LIVE — ponte client -> server (osservazione passiva).
 *
 * Il client invia al server il setup gia' emesso, senza ricalcolare nulla e senza
 * modificare la decisione: il radar resta identico. Tutto e' spento di default
 * (`SHADOW_V1_LIVE_BRIDGE = 'off'` in `src/config/shadowV1LiveBridge.ts`).
 *
 * Garanzie:
 * - a flag OFF non parte alcuna richiesta di rete e non si alloca stato;
 * - deduplica per chiave del nucleo (`ticker|entry|stop|giorno UTC`): un setup
 *   ricalcolato N volte produce una sola POST, con tetto di memoria;
 * - fire-and-forget: il chiamante non attende la rete, `notifyShadowV1Live`
 *   ritorna subito un booleano;
 * - timeout breve, al massimo un tentativo di ripetizione, errori inghiottiti con
 *   un solo `console.warn` limitato in frequenza.
 *
 * Nessun dato dell'utente e nessun segreto nel payload: solo i sette campi che il
 * server valida.
 */

import { SHADOW_V1_LIVE_BRIDGE } from '../config/shadowV1LiveBridge';
import { shadowV1LiveKeyOf } from '../knowledge/shadowV1Live';
import type { ExecutionSetup } from '../types/radar';

export const SHADOW_V1_LIVE_BRIDGE_ENDPOINT = '/api/shadow/v1-live/observe';

/** Tetto della deduplica in memoria (chiavi gia' inviate). */
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

export interface BridgeDeps {
  /** Override del flag (test). Default: costante `SHADOW_V1_LIVE_BRIDGE`. */
  enabled?: boolean;
  fetchImpl?: BridgeFetch;
  endpoint?: string;
  timeoutMs?: number;
  maxKeys?: number;
  warn?: (message: string) => void;
  now?: () => number;
}

const WARN_PREFIX = '[Shadow V1 Live Bridge]';

const sentKeys = new Set<string>();
let lastWarnAt = Number.NEGATIVE_INFINITY;

/** Svuota deduplica e throttle: usato solo dai test. */
export function resetShadowV1LiveBridgeForTest(): void {
  sentKeys.clear();
  lastWarnAt = Number.NEGATIVE_INFINITY;
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

async function postOnce(
  payload: ShadowV1LiveBridgePayload,
  url: string,
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function send(payload: ShadowV1LiveBridgePayload, deps: BridgeDeps): Promise<void> {
  const url = deps.endpoint ?? SHADOW_V1_LIVE_BRIDGE_ENDPOINT;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await postOnce(payload, url, deps);
      // 4xx: richiesta rifiutata (429/413/400), nessuna ripetizione.
      if (res.status >= 400 && res.status < 500) return;
      // 5xx: un solo tentativo in piu'.
      if (res.status >= 500 && attempt === 0) continue;
      return;
    } catch (err) {
      if (attempt === 0) continue;
      const message = err instanceof Error ? err.message : String(err);
      warnThrottled(`${WARN_PREFIX} invio non riuscito: ${message}`, deps);
      return;
    }
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
  const maxKeys = deps.maxKeys ?? SHADOW_V1_LIVE_BRIDGE_MAX_KEYS;
  if (!remember(key, maxKeys)) return false;

  try {
    void send(payload, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnThrottled(`${WARN_PREFIX} invio non avviato: ${message}`, deps);
  }
  return true;
}
