/**
 * Contratto di ruolo dell'AI di desk (PR-B).
 *
 * L'AI non e' piu' libera di scrivere qualunque prosa: riceve un fascicolo
 * probatorio (`aiEvidencePack`) e deve rispondere con un JSON chiuso in cui
 * OGNI affermazione cita le chiavi del fascicolo che la sostengono. Questo
 * modulo contiene le tre parti pure del contratto:
 *
 * 1. la persona e le regole (testo del prompt);
 * 2. il parser della risposta (JSON, anche dentro code fence);
 * 3. il validatore anti-allucinazione, che scarta cio' che non e' ancorato.
 *
 * Puro: nessun I/O, nessuna LLM, nessun orologio. Non lancia mai.
 *
 * Regola sui numeri (dichiarata, non euristica nascosta): un numero e'
 * "misurato" se ha un separatore decimale oppure un'unita' (`%`, `€`, `R`).
 * Solo i numeri misurati devono comparire fra i valori citati; le etichette
 * (`Target 1`, `G11`, `mark 15`) non vengono validate come misure.
 */

import {
  indexAiEvidence,
  serializeAiEvidencePack,
  AI_EVIDENCE_PACK_VERSION,
  type AiEvidenceEntry,
  type AiEvidencePack,
} from './aiEvidencePack';

export const AI_DESK_CONTRACT_VERSION = 'ai-desk@1';
/** Numero massimo di affermazioni accettate. */
export const AI_DESK_MAX_CLAIMS = 12;
/** Numero massimo di direttive accettate (stesso tetto del flusso di memoria). */
export const AI_DESK_MAX_DIRECTIVES = 3;
/** Riferimenti massimi per singola affermazione. */
export const AI_DESK_MAX_REFS_PER_CLAIM = 4;
/** Lunghezza massima di un'affermazione. */
export const AI_DESK_MAX_STATEMENT_CHARS = 400;
/** Lunghezza massima della sintesi. */
export const AI_DESK_MAX_SUMMARY_CHARS = 1200;
/**
 * Tolleranza nel confronto fra numero citato e valore del fascicolo: 2%
 * relativo con un minimo assoluto di 0.005. Il minimo copre gli arrotondamenti
 * (0.183 vs 0.18), il rapporto relativo impedisce che 0.18 "copra" 0.21.
 */
export const AI_DESK_NUMBER_TOLERANCE = 0.005;
export const AI_DESK_NUMBER_RELATIVE_TOLERANCE = 0.02;

export const AI_DESK_SYSTEM_INSTRUCTION =
  'Sei un senior intraday desk analyst con quindici anni di esperienza su desk proprietari. ' +
  'Analizzi esclusivamente il fascicolo probatorio che ricevi: ogni numero che scrivi deve essere ' +
  'preso da una chiave del fascicolo e deve essere citato. ' +
  'Non prometti rendimenti, non garantisci profitti e non dichiari validita statistica: le tue ' +
  'proposte restano non validate finche un validatore deterministico non le conferma. ' +
  'Se un dato manca, e elencato come insufficiente o non e nel fascicolo, lo dichiari nei dataGaps ' +
  'invece di stimarlo. Rispondi solo con JSON valido conforme allo schema richiesto.';

export interface AiDeskClaim {
  statement: string;
  evidenceRefs: string[];
  /** `true` quando tutte le chiavi citate sono sotto soglia di campione. */
  insufficient: boolean;
}

export interface AiDeskDirective {
  topic: string;
  market: 'EU' | 'US' | 'GLOBAL';
  predicateId: string;
  directive: string;
  evidenceRefs: string[];
}

export type AiDeskRejectionKind = 'claim' | 'directive';

export interface AiDeskRejection {
  kind: AiDeskRejectionKind;
  index: number;
  /** Codice stabile, adatto a un contatore o a un test. */
  code:
    | 'not_an_object'
    | 'empty_statement'
    | 'statement_too_long'
    | 'no_ref'
    | 'unknown_ref'
    | 'unsupported_number'
    | 'invalid_predicate'
    | 'empty_directive'
    | 'invalid_market'
    | 'empty_topic';
  detail: string;
}

export interface AiDeskAnalysis {
  contractVersion: typeof AI_DESK_CONTRACT_VERSION;
  evidencePackVersion: typeof AI_EVIDENCE_PACK_VERSION;
  summary: string;
  /** `true` quando ogni numero misurato nella sintesi esiste nel fascicolo. */
  summaryVerified: boolean;
  /** Chiavi del fascicolo che sostengono i numeri della sintesi. */
  summaryEvidenceRefs: string[];
  /** Numeri della sintesi non riconducibili al fascicolo. */
  summaryUnsupportedNumbers: string[];
  claims: AiDeskClaim[];
  proposedDirectives: AiDeskDirective[];
  dataGaps: string[];
  rejected: AiDeskRejection[];
  /** Chiavi effettivamente citate, ordinate. */
  evidenceKeysUsed: string[];
  /** `true` solo quando nessuna affermazione e' stata scartata. */
  complete: boolean;
  /** `true` quando claim e direttive sono integri E la sintesi e' ancorata. */
  verified: boolean;
}

