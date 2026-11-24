/**
 * Valutazione AI shadow di TUTTI i candidati della scansione (Fasi 1-2).
 *
 * Questo modulo costruisce la sezione `CANDIDATI_SCANSIONE` dei prompt AI,
 * suddivide i candidati in batch di dimensione fissa, mappa le risposte della
 * LLM per ticker e produce le voci del log shadow con `evaluated: true` e
 * `aiOutcome` valorizzato. I candidati che la LLM non restituisce o il cui
 * output non e' parsabile restano `evaluated: false` con motivo esplicito.
 *
 * L'AI osserva e registra: questo modulo non decide la selezione dei top
 * setup, non scrive in memoria persistente e non tocca i gate.
 */

import { randomUUID } from 'node:crypto';
import type { AiShadowLogCandidateSource, AiShadowLogEntry } from './aiShadowLog';
import { AI_SHADOW_DISCARD_REASONS } from './aiShadowLog';

export interface ScanCandidateSnapshot {
  ticker: string;
  market: string;
  direction: string | null;
  /** Punteggio totale gia' calcolato dalla scansione (calculateCandidateScore). */
  scoreTotal: number | null;
  /** Primo veto gia' calcolato dalla scansione, se presente. */
  veto: string | null;
}

export interface ScanEvaluation {
  ticker: string;
  aiOutcome: string;
  aiCategory: string | null;
}

export type ScanEvaluationBatchStatus = 'ok' | 'parse_error' | 'llm_missing';

export interface ScanEvaluationBatchResult {
  batchIndex: number;
  candidateTickers: string[];
  status: ScanEvaluationBatchStatus;
  evaluations: ScanEvaluation[];
  ignoredUnknownTickers: number;
  ignoredDuplicateTickers: number;
  /** ADDITIVO (P4): durata misurata del batch LLM, in millisecondi. */
  durationMs: number;
}

/** ADDITIVO (P2/P3): metadati comuni alle voci prodotte da una valutazione. */
export interface ScanEvaluationMeta {
  runId?: string | null;
  candidateSource?: AiShadowLogCandidateSource | null;
  /** ADDITIVO (P4): concorrenza dei batch (default `AI_SHADOW_CONCURRENCY`). */
  concurrency?: number;
}

export interface ScanEvaluationRunResult {
  entries: AiShadowLogEntry[];
  batches: ScanEvaluationBatchResult[];
  evaluated: number;
  notEvaluated: number;
  ignoredUnknownTickers: number;
  ignoredDuplicateTickers: number;
}

/** Dimensione fissa dei batch inviati alla LLM. */
export const AI_SHADOW_BATCH_SIZE = 10;
/** ADDITIVO (P4): numero massimo di batch LLM eseguiti in parallelo. */
export const AI_SHADOW_CONCURRENCY = 2;
/** Titolo della sezione informativa aggiunta al prompt. */
export const AI_SHADOW_SCAN_SECTION = 'CANDIDATI_SCANSIONE';
/** Tetto difensivo: oltre, i candidati vengono troncati (mai in produzione: 40 titoli). */
export const AI_SHADOW_MAX_SCAN_CANDIDATES = 500;

export const AI_SHADOW_SCAN_SYSTEM_INSTRUCTION =
  'Sei un osservatore shadow quantitativo. Valuti ogni candidato che ricevi e registri un ' +
  'giudizio sintetico. Non decidi la selezione dei setup, non riscrivi le regole e non emetti ' +
  'ordini. Rispondi solo in JSON valido.';

let lastScanCandidates: ScanCandidateSnapshot[] = [];
/** ADDITIVO (P3): runId dell'ultima scansione di processo. */
let lastScanRunId: string | null = null;

/** ADDITIVO (P3): runId dell'ultima scansione salvata in memoria di processo. */
export function getLastScanRunId(): string | null {
  return lastScanRunId;
}

/** ADDITIVO (P3): registra il runId della scansione corrente. */
export function setLastScanRunId(runId: string | null): void {
  lastScanRunId = typeof runId === 'string' && runId.length > 0 ? runId : null;
}

