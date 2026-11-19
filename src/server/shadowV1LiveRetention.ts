/**
 * SHADOW V1 LIVE — archiviazione mensile dei record terminali (P12).
 *
 * Regole, in ordine di importanza:
 * 1. **Nessun dato viene cancellato dal codice.** Il file attivo conserva lo
 *    stesso nome e lo stesso formato di sempre (`artifacts/shadow_v1_live/signals.jsonl`).
 * 2. Si archiviano **solo** record terminali (`STOP`, `TARGET`, `EXPIRED`,
 *    `NOT_FILLED`) il cui mese UTC di `decidedAtMs` e' precedente al mese UTC di
 *    `now`: i record non terminali restano sempre nel file attivo.
 * 3. L'archivio si scrive e si **verifica** (rilettura, `sha256` e conteggio
 *    righe) prima di togliere le righe dal file attivo. Se la verifica fallisce
 *    il file attivo non viene toccato e il chiamante prosegue: la retention e'
 *    un miglioramento, mai una causa di perdita o di crash del ciclo.
 * 4. Tutto passa dal tmp univoco per processo (`shadowV1LiveTmpPath`) e da un
 *    rename atomico, come `writeRecordsAtomic`. Nessuna nuova concorrenza: il
 *    chiamante e' gia' serializzato dalla coda del collector.
 *
 * File prodotti accanto al file attivo:
 * - `signals-YYYY-MM.jsonl`  record archiviati, stesso formato JSONL;
 * - `signals-YYYY-MM.sha256` sidecar con hash e conteggio:
 *   ```
 *   <sha256>  signals-YYYY-MM.jsonl
 *   records=<n>
 *   ```
 *   La prima riga e' compatibile con `sha256sum -c`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  shadowV1LiveTmpPath,
  type PersistedShadowV1LiveRecord,
} from './shadowV1LiveStore';

/** Prefisso dei file di archivio mensile. */
export const SHADOW_V1_LIVE_ARCHIVE_PREFIX = 'signals-';

/** Estensione dei file di archivio (identica al formato del file attivo). */
export const SHADOW_V1_LIVE_ARCHIVE_SUFFIX = '.jsonl';

/** Estensione del sidecar di verifica. */
export const SHADOW_V1_LIVE_ARCHIVE_SIDECAR_SUFFIX = '.sha256';

/** Pattern del nome di un archivio mensile valido. */
export const SHADOW_V1_LIVE_ARCHIVE_PATTERN = /^signals-\d{4}-\d{2}\.jsonl$/;

/** Stati terminali: gli unici che possono essere archiviati. */
export const SHADOW_V1_LIVE_TERMINAL_STATUSES: readonly string[] = [
  'STOP',
  'TARGET',
  'EXPIRED',
  'NOT_FILLED',
];

export function isTerminalLiveStatus(status: string): boolean {
  return SHADOW_V1_LIVE_TERMINAL_STATUSES.includes(status);
}

/**
 * Mese di competenza in **UTC** (`YYYY-MM`). Deliberatamente UTC, non locale:
 * il record e' gia' datato in millisecondi epoch e la session date del nucleo e'
 * UTC, quindi il confine di mese non deve dipendere dal fuso del processo.
 */
export function monthKeyUtc(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 7);
}

export function archivePathFor(signalsPath: string, month: string): string {
  return path.join(
    path.dirname(signalsPath),
    `${SHADOW_V1_LIVE_ARCHIVE_PREFIX}${month}${SHADOW_V1_LIVE_ARCHIVE_SUFFIX}`
  );
}

export function sidecarPathFor(archivePath: string): string {
  return `${archivePath}${SHADOW_V1_LIVE_ARCHIVE_SIDECAR_SUFFIX}`;
}

