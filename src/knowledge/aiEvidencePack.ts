/**
 * AI Evidence Pack (PR-A).
 *
 * Fascicolo probatorio deterministico che l'AI riceve al posto di 3-4 esempi
 * anonimi. Il pack NON calcola nulla di nuovo: legge artefatti gia' prodotti
 * (scansione, veto outcome, near-miss, Shadow V1-live, Shadow V2, diario) e li
 * normalizza in una struttura stabile, versionata e citabile.
 *
 * Perche' esiste: senza un fascicolo, una LLM puo' solo fare retorica. Con un
 * fascicolo, ogni affermazione futura puo' essere ancorata a una chiave
 * (`veto.EU.SUPERTREND_OPPOSED.meanRMarket`) e verificata da un validatore
 * puro. Questo modulo e' il prerequisito di quel contratto, non lo sostituisce.
 *
 * Regole di progetto (come il resto di `src/knowledge`):
 * - puro: nessun I/O, nessuna rete, nessuna LLM, nessun orologio implicito
 *   (il tempo arriva sempre da `generatedAtMs`);
 * - deterministico: a parita' di input l'output e' identico byte per byte;
 * - non lancia mai: input sporchi vengono scartati e dichiarati, non propagati;
 * - additivo: non tocca gate, selezioni, punteggi o `tradingParams`.
 *
 * Le soglie di campione sono le stesse del validatore deterministico
 * (`MIN_REAL_TRADE_SAMPLE = 30`): un dato sotto soglia viene marcato
 * `insufficient`, cosi' l'AI non puo' fingersi sicura su 4 osservazioni.
 */

import type { ExcludedSetupRecord, TradeJournalEntry } from '../types/radar';

/** Versione dello schema: cambia solo con modifiche incompatibili. */
export const AI_EVIDENCE_PACK_VERSION = 'ai-evidence@1';
/** Soglia di campione, allineata a `MIN_REAL_TRADE_SAMPLE`. */
export const AI_EVIDENCE_MIN_SAMPLE = 30;
/** Budget di caratteri per il testo destinato al prompt. */
export const AI_EVIDENCE_DEFAULT_MAX_CHARS = 12_000;
/** Tetto difensivo sui candidati inclusi (in produzione sono 40). */
export const AI_EVIDENCE_MAX_SCAN_CANDIDATES = 60;

export type AiEvidenceSectionKey =
  | 'scan'
  | 'vetoOutcomes'
  | 'nearMiss'
  | 'shadowV1Live'
  | 'shadowV2'
  | 'journal';

/** Valore citabile: sempre serializzabile, mai `undefined`. */
export type AiEvidenceValue = number | string | boolean | null;

export interface AiEvidenceEntry {
  key: string;
  value: AiEvidenceValue;
  /** Numerosita' su cui poggia il valore, quando applicabile. */
  n: number | null;
  /** `true` quando `n` esiste ed e' sotto `AI_EVIDENCE_MIN_SAMPLE`. */
  insufficient: boolean;
  section: AiEvidenceSectionKey;
}

// ---------------------------------------------------------------------------
// Sezioni
// ---------------------------------------------------------------------------

export interface AiEvidenceScanCandidate {
  ticker: string;
  market: string;
  direction: 'LONG' | 'SHORT' | null;
  score: number | null;
  veto: string | null;
  gate: string | null;
  gateReason: string | null;
  decision: 'TRADE' | null;
}

export interface AiEvidenceScanSection {
  runId: string | null;
  candidates: readonly AiEvidenceScanCandidate[];
  candidateCount: number;
  tradeCount: number;
  /** Candidati scartati perche' oltre il tetto o senza ticker. */
  droppedCandidates: number;
}

/**
 * Riga di `summarizeVetoOutcomes`. Strutturale di proposito: `src/knowledge`
 * non importa da `src/server` (la dipendenza va nell'altro verso). La
 * compatibilita' e' verificata nei test con una riga reale.
 */
export interface AiEvidenceVetoOutcomeRow {
  veto: string;
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
  ciRMarket: readonly [number, number] | null;
  meanMark15: number | null;
  meanMark30: number | null;
  meanMark60: number | null;
  meanMfeR: number | null;
  meanMaeR: number | null;
}

export interface AiEvidenceVetoOutcomesSection {
  rows: readonly AiEvidenceVetoOutcomeRow[];
}