/** Salva l'istantanea dei candidati prodotta dalla scansione (sola memoria di processo). */
export function setLastScanCandidates(candidates: ReadonlyArray<ScanCandidateSnapshot>): void {
  const normalized: ScanCandidateSnapshot[] = [];
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') continue;
    const ticker = typeof raw.ticker === 'string' ? raw.ticker.trim() : '';
    if (ticker.length === 0) continue;
    const market = typeof raw.market === 'string' && raw.market.length > 0 ? raw.market : 'GLOBAL';
    const direction =
      raw.direction === 'LONG' || raw.direction === 'SHORT' ? raw.direction : null;
    const scoreTotal =
      typeof raw.scoreTotal === 'number' && Number.isFinite(raw.scoreTotal) ? raw.scoreTotal : null;
    const veto = typeof raw.veto === 'string' && raw.veto.length > 0 ? raw.veto : null;
    normalized.push({ ticker, market, direction, scoreTotal, veto });
    if (normalized.length >= AI_SHADOW_MAX_SCAN_CANDIDATES) break;
  }
  lastScanCandidates = normalized;
}

/** Copia dei candidati dell'ultima scansione. */
export function getLastScanCandidates(): ScanCandidateSnapshot[] {
  return lastScanCandidates.map((candidate) => ({ ...candidate }));
}

/** Azzera l'istantanea (usato dai test). */
export function resetLastScanCandidates(): void {
  lastScanCandidates = [];
  lastScanRunId = null;
  pendingHandlerScanInput = null;
}

/**
 * ADDITIVO (P2): normalizza il campo `scanCandidates` inviato dal client.
 * Accetta `score` oppure `scoreTotal`; scarta le voci senza ticker.
 */
export function normalizeScanCandidatesPayload(raw: unknown): ScanCandidateSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const normalized: ScanCandidateSnapshot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const ticker = typeof row.ticker === 'string' ? row.ticker.trim() : '';
    if (ticker.length === 0) continue;
    const market = typeof row.market === 'string' && row.market.length > 0 ? row.market : 'GLOBAL';
    const direction = row.direction === 'LONG' || row.direction === 'SHORT' ? row.direction : null;
    const rawScore = typeof row.score === 'number' ? row.score : row.scoreTotal;
    const scoreTotal =
      typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : null;
    const veto = typeof row.veto === 'string' && row.veto.length > 0 ? row.veto : null;
    normalized.push({ ticker, market, direction, scoreTotal, veto });
    if (normalized.length >= AI_SHADOW_MAX_SCAN_CANDIDATES) break;
  }
  return normalized;
}

/** ADDITIVO (P2): esito della scelta fra body del client e istantanea. */
export interface ScanCandidateInputResolution {
  candidates: ScanCandidateSnapshot[];
  candidateSource: AiShadowLogCandidateSource;
  runId: string | null;
}

/** Input del body consegnato all'handler corrente (handoff sincrono). */
let pendingHandlerScanInput: { bodyCandidates: unknown; bodyRunId: unknown } | null = null;

/**
 * ADDITIVO (P2): consegna l'input del body alla valutazione immediatamente
 * successiva. Va chiamata senza `await` in mezzo: `logScanCandidateEvaluations`
 * legge il valore nello stesso tick sincrono, quindi nessuna richiesta
 * concorrente puo' sovrascriverlo prima della lettura.
 *
 * Il passaggio esplicito come argomento resta disponibile tramite
 * `resolveScanCandidateInput`; questo handoff esiste per non alterare la firma
 * della chiamata negli handler (vincolo: nessun test esistente modificato).
 */
export function setHandlerScanInput(bodyCandidates: unknown, bodyRunId: unknown): void {
  pendingHandlerScanInput = { bodyCandidates, bodyRunId };
}

/** ADDITIVO (P2): legge e azzera l'input consegnato da `setHandlerScanInput`. */
export function consumeHandlerScanInput(): { bodyCandidates: unknown; bodyRunId: unknown } {
  const pending = pendingHandlerScanInput;
  pendingHandlerScanInput = null;
  return pending ?? { bodyCandidates: undefined, bodyRunId: undefined };
}

/**
 * ADDITIVO (P2): risolve la sorgente dei candidati per un handler.
 * Priorita': campo `scanCandidates` del body, poi istantanea di processo,
 * infine nessuna sorgente (`candidateSource: 'none'`). Non chiama la LLM.
 */
export function resolveScanCandidateInput(
  bodyScanCandidates?: unknown,
  bodyScanRunId?: unknown
): ScanCandidateInputResolution {
  const fromBody = normalizeScanCandidatesPayload(bodyScanCandidates);
  if (fromBody.length > 0) {
    return {
      candidates: fromBody,
      candidateSource: 'body',
      runId:
        typeof bodyScanRunId === 'string' && bodyScanRunId.length > 0
          ? bodyScanRunId
          : getLastScanRunId(),
    };
  }
  const snapshot = getLastScanCandidates();
  if (snapshot.length > 0) {
    return { candidates: snapshot, candidateSource: 'snapshot', runId: getLastScanRunId() };
  }
  return { candidates: [], candidateSource: 'none', runId: null };
}

