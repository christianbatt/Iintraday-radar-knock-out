/**
 * Log shadow delle valutazioni AI (Fase 1).
 *
 * Ogni valutazione prodotta dagli endpoint AI (`/api/ai/specialize`,
 * `/api/ai/desk-post-mortem`) viene registrata come osservazione shadow con
 * `status: "NON_VALIDATO"` e `outcome: null`. Questo flusso non tocca mai
 * memoria persistente AI e non entra nella selezione dei top setup.
 *
 * Formato: JSONL, un record per riga. Scrittura append-only best-effort:
 * un errore di I/O non viene mai propagato al chiamante.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  aiShadowLogEntryDocId,
  isAiShadowLogFirestoreEnabled,
  readAiShadowLogFromFirestore,
  syncAiShadowLogToFirestore,
  type AiShadowLogFirestoreReadItem,
} from './aiShadowLogFirestore';

export type AiShadowLogSource = 'scan' | 'specialize' | 'desk';

export type AiShadowLogStatus = 'NON_VALIDATO';

/**
 * Decisione CHIUSA del desk su un candidato, scritta dall'handler che riceve la
 * risposta della LLM. Tre soli valori ammessi: nessuna euristica sul testo, e
 * nessuna classificazione a posteriori nella calibrazione. Le direttive in
 * prosa restano `null`.
 */
export type AiShadowDecision = 'AZIONE' | 'ATTESA' | 'SCARTO';

export const AI_SHADOW_DECISIONS: readonly AiShadowDecision[] = ['AZIONE', 'ATTESA', 'SCARTO'];

/**
 * Unico modo ammesso per riconoscere una decisione: uguaglianza esatta contro
 * l'elenco chiuso. `AI_SHADOW_DECISIONS` e' anche la sorgente usata nel prompt
 * dei batch, cosi' prompt e validatore non possono divergere.
 */
export function isAiShadowDecision(value: unknown): value is AiShadowDecision {
  return (
    typeof value === 'string' && (AI_SHADOW_DECISIONS as readonly string[]).includes(value)
  );
}

/**
 * Origine dei candidati usati dall'handler per la valutazione AI:
 * `body` = campo `scanCandidates` inviato dal client, `snapshot` = istantanea di
 * processo dell'ultima scansione, `none` = nessuna sorgente disponibile.
 */
export type AiShadowLogCandidateSource = 'body' | 'snapshot' | 'none';

export interface AiShadowLogEntry {
  id: string;
  timestamp: string;
  ticker: string | null;
  market: string;
  direction: string | null;
  setup: string | null;
  aiOutcome: string | null;
  aiCategory: string | null;
  source: AiShadowLogSource;
  evaluated: boolean;
  discarded: boolean;
  discardReason: string | null;
  status: AiShadowLogStatus;
  outcome: null;
  /**
   * Decisione chiusa sull'eventuale candidato (`AZIONE`/`ATTESA`/`SCARTO`).
   * `null` per le direttive in prosa e per le righe storiche scritte prima di
   * questo campo: solo la calibrazione, per quelle, usa la classificazione
   * testuale di ripiego.
   */
  decision?: AiShadowDecision | null;
  /** ADDITIVO (P2): origine dei candidati. */
  candidateSource?: AiShadowLogCandidateSource | null;
  /** ADDITIVO (P3): `runId:ticker`, identico fra riga di scansione e riga handler. */
  candidateKey?: string | null;
  /** ADDITIVO (P3): identificativo della scansione. */
  runId?: string | null;
  /** ADDITIVO (P4): durata del batch LLM che ha prodotto la valutazione. */
  durationMs?: number | null;
}

export interface AiShadowLogWriteResult {
  ok: boolean;
  error?: string;
  written?: number;
}

export interface AiShadowLogResponse {
  entries: AiShadowLogEntry[];
  count: number;
  total: number;
  limit: number;
  byStatus: Record<string, number>;
  byDiscarded: Record<string, number>;
  byEvaluated: Record<string, number>;
}

