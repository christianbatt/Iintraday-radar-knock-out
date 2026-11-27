/** VETO OUTCOME LOG — append-only counterfactual tracking of technical vetoes. */

import fs from 'node:fs';
import path from 'node:path';
import { adxThresholds, TRADING_PARAMS } from '../config/tradingParams';
import { buildExecutionSetup, DEFAULT_SYSTEM_PARAMETERS } from '../utils/calculator';
import type { RawQuoteData, ScoreBreakdown } from '../types/radar';

export type VetoKind = 'SUPERTREND_OPPOSED' | 'ADX_BELOW_MARKET_THRESHOLD' | 'VWAP_OPPOSED';

export const VETO_KINDS: readonly VetoKind[] = [
  'SUPERTREND_OPPOSED',
  'ADX_BELOW_MARKET_THRESHOLD',
  'VWAP_OPPOSED',
];

export const VETO_LOG_RELATIVE_PATH = 'logs/veto_outcome_log.jsonl';

export const VETO_HORIZON_MS = 60 * 60 * 1000;

export const VETO_FORWARD_MARKS_MIN = [15, 30, 60] as const;

export interface VetoBar {
  t: number;
  h: number;
  l: number;
  c: number;
}

export interface VetoScoredQuote {
  quote: RawQuoteData;
  score: ScoreBreakdown;
}

export interface VetoLevels {
  markerPrice: number | null;
  entry: number | null;
  stop: number | null;
  target1: number | null;
  stopDistancePct: number | null;
}

export interface VetoContext {
  vetoReasons: VetoKind[];
  supertrendDirection: number | null;
  supertrendBarsSinceFlip: number | null;
  adx: number | null;
  adxThreshold: number | null;
  plusDI: number | null;
  minusDI: number | null;
  vwapState: string | null;
  vwapDistAtr: number | null;
  vwapVolumeRatio: number | null;
  setupIndicators?: any | null;
}

export interface VetoDecisionRecord {
  type: 'decide';
  id: string;
  decidedAtMs: number;
  sessionDay: string;
  ticker: string;
  market: 'EU' | 'US';
  direction: 'LONG' | 'SHORT';
  veto: VetoKind;
  score: number | null;
  context: VetoContext;
  levels: VetoLevels;
  hypothetical: {
    decision: 'TRADE' | 'NESSUN_TRADE';
    blockedGate: string | null;
    minScoreApplied: number;
  };
}

export type VetoStatus =
  | 'PENDING_FILL'
  | 'OPEN'
  | 'TARGET'
  | 'STOP'
  | 'EXPIRED'
  | 'NO_LEVELS';

const VALID_STATUSES: ReadonlySet<VetoStatus> = new Set<VetoStatus>([
  'PENDING_FILL',
  'OPEN',
  'TARGET',
  'STOP',
  'EXPIRED',
  'NO_LEVELS',
]);

export interface VetoState {
  status: VetoStatus;
  triggerFilled: boolean;
  fillBarTs: number | null;
  rTrigger: number | null;
  rMarket: number | null;
  exitBarTs: number | null;
  exitPrice: number | null;
  marks: Record<string, number | null>;
  mfeR: number | null;
  maeR: number | null;
  barsSeen: number;
  updatedAtMs: number;
}

export interface VetoUpdateRecord {
  type: 'update';
  id: string;
  state: VetoState;
}

export type VetoLogLine = VetoDecisionRecord | VetoUpdateRecord;

export interface VetoFoldEntry {
  decision: VetoDecisionRecord;
  latest: VetoState;
}

export type VetoFold = Map<string, VetoFoldEntry>;

const TERMINAL: ReadonlySet<VetoStatus> = new Set<VetoStatus>(['TARGET', 'STOP', 'EXPIRED']);

export function isTerminalVetoStatus(status: VetoStatus): boolean {
  return TERMINAL.has(status);
}

function isNumberFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function roundTo(v: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(v * factor) / factor;
}