/**
 * Una riga compatta per candidato:
 * `ticker | mercato | direzione | esito gates (sintesi) | motivo di veto`.
 * I campi sono quelli gia' calcolati dalla scansione.
 */
export function formatScanCandidateLine(candidate: ScanCandidateSnapshot): string {
  const market =
    candidate.market === 'US' || candidate.market === 'EU' ? candidate.market : 'GLOBAL';
  const direction = candidate.direction ?? 'n.d.';
  const score =
    typeof candidate.scoreTotal === 'number' ? `score ${candidate.scoreTotal}/100` : 'score n.d.';
  const veto = candidate.veto && candidate.veto.length > 0 ? candidate.veto : 'nessuno';
  return `${candidate.ticker} | ${market} | ${direction} | ${score} | veto: ${veto}`;
}

/** Sezione `CANDIDATI_SCANSIONE` completa (titolo + una riga per candidato). */
export function buildScanCandidatesSection(
  candidates: ReadonlyArray<ScanCandidateSnapshot>
): string {
  return [AI_SHADOW_SCAN_SECTION, ...candidates.map(formatScanCandidateLine)].join('\n');
}

/** Prompt di un singolo batch: sezione informativa + formato di risposta stabile. */
export function buildScanEvaluationPrompt(
  candidates: ReadonlyArray<ScanCandidateSnapshot>
): string {
  return `Valuta OGNI candidato elencato e registra un giudizio. La sezione e' informativa: non modificare la selezione dei setup, non proporre nuove regole e non toccare i gate.

${buildScanCandidatesSection(candidates)}

Restituisci solo JSON valido in questo formato esatto:
{"scanEvaluations":[{"ticker":"<ticker>","aiOutcome":"<giudizio sintetico>","aiCategory":"<categoria sintetica>"}]}

Regole: una voce per ogni ticker elencato, ticker identici a quelli della sezione, nessun ticker inventato, "aiOutcome" non vuoto.`;
}

/** Batch di dimensione fissa, nell'ordine dei candidati. */
export function splitScanCandidatesInBatches(
  candidates: ReadonlyArray<ScanCandidateSnapshot>,
  batchSize: number = AI_SHADOW_BATCH_SIZE
): ScanCandidateSnapshot[][] {
  const size = Number.isFinite(batchSize) ? Math.max(1, Math.floor(batchSize)) : AI_SHADOW_BATCH_SIZE;
  const batches: ScanCandidateSnapshot[][] = [];
  for (let i = 0; i < candidates.length; i += size) {
    batches.push(candidates.slice(i, i + size));
  }
  return batches;
}

function stripCodeFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/**
 * Parser dell'output LLM. Accetta solo JSON valido con `scanEvaluations` array;
 * le voci senza ticker o senza `aiOutcome` non valido vengono scartate qui e
 * risultano poi NON_RESTITUITO_DALLA_LLM per il rispettivo candidato.
 */
export function parseScanEvaluations(raw: string): { ok: boolean; evaluations: ScanEvaluation[] } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, evaluations: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch {
    return { ok: false, evaluations: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, evaluations: [] };
  }
  const list = (parsed as Record<string, unknown>).scanEvaluations;
  if (!Array.isArray(list)) {
    return { ok: false, evaluations: [] };
  }
  const evaluations: ScanEvaluation[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const ticker = typeof row.ticker === 'string' ? row.ticker.trim() : '';
    const aiOutcome = typeof row.aiOutcome === 'string' ? row.aiOutcome.trim() : '';
    if (ticker.length === 0 || aiOutcome.length === 0) continue;
    const aiCategory =
      typeof row.aiCategory === 'string' && row.aiCategory.trim().length > 0
        ? row.aiCategory.trim()
        : null;
    evaluations.push({ ticker, aiOutcome, aiCategory });
  }
  return { ok: true, evaluations };
}

