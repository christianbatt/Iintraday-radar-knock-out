/**
 * Collettore parallelo Shadow V2 (SOLA OSSERVAZIONE / ZERO EFFETTO LIVE).
 *
 * Riceve le barre 5m reali gia' scaricate dal server durante le scansioni
 * e persiste in locale `artifacts/shadow_v2/signals.jsonl` e `summary.json`
 * senza mai toccare punteggi, UI o SETUP_SELECTOR_LIVE.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IndicatorBarInput, RawQuoteData } from '../types/radar';
import {
  evaluateShadowV2OnBars,
  SHADOW_V2_BAR_MS,
  summarizeShadowV2,
  type ShadowV2Record,
  type ShadowV2Summary,
} from '../knowledge/shadowV2';
import { syncShadowV2ToFirestore } from './shadowFirestoreSync';

interface StoredBarsEntry {
  ticker: string;
  market: 'EU' | 'US';
  bars: IndicatorBarInput[];
  updatedAt: number;
}

const recentBarsStore = new Map<string, StoredBarsEntry>();

const MAX_BARS_PER_TICKER = 600;

function barsStoreKey(ticker: string, market: 'EU' | 'US'): string {
  return `${market}|${ticker}`;
}

function mergeClosedBarsV2(
  existing: readonly IndicatorBarInput[],
  incoming: readonly IndicatorBarInput[],
  nowMs: number
): IndicatorBarInput[] {
  const byTs = new Map<number, IndicatorBarInput>();
  const accept = (b: IndicatorBarInput) => {
    if (
      b &&
      Number.isFinite(b.t) &&
      b.t > 0 &&
      b.t % SHADOW_V2_BAR_MS === 0 &&
      b.t + SHADOW_V2_BAR_MS <= nowMs &&
      [b.o, b.h, b.l, b.c].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) &&
      b.h >= b.l
    ) {
      byTs.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
  };
  for (const b of existing) accept(b);
  for (const b of incoming) accept(b);
  const merged = Array.from(byTs.values()).sort((a, b) => a.t - b.t);
  return merged.length > MAX_BARS_PER_TICKER ? merged.slice(-MAX_BARS_PER_TICKER) : merged;
}

/** Memorizza barre 5m reali gia' chiuse per un ticker (zero look-ahead). */
export function recordClosedBarsForShadowV2(
  ticker: string,
  market: 'EU' | 'US',
  rawBars: readonly IndicatorBarInput[],
  nowMs: number = Date.now()
): void {
  try {
    if (!ticker || !Array.isArray(rawBars) || rawBars.length === 0) return;
    const key = barsStoreKey(ticker, market);
    const existing = recentBarsStore.get(key)?.bars ?? [];
    const trimmed = mergeClosedBarsV2(existing, rawBars, nowMs);
    if (trimmed.length === 0) return;

    recentBarsStore.set(key, {
      ticker,
      market,
      bars: trimmed,
      updatedAt: nowMs,
    });
  } catch {
    // Non interferisce mai con il flusso principale di scansione
  }
}

export function loadShadowV2BarsFromDisk(
  rootDir: string = process.cwd(),
  nowMs: number = Date.now()
): number {
  const barsPath = path.join(rootDir, 'artifacts', 'shadow_v2', 'bars.json');
  if (!fs.existsSync(barsPath)) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(barsPath, 'utf8')) as {
      entries?: StoredBarsEntry[];
    } | null;
    if (!raw || !Array.isArray(raw.entries)) return 0;
    let loaded = 0;
    let sanitized = false;
    for (const entry of raw.entries) {
      if (
        !entry ||
        typeof entry.ticker !== 'string' ||
        (entry.market !== 'EU' && entry.market !== 'US') ||
        !Array.isArray(entry.bars)
      ) {
        continue;
      }
      const key = barsStoreKey(entry.ticker, entry.market);
      const existing = recentBarsStore.get(key)?.bars ?? [];
      const merged = mergeClosedBarsV2(existing, entry.bars, nowMs);
      if (merged.length < entry.bars.length) {
        sanitized = true;
      }
      if (merged.length > 0) {
        recentBarsStore.set(key, {
          ticker: entry.ticker,
          market: entry.market,
          bars: merged,
          updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : nowMs,
        });
        loaded += 1;
      }
    }
    if (sanitized && loaded > 0) {
      saveShadowV2BarsToDisk(rootDir, nowMs);
    }
    return loaded;
  } catch {
    return 0;
  }
}

