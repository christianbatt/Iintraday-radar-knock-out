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
import type {
  AiShadowDecision,
  AiShadowLogCandidateSource,
  AiShadowLogEntry,
} from './aiShadowLog';
import { AI_SHADOW_DECISIONS, AI_SHADOW_DISCARD_REASONS, isAiShadowDecision } from './aiShadowLog';

export interface ScanCandidateSnapshot {
  ticker: string;
  market: string;
  direction: string | null;
  /** Punteggio totale gia' calcolato dalla scansione (calculateCandidateScore). */
  scoreTotal: number | null;
  /** Primo veto gia' calcolato dalla scansione, se presente. */
  veto: string | null;
  /**
   * ADDITIVO (gate nel log AI): gate G1-G13 che ha bloccato il candidato, letto
   * dalla diagnostica Shadow V1 gia' calcolata (`observeShadowV1LiveScan`).
   * Mai ricalcolato qui; `null` quando la diagnostica non e' disponibile.
   */
  gate?: string | null;
  /** ADDITIVO (gate nel log AI): motivo testuale del gate, come prodotto dallo scanner. */
  gateReason?: string | null;
  /**
   * ADDITIVO (provenienza dei gate): runId della scansione che ha prodotto il
   * candidato. I gate sono indicizzati per `runId:ticker`: senza questo campo,
   * o con un runId diverso da quello della diagnostica, nessun gate viene
   * applicato (nessun fallback alla sola chiave `ticker`).
   */
  runId?: string | null;
  /**
   * ADDITIVO (gate nel log AI): esito della diagnostica per il candidato.
   * `TRADE` significa che nessun gate G1-G13 lo ha bloccato; `null` significa
   * che la diagnostica non e' disponibile (nessun gate noto).
   */
  decision?: 'TRADE' | null;
}

