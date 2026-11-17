/**
 * Collettore parallelo Shadow V2 (SOLA OSSERVAZIONE / ZERO EFFETTO LIVE).
 *
 * Riceve le barre 5m reali gia' scaricate dal server durante le scansioni
 * e persiste in locale `artifacts/shadow_v2/signals.jsonl` e `summary.json`
 * senza mai toccare punteggi, UI o SETUP_SELECTOR_LIVE.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { IndicatorBarInput, RawQuoteData } from '../types/radar';
import {
  evaluateShadowV2OnBars,
  SHADOW_V2_BAR_MS,
  summarizeShadowV2,
  type ShadowV2Record,
  type ShadowV2Summary,
} from '../knowledge/shadowV2';

interface StoredBarsEntry {
  ticker: string;
  market: 'EU' | 'US';
  bars: IndicatorBarInput[];
  updatedAt: number;
}

const recentBarsStore = new Map<string, StoredBarsEntry>();

const MAX_BARS_PER_TICKER = 600;

/** Memorizza barre 5m reali gia' chiuse per un ticker (zero look-ahead). */
export function recordClosedBarsForShadowV2(
  ticker: string,
  market: 'EU' | 'US',
  rawBars: readonly IndicatorBarInput[],
  nowMs: number = Date.now()
): void {
  try {
    if (!ticker || !Array.isArray(rawBars) || rawBars.length === 0) return;

    const existing = recentBarsStore.get(ticker)?.bars ?? [];
    const byTs = new Map<number, IndicatorBarInput>();

    for (const b of existing) {
      if (Number.isFinite(b.t) && b.t > 0 && b.t + SHADOW_V2_BAR_MS <= nowMs) {
        byTs.set(b.t, b);
      }
    }
    for (const b of rawBars) {
      if (
        Number.isFinite(b.t) &&
        b.t > 0 &&
        b.t + SHADOW_V2_BAR_MS <= nowMs &&
        [b.o, b.h, b.l, b.c].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
      ) {
        byTs.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      }
    }

    const merged = Array.from(byTs.values()).sort((a, b) => a.t - b.t);
    const trimmed =
      merged.length > MAX_BARS_PER_TICKER ? merged.slice(-MAX_BARS_PER_TICKER) : merged;

    recentBarsStore.set(ticker, {
      ticker,
      market,
      bars: trimmed,
      updatedAt: nowMs,
    });
  } catch {
    // Non interferisce mai con il flusso principale di scansione
  }
}

export function loadShadowV2Records(signalsPath: string): ShadowV2Record[] {
  if (!fs.existsSync(signalsPath)) return [];
  try {
    const raw = fs.readFileSync(signalsPath, 'utf8');
    const out: ShadowV2Record[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ShadowV2Record;
        if (parsed && typeof parsed.id === 'string') {
          out.push(parsed);
        }
      } catch {
        // Riga JSONL malformata ignorata senza inventario
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeFileAtomic(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Esegue valutazione Shadow V2 sulle barre reali accumulate dopo una scansione,
 * aggiorna `artifacts/shadow_v2/signals.jsonl` e `artifacts/shadow_v2/summary.json`.
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

    for (const [ticker, entry] of recentBarsStore.entries()) {
      if (scanTickers.size > 0 && !scanTickers.has(ticker) && !openTickers.has(ticker)) {
        continue;
      }
      const computed = evaluateShadowV2OnBars(ticker, entry.market, entry.bars, { nowMs });
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
        }
      }
    }

    const allRecords = Array.from(byId.values()).sort((a, b) => a.signalBarTs - b.signalBarTs);
    const summary = summarizeShadowV2(allRecords, new Date(nowMs).toISOString());

    if (changed || !fs.existsSync(summaryPath)) {
      const jsonl = allRecords.map((r) => JSON.stringify(r)).join('\n') + (allRecords.length ? '\n' : '');
      writeFileAtomic(signalsPath, jsonl);
      writeFileAtomic(summaryPath, JSON.stringify(summary, null, 2));
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