export interface AiEvidenceNearMissBucket {
  gate: string;
  total: number;
  resolved: number;
  winRatePct: number | null;
  meanR: number | null;
}

export interface AiEvidenceNearMissSection {
  totalRecords: number;
  byGate: readonly AiEvidenceNearMissBucket[];
}

export interface AiEvidenceShadowV1LiveSection {
  persisted: number;
  pendingFill: number;
  open: number;
  stop: number;
  target: number;
  expired: number;
  notFilled: number;
  stale: number;
  resolved: number;
  meanR: number | null;
  winRatePct: number | null;
  maxDrawdownR: number | null;
  nLate: number;
}

export interface AiEvidenceShadowV2Section {
  nSignals: number;
  nResolved: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  meanRNet: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  dsr: number | null;
  clusterBootstrapPValue: number | null;
  nDayClusters: number;
  limitations: readonly string[];
}

export interface AiEvidenceJournalSection {
  n: number;
  wins: number;
  losses: number;
  breakevens: number;
  expired: number;
  /** Denominatore: solo esiti decisivi (WIN + LOSS). */
  winRatePct: number | null;
  avgR: number | null;
  sumR: number | null;
  profitFactor: number | null;
  nPaper: number;
  nReal: number;
  excluded: {
    n: number;
    profit: number;
    stop: number;
    other: number;
  };
}

export interface AiEvidenceSections {
  scan: AiEvidenceScanSection | null;
  vetoOutcomes: AiEvidenceVetoOutcomesSection | null;
  nearMiss: AiEvidenceNearMissSection | null;
  shadowV1Live: AiEvidenceShadowV1LiveSection | null;
  shadowV2: AiEvidenceShadowV2Section | null;
  journal: AiEvidenceJournalSection | null;
}

export interface AiEvidencePackInput {
  /** Istante di costruzione, iniettato: nessun orologio implicito. */
  generatedAtMs: number;
  scan?: {
    runId?: unknown;
    candidates?: readonly unknown[];
    tradeCount?: unknown;
  } | null;
  vetoOutcomes?: readonly unknown[] | null;
  nearMiss?: {
    totalRecords?: unknown;
    byGate?: readonly unknown[];
  } | null;
  shadowV1Live?: unknown;
  shadowV2?: unknown;
  journal?: {
    trades?: readonly TradeJournalEntry[] | null;
    excluded?: readonly ExcludedSetupRecord[] | null;
  } | null;
}

export interface AiEvidencePack {
  schemaVersion: typeof AI_EVIDENCE_PACK_VERSION;
  generatedAt: string;
  sections: AiEvidenceSections;
  evidence: readonly AiEvidenceEntry[];
  /** Sezioni non fornite o non valide. */
  missing: readonly AiEvidenceSectionKey[];
  /** Chiavi `evidence` con campione sotto soglia. */
  insufficient: readonly string[];
  notes: readonly string[];
}

export interface AiEvidencePackPrompt {
  text: string;
  chars: number;
  maxChars: number;
  truncatedSections: readonly AiEvidenceSectionKey[];
}

// ---------------------------------------------------------------------------
// Normalizzazione (nessuna eccezione, mai `any` in uscita)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Numero finito, arrotondato; altrimenti `null`. */
function num(value: unknown, decimals = 4): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Numero finito non negativo, usato per le numerosita'. */
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function oneLine(value: unknown): string | null {
  const cleaned = text(value);
  return cleaned === null ? null : cleaned.replace(/[\r\n\t]+/g, ' ');
}

/** Tronca una stringa senza spezzare il testo a meta' parola in modo aggressivo. */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function normalizeCandidate(raw: unknown): AiEvidenceScanCandidate | null {
  if (!isRecord(raw)) return null;
  const ticker = text(raw.ticker);
  if (ticker === null) return null;
  const direction = raw.direction === 'LONG' || raw.direction === 'SHORT' ? raw.direction : null;
  const decision = raw.decision === 'TRADE' ? 'TRADE' : null;
  return {
    ticker,
    market: text(raw.market) ?? 'GLOBAL',
    direction,
    score: num(raw.score, 2),
    veto: oneLine(raw.veto),
    gate: oneLine(raw.gate),
    gateReason: oneLine(raw.gateReason),
    decision,
  };
}

