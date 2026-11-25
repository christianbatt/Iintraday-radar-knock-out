/** Flag del percorso AI desk basato sul fascicolo probatorio. */
export type AiDeskEvidenceFlag = 'on' | 'off';

export const AI_DESK_EVIDENCE_ENV = 'AI_DESK_EVIDENCE';

/**
 * Spento di default: acceso solo con il valore esatto `'1'`.
 * Con il flag spento nessun endpoint cambia comportamento.
 */
export function isAiDeskEvidenceEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[AI_DESK_EVIDENCE_ENV] === '1';
}
