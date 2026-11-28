/**
 * Pure deterministic utilities for news freshness/relevance hygiene and
 * benchmark futures payload normalization across client/server boundaries.
 *
 * Zero network I/O, zero side effects, deterministic for a given `nowMs`.
 */

export interface FilterableNewsItem {
  id?: string;
  title: string;
  summary?: string;
  source?: string;
  url?: string;
  publishedAt?: string;
}

export interface FilteredNewsResult<T extends FilterableNewsItem> {
  fresh: T[];
  staleCount: number;
  offTickerCount: number;
  hasRecent24h: boolean;
  hasPrimaryWire: boolean;
}

const CORPORATE_STOPWORDS = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'spa',
  'srl',
  'plc',
  'ltd',
  'limited',
  'nv',
  'se',
  'ag',
  'sa',
  'co',
  'company',
  'group',
  'gruppo',
  'holding',
  'holdings',
  'technologies',
  'technology',
  'systems',
  'international',
  'global',
  'financial',
  'bancario',
  'banca',
  'bank',
  'azioni',
  'borsa',
  'stock',
  'shares',
  'ordinary',
  'adr',
]);

const PRIMARY_WIRE_PATTERNS: readonly RegExp[] = [
  /\breuters\b/i,
  /\bbloomberg\b/i,
  /\bansa\b/i,
  /\bsole\s*24\s*ore\b/i,
  /\bradiocor\b/i,
  /\bmilano\s*finanza\b/i,
  /\bteleborsa\b/i,
  /\bborsa\s*italiana\b/i,
  /\bmarketwatch\b/i,
  /\bcnbc\b/i,
  /\bwall\s*street\s*journal\b|\bwsj\b/i,
  /\bfinancial\s*times\b/i,
  /\bdow\s*jones\b/i,
  /\bbarron'?s\b/i,
  /\bpr\s*newswire\b/i,
  /\bbusiness\s*wire\b/i,
  /\bglobenewswire\b/i,
  /\bfinnhub\b/i,
  /\byahoo\s*finance\b/i,
];

const TICKER_ALIASES: Record<string, readonly string[]> = {
  'ISP.MI': ['intesa', 'sanpaolo', 'isp'],
  'UCG.MI': ['unicredit', 'ucg'],
  'LDO.MI': ['leonardo', 'ldo'],
  'LEO.MI': ['leonardo', 'ldo'],
  'ENI.MI': ['eni'],
  'ENEL.MI': ['enel'],
  'STM.MI': ['stmicroelectronics', 'stm'],
  'STMMI.MI': ['stmicroelectronics', 'stm'],
  'RACE.MI': ['ferrari', 'race'],
  'STLAM.MI': ['stellantis', 'stlam'],
  'G.MI': ['generali', 'assicurazioni generali'],
  'MB.MI': ['mediobanca'],
  'BAMI.MI': ['banco bpm', 'bpm', 'bami'],
  'BMPS.MI': ['monte dei paschi', 'mps', 'bmps'],
  'PRY.MI': ['prysmian'],
  'TEN.MI': ['tenaris'],
  'TIT.MI': ['telecom italia', 'tim'],
  SPACEX: ['spacex', 'space exploration', 'starlink'],
  SPCX: ['spacex', 'space exploration', 'spcx'],
  GOOGL: ['alphabet', 'google', 'googl'],
  GOOG: ['alphabet', 'google', 'goog'],
  META: ['meta platforms', 'meta', 'facebook', 'instagram', 'whatsapp'],
};

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildEntityMatchers(ticker: string, companyName: string): RegExp[] {
  const upperTicker = String(ticker || '').trim().toUpperCase();
  const rootSymbol = upperTicker.split('.')[0] || upperTicker;
  const matchers: RegExp[] = [];

  if (upperTicker.length >= 2) {
    matchers.push(new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegex(upperTicker)}(?:$|[^A-Za-z0-9])`, 'i'));
  }
  // Single-letter roots like 'G' (Generali) or 'F' (Ford) are too ambiguous without suffix/company name
  if (rootSymbol.length >= 2) {
    matchers.push(new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegex(rootSymbol)}(?:$|[^A-Za-z0-9])`, 'i'));
  }

  const aliases = TICKER_ALIASES[upperTicker] ?? TICKER_ALIASES[rootSymbol] ?? [];
  for (const alias of aliases) {
    if (alias.length >= 3) {
      matchers.push(new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i'));
    }
  }

  const cleanedName = String(companyName || '')
    .replace(/[.,()/-]+/g, ' ')
    .trim();
  if (cleanedName.length >= 3) {
    const tokens = cleanedName
      .split(/\s+/)
      .map((tok) => tok.trim())
      .filter((tok) => tok.length >= 3 && !CORPORATE_STOPWORDS.has(tok.toLowerCase()));

    for (const token of tokens) {
      matchers.push(new RegExp(`\\b${escapeRegex(token)}\\b`, 'i'));
    }
  }

  return matchers;
}

