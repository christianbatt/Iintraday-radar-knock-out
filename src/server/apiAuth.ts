/**
 * AUTH DELLE API — nucleo puro, iniettabile.
 *
 * Unica implementazione del controllo credenziali per le route protette del
 * server (`requireApiAuth`) e per la route observe del collector Shadow V1-live
 * (che la riceve come `authorize`). Vive qui, e non in `server.ts`, perche'
 * `server.ts` avvia il processo all'import: un modulo puro permette di
 * esercitare token valido/invalido e il ripiego legacy senza un server vivo ne'
 * un vero Firebase Admin.
 *
 * Regole (AUDIT D2, fail-closed):
 * - `x-api-key` valido -> uid `service-api-key` (chiavi di servizio interne).
 * - `Authorization: Bearer <token>` con Firebase Admin configurato -> `verifyIdToken`.
 * - Nessun header -> 401, a meno del ripiego esplicito `ALLOW_LEGACY_API_AUTH`.
 * - Bearer ma nessun Firebase Admin -> 401 (mai fail-open), stesso ripiego.
 * - Token non verificabile -> 401 `invalid`.
 */

export interface ApiAuthRequest {
  get(name: string): string | undefined;
}

export type ApiAuthFailureReason = 'missing' | 'no_backend' | 'invalid';

export type ApiAuthResolution =
  | { ok: true; uid: string }
  | { ok: false; reason: ApiAuthFailureReason };

export interface ApiAuthDeps {
  /** true se l'`x-api-key` della richiesta corrisponde a una chiave valida. */
  isValidApiKey: (req: ApiAuthRequest) => boolean;
  /** Verificatore Firebase Admin; `null` quando il backend non e' configurato. */
  verifyIdToken: ((token: string) => Promise<{ uid: string }>) | null;
  /** Ripiego legacy, spento di default: autentica senza credenziali. */
  allowLegacyApiAuth: boolean;
}

/** Messaggi dei 401: parte del contratto, quindi centralizzati e testati. */
export const API_AUTH_ERROR_MESSAGES: Record<ApiAuthFailureReason, string> = {
  missing: 'Bearer token required',
  no_backend: 'Auth backend not configured: Firebase Admin credentials missing',
  invalid: 'Firebase ID token invalid or expired',
};

export function apiAuthErrorMessage(reason: ApiAuthFailureReason): string {
  return API_AUTH_ERROR_MESSAGES[reason];
}

export async function resolveApiAuth(
  req: ApiAuthRequest,
  deps: ApiAuthDeps
): Promise<ApiAuthResolution> {
  if (deps.isValidApiKey(req)) return { ok: true, uid: 'service-api-key' };

  const authorization = req.get('authorization') || '';
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) {
    return deps.allowLegacyApiAuth ? { ok: true, uid: 'legacy' } : { ok: false, reason: 'missing' };
  }
  if (!deps.verifyIdToken) {
    return deps.allowLegacyApiAuth
      ? { ok: true, uid: 'legacy' }
      : { ok: false, reason: 'no_backend' };
  }

  try {
    const decoded = await deps.verifyIdToken(tokenMatch[1]);
    return { ok: true, uid: decoded.uid };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
