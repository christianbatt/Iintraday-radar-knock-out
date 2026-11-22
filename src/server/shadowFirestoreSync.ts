/**
 * Persistenza cloud su Firebase Firestore per Shadow V1-live, Near-Miss V1 e Shadow V2.
 *
 * Architettura a doppia tenuta (locale + Firestore):
 * - Su avvio server (`hydrateAllShadowStateFromFirestore`), fonde lo stato salvato in
 *   Firestore `_system/shadow_*` con gli eventuali file su disco (`artifacts/...`),
 *   senza mai regredire stati terminali o perdere operazioni storiche oltre la finestra
 *   600 barre di Yahoo Finance.
 * - Ogni mutazione incrementale su V1-live (`signals.jsonl`), Near-Miss (`near_miss.jsonl`),
 *   diagnostica/marks V1 e V2 (`signals.jsonl` + `summary.json`) sincronizza su Firestore
 *   solo i documenti nuovi o modificati (diff cache in RAM, batch <= 400).
 * - Isolamento completo: nessuna eccezione viene propagata; in assenza di adapter
 *   (es. nei test unitari o se Firebase non e' configurato) tutte le operazioni sono no-op.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Firestore } from 'firebase-admin/firestore';
import type { ShadowV1LiveBar } from '../knowledge/shadowV1Live';
import { summarizeShadowV2, type ShadowV2Record, type ShadowV2Summary } from '../knowledge/shadowV2';
import type { ShadowV1LiveMarksPayload } from './shadowV1LiveMarks';
import {
  loadNearMissRecordsWithStats,
  SHADOW_V1_NEAR_MISS_MAX_RECORDS,
  SHADOW_V1_NEAR_MISS_PATH,
  SHADOW_V1_NEAR_MISS_SUMMARY_PATH,
  summarizeNearMissRecords,
  type ShadowV1NearMissRecord,
  type ShadowV1NearMissSummary,
} from './shadowV1LiveNearMiss';
import {
  archiveClosedMonths,
  listArchivePaths,
  mergeRecordFiles,
  monthKeyUtc,
} from './shadowV1LiveRetention';
import type { ShadowV1LiveScanDiagnostics } from './shadowV1LiveScanner';
import {
  isValidPersistedRecord,
  loadRecords,
  SHADOW_V1_LIVE_SIGNALS_PATH,
  shadowV1LiveTmpPath,
  writeRecordsAtomic,
  type PersistedShadowV1LiveRecord,
} from './shadowV1LiveStore';
import {
  flushShadowV1LiveBarsToDisk,
  recordBarsForShadowV1Live,
  runInShadowV1LiveStoreQueue,
  saveShadowV1LiveBarsToDisk,
} from './shadowV1LiveCollector';
import { loadShadowV2RecordsWithStats } from './shadowV2Collector';

export const SHADOW_V1_SIGNALS_COLLECTION = '_system/shadow_v1_live/signals';
export const SHADOW_V1_NEAR_MISS_COLLECTION = '_system/shadow_v1_live/near_miss';
export const SHADOW_V1_DIAGNOSTICS_DOC = '_system/shadow_v1_live/meta/scan_diagnostics';
export const SHADOW_V1_NEAR_MISS_SUMMARY_DOC = '_system/shadow_v1_live/meta/near_miss_summary';
export const SHADOW_V1_LIVE_MARKS_DOC = '_system/shadow_v1_live/meta/live_marks';
export const SHADOW_V1_ACTIVE_BARS_DOC = '_system/shadow_v1_live/meta/active_bars';
export const SHADOW_V2_SIGNALS_COLLECTION = '_system/shadow_v2/signals';
export const SHADOW_V2_SUMMARY_DOC = '_system/shadow_v2/meta/summary';

const FIRESTORE_SYNC_TIMEOUT_MS = 5_000;
const FIRESTORE_BATCH_MAX = 400;
const ACTIVE_BARS_MAX_PER_TICKER = 80;
// Misura locale (artifacts/shadow_v1_live/bars.json, 40 ticker): 600 barre per ticker,
// quindi il documento Firestore conserva 80/600 = 13,3% della storia. Il contenuto del
// documento remoto non è stato verificato: la proporzione va riletta sul dato reale.

export interface ActiveBarsCacheEntry {
  ticker: string;
  market: 'EU' | 'US';
  bars: ShadowV1LiveBar[];
  updatedAt: number;
}

export interface ShadowFirestoreAdapter {
  getDoc(docPath: string): Promise<Record<string, unknown> | null>;
  setDoc(docPath: string, data: Record<string, unknown>): Promise<void>;
  listDocs(collectionPath: string): Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  batchSetDocs(items: Array<{ path: string; data: Record<string, unknown> }>): Promise<void>;
}

let activeAdapter: ShadowFirestoreAdapter | null = null;
const syncedHashByPath = new Map<string, string>();
let pendingSyncChain: Promise<void> = Promise.resolve();

export function shadowDocIdForKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function sanitizeForFirestore<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForFirestore(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = sanitizeForFirestore(v);
      }
    }
    return out as T;
  }
  return value;
}

export function createAdminFirestoreAdapter(firestore: Firestore): ShadowFirestoreAdapter {
  return {
    async getDoc(docPath: string) {
      const snap = await firestore.doc(docPath).get();
      if (!snap.exists) return null;
      return (snap.data() as Record<string, unknown>) ?? null;
    },
    async setDoc(docPath: string, data: Record<string, unknown>) {
      await firestore.doc(docPath).set(sanitizeForFirestore(data), { merge: true });
    },
    async listDocs(collectionPath: string) {
      const snap = await firestore.collection(collectionPath).get();
      return snap.docs.map((d) => ({
        id: d.id,
        data: (d.data() as Record<string, unknown>) ?? {},
      }));
    },
    async batchSetDocs(items: Array<{ path: string; data: Record<string, unknown> }>) {
      for (let i = 0; i < items.length; i += FIRESTORE_BATCH_MAX) {
        const chunk = items.slice(i, i + FIRESTORE_BATCH_MAX);
        const batch = firestore.batch();
        for (const item of chunk) {
          batch.set(firestore.doc(item.path), sanitizeForFirestore(item.data), { merge: true });
        }
        await batch.commit();
      }
    },
  };
}

export function setShadowFirestoreAdapter(adapter: ShadowFirestoreAdapter | null): void {
  activeAdapter = adapter;
  syncedHashByPath.clear();
}

export function resetShadowFirestoreSyncForTest(): void {
  activeAdapter = null;
  syncedHashByPath.clear();
  pendingSyncChain = Promise.resolve();
}

export async function flushPendingShadowFirestoreSync(): Promise<void> {
  await pendingSyncChain.catch(() => {});
}

function enqueueFirestoreWrite(task: () => Promise<void>): Promise<void> {
  const next = pendingSyncChain.then(task, task);
  pendingSyncChain = next.catch(() => {});
  return next;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[Shadow Firestore] Timeout (${FIRESTORE_SYNC_TIMEOUT_MS}ms) su ${label}`);
          resolve(null);
        }, FIRESTORE_SYNC_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hashPayload(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value), 'utf8').digest('hex');
}

function writeFileAtomicSync(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = shadowV1LiveTmpPath(targetPath);
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

function readJsonFileSafe<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Copia di sicurezza prima di una riscrittura che scarta righe non valide.
 * Non sovrascrive mai un backup esistente (suffisso progressivo in caso di
 * collisione) e non propaga eccezioni: un backup fallito non blocca l'idratazione.
 */
