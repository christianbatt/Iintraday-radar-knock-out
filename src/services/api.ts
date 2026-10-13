import {
  UnderlyingItem,
  RawQuoteData,
  NewsItem,
  GeminiCatalystAnalysis,
  SessionInfo,
} from '../types/radar';

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
  const res = await fetch('/api/session');
  return safeJson<SessionInfo>(res, 'Errore durante il recupero della sessione');
}

export async function fetchBenchmarkFutures(forceRefresh: boolean = false): Promise<any> {
  const url = forceRefresh ? `/api/futures?refresh=true&_=${Date.now()}` : '/api/futures';
  const res = await fetch(url);
  return safeJson<any>(res, 'Errore durante il recupero dei futures');
}

export async function fetchMarketData(
  underlyings: UnderlyingItem[],
  forceRefresh: boolean = false
): Promise<RawQuoteData[]> {
  const url = forceRefresh ? `/api/market-data?refresh=true&_=${Date.now()}` : '/api/market-data';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ underlyings, refresh: forceRefresh }),
  });
  const json = await safeJson<{ data: RawQuoteData[] }>(res, 'Errore durante il recupero dei dati di mercato');
  return json.data || [];
}

export async function fetchTickerNews(ticker: string, name: string): Promise<NewsItem[]> {
  const res = await fetch(`/api/news/${encodeURIComponent(ticker)}?name=${encodeURIComponent(name)}`);
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
  const res = await fetch('/api/analyze-catalyst', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidate, news, futures }),
  });
  return safeJson<GeminiCatalystAnalysis>(res, 'Errore durante l\'analisi del catalizzatore');
}

export async function clearServerCache(): Promise<void> {
  await fetch('/api/cache/clear', { method: 'POST' });
}