function buildEntry(
  candidate: ScanCandidateSnapshot,
  source: 'specialize' | 'desk',
  evaluated: boolean,
  aiOutcome: string | null,
  aiCategory: string | null,
  discardReason: string | null,
  meta: {
    runId: string | null;
    candidateSource: AiShadowLogCandidateSource | null;
    durationMs: number | null;
  }
): AiShadowLogEntry {
  const scorePart =
    typeof candidate.scoreTotal === 'number' ? `scan score ${candidate.scoreTotal}/100` : 'scan';
  const vetoPart = candidate.veto ? ` | veto ${candidate.veto}` : '';
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ticker: candidate.ticker,
    market: candidate.market,
    direction: candidate.direction,
    setup: `${scorePart}${vetoPart}`,
    aiOutcome,
    aiCategory,
    source,
    evaluated,
    discarded: false,
    discardReason,
    status: 'NON_VALIDATO',
    outcome: null,
    candidateSource: meta.candidateSource,
    candidateKey: meta.runId ? `${meta.runId}:${candidate.ticker}` : null,
    runId: meta.runId,
    durationMs: meta.durationMs,
  };
}

/**
 * ADDITIVO (P2): voce unica scritta quando né il body né l'istantanea
 * forniscono candidati. Nessuna chiamata LLM viene effettuata.
 */
export function buildNoCandidateEntry(source: 'specialize' | 'desk'): AiShadowLogEntry {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ticker: null,
    market: 'GLOBAL',
    direction: null,
    setup: null,
    aiOutcome: null,
    aiCategory: null,
    source,
    evaluated: false,
    discarded: false,
    discardReason: AI_SHADOW_DISCARD_REASONS.NESSUN_CANDIDATO_DISPONIBILE,
    status: 'NON_VALIDATO',
    outcome: null,
    candidateSource: 'none',
    candidateKey: null,
    runId: null,
    durationMs: null,
  };
}

/**
 * Mappa le risposte dei batch sui candidati. Duplicati e ticker sconosciuti
 * vengono ignorati e contati. Nessun candidato viene perso: chi non ha una
 * valutazione valida resta `evaluated: false` con motivo esplicito.
 */
export function combineScanEvaluations(
  candidates: ReadonlyArray<ScanCandidateSnapshot>,
  batches: ReadonlyArray<ScanEvaluationBatchResult>,
  source: 'specialize' | 'desk',
  meta: ScanEvaluationMeta = {}
): AiShadowLogEntry[] {
  const runId = typeof meta.runId === 'string' && meta.runId.length > 0 ? meta.runId : null;
  const candidateSource = meta.candidateSource ?? null;
  const byTicker = new Map<
    string,
    {
      status: ScanEvaluationBatchStatus;
      evaluation: ScanEvaluation | null;
      durationMs: number | null;
    }
  >();
  for (const batch of batches) {
    const allowed = new Set(batch.candidateTickers);
    const seen = new Map<string, ScanEvaluation>();
    for (const evaluation of batch.evaluations) {
      if (!allowed.has(evaluation.ticker)) continue;
      if (seen.has(evaluation.ticker)) continue;
      seen.set(evaluation.ticker, evaluation);
    }
    for (const ticker of batch.candidateTickers) {
      const evaluation = seen.get(ticker) ?? null;
      byTicker.set(ticker, {
        status: batch.status,
        evaluation,
        durationMs:
          typeof batch.durationMs === 'number' && Number.isFinite(batch.durationMs)
            ? batch.durationMs
            : null,
      });
    }
  }

  return candidates.map((candidate) => {
    const hit = byTicker.get(candidate.ticker);
    const rowMeta = { runId, candidateSource, durationMs: hit?.durationMs ?? null };
    if (!hit) {
      return buildEntry(
        candidate,
        source,
        false,
        null,
        null,
        AI_SHADOW_DISCARD_REASONS.NON_INVIATO_ALLA_LLM,
        rowMeta
      );
    }
    if (hit.status === 'parse_error') {
      return buildEntry(
        candidate,
        source,
        false,
        null,
        null,
        AI_SHADOW_DISCARD_REASONS.ERRORE_PARSING,
        rowMeta
      );
    }
    if (hit.status === 'llm_missing') {
      return buildEntry(
        candidate,
        source,
        false,
        null,
        null,
        AI_SHADOW_DISCARD_REASONS.LLM_NON_DISPONIBILE,
        rowMeta
      );
    }
    if (!hit.evaluation) {
      return buildEntry(
        candidate,
        source,
        false,
        null,
        null,
        AI_SHADOW_DISCARD_REASONS.NON_RESTITUITO_DALLA_LLM,
        rowMeta
      );
    }
    return buildEntry(
      candidate,
      source,
      true,
      hit.evaluation.aiOutcome,
      hit.evaluation.aiCategory,
      null,
      rowMeta
    );
  });
}

