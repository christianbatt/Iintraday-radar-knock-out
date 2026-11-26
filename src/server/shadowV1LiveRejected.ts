/**
 * SHADOW V1 LIVE — esiti dei candidati scartati fuori dal near-miss (SOLA OSSERVAZIONE).
 *
 * Il tracker near-miss (`shadowV1LiveNearMiss.ts`) copre solo i candidati
 * bloccati da UN gate della sua whitelist (ADX borderline, G4, G5, G7, G8/G9,
 * G11). Ogni altro candidato scartato con livelli coerenti — bloccato da due o
 * piu' gate, da un veto, o da un gate fuori whitelist — non aveva nessun esito
 * forward: e' la popolazione che manca al bucket `SCARTO` della calibrazione AI.
 *
 * Questo modulo registra QUEI candidati in un file dedicato e ne segue l'esito
 * reale sulle barre 5m chiuse con lo stesso motore deterministico
 * `evaluateShadowV1Live` (zero look-ahead). Non inventa nulla:
 * - nessun record per candidati `TRADE` (non sono scartati);
 * - nessun record se i livelli entry/stop/target non sono coerenti (non sono
 *   valutabili, quindi non hanno un esito);
 * - nessun record se il candidato e' gia' coperto dal near-miss (niente doppioni
 *   fra le due fonti: il join della calibrazione e' uno-a-uno).
 *
 * Isolamento assoluto, come il near-miss:
 * - file dedicato `rejected.jsonl`, tetto `SHADOW_V1_REJECTED_MAX_RECORDS`;
 * - non entra MAI in `signals.jsonl`, nelle metriche V1 ufficiali, ne' in
 *   SETUP_SELECTOR_LIVE;
 * - un errore non blocca la scansione (ritorna `null`).
 */

import path from 'node:path';
import type {
  ExecutionSetup,
  RawQuoteData,
  ScoredCandidate,
  SystemParameters,
} from '../types/radar';
import { sessionCloseMsFor, sessionDateFor } from '../utils/sessionClose';
import {
  areSetupLevelsValid,
  classifyNearMissCandidate,
} from './shadowV1LiveNearMiss';
import { syncShadowV1RejectedToFirestore } from './shadowFirestoreSync';
import {
  hasOpenForwardRecords,
  isResolvedForwardOutcome,
  readJsonlRecords,
  reevaluateForwardRecords,
  writeJsonlAtomic,
  type JsonlLoadResult,
  type NearMissStatus,
} from './shadowV1LiveRecords';

export const SHADOW_V1_REJECTED_PATH = 'artifacts/shadow_v1_live/rejected.jsonl';
/** Tetto per numero di record: una riga per ticker/sessione, le piu' recenti. */
export const SHADOW_V1_REJECTED_MAX_RECORDS = 400;

export interface ShadowV1RejectedRecord {
  id: string;
  ticker: string;
  market: 'EU' | 'US';
  sessionDate: string;
  direction: 'LONG' | 'SHORT';
  /** Gate falliti letti da `setup.gateResults` (prefisso `VETO:` per i veti). */
  blockedGates: string[];
  /** Causa principale: il veto, il primo gate fallito o il gate del setup. */
  blockedPrimary: string;
  gateDetail: string;
  score: number;
  entryLevel: number;
  stopLossLevel: number;
  target1Level: number;
  decidedAtMs: number;
  sessionCloseMs: number;
  status: NearMissStatus;
  r: number | null;
  fillBarTs: number | null;
  exitBarTs: number | null;
  exitPrice: number | null;
  updatedAtMs: number;
}

export interface RejectedClassification {
  blockedGates: string[];
  blockedPrimary: string;
  gateDetail: string;
}

export type RejectedLoadResult = JsonlLoadResult<ShadowV1RejectedRecord>;

export function loadRejectedRecordsWithStats(filePath: string): RejectedLoadResult {
  return readJsonlRecords<ShadowV1RejectedRecord>(filePath);
}

export function loadRejectedRecords(filePath: string): ShadowV1RejectedRecord[] {
  return loadRejectedRecordsWithStats(filePath).records;
}

export function hasOpenRejectedRecords(rootDir: string = process.cwd()): boolean {
  return hasOpenForwardRecords(loadRejectedRecords(path.join(rootDir, SHADOW_V1_REJECTED_PATH)));
}

/**
 * Un candidato scartato merita un esito forward?
 *
 * Ritorna `null` quando: il warmup e' incompleto (indicatori non affidabili),
 * il setup non e' uno scarto, i livelli non sono coerenti (non valutabile) o il
 * candidato e' gia' coperto dal near-miss. In tutti gli altri casi restituisce
 * i gate che l'hanno bloccato, senza giudizi sul merito.
 */