function formatSessionDay(nowMs: number, market: 'EU' | 'US'): string {
  const timeZone = market === 'US' ? 'America/New_York' : 'Europe/Rome';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

function normalizeId(
  ticker: string,
  market: 'EU' | 'US',
  day: string,
  veto: VetoKind,
  direction: 'LONG' | 'SHORT',
  entry: number | null,
  stop: number | null
): string {
  const entryStr = isNumberFinite(entry) ? entry.toFixed(2) : 'nd';
  const stopStr = isNumberFinite(stop) ? stop.toFixed(2) : 'nd';
  return `${market}|${ticker}|${day}|${veto}|${direction}|E${entryStr}|S${stopStr}`;
}

export function vetoRecordId(args: {
  ticker: string;
  market: 'EU' | 'US';
  day: string;
  veto: VetoKind;
  direction: 'LONG' | 'SHORT';
  entry: number | null;
  stop: number | null;
}): string {
  return normalizeId(
    args.ticker,
    args.market,
    args.day,
    args.veto,
    args.direction,
    args.entry,
    args.stop
  );
}

function emptyVetoState(nowMs: number, status: VetoStatus = 'PENDING_FILL'): VetoState {
  return {
    status,
    triggerFilled: false,
    fillBarTs: null,
    rTrigger: null,
    rMarket: null,
    exitBarTs: null,
    exitPrice: null,
    marks: { '15': null, '30': null, '60': null },
    mfeR: null,
    maeR: null,
    barsSeen: 0,
    updatedAtMs: nowMs,
  };
}

function isVetoKind(v: unknown): v is VetoKind {
  return typeof v === 'string' && (VETO_KINDS as readonly string[]).includes(v);
}

/** Parse a VetoDecisionRecord from a persisted JSON line; returns null if corrupt/incomplete. */
function parseDecision(raw: any): VetoDecisionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const getNum = (obj: any, key: string): number | null =>
    obj && isNumberFinite(obj[key]) ? obj[key] : null;

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const ticker = typeof raw.ticker === 'string' ? raw.ticker.trim() : '';
  if (!id || !ticker) return null;

  const decidedAtMs = isNumberFinite(raw.decidedAtMs) ? raw.decidedAtMs : null;
  if (decidedAtMs == null || decidedAtMs <= 0) return null;

  const market: 'EU' | 'US' = raw.market === 'US' ? 'US' : 'EU';
  const direction: 'LONG' | 'SHORT' = raw.direction === 'SHORT' ? 'SHORT' : 'LONG';
  const sessionDay =
    typeof raw.sessionDay === 'string' && raw.sessionDay.trim().length > 0
      ? raw.sessionDay.trim()
      : formatSessionDay(decidedAtMs, market);

  const veto: VetoKind | null = isVetoKind(raw.veto) ? raw.veto : null;
  if (!veto) return null;

  const score = getNum(raw, 'score');
  const ctx = raw.context && typeof raw.context === 'object' ? raw.context : {};
  const vetoReasonsRaw = Array.isArray(ctx.vetoReasons) ? ctx.vetoReasons : [veto];
  const vetoReasons = vetoReasonsRaw.filter((r: unknown): r is VetoKind => isVetoKind(r));
  if (vetoReasons.length === 0) vetoReasons.push(veto);

  const ml = raw.levels && typeof raw.levels === 'object' ? raw.levels : {};
  const hypRaw = raw.hypothetical && typeof raw.hypothetical === 'object' ? raw.hypothetical : {};
  const decisionHyp: 'TRADE' | 'NESSUN_TRADE' =
    hypRaw.decision === 'TRADE' ? 'TRADE' : 'NESSUN_TRADE';

  return {
    type: 'decide',
    id,
    decidedAtMs,
    sessionDay,
    ticker,
    market,
    direction,
    veto,
    score,
    context: {
      vetoReasons,
      supertrendDirection: getNum(ctx, 'supertrendDirection'),
      supertrendBarsSinceFlip: getNum(ctx, 'supertrendBarsSinceFlip'),
      adx: getNum(ctx, 'adx'),
      adxThreshold: getNum(ctx, 'adxThreshold') ?? adxThresholds(market).min,
      plusDI: getNum(ctx, 'plusDI'),
      minusDI: getNum(ctx, 'minusDI'),
      vwapState: typeof ctx.vwapState === 'string' ? ctx.vwapState : null,
      vwapDistAtr: getNum(ctx, 'vwapDistAtr'),
      vwapVolumeRatio: getNum(ctx, 'vwapVolumeRatio'),
    },
    levels: {
      markerPrice: getNum(ml, 'markerPrice'),
      entry: getNum(ml, 'entry'),
      stop: getNum(ml, 'stop'),
      target1: getNum(ml, 'target1'),
      stopDistancePct: getNum(ml, 'stopDistancePct'),
    },
    hypothetical: {
      decision: decisionHyp,
      blockedGate: typeof hypRaw.blockedGate === 'string' ? hypRaw.blockedGate : null,
      minScoreApplied: isNumberFinite(hypRaw.minScoreApplied) ? hypRaw.minScoreApplied : 0,
    },
  };
}

