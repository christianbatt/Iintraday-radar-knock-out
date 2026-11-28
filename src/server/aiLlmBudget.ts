/**
 * BUDGET DELLE CHIAMATE LLM (P10 della roadmap).
 *
 * Tre cose dichiarate prima dei dati, non dopo:
 *
 * 1. **`maxTokens` per endpoint.** Oggi i valori erano costanti sparse nei
 *    punti di chiamata (2500, 2800, 300). Qui c'e' una tabella unica, con i
 *    valori storici invariati: passare la tabella ai chiamanti non cambia il
 *    payload delle richieste andate a buon fine, la rende solo esplicita e
 *    modificabile in un punto solo.
 *
 * 2. **Tetto di chiamate per richiesta e per utente.** Ogni endpoint AI apre
 *    un budget di richiesta; ogni chiamata al provider (OpenRouter o Gemini)
 *    consuma una unita'. Il tetto per richiesta ferma un ciclo impazzito, il
 *    tetto per utente (finestra scorrevole di un'ora) ferma un client che
 *    ripete la richiesta. I due tetti sono DICHIARATI qui e valgono la prima
 *    volta che vengono superati: sotto quei valori il comportamento e'
 *    identico a prima.
 *
 * 3. **Retry con backoff sui 429.** Solo sui codici transitori (429 e 503),
 *    con un numero massimo di tentativi e un ritardo che rispetta
 *    `Retry-After` quando il provider lo manda. Nessun retry sui 4xx
 *    definitivi (401/402/400): ripeterli spreca quota e nasconde l'errore.
 *
 * Puro e deterministico: il tempo entra solo da `now` iniettato, il jitter e'
 * un parametro (0 in produzione quando si vuole determinismo nei test).
 */

/** Endpoint che possono chiamare un modello. */
export type AiLlmEndpoint =
  | 'ai-specialize'
  | 'ai-desk-post-mortem'
  | 'ai-catalyst'
  | 'ai-scan-batch'
  | 'ai-test-openrouter';

/**
 * `maxTokens` per endpoint. I valori sono quelli gia' in uso prima di P10:
 * il budget li rende espliciti, non li cambia.
 */
export const AI_LLM_ENDPOINT_MAX_TOKENS: Record<AiLlmEndpoint, number> = {
  'ai-specialize': 2500,
  'ai-desk-post-mortem': 2500,
  'ai-catalyst': 2500,
  'ai-scan-batch': 2800,
  'ai-test-openrouter': 300,
};

/**
 * Tetto di chiamate al provider dentro UNA richiesta HTTP.
 *
 * Il caso normale sta sotto: la chiamata principale puo' usare OpenRouter e poi
 * Gemini (2 unita') e i batch shadow della scansione al massimo 4 batch (40
 * candidati / 10) per 2 provider = 8. Il tetto e' sopra il massimo osservabile
 * e serve a fermare un ciclo, non a limare il caso normale.
 */
export const AI_LLM_MAX_CALLS_PER_REQUEST = 12;

/**
 * Tetto di chiamate al provider per utente in una finestra scorrevole di un'ora.
 * Finestra scorrevole, non a secchio fisso: dieci richieste a cavallo del minuto
 * 59 non possono valere il doppio.
 */
export const AI_LLM_MAX_CALLS_PER_USER = 60;
export const AI_LLM_USER_WINDOW_MS = 60 * 60 * 1000;

/** Tentativi di retry oltre al primo (2 = fino a 3 tentativi in tutto). */
export const AI_LLM_RETRY_MAX_ATTEMPTS = 2;
/** Base del backoff esponenziale: 400 ms, 800 ms. */
export const AI_LLM_RETRY_BASE_MS = 400;
/** Tetto del singolo ritardo: una richiesta HTTP non deve restare appesa. */
export const AI_LLM_RETRY_MAX_DELAY_MS = 2000;

export type AiLlmBudgetScope = 'request' | 'user';

