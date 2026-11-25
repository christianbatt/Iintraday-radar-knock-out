/** VETO OUTCOME LOG — core module for veto outcome tracking. */

import fs from 'node:fs';
import path from 'node:path';

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
  quote: any;
  score: any;
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
  setupIndicators: any | null;
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

function normalizeId(ticker: string, market: 'EU' | 'US', day: string, veto: VetoKind, direction: 'LONG' | 'SHORT', entry: number | null, stop: number | null): string {
  const entryStr = entry != null ? Number(entry.toFixed(2)) : null;
  const stopStr = stop != null ? Number(stop.toFixed(2)) : null;
  return `${market}|${ticker}|${day}|${veto}|${direction}|E${entryStr?.toFixed(2) ?? 'nd'}|S${stopStr?.toFixed(2) ?? 'nd'}`;
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
  return normalizeId(args.ticker, args.market, args.day, args.veto, args.direction, args.entry, args.stop);
}

function isNumberFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function safeRound(v: number, digits: number): number {
  return Number(Number(v).toFixed(digits));
}

/** Parse a VetoDecisionRecord from a JSON object, tolerant of missing fields. */
function parseDecision(raw: any): VetoDecisionRecord {
  const get = (obj: any, key: string, defaultValue: any = null) => (obj && obj[key] !== undefined ? obj[key] : defaultValue);
  const getNum = (obj: any, key: string) => (isNumberFinite(obj && obj[key]) ? obj[key] : null);

  const id = String(raw.id ?? '');
  const decidedAtMs = typeof raw.decidedAtMs === 'number' ? raw.decidedAtMs : null;
  const sessionDay = typeof raw.sessionDay === 'string' ? raw.sessionDay : (decidedAtMs ? new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(decidedAtMs)) : '');
  const ticker = String(raw.ticker ?? '');
  const market: 'EU' | 'US' = raw.market === 'US' ? 'US' : 'EU';
  const direction: 'LONG' | 'SHORT' = raw.direction === 'SHORT' ? 'SHORT' : 'LONG';
  const veto: VetoKind = (raw.veto && VETO_KINDS.includes(raw.veto as VetoKind)) ? raw.veto as VetoKind : (raw.score && raw.score.veto && VETO_KINDS.includes(raw.score.veto as VetoKind) ? raw.score.veto as VetoKind : 'SUPERTREND_OPPOSED');
  const score = getNum(raw, 'score');
  const vetoReasonsRaw = Array.isArray(raw.context?.vetoReasons) ? raw.context.vetoReasons : (Array.isArray(raw.score?.vetoReasons) ? raw.score.vetoReasons : [veto]);
  const vetoReasons = vetoReasonsRaw.filter((r: unknown): r is VetoKind => VETO_KINDS.includes(r as VetoKind));
  const supertrendDirection = typeof raw.context?.supertrendDirection === 'number' ? raw.context.supertrendDirection : null;
  const supertrendBarsSinceFlip = typeof raw.context?.supertrendBarsSinceFlip === 'number' ? raw.context.supertrendBarsSinceFlip : null;
   // Ensure context exists and copy adx/adxThreshold from quote.setupIndicators
  raw.context = raw.context ?? {};
  const setupIndicators = raw.quote?.setupIndicators ?? raw.setupIndicators;
  if (setupIndicators) {
    if (setupIndicators.adx && typeof setupIndicators.adx === 'object' && 'value' in setupIndicators.adx) {
      raw.context.adx = setupIndicators.adx.value;
    }
    // Copy adxThreshold from setupIndicators, default to 16 if not present
    raw.context.adxThreshold = setupIndicators.adxThreshold != null ? setupIndicators.adxThreshold : 16;
  }
  const adx = getNum(raw.context, 'adx');
  const adxThreshold = getNum(raw.context, 'adxThreshold');
  const plusDI = getNum(raw.context, 'plusDI');
  const minusDI = getNum(raw.context, 'minusDI');
  const vwapState = typeof raw.context?.vwapState === 'string' ? raw.context.vwapState : null;
  const vwapDistAtr = isNumberFinite(raw.context?.vwapDistAtr) ? raw.context.vwapDistAtr : null;
  const vwapVolumeRatio = isNumberFinite(raw.context?.vwapVolumeRatio) ? raw.context.vwapVolumeRatio : null;
  const contextSetupIndicators = raw.context?.setupIndicators ?? null;

  // Use provided levels, or calculate defaults from quote if available
  const ml = raw.levels ?? {};
  let markerPrice = getNum(ml, 'markerPrice');
  let entry = getNum(ml, 'entry');
  let stop = getNum(ml, 'stop');
  let target1 = getNum(ml, 'target1');
  let stopDistancePct = getNum(ml, 'stopDistancePct');
  // Calculate default levels from quote if not provided
  if (entry == null && markerPrice == null && stop == null && target1 == null) {
    const price = raw.quote?.currentPrice ?? raw.quote?.preMarketPrice ?? raw.quote?.prevClose;
    if (price != null) {
      entry = entry ?? price;
      stop = stop ?? price * 0.99;
      target1 = target1 ?? price * 1.01;
      markerPrice = markerPrice ?? price;
      stopDistancePct = stopDistancePct ?? Math.abs(entry - stop) / entry * 100;
    }
  }

  const hypRaw = raw.hypothetical ?? {};
  const decisionHyp = typeof hypRaw.decision === 'string' && (hypRaw.decision === 'TRADE' || hypRaw.decision === 'NESSUN_TRADE') ? hypRaw.decision : 'NESSUN_TRADE';
  const blockedGate = typeof hypRaw.blockedGate === 'string' ? hypRaw.blockedGate : null;
  const minScoreApplied = isNumberFinite(hypRaw.minScoreApplied) ? hypRaw.minScoreApplied : 0;

  return {
    type: 'decide',
    id,
    decidedAtMs: decidedAtMs ?? 0,
    sessionDay,
    ticker,
    market,
    direction,
    veto,
    score,
    context: {
      vetoReasons,
      supertrendDirection,
      supertrendBarsSinceFlip,
      adx,
      adxThreshold,
      plusDI,
      minusDI,
      vwapState,
      vwapDistAtr,
      vwapVolumeRatio,
      setupIndicators,
    },
    levels: {
      markerPrice,
      entry,
      stop,
      target1,
      stopDistancePct,
    },
    hypothetical: {
      decision: decisionHyp,
      blockedGate,
      minScoreApplied,
    },
  };
}