/** Parse a VetoState from JSON, preserving all 6 statuses and ts field names. */
function parseState(raw: any): VetoState {
  if (!raw || typeof raw !== 'object') {
    return emptyVetoState(0, 'PENDING_FILL');
  }
  const getNum = (obj: any, key: string): number | null =>
    obj && isNumberFinite(obj[key]) ? obj[key] : null;

  const status: VetoStatus =
    typeof raw.status === 'string' && VALID_STATUSES.has(raw.status as VetoStatus)
      ? (raw.status as VetoStatus)
      : 'PENDING_FILL';

  const fillBarTs = getNum(raw, 'fillBarTs') ?? getNum(raw, 'fillBarMs');
  const exitBarTs = getNum(raw, 'exitBarTs') ?? getNum(raw, 'exitBarMs');

  return {
    status,
    triggerFilled: raw.triggerFilled === true,
    fillBarTs,
    rTrigger: getNum(raw, 'rTrigger'),
    rMarket: getNum(raw, 'rMarket'),
    exitBarTs,
    exitPrice: getNum(raw, 'exitPrice'),
    marks: {
      '15': getNum(raw.marks, '15'),
      '30': getNum(raw.marks, '30'),
      '60': getNum(raw.marks, '60'),
    },
    mfeR: getNum(raw, 'mfeR'),
    maeR: getNum(raw, 'maeR'),
    barsSeen: isNumberFinite(raw.barsSeen) ? raw.barsSeen : 0,
    updatedAtMs: isNumberFinite(raw.updatedAtMs) ? raw.updatedAtMs : 0,
  };
}

