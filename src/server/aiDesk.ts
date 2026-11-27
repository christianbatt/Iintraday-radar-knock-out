/**
 * Orchestratore AI desk (PR-B).
 *
 * Due responsabilita', entrambe isolanti:
 * 1. `collectDeskEvidenceInput`: raccoglie le fonti gia' esistenti (diario,
 *    istantanea della scansione, log dei veti, near-miss, summary Shadow V2) e
 *    le consegna al pack. Ogni fonte e' in un try/catch indipendente: una fonte
 *    rotta non impedisce alle altre di entrare nel fascicolo, e il pack dichiara
 *    da solo le sezioni mancanti.
 * 2. `analyzeDeskEvidence`: valida la risposta GIA' ottenuta dall'endpoint
 *    contro il fascicolo (nessuna seconda chiamata LLM). Non lancia mai e non
 *    decide nulla: restituisce l'analisi ancorata e ciò che e' stato scartato.
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
import { validateDeskAnalysis, type AiDeskAnalysis } from '../knowledge/aiDeskContract';
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
/**
 * Tetto di sicurezza per le fonti su disco: oltre questa dimensione la sezione
 * viene saltata invece di rallentare la risposta del pulsante.
 */
export const AI_DESK_MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;

function isReadableEvidenceFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size <= AI_DESK_MAX_EVIDENCE_FILE_BYTES;
  } catch {
    return false;
  }
}

export interface DeskEvidenceSources {
  nowMs: number;
  trades?: readonly TradeJournalEntry[] | null;
  excluded?: readonly ExcludedSetupRecord[] | null;
  rootDir?: string;
  /**
   * Risposta gia' calcolata di `/api/shadow/ai-calibration`. Arriva dal
   * chiamante perche' aiDesk non deve leggere log ne' esiti: il fascicolo
   * normalizza, non ricalcola.
   */
  calibration?: unknown;
}

function readJsonFile(filePath: string): unknown {
  try {
    if (!isReadableEvidenceFile(filePath)) return null;
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
  if (sources.calibration && typeof sources.calibration === 'object') {
    input.calibration = sources.calibration;
  }

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
    if (isReadableEvidenceFile(filePath)) {
      const rows = summarizeVetoOutcomes(foldVetoLog(fs.readFileSync(filePath, 'utf8')));
      if (rows.length > 0) input.vetoOutcomes = rows;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[AI Desk Evidence] veto outcome non disponibili: ${message}`);
  }

  try {
    const filePath = path.join(rootDir, SHADOW_V1_NEAR_MISS_PATH);
    if (isReadableEvidenceFile(filePath)) {
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

export interface DeskEvidenceAnalysis {
  analysis: AiDeskAnalysis;
  evidenceKeys: number;
  missingSections: readonly string[];
  insufficientKeys: number;
  packGeneratedAt: string;
}

/**
 * Valida una risposta GIA ottenuta contro il fascicolo probatorio.
 *
 * Nessuna seconda chiamata LLM e nessuna attesa aggiuntiva: il pulsante paga
 * un solo round-trip verso il modello. Le fonti su disco hanno un tetto di
 * dimensione (`AI_DESK_MAX_EVIDENCE_FILE_BYTES`) per non rallentare la risposta.
 */
export function analyzeDeskEvidence(args: {
  sources: DeskEvidenceSources;
  response: unknown;
  predicateIds: readonly string[];
}): DeskEvidenceAnalysis {
  return analyzeDeskEvidencePack({
    pack: buildDeskEvidencePack(args.sources),
    response: args.response,
    predicateIds: args.predicateIds,
  });
}

/**
 * Variante che riceve il pack gia' costruito: l'endpoint lo usa una sola volta,
 * sia per il prompt sia per la validazione (nessuna lettura duplicata).
 */
export function analyzeDeskEvidencePack(args: {
  pack: AiEvidencePack;
  response: unknown;
  predicateIds: readonly string[];
}): DeskEvidenceAnalysis {
  const analysis = validateDeskAnalysis(args.response, {
    pack: args.pack,
    predicateIds: args.predicateIds,
  });
  return {
    analysis,
    evidenceKeys: args.pack.evidence.length,
    missingSections: [...args.pack.missing],
    insufficientKeys: args.pack.insufficient.length,
    packGeneratedAt: args.pack.generatedAt,
  };
}