export type AiDeskParseResult =
  | { ok: true; analysis: AiDeskAnalysis }
  | { ok: false; error: 'empty' | 'invalid_json'; detail: string };

export interface AiDeskPrompt {
  systemInstruction: string;
  userPrompt: string;
  packChars: number;
  truncatedSections: readonly string[];
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const RESPONSE_SCHEMA = [
  '{',
  '  "summary": string,',
  '  "claims": [{ "statement": string, "evidenceRefs": [string] }],',
  '  "proposedDirectives": [{ "topic": string, "market": "EU" | "US" | "GLOBAL",',
  '    "predicateId": string, "directive": string, "evidenceRefs": [string] }],',
  '  "dataGaps": [string]',
  '}',
].join('\n');

/**
 * Costruisce i due testi del prompt. Il fascicolo resta la sola fonte di
 * numeri: le regole sotto lo dicono in modo esplicito e verificabile.
 */
export function buildDeskPrompt(
  pack: AiEvidencePack,
  options: { question?: string; predicateIds?: readonly string[]; maxChars?: number } = {}
): AiDeskPrompt {
  const serialized = serializeAiEvidencePack(pack, { maxChars: options.maxChars });
  const predicateIds = Array.isArray(options.predicateIds) ? options.predicateIds : [];
  const question =
    typeof options.question === 'string' && options.question.trim().length > 0
      ? options.question.trim()
      : 'Valuta la qualita della selezione e indica cosa merita di essere corretto o approfondito.';

  const rules = [
    `- Ogni claim deve avere da 1 a ${AI_DESK_MAX_REFS_PER_CLAIM} evidenceRefs, scelte SOLO fra le chiavi del fascicolo.`,
    '- Un numero con decimali o con %/€/R deve comparire identico (tolleranza 0.05) in almeno un valore citato; se non c e, non scriverlo.',
    '- Se una chiave e elencata in INSUFFICIENT, dichiarala nei dataGaps e non farci una conclusione.',
    '- Al massimo ' + AI_DESK_MAX_CLAIMS + ' claim e ' + AI_DESK_MAX_DIRECTIVES + ' direttive.',
    '- Non scrivere promesse di rendimento, garanzie o confidenza statistica.',
    predicateIds.length > 0
      ? `- predicateId ammessi (enum chiuso): ${predicateIds.join(', ')}.`
      : '- Non inventare predicateId.',
  ].join('\n');

  const userPrompt = [
    'FASCICOLO PROBATORIO (formato: SECTION <nome> <json>; NOTE e INSUFFICIENT in coda):',
    serialized.text,
    '',
    `DOMANDA: ${question}`,
    '',
    'SCHEMA DI RISPOSTA (JSON, nessun testo fuori dal JSON):',
    RESPONSE_SCHEMA,
    '',
    'REGOLE:',
    rules,
  ].join('\n');

  return {
    systemInstruction: AI_DESK_SYSTEM_INSTRUCTION,
    userPrompt,
    packChars: serialized.chars,
    truncatedSections: serialized.truncatedSections,
  };
}

// ---------------------------------------------------------------------------
// Parser e validatore
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Rimuove i code fence e isola il primo oggetto JSON plausibile. */
export function extractJsonObject(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const unfenced = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  if (unfenced.length === 0) return null;
  if (unfenced.startsWith('{')) return unfenced;
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return unfenced.slice(start, end + 1);
}

interface NumericToken {
  value: number;
  measured: boolean;
  text: string;
}

const NUMERIC_TOKEN = /(-?\d+(?:[.,]\d+)?)(\s*)(%|€|R\b)?/g;

/** Estrae i numeri "misurati" (decimali o con unita) dal testo di un claim. */
export function extractMeasuredNumbers(text: string): NumericToken[] {
  const out: NumericToken[] = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  NUMERIC_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMERIC_TOKEN.exec(text)) !== null) {
    const rawNumber = match[1];
    const unit = match[3] ?? null;
    const hasDecimal = rawNumber.includes('.') || rawNumber.includes(',');
    const value = Number(rawNumber.replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    out.push({ value, measured: hasDecimal || unit !== null, text: match[0].trim() });
  }
  return out;
}

function isSupportedNumber(value: number, cited: readonly AiEvidenceEntry[]): boolean {
  const tolerance = Math.max(
    AI_DESK_NUMBER_TOLERANCE,
    AI_DESK_NUMBER_RELATIVE_TOLERANCE * Math.abs(value)
  );
  for (const item of cited) {
    for (const candidate of [item.value, item.n]) {
      if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
      if (Math.abs(candidate - value) <= tolerance) return true;
    }
  }
  return false;
}

