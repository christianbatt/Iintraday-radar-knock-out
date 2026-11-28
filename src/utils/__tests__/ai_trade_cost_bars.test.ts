/**
 * Test della lettura unica di `bars.json` per richiesta (Fase 6.3).
 *
 * Il contratto: la mappa si carica UNA volta per scope (la richiesta) e i
 * consumatori condividono la stessa istanza. Nessun file di produzione viene
 * toccato: la directory e' temporanea.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  barsAroundFill,
  createShadowV1LiveBarsOnce,
  loadShadowV1LiveBarsByTicker,
} from '../../server/aiTradeCostBars';
import { resolveTradeCost } from '../../server/aiTradeCost';

const roots: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-bars-'));
  roots.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function barsFile(dir: string): string {
  const file = path.join(dir, 'bars.json');
  const payload = {
    version: 1,
    updatedAtMs: 1_773_673_200_000,
    entries: {
      0: {
        ticker: 'AAPL',
        market: 'US',
        bars: [
          { t: 1000, o: 99, h: 100.5, l: 98.5, c: 100, v: 10 },
          { t: 2000, o: 100, h: 101, l: 99.5, c: 100.5, v: 12 },
          { t: 3000, o: 100.5, h: 102, l: 100, c: 101.5, v: 8 },
        ],
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  return file;
}

test('Fase 6.3: la mappa si carica una sola volta per scope, anche con tre lettori', () => {
  let reads = 0;
  const barsOnce = createShadowV1LiveBarsOnce(() => {
    reads += 1;
    return new Map([['AAPL', [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }]]]);
  });

  // Tre consumatori, come readForward + readNearMissForward + readRejectedForward.
  assert.equal(barsOnce().get('AAPL')?.length, 1);
  assert.equal(barsOnce().get('AAPL')?.length, 1);
  assert.equal(barsOnce().get('AAPL')?.length, 1);
  assert.equal(reads, 1, 'bars.json deve essere letto una volta sola per richiesta');
});

test('Fase 6.3: due scope diversi rileggono (nessuna cache di processo)', () => {
  let reads = 0;
  const load = (): Map<string, never[]> => {
    reads += 1;
    return new Map();
  };
  createShadowV1LiveBarsOnce(load)();
  createShadowV1LiveBarsOnce(load)();
  assert.equal(reads, 2);
});

test('Fase 6.3: loadShadowV1LiveBarsByTicker indicizza per ticker e ignora barre incomplete', () => {
  const dir = tmpRoot();
  const file = barsFile(dir);
  const map = loadShadowV1LiveBarsByTicker(file);
  assert.equal(map.get('AAPL')?.length, 3);

  // Barre senza un campo OHLC non entrano: il costo resta quello dichiarato.
  const dirty = path.join(dir, 'dirty.json');
  fs.writeFileSync(
    dirty,
    JSON.stringify({ entries: [{ ticker: 'ENI.MI', bars: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: 2, o: 2 }] }] }),
    'utf8'
  );
  assert.equal(loadShadowV1LiveBarsByTicker(dirty).get('ENI.MI')?.length, 1);
});

test('Fase 6.3: file assente o JSON invalido non lanciano e danno mappa vuota', () => {
  const dir = tmpRoot();
  assert.equal(loadShadowV1LiveBarsByTicker(path.join(dir, 'assente.json')).size, 0);
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{non json', 'utf8');
  assert.equal(loadShadowV1LiveBarsByTicker(broken).size, 0);
});

test('Fase 6.3: barsAroundFill prende la barra del fill e la precedente', () => {
  const dir = tmpRoot();
  const map = loadShadowV1LiveBarsByTicker(barsFile(dir));
  const two = barsAroundFill(map.get('AAPL'), 2000);
  assert.deepEqual(two?.map((b) => b.t), [1000, 2000]);
  assert.equal(barsAroundFill(map.get('AAPL'), 500), null, 'nessuna barra precedente');
  assert.equal(barsAroundFill(map.get('AAPL'), null), null, 'fill non databile');
  assert.equal(barsAroundFill(undefined, 2000), null, 'ticker assente');
});

test('Fase 6.3: i numeri del costo non cambiano rispetto alla lettura diretta', () => {
  const dir = tmpRoot();
  const file = barsFile(dir);
  const barsOnce = createShadowV1LiveBarsOnce(() => loadShadowV1LiveBarsByTicker(file));

  const fromSnapshot = barsAroundFill(barsOnce().get('AAPL'), 2000);
  const direct = barsAroundFill(loadShadowV1LiveBarsByTicker(file).get('AAPL'), 2000);

  const a = resolveTradeCost({ entry: 100, stop: 95, leverage: 10, bars: fromSnapshot });
  const b = resolveTradeCost({ entry: 100, stop: 95, leverage: 10, bars: direct });
  assert.deepEqual(a, b);
  assert.equal(a.costSource, 'per_row_cs_leverage');
});