function backupBeforeRewrite(
  filePath: string,
  skippedLines: number,
  label: string,
  nowMs: number
): string | null {
  if (skippedLines <= 0) return null;
  if (!fs.existsSync(filePath)) return null;
  const base = `${filePath}.bak-${new Date(nowMs).toISOString()}`;
  let target = base;
  let attempt = 1;
  while (fs.existsSync(target)) {
    target = `${base}-${attempt}`;
    attempt += 1;
  }
  try {
    fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL);
    console.warn(
      `[Shadow Firestore] ${label}: ${skippedLines} righe scartate in lettura; copia di sicurezza in ${path.basename(target)}`
    );
    return target;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Shadow Firestore] ${label}: backup non riuscito (${msg}); ${skippedLines} righe scartate in lettura`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Merge rules monotone (nessuna perdita ne' regressione di stato)
// ---------------------------------------------------------------------------

function v1StatusRank(status: string): number {
  if (status === 'PENDING_FILL') return 0;
  if (status === 'OPEN') return 1;
  return 2;
}

export function mergeV1LiveRecordsMonotone(
  a: readonly PersistedShadowV1LiveRecord[],
  b: readonly PersistedShadowV1LiveRecord[]
): PersistedShadowV1LiveRecord[] {
  const byKey = new Map<string, PersistedShadowV1LiveRecord>();
  const accept = (rec: PersistedShadowV1LiveRecord) => {
    const prev = byKey.get(rec.key);
    if (!prev) {
      byKey.set(rec.key, rec);
      return;
    }
    const prevRank = v1StatusRank(prev.status);
    const nextRank = v1StatusRank(rec.status);
    const firstSeenAtMs = Math.min(prev.firstSeenAtMs, rec.firstSeenAtMs);
    if (nextRank > prevRank) {
      byKey.set(rec.key, { ...rec, firstSeenAtMs });
      return;
    }
    if (nextRank < prevRank) {
      if (firstSeenAtMs !== prev.firstSeenAtMs) {
        byKey.set(rec.key, { ...prev, firstSeenAtMs });
      }
      return;
    }
    // Stesso rango: se terminali, non sovrascrivere esiti gia' fissati tranne firstSeenAtMs
    if (prevRank === 2) {
      if (firstSeenAtMs !== prev.firstSeenAtMs) {
        byKey.set(rec.key, { ...prev, firstSeenAtMs });
      }
      return;
    }
    const winner = rec.updatedAtMs >= prev.updatedAtMs ? rec : prev;
    byKey.set(rec.key, { ...winner, firstSeenAtMs });
  };
  for (const r of a) accept(r);
  for (const r of b) accept(r);
  return Array.from(byKey.values()).sort((x, y) =>
    x.decidedAtMs !== y.decidedAtMs ? x.decidedAtMs - y.decidedAtMs : x.key < y.key ? -1 : x.key > y.key ? 1 : 0
  );
}

function nearMissRank(status: string): number {
  if (status === 'PENDING_FILL') return 0;
  if (status === 'OPEN') return 1;
  return 2;
}

export function isValidNearMissRecord(value: unknown): value is ShadowV1NearMissRecord {
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

export function mergeNearMissRecordsMonotone(
  a: readonly ShadowV1NearMissRecord[],
  b: readonly ShadowV1NearMissRecord[]
): ShadowV1NearMissRecord[] {
  const byId = new Map<string, ShadowV1NearMissRecord>();
  const accept = (rec: ShadowV1NearMissRecord) => {
    const prev = byId.get(rec.id);
    if (!prev) {
      byId.set(rec.id, rec);
      return;
    }
    const pr = nearMissRank(prev.status);
    const nr = nearMissRank(rec.status);
    if (nr > pr || (nr === pr && rec.updatedAtMs >= prev.updatedAtMs)) {
      byId.set(rec.id, rec);
    }
  };
  for (const r of a) accept(r);
  for (const r of b) accept(r);
  return Array.from(byId.values())
    .sort((x, y) => x.decidedAtMs - y.decidedAtMs)
    .slice(-SHADOW_V1_NEAR_MISS_MAX_RECORDS);
}

function v2StatusRank(status: string): number {
  if (status === 'PENDING_OPEN') return 0;
  if (status === 'OPEN') return 1;
  return 2;
}

export function isValidShadowV2Record(value: unknown): value is ShadowV2Record {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.ticker === 'string' &&
    (r.market === 'EU' || r.market === 'US') &&
    (r.direction === 'LONG' || r.direction === 'SHORT') &&
    typeof r.signalBarTs === 'number' &&
    Number.isFinite(r.signalBarTs) &&
    typeof r.status === 'string'
  );
}

export function mergeShadowV2RecordsMonotone(
  a: readonly ShadowV2Record[],
  b: readonly ShadowV2Record[]
): ShadowV2Record[] {
  const byId = new Map<string, ShadowV2Record>();
  const accept = (rec: ShadowV2Record) => {
    const prev = byId.get(rec.id);
    if (!prev) {
      byId.set(rec.id, rec);
      return;
    }
    const pr = v2StatusRank(prev.status);
    const nr = v2StatusRank(rec.status);
    if (nr > pr) {
      byId.set(rec.id, rec);
      return;
    }
    if (nr < pr) return;
    if ((rec.altOutcomes && !prev.altOutcomes) || (rec.barsHeld ?? 0) > (prev.barsHeld ?? 0)) {
      byId.set(rec.id, rec);
    }
  };
  for (const r of a) accept(r);
  for (const r of b) accept(r);
  return Array.from(byId.values()).sort((x, y) => x.signalBarTs - y.signalBarTs);
}

// ---------------------------------------------------------------------------
// Sync incrementali verso Firestore
// ---------------------------------------------------------------------------

async function batchUpsertChangedDocs(
  collectionPath: string,
  entries: Array<{ key: string; payload: Record<string, unknown> }>,
  label: string
): Promise<void> {
  const adapter = activeAdapter;
  if (!adapter || entries.length === 0) return;

  const toWrite: Array<{ path: string; data: Record<string, unknown>; hash: string }> = [];
  for (const entry of entries) {
    const docPath = `${collectionPath}/${shadowDocIdForKey(entry.key)}`;
    const h = hashPayload(entry.payload);
    if (syncedHashByPath.get(docPath) === h) continue;
    toWrite.push({
      path: docPath,
      data: sanitizeForFirestore(entry.payload),
      hash: h,
    });
  }

  if (toWrite.length === 0) return;

  await enqueueFirestoreWrite(async () => {
    try {
      const ok = await withTimeout(
        adapter.batchSetDocs(toWrite.map((w) => ({ path: w.path, data: w.data }))).then(() => true),
        label
      );
      if (ok) {
        for (const w of toWrite) syncedHashByPath.set(w.path, w.hash);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Shadow Firestore] ${label} non riuscito: ${msg}`);
    }
  });
}

