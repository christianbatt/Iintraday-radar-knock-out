import {
  UnderlyingItem,
  RawQuoteData,
  NewsItem,
  GeminiCatalystAnalysis,
  SessionInfo,
  MacroCalendarState,
  AILearnedInsight,
} from '../types/radar';
import { auth } from './firebaseSync';

// IPOTESI (nessun valore preesistente): timeout espliciti lato client.
const API_TIMEOUT_MS = 20000;
const AI_TIMEOUT_MS = 45000;

function timeoutForUrl(input: RequestInfo | URL): number {
  const url = String(input);
  return /\/api\/(ai\/|analyze-catalyst)/.test(url) ? AI_TIMEOUT_MS : API_TIMEOUT_MS;
}

// AUDIT D3: una richiesta senza risposta entro il timeout fallisce con un errore esplicito,
// invece di restare appesa o restituire un payload vuoto interpretabile come dato valido.
function withTimeout(init: RequestInit, timeoutMs: number): RequestInit {
  if (init.signal) return init;
  return { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

async function fetchWithFirebaseAuth(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const currentUser = auth?.currentUser;
  if (currentUser) {
    headers.set('Authorization', `Bearer ${await currentUser.getIdToken()}`);
  }
  return fetch(input, { ...withTimeout(init, timeoutForUrl(input)), headers });
}

async function safeJson<T>(res: Response, defaultErrMsg: string): Promise<T> {
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const errBody = await res.json().catch(() => null);
      if (errBody?.error) throw new Error(errBody.error);
    }
    throw new Error(`${defaultErrMsg} (HTTP ${res.status})`);
  }
  if (!contentType.includes('application/json')) {
    throw new Error('Il server ha restituito una risposta non JSON. Riprova tra pochi istanti.');
  }
  return res.json();
}

export async function fetchSessionInfo(): Promise<SessionInfo> {
  const res = await fetch('/api/session', withTimeout({}, timeoutForUrl('/api/session')));
  return safeJson<SessionInfo>(res, 'Errore durante il recupero della sessione');
}

export async function fetchMacroCalendar(): Promise<MacroCalendarState> {
  try {
    const res = await fetch('/api/macro-calendar', withTimeout({}, timeoutForUrl('/api/macro-calendar')));
    if (!res.ok) {
      return {
        events: [],
        activeBlackoutEvent: null,
        isBlackoutActive: false,
        spreadWarningTradeRepublic: null,
        status: 'unavailable',
      };
    }
    const data = await res.json();
    return { ...data, status: 'ok' };
  } catch {
    return {
      events: [],
      activeBlackoutEvent: null,
      isBlackoutActive: false,
      spreadWarningTradeRepublic: null,
      status: 'unavailable',
    };
  }
}

export async function fetchBenchmarkFutures(forceRefresh: boolean = false): Promise<any> {
  const url = forceRefresh ? `/api/futures?refresh=true&_=${Date.now()}` : '/api/futures';
  const res = await fetch(url, withTimeout({}, timeoutForUrl(url)));
  return safeJson<any>(res, 'Errore durante il recupero dei futures');
}

export async function fetchMarketData(
  underlyings: UnderlyingItem[],
  forceRefresh: boolean = false
): Promise<RawQuoteData[]> {
  const url = forceRefresh ? `/api/market-data?refresh=true&_=${Date.now()}` : '/api/market-data';
  const res = await fetch(url, withTimeout({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ underlyings, refresh: forceRefresh }),
  }, timeoutForUrl(url)));
  const json = await safeJson<{ data: RawQuoteData[] }>(res, 'Errore durante il recupero dei dati di mercato');
  return json.data || [];
}

export async function fetchTickerNews(ticker: string, name: string): Promise<NewsItem[]> {
  const res = await fetch(
    `/api/news/${encodeURIComponent(ticker)}?name=${encodeURIComponent(name)}`,
    withTimeout({}, API_TIMEOUT_MS)
  );
  if (!res.ok) return [];
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return [];
  const json = await res.json().catch(() => ({ news: [] }));
  return json.news || [];
}

export async function analyzeCatalystWithGemini(
  candidate: RawQuoteData,
  news: NewsItem[],
  futures: any
): Promise<GeminiCatalystAnalysis> {
  const res = await fetchWithFirebaseAuth('/api/analyze-catalyst', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidate, news, futures }),
  });
  return safeJson<GeminiCatalystAnalysis>(res, 'Errore durante l\'analisi del catalizzatore');
}

export async function clearServerCache(): Promise<void> {
  await fetchWithFirebaseAuth('/api/cache/clear', { method: 'POST' });
}

export async function fetchSharedAppState(sinceVersion?: number): Promise<{
  hasUpdates: boolean;
  version?: number;
  updatedAt?: string;
  state?: any;
}> {
  try {
    const url = sinceVersion ? `/api/sync/state?sinceVersion=${sinceVersion}` : '/api/sync/state';
    const res = await fetchWithFirebaseAuth(url);
    if (!res.ok) return { hasUpdates: false };
    return res.json();
  } catch {
    return { hasUpdates: false };
  }
}

export async function pushSharedAppState(patch: any): Promise<{ success: boolean; version?: number }> {
  try {
    const res = await fetchWithFirebaseAuth('/api/sync/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { success: false };
    return res.json();
  } catch {
    return { success: false };
  }
}

export async function fetchAIMemory(): Promise<AILearnedInsight[]> {
  try {
    const res = await fetchWithFirebaseAuth('/api/ai/memory');
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.memory) ? data.memory : [];
  } catch {
    return [];
  }
}

export async function triggerAISpecialization(
  trades: any[],
  excludedSetups: any[]
): Promise<{ success: boolean; newInsightsCount: number; memory: AILearnedInsight[]; message?: string }> {
  try {
    const res = await fetchWithFirebaseAuth('/api/ai/specialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trades, excludedSetups }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, newInsightsCount: 0, memory: [], message: err.error || 'Errore server' };
    }
    return res.json();
  } catch (err: any) {
    return { success: false, newInsightsCount: 0, memory: [], message: err?.message || 'Errore di connessione' };
  }
}

export interface DeskPostMortemReport {
  executiveSummary: string;
  strengths: string[];
  failurePatterns: string[];
  tacticalAdvice: string;
  generatedAt: string;
}

export async function fetchDeskPostMortem(
  trades: any[],
  market: 'EU' | 'US' | 'GLOBAL'
): Promise<{
  success: boolean;
  market: string;
  postMortem: DeskPostMortemReport;
  newDirectivesAdded: number;
  totalRules: number;
  error?: string;
}> {
  try {
    const res = await fetchWithFirebaseAuth('/api/ai/desk-post-mortem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trades, market }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Errore durante la generazione del post-mortem');
    }
    return res.json();
  } catch (err: any) {
    return {
      success: false,
      market,
      postMortem: {
        executiveSummary: '',
        strengths: [],
        failurePatterns: [],
        tacticalAdvice: '',
        generatedAt: '',
      },
      newDirectivesAdded: 0,
      totalRules: 0,
      error: err?.message || 'Errore di connessione',
    };
  }
}


