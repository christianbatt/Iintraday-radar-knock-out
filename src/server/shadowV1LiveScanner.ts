/**
 * SHADOW V1 LIVE — scanner passivo lato server su tutto il paniere (~40 titoli).
 *
 * Colma l'asimmetria con Shadow V2: mentre il ponte client osserva solo Top-1 EU
 * e Top-1 US a tab aperta e utente autenticato, questo modulo valuta la logica
 * V1 canonica (G1-G13 su `buildExecutionSetup`) per ogni titolo restituito da
 * `/api/market-data`:
 * - ogni setup valido `decision === 'TRADE'` viene inviato al collector
 *   `shadowV1LiveCollector` attraverso la stessa coda serializzata;
 * - i blocchi dei gate e lo stato di scansione sono salvati su disco in
 *   `artifacts/shadow_v1_live/scan_diagnostics.json` cosi' l'utente vede
 *   sempre su quanti titoli sta lavorando V1 e perche' eventualmente non emette.
 *
 * ZERO impatto sul live: funzione passiva, nessun mutamento di `quotes` o UI.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RawQuoteData, SystemParameters } from '../types/radar';
import {
  buildExecutionSetup,
  DEFAULT_SYSTEM_PARAMETERS,
  getDualTopCandidates,
  scoreAllRadarCandidates,
} from '../utils/calculator';
import {
  buildShadowV1LivePayload,
  type ShadowV1LiveBridgePayload,
} from '../utils/shadowV1LiveBridge';
import {
  getShadowV1ActiveBarsEntries,
  isShadowV1LiveCollectEnabled,
  observeShadowV1LiveFromServer,
  runInShadowV1LiveStoreQueue,
  type ObserveResponse,
} from './shadowV1LiveCollector';
import { getActiveMarketsAt } from './shadowMarketScheduler';
import { hasOpenNearMissRecords, updateShadowV1NearMiss } from './shadowV1LiveNearMiss';
import { updateShadowV1LiveMarksOnDisk } from './shadowV1LiveMarks';
import { loadRecords, SHADOW_V1_LIVE_SIGNALS_PATH, shadowV1LiveTmpPath } from './shadowV1LiveStore';
import {
  syncShadowV1ActiveBarsToFirestore,
  syncShadowV1DiagnosticsToFirestore,
  syncShadowV1LiveMarksToFirestore,
} from './shadowFirestoreSync';

export const SHADOW_V1_LIVE_DIAGNOSTICS_PATH = 'artifacts/shadow_v1_live/scan_diagnostics.json';

/**
 * Quanti candidati campione restano nella diagnostica: prima i `TRADE`, poi i
 * top pick bloccati, poi i migliori per score. Il resto resta nei conteggi.
 */
export const SHADOW_V1_LIVE_SCAN_SAMPLE_SIZE = 12;

export interface ShadowV1LiveGateCount {
  gate: string;
  label: string;
  count: number;
}

export interface ShadowV1LiveCandidateDiag {
  ticker: string;
  market: 'EU' | 'US';
  score: number;
  isTopPick: boolean;
  decision: 'TRADE' | 'BLOCKED';
  gate: string | null;
  reason: string | null;
}

export interface ShadowV1LiveScanDiagnostics {
  version: number;
  lastScanAt: string;
  scannedTickers: number;
  evaluatedTickers: number;
  emittedThisScan: number;
  persistedThisScan: number;
  blockedThisScan: number;
  topEU: string | null;
  topUS: string | null;
  gateCounts: ShadowV1LiveGateCount[];
  sampleCandidates: ShadowV1LiveCandidateDiag[];
}

export interface ShadowV1LiveScanOptions {
  rootDir?: string;
  nowMs?: number;
  env?: Record<string, string | undefined>;
  parameters?: SystemParameters;
  observe?: (payload: ShadowV1LiveBridgePayload) => Promise<ObserveResponse | null>;
}

const GATE_LABELS_IT: Record<string, string> = {
  G1: 'Liquidita\' insufficiente',
  G2: 'Dati o barre ORB insufficienti',
  G3: 'In attesa chiusura ORB iniziale',
  G4: 'Prezzo gia\' esteso oltre +0,40%',
  G5: 'Breakout scaduto oltre 60 minuti',
  G6: 'Target T1 gia\' raggiunto',
  G7: 'Range giornaliero ADR esaurito (>60%)',
  G8: 'Stop troppo distante per leva KO',
  G9: 'Nessuna leva/barriera KO sicura',
  G10: 'Stop gia\' toccato dal prezzo attuale',
  G11: 'Punteggio sotto soglia minima',
  G12: 'Target oltre lo spazio ADR residuo',
  G13: 'Dati non freschi (ritardo feed)',
  ADX_BELOW_MARKET_THRESHOLD: 'Veto ADX: trend sotto soglia minima',
  SUPERTREND_OPPOSED: 'Veto Supertrend contrario alla direzione',
  VWAP_OPPOSED: 'Veto VWAP contrario con volumi confermati',
  MARKET_CLOSED_OR_STALE: 'Mercato chiuso o feed in attesa della seduta',
  WARMUP_INCOMPLETE: 'Indicatori 5m ancora in warmup',
  INVALID_PAYLOAD: 'Livelli incoerenti o incompleti',
  CALENDAR_SELECTOR: 'Blocco filtro calendario/orario',
};