/**
 * Esegue la valutazione di tutti i candidati con la LLM fornita dal chiamante.
 * Non lancia mai: un errore di chiamata produce `llm_missing` per il batch.
 */
async function evaluateSingleBatch(
  index: number,
  batch: ReadonlyArray<ScanCandidateSnapshot>,
  callLlm: (systemInstruction: string, userPrompt: string) => Promise<string | null>
): Promise<ScanEvaluationBatchResult> {
  const startedAt = performance.now();
  let raw: string | null = null;
  try {
    raw = await callLlm(AI_SHADOW_SCAN_SYSTEM_INSTRUCTION, buildScanEvaluationPrompt(batch));
  } catch {
    raw = null;
  }
  const durationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;

  let status: ScanEvaluationBatchStatus;
  let evaluations: ScanEvaluation[] = [];
  if (raw == null || raw.trim().length === 0) {
    status = 'llm_missing';
  } else {
    const parsed = parseScanEvaluations(raw);
    if (!parsed.ok) {
      status = 'parse_error';
    } else {
      status = 'ok';
      evaluations = parsed.evaluations;
    }
  }

  const allowed = new Set(batch.map((candidate) => candidate.ticker));
  const seen = new Set<string>();
  let ignoredUnknownTickers = 0;
  let ignoredDuplicateTickers = 0;
  const kept: ScanEvaluation[] = [];
  for (const evaluation of evaluations) {
    if (!allowed.has(evaluation.ticker)) {
      ignoredUnknownTickers += 1;
      continue;
    }
    if (seen.has(evaluation.ticker)) {
      ignoredDuplicateTickers += 1;
      continue;
    }
    seen.add(evaluation.ticker);
    kept.push(evaluation);
  }

  return {
    batchIndex: index,
    candidateTickers: batch.map((candidate) => candidate.ticker),
    status,
    evaluations: kept,
    ignoredUnknownTickers,
    ignoredDuplicateTickers,
    durationMs,
  };
}

export async function evaluateScanCandidates(
  candidates: ReadonlyArray<ScanCandidateSnapshot>,
  source: 'specialize' | 'desk',
  callLlm: (systemInstruction: string, userPrompt: string) => Promise<string | null>,
  batchSize: number = AI_SHADOW_BATCH_SIZE,
  meta: ScanEvaluationMeta = {}
): Promise<ScanEvaluationRunResult> {
  const list = candidates.map((candidate) => ({ ...candidate }));
  const batchList = splitScanCandidatesInBatches(list, batchSize);
  const requestedConcurrency =
    typeof meta.concurrency === 'number' && Number.isFinite(meta.concurrency)
      ? Math.floor(meta.concurrency)
      : AI_SHADOW_CONCURRENCY;
  const concurrency = Math.max(1, requestedConcurrency);
  // I risultati restano nell'ordine dei batch: ogni worker scrive nel proprio
  // indice, poi `batches` viene usato in ordine crescente.
  const slots: (ScanEvaluationBatchResult | null)[] = new Array(batchList.length).fill(null);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= batchList.length) return;
      slots[index] = await evaluateSingleBatch(index, batchList[index], callLlm);
    }
  };
  const workerCount = Math.min(concurrency, batchList.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const batches: ScanEvaluationBatchResult[] = slots.filter(
    (batch): batch is ScanEvaluationBatchResult => batch !== null
  );

  const entries = combineScanEvaluations(list, batches, source, meta);
  const evaluated = entries.filter((entry) => entry.evaluated).length;
  return {
    entries,
    batches,
    evaluated,
    notEvaluated: entries.length - evaluated,
    ignoredUnknownTickers: batches.reduce((sum, batch) => sum + batch.ignoredUnknownTickers, 0),
    ignoredDuplicateTickers: batches.reduce((sum, batch) => sum + batch.ignoredDuplicateTickers, 0),
  };
}

/** Costante esportata per i test: numero di batch atteso per N candidati. */
export function scanEvaluationBatchCount(
  candidateCount: number,
  batchSize: number = AI_SHADOW_BATCH_SIZE
): number {
  return splitScanCandidatesInBatches(
    Array.from({ length: Math.max(0, candidateCount) }, (_, i) => ({
      ticker: `T${i}`,
      market: 'US',
      direction: null,
      scoreTotal: null,
      veto: null,
    })),
    batchSize
  ).length;
}
