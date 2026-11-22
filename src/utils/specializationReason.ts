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