function labelForGate(gate: string, fallback?: string): string {
  return GATE_LABELS_IT[gate] ?? fallback ?? gate;
}

function extractFuturesMapping(futuresData: any): { EU: number; US: number } {
  const eu =
    typeof futuresData?.europe?.dax?.changePercent === 'number'
      ? futuresData.europe.dax.changePercent
      : typeof futuresData?.europe?.eurostoxx?.changePercent === 'number'
      ? futuresData.europe.eurostoxx.changePercent
      : 0;
  const us =
    typeof futuresData?.usa?.sp500?.changePercent === 'number'
      ? futuresData.usa.sp500.changePercent
      : typeof futuresData?.usa?.nasdaq?.changePercent === 'number'
      ? futuresData.usa.nasdaq.changePercent
      : 0;
  return { EU: eu, US: us };
}

function writeDiagnosticsAtomic(filePath: string, payload: ShadowV1LiveScanDiagnostics): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = shadowV1LiveTmpPath(filePath);
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Valuta tutti i candidati dell'ultima scansione `/api/market-data` secondo le
 * regole canoniche V1 (G1-G13), persiste ogni setup `TRADE` nel collector e
 * aggiorna la diagnostica dei blocchi su `scan_diagnostics.json`.
 */
export async function observeShadowV1LiveScan(
  quotes: readonly RawQuoteData[],
  futuresData: unknown = null,
  options: ShadowV1LiveScanOptions = {}
): Promise<ShadowV1LiveScanDiagnostics | null> {
  const env = options.env ?? process.env;
  if (!isShadowV1LiveCollectEnabled(env)) return null;

  try {
    const rootDir = options.rootDir ?? process.cwd();
    const nowMs = options.nowMs ?? Date.now();
    const nowDate = new Date(nowMs);
    const parameters = options.parameters ?? DEFAULT_SYSTEM_PARAMETERS;
    const observe =
      options.observe ??
      ((payload: ShadowV1LiveBridgePayload) => observeShadowV1LiveFromServer(payload));

    const validQuotes = quotes.filter(
      (q) => q && typeof q.ticker === 'string' && q.ticker.trim().length > 0 && (q.market === 'EU' || q.market === 'US')
    );
    const futuresMapping = extractFuturesMapping(futuresData);

    const dual = getDualTopCandidates([...validQuotes], futuresMapping, {
      rsiFilterActive: false,
      parameters,
    });
    const allScored = scoreAllRadarCandidates([...validQuotes], futuresMapping, {
      rsiFilterActive: false,
      parameters,
    });

    const topEU = dual.topEU?.quote?.ticker ?? null;
    const topUS = dual.topUS?.quote?.ticker ?? null;

    const gateMap = new Map<string, { label: string; count: number }>();
    const bumpGate = (gate: string, fallbackReason?: string) => {
      const prev = gateMap.get(gate);
      if (prev) prev.count += 1;
      else gateMap.set(gate, { label: labelForGate(gate, fallbackReason), count: 1 });
    };

    let emittedThisScan = 0;
    let persistedThisScan = 0;
    let blockedThisScan = 0;

    const candidateDiags: ShadowV1LiveCandidateDiag[] = [];
    const payloadsToSend: ShadowV1LiveBridgePayload[] = [];
    const nearMissPairs: Array<{ cand: typeof allScored[number]; setup: ReturnType<typeof buildExecutionSetup> }> = [];

    for (const cand of allScored) {
      const ticker = cand.quote.ticker;
      const market = cand.quote.market;
      const isTopPick = ticker === topEU || ticker === topUS;

      if (cand.score.warmupIncomplete) {
        blockedThisScan += 1;
        const ind = cand.quote.setupIndicators;
        const reasons = [
          ind?.atr?.reason,
          ind?.supertrend?.reason,
          ind?.adx?.reason,
          ind?.stochRsi?.reason,
        ];
        const isClosedOrStale = reasons.some((r) => r === 'STALE' || r === 'AFTER_HOURS');
        const gateKey = isClosedOrStale ? 'MARKET_CLOSED_OR_STALE' : 'WARMUP_INCOMPLETE';
        bumpGate(gateKey);
        candidateDiags.push({
          ticker,
          market,
          score: cand.score.total,
          isTopPick,
          decision: 'BLOCKED',
          gate: gateKey,
          reason: labelForGate(gateKey),
        });
        continue;
      }

      const setup = buildExecutionSetup(cand, null, market, parameters, {
        currentTime: nowDate,
      });

      if (cand.score.veto != null) {
        blockedThisScan += 1;
        const gateKey = cand.score.veto;
        bumpGate(gateKey);
        nearMissPairs.push({ cand, setup });
        candidateDiags.push({
          ticker,
          market,
          score: cand.score.total,
          isTopPick,
          decision: 'BLOCKED',
          gate: gateKey,
          reason: labelForGate(gateKey),
        });
        continue;
      }

      if (setup.decision === 'TRADE') {
        const payload = buildShadowV1LivePayload(setup);
        if (payload) {
          emittedThisScan += 1;
          payloadsToSend.push(payload);
          candidateDiags.push({
            ticker,
            market,
            score: cand.score.total,
            isTopPick,
            decision: 'TRADE',
            gate: null,
            reason: null,
          });
          continue;
        }
        blockedThisScan += 1;
        bumpGate('INVALID_PAYLOAD');
        candidateDiags.push({
          ticker,
          market,
          score: cand.score.total,
          isTopPick,
          decision: 'BLOCKED',
          gate: 'INVALID_PAYLOAD',
          reason: GATE_LABELS_IT.INVALID_PAYLOAD,
        });
        continue;
      }

      blockedThisScan += 1;
      nearMissPairs.push({ cand, setup });
      const gateKey = setup.blockedGate ?? 'CALENDAR_SELECTOR';
      bumpGate(gateKey, setup.reasonNoTrade);
      candidateDiags.push({
        ticker,
        market,
        score: cand.score.total,
        isTopPick,
        decision: 'BLOCKED',
        gate: gateKey,
        reason: labelForGate(gateKey, setup.reasonNoTrade),
      });
    }

    for (const payload of payloadsToSend) {
      try {
        const resp = await observe(payload);
        if (resp && resp.status === 200 && resp.body?.persisted === true) {
          persistedThisScan += 1;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[Shadow V1 Live Scanner] invio interno ${payload.ticker}: ${message}`);
      }
    }

    const activeMarkets = getActiveMarketsAt(nowMs);
    if ((activeMarkets.length > 0 && nearMissPairs.length > 0) || hasOpenNearMissRecords(rootDir)) {
      updateShadowV1NearMiss({
        candidates: activeMarkets.length > 0 ? nearMissPairs : [],
        parameters,
        quotes: validQuotes,
        rootDir,
        nowMs,
      });
    }

    const gateCounts: ShadowV1LiveGateCount[] = Array.from(gateMap.entries())
      .map(([gate, info]) => ({ gate, label: info.label, count: info.count }))
      .sort((a, b) => b.count - a.count || a.gate.localeCompare(b.gate));

    const prioritized = [
      ...candidateDiags.filter((c) => c.decision === 'TRADE'),
      ...candidateDiags.filter((c) => c.decision !== 'TRADE' && c.isTopPick),
      ...candidateDiags
        .filter((c) => c.decision !== 'TRADE' && !c.isTopPick)
        .sort((a, b) => b.score - a.score),
    ].slice(0, SHADOW_V1_LIVE_SCAN_SAMPLE_SIZE);

    const diagnostics: ShadowV1LiveScanDiagnostics = {
      version: 1,
      lastScanAt: nowDate.toISOString(),
      scannedTickers: validQuotes.length,
      evaluatedTickers: allScored.length,
      emittedThisScan,
      persistedThisScan,
      blockedThisScan,
      topEU,
      topUS,
      gateCounts,
      sampleCandidates: prioritized,
    };

    const diagnosticsPath = path.join(rootDir, SHADOW_V1_LIVE_DIAGNOSTICS_PATH);
    // Fuori orario di borsa (notte/weekend/festivi), evita di sovrascrivere la
    // diagnostica reale dell'ultima sessione con falsi blocchi MARKET_CLOSED_OR_STALE.
    const shouldPreserveLastSessionDiag =
      activeMarkets.length === 0 &&
      emittedThisScan === 0 &&
      fs.existsSync(diagnosticsPath);

    if (!shouldPreserveLastSessionDiag) {
      writeDiagnosticsAtomic(diagnosticsPath, diagnostics);
      void syncShadowV1DiagnosticsToFirestore(diagnostics);
    }

    await runInShadowV1LiveStoreQueue(async () => {
      const marksPayload = updateShadowV1LiveMarksOnDisk(validQuotes, { rootDir, nowMs });
      if (marksPayload) {
        void syncShadowV1LiveMarksToFirestore(marksPayload);
      }
      const signalsPath = path.join(rootDir, SHADOW_V1_LIVE_SIGNALS_PATH);
      if (fs.existsSync(signalsPath)) {
        const currentRecords = loadRecords(signalsPath).records;
        const openTickers = new Set(
          currentRecords
            .filter((r) => r.status === 'PENDING_FILL' || r.status === 'OPEN')
            .map((r) => r.ticker)
        );
        if (openTickers.size > 0) {
          void syncShadowV1ActiveBarsToFirestore(getShadowV1ActiveBarsEntries(openTickers));
        }
      }
    });
    return diagnostics;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Shadow V1 Live Scanner] errore non bloccante: ${message}`);
    return null;
  }
}