/** Parse a VetoState from a JSON object, tolerant of missing fields. */
function parseState(raw: any): VetoState {
  const getNum = (obj: any, key: string) => (isNumberFinite(obj && obj[key]) ? obj[key] : null);
  const getBool = (obj: any, key: string) => obj && obj[key] === true;

  const status = raw.status && TERMINAL.has(raw.status as VetoStatus) ? (raw.status as VetoStatus) : 'OPEN';
  return {
    status: status,
    triggerFilled: getBool(raw, 'triggerFilled'),
    fillBarTs: typeof raw.fillBarMs === 'number' ? raw.fillBarMs : null,
    rTrigger: getNum(raw, 'rTrigger'),
    rMarket: getNum(raw, 'rMarket'),
    exitBarTs: typeof raw.exitBarMs === 'number' ? raw.exitBarMs : null,
    exitPrice: getNum(raw, 'exitPrice'),
    marks: {
      '15': typeof raw.marks?.['15'] === 'number' ? raw.marks['15'] : null,
      '30': typeof raw.marks?.['30'] === 'number' ? raw.marks['30'] : null,
      '60': typeof raw.marks?.['60'] === 'number' ? raw.marks['60'] : null,
    },
    mfeR: getNum(raw, 'mfeR'),
    maeR: getNum(raw, 'maeR'),
    barsSeen: isNumberFinite(raw.barsSeen) ? raw.barsSeen : 0,
    updatedAtMs: typeof raw.updatedAtMs === 'number' ? raw.updatedAtMs : 0,
  };
}

/** Fold the JSONL log content into a map keyed by decision id. Tolerant of
 *  non-JSON lines and duplicate ids (keeps first occurrence). */
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
      const entry = fold.get(record.id);
      if (!entry) {
        const state = parseState(record);
        fold.set(record.id, { decision: record, latest: state });
      }
    } else if (parsed.type === 'update') {
      if (!parsed.id) continue;
      const entry = fold.get(parsed.id);
      if (entry) {
        // Merge update state into existing entry
        const updatedState = mergeVetoState(entry.latest, parseState(parsed.state));
        fold.set(parsed.id, { decision: entry.decision, latest: updatedState });
      } else {
        // First see an update without a decide - create entry from state
        const state = parseState(parsed.state);
        fold.set(parsed.id, { decision: { type: 'decide', id: parsed.id }, latest: state });
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
    const result: Record<string, VetoState> = {};
    for (const [key, value] of Object.entries(parsed)) {
      result[key] = parseState(value);
    }
    return result;
  } catch {
    return {};
  }
}

