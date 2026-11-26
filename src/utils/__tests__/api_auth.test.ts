/**
 * Test del nucleo di autenticazione API (`src/server/apiAuth.ts`).
 *
 * Il fake di Firebase Admin espone solo `verifyIdToken`, cioe' l'unica cosa che
 * il nucleo usa: i casi coperti sono token valido, token rifiutato, backend
 * assente e ripiego legacy on/off, piu' i tre messaggi 401 (contratto pubblico
 * del middleware). Nessun server vivo, nessuna credenziale reale.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  API_AUTH_ERROR_MESSAGES,
  apiAuthErrorMessage,
  resolveApiAuth,
  type ApiAuthDeps,
  type ApiAuthRequest,
} from '../../server/apiAuth';

const SERVICE_KEY = 'service-key';

function request(headers: Record<string, string> = {}): ApiAuthRequest {
  return {
    get(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  };
}

function fakeFirebase(options: { uid?: string; throws?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    verifyIdToken: async (token: string) => {
      calls.push(token);
      if (options.throws) throw new Error('token scaduto');
      return { uid: options.uid ?? 'uid-fake' };
    },
  };
}

function deps(over: Partial<ApiAuthDeps> = {}): ApiAuthDeps {
  return {
    isValidApiKey: (req) => req.get('x-api-key') === SERVICE_KEY,
    verifyIdToken: null,
    allowLegacyApiAuth: false,
    ...over,
  };
}

// --- x-api-key di servizio ----------------------------------------------------

test('x-api-key valida: uid service-api-key e nessuna verifica del token', async () => {
  const firebase = fakeFirebase();
  const out = await resolveApiAuth(
    request({ 'x-api-key': SERVICE_KEY }),
    deps({ verifyIdToken: firebase.verifyIdToken })
  );
  assert.deepEqual(out, { ok: true, uid: 'service-api-key' });
  assert.deepEqual(firebase.calls, []);
});

test('x-api-key errata non autentica: senza altri header si finisce in missing', async () => {
  const out = await resolveApiAuth(request({ 'x-api-key': 'sbagliata' }), deps());
  assert.deepEqual(out, { ok: false, reason: 'missing' });
});

// --- assenza di credenziali ---------------------------------------------------

test('nessun header, legacy off: 401 missing', async () => {
  const firebase = fakeFirebase();
  const out = await resolveApiAuth(
    request(),
    deps({ verifyIdToken: firebase.verifyIdToken })
  );
  assert.deepEqual(out, { ok: false, reason: 'missing' });
  assert.deepEqual(firebase.calls, [], 'senza token non si chiama Firebase');
});

test('nessun header, legacy on: autentica come legacy', async () => {
  const out = await resolveApiAuth(request(), deps({ allowLegacyApiAuth: true }));
  assert.deepEqual(out, { ok: true, uid: 'legacy' });
});

test('Authorization non Bearer (es. Basic) trattata come assente', async () => {
  const out = await resolveApiAuth(
    request({ authorization: 'Basic dXNlcjpwYXNz' }),
    deps()
  );
  assert.deepEqual(out, { ok: false, reason: 'missing' });
});

test('Bearer senza token (header troncato) e\' missing', async () => {
  const out = await resolveApiAuth(request({ authorization: 'Bearer ' }), deps());
  assert.deepEqual(out, { ok: false, reason: 'missing' });
});

// --- Bearer token con Firebase ------------------------------------------------

test('Bearer valido: uid dal token verificato, token passato senza modifiche', async () => {
  const firebase = fakeFirebase({ uid: 'uid-42' });
  const out = await resolveApiAuth(
    request({ authorization: 'Bearer abc.def.ghi' }),
    deps({ verifyIdToken: firebase.verifyIdToken })
  );
  assert.deepEqual(out, { ok: true, uid: 'uid-42' });
  assert.deepEqual(firebase.calls, ['abc.def.ghi']);
});

test('schema dello header case-insensitive: bEaReR accettato', async () => {
  const firebase = fakeFirebase({ uid: 'uid-case' });
  const out = await resolveApiAuth(
    request({ authorization: 'bEaReR token-1' }),
    deps({ verifyIdToken: firebase.verifyIdToken })
  );
  assert.deepEqual(out, { ok: true, uid: 'uid-case' });
});

test('Bearer non valido: 401 invalid e nessun ripiego legacy', async () => {
  const firebase = fakeFirebase({ throws: true });
  const out = await resolveApiAuth(
    request({ authorization: 'Bearer scaduto' }),
    deps({ verifyIdToken: firebase.verifyIdToken, allowLegacyApiAuth: true })
  );
  assert.deepEqual(out, { ok: false, reason: 'invalid' });
});

test('Bearer senza backend Firebase, legacy off: 401 no_backend', async () => {
  const out = await resolveApiAuth(
    request({ authorization: 'Bearer qualsiasi' }),
    deps({ verifyIdToken: null })
  );
  assert.deepEqual(out, { ok: false, reason: 'no_backend' });
});

test('Bearer senza backend Firebase, legacy on: autentica come legacy', async () => {
  const out = await resolveApiAuth(
    request({ authorization: 'Bearer qualsiasi' }),
    deps({ verifyIdToken: null, allowLegacyApiAuth: true })
  );
  assert.deepEqual(out, { ok: true, uid: 'legacy' });
});

// --- messaggi 401 -------------------------------------------------------------

test('i tre messaggi 401 sono distinti e stabili', () => {
  assert.equal(apiAuthErrorMessage('missing'), 'Bearer token required');
  assert.equal(
    apiAuthErrorMessage('no_backend'),
    'Auth backend not configured: Firebase Admin credentials missing'
  );
  assert.equal(apiAuthErrorMessage('invalid'), 'Firebase ID token invalid or expired');
  const distinct = new Set(Object.values(API_AUTH_ERROR_MESSAGES));
  assert.equal(distinct.size, 3, 'nessun messaggio duplicato: ogni causa e\' distinguibile');
});