async function setDocIfChanged(
  docPath: string,
  payload: Record<string, unknown>,
  label: string
): Promise<void> {
  const adapter = activeAdapter;
  if (!adapter) return;
  const h = hashPayload(payload);
  if (syncedHashByPath.get(docPath) === h) return;

  await enqueueFirestoreWrite(async () => {
    try {
      const sanitized = sanitizeForFirestore(payload);
      const ok = await withTimeout(
        adapter.setDoc(docPath, sanitized).then(() => true),
        label
      );
      if (ok) {
        syncedHashByPath.set(docPath, h);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Shadow Firestore] ${label} non riuscito: ${msg}`);
    }
  });
}

export async function syncShadowV1LiveRecordsToFirestore(
  records: readonly PersistedShadowV1LiveRecord[]
): Promise<void> {
  if (!activeAdapter || records.length === 0) return;
  const entries = records.map((rec) => ({
    key: rec.key,
    payload: rec as unknown as Record<string, unknown>,
  }));
  await batchUpsertChangedDocs(SHADOW_V1_SIGNALS_COLLECTION, entries, 'sync V1-live signals');
}

export async function syncShadowV1NearMissToFirestore(
  records: readonly ShadowV1NearMissRecord[],
  summary: ShadowV1NearMissSummary
): Promise<void> {
  if (!activeAdapter) return;
  if (records.length > 0) {
    const entries = records.map((rec) => ({
      key: rec.id,
      payload: rec as unknown as Record<string, unknown>,
    }));
    await batchUpsertChangedDocs(SHADOW_V1_NEAR_MISS_COLLECTION, entries, 'sync V1 near-miss');
  }
  await setDocIfChanged(
    SHADOW_V1_NEAR_MISS_SUMMARY_DOC,
    { payload: summary },
    'sync V1 near-miss summary'
  );
}

export async function syncShadowV1DiagnosticsToFirestore(
  diagnostics: ShadowV1LiveScanDiagnostics
): Promise<void> {
  if (!activeAdapter) return;
  await setDocIfChanged(
    SHADOW_V1_DIAGNOSTICS_DOC,
    { payload: diagnostics },
    'sync V1 diagnostics'
  );
}

export async function syncShadowV1LiveMarksToFirestore(
  marks: ShadowV1LiveMarksPayload
): Promise<void> {
  if (!activeAdapter) return;
  await setDocIfChanged(
    SHADOW_V1_LIVE_MARKS_DOC,
    { payload: marks },
    'sync V1 live marks'
  );
}

export async function syncShadowV1ActiveBarsToFirestore(
  entries: readonly ActiveBarsCacheEntry[]
): Promise<void> {
  if (!activeAdapter) return;
  const trimmed = entries
    .filter((e) => e.bars.length > 0)
    .map((e) => ({
      ticker: e.ticker,
      market: e.market,
      updatedAt: e.updatedAt,
      bars: e.bars.slice(-ACTIVE_BARS_MAX_PER_TICKER),
    }));
  await setDocIfChanged(
    SHADOW_V1_ACTIVE_BARS_DOC,
    { version: 1, entries: trimmed },
    'sync V1 active bars'
  );
}

export async function syncShadowV2ToFirestore(
  records: readonly ShadowV2Record[],
  summary: ShadowV2Summary | null
): Promise<void> {
  if (!activeAdapter) return;
  if (records.length > 0) {
    const entries = records.map((rec) => ({
      key: rec.id,
      payload: rec as unknown as Record<string, unknown>,
    }));
    await batchUpsertChangedDocs(SHADOW_V2_SIGNALS_COLLECTION, entries, 'sync V2 signals');
  }
  if (summary) {
    await setDocIfChanged(SHADOW_V2_SUMMARY_DOC, { payload: summary }, 'sync V2 summary');
  }
}

// ---------------------------------------------------------------------------
// Idratazione bidirezionale all'avvio server (Firestore <-> disco locale)
// ---------------------------------------------------------------------------

export interface HydrationReport {
  v1SignalsLocal: number;
  v1SignalsRemote: number;
  v1SignalsMerged: number;
  v1NearMissMerged: number;
  v2SignalsLocal: number;
  v2SignalsRemote: number;
  v2SignalsMerged: number;
  diagnosticsRestored: boolean;
  activeBarsRestored: number;
}

export async function hydrateAllShadowStateFromFirestore(
  rootDir: string = process.cwd(),
  options: {
    nowMs?: number;
    seedV1Bars?: (ticker: string, market: 'EU' | 'US', bars: readonly ShadowV1LiveBar[], nowMs: number) => void;
    activeBarsPath?: string;
  } = {}
): Promise<HydrationReport> {
  const nowMs = options.nowMs ?? Date.now();
  const report: HydrationReport = {
    v1SignalsLocal: 0,
    v1SignalsRemote: 0,
    v1SignalsMerged: 0,
    v1NearMissMerged: 0,
    v2SignalsLocal: 0,
    v2SignalsRemote: 0,
    v2SignalsMerged: 0,
    diagnosticsRestored: false,
    activeBarsRestored: 0,
  };

  const adapter = activeAdapter;
  if (!adapter) return report;

  try {
    // 1. Shadow V1-live signals (attivo + eventuali archivi mensili)
    // Scarica prima i documenti remoti fuori dalla coda locale, poi acquisisce la coda
    // unica dello store per evitare race con POST /observe o cycle() gia' attivi.
    const signalsPath = path.join(rootDir, SHADOW_V1_LIVE_SIGNALS_PATH);
    const remoteV1Docs = (await withTimeout(
      adapter.listDocs(SHADOW_V1_SIGNALS_COLLECTION),
      'hydrate V1 signals'
    )) ?? [];
    const remoteV1: PersistedShadowV1LiveRecord[] = [];
    for (const d of remoteV1Docs) {
      if (isValidPersistedRecord(d.data)) {
        remoteV1.push(d.data);
        syncedHashByPath.set(
          `${SHADOW_V1_SIGNALS_COLLECTION}/${shadowDocIdForKey(d.data.key)}`,
          hashPayload(d.data)
        );
      }
    }
    report.v1SignalsRemote = remoteV1.length;

    let mergedV1ToSync: PersistedShadowV1LiveRecord[] = [];
    await runInShadowV1LiveStoreQueue(async () => {
      const activeSignalsExists = fs.existsSync(signalsPath);
      const localFiles = [
        ...(activeSignalsExists ? [signalsPath] : []),
        ...listArchivePaths(signalsPath),
      ];
      // Righe scartate nel solo file attivo: gli archivi non vengono riscritti.
      const activeSignalsSkipped = activeSignalsExists ? loadRecords(signalsPath).skipped : 0;
      const localV1 = localFiles.length > 0 ? mergeRecordFiles(localFiles, loadRecords).records : [];
      report.v1SignalsLocal = localV1.length;

      const mergedV1 = mergeV1LiveRecordsMonotone(localV1, remoteV1);
      report.v1SignalsMerged = mergedV1.length;

      if (mergedV1.length > 0) {
        const currentMonth = monthKeyUtc(nowMs);
        const retained = archiveClosedMonths({ signalsPath, records: mergedV1, nowMs });
        const activeToWrite = retained.records.length > 0 || !currentMonth ? retained.records : [];
        if (activeToWrite.length > 0) {
          backupBeforeRewrite(signalsPath, activeSignalsSkipped, 'V1-live signals', nowMs);
          writeRecordsAtomic(signalsPath, activeToWrite);
        } else if (!fs.existsSync(signalsPath) && retained.archived > 0) {
          // Tutti i record sono in archivi mensili: mantiene file attivo vuoto valido
          writeFileAtomicSync(signalsPath, '');
        }
        mergedV1ToSync = mergedV1;
      }
    });

    if (mergedV1ToSync.length > 0) {
      await syncShadowV1LiveRecordsToFirestore(mergedV1ToSync);
    }

    // 2. Shadow V1 Near-Miss + Summary
    const nearMissPath = path.join(rootDir, SHADOW_V1_NEAR_MISS_PATH);
    const nearMissSummaryPath = path.join(rootDir, SHADOW_V1_NEAR_MISS_SUMMARY_PATH);
    const localNearMissLoad = loadNearMissRecordsWithStats(nearMissPath);
    const localNearMiss = localNearMissLoad.records;
    const remoteNearMissDocs = (await withTimeout(
      adapter.listDocs(SHADOW_V1_NEAR_MISS_COLLECTION),
      'hydrate V1 near-miss'
    )) ?? [];
    const remoteNearMiss: ShadowV1NearMissRecord[] = [];
    for (const d of remoteNearMissDocs) {
      if (isValidNearMissRecord(d.data)) {
        remoteNearMiss.push(d.data);
        syncedHashByPath.set(
          `${SHADOW_V1_NEAR_MISS_COLLECTION}/${shadowDocIdForKey(d.data.id)}`,
          hashPayload(d.data)
        );
      }
    }
    const mergedNearMiss = mergeNearMissRecordsMonotone(localNearMiss, remoteNearMiss);
    report.v1NearMissMerged = mergedNearMiss.length;
    if (mergedNearMiss.length > 0) {
      const summary = summarizeNearMissRecords(mergedNearMiss, nowMs);
      const jsonl = mergedNearMiss.map((r) => JSON.stringify(r)).join('\n') + '\n';
      backupBeforeRewrite(nearMissPath, localNearMissLoad.skipped, 'V1 near-miss', nowMs);
      writeFileAtomicSync(nearMissPath, jsonl);
      writeFileAtomicSync(nearMissSummaryPath, JSON.stringify(summary, null, 2));
      await syncShadowV1NearMissToFirestore(mergedNearMiss, summary);
    }

    // 3. V1 Scan Diagnostics
    const diagPath = path.join(rootDir, 'artifacts', 'shadow_v1_live', 'scan_diagnostics.json');
    const localDiag = readJsonFileSafe<ShadowV1LiveScanDiagnostics>(diagPath);
    const remoteDiagDoc = await withTimeout(
      adapter.getDoc(SHADOW_V1_DIAGNOSTICS_DOC),
      'hydrate V1 diagnostics'
    );
    const remoteDiag = (remoteDiagDoc?.payload as ShadowV1LiveScanDiagnostics | undefined) ?? null;
    if (remoteDiag && typeof remoteDiag.lastScanAt === 'string') {
      const remoteTs = Date.parse(remoteDiag.lastScanAt) || 0;
      const localTs = localDiag && typeof localDiag.lastScanAt === 'string' ? Date.parse(localDiag.lastScanAt) || 0 : 0;
      if (!localDiag || remoteTs >= localTs) {
        writeFileAtomicSync(diagPath, JSON.stringify(remoteDiag, null, 2));
        report.diagnosticsRestored = true;
      } else {
        await syncShadowV1DiagnosticsToFirestore(localDiag);
      }
    } else if (localDiag) {
      await syncShadowV1DiagnosticsToFirestore(localDiag);
    }

    // 4. V1 Live Marks
    const marksPath = path.join(rootDir, 'artifacts', 'shadow_v1_live', 'live_marks.json');
    const localMarks = readJsonFileSafe<ShadowV1LiveMarksPayload>(marksPath);
    const remoteMarksDoc = await withTimeout(
      adapter.getDoc(SHADOW_V1_LIVE_MARKS_DOC),
      'hydrate V1 live marks'
    );
    const remoteMarks = (remoteMarksDoc?.payload as ShadowV1LiveMarksPayload | undefined) ?? null;
    if (remoteMarks && Array.isArray(remoteMarks.marks)) {
      const remoteTs = Date.parse(remoteMarks.updatedAt || '') || 0;
      const localTs = localMarks ? Date.parse(localMarks.updatedAt || '') || 0 : 0;
      if (!localMarks || remoteTs >= localTs) {
        writeFileAtomicSync(marksPath, JSON.stringify(remoteMarks, null, 2));
      } else {
        await syncShadowV1LiveMarksToFirestore(localMarks);
      }
    } else if (localMarks) {
      await syncShadowV1LiveMarksToFirestore(localMarks);
    }

    // 5. Active Bars per record V1 non terminali
    const seedBars =
      options.seedV1Bars ??
      ((ticker: string, market: 'EU' | 'US', bars: readonly ShadowV1LiveBar[], ts: number) =>
        recordBarsForShadowV1Live(ticker, market, bars, ts, process.env, { deferDiskSave: true }));
    {
      const remoteActiveBars = await withTimeout(
        adapter.getDoc(SHADOW_V1_ACTIVE_BARS_DOC),
        'hydrate V1 active bars'
      );
      const entries = Array.isArray(remoteActiveBars?.entries)
        ? (remoteActiveBars.entries as ActiveBarsCacheEntry[])
        : [];
      for (const e of entries) {
        if (
          e &&
          typeof e.ticker === 'string' &&
          (e.market === 'EU' || e.market === 'US') &&
          Array.isArray(e.bars) &&
          e.bars.length > 0
        ) {
          seedBars(e.ticker, e.market, e.bars, nowMs);
          report.activeBarsRestored += 1;
        }
      }
      if (report.activeBarsRestored > 0 && !options.seedV1Bars) {
        if (options.activeBarsPath) {
          saveShadowV1LiveBarsToDisk(options.activeBarsPath);
        } else {
          flushShadowV1LiveBarsToDisk();
        }
      }
    }

    // 6. Shadow V2 signals & summary
    const v2SignalsPath = path.join(rootDir, 'artifacts', 'shadow_v2', 'signals.jsonl');
    const v2SummaryPath = path.join(rootDir, 'artifacts', 'shadow_v2', 'summary.json');
    const localV2Load = loadShadowV2RecordsWithStats(v2SignalsPath);
    const localV2 = localV2Load.records;
    report.v2SignalsLocal = localV2.length;

    const remoteV2Docs = (await withTimeout(
      adapter.listDocs(SHADOW_V2_SIGNALS_COLLECTION),
      'hydrate V2 signals'
    )) ?? [];
    const remoteV2: ShadowV2Record[] = [];
    for (const d of remoteV2Docs) {
      if (isValidShadowV2Record(d.data)) {
        remoteV2.push(d.data);
        syncedHashByPath.set(
          `${SHADOW_V2_SIGNALS_COLLECTION}/${shadowDocIdForKey(d.data.id)}`,
          hashPayload(d.data)
        );
      }
    }
    report.v2SignalsRemote = remoteV2.length;

    const mergedV2 = mergeShadowV2RecordsMonotone(localV2, remoteV2);
    report.v2SignalsMerged = mergedV2.length;

    if (mergedV2.length > 0) {
      const summary = summarizeShadowV2(mergedV2, new Date(nowMs).toISOString());
      const jsonl = mergedV2.map((r) => JSON.stringify(r)).join('\n') + '\n';
      backupBeforeRewrite(v2SignalsPath, localV2Load.skipped, 'Shadow V2 signals', nowMs);
      writeFileAtomicSync(v2SignalsPath, jsonl);
      writeFileAtomicSync(v2SummaryPath, JSON.stringify(summary, null, 2));
      await syncShadowV2ToFirestore(mergedV2, summary);
    }

    console.log(
      `[Shadow Firestore] Idratazione completata — V1-live: ${report.v1SignalsMerged} (locale ${report.v1SignalsLocal}, cloud ${report.v1SignalsRemote}) | Near-Miss: ${report.v1NearMissMerged} | V2: ${report.v2SignalsMerged} (locale ${report.v2SignalsLocal}, cloud ${report.v2SignalsRemote})`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Shadow Firestore] Idratazione startup non bloccante fallita: ${msg}`);
  }

  return report;
}