function normalizeVetoRow(raw: unknown): AiEvidenceVetoOutcomeRow | null {
  if (!isRecord(raw)) return null;
  const veto = text(raw.veto);
  const market = raw.market === 'EU' || raw.market === 'US' ? raw.market : null;
  if (veto === null || market === null) return null;
  const ci = raw.ciRMarket;
  const ciRMarket: readonly [number, number] | null =
    Array.isArray(ci) && ci.length === 2 && typeof ci[0] === 'number' && typeof ci[1] === 'number'
      ? [num(ci[0]) ?? 0, num(ci[1]) ?? 0]
      : null;
  return {
    veto,
    market,
    n: count(raw.n),
    triggerFillPct: num(raw.triggerFillPct, 2),
    target: count(raw.target),
    stop: count(raw.stop),
    expired: count(raw.expired),
    open: count(raw.open),
    noLevels: count(raw.noLevels),
    meanRTrigger: num(raw.meanRTrigger),
    meanRMarket: num(raw.meanRMarket),
    ciRMarket,
    meanMark15: num(raw.meanMark15),
    meanMark30: num(raw.meanMark30),
    meanMark60: num(raw.meanMark60),
    meanMfeR: num(raw.meanMfeR),
    meanMaeR: num(raw.meanMaeR),
  };
}

function normalizeNearMissBucket(raw: unknown): AiEvidenceNearMissBucket | null {
  if (!isRecord(raw)) return null;
  const gate = text(raw.gate);
  if (gate === null) return null;
  return {
    gate,
    total: count(raw.total),
    resolved: count(raw.resolved),
    winRatePct: num(raw.winRatePct, 2),
    meanR: num(raw.meanR),
  };
}

function normalizeShadowV1Live(raw: unknown): AiEvidenceShadowV1LiveSection | null {
  if (!isRecord(raw)) return null;
  const counts = isRecord(raw.counts) ? raw.counts : raw;
  const metrics = isRecord(raw.metrics) ? raw.metrics : raw;
  const section: AiEvidenceShadowV1LiveSection = {
    persisted: count(counts.persisted),
    pendingFill: count(counts.pendingFill),
    open: count(counts.open),
    stop: count(counts.stop),
    target: count(counts.target),
    expired: count(counts.expired),
    notFilled: count(counts.notFilled),
    stale: count(counts.stale),
    resolved: count(metrics.resolved),
    meanR: num(metrics.meanR),
    winRatePct: num(metrics.winRatePct, 2),
    maxDrawdownR: num(metrics.maxDrawdownR),
    nLate: count(metrics.nLate),
  };
  const empty =
    section.persisted === 0 &&
    section.resolved === 0 &&
    section.pendingFill === 0 &&
    section.open === 0 &&
    section.notFilled === 0;
  return empty ? null : section;
}

function normalizeShadowV2(raw: unknown): AiEvidenceShadowV2Section | null {
  if (!isRecord(raw)) return null;
  const nSignals = count(raw.nSignals);
  if (nSignals === 0 && count(raw.nResolved) === 0) return null;
  const limitations = Array.isArray(raw.limitations)
    ? raw.limitations
        .map((item) => oneLine(item))
        .filter((item): item is string => item !== null)
        .map((item) => clip(item, 240))
    : [];
  return {
    nSignals,
    nResolved: count(raw.nResolved),
    wins: count(raw.wins),
    losses: count(raw.losses),
    winRatePct: num(raw.winRatePct, 2),
    meanRNet: num(raw.meanRNet),
    profitFactor: num(raw.profitFactor),
    maxDrawdownR: num(raw.maxDrawdownR),
    dsr: num(raw.dsr),
    clusterBootstrapPValue: num(raw.clusterBootstrapPValue),
    nDayClusters: count(raw.nDayClusters),
    limitations,
  };
}

/**
 * Aggrega il diario. Gli esiti non decisivi (BREAKEVEN, EXPIRED) restano contati
 * ma fuori dal denominatore del win rate, come fa il validatore deterministico.
 * I controfattuali (setup esclusi) sono tenuti separati e non entrano nel
 * campione: non sono trade eseguiti.
 */