export function saveShadowV2BarsToDisk(
  rootDir: string = process.cwd(),
  nowMs: number = Date.now()
): void {
  if (recentBarsStore.size === 0) return;
  try {
    const barsPath = path.join(rootDir, 'artifacts', 'shadow_v2', 'bars.json');
    const payload = {
      version: 1,
      updatedAt: new Date(nowMs).toISOString(),
      entries: Array.from(recentBarsStore.values()),
    };
    writeFileAtomic(barsPath, JSON.stringify(payload));
  } catch {
    // non bloccante
  }
}

export interface ShadowV2LoadResult {
  records: ShadowV2Record[];
  /** Righe non vuote scartate: JSON invalido o record senza `id`. */
  skipped: number;
}

/** Lettura con inventario delle righe scartate (per la copia di sicurezza). */
export function loadShadowV2RecordsWithStats(signalsPath: string): ShadowV2LoadResult {
  const records: ShadowV2Record[] = [];
  let skipped = 0;
  if (!fs.existsSync(signalsPath)) return { records, skipped };
  try {
    const raw = fs.readFileSync(signalsPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ShadowV2Record;
        if (parsed && typeof parsed.id === 'string') {
          records.push(parsed);
        } else {
          skipped += 1;
        }
      } catch {
        skipped += 1;
      }
    }
    return { records, skipped };
  } catch {
    return { records, skipped };
  }
}

export function loadShadowV2Records(signalsPath: string): ShadowV2Record[] {
  return loadShadowV2RecordsWithStats(signalsPath).records;
}

