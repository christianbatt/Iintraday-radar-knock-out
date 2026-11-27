#!/usr/bin/env bun
/**
 * scripts/ai_calibration_latency.ts — latenza del NUCLEO della route
 * `GET /api/shadow/ai-calibration` con un campione PIENO.
 *
 * Perche' esiste: la calibrazione fa un bootstrap deterministico (2000
 * iterazioni x 2 statistiche) sull'intero campione. Con 2000 valutazioni
 * (`AI_CALIBRATION_MAX_ENTRIES`) e' lavoro CPU dentro una GET: se sfonda il
 * budget, la route resta lenta anche quando i dati sono corretti.
 *
 * Il probe misura `buildAiCalibration` (la funzione pura che la route chiama
 * dopo le letture), non la rete ne' Firestore: isola il costo dell'aggregato.
 * Il campione sintetico e' deterministico (stesse righe a ogni esecuzione).
 *
 * Uso: npx tsx scripts/ai_calibration_latency.ts [--iterations=20]
 * Output: artifacts/ai_calibration_route_latency.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AI_CALIBRATION_MAX_ENTRIES,
  buildAiCalibration,
  type AiCalibrationEntry,
  type AiCalibrationForwardPoint,
} from '../src/server/aiCalibration';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const ITERATIONS = Math.max(1, Math.floor(Number(arg('iterations', '20')) || 20));
const OUT = arg('out', 'artifacts/ai_calibration_route_latency.json');
const CANDIDATES = AI_CALIBRATION_MAX_ENTRIES;
const BASE_MS = Date.parse('2026-11-20T09:00:00.000Z');
const DECISIONS = ['AZIONE', 'ATTESA', 'SCARTO'] as const;

/** Campione pieno deterministico: 40 candidati per run, esiti entro la finestra. */
function buildSample(): { entries: AiCalibrationEntry[]; forward: AiCalibrationForwardPoint[] } {
  const entries: AiCalibrationEntry[] = [];
  const forward: AiCalibrationForwardPoint[] = [];
  for (let i = 0; i < CANDIDATES; i += 1) {
    const runIndex = Math.floor(i / 40);
    const atMs = BASE_MS + runIndex * 60_000;
    const ticker = `T${i % 40}.MI`;
    const decision = DECISIONS[i % DECISIONS.length];
    const candidateKey = `run-${runIndex}:${ticker}`;
    entries.push({
      id: `e${i}`,
      timestamp: new Date(atMs).toISOString(),
      ticker,
      market: i % 2 === 0 ? 'EU' : 'US',
      direction: i % 3 === 0 ? 'SHORT' : 'LONG',
      source: 'specialize',
      aiOutcome: `${decision}: sintetico`,
      candidateKey,
      evaluated: true,
      discarded: false,
      durationMs: 800 + (i % 700),
      decision,
    });
    forward.push({
      key: `signals:${i}`,
      ticker,
      decidedAtMs: atMs + 5 * 60_000,
      r: ((i * 37) % 400) / 100 - 1.2,
      status: i % 5 === 0 ? 'STOP' : i % 7 === 0 ? 'EXPIRED' : 'TARGET',
      source: 'signals',
    });
  }
  return { entries, forward };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function main(): void {
  const sample = buildSample();
  const timings: number[] = [];
  let last = buildAiCalibration({
    entries: sample.entries,
    forward: sample.forward,
    nowMs: BASE_MS,
    generatedAt: new Date(BASE_MS).toISOString(),
  });
  for (let i = 0; i < ITERATIONS; i += 1) {
    const startedAt = performance.now();
    last = buildAiCalibration({
      entries: sample.entries,
      forward: sample.forward,
      nowMs: BASE_MS,
      generatedAt: new Date(BASE_MS).toISOString(),
    });
    timings.push(performance.now() - startedAt);
  }
  timings.sort((a, b) => a - b);
  const summary = {
    kind: 'ai-calibration-route-latency',
    measuredAt: new Date().toISOString(),
    route: 'GET /api/shadow/ai-calibration (nucleo puro buildAiCalibration)',
    entries: sample.entries.length,
    forwardPoints: sample.forward.length,
    iterations: ITERATIONS,
    ms: {
      min: round(timings[0], 2),
      p50: round(percentile(timings, 0.5), 2),
      p95: round(percentile(timings, 0.95), 2),
      max: round(timings[timings.length - 1], 2),
    },
    sampleResult: {
      matched: last.counts.matched,
      classified: last.counts.classified,
      verdict: last.verdict,
      validation: last.validation.verdict,
      edgeRNet: last.edgeRNet,
    },
    note:
      'Misura solo il costo CPU dell aggregato: le letture (file/Firestore) sono fuori. ' +
      'Campione sintetico deterministico, non dati reali.',
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `campione ${summary.entries} valutazioni, ${summary.forwardPoints} esiti -> ` +
      `p50 ${summary.ms.p50}ms, p95 ${summary.ms.p95}ms, max ${summary.ms.max}ms ` +
      `(${ITERATIONS} iterazioni)`
  );
  console.log(`riepilogo in ${OUT}`);
}

main();
