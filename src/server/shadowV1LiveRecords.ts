/**
 * SHADOW V1 — nucleo condiviso dei registri controfattuali (SOLA OSSERVAZIONE).
 *
 * `shadowV1LiveNearMiss.ts` e `shadowV1LiveRejected.ts` seguono lo stesso ciclo
 * di vita: leggono un JSONL, registrano una riga per ticker/sessione con i
 * livelli del setup, rivalutano i record aperti sulle barre 5m chiuse con
 * `evaluateShadowV1Live` (zero look-ahead) e riscrivono il file in modo
 * atomico. Questo modulo tiene quella meccanica in un solo posto.
 *
 * I due registri restano separati per file, collezione Firestore, tetto e
 * criteri di ingresso: qui vive solo cio' che sarebbe identico in entrambi.
 * Nessuna scrittura ufficiale: non tocca `signals.jsonl`, le metriche V1 ne'
 * SETUP_SELECTOR_LIVE.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluateShadowV1Live } from '../knowledge/shadowV1Live';
import { barsForShadowV1Live } from './shadowV1LiveCollector';

/** Stati del ciclo di vita condivisi da near-miss e scarti. */
export type NearMissStatus =
  | 'PENDING_FILL'
  | 'OPEN'
  | 'TARGET'
  | 'STOP'
  | 'EXPIRED'
  | 'NOT_FILLED';

const OPEN_FORWARD_STATUSES: ReadonlySet<string> = new Set(['PENDING_FILL', 'OPEN']);
const RESOLVED_FORWARD_STATUSES: ReadonlySet<string> = new Set(['TARGET', 'STOP', 'EXPIRED']);

/** `PENDING_FILL` < `OPEN` < terminale: usato dai merge monotoni. */
export function forwardStatusRank(status: string): number {
  if (status === 'PENDING_FILL') return 0;
  if (status === 'OPEN') return 1;
  return 2;
}

/** Il record va ancora rivalutato sulle barre? */
export function isOpenForwardStatus(status: string): boolean {
  return OPEN_FORWARD_STATUSES.has(status);
}

/** L'esito e' definitivo e utilizzabile come punto forward? */
export function isResolvedForwardOutcome(status: string, r: unknown): boolean {
  return (
    RESOLVED_FORWARD_STATUSES.has(status) && typeof r === 'number' && Number.isFinite(r)
  );
}

/** Scrittura atomica di testo (tmp + rename) nella directory del file. */
export function writeAtomicText(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

/** Scrittura atomica di un JSONL: una riga per record. */
export function writeJsonlAtomic(targetPath: string, rows: readonly unknown[]): void {
  writeAtomicText(
    targetPath,
    rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
  );
}

export interface JsonlLoadResult<T> {
  records: T[];
  /** Righe non vuote scartate: JSON invalido o record senza i campi minimi. */
  skipped: number;
}

function isDefaultRecord(value: unknown): value is { id: string; ticker: string } {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.ticker === 'string';
}

/** Lettura JSONL tollerante, con inventario delle righe scartate. */
export function readJsonlRecords<T extends { id: string; ticker: string }>(
  filePath: string,
  isRecord?: (value: unknown) => value is T
): JsonlLoadResult<T> {
  const records: T[] = [];
  let skipped = 0;
  if (!fs.existsSync(filePath)) return { records, skipped };
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        skipped += 1;
        continue;
      }
      if (isRecord ? isRecord(parsed) : isDefaultRecord(parsed)) {
        records.push(parsed as T);
      } else {
        skipped += 1;
      }
    }
  } catch {
    return { records, skipped };
  }
  return { records, skipped };
}

/** C'e' almeno un record da rivalutare? */
export function hasOpenForwardRecords<T extends { status: NearMissStatus }>(
  records: readonly T[]
): boolean {
  return records.some((r) => isOpenForwardStatus(r.status));
}