export function isPrimaryFinancialWire(source: string | undefined | null): boolean {
  if (!source || typeof source !== 'string') return false;
  return PRIMARY_WIRE_PATTERNS.some((pattern) => pattern.test(source));
}

/**
 * Filters raw news items to keep only articles that:
 * 1. Have a valid `publishedAt` timestamp within `maxAgeHours` (default 72h, with 30m future skew tolerance);
 * 2. Explicitly reference the target ticker or company name in `title` or `summary` (eliminating off-ticker RSS noise).
 */
export function filterRelevantFreshNews<T extends FilterableNewsItem>(
  news: readonly T[] | null | undefined,
  ticker: string,
  companyName: string = '',
  nowMs: number = Date.now(),
  maxAgeHours: number = 72
): FilteredNewsResult<T> {
  if (!Array.isArray(news) || news.length === 0) {
    return {
      fresh: [],
      staleCount: 0,
      offTickerCount: 0,
      hasRecent24h: false,
      hasPrimaryWire: false,
    };
  }

  const maxAgeMs = Math.max(1, maxAgeHours) * 3_600_000;
  const futureSkewToleranceMs = 30 * 60_000;
  const recent24hMs = 24 * 3_600_000;
  const matchers = buildEntityMatchers(ticker, companyName);
  const seenTitles = new Set<string>();

  const fresh: T[] = [];
  let staleCount = 0;
  let offTickerCount = 0;
  let hasRecent24h = false;
  let hasPrimaryWire = false;

  for (const item of news) {
    if (!item || typeof item.title !== 'string' || item.title.trim().length === 0) {
      continue;
    }

    const publishedMs = typeof item.publishedAt === 'string' ? Date.parse(item.publishedAt) : Number.NaN;
    const ageMs = nowMs - publishedMs;
    if (!Number.isFinite(publishedMs) || ageMs > maxAgeMs || ageMs < -futureSkewToleranceMs) {
      staleCount += 1;
      continue;
    }

    const haystack = `${item.title} ${item.summary ?? ''}`;
    const isRelevant = matchers.length === 0 || matchers.some((rx) => rx.test(haystack));
    if (!isRelevant) {
      offTickerCount += 1;
      continue;
    }

    const normalizedTitleKey = item.title.trim().toLowerCase().replace(/\s+/g, ' ');
    if (seenTitles.has(normalizedTitleKey)) {
      continue;
    }
    seenTitles.add(normalizedTitleKey);

    fresh.push(item);
    if (ageMs <= recent24hMs) {
      hasRecent24h = true;
    }
    if (isPrimaryFinancialWire(item.source)) {
      hasPrimaryWire = true;
    }
  }

  return {
    fresh,
    staleCount,
    offTickerCount,
    hasRecent24h,
    hasPrimaryWire,
  };
}

/** Finestra dichiarata entro cui una notizia e' "pertinente" (invariata). */
export const NEWS_MAX_AGE_HOURS = 72;
/** Notizia "di oggi": e' l'unica banda che puo' valere punti. */
export const NEWS_TODAY_AGE_HOURS = 24;
/** Notizia "intraday": pubblicata dentro la sessione corrente. */
export const NEWS_INTRADAY_AGE_HOURS = 6;

export type NewsRecencyBand = 'intraday' | 'today' | 'recent' | 'stale';

