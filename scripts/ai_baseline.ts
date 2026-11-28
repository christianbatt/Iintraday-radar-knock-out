/**
 * CLI della baseline AI (Passo 0.1): scrive una fotografia datata in
 * `artifacts/audit/baseline-<giorno>.json` e stampa i numeri che contano.
 *
 * Riproducibile: stesso contenuto dei file => stesso output, a parte
 * `generatedAt`. Non modifica nessun dato del sistema.
 *
 * Uso: npx tsx scripts/ai_baseline.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildAiBaseline } from '../src/server/aiBaseline';

const rootDir = process.cwd();
const baseline = buildAiBaseline({ rootDir, nowMs: Date.now() });
const day = baseline.generatedAt.slice(0, 10);
const outPath = path.join(rootDir, 'artifacts', 'audit', `baseline-${day}.json`);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');

const percent = (value: number | null): string => (value === null ? 'n.d.' : `${value}`);

console.log(`[AI Baseline] ${baseline.version} — ${baseline.generatedAt}`);
console.log(
  `[AI Baseline] scansioni AI: ${baseline.aiScans.rows} righe, decisioni chiuse ${baseline.availability.aiDecisions}`
);
console.log(
  `[AI Baseline] log AI (valutazioni): ${baseline.aiLog.exists ? `${baseline.aiLog.rows} righe` : 'assente'}`
);
console.log(
  `[AI Baseline] segnali: ${baseline.signals.rows} (R medio ${percent(baseline.signals.meanR)} su ${baseline.signals.meanRN})`
);
console.log(
  `[AI Baseline] near-miss: ${baseline.nearMiss.rows} (R medio ${percent(baseline.nearMiss.meanR)} su ${baseline.nearMiss.meanRN})`
);
console.log(`[AI Baseline] esiti forward risolti: ${baseline.availability.resolvedForward}`);
console.log(
  `[AI Baseline] barre: ${baseline.bars.parsed ? `${baseline.bars.bars} su ${baseline.bars.tickers} ticker (OHLC ${baseline.bars.hasOhlc ? 'sì' : 'no'})` : 'assenti o illeggibili'}`
);
console.log(
  `[AI Baseline] memoria: ${baseline.memory.rules} regole, ${baseline.memory.validated} scritte dal validatore`
);
console.log(`[AI Baseline] scritto: ${path.relative(rootDir, outPath)}`);
