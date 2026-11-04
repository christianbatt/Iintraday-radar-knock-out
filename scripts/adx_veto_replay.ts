/**
 * Replay dei veti ADX (IPOTESI).
 *
 * Uso: npx tsx scripts/adx_veto_replay.ts [percorso-log]
 * Default: logs/adx_veto_log.jsonl (scritto da server.ts a ogni scan).
 *
 * Per ogni veto verifica se il prezzo ha raggiunto T1 prima dello stop usando le barre
 * successive presenti nel log. Quando barre o campi mancano scrive "dati insufficienti":
 * nessuna stima, nessun valore inventato.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseAdxVetoLog, replayVetoes, summarizeReplay } from '../src/utils/adxVetoReplay';

const logPath = process.argv[2] ?? path.join(process.cwd(), 'logs', 'adx_veto_log.jsonl');

if (!fs.existsSync(logPath)) {
  console.log(`dati insufficienti: log non trovato (${logPath}). Nessuna stima.`);
  process.exit(0);
}

const records = parseAdxVetoLog(fs.readFileSync(logPath, 'utf-8'));
if (records.length === 0) {
  console.log(`dati insufficienti: nessun veto ADX leggibile in ${logPath}. Nessuna stima.`);
  process.exit(0);
}

const rows = replayVetoes(records);
const summary = summarizeReplay(rows);
const insufficienti = rows.filter((row) => row.outcome === 'dati insufficienti').length;

console.log(`Replay veto ADX_BELOW_MARKET_THRESHOLD | log ${logPath}`);
console.log(`veti nel log: ${records.length} | con dati insufficienti: ${insufficienti}`);

for (const row of rows) {
  const { record } = row;
  const prices =
    record.entry != null && record.stop != null && record.t1 != null
      ? `entry ${record.entry} stop ${record.stop} T1 ${record.t1}`
      : 'entry/stop/T1 mancanti';
  console.log(
    `- ${record.ticker} ${record.market} ${record.direction} | ADX ${record.adx ?? 'nd'} (+DI ${record.plusDI ?? 'nd'} / -DI ${record.minusDI ?? 'nd'}) soglia ${record.threshold} | ET ${record.etTime ?? 'nd'} locali ${record.localTime ?? 'nd'} | ${prices} | barre successive ${row.barsAfter} | esito ${row.outcome}`
  );
}

console.log('\nPercentuale T1 prima dello stop (T1 / (T1 + STOP)):');
for (const row of summary) {
  const pct = row.t1Pct == null ? 'dati insufficienti' : `${row.t1Pct}%`;
  console.log(
    `- ${row.market} | ${row.bucket} | veti ${row.total} T1 ${row.t1} STOP ${row.stop} nessun contatto ${row.nessuna} insufficienti ${row.insufficienti} | ${pct}`
  );
}