/**
 * Banda di freschezza di una notizia. Il bordo e' inclusivo: 6h esatte sono
 * ancora `intraday`, 24h esatte ancora `today`, oltre `NEWS_MAX_AGE_HOURS` e'
 * `stale` e non dovrebbe nemmeno entrare nel pool.
 */
export function newsRecencyBand(ageHours: number): NewsRecencyBand {
  if (!Number.isFinite(ageHours)) return 'stale';
  if (ageHours <= NEWS_INTRADAY_AGE_HOURS) return 'intraday';
  if (ageHours <= NEWS_TODAY_AGE_HOURS) return 'today';
  if (ageHours <= NEWS_MAX_AGE_HOURS) return 'recent';
  return 'stale';
}

/**
 * Titoli che possono davvero muovere un titolo intraday: sorprese sugli utili,
 * giudizi degli analisti, contratti/commesse, guidance, operazioni societarie,
 * azioni legali o regolatorie, sospensioni, aumento di capitale, dividendo
 * straordinario. Deliberatamente NON include "rassegna", "analisi", "previsione"
 * o commenti generici: sono notizie che non spostano il prezzo di oggi.
 */
export const NEWS_INTRADAY_MOVER_PATTERNS: readonly RegExp[] = [
  /\bupgrade\b|\bdowngrade\b|\bprice\s*target\b|\btarget\s*price\b|\boutperform\b|\bunderperform\b/i,
  /\brialzo\s+del\s+prezzo\s+obiettivo\b|\babbassamento\s+del\s+prezzo\s+obiettivo\b|\bgiudizio\b/i,
  /\bcontract\b|\bcontracts\b|\border\s+intake\b|\bcommessa\b|\bcontratto\b|\bcontratti\b|\bordini\b/i,
  /\bguidance\b|\bprevisione\s+sui\s+ricavi\b|\btaglia\s+le\s+stime\b|\balza\s+le\s+stime\b/i,
  /\bearnings\b|\bquarterly\s+results\b|\bconti\s+trimestrali\b|\butili\b|\bprofit\s+warning\b/i,
  /\bacquisition\b|\bacquisizione\b|\bmerger\b|\bmerger\s+agreement\b|\bfusione\b|\bstake\b|\bopa\b/i,
  /\bcapital\s+increase\b|\baumento\s+di\s+capitale\b|\bdividend\b|\bdividendo\b|\bbuyback\b|\briacquisto\s+di\s+azioni\b/i,
  /\blawsuit\b|\binvestigation\b|\bantitrust\b|\bfine\b|\bsanzione\b|\bindagine\b|\btrading\s+halt\b|\bsospensione\b/i,
  /\bceo\b.*\b(resigns|steps\s+down|dismissed)\b|\bdimissioni\b|\bcda\s+straordinario\b/i,
  /\boutage\b|\brecall\b|\bstrike\b|\bsciopero\b|\bfire\b|\bincendio\b/i,
];

/** Vero quando il titolo contiene un evento in grado di muovere il prezzo intraday. */
export function isIntradayMovingHeadline(item: FilterableNewsItem | null | undefined): boolean {
  if (!item || typeof item.title !== 'string') return false;
  const haystack = `${item.title} ${item.summary ?? ''}`;
  return NEWS_INTRADAY_MOVER_PATTERNS.some((pattern) => pattern.test(haystack));
}

/** Età in ore di una notizia, `null` se la data manca o non è leggibile. */
export function newsAgeHours(
  item: FilterableNewsItem | null | undefined,
  nowMs: number
): number | null {
  if (!item || typeof item.publishedAt !== 'string') return null;
  const publishedMs = Date.parse(item.publishedAt);
  if (!Number.isFinite(publishedMs)) return null;
  return (nowMs - publishedMs) / 3_600_000;
}

/** Etichetta leggibile per il prompt: "2,4h", "1,3 giorni". */
export function formatNewsAge(ageHours: number | null): string {
  if (ageHours === null || !Number.isFinite(ageHours)) return 'età non dichiarata';
  const safe = Math.max(0, ageHours);
  if (safe < 1) return `${Math.round(safe * 60)} min`;
  if (safe < 48) return `${safe.toFixed(1).replace('.', ',')}h`;
  return `${(safe / 24).toFixed(1).replace('.', ',')} giorni`;
}

