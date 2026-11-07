import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApps as getFirebaseAdminApps, initializeApp as initializeFirebaseAdminApp } from 'firebase-admin/app';
import { getFirestore as getFirebaseAdminFirestore } from 'firebase-admin/firestore';
import { ExcludedSetupRecord, TradeJournalEntry } from '../src/types/radar';
import { LearningResult, validateLearningPattern } from '../src/utils/learningValidator';
import { updateAIMemory } from '../src/utils/memoryUpdater';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHARED_STATE_FILE = path.join(SCRIPT_DIR, '..', 'shared_radar_state.json');
const AI_MEMORY_FILE = path.join(SCRIPT_DIR, '..', 'ai_specialization_memory.json');

interface SharedState {
  journalEntries?: TradeJournalEntry[];
  excludedRecords?: ExcludedSetupRecord[];
}

interface PatternGroup {
  trades: TradeJournalEntry[];
  excluded: ExcludedSetupRecord[];
  topic: string;
  market: 'EU' | 'US' | 'GLOBAL';
  contextKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadSharedStateFromDisk(filePath: string): SharedState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed)) return { journalEntries: [], excludedRecords: [] };

    const state = { journalEntries: [] as TradeJournalEntry[], excludedRecords: [] as ExcludedSetupRecord[] };
    const userStates = isRecord(parsed.users)
      ? Object.entries(parsed.users)
      : [['legacy', parsed] as [string, unknown]];

    for (const [userId, value] of userStates) {
      if (!isRecord(value)) continue;
      if (Array.isArray(value.journalEntries)) {
        state.journalEntries.push(...(value.journalEntries as TradeJournalEntry[]).map((trade) => ({
          ...trade,
          id: `${userId}:${trade.id}`,
        })));
      }
      if (Array.isArray(value.excludedRecords)) {
        state.excludedRecords.push(...(value.excludedRecords as ExcludedSetupRecord[]).map((record) => ({
          ...record,
          id: `${userId}:${record.id}`,
        })));
      }
    }
    return state;
  } catch {
    return { journalEntries: [], excludedRecords: [] };
  }
}

async function loadSharedStateFromFirestore(): Promise<SharedState> {
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.VITE_FIREBASE_PROJECT_ID;
  if (!projectId) return { journalEntries: [], excludedRecords: [] };

  try {
    const adminApp = getFirebaseAdminApps().find((candidate) => candidate.options.projectId === projectId) ||
      initializeFirebaseAdminApp({ projectId }, 'nightly-learning');
    const databaseId = process.env.FIRESTORE_DATABASE_ID || '(default)';
    const database = getFirebaseAdminFirestore(adminApp, databaseId);
    const [tradesSnapshot, excludedSnapshot] = await Promise.all([
      database.collectionGroup('trades').get(),
      database.collectionGroup('excludedSetups').get(),
    ]);

    const journalEntries = tradesSnapshot.docs.map((document) => {
      const userId = document.ref.parent.parent?.id || 'unknown-user';
      return { ...document.data(), id: `${userId}:${document.id}` } as TradeJournalEntry;
    });
    const excludedRecords = excludedSnapshot.docs.map((document) => {
      const userId = document.ref.parent.parent?.id || 'unknown-user';
      return { ...document.data(), id: `${userId}:${document.id}` } as ExcludedSetupRecord;
    });
    return { journalEntries, excludedRecords };
  } catch (error) {
    console.warn('[Nightly Learning] Firestore non disponibile; uso stato locale:', error);
    return { journalEntries: [], excludedRecords: [] };
  }
}

export async function loadSharedState(filePath = SHARED_STATE_FILE): Promise<SharedState> {
  const localState = loadSharedStateFromDisk(filePath);
  const firestoreState = await loadSharedStateFromFirestore();
  const journalById = new Map<string, TradeJournalEntry>();
  const excludedById = new Map<string, ExcludedSetupRecord>();
  localState.journalEntries?.forEach((trade) => journalById.set(trade.id, trade));
  firestoreState.journalEntries?.forEach((trade) => journalById.set(trade.id, trade));
  localState.excludedRecords?.forEach((record) => excludedById.set(record.id, record));
  firestoreState.excludedRecords?.forEach((record) => excludedById.set(record.id, record));
  return {
    journalEntries: Array.from(journalById.values()),
    excludedRecords: Array.from(excludedById.values()),
  };
}

function sessionWindow(timestamp: string, market: 'EU' | 'US' | 'GLOBAL'): string {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) return 'UNKNOWN_TIME';
  const timeZone = market === 'US' ? 'America/New_York' : 'Europe/Rome';
  const hourPart = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(parsed).find((part) => part.type === 'hour')?.value;
  const hour = Number(hourPart);
  return Number.isFinite(hour) && hour < 12 ? 'MORNING' : 'AFTERNOON';
}

function marketForTrade(trade: TradeJournalEntry): 'EU' | 'US' | 'GLOBAL' {
  return trade.market || trade.session || 'GLOBAL';
}

function contextKey(market: string, direction: string, window: string): string {
  return `${market}_${direction}_${window}`;
}

