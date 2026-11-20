/**
 * SHADOW V1 NEAR-MISS TRACKER — Laboratorio controfattuale passivo (SOLA OSSERVAZIONE).
 *
 * Scopo: quando la logica V1 ufficiale (G1-G13 + veto ADX) emette 0 o pochissimi segnali,
 * questo modulo registra separatamente i candidati che hanno fallito **un solo gate**
 * selezionabile (`ADX_BORDERLINE`, `G4_EXTENDED`, `G5_EXPIRED`, `G11_SCORE`) ma possiedono
 * livelli coerenti (Entry, Stop, T1). Ne segue l'esito reale sulle barre 5m chiuse di
 * `bars.json` con lo stesso motore deterministico `evaluateShadowV1Live` (zero look-ahead),
 * rispondendo con i numeri reali alla domanda: "quel filtro ci sta proteggendo o ci sta
 * tagliando i setup migliori?".
 *
 * Isolamento assoluto:
 * - Scrive su file dedicati (`near_miss.jsonl` e `near_miss_summary.json`).
 * - Non entra MAI in `signals.jsonl`, nelle metriche V1 ufficiali, ne' su SETUP_SELECTOR_LIVE.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluateShadowV1Live } from '../knowledge/shadowV1Live';
import { adxThresholds } from '../config/tradingParams';
import type {
  ExecutionSetup,
  RawQuoteData,
  ScoredCandidate,
  SystemParameters,
} from '../types/radar';
import { sessionCloseMsFor, sessionDateFor } from '../utils/sessionClose';
import { barsForShadowV1Live } from './shadowV1LiveCollector';

export const SHADOW_V1_NEAR_MISS_PATH = 'artifacts/shadow_v1_live/near_miss.jsonl';
export const SHADOW_V1_NEAR_MISS_SUMMARY_PATH = 'artifacts/shadow_v1_live/near_miss_summary.json';
export const SHADOW_V1_NEAR_MISS_MAX_RECORDS = 400;

export type NearMissGate = 'ADX_BORDERLINE' | 'G4_EXTENDED' | 'G5_EXPIRED' | 'G11_SCORE';

export type NearMissStatus =
  | 'PENDING_FILL'
  | 'OPEN'
  | 'TARGET'
  | 'STOP'
  | 'EXPIRED'
  | 'NOT_FILLED';

export interface ShadowV1NearMissRecord {
  id: string;
  ticker: string;
  market: 'EU' | 'US';
  sessionDate: string;
  direction: 'LONG' | 'SHORT';
  nearMissGate: NearMissGate;
  gateDetail: string;
  score: number;
  adxValue: number | null;
  extensionPct: number | null;
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

export interface NearMissGateBucket {
  gate: NearMissGate;
  label: string;
  total: number;
  resolved: number;
  wins: number;
  stops: number;
  expired: number;
  notFilled: number;
  open: number;
  winRatePct: number | null;
  meanR: number | null;
  sumR: number | null;
}

export interface ShadowV1NearMissSummary {
  version: number;
  generatedAt: string;
  totalRecords: number;
  byGate: NearMissGateBucket[];
  recent: ShadowV1NearMissRecord[];
  note: string;
}

const NEAR_MISS_GATE_LABELS: Record<NearMissGate, string> = {
  ADX_BORDERLINE: 'ADX appena sotto soglia (14..soglia)',
  G4_EXTENDED: 'G4 Estensione moderata (0,40%..1,20%)',
  G5_EXPIRED: 'G5 Breakout oltre 60m',
  G11_SCORE: 'G11 Score vicino alla soglia (-6 pt)',
};

function writeAtomic(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

export function loadNearMissRecords(filePath: string): ShadowV1NearMissRecord[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const out: ShadowV1NearMissRecord[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t) as ShadowV1NearMissRecord;
        if (parsed && typeof parsed.id === 'string' && typeof parsed.ticker === 'string') {
          out.push(parsed);
        }
      } catch {
        // riga corrotta ignorata
      }
    }
    return out;
  } catch {
    return [];
  }
}

function areSetupLevelsValid(setup: ExecutionSetup): boolean {
  if (setup.direction !== 'LONG' && setup.direction !== 'SHORT') return false;
  const e = setup.entryLevel ?? setup.triggerLevel;
  const s = setup.stopLossLevel;
  const t1 = setup.target1Level;
  if (
    typeof e !== 'number' ||
    !Number.isFinite(e) ||
    e <= 0 ||
    typeof s !== 'number' ||
    !Number.isFinite(s) ||
    s <= 0 ||
    typeof t1 !== 'number' ||
    !Number.isFinite(t1) ||
    t1 <= 0
  ) {
    return false;
  }
  return setup.direction === 'LONG' ? s < e && t1 > e : s > e && t1 < e;
}

export function classifyNearMissCandidate(
  cand: ScoredCandidate,
  setup: ExecutionSetup,
  parameters: SystemParameters
): { gate: NearMissGate; detail: string } | null {
  if (cand.score.warmupIncomplete) return null;
  if (!areSetupLevelsValid(setup)) return null;

  const market = cand.quote.market;

  // Caso 1: unico blocco = veto ADX borderline [14, minThreshold) con tutti gli altri gate (escluso G11 privato dei punti ADX) verdi
  if (cand.score.veto === 'ADX_BELOW_MARKET_THRESHOLD') {
    const adx = cand.quote.setupIndicators?.adx?.value ?? null;
    const minAdx = adxThresholds(market).min;
    if (adx != null && Number.isFinite(adx) && adx >= 14 && adx < minAdx && setup.gateResults) {
      const failedNonScore = Object.entries(setup.gateResults).filter(
        ([k, g]) => k !== 'G11' && g && !g.passed
      );
      if (failedNonScore.length === 0) {
        return {
          gate: 'ADX_BORDERLINE',
          detail: `ADX ${adx.toFixed(1)} < ${minAdx} (Score ${cand.score.total})`,
        };
      }
    }
    return null;
  }

  if (cand.score.veto != null) return null;
  if (setup.decision !== 'NESSUN_TRADE' || !setup.gateResults) return null;

  const failedGates = Object.entries(setup.gateResults)
    .filter(([, g]) => g && !g.passed)
    .map(([k]) => k);

  if (failedGates.length !== 1) return null;
  const onlyFailed = failedGates[0];

  if (onlyFailed === 'G4') {
    const ext = setup.extensionPct ?? null;
    if (ext != null && ext > 0.4 && ext <= 1.2) {
      return {
        gate: 'G4_EXTENDED',
        detail: `Estensione +${ext.toFixed(2)}% > 0,40%`,
      };
    }
  } else if (onlyFailed === 'G5') {
    return {
      gate: 'G5_EXPIRED',
      detail: 'Breakout > 60 min (unica causa di blocco)',
    };
  } else if (onlyFailed === 'G11') {
    const minScore =
      market === 'EU' ? parameters.minScoreEurope : parameters.minScoreUSA;
    const diff = minScore - cand.score.total;
    if (diff > 0 && diff <= 6) {
      return {
        gate: 'G11_SCORE',
        detail: `Score ${cand.score.total} vs soglia ${minScore} (-${diff.toFixed(1)} pt)`,
      };
    }
  }

  return null;
}

export function summarizeNearMissRecords(
  records: readonly ShadowV1NearMissRecord[],
  nowMs: number = Date.now()
): ShadowV1NearMissSummary {
  const gateOrder: NearMissGate[] = [
    'ADX_BORDERLINE',
    'G4_EXTENDED',
    'G5_EXPIRED',
    'G11_SCORE',
  ];
  const resolvedStatuses = new Set<NearMissStatus>(['TARGET', 'STOP', 'EXPIRED']);

  const byGate: NearMissGateBucket[] = gateOrder.map((gate) => {
    const items = records.filter((r) => r.nearMissGate === gate);
    const resolved = items.filter(
      (r) => resolvedStatuses.has(r.status) && typeof r.r === 'number' && Number.isFinite(r.r)
    );
    const wins = resolved.filter((r) => (r.r ?? 0) > 0).length;
    const stops = resolved.filter((r) => r.status === 'STOP').length;
    const expired = resolved.filter((r) => r.status === 'EXPIRED').length;
    const notFilled = items.filter((r) => r.status === 'NOT_FILLED').length;
    const open = items.filter((r) => r.status === 'OPEN' || r.status === 'PENDING_FILL').length;
    const sumR = resolved.reduce((acc, r) => acc + (r.r ?? 0), 0);

    return {
      gate,
      label: NEAR_MISS_GATE_LABELS[gate],
      total: items.length,
      resolved: resolved.length,
      wins,
      stops,
      expired,
      notFilled,
      open,
      winRatePct: resolved.length > 0 ? +((wins / resolved.length) * 100).toFixed(1) : null,
      meanR: resolved.length > 0 ? +(sumR / resolved.length).toFixed(4) : null,
      sumR: resolved.length > 0 ? +sumR.toFixed(4) : null,
    };
  });

  const recent = [...records]
    .sort((a, b) => b.decidedAtMs - a.decidedAtMs)
    .slice(0, 12);

  return {
    version: 1,
    generatedAt: new Date(nowMs).toISOString(),
    totalRecords: records.length,
    byGate,
    recent,
    note: 'Ricerca esplorativa Near-Miss V1 (zero impatto live): R di prezzo lordo senza costi ne leva su setup bloccati da un singolo filtro.',
  };
}

/**
 * Registra nuovi Near-Miss e rivaluta quelli aperti sulle barre chiuse reali di `barsForShadowV1Live`.
 */