function writeFileAtomic(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

function isSummaryOutOfSync(
  summaryPath: string,
  expected: ShadowV2Summary
): boolean {
  if (!fs.existsSync(summaryPath)) return true;
  try {
    const raw = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as Partial<ShadowV2Summary> | null;
    if (!raw || typeof raw !== 'object') return true;
    const rawExpCount = Array.isArray(raw.experiments) ? raw.experiments.length : 0;
    const expCount = Array.isArray(expected.experiments) ? expected.experiments.length : 0;
    return (
      raw.nSignals !== expected.nSignals ||
      raw.nResolved !== expected.nResolved ||
      raw.nOpen !== expected.nOpen ||
      raw.nPendingOpen !== expected.nPendingOpen ||
      raw.nBlocked !== expected.nBlocked ||
      raw.nSessions !== expected.nSessions ||
      rawExpCount !== expCount
    );
  } catch {
    return true;
  }
}

/**
 * Riallinea `artifacts/shadow_v2/summary.json` con `signals.jsonl` se mancante,
 * corrotto o desincronizzato (es. server riavviato o segnale pregresso su disco)
 * e idrata `recentBarsStore` da `artifacts/shadow_v2/bars.json`.
 */
export function syncShadowV2SummaryFromDisk(
  rootDir: string = process.cwd(),
  nowMs: number = Date.now()
): ShadowV2Summary | null {
  try {
    loadShadowV2BarsFromDisk(rootDir, nowMs);
    const outDir = path.join(rootDir, 'artifacts', 'shadow_v2');
    const signalsPath = path.join(outDir, 'signals.jsonl');
    const summaryPath = path.join(outDir, 'summary.json');
    if (!fs.existsSync(signalsPath)) return null;

    const allRecords = loadShadowV2Records(signalsPath).sort((a, b) => a.signalBarTs - b.signalBarTs);
    const summary = summarizeShadowV2(allRecords, new Date(nowMs).toISOString());
    if (isSummaryOutOfSync(summaryPath, summary)) {
      writeFileAtomic(summaryPath, JSON.stringify(summary, null, 2));
    }
    if (allRecords.length > 0) {
      void syncShadowV2ToFirestore(allRecords, summary);
    }
    return summary;
  } catch (err: any) {
    console.warn('[Shadow V2 Collector] Errore riallineamento summary:', err?.message || err);
    return null;
  }
}

/**
 * Esegue valutazione Shadow V2 sulle barre reali accumulate dopo una scansione,
 * aggiorna `artifacts/shadow_v2/signals.jsonl`, `summary.json` e `bars.json`.
 */
export function observeShadowV2Scan(
  quotes: readonly Pick<RawQuoteData, 'ticker' | 'market'>[],
  rootDir: string = process.cwd(),
  nowMs: number = Date.now()
): ShadowV2Summary | null {
  try {
    const outDir = path.join(rootDir, 'artifacts', 'shadow_v2');
    const signalsPath = path.join(outDir, 'signals.jsonl');
    const summaryPath = path.join(outDir, 'summary.json');

    const existingRecords = loadShadowV2Records(signalsPath);
    const byId = new Map<string, ShadowV2Record>();
    for (const rec of existingRecords) {
      byId.set(rec.id, rec);
    }

    // Valuta i ticker della scansione corrente + quelli con segnali aperti in memoria
    const scanTickers = new Set(quotes.map((q) => q.ticker));
    const openTickers = new Set(
      existingRecords
        .filter((r) => r.status === 'PENDING_OPEN' || r.status === 'OPEN')
        .map((r) => r.ticker)
    );

    let changed = false;

    for (const entry of recentBarsStore.values()) {
      if (scanTickers.size > 0 && !scanTickers.has(entry.ticker) && !openTickers.has(entry.ticker)) {
        continue;
      }
      const computed = evaluateShadowV2OnBars(entry.ticker, entry.market, entry.bars, { nowMs });
      for (const rec of computed) {
        const prev = byId.get(rec.id);
        if (!prev) {
          byId.set(rec.id, rec);
          changed = true;
        } else if (prev.status === 'PENDING_OPEN' || prev.status === 'OPEN') {
          if (
            prev.status !== rec.status ||
            prev.outcome !== rec.outcome ||
            prev.barsHeld !== rec.barsHeld ||
            prev.rNet !== rec.rNet
          ) {
            byId.set(rec.id, rec);
            changed = true;
          }
        } else if (prev.status === 'RESOLVED' && !prev.altOutcomes && rec.altOutcomes) {
          byId.set(rec.id, { ...prev, altOutcomes: rec.altOutcomes });
          changed = true;
        }
      }
    }

    const allRecords = Array.from(byId.values()).sort((a, b) => a.signalBarTs - b.signalBarTs);
    const summary = summarizeShadowV2(allRecords, new Date(nowMs).toISOString());

    saveShadowV2BarsToDisk(rootDir, nowMs);

    if (changed) {
      const jsonl = allRecords.map((r) => JSON.stringify(r)).join('\n') + (allRecords.length ? '\n' : '');
      writeFileAtomic(signalsPath, jsonl);
      writeFileAtomic(summaryPath, JSON.stringify(summary, null, 2));
      void syncShadowV2ToFirestore(allRecords, summary);
    } else if (isSummaryOutOfSync(summaryPath, summary)) {
      writeFileAtomic(summaryPath, JSON.stringify(summary, null, 2));
      void syncShadowV2ToFirestore(allRecords, summary);
    }

    return summary;
  } catch (err: any) {
    console.warn('[Shadow V2 Collector] Errore non bloccante:', err?.message || err);
    return null;
  }
}

export function clearShadowV2BarsForTest(): void {
  recentBarsStore.clear();
}