export const AI_SHADOW_LOG_RELATIVE_PATH = 'shadow_ai_log.jsonl';
/** File separato per i snapshot di scansione grezzi (`source: 'scan'`), evitando di ruotare/oscurare le valutazioni AI. */
export const AI_SHADOW_SCAN_LOG_RELATIVE_PATH = 'shadow_ai_scans.jsonl';
export const AI_SHADOW_LOG_DEFAULT_LIMIT = 50;
export const AI_SHADOW_LOG_MAX_LIMIT = 200;
/** Soglia di rotazione: 5 MB. Oltre, il file corrente diventa un archivio. */
export const AI_SHADOW_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Archivi mantenuti: .1 (piu' recente), .2, .3. Il piu' vecchio viene eliminato. */
export const AI_SHADOW_LOG_MAX_ARCHIVES = 3;

/** Motivi di scarto ammessi (stringhe fisse). */
export const AI_SHADOW_DISCARD_REASONS = {
  SCARTATO_DAL_FILTRO: 'SCARTATO_DAL_FILTRO',
  NON_RESTITUITO_DALLA_LLM: 'NON_RESTITUITO_DALLA_LLM',
  NON_INVIATO_ALLA_LLM: 'NON_INVIATO_ALLA_LLM',
  ERRORE_PARSING: 'ERRORE_PARSING',
  LLM_NON_DISPONIBILE: 'LLM_NON_DISPONIBILE',
  /** ADDITIVO (P2): nessuna sorgente di candidati (né body né istantanea). */
  NESSUN_CANDIDATO_DISPONIBILE: 'NESSUN_CANDIDATO_DISPONIBILE',
} as const;

function shapeDiscardReason(hasTopic: boolean, hasDirective: boolean): string {
  const reasons: string[] = [];
  if (!hasTopic) reasons.push('missing topic');
  if (!hasDirective) reasons.push('missing directive');
  return `shape: ${reasons.join(' and ')}`;
}

function normalizeEntries(input: unknown): AiShadowLogEntry[] {
  const arr = Array.isArray(input) ? input : [input];
  const out: AiShadowLogEntry[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;

    const ticker = r.ticker == null ? null : String(r.ticker);
    const market = typeof r.market === 'string' ? r.market : 'GLOBAL';
    const direction = r.direction == null ? null : String(r.direction);
    const source: AiShadowLogSource =
      r.source === 'desk' ? 'desk' : r.source === 'scan' ? 'scan' : 'specialize';

    // Entry gia' normalizzata: contiene la chiave aiOutcome (anche null).
    if ('aiOutcome' in r) {
      const evaluated = typeof r.evaluated === 'boolean' ? r.evaluated : true;
      const discarded = typeof r.discarded === 'boolean' ? r.discarded : false;
      let discardReason: string | null =
        r.discardReason == null ? null : String(r.discardReason);
      if (discardReason === null && (discarded || !evaluated)) {
        discardReason = 'non specificato';
      }
      out.push({
        id: typeof r.id === 'string' ? r.id : randomUUID(),
        timestamp: typeof r.timestamp === 'string' ? r.timestamp : new Date().toISOString(),
        ticker,
        market,
        direction,
        setup: r.setup == null ? null : String(r.setup),
        aiOutcome: typeof r.aiOutcome === 'string' ? r.aiOutcome : null,
        aiCategory: r.aiCategory == null ? null : String(r.aiCategory),
        source,
        evaluated,
        discarded,
        discardReason,
        status: 'NON_VALIDATO',
        outcome: null,
        decision: isAiShadowDecision(r.decision) ? r.decision : null,
        candidateSource:
          r.candidateSource === 'body' ||
          r.candidateSource === 'snapshot' ||
          r.candidateSource === 'none'
            ? r.candidateSource
            : null,
        candidateKey:
          typeof r.candidateKey === 'string' && r.candidateKey.length > 0
            ? r.candidateKey
            : null,
        runId: typeof r.runId === 'string' && r.runId.length > 0 ? r.runId : null,
        durationMs:
          typeof r.durationMs === 'number' && Number.isFinite(r.durationMs)
            ? r.durationMs
            : null,
      });
      continue;
    }

    // Proposta LLM grezza (newDirective): evaluated/discarded dalla shape,
    // salvo valori espliciti passati dal chiamante.
    const hasTopic = typeof r.topic === 'string' && r.topic.length > 0;
    const hasDirective = typeof r.directive === 'string' && r.directive.length > 0;
    const shapeValid = hasTopic && hasDirective;
    const evaluated = typeof r.evaluated === 'boolean' ? r.evaluated : shapeValid;
    const discarded = typeof r.discarded === 'boolean' ? r.discarded : !shapeValid;
    let discardReason: string | null = null;
    if (typeof r.discardReason === 'string' && r.discardReason.length > 0) {
      discardReason = r.discardReason;
    } else if (discarded || !evaluated) {
      discardReason = shapeValid ? 'non specificato' : shapeDiscardReason(hasTopic, hasDirective);
    }

    const directive = r.directive;
    out.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ticker,
      market,
      direction,
      setup: hasTopic ? String(r.topic) : null,
      aiOutcome: typeof directive === 'string' ? directive : null,
      aiCategory:
        typeof r.predicateId === 'string'
          ? r.predicateId
          : hasTopic
            ? String(r.topic)
            : null,
      source,
      evaluated,
      discarded,
      discardReason,
      status: 'NON_VALIDATO',
      outcome: null,
      // Proposta in prosa: nessuna decisione chiusa, mai dedotta dal testo.
      decision: null,
    });
  }
  return out;
}