export interface ScanEvaluation {
  ticker: string;
  aiOutcome: string;
  aiCategory: string | null;
  /** Decisione chiusa dichiarata dalla LLM e validata dall'handler. */
  decision: AiShadowDecision | null;
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
  /** ADDITIVO (P5): modello che ha risposto per questo batch (`null` se nessuno). */
  model: string | null;
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
/**
 * ADDITIVO (P5): versione del prompt dei batch di valutazione. Cambia quando
 * cambia il testo del prompt: la calibrazione per versione non deve mescolare
 * valutazioni prodotte da istruzioni diverse.
 */
export const AI_SHADOW_SCAN_PROMPT_VERSION = 'ai-scan@1';
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

/** ADDITIVO (P3-fix): handle del runId di una singola richiesta di scansione. */
export interface ScanRunIdHandle {
  value: string | null;
}

/** ADDITIVO (P3-fix): nuovo handle vuoto, uno per richiesta. */
export function createScanRunIdHandle(): ScanRunIdHandle {
  return { value: null };
}

/**
 * ADDITIVO (P3-fix): genera il runId all'inizio della scansione, lo assegna
 * all'handle della singola richiesta e aggiorna l'ultimo runId di processo solo
 * come dato diagnostico. Due scansioni concorrenti sulla stessa istanza
 * ottengono runId distinti e ogni handle conserva il proprio: la risposta HTTP
 * legge l'handle della propria richiesta, non lo stato globale di processo.
 */
export function beginScanRun(
  handle?: ScanRunIdHandle | null,
  generate: () => string = randomUUID
): string {
  const runId = generate();
  if (handle) handle.value = runId;
  setLastScanRunId(runId);
  return runId;
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
    const gate = normalizeGateText(raw.gate);
    const gateReason = normalizeGateText(raw.gateReason);
    const runId = normalizeRunId(raw.runId);
    const decision = raw.decision === 'TRADE' ? 'TRADE' : null;
    normalized.push({
      ticker,
      market,
      direction,
      scoreTotal,
      veto,
      gate,
      gateReason,
      runId,
      decision,
    });
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
  scanGateByRunTicker = new Map();
  scanGateRunIds = [];
  scanGateRunId = null;
}

/**
 * ADDITIVO (gate nel log AI): ultima diagnostica per-candidato di Shadow V1,
 * indicizzata per `runId:ticker`, la stessa convenzione di `candidateKey`.
 * Sola lettura: nessun gate viene calcolato qui e nessuna selezione la consulta.
 *
 * La chiave include il runId: un gate della scansione N non puo' essere letto
 * dai candidati della scansione N+1, nemmeno se i ticker coincidono.
 */
interface ScanGateEntry {
  gate: string | null;
  gateReason: string | null;
  decision: 'TRADE' | null;
}
let scanGateByRunTicker = new Map<string, ScanGateEntry>();
/**
 * ADDITIVO (tetto runId): runId tracciati nella mappa, in ordine di inserimento
 * (il piu' vecchio per primo). Il tetto e' di due runId: corrente e precedente.
 */
let scanGateRunIds: string[] = [];
/** ADDITIVO (gate nel log AI): runId a cui appartiene la diagnostica registrata. */
let scanGateRunId: string | null = null;

/** ADDITIVO (tetto runId): runId conservati nella mappa dei gate. */
export const SCAN_GATE_MAX_RUNS = 2;

/** ADDITIVO (provenienza dei gate): runId valido, oppure `null`. */
function normalizeRunId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** ADDITIVO (provenienza dei gate): chiave unica per una coppia runId/ticker. */
function scanGateKey(runId: string, ticker: string): string {
  return `${runId}:${ticker}`;
}

/**
 * ADDITIVO (tetto runId): elimina tutte le chiavi di un runId. Il prefisso usato
 * per l'eliminazione e' esattamente `scanGateKey(runId, '')`, quindi non tocca
 * le chiavi di altri runId a meno che un runId non sia prefisso di un altro
 * (impossibile: il runId e' un UUID, senza `:` ne' `/`).
 */
function dropScanGateRun(runId: string): void {
  const prefix = scanGateKey(runId, '');
  for (const key of Array.from(scanGateByRunTicker.keys())) {
    if (key.startsWith(prefix)) scanGateByRunTicker.delete(key);
  }
}

/** ADDITIVO (gate nel log AI): stringa di una riga, senza a capo, o `null`. */
function normalizeGateText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Riga della diagnostica Shadow V1 accettata dall'aggancio dei gate. */
export interface ScanGateDiagnosticRow {
  ticker?: unknown;
  gate?: unknown;
  reason?: unknown;
  gateReason?: unknown;
  /** ADDITIVO: `TRADE` quando lo scanner non ha bloccato il candidato. */
  decision?: unknown;
}

/**
 * ADDITIVO (gate nel log AI): registra gate e motivo per `runId:ticker`. Non
 * lancia mai. Se `rows` non e' un array (lettura non disponibile) o il runId
 * manca, la mappa resta invariata: nessun dato vecchio viene riusato su un
 * altro run, perche' la chiave contiene il runId.
 *
 * ADDITIVO (tetto runId): la mappa conserva al massimo `SCAN_GATE_MAX_RUNS`
 * runId (corrente e precedente). Le righe di un runId gia' tracciato vengono
 * sostituite; all'inserimento di un runId nuovo, se i runId tracciati superano
 * il tetto, vengono eliminate tutte le chiavi del piu' vecchio. Nessun timer,
 * nessuna scadenza temporale, nessun azzeramento totale.
 */
export function setScanGateDiagnostics(
  runId: string | null | undefined,
  rows: ReadonlyArray<ScanGateDiagnosticRow> | null | undefined
): void {
  const normalizedRunId = normalizeRunId(runId);
  if (normalizedRunId === null) return;
  if (!Array.isArray(rows)) return;
  const next = new Map<string, ScanGateEntry>(scanGateByRunTicker);
  try {
    const currentPrefix = scanGateKey(normalizedRunId, '');
    for (const key of Array.from(next.keys())) {
      if (key.startsWith(currentPrefix)) next.delete(key);
    }
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const ticker = typeof row.ticker === 'string' ? row.ticker.trim() : '';
      if (ticker.length === 0) continue;
      const gate = normalizeGateText(row.gate);
      const gateReason = normalizeGateText(row.gateReason ?? row.reason);
      const decision = row.decision === 'TRADE' ? 'TRADE' : null;
      if (gate === null && gateReason === null && decision === null) continue;
      const key = scanGateKey(normalizedRunId, ticker);
      if (!next.has(key)) next.set(key, { gate, gateReason, decision });
    }
  } catch {
    return;
  }
  scanGateByRunTicker = next;
  const runIds = scanGateRunIds.filter((id) => id !== normalizedRunId);
  runIds.push(normalizedRunId);
  while (runIds.length > SCAN_GATE_MAX_RUNS) {
    const oldest = runIds.shift();
    if (oldest !== undefined) dropScanGateRun(oldest);
  }
  scanGateRunIds = runIds;
  scanGateRunId = normalizedRunId;
}