/**
 * Tetti del bonus notizia, per banda di freschezza e presenza di un evento che
 * muove il prezzo. Sono la traduzione deterministica di "peso solo alle notizie
 * recenti e importanti": una notizia vecchia vale **zero** punti, non pochi.
 * Dichiarati qui, prima di guardare i dati.
 */
export const NEWS_BONUS_CEILING = {
  /** Evento rilevante pubblicato nelle ultime 6h: bonus pieno. */
  intradayMover: 15,
  /** Evento rilevante nelle ultime 24h, ma non intraday. */
  todayMover: 12,
  /** Notizia fresca senza evento rilevante: contesto, non catalizzatore. */
  intradayContext: 10,
  /** Notizia di oggi senza evento rilevante. */
  todayContext: 7,
  /** Niente entro 24h: la notizia non e' piu' un catalizzatore. */
  stale: 0,
} as const;

export interface NewsBonusPolicy {
  /** Punti massimi che il bonus puo' valere con questo pool di notizie. */
  ceiling: number;
  freshestAgeHours: number | null;
  hasIntradayMover: boolean;
  hasPrimaryWire: boolean;
  bandCounts: Record<NewsRecencyBand, number>;
  /** Frase breve da mettere nel prompt/log: perche' il tetto e' quello. */
  reason: string;
}

/**
 * Calcola il tetto del bonus guardando solo le notizie del pool gia' filtrato
 * (fresche <=72h e pertinenti al ticker). Non ha effetti: e' una funzione pura
 * di `news` e `nowMs`.
 */
export function newsBonusPolicy(
  news: readonly FilterableNewsItem[] | null | undefined,
  nowMs: number
): NewsBonusPolicy {
  const bandCounts: Record<NewsRecencyBand, number> = {
    intraday: 0,
    today: 0,
    recent: 0,
    stale: 0,
  };
  let freshestAgeHours: number | null = null;
  let hasIntradayMover = false;
  let hasPrimaryWire = false;

  for (const item of news ?? []) {
    const age = newsAgeHours(item, nowMs);
    const band = newsRecencyBand(age ?? Number.POSITIVE_INFINITY);
    bandCounts[band] += 1;
    if (age === null) continue;
    if (freshestAgeHours === null || age < freshestAgeHours) freshestAgeHours = age;
    if (age <= NEWS_TODAY_AGE_HOURS && isIntradayMovingHeadline(item)) hasIntradayMover = true;
    if (isPrimaryFinancialWire(item.source)) hasPrimaryWire = true;
  }

  let ceiling: number = NEWS_BONUS_CEILING.stale;
  let reason = 'nessuna notizia entro 24h: il bonus vale 0';
  if (freshestAgeHours !== null && freshestAgeHours <= NEWS_INTRADAY_AGE_HOURS) {
    if (hasIntradayMover) {
      ceiling = NEWS_BONUS_CEILING.intradayMover;
      reason = 'evento rilevante entro 6h: bonus pieno';
    } else {
      ceiling = NEWS_BONUS_CEILING.intradayContext;
      reason = 'notizia entro 6h senza evento rilevante: solo contesto';
    }
  } else if (freshestAgeHours !== null && freshestAgeHours <= NEWS_TODAY_AGE_HOURS) {
    if (hasIntradayMover) {
      ceiling = NEWS_BONUS_CEILING.todayMover;
      reason = 'evento rilevante di oggi (<=24h): bonus alto ma non pieno';
    } else {
      ceiling = NEWS_BONUS_CEILING.todayContext;
      reason = 'notizia di oggi senza evento rilevante: solo contesto';
    }
  }

  return { ceiling, freshestAgeHours, hasIntradayMover, hasPrimaryWire, bandCounts, reason };
}

/** Vero se il pool contiene almeno una notizia piu' giovane di `hours`. */
export function hasNewsWithinHours(
  news: readonly FilterableNewsItem[] | null | undefined,
  nowMs: number,
  hours: number
): boolean {
  for (const item of news ?? []) {
    const age = newsAgeHours(item, nowMs);
    if (age !== null && age <= hours) return true;
  }
  return false;
}