export type AiLlmBudgetDecision =
  | { ok: true }
  | { ok: false; scope: AiLlmBudgetScope; limit: number };

/** Budget di una singola richiesta HTTP. */
export interface AiLlmRequestBudget {
  /** Utente a cui la richiesta e' attribuita; `null` per i percorsi automatici. */
  readonly uid: string | null;
  /** Consuma una unita' o nega il permesso indicando quale tetto ha ceduto. */
  tryConsume(): AiLlmBudgetDecision;
  /**
   * Come `tryConsume` ma SENZA consumare: serve a rifiutare una richiesta prima
   * di fare lavoro inutile, lasciando che sia la singola chiamata a consumare.
   */
  peek(): AiLlmBudgetDecision;
  /** Unita' consumate da questa richiesta. */
  used(): number;
}

export interface AiLlmBudgetLedger {
  openRequest(uid: string | null): AiLlmRequestBudget;
  /** Chiamate registrate per l'utente nella finestra corrente. */
  userCallsInWindow(uid: string): number;
  /** Azzera tutto (solo test). */
  reset(): void;
}

export interface AiLlmBudgetOptions {
  now?: () => number;
  maxCallsPerRequest?: number;
  maxCallsPerUser?: number;
  userWindowMs?: number;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Registro dei budget. La finestra per utente e' un elenco di istanti: si potano
 * gli istanti fuori finestra a ogni consumo, quindi la memoria e' limitata dal
 * tetto stesso e non cresce con la storia.
 */
export function createAiLlmBudgetLedger(options: AiLlmBudgetOptions = {}): AiLlmBudgetLedger {
  const now = options.now ?? (() => Date.now());
  const maxPerRequest = positive(options.maxCallsPerRequest, AI_LLM_MAX_CALLS_PER_REQUEST);
  const maxPerUser = positive(options.maxCallsPerUser, AI_LLM_MAX_CALLS_PER_USER);
  const windowMs = positive(options.userWindowMs, AI_LLM_USER_WINDOW_MS);
  const userCalls = new Map<string, number[]>();

  const pruneAndRead = (uid: string, at: number): number[] => {
    const cutoff = at - windowMs;
    const kept = (userCalls.get(uid) ?? []).filter((ts) => ts > cutoff);
    userCalls.set(uid, kept);
    return kept;
  };

  const peek = (uid: string | null, used: number): AiLlmBudgetDecision => {
    if (used >= maxPerRequest) {
      return { ok: false, scope: 'request', limit: maxPerRequest };
    }
    if (uid === null) return { ok: true };
    const calls = pruneAndRead(uid, now());
    if (calls.length >= maxPerUser) {
      return { ok: false, scope: 'user', limit: maxPerUser };
    }
    return { ok: true };
  };

  return {
    openRequest(uid: string | null): AiLlmRequestBudget {
      let used = 0;
      return {
        uid,
        used: () => used,
        peek: (): AiLlmBudgetDecision => peek(uid, used),
        tryConsume(): AiLlmBudgetDecision {
          if (used >= maxPerRequest) {
            return { ok: false, scope: 'request', limit: maxPerRequest };
          }
          if (uid !== null) {
            const at = now();
            const calls = pruneAndRead(uid, at);
            if (calls.length >= maxPerUser) {
              return { ok: false, scope: 'user', limit: maxPerUser };
            }
            calls.push(at);
            userCalls.set(uid, calls);
          }
          used += 1;
          return { ok: true };
        },
      };
    },
    userCallsInWindow(uid: string): number {
      return pruneAndRead(uid, now()).length;
    },
    reset(): void {
      userCalls.clear();
    },
  };
}

/**
 * Registro di processo: una sola finestra per utente condivisa da tutti gli
 * handler. Iniettarlo nei test evita di toccare lo stato globale.
 */
export const aiLlmBudgetLedger = createAiLlmBudgetLedger();

/** Apre il budget di una richiesta sul registro di processo. */
export function openAiLlmRequest(uid: string | null): AiLlmRequestBudget {
  return aiLlmBudgetLedger.openRequest(uid);
}

/** `true` solo per i codici che vale la pena ripetere. */
export function isRetryableLlmStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/**
 * `Retry-After` in millisecondi: secondi interi oppure data HTTP. `null` se
 * assente o non interpretabile.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number = Date.now()
): number | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

/**
 * Richiesta di retry restituita da un tentativo: e' un valore, non un'eccezione.
 * Le funzioni di chiamata documentano "non lancia mai", e un throw per il
 * controllo di flusso romperebbe quella promessa (il loro `catch` lo
 * assorbirebbe come errore di rete). Il marcatore e' su un Symbol, quindi un
 * valore normale non puo' essere scambiato per una richiesta di retry.
 */
const AI_LLM_RETRY = Symbol.for('freebuff.aiLlmRetry');

export interface AiLlmRetryInfo {
  status: number;
  retryAfterMs?: number | null;
  /** Valutato solo quando i tentativi sono esauriti (es. cooldown + valore). */
  exhausted: () => unknown;
}

export interface AiLlmRetryRequest {
  [AI_LLM_RETRY]: AiLlmRetryInfo;
}

/** Costruisce la richiesta di retry per un tentativo fallito con codice ritentabile. */
export function aiLlmRetryRequest(info: AiLlmRetryInfo): AiLlmRetryRequest {
  return { [AI_LLM_RETRY]: info };
}

function isAiLlmRetryRequest<T>(value: T | AiLlmRetryRequest): value is AiLlmRetryRequest {
  return (
    value !== null &&
    typeof value === 'object' &&
    AI_LLM_RETRY in (value as Record<symbol, unknown>)
  );
}

export interface AiLlmRetryRunOptions {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Notifica di ogni retry programmato (per il log del chiamante). */
  onRetry?: (info: { attempt: number; status: number; delayMs: number }) => void;
}

/**
 * Esegue `attempt` e ripete SOLO quando il tentativo restituisce una richiesta
 * di retry (429/503), con il backoff dichiarato. Un solo posto che conosce
 * tentativi, ritardi e `Retry-After`: i chiamanti descrivono un tentativo e il
 * valore da restituire quando i tentativi finiscono.
 */
export async function runWithLlmRetry<T>(
  attempt: () => Promise<T | AiLlmRetryRequest>,
  options: AiLlmRetryRunOptions = {}
): Promise<T> {
  const maxRetries =
    typeof options.maxRetries === 'number' && Number.isFinite(options.maxRetries) && options.maxRetries >= 0
      ? Math.floor(options.maxRetries)
      : AI_LLM_RETRY_MAX_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let index = 0; ; index += 1) {
    const out = await attempt();
    if (!isAiLlmRetryRequest(out)) return out;
    const info = out[AI_LLM_RETRY];
    if (index >= maxRetries) return info.exhausted() as T;
    const delayMs = aiLlmRetryDelayMs(index, info.retryAfterMs ?? null);
    options.onRetry?.({ attempt: index + 1, status: info.status, delayMs });
    await sleep(delayMs);
  }
}

/**
 * Ritardo del prossimo tentativo: `Retry-After` se dichiarato, altrimenti
 * backoff esponenziale; sempre dentro il tetto. `jitterMs` e' un parametro
 * esplicito (0 = deterministico).
 */
export function aiLlmRetryDelayMs(
  attempt: number,
  retryAfterMs: number | null = null,
  jitterMs: number = 0
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const backoff = AI_LLM_RETRY_BASE_MS * 2 ** safeAttempt;
  const declared =
    typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? retryAfterMs
      : null;
  const base = declared ?? backoff;
  const jitter = Number.isFinite(jitterMs) && jitterMs > 0 ? jitterMs : 0;
  return Math.min(AI_LLM_RETRY_MAX_DELAY_MS, Math.floor(base + jitter));
}