/** Build a real counterfactual VetoDecisionRecord from a scored candidate. */
function buildDecisionFromScored(
  item: VetoScoredQuote,
  nowMs: number,
  fallbackMarket?: 'EU' | 'US'
): VetoDecisionRecord | null {
  if (!item || typeof item !== 'object' || !item.quote || !item.score) return null;
  const { quote, score } = item;
  if (score.warmupIncomplete === true) return null;
  if (!isVetoKind(score.veto)) return null;

  const ticker = typeof quote.ticker === 'string' ? quote.ticker.trim() : '';
  if (!ticker) return null;

  const market: 'EU' | 'US' =
    quote.market === 'US' ? 'US' : quote.market === 'EU' ? 'EU' : fallbackMarket === 'US' ? 'US' : 'EU';
  const veto: VetoKind = score.veto;
  const vetoReasons: VetoKind[] = Array.isArray(score.vetoReasons)
    ? score.vetoReasons.filter((r: unknown): r is VetoKind => isVetoKind(r))
    : [veto];
  if (vetoReasons.length === 0) vetoReasons.push(veto);

  const markerPriceRaw = quote.currentPrice ?? quote.preMarketPrice ?? null;
  const markerPrice = isNumberFinite(markerPriceRaw) && markerPriceRaw > 0 ? markerPriceRaw : null;

  // Counterfactual setup computed through the REAL execution pipeline (veto stripped).
  // Zero fabricated percentages: if buildExecutionSetup cannot compute levels, they stay null (NO_LEVELS).
  const scoreWithoutVeto: ScoreBreakdown = {
    ...score,
    veto: null,
    vetoReasons: [],
  };
  let setup: ReturnType<typeof buildExecutionSetup> | null = null;
  try {
    setup = buildExecutionSetup(
      { quote, score: scoreWithoutVeto, rank: 1 },
      null,
      market,
      DEFAULT_SYSTEM_PARAMETERS,
      {
        currentTime: new Date(nowMs),
        customLeve: market === 'US' ? TRADING_PARAMS.LEVE_US : TRADING_PARAMS.LEVE,
        adrMax: market === 'US' ? TRADING_PARAMS.ADR_MAX_US : TRADING_PARAMS.ADR_MAX,
      }
    );
  } catch {
    setup = null;
  }

  const direction: 'LONG' | 'SHORT' =
    setup?.direction === 'SHORT'
      ? 'SHORT'
      : setup?.direction === 'LONG'
        ? 'LONG'
        : (quote.gapPercent ?? 0) < 0
          ? 'SHORT'
          : 'LONG';

  const entry = isNumberFinite(setup?.entryLevel) ? setup!.entryLevel : null;
  const stop = isNumberFinite(setup?.stopLossLevel) ? setup!.stopLossLevel : null;
  const target1 = isNumberFinite(setup?.target1Level) ? setup!.target1Level : null;
  const stopDistancePct =
    isNumberFinite(setup?.stopDistancePct)
      ? setup!.stopDistancePct
      : entry != null && stop != null && entry > 0
        ? roundTo((Math.abs(entry - stop) / entry) * 100, 3)
        : null;

  const sessionDay = formatSessionDay(nowMs, market);
  const id = normalizeId(ticker, market, sessionDay, veto, direction, entry, stop);

  const si = (quote as any).setupIndicators;
  const vs = (quote as any).vwapState;
  const minScoreApplied =
    market === 'US'
      ? (DEFAULT_SYSTEM_PARAMETERS.minScoreUSA ?? TRADING_PARAMS.MIN_SCORE_US)
      : (DEFAULT_SYSTEM_PARAMETERS.minScoreEurope ?? TRADING_PARAMS.MIN_SCORE_EU);

  return {
    type: 'decide',
    id,
    decidedAtMs: nowMs,
    sessionDay,
    ticker,
    market,
    direction,
    veto,
    score: isNumberFinite(score.total) ? score.total : null,
    context: {
      vetoReasons,
      supertrendDirection: isNumberFinite(si?.supertrend?.direction) ? si.supertrend.direction : null,
      supertrendBarsSinceFlip: isNumberFinite(si?.supertrend?.barsSinceFlip)
        ? si.supertrend.barsSinceFlip
        : null,
      adx: isNumberFinite(si?.adx?.value) ? si.adx.value : null,
      adxThreshold: adxThresholds(market).min,
      plusDI: isNumberFinite(si?.adx?.plusDI) ? si.adx.plusDI : null,
      minusDI: isNumberFinite(si?.adx?.minusDI) ? si.adx.minusDI : null,
      vwapState: typeof vs?.state === 'string' ? vs.state : null,
      vwapDistAtr: isNumberFinite(vs?.distAtr) ? vs.distAtr : null,
      vwapVolumeRatio: isNumberFinite(vs?.volumeRatio) ? vs.volumeRatio : null,
    },
    levels: {
      markerPrice,
      entry,
      stop,
      target1,
      stopDistancePct,
    },
    hypothetical: {
      decision: setup?.decision === 'TRADE' ? 'TRADE' : 'NESSUN_TRADE',
      blockedGate: typeof setup?.blockedGate === 'string' ? setup.blockedGate : null,
      minScoreApplied,
    },
  };
}

/** Fold the JSONL log content into a map keyed by decision id. Tolerant of
 *  non-JSON lines, corrupt entries, and duplicate decide ids (keeps first). */
export function foldVetoLog(content: string): VetoFold {
  const fold: VetoFold = new Map();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.type === 'decide') {
      const record = parseDecision(parsed);
      if (!record) continue;
      if (!fold.has(record.id)) {
        const hasLevels =
          record.levels.entry != null &&
          record.levels.stop != null &&
          record.levels.target1 != null &&
          record.levels.markerPrice != null;
        fold.set(record.id, {
          decision: record,
          latest: emptyVetoState(record.decidedAtMs, hasLevels ? 'PENDING_FILL' : 'NO_LEVELS'),
        });
      }
    } else if (parsed.type === 'update') {
      if (typeof parsed.id !== 'string' || !parsed.id.trim() || !parsed.state) continue;
      const entry = fold.get(parsed.id);
      if (entry) {
        const updatedState = mergeVetoState(entry.latest, parseState(parsed.state));
        fold.set(parsed.id, { decision: entry.decision, latest: updatedState });
      }
    }
  }
  return fold;
}

/** Read the compact veto state from veto_state.json. */
export function readVetoState(statePath: string): Record<string, VetoState> {
  try {
    if (!fs.existsSync(statePath)) return {};
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, VetoState> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || key === 'record') continue;
      result[key] = parseState(value);
    }
    return result;
  } catch {
    return {};
  }
}