function collectRefs(
  raw: unknown,
  index: Map<string, AiEvidenceEntry>,
  rejected: AiDeskRejection[],
  kind: AiDeskRejectionKind,
  position: number
): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const refs: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const key = item.trim();
    if (key.length === 0) continue;
    if (!index.has(key)) {
      rejected.push({ kind, index: position, code: 'unknown_ref', detail: key });
      continue;
    }
    if (refs.length >= AI_DESK_MAX_REFS_PER_CLAIM) continue;
    if (!refs.includes(key)) refs.push(key);
  }
  return refs;
}

/**
 * Verifica dei numeri della sintesi contro l'INTERO fascicolo (la sintesi non ha
 * riferimenti per-claim). Un numero misurato che non esiste nel fascicolo rende
 * la sintesi non verificata: il testo resta, ma il consumatore sa che non e'
 * ancorato.
 */
export function verifyDeskSummary(
  text: string,
  pack: AiEvidencePack
): { text: string; verified: boolean; evidenceRefs: string[]; unsupportedNumbers: string[] } {
  const cleaned = clip(cleanText(text), AI_DESK_MAX_SUMMARY_CHARS);
  const measured = extractMeasuredNumbers(cleaned).filter((token) => token.measured);
  if (measured.length === 0) {
    return { text: cleaned, verified: true, evidenceRefs: [], unsupportedNumbers: [] };
  }
  const refs = new Set<string>();
  const unsupportedNumbers: string[] = [];
  for (const token of measured) {
    const matches = pack.evidence.filter((item) => isSupportedNumber(token.value, [item]));
    if (matches.length === 0) {
      unsupportedNumbers.push(token.text);
      continue;
    }
    for (const match of matches) refs.add(match.key);
  }
  return {
    text: cleaned,
    verified: unsupportedNumbers.length === 0,
    evidenceRefs: [...refs].sort(),
    unsupportedNumbers,
  };
}

function validateClaim(
  raw: unknown,
  position: number,
  index: Map<string, AiEvidenceEntry>,
  rejected: AiDeskRejection[]
): AiDeskClaim | null {
  if (!isRecord(raw)) {
    rejected.push({ kind: 'claim', index: position, code: 'not_an_object', detail: 'claim non oggetto' });
    return null;
  }
  const statement = cleanText(raw.statement);
  if (statement.length === 0) {
    rejected.push({ kind: 'claim', index: position, code: 'empty_statement', detail: 'statement vuoto' });
    return null;
  }
  const refs = collectRefs(raw.evidenceRefs, index, rejected, 'claim', position);
  if (refs.length === 0) {
    rejected.push({ kind: 'claim', index: position, code: 'no_ref', detail: 'nessun riferimento valido' });
    return null;
  }
  const cited = refs.map((key) => index.get(key)).filter((item): item is AiEvidenceEntry => item !== undefined);
  const unsupported = extractMeasuredNumbers(statement).filter(
    (token) => token.measured && !isSupportedNumber(token.value, cited)
  );
  if (unsupported.length > 0) {
    rejected.push({
      kind: 'claim',
      index: position,
      code: 'unsupported_number',
      detail: `${unsupported.map((token) => token.text).join(', ')} non presenti fra i riferimenti citati`,
    });
    return null;
  }
  if (statement.length > AI_DESK_MAX_STATEMENT_CHARS) {
    rejected.push({
      kind: 'claim',
      index: position,
      code: 'statement_too_long',
      detail: `${statement.length} caratteri`,
    });
    return null;
  }
  return {
    statement,
    evidenceRefs: refs,
    insufficient: cited.length > 0 && cited.every((item) => item.insufficient),
  };
}

function validateDirective(
  raw: unknown,
  position: number,
  index: Map<string, AiEvidenceEntry>,
  predicateIds: readonly string[],
  rejected: AiDeskRejection[]
): AiDeskDirective | null {
  if (!isRecord(raw)) {
    rejected.push({ kind: 'directive', index: position, code: 'not_an_object', detail: 'direttiva non oggetto' });
    return null;
  }
  const topic = cleanText(raw.topic);
  if (topic.length === 0) {
    rejected.push({ kind: 'directive', index: position, code: 'empty_topic', detail: 'topic vuoto' });
    return null;
  }
  const directive = cleanText(raw.directive);
  if (directive.length === 0) {
    rejected.push({ kind: 'directive', index: position, code: 'empty_directive', detail: 'directive vuota' });
    return null;
  }
  const market = raw.market === 'EU' || raw.market === 'US' || raw.market === 'GLOBAL' ? raw.market : null;
  if (market === null) {
    rejected.push({ kind: 'directive', index: position, code: 'invalid_market', detail: String(raw.market) });
    return null;
  }
  const predicateId = cleanText(raw.predicateId);
  if (!predicateIds.includes(predicateId)) {
    rejected.push({ kind: 'directive', index: position, code: 'invalid_predicate', detail: predicateId });
    return null;
  }
  const refs = collectRefs(raw.evidenceRefs, index, rejected, 'directive', position);
  if (refs.length === 0) {
    rejected.push({ kind: 'directive', index: position, code: 'no_ref', detail: 'nessun riferimento valido' });
    return null;
  }
  return {
    topic: clip(topic, 80),
    market,
    predicateId,
    directive: clip(directive, AI_DESK_MAX_STATEMENT_CHARS),
    evidenceRefs: refs,
  };
}

