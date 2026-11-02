import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AILearnedInsight } from '../types/radar';
import { LearningResult, MIN_REAL_TRADE_SAMPLE } from './learningValidator';

const DEFAULT_MEMORY_FILE = fileURLToPath(new URL('../../ai_specialization_memory.json', import.meta.url));

export function updateAIMemory(
  results: LearningResult[],
  memoryPath: string = DEFAULT_MEMORY_FILE
): void {
  let memory: AILearnedInsight[] = [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
    if (Array.isArray(parsed)) memory = parsed as AILearnedInsight[];
  } catch {
    memory = [];
  }

  for (const result of results) {
    if (
      result.stats.n < MIN_REAL_TRADE_SAMPLE ||
      result.stats.adjustedPValue >= 0.05 ||
      result.stats.avgR <= 0 ||
      result.stats.profitFactor <= 1
    ) {
      continue;
    }

    const insight: AILearnedInsight = {
      id: `ai-${result.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      learnedAt: new Date().toISOString(),
      market: result.market,
      topic: result.topic,
      directive: result.directive,
      confidence: Math.round(result.confidence * 100),
      sampleEvidence:
        `Trade analizzati (reali e paper): ${result.stats.n}; IDs: ${result.evidence.slice(0, 10).join(', ')}` +
        `${result.evidence.length > 10 ? ', ...' : ''}. ` +
        `Win rate ${(result.stats.winRate * 100).toFixed(1)}%, avg R ${result.stats.avgR.toFixed(2)}, ` +
        `profit factor ${result.stats.profitFactor.toFixed(2)}, p=${result.stats.pValue.toFixed(4)}, ` +
        `BH q=${result.stats.adjustedPValue.toFixed(4)}. ` +
        `Esclusi controfattuali separati: ${result.stats.counterfactual.n} ` +
        `(WIN ${result.stats.counterfactual.wins}, LOSS ${result.stats.counterfactual.losses}, ` +
        `EXPIRED ${result.stats.counterfactual.expired}); non inclusi nel campione statistico.`,
    };

    const existingIndex = memory.findIndex((entry) => entry.topic === result.topic);
    if (existingIndex >= 0) memory[existingIndex] = insight;
    else memory.push(insight);
  }

  if (memory.length > 50) memory = memory.slice(-50);

  const directory = path.dirname(memoryPath);
  const temporaryPath = `${memoryPath}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(memory, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, memoryPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}
