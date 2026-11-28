/**
 * VALIDAZIONE DELLO SCHEMA PRIMA DEL PARSE (P10 della roadmap).
 *
 * Fino a P10 ogni punto di chiamata faceva `JSON.parse` e poi leggeva i campi
 * che gli servivano: una risposta con la forma sbagliata non era un errore, era
 * una risposta a cui mancavano pezzi. Nel percorso dei batch shadow finiva in
 * `ERRORE_PARSING` (contato, mai prevenuto), nel catalizzatore finiva in
 * "modello assente" e si passava al provider successivo senza dire perche'.
 *
 * Qui lo schema e' **dichiarato** prima del parse: una funzione pura controlla
 * struttura e tipi sul valore gia' decodificato, PRIMA che l'endpoint lo usi, e
 * restituisce un motivo stabile (`json`, `not_object`, `missing:<campo>`,
 * `field:<campo>`). Nessuna coercizione silenziosa: i valori di ripiego restano
 * dove sono, ma ora si sa se la risposta era conforme o no.
 *
 * Lo schema e' volutamente minimo: campi necessari, tipo, enum quando l'insieme
 * dei valori e' chiuso. Non e' un JSON Schema completo e non pretende di
 * esserlo; e' la parte che serve per distinguere "risposta valida" da "risposta
 * che sembrava valida".
 */

export type AiLlmFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface AiLlmFieldSpec {
  type: AiLlmFieldType;
  /** Obbligatorio (default: nessun obbligo). */
  required?: boolean;
  /** Insieme chiuso di valori ammessi per le stringhe. */
  enum?: readonly string[];
  /** Stringa non vuota dopo il trim (default: `false`). */
  nonEmpty?: boolean;
  /** Minimo/massimo per i numeri finiti. */
  min?: number;
  max?: number;
}

export interface AiLlmObjectSchema {
  fields: Record<string, AiLlmFieldSpec>;
  /**
   * Almeno uno dei campi elencati deve essere presente e valido. Serve ai
   * contratti che ammettono due nomi per lo stesso campo (per esempio
   * `executiveSummary` oppure `summary`).
   */
  anyOf?: readonly string[];
}

export type AiLlmSchemaFailure = {
  ok: false;
  reason: string;
};

export type AiLlmSchemaResult =
  | {
      ok: true;
      /**
       * Copia normalizzata dell'oggetto: i campi facoltativi fuori tipo o fuori
       * enum sono stati rimossi, i numeri fuori intervallo sono stati riportati
       * nel bordo. I campi non dichiarati restano com'erano.
       */
      value: Record<string, unknown>;
      /** Campi facoltativi rimossi perche' fuori tipo o fuori enum. */
      dropped: string[];
      /** Campi facoltativi numerici riportati nel bordo dichiarato. */
      clamped: string[];
    }
  | AiLlmSchemaFailure;

function matchesType(value: unknown, type: AiLlmFieldType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return false;
  }
}

/**
 * Controlla un oggetto gia' decodificato contro lo schema dichiarato.
 *
 * REGOLA (P10, revisione): **solo i campi obbligatori possono far fallire la
 * risposta**. Un campo facoltativo con tipo o enum sbagliato viene rimosso
 * (`dropped`), un numero facoltativo fuori intervallo viene riportato nel bordo
 * (`clamped`): il chiamante ricade sui propri valori di ripiego, esattamente
 * come faceva prima di P10 quando il campo mancava. Scartare un'intera risposta
 * per `newsBonusScore: "5"` era una regressione: il resto della valutazione
 * era valido.
 */
export function validateAiLlmObject(value: unknown, schema: AiLlmObjectSchema): AiLlmSchemaResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not_object' };
  }
  const source = value as Record<string, unknown>;
  const record: Record<string, unknown> = { ...source };
  const dropped: string[] = [];
  const clamped: string[] = [];

  const dropOptional = (name: string): void => {
    if (!dropped.includes(name)) dropped.push(name);
    delete record[name];
  };

  for (const [name, spec] of Object.entries(schema.fields)) {
    const present = source[name] !== undefined && source[name] !== null;
    if (!present) {
      if (spec.required) return { ok: false, reason: `missing:${name}` };
      continue;
    }
    const fieldValue = source[name];
    // Un campo che partecipa ad `anyOf` non fa fallire la validazione da solo:
    // decide `anyOf` (es. `executiveSummary` vuoto con `summary` valido e' una
    // risposta usabile, non un errore di schema).
    const inAnyOf = schema.anyOf?.includes(name) ?? false;
    const failOrDrop = (): AiLlmSchemaResult | null => {
      if (spec.required) return { ok: false, reason: `field:${name}` };
      if (!inAnyOf) dropOptional(name);
      return null;
    };

    if (!matchesType(fieldValue, spec.type)) {
      const failed = failOrDrop();
      if (failed) return failed;
      continue;
    }
    if (spec.type === 'string') {
      const text = fieldValue as string;
      if (spec.nonEmpty && text.trim().length === 0) {
        const failed = failOrDrop();
        if (failed) return failed;
        continue;
      }
      if (spec.enum && !spec.enum.includes(text)) {
        const failed = failOrDrop();
        if (failed) return failed;
        continue;
      }
    }
    if (spec.type === 'number') {
      const n = fieldValue as number;
      const boundedLow = typeof spec.min === 'number' && n < spec.min;
      const boundedHigh = typeof spec.max === 'number' && n > spec.max;
      if (boundedLow || boundedHigh) {
        if (spec.required) return { ok: false, reason: `field:${name}` };
        // Normale, non errore: un bonus 16 su un tetto 15 vale 15, non getta
        // via la valutazione. Un campo in `anyOf` si risolve dopo, insieme
        // all'alternativa.
        if (!inAnyOf) {
          record[name] = boundedLow ? spec.min : spec.max;
          if (!clamped.includes(name)) clamped.push(name);
        }
      }
    }
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    const usable = schema.anyOf.filter((name) => anyOfFieldUsable(source[name], schema.fields[name]));
    if (usable.length === 0) return { ok: false, reason: 'any_of' };
    // Un campo `anyOf` invalido NON resta nel valore normalizzato: se resta, il
    // chiamante lo usa al posto dell'alternativa valida (prima un
    // `executiveSummary` oggetto vinceva su un `summary` stringa corretto,
    // perche' "truthy"). Si rimuovono solo gli invalidi: quelli usabili restano.
    for (const name of schema.anyOf) {
      if (!usable.includes(name)) dropOptional(name);
    }
  }
  return { ok: true, value: record, dropped, clamped };
}

