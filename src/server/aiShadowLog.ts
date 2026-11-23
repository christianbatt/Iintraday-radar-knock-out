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
}

export const AI_SHADOW_LOG_RELATIVE_PATH = 'artifacts/ai_shadow_log.jsonl';

export interface AiShadowLogWriteResult {
  ok: boolean;
  error?: string;
  written?: number;
}

/**
 * Normalizza l'input in una lista di entry. Accetta:
 *  - un singolo oggetto entry
 *  - un array di entry
 *  - un array di oggetti "proposta" (newDirective) che vengono mappati
 */
function normalizeEntries(input: unknown): AiShadowLogEntry[] {
  const arr = Array.isArray(input) ? input : [input];
  const out: AiShadowLogEntry[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    // Se e' gia' una entry completa, la accettiamo (con default difensivi).
    if (typeof r.status === 'string' && r.status === 'NON_VALIDATO' && typeof r.aiOutcome === 'string') {
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
      });
      continue;
    }
    // Altrimenti interpretiamo come proposta LLM (newDirective).
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
    });
  }
  return out;
}

/**
 * Append-only best-effort. Non lancia mai. Accetta firme flessibili:
 *   appendAiShadowLog(filePath, entries)
 *   appendAiShadowLog(entries, filePath?)
 *   appendAiShadowLog(entries)  (path di default)
 */
export function appendAiShadowLog(
  first: string | unknown | unknown[],
  second?: unknown,
  third?: string
): AiShadowLogWriteResult {
  let filePath: string;
  let entriesInput: unknown;
  if (typeof first === 'string') {
    filePath = first;
    entriesInput = second;
  } else if (Array.isArray(first)) {
    entriesInput = first;
    filePath = typeof second === 'string' ? second : (typeof third === 'string' ? third : AI_SHADOW_LOG_RELATIVE_PATH);
  } else if (first && typeof first === 'object') {
    // potrebbe essere una singola entry o { filePath, entries }
    const obj = first as Record<string, unknown>;
    if (Array.isArray(obj.entries)) {
      entriesInput = obj.entries;
      filePath = typeof obj.filePath === 'string' ? obj.filePath : (typeof second === 'string' ? second : AI_SHADOW_LOG_RELATIVE_PATH);
    } else {
      entriesInput = first;
      filePath = typeof second === 'string' ? second : AI_SHADOW_LOG_RELATIVE_PATH;
    }
  } else {
    filePath = AI_SHADOW_LOG_RELATIVE_PATH;
    entriesInput = first;
  }

  if (!path.isAbsolute(filePath)) {
    filePath = path.join(process.cwd(), filePath);
  }

  const entries = normalizeEntries(entriesInput);
  if (entries.length === 0) {
    return { ok: true, written: 0 };
  }

  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(filePath, lines, 'utf8');
    return { ok: true, written: entries.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, written: 0 };
  }
}

/** Alias per compatibilita'. */
export const appendAiShadowLogEntries = appendAiShadowLog;
export const appendAiShadowObservation = (entry: unknown, filePath?: string) =>
  appendAiShadowLog(filePath ?? AI_SHADOW_LOG_RELATIVE_PATH, entry);
export const logAiShadowObservation = appendAiShadowObservation;

export function readAiShadowLog(filePath: string = AI_SHADOW_LOG_RELATIVE_PATH): AiShadowLogEntry[] {
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
    return out;
  } catch {
    return [];
  }
}

/** Alias per compatibilita'. */
export const loadAiShadowLog = readAiShadowLog;
export const readAiShadowObservations = readAiShadowLog;