function resolveLogPath(filePath?: string): string {
  const target = filePath && filePath.length > 0 ? filePath : AI_SHADOW_LOG_RELATIVE_PATH;
  return path.isAbsolute(target) ? target : path.join(process.cwd(), target);
}

/** `shadow_ai_log.jsonl` + indice => `shadow_ai_log.1.jsonl`. */
export function aiShadowLogArchivePath(resolvedPath: string, index: number): string {
  const dir = path.dirname(resolvedPath);
  const ext = path.extname(resolvedPath);
  const base = path.basename(resolvedPath, ext);
  return path.join(dir, `${base}.${index}${ext}`);
}

/**
 * Rotazione a soglia: se il file supera 5 MB diventa `.1`, i precedenti scalano
 * e il `.3` viene eliminato. Best-effort: un errore di rotazione non blocca
 * l'append (il file continua a crescere finche' la rotazione non riesce).
 */
function rotateIfOversized(resolvedPath: string): void {
  try {
    if (!fs.existsSync(resolvedPath)) return;
    if (fs.statSync(resolvedPath).size <= AI_SHADOW_LOG_MAX_BYTES) return;
    const oldest = aiShadowLogArchivePath(resolvedPath, AI_SHADOW_LOG_MAX_ARCHIVES);
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let i = AI_SHADOW_LOG_MAX_ARCHIVES - 1; i >= 1; i--) {
      const from = aiShadowLogArchivePath(resolvedPath, i);
      if (fs.existsSync(from)) fs.renameSync(from, aiShadowLogArchivePath(resolvedPath, i + 1));
    }
    fs.renameSync(resolvedPath, aiShadowLogArchivePath(resolvedPath, 1));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[AI Shadow Log] rotazione non riuscita:', message);
  }
}

/**
 * Candidati della scansione (tutti i titoli, prima di qualunque filtro).
 * L'LLM non li riceve: `evaluated: false` e motivo NON_INVIATO_ALLA_LLM.
 */
export function buildScanCandidateEntries(
  candidates: ReadonlyArray<{
    ticker?: unknown;
    market?: unknown;
    direction?: unknown;
    setup?: unknown;
  }>,
  runId?: string | null
): AiShadowLogEntry[] {
  const normalizedRunId = typeof runId === 'string' && runId.length > 0 ? runId : null;
  return candidates.map((c) => ({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ticker: c.ticker == null ? null : String(c.ticker),
    market: typeof c.market === 'string' && c.market.length > 0 ? c.market : 'GLOBAL',
    direction: c.direction == null ? null : String(c.direction),
    setup: c.setup == null ? null : String(c.setup),
    aiOutcome: null,
    aiCategory: null,
    source: 'scan' as const,
    evaluated: false,
    discarded: false,
    discardReason: AI_SHADOW_DISCARD_REASONS.NON_INVIATO_ALLA_LLM,
    status: 'NON_VALIDATO' as const,
    outcome: null,
    decision: null,
    candidateSource: null,
    candidateKey:
      normalizedRunId && c.ticker != null ? `${normalizedRunId}:${String(c.ticker)}` : null,
    runId: normalizedRunId,
    durationMs: null,
  }));
}

export function isUnprocessedScanEntry(entry: AiShadowLogEntry): boolean {
  return (
    entry.source === 'scan' &&
    entry.evaluated === false &&
    entry.discardReason === AI_SHADOW_DISCARD_REASONS.NON_INVIATO_ALLA_LLM
  );
}

export function appendAiShadowLog(
  entries: unknown,
  filePath?: string
): AiShadowLogWriteResult {
  const resolvedPath = resolveLogPath(filePath);
  const normalized = normalizeEntries(entries);
  if (normalized.length === 0) {
    return { ok: true, written: 0 };
  }

  try {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    rotateIfOversized(resolvedPath);
    const lines = normalized.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(resolvedPath, lines, 'utf8');
    // ADDITIVO (log AI su Firestore): sync subito dopo l'append su file, escludendo i
    // placeholder automatici di scansione per non generare 40 doc/scan ogni 3 minuti.
    const syncEntries = normalized.filter((entry) => !isUnprocessedScanEntry(entry));
    if (syncEntries.length > 0) {
      void syncAiShadowLogToFirestore(syncEntries).catch(() => undefined);
    }
    return { ok: true, written: normalized.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, written: 0 };
  }
}