export function summarizeJournalEvidence(
  trades: readonly TradeJournalEntry[] | null | undefined,
  excluded: readonly ExcludedSetupRecord[] | null | undefined
): AiEvidenceJournalSection | null {
  const tradeList = Array.isArray(trades) ? trades : [];
  const excludedList = Array.isArray(excluded) ? excluded : [];
  if (tradeList.length === 0 && excludedList.length === 0) return null;

  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let expired = 0;
  let sumR = 0;
  let sumWinsR = 0;
  let sumLossesR = 0;
  let nPaper = 0;
  let nReal = 0;
  let n = 0;

  for (const trade of tradeList) {
    if (!isRecord(trade)) continue;
    const outcome = trade.outcome;
    const rMultiple = typeof trade.rMultiple === 'number' && Number.isFinite(trade.rMultiple) ? trade.rMultiple : null;
    const status = trade.status;
    if (status === 'OPEN') continue;
    if (outcome !== 'WIN' && outcome !== 'LOSS' && outcome !== 'BREAKEVEN' && outcome !== 'EXPIRED') continue;
    if (rMultiple === null) continue;
    n += 1;
    sumR += rMultiple;
    if (outcome === 'WIN') {
      wins += 1;
      sumWinsR += rMultiple;
    } else if (outcome === 'LOSS') {
      losses += 1;
      sumLossesR += rMultiple;
    } else if (outcome === 'BREAKEVEN') breakevens += 1;
    else expired += 1;
    if (trade.isPaper === true) nPaper += 1;
    else nReal += 1;
  }

  const decisive = wins + losses;
  const winRatePct = decisive > 0 ? num((wins / decisive) * 100, 2) : null;
  const avgR = n > 0 ? num(sumR / n) : null;

  let profit = 0;
  let stop = 0;
  for (const record of excludedList) {
    if (!isRecord(record)) continue;
    if (record.outcomeStatus === 'THEORETICAL_PROFIT') profit += 1;
    else if (record.outcomeStatus === 'THEORETICAL_STOP') stop += 1;
  }
  const excludedTotal = excludedList.length;
  const other = Math.max(0, excludedTotal - profit - stop);

  return {
    n,
    wins,
    losses,
    breakevens,
    expired,
    winRatePct,
    avgR,
    sumR: n > 0 ? num(sumR) : null,
    // Senza perdite il rapporto non e' definito: mai `Infinity` nel pack.
    profitFactor: losses > 0 ? num(sumWinsR / Math.abs(sumLossesR), 4) : null,
    nPaper,
    nReal,
    excluded: { n: excludedTotal, profit, stop, other },
  };
}

// ---------------------------------------------------------------------------
// Indice delle evidenze
// ---------------------------------------------------------------------------

function entry(
  section: AiEvidenceSectionKey,
  key: string,
  value: AiEvidenceValue,
  n: number | null = null
): AiEvidenceEntry {
  return {
    key,
    value,
    n,
    insufficient: n !== null && n < AI_EVIDENCE_MIN_SAMPLE,
    section,
  };
}

function vetoKey(row: AiEvidenceVetoOutcomeRow, suffix: string): string {
  return `veto.${row.market}.${row.veto}.${suffix}`;
}

function buildEvidence(sections: AiEvidenceSections): AiEvidenceEntry[] {
  const out: AiEvidenceEntry[] = [];

  if (sections.scan) {
    out.push(entry('scan', 'scan.runId', sections.scan.runId));
    out.push(entry('scan', 'scan.candidateCount', sections.scan.candidateCount));
    out.push(entry('scan', 'scan.tradeCount', sections.scan.tradeCount));
    const byVeto = new Map<string, number>();
    const byGate = new Map<string, number>();
    for (const candidate of sections.scan.candidates) {
      if (candidate.veto !== null) byVeto.set(candidate.veto, (byVeto.get(candidate.veto) ?? 0) + 1);
      if (candidate.gate !== null) byGate.set(candidate.gate, (byGate.get(candidate.gate) ?? 0) + 1);
    }
    for (const [veto, n] of [...byVeto.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(entry('scan', `scan.vetoCount.${veto}`, n, null));
    }
    for (const [gate, n] of [...byGate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(entry('scan', `scan.gateCount.${gate}`, n, null));
    }
  }

  if (sections.vetoOutcomes) {
    for (const row of sections.vetoOutcomes.rows) {
      out.push(entry('vetoOutcomes', vetoKey(row, 'n'), row.n, row.n));
      out.push(entry('vetoOutcomes', vetoKey(row, 'triggerFillPct'), row.triggerFillPct, row.n));
      out.push(entry('vetoOutcomes', vetoKey(row, 'target'), row.target, row.n));
      out.push(entry('vetoOutcomes', vetoKey(row, 'stop'), row.stop, row.n));
      out.push(entry('vetoOutcomes', vetoKey(row, 'expired'), row.expired, row.n));
      out.push(entry('vetoOutcomes', vetoKey(row, 'meanRMarket'), row.meanRMarket, row.n));
      out.push(entry('vetoOutcomes', vetoKey(row, 'meanRTrigger'), row.meanRTrigger, row.n));
      out.push(entry('vetoOutcomes', vetoKey(row, 'ciRLow'), row.ciRMarket ? row.ciRMarket[0] : null, row.n));
      out.push(entry('vetoOutcomes', vetoKey(row, 'ciRHigh'), row.ciRMarket ? row.ciRMarket[1] : null, row.n));
      out.push(entry('vetoOutcomes', vetoKey(row, 'meanMark15'), row.meanMark15, row.n));
      out.push(entry('vetoOutcomes', vetoKey(row, 'meanMark30'), row.meanMark30, row.n));
      out.push(entry('vetoOutcomes', vetoKey(row, 'meanMark60'), row.meanMark60, row.n));
    }
  }

  if (sections.nearMiss) {
    out.push(entry('nearMiss', 'nearMiss.totalRecords', sections.nearMiss.totalRecords));
    for (const bucket of sections.nearMiss.byGate) {
      out.push(entry('nearMiss', `nearMiss.${bucket.gate}.total`, bucket.total, null));
      out.push(entry('nearMiss', `nearMiss.${bucket.gate}.resolved`, bucket.resolved, bucket.resolved));
      out.push(entry('nearMiss', `nearMiss.${bucket.gate}.meanR`, bucket.meanR, bucket.resolved));
    }
  }

  if (sections.shadowV1Live) {
    const s = sections.shadowV1Live;
    out.push(entry('shadowV1Live', 'shadowV1Live.persisted', s.persisted));
    out.push(entry('shadowV1Live', 'shadowV1Live.pendingFill', s.pendingFill));
    out.push(entry('shadowV1Live', 'shadowV1Live.open', s.open));
    out.push(entry('shadowV1Live', 'shadowV1Live.stop', s.stop, s.resolved));
    out.push(entry('shadowV1Live', 'shadowV1Live.target', s.target, s.resolved));
    out.push(entry('shadowV1Live', 'shadowV1Live.expired', s.expired, s.resolved));
    out.push(entry('shadowV1Live', 'shadowV1Live.notFilled', s.notFilled));
    out.push(entry('shadowV1Live', 'shadowV1Live.stale', s.stale));
    out.push(entry('shadowV1Live', 'shadowV1Live.resolved', s.resolved, s.resolved));
    out.push(entry('shadowV1Live', 'shadowV1Live.meanR', s.meanR, s.resolved));
    out.push(entry('shadowV1Live', 'shadowV1Live.winRatePct', s.winRatePct, s.resolved));
    out.push(entry('shadowV1Live', 'shadowV1Live.maxDrawdownR', s.maxDrawdownR, s.resolved));
    out.push(entry('shadowV1Live', 'shadowV1Live.nLate', s.nLate));
  }

  if (sections.shadowV2) {
    const s = sections.shadowV2;
    out.push(entry('shadowV2', 'shadowV2.nSignals', s.nSignals));
    out.push(entry('shadowV2', 'shadowV2.nResolved', s.nResolved, s.nResolved));
    out.push(entry('shadowV2', 'shadowV2.wins', s.wins, s.nResolved));
    out.push(entry('shadowV2', 'shadowV2.losses', s.losses, s.nResolved));
    out.push(entry('shadowV2', 'shadowV2.winRatePct', s.winRatePct, s.nResolved));
    out.push(entry('shadowV2', 'shadowV2.meanRNet', s.meanRNet, s.nResolved));
    out.push(entry('shadowV2', 'shadowV2.profitFactor', s.profitFactor, s.nResolved));
    out.push(entry('shadowV2', 'shadowV2.maxDrawdownR', s.maxDrawdownR, s.nResolved));
    out.push(entry('shadowV2', 'shadowV2.dsr', s.dsr, s.nResolved));
    out.push(entry('shadowV2', 'shadowV2.clusterBootstrapPValue', s.clusterBootstrapPValue, s.nResolved));
    out.push(entry('shadowV2', 'shadowV2.nDayClusters', s.nDayClusters));
  }

  if (sections.journal) {
    const s = sections.journal;
    out.push(entry('journal', 'journal.n', s.n, s.n));
    out.push(entry('journal', 'journal.wins', s.wins, s.n));
    out.push(entry('journal', 'journal.losses', s.losses, s.n));
    out.push(entry('journal', 'journal.breakevens', s.breakevens, s.n));
    out.push(entry('journal', 'journal.expired', s.expired, s.n));
    out.push(entry('journal', 'journal.winRatePct', s.winRatePct, s.n));
    out.push(entry('journal', 'journal.avgR', s.avgR, s.n));
    out.push(entry('journal', 'journal.sumR', s.sumR, s.n));
    out.push(entry('journal', 'journal.profitFactor', s.profitFactor, s.n));
    out.push(entry('journal', 'journal.nPaper', s.nPaper, s.n));
    out.push(entry('journal', 'journal.nReal', s.nReal, s.n));
    out.push(entry('journal', 'journal.excluded.n', s.excluded.n));
    out.push(entry('journal', 'journal.excluded.profit', s.excluded.profit));
    out.push(entry('journal', 'journal.excluded.stop', s.excluded.stop));
  }

  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Costruzione
// ---------------------------------------------------------------------------

export function buildAiEvidencePack(input: AiEvidencePackInput): AiEvidencePack {
  const generatedAtMs =
    typeof input?.generatedAtMs === 'number' && Number.isFinite(input.generatedAtMs)
      ? input.generatedAtMs
      : 0;
  const notes: string[] = [
    'Pack deterministico costruito da artefatti gia\' calcolati: nessun gate, punteggio o selezione viene ricalcolato.',
  ];

  let scan: AiEvidenceScanSection | null = null;
  if (isRecord(input?.scan)) {
    const rawCandidates = Array.isArray(input.scan.candidates) ? input.scan.candidates : [];
    const candidates: AiEvidenceScanCandidate[] = [];
    for (const raw of rawCandidates) {
      const candidate = normalizeCandidate(raw);
      if (candidate === null) continue;
      if (candidates.length >= AI_EVIDENCE_MAX_SCAN_CANDIDATES) break;
      candidates.push(candidate);
    }
    const droppedCandidates = Math.max(0, rawCandidates.length - candidates.length);
    if (droppedCandidates > 0) {
      notes.push(`scan: ${droppedCandidates} candidati esclusi (senza ticker o oltre il tetto ${AI_EVIDENCE_MAX_SCAN_CANDIDATES}).`);
    }
    const runId = text(input.scan.runId);
    const tradeCount = count(input.scan.tradeCount);
    if (candidates.length > 0 || runId !== null || tradeCount > 0) {
      scan = { runId, candidates, candidateCount: candidates.length, tradeCount, droppedCandidates };
    }
  }

  let vetoOutcomes: AiEvidenceVetoOutcomesSection | null = null;
  if (Array.isArray(input?.vetoOutcomes)) {
    const rows: AiEvidenceVetoOutcomeRow[] = [];
    for (const raw of input.vetoOutcomes) {
      const row = normalizeVetoRow(raw);
      if (row !== null) rows.push(row);
    }
    if (rows.length > 0) {
      vetoOutcomes = {
        rows: [...rows].sort((a, b) => `${a.market}.${a.veto}`.localeCompare(`${b.market}.${b.veto}`)),
      };
    }
  }

  let nearMiss: AiEvidenceNearMissSection | null = null;
  if (isRecord(input?.nearMiss)) {
    const byGate: AiEvidenceNearMissBucket[] = [];
    const rawBuckets = Array.isArray(input.nearMiss.byGate) ? input.nearMiss.byGate : [];
    for (const raw of rawBuckets) {
      const bucket = normalizeNearMissBucket(raw);
      if (bucket !== null) byGate.push(bucket);
    }
    if (byGate.length > 0) {
      nearMiss = {
        totalRecords: count(input.nearMiss.totalRecords),
        byGate: byGate.sort((a, b) => a.gate.localeCompare(b.gate)),
      };
    }
  }

  const shadowV1Live = normalizeShadowV1Live(input?.shadowV1Live);
  const shadowV2 = normalizeShadowV2(input?.shadowV2);
  const journal = isRecord(input?.journal)
    ? summarizeJournalEvidence(input.journal.trades, input.journal.excluded)
    : null;

  const sections: AiEvidenceSections = { scan, vetoOutcomes, nearMiss, shadowV1Live, shadowV2, journal };
  const missing: AiEvidenceSectionKey[] = [];
  for (const key of ['scan', 'vetoOutcomes', 'nearMiss', 'shadowV1Live', 'shadowV2', 'journal'] as const) {
    if (sections[key] === null) missing.push(key);
  }
  if (missing.length > 0) {
    notes.push(`Sezioni non disponibili: ${missing.join(', ')}.`);
  }

  const evidence = buildEvidence(sections);
  const insufficient = evidence.filter((item) => item.insufficient).map((item) => item.key);
  if (insufficient.length > 0) {
    notes.push(
      `Campione sotto ${AI_EVIDENCE_MIN_SAMPLE}: ${insufficient.length} chiavi marcate insufficienti. Nessuna conclusione e' ammessa su quelle chiavi.`
    );
  }
  if (shadowV1Live && shadowV2) {
    notes.push('Shadow V1-live e Shadow V2 non sono confrontabili: ingressi, barriere temporali e costi differiscono.');
  }
  notes.push('L\'AI osserva e propone: ogni proposta resta NON_VALIDATA finche\' il validatore deterministico non la conferma.');

  return {
    schemaVersion: AI_EVIDENCE_PACK_VERSION,
    generatedAt: new Date(generatedAtMs).toISOString(),
    sections,
    evidence,
    missing,
    insufficient,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Serializzazione per il prompt
// ---------------------------------------------------------------------------

function sectionPayload(pack: AiEvidencePack, section: AiEvidenceSectionKey): unknown {
  const value = pack.sections[section];
  if (value === null) return null;
  if (section === 'scan') {
    const scan = value as AiEvidenceScanSection;
    return {
      runId: scan.runId,
      candidateCount: scan.candidateCount,
      tradeCount: scan.tradeCount,
      droppedCandidates: scan.droppedCandidates,
      candidates: scan.candidates,
    };
  }
  if (section === 'vetoOutcomes') return (value as AiEvidenceVetoOutcomesSection).rows;
  if (section === 'nearMiss') return value;
  return value;
}

const SECTION_ORDER: readonly AiEvidenceSectionKey[] = [
  'journal',
  'vetoOutcomes',
  'nearMiss',
  'scan',
  'shadowV1Live',
  'shadowV2',
];

/**
 * Testo compatto e deterministico. Le sezioni sono emesse in ordine fisso; se
 * una non entra nel budget viene omessa e dichiarata in `truncatedSections`
 * (mai troncata a meta', mai silenziosa).
 */
export function serializeAiEvidencePack(
  pack: AiEvidencePack,
  options: { maxChars?: number } = {}
): AiEvidencePackPrompt {
  const maxChars =
    typeof options.maxChars === 'number' && Number.isFinite(options.maxChars) && options.maxChars > 0
      ? Math.floor(options.maxChars)
      : AI_EVIDENCE_DEFAULT_MAX_CHARS;

  const lines: string[] = [
    `AI_EVIDENCE schema=${pack.schemaVersion} generatedAt=${pack.generatedAt}`,
  ];
  const truncatedSections: AiEvidenceSectionKey[] = [];

  for (const section of SECTION_ORDER) {
    const payload = sectionPayload(pack, section);
    if (payload === null) continue;
    const line = `SECTION ${section} ${JSON.stringify(payload)}`;
    // +1 per il newline che verra' aggiunto in join.
    if (lines.join('\n').length + 1 + line.length > maxChars) {
      truncatedSections.push(section);
      continue;
    }
    lines.push(line);
  }

  if (pack.insufficient.length > 0) {
    lines.push(`INSUFFICIENT ${pack.insufficient.join(',')}`);
  }
  for (const note of pack.notes) {
    lines.push(`NOTE ${note}`);
  }

  let text = lines.join('\n');
  if (text.length > maxChars) {
    text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return { text, chars: text.length, maxChars, truncatedSections };
}

/** Indice chiave -> voce, per il validatore delle citazioni (PR-B). */
export function indexAiEvidence(pack: AiEvidencePack): Map<string, AiEvidenceEntry> {
  const index = new Map<string, AiEvidenceEntry>();
  for (const item of pack.evidence) index.set(item.key, item);
  return index;
}
