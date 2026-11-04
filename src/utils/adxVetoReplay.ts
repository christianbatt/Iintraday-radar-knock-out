/**
 * Replay dei veti ADX_BELOW_MARKET_THRESHOLD (IPOTESI): logica pura, nessun I/O.
 *
 * Input: i record scritti da server.ts in logs/adx_veto_log.jsonl.
 * Regola: per un veto long T1 e' raggiunto se una barra successiva al veto tocca T1 prima
 * dello stop; per uno short vale in modo speculare. Nessuna stima: se mancano barre
 * successive al veto (o entry/stop/T1) l'esito e' "dati insufficienti".
 */

export interface AdxVetoBar {
  t: number;
  h: number;
  l: number;
  c: number;
}

export interface AdxVetoRecord {
  ts: number;
  ticker: string;
  market: 'EU' | 'US';
  direction: 'LONG' | 'SHORT';
  etTime?: string;
  localTime?: string;
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
  threshold: number;
  entry: number | null;
  stop: number | null;
  t1: number | null;
  bars?: AdxVetoBar[];
}

export type ReplayOutcome = 'T1' | 'STOP' | 'NESSUNA' | 'dati insufficienti';

export interface ReplayRow {
  record: AdxVetoRecord;
  outcome: ReplayOutcome;
  barsAfter: number;
  bucket: string;
}

/** Fasce orarie locali richieste dal replay (orologio locale del mercato). */
export const LOCAL_BUCKETS = [
  { label: 'apertura 09:00-10:30', from: 9 * 60, to: 10 * 60 + 30 },
  { label: 'meta sessione 10:30-12:30', from: 10 * 60 + 30, to: 12 * 60 + 30 },
  { label: 'pranzo 12:30-14:30', from: 12 * 60 + 30, to: 14 * 60 + 30 },
  { label: 'pomeriggio 14:30-17:30', from: 14 * 60 + 30, to: 17 * 60 + 30 },
] as const;

export function localBucket(localTime: string | undefined): string {
  const match = /^(\d{2}):(\d{2})/.exec(localTime ?? '');
  if (!match) return 'fuori sessione';
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  const bucket = LOCAL_BUCKETS.find((b) => minutes >= b.from && minutes < b.to);
  return bucket ? bucket.label : 'fuori sessione';
}

/** Parsing tollerante del log JSONL: le righe non valide vengono scartate, mai inventate. */
export function parseAdxVetoLog(content: string): AdxVetoRecord[] {
  const records: AdxVetoRecord[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed.ticker !== 'string' || typeof parsed.ts !== 'number') continue;
    if (parsed.market !== 'EU' && parsed.market !== 'US') continue;
    if (parsed.direction !== 'LONG' && parsed.direction !== 'SHORT') continue;
    records.push(parsed as AdxVetoRecord);
  }
  return records;
}

/**
 * Replay di un singolo veto: usa le barre successive al veto presenti nel log per lo
 * stesso ticker (deduplicate per timestamp e ordinate). Restituisce "dati insufficienti"
 * quando non ci sono barre successive o mancano entry/stop/T1.
 */
export function replayVetoes(records: readonly AdxVetoRecord[]): ReplayRow[] {
  const barsByTicker = new Map<string, AdxVetoBar[]>();
  for (const record of records) {
    const list = barsByTicker.get(record.ticker) ?? [];
    for (const bar of record.bars ?? []) {
      if (!bar || !Number.isFinite(bar.t) || !Number.isFinite(bar.h) || !Number.isFinite(bar.l)) continue;
      list.push(bar);
    }
    barsByTicker.set(record.ticker, list);
  }

  return records.map((record) => {
    const bucket = localBucket(record.localTime);
    const { entry, stop, t1 } = record;
    if (
      entry == null ||
      stop == null ||
      t1 == null ||
      !Number.isFinite(entry) ||
      !Number.isFinite(stop) ||
      !Number.isFinite(t1)
    ) {
      return { record, outcome: 'dati insufficienti' as ReplayOutcome, barsAfter: 0, bucket };
    }

    const seen = new Set<number>();
    const barsAfter: AdxVetoBar[] = [];
    for (const bar of barsByTicker.get(record.ticker) ?? []) {
      if (bar.t <= record.ts || seen.has(bar.t)) continue;
      seen.add(bar.t);
      barsAfter.push(bar);
    }
    barsAfter.sort((a, b) => a.t - b.t);
    if (barsAfter.length === 0) {
      return { record, outcome: 'dati insufficienti' as ReplayOutcome, barsAfter: 0, bucket };
    }

    for (const bar of barsAfter) {
      if (record.direction === 'LONG') {
        if (bar.l <= stop) return { record, outcome: 'STOP' as ReplayOutcome, barsAfter: barsAfter.length, bucket };
        if (bar.h >= t1) return { record, outcome: 'T1' as ReplayOutcome, barsAfter: barsAfter.length, bucket };
      } else {
        if (bar.h >= stop) return { record, outcome: 'STOP' as ReplayOutcome, barsAfter: barsAfter.length, bucket };
        if (bar.l <= t1) return { record, outcome: 'T1' as ReplayOutcome, barsAfter: barsAfter.length, bucket };
      }
    }
    return { record, outcome: 'NESSUNA' as ReplayOutcome, barsAfter: barsAfter.length, bucket };
  });
}

export interface ReplaySummaryRow {
  market: string;
  bucket: string;
  total: number;
  t1: number;
  stop: number;
  nessuna: number;
  insufficienti: number;
  /** T1 / (T1 + STOP); null se non ci sono esiti valutabili. */
  t1Pct: number | null;
}

/** Aggregazione per mercato e fascia oraria locale. */
export function summarizeReplay(rows: readonly ReplayRow[]): ReplaySummaryRow[] {
  const markets = Array.from(new Set(rows.map((row) => row.record.market))).sort();
  const buckets = [...LOCAL_BUCKETS.map((b) => b.label), 'fuori sessione'];
  const summary: ReplaySummaryRow[] = [];

  for (const market of markets) {
    for (const bucket of buckets) {
      const subset = rows.filter((row) => row.record.market === market && row.bucket === bucket);
      if (subset.length === 0) continue;
      const count = (outcome: ReplayOutcome) => subset.filter((row) => row.outcome === outcome).length;
      const t1 = count('T1');
      const stop = count('STOP');
      summary.push({
        market,
        bucket,
        total: subset.length,
        t1,
        stop,
        nessuna: count('NESSUNA'),
        insufficienti: count('dati insufficienti'),
        t1Pct: t1 + stop > 0 ? +((t1 / (t1 + stop)) * 100).toFixed(1) : null,
      });
    }
  }

  return summary;
}