function statesDiffer(a: VetoState, b: VetoState): boolean {
  return (
    a.status !== b.status ||
    a.triggerFilled !== b.triggerFilled ||
    a.fillBarTs !== b.fillBarTs ||
    a.rTrigger !== b.rTrigger ||
    a.rMarket !== b.rMarket ||
    a.exitBarTs !== b.exitBarTs ||
    a.exitPrice !== b.exitPrice ||
    a.marks['15'] !== b.marks['15'] ||
    a.marks['30'] !== b.marks['30'] ||
    a.marks['60'] !== b.marks['60'] ||
    a.mfeR !== b.mfeR ||
    a.maeR !== b.maeR ||
    a.barsSeen !== b.barsSeen
  );
}

function extractBarsFromQuote(quote: any): VetoBar[] {
  const rawBars = quote?.setupIndicators?.recentBars;
  if (!Array.isArray(rawBars)) return [];
  const out: VetoBar[] = [];
  for (const b of rawBars) {
    if (!b || typeof b !== 'object') continue;
    const t = isNumberFinite(b.t) ? b.t : isNumberFinite(b.ts) ? b.ts : null;
    const h = isNumberFinite(b.h) ? b.h : isNumberFinite(b.high) ? b.high : null;
    const l = isNumberFinite(b.l) ? b.l : isNumberFinite(b.low) ? b.low : null;
    const c = isNumberFinite(b.c) ? b.c : isNumberFinite(b.close) ? b.close : null;
    if (t != null && h != null && l != null && c != null) {
      out.push({ t, h, l, c });
    }
  }
  return out;
}

function mergeBars(a: readonly VetoBar[] | undefined, b: readonly VetoBar[] | undefined): VetoBar[] {
  const byTs = new Map<number, VetoBar>();
  for (const bar of a ?? []) {
    if (isNumberFinite(bar.t) && isNumberFinite(bar.h) && isNumberFinite(bar.l) && isNumberFinite(bar.c)) {
      byTs.set(bar.t, bar);
    }
  }
  for (const bar of b ?? []) {
    if (isNumberFinite(bar.t) && isNumberFinite(bar.h) && isNumberFinite(bar.l) && isNumberFinite(bar.c)) {
      byTs.set(bar.t, bar);
    }
  }
  return [...byTs.values()].sort((x, y) => x.t - y.t);
}

/**
 * Append-only veto outcome logger.
 * - Records only genuine technical vetoes (`VETO_KINDS`, excluding `warmupIncomplete`).
 * - Never deletes terminal (`TARGET`/`STOP`/`EXPIRED`) records from `args.logPath`.
 * - Updates forward progress for all non-terminal records using real bars and writes
 *   `update` lines when state advances.
 * - Writes compact `veto_state.json` next to `args.logPath`, keyed by real decision `id`.
 */
export function logVetoOutcomes(args: {
  nowMs: number;
  scored: ReadonlyArray<VetoScoredQuote>;
  logPath: string;
  market?: 'EU' | 'US';
  barsByTicker?: ReadonlyMap<string, readonly VetoBar[]>;
}): { fold: VetoFold; added: number; updated: number; removed: string[] } {
  const dir = path.dirname(args.logPath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(args.logPath)) {
    fs.writeFileSync(args.logPath, '', 'utf8');
  }

  const fold: VetoFold = foldVetoLog(fs.readFileSync(args.logPath, 'utf8'));
  const linesToAppend: string[] = [];
  let added = 0;
  let updated = 0;

  // Build combined bar lookup from quotes + optional external barsByTicker
  const combinedBars = new Map<string, VetoBar[]>();
  if (args.barsByTicker) {
    for (const [ticker, bars] of args.barsByTicker.entries()) {
      combinedBars.set(ticker, mergeBars(undefined, bars));
    }
  }
  for (const item of args.scored) {
    const ticker = item?.quote?.ticker;
    if (typeof ticker === 'string' && ticker.trim()) {
      const qBars = extractBarsFromQuote(item.quote);
      if (qBars.length > 0) {
        combinedBars.set(ticker, mergeBars(combinedBars.get(ticker), qBars));
      }
    }
  }

  // 1. Add new veto decisions (append-only, deduplicated by stable id)
  for (const item of args.scored) {
    const record = buildDecisionFromScored(item, args.nowMs, args.market);
    if (!record) continue;
    if (fold.has(record.id)) continue;

    const hasLevels =
      record.levels.entry != null &&
      record.levels.stop != null &&
      record.levels.target1 != null &&
      record.levels.markerPrice != null;
    const initialState = emptyVetoState(
      args.nowMs,
      hasLevels ? 'PENDING_FILL' : 'NO_LEVELS'
    );
    fold.set(record.id, { decision: record, latest: initialState });
    linesToAppend.push(JSON.stringify(record));
    added += 1;
  }

  // 2. Advance forward simulation for all non-terminal records
  for (const [id, entry] of fold.entries()) {
    if (isTerminalVetoStatus(entry.latest.status) || entry.latest.status === 'NO_LEVELS') {
      continue;
    }
    const bars = combinedBars.get(entry.decision.ticker);
    const simulated = simulateVetoForward(entry.decision, bars, args.nowMs);
    const merged = mergeVetoState(entry.latest, simulated);
    if (statesDiffer(entry.latest, merged)) {
      entry.latest = merged;
      const updateLine: VetoUpdateRecord = { type: 'update', id, state: merged };
      linesToAppend.push(JSON.stringify(updateLine));
      updated += 1;
    }
  }

  if (linesToAppend.length > 0) {
    try {
      fs.appendFileSync(args.logPath, linesToAppend.join('\n') + '\n', 'utf8');
    } catch {
      // best-effort I/O
    }
  }

  // 3. Write compact state snapshot next to logPath keyed by real record id
  const statePath = path.join(dir, 'veto_state.json');
  const compactState: Record<string, VetoState> = {};
  for (const [id, entry] of fold.entries()) {
    compactState[id] = entry.latest;
  }
  try {
    fs.writeFileSync(statePath, JSON.stringify(compactState, null, 2), 'utf8');
  } catch {
    // best-effort I/O
  }

  return {
    fold,
    added,
    updated,
    removed: [],
  };
}

