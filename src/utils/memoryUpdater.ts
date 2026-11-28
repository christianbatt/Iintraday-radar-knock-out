import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AILearnedInsight } from '../types/radar';
import { LearningResult, MIN_REAL_TRADE_SAMPLE } from './learningValidator';
import { applyLifecycleDefaults } from '../server/aiMemoryLifecycle';

const DEFAULT_MEMORY_FILE = fileURLToPath(new URL('../../ai_specialization_memory.json', import.meta.url));

/**
 * Fase 3: chi scrive. Quando presente, la regola dichiara il proprietario e
 * l'autore, e il campione su cui è stata validata (`datasetHash`).
 */
export interface AIMemoryOwner {
  ownerUid: string;
  datasetHash: string | null;
  runId: string | null;
}

export function updateAIMemory(
  results: LearningResult[],
  memoryPath: string = DEFAULT_MEMORY_FILE,
  owner: AIMemoryOwner | null = null
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

    // ADDITIVO (P8): provenienza sanificata (nessuna eccezione su input sporchi).
    // Si conserva solo cio' che il chiamante ha davvero: niente valori dedotti.
    const rawProvenance = result.provenance;
    const provenance =
      rawProvenance && typeof rawProvenance === 'object'
        ? {
            promptVersion:
              typeof rawProvenance.promptVersion === 'string' &&
              rawProvenance.promptVersion.trim().length > 0
                ? rawProvenance.promptVersion.trim()
                : null,
            model:
              typeof rawProvenance.model === 'string' && rawProvenance.model.trim().length > 0
                ? rawProvenance.model.trim()
                : null,
            evidenceRefs: Array.isArray(rawProvenance.evidenceRefs)
              ? [...new Set(
                  rawProvenance.evidenceRefs.filter(
                    (ref): ref is string => typeof ref === 'string' && ref.trim().length > 0
                  )
                )].slice(0, 8)
              : [],
            // ADDITIVO (Fase 3): autore e campione, sanificati come il resto.
            writerUid:
              typeof rawProvenance.writerUid === 'string' && rawProvenance.writerUid.trim().length > 0
                ? rawProvenance.writerUid.trim()
                : null,
            datasetHash:
              typeof rawProvenance.datasetHash === 'string' &&
              /^[a-f0-9]{64}$/.test(rawProvenance.datasetHash.trim())
                ? rawProvenance.datasetHash.trim()
                : null,
            runId:
              typeof rawProvenance.runId === 'string' && rawProvenance.runId.trim().length > 0
                ? rawProvenance.runId.trim()
                : null,
          }
        : null;

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
    // Fase 4: campione dichiarato nella regola, così il prompt può mostrare n
    // senza dedurlo dal testo di `sampleEvidence`.
    insight.sampleSize = result.stats.n;

    // Presente solo quando c'e' una provenienza reale: le regole storiche non
    // cambiano forma e chi legge non deve distinguere due schemi.
    if (provenance !== null) insight.provenance = provenance;

    // Fase 3: proprietà e autore. Senza `owner` la regola resta com'era
    // (regola storica/globale), quindi nessun comportamento cambia per i
    // chiamanti che non passano il nuovo argomento.
    if (owner !== null) {
      insight.ownerUid = owner.ownerUid;
      insight.legacy = false;
      const base = insight.provenance ?? { promptVersion: null, model: null, evidenceRefs: [] };
      insight.provenance = {
        ...base,
        writerUid: owner.ownerUid,
        datasetHash: owner.datasetHash,
        runId: owner.runId,
      };
    }

    // Fase 4: una regola nasce con scadenza (90 giorni), data di test e contatore.
    const withLifecycle = applyLifecycleDefaults(insight);
    const existingIndex = memory.findIndex((entry) => entry.topic === result.topic);
    if (existingIndex >= 0) memory[existingIndex] = withLifecycle;
    else memory.push(withLifecycle);
  }

  if (memory.length > 50) memory = memory.slice(-50);

  const directory = path.dirname(memoryPath);
  const temporaryPath = `${memoryPath}.tmp-${process.pid}-${randomUUID()}`;
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(memory, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, memoryPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}