/** Elenco deterministico (alfabetico) degli archivi mensili accanto al file attivo. */
export function listArchivePaths(signalsPath: string): string[] {
  try {
    const dir = path.dirname(signalsPath);
    return fs
      .readdirSync(dir)
      .filter((name) => SHADOW_V1_LIVE_ARCHIVE_PATTERN.test(name))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** Ordine su disco: deterministico, indipendente dall'ordine di arrivo. */
function compareForDisk(a: PersistedShadowV1LiveRecord, b: PersistedShadowV1LiveRecord): number {
  if (a.decidedAtMs !== b.decidedAtMs) return a.decidedAtMs - b.decidedAtMs;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function serializeRecords(records: readonly PersistedShadowV1LiveRecord[]): string {
  return [...records].sort(compareForDisk).map((r) => JSON.stringify(r)).join('\n') + '\n';
}

export function sha256Of(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Conta le righe non vuote del contenuto serializzato. */
export function countLines(content: string): number {
  return content.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * Unione per chiave: vince il record con `updatedAtMs` maggiore; a parita' vince
 * il piu' recente in ingresso. Serve a fondere un archivio esistente con nuovi
 * record dello stesso mese e a deduplicare fra file attivo e archivi.
 */
export function mergeByKey(
  base: readonly PersistedShadowV1LiveRecord[],
  incoming: readonly PersistedShadowV1LiveRecord[]
): PersistedShadowV1LiveRecord[] {
  const byKey = new Map<string, PersistedShadowV1LiveRecord>();
  for (const record of base) byKey.set(record.key, record);
  for (const record of incoming) {
    const previous = byKey.get(record.key);
    if (!previous || record.updatedAtMs >= previous.updatedAtMs) byKey.set(record.key, record);
  }
  return [...byKey.values()];
}

export interface ArchiveResult {
  /** Record da scrivere nel file attivo (archiviati esclusi). */
  records: PersistedShadowV1LiveRecord[];
  /** Numero di record spostati in archivio e verificati. */
  archived: number;
  /** Mesi archiviati in questa chiamata. */
  months: string[];
  /** Avvisi da loggare (fallimenti parziali, nessuna eccezione). */
  notes: string[];
}

/**
 * Scrive l'archivio di un mese e lo verifica. Ritorna l'hash verificato oppure
 * `null` se qualcosa non torna: in quel caso il file attivo non va toccato.
 */
function writeVerifiedArchive(
  archivePath: string,
  content: string
): { ok: true; sha256: string; lines: number } | { ok: false; error: string } {
  const expectedSha = sha256Of(content);
  const expectedLines = countLines(content);
  const tmpPath = shadowV1LiveTmpPath(archivePath);
  try {
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(tmpPath, content, 'utf8');
    // Verifica sul temporaneo, prima di sostituire l'archivio esistente.
    const readBack = fs.readFileSync(tmpPath, 'utf8');
    if (sha256Of(readBack) !== expectedSha) {
      throw new Error('hash del temporaneo diverso dal contenuto calcolato');
    }
    if (countLines(readBack) !== expectedLines) {
      throw new Error('conteggio righe del temporaneo diverso dal previsto');
    }
    fs.renameSync(tmpPath, archivePath);
    // Verifica anche dopo il rename: cio' che resta su disco deve essere identico.
    const onDisk = fs.readFileSync(archivePath, 'utf8');
    if (sha256Of(onDisk) !== expectedSha || countLines(onDisk) !== expectedLines) {
      throw new Error("verifica dell'archivio su disco fallita");
    }
    const sidecar = `${expectedSha}  ${path.basename(archivePath)}\nrecords=${expectedLines}\n`;
    const sidecarTmp = shadowV1LiveTmpPath(sidecarPathFor(archivePath));
    fs.writeFileSync(sidecarTmp, sidecar, 'utf8');
    fs.renameSync(sidecarTmp, sidecarPathFor(archivePath));
    return { ok: true, sha256: expectedSha, lines: expectedLines };
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    } catch {
      // best effort
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Applica la retention mensile. Funzione unica usata dal collector: nessun I/O
 * quando non ci sono record terminali di mesi precedenti (caso normale, quindi
 * comportamento identico a oggi).
 *
 * Non lancia mai: ogni errore diventa una nota e i record restano attivi.
 */
export function archiveClosedMonths(input: {
  signalsPath: string;
  records: readonly PersistedShadowV1LiveRecord[];
  nowMs: number;
  /** Iniettabile per i test: lettura dei record gia' archiviati. */
  readArchive?: (filePath: string) => readonly PersistedShadowV1LiveRecord[];
}): ArchiveResult {
  const notes: string[] = [];
  const unchanged: ArchiveResult = { records: [...input.records], archived: 0, months: [], notes };

  try {
    const currentMonth = monthKeyUtc(input.nowMs);
    if (!currentMonth) return { ...unchanged, notes: ['retention: nowMs non finito, nessuna azione'] };

    const candidates = new Map<string, PersistedShadowV1LiveRecord[]>();
    const kept: PersistedShadowV1LiveRecord[] = [];
    for (const record of input.records) {
      const month = monthKeyUtc(record.decidedAtMs);
      const closable =
        isTerminalLiveStatus(record.status) && month.length > 0 && month < currentMonth;
      if (!closable) {
        kept.push(record);
        continue;
      }
      const bucket = candidates.get(month);
      if (bucket) bucket.push(record);
      else candidates.set(month, [record]);
    }

    if (candidates.size === 0) return unchanged;

    const archivedKeys = new Set<string>();
    const months: string[] = [];
    const readArchive =
      input.readArchive ??
      ((filePath: string) => {
        // Lettura tollerante: un archivio corrotto non deve fermare la retention.
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const out: PersistedShadowV1LiveRecord[] = [];
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed) as PersistedShadowV1LiveRecord;
              if (parsed && typeof parsed.key === 'string') out.push(parsed);
            } catch {
              // riga illeggibile: resta fuori dall'unione, l'archivio su disco non si tocca
            }
          }
          return out;
        } catch {
          return [];
        }
      });

    for (const [month, records] of [...candidates.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const archivePath = archivePathFor(input.signalsPath, month);
      try {
        const existing = readArchive(archivePath);
        const merged = mergeByKey(existing, records);
        const content = serializeRecords(merged);
        const written = writeVerifiedArchive(archivePath, content);
        if (!written.ok) {
          notes.push(`retention: archivio ${month} non scritto (${written.error})`);
          continue;
        }
        for (const record of records) archivedKeys.add(record.key);
        months.push(month);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notes.push(`retention: mese ${month} non archiviato (${message})`);
      }
    }

    if (archivedKeys.size === 0) return { records: [...input.records], archived: 0, months: [], notes };

    const remaining = input.records.filter((record) => !archivedKeys.has(record.key));
    return { records: remaining, archived: archivedKeys.size, months, notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { records: [...input.records], archived: 0, months: [], notes: [`retention: ${message}`] };
  }
}

/**
 * Unione per chiave di piu' file (attivo + archivi), con lo stesso criterio di
 * `mergeByKey`. Usata dalla vista: il risultato non dipende dall'ordine dei file.
 */
export function mergeRecordFiles(
  files: readonly string[],
  read: (filePath: string) => { records: PersistedShadowV1LiveRecord[]; skipped: number }
): { records: PersistedShadowV1LiveRecord[]; skipped: number } {
  let records: PersistedShadowV1LiveRecord[] = [];
  let skipped = 0;
  for (const file of files) {
    const loaded = read(file);
    skipped += loaded.skipped;
    records = mergeByKey(records, loaded.records);
  }
  return { records, skipped };
}