/** Merge two veto states (monotonic: terminal states take precedence, known
 *  values never regress to null). */
export function mergeVetoState(previous: VetoState, next: VetoState): VetoState {
  if (isTerminalVetoStatus(previous.status)) return previous;

  const marks: Record<string, number | null> = {
    '15': next.marks?.['15'] ?? previous.marks?.['15'] ?? null,
    '30': next.marks?.['30'] ?? previous.marks?.['30'] ?? null,
    '60': next.marks?.['60'] ?? previous.marks?.['60'] ?? null,
  };

  const mergedMfe =
    previous.mfeR != null && next.mfeR != null
      ? Math.max(previous.mfeR, next.mfeR)
      : next.mfeR ?? previous.mfeR;
  const mergedMae =
    previous.maeR != null && next.maeR != null
      ? Math.min(previous.maeR, next.maeR)
      : next.maeR ?? previous.maeR;

  if (isTerminalVetoStatus(next.status)) {
    return {
      ...next,
      triggerFilled: previous.triggerFilled || next.triggerFilled,
      fillBarTs: previous.fillBarTs ?? next.fillBarTs,
      rTrigger: next.rTrigger ?? previous.rTrigger,
      marks,
      mfeR: mergedMfe,
      maeR: mergedMae,
      barsSeen: Math.max(previous.barsSeen, next.barsSeen),
    };
  }

  const nextStatus: VetoStatus =
    next.status === 'NO_LEVELS' || previous.status === 'NO_LEVELS'
      ? 'NO_LEVELS'
      : previous.status === 'OPEN' || next.status === 'OPEN'
        ? 'OPEN'
        : next.status;

  return {
    status: nextStatus,
    triggerFilled: previous.triggerFilled || next.triggerFilled,
    fillBarTs: previous.fillBarTs ?? next.fillBarTs,
    rTrigger: next.rTrigger ?? previous.rTrigger,
    rMarket: next.rMarket ?? previous.rMarket,
    exitBarTs: next.exitBarTs ?? previous.exitBarTs,
    exitPrice: next.exitPrice ?? previous.exitPrice,
    marks,
    mfeR: mergedMfe,
    maeR: mergedMae,
    barsSeen: Math.max(previous.barsSeen, next.barsSeen),
    updatedAtMs: Math.max(previous.updatedAtMs, next.updatedAtMs),
  };
}

function meanOf(values: ReadonlyArray<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => isNumberFinite(v));
  if (nums.length === 0) return null;
  return roundTo(nums.reduce((a, b) => a + b, 0) / nums.length, 4);
}