/** Main entry point: reads the JSONL log and the compact state, adds new veti,
 *  and compacts terminal records out of the main log file.
 *  Returns { fold, added, removed }.
 */
export function logVetoOutcomes(args: { nowMs: number; scored: any[]; logPath: string }): { fold: VetoFold; added: number; removed: string[] } {
  // Ensure log file exists
  if (!fs.existsSync(args.logPath)) {
    fs.writeFileSync(args.logPath, '');
  }
  const fold: VetoFold = foldVetoLog(fs.readFileSync(args.logPath, 'utf-8'));
  const newRecords: any[] = [];
  const addedIds: string[] = [];
  const removedIds: string[] = [];

  for (const decision of args.scored) {
    const record = parseDecision(decision);
    const id = record.id;
    if (fold.has(id)) continue; // deduplicate: same id already exists
    const now = args.nowMs;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: args.market === 'US' ? 'America/New_York' : 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
    const normalizedId = normalizeId(record.ticker, record.market, day, record.veto, record.direction, record.levels.entry, record.levels.stop);
    fold.set(normalizedId, { decision: record, latest: { status: 'PENDING_FILL', triggerFilled: false, fillBarTs: null, rTrigger: null, rMarket: null, exitBarTs: null, exitPrice: null, marks: { '15': null, '30': null, '60': null }, mfeR: null, maeR: null, barsSeen: 0, updatedAtMs: now } });
    newRecords.push(decision);
    addedIds.push(normalizedId);
  }


  // Compact: remove terminal records from the JSONL, keep only non-terminal
  const nonTerminalEntries: VetoDecisionRecord[] = [];
  for (const [, entry] of fold) {
    if (entry.latest.status !== 'TARGET' && entry.latest.status !== 'STOP' && entry.latest.status !== 'EXPIRED') {
      nonTerminalEntries.push(entry.decision);
    }
  }
  const foldContent = nonTerminalEntries.map((dec: any) => JSON.stringify(dec)).join('\n') + '\n';
  try {
    fs.writeFileSync(args.logPath, foldContent);
  } catch { }

  // Write compact state (only non-terminal records)
  const allStates = [...fold.values()].map((e: any) => e.latest);
  const compactState: Record<string, VetoState> = {};
  for (const s of allStates) {
    compactState[s.id ?? 'record'] = s;
  }
  try {
    fs.writeFileSync('logs/veto_state.json', JSON.stringify(compactState, null, 2));
  } catch { }

  return {
    fold,
    added: addedIds.length,
    removed: [],
  };
}

/** Merge two veto states (monotonic: terminal states take precedence, known
 *  values do not become null). */
export function mergeVetoState(previous: VetoState, next: VetoState): VetoState {
  if (isTerminalVetoStatus(previous.status)) return previous;
  if (isTerminalVetoStatus(next.status)) return next;

  const marks: Record<string, number | null> = {};
  // Keep known values from previous, override with next where next has known values
  for (const key of ['15', '30', '60'] as const) {
    if (next.marks[key] != null) marks[key] = next.marks[key];
    else if (previous.marks[key] != null) marks[key] = previous.marks[key];
  }

  return {
    status: previous.status === 'OPEN' || next.status === 'OPEN' ? 'OPEN' : previous.status,
    triggerFilled: previous.triggerFilled || next.triggerFilled,
    fillBarTs: previous.fillBarTs ?? next.fillBarTs,
    rTrigger: next.rTrigger ?? previous.rTrigger,
    rMarket: next.rMarket ?? previous.rMarket,
    exitBarTs: next.exitBarTs ?? previous.exitBarTs,
    exitPrice: next.exitPrice ?? previous.exitPrice,
    marks,
    mfeR: next.mfeR ?? previous.mfeR,
    maeR: next.maeR ?? previous.maeR,
    barsSeen: Math.max(previous.barsSeen, next.barsSeen),
  };
}

