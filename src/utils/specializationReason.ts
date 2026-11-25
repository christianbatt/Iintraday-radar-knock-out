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
  /** ADDITIVO (v10): direttive testuali restituite dalla LLM (per distinguere LLM_VUOTA). */
  llmDirectiveCount?: number;
  /** ADDITIVO (v10): predicati con campione >= minSample (per distinguere CAMPIONE_INSUFFICIENTE). */
  testedCount?: number;
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
  if (input.validDirectivesCount === 0 && input.discardedCount > 0) {
    // Legacy v9: non emesso dal flusso v10 (gli handler passano discardedCount = 0).
    return {
      reason: 'PREDICATO_NON_VALIDO',
      reasonDetail:
        `${input.discardedCount}/${input.discardedCount + input.validDirectivesCount} direttive scartate: ` +
        'predicateId assente o fuori enum.',
    };
  }
  const llmDirectiveCount = input.llmDirectiveCount ?? input.validDirectivesCount;
  const testedCount = input.testedCount ?? (input.decisiveSample >= input.minSample ? 1 : 0);
  if (llmDirectiveCount === 0 && input.validDirectivesCount === 0) {
    return {
      reason: 'LLM_VUOTA',
      reasonDetail: 'La LLM non ha restituito direttive valide.',
    };
  }
  if (testedCount === 0) {
    return {
      reason: 'CAMPIONE_INSUFFICIENTE',
      reasonDetail:
        `${input.decisiveSample}/${input.minSample} trade decisivi: nessun predicato con campione sufficiente.`,
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