function deriveTopic(trade: TradeJournalEntry): { topic: string; market: 'EU' | 'US' | 'GLOBAL'; contextKey: string } {
  const market = marketForTrade(trade);
  const window = sessionWindow(trade.timestamp, market);
  const strategy = trade.strategy.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return {
    topic: `${strategy}_${trade.direction}_${window}_${market}`,
    market,
    contextKey: contextKey(market, trade.direction, window),
  };
}

export function groupByTopic(
  trades: TradeJournalEntry[],
  excluded: ExcludedSetupRecord[]
): Map<string, PatternGroup> {
  const groups = new Map<string, PatternGroup>();
  const excludedByContext = new Map<string, ExcludedSetupRecord[]>();

  for (const record of excluded) {
    if (
      record.outcomeStatus === 'MONITORING' ||
      record.outcomeStatus === 'INSUFFICIENT_DATA' ||
      typeof record.theoreticalRMultiple !== 'number' ||
      !Number.isFinite(record.theoreticalRMultiple)
    ) continue;

    const market = record.market || 'GLOBAL';
    const window = sessionWindow(record.timestamp, market);
    const key = contextKey(market, record.direction, window);
    const records = excludedByContext.get(key) || [];
    records.push(record);
    excludedByContext.set(key, records);
  }

  for (const trade of trades) {
    if (trade.status === 'OPEN') continue;
    const derived = deriveTopic(trade);
    const group = groups.get(derived.topic) || {
      trades: [],
      excluded: [],
      topic: derived.topic,
      market: derived.market,
      contextKey: derived.contextKey,
    };
    group.trades.push(trade);
    groups.set(derived.topic, group);
  }

  for (const [topic, group] of groups) {
    group.excluded = excludedByContext.get(group.contextKey) || [];
    groups.set(topic, group);
  }

  return groups;
}

export function benjaminiHochberg(pValues: number[]): number[] {
  const adjusted = new Array<number>(pValues.length).fill(1);
  const ordered = pValues
    .map((pValue, index) => ({ pValue: Math.min(1, Math.max(0, pValue)), index }))
    .sort((left, right) => left.pValue - right.pValue);

  let runningMinimum = 1;
  for (let index = ordered.length - 1; index >= 0; index--) {
    const rank = index + 1;
    runningMinimum = Math.min(runningMinimum, (ordered[index].pValue * ordered.length) / rank);
    adjusted[ordered[index].index] = Math.min(1, runningMinimum);
  }
  return adjusted;
}

export async function runNightlyLearning(dryRun = false): Promise<LearningResult[]> {
  console.log('[Nightly Learning] Avvio...');
  const state = await loadSharedState();
  const completedTrades = (state.journalEntries || []).filter((trade) =>
    trade.status !== 'OPEN' &&
    (trade.outcome === 'WIN' || trade.outcome === 'LOSS' || trade.outcome === 'BREAKEVEN' || trade.outcome === 'EXPIRED')
  );
  const resolvedExcluded = (state.excludedRecords || []).filter((record) =>
    record.outcomeStatus !== 'MONITORING' && record.outcomeStatus !== 'INSUFFICIENT_DATA'
  );
  console.log(
    `[Nightly Learning] Trade completati: ${completedTrades.length}, esclusi controfattuali risolti: ${resolvedExcluded.length}`
  );

  const candidates: LearningResult[] = [];
  const groups = Array.from(groupByTopic(completedTrades, resolvedExcluded).values());
  for (const group of groups) {
    // IPOTESI: i controfattuali arrivano dal raggruppamento per mercato+direzione+finestra
    // (condivisi fra i topic della stessa chiave) e T = numero di ipotesi testate stanotte.
    // Entrambi sono campi informativi: non entrano nei filtri né nelle scritture di memoria.
    const result = validateLearningPattern(group.trades, group.excluded, group.topic, group.market, {
      counterfactualShared: true,
      dsrTrials: groups.length,
    });
    if (result) candidates.push(result);
  }

  const adjustedPValues = benjaminiHochberg(candidates.map((result) => result.stats.pValue));
  const validated = candidates
    .map((result, index) => ({
      ...result,
      confidence: 1 - adjustedPValues[index],
      stats: { ...result.stats, adjustedPValue: adjustedPValues[index] },
    }))
    .filter((result) =>
      result.stats.adjustedPValue < 0.05 &&
      result.stats.avgR > 0 &&
      result.stats.profitFactor > 1
    );

  console.log(`[Nightly Learning] Pattern validati dopo FDR: ${validated.length}/${candidates.length}`);
  if (!dryRun && validated.length > 0) {
    updateAIMemory(validated, AI_MEMORY_FILE);
    console.log('[Nightly Learning] Memoria aggiornata con pattern supportati da trade reali');
  } else if (dryRun) {
    console.log('[Nightly Learning] Dry-run: nessuna scrittura eseguita');
  }
  return validated;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runNightlyLearning(process.argv.includes('--dry-run'))
    .then((results) => {
      console.log('[Nightly Learning] Completato:', results.length, 'pattern validati');
    })
    .catch((error: unknown) => {
      console.error('[Nightly Learning] Errore:', error);
      process.exitCode = 1;
    });
}
