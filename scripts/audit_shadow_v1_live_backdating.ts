/**
 * AUDIT (SOLA LETTURA) — record Shadow V1-live con `decidedAtMs` retrodatato.
 *
 * Prima che il timestamp fosse deciso dal server, il collector datava la
 * decisione con il `calculatedAt` inviato dal client: un chiamante poteva
 * dichiarare un istante precedente a quello in cui il record e' stato visto per
 * la prima volta (`firstSeenAtMs`). Questi record possono essere finiti in una
 * sessione diversa da quella reale e vanno valutati prima di usarli nelle
 * statistiche.
 *
 * Lo script NON modifica nulla: apre il file in lettura, elenca i casi e
 * riassume. Nessuna scrittura, nessuna chiamata di rete.
 *
 * Uso:
 *   npx tsx scripts/audit_shadow_v1_live_backdating.ts
 *   npx tsx scripts/audit_shadow_v1_live_backdating.ts --file=artifacts/.../signals.jsonl
 *   npx tsx scripts/audit_shadow_v1_live_backdating.ts --threshold-min=5
 *   npx tsx scripts/audit_shadow_v1_live_backdating.ts --json
 *
 * Soglia: un record e' "retrodatato" se `firstSeenAtMs - decidedAtMs` supera
 * `--threshold-min` (default 5 = una barra 5m, cioe' lo scarto fisiologico fra
 * decisione e prima osservazione). Con `--threshold-min=0` conta qualsiasi
 * anticipo, anche di 1 ms.
 *
 * Exit code: 0 nessun record retrodatato, 1 almeno un record, 2 errore di
 * lettura o argomenti. Utilizzabile come guardia.
 */

import fs from 'node:fs';

const DEFAULT_FILE = 'artifacts/shadow_v1_live/signals.jsonl';
const DEFAULT_THRESHOLD_MIN = 5;

interface RawRecord {
  key?: unknown;
  ticker?: unknown;
  market?: unknown;
  status?: unknown;
  decidedAtMs?: unknown;
  firstSeenAtMs?: unknown;
}

interface BackdatedRow {
  key: string;
  ticker: string;
  market: string;
  status: string;
  decidedAtMs: number;
  firstSeenAtMs: number;
  anticipationMs: number;
}

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function main(): number {
  if (hasFlag('help') || hasFlag('h')) {
    console.log(
      [
        'Uso: tsx scripts/audit_shadow_v1_live_backdating.ts [--file=PATH] [--threshold-min=N] [--json]',
        '',
        `  --file=PATH          file JSONL da leggere (default: ${DEFAULT_FILE})`,
        `  --threshold-min=N    anticipo minimo per segnalare un record (default: ${DEFAULT_THRESHOLD_MIN})`,
        '  --json               output JSON (stessi dati, per automazioni)',
        '',
        'Sola lettura: il file non viene mai modificato.',
      ].join('\n')
    );
    return 0;
  }

  const file = argValue('file') ?? DEFAULT_FILE;
  const thresholdRaw = argValue('threshold-min');
  const thresholdMin = thresholdRaw === null ? DEFAULT_THRESHOLD_MIN : Number(thresholdRaw);
  if (!Number.isFinite(thresholdMin) || thresholdMin < 0) {
    console.error(`--threshold-min non valido: ${thresholdRaw}`);
    return 2;
  }
  const json = hasFlag('json');

  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Impossibile leggere ${file}: ${message}`);
    return 2;
  }

  const lines = content.split('\n');
  const rows: BackdatedRow[] = [];
  let parsed = 0;
  let malformed = 0;
  let incomplete = 0;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let record: RawRecord;
    try {
      record = JSON.parse(trimmed) as RawRecord;
    } catch {
      malformed += 1;
      return;
    }
    parsed += 1;
    const decidedAtMs = record.decidedAtMs;
    const firstSeenAtMs = record.firstSeenAtMs;
    if (
      typeof decidedAtMs !== 'number' ||
      !Number.isFinite(decidedAtMs) ||
      typeof firstSeenAtMs !== 'number' ||
      !Number.isFinite(firstSeenAtMs)
    ) {
      incomplete += 1;
      return;
    }
    const anticipationMs = firstSeenAtMs - decidedAtMs;
    if (anticipationMs <= thresholdMin * 60_000) return;
    rows.push({
      key:
        typeof record.key === 'string'
          ? record.key
          : `riga ${index + 1} (senza key)`,
      ticker: typeof record.ticker === 'string' ? record.ticker : '?',
      market: typeof record.market === 'string' ? record.market : '?',
      status: typeof record.status === 'string' ? record.status : '?',
      decidedAtMs,
      firstSeenAtMs,
      anticipationMs,
    });
  });

  rows.sort((a, b) => b.anticipationMs - a.anticipationMs);

  if (json) {
    console.log(
      JSON.stringify(
        {
          file,
          thresholdMin,
          scanned: parsed,
          malformed,
          incomplete,
          backdated: rows.length,
          records: rows.map((r) => ({
            ...r,
            decidedAt: iso(r.decidedAtMs),
            firstSeenAt: iso(r.firstSeenAtMs),
            anticipationMin: Number((r.anticipationMs / 60_000).toFixed(2)),
          })),
        },
        null,
        2
      )
    );
    return rows.length === 0 ? 0 : 1;
  }

  console.log('Audit Shadow V1-live: decidedAtMs retrodatato rispetto a firstSeenAtMs');
  console.log(`File: ${file}`);
  console.log(
    `Soglia: ${thresholdMin} min (un record e' segnalato se firstSeenAtMs - decidedAtMs > soglia)`
  );
  console.log(
    `Righe lette: ${parsed} (scartate: ${malformed} JSON non valido, ${incomplete} senza timestamp numerici)`
  );
  console.log('');

  if (rows.length === 0) {
    console.log('Nessun record retrodatato: nessun dato da escludere per questo criterio.');
    return 0;
  }

  console.log(`Record retrodatati trovati: ${rows.length} (dal piu' anticipato):`);
  console.log(
    [
      pad('TICKER', 10),
      pad('STATUS', 14),
      pad('ANTICIPO', 10),
      pad('DECIDED_AT', 22),
      pad('FIRST_SEEN', 22),
      'KEY',
    ].join(' ')
  );
  for (const row of rows) {
    console.log(
      [
        pad(row.ticker, 10),
        pad(row.status, 14),
        pad(`${(row.anticipationMs / 60_000).toFixed(1)}m`, 10),
        pad(iso(row.decidedAtMs), 22),
        pad(iso(row.firstSeenAtMs), 22),
        row.key,
      ].join(' ')
    );
  }
  console.log('');
  console.log(
    'Questi record sono candidati all\'esclusione dalle statistiche: la decisione dichiarata precede di molto la prima osservazione.'
  );
  return 1;
}

process.exitCode = main();
