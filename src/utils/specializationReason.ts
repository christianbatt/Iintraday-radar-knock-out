/**
 * ADDITIVO (R1 v5): classificazione esplicita del ramo di /api/ai/specialize.
 * Funzione pura, usata dal handler reale e dai test. Non applica i gate statistici:
 * quelli restano in learningValidator/updateAIMemory.
 */
export interface SpecializationReasonInput {
  hasOpenRouterKey: boolean;
  geminiAvailable: boolean;
  llmErrorDetail: string | null;
  proposedDirectivesCount: number;
  decisiveSample: number;
  minSample: number;
  /**
   * v7 (Parte 3.3): validateLearningPattern NON filtra i trade per topic.
   * Finché il filtro per topic non esiste, l'handler non può persistere regole
   * da un topic LLM: il ramo esplicito TOPIC_NON_FILTRATO lo dichiara.
   */
  topicFilterSupported?: boolean;
}

export interface SpecializationReasonResult {
  /** CHIAVE_ASSENTE | LLM_ERRORE | LLM_VUOTA | CAMPIONE_INSUFFICIENTE | SAMPLE_OK */
  reason: string;
  reasonDetail: string;
}

export function resolveSpecializationReason(
  input: SpecializationReasonInput
): SpecializationReasonResult {
  if (!input.hasOpenRouterKey && !input.geminiAvailable) {
    return {
      reason: 'CHIAVE_ASSENTE',
      reasonDetail: 'Nessuna chiave OPENROUTER_API_KEY e Gemini non disponibile.',
    };
  }
  if (input.llmErrorDetail) {
    return { reason: 'LLM_ERRORE', reasonDetail: input.llmErrorDetail };
  }
  if (input.proposedDirectivesCount === 0) {
    return {
      reason: 'LLM_VUOTA',
      reasonDetail: 'La LLM non ha restituito direttive valide.',
    };
  }
  if (input.decisiveSample < input.minSample) {
    return {
      reason: 'CAMPIONE_INSUFFICIENTE',
      reasonDetail: `${input.decisiveSample}/${input.minSample} trade chiusi decisivi (WIN/LOSS).`,
    };
  }
  if (input.topicFilterSupported !== true) {
    return {
      reason: 'TOPIC_NON_FILTRATO',
      reasonDetail:
        'validateLearningPattern non filtra i trade per topic: scrittura dall\'handler disabilitata.',
    };
  }
  return { reason: 'SAMPLE_OK', reasonDetail: '' };
}

/**
 * ADDITIVO (v9, Parte 5.1): enum CHIUSO delle reason emesse dall'handler e dal desk.
 * TOPIC_NON_FILTRATO non fa parte di questo enum: non viene più emesso.
 */
export const SPECIALIZATION_REASONS = {
  CHIAVE_ASSENTE: 'CHIAVE_ASSENTE',
  LLM_ERRORE: 'LLM_ERRORE',
  LLM_VUOTA: 'LLM_VUOTA',
  PREDICATO_NON_VALIDO: 'PREDICATO_NON_VALIDO',
  CAMPIONE_INSUFFICIENTE: 'CAMPIONE_INSUFFICIENTE',
  GATE_NON_SUPERATI: 'GATE_NON_SUPERATI',
  OK_SCRITTO: 'OK_SCRITTO',
} as const;

export type SpecializationReasonId = keyof typeof SPECIALIZATION_REASONS;

export interface SpecializationOutcomeInput {
  hasOpenRouterKey: boolean;
  geminiAvailable: boolean;
  llmErrorDetail: string | null;
  /** Direttive con predicateId dentro l'enum. */
  validDirectivesCount: number;
  /** Direttive scartate: predicateId assente o fuori enum. */
  discardedCount: number;
  /** Trade decisivi del miglior predicato valido (0 se nessun predicato). */
  decisiveSample: number;
  minSample: number;
  /** Regole effettivamente scritte in memoria da updateAIMemory. */
  writtenCount: number;
  /** Dettaglio dei gate per GATE_NON_SUPERATI. */
  gateDetail?: string;
}

export interface SpecializationOutcome {
  reason: SpecializationReasonId;
  reasonDetail: string;
}

/**
 * ADDITIVO (v9, Parte 5.1): unico resolver condiviso da /api/ai/specialize e
 * /api/ai/desk-post-mortem. Ogni reason ha il proprio reasonDetail.
 */
export function resolveSpecializationOutcome(
  input: SpecializationOutcomeInput
): SpecializationOutcome {
  if (!input.hasOpenRouterKey && !input.geminiAvailable) {
    return {
      reason: 'CHIAVE_ASSENTE',
      reasonDetail: 'Nessuna chiave OPENROUTER_API_KEY e Gemini non disponibile.',
    };
  }
  if (input.llmErrorDetail) {
    return { reason: 'LLM_ERRORE', reasonDetail: input.llmErrorDetail };
  }
  if (input.validDirectivesCount === 0) {
    if (input.discardedCount > 0) {
      return {
        reason: 'PREDICATO_NON_VALIDO',
        reasonDetail:
          `${input.discardedCount}/${input.discardedCount + input.validDirectivesCount} direttive scartate: ` +
          'predicateId assente o fuori enum.',
      };
    }
    return {
      reason: 'LLM_VUOTA',
      reasonDetail: 'La LLM non ha restituito direttive valide.',
    };
  }
  if (input.decisiveSample < input.minSample) {
    return {
      reason: 'CAMPIONE_INSUFFICIENTE',
      reasonDetail:
        `${input.decisiveSample}/${input.minSample} trade chiusi decisivi (WIN/LOSS) per il miglior predicato.`,
    };
  }
  if (input.writtenCount > 0) {
    return {
      reason: 'OK_SCRITTO',
      reasonDetail: `${input.writtenCount} regola/e scritte in memoria dopo i gate statistici.`,
    };
  }
  return {
    reason: 'GATE_NON_SUPERATI',
    reasonDetail: input.gateDetail || 'Gate statistici non superati (n, q BH, avgR, profitFactor).',
  };
}
