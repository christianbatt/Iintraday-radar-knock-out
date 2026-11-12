import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const REG = `${ROOT}/registry/ai_registry.jsonl`;

function rowCount(): number {
  return fs.readFileSync(REG, 'utf8').split('\n').filter(l => l.trim().length > 0).length;
}

describe('STEP 3.3 — `postmortem` non scrive nel registro', () => {
  it('due esecuzioni di fila lasciano invariato il numero di righe', () => {
    const before = rowCount();
    execFileSync('bun', ['scripts/ai_cycle.ts', 'postmortem'], { cwd: ROOT, stdio: 'ignore' });
    execFileSync('bun', ['scripts/ai_cycle.ts', 'postmortem'], { cwd: ROOT, stdio: 'ignore' });
    const after = rowCount();
    assert.equal(after, before, `righe prima=${before} dopo=${after}`);
    assert.ok(before > 0);
  });
});
