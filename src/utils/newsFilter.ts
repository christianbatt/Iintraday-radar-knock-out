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