export function classifyRejectedCandidate(
  cand: ScoredCandidate,
  setup: ExecutionSetup,
  parameters: SystemParameters
): RejectedClassification | null {
  if (cand.score.warmupIncomplete) return null;
  if (setup.decision === 'TRADE') return null;
  if (!areSetupLevelsValid(setup)) return null;
  // Gia' tracciato dal near-miss: le due fonti non devono produrre due esiti
  // per lo stesso candidato.
  if (classifyNearMissCandidate(cand, setup, parameters)) return null;

  const failed = setup.gateResults
    ? Object.entries(setup.gateResults)
        .filter(([, gate]) => gate && !gate.passed)
        .map(([key]) => key)
    : [];
  const veto = typeof cand.score.veto === 'string' && cand.score.veto.length > 0 ? cand.score.veto : null;
  if (!veto && failed.length === 0) return null;

  const blockedGates = veto ? [`VETO:${veto}`, ...failed] : [...failed];
  const blockedPrimary = veto ?? failed[0] ?? setup.blockedGate ?? 'UNKNOWN';
  const extra = failed.length > 1 ? ` (+${failed.length - 1})` : '';
  const gateDetail = veto
    ? `Veto ${veto}${extra}`
    : `${failed.length} gate falliti: ${failed.join(', ')}`;

  return { blockedGates, blockedPrimary, gateDetail };
}

export interface RejectedUpdateResult {
  totalRecords: number;
  resolved: number;
}

/**
 * Registra i nuovi scarti e rivaluta quelli aperti sulle barre chiuse reali di
 * `barsForShadowV1Live`. Stessa meccanica del near-miss, file separato.
 */
export function updateShadowV1Rejected(input: {
  candidates: ReadonlyArray<{ cand: ScoredCandidate; setup: ExecutionSetup }>;
  parameters: SystemParameters;
  quotes?: readonly RawQuoteData[];
  rootDir?: string;
  nowMs?: number;
}): RejectedUpdateResult | null {
  try {
    const rootDir = input.rootDir ?? process.cwd();
    const nowMs = input.nowMs ?? Date.now();
    const filePath = path.join(rootDir, SHADOW_V1_REJECTED_PATH);

    const existing = loadRejectedRecords(filePath);
    const byId = new Map<string, ShadowV1RejectedRecord>();
    for (const rec of existing) byId.set(rec.id, rec);

    let changed = false;

    for (const { cand, setup } of input.candidates) {
      const classified = classifyRejectedCandidate(cand, setup, input.parameters);
      if (!classified) continue;

      const market = cand.quote.market;
      if (market !== 'EU' && market !== 'US') continue;
      const sessionDate = sessionDateFor(market, nowMs);
      if (!sessionDate) continue;
      const sessionCloseMs = sessionCloseMsFor(market, sessionDate);
      if (sessionCloseMs === null) continue;

      // Una riga per ticker e sessione: lo stesso titolo scartato piu' volte
      // nella stessa giornata e' lo stesso candidato.
      const id = `${market}|${cand.quote.ticker}|${sessionDate}`;
      if (byId.has(id)) continue;

      const entryLevel = (setup.entryLevel ?? setup.triggerLevel)!;
      byId.set(id, {
        id,
        ticker: cand.quote.ticker,
        market,
        sessionDate,
        direction: setup.direction as 'LONG' | 'SHORT',
        blockedGates: classified.blockedGates,
        blockedPrimary: classified.blockedPrimary,
        gateDetail: classified.gateDetail,
        score: cand.score.total,
        entryLevel,
        stopLossLevel: setup.stopLossLevel!,
        target1Level: setup.target1Level!,
        decidedAtMs: nowMs,
        sessionCloseMs,
        status: 'PENDING_FILL',
        r: null,
        fillBarTs: null,
        exitBarTs: null,
        exitPrice: null,
        updatedAtMs: nowMs,
      });
      changed = true;
    }

    // Rivalutazione dei soli record non terminali, con barre 5m gia' raccolte.
    if (reevaluateForwardRecords(byId, nowMs)) changed = true;

    const ordered = Array.from(byId.values())
      .sort((a, b) => a.decidedAtMs - b.decidedAtMs)
      .slice(-SHADOW_V1_REJECTED_MAX_RECORDS);

    if (changed) {
      writeJsonlAtomic(filePath, ordered);
      void syncShadowV1RejectedToFirestore(ordered);
    }

    return {
      totalRecords: ordered.length,
      resolved: ordered.filter((r) => isResolvedForwardOutcome(r.status, r.r)).length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Shadow V1 Rejected] errore non bloccante: ${message}`);
    return null;
  }
}