/**
 * Valida un oggetto gia' parsato. Restituisce un'analisi con SOLO il contenuto
 * ancorato al fascicolo e l'elenco di cio' che e' stato scartato, con codice
 * stabile: il chiamante puo' contare, loggare e mostrare i rifiuti.
 */
export function validateDeskAnalysis(
  raw: unknown,
  options: { pack: AiEvidencePack; predicateIds: readonly string[] }
): AiDeskAnalysis {
  const index = indexAiEvidence(options.pack);
  const predicateIds = Array.isArray(options.predicateIds) ? options.predicateIds : [];
  const rejected: AiDeskRejection[] = [];
  const record = isRecord(raw) ? raw : {};

  // ADDITIVO: accetta anche la forma storica (`executiveSummary`) cosi' la
  // risposta gia' ottenuta dall'endpoint puo' essere validata senza richiamare
  // la LLM una seconda volta.
  const summarySource = record.summary ?? record.executiveSummary;
  const summaryCheck = verifyDeskSummary(
    typeof summarySource === 'string' ? summarySource : '',
    options.pack
  );

  const claims: AiDeskClaim[] = [];
  const rawClaims = Array.isArray(record.claims) ? record.claims : [];
  for (let position = 0; position < rawClaims.length; position += 1) {
    if (claims.length >= AI_DESK_MAX_CLAIMS) break;
    const claim = validateClaim(rawClaims[position], position, index, rejected);
    if (claim !== null) claims.push(claim);
  }

  const proposedDirectives: AiDeskDirective[] = [];
  // ADDITIVO: le direttive storiche (`newDirectives`) non hanno evidenceRefs,
  // quindi vengono scartate con `no_ref` invece di essere presentate come
  // validate. E' esattamente la distinzione che serve.
  const rawDirectives = Array.isArray(record.proposedDirectives)
    ? record.proposedDirectives
    : Array.isArray(record.newDirectives)
      ? record.newDirectives
      : [];
  for (let position = 0; position < rawDirectives.length; position += 1) {
    if (proposedDirectives.length >= AI_DESK_MAX_DIRECTIVES) break;
    const directive = validateDirective(rawDirectives[position], position, index, predicateIds, rejected);
    if (directive !== null) proposedDirectives.push(directive);
  }

  const dataGaps: string[] = [];
  const rawGaps = Array.isArray(record.dataGaps) ? record.dataGaps : [];
  for (const gap of rawGaps) {
    const cleaned = cleanText(gap);
    if (cleaned.length === 0) continue;
    dataGaps.push(clip(cleaned, 240));
    if (dataGaps.length >= 6) break;
  }

  const used = new Set<string>();
  for (const claim of claims) for (const ref of claim.evidenceRefs) used.add(ref);
  for (const directive of proposedDirectives) for (const ref of directive.evidenceRefs) used.add(ref);

  return {
    contractVersion: AI_DESK_CONTRACT_VERSION,
    evidencePackVersion: AI_EVIDENCE_PACK_VERSION,
    summary: summaryCheck.text,
    summaryVerified: summaryCheck.verified,
    summaryEvidenceRefs: summaryCheck.evidenceRefs,
    summaryUnsupportedNumbers: summaryCheck.unsupportedNumbers,
    claims,
    proposedDirectives,
    dataGaps,
    rejected,
    evidenceKeysUsed: [...used].sort(),
    complete: rejected.length === 0,
    verified: rejected.length === 0 && summaryCheck.verified,
  };
}

/** Parser + validatore: unico ingresso per il testo grezzo della LLM. */
export function parseDeskAnalysis(
  rawText: string,
  options: { pack: AiEvidencePack; predicateIds: readonly string[] }
): AiDeskParseResult {
  const json = extractJsonObject(rawText);
  if (json === null) {
    return { ok: false, error: 'empty', detail: 'nessun oggetto JSON nella risposta' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      error: 'invalid_json',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, analysis: validateDeskAnalysis(parsed, options) };
}