function ci95Of(values: ReadonlyArray<number | null | undefined>): [number, number] | null {
  const nums = values.filter((v): v is number => isNumberFinite(v));
  if (nums.length < 2) return null;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance =
    nums.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (nums.length - 1);
  const se = Math.sqrt(variance / nums.length);
  const halfWidth = 1.96 * se;
  return [roundTo(mean - halfWidth, 3), roundTo(mean + halfWidth, 3)];
}

/** Summarize veto outcomes from a fold. Returns one row per (veto, market) combo. */
export function summarizeVetoOutcomes(
  fold: VetoFold
): {
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
}[] {
  const rows = [];
  for (const veto of VETO_KINDS) {
    for (const market of ['EU', 'US'] as const) {
      const entries = [...fold.values()].filter(
        (e) => e.decision.veto === veto && e.decision.market === market
      );
      if (entries.length === 0) continue;
      const states = entries.map((e) => e.latest);
      const count = (status: VetoStatus) => states.filter((s) => s.status === status).length;
      const rMarkets = states.map((s) => s.rMarket);
      const rTriggers = states.map((s) => s.rTrigger);
      rows.push({
        veto,
        market,
        n: entries.length,
        triggerFillPct: roundTo(
          (states.filter((s) => s.triggerFilled).length / entries.length) * 100,
          1
        ),
        target: count('TARGET'),
        stop: count('STOP'),
        expired: count('EXPIRED'),
        open: count('OPEN') + count('PENDING_FILL'),
        noLevels: count('NO_LEVELS'),
        meanRTrigger: meanOf(rTriggers),
        meanRMarket: meanOf(rMarkets),
        ciRMarket: ci95Of(rMarkets),
        meanMark15: meanOf(states.map((s) => s.marks?.['15'] ?? null)),
        meanMark30: meanOf(states.map((s) => s.marks?.['30'] ?? null)),
        meanMark60: meanOf(states.map((s) => s.marks?.['60'] ?? null)),
        meanMfeR: meanOf(states.map((s) => s.mfeR)),
        meanMaeR: meanOf(states.map((s) => s.maeR)),
      });
    }
  }
  return rows;
}

/**
 * Simulate the forward path for a veto decision using real intraday bars.
 * Evaluates TWO distinct counterfactual paths, both properly R-normalized:
 * 1. Market-entry path from `markerPrice` with `riskMarket = |markerPrice - stop|`
 *    and target at the same R multiple (`targetR = dir*(target1 - entry)/|entry - stop|`).
 *    Stop takes strict precedence over target when both are touched in the same bar.
 * 2. Trigger-entry path from `entry` (only if touched by a bar) with `riskTrigger = |entry - stop|`,
 *    checking stop vs `target1` from the fill bar onward (stop takes precedence in same bar).
 * Marks (+15/+30/+60m) and MFE/MAE are normalized in R units relative to `markerPrice` / `riskMarket`.
 */
