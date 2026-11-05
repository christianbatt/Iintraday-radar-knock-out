/**
 * Messaggio di avvio relativo all'autenticazione delle API.
 *
 * Con `ALLOW_LEGACY_API_AUTH=true` il server non e' fail-closed: annunciarlo come tale
 * sarebbe fuorviante, quindi il messaggio diventa un avviso esplicito.
 * Non modifica la logica di autorizzazione: decide solo cosa scrivere nel log.
 */

export const AUTH_FAIL_CLOSED_WARNING =
  '[Auth] Nessun autenticatore configurato: route sensibili restano chiuse (401/503).';

export const AUTH_LEGACY_WARNING =
  '[Auth] ATTENZIONE: ALLOW_LEGACY_API_AUTH=true, fallback legacy attivo';

/**
 * @param allowLegacyApiAuth `ALLOW_LEGACY_API_AUTH === 'true'`
 * @param hasAuthenticator almeno un autenticatore configurato (VALID_API_KEYS o Firebase Admin)
 * @returns messaggio da stampare, oppure `null` quando non c'e' nulla da segnalare
 */
export function authStartupWarning(
  allowLegacyApiAuth: boolean,
  hasAuthenticator: boolean,
): string | null {
  if (allowLegacyApiAuth) return AUTH_LEGACY_WARNING;
  if (hasAuthenticator) return null;
  return AUTH_FAIL_CLOSED_WARNING;
}
