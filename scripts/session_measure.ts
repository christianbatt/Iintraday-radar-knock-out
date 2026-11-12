#!/usr/bin/env bun
/**
 * scripts/session_measure.ts — Passo H-bis / I4 orchestrato
 *
 * Lancia in sequenza:
 *   1. scripts/latency_probe.ts  (>=90 min consecutivi, coppie .MI vs .XD)
 *   2. scripts/leadlag_probe.ts  (finestra 15:30-17:30 CET, soglia assoluta 0.30)
 * e aggrega i due artefatti in artifacts/session_summary_<data>.json.
 *
 * Vincolo di orario: per avere 90 minuti consecutivi DENTRO la sessione (09:00-17:30
 * CET) il lancio deve avvenire entro le 16:00 CET. Dopo, la coda del campionamento
 * finisce fuori sessione: il probe la esclude dal verdetto, ma la misura si accorcia.
 *
 * Nota di portabilita': e' usato spawnSync di node:child_process (non Bun.spawnSync)
 * perche' i tipi del progetto non includono le API globali di Bun.
 *
 * Exit code:
 *   0 = latenza misurata in sessione (>=20 campioni)
 *   3 = sessione chiusa, nessuna misura tentata
 *   4 = latenza insufficiente (1..19 campioni in sessione)
 *   5 = latenza ok ma lead-lag in errore
 *   1 = errore imprevisto
 *
 * Uso:
 *   bun scripts/session_measure.ts
 *   bun scripts/session_measure.ts --duration=5400 --interval=30
 *   bun scripts/session_measure.ts --skip-leadlag
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const INTERVAL = arg('interval', '30');
const DURATION = arg('duration', '5400');
const PAIRS = arg('pairs', 'ENI.MI:ENIM.XD,UCG.MI:UCGM.XD,STLAM.MI:STLAMM.XD');
const TARGETS = arg('targets', 'ENI.MI,UCG.MI');
const PROXY = arg('proxy', 'EWI');
const RANGE = arg('range', '30d');
const WINDOW = arg('window', '15:30-17:30');
const MIN_ABS_CORR = arg('min-abs-corr', '0.30');
const MIN_DELTA = arg('min-delta', '0.05');
const APP_BASE = arg('app-base', '');
const APP_BODY = arg('app-body', '');
const SKIP_LEADLAG = process.argv.includes('--skip-leadlag');

const DATE = new Date().toISOString().slice(0, 10);
const LAT_OUT = arg('lat-out', `artifacts/latency_${DATE}.jsonl`);
const LAT_SUM = LAT_OUT.replace(/\.jsonl$/, '.summary.json');
const LL_OUT = arg('ll-out', `artifacts/leadlag_${DATE}.json`);
const AGG_OUT = arg('agg-out', `artifacts/session_summary_${DATE}.json`);

const STALE_THRESHOLD_SEC = 300;
const MIN_IN_SESSION = 20;

function romeClock(): { minutes: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    dow: dows.indexOf(get('weekday')),
  };
}

function sessionOpen(): boolean {
  const { minutes, dow } = romeClock();
  return dow >= 1 && dow <= 5 && minutes >= 540 && minutes <= 1050;
}

function minutesToClose(): number {
  const { minutes } = romeClock();
  return 1050 - minutes;
}

function run(cmd: string[]): { code: number; out: string } {
  const p = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
  const code = typeof p.status === 'number' ? p.status : 1;
  const out = `${p.stdout ?? ''}${p.stderr ?? ''}`;
  return { code, out };
}

type Row = Record<string, unknown>;

function readJsonl(path: string): Row[] {
  if (!existsSync(path)) return [];
  const txt = readFileSync(path, 'utf8');
  const out: Row[] = [];
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (typeof v === 'object' && v !== null) out.push(v as Row);
    } catch {
      // riga troncata (processo interrotto): si ignora
    }
  }
  return out;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function round(v: number | null, digits: number): number | null {
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function aggregateLatency(): {
  inSessionSamples: number;
  outSessionSamples: number;
  worstMedianSec: number | null;
  frozen: string[];
  perSymbol: { symbol: string; n: number; medianAgeSec: number | null; distinctPrices: number }[];
  pairs: {
    pair: string;
    n: number;
    medianDeltaSec: number | null;
    minDeltaSec: number | null;
    maxDeltaSec: number | null;
    medianPctDist: number | null;
  }[];
  delayedByObserved: string[];
} {
  const rows = readJsonl(LAT_OUT);
  const samples = rows.filter((r) => str(r.symbol) !== null && r.kind === undefined);
  const pairRows = rows.filter((r) => r.kind === 'pair');

  const inSession = samples.filter((r) => r.sessionOpen === true);
  const outSession = samples.filter((r) => r.sessionOpen === false);

  const symbols = Array.from(new Set(inSession.map((r) => str(r.symbol) ?? ''))).filter(
    (s) => s.length > 0,
  );

  const perSymbol = symbols.map((symbol) => {
    const rowsFor = inSession.filter((r) => str(r.symbol) === symbol);
    const ages = rowsFor.map((r) => num(r.ageSec)).filter((v): v is number => v !== null);
    const prices = new Set(
      rowsFor.map((r) => num(r.lastPrice)).filter((v): v is number => v !== null),
    );
    return {
      symbol,
      n: rowsFor.length,
      medianAgeSec: round(median(ages), 0),
      distinctPrices: prices.size,
    };
  });

  const medians = perSymbol
    .map((r) => r.medianAgeSec)
    .filter((v): v is number => v !== null);
  const worstMedianSec = medians.length > 0 ? Math.max(...medians) : null;
  const frozen = perSymbol.filter((r) => r.distinctPrices === 1 && r.n > 5).map((r) => r.symbol);

  const pairKeys = Array.from(
    new Set(pairRows.map((r) => `${str(r.a) ?? '?'}:${str(r.b) ?? '?'}`)),
  );
  const pairs = pairKeys.map((pair) => {
    const rowsFor = pairRows.filter((r) => `${str(r.a) ?? '?'}:${str(r.b) ?? '?'}` === pair);
    const deltas = rowsFor.map((r) => num(r.deltaSec)).filter((v): v is number => v !== null);
    const dists = rowsFor.map((r) => num(r.pctDist)).filter((v): v is number => v !== null);
    const sorted = [...deltas].sort((a, b) => a - b);
    return {
      pair,
      n: rowsFor.length,
      medianDeltaSec: round(median(deltas), 0),
      minDeltaSec: sorted.length > 0 ? sorted[0] : null,
      maxDeltaSec: sorted.length > 0 ? sorted[sorted.length - 1] : null,
      medianPctDist: round(median(dists), 4),
    };
  });

  const delayedByObserved = Array.from(
    new Set(
      inSession
        .map((r) => num(r.delayedBy))
        .filter((v): v is number => v !== null)
        .map((v) => String(v)),
    ),
  );

  return {
    inSessionSamples: inSession.length,
    outSessionSamples: outSession.length,
    worstMedianSec,
    frozen,
    perSymbol,
    pairs,
    delayedByObserved,
  };
}

function aggregateLeadlag(): {
  ran: boolean;
  proxy: string | null;
  window: string | null;
  targets: {
    symbol: string;
    corr0: number | null;
    bestLagMinutes: number | null;
    bestCorr: number | null;
    corrDelta: number | null;
    trustworthy: boolean;
    divergenceCount: number | null;
  }[];
} {
  if (!existsSync(LL_OUT)) return { ran: false, proxy: null, window: null, targets: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(LL_OUT, 'utf8'));
  } catch {
    return { ran: false, proxy: null, window: null, targets: [] };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ran: false, proxy: null, window: null, targets: [] };
  }
  const obj = parsed as Row;
  const targetsObj = typeof obj.targets === 'object' && obj.targets !== null ? (obj.targets as Row) : {};
  const targets = Object.keys(targetsObj).map((symbol) => {
    const t = targetsObj[symbol];
    const row = typeof t === 'object' && t !== null ? (t as Row) : {};
    return {
      symbol,
      corr0: num(row.corr0),
      bestLagMinutes: num(row.bestLagMinutes),
      bestCorr: num(row.bestCorr),
      corrDelta: num(row.corrDelta),
      trustworthy: row.trustworthy === true,
      divergenceCount: num(row.divergenceCount),
    };
  });
  return {
    ran: true,
    proxy: str(obj.proxy),
    window: str(obj.window),
    targets,
  };
}

function main(): void {
  mkdirSync(dirname(LAT_OUT), { recursive: true });
  mkdirSync(dirname(AGG_OUT), { recursive: true });

  if (!sessionOpen()) {
    console.log('SESSIONE CHIUSA: nessuna misura tentata, nessun numero scritto.');
    console.log('Rilancia fra le 09:00 e le 16:00 CET di un giorno feriale (90 min in sessione).');
    process.exit(3);
  }

  const remaining = minutesToClose();
  const needed = Math.ceil(Number(DURATION) / 60);
  if (remaining < needed) {
    console.log(
      `ATTENZIONE: mancano ${remaining} min alla chiusura, la misura ne richiede ${needed}.`,
    );
    console.log('La coda del campionamento cadra\' fuori sessione e sara\' esclusa dal verdetto.');
  }

  console.log(`=== 1/2 latenza: ${DURATION}s ogni ${INTERVAL}s, coppie ${PAIRS} ===`);
  const latCmd = [
    'bun',
    'scripts/latency_probe.ts',
    `--interval=${INTERVAL}`,
    `--duration=${DURATION}`,
    `--pairs=${PAIRS}`,
    `--out=${LAT_OUT}`,
  ];
  if (APP_BASE.length > 0 && APP_BODY.length > 0) {
    latCmd.push(`--app-base=${APP_BASE}`, `--app-body=${APP_BODY}`);
  }
  const lat = run(latCmd);
  console.log(lat.out.trim());
  console.log(`latency_probe exit: ${lat.code}`);

  let llCode = 0;
  if (SKIP_LEADLAG) {
    console.log('=== 2/2 lead-lag: saltato (--skip-leadlag) ===');
  } else {
    console.log(`=== 2/2 lead-lag: proxy ${PROXY}, target ${TARGETS}, finestra ${WINDOW} ===`);
    const ll = run([
      'bun',
      'scripts/leadlag_probe.ts',
      `--targets=${TARGETS}`,
      `--proxy=${PROXY}`,
      `--range=${RANGE}`,
      `--window=${WINDOW}`,
      `--min-abs-corr=${MIN_ABS_CORR}`,
      `--min-delta=${MIN_DELTA}`,
      `--out=${LL_OUT}`,
    ]);
    console.log(ll.out.trim());
    llCode = ll.code;
    console.log(`leadlag_probe exit: ${llCode}`);
  }

  const latency = aggregateLatency();
  const leadlag = aggregateLeadlag();

  let latencyVerdict: 'material' | 'not-material' | 'insufficient';
  if (latency.inSessionSamples < MIN_IN_SESSION) latencyVerdict = 'insufficient';
  else if (latency.worstMedianSec !== null && latency.worstMedianSec > STALE_THRESHOLD_SEC)
    latencyVerdict = 'material';
  else latencyVerdict = 'not-material';

  const trustworthyTargets = leadlag.targets.filter((t) => t.trustworthy).map((t) => t.symbol);

  let combined: string;
  if (latencyVerdict === 'insufficient') {
    combined = 'NON CONCLUSIVO: campioni in sessione insufficienti, nessuna decisione possibile.';
  } else if (latencyVerdict === 'not-material') {
    combined =
      'RITARDO NON MATERIALE: mediana in sessione entro soglia. Decisione (a) sostenuta dai dati.';
  } else if (trustworthyTargets.length > 0) {
    combined =
      `RITARDO MATERIALE + LAG CREDIBILE su ${trustworthyTargets.join(', ')}: ` +
      'il proxy e\' utilizzabile come rilevatore, valutare (b) guard e (c) sorgente.';
  } else {
    combined =
      'RITARDO MATERIALE ma NESSUN LAG CREDIBILE: il proxy non e\' un rilevatore. ' +
      'Il guard locale (b) resta l\'unica opzione gratuita.';
  }

  const agg = {
    kind: 'session_summary',
    generatedAt: new Date().toISOString(),
    latencyArtifact: LAT_OUT,
    latencySummaryArtifact: existsSync(LAT_SUM) ? LAT_SUM : null,
    leadlagArtifact: existsSync(LL_OUT) ? LL_OUT : null,
    staleThresholdSec: STALE_THRESHOLD_SEC,
    minInSession: MIN_IN_SESSION,
    latency,
    latencyVerdict,
    leadlag,
    trustworthyTargets,
    combinedVerdict: combined,
    exitCodes: { latencyProbe: lat.code, leadlagProbe: llCode },
  };
  writeFileSync(AGG_OUT, `${JSON.stringify(agg, null, 2)}\n`);

  console.log('');
  console.log('=== AGGREGATO ===');
  console.log(`campioni in sessione: ${latency.inSessionSamples}  fuori: ${latency.outSessionSamples}`);
  console.log(`mediana peggiore in sessione: ${latency.worstMedianSec ?? '-'}s (soglia ${STALE_THRESHOLD_SEC}s)`);
  if (latency.frozen.length > 0) {
    console.log(`prezzo invariato in sessione: ${latency.frozen.join(', ')}`);
  }
  for (const p of latency.pairs) {
    console.log(
      `  ${p.pair}: n=${p.n} deltaMed=${p.medianDeltaSec ?? '-'}s ` +
        `[${p.minDeltaSec ?? '-'}..${p.maxDeltaSec ?? '-'}] distMed=${p.medianPctDist ?? '-'}%`,
    );
  }
  if (latency.delayedByObserved.length === 0) {
    console.log('exchangeDataDelayedBy: assente su tutti i campioni in sessione.');
  } else {
    console.log(`exchangeDataDelayedBy osservato: ${latency.delayedByObserved.join(' ')}`);
  }
  for (const t of leadlag.targets) {
    console.log(
      `  ${t.symbol}: corr0=${t.corr0 ?? '-'} lag=${t.bestLagMinutes ?? '-'}min ` +
        `corr=${t.bestCorr ?? '-'} delta=${t.corrDelta ?? '-'} credibile=${t.trustworthy ? 'SI' : 'NO'}`,
    );
  }
  console.log('');
  console.log(`VERDETTO: ${combined}`);
  console.log(`aggregato scritto in ${AGG_OUT}`);

  if (latencyVerdict === 'insufficient') process.exit(4);
  if (!SKIP_LEADLAG && llCode !== 0) process.exit(5);
  process.exit(0);
}

try {
  main();
} catch (e: unknown) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