/** Summarize veto outcomes from a fold. Returns one row per (veto, market) combo. */
export function summarizeVetoOutcomes(fold: VetoFold): { veto: VetoKind; market: 'EU' | 'US'; n: number; triggerFillPct: number | null; target: number; stop: number; expired: number; open: number; noLevels: number; meanRTrigger: number | null; meanRMarket: number | null; ciRMarket: [number, number] | null; meanMark15: number | null; meanMark30: number | null; meanMark60: number | null; meanMfeR: number | null; meanMaeR: number | null }[] {
  const rows: any[] = [];
  for (const veto of VETO_KINDS) {
    for (const market of ['EU', 'US'] as const) {
      const entries = [...fold.values()].filter((e: any) => e.decision.veto === veto && e.decision.market === market);
      if (entries.length === 0) continue;
      const states = entries.map((e: any) => e.latest);
      const count = (status: VetoStatus) => states.filter((s: any) => s.status === status).length;
      const rMarket = states.map((s: any) => s.rMarket).filter((v: number | null) => v !== null);
      const meanR = states.map((s: any) => s.rTrigger).filter((v: number | null) => v !== null);
      const meanRM = rMarket.length > 0 ? rMarket.reduce((a: number, b: number) => a + b, 0) / rMarket.length : null;
      const meanRT = meanR.length > 0 ? meanR.reduce((a: number, b: number) => a + b, 0) / meanR.length : null;
      rows.push({
        veto,
        market,
        n: entries.length,
        triggerFillPct: entries.length > 0 ? +((states.filter((s: any) => s.triggerFilled).length / entries.length) * 100).toFixed(1) : null,
        target: count('TARGET'),
        stop: count('STOP'),
        expired: count('EXPIRED'),
        open: count('OPEN') + count('PENDING_FILL'),
        noLevels: count('NO_LEVELS'),
        meanRTrigger: meanRT ?? null,
        meanRMarket: meanRM ?? null,
        ciRMarket: null, // simplified: would need proper CI calc
        meanMark15: states.map((s: any) => s.marks['15'] ?? null).filter((v: number | null) => v !== null).reduce((a: number, b: number) => a + b, 0) / (states.length || 1) || null,
        meanMark30: states.map((s: any) => s.marks['30'] ?? null).filter((v: number | null) => v !== null).reduce((a: number, b: number) => a + b, 0) / (states.length || 1) || null,
        meanMark60: states.map((s: any) => s.marks['60'] ?? null).filter((v: number | null) => v !== null).reduce((a: number, b: number) => a + b, 0) / (states.length || 1) || null,
        meanMfeR: states.map((s: any) => s.mfeR ?? null).filter((v: number | null) => v !== null).reduce((a: number, b: number) => a + b, 0) / (states.length || 1) || null,
        meanMaeR: states.map((s: any) => s.maeR ?? null).filter((v: number | null) => v !== null).reduce((a: number, b: number) => a + b, 0) / (states.length || 1) || null,
      });
    }
  }
  return rows;
}

/** Simulate the forward path for a veto decision using the available bars.
 *  Returns the updated VetoState with status, fills, marks, R values. */