/**
 * Un campo che partecipa ad `anyOf` e' usabile quando esiste, ha il tipo
 * dichiarato e (per le stringhe) non e' vuoto. Stessa regola usata per decidere
 * se l'`anyOf` e' soddisfatto e per decidere cosa rimuovere.
 */
function anyOfFieldUsable(value: unknown, spec: AiLlmFieldSpec | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (!spec) return true;
  if (!matchesType(value, spec.type)) return false;
  if (spec.type === 'string' && spec.nonEmpty && (value as string).trim().length === 0) {
    return false;
  }
  return true;
}

/** Toglie i recinti di codice attorno al JSON, come fanno i chiamanti esistenti. */
export function stripAiLlmCodeFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/**
 * Decodifica e valida in un solo passaggio. `reason: 'json'` = non e' JSON;
 * qualunque altro motivo viene dallo schema.
 */
export function parseAiLlmJson(raw: string, schema: AiLlmObjectSchema): AiLlmSchemaResult {
  const cleaned = stripAiLlmCodeFences(raw);
  if (cleaned.length === 0) return { ok: false, reason: 'json' };
  let decoded: unknown;
  try {
    decoded = JSON.parse(cleaned);
  } catch {
    return { ok: false, reason: 'json' };
  }
  return validateAiLlmObject(decoded, schema);
}

/** Schema dichiarati per gli endpoint. I campi non elencati non vengono toccati. */
export const AI_LLM_SCHEMAS: Record<string, AiLlmObjectSchema> = {
  'ai-catalyst': {
    fields: {
      decisione: { type: 'string', required: true, enum: ['TRADE', 'NESSUN_TRADE'] },
      direzione: { type: 'string', enum: ['LONG', 'SHORT', 'NESSUNA'] },
      catalizzatore: { type: 'string' },
      punti_a_favore: { type: 'array' },
      rischi: { type: 'array' },
      condizioni_invalidazione: { type: 'array' },
      fonti: { type: 'array' },
      newsBonusScore: { type: 'number', min: 0, max: 15 },
      confidenza: { type: 'number', min: 0, max: 100 },
    },
  },
  'ai-specialize': {
    fields: {
      newDirectives: { type: 'array', required: true },
    },
  },
  'ai-desk-post-mortem': {
    fields: {
      executiveSummary: { type: 'string', nonEmpty: true },
      summary: { type: 'string', nonEmpty: true },
      newDirectives: { type: 'array' },
    },
    anyOf: ['executiveSummary', 'summary'],
  },
  'ai-scan-batch': {
    fields: {
      scanEvaluations: { type: 'array', required: true },
    },
  },
};

/**
 * Validazione della singola riga di `scanEvaluations`.
 *
 * `ticker` e `aiOutcome` sono obbligatori e non vuoti: senza di loro la riga
 * non identifica un candidato e viene scartata (comportamento storico).
 * `decision` invece e' **leniente**: un valore fuori dall'enum diventa `null`
 * invece di far scartare la riga, perche' l'esito resta informativo e la
 * calibrazione non deve ricevere un quarto valore. La differenza con prima e'
 * che ora il caso e' dichiarato e coperto da un test, non implicito.
 */
export function validateScanEvaluationRow(
  row: unknown,
  decisions: readonly string[]
): { ok: true; ticker: string; aiOutcome: string; aiCategory: string | null; decision: string | null } | { ok: false; reason: string } {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return { ok: false, reason: 'not_object' };
  }
  const record = row as Record<string, unknown>;
  const ticker = typeof record.ticker === 'string' ? record.ticker.trim() : '';
  if (ticker.length === 0) return { ok: false, reason: 'field:ticker' };
  const aiOutcome = typeof record.aiOutcome === 'string' ? record.aiOutcome.trim() : '';
  if (aiOutcome.length === 0) return { ok: false, reason: 'field:aiOutcome' };
  const aiCategory =
    typeof record.aiCategory === 'string' && record.aiCategory.trim().length > 0
      ? record.aiCategory.trim()
      : null;
  const rawDecision = record.decision;
  const decision =
    typeof rawDecision === 'string' && decisions.includes(rawDecision) ? rawDecision : null;
  return { ok: true, ticker, aiOutcome, aiCategory, decision };
}