/**
 * Variante usata dagli handler: non lancia mai e non altera la risposta HTTP.
 * Un errore di I/O produce solo un `console.warn`.
 */
export function safeAppendAiShadowLog(
  entries: unknown,
  filePath?: string
): AiShadowLogWriteResult {
  try {
    const result = appendAiShadowLog(entries, filePath);
    if (!result.ok) {
      console.warn('[AI Shadow Log] scrittura fallita:', result.error ?? 'errore sconosciuto');
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[AI Shadow Log] scrittura eccezione:', message);
    return { ok: false, error: message, written: 0 };
  }
}

export function readAiShadowLog(limit?: number, filePath?: string): AiShadowLogEntry[] {
  const resolved = resolveLogPath(filePath);
  if (!fs.existsSync(resolved)) return [];
  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const out: AiShadowLogEntry[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t) as AiShadowLogEntry;
        if (parsed && typeof parsed === 'object') out.push(parsed);
      } catch {
        // riga illeggibile: si salta
      }
    }
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      return out.slice(-Math.floor(limit));
    }
    return out;
  } catch {
    return [];
  }
}

/** Limite dell'endpoint: default 50, massimo 200, minimo 1; non numerico => default. */
export function clampAiShadowLogLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return AI_SHADOW_LOG_DEFAULT_LIMIT;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return AI_SHADOW_LOG_DEFAULT_LIMIT;
  return Math.min(AI_SHADOW_LOG_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/** Conteggi della risposta: stessa forma per file e per file+Firestore. */
function summarizeAiShadowLogEntries(
  entries: AiShadowLogEntry[],
  total: number,
  limit: number
): AiShadowLogResponse {
  const byStatus: Record<string, number> = {};
  const byDiscarded: Record<string, number> = { true: 0, false: 0 };
  const byEvaluated: Record<string, number> = { true: 0, false: 0 };
  for (const e of entries) {
    byStatus[String(e.status)] = (byStatus[String(e.status)] || 0) + 1;
    byDiscarded[String(e.discarded)] = (byDiscarded[String(e.discarded)] || 0) + 1;
    byEvaluated[String(e.evaluated)] = (byEvaluated[String(e.evaluated)] || 0) + 1;
  }
  return { entries, count: entries.length, total, limit, byStatus, byDiscarded, byEvaluated };
}

export interface AiShadowLogReadOptions {
  /** Se true include anche le righe placeholder `source: 'scan'` non valutate dall'LLM. Default false. */
  includeScan?: boolean;
}

/**
 * Tetto della lettura estesa (calibrazione): piu' alto del clamp HTTP, perche'
 * l'aggregato ha bisogno di tutte le voci recenti, non delle ultime 200.
 */
export const AI_SHADOW_LOG_FALLBACK_MAX_LIMIT = 2000;

export interface AiShadowLogFallbackReadOptions {
  filePath: string;
  /** Default: `AI_SHADOW_LOG_FALLBACK_MAX_LIMIT`. */
  limit?: number;
  includeScan?: boolean;
  env?: Record<string, string | undefined>;
  /** Iniettabile nei test; default: `readAiShadowLogFromFirestore`. */
  readRemote?: (limit: number) => Promise<AiShadowLogFirestoreReadItem[]>;
}

function clampFallbackLimit(raw: number | undefined): number {
  if (!Number.isFinite(raw as number) || (raw as number) <= 0) {
    return AI_SHADOW_LOG_FALLBACK_MAX_LIMIT;
  }
  return Math.min(AI_SHADOW_LOG_FALLBACK_MAX_LIMIT, Math.floor(raw as number));
}

/**
 * Le stesse voci del pannello Shadow AI (file locale + fallback Firestore), con
 * un tetto piu' alto e senza il clamp di `buildAiShadowLogResponseWithFallback`.
 *
 * Serve alla calibrazione: su un disco effimero il file locale puo' essere
 * vuoto, mentre i documenti restano su Firestore. Dedup per doc id, ordine dal
 * piu' vecchio al piu' recente (come `readAiShadowLog`), nessuna scrittura.
 *
 * Il fallback remoto viene interrogato solo se il flag `SHADOW_AI_LOG_FIRESTORE`
 * e' acceso e il file locale non ha gia' raggiunto il limite.
 */
export async function readAiShadowLogWithFallback(
  options: AiShadowLogFallbackReadOptions
): Promise<AiShadowLogEntry[]> {
  const limit = clampFallbackLimit(options.limit);
  const includeScan = options.includeScan === true;
  const merged = new Map<string, { entry: AiShadowLogEntry; atMs: number }>();

  for (const entry of readAiShadowLog(undefined, options.filePath)) {
    if (!includeScan && isUnprocessedScanEntry(entry)) continue;
    const docId = aiShadowLogEntryDocId(entry) ?? entry.id;
    if (merged.has(docId)) continue;
    merged.set(docId, { entry, atMs: Date.parse(entry.timestamp) || 0 });
  }

  const localCount = merged.size;
  const env = options.env ?? process.env;
  if (localCount < limit && isAiShadowLogFirestoreEnabled(env)) {
    const readRemote =
      options.readRemote ?? ((remoteLimit: number) => readAiShadowLogFromFirestore(remoteLimit, { env }));
    let remote: AiShadowLogFirestoreReadItem[] = [];
    try {
      remote = await readRemote(limit);
    } catch (err) {
      // Stessa semantica del pannello: il remoto non disponibile non cancella il
      // file locale, e nessuna eccezione arriva al chiamante.
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[AI Shadow Log] fallback Firestore non disponibile:', message);
      remote = [];
    }
    for (const item of remote) {
      if (merged.has(item.docId)) continue;
      const normalized = normalizeEntries(item.entry)[0];
      if (!normalized) continue;
      if (!includeScan && isUnprocessedScanEntry(normalized)) continue;
      merged.set(item.docId, { entry: normalized, atMs: Date.parse(normalized.timestamp) || 0 });
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, limit)
    .map((item) => item.entry)
    .reverse();
}

/** Corpo di `GET /api/shadow/ai-log`: sola lettura, nessuna eccezione. */
export function buildAiShadowLogResponse(
  rawLimit?: unknown,
  filePath?: string,
  options: AiShadowLogReadOptions = {}
): AiShadowLogResponse {
  const limit = clampAiShadowLogLimit(rawLimit);
  const rawAll = readAiShadowLog(undefined, filePath);
  const all = options.includeScan === true ? rawAll : rawAll.filter((e) => !isUnprocessedScanEntry(e));
  return summarizeAiShadowLogEntries(all.slice(-limit), all.length, limit);
}

/**
 * ADDITIVO (Fase 9): stessa risposta di `buildAiShadowLogResponse`, ma se il
 * file locale restituisce meno di `limit` voci e il flag Firestore e' acceso,
 * unisce le voci lette da Firestore (ordinate per `createdAt` decrescente, con
 * lo stesso `limit`), deduplica per doc id e riapplica il clamp. In errore la
 * lettura remota ritorna `[]`: la risposta resta quella del file.
 *
 * L'array `entries` esce dal piu' vecchio al piu' recente, come nel percorso
 * solo-file (`readAiShadowLog` + `slice(-limit)`): la forma e l'ordine della
 * risposta non cambiano.
 */
export async function buildAiShadowLogResponseWithFallback(
  rawLimit?: unknown,
  filePath?: string,
  options: AiShadowLogReadOptions = {}
): Promise<AiShadowLogResponse> {
  const base = buildAiShadowLogResponse(rawLimit, filePath, options);
  if (base.count >= base.limit) return base;
  if (!isAiShadowLogFirestoreEnabled()) return base;

  const remote = await readAiShadowLogFromFirestore(base.limit);
  if (remote.length === 0) return base;

  const includeScan = options.includeScan === true;
  const merged = new Map<string, { entry: AiShadowLogEntry; atMs: number }>();
  for (const entry of readAiShadowLog(undefined, filePath)) {
    if (!includeScan && isUnprocessedScanEntry(entry)) continue;
    const docId = aiShadowLogEntryDocId(entry) ?? entry.id;
    if (merged.has(docId)) continue;
    merged.set(docId, { entry, atMs: Date.parse(entry.timestamp) || 0 });
  }
  for (const item of remote) {
    if (merged.has(item.docId)) continue;
    // Stessa normalizzazione usata per il file: nessun cast sul documento letto.
    const normalized = normalizeEntries(item.entry)[0];
    if (!normalized) continue;
    if (!includeScan && isUnprocessedScanEntry(normalized)) continue;
    merged.set(item.docId, { entry: normalized, atMs: Date.parse(normalized.timestamp) || 0 });
  }

  const ordered = Array.from(merged.values()).sort((a, b) => b.atMs - a.atMs);
  const entries = ordered
    .slice(0, base.limit)
    .map((item) => item.entry)
    .reverse();
  return summarizeAiShadowLogEntries(entries, merged.size, base.limit);
}