/** Campi minimi che rendono un record rivalutabile dal motore di esito. */
export interface ForwardTrackableRecord {
  ticker: string;
  market: 'EU' | 'US';
  direction: 'LONG' | 'SHORT';
  entryLevel: number;
  stopLossLevel: number;
  target1Level: number;
  decidedAtMs: number;
  sessionCloseMs: number;
  status: NearMissStatus;
  r: number | null;
  fillBarTs: number | null;
  exitBarTs: number | null;
  exitPrice: number | null;
  updatedAtMs: number;
}

/**
 * Rivaluta in loco i soli record non terminali sulle barre 5m chiuse gia'
 * raccolte. Ritorna `true` se almeno un record e' cambiato (il chiamante decide
 * se riscrivere). Nessun record viene creato o rimosso qui.
 */
export function reevaluateForwardRecords<T extends ForwardTrackableRecord>(
  byId: Map<string, T>,
  nowMs: number
): boolean {
  let changed = false;
  for (const [id, rec] of byId.entries()) {
    if (!isOpenForwardStatus(rec.status)) continue;
    const bars = barsForShadowV1Live(rec.ticker, rec.market);
    if (bars.length === 0 && nowMs <= rec.sessionCloseMs) continue;

    const evalRes = evaluateShadowV1Live({
      setup: {
        candidate: { ticker: rec.ticker },
        decision: 'TRADE',
        direction: rec.direction,
        entryLevel: rec.entryLevel,
        triggerLevel: rec.entryLevel,
        stopLossLevel: rec.stopLossLevel,
        target1Level: rec.target1Level,
      },
      decidedAtMs: rec.decidedAtMs,
      sessionCloseMs: rec.sessionCloseMs,
      nowMs,
      bars,
    });

    if (evalRes.status === 'INVALID_SETUP' || evalRes.status === 'DUPLICATE') continue;
    const nextStatus = evalRes.status as NearMissStatus;
    if (
      nextStatus === rec.status &&
      evalRes.r === rec.r &&
      evalRes.fillBarTs === rec.fillBarTs &&
      evalRes.exitBarTs === rec.exitBarTs
    ) {
      continue;
    }
    byId.set(id, {
      ...rec,
      status: nextStatus,
      r: evalRes.r,
      fillBarTs: evalRes.fillBarTs,
      exitBarTs: evalRes.exitBarTs,
      exitPrice: evalRes.exitPrice,
      updatedAtMs: nowMs,
    });
    changed = true;
  }
  return changed;
}

/** Campi minimi di un record letto da Firestore. */
export interface ForwardRecordMergeable {
  id: string;
  status: string;
  decidedAtMs: number;
  updatedAtMs: number;
}

/** Validazione strutturale condivisa dei documenti Firestore dei due registri. */
export function isValidForwardRecordShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.ticker === 'string' &&
    (r.market === 'EU' || r.market === 'US') &&
    (r.direction === 'LONG' || r.direction === 'SHORT') &&
    typeof r.decidedAtMs === 'number' &&
    Number.isFinite(r.decidedAtMs) &&
    typeof r.status === 'string'
  );
}

/**
 * Unione monotona per `id`: un esito terminale non torna indietro e, a parita'
 * di stato, vince il record aggiornato piu' di recente. Tiene gli ultimi
 * `maxRecords` per `decidedAtMs`.
 */
export function mergeForwardRecordsMonotone<T extends ForwardRecordMergeable>(
  a: readonly T[],
  b: readonly T[],
  maxRecords: number
): T[] {
  const byId = new Map<string, T>();
  const accept = (rec: T) => {
    const prev = byId.get(rec.id);
    if (!prev) {
      byId.set(rec.id, rec);
      return;
    }
    const pr = forwardStatusRank(prev.status);
    const nr = forwardStatusRank(rec.status);
    if (nr > pr || (nr === pr && rec.updatedAtMs >= prev.updatedAtMs)) {
      byId.set(rec.id, rec);
    }
  };
  for (const r of a) accept(r);
  for (const r of b) accept(r);
  return Array.from(byId.values())
    .sort((x, y) => x.decidedAtMs - y.decidedAtMs)
    .slice(-maxRecords);
}
