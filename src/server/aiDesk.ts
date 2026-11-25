/**
 * Orchestratore AI desk (PR-B).
 *
 * Due responsabilita', entrambe isolanti:
 * 1. `collectDeskEvidenceInput`: raccoglie le fonti gia' esistenti (diario,
 *    istantanea della scansione, log dei veti, near-miss, summary Shadow V2) e
 *    le consegna al pack. Ogni fonte e' in un try/catch indipendente: una fonte
 *    rotta non impedisce alle altre di entrare nel fascicolo, e il pack dichiara
 *    da solo le sezioni mancanti.
 * 2. `runDeskAnalysis`: prompt -> LLM iniettata -> parser -> validatore. Non
 *    lancia mai e non decide nulla: restituisce l'analisi ancorata o un errore.
 *
 * Il percorso e' attivo solo con `AI_DESK_EVIDENCE=1`: con il flag spento
 * nessuna di queste funzioni viene chiamata dagli endpoint.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  buildAiEvidencePack,
  type AiEvidencePack,
  type AiEvidencePackInput,
} from '../knowledge/aiEvidencePack';
import {
  buildDeskPrompt,
  parseDeskAnalysis,
  type AiDeskAnalysis,
} from '../knowledge/aiDeskContract';
import type { ExcludedSetupRecord, TradeJournalEntry } from '../types/radar';
import { getLastScanCandidates, getLastScanRunId } from './aiScanEvaluation';
import {
  loadNearMissRecords,
  summarizeNearMissRecords,
  SHADOW_V1_NEAR_MISS_PATH,
} from './shadowV1LiveNearMiss';
import { foldVetoLog, summarizeVetoOutcomes, VETO_LOG_RELATIVE_PATH } from './vetoOutcomeLog';

/** Percorso del summary gia' prodotto da Shadow V2. */
export const SHADOW_V2_SUMMARY_RELATIVE_PATH = path.join('artifacts', 'shadow_v2', 'summary.json');

export interface DeskEvidenceSources {
  nowMs: number;
  trades?: readonly TradeJournalEntry[] | null;
  excluded?: readonly ExcludedSetupRecord[] | null;
  rootDir?: string;
}

function readJsonFile(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[AI Desk Evidence] lettura non riuscita (${filePath}): ${message}`);
    return null;
  }
}

/**
 * Fonti incluse in PR-B: diario, scansione, veti, near-miss, Shadow V2.
 * Shadow V1-live resta fuori: la sua vista richiede il bar store del collector
 * e verra' aggiunta in PR-C. Il pack la dichiara come sezione mancante.
 */
export function collectDeskEvidenceInput(sources: DeskEvidenceSources): AiEvidencePackInput {
  const rootDir = typeof sources.rootDir === 'string' && sources.rootDir.length > 0 ? sources.rootDir : process.cwd();
  const input: AiEvidencePackInput = {
    generatedAtMs: sources.nowMs,
    journal: { trades: sources.trades ?? [], excluded: sources.excluded ?? [] },
  };

  try {
    const candidates = getLastScanCandidates();
    if (candidates.length > 0) {
      input.scan = {
        runId: getLastScanRunId(),
        tradeCount: candidates.filter((candidate) => candidate.decision === 'TRADE').length,
        candidates: candidates.map((candidate) => ({
          ticker: candidate.ticker,
          market: candidate.market,
          direction: candidate.direction,
          score: candidate.scoreTotal,
          veto: candidate.veto,
          gate: candidate.gate,
          gateReason: candidate.gateReason,
          decision: candidate.decision,
        })),
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[AI Desk Evidence] scansione non disponibile: ${message}`);
  }

  try {
    const filePath = path.join(rootDir, VETO_LOG_RELATIVE_PATH);
    if (fs.existsSync(filePath)) {
      const rows = summarizeVetoOutcomes(foldVetoLog(fs.readFileSync(filePath, 'utf8')));
      if (rows.length > 0) input.vetoOutcomes = rows;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[AI Desk Evidence] veto outcome non disponibili: ${message}`);
  }

  try {
    const filePath = path.join(rootDir, SHADOW_V1_NEAR_MISS_PATH);
    if (fs.existsSync(filePath)) {
      const records = loadNearMissRecords(filePath);
      if (records.length > 0) {
        const summary = summarizeNearMissRecords(records, sources.nowMs);
        input.nearMiss = {
          totalRecords: summary.totalRecords,
          byGate: summary.byGate.map((bucket) => ({
            gate: bucket.gate,
            total: bucket.total,
            resolved: bucket.resolved,
            winRatePct: bucket.winRatePct,
            meanR: bucket.meanR,
          })),
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[AI Desk Evidence] near-miss non disponibili: ${message}`);
  }

  const shadowV2 = readJsonFile(path.join(rootDir, SHADOW_V2_SUMMARY_RELATIVE_PATH));
  if (shadowV2 !== null) input.shadowV2 = shadowV2;

  return input;
}

/** Pack pronto per il prompt, costruito dalle fonti disponibili a runtime. */
export function buildDeskEvidencePack(sources: DeskEvidenceSources): AiEvidencePack {
  return buildAiEvidencePack(collectDeskEvidenceInput(sources));
}

export interface AiDeskRunOptions {
  pack: AiEvidencePack;
  predicateIds: readonly string[];
  callLlm: (systemInstruction: string, userPrompt: string) => Promise<string | null>;
  question?: string;
  maxChars?: number;
}

export type AiDeskRunResult =
  | {
      ok: true;
      analysis: AiDeskAnalysis;
      packChars: number;
      promptChars: number;
      truncatedSections: readonly string[];
    }
  | {
      ok: false;
      error: 'llm_unavailable' | 'empty' | 'invalid_json';
      detail: string;
      packChars: number;
    };

/**
 * Esegue il giro completo. Non lancia: qualunque guasto diventa `ok: false`
 * con un codice stabile, cosi' l'endpoint puo' rispondere comunque.
 */
export async function runDeskAnalysis(options: AiDeskRunOptions): Promise<AiDeskRunResult> {
  const prompt = buildDeskPrompt(options.pack, {
    question: options.question,
    predicateIds: options.predicateIds,
    maxChars: options.maxChars,
  });

  let raw: string | null = null;
  try {
    raw = await options.callLlm(prompt.systemInstruction, prompt.userPrompt);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'llm_unavailable', detail, packChars: prompt.packChars };
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      ok: false,
      error: 'llm_unavailable',
      detail: 'nessuna risposta dal modello',
      packChars: prompt.packChars,
    };
  }

  const parsed = parseDeskAnalysis(raw, { pack: options.pack, predicateIds: options.predicateIds });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, detail: parsed.detail, packChars: prompt.packChars };
  }

  return {
    ok: true,
    analysis: parsed.analysis,
    packChars: prompt.packChars,
    promptChars: prompt.userPrompt.length,
    truncatedSections: prompt.truncatedSections,
  };
}