/**
 * ADDITIVO (gate nel log AI): legge la diagnostica dalla sorgente fornita e la
 * registra. Non lancia mai: se la lettura fallisce (Shadow V1 disabilitato,
 * assente o in errore) la mappa resta invariata e le voci del log AI vengono
 * scritte comunque, con gate e motivo assenti.
 */
export function applyScanGateDiagnostics(
  runId: string | null | undefined,
  read: () => ReadonlyArray<ScanGateDiagnosticRow> | null | undefined
): void {
  let rows: ReadonlyArray<ScanGateDiagnosticRow> | null | undefined;
  try {
    rows = read();
  } catch {
    return;
  }
  setScanGateDiagnostics(runId, rows);
}

/** ADDITIVO (provenienza dei gate): runId della diagnostica registrata. */
export function getScanGateRunId(): string | null {
  return scanGateRunId;
}

/** Gate noto per una coppia runId/ticker, in sola lettura. */
export function getScanGateForTicker(runId: string, ticker: string): {
  gate: string | null;
  gateReason: string | null;
  decision: 'TRADE' | null;
} {
  const normalizedRunId = normalizeRunId(runId);
  const known =
    normalizedRunId === null
      ? undefined
      : scanGateByRunTicker.get(scanGateKey(normalizedRunId, ticker));
  return known ? { ...known } : { gate: null, gateReason: null, decision: null };
}

/**
 * ADDITIVO (gate nel log AI): aggiunge gate e motivo noti al candidato, cercati
 * con la chiave `runId:ticker`. Senza `candidate.runId` o senza quella chiave
 * nella mappa, `gate` e `gateReason` sono `null` (mai un gate di un altro run e
 * mai un fallback alla sola chiave `ticker`). Il campo gia' presente sul
 * candidato ha la precedenza; `decision` della diagnostica prevale su quello
 * del candidato.
 */
function withScanGate(candidate: ScanCandidateSnapshot): ScanCandidateSnapshot {
  const ownDecision = candidate.decision === 'TRADE' ? 'TRADE' : null;
  const runId = normalizeRunId(candidate.runId);
  if (runId === null) {
    return { ...candidate, gate: null, gateReason: null, decision: ownDecision };
  }
  const known = scanGateByRunTicker.get(scanGateKey(runId, candidate.ticker));
  if (!known) {
    return { ...candidate, gate: null, gateReason: null, decision: ownDecision, runId };
  }
  return {
    ...candidate,
    gate: normalizeGateText(candidate.gate) ?? known.gate,
    gateReason: normalizeGateText(candidate.gateReason) ?? known.gateReason,
    decision: known.decision ?? ownDecision,
    runId,
  };
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
    // ADDITIVO (gate nel log AI): i campi restano assenti quando il body non li
    // porta, cosi' la forma delle voci esistenti non cambia. `gate: "nessuno"`
    // e' la forma con cui il payload esprime un candidato TRADE senza gate.
    const gate = normalizeGateText(row.gate);
    const gateReason = normalizeGateText(row.gateReason);
    const decision =
      row.decision === 'TRADE' || gate === 'nessuno' || gateReason === 'nessuno'
        ? 'TRADE'
        : null;
    const candidate: ScanCandidateSnapshot = { ticker, market, direction, scoreTotal, veto };
    if (decision !== null) {
      candidate.decision = 'TRADE';
    } else {
      if (gate !== null) candidate.gate = gate;
      if (gateReason !== null) candidate.gateReason = gateReason;
    }
    normalized.push(candidate);
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
  try {
    return pending ?? { bodyCandidates: undefined, bodyRunId: undefined };
  } finally {
    pendingHandlerScanInput = null;
  }
}