/**
 * Unisce piu' liste di notizie tenendo la piu' fresca per titolo, in ordine di
 * pubblicazione decrescente. Serve a non fermarsi alla prima fonte: se Finnhub
 * porta solo articoli vecchi, il pool si arricchisce con i feed live.
 */
export function mergeNewsByRecency<T extends FilterableNewsItem>(
  base: readonly T[] | null | undefined,
  extra: readonly T[] | null | undefined,
  limit: number = 5
): T[] {
  const byTitle = new Map<string, T>();
  const push = (item: T | null | undefined) => {
    if (!item || typeof item.title !== 'string' || item.title.trim().length === 0) return;
    const key = item.title.trim().toLowerCase().replace(/\s+/g, ' ');
    const prev = byTitle.get(key);
    const prevMs = prev?.publishedAt ? Date.parse(prev.publishedAt) : Number.NEGATIVE_INFINITY;
    const nextMs = item.publishedAt ? Date.parse(item.publishedAt) : Number.NEGATIVE_INFINITY;
    if (!prev || nextMs > prevMs) byTitle.set(key, item);
  };
  for (const item of base ?? []) push(item);
  for (const item of extra ?? []) push(item);
  const ordered = [...byTitle.values()].sort((a, b) => {
    const ams = a.publishedAt ? Date.parse(a.publishedAt) : Number.NEGATIVE_INFINITY;
    const bms = b.publishedAt ? Date.parse(b.publishedAt) : Number.NEGATIVE_INFINITY;
    return bms - ams;
  });
  return ordered.slice(0, Math.max(1, limit));
}

export interface NormalizedFuturesContext {
  changePercent: number | null;
  benchmarkLabel: string;
  normalized: Record<string, unknown>;
}

function finiteNumber(val: unknown): number | null {
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
}

function isPlainObject(val: unknown): val is Record<string, any> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Normalizes `futures` payloads regardless of whether the caller passed:
 * - full `{ europe: { dax, eurostoxx }, usa: { sp500, nasdaq } }`,
 * - market slice `{ dax, eurostoxx }` or `{ sp500, nasdaq }`, or
 * - direct quote `{ changePercent }`.
 */
export function normalizeFuturesPayload(
  futures: unknown,
  market: string | undefined | null
): NormalizedFuturesContext {
  const isUS = String(market || '').toUpperCase() === 'US';
  if (!isPlainObject(futures)) {
    return {
      changePercent: null,
      benchmarkLabel: isUS ? 'S&P 500' : 'DAX',
      normalized: {},
    };
  }

  const euSlice = isPlainObject(futures.europe) ? futures.europe : futures;
  const usSlice = isPlainObject(futures.usa) ? futures.usa : futures;

  const daxChange = finiteNumber(euSlice?.dax?.changePercent);
  const stoxxChange = finiteNumber(euSlice?.eurostoxx?.changePercent);
  const sp500Change = finiteNumber(usSlice?.sp500?.changePercent);
  const nasdaqChange = finiteNumber(usSlice?.nasdaq?.changePercent);
  const directChange = finiteNumber(futures.changePercent);

  if (isUS) {
    const changePercent = sp500Change ?? nasdaqChange ?? directChange;
    const benchmarkLabel = sp500Change !== null ? 'S&P 500' : nasdaqChange !== null ? 'Nasdaq 100' : 'US Index';
    return {
      changePercent,
      benchmarkLabel,
      normalized: {
        market: 'US',
        sp500ChangePct: sp500Change,
        nasdaqChangePct: nasdaqChange,
        ...(daxChange !== null ? { daxChangePct: daxChange } : {}),
      },
    };
  }

  const changePercent = daxChange ?? stoxxChange ?? directChange;
  const benchmarkLabel = daxChange !== null ? 'DAX' : stoxxChange !== null ? 'EuroStoxx 50' : 'EU Index';
  return {
    changePercent,
    benchmarkLabel,
    normalized: {
      market: 'EU',
      daxChangePct: daxChange,
      eurostoxxChangePct: stoxxChange,
      ...(sp500Change !== null ? { sp500ChangePct: sp500Change } : {}),
    },
  };
}