export function updateShadowV1NearMiss(input: {
  candidates: ReadonlyArray<{ cand: ScoredCandidate; setup: ExecutionSetup }>;
  parameters: SystemParameters;
  quotes?: readonly RawQuoteData[];
  rootDir?: string;
  nowMs?: number;
}): ShadowV1NearMissSummary | null {
  try {
    const rootDir = input.rootDir ?? process.cwd();
    const nowMs = input.nowMs ?? Date.now();
    const filePath = path.join(rootDir, SHADOW_V1_NEAR_MISS_PATH);
    const summaryPath = path.join(rootDir, SHADOW_V1_NEAR_MISS_SUMMARY_PATH);

    const existing = loadNearMissRecords(filePath);
    const byId = new Map<string, ShadowV1NearMissRecord>();
    for (const rec of existing) byId.set(rec.id, rec);

    let changed = false;

    for (const { cand, setup } of input.candidates) {
      const classified = classifyNearMissCandidate(cand, setup, input.parameters);
      if (!classified) continue;

      const market = cand.quote.market;
      const sessionDate = sessionDateFor(market, nowMs);
      if (!sessionDate) continue;
      const sessionCloseMs = sessionCloseMsFor(market, sessionDate);
      if (sessionCloseMs === null) continue;

      const id = `${market}|${cand.quote.ticker}|${sessionDate}|${classified.gate}`;
      if (byId.has(id)) continue;

      const entryLevel = (setup.entryLevel ?? setup.triggerLevel)!;
      const direction = setup.direction as 'LONG' | 'SHORT';

      const newRec: ShadowV1NearMissRecord = {
        id,
        ticker: cand.quote.ticker,
        market,
        sessionDate,
        direction,
        nearMissGate: classified.gate,
        gateDetail: classified.detail,
        score: cand.score.total,
        adxValue: cand.quote.setupIndicators?.adx?.value ?? null,
        extensionPct: setup.extensionPct ?? null,
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
      };
      byId.set(id, newRec);
      changed = true;
    }

    // Rivaluta record non terminali usando solo barre 5m chiuse gia' raccolte in bars.json
    for (const [id, rec] of byId.entries()) {
      if (rec.status !== 'PENDING_FILL' && rec.status !== 'OPEN') continue;
      const bars = barsForShadowV1Live(rec.ticker, rec.market);
      if (bars.length === 0 && nowMs <= rec.sessionCloseMs) continue;

      const evalRes = evaluateShadowV1Live({
        setup: {
          candidate: { ticker: rec.ticker },
          decision: 'TRADE',
          direction: rec.direction,
          entryLevel: rec.entryLevel,
          triggerLevel: rec.entryLevel,
          stopLossLevel: rec.stopLossLevel,
          target1Level: rec.target1Level,
        },
        decidedAtMs: rec.decidedAtMs,
        sessionCloseMs: rec.sessionCloseMs,
        nowMs,
        bars,
      });

      if (evalRes.status === 'INVALID_SETUP' || evalRes.status === 'DUPLICATE') continue;
      const nextStatus = evalRes.status as NearMissStatus;
      if (
        nextStatus !== rec.status ||
        evalRes.r !== rec.r ||
        evalRes.fillBarTs !== rec.fillBarTs ||
        evalRes.exitBarTs !== rec.exitBarTs
      ) {
        byId.set(id, {
          ...rec,
          status: nextStatus,
          r: evalRes.r,
          fillBarTs: evalRes.fillBarTs,
          exitBarTs: evalRes.exitBarTs,
          exitPrice: evalRes.exitPrice,
          updatedAtMs: nowMs,
        });
        changed = true;
      }
    }

    const ordered = Array.from(byId.values())
      .sort((a, b) => a.decidedAtMs - b.decidedAtMs)
      .slice(-SHADOW_V1_NEAR_MISS_MAX_RECORDS);

    const summary = summarizeNearMissRecords(ordered, nowMs);

    if (changed || (!fs.existsSync(summaryPath) && ordered.length > 0)) {
      const jsonl = ordered.map((r) => JSON.stringify(r)).join('\n') + (ordered.length ? '\n' : '');
      writeAtomic(filePath, jsonl);
      writeAtomic(summaryPath, JSON.stringify(summary, null, 2));
    }

    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Shadow V1 Near-Miss] errore non bloccante: ${message}`);
    return null;
  }
}
