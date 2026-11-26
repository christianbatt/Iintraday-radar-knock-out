/**
 * Verifica live degli endpoint AI desk con AI_DESK_EVIDENCE=1.
 *
 * Cosa fa, in ordine:
 * 1. controlla che ci sia una chiave modello (`OPENROUTER_API_KEY` o
 *    `GEMINI_API_KEY`). Se manca si ferma con un messaggio chiaro ed exit 2:
 *    non avvia nulla e non produce risultati finti;
 * 2. avvia `tsx server.ts` con il flag acceso su una porta libera e una chiave
 *    di servizio temporanea (`VALID_API_KEYS`, solo in memoria del processo);
 * 3. chiama `POST /api/ai/specialize` e `POST /api/ai/desk-post-mortem` con un
 *    diario deterministico di 6 trade (label nei risultati: dati di prova);
 * 4. per ciascun endpoint stampa `directives` con i loro `evidenceRefs`, la
 *    `summary` con `summaryDeclaredRefs`/`summaryVerified`, i codici di scarto;
 * 5. spegne il server e chiude con exit 0 se entrambi hanno risposto, 1 se no.
 *
 * Uso:
 *   npx tsx scripts/ai_desk_live_check.ts
 *   npx tsx scripts/ai_desk_live_check.ts --json   # dump del deskAnalysis grezzo
 *
 * Nessun segreto viene stampato: delle chiavi si dice solo se sono presenti.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const KEY_VARS = ['OPENROUTER_API_KEY', 'GEMINI_API_KEY'] as const;
const READY_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 180_000;

const SAMPLE_TRADES = [
  {
    id: 'lc-1',
    timestamp: '2026-11-20T08:12:00.000Z',
    date: '2026-11-20',
    session: 'EU',
    market: 'EU',
    ticker: 'ENI.MI',
    direction: 'LONG',
    strategy: 'ORB',
    entryPrice: 14.2,
    exitPrice: 14.62,
    stopLoss: 13.98,
    target1: 14.62,
    pnlEur: 126,
    rMultiple: 1.9,
    outcome: 'WIN',
    notes: 'rottura del massimo di apertura con volume',
    isPaper: false,
  },
  {
    id: 'lc-2',
    timestamp: '2026-11-20T09:05:00.000Z',
    date: '2026-11-20',
    session: 'EU',
    market: 'EU',
    ticker: 'ISP.MI',
    direction: 'SHORT',
    strategy: 'PULLBACK',
    entryPrice: 5.72,
    exitPrice: 5.7615,
    stopLoss: 5.7615,
    target1: 5.62,
    pnlEur: -84,
    rMultiple: -1,
    outcome: 'LOSS',
    notes: 'rientro contro il SuperTrend',
    isPaper: false,
  },
  {
    id: 'lc-3',
    timestamp: '2026-11-21T08:20:00.000Z',
    date: '2026-11-21',
    session: 'EU',
    market: 'EU',
    ticker: 'UCG.MI',
    direction: 'LONG',
    strategy: 'BREAKOUT',
    entryPrice: 76.4,
    exitPrice: 77.2,
    stopLoss: 75.9,
    target1: 77.2,
    pnlEur: 160,
    rMultiple: 1.6,
    outcome: 'WIN',
    notes: 'gap di apertura tenuto',
    isPaper: true,
  },
  {
    id: 'lc-4',
    timestamp: '2026-11-21T14:40:00.000Z',
    date: '2026-11-21',
    session: 'US',
    market: 'US',
    ticker: 'AAPL',
    direction: 'LONG',
    strategy: 'VWAP_RECLAIM',
    entryPrice: 231.4,
    exitPrice: 231.4,
    stopLoss: 229.8,
    target1: 234.6,
    pnlEur: 0,
    rMultiple: 0,
    outcome: 'BREAKEVEN',
    notes: 'uscita a tempo prima della chiusura',
    isPaper: true,
  },
  {
    id: 'lc-5',
    timestamp: '2026-11-22T15:10:00.000Z',
    date: '2026-11-22',
    session: 'US',
    market: 'US',
    ticker: 'NVDA',
    direction: 'SHORT',
    strategy: 'FAILED_BREAKOUT',
    entryPrice: 178.2,
    exitPrice: 175.1,
    stopLoss: 179.4,
    target1: 175.1,
    pnlEur: 240,
    rMultiple: 2.58,
    outcome: 'WIN',
    notes: 'falso breakout respinto dalla media',
    isPaper: false,
  },
  {
    id: 'lc-6',
    timestamp: '2026-11-22T15:35:00.000Z',
    date: '2026-11-22',
    session: 'US',
    market: 'US',
    ticker: 'TSLA',
    direction: 'LONG',
    strategy: 'ORB',
    entryPrice: 412.5,
    exitPrice: 412.5,
    stopLoss: 408.1,
    target1: 421.3,
    pnlEur: 0,
    rMultiple: 0,
    outcome: 'EXPIRED',
    notes: 'nessun follow-through',
    isPaper: true,
  },
];

const KEEP_RAW = process.argv.includes('--json');

function missingKeyMessage(): string {
  return [
    'Chiave modello assente: impossibile eseguire i due endpoint contro un modello reale.',
    '',
    `Servono ${KEY_VARS.join(' oppure ')} nell ambiente di questo processo.`,
    'Come impostarle, senza scriverle in chat ne in file tracciati:',
    '  - Cloud / secret del progetto: aggiungi la variabile e rilancia questo script;',
    '  - locale: esportala nella shell o mettila in un .env non versionato.',
    '',
    `Variabili opzionali: OPENROUTER_PRIMARY_MODEL, OPENROUTER_FALLBACK_MODEL.`,
    'Nessuna richiesta e nessun server sono stati avviati.',
  ].join('\n');
}

function hasModelKey(): boolean {
  return KEY_VARS.some((name) => (process.env[name] || '').trim().length > 0);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(port: number, child: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server terminato prima di essere pronto (exit ${child.exitCode})\n${logs.slice(-40).join('')}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/shadow/v1-live/signals`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.status < 500) return;
    } catch {
      // non ancora in ascolto
    }
    await wait(700);
  }
  throw new Error(`server non pronto entro ${READY_TIMEOUT_MS / 1000}s\n${logs.slice(-40).join('')}`);
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 2000) };
  }
  return { status: res.status, json };
}

function formatEndpointReport(label: string, status: number, payload: any): string[] {
  const out: string[] = [];
  out.push(`\n=== ${label} (HTTP ${status}) ===`);
  const analysis = payload?.deskAnalysis;
  if (!analysis) {
    out.push('deskAnalysis: ASSENTE nella risposta (flag non attivo o errore prima della validazione).');
    if (payload?.error) out.push(`errore API: ${String(payload.error)}`);
    return out;
  }
  if (analysis.available !== true) {
    out.push(`deskAnalysis NON disponibile: ${String(analysis.error ?? 'motivo non dichiarato')}`);
    return out;
  }
  const a = analysis.analysis ?? {};
  const directives: any[] = Array.isArray(a.proposedDirectives) ? a.proposedDirectives : [];
  const rejected: any[] = Array.isArray(a.rejected) ? a.rejected : [];

  out.push(`fascicolo: ${analysis.evidenceKeys ?? '?'} chiavi, sezioni mancanti: ${JSON.stringify(analysis.missingSections ?? [])}`);
  out.push('');
  out.push(`summaryVerified: ${String(a.summaryVerified)}   verified: ${String(a.verified)}   complete: ${String(a.complete)}`);
  out.push(`summaryDeclaredRefs: ${JSON.stringify(a.summaryDeclaredRefs ?? [])}`);
  out.push(`summaryEvidenceRefs: ${JSON.stringify(a.summaryEvidenceRefs ?? [])}`);
  out.push(`summaryUnsupportedNumbers: ${JSON.stringify(a.summaryUnsupportedNumbers ?? [])}`);
  out.push(`summary: ${String(a.summary ?? '').slice(0, 600)}`);
  out.push('');

  if (directives.length === 0) {
    out.push('direttive valide: 0');
  } else {
    out.push(`direttive valide: ${directives.length}`);
    directives.forEach((d, i) => {
      const refs = Array.isArray(d.evidenceRefs) ? d.evidenceRefs : [];
      out.push(`  [${i + 1}] ${String(d.topic ?? '?')} / ${String(d.predicateId ?? '?')} -> ${String(d.directive ?? '').slice(0, 200)}`);
      out.push(`      evidenceRefs: ${JSON.stringify(refs)}${refs.length === 0 ? '  <-- VUOTI' : ''}`);
    });
  }

  if (rejected.length > 0) {
    const byCode: Record<string, number> = {};
    for (const r of rejected) byCode[String(r.code)] = (byCode[String(r.code)] || 0) + 1;
    out.push(`scarti: ${rejected.length} ${JSON.stringify(byCode)}`);
    for (const r of rejected.slice(0, 5)) {
      out.push(`  - ${String(r.code)}: ${String(r.detail ?? r.statement ?? '').slice(0, 160)}`);
    }
  } else {
    out.push('scarti: 0');
  }
  return out;
}

async function main(): Promise<number> {
  if (!hasModelKey()) {
    console.error(missingKeyMessage());
    return 2;
  }

  const port = 3700 + Math.floor(Math.random() * 200);
  const apiKey = `live-check-${Math.random().toString(36).slice(2)}`;
  const base = `http://127.0.0.1:${port}`;
  const logs: string[] = [];

  console.log('Modello: chiave presente (valore non mostrato).');
  console.log(`Server: tsx server.ts su :${port}, AI_DESK_EVIDENCE=1.`);

  const child = spawn(process.execPath, ['--import', 'tsx', path.join(process.cwd(), 'server.ts')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AI_DESK_EVIDENCE: '1',
      PORT: String(port),
      VALID_API_KEYS: apiKey,
      DISABLE_AUTO_MARKET_SCAN: 'true',
      NODE_ENV: process.env.NODE_ENV || 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)));

  let exitCode = 1;
  try {
    await waitForServer(port, child, logs);
    console.log('Server pronto: chiamata a /api/ai/specialize...');
    const specialize = await postJson(`${base}/api/ai/specialize`, apiKey, {
      trades: SAMPLE_TRADES,
      excluded: [],
    });
    console.log('Chiamata a /api/ai/desk-post-mortem...');
    const desk = await postJson(`${base}/api/ai/desk-post-mortem`, apiKey, {
      market: 'GLOBAL',
      trades: SAMPLE_TRADES,
    });

    const lines = [
      '',
      'Dati: 6 trade sintetici deterministici (dati di prova, non operazioni reali).',
      ...formatEndpointReport('/api/ai/specialize', specialize.status, specialize.json),
      ...formatEndpointReport('/api/ai/desk-post-mortem', desk.status, desk.json),
    ];
    console.log(lines.join('\n'));

    if (KEEP_RAW) {
      console.log('\n=== deskAnalysis grezzo ===');
      console.log(
        JSON.stringify(
          {
            specialize: specialize.json?.deskAnalysis ?? null,
            desk: desk.json?.deskAnalysis ?? null,
          },
          null,
          2
        )
      );
    }

    exitCode = specialize.status < 400 && desk.status < 400 ? 0 : 1;
  } catch (err) {
    console.error('Verifica live non riuscita:', err instanceof Error ? err.message : String(err));
    exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await wait(1500);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  return exitCode;
}

main().then((code) => {
  process.exitCode = code;
});