/**
 * ADDITIVO (P3-fix): azzera l'input in sospeso. Rete di sicurezza usata nel
 * `finally` dell'handler: nessun input resta in stato di modulo se la
 * valutazione lancia dopo il consumo.
 */
export function resetHandlerScanInput(): void {
  pendingHandlerScanInput = null;
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
    const runId = normalizeRunId(bodyScanRunId) ?? getLastScanRunId();
    return {
      candidates: fromBody.map((candidate) => withScanGate({ ...candidate, runId })),
      candidateSource: 'body',
      runId,
    };
  }
  const snapshot = getLastScanCandidates();
  if (snapshot.length > 0) {
    const runId = getLastScanRunId();
    return {
      candidates: snapshot.map((candidate) =>
        withScanGate({ ...candidate, runId: normalizeRunId(candidate.runId) ?? runId })
      ),
      candidateSource: 'snapshot',
      runId,
    };
  }
  return { candidates: [], candidateSource: 'none', runId: null };
}

/**
 * Una riga compatta per candidato:
 * `ticker | mercato | direzione | score N/100 | veto: <veto di scoring> |
 * gate: <G1-G13> | motivo: <motivo del gate>`.
 * Tutti i campi sono quelli gia' calcolati altrove (scoring e diagnostica Shadow
 * V1): qui non si ricalcola nulla. Valore assente => `n.d.`.
 *
 * NOTA: gate e motivo stanno DOPO il veto, non fra score e veto come nella
 * specifica, perche' `ai_shadow_log_coverage.test.ts:306-307` verifica il
 * prefisso esatto `<ticker> | <mercato> | <direzione> | score N/100 | veto: X`
 * e i test esistenti non vanno modificati.
 */