export function simulateVetoForward(
  decision: VetoDecisionRecord,
  bars: readonly VetoBar[] | undefined,
  nowMs: number
): VetoState {
  const { entry, stop, target1, markerPrice } = decision.levels;
  const state = emptyVetoState(nowMs, 'PENDING_FILL');

  if (entry == null || stop == null || markerPrice == null || target1 == null) {
    return { ...state, status: 'NO_LEVELS' };
  }

  const direction: 1 | -1 = decision.direction === 'SHORT' ? -1 : 1;
  const riskTrigger = Math.abs(entry - stop);
  const riskMarket = Math.abs(markerPrice - stop);
  // Sanity: stop must lie on the adverse side of entry/markerPrice
  const validTriggerStop = direction === 1 ? stop < entry : stop > entry;
  const validMarketStop = direction === 1 ? stop < markerPrice : stop > markerPrice;
  if (riskTrigger <= 0 || riskMarket <= 0 || !validTriggerStop || !validMarketStop) {
    return { ...state, status: 'NO_LEVELS' };
  }

  const targetR = roundTo((direction * (target1 - entry)) / riskTrigger, 3);
  if (!Number.isFinite(targetR) || targetR <= 0) {
    return { ...state, status: 'NO_LEVELS' };
  }
  const targetMarket = markerPrice + direction * targetR * riskMarket;

  const horizonEnd = decision.decidedAtMs + VETO_HORIZON_MS;
  const relevantBars = (bars ?? [])
    .filter((b) => isNumberFinite(b.t) && b.t > decision.decidedAtMs)
    .sort((a, b) => a.t - b.t);

  state.barsSeen = relevantBars.length;

  // 1. Market-entry path (from markerPrice)
  let exitStatus: VetoStatus = relevantBars.length > 0 ? 'OPEN' : 'PENDING_FILL';
  let exitBarTs: number | null = null;
  let exitPrice: number | null = null;
  let rMarket: number | null = null;

  for (const bar of relevantBars) {
    const hitStop = direction === 1 ? bar.l <= stop : bar.h >= stop;
    if (hitStop) {
      exitStatus = 'STOP';
      exitBarTs = bar.t;
      exitPrice = stop;
      rMarket = -1;
      break;
    }
    const hitTargetMarket = direction === 1 ? bar.h >= targetMarket : bar.l <= targetMarket;
    if (hitTargetMarket) {
      exitStatus = 'TARGET';
      exitBarTs = bar.t;
      exitPrice = roundTo(targetMarket, 4);
      rMarket = targetR;
      break;
    }
  }

  if (exitStatus !== 'STOP' && exitStatus !== 'TARGET') {
    if (nowMs >= horizonEnd) {
      exitStatus = 'EXPIRED';
      if (relevantBars.length > 0) {
        const lastBar = relevantBars[relevantBars.length - 1];
        exitBarTs = lastBar.t;
        exitPrice = lastBar.c;
        rMarket = roundTo((direction * (lastBar.c - markerPrice)) / riskMarket, 3);
      } else {
        exitBarTs = horizonEnd;
        exitPrice = null;
        rMarket = null;
      }
    } else if (relevantBars.length > 0) {
      const lastBar = relevantBars[relevantBars.length - 1];
      exitStatus = 'OPEN';
      exitBarTs = lastBar.t;
      exitPrice = lastBar.c;
      rMarket = roundTo((direction * (lastBar.c - markerPrice)) / riskMarket, 3);
    }
  }

  // 2. Trigger-entry path (only if entry trigger is actually touched)
  let triggerFilled = false;
  let fillBarTs: number | null = null;
  let rTrigger: number | null = null;

  for (const bar of relevantBars) {
    if (!triggerFilled) {
      const touchedEntry = direction === 1 ? bar.h >= entry : bar.l <= entry;
      if (!touchedEntry) continue;
      triggerFilled = true;
      fillBarTs = bar.t;
    }
    // Check stop before target (same-bar conservative precedence)
    const hitStop = direction === 1 ? bar.l <= stop : bar.h >= stop;
    if (hitStop) {
      rTrigger = -1;
      break;
    }
    const hitTarget1 = direction === 1 ? bar.h >= target1 : bar.l <= target1;
    if (hitTarget1) {
      rTrigger = targetR;
      break;
    }
  }

  if (triggerFilled && rTrigger === null && relevantBars.length > 0) {
    const lastBar = relevantBars[relevantBars.length - 1];
    if (exitStatus === 'EXPIRED') {
      rTrigger = roundTo((direction * (lastBar.c - entry)) / riskTrigger, 3);
    }
  }

  // 3. Forward marks at +15, +30, +60m normalized in R by riskMarket
  for (const m of VETO_FORWARD_MARKS_MIN) {
    const markTs = decision.decidedAtMs + m * 60_000;
    const markBar = relevantBars.find((b) => b.t >= markTs);
    state.marks[String(m)] = markBar
      ? roundTo((direction * (markBar.c - markerPrice)) / riskMarket, 3)
      : null;
  }

  // 4. MFE / MAE across all seen bars normalized in R by riskMarket (direction-aware for LONG and SHORT)
  let mfe = -Infinity;
  let mae = Infinity;
  for (const bar of relevantBars) {
    const favorable =
      direction === 1
        ? (bar.h - markerPrice) / riskMarket
        : (markerPrice - bar.l) / riskMarket;
    const adverse =
      direction === 1
        ? (bar.l - markerPrice) / riskMarket
        : (markerPrice - bar.h) / riskMarket;
    if (favorable > mfe) mfe = favorable;
    if (adverse < mae) mae = adverse;
  }

  state.status = exitStatus;
  state.triggerFilled = triggerFilled;
  state.fillBarTs = fillBarTs;
  state.rTrigger = rTrigger;
  state.rMarket = rMarket;
  state.exitBarTs = exitBarTs;
  state.exitPrice = exitPrice;
  state.mfeR = mfe === -Infinity ? null : roundTo(mfe, 2);
  state.maeR = mae === Infinity ? null : roundTo(mae, 2);

  return state;
}