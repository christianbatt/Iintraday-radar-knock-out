/**
 * CLI offline Shadow V2: rigenera `artifacts/shadow_v2/summary.json` dai segnali
 * reali osservati in `artifacts/shadow_v2/signals.jsonl` (e opzionali snapshot barre locali).
 * Nessun dato sintetico o inventato.
 */

import fs from 'node:fs';
import path from 'node:path';
import { summarizeShadowV2 } from '../src/knowledge/shadowV2';
import { loadShadowV2Records } from '../src/server/shadowV2Collector';

function main(): void {
  const rootDir = process.cwd();
  const outDir = path.join(rootDir, 'artifacts', 'shadow_v2');
  const signalsPath = path.join(outDir, 'signals.jsonl');
  const summaryPath = path.join(outDir, 'summary.json');

  const records = loadShadowV2Records(signalsPath);
  const summary = summarizeShadowV2(records, new Date().toISOString());

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log(
    JSON.stringify(
      {
        status: 'OK',
        signalsPath,
        summaryPath,
        nSessions: summary.nSessions,
        nSignals: summary.nSignals,
        nResolved: summary.nResolved,
        nOpen: summary.nOpen,
        nBlocked: summary.nBlocked,
        meanRGross: summary.meanRGross,
        meanRNet: summary.meanRNet,
        winRatePct: summary.winRatePct,
        profitFactor: summary.profitFactor,
        dsr: summary.dsr,
        clusterBootstrapPValue: summary.clusterBootstrapPValue,
      },
      null,
      2
    )
  );
}

main();
