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

export type AiShadowLogSource = 'specialize' | 'desk';

export type AiShadowLogStatus = 'NON_VALIDATO';

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
export const AI_SHADOW_LOG_DEFAULT_LIMIT = 50;
export const AI_SHADOW_LOG_MAX_LIMIT = 200;

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
    const source: AiShadowLogSource = r.source === 'desk' ? 'desk' : 'specialize';

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
    });
  }
  return out;
}

function resolveLogPath(filePath?: string): string {
  const target = filePath && filePath.length > 0 ? filePath : AI_SHADOW_LOG_RELATIVE_PATH;
  return path.isAbsolute(target) ? target : path.join(process.cwd(), target);
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
    const lines = normalized.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(resolvedPath, lines, 'utf8');
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

/** Corpo di `GET /api/shadow/ai-log`: sola lettura, nessuna eccezione. */
export function buildAiShadowLogResponse(
  rawLimit?: unknown,
  filePath?: string
): AiShadowLogResponse {
  const limit = clampAiShadowLogLimit(rawLimit);
  const all = readAiShadowLog(undefined, filePath);
  const entries = all.slice(-limit);
  const byStatus: Record<string, number> = {};
  const byDiscarded: Record<string, number> = { true: 0, false: 0 };
  const byEvaluated: Record<string, number> = { true: 0, false: 0 };
  for (const e of entries) {
    byStatus[String(e.status)] = (byStatus[String(e.status)] || 0) + 1;
    byDiscarded[String(e.discarded)] = (byDiscarded[String(e.discarded)] || 0) + 1;
    byEvaluated[String(e.evaluated)] = (byEvaluated[String(e.evaluated)] || 0) + 1;
  }
  return { entries, count: entries.length, total: all.length, limit, byStatus, byDiscarded, byEvaluated };
}