export function formatScanCandidateLine(candidate: ScanCandidateSnapshot): string {
  const market =
    candidate.market === 'US' || candidate.market === 'EU' ? candidate.market : 'GLOBAL';
  const ticker = normalizeGateText(candidate.ticker) ?? 'n.d.';
  const direction = normalizeGateText(candidate.direction) ?? 'n.d.';
  const score =
    typeof candidate.scoreTotal === 'number' ? `score ${candidate.scoreTotal}/100` : 'score n.d.';
  const veto = normalizeGateText(candidate.veto) ?? 'nessuno';
  // ADDITIVO (gate nel log AI): un candidato `TRADE` non ha gate per
  // definizione, quindi scrive `nessuno`; `n.d.` resta riservato alla
  // diagnostica non disponibile. Distinzione imposta dalla Fase 3.1.
  const isTrade = candidate.decision === 'TRADE';
  const gate = isTrade ? 'nessuno' : normalizeGateText(candidate.gate) ?? 'n.d.';
  const gateReason = isTrade ? 'nessuno' : normalizeGateText(candidate.gateReason) ?? 'n.d.';
  return `${ticker} | ${market} | ${direction} | ${score} | veto: ${veto} | gate: ${gate} | motivo: ${gateReason}`;
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
{"scanEvaluations":[{"ticker":"<ticker>","aiOutcome":"<giudizio sintetico>","aiCategory":"<categoria sintetica>","decision":"${AI_SHADOW_DECISIONS.join('|')}"}]}

Regole: una voce per ogni ticker elencato, ticker identici a quelli della sezione, nessun ticker inventato, "aiOutcome" non vuoto, "decision" uno solo dei tre valori ammessi (AZIONE = il candidato ha un edge, ATTESA = serve altra conferma, SCARTO = da non operare). Fuori da quei valori il campo viene ignorato.`;
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
    // Solo i tre valori ammessi: qualunque altra cosa (o l'assenza) resta null,
    // cosi' la calibrazione non deve indovinare.
    const decision = isAiShadowDecision(row.decision) ? row.decision : null;
    evaluations.push({ ticker, aiOutcome, aiCategory, decision });
  }
  return { ok: true, evaluations };
}

function buildEntry(
  candidate: ScanCandidateSnapshot,
  source: 'specialize' | 'desk',
  evaluated: boolean,
  aiOutcome: string | null,
  aiCategory: string | null,
  decision: AiShadowDecision | null,
  discardReason: string | null,
  meta: {
    runId: string | null;
    candidateSource: AiShadowLogCandidateSource | null;
    durationMs: number | null;
    promptVersion: string | null;
    model: string | null;
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
    decision,
    candidateSource: meta.candidateSource,
    candidateKey: meta.runId ? `${meta.runId}:${candidate.ticker}` : null,
    runId: meta.runId,
    durationMs: meta.durationMs,
    promptVersion: meta.promptVersion,
    model: meta.model,
  };
}

/**
 * ADDITIVO (P2): voce unica scritta quando né il body né l'istantanea
 * forniscono candidati. Nessuna chiamata LLM viene effettuata.
 */
export function buildNoCandidateEntry(
  source: 'specialize' | 'desk',
  meta: { promptVersion?: string | null; model?: string | null } = {}
): AiShadowLogEntry {
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
    decision: null,
    candidateSource: 'none',
    candidateKey: null,
    runId: null,
    durationMs: null,
    promptVersion: meta.promptVersion ?? null,
    model: meta.model ?? null,
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
      model: string | null;
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
        model: typeof batch.model === 'string' && batch.model.length > 0 ? batch.model : null,
      });
    }
  }

  return candidates.map((candidate) => {
    const hit = byTicker.get(candidate.ticker);
    const rowMeta = {
      runId,
      candidateSource,
      durationMs: hit?.durationMs ?? null,
      promptVersion: AI_SHADOW_SCAN_PROMPT_VERSION,
      model: hit?.model ?? null,
    };
    if (!hit) {
      return buildEntry(
        candidate,
        source,
        false,
        null,
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
      hit.evaluation.decision,
      null,
      rowMeta
    );
  });
}

/**
 * Esegue la valutazione di tutti i candidati con la LLM fornita dal chiamante.
 * Non lancia mai: un errore di chiamata produce `llm_missing` per il batch.
 */
/**
 * ADDITIVO (P5): la LLM puo' restituire solo il testo (forma storica, usata dai
 * test) oppure testo + modello. Il modello non si deduce dal testo: o lo
 * riporta il chiamante o resta `null`.
 */
export type ScanEvaluationLlmResult =
  | string
  | null
  | { text: string | null; model?: string | null };

export type ScanEvaluationLlmCall = (
  systemInstruction: string,
  userPrompt: string
) => Promise<ScanEvaluationLlmResult>;

async function evaluateSingleBatch(
  index: number,
  batch: ReadonlyArray<ScanCandidateSnapshot>,
  callLlm: ScanEvaluationLlmCall
): Promise<ScanEvaluationBatchResult> {
  const startedAt = performance.now();
  let raw: string | null = null;
  let model: string | null = null;
  try {
    const out = await callLlm(AI_SHADOW_SCAN_SYSTEM_INSTRUCTION, buildScanEvaluationPrompt(batch));
    if (typeof out === 'string' || out === null) {
      raw = out;
    } else if (out && typeof out.text === 'string') {
      raw = out.text;
      model = typeof out.model === 'string' && out.model.length > 0 ? out.model : null;
    }
  } catch {
    raw = null;
  }
  const durationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;

  let status: ScanEvaluationBatchStatus;
  let evaluations: ScanEvaluation[] = [];
  if (raw == null || raw.trim().length === 0) {
    status = 'llm_missing';
    // Nessuna risposta: nessun modello attribuibile, anche se il chiamante lo
    // conosceva per altre chiamate.
    model = null;
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
    model,
  };
}

export async function evaluateScanCandidates(
  candidates: ReadonlyArray<ScanCandidateSnapshot>,
  source: 'specialize' | 'desk',
  callLlm: ScanEvaluationLlmCall,
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
