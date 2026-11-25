/**
 * Report dei veti misurati in produzione (nessun harness).
 *
 * Uso: npx tsx scripts/veto_outcome_report.ts [percorso-log] [--json=out.json]
 * Default: logs/veto_outcome_log.jsonl (scritto da `logVetoOutcomes` in server.ts).
 *
 * Legge il log append-only, ricostruisce lo stato per veto e stampa:
 *   - quanti veti, quanti hanno toccato il livello di entry (fill al trigger);
 *   - esito a 60 minuti: TARGET / STOP / EXPIRED / aperti / senza livelli;
 *   - R medio con fill al trigger e con fill a mercato (con CI 95%);
 *   - mark in R a +15/+30/+60 minuti, MFE e MAE.
 * Con il log vuoto o assente scrive "dati insufficienti": nessuna stima.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  VETO_LOG_RELATIVE_PATH,
  foldVetoLog,
  summarizeVetoOutcomes,
  VetoKind,
  VETO_KINDS,
} from '../src/server/vetoOutcomeLog';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const jsonArg = process.argv.slice(2).find((a) => a.startsWith('--json='));
const logPath = positional[0] ?? path.join(process.cwd(), VETO_LOG_RELATIVE_PATH);

const fold = foldVetoLog(fs.readFileSync(logPath, 'utf-8'));

const rows = summarizeVetoOutcomes(fold);

console.log(`Veti misurati in produzione | log ${logPath}`);
if (fold.size === 0) {
  console.log('dati insufficienti: nessun veto leggibile nel log. Nessuna stima.');
  process.exit(0);
}

const fmt = (value: number | null, digits = 3): string =>
  value == null ? '   n/d' : value.toFixed(digits).padStart(7);

console.log(`veti distinti: ${fold.size}`);
console.log(
  '\nveto | mercato |    n | fill-trigger | TARGET | STOP | EXPIRED | aperti | s/liv | R trigger | R mercato (CI95) | mark15 | mark30 | mark60 | MFE | MAE'
);
for (const row of rows) {
  const ci = row.ciRMarket ? ` [${row.ciRMarket[0].toFixed(2)}, ${row.ciRMarket[1].toFixed(2)}]` : '';
  console.log(
    `${row.veto} | ${row.market} | ${String(row.n).padStart(3)} | ` +
      `${(row.triggerFillPct ?? 0).toFixed(1).padStart(5)}% | ${String(row.target).padStart(6)} | ` +
      `${String(row.stop).padStart(4)} | ${String(row.expired).padStart(7)} | ${String(row.open).padStart(6)} | ` +
      `${String(row.noLevels).padStart(5)} | ${fmt(row.meanRTrigger)} | ${fmt(row.meanRMarket)}${ci} | ` +
      `${fmt(row.meanMark15, 2)} | ${fmt(row.meanMark30, 2)} | ${fmt(row.meanMark60, 2)} | ` +
      `${fmt(row.meanMfeR, 2)} | ${fmt(row.meanMaeR, 2)}`
  );
}

const totals = rows.reduce(
  (acc, row) => ({ n: acc.n + row.n, target: acc.target + row.target, stop: acc.stop + row.stop }),
  { n: 0, target: 0, stop: 0 }
);
console.log(
  `\ntotale: ${totals.n} veti | T1 ${totals.target} STOP ${totals.stop} | ` +
    `T1/(T1+STOP) ${totals.target + totals.stop > 0 ? ((totals.target / (totals.target + totals.stop)) * 100).toFixed(1) : 'n/d'}%`
);

if (jsonArg) {
  const outPath = jsonArg.slice('--json='.length);
  const payload = {
    generatedAt: new Date().toISOString(),
    logPath,
    distinct: fold.size,
    totals,
    rows,
    records: [...fold.values()].map((entry) => ({ ...entry.decision, state: entry.latest })),
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 1) + '\n', 'utf-8');
  console.log(`scritto ${outPath}`);
}

export type VetoOutcomeSummaryRow = {
  veto: VetoKind;
  market: 'EU' | 'US';
  n: number;
  triggerFillPct: number | null;
  target: number;
  stop: number;
  expired: number;
  open: number;
  noLevels: number;
  meanRTrigger: number | null;
  meanRMarket: number | null;
  ciRMarket: [number, number] | null;
  meanMark15: number | null;
  meanMark30: number | null;
  meanMark60: number | null;
  meanMfeR: number | null;
  meanMaeR: number | null;
};
