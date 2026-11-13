/**
 * scripts/replay_adapter.ts — Passo H-bis / I3
 *
 * Wrapper sottile fra scripts/delay_replay.ts e l'harness (scripts/headless_pipeline.ts).
 * Traduce { symbol, decisionTs, bars } nella chiamata alla pipeline REALE e
 * restituisce la forma SetupOut attesa dal replay.
 *
 * Nessuna soglia, nessun gate, nessuna decisione: la decisione la prende
 * buildExecutionSetup come in produzione. Le barre arrivano GIA' troncate da
 * delay_replay (shift applicato a monte): qui non si sposta nessun timestamp.
 *
 * Unica I/O: lettura una tantum dello snapshot versionato, da cui provengono i
 * campi statici per simbolo (nome, mercato, valuta, atr14, avgVolume20d,
 * liqEur20d, prevClose). Non e' I/O di mercato e non avviene per decisione.
 */

import { readFileSync } from 'node:fs';
import { runPipelineFromBars, type Bar5m, type Snapshot } from './headless_pipeline';
import { reasonLabel } from './emission_guard';

const SNAPSHOT_PATH = 'artifacts/snapshot_9.json';

let cached: Snapshot | null = null;

function snapshot(): Snapshot {
  if (cached === null) {
    cached = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
  }
  return cached;
}

type SetupOut = {
  symbol: string;
  decisionTs: number;
  emitted: boolean;
  direction: string | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  gates: string[] | null;
  reason: string | null;
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function runPipeline(input: {
  symbol: string;
  decisionTs: number;
  bars: { t: number; o: number; h: number; l: number; c: number; v: number }[];
}): SetupOut | null {
  const snap = snapshot();
  const base = snap.quotes.find((q) => q.ticker === input.symbol);
  if (base === undefined) return null;

  const bars = input.bars as Bar5m[];
  const result = runPipelineFromBars(snap, input.symbol, input.decisionTs, bars);
  if (result === null) return null;

  const market = base.market;
  const branch = (market === 'EU' ? result.EU : result.US) as Record<string, unknown> | undefined;
  const setup = (branch?.setup ?? null) as Record<string, unknown> | null;
  if (setup === null) return null;

  const gateResults = (setup.gateResults ?? {}) as Record<string, { passed?: boolean }>;
  const gates = Object.keys(gateResults).filter((k) => gateResults[k]?.passed === true);
  const decision = typeof setup.decision === 'string' ? setup.decision : 'NESSUN_TRADE';
  const direction = typeof setup.direction === 'string' ? setup.direction : null;

  // Passo N: causa del blocco, additiva. Non cambia nessun esito.
  const blocked = typeof setup.blockedGate === 'string' ? setup.blockedGate : null;
  const reasonNoTrade = typeof setup.reasonNoTrade === 'string' ? setup.reasonNoTrade : null;
  const reason = decision === 'TRADE'
    ? null
    : (reasonLabel(gateResults) ?? (blocked !== null ? `${blocked}` : reasonNoTrade));

  return {
    symbol: input.symbol,
    decisionTs: input.decisionTs,
    emitted: decision === 'TRADE',
    reason,
    direction: direction === 'LONG' || direction === 'SHORT' ? direction : null,
    // entry: il replay usa il livello di ingresso effettivo del setup.
    entry: num(setup.entryLevel) ?? num(setup.triggerLevel),
    stop: num(setup.stopLossLevel),
    target: num(setup.target1Level),
    gates,
  };
}