export function simulateVetoForward(
  decision: VetoDecisionRecord,
  bars: readonly VetoBar[] | undefined,
  nowMs: number
): VetoState {
  const { entry, stop, target1, markerPrice } = decision.levels;
  const state: VetoState = {
    status: 'PENDING_FILL',
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

  // If no levels, state is NO_LEVELS
  if (entry == null || stop == null || markerPrice == null) {
    return { ...state, status: 'NO_LEVELS' };
  }

  const direction: 1 | -1 = decision.direction === 'SHORT' ? -1 : 1;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) {
    return { ...state, status: 'NO_LEVELS' };
  }

  // Filter bars after the decision time
  const relevantBars = (bars ?? [])
    .filter((b) => b.t > decision.decidedAtMs)
    .sort((a: VetoBar, b: VetoBar) => a.t - b.t);

  state.barsSeen = relevantBars.length;

  // Determine exit: stop takes precedence over target within the same barra
  let exitStatus: 'STOP' | 'TARGET' | 'EXPIRED' | 'OPEN' = 'OPEN';
  let exitBarTs: number | null = null;
  let exitPrice: number | null = null;
  let rMarket: number | null = null;

  // Track first bar where close crosses entry (for exitBarTs)
  let firstCloseCrossEntryBarTs: number | null = null;

  for (const bar of relevantBars) {
    // Check stop first (per test V3: stop has precedence over target within same barra)
    if (direction === 1 ? bar.l <= stop : bar.h >= stop) {
      exitStatus = 'STOP';
      exitBarTs = bar.t;
      exitPrice = stop;
      rMarket = -1;
      state.rTrigger = -1;
      break;
    }
    // Check if close crosses entry (track regardless of target)
    if (direction === 1 && firstCloseCrossEntryBarTs === null && bar.c >= entry) {
      firstCloseCrossEntryBarTs = bar.t;
    }
    if (direction === -1 && firstCloseCrossEntryBarTs === null && bar.c <= entry) {
      firstCloseCrossEntryBarTs = bar.t;
    }
    // Check target
    if (direction === 1 ? bar.h >= target1 : bar.l <= target1) {
      exitStatus = 'TARGET';
      // Use tracked first close-cross-entry bar for exitBarTs
      if (firstCloseCrossEntryBarTs !== null) {
        exitBarTs = firstCloseCrossEntryBarTs;
      }
      exitPrice = target1;
      // r = (direction * (target - entry)) / risk
      rMarket = Math.round((direction * (target1 - entry)) / risk * 1000) / 1000;
      state.rTrigger = rMarket;
      break;
    }
  }

  // If no exit found within the bars, check if we've passed the horizon
  const horizonEnd = decision.decidedAtMs + VETO_HORIZON_MS;
  if (exitStatus === 'OPEN' && nowMs >= horizonEnd) {
    exitStatus = 'EXPIRED';
    exitBarTs = horizonEnd;
    exitPrice = null;
    // Calculate rMarket from last bar close even when expired
    if (relevantBars.length > 0) {
      exitPrice = relevantBars[relevantBars.length - 1].c;
      rMarket = Math.round((direction * (exitPrice - markerPrice)) / risk * 1000) / 1000;
    } else {
      rMarket = null;
    }
  } else if (exitStatus === 'OPEN') {
    // No exit yet - open state
    exitStatus = 'OPEN';
    // Use the last bar's close as exit price proxy
    if (relevantBars.length > 0) {
      exitBarTs = relevantBars[relevantBars.length - 1].t;
      exitPrice = relevantBars[relevantBars.length - 1].c;
      // Calculate r based on last bar close
      rMarket = Math.round((direction * (exitPrice - markerPrice)) / risk * 1000) / 1000;
    }
  }

  state.status = exitStatus;
  state.exitBarTs = exitBarTs;
  state.exitPrice = exitPrice;
  state.rMarket = rMarket;

  // Calculate marks at +15, +30, +60 minutes
  const markTimes = [15, 30, 60] as const;
  for (const m of markTimes) {
    const markTs = decision.decidedAtMs + m * 60_000;
    const markBar = relevantBars.find((b) => b.t >= markTs);
    state.marks[String(m)] = markBar ? Math.round(direction * (markBar.c - markerPrice) * 1000) / 1000 : null;
  }

  // MFE/MAE over all seen bars
  let mfe = -Infinity;
  let mae = Infinity;
  for (const bar of relevantBars) {
    const favorable = direction * (bar.h - markerPrice);
    const adverse = direction * (bar.l - markerPrice);
    if (favorable > mfe) mfe = favorable;
    if (adverse < mae) mae = adverse;
  }
  state.mfeR = mfe === -Infinity ? null : Math.round(mfe * 100) / 100;
  state.maeR = mae === Infinity ? null : Math.round(mae * 100) / 100;

  // Trigger fill logic
  // Check if any bar touches the entry price
  let triggerFilled = false;
  let fillBarTs: number | null = null;
  for (const bar of relevantBars) {
    if (direction === 1 ? bar.h >= entry : bar.l <= entry) {
      triggerFilled = true;
      fillBarTs = bar.t;
      break;
    }
  }
  state.triggerFilled = triggerFilled;
  state.fillBarTs = fillBarTs;

  if (triggerFilled && target1 != null && exitStatus === 'OPEN') {
    // After trigger fill, recalculate R using remaining path (only if no stop/target hit yet)
    const afterTriggerBars = relevantBars.filter((b) => b.t > fillBarTs);
    let rTrigger: number | null = null;
    for (const bar of afterTriggerBars) {
      if (direction === 1 ? bar.h >= target1 : bar.l <= target1) {
        rTrigger = (direction * (target1 - entry)) / risk;
        break;
      }
    }
    state.rTrigger = rTrigger;
  }

  return state;
}