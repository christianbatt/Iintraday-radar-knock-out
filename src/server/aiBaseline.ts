/**
 * BASELINE DEL DESK AI (Passo 0.1 della roadmap).
 *
 * Fotografia RIPRODUCIBILE di cosa il sistema ha davvero: righe di log AI,
 * segnali emessi, esiti controfattuali, memoria, presenze dei file. Non
 * interpreta, non stima, non riempie buchi: se un file manca lo dichiara
 * `exists: false` e i conteggi restano zero.
 *
 * Perche' esiste: prima di progettare qualunque passo che legga le barre
 * (spread stimato, dataset event-based) bisogna sapere se le barre hanno OHLC e
 * quante sono; prima di parlare di numeri bisogna sapere su quante righe sono
 * calcolati. Questo modulo risponde a quelle domande e nient'altro.
 *
 * Puro rispetto all'I/O: letture e dimensioni arrivano da `AiBaselineIo`, cosi'
 * i test non toccano il disco. Stesso input => stesso output (a parita' di
 * `nowMs`, che il chiamante fornisce).
 */

import fs from 'node:fs';
import path from 'node:path';

export const AI_BASELINE_VERSION = 'ai-baseline@1';

/** Percorsi relativi alla radice del progetto. */
export const AI_BASELINE_PATHS = {
  aiScans: 'shadow_ai_scans.jsonl',
  aiLog: 'shadow_ai_log.jsonl',
  signals: path.join('artifacts', 'shadow_v1_live', 'signals.jsonl'),
  nearMiss: path.join('artifacts', 'shadow_v1_live', 'near_miss.jsonl'),
  rejected: path.join('artifacts', 'shadow_v1_live', 'rejected.jsonl'),
  bars: path.join('artifacts', 'shadow_v1_live', 'bars.json'),
  memory: 'ai_specialization_memory.json',
  shadowV2Summary: path.join('artifacts', 'shadow_v2', 'summary.json'),
} as const;

/** Accesso ai file, iniettabile: i test forniscono una mappa in memoria. */
export interface AiBaselineIo {
  readText(absolutePath: string): string | null;
  sizeBytes(absolutePath: string): number | null;
}

export const defaultAiBaselineIo: AiBaselineIo = {
  readText(absolutePath) {
    try {
      return fs.readFileSync(absolutePath, 'utf8');
    } catch {
      return null;
    }
  },
  sizeBytes(absolutePath) {
    try {
      const stat = fs.statSync(absolutePath);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  },
};

export interface AiBaselineFileFact {
  path: string;
  exists: boolean;
  bytes: number | null;
}

export interface AiBaselineJsonlFact extends AiBaselineFileFact {
  rows: number;
  /** Righe illeggibili: dichiarate, mai ignorate in silenzio. */
  unparsable: number;
  /**
   * Conteggi per campo, solo per i campi richiesti dal chiamante.
   * Convenzione: un valore assente o `null` finisce sotto la chiave `null`,
   * perche' "nessuna decisione" e' un fatto, non un valore da indovinare.
   */
  byField: Record<string, Record<string, number>>;
  /** R finite trovate nel campo indicato (o `null` quando non c'e' campo). */
  meanR: number | null;
  meanRN: number;
}

export interface AiBaselineBarsFact extends AiBaselineFileFact {
  parsed: boolean;
  /**
   * Forma riconosciuta del file:
   * - `array`: lista piatta di barre;
   * - `wrapper-list`: lista (o campo `bars`) di oggetti `{ ticker, bars: [...] }`;
   * - `map-of-arrays`: mappa `ticker -> barre`;
   * - `other`: non riconosciuta (nessun conteggio inventato).
   */
  shape: 'array' | 'wrapper-list' | 'map-of-arrays' | 'other';
  tickers: number;
  bars: number;
  /** Chiavi della prima barra campionata: dice quali campi OHLC esistono. */
  barKeys: string[];
  /** true solo se TUTTE le barre campionate hanno o/h/l/c finiti. */
  hasOhlc: boolean;
  sampledBars: number;
}

export interface AiBaselineMemoryFact extends AiBaselineFileFact {
  parsed: boolean;
  rules: number;
  /** Regole con `confidence` numerica (le uniche scritte dal validatore). */
  validated: number;
  topics: string[];
}

export interface AiBaseline {
  version: typeof AI_BASELINE_VERSION;
  generatedAt: string;
  aiScans: AiBaselineJsonlFact;
  aiLog: AiBaselineJsonlFact;
  signals: AiBaselineJsonlFact;
  nearMiss: AiBaselineJsonlFact;
  rejected: AiBaselineJsonlFact;
  bars: AiBaselineBarsFact;
  memory: AiBaselineMemoryFact;
  shadowV2Summary: AiBaselineFileFact;
  /** Domande a cui la Fase 6 e la Fase 8 devono rispondere prima di partire. */
  availability: {
    barsPresent: boolean;
    barsHaveOhlc: boolean;
    /** Barre disponibili: quante osservazioni per il dataset event-based. */
    barsCount: number;
    /** Righe AI con una decisione chiusa (base della calibrazione). */
    aiDecisions: number;
    /** Esiti forward risolti utilizzabili per un abbinamento. */
    resolvedForward: number;
    /** Regole di memoria scritte dal validatore (non ipotesi a mano). */
    validatedRules: number;
  };
}

function countInto(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function fileFact(
  io: AiBaselineIo,
  rootDir: string,
  relativePath: string
): AiBaselineFileFact & { text: string | null } {
  const absolutePath = path.join(rootDir, relativePath);
  const text = io.readText(absolutePath);
  const bytes = io.sizeBytes(absolutePath);
  return {
    path: relativePath,
    exists: text !== null || bytes !== null,
    bytes,
    text,
  };
}

/** Riga JSONL di un esito: `r` se finito, altrimenti il teorico dichiarato. */
function outcomeR(row: Record<string, unknown>): number | null {
  const direct = row.r;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const theoretical = row.theoreticalRMultiple;
  if (typeof theoretical === 'number' && Number.isFinite(theoretical)) return theoretical;
  return null;
}

function jsonlFact(args: {
  io: AiBaselineIo;
  rootDir: string;
  relativePath: string;
  fields: readonly string[];
  rField?: boolean;
}): AiBaselineJsonlFact {
  const fact = fileFact(args.io, args.rootDir, args.relativePath);
  const byField: Record<string, Record<string, number>> = {};
  for (const field of args.fields) byField[field] = {};
  let rows = 0;
  let unparsable = 0;
  const rValues: number[] = [];

  if (fact.text !== null) {
    for (const line of fact.text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        unparsable += 1;
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        unparsable += 1;
        continue;
      }
      const row = parsed as Record<string, unknown>;
      rows += 1;
      for (const field of args.fields) {
        const raw = row[field];
        const key =
          raw === null || raw === undefined
            ? 'null'
            : typeof raw === 'string'
              ? raw
              : String(raw);
        countInto(byField[field], key);
      }
      if (args.rField === true) {
        const value = outcomeR(row);
        if (value !== null) rValues.push(value);
      }
    }
  }

  return {
    path: fact.path,
    exists: fact.exists,
    bytes: fact.bytes,
    rows,
    unparsable,
    byField,
    meanR:
      rValues.length > 0
        ? Math.round((rValues.reduce((sum, value) => sum + value, 0) / rValues.length) * 1e4) / 1e4
        : null,
    meanRN: rValues.length,
  };
}

/**
 * Estrae le barre senza assumere uno schema unico.
 *
 * Il formato reale di `bars.json` e' una lista di wrapper
 * `{ ticker, market, bars: [...], updatedAt }`: senza srotolare i wrapper si
 * conterebbero 40 involucri invece delle barre, e `tickers` sarebbe un valore
 * costruito a mano. Qui `tickers` conta gli identificativi DAVVERO dichiarati
 * (0 se il file non li dichiara) e `bars` sono solo le barre srotolate.
 */
function collectBars(list: readonly unknown[]): {
  bars: Record<string, unknown>[];
  tickers: Set<string>;
  wrappers: number;
} {
  const bars: Record<string, unknown>[] = [];
  const tickers = new Set<string>();
  let wrappers = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (Array.isArray(record.bars)) {
      wrappers += 1;
      if (typeof record.ticker === 'string' && record.ticker.trim().length > 0) {
        tickers.add(record.ticker.trim());
      }
      for (const row of record.bars) {
        if (row && typeof row === 'object') bars.push(row as Record<string, unknown>);
      }
      continue;
    }
    bars.push(record);
  }
  return { bars, tickers, wrappers };
}

function extractBars(parsed: unknown): {
  shape: AiBaselineBarsFact['shape'];
  tickers: number;
  bars: Record<string, unknown>[];
} {
  if (Array.isArray(parsed)) {
    const collected = collectBars(parsed);
    return {
      shape: collected.wrappers > 0 ? 'wrapper-list' : 'array',
      tickers: collected.tickers.size,
      bars: collected.bars,
    };
  }
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.bars)) {
      const collected = collectBars(record.bars);
      return {
        shape: collected.wrappers > 0 ? 'wrapper-list' : 'array',
        tickers: collected.tickers.size,
        bars: collected.bars,
      };
    }
    const arrayKeys = Object.keys(record).filter((key) => Array.isArray(record[key]));
    if (arrayKeys.length > 0) {
      // Anche qui i wrapper vanno srotolati: una mappa verso liste di wrapper
      // non deve contare gli involucri come barre.
      const lists: unknown[] = [];
      for (const key of arrayKeys) lists.push(...(record[key] as unknown[]));
      const collected = collectBars(lists);
      return {
        shape: collected.wrappers > 0 ? 'wrapper-list' : 'map-of-arrays',
        tickers:
          collected.tickers.size > 0 ? collected.tickers.size : arrayKeys.length,
        bars: collected.bars,
      };
    }
  }
  return { shape: 'other', tickers: 0, bars: [] };
}

const OHLC_KEYS = ['o', 'h', 'l', 'c'] as const;
const MAX_SAMPLED_BARS = 200;

function barsFact(io: AiBaselineIo, rootDir: string): AiBaselineBarsFact {
  const fact = fileFact(io, rootDir, AI_BASELINE_PATHS.bars);
  const empty: AiBaselineBarsFact = {
    path: fact.path,
    exists: fact.exists,
    bytes: fact.bytes,
    parsed: false,
    shape: 'other',
    tickers: 0,
    bars: 0,
    barKeys: [],
    hasOhlc: false,
    sampledBars: 0,
  };
  if (fact.text === null) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fact.text);
  } catch {
    return empty;
  }
  const extracted = extractBars(parsed);
  const sampled = extracted.bars.slice(0, MAX_SAMPLED_BARS);
  const hasOhlc =
    sampled.length > 0 &&
    sampled.every((bar) =>
      OHLC_KEYS.every((key) => typeof bar[key] === 'number' && Number.isFinite(bar[key] as number))
    );
  return {
    path: fact.path,
    exists: fact.exists,
    bytes: fact.bytes,
    parsed: true,
    shape: extracted.shape,
    tickers: extracted.tickers,
    bars: extracted.bars.length,
    barKeys: sampled.length > 0 ? Object.keys(sampled[0]).sort() : [],
    hasOhlc,
    sampledBars: sampled.length,
  };
}

function memoryFact(io: AiBaselineIo, rootDir: string): AiBaselineMemoryFact {
  const fact = fileFact(io, rootDir, AI_BASELINE_PATHS.memory);
  const empty: AiBaselineMemoryFact = {
    path: fact.path,
    exists: fact.exists,
    bytes: fact.bytes,
    parsed: false,
    rules: 0,
    validated: 0,
    topics: [],
  };
  if (fact.text === null) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fact.text);
  } catch {
    return empty;
  }
  if (!Array.isArray(parsed)) return empty;
  const rules = parsed.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
  return {
    path: fact.path,
    exists: fact.exists,
    bytes: fact.bytes,
    parsed: true,
    rules: rules.length,
    validated: rules.filter(
      (rule) => typeof rule.confidence === 'number' && Number.isFinite(rule.confidence)
    ).length,
    topics: rules
      .map((rule) => (typeof rule.topic === 'string' ? rule.topic : null))
      .filter((topic): topic is string => topic !== null),
  };
}

/**
 * Costruisce la fotografia. Non lancia: file assenti, JSON rotto e righe
 * illeggibili diventano fatti dichiarati (`exists: false`, `parsed: false`,
 * `unparsable: n`).
 */
export function buildAiBaseline(args: {
  rootDir: string;
  nowMs: number;
  io?: AiBaselineIo;
}): AiBaseline {
  const io = args.io ?? defaultAiBaselineIo;
  const rootDir = args.rootDir;

  const aiScans = jsonlFact({
    io,
    rootDir,
    relativePath: AI_BASELINE_PATHS.aiScans,
    fields: ['source', 'evaluated', 'decision', 'discardReason'],
  });
  const aiLog = jsonlFact({
    io,
    rootDir,
    relativePath: AI_BASELINE_PATHS.aiLog,
    fields: ['source', 'evaluated', 'decision'],
  });
  const signals = jsonlFact({
    io,
    rootDir,
    relativePath: AI_BASELINE_PATHS.signals,
    fields: ['status', 'market', 'direction'],
    rField: true,
  });
  const nearMiss = jsonlFact({
    io,
    rootDir,
    relativePath: AI_BASELINE_PATHS.nearMiss,
    fields: ['status', 'nearMissGate'],
    rField: true,
  });
  const rejected = jsonlFact({
    io,
    rootDir,
    relativePath: AI_BASELINE_PATHS.rejected,
    fields: ['status', 'primaryGate'],
    rField: true,
  });
  const bars = barsFact(io, rootDir);
  const memory = memoryFact(io, rootDir);
  const summary = fileFact(io, rootDir, AI_BASELINE_PATHS.shadowV2Summary);

  const aiDecisions =
    (aiScans.byField.decision
      ? Object.entries(aiScans.byField.decision).reduce(
          (total, [key, count]) => (key === 'null' ? total : total + count),
          0
        )
      : 0) +
    (aiLog.byField.decision
      ? Object.entries(aiLog.byField.decision).reduce(
          (total, [key, count]) => (key === 'null' ? total : total + count),
          0
        )
      : 0);

  const resolved = (fact: AiBaselineJsonlFact): number =>
    ['STOP', 'TARGET', 'EXPIRED'].reduce(
      (total, status) => total + (fact.byField.status?.[status] ?? 0),
      0
    );

  return {
    version: AI_BASELINE_VERSION,
    generatedAt: new Date(args.nowMs).toISOString(),
    aiScans,
    aiLog,
    signals,
    nearMiss,
    rejected,
    bars,
    memory,
    shadowV2Summary: {
      path: summary.path,
      exists: summary.exists,
      bytes: summary.bytes,
    },
    availability: {
      barsPresent: bars.bars > 0,
      barsHaveOhlc: bars.hasOhlc,
      barsCount: bars.bars,
      aiDecisions,
      resolvedForward: resolved(signals) + resolved(nearMiss) + resolved(rejected),
      validatedRules: memory.validated,
    },
  };
}
