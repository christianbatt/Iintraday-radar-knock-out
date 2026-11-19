/**
 * Test dello scheduler orario passivo e dei mark live V1-live (`lastPrice` / `unrealizedR`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  filterUnderlyingsForActiveMarkets,
  getActiveMarketsAt,
} from '../../server/shadowMarketScheduler';
import {
  computeShadowV1LiveMarks,
  SHADOW_V1_LIVE_MARKS_PATH,
  updateShadowV1LiveMarksOnDisk,
} from '../../server/shadowV1LiveMarks';
import {
  SHADOW_V1_LIVE_SIGNALS_PATH,
  writeRecordsAtomic,
  type PersistedShadowV1LiveRecord,
} from '../../server/shadowV1LiveStore';
import type { UnderlyingItem } from '../../types/radar';

const BASKET: UnderlyingItem[] = [
  { ticker: 'SAP.DE', nome: 'SAP', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'NVDA', nome: 'NVIDIA', mercato: 'US', valuta: 'USD' },
];

test('scheduler: seleziona solo i mercati effettivamente aperti per orario, weekend, festivi e early close', () => {
  // 2026-11-18 (mercoledi): 09:30 UTC = 10:30 CET (EU aperto), 04:30 ET (US chiuso)
  const euMorning = Date.UTC(2026, 10, 18, 9, 30, 0);
  const mMorning = filterUnderlyingsForActiveMarkets(BASKET, euMorning);
  assert.deepEqual(mMorning.activeMarkets, ['EU']);
  assert.deepEqual(mMorning.items.map((i) => i.ticker), ['SAP.DE']);

  // 2026-11-18: 15:00 UTC = 16:00 CET (EU aperto) + 10:00 ET (US aperto)
  const overlap = Date.UTC(2026, 10, 18, 15, 0, 0);
  const mOverlap = filterUnderlyingsForActiveMarkets(BASKET, overlap);
  assert.deepEqual(mOverlap.activeMarkets, ['EU', 'US']);
  assert.deepEqual(mOverlap.items.map((i) => i.ticker), ['SAP.DE', 'NVDA']);

  // 2026-11-18: 19:00 UTC = 20:00 CET (EU chiuso) + 14:00 ET (US aperto)
  const usEvening = Date.UTC(2026, 10, 18, 19, 0, 0);
  const mEvening = filterUnderlyingsForActiveMarkets(BASKET, usEvening);
  assert.deepEqual(mEvening.activeMarkets, ['US']);
  assert.deepEqual(mEvening.items.map((i) => i.ticker), ['NVDA']);

  // 2026-11-21 (sabato): nessun mercato
  const saturday = Date.UTC(2026, 10, 21, 15, 0, 0);
  assert.deepEqual(getActiveMarketsAt(saturday), []);
  assert.equal(filterUnderlyingsForActiveMarkets(BASKET, saturday).items.length, 0);

  // 2026-11-26 (Thanksgiving US, EU aperto ma US festivo chiuso): solo EU
  const thanksgiving = Date.UTC(2026, 10, 26, 15, 0, 0);
  assert.deepEqual(getActiveMarketsAt(thanksgiving), ['EU']);

  // 2026-11-27 (Day after Thanksgiving US early close 13:00 ET -> UTC 18:00):
  // alle 13:15 ET (18:15 UTC) ancora dentro +5m di buffer? no (13:05+ = chiuso)
  const postEarlyClose = Date.UTC(2026, 10, 27, 19, 0, 0); // 14:00 ET -> US chiuso, EU 20:00 chiuso
  assert.deepEqual(getActiveMarketsAt(postEarlyClose), []);
});

test('marks live V1-live: calcola unrealizedR, pct e fallback bar5m senza esporre entry/stop/target', () => {
  const rec = (over: Partial<PersistedShadowV1LiveRecord>): PersistedShadowV1LiveRecord => ({
    v: 1,
    key: 'K1',
    ticker: 'NVDA',
    market: 'US',
    direction: 'LONG',
    entry: 100,
    stop: 95,
    target: 110,
    decidedAtMs: Date.UTC(2026, 10, 18, 15, 0, 0),
    sessionCloseMs: Date.UTC(2026, 10, 18, 21, 0, 0),
    firstSeenAtMs: Date.UTC(2026, 10, 18, 15, 0, 10),
    status: 'OPEN',
    r: null,
    reason: null,
    fillBarTs: Date.UTC(2026, 10, 18, 15, 5, 0),
    exitBarTs: null,
    exitPrice: null,
    moduleVersion: 'shadowV1Live@1',
    updatedAtMs: Date.UTC(2026, 10, 18, 15, 5, 0),
    ...over,
  });

  const records: PersistedShadowV1LiveRecord[] = [
    rec({ key: 'OPEN_LONG', ticker: 'NVDA', market: 'US', direction: 'LONG', status: 'OPEN', entry: 100, stop: 95 }),
    rec({ key: 'PENDING_SHORT', ticker: 'SAP.DE', market: 'EU', direction: 'SHORT', status: 'PENDING_FILL', entry: 200, stop: 204 }),
    rec({ key: 'CLOSED_STOP', ticker: 'AAPL', status: 'STOP', r: -1, exitPrice: 95 }),
  ];

  const marks = computeShadowV1LiveMarks(
    records,
    [{ ticker: 'NVDA', market: 'US', currency: 'USD', currentPrice: 102.5, marketTs: 1_795_014_300 }],
    (ticker) =>
      ticker === 'SAP.DE'
        ? [{ t: Date.UTC(2026, 10, 18, 15, 10, 0), o: 199, h: 199.5, l: 197.5, c: 198 }]
        : [],
    Date.UTC(2026, 10, 18, 15, 15, 0)
  );

  assert.equal(marks.length, 2, 'solo OPEN e PENDING_FILL ricevono il mark live');

  const mLong = marks.find((m) => m.key === 'OPEN_LONG')!;
  assert.equal(mLong.lastPrice, 102.5);
  assert.equal(mLong.unrealizedR, 0.5);
  assert.equal(mLong.pctFromEntry, 2.5);
  assert.equal(mLong.priceSource, 'quote');
  assert.equal(mLong.currency, 'USD');
  assert.equal('entry' in mLong, false);
  assert.equal('stop' in mLong, false);
  assert.equal('target' in mLong, false);

  const mShortPending = marks.find((m) => m.key === 'PENDING_SHORT')!;
  assert.equal(mShortPending.lastPrice, 198);
  assert.equal(mShortPending.unrealizedR, null, 'PENDING_FILL non ha R non realizzato');
  assert.equal(mShortPending.pctFromEntry, 1, 'SHORT con prezzo 198 vs 200 -> +1% favorevole');
  assert.equal(mShortPending.priceSource, 'bar5m');
  assert.equal(mShortPending.currency, 'EUR');
});

test('marks live V1-live: updateShadowV1LiveMarksOnDisk scrive e legge da disco atomicamente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1marks-'));
  try {
    const sigPath = path.join(dir, SHADOW_V1_LIVE_SIGNALS_PATH);
    writeRecordsAtomic(sigPath, [
      {
        v: 1,
        key: 'M1',
        ticker: 'ASML.AS',
        market: 'EU',
        direction: 'LONG',
        entry: 800,
        stop: 790,
        target: 820,
        decidedAtMs: Date.UTC(2026, 10, 18, 9, 0, 0),
        sessionCloseMs: Date.UTC(2026, 10, 18, 16, 30, 0),
        firstSeenAtMs: Date.UTC(2026, 10, 18, 9, 0, 5),
        status: 'OPEN',
        r: null,
        reason: null,
        fillBarTs: Date.UTC(2026, 10, 18, 9, 5, 0),
        exitBarTs: null,
        exitPrice: null,
        moduleVersion: 'shadowV1Live@1',
        updatedAtMs: Date.UTC(2026, 10, 18, 9, 5, 0),
      },
    ]);

    const payload = updateShadowV1LiveMarksOnDisk(
      [{ ticker: 'ASML.AS', market: 'EU', currency: 'EUR', currentPrice: 805, marketTs: 1_795_000_000 }],
      { rootDir: dir, nowMs: Date.UTC(2026, 10, 18, 9, 10, 0) }
    );
    assert.ok(payload);
    assert.equal(payload.marks.length, 1);
    assert.equal(payload.marks[0].unrealizedR, 0.5);

    const disk = JSON.parse(fs.readFileSync(path.join(dir, SHADOW_V1_LIVE_MARKS_PATH), 'utf8'));
    assert.equal(disk.marks[0].ticker, 'ASML.AS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('marks live V1-live: il temporaneo e univoco per chiamata e non consuma un file estraneo con lo stesso pid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1marks-tmp-'));
  try {
    const sigPath = path.join(dir, SHADOW_V1_LIVE_SIGNALS_PATH);
    writeRecordsAtomic(sigPath, [
      {
        v: 1,
        key: 'TMP1',
        ticker: 'ASML.AS',
        market: 'EU',
        direction: 'LONG',
        entry: 800,
        stop: 790,
        target: 820,
        decidedAtMs: Date.UTC(2026, 10, 18, 9, 0, 0),
        sessionCloseMs: Date.UTC(2026, 10, 18, 16, 30, 0),
        firstSeenAtMs: Date.UTC(2026, 10, 18, 9, 0, 5),
        status: 'OPEN',
        r: null,
        reason: null,
        fillBarTs: Date.UTC(2026, 10, 18, 9, 5, 0),
        exitBarTs: null,
        exitPrice: null,
        moduleVersion: 'shadowV1Live@1',
        updatedAtMs: Date.UTC(2026, 10, 18, 9, 5, 0),
      },
    ]);

    const marksPath = path.join(dir, SHADOW_V1_LIVE_MARKS_PATH);
    fs.mkdirSync(path.dirname(marksPath), { recursive: true });
    const decoy = `${marksPath}.tmp-${process.pid}`;
    fs.writeFileSync(decoy, 'DECOY', 'utf8');

    const payload = updateShadowV1LiveMarksOnDisk(
      [{ ticker: 'ASML.AS', market: 'EU', currency: 'EUR', currentPrice: 805, marketTs: 1_795_000_000 }],
      { rootDir: dir, nowMs: Date.UTC(2026, 10, 18, 9, 10, 0) }
    );
    assert.ok(payload);

    assert.equal(fs.readFileSync(decoy, 'utf8'), 'DECOY', 'il file estraneo non viene ne sovrascritto ne consumato');
    const leftovers = fs
      .readdirSync(path.dirname(marksPath))
      .filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [path.basename(decoy)], 'nessun temporaneo residuo della scrittura');
    assert.equal(JSON.parse(fs.readFileSync(marksPath, 'utf8')).marks.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
