/**
 * Log shadow delle valutazioni AI (Fase 1).
 *
 * Ogni valutazione prodotta dagli endpoint AI (`/api/ai/specialize`,
 * `/api/ai/desk-post-mortem`) viene registrata come osservazione shadow con
 * `status: "NON_VALIDATO"` e `outcome: null`. Questo flusso non tocca mai
 * memoria persistente AI e non entra nella selezione dei top setup.
 *
 * Formato: JSONL, un record per riga. Scrittura append atomica best-effort:
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
  aiOutcome: string;
  aiCategory: string;
  source: AiShadowLogSource;
  status: AiShadowLogStatus;
  outcome: null;
  discarded: boolean;
  discardReason: string | null;
}

export const AI_SHADOW_LOG_RELATIVE_PATH = 'shadow_ai_log.jsonl';

export interface AiShadowLogWriteResult {
  ok: boolean;
  error?: string;
  written?: number;
}

function normalizeEntries(input: unknown): AiShadowLogEntry[] {
  const arr = Array.isArray(input) ? input : [input];
  const out: AiShadowLogEntry[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;

    // Entry gia' normalizzata (oggetto con aiOutcome): accettata as-is.
    if (typeof r.aiOutcome === 'string') {
      out.push({
        id: typeof r.id === 'string' ? r.id : randomUUID(),
        timestamp: typeof r.timestamp === 'string' ? r.timestamp : new Date().toISOString(),
        ticker: r.ticker == null ? null : String(r.ticker),
        market: typeof r.market === 'string' ? r.market : 'GLOBAL',
        direction: r.direction == null ? null : String(r.direction),
        setup: r.setup == null ? null : String(r.setup),
        aiOutcome: String(r.aiOutcome),
        aiCategory: typeof r.aiCategory === 'string' ? r.aiCategory : 'unknown',
        source: r.source === 'desk' ? 'desk' : 'specialize',
        status: 'NON_VALIDATO',
        outcome: null,
        discarded: typeof r.discarded === 'boolean' ? r.discarded : false,
        discardReason: r.discardReason == null ? null : String(r.discardReason),
      });
      continue;
    }

    // Proposta LLM (newDirective): calcola discarded in base alla shape.
    const hasTopic = typeof r.topic === 'string';
    const hasDirective = typeof r.directive === 'string';
    const discarded = !(hasTopic && hasDirective);
    let discardReason: string | null = null;
    if (discarded) {
      const reasons: string[] = [];
      if (!hasTopic) reasons.push('missing topic');
      if (!hasDirective) reasons.push('missing directive');
      discardReason = `shape: ${reasons.join(' and ')}`;
    }

    const directive = r.directive ?? r.aiOutcome ?? r.outcome ?? '';
    const category = r.predicateId ?? r.topic ?? r.aiCategory ?? 'unknown';
    const setup = r.topic ?? r.setup ?? null;
    const market = typeof r.market === 'string' ? r.market : 'GLOBAL';

    out.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ticker: r.ticker == null ? null : String(r.ticker),
      market,
      direction: r.direction == null ? null : String(r.direction),
      setup: setup == null ? null : String(setup),
      aiOutcome: String(directive),
      aiCategory: String(category),
      source: r.source === 'desk' ? 'desk' : 'specialize',
      status: 'NON_VALIDATO',
      outcome: null,
      discarded,
      discardReason,
    });
  }
  return out;
}

export function appendAiShadowLog(
  entries: unknown,
  filePath: string = AI_SHADOW_LOG_RELATIVE_PATH
): AiShadowLogWriteResult {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

  const normalized = normalizeEntries(entries);
  if (normalized.length === 0) {
    return { ok: true, written: 0 };
  }

  try {
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });
    const lines = normalized.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(resolvedPath, lines, 'utf8');
    return { ok: true, written: normalized.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, written: 0 };
  }
}

export function readAiShadowLog(
  limit?: number,
  filePath: string = AI_SHADOW_LOG_RELATIVE_PATH
): AiShadowLogEntry[] {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
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