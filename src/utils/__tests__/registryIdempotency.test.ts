import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SRC_REG = path.join(ROOT, 'registry', 'ai_registry.jsonl');
const CYCLE_SCRIPT = path.join(ROOT, 'scripts', 'ai_cycle.ts');

function rowCount(regPath: string): number {
  if (!fs.existsSync(regPath)) return 0;
  return fs
    .readFileSync(regPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0).length;
}

describe('STEP 3.3 — `postmortem` non scrive nel registro', () => {
  it('due esecuzioni di fila lasciano invariato il numero di righe', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cycle-postmortem-'));
    try {
      const tmpRegDir = path.join(tmpDir, 'registry');
      const tmpReg = path.join(tmpRegDir, 'ai_registry.jsonl');
      const tmpReplayDir = path.join(tmpDir, 'artifacts', 'replay_i3_30d', 'shift_0');
      const tmpBarsDir = path.join(tmpDir, 'artifacts', 'bars');
      fs.mkdirSync(tmpRegDir, { recursive: true });
      fs.mkdirSync(tmpReplayDir, { recursive: true });
      fs.mkdirSync(tmpBarsDir, { recursive: true });

      if (fs.existsSync(SRC_REG)) {
        fs.copyFileSync(SRC_REG, tmpReg);
      } else {
        fs.writeFileSync(tmpReg, `${JSON.stringify({ id: 'AI-0001', kind: 'hypothesis' })}\n`, 'utf8');
      }

      const t0 = Math.floor(Date.UTC(2026, 9, 20, 8, 30, 0) / 1000);
      fs.writeFileSync(
        path.join(tmpBarsDir, 'TEST_5d.json'),
        JSON.stringify([
          { t: t0, o: 100, h: 100.5, l: 99.5, c: 100, v: 1000 },
          { t: t0 + 300, o: 100, h: 102.0, l: 99.6, c: 101.8, v: 1200 },
          { t: t0 + 600, o: 101.8, h: 102.2, l: 98.5, c: 99.0, v: 1500 },
        ]),
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpReplayDir, 'setups.json'),
        JSON.stringify([
          {
            symbol: 'TEST',
            decisionTs: t0,
            direction: 'LONG',
            entry: 100,
            stop: 99,
            target: 101.6,
            gates: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13'],
            emitted: true,
          },
          {
            symbol: 'TEST',
            decisionTs: t0 + 300,
            direction: 'LONG',
            entry: 101,
            stop: 100,
            target: 102.6,
            gates: ['G1', 'G2', 'G3'],
            emitted: false,
          },
        ]),
        'utf8'
      );

      const before = rowCount(tmpReg);
      execFileSync('bun', [CYCLE_SCRIPT, 'postmortem'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('bun', [CYCLE_SCRIPT, 'postmortem'], { cwd: tmpDir, stdio: 'ignore' });
      const after = rowCount(tmpReg);
      assert.equal(after, before, `righe prima=${before} dopo=${after}`);
      assert.ok(before > 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
