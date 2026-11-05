/**
 * Regressione sul log di avvio auth: il messaggio fail-closed non deve comparire
 * quando ALLOW_LEGACY_API_AUTH=true.
 * Runner: tsx — `npx tsx src/utils/__tests__/authStartupWarning.test.ts`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  AUTH_FAIL_CLOSED_WARNING,
  AUTH_LEGACY_WARNING,
  authStartupWarning,
} from '../authStartupWarning';

// ------------------------------------------------- VOCE A: fallback legacy attivo
{
  const withAuthenticator = authStartupWarning(true, true);
  const withoutAuthenticator = authStartupWarning(true, false);
  for (const message of [withAuthenticator, withoutAuthenticator]) {
    assert.equal(message, AUTH_LEGACY_WARNING, 'A: con ALLOW_LEGACY_API_AUTH=true vale il messaggio legacy');
    assert.notEqual(message, AUTH_FAIL_CLOSED_WARNING, 'A: il messaggio fail-closed non compare');
    assert.ok(message?.includes('ATTENZIONE'), 'A: il messaggio legacy e\' un avviso esplicito');
    assert.ok(message?.includes('ALLOW_LEGACY_API_AUTH=true'), 'A: il messaggio nomina la variabile');
  }
}

// ------------------------------------------------- VOCE B: senza fallback legacy
{
  assert.equal(
    authStartupWarning(false, false),
    AUTH_FAIL_CLOSED_WARNING,
    'B: senza autenticatore il messaggio fail-closed resta invariato',
  );
  assert.equal(authStartupWarning(false, true), null, 'B: con autenticatore non si stampa nulla');
}

// ------------------------------------------------- VOCE C: wiring in server.ts
{
  const serverSource = fs.readFileSync(new URL('../../../server.ts', import.meta.url), 'utf8');
  assert.ok(
    !serverSource.includes("console.warn('[Auth] Nessun autenticatore configurato"),
    'C: server.ts non stampa piu\' il messaggio fail-closed in modo diretto',
  );
  assert.ok(serverSource.includes('authStartupWarning('), 'C: server.ts usa la funzione testata');
  assert.ok(serverSource.includes('ALLOW_LEGACY_API_AUTH'), 'C: il flag resta letto da server.ts');
}

console.log('auth_startup_warning: 3 gruppi OK');
