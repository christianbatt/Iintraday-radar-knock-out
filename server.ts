import express, { NextFunction, Request, Response } from 'express';
import { registerShadowRoutesFromDisk } from './src/server/shadowRoute';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import { getApps as getFirebaseAdminApps, initializeApp as initializeFirebaseAdminApp } from 'firebase-admin/app';
import { getAuth as getFirebaseAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getFirebaseAdminFirestore } from 'firebase-admin/firestore';
import {
  filterCompletedBars,
  calculateAtr14FromBars,
  calculateAdr14FromBars,
  calculateLiqEurFromBars,
  calculateOrbFromIntradayBars,
  calculateOrbRvolFromBars,
  DailyBarInput,
  IntradayCandleInput,
  computeSessionVwap,
  computeVwapState,
  calculateAtr5m,
  VwapBar,
} from './src/utils/calculator';
import { computeVwapDataQuality, formatVwapDataQualityScan, calculateCandidateScore, adxThresholds } from './src/utils/calculator';
import { computeSetupIndicators, filterRegularSessionBars, loadWarmupBars, selectWarmupBars, WarmupSeriesResult } from './src/utils/indicators';
import { getExchangeDateStr, getMarketTime } from './src/utils/timezone';
import { TRADING_PARAMS } from './src/config/tradingParams';
import { VWAP_PROMPT_BLOCK } from './src/config/vwapPrompt';
import { SETUP_PROMPT_BLOCK } from './src/config/setupPrompt';
import { AILearnedInsight, VwapSignalState, VwapDataQuality, SetupIndicators, IndicatorBarInput } from './src/types/radar';
import { runNightlyLearning } from './scripts/nightly_learning';
import {
  MIN_REAL_TRADE_SAMPLE,
  LEARNING_PREDICATE_IDS,
  isLearningPredicateId,
  scanLearningPredicates,
  LearningResult,
} from './src/utils/learningValidator';
import { updateAIMemory } from './src/utils/memoryUpdater';
import { buildCanonicalSample } from './src/server/canonicalTradeSample';
import {
  AI_MEMORY_REVOCATION_LOG_RELATIVE_PATH,
  appendRevocationLog,
  buildMemoryPromptBlock,
  renewRulesForPassingPredicates,
  revokeRulesForFailedPredicates,
  selectActiveRules,
} from './src/server/aiMemoryLifecycle';
import {
  aiMemoryFirestorePath,
  aiMemoryLocalFileName,
  computeDatasetHash,
  filterMemoryForUser,
  isScopedMemoryUid,
  migrateLegacyMemory,
} from './src/server/aiMemoryScope';
import { resolveSpecializationOutcome } from './src/utils/specializationReason';
import {
  safeAppendAiShadowLog,
  buildAiShadowLogResponse,
  buildScanCandidateEntries,
  AI_SHADOW_LOG_RELATIVE_PATH,
  AI_SHADOW_SCAN_LOG_RELATIVE_PATH,
  buildAiShadowLogResponseWithFallback,
  readAiShadowLogFallbackDetailed,
} from './src/server/aiShadowLog';
import {
  setLastScanCandidates,
  getLastScanCandidates,
  getLastScanRunId,
  getLastScanTimestampMs,
  evaluateScanCandidates,
  resolveScanCandidateInput,
  consumeHandlerScanInput,
  resetHandlerScanInput,
  createScanRunIdHandle,
  beginScanRun,
  type ScanRunIdHandle,
  buildNoCandidateEntry,
  applyScanGateDiagnostics,
  AI_SHADOW_BATCH_SIZE,
  AI_SHADOW_SCAN_PROMPT_VERSION,
} from './src/server/aiScanEvaluation';

// ADDITIVO (v9, Parte 3.2): enum dei predicati esposto alla LLM.
const LEARNING_PREDICATE_PROMPT = `predicateId ∈ { ${LEARNING_PREDICATE_IDS.join(' | ')} }`;
import { authStartupWarning } from './src/utils/authStartupWarning';
import { recordClosedBarsForShadowV2, observeShadowV2Scan, saveShadowV2BarsToDisk, syncShadowV2SummaryFromDisk } from './src/server/shadowV2Collector';
import {
  flushShadowV1LiveBarsToDisk,
  recordBarsForShadowV1Live,
  registerShadowV1LiveCollector,
  shadowV1LiveBodyLimitErrorHandler,
  shadowV1LiveBodyLimitParser,
  SHADOW_V1_LIVE_BARS_PATH,
  SHADOW_V1_LIVE_OBSERVE_PATH,
} from './src/server/shadowV1LiveCollector';
import {
  createAdminFirestoreAdapter,
  flushPendingShadowFirestoreSync,
  hydrateAllShadowStateFromFirestore,
  setShadowFirestoreAdapter,
} from './src/server/shadowFirestoreSync';
import { registerShadowV1LiveViewRoute } from './src/server/shadowV1LiveView';
import { apiAuthErrorMessage, resolveApiAuth, type ApiAuthResolution } from './src/server/apiAuth';
import { loadRecords, SHADOW_V1_LIVE_SIGNALS_PATH } from './src/server/shadowV1LiveStore';
import {
  barsAroundFill,
  createShadowV1LiveBarsOnce,
  loadShadowV1LiveBarsByTicker,
  type ShadowV1LiveCostBarsByTicker,
} from './src/server/aiTradeCostBars';
// P10: budget e retry delle chiamate LLM, dichiarati in un solo modulo.
import {
  AI_LLM_ENDPOINT_MAX_TOKENS,
  AI_LLM_RETRY_MAX_ATTEMPTS,
  aiLlmRetryRequest,
  isRetryableLlmStatus,
  openAiLlmRequest,
  parseRetryAfterMs,
  runWithLlmRetry,
  type AiLlmEndpoint,
  type AiLlmRequestBudget,
} from './src/server/aiLlmBudget';
import { AI_LLM_SCHEMAS, validateAiLlmObject } from './src/server/aiLlmResponseSchema';
import { listArchivePaths, mergeRecordFiles } from './src/server/shadowV1LiveRetention';
import {
  AI_CALIBRATION_MAX_ENTRIES,
  createAiCalibrationHandler,
  mapNearMissForwardPoints,
  mapRejectedForwardPoints,
  registerAiCalibrationRoute,
  type AiCalibrationEntry,
  type AiCalibrationForwardPoint,
  type AiCalibrationRegistrationDeps,
} from './src/server/aiCalibration';
import { loadNearMissRecords, SHADOW_V1_NEAR_MISS_PATH } from './src/server/shadowV1LiveNearMiss';
import { loadRejectedRecords, SHADOW_V1_REJECTED_PATH } from './src/server/shadowV1LiveRejected';
import { existsSync } from 'node:fs';
import {
  foldVetoLog,
  logVetoOutcomes,
  summarizeVetoOutcomes,
  VETO_LOG_RELATIVE_PATH,
} from './src/server/vetoOutcomeLog';
import { filterRelevantFreshNews, normalizeFuturesPayload } from './src/utils/newsFilter';
import {
  analyzeDeskEvidencePack,
  buildDeskEvidencePack,
  type DeskEvidenceSources,
} from './src/server/aiDesk';
import { AI_DESK_CONTRACT_VERSION, buildEvidencePromptAddendum } from './src/knowledge/aiDeskContract';
import type { AiEvidencePack } from './src/knowledge/aiEvidencePack';
import { isAiDeskEvidenceEnabled } from './src/config/aiDesk';
import {
  DEFAULT_YAHOO_USER_AGENT,
  fetchAndCacheYahooCrumb,
  invalidateYahooCrumb,
} from './src/server/yahooCrumbCache';
import { observeShadowV1LiveScan } from './src/server/shadowV1LiveScanner';
import {
  filterUnderlyingsForActiveMarkets,
  getActiveMarketsAt,
  SHADOW_MARKET_SCAN_INTERVAL_MS,
} from './src/server/shadowMarketScheduler';
import { DEFAULT_TRADE_REPUBLIC_UNDERLYINGS } from './src/data/defaultUnderlyings';
import { formatShadowV2SignalsCsv, formatShadowV2SignalsJsonl, ShadowV2Record } from './src/knowledge/shadowV2';

dotenv.config();

// Attiva di default in produzione/dev il fascicolo probatorio anti-allucinazione
// e la persistenza Firestore del log Shadow AI (rimangono disattivabili con '0'/'false'
// e spenti nei test unitari che controllano il default di modulo).
if (process.env.NODE_ENV !== 'test') {
  if (process.env.AI_DESK_EVIDENCE === undefined) {
    process.env.AI_DESK_EVIDENCE = '1';
  }
  if (process.env.SHADOW_AI_LOG_FIRESTORE === undefined) {
    process.env.SHADOW_AI_LOG_FIRESTORE = '1';
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Shared Universal App State across all environments (Desktop, Mobile, Dev preview)
const SHARED_STATE_FILE = path.join(__dirname, 'shared_radar_state.json');

interface SharedAppState {
  parameters?: any;
  freezeStateEU?: any;
  freezeStateUS?: any;
  journalEntries?: any[];
  excludedRecords?: any[];
  pendingProposal?: any;
  dualProposals?: any;
  accountCapital?: number;
  isPaperMode?: boolean;
  underlyings?: any[];
  updatedAt: string;
  version: number;
}

function sanitizeParameters(params: any): any {
  if (!params || typeof params !== 'object') return params;
  const p = { ...params };
  if (typeof p.minScoreEurope === 'number' && p.minScoreEurope > 100) {
    p.minScoreEurope = Math.round(p.minScoreEurope / 1000);
  }
  if (typeof p.minScoreUSA === 'number' && p.minScoreUSA > 100) {
    p.minScoreUSA = Math.round(p.minScoreUSA / 1000);
  }
  if (typeof p.minScore === 'number' && p.minScore > 100) {
    p.minScore = Math.round(p.minScore / 1000);
  }
  return p;
}

const sharedAppStates = new Map<string, SharedAppState>();

function createEmptySharedAppState(): SharedAppState {
  return { version: 1, updatedAt: new Date().toISOString() };
}

try {
  if (fs.existsSync(SHARED_STATE_FILE)) {
    const raw = fs.readFileSync(SHARED_STATE_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const store = parsed as Record<string, unknown>;
      if (store.users && typeof store.users === 'object' && !Array.isArray(store.users)) {
        for (const [userId, value] of Object.entries(store.users as Record<string, unknown>)) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const userState = { ...createEmptySharedAppState(), ...(value as Partial<SharedAppState>) };
          if (userState.parameters) userState.parameters = sanitizeParameters(userState.parameters);
          sharedAppStates.set(userId, userState);
        }
      } else if ('journalEntries' in store || 'parameters' in store || 'excludedRecords' in store) {
        const legacyState = { ...createEmptySharedAppState(), ...(store as Partial<SharedAppState>) };
        if (legacyState.parameters) legacyState.parameters = sanitizeParameters(legacyState.parameters);
        sharedAppStates.set('legacy', legacyState);
      }
    }
  }
} catch (e) {
  console.info('[Sync] Inizializzato nuovo stato condiviso.');
}

function getSharedAppState(userId: string): SharedAppState {
  let state = sharedAppStates.get(userId);
  if (!state) {
    state = createEmptySharedAppState();
    sharedAppStates.set(userId, state);
  }
  return state;
}

function saveSharedAppStateToDisk() {
  const temporaryPath = `${SHARED_STATE_FILE}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, users: Object.fromEntries(sharedAppStates) }, null, 2), 'utf-8');
    fs.renameSync(temporaryPath, SHARED_STATE_FILE);
  } catch (e) {
    console.warn('[Sync] Impossibile salvare shared_radar_state.json:', e);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

// AI Continuous Specialization & Qualitative Optimization Memory Store
const AI_MEMORY_FILE = path.join(__dirname, 'ai_specialization_memory.json');

/**
 * Fase 3: ogni scope ha il proprio mirror locale. Il globale mantiene il nome
 * storico, un utente ha `ai_specialization_memory.<uid>.json`: un uid non
 * scrive mai il file di un altro (e il nome e' gia' validato dal modulo).
 */
function aiMemoryFilePathFor(uid: string): string {
  return uid === AI_MEMORY_SYSTEM_UID ? AI_MEMORY_FILE : path.join(__dirname, aiMemoryLocalFileName(uid));
}

function loadAIMemoryFromDisk(uid: string = AI_MEMORY_SYSTEM_UID): AILearnedInsight[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(aiMemoryFilePathFor(uid), 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter((entry): entry is AILearnedInsight =>
      entry &&
      typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      typeof entry.topic === 'string' &&
      typeof entry.directive === 'string' &&
      (entry.confidence === null || typeof entry.confidence === 'number')
    );
    // Migrazione idempotente: una regola senza proprietario e' storica/globale.
    return migrateLegacyMemory(valid);
  } catch {
    return [];
  }
}

function saveAIMemoryLocally(memory: AILearnedInsight[], uid: string = AI_MEMORY_SYSTEM_UID): void {
  const filePath = aiMemoryFilePathFor(uid);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(memory, null, 2), 'utf-8');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    console.warn('[AI Specialization] Impossibile aggiornare il mirror locale:', error);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

let aiLearnedMemory: AILearnedInsight[] = loadAIMemoryFromDisk();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// SIC-2: limite dedicato alla route observe, montato prima del parser globale.
// body-parser salta i body gia' letti, quindi gli altri endpoint restano a 10 MB.
app.use(SHADOW_V1_LIVE_OBSERVE_PATH, shadowV1LiveBodyLimitParser(express.json));
app.use(SHADOW_V1_LIVE_OBSERVE_PATH, shadowV1LiveBodyLimitErrorHandler());
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', 1);

const validApiKeys = (process.env.VALID_API_KEYS || '').split(',').map((key) => key.trim()).filter(Boolean);

/**
 * AUDIT D2: interruttore esplicito per il vecchio comportamento "legacy" (nessuna credenziale
 * -> sessione condivisa). Default OFF: le API protette sono fail-closed.
 * IPOTESI: nome della variabile e default OFF (prima il fail-open era sempre attivo).
 */
const ALLOW_LEGACY_API_AUTH = process.env.ALLOW_LEGACY_API_AUTH === 'true';
const firebaseLocalConfigPath = path.join(__dirname, 'firebase-applet-config.json');
let firebaseProjectId =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.VITE_FIREBASE_PROJECT_ID ||
  '';
let firebaseDatabaseId = process.env.FIRESTORE_DATABASE_ID || '(default)';
if (fs.existsSync(firebaseLocalConfigPath)) {
  try {
    const firebaseConfig = JSON.parse(fs.readFileSync(firebaseLocalConfigPath, 'utf8'));
    firebaseProjectId ||= firebaseConfig.projectId || '';
    firebaseDatabaseId = process.env.FIRESTORE_DATABASE_ID || firebaseConfig.firestoreDatabaseId || '(default)';
  } catch {
    console.warn('[Auth] firebase-applet-config.json non valido; Firebase token auth non disponibile.');
  }
}

let firebaseAdminApp: ReturnType<typeof initializeFirebaseAdminApp> | null = null;
let firebaseAdminAuth: ReturnType<typeof getFirebaseAdminAuth> | null = null;
let firebaseAdminFirestore: ReturnType<typeof getFirebaseAdminFirestore> | null = null;
const AI_MEMORY_SYSTEM_UID = process.env.AI_MEMORY_SYSTEM_UID || 'system';
if (firebaseProjectId) {
  try {
    firebaseAdminApp = getFirebaseAdminApps().find((candidate) => candidate.name === 'intraday-radar-auth') ||
      initializeFirebaseAdminApp({ projectId: firebaseProjectId }, 'intraday-radar-auth');
    firebaseAdminAuth = getFirebaseAdminAuth(firebaseAdminApp);
    firebaseAdminFirestore = getFirebaseAdminFirestore(firebaseAdminApp, firebaseDatabaseId);
  } catch (error) {
    console.warn('[Auth] Firebase Admin auth non disponibile:', error);
  }
}

const startupAuthWarning = authStartupWarning(
  ALLOW_LEGACY_API_AUTH,
  validApiKeys.length > 0 || Boolean(firebaseAdminAuth),
);
if (startupAuthWarning) {
  console.warn(startupAuthWarning);
}

async function loadPersistentAIMemory(uid: string = AI_MEMORY_SYSTEM_UID): Promise<AILearnedInsight[]> {
  // Fase 3: un uid non valido non diventa un percorso; ricade nello scope globale.
  const scope = isScopedMemoryUid(uid) ? uid : AI_MEMORY_SYSTEM_UID;
  const localMemory = loadAIMemoryFromDisk(scope);
  if (firebaseAdminFirestore) {
    try {
      const reference = firebaseAdminFirestore.doc(aiMemoryFirestorePath(scope));
      const snapshot = await reference.get();
      const documentData = snapshot.data();
      const storedMemory: unknown = documentData?.memory;
      if (snapshot.exists && Array.isArray(storedMemory)) {
        const remoteMemory = storedMemory.filter((entry): entry is AILearnedInsight =>
          entry &&
          typeof entry === 'object' &&
          typeof entry.id === 'string' &&
          typeof entry.topic === 'string' &&
          typeof entry.directive === 'string' &&
          (entry.confidence === null || typeof entry.confidence === 'number')
        );
        const localUpdatedAt = fs.existsSync(aiMemoryFilePathFor(scope)) ? fs.statSync(aiMemoryFilePathFor(scope)).mtimeMs : 0;
        const remoteUpdatedAt = Date.parse(String(documentData?.updatedAt || '')) || 0;

        if (remoteMemory.length > 0 && (remoteUpdatedAt >= localUpdatedAt || localMemory.length === 0)) {
          saveAIMemoryLocally(remoteMemory, scope);
          return migrateLegacyMemory(remoteMemory);
        }
        const memoryMatches = JSON.stringify(localMemory) === JSON.stringify(remoteMemory);
        if (localMemory.length > 0 && !memoryMatches) {
          await persistAIMemoryToFirestore(localMemory, scope);
        }
        return localMemory.length > 0 ? localMemory : migrateLegacyMemory(remoteMemory);
      }

      if (localMemory.length > 0) {
        await persistAIMemoryToFirestore(localMemory, scope);
      }
      return localMemory;
    } catch (error) {
      console.warn('[AI Specialization] Firestore non disponibile; fallback alla memoria locale:', error);
    }
  }
  return loadAIMemoryFromDisk(scope);
}

/**
 * Fase 3: uid della richiesta. Il vecchio auth condiviso (`legacy`) resta nello
 * scope globale, cosi' il comportamento preesistente non cambia.
 */
function aiMemoryScopeUidOf(res: Response): string {
  const uid = typeof res.locals.authenticatedUid === 'string' ? res.locals.authenticatedUid : '';
  if (!isScopedMemoryUid(uid) || uid === 'legacy') return AI_MEMORY_SYSTEM_UID;
  return uid;
}

/**
 * Fase 3: cio' che un utente vede. Le proprie regole piu' le storiche globali,
 * marcate `legacy`: leggibili, non possedute, e mai riscritte nel suo documento.
 */
async function loadAIMemoryForUser(uid: string): Promise<AILearnedInsight[]> {
  const scope = isScopedMemoryUid(uid) ? uid : AI_MEMORY_SYSTEM_UID;
  const own = await loadPersistentAIMemory(scope);
  if (scope === AI_MEMORY_SYSTEM_UID) return migrateLegacyMemory(own);
  const legacy = await loadPersistentAIMemory(AI_MEMORY_SYSTEM_UID);
  return filterMemoryForUser([...migrateLegacyMemory(legacy), ...migrateLegacyMemory(own)], scope);
}

async function persistAIMemoryToFirestore(
  memory: AILearnedInsight[],
  uid: string = AI_MEMORY_SYSTEM_UID
): Promise<void> {
  if (!firebaseAdminFirestore) return;
  const scope = isScopedMemoryUid(uid) ? uid : AI_MEMORY_SYSTEM_UID;
  const reference = firebaseAdminFirestore.doc(aiMemoryFirestorePath(scope));
  await firebaseAdminFirestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const previousVersion = snapshot.data()?.version;
    const version = typeof previousVersion === 'number' && Number.isInteger(previousVersion)
      ? previousVersion + 1
      : 1;
    const payload = {
      memory,
      updatedAt: new Date().toISOString(),
      version,
      rulesCount: memory.length,
      validatedCount: memory.filter((entry) => entry.confidence !== null).length,
    };
    const versionReference = reference.collection('versions').doc(String(version));
    transaction.set(reference, payload, { merge: true });
    transaction.create(versionReference, payload);
  });
}

function isValidApiKey(req: Request): boolean {
  const providedKey = req.get('x-api-key');
  if (!providedKey) return false;
  const provided = Buffer.from(providedKey);
  return validApiKeys.some((key) => {
    const expected = Buffer.from(key);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}


/**
 * Adattatore fra `server.ts` e il nucleo puro `src/server/apiAuth.ts`: qui si
 * forniscono solo le dipendenze reali (chiavi server, Firebase Admin, ripiego
 * legacy). Middleware e route observe passano entrambi da qui, cosi' le due
 * strade non possono divergere.
 */
async function resolveApiAuthFor(req: Request): Promise<ApiAuthResolution> {
  return resolveApiAuth(req, {
    isValidApiKey: (candidate) => isValidApiKey(candidate as Request),
    verifyIdToken: firebaseAdminAuth
      ? (token: string) => firebaseAdminAuth!.verifyIdToken(token)
      : null,
    allowLegacyApiAuth: ALLOW_LEGACY_API_AUTH,
  });
}

async function requireApiAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await resolveApiAuthFor(req);
  if (auth.ok) {
    res.locals.authenticatedUid = auth.uid;
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized', message: apiAuthErrorMessage(auth.reason) });
}

function requireServerApiKey(req: Request, res: Response, next: NextFunction): void {
  if (isValidApiKey(req)) {
    res.locals.authenticatedUid = 'service-api-key';
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized', message: 'Valid x-api-key header required' });
}

const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Rate limit exceeded. Max 60 requests/minute.' }),
});
app.use('/api/', apiLimiter);

// In-Memory Cache Store (Redis-like TTL Cache)
interface CacheEntry<T> {
  data: T;
  expiry: number;
  timestamp: string;
}

class CacheStore {
  private store = new Map<string, CacheEntry<any>>();

  set<T>(key: string, data: T, ttlSeconds: number): void {
    const expiry = Date.now() + ttlSeconds * 1000;
    this.store.set(key, {
      data,
      expiry,
      timestamp: new Date().toISOString(),
    });
  }

  get<T>(key: string): { data: T; cachedAt: string } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      return null;
    }
    return { data: entry.data, cachedAt: entry.timestamp };
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

const cache = new CacheStore();
let geminiQuotaExhaustedUntil: number = 0;
let openRouterRateLimitedUntil: number = 0;

function isGeminiAvailable(): boolean {
  if (!process.env.GEMINI_API_KEY) return false;
  if (Date.now() < geminiQuotaExhaustedUntil) return false;
  return true;
}

/** ADDITIVO (P5): unico punto in cui il modello Gemini e' dichiarato. */
const GEMINI_MODEL = 'gemini-4-hydrogen';

// Initialize Gemini Client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Non-blocking availability probe on startup to preemptively catch 402/depleted credits
if (process.env.GEMINI_API_KEY && process.env.NODE_ENV !== 'test') {
  (async () => {
    try {
      await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: 'ping',
      });
      console.info('[AI Gemini] API attiva e verificata con successo.');
    } catch (startupErr: any) {
      const status = startupErr?.status || startupErr?.code;
      const msg = String(startupErr?.message || '');
      if (status === 402 || msg.includes('402') || msg.includes('prepayment credits are depleted')) {
        // Cooldown temporaneo (30m) anziche' blocco permanente: se i crediti vengono ricaricati si riattiva senza riavvio.
        geminiQuotaExhaustedUntil = Date.now() + 30 * 60 * 1000;
        console.info('[AI Gemini] Crediti prepagati esauriti (HTTP 402). Cooldown 30m e transizione su OpenRouter e regole deterministiche.');
      } else if (status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        geminiQuotaExhaustedUntil = Date.now() + 15 * 60 * 1000;
        console.info('[AI Gemini] Quota temporaneamente esaurita (HTTP 429). Attivato cooldown 15m.');
      }
    }
  })();
}

// Helper for CET time calculations
function getCETTime() {
  const now = new Date();
  
  // Europe (Europe/Rome)
  const euFormatter = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const euParts = euFormatter.formatToParts(now);
  const euMap: Record<string, string> = {};
  euParts.forEach((p) => {
    euMap[p.type] = p.value;
  });

  const hour = parseInt(euMap.hour || '0', 10);
  const minute = parseInt(euMap.minute || '0', 10);
  const totalMinutes = hour * 60 + minute;

  // Day of week in Rome / New York
  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    weekday: 'short',
  });
  const weekdayStr = dayFormatter.format(now); // "Sun", "Mon", etc.
  const isWeekend = weekdayStr === 'Sat' || weekdayStr === 'Sun';
  const dayOfWeek = now.getDay();

  // Screening Europa: 07:30 (450m) to 08:55 (535m) Europe/Rome (solo feriali)
  const isEuropeWindow = !isWeekend && totalMinutes >= 450 && totalMinutes <= 535;
  // Regular Trading Session Hours Europe: 09:00 (540m) to 17:35 (1055m) Europe/Rome (solo feriali)
  const isEuropeLive = !isWeekend && totalMinutes >= 540 && totalMinutes <= 1055;

  // USA (America/New_York) - 100% Dynamic with Intl
  const usFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const usParts = usFormatter.formatToParts(now);
  const usMap: Record<string, string> = {};
  usParts.forEach((p) => {
    usMap[p.type] = p.value;
  });

  const usHour = parseInt(usMap.hour || '0', 10);
  const usMinute = parseInt(usMap.minute || '0', 10);
  const usTotalMinutes = usHour * 60 + usMinute;

  // Screening USA: 08:30 (510m) to 09:25 (565m) America/New_York (solo feriali)
  const isUSAWindow = !isWeekend && usTotalMinutes >= 510 && usTotalMinutes <= 565;
  // Pre-Market USA: 04:00 (240m) to 09:29 (569m) America/New_York (solo feriali)
  const isUSAPreMarket = !isWeekend && usTotalMinutes >= 240 && usTotalMinutes <= 569;
  // Regular Live Session USA: 09:30 (570m) to 16:05 (965m) America/New_York (solo feriali)
  const isUSALive = !isWeekend && usTotalMinutes >= 570 && usTotalMinutes <= 965;

  const marketStatusEU: 'PRE_MARKET' | 'OPEN_LIVE' | 'CLOSED' = isEuropeLive
    ? 'OPEN_LIVE'
    : isEuropeWindow
    ? 'PRE_MARKET'
    : 'CLOSED';

  const marketStatusUS: 'PRE_MARKET' | 'OPEN_LIVE' | 'CLOSED' = isUSALive
    ? 'OPEN_LIVE'
    : isUSAPreMarket
    ? 'PRE_MARKET'
    : 'CLOSED';

  return {
    formatted: `${euMap.hour}:${euMap.minute}:${euMap.second} CET`,
    date: `${euMap.year}-${euMap.month}-${euMap.day}`,
    hour,
    minute,
    dayOfWeek,
    isWeekend,
    isEuropeWindow,
    isUSAWindow,
    isEuropeLive,
    isUSAPreMarket,
    isUSALive,
    marketStatusEU,
    marketStatusUS,
    currentMinutes: totalMinutes,
    usMinutes: usTotalMinutes,
  };
}

export interface RawQuoteData {
  ticker: string;
  name: string;
  market: 'EU' | 'US';
  currency: string;
  prevClose: number | null;
  currentPrice: number | null;
  preMarketPrice: number | null;
  prevHigh: number | null;
  prevLow: number | null;
  preMarketHigh: number | null;
  preMarketLow: number | null;
  todayOpen?: number | null;
  todayHigh?: number | null;
  todayLow?: number | null;
  vwap?: number | null;
  ema20Daily?: number | null;
  avgVolume20d: number | null;
  preMarketVolume: number | null;
  atr14: number | null;
  adr14?: number | null;
  liqEur20d?: number | null;
  fxRate?: number | null;
  completedBarsCount?: number | null;
  orbHigh?: number | null;
  orbLow?: number | null;
  orbBreakoutTime?: string | null;
  orbBreakoutTimeLong?: string | null;
  orbBreakoutTimeShort?: string | null;
  vwapCumulative?: number | null;
  vwapCumulativeWithPre?: number | null;
  vwapCoverage?: number | null;
  vwapState?: VwapSignalState | null;
  lastBarVolume?: number | null; // volume della barra 5m piu' recente della sessione (da getIntraday5mMetrics)
  lastBarTime?: number | null; // timestamp unix (secondi) della stessa barra
  vwapDataQuality?: VwapDataQuality | null;
  setupIndicators?: SetupIndicators | null; // quality gate VWAP: se !ok il contributo e' 0
  gapPercent: number | null;
  rvol: number | null;
  impliedVolatility?: number | null;
  historicalVolatility30d?: number | null;
  ivRank?: number | null;
  rsi14?: number | null;
  rsi5m?: number | null;
  rvol20m?: number | null;
  orderFlow?: OrderFlowMetrics | null;
  timestamp: string;
  // I2a: tempo di MERCATO della quota (unix secondi). Opzionale: i siti di
  // costruzione nel repo sono >8. Inerte con STALENESS_USE_MARKET_TS = 'off'.
  marketTs?: number | null;
  source: string;
  nextEarningsDate?: string | null;
  daysToEarnings?: number | null;
  earningsRiskLevel?: 'IMMINENT_0_2D' | 'UPCOMING_7D' | 'CLEAR' | null;
}

export interface OrderFlowMetrics {
  buyerVolumePercent: number;
  sellerVolumePercent: number;
  netDeltaPercent: number;
  cvdTrend: 'EXPANDING_UP' | 'EXPANDING_DOWN' | 'NEUTRAL' | 'ABSORPTION_TRAP';
  vpocPrice: number | null;
  isPriceAboveVpoc: boolean | null;
  flowQuality: 'INSTITUTIONAL_BUYING' | 'INSTITUTIONAL_SELLING' | 'ABSORPTION_TRAP' | 'BALANCED';
  summary: string;
}

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
}

// Calculate Wilder's 14-period RSI on series of prices
function calculateWilderRsi(closes: number[], period: number = 14): number | null {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(1);
}

/**
 * AUDIT D3: timeout esplicito su ogni fetch verso API esterne.
 * IPOTESI: 10000 ms di default (nessun valore preesistente). Un timeout produce un errore
 * esplicito (DOMException/AbortError), mai una risposta vuota trattata come dato valido.
 * Un init.signal gia' presente (timeout dedicato del chiamante) ha la precedenza.
 */
const DEFAULT_EXTERNAL_FETCH_TIMEOUT_MS = 10000;

/**
 * PUNTO 5: legge un intero positivo da ambiente.
 * Variabile assente, vuota, non numerica o <= 0 -> fallback (default storico).
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const EXTERNAL_FETCH_TIMEOUT_MS = positiveIntFromEnv(
  'EXTERNAL_FETCH_TIMEOUT_MS',
  DEFAULT_EXTERNAL_FETCH_TIMEOUT_MS
);

// PUNTO 5: TTL della cache Yahoo delle metriche intraday 5m (in millisecondi).
// Default 25000 ms = 25 secondi, il valore storico usato da cache.set(..., 25).
const YAHOO_CACHE_TTL_MS = positiveIntFromEnv('YAHOO_CACHE_TTL_MS', 25000);

// PUNTO 3 (config): modelli OpenRouter leggibili da ambiente.
// Default scelti tra i modelli :free verificati su OpenRouter con supporto nativo response_format json_object
// e disattivazione esplicita del reasoning interno (che altrimenti brucia max_tokens producendo content: null).
const OPENROUTER_PRIMARY_MODEL = (process.env.OPENROUTER_PRIMARY_MODEL || '').trim() || 'google/gemma-4-26b-a4b-it:free';
const OPENROUTER_FALLBACK_MODEL = (process.env.OPENROUTER_FALLBACK_MODEL || '').trim() || 'google/gemma-4-31b-it:free';
const OPENROUTER_ENABLE_REASONING = process.env.OPENROUTER_ENABLE_REASONING === 'true';

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = EXTERNAL_FETCH_TIMEOUT_MS
): Promise<globalThis.Response> {
  // Nota: in questo file `Response` e' quello di Express; qui serve il Response di fetch.
  if (init.signal) return fetch(url, init);
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Esegue mapping asincrono con limite di concorrenza per evitare rate limit e timeout su API esterne.
 */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let currentIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchYahooChartWithRetry(
  url: string,
  init: RequestInit = {},
  options: { maxRetries?: number; timeoutMs?: number } = {}
): Promise<globalThis.Response> {
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? Math.max(EXTERNAL_FETCH_TIMEOUT_MS, 14000);
  let lastError: unknown = null;
  let lastResp: globalThis.Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, init, timeoutMs);
      if (resp.ok) return resp;
      lastResp = resp;
      const retryableStatus = resp.status === 429 || resp.status >= 500;
      if (!retryableStatus || attempt >= maxRetries) {
        return resp;
      }
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries) {
        throw err;
      }
    }
    const backoffMs = 350 * (attempt + 1) + Math.floor(Math.random() * 250);
    await sleepMs(backoffMs);
  }

  if (lastResp) return lastResp;
  throw lastError instanceof Error ? lastError : new Error('Yahoo fetch failed');
}

let inFlightEurUsd: Promise<number> | null = null;

// Fetch real live EUR/USD exchange rate from Yahoo Finance feed (no hardcoded fallback)
async function getLiveEurUsdRate(): Promise<number> {
  const cacheKey = 'fx:EURUSD';
  const cached = cache.get<number>(cacheKey);
  if (cached) return cached.data;
  if (inFlightEurUsd) return inFlightEurUsd;

  inFlightEurUsd = (async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1d&range=1d&_=${Date.now()}`;
    const resp = await fetchYahooChartWithRetry(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json' },
    });
    if (!resp.ok) {
      throw new Error(`Impossibile recuperare tasso FX EUR/USD dal feed: HTTP ${resp.status}`);
    }
    const json = await resp.json();
    const rate = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (typeof rate !== 'number' || rate <= 0) {
      throw new Error('Tasso FX EUR/USD non disponibile nel feed per conversione liquidità');
    }
    cache.set(cacheKey, rate, 300); // 5 min TTL
    return rate;
  })();

  try {
    return await inFlightEurUsd;
  } finally {
    inFlightEurUsd = null;
  }
}

// Fetch real 5-minute Intraday RSI, 20-minute RVOL, ORB levels & Synthetic Order Flow
/**
 * Barre 5m per la serie di warm-up degli indicatori (range dedicato, IPOTESI).
 * Errore esplicito sul feed: il chiamante decide il fallback, nessun dato inventato.
 */
async function fetchWarmup5mBars(ticker: string, range: string): Promise<IndicatorBarInput[]> {
  const ySymbol = ticker.includes('.') ? ticker : `${ticker}`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?interval=5m&range=${encodeURIComponent(range)}&includePrePost=true&_=${Date.now()}`;
  const resp = await fetchYahooChartWithRetry(
    url,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    },
    { maxRetries: 2, timeoutMs: 14000 }
  );
  if (!resp.ok) throw new Error(`FEED_ERROR:HTTP ${resp.status}`);
  const json = await resp.json();
  const timestamps: number[] = json?.chart?.result?.[0]?.timestamp || [];
  const quote = json?.chart?.result?.[0]?.indicators?.quote?.[0];
  return timestamps.map((t, i) => ({
    t: t * 1000,
    o: quote?.open?.[i],
    h: quote?.high?.[i],
    l: quote?.low?.[i],
    c: quote?.close?.[i],
    v: quote?.volume?.[i],
  })) as IndicatorBarInput[];
}

interface Intraday5mMetricsResult {
  rsi5m: number | null;
  rvol: number | null;
  rvol20m: number | null;
  orderFlow: OrderFlowMetrics | null;
  orbHigh: number | null;
  orbLow: number | null;
  orbBreakoutTime: string | null;
  orbBreakoutTimeLong: string | null;
  orbBreakoutTimeShort: string | null;
  vwapCumulative?: number | null;
  vwapCumulativeWithPre?: number | null;
  vwapCoverage?: number | null;
  vwapState?: VwapSignalState | null;
  lastBarVolume?: number | null;
  lastBarTime?: number | null;
  vwapDataQuality?: VwapDataQuality | null;
  setupIndicators?: SetupIndicators | null;
  latestPrePostPrice?: number | null;
  todayPrePostVolume?: number | null;
}

const inFlightIntraday5m = new Map<string, Promise<Intraday5mMetricsResult>>();

async function getIntraday5mMetrics(
  ticker: string,
  market: 'EU' | 'US' = 'EU'
): Promise<Intraday5mMetricsResult> {
  const cacheKey = `metrics5m:${ticker}:${market}`;
  const cached = cache.get<Intraday5mMetricsResult>(cacheKey);
  if (cached) return cached.data;

  const existingInFlight = inFlightIntraday5m.get(cacheKey);
  if (existingInFlight) return existingInFlight;

  const task = (async (): Promise<Intraday5mMetricsResult> => {
  try {
    const ySymbol = ticker.includes('.') ? ticker : `${ticker}`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?interval=5m&range=60d&includePrePost=true&_=${Date.now()}`;
    const resp = await fetchYahooChartWithRetry(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      },
      { maxRetries: 2, timeoutMs: 14000 }
    );
    if (!resp.ok) return { rsi5m: null, rvol: null, rvol20m: null, orderFlow: null, orbHigh: null, orbLow: null, orbBreakoutTime: null, orbBreakoutTimeLong: null, orbBreakoutTimeShort: null, vwapCumulative: null, vwapCumulativeWithPre: null, vwapCoverage: null, vwapState: null, lastBarVolume: null, lastBarTime: null, vwapDataQuality: { ok: false, reason: `FEED_ERROR:HTTP ${resp.status}`, coverage: 0 }, setupIndicators: null, latestPrePostPrice: null, todayPrePostVolume: null };
    const json = await resp.json();
    const rawQuotes = json?.chart?.result?.[0]?.indicators?.quote?.[0];
    const closes: number[] = rawQuotes?.close?.filter(
      (c: any) => typeof c === 'number' && c > 0
    ) || [];

    const rsi5m = calculateWilderRsi(closes, 14);

    // Calculate real-time 20-minute Relative Volume (last 4 bars of 5m vs preceding moving average)
    let rvol20m: number | null = null;
    const vols: number[] = (rawQuotes?.volume || [])
      .map((v: any, i: number) => ({ v: typeof v === 'number' ? v : 0, c: rawQuotes?.close?.[i] }))
      .filter((x: any) => typeof x.c === 'number' && x.v > 0)
      .map((x: any) => x.v);

    if (vols.length >= 8) {
      // Last 4 bars (4 * 5m = 20 minutes)
      const last4 = vols.slice(-4);
      // Preceding moving average window of up to 16 bars (80 min)
      const prevBars = vols.slice(Math.max(0, vols.length - 20), vols.length - 4);
      if (prevBars.length >= 4) {
        const last4Avg = last4.reduce((a, b) => a + b, 0) / last4.length;
        const prevAvg = prevBars.reduce((a, b) => a + b, 0) / prevBars.length;
        if (prevAvg > 0) {
          rvol20m = +(last4Avg / prevAvg).toFixed(2);
        }
      }
    }

    // 100% REAL Order Flow: Intra-candle Lee-Ready Volume Decomposition & Cumulative Delta
    let orderFlow: OrderFlowMetrics | null = null;
    const opens = rawQuotes?.open || [];
    const highs = rawQuotes?.high || [];
    const lows = rawQuotes?.low || [];
    const closesArr = rawQuotes?.close || [];
    const volumes = rawQuotes?.volume || [];

    const validBars: {
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      buyerVol: number;
      sellerVol: number;
      delta: number;
    }[] = [];

    for (let i = 0; i < closesArr.length; i++) {
      const c = closesArr[i];
      const h = highs[i] ?? c;
      const l = lows[i] ?? c;
      const o = opens[i] ?? c;
      const v = typeof volumes[i] === 'number' && volumes[i] > 0 ? volumes[i] : 0;
      if (typeof c === 'number' && c > 0) {
        const range = Math.max(h - l, c * 0.0005);
        // Close Location Value (CLV) strictly in [-1, +1]
        const clv = Math.max(-1, Math.min(1, ((c - l) - (h - c)) / range));
        // Buyer fraction [0.05, 0.95]
        const buyerFraction = Math.min(0.95, Math.max(0.05, 0.5 + clv * 0.45));
        const sellerFraction = 1 - buyerFraction;
        const buyerVol = v * buyerFraction;
        const sellerVol = v * sellerFraction;
        const delta = buyerVol - sellerVol;

        validBars.push({
          open: o,
          high: h,
          low: l,
          close: c,
          volume: v,
          buyerVol,
          sellerVol,
          delta,
        });
      }
    }

    if (validBars.length >= 4) {
      // Analyze recent window of up to 12 bars (last 60m of intraday trading)
      const windowBars = validBars.slice(-12);
      const totalBuyerVol = windowBars.reduce((acc, b) => acc + b.buyerVol, 0);
      const totalSellerVol = windowBars.reduce((acc, b) => acc + b.sellerVol, 0);
      const windowVol = totalBuyerVol + totalSellerVol;

      const buyerVolumePercent = windowVol > 0 ? +((totalBuyerVol / windowVol) * 100).toFixed(1) : 50;
      const sellerVolumePercent = +(100 - buyerVolumePercent).toFixed(1);
      const netDeltaPercent = +(buyerVolumePercent - sellerVolumePercent).toFixed(1);

      // Cumulative Volume Delta (CVD) slope over last 6 bars (last 30m)
      const cvdBars = validBars.slice(-6);
      let runningDelta = 0;
      const cvdSeries = cvdBars.map((b) => {
        runningDelta += b.delta;
        return { close: b.close, cvd: runningDelta };
      });

      const firstHalf = cvdSeries.slice(0, 3);
      const secondHalf = cvdSeries.slice(-3);
      const avgPrice1 = firstHalf.reduce((a, b) => a + b.close, 0) / firstHalf.length;
      const avgPrice2 = secondHalf.reduce((a, b) => a + b.close, 0) / secondHalf.length;
      const avgCvd1 = firstHalf.reduce((a, b) => a + b.cvd, 0) / firstHalf.length;
      const avgCvd2 = secondHalf.reduce((a, b) => a + b.cvd, 0) / secondHalf.length;

      const priceUp = avgPrice2 > avgPrice1 * 1.0006;
      const priceDown = avgPrice2 < avgPrice1 * 0.9994;
      const cvdUp = avgCvd2 > avgCvd1;
      const cvdDown = avgCvd2 < avgCvd1;

      // Detection of Absorption Trap (Bearish: Price makes new highs but CVD dumps; Bullish: Price drops but CVD buys)
      let cvdTrend: OrderFlowMetrics['cvdTrend'] = 'NEUTRAL';
      let flowQuality: OrderFlowMetrics['flowQuality'] = 'BALANCED';

      if (priceUp && cvdDown) {
        cvdTrend = 'ABSORPTION_TRAP';
        flowQuality = 'ABSORPTION_TRAP';
      } else if (priceDown && cvdUp) {
        cvdTrend = 'ABSORPTION_TRAP';
        flowQuality = 'ABSORPTION_TRAP';
      } else if (cvdUp && buyerVolumePercent >= 56) {
        cvdTrend = 'EXPANDING_UP';
        flowQuality = 'INSTITUTIONAL_BUYING';
      } else if (cvdDown && sellerVolumePercent >= 56) {
        cvdTrend = 'EXPANDING_DOWN';
        flowQuality = 'INSTITUTIONAL_SELLING';
      } else {
        cvdTrend = cvdUp ? 'EXPANDING_UP' : cvdDown ? 'EXPANDING_DOWN' : 'NEUTRAL';
        flowQuality = 'BALANCED';
      }

      // Micro Volume Profile & VPOC (Volume Point of Control across last 12 bars)
      const minP = Math.min(...windowBars.map((b) => b.low));
      const maxP = Math.max(...windowBars.map((b) => b.high));
      const pRange = Math.max(maxP - minP, 0.01);
      const binCount = 10;
      const binSize = pRange / binCount;
      const bins: number[] = new Array(binCount).fill(0);

      windowBars.forEach((b) => {
        const binIdx = Math.min(Math.floor((b.close - minP) / binSize), binCount - 1);
        if (binIdx >= 0) bins[binIdx] += b.volume;
      });

      let maxBinIdx = 0;
      let maxBinVol = -1;
      bins.forEach((vol, idx) => {
        if (vol > maxBinVol) {
          maxBinVol = vol;
          maxBinIdx = idx;
        }
      });

      const vpocPrice = +(minP + (maxBinIdx + 0.5) * binSize).toFixed(2);
      const currentPrice = windowBars[windowBars.length - 1].close;
      const isPriceAboveVpoc = currentPrice >= vpocPrice;

      let summary = '';
      if (flowQuality === 'ABSORPTION_TRAP') {
        summary = `⚠️ Divergenza Delta: ${priceUp ? 'prezzo in rialzo ma volumi in scarico al Bid' : 'prezzo in ribasso ma volumi in assorbimento all\'Ask'} (Rischio falso breakout).`;
      } else if (flowQuality === 'INSTITUTIONAL_BUYING') {
        summary = `Pressione Compratrice Istituzionale (+${netDeltaPercent}% Ask): aggressione al mercato e CVD in espansione sopra VPOC.`;
      } else if (flowQuality === 'INSTITUTIONAL_SELLING') {
        summary = `Pressione Venditrice Istituzionale (${netDeltaPercent}% Bid): scarico volumi a mercato e CVD ribassista sotto VPOC.`;
      } else {
        summary = `Flusso Volumetrico Bilanciato (${buyerVolumePercent}% Ask / ${sellerVolumePercent}% Bid).`;
      }

      orderFlow = {
        buyerVolumePercent,
        sellerVolumePercent,
        netDeltaPercent,
        cvdTrend,
        vpocPrice,
        isPriceAboveVpoc,
        flowQuality,
        summary,
      };
    }

    // Extract ORB levels for today's session based on local exchange time and calculate ORB RVOL
    let orbHigh: number | null = null;
    let orbLow: number | null = null;
    let orbBreakoutTime: string | null = null;
    let orbBreakoutTimeLong: string | null = null;
    let orbBreakoutTimeShort: string | null = null;
    let orbRvol: number | null = null;

    try {
      const timestamps5m: number[] = json?.chart?.result?.[0]?.timestamp || [];
      const highs5m: number[] = rawQuotes?.high || [];
      const lows5m: number[] = rawQuotes?.low || [];
      const candles5m: IntradayCandleInput[] = [];

      const openM =
        market === 'US'
          ? TRADING_PARAMS.US_OPEN_HOUR * 60 + TRADING_PARAMS.US_OPEN_MINUTE
          : TRADING_PARAMS.EU_OPEN_HOUR * 60 + TRADING_PARAMS.EU_OPEN_MINUTE;
      const orbEndM = openM + TRADING_PARAMS.ORB_MINUTES;

      const sessionOrbMap = new Map<string, number>();
      const sessionCandles = new Map<string, Array<{ volume?: number | null }>>();

      for (let i = 0; i < timestamps5m.length; i++) {
        const ts = timestamps5m[i];
        const h = highs5m[i];
        const l = lows5m[i];
        const c = rawQuotes?.close?.[i];
        const v = typeof rawQuotes?.volume?.[i] === 'number' && rawQuotes.volume[i] > 0 ? rawQuotes.volume[i] : 0;

        if (typeof h === 'number' && typeof l === 'number' && typeof c === 'number' && h > 0 && l > 0) {
          candles5m.push({ timestamp: ts, high: h, low: l, close: c });
        }

        const d = new Date(ts * 1000);
        const mt = getMarketTime(market, d);
        if (mt.totalMinutes >= openM && mt.totalMinutes < orbEndM) {
          if (!sessionOrbMap.has(mt.dateFormatted)) {
            sessionOrbMap.set(mt.dateFormatted, 0);
            sessionCandles.set(mt.dateFormatted, []);
          }
          sessionOrbMap.set(mt.dateFormatted, sessionOrbMap.get(mt.dateFormatted)! + v);
          sessionCandles.get(mt.dateFormatted)!.push({ volume: v });
        }
      }

      if (candles5m.length > 0) {
        const latestCandleDate = new Date(timestamps5m[timestamps5m.length - 1] * 1000);
        const orbRes = calculateOrbFromIntradayBars(candles5m, market, latestCandleDate, undefined, new Date());
        orbHigh = orbRes.orbHigh != null ? +orbRes.orbHigh.toFixed(2) : null;
        orbLow = orbRes.orbLow != null ? +orbRes.orbLow.toFixed(2) : null;
        orbBreakoutTimeLong = orbRes.firstBreakoutTimeLong;
        orbBreakoutTimeShort = orbRes.firstBreakoutTimeShort;
        orbBreakoutTime = orbRes.firstBreakoutTimeLong ?? orbRes.firstBreakoutTimeShort ?? null;

        const allDates = Array.from(sessionOrbMap.keys()).sort();
        if (allDates.length > 0) {
          const latestDate = getExchangeDateStr(market, latestCandleDate);
          const histDates = allDates.filter((d) => d < latestDate);
          const histVolumes = histDates.map((d) => sessionOrbMap.get(d)!);
          const currentBars = sessionCandles.get(latestDate) || [];

          orbRvol = orbRes.orbHigh != null
            ? calculateOrbRvolFromBars(currentBars, histVolumes.slice(-20))
            : null;
        }
      }
    } catch {
      // ignore
    }

    let vwapCumulative: number | null = null;
    let vwapCumulativeWithPre: number | null = null;
    let vwapCoverage: number | null = null;
    let vwapState: VwapSignalState | null = null;
    let lastBarVolume: number | null = null;
    let lastBarTime: number | null = null;
    let vwapDataQuality: VwapDataQuality | null = null;
    let latestPrePostPrice: number | null = null;
    let todayPrePostVolume: number | null = null;
    try {
      const ts: number[] = json?.chart?.result?.[0]?.timestamp || [];
      if (ts.length > 0) {
        const bars: VwapBar[] = ts.map((t, i) => ({
          timestamp: t,
          open: rawQuotes?.open?.[i] ?? null,
          high: rawQuotes?.high?.[i] ?? null,
          low: rawQuotes?.low?.[i] ?? null,
          close: rawQuotes?.close?.[i] ?? null,
          volume: rawQuotes?.volume?.[i] ?? null,
        }));
        // Data di sessione = OGGI nel fuso del mercato (non l'ultima barra disponibile)
        const sessionDate = getExchangeDateStr(market, new Date());
        const nowMinutes = getMarketTime(market, new Date()).totalMinutes;

        // Barra 5m piu' recente della sessione corrente: volume e timestamp servono al VWAP state
        // e vengono passati al call site di calculateCandidateScore; stesso stream fornisce pre/post US
        // evitando una seconda chiamata Yahoo range=1d per titolo.
        const todaySessionBars = bars.filter(
          (b) => getExchangeDateStr(market, new Date(b.timestamp * 1000)) === sessionDate
        );
        const lastSessionBar =
          todaySessionBars.length > 0 ? todaySessionBars[todaySessionBars.length - 1] : undefined;
        lastBarVolume = lastSessionBar?.volume ?? null;
        lastBarTime = lastSessionBar?.timestamp ?? null;
        const validTodayCloses = todaySessionBars
          .map((b) => b.close)
          .filter((c): c is number => typeof c === 'number' && Number.isFinite(c) && c > 0);
        if (validTodayCloses.length > 0) {
          latestPrePostPrice = validTodayCloses[validTodayCloses.length - 1];
        }
        const sumTodayVol = todaySessionBars.reduce(
          (acc, b) =>
            acc + (typeof b.volume === 'number' && Number.isFinite(b.volume) && b.volume > 0 ? b.volume : 0),
          0
        );
        if (sumTodayVol > 0) {
          todayPrePostVolume = sumTodayVol;
        }
        const reg = computeSessionVwap(bars, market, sessionDate, { nowMinutes });
        vwapCumulative = reg.vwap != null ? +reg.vwap.toFixed(2) : null;
        vwapCoverage = reg.coverage != null ? +reg.coverage.toFixed(2) : null;
        if (market === 'US') {
          const pre = computeSessionVwap(bars, market, sessionDate, { includePreMarket: true, nowMinutes });
          vwapCumulativeWithPre = pre.vwap != null ? +pre.vwap.toFixed(2) : null;
        }
        // Stato VWAP di sessione (IPOTESI): solo contesto + contributo score, nessun filtro se VWAP_HARD_GATE=false
        const atr5m = calculateAtr5m(bars);
        const vwapSource = TRADING_PARAMS.VWAP_SOURCE;
        vwapState = computeVwapState(bars, {
          market,
          sessionDate,
          atr5m,
          vwapCumulative:
            vwapSource === 'withPre' ? vwapCumulativeWithPre ?? vwapCumulative : vwapCumulative,
          coverage: vwapCoverage,
          nowMinutes,
          source: vwapSource,
        });

        // Quality gate (IPOTESI): serie non affidabile -> stato UNKNOWN + DATA_QUALITY:<reason>, contributo 0.
        // Nel weekend o prima che si chiuda la prima candela 5m della sessione regolare non esiste
        // copertura di sessione odierna attesa: non e' LOW_COVERAGE ma mercato chiuso / pre-open.
        const openMinutes = market === 'US' ? 570 : 540;
        const exchangeDay = new Date(`${sessionDate}T12:00:00Z`).getUTCDay();
        const metaPrice = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
        const quality =
          exchangeDay === 0 || exchangeDay === 6
            ? { ok: false, reason: 'MARKET_CLOSED', coverage: 0, nullFields: 0 }
            : nowMinutes < openMinutes + 5
              ? { ok: false, reason: 'PRE_MARKET', coverage: 0, nullFields: 0 }
              : computeVwapDataQuality(
                  bars,
                  {
                    currentPrice: typeof metaPrice === 'number' ? metaPrice : lastSessionBar?.close ?? null,
                    vwap: null,
                  },
                  market,
                  new Date()
                );
        vwapDataQuality = quality;
        if (!quality.ok) {
          const dqFlag = `DATA_QUALITY:${quality.reason ?? 'UNKNOWN'}`;
          vwapState = vwapState
            ? {
                ...vwapState,
                state: 'UNKNOWN',
                coverage: quality.coverage,
                flags: [dqFlag, ...vwapState.flags.filter((f) => !f.startsWith('DATA_QUALITY:'))],
              }
            : {
                state: 'UNKNOWN',
                distAtr: null,
                slopeAtr: null,
                coverage: quality.coverage,
                volumeRatio: null,
                flags: [dqFlag],
                vwapLevel: null,
              };
        }
      }
    } catch {
      // lascia null
    }
    if (!vwapDataQuality) vwapDataQuality = { ok: false, reason: 'FEED_ERROR', coverage: 0 };

    // Indicatori di setup 5m (IPOTESI): sessione regolare corrente + sessioni precedenti disponibili.
    // Serie dedicata con WARMUP_RANGE_5M (fallback WARMUP_RANGE_FALLBACK_5M se le barre complete
    // sono < IND_MIN_BARS); se il feed dedicato fallisce si usa la serie 60d gia' in memoria.
    // Nessuna imputazione: barre insufficienti = UNKNOWN con reason esplicita.
    let setupIndicators: SetupIndicators | null = null;
    try {
      const tsInd: number[] = json?.chart?.result?.[0]?.timestamp || [];
      const inMemoryBars = tsInd.map((t, i) => ({
        t: t * 1000,
        o: rawQuotes?.open?.[i],
        h: rawQuotes?.high?.[i],
        l: rawQuotes?.low?.[i],
        c: rawQuotes?.close?.[i],
        v: rawQuotes?.volume?.[i],
      })) as IndicatorBarInput[];

      let warmup: WarmupSeriesResult | null = null;
      const recentInMemoryBars = inMemoryBars.length > 600 ? inMemoryBars.slice(-600) : inMemoryBars;
      if (recentInMemoryBars.length >= TRADING_PARAMS.IND_MIN_BARS) {
        const selection = selectWarmupBars(recentInMemoryBars, market, { now: new Date() });
        warmup = {
          bars: selection.bars,
          rangeUsed: '60d (serie gia in memoria)',
          fallbackUsed: false,
          priorSessionsUsed: selection.priorSessionsUsed,
          completeBars: selection.bars.length,
          droppedFutureBars: selection.droppedFutureBars,
        };
      } else {
        try {
          warmup = await loadWarmupBars((range) => fetchWarmup5mBars(ticker, range), { market, now: new Date() });
        } catch {
          warmup = null;
        }
      }
      if (!warmup) {
        const selection = selectWarmupBars(recentInMemoryBars, market, { now: new Date() });
        warmup = {
          bars: selection.bars,
          rangeUsed: '60d (serie gia in memoria)',
          fallbackUsed: false,
          priorSessionsUsed: selection.priorSessionsUsed,
          completeBars: selection.bars.length,
          droppedFutureBars: selection.droppedFutureBars,
        };
      }

      setupIndicators = computeSetupIndicators(warmup.bars, {
        market,
        now: new Date(),
        rangeUsed: warmup.rangeUsed,
        priorSessionsUsed: warmup.priorSessionsUsed,
        droppedFutureBars: warmup.droppedFutureBars,
      });

      const regularInMemoryBars = filterRegularSessionBars(inMemoryBars, market);
      const barsForShadow = warmup.bars.length > regularInMemoryBars.length ? warmup.bars : regularInMemoryBars;
      recordClosedBarsForShadowV2(ticker, market, barsForShadow);
      recordBarsForShadowV1Live(ticker, market, barsForShadow, Date.now(), process.env, { deferDiskSave: true });
    } catch {
      setupIndicators = null;
    }

    const result = {
      rsi5m,
      rvol: orbRvol,
      rvol20m,
      orderFlow,
      orbHigh,
      orbLow,
      orbBreakoutTime,
      orbBreakoutTimeLong,
      orbBreakoutTimeShort,
      vwapCumulative,
      vwapCumulativeWithPre,
      vwapCoverage,
      vwapState,
      lastBarVolume,
      lastBarTime,
      vwapDataQuality,
      setupIndicators,
      latestPrePostPrice,
      todayPrePostVolume,
    };
    cache.set(cacheKey, result, YAHOO_CACHE_TTL_MS / 1000);
    return result;
  } catch (err: any) {
    console.warn(`[getIntraday5mMetrics] ${ticker} (${market}) fallito:`, err?.message || err);
    return {
      rsi5m: null,
      rvol: null,
      rvol20m: null,
      orderFlow: null,
      orbHigh: null,
      orbLow: null,
      orbBreakoutTime: null,
      orbBreakoutTimeLong: null,
      orbBreakoutTimeShort: null,
      vwapCumulative: null,
      vwapCumulativeWithPre: null,
      vwapCoverage: null,
      vwapState: null,
      lastBarVolume: null,
      lastBarTime: null,
      vwapDataQuality: { ok: false, reason: 'FEED_ERROR', coverage: 0 },
      setupIndicators: null,
      latestPrePostPrice: null,
      todayPrePostVolume: null,
    };
  }
  })();

  inFlightIntraday5m.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inFlightIntraday5m.delete(cacheKey);
  }
}

// Yahoo Finance Cookie + Crumb: cache canonica unica condivisa con il collector
// V1-live (`src/server/yahooCrumbCache.ts`: TTL 30 minuti, coalescing richieste parallele).
async function getYahooCrumb(forceRefresh: boolean = false): Promise<{ cookie: string; crumb: string } | null> {
  return fetchAndCacheYahooCrumb({
    forceRefresh,
    userAgent: DEFAULT_YAHOO_USER_AGENT,
    timeoutMs: 3500,
  });
}

function classifyEarningsProximity(
  nextDateStr: string | null | undefined,
  todayStr: string
): {
  nextEarningsDate: string | null;
  daysToEarnings: number | null;
  earningsRiskLevel: 'IMMINENT_0_2D' | 'UPCOMING_7D' | 'CLEAR' | null;
} {
  if (!nextDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(nextDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(todayStr)) {
    return { nextEarningsDate: null, daysToEarnings: null, earningsRiskLevel: null };
  }
  const [ey, em, ed] = nextDateStr.split('-').map(Number);
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const diffDays = Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(ty, tm - 1, td)) / 86400000);
  if (!Number.isFinite(diffDays) || diffDays < 0) {
    return { nextEarningsDate: null, daysToEarnings: null, earningsRiskLevel: null };
  }
  const level: 'IMMINENT_0_2D' | 'UPCOMING_7D' | 'CLEAR' =
    diffDays <= 2 ? 'IMMINENT_0_2D' : diffDays <= 7 ? 'UPCOMING_7D' : 'CLEAR';
  return {
    nextEarningsDate: nextDateStr,
    daysToEarnings: diffDays,
    earningsRiskLevel: level,
  };
}

async function fetchEarningsInfoForTicker(
  ticker: string,
  market: 'EU' | 'US',
  bypassCache: boolean = false
): Promise<{
  nextEarningsDate: string | null;
  daysToEarnings: number | null;
  earningsRiskLevel: 'IMMINENT_0_2D' | 'UPCOMING_7D' | 'CLEAR' | null;
}> {
  const empty = { nextEarningsDate: null, daysToEarnings: null, earningsRiskLevel: null };
  const cacheKey = `earnings:${ticker}`;
  if (!bypassCache) {
    const cached = cache.get<typeof empty>(cacheKey);
    if (cached) return cached.data;
  }

  try {
    let auth = await getYahooCrumb(false);
    if (!auth) return empty;

    const querySummary = async (pair: { cookie: string; crumb: string }) =>
      fetchWithTimeout(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=calendarEvents&crumb=${encodeURIComponent(pair.crumb)}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Cookie: pair.cookie,
            Accept: 'application/json',
          },
        },
        3500
      );

    let resp = await querySummary(auth);
    if (resp.status === 401 || resp.status === 403) {
      invalidateYahooCrumb();
      auth = await getYahooCrumb(true);
      if (!auth) return empty;
      resp = await querySummary(auth);
    }
    if (!resp.ok) return empty;

    const json = await resp.json();
    const earningsDates = json?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate;
    const first = Array.isArray(earningsDates) && earningsDates.length > 0 ? earningsDates[0] : null;
    const todayStr = getExchangeDateStr(market, new Date());

    let candidateDate: string | null = typeof first?.fmt === 'string' ? first.fmt : null;
    if (!candidateDate && typeof first?.raw === 'number' && Number.isFinite(first.raw)) {
      candidateDate = getExchangeDateStr(market, new Date(first.raw * 1000));
    }

    const classified = classifyEarningsProximity(candidateDate, todayStr);
    // Cache 6 ore (dato trimestrale lento, null o valido)
    cache.set(cacheKey, classified, 21600);
    return classified;
  } catch {
    return empty;
  }
}

// Fetch real market quote & historical bars from real exchange feed
async function fetchQuoteForTicker(
  ticker: string,
  name: string,
  market: 'EU' | 'US',
  currency: string,
  bypassCache: boolean = false
): Promise<RawQuoteData> {
  const cacheKey = `quote:${ticker}`;
  if (!bypassCache) {
    const cached = cache.get<RawQuoteData>(cacheKey);
    if (cached) {
      return cached.data;
    }
  }

  const upper = ticker.toUpperCase();
  const isSpaceX = upper === 'SPACEX' || upper === 'SPCX';
  let queryTicker = upper;
  if (upper === 'SPACEX') queryTicker = 'SPCX';
  if (upper === 'LEO.MI' || upper === 'LEO' || upper === 'LDO') queryTicker = 'LDO.MI';

  // Launch 5m intraday metrics & earnings calendar fetch in parallel
  const intraday5mPromise = getIntraday5mMetrics(queryTicker, market);
  const earningsPromise = fetchEarningsInfoForTicker(queryTicker, market, bypassCache);

  let quoteData: Partial<RawQuoteData> = {};
  let source = 'Exchange Feed (Real-Time)';

  // 1. Check Finnhub if API key is provided
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (finnhubKey) {
    try {
      const cleanTicker = queryTicker.replace('.DE', '').replace('.MI', '').replace('.PA', '').replace('.AS', '');
      const resp = await fetchWithTimeout(
        `https://finnhub.io/api/v1/quote?symbol=${cleanTicker}&token=${finnhubKey}`
      );
      if (resp.ok) {
        const json = await resp.json();
        if (typeof json.c === 'number' && json.c > 0) {
          quoteData.currentPrice = json.c;
          quoteData.prevClose = json.pc || null;
          quoteData.prevHigh = json.h || null;
          quoteData.prevLow = json.l || null;
          quoteData.preMarketPrice = json.c;
          source = 'Finnhub Live API';
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Fetch real data from Yahoo Finance Chart API (with cachebuster to bypass CDN stale cache)
  try {
    const ySymbol = queryTicker.includes('.') ? queryTicker : `${queryTicker}`;
    const nocache = Date.now();
    const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?interval=1d&range=1mo&includePrePost=true&_=${nocache}`;
    const yResp = await fetchYahooChartWithRetry(
      yUrl,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
          Accept: 'application/json',
        },
      },
      { maxRetries: 2, timeoutMs: 14000 }
    );

    if (yResp.ok) {
      const yJson = await yResp.json();
      const result = yJson?.chart?.result?.[0];
      if (result) {
        const meta = result.meta || {};
        // I2a: tempo di mercato dichiarato dal feed (unix secondi). Nessun lettore:
        // il campo diventa operativo solo con STALENESS_USE_MARKET_TS = 'on'.
        quoteData.marketTs = typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime : null;
        const timestamps: number[] = result.timestamp || [];
        const quotes = result.indicators?.quote?.[0];

        // Extract valid daily candles with timestamp, close, high, low, volume in exchange timezone
        const validBars: DailyBarInput[] = [];
        for (let i = 0; i < timestamps.length; i++) {
          if (typeof quotes?.close?.[i] === 'number') {
            validBars.push({
              date: getExchangeDateStr(market, new Date(timestamps[i] * 1000)),
              timestamp: timestamps[i],
              close: quotes.close[i],
              high: quotes.high?.[i] ?? quotes.close[i],
              low: quotes.low?.[i] ?? quotes.close[i],
              volume: quotes.volume?.[i] ?? 0,
            });
          }
        }

        const todayStr = getExchangeDateStr(market, new Date());
        const lastBar = validBars.length > 0 ? validBars[validBars.length - 1] : null;
        const isTodayBar = lastBar?.date === todayStr;

        // Zero lookahead: completed sessions strictly exclude today's incomplete candle
        const completedBars = filterCompletedBars(validBars, market, new Date());

        let prevC: number | null = null;
        let yHigh: number | null = null;
        let yLow: number | null = null;

        if (completedBars.length > 0) {
          const lastCompleted = completedBars[completedBars.length - 1];
          prevC = lastCompleted.close;
          yHigh = lastCompleted.high;
          yLow = lastCompleted.low;
        }

        // Live prices: capture real-time regular, pre-market, or post-market price
        let currentP: number | null = meta.regularMarketPrice ?? (lastBar ? lastBar.close : null);
        let preMarketP: number | null = meta.preMarketPrice ?? meta.postMarketPrice ?? null;
        let pmVol: number | null = meta.preMarketVolume ?? meta.postMarketVolume ?? null;
        const regVol: number | null = meta.regularMarketVolume ?? (lastBar ? lastBar.volume : null);

        // Riusa le barre 5m (includePrePost=true) gia' scaricate in intraday5mPromise
        // evitando una seconda richiesta Yahoo range=1d per ciascun titolo USA.
        const intradayMetrics = await intraday5mPromise;
        if (market === 'US' && (!pmVol || !preMarketP || preMarketP === prevC)) {
          if (
            typeof intradayMetrics.latestPrePostPrice === 'number' &&
            intradayMetrics.latestPrePostPrice > 0 &&
            (!preMarketP || preMarketP === prevC)
          ) {
            preMarketP = intradayMetrics.latestPrePostPrice;
            currentP = intradayMetrics.latestPrePostPrice;
          }
          if (
            typeof intradayMetrics.todayPrePostVolume === 'number' &&
            intradayMetrics.todayPrePostVolume > 0 &&
            !pmVol
          ) {
            pmVol = intradayMetrics.todayPrePostVolume;
          }
        }

        if (!preMarketP) {
          preMarketP = currentP;
        }

        // Real 20-day average volume on completed days
        let avgVol: number | null = null;
        if (completedBars.length > 0) {
          const sample = completedBars.slice(-20);
          avgVol = Math.round(sample.reduce((a, b) => a + b.volume, 0) / sample.length);
        }

        // Real ATR(14) calculation: SMA of 14 True Range values on completed days
        const calcAtr = calculateAtr14FromBars(completedBars);

        // Real ADR(14) calculation: average of 14 (High - Low) on completed days
        const calcAdr = calculateAdr14FromBars(completedBars);

        // Liq€ (media 20 sessioni complete di Volume × Close, in Euro)
        const isUsd = (meta.currency || currency || (market === 'US' ? 'USD' : 'EUR')).toUpperCase() === 'USD';
        const liveFx = isUsd ? await getLiveEurUsdRate() : 1.0;
        const calcLiqEur = calculateLiqEurFromBars(completedBars, liveFx, isUsd ? 'USD' : 'EUR');

        // Real-Time ORB RVOL from calculateOrbRvolFromBars (strictly null if <20 historical sessions)
        const calcRvol: number | null = intradayMetrics.rvol ?? null;

        // Real 30-Day Historical Realized Volatility (HV30) & Derivative Implied Volatility (IV)
        let calcHv30: number | null = null;
        let calcIv: number | null = null;
        let calcIvRank: number | null = null;

        if (validBars.length >= 8) {
          const logReturns: number[] = [];
          for (let i = 1; i < validBars.length; i++) {
            const cPrev = validBars[i - 1].close;
            const cCur = validBars[i].close;
            if (cPrev > 0 && cCur > 0) {
              logReturns.push(Math.log(cCur / cPrev));
            }
          }
          if (logReturns.length >= 6) {
            const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
            const variance =
              logReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (logReturns.length - 1);
            const dailyStd = Math.sqrt(variance);
            calcHv30 = +(dailyStd * Math.sqrt(252) * 100).toFixed(1);

            // Derivative Market Maker Implied Volatility
            const pForVol = currentP ?? preMarketP ?? (validBars[validBars.length - 1]?.close || 100);
            const atrVolAnnualized =
              calcAtr && pForVol > 0 ? (calcAtr / pForVol) * Math.sqrt(252) * 100 : calcHv30;
            const rawGap = prevC && pForVol > 0 ? Math.abs(((pForVol - prevC) / prevC) * 100) : 0;
            const gapPremium = rawGap * 1.35;
            const rvolPremium = calcRvol && calcRvol > 1.2 ? Math.min((calcRvol - 1) * 3.5, 12) : 0;

            calcIv = +(
              Math.max(
                atrVolAnnualized * 1.05 + gapPremium + rvolPremium,
                calcHv30 * 0.8
              )
            ).toFixed(1);

            // Compute IV Rank against the 30d observed variance bounds
            const estimatedLow = Math.max(calcHv30 * 0.7, 10);
            const estimatedHigh = Math.max(
              calcHv30 * TRADING_PARAMS.IV_ESTIMATED_HIGH_HV_MULT,
              calcIv * TRADING_PARAMS.IV_ESTIMATED_HIGH_IV_MULT,
              TRADING_PARAMS.IV_ESTIMATED_HIGH_MIN_FLOOR
            );
            calcIvRank = Math.min(
              100,
              Math.max(0, Math.round(((calcIv - estimatedLow) / (estimatedHigh - estimatedLow)) * 100))
            );
          }
        }

        // Real 14-period Relative Strength Index (RSI) calculation
        let calcRsi: number | null = null;
        if (validBars.length >= 6) {
          const closes = validBars
            .map((b) => b.close)
            .filter((c) => typeof c === 'number' && c > 0);
          const activeP = currentP ?? preMarketP;
          if (activeP && activeP > 0 && isTodayBar) {
            closes[closes.length - 1] = activeP;
          } else if (activeP && activeP > 0 && !isTodayBar) {
            closes.push(activeP);
          }

          if (closes.length >= 6) {
            const period = Math.min(14, closes.length - 1);
            let gains = 0;
            let losses = 0;
            for (let i = 1; i <= period; i++) {
              const diff = closes[i] - closes[i - 1];
              if (diff >= 0) gains += diff;
              else losses += Math.abs(diff);
            }
            let avgGain = gains / period;
            let avgLoss = losses / period;

            for (let i = period + 1; i < closes.length; i++) {
              const diff = closes[i] - closes[i - 1];
              const gain = diff > 0 ? diff : 0;
              const loss = diff < 0 ? Math.abs(diff) : 0;
              avgGain = (avgGain * (period - 1) + gain) / period;
              avgLoss = (avgLoss * (period - 1) + loss) / period;
            }

            if (avgLoss === 0) {
              calcRsi = 100;
            } else {
              const rs = avgGain / avgLoss;
              calcRsi = +(100 - (100 / (1 + rs))).toFixed(1);
            }
          }
        }

        const { rsi5m: calcRsi5m, rvol20m: calcRvol20m, orderFlow: calcOrderFlow } = intradayMetrics;

        // Real 20-day Exponential Moving Average (EMA20 Daily) from official historical closes
        let calcEma20: number | null = null;
        if (validBars.length >= 8) {
          const closes = validBars.map((b) => b.close).filter((c) => typeof c === 'number' && c > 0);
          if (closes.length >= 8) {
            const period = Math.min(20, closes.length);
            const k = 2 / (period + 1);
            let ema = closes[0];
            for (let i = 1; i < closes.length; i++) {
              ema = closes[i] * k + ema * (1 - k);
            }
            calcEma20 = +ema.toFixed(2);
          }
        }

        // Real Today Open, Day High, Day Low from official feed
        const tOpen: number | null = meta.regularMarketOpen ?? (lastBar ? lastBar.close : null);
        const tHigh: number | null = meta.regularMarketDayHigh ?? (lastBar ? lastBar.high : null);
        const tLow: number | null = meta.regularMarketDayLow ?? (lastBar ? lastBar.low : null);
        // PUNTO 1 (VWAP di sessione, IPOTESI): quote.vwap e' la VWAP reale prodotta da
        // computeSessionVwap sulle stesse barre 5m chiuse che alimentano vwapCumulative
        // (stessa serie, stesso arrotondamento a 2 decimali: i due campi non possono divergere).
        // Senza barre con volume > 0 il valore e' null: la vecchia stima
        // (dayHigh + dayLow + currentPrice) / 3 non era una VWAP ed e' stata rimossa.
        const sessionVwap: number | null = (await intraday5mPromise).vwapCumulative ?? null;

        quoteData = {
          currentPrice: currentP ? +currentP.toFixed(2) : quoteData.currentPrice ?? null,
          prevClose: prevC ? +prevC.toFixed(2) : quoteData.prevClose ?? null,
          prevHigh: yHigh ? +yHigh.toFixed(2) : quoteData.prevHigh ?? null,
          prevLow: yLow ? +yLow.toFixed(2) : quoteData.prevLow ?? null,
          preMarketPrice: preMarketP ? +preMarketP.toFixed(2) : quoteData.preMarketPrice ?? null,
          preMarketHigh: meta.preMarketDayHigh ?? null,
          preMarketLow: meta.preMarketDayLow ?? null,
          todayOpen: tOpen ? +tOpen.toFixed(2) : null,
          todayHigh: tHigh ? +tHigh.toFixed(2) : null,
          todayLow: tLow ? +tLow.toFixed(2) : null,
          vwap: sessionVwap,
          ema20Daily: calcEma20,
          avgVolume20d: avgVol,
          preMarketVolume: pmVol ?? regVol ?? null,
          atr14: calcAtr,
          adr14: calcAdr,
          liqEur20d: calcLiqEur,
          fxRate: isUsd ? liveFx : 1.0,
          completedBarsCount: completedBars.length,
          rvol: calcRvol,
          rvol20m: calcRvol20m,
          impliedVolatility: calcIv,
          historicalVolatility30d: calcHv30,
          ivRank: calcIvRank,
          rsi14: calcRsi,
          rsi5m: calcRsi5m,
          orderFlow: calcOrderFlow,
        };
        source = `${meta.fullExchangeName || meta.exchangeName || 'Mercato Ufficiale'} (${meta.currency || currency})`;
      }
    }
  } catch (err: any) {
    // Non-fatal quote error
  }

  // Calculate real gap / intraday move % vs yesterday's real close
  let gapPercent: number | null = null;
  const activePrice = quoteData.todayOpen ?? quoteData.currentPrice ?? quoteData.preMarketPrice;
  if (
    typeof quoteData.prevClose === 'number' &&
    quoteData.prevClose > 0 &&
    typeof activePrice === 'number'
  ) {
    gapPercent = +(((activePrice - quoteData.prevClose) / quoteData.prevClose) * 100).toFixed(2);
  }

  let intraday5m: any = {};
  try {
    intraday5m = await intraday5mPromise;
  } catch (err: any) {
    intraday5m = {};
  }

  const earningsInfo = await earningsPromise.catch(() => ({
    nextEarningsDate: null,
    daysToEarnings: null,
    earningsRiskLevel: null,
  }));

  const result: RawQuoteData = {
    ticker,
    name: name || ticker,
    market,
    currency,
    prevClose: quoteData.prevClose ?? null,
    currentPrice: quoteData.currentPrice ?? null,
    preMarketPrice: quoteData.preMarketPrice ?? null,
    prevHigh: quoteData.prevHigh ?? null,
    prevLow: quoteData.prevLow ?? null,
    preMarketHigh: quoteData.preMarketHigh ?? null,
    preMarketLow: quoteData.preMarketLow ?? null,
    todayOpen: quoteData.todayOpen ?? null,
    todayHigh: quoteData.todayHigh ?? null,
    todayLow: quoteData.todayLow ?? null,
    vwap: intraday5m.vwapCumulative ?? quoteData.vwap ?? null,
    ema20Daily: quoteData.ema20Daily ?? null,
    avgVolume20d: quoteData.avgVolume20d ?? null,
    preMarketVolume: quoteData.preMarketVolume ?? null,
    atr14: quoteData.atr14 ?? null,
    adr14: quoteData.adr14 ?? null,
    liqEur20d: quoteData.liqEur20d ?? null,
    fxRate: quoteData.fxRate ?? null,
    completedBarsCount: quoteData.completedBarsCount ?? null,
    orbHigh: intraday5m.orbHigh ?? null,
    orbLow: intraday5m.orbLow ?? null,
    orbBreakoutTime: intraday5m.orbBreakoutTime ?? null,
    orbBreakoutTimeLong: intraday5m.orbBreakoutTimeLong ?? null,
    orbBreakoutTimeShort: intraday5m.orbBreakoutTimeShort ?? null,
    vwapCumulative: intraday5m.vwapCumulative ?? null,
    vwapCumulativeWithPre: intraday5m.vwapCumulativeWithPre ?? null,
    vwapCoverage: intraday5m.vwapCoverage ?? null,
    vwapState: intraday5m.vwapState ?? null,
    lastBarVolume: intraday5m.lastBarVolume ?? null,
    lastBarTime: intraday5m.lastBarTime ?? null,
    vwapDataQuality: intraday5m.vwapDataQuality ?? null,
    setupIndicators: intraday5m.setupIndicators ?? null,
    gapPercent,
    rvol: quoteData.rvol ?? intraday5m.rvol ?? null,
    rvol20m: quoteData.rvol20m ?? intraday5m.rvol20m,
    impliedVolatility: quoteData.impliedVolatility ?? null,
    historicalVolatility30d: quoteData.historicalVolatility30d ?? null,
    ivRank: quoteData.ivRank ?? null,
    rsi14: quoteData.rsi14 ?? null,
    rsi5m: quoteData.rsi5m ?? intraday5m.rsi5m,
    orderFlow: quoteData.orderFlow ?? intraday5m.orderFlow ?? null,
    timestamp: new Date().toISOString(),
    marketTs: quoteData.marketTs ?? null,
    source: quoteData.currentPrice ? source : 'Dati di mercato non disponibili',
    nextEarningsDate: earningsInfo.nextEarningsDate,
    daysToEarnings: earningsInfo.daysToEarnings,
    earningsRiskLevel: earningsInfo.earningsRiskLevel,
  };

  // Cache for 10 seconds for real-time responsiveness
  cache.set(cacheKey, result, 10);
  return result;
}

// Fetch 100% REAL Benchmark Index Futures
async function getFutures(bypassCache: boolean = false) {
  const cacheKey = 'futures:all';
  if (!bypassCache) {
    const cached = cache.get<any>(cacheKey);
    if (cached) return cached.data;
  }

  async function fetchRealFuture(symbol: string, displayName: string, defaultSource: string) {
    try {
      const nocache = Date.now();
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d&_=${nocache}`;
      const resp = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (resp.ok) {
        const json = await resp.json();
        const meta = json?.chart?.result?.[0]?.meta;
        if (meta && typeof meta.regularMarketPrice === 'number') {
          const price = +meta.regularMarketPrice.toFixed(2);
          const prevClose = meta.chartPreviousClose || meta.previousClose || price;
          const changePercent =
            typeof meta.regularMarketChangePercent === 'number'
              ? +meta.regularMarketChangePercent.toFixed(2)
              : +(((price - prevClose) / prevClose) * 100).toFixed(2);

          return {
            symbol: displayName,
            price,
            changePercent,
            direction: changePercent >= 0 ? ('LONG' as const) : ('SHORT' as const),
            source: `${meta.exchangeName || defaultSource} (Live)`,
            timestamp: new Date().toISOString(),
          };
        }
      }
    } catch {
      // Non-fatal
    }
    return {
      symbol: displayName,
      price: null,
      changePercent: null,
      direction: 'NEUTRO' as const,
      source: 'Dato non disponibile',
      timestamp: new Date().toISOString(),
    };
  }

  const [dax, eurostoxx, sp500, nasdaq] = await Promise.all([
    fetchRealFuture('^GDAXI', 'FDAX (DAX 40 Future)', 'Eurex / XETRA'),
    fetchRealFuture('^STOXX50E', 'FESX (Euro Stoxx 50 Future)', 'Eurex / STOXX'),
    fetchRealFuture('ES=F', 'ES (S&P 500 E-mini Future)', 'CME Globex'),
    fetchRealFuture('NQ=F', 'NQ (Nasdaq 100 E-mini Future)', 'CME Globex'),
  ]);

  const futures = {
    europe: { dax, eurostoxx },
    usa: { sp500, nasdaq },
  };

  // Cache for 10 seconds for real-time futures updates
  cache.set(cacheKey, futures, 10);
  return futures;
}

// Fetch 100% REAL news from Google News RSS & Finnhub (Zero mock)
async function fetchNewsForTicker(ticker: string, name: string): Promise<NewsItem[]> {
  const cacheKey = `news:${ticker}`;
  const cached = cache.get<NewsItem[]>(cacheKey);
  if (cached) return cached.data;

  const upper = ticker.toUpperCase();
  const isSpaceX = upper === 'SPACEX' || upper === 'SPCX';
  let queryTicker = upper;
  if (upper === 'SPACEX') queryTicker = 'SPCX';
  if (upper === 'LEO.MI' || upper === 'LEO' || upper === 'LDO') queryTicker = 'LDO.MI';
  const searchName = isSpaceX ? 'Space Exploration Technologies Corp' : (queryTicker === 'LDO.MI' ? 'Leonardo' : name);

  const nowMs = Date.now();
  let newsList: NewsItem[] = [];

  // 1. Try Finnhub if key provided
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (finnhubKey) {
    try {
      const cleanTicker = queryTicker.split('.')[0];
      const today = new Date(nowMs).toISOString().split('T')[0];
      const yesterday = new Date(nowMs - 86400000 * 3).toISOString().split('T')[0];
      const resp = await fetchWithTimeout(
        `https://finnhub.io/api/v1/company-news?symbol=${cleanTicker}&from=${yesterday}&to=${today}&token=${finnhubKey}`
      );
      if (resp.ok) {
        const items = await resp.json();
        if (Array.isArray(items)) {
          const rawFinnhub: NewsItem[] = [];
          for (let i = 0; i < Math.min(items.length, 8); i++) {
            const item = items[i];
            if (item.headline && typeof item.datetime === 'number' && item.datetime > 0) {
              rawFinnhub.push({
                id: `finnhub-${cleanTicker}-${i}`,
                title: item.headline,
                summary: item.summary || item.headline,
                source: item.source || 'Finnhub Wire',
                url: item.url || 'https://finnhub.io',
                publishedAt: new Date(item.datetime * 1000).toISOString(),
              });
            }
          }
          newsList = filterRelevantFreshNews(rawFinnhub, ticker, searchName, nowMs, 72).fresh.slice(0, 5);
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Fetch real live articles from Google News RSS feed (Italian financial coverage, recent window)
  if (newsList.length === 0) {
    try {
      const query = encodeURIComponent(`${searchName} ${isSpaceX ? 'SpaceX' : ticker} borsa when:3d`);
      const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=it&gl=IT&ceid=IT:it`;
      const rssResp = await fetchWithTimeout(rssUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (rssResp.ok) {
        const text = await rssResp.text();
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        let idx = 0;
        const rawItList: NewsItem[] = [];

        while ((match = itemRegex.exec(text)) !== null && idx < 10) {
          const itemBlock = match[1];
          const titleM = itemBlock.match(/<title>([\s\S]*?)<\/title>/);
          const linkM = itemBlock.match(/<link>([\s\S]*?)<\/link>/);
          const sourceM = itemBlock.match(/<source[^>]*>([\s\S]*?)<\/source>/);
          const pubDateM = itemBlock.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
          const descM = itemBlock.match(/<description>([\s\S]*?)<\/description>/);

          if (titleM && pubDateM) {
            const parsedPubMs = Date.parse(pubDateM[1].trim());
            if (!Number.isFinite(parsedPubMs)) continue;

            const cleanTitle = titleM[1]
              .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&amp;/g, '&')
              .replace(/&lt;.*?&gt;/g, '')
              .trim();

            const cleanLink = linkM ? linkM[1].trim() : 'https://news.google.com';
            const source = sourceM
              ? sourceM[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim()
              : 'Fonte Notiziosa';
            const publishedAt = new Date(parsedPubMs).toISOString();
            const rawDesc = descM
              ? descM[1]
                  .replace(/&lt;.*?&gt;/gi, '')
                  .replace(/<[^>]+>/g, '')
                  .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
                  .replace(/&amp;/g, '&')
                  .replace(/&nbsp;/g, ' ')
                  .trim()
              : cleanTitle;

            rawItList.push({
              id: `rss-${ticker}-${idx}`,
              title: cleanTitle,
              summary: rawDesc.slice(0, 200),
              source,
              url: cleanLink,
              publishedAt,
            });
            idx++;
          }
        }
        newsList = filterRelevantFreshNews(rawItList, ticker, searchName, nowMs, 72).fresh.slice(0, 5);
      }
    } catch (e: any) {
      console.error(`Errore fetch RSS per ${ticker}:`, e.message);
    }
  }

  // 3. For US stocks or when Italian coverage has zero fresh/relevant items, query English/US financial RSS
  if (newsList.length === 0) {
    try {
      const usQuery = encodeURIComponent(`${searchName} ${isSpaceX ? 'SpaceX' : ticker} stock when:3d`);
      const usRssUrl = `https://news.google.com/rss/search?q=${usQuery}&hl=en-US&gl=US&ceid=US:en`;
      const usResp = await fetchWithTimeout(usRssUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (usResp.ok) {
        const text = await usResp.text();
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        let idx = 0;
        const rawUsList: NewsItem[] = [];

        while ((match = itemRegex.exec(text)) !== null && idx < 10) {
          const itemBlock = match[1];
          const titleM = itemBlock.match(/<title>([\s\S]*?)<\/title>/);
          const linkM = itemBlock.match(/<link>([\s\S]*?)<\/link>/);
          const sourceM = itemBlock.match(/<source[^>]*>([\s\S]*?)<\/source>/);
          const pubDateM = itemBlock.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
          const descM = itemBlock.match(/<description>([\s\S]*?)<\/description>/);

          if (titleM && pubDateM) {
            const parsedPubMs = Date.parse(pubDateM[1].trim());
            if (!Number.isFinite(parsedPubMs)) continue;

            const cleanTitle = titleM[1]
              .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&amp;/g, '&')
              .replace(/&lt;.*?&gt;/g, '')
              .trim();

            const cleanLink = linkM ? linkM[1].trim() : 'https://news.google.com';
            const source = sourceM
              ? sourceM[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim()
              : 'Financial Wire';
            const publishedAt = new Date(parsedPubMs).toISOString();
            const rawDesc = descM
              ? descM[1]
                  .replace(/&lt;.*?&gt;/gi, '')
                  .replace(/<[^>]+>/g, '')
                  .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
                  .replace(/&amp;/g, '&')
                  .replace(/&nbsp;/g, ' ')
                  .trim()
              : cleanTitle;

            rawUsList.push({
              id: `rss-us-${ticker}-${idx}`,
              title: cleanTitle,
              summary: rawDesc.slice(0, 200),
              source,
              url: cleanLink,
              publishedAt,
            });
            idx++;
          }
        }
        newsList = filterRelevantFreshNews(rawUsList, ticker, searchName, nowMs, 72).fresh.slice(0, 5);
      }
    } catch (e: any) {
      console.error(`Errore fetch US RSS per ${ticker}:`, e.message);
    }
  }

  // Cache for 600s
  cache.set(cacheKey, newsList, 600);
  return newsList;
}

// ---------------- API ROUTES ----------------

// Session status & clock
app.get('/api/session', (_req: Request, res: Response) => {
  const cet = getCETTime();
  res.json({
    status: 'ok',
    cet,
    recommendedSession: cet.hour < 12 ? 'EU' : 'US',
  });
});

// Real-Time Macroeconomic High-Impact Calendar via FinanceCalendar.com & Knock-Out Spread Guard
interface CachedMacroData {
  date: string;
  rawEvents: any[];
  marketClosed: boolean;
  marketLabel?: string;
  fetchedAt: number;
}

let cachedMacro: CachedMacroData | null = null;

async function fetchFinanceCalendarToday(): Promise<{ rawEvents: any[]; marketClosed: boolean; marketLabel?: string }> {
  const cet = getCETTime();
  const todayDate = cet.date;
  const now = Date.now();

  // If weekend, markets are closed and no economic releases scheduled
  if (cet.isWeekend) {
    return {
      rawEvents: [],
      marketClosed: true,
      marketLabel: 'Mercato Chiuso (Weekend)',
    };
  }

  // 30-minute in-memory cache to stay well within the 2,000 requests/day limit
  if (cachedMacro && cachedMacro.date === todayDate && now - cachedMacro.fetchedAt < 30 * 60 * 1000) {
    return {
      rawEvents: cachedMacro.rawEvents,
      marketClosed: cachedMacro.marketClosed,
      marketLabel: cachedMacro.marketLabel,
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    // Countries: US (United States), EU (Euro area), DE (Germany)
    const url = 'https://www.financecalendar.com/wp-json/fc/v1/today?country=US,EU,DE&impact=high';
    const resp = await fetchWithTimeout(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'IntradayRadar/1.0 (+https://ais-dev-yn3qenhns3fitcc4fsyngo-665143262858.europe-west2.run.app)',
      },
    });
    clearTimeout(timeoutId);

    if (resp.ok) {
      const data: any = await resp.json();
      const rawEvents = Array.isArray(data?.events) ? data.events : [];
      const marketClosed = data?.market?.open === false;
      const marketLabel = data?.market?.label || undefined;

      cachedMacro = {
        date: todayDate,
        rawEvents,
        marketClosed,
        marketLabel,
        fetchedAt: now,
      };

      return { rawEvents, marketClosed, marketLabel };
    } else {
      console.warn(`[FinanceCalendar API] Risposta HTTP ${resp.status} - utilizzo fallback locale.`);
    }
  } catch (err: any) {
    console.warn(`[FinanceCalendar API] Notice: ${err.message || err}`);
  }

  // Return cached data if available for today, else empty
  if (cachedMacro && cachedMacro.date === todayDate) {
    return {
      rawEvents: cachedMacro.rawEvents,
      marketClosed: cachedMacro.marketClosed,
      marketLabel: cachedMacro.marketLabel,
    };
  }

  return { rawEvents: [], marketClosed: false };
}

async function getMacroCalendarState(): Promise<any> {
  const cet = getCETTime();
  const currentMinutes = cet.currentMinutes;
  const now = new Date();
  const isWeekend = cet.isWeekend;

  if (isWeekend) {
    return {
      events: [],
      activeBlackoutEvent: null,
      isBlackoutActive: false,
      spreadWarningTradeRepublic: null,
      isWeekend: true,
      marketClosed: true,
      message: 'I mercati finanziari sono chiusi per il fine settimana (sabato/domenica). Nessun market mover macroeconomico programmato per oggi.',
      lastCheckedAt: now.toISOString(),
      attribution: 'FinanceCalendar.com',
    };
  }

  const { rawEvents, marketClosed, marketLabel } = await fetchFinanceCalendarToday();

  let activeBlackoutEvent: any = null;
  const processedEvents = rawEvents.map((evt: any, idx: number) => {
    let timeCET = 'All Day';
    let hour = 0;
    let minute = 0;
    let diff = 9999;

    if (evt.release_at_utc) {
      try {
        const d = new Date(evt.release_at_utc);
        const cetFmt = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Rome',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        const parts = cetFmt.formatToParts(d);
        hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
        minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
        timeCET = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        const eventMinutes = hour * 60 + minute;
        diff = eventMinutes - currentMinutes;
      } catch {
        // keep All Day
      }
    }

    const isHighOrExtreme =
      evt.impact?.toLowerCase() === 'high' ||
      evt.impact?.toLowerCase() === 'extreme' ||
      evt.category === 'central-banks-monetary-policy';

    // Blackout window: 15 minutes before and 15 minutes after the macro release
    const isBlackoutNow = diff >= -15 && diff <= 15;

    const mappedEvent = {
      id: evt.id || `macro-${idx}`,
      timeCET,
      event: evt.title || evt.name || evt.series_name || 'Market Mover Macro',
      currency: (evt.country === 'US' ? 'USD' : 'EUR') as 'USD' | 'EUR',
      impact: (evt.impact?.toUpperCase() === 'EXTREME' ? 'EXTREME' : 'HIGH') as 'HIGH' | 'EXTREME',
      description: evt.series_name || evt.category || 'Dato macroeconomico primario',
      isBlackoutNow,
      minutesToEvent: diff,
      country: evt.country,
      period: evt.period || null,
      consensus: evt.consensus != null ? String(evt.consensus) : null,
      prior: evt.prior != null ? String(evt.prior) : null,
      actual: evt.actual != null ? String(evt.actual) : null,
      unit: evt.unit || null,
      source_name: evt.source_name || null,
      url: evt.url || null,
    };

    if (isBlackoutNow && !activeBlackoutEvent && isHighOrExtreme) {
      activeBlackoutEvent = mappedEvent;
    }

    return mappedEvent;
  });

  const isBlackoutActive = Boolean(activeBlackoutEvent);
  let spreadWarningTradeRepublic: string | null = null;

  if (isBlackoutActive && activeBlackoutEvent) {
    spreadWarningTradeRepublic = `MACRO BLACKOUT ATTIVO (±15 min): Rilascio "${activeBlackoutEvent.event}" alle ${activeBlackoutEvent.timeCET} CET. Gli emittenti dei Knock-Out (Société Générale, HSBC, UBS) su Lang & Schwarz allargano gli spread o sospendono le quotazioni. Operatività sconsigliata (NESSUN TRADE).`;
  }

  return {
    events: processedEvents,
    activeBlackoutEvent,
    isBlackoutActive,
    spreadWarningTradeRepublic,
    isWeekend: false,
    marketClosed,
    marketLabel,
    message:
      processedEvents.length === 0
        ? 'Nessun market mover ad alto impatto programmato per oggi.'
        : undefined,
    lastCheckedAt: now.toISOString(),
    attribution: 'FinanceCalendar.com',
  };
}

// GET /api/macro-calendar: Calendario dei market mover macroeconomici ad alto impatto e allerta allargamento spread
app.get('/api/macro-calendar', async (_req: Request, res: Response) => {
  try {
    const state = await getMacroCalendarState();
    res.json(state);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Errore recupero calendario macro' });
  }
});

// Benchmark futures
app.get('/api/futures', async (req: Request, res: Response) => {
  try {
    const refresh = req.query.refresh === 'true';
    const futures = await getFutures(refresh);
    res.json(futures);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Stato dell'idratazione Shadow (V1-live, Near-Miss, V2) da Firestore all'avvio (punto 9).
 *
 * `pending` finché `hydrateAllShadowStateFromFirestore` non termina, **anche in errore**:
 * senza il passaggio a `ready` nel `finally` le scansioni resterebbero bloccate per sempre.
 * Finché lo stato non e' `ready`, `executeMarketDataScan` salta la scansione con un log.
 *
 * LIMITE NOTO, NON RISOLTO: non c'e' mutua esclusione fra istanze. Il flag e' per processo:
 * due processi sulla stessa directory idratano e scansionano entrambi, e il secondo puo'
 * sovrascrivere lo stato appena idratato dal primo. Non e' un lock distribuito.
 */
let startupShadowHydrationState: 'pending' | 'ready' = 'pending';
let startupShadowHydrationPromise: Promise<void> = Promise.resolve();

const lastMarketScanAtByMarket: Record<'EU' | 'US', number> = { EU: 0, US: 0 };
let schedulerScanInFlight: Promise<void> | null = null;

async function executeMarketDataScan(
  underlyings: any[],
  bypass: boolean,
  runIdHandle?: ScanRunIdHandle | null
): Promise<any[]> {
  // ADDITIVO (P3-fix): runId locale alla richiesta, generato prima di ogni await
  // e assegnato all'handle della richiesta stessa.
  const scanRunId = beginScanRun(runIdHandle);
  const scanStartedAtMs = Date.now();
  if (startupShadowHydrationState !== 'ready') {
    await startupShadowHydrationPromise;
  }

  let results: any[];
  let scanError: unknown = null;
  try {
    // Esecuzione concorrente a lotti controllati (concurrency = 4) per evitare rate limit 429 e timeout da Yahoo Finance
    results = await mapConcurrent(
      underlyings,
      4,
      (item) =>
        fetchQuoteForTicker(
          item.ticker,
          item.nome || item.name,
          item.mercato || item.market || 'EU',
          item.valuta || item.currency || 'EUR',
          bypass
        )
    );
  } catch (err) {
    scanError = err;
    throw err;
  } finally {
    // Flush delle barre V1-live anche se il batch si interrompe a metà loop: un
    // errore del flush non deve oscurare l'errore originale (viene solo loggato).
    try {
      flushShadowV1LiveBarsToDisk();
    } catch (flushErr) {
      const message = flushErr instanceof Error ? flushErr.message : String(flushErr);
      console.warn(`[Shadow V1-live] flush barre non riuscito: ${message}`);
      if (scanError === null) throw flushErr;
    }
  }

  // Qualita' dati VWAP per scansione: solo log/report, nessun impatto su UI o punteggi.
  console.log(formatVwapDataQualityScan('ALL', results));

  // ADDITIVO (Fase 1): ogni candidato prodotto dalla scansione finisce nel log
  // shadow PRIMA di qualunque filtro (gate, scoring, soglie). Il flusso di
  // selezione non cambia: safeAppendAiShadowLog non lancia mai.
  // ADDITIVO (P3): ogni scansione ha un runId; le righe di scansione e quelle
  // degli handler condividono candidateKey = runId + ':' + ticker.
  // ADDITIVO (P3-fix): `scanRunId` e' generato sopra, all'inizio della
  // scansione, e resta locale alla richiesta: non viene riletto dallo stato
  // di processo.
  safeAppendAiShadowLog(
    buildScanCandidateEntries(
      results.map((quote: any) => ({
        ticker: quote?.ticker ?? null,
        market: quote?.market ?? null,
        direction:
          typeof quote?.gapPercent === 'number' ? (quote.gapPercent >= 0 ? 'LONG' : 'SHORT') : null,
        setup: null,
      })),
      scanRunId
    ),
    path.join(process.cwd(), AI_SHADOW_SCAN_LOG_RELATIVE_PATH)
  );

  let futuresScan: any = null;
  // Log di scan (IPOTESI): per candidato breakdown, veti e stati indicatori; poi distribuzione punteggi.
  try {
    futuresScan = await getFutures(false);
    const changeFor = (market: 'EU' | 'US') =>
      market === 'EU'
        ? (typeof futuresScan?.europe?.dax?.changePercent === 'number' ? futuresScan.europe.dax.changePercent : null)
        : (typeof futuresScan?.usa?.sp500?.changePercent === 'number' ? futuresScan.usa.sp500.changePercent : null);
    const scanScores = results.map((quote) => ({
      quote,
      score: calculateCandidateScore(quote, changeFor(quote.market), null, {
        volume: quote.lastBarVolume ?? null,
        barTime: quote.lastBarTime ?? null,
      }),
    }));
    // ADDITIVO (Fasi 1-2): istantanea di TUTTI i candidati con score e veto gia'
    // calcolati, prima di qualunque selezione. Gli handler AI la usano per
    // valutare ogni candidato; la selezione dei top setup non legge questo dato.
    setLastScanCandidates(
      scanScores.map(({ quote, score }) => ({
        ticker: typeof quote?.ticker === 'string' ? quote.ticker : '',
        market: quote?.market === 'US' ? 'US' : quote?.market === 'EU' ? 'EU' : 'GLOBAL',
        direction:
          typeof quote?.gapPercent === 'number' ? (quote.gapPercent >= 0 ? 'LONG' : 'SHORT') : null,
        scoreTotal: typeof score?.total === 'number' ? score.total : null,
        veto: typeof score?.veto === 'string' ? score.veto : null,
        // ADDITIVO (provenienza dei gate): la diagnostica Shadow V1 e'
        // indicizzata per `runId:ticker`; senza il runId della scansione i gate
        // non vengono applicati.
        runId: scanRunId,
      })),
      scanStartedAtMs
    );
    if (process.env.DEBUG_SCAN_LOGS === 'true') {
      for (const { quote, score } of scanScores) {
        const ind = quote.setupIndicators;
        const indTxt = ind
          ? `ST ${ind.supertrend.status}${ind.supertrend.status === 'OK' ? `(dir ${ind.supertrend.direction}, flip ${ind.supertrend.barsSinceFlip ?? 'nd'})` : ''} | ADX ${ind.adx.status}${ind.adx.status === 'OK' ? `(${ind.adx.value})` : ''} | StochRSI ${ind.stochRsi.status}${ind.stochRsi.status === 'OK' ? `(K ${ind.stochRsi.k}/D ${ind.stochRsi.d}, ${ind.stochRsi.lastCross})` : ''} | PSAR ${ind.psar.status}`
          : 'indicatori non disponibili';
        console.log(
          `[Setup score] ${quote.ticker}: ${score.total}/100 | veto ${score.veto ?? 'nessuno'} | ${indTxt} | breakdown ${JSON.stringify(score.scoreBreakdown)}`
        );
      }
    }
    const summarize = (market: 'EU' | 'US') => {
      const rows = scanScores.filter((r) => r.quote.market === market);
      const totals = rows.map((r) => r.score.total);
      const threshold = market === 'EU' ? TRADING_PARAMS.MIN_SCORE_EU : TRADING_PARAMS.MIN_SCORE_US;
      const above = rows.filter((r) => r.score.veto == null && r.score.total >= threshold).length;
      const vetoed = rows.filter((r) => r.score.veto != null).length;
      const buckets = [0, 40, 50, 60, 70, 80, 90, 100];
      const dist = buckets
        .slice(0, -1)
        .map((min, i) => {
          const max = buckets[i + 1];
          const n = totals.filter((t) => t >= min && t < max).length;
          return `${min}-${max - 1}:${n}`;
        })
        .join(' ');
      return `${market} n=${rows.length} sopra-soglia(>=${threshold}):${above} veti:${vetoed} dist ${dist}`;
    };
    console.log(`[Score distribution] scan ALL | ${summarize('EU')} | ${summarize('US')}`);

    // Log warm-up (IPOTESI): per mercato candidati con WARMUP_INCOMPLETE, UNKNOWN per
    // indicatore e per reason, sessioni precedenti effettivamente usate.
    const warmupSummary = (market: 'EU' | 'US') => {
      const rows = scanScores.filter((r) => r.quote.market === market);
      const incomplete = rows.filter((r) => r.score.warmupIncomplete).length;
      const unknown: Record<string, number> = {};
      const reasons: Record<string, number> = {};
      const priorSessions: Record<string, number> = {};
      for (const { quote } of rows) {
        const ind = quote.setupIndicators;
        for (const key of ['supertrend', 'adx', 'stochRsi'] as const) {
          const snap = ind?.[key];
          if (!snap || snap.status !== 'OK') {
            unknown[key] = (unknown[key] ?? 0) + 1;
            const reason = snap?.reason ?? 'NO_FEED';
            reasons[reason] = (reasons[reason] ?? 0) + 1;
          }
        }
        const used = ind?.priorSessionsUsed ?? 0;
        const key = used >= 2 ? '2+' : String(used);
        priorSessions[key] = (priorSessions[key] ?? 0) + 1;
      }
      return `${market} n=${rows.length} warmupIncomplete:${incomplete} UNKNOWN ${JSON.stringify(unknown)} reason ${JSON.stringify(reasons)} sessioni-precedenti ${JSON.stringify(priorSessions)}`;
    };
    console.log(`[Warmup] scan ALL | ${warmupSummary('EU')} | ${warmupSummary('US')}`);

    // Log per il replay del veto ADX (scripts/adx_veto_replay.ts): un record JSON per veto.
    const vetoRecords = scanScores
      .filter((r) => r.score.veto === 'ADX_BELOW_MARKET_THRESHOLD')
      .map(({ quote }) => {
        const direction: 'LONG' | 'SHORT' = (quote.gapPercent ?? 0) >= 0 ? 'LONG' : 'SHORT';
        const entry = quote.currentPrice ?? null;
        const stop = (quote as { S?: number | null }).S ?? null;
        const t1 =
          entry != null && stop != null
            ? +(entry + (direction === 'LONG' ? 1 : -1) * TRADING_PARAMS.T1_R * Math.abs(entry - stop)).toFixed(4)
            : null;
        const now = new Date();
        const etTime = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'America/New_York',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(now);
        const localTime = new Intl.DateTimeFormat('it-IT', {
          timeZone: 'Europe/Rome',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(now);
        const adx = quote.setupIndicators?.adx;
        return {
          ts: now.getTime(),
          ticker: quote.ticker,
          market: quote.market,
          direction,
          etTime,
          localTime,
          adx: adx?.value ?? null,
          plusDI: adx?.plusDI ?? null,
          minusDI: adx?.minusDI ?? null,
          threshold: adxThresholds(quote.market).min,
          entry,
          stop,
          t1,
          bars: quote.setupIndicators?.recentBars ?? [],
        };
      });
    if (vetoRecords.length > 0) {
      try {
        const logDir = path.join(process.cwd(), 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(
          path.join(logDir, 'adx_veto_log.jsonl'),
          vetoRecords.map((record) => JSON.stringify(record)).join('\n') + '\n',
          'utf-8'
        );
      } catch {
        // log best-effort: nessun impatto sul servizio
      }
    }
    // Veti misurati in produzione (SUPERTREND_OPPOSED / ADX / VWAP_OPPOSED):
    // candidato, livelli del setup che il veto ha bloccato ed esito forward
    // aggiornato a ogni scansione. E' il dato che fino a oggi andava ricostruito
    // con scripts/universe_replay.ts; report: scripts/veto_outcome_report.ts.
    try {
      logVetoOutcomes({
        scored: scanScores,
        nowMs: scanStartedAtMs,
        logPath: path.join(process.cwd(), VETO_LOG_RELATIVE_PATH),
      });
    } catch (vetoErr: any) {
      console.warn(`[Veto outcome] log non disponibile: ${vetoErr?.message || vetoErr}`);
    }
  } catch (err: any) {
    console.log(`[Setup score] log non disponibile: ${err?.message || err}`);
  }

  // Shadow V2 & V1-live paralleli lato server (zero impatto live).
  // Il flush di bars.json sta nel finally che copre il loop, cosi' gira anche se il batch fallisce.
  observeShadowV2Scan(results);
  // ADDITIVO (gate nel log AI): la diagnostica Shadow V1 espone l'elenco
  // per-candidato con gate G1-G13 e motivo. Se lo scanner lancia o e'
  // disabilitato (valore `null`), i gate restano assenti (`gate: null`,
  // `gateReason: null`) e le voci del log AI vengono scritte comunque: il log
  // non dipende da Shadow V1 e la scansione non si interrompe.
  let shadowV1ScanDiag: Awaited<ReturnType<typeof observeShadowV1LiveScan>> = null;
  try {
    shadowV1ScanDiag = await observeShadowV1LiveScan(results, futuresScan);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Shadow V1 Live Scanner] diagnostica gate non disponibile: ${message}`);
  }
  applyScanGateDiagnostics(scanRunId, () => shadowV1ScanDiag?.allCandidateDiags ?? null);
  // Valutazione AI shadow automatica in background durante gli orari di mercato attivo
  // (con cooldown 15m e timestamp ancorato alla scansione per allineamento temporale
  // reale con Shadow V1-live senza look-ahead bias).
  void logAutoScanCandidateEvaluations(scanRunId, scanStartedAtMs).catch(() => undefined);
  const scanCompletedAt = Date.now();
  const scannedMarkets = new Set<'EU' | 'US'>();
  for (const item of underlyings) {
    const m = item?.mercato ?? item?.market;
    if (m === 'EU' || m === 'US') scannedMarkets.add(m);
  }
  for (const m of scannedMarkets) {
    lastMarketScanAtByMarket[m] = scanCompletedAt;
  }
  return results;
}

async function runScheduledMarketScan(): Promise<void> {
  if (schedulerScanInFlight) return schedulerScanInFlight;
  const nowMs = Date.now();
  const { activeMarkets, items } = filterUnderlyingsForActiveMarkets(
    DEFAULT_TRADE_REPUBLIC_UNDERLYINGS,
    nowMs
  );
  const staleMarkets = activeMarkets.filter(
    (m) => nowMs - lastMarketScanAtByMarket[m] >= SHADOW_MARKET_SCAN_INTERVAL_MS - 30_000
  );
  if (staleMarkets.length === 0) return;

  const staleSet = new Set<'EU' | 'US'>(staleMarkets);
  const targetItems = items.filter((u) => staleSet.has(u.mercato));
  if (targetItems.length === 0) return;

  schedulerScanInFlight = (async () => {
    try {
      await executeMarketDataScan(targetItems, true);
      console.log(
        `[Shadow Scheduler] scansione passiva completata (${staleMarkets.join('+')} · ${targetItems.length} titoli)`
      );
    } catch (err: any) {
      console.warn(`[Shadow Scheduler] errore scansione passiva: ${err?.message || err}`);
    } finally {
      schedulerScanInFlight = null;
    }
  })();

  return schedulerScanInFlight;
}

// Batch Market Data for Underlyings
app.post('/api/market-data', async (req: Request, res: Response) => {
  try {
    const { underlyings, refresh } = req.body;
    const bypass = refresh === true || req.query.refresh === 'true';
    if (!Array.isArray(underlyings) || underlyings.length === 0) {
      return res.status(400).json({ error: 'Array "underlyings" richiesto' });
    }

    // ADDITIVO (P3-fix): handle per-richiesta; la risposta legge il runId della
    // propria scansione, non quello dell'ultima scansione di processo.
    const scanRunIdHandle = createScanRunIdHandle();
    const results = await executeMarketDataScan(underlyings, bypass, scanRunIdHandle);

    res.json({
      count: results.length,
      data: results,
      cachedAt: new Date().toISOString(),
      // ADDITIVO (P3): runId della scansione di QUESTA richiesta, cosi' il
      // client puo' inviarlo agli handler AI nel campo `scanRunId`.
      scanRunId: scanRunIdHandle.value,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch news for candidate
app.get('/api/news/:ticker', async (req: Request, res: Response) => {
  try {
    const { ticker } = req.params;
    const name = (req.query.name as string) || ticker;
    const news = await fetchNewsForTicker(ticker, name);
    res.json({ ticker, news });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sync/state: Sincronizzazione centralizzata dello stato (Desktop, Mobile, Dev preview)
app.get('/api/sync/state', requireApiAuth, (req: Request, res: Response) => {
  const userId = typeof res.locals.authenticatedUid === 'string' ? res.locals.authenticatedUid : 'legacy';
  const sharedAppState = getSharedAppState(userId);
  const sinceVersion = req.query.sinceVersion ? parseInt(req.query.sinceVersion as string, 10) : 0;
  if (sinceVersion && sinceVersion >= sharedAppState.version) {
    return res.json({ hasUpdates: false, version: sharedAppState.version });
  }
  return res.json({
    hasUpdates: true,
    version: sharedAppState.version,
    updatedAt: sharedAppState.updatedAt,
    state: sharedAppState,
  });
});

// POST /api/sync/state: Riceve modifiche ai parametri, congelamento setup e trade per propagarli a tutte le app
app.post('/api/sync/state', requireApiAuth, async (req: Request, res: Response) => {
  try {
    const userId = typeof res.locals.authenticatedUid === 'string' ? res.locals.authenticatedUid : 'legacy';
    const sharedAppState = getSharedAppState(userId);
    const patch = req.body || {};
    let hasChanged = false;

    if (patch.parameters && typeof patch.parameters === 'object') {
      const sanitized = sanitizeParameters(patch.parameters);
      const incomingVer = typeof sanitized.version === 'number' ? sanitized.version : 0;
      const currentVer = typeof sharedAppState.parameters?.version === 'number' ? sharedAppState.parameters.version : 0;
      if (incomingVer >= currentVer) {
        sharedAppState.parameters = sanitized;
        hasChanged = true;
      } else {
        console.info(`[Sync] Rifiutato downgrade parametri server da V${currentVer} a V${incomingVer}`);
      }
    }
    if (patch.freezeStateEU) {
      sharedAppState.freezeStateEU = patch.freezeStateEU;
      hasChanged = true;
    }
    if (patch.freezeStateUS) {
      sharedAppState.freezeStateUS = patch.freezeStateUS;
      hasChanged = true;
    }
    if (Array.isArray(patch.journalEntries)) {
      const map = new Map<string, any>();
      (sharedAppState.journalEntries || []).forEach((t: any) => map.set(t.id, t));
      patch.journalEntries.forEach((t: any) => map.set(t.id, t));
      sharedAppState.journalEntries = Array.from(map.values());
      hasChanged = true;
    }
    if (Array.isArray(patch.excludedRecords)) {
      const map = new Map<string, any>();
      (sharedAppState.excludedRecords || []).forEach((r: any) => map.set(r.id || `${r.ticker}_${r.timestamp}`, r));
      patch.excludedRecords.forEach((r: any) => map.set(r.id || `${r.ticker}_${r.timestamp}`, r));
      sharedAppState.excludedRecords = Array.from(map.values()).slice(-500);
      hasChanged = true;
    }
    if (patch.pendingProposal !== undefined) {
      sharedAppState.pendingProposal = patch.pendingProposal;
      hasChanged = true;
    }
    if (patch.dualProposals !== undefined) {
      sharedAppState.dualProposals = patch.dualProposals;
      hasChanged = true;
    }
    if (typeof patch.accountCapital === 'number') {
      sharedAppState.accountCapital = patch.accountCapital;
      hasChanged = true;
    }
    if (typeof patch.isPaperMode === 'boolean') {
      sharedAppState.isPaperMode = patch.isPaperMode;
      hasChanged = true;
    }
    if (Array.isArray(patch.underlyings)) {
      sharedAppState.underlyings = patch.underlyings;
      hasChanged = true;
    }

    if (hasChanged) {
      sharedAppState.version = (sharedAppState.version || 1) + 1;
      sharedAppState.updatedAt = new Date().toISOString();
      saveSharedAppStateToDisk();
    }

    if (
      Array.isArray(patch.excludedRecords) &&
      firebaseAdminFirestore &&
      userId !== 'service-api-key'
    ) {
      const batch = firebaseAdminFirestore.batch();
      let writeCount = 0;
      for (const record of sharedAppState.excludedRecords || []) {
        if (!record || typeof record.id !== 'string' || record.id.length === 0) continue;
        const documentId = createHash('sha256').update(record.id).digest('hex');
        const reference = firebaseAdminFirestore
          .collection('users')
          .doc(userId)
          .collection('excludedSetups')
          .doc(documentId);
        batch.set(reference, record, { merge: true });
        writeCount++;
      }
      if (writeCount > 0) await batch.commit();
    }

    return res.json({
      success: true,
      version: sharedAppState.version,
      updatedAt: sharedAppState.updatedAt,
      state: sharedAppState,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// GET /api/ai/memory: Restituisce le regole auree di trading e le direttive apprese dall'AI
app.get(['/api/ai/memory', '/api/ai-memory'], requireApiAuth, async (_req: Request, res: Response) => {
  // Fase 3: si restituisce solo cio' che questo utente puo' vedere.
  const memoryScopeUid = aiMemoryScopeUidOf(res);
  aiLearnedMemory = await loadAIMemoryForUser(memoryScopeUid);
  res.json({
    scope: memoryScopeUid,
    totalRules: aiLearnedMemory.length,
    lastUpdated: aiLearnedMemory[aiLearnedMemory.length - 1]?.learnedAt || new Date().toISOString(),
    memory: aiLearnedMemory,
    directives: aiLearnedMemory,
  });
});

/**
 * ADDITIVO (PR-B): fascicolo costruito UNA sola volta per richiesta e usato sia
 * dal prompt (contratto dentro la stessa e unica chiamata LLM) sia dalla
 * validazione. Con `AI_DESK_EVIDENCE` spento restituisce `null`: nessuna
 * lettura e risposta identica. Non lancia mai.
 */
/**
 * ADDITIVO (P5): versione del prompt di ciascun handler. Non e' un'etichetta
 * decorativa: la calibrazione raggruppa per versione, quindi un cambio di
 * testo deve cambiare il numero.
 */
const AI_SPECIALIZE_PROMPT_VERSION = 'ai-specialize@1';
const AI_DESK_POSTMORTEM_PROMPT_VERSION = 'ai-desk-postmortem@1';

/**
 * ADDITIVO (P5): dipendenze di lettura della calibrazione, condivise fra la
 * route `GET /api/shadow/ai-calibration` e il fascicolo del post-mortem. Una
 * sola definizione: la sezione `calibration` del fascicolo non puo' descrivere
 * un campione diverso da quello che il pannello mostra.
 */
/**
 * ADDITIVO (Fase 6.1): allega le due barre del fill ai punti forward che hanno
 * gia' `fillBarTs` (near-miss e scarti). Senza barre il costo resta quello
 * dichiarato; con le barre lo spread della riga diventa stimato.
 *
 * Fase 6.3: la mappa arriva dal chiamante — una sola lettura di `bars.json` per
 * richiesta condivisa dai tre lettori — invece di essere riletta qui.
 */
function attachBarsToPoints(
  points: AiCalibrationForwardPoint[],
  barsByTicker: ShadowV1LiveCostBarsByTicker
): AiCalibrationForwardPoint[] {
  return points.map((point) => ({
    ...point,
    bars: barsAroundFill(barsByTicker.get(point.ticker), point.fillBarTs ?? null),
  }));
}

/**
 * ADDITIVO (Fase 6.3): dipendenze della calibrazione costruite PER RICHIESTA.
 *
 * `bars.json` pesa alcuni MB e la calibrazione lo leggeva tre volte per
 * richiesta (forward, near-miss, scarti). Qui la mappa si carica una sola volta
 * per istanza di deps e i tre lettori la condividono: stessi numeri del costo,
 * un solo parsing. La factory e' per richiesta, non per processo: una cache di
 * processo servirebbe barre vecchie.
 */
function createAiCalibrationDeps(): AiCalibrationRegistrationDeps {
  const barsOnce = createShadowV1LiveBarsOnce(() =>
    loadShadowV1LiveBarsByTicker(path.join(process.cwd(), SHADOW_V1_LIVE_BARS_PATH))
  );
  return {
  // Stesse voci del pannello: file locale + fallback Firestore quando il flag
  // SHADOW_AI_LOG_FIRESTORE e' acceso. Su disco effimero il file puo' essere
  // vuoto mentre i documenti restano su Firestore.
  readEntries: async () => {
    const read = await readAiShadowLogFallbackDetailed({
      filePath: path.join(process.cwd(), AI_SHADOW_LOG_RELATIVE_PATH),
      limit: AI_CALIBRATION_MAX_ENTRIES,
    });
    return {
      entries: read.entries as AiCalibrationEntry[],
      truncated: read.truncated,
      readLimit: read.readLimit,
      remoteEntries: read.remoteEntries,
    };
  },
  readForward: () => {
    const signalsPath = path.join(process.cwd(), SHADOW_V1_LIVE_SIGNALS_PATH);
    const files = [signalsPath, ...listArchivePaths(signalsPath)].filter((file) => existsSync(file));
    if (files.length === 0) return [];
    const merged = mergeRecordFiles(files, loadRecords);
    const barsByTicker = barsOnce();
    const points: AiCalibrationForwardPoint[] = [];
    for (const record of merged.records) {
      if (record.status !== 'STOP' && record.status !== 'TARGET' && record.status !== 'EXPIRED') continue;
      if (typeof record.r !== 'number' || !Number.isFinite(record.r)) continue;
      // Fase 6.1: prezzo di ingresso/stop e due barre del fill per il costo
      // della riga. Fase 6.3: `selectedLeverage` e' persistito nei record nuovi
      // (prima non lo era), quindi il termine certificato KO si conta sui dati
      // reali. `leverage` resta come ripiego per eventuali record che lo usano.
      const leverageRaw =
        (record as { selectedLeverage?: unknown }).selectedLeverage ??
        (record as { leverage?: unknown }).leverage;
      const leverage =
        typeof leverageRaw === 'number' && Number.isFinite(leverageRaw) && leverageRaw > 0
          ? leverageRaw
          : null;
      points.push({
        key: record.key,
        ticker: record.ticker,
        decidedAtMs: record.decidedAtMs,
        r: record.r,
        status: record.status,
        entry: typeof record.entry === 'number' ? record.entry : null,
        stop: typeof record.stop === 'number' ? record.stop : null,
        leverage,
        bars: barsAroundFill(barsByTicker.get(record.ticker), record.fillBarTs),
      });
    }
    return points;
  },
  // I near-miss gia' persistiti (setup bloccati da un solo gate e mai emessi)
  // forniscono l'esito che manca ai candidati scartati: nessun nuovo
  // macchinario, solo la lettura del file che il tracker aggiorna gia'.
  readNearMissForward: () =>
    attachBarsToPoints(
      mapNearMissForwardPoints(
        loadNearMissRecords(path.join(process.cwd(), SHADOW_V1_NEAR_MISS_PATH))
      ),
      barsOnce()
    ),
  // ADDITIVO: gli scarti fuori whitelist near-miss (due o piu' gate, veti)
  // hanno lo stesso esito deterministico sulle barre chiuse, in un file
  // dedicato: e' la popolazione che mancava al bucket SCARTO.
  readRejectedForward: () =>
    attachBarsToPoints(
      mapRejectedForwardPoints(
        loadRejectedRecords(path.join(process.cwd(), SHADOW_V1_REJECTED_PATH))
      ),
      barsOnce()
    ),
  };
}

/**
 * ADDITIVO (P5): calibrazione gia' aggregata da consegnare al fascicolo. Non
 * lancia mai: in errore la sezione e' assente e il pack lo dichiara, invece di
 * far fallire un post-mortem che non dipende dalla calibrazione.
 */
async function loadDeskCalibration(): Promise<unknown | null> {
  try {
    const out = await createAiCalibrationHandler(createAiCalibrationDeps());
    return out.status === 200 ? out.body : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[AI Desk Evidence] calibrazione non disponibile: ${message}`);
    return null;
  }
}

async function prepareDeskEvidence(sources: DeskEvidenceSources): Promise<AiEvidencePack | null> {
  if (!isAiDeskEvidenceEnabled()) return null;
  try {
    // La calibrazione entra nel fascicolo: il post-mortem deve poter vedere il
    // proprio track record, non solo il diario e i veti.
    const calibration = await loadDeskCalibration();
    return buildDeskEvidencePack({ ...sources, calibration });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[AI Desk Evidence] fascicolo non disponibile: ${message}`);
    return null;
  }
}

/**
 * ADDITIVO (PR-B): valida la risposta GIA ottenuta, sul pack gia' costruito.
 * Nessuna seconda chiamata LLM, nessuna attesa aggiuntiva. Non lancia mai.
 */
function buildDeskEvidenceAnalysis(pack: AiEvidencePack | null, response: unknown) {
  if (pack === null) return null;
  try {
    const result = analyzeDeskEvidencePack({
      pack,
      response,
      predicateIds: LEARNING_PREDICATE_IDS,
    });
    if (result.analysis.rejected.length > 0) {
      console.warn(
        `[AI Desk Evidence] ${result.analysis.rejected.length} affermazioni scartate: ` +
          result.analysis.rejected.map((rejection) => rejection.code).join(', ')
      );
    }
    if (!result.analysis.summaryVerified) {
      console.warn(
        `[AI Desk Evidence] sintesi non ancorata al fascicolo: ${result.analysis.summaryUnsupportedNumbers.join(', ')}`
      );
    }
    return {
      available: true,
      contractVersion: result.analysis.contractVersion,
      evidencePackVersion: result.analysis.evidencePackVersion,
      analysis: result.analysis,
      rejectedCount: result.analysis.rejected.length,
      summaryVerified: result.analysis.summaryVerified,
      evidenceKeys: result.evidenceKeys,
      missingSections: result.missingSections,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[AI Desk Evidence] errore interno: ${message}`);
    return { available: false, error: 'internal_error' };
  }
}

/**
 * ADDITIVO (Fase 1): mappa le proposte restituite dalla LLM in voci di log shadow.
 *
 * - proposta con `topic` e `directive` => `evaluated: true`;
 * - proposta senza shape valida => `evaluated: false` con motivo di scarto;
 * - `predicateId` fuori enum => valutata ma scartata dal flusso esistente;
 * - nessuna direttiva restituita => una voce `evaluated: false` che documenta l'assenza,
 *   cosi' il log non dipende dal fatto che `newDirectives` sia non vuoto.
 */
function buildAiShadowLogEntries(
  rawDirectives: any[],
  source: 'specialize' | 'desk',
  market: string,
  meta: { promptVersion?: string | null; model?: string | null } = {}
): any[] {
  const promptVersion = meta.promptVersion ?? null;
  const model = meta.model ?? null;
  if (!Array.isArray(rawDirectives) || rawDirectives.length === 0) {
    return [
      {
        source,
        ticker: null,
        market,
        direction: null,
        setup: null,
        aiOutcome: null,
        aiCategory: null,
        evaluated: false,
        discarded: true,
        discardReason: 'llm: nessuna direttiva restituita (newDirectives assente o vuoto)',
        promptVersion,
        model,
      },
    ];
  }
  return rawDirectives.map((item: any) => {
    const shapeOk =
      typeof item?.topic === 'string' &&
      item.topic.length > 0 &&
      typeof item?.directive === 'string' &&
      item.directive.length > 0;
    const predicateOk = shapeOk && isLearningPredicateId(item?.predicateId);
    return {
      ...item,
      source,
      promptVersion,
      model,
      market: typeof item?.market === 'string' ? item.market : market,
      evaluated: shapeOk,
      discarded: !shapeOk || !predicateOk,
      discardReason: !shapeOk
        ? 'shape non valida: topic o directive mancante'
        : !predicateOk
          ? `predicateId fuori enum: ${String(item?.predicateId)}`
          : null,
    };
  });
}

/**
 * ADDITIVO (Fasi 1-2): chiamata LLM dei batch `CANDIDATI_SCANSIONE`.
 * Restituisce il testo grezzo (il parser distingue JSON invalido da LLM assente).
 */
async function callScanBatchLlm(
  systemInstruction: string,
  userPrompt: string,
  budget: AiLlmRequestBudget | null = null
): Promise<{ text: string; model: string | null } | null> {
  const openRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();
  if (openRouterKey) {
    const raw = await callOpenRouterRawText(
      [OPENROUTER_PRIMARY_MODEL, OPENROUTER_FALLBACK_MODEL],
      systemInstruction,
      userPrompt,
      openRouterKey,
      15000,
      { endpoint: 'ai-scan-batch', budget }
    );
    if (raw != null && raw.text.trim().length > 0) return raw;
  }
  if (isGeminiAvailable()) {
    const gemRes = await callGeminiModel(systemInstruction, userPrompt, undefined, {
      endpoint: 'ai-scan-batch',
      budget,
    });
    if (gemRes?.data) {
      return {
        text: JSON.stringify(gemRes.data),
        model: gemRes.model ?? null,
      };
    }
  }
  return null;
}

const inFlightScanRunIds = new Set<string>();
const completedScanRunIds: string[] = [];
const MAX_COMPLETED_SCAN_RUN_IDS = 30;
// Cooldown di 45 minuti sulle valutazioni background: preserva la quota giornaliera :free
// su OpenRouter mantenendo 2-3 campionamenti distribuiti per sessione operativa.
const AUTO_SCAN_EVAL_COOLDOWN_MS = 45 * 60_000;
let lastAutoScanEvalAtMs = 0;
let autoScanEvalInFlight = false;

function markScanRunEvaluated(runId: string): void {
  if (!completedScanRunIds.includes(runId)) {
    completedScanRunIds.push(runId);
    if (completedScanRunIds.length > MAX_COMPLETED_SCAN_RUN_IDS) {
      completedScanRunIds.shift();
    }
  }
}

/**
 * Valutazione AI shadow automatica in background durante gli orari di mercato
 * attivo: ancora i timestamp all'istante reale della scansione (`scanStartedAtMs`)
 * cosi' la calibrazione puo' abbinare le decisioni AI agli esiti Shadow V1-live
 * senza look-ahead bias e senza richiedere click manuali su Specialize/Post-Mortem.
 */
async function logAutoScanCandidateEvaluations(
  scanRunId: string,
  scanStartedAtMs: number
): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.DISABLE_AUTO_AI_SCAN_EVAL === 'true') {
    return;
  }
  const activeMarkets = getActiveMarketsAt(scanStartedAtMs);
  if (activeMarkets.length === 0) return;
  if (autoScanEvalInFlight) return;
  if (scanStartedAtMs - lastAutoScanEvalAtMs < AUTO_SCAN_EVAL_COOLDOWN_MS) return;

  const openRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();
  if (!openRouterKey && !isGeminiAvailable()) return;

  if (inFlightScanRunIds.has(scanRunId) || completedScanRunIds.includes(scanRunId)) {
    return;
  }

  // Invia al batch LLM solo i candidati attivi con punteggio calcolato (inclusi near-miss e veti),
  // escludendo i titoli inattivi/senza barre (scoreTotal === null) per dimezzare il consumo di token.
  const candidates = getLastScanCandidates().filter(
    (c) =>
      c.runId === scanRunId &&
      (c.market === 'EU' || c.market === 'US') &&
      activeMarkets.includes(c.market) &&
      c.scoreTotal !== null
  );
  if (candidates.length === 0) return;

  autoScanEvalInFlight = true;
  inFlightScanRunIds.add(scanRunId);
  lastAutoScanEvalAtMs = scanStartedAtMs;
  // P10: percorso automatico, nessun utente: vale il solo tetto per richiesta.
  const scanBudget = openAiLlmRequest(null);
  try {
    const result = await evaluateScanCandidates(
      candidates,
      'scan',
      (system, user) => callScanBatchLlm(system, user, scanBudget),
      AI_SHADOW_BATCH_SIZE,
      {
        runId: scanRunId,
        candidateSource: 'snapshot',
        evaluatedAtMs: scanStartedAtMs,
      }
    );
    console.info(
      `[AI Shadow Log] auto-scan (${activeMarkets.join('/')}, run ${scanRunId}): ${result.evaluated}/${result.entries.length} valutati in ${result.batches
        .map((batch) => `${batch.durationMs}ms`)
        .join(' + ')}`
    );
    if (result.entries.length > 0) {
      safeAppendAiShadowLog(
        result.entries,
        path.join(process.cwd(), AI_SHADOW_LOG_RELATIVE_PATH)
      );
    }
    if (result.evaluated > 0) {
      markScanRunEvaluated(scanRunId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[AI Shadow Log] valutazione automatica scansione non riuscita:', message);
  } finally {
    inFlightScanRunIds.delete(scanRunId);
    autoScanEvalInFlight = false;
  }
}

/**
 * ADDITIVO (Fasi 1-2): valuta i candidati dell'ultima scansione e li registra
 * nel log shadow. Deduplica globalmente per `runId` tra `scan`, `specialize` e
 * `desk` cosi' due azioni sul medesimo snapshot non bruciano due volte la quota LLM.
 */
async function logScanCandidateEvaluations(
  source: 'specialize' | 'desk',
  input?: {
    bodyCandidates?: unknown;
    bodyRunId?: unknown;
    /** P10: i batch consumano lo stesso budget della richiesta che li ha avviati. */
    budget?: AiLlmRequestBudget | null;
  }
): Promise<void> {
  const { bodyCandidates, bodyRunId } = input
    ? { bodyCandidates: input.bodyCandidates, bodyRunId: input.bodyRunId }
    : consumeHandlerScanInput();
  const batchBudget = input?.budget ?? null;
  let trackedRunId: string | null = null;
  try {
    const { candidates, candidateSource, runId } = resolveScanCandidateInput(
      bodyCandidates,
      bodyRunId
    );
    if (candidates.length === 0) {
      safeAppendAiShadowLog(
        buildNoCandidateEntry(source, {
          promptVersion: AI_SHADOW_SCAN_PROMPT_VERSION,
          model: null,
        }),
        path.join(process.cwd(), AI_SHADOW_LOG_RELATIVE_PATH)
      );
      return;
    }
    if (runId) {
      if (inFlightScanRunIds.has(runId) || completedScanRunIds.includes(runId)) {
        return;
      }
      trackedRunId = runId;
      inFlightScanRunIds.add(runId);
    }
    const activeCandidates = candidates.filter((c) => c.scoreTotal !== null);
    const batchCandidates = activeCandidates.length > 0 ? activeCandidates : candidates;

    const lastScanTs = getLastScanTimestampMs();
    const anchoredAtMs =
      lastScanTs != null && (candidateSource === 'snapshot' || (runId != null && runId === getLastScanRunId()))
        ? lastScanTs
        : null;
    try {
      const result = await evaluateScanCandidates(
        batchCandidates,
        source,
        (system, user) => callScanBatchLlm(system, user, batchBudget),
        AI_SHADOW_BATCH_SIZE,
        { runId, candidateSource, evaluatedAtMs: anchoredAtMs }
      );
      if (result.ignoredUnknownTickers > 0 || result.ignoredDuplicateTickers > 0) {
        console.warn(
          `[AI Shadow Log] valutazioni ignorate (${source}): ticker sconosciuti ${result.ignoredUnknownTickers}, duplicati ${result.ignoredDuplicateTickers}`
        );
      }
      console.info(
        `[AI Shadow Log] ${source} (${candidateSource}, run ${runId ?? 'n.d.'}): ${result.evaluated}/${result.entries.length} valutati in ${result.batches
          .map((batch) => `${batch.durationMs}ms`)
          .join(' + ')}`
      );
      if (result.entries.length > 0) {
        safeAppendAiShadowLog(
          result.entries,
          path.join(process.cwd(), AI_SHADOW_LOG_RELATIVE_PATH)
        );
      }
      if (trackedRunId && result.evaluated > 0) {
        markScanRunEvaluated(trackedRunId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[AI Shadow Log] valutazione candidati non riuscita:', message);
    }
  } finally {
    if (trackedRunId) inFlightScanRunIds.delete(trackedRunId);
    if (!input) resetHandlerScanInput();
  }
}

// POST /api/ai/specialize: L'AI analizza i trade e i setup scartati per distillare nuove regole empiriche di condotta
app.post('/api/ai/specialize', requireApiAuth, async (req: Request, res: Response) => {
  try {
    const userId = typeof res.locals.authenticatedUid === 'string' ? res.locals.authenticatedUid : 'legacy';
    const sharedAppState = getSharedAppState(userId);
    // Fase 3.3: il campione che puo' scrivere memoria viene dal diario canonico
    // del server, non dal body. Un client non puo' piu' fabbricare i 30 trade
    // che servono a superare i gate statistici di un altro utente.
    const canonicalSample = buildCanonicalSample(sharedAppState.journalEntries, Date.now());
    const trades: any[] = canonicalSample.trades;
    // Id dell'esecuzione che scrive: non il runId dell'ultima scansione, che
    // appartiene a un'altra operazione.
    const memoryRunId = randomUUID();
    const excluded: any[] = Array.isArray(req.body?.excluded)
      ? req.body.excluded
      : Array.isArray(req.body?.excludedSetups)
        ? req.body.excludedSetups
        : (sharedAppState.excludedRecords || []);

    if (trades.length === 0 && excluded.length === 0) {
      return res.status(400).json({
        success: false,
        runId: memoryRunId,
        datasetSource: canonicalSample.source,
        datasetHash: canonicalSample.datasetHash,
        rejectedTrades: canonicalSample.rejected,
        error:
          'Nessun trade nel diario canonico del server: il campione non puo\' essere preso dalla richiesta. ' +
          'Sincronizza il diario (POST /api/sync/state) oppure registra almeno un trade concluso.',
      });
    }

    const openRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();

    // P10: budget della richiesta (tetto per richiesta e finestra oraria per
    // utente, dichiarati in `aiLlmBudget`). Sotto i limiti: comportamento
    // identico a prima; sopra: 429 esplicito invece di consumo silenzioso.
    const llmBudget = openAiLlmRequest(userId);
    const budgetGate = llmBudget.peek();
    if (!budgetGate.ok) {
      return res.status(429).json({
        success: false,
        error: 'llm_budget_exhausted',
        scope: budgetGate.scope,
        limit: budgetGate.limit,
      });
    }

    // Summary statistics for AI
    const winTrades = trades.filter((t) => t.outcome === 'WIN');
    const lossTrades = trades.filter((t) => t.outcome === 'LOSS');
    const profitableExcluded = excluded.filter((e) => e.outcomeStatus === 'THEORETICAL_PROFIT');
    const stoppedExcluded = excluded.filter((e) => e.outcomeStatus === 'THEORETICAL_STOP');

    let promptText = `Sei il Lead Quantitative Risk Manager & Head of Systematic Trading.
Analizza questo dataset di trade conclusi (inclusi sia operazioni in paper trading che eseguite a mercato reale) e setup scartati per distillare da 1 a 3 DIRETTIVE OPERATIVE AUREE (Regole di condotta) che guideranno le future valutazioni dell'AI su catalizzatori e parametri.

STATISTICHE FORNITE (trade reali e paper trading):
- Trade Chiusi: ${trades.length} (Vinti: ${winTrades.length}, Persi: ${lossTrades.length})
- Setup Esclusi Monitorati: ${excluded.length} (Andati a Target: ${profitableExcluded.length}, Andati a Stop: ${stoppedExcluded.length})
- Esempi Trade Vincenti: ${JSON.stringify(winTrades.slice(0, 3).map((t) => ({ ticker: t.ticker, strategy: t.strategy, mode: t.isPaper ? 'PAPER' : 'REALE', rMult: t.rMultiple, notes: t.notes })))}
- Esempi Trade in Perdita: ${JSON.stringify(lossTrades.slice(0, 3).map((t) => ({ ticker: t.ticker, strategy: t.strategy, mode: t.isPaper ? 'PAPER' : 'REALE', rMult: t.rMultiple, notes: t.notes })))}
- Esempi Esclusi Andati a Target: ${JSON.stringify(profitableExcluded.slice(0, 4).map((e) => ({ ticker: e.ticker, reason: e.primaryReasonCategory, gap: e.gapPercent, rvol: e.rvol })))}

Istruzioni:
Restituisci eventuali proposte non persistenti nel campo "newDirectives" (array). Ogni elemento deve contenere un predicato CHIUSO scelto esclusivamente da questo enum, senza inventarne altri:
${LEARNING_PREDICATE_PROMPT}
Non dichiarare una confidence statistica e non affermare che le proposte sono state validate:
{
  "newDirectives": [
    {
      "topic": "STRINGA_SINTETICA_MAIUSCOLA",
      "market": "EU" | "US" | "GLOBAL",
      "predicateId": "UNO_DEGLI_ID_DELL_ENUM",
      "directive": "Regola operativa chiara, concisa e vincolante da applicare nelle future analisi",
      "confidence": null,
      "sampleEvidence": "Spiegazione quantitativa basata sui dati reali esaminati"
    }
  ]
}`;

    // ADDITIVO (PR-B): il contratto (fascicolo + campi obbligatori) entra nella
    // STESSA chiamata LLM, prima del modello. Nessun secondo giro.
    const deskEvidencePack = await prepareDeskEvidence({
      nowMs: Date.now(),
      trades,
      excluded,
      rootDir: process.cwd(),
    });
    if (deskEvidencePack !== null) {
      promptText += buildEvidencePromptAddendum(deskEvidencePack, {
        predicateIds: LEARNING_PREDICATE_IDS,
      });
    }

    const systemInstruction = `Sei un Risk Manager quantitativo rigoroso. Estrai solo regole concrete, empiriche e non banali basate esclusivamente sui dati forniti. Rispondi solo in formato JSON.`;
    // ADDITIVO (P5): versione del prompt e modello viaggiano con la riga di log.
    const specializePromptVersion = deskEvidencePack
      ? `${AI_SPECIALIZE_PROMPT_VERSION}+${AI_DESK_CONTRACT_VERSION}`
      : AI_SPECIALIZE_PROMPT_VERSION;

    let generated: any = null;
    let llmErrorDetail: string | null = null;
    let usedModel: string | null = null;
    if (openRouterKey) {
      const openRouterRes = await callOpenRouterModel(
        [OPENROUTER_PRIMARY_MODEL, OPENROUTER_FALLBACK_MODEL],
        systemInstruction,
        promptText,
        openRouterKey,
        15000,
        { endpoint: 'ai-specialize', budget: llmBudget }
      );
      if (openRouterRes?.data?.newDirectives) {
        generated = openRouterRes.data;
        usedModel = openRouterRes.model ?? null;
      } else if (openRouterRes?.keyInvalid) {
        llmErrorDetail = 'openrouter:401';
      } else if (openRouterRes?.creditsExhausted) {
        llmErrorDetail = 'openrouter:402/429';
      } else if (typeof openRouterRes?.status === 'number' && openRouterRes.status > 0) {
        llmErrorDetail = `openrouter:${openRouterRes.status}`;
      } else if (openRouterRes?.schemaError) {
        // P10 (revisione): un rifiuto per schema non e' "provider assente".
        llmErrorDetail = 'openrouter:schema';
      }
    }

    if (!generated && isGeminiAvailable()) {
      const gemRes = await callGeminiModel(systemInstruction, promptText, undefined, {
        endpoint: 'ai-specialize',
        budget: llmBudget,
      });
      if (gemRes?.data?.newDirectives) {
        generated = gemRes.data;
        usedModel = gemRes.model ?? null;
      } else if (gemRes?.quotaExhausted) {
        llmErrorDetail = 'gemini:402/429';
      } else if (gemRes?.schemaError) {
        llmErrorDetail = 'gemini:schema';
      }
    }

    // ADDITIVO (v9, Parte 3.2): direttive divise fra valide (predicateId in enum) e scartate.
    const rawDirectives = Array.isArray(generated?.newDirectives) ? generated.newDirectives : [];
    // ADDITIVO (Fase 1): log shadow di TUTTE le proposte valutate, prima di qualunque filtro.
    // safeAppend non lancia mai: un errore di I/O non altera la risposta.
    safeAppendAiShadowLog(
      buildAiShadowLogEntries(rawDirectives, 'specialize', 'GLOBAL', {
        promptVersion: specializePromptVersion,
        model: usedModel,
      }),
      path.join(process.cwd(), AI_SHADOW_LOG_RELATIVE_PATH)
    );
    // ADDITIVO (Fasi 1-2, P2): valutazione asincrona in background con passaggio
    // diretto dei parametri (non blocca la risposta HTTP ed evita timeout client).
    void logScanCandidateEvaluations('specialize', {
      bodyCandidates: req.body?.scanCandidates,
      bodyRunId: req.body?.scanRunId,
      budget: llmBudget,
    }).catch(() => undefined);
    const shapeValidDirectives = rawDirectives.filter(
      (item: any) => typeof item?.topic === 'string' && typeof item?.directive === 'string'
    );
    const proposedDirectives = shapeValidDirectives;
    // ADDITIVO (PR-B): analisi AI ancorata al fascicolo, dietro AI_DESK_EVIDENCE=1.
    const deskAnalysisPayload = buildDeskEvidenceAnalysis(deskEvidencePack, generated);
    const validatedDeskDirectives =
      deskAnalysisPayload && deskAnalysisPayload.available && deskAnalysisPayload.analysis
        ? deskAnalysisPayload.analysis.proposedDirectives
        : [];
    // ADDITIVO (v10, Parte 3.2): la LLM fornisce solo il testo; il predicato lo decide la scansione.
    // Quando il fascicolo probatorio e' attivo, usa solo testo e refs validati dal contratto anti-allucinazione.
    const directiveTextByPredicate = new Map<string, string>();
    const evidenceRefsByPredicate = new Map<string, string[]>();
    const directiveSourceList = deskEvidencePack !== null ? validatedDeskDirectives : shapeValidDirectives;
    for (const item of directiveSourceList) {
      if (isLearningPredicateId(item?.predicateId) && !directiveTextByPredicate.has(item.predicateId)) {
        directiveTextByPredicate.set(item.predicateId, String(item.directive));
      }
      if (isLearningPredicateId(item?.predicateId) && Array.isArray(item?.evidenceRefs)) {
        evidenceRefsByPredicate.set(
          item.predicateId,
          item.evidenceRefs.filter((ref: unknown): ref is string => typeof ref === 'string')
        );
      }
    }
    // Fase 3: memoria per-utente. `writerUid` e `datasetHash` firmano la regola
    // scritta; le regole storiche globali restano visibili ma non le si riscrive
    // nel documento di questo utente.
    const memoryScopeUid = aiMemoryScopeUidOf(res);
    const memoryDatasetHash = computeDatasetHash(trades);
    aiLearnedMemory = await loadAIMemoryForUser(memoryScopeUid);
    const memoryBefore = new Map(aiLearnedMemory.map((entry) => [entry.topic, entry.learnedAt]));

    // ADDITIVO (v10): scansione deterministica dei 14 predicati chiusi.
    const scan = scanLearningPredicates(trades, excluded);

    // Fase 4.3: un predicato ri-testato che non passa piu' i gate revoca la sua
    // regola (non la cancella) e lascia una riga nel registro append-only. Un
    // predicato senza campione non e' una smentita e non revoca nulla.
    // La scansione nomina il topic `PREDICATO_<id>`: si passa il topic reale,
    // altrimenti ne' il rinnovo ne' la revoca troverebbero la regola.
    const predicateRows = scan.map((entry) => ({
      predicateId: entry.predicateId,
      topic: entry.result?.topic ?? `PREDICATO_${entry.predicateId}`,
      tested: entry.tested,
      passesGates: entry.passesGates,
      n: entry.n,
    }));
    const ownMemoryBeforeRetest = loadAIMemoryFromDisk(memoryScopeUid);
    // I topic che questo run riscrivera' con `updateAIMemory` vengono rinnovati
    // dal percorso di scrittura: rinnovarli anche qui conterebbe lo stesso
    // re-test due volte. Senza modello non si scrive nulla, quindi il rinnovo
    // resta necessario.
    const topicsWrittenThisRun =
      usedModel !== null
        ? new Set(
            scan
              .filter((entry) => entry.passesGates)
              .map((entry) => entry.result?.topic ?? `PREDICATO_${entry.predicateId}`)
          )
        : new Set<string>();
    const renewal = renewRulesForPassingPredicates(
      ownMemoryBeforeRetest,
      predicateRows,
      Date.now(),
      topicsWrittenThisRun
    );
    const revocation = revokeRulesForFailedPredicates(renewal.memory, predicateRows, Date.now());
    if (renewal.renewed.length > 0 || revocation.revoked.length > 0) {
      saveAIMemoryLocally(revocation.memory, memoryScopeUid);
      if (firebaseAdminFirestore) {
        try {
          await persistAIMemoryToFirestore(revocation.memory, memoryScopeUid);
        } catch (revokePersistError) {
          console.warn('[AI Specialization] Persistenza re-test fallita:', revokePersistError);
        }
      }
      appendRevocationLog(
        revocation.revoked,
        path.join(process.cwd(), AI_MEMORY_REVOCATION_LOG_RELATIVE_PATH)
      );
      aiLearnedMemory = await loadAIMemoryForUser(memoryScopeUid);
    }
    const testedPredicates = scan.filter((entry) => entry.tested);
    const winningPredicates = scan.filter((entry) => entry.passesGates);
    const decisiveSample = Math.max(0, ...scan.map((entry) => entry.n));
    const discardedCount = shapeValidDirectives.length - winningPredicates.length;

    const winnerResults: LearningResult[] = winningPredicates.map((entry) => ({
      ...(entry.result as LearningResult),
      directive:
        directiveTextByPredicate.get(entry.predicateId) ??
        `Predicato ${entry.predicateId}: n=${entry.n}, q=${entry.qValue.toFixed(4)}, avgR=${entry.avgR.toFixed(2)}, profitFactor=${entry.profitFactor.toFixed(2)}`,
      confidence: 1 - entry.qValue,
      // ADDITIVO (P8): la regola scritta sa da quale prompt, modello e chiavi
      // viene. `model` resta null se nessun modello ha risposto.
      provenance: {
        promptVersion: specializePromptVersion,
        model: usedModel,
        evidenceRefs: evidenceRefsByPredicate.get(entry.predicateId) ?? [],
      },
    }));

    let persistedCount = 0;
    // Non scrivere regole in memoria quando nessun modello AI ha risposto (evita
    // direttive non attribuibili con model=null su disco/Firestore).
    if (winnerResults.length > 0 && usedModel !== null) {
      // R3: persistenza tramite le funzioni esistenti; i gate (n, q, avgR, profitFactor) sono dentro updateAIMemory.
      updateAIMemory(winnerResults, aiMemoryFilePathFor(memoryScopeUid), {
        ownerUid: memoryScopeUid,
        datasetHash: memoryDatasetHash,
        runId: memoryRunId,
      });
      aiLearnedMemory = loadAIMemoryFromDisk(memoryScopeUid);
      if (firebaseAdminFirestore) {
        try {
          await persistAIMemoryToFirestore(aiLearnedMemory, memoryScopeUid);
        } catch (persistError) {
          console.warn('[AI Specialization] Persistenza Firestore fallita:', persistError);
        }
      }
      for (const validation of winnerResults) {
        const foundAfter = aiLearnedMemory.find((entry) => entry.topic === validation.topic);
        if (foundAfter && foundAfter.learnedAt !== memoryBefore.get(validation.topic)) {
          persistedCount += 1;
        }
      }
      // La risposta mostra cio' che l'utente vede: le sue regole piu' le storiche.
      aiLearnedMemory = await loadAIMemoryForUser(memoryScopeUid);
    }

    // ADDITIVO (v10, Parte 3.4): gateDetail coerente col ramo (n=0/30 solo se non testato).
    const gateDetail =
      testedPredicates.length === 0
        ? `${decisiveSample}/${MIN_REAL_TRADE_SAMPLE} trade decisivi: nessun predicato con campione sufficiente.`
        : testedPredicates
            .map(
              (entry) =>
                `PREDICATO ${entry.predicateId}: n=${entry.n}, q=${entry.qValue.toFixed(4)}, ` +
                `avgR=${entry.avgR.toFixed(2)}, profitFactor=${entry.profitFactor.toFixed(2)}`
            )
            .join(' | ');

    // ADDITIVO (v9, Parte 5.1): unico resolver condiviso con il desk.
    const outcome = resolveSpecializationOutcome({
      hasOpenRouterKey: Boolean(openRouterKey),
      geminiAvailable: isGeminiAvailable(),
      llmErrorDetail,
      validDirectivesCount: winningPredicates.length,
      discardedCount: 0,
      llmDirectiveCount: shapeValidDirectives.length,
      testedCount: testedPredicates.length,
      decisiveSample,
      minSample: MIN_REAL_TRADE_SAMPLE,
      writtenCount: persistedCount,
      gateDetail,
    });
    const reason = outcome.reason;
    const reasonDetail = outcome.reasonDetail;

    return res.json({
      success: true,
      // Fase 3.3: la risposta dichiara su quale campione e' stata scritta la regola.
      runId: memoryRunId,
      datasetSource: canonicalSample.source,
      datasetHash: memoryDatasetHash,
      rejectedTrades: canonicalSample.rejected,
      revokedCount: revocation.revoked.length,
      revokedTopics: revocation.revoked.map((entry) => entry.topic),
      renewedCount: renewal.renewed.length,
      renewedTopics: renewal.renewed.map((entry) => entry.topic),
      reason,
      reasonDetail,
      addedCount: persistedCount,
      newInsightsCount: persistedCount,
      proposedDirectives,
      sampleDecisive: decisiveSample,
      minSample: MIN_REAL_TRADE_SAMPLE,
      memory: aiLearnedMemory,
      message: reason === 'OK_SCRITTO'
        ? `Direttiva scritta: ${reasonDetail}`
        : proposedDirectives.length > 0
          ? 'Proposte LLM non persistite: la memoria viene aggiornata solo dalla pipeline statistica sui trade reali.'
          : 'Nessuna proposta LLM; la memoria persistente resta invariata.',
      messageDetail: reasonDetail,
      proposedCount: proposedDirectives.length,
      discardedCount,
      deskAnalysis: deskAnalysisPayload,
      totalRules: aiLearnedMemory.length,
      directives: aiLearnedMemory,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// POST /api/ai/desk-post-mortem: Genera una relazione retrospettiva istituzionale del desk e distilla nuove direttive operative
app.post('/api/ai/desk-post-mortem', requireApiAuth, async (req: Request, res: Response) => {
  try {
    const userId = typeof res.locals.authenticatedUid === 'string' ? res.locals.authenticatedUid : 'legacy';
    const sharedAppState = getSharedAppState(userId);
    // Fase 3.3: stesso campione canonico del flusso di specializzazione.
    const deskCanonicalSample = buildCanonicalSample(sharedAppState.journalEntries, Date.now());
    const deskMemoryRunId = randomUUID();
    const rawTrades: any[] = deskCanonicalSample.trades;
    const market = req.body?.market || 'GLOBAL';

    let sessionTrades = market === 'GLOBAL'
      ? rawTrades
      : rawTrades.filter((t) => (t.market || (t.session === 'US' ? 'US' : 'EU')) === market);

    // If no trades for this specific market, but journal has trades, fall back to analyzing available journal trades
    if (sessionTrades.length === 0 && rawTrades.length > 0) {
      sessionTrades = rawTrades;
    }

    if (sessionTrades.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Nessun trade a diario disponibile per generare il Post-Mortem del Desk. Registra almeno un trade per avviare l\'analisi.',
      });
    }

    const wins = sessionTrades.filter((t) => t.outcome === 'WIN');
    const losses = sessionTrades.filter((t) => t.outcome === 'LOSS');
    const breakevens = sessionTrades.filter((t) => t.outcome === 'BREAKEVEN');
    const expired = sessionTrades.filter((t) => t.outcome === 'EXPIRED');

    const total = sessionTrades.length;
    const winRate = total > 0 ? ((wins.length / total) * 100).toFixed(1) : '0';
    const netPnl = sessionTrades.reduce((acc, t) => acc + (t.pnlEur || 0), 0).toFixed(2);
    const avgR = total > 0 ? (sessionTrades.reduce((acc, t) => acc + (t.rMultiple || 0), 0) / total).toFixed(2) : '0';

    const openRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();

    // P10: stesso budget per richiesta e per utente del flusso di specializzazione.
    const llmBudget = openAiLlmRequest(userId);
    const budgetGate = llmBudget.peek();
    if (!budgetGate.ok) {
      return res.status(429).json({
        success: false,
        error: 'llm_budget_exhausted',
        scope: budgetGate.scope,
        limit: budgetGate.limit,
      });
    }

    let promptText = `Sei l'Head of Quantitative Trading & Senior Risk Officer di un desk proprietario intraday.
Redigi il "POST-MORTEM UFFICIALE DEL DESK" analizzando le ultime sessioni operative (${market === 'EU' ? 'Europa' : market === 'US' ? 'USA' : 'Globale'}) includendo tutti i trade registrati a diario (sia eseguiti a mercato reale che in paper trading).

METRICHE DI PERFORMANCE (REALI E PAPER TRADING):
- Trade Totali Analizzati: ${total}
- Win: ${wins.length} | Loss: ${losses.length} | BE: ${breakevens.length} | Expired: ${expired.length}
- Win Rate: ${winRate}% | P&L Netto: ${netPnl} € | R-Multiple Medio: ${avgR}R
- Dettaglio Trade Eseguiti: ${JSON.stringify(sessionTrades.slice(-10).map((t) => ({
      ticker: t.ticker,
      direction: t.direction,
      outcome: t.outcome,
      mode: t.isPaper ? 'PAPER' : 'REALE',
      rMultiple: t.rMultiple,
      closeReason: t.closeReason,
      notes: t.notes,
    })))}

ISTRUZIONI DI REDAZIONE:
Restituisci un JSON rigoroso con questi campi:
1. "executiveSummary": stringa sintetica (3-4 frasi) con il giudizio istituzionale complessivo sull'efficienza del trading.
2. "strengths": array di 2-3 stringhe che evidenziano cosa ha funzionato a livello di timing, selezione o disciplina.
3. "failurePatterns": array di 2-3 stringhe che evidenziano i punti critici reali (falsi breakout, trade lenti, mancato allineamento o violazioni di timing).
4. "tacticalAdvice": stringa con il piano d'azione operativo concreto per la prossima sessione.
5. "newDirectives": array opzionale di ipotesi non persistenti. Ogni elemento deve contenere un predicato CHIUSO scelto esclusivamente da questo enum, senza inventarne altri:
${LEARNING_PREDICATE_PROMPT}
Forma: ({ "topic": string, "market": "${market}", "predicateId": string, "directive": string, "confidence": null, "sampleEvidence": string }).`;

    // ADDITIVO (PR-B): contratto dentro la stessa e unica chiamata LLM, passando anche gli esclusi reali.
    const deskExcluded: any[] = Array.isArray(req.body?.excluded)
      ? req.body.excluded
      : Array.isArray(sharedAppState.excludedRecords)
        ? sharedAppState.excludedRecords
        : [];
    const deskEvidencePack = await prepareDeskEvidence({
      nowMs: Date.now(),
      trades: sessionTrades,
      excluded: deskExcluded,
      rootDir: process.cwd(),
    });
    if (deskEvidencePack !== null) {
      promptText += buildEvidencePromptAddendum(deskEvidencePack, {
        predicateIds: LEARNING_PREDICATE_IDS,
      });
    }

    const systemInstruction = `Sei un Senior Risk Officer rigoroso ed esperto. Analizza con occhio clinico e linguaggio istituzionale da hedge fund. Non inventare dati e cita sempre le chiavi del fascicolo probatorio (inclusi nearMiss.*, veto.* e calibration.catalystLift.* quando disponibili e con campione sufficiente). Rispondi solo in formato JSON.`;

    // ADDITIVO (P5): versione del prompt e modello viaggiano con la riga di log.
    const deskPromptVersion = deskEvidencePack
      ? `${AI_DESK_POSTMORTEM_PROMPT_VERSION}+${AI_DESK_CONTRACT_VERSION}`
      : AI_DESK_POSTMORTEM_PROMPT_VERSION;

    let generated: any = null;
    let llmErrorDetail: string | null = null;
    let usedModel: string | null = null;
    if (openRouterKey) {
      const openRouterRes = await callOpenRouterModel(
        [OPENROUTER_PRIMARY_MODEL, OPENROUTER_FALLBACK_MODEL],
        systemInstruction,
        promptText,
        openRouterKey,
        18000,
        { endpoint: 'ai-desk-post-mortem', budget: llmBudget }
      );
      if (openRouterRes?.data?.executiveSummary || openRouterRes?.data?.summary) {
        generated = {
          ...openRouterRes.data,
          executiveSummary: openRouterRes.data.executiveSummary || openRouterRes.data.summary,
        };
        usedModel = openRouterRes.model ?? null;
      } else if (openRouterRes?.keyInvalid) {
        llmErrorDetail = 'openrouter:401';
      } else if (openRouterRes?.creditsExhausted) {
        llmErrorDetail = 'openrouter:402/429';
      } else if (typeof openRouterRes?.status === 'number' && openRouterRes.status > 0) {
        llmErrorDetail = `openrouter:${openRouterRes.status}`;
      } else if (openRouterRes?.schemaError) {
        // P10 (revisione): un rifiuto per schema non e' "provider assente".
        llmErrorDetail = 'openrouter:schema';
      }
    }

    if (!generated && isGeminiAvailable()) {
      const gemRes = await callGeminiModel(systemInstruction, promptText, undefined, {
        endpoint: 'ai-desk-post-mortem',
        budget: llmBudget,
      });
      if (gemRes?.data?.executiveSummary || gemRes?.data?.summary) {
        generated = {
          ...gemRes.data,
          executiveSummary: gemRes.data.executiveSummary || gemRes.data.summary,
        };
        usedModel = gemRes.model ?? null;
      } else if (gemRes?.quotaExhausted) {
        llmErrorDetail = 'gemini:402/429';
      } else if (gemRes?.schemaError) {
        llmErrorDetail = 'gemini:schema';
      }
    }

    // Nessuna prosa inventata: se nessun modello risponde, il post-mortem
    // riporta solo le metriche gia' calcolate e ancorate esattamente alle chiavi
    // del fascicolo probatorio (`journal.*`) cosi' `summaryVerified` resta true.
    if (!generated) {
      const packJournal = deskEvidencePack?.sections.journal;
      const fbN = packJournal ? packJournal.n : total;
      const fbWins = packJournal ? packJournal.wins : wins.length;
      const fbLosses = packJournal ? packJournal.losses : losses.length;
      const fbBe = packJournal ? packJournal.breakevens : breakevens.length;
      const fbExp = packJournal ? packJournal.expired : expired.length;
      const fbWrAll =
        packJournal && packJournal.winRateAllPct !== null ? packJournal.winRateAllPct : Number(winRate);
      const fbNetPnl =
        packJournal && packJournal.netPnlEur !== null ? packJournal.netPnlEur : Number(netPnl);
      const fbAvgR =
        packJournal && packJournal.avgR !== null ? Number(packJournal.avgR.toFixed(2)) : Number(avgR);
      const fallbackSummary =
        `LLM non disponibile: riepilogo deterministico delle sessioni ${market}. ` +
        `${fbN} trade chiusi analizzati (${fbWins} win, ${fbLosses} loss, ${fbBe} BE, ${fbExp} scaduti), ` +
        `win rate ${fbWrAll}% sui trade chiusi, P&L netto ${fbNetPnl} €, R medio ${fbAvgR}R. ` +
        `Nessuna interpretazione qualitativa: da soli questi aggregati non identificano le cause.`;
      generated = {
        summary: fallbackSummary,
        executiveSummary: fallbackSummary,
        summaryRefs: packJournal
          ? ['journal.n', 'journal.winRateAllPct', 'journal.netPnlEur', 'journal.avgR']
          : [],
        claims: [],
        dataGaps: ['Modello LLM temporaneamente non disponibile o in cooldown di quota API.'],
        strengths: [],
        failurePatterns: [],
        tacticalAdvice:
          'Rilanciare il post-mortem quando il modello AI e\' disponibile; nel frattempo attenersi esclusivamente alle metriche verificate dal diario e dai gate deterministici.',
        newDirectives: [],
        llmUnavailable: true,
      };
    }

    // ADDITIVO (v9, Parte 4.2/4.3): stesso flusso dell'handler, stessi gate e stesso resolver.
    const rawDirectives = Array.isArray(generated.newDirectives) ? generated.newDirectives : [];
    // ADDITIVO (Fase 1): log shadow di TUTTE le proposte valutate, prima di qualunque filtro.
    safeAppendAiShadowLog(
      buildAiShadowLogEntries(rawDirectives, 'desk', typeof market === 'string' ? market : 'GLOBAL', {
        promptVersion: deskPromptVersion,
        model: usedModel,
      }),
      path.join(process.cwd(), AI_SHADOW_LOG_RELATIVE_PATH)
    );
    // ADDITIVO (Fasi 1-2, P2): valutazione asincrona in background con passaggio
    // diretto dei parametri (non blocca la risposta HTTP ed evita timeout client).
    void logScanCandidateEvaluations('desk', {
      bodyCandidates: req.body?.scanCandidates,
      bodyRunId: req.body?.scanRunId,
      budget: llmBudget,
    }).catch(() => undefined);
    const shapeValidDirectives = rawDirectives.filter(
      (item: any) => typeof item?.topic === 'string' && typeof item?.directive === 'string'
    );
    const proposedDirectives = shapeValidDirectives;
    // ADDITIVO (PR-B): analisi AI ancorata al fascicolo, dietro AI_DESK_EVIDENCE=1.
    const deskAnalysisPayload = buildDeskEvidenceAnalysis(deskEvidencePack, generated);
    const deskValidatedDirectives =
      deskAnalysisPayload && deskAnalysisPayload.available && deskAnalysisPayload.analysis
        ? deskAnalysisPayload.analysis.proposedDirectives
        : [];
    const directiveTextByPredicate = new Map<string, string>();
    // ADDITIVO (P8): chiavi del fascicolo citate dalla proposta, per predicato.
    // Quando il fascicolo probatorio e' attivo, usa solo direttive/refs validati dal contratto.
    const evidenceRefsByPredicate = new Map<string, string[]>();
    const deskDirectiveSource = deskEvidencePack !== null ? deskValidatedDirectives : shapeValidDirectives;
    for (const item of deskDirectiveSource) {
      if (isLearningPredicateId(item?.predicateId) && !directiveTextByPredicate.has(item.predicateId)) {
        directiveTextByPredicate.set(item.predicateId, String(item.directive));
      }
      if (isLearningPredicateId(item?.predicateId) && Array.isArray(item?.evidenceRefs)) {
        evidenceRefsByPredicate.set(
          item.predicateId,
          item.evidenceRefs.filter((ref: unknown): ref is string => typeof ref === 'string')
        );
      }
    }
    // Fase 3: stesso perimetro per il post-mortem del desk.
    const deskMemoryScopeUid = aiMemoryScopeUidOf(res);
    const deskDatasetHash = computeDatasetHash(sessionTrades);
    aiLearnedMemory = await loadAIMemoryForUser(deskMemoryScopeUid);
    const deskMemoryBefore = new Map(aiLearnedMemory.map((entry) => [entry.topic, entry.learnedAt]));

    // ADDITIVO (v10, Parte 3.6): stessa scansione deterministica su sessionTrades + deskExcluded reali.
    const deskScan = scanLearningPredicates(sessionTrades, deskExcluded);
    const deskTestedPredicates = deskScan.filter((entry) => entry.tested);
    const deskWinningPredicates = deskScan.filter((entry) => entry.passesGates);
    const deskDecisiveSample = Math.max(0, ...deskScan.map((entry) => entry.n));
    const deskDiscardedCount = shapeValidDirectives.length - deskWinningPredicates.length;

    const deskWinnerResults: LearningResult[] = deskWinningPredicates.map((entry) => ({
      ...(entry.result as LearningResult),
      directive:
        directiveTextByPredicate.get(entry.predicateId) ??
        `Predicato ${entry.predicateId}: n=${entry.n}, q=${entry.qValue.toFixed(4)}, avgR=${entry.avgR.toFixed(2)}, profitFactor=${entry.profitFactor.toFixed(2)}`,
      confidence: 1 - entry.qValue,
      // ADDITIVO (P8): stessa attribuzione del flusso di specializzazione.
      provenance: {
        promptVersion: deskPromptVersion,
        model: usedModel,
        evidenceRefs: evidenceRefsByPredicate.get(entry.predicateId) ?? [],
      },
    }));

    let deskPersistedCount = 0;
    if (deskWinnerResults.length > 0 && usedModel !== null) {
      updateAIMemory(deskWinnerResults, aiMemoryFilePathFor(deskMemoryScopeUid), {
        ownerUid: deskMemoryScopeUid,
        datasetHash: deskDatasetHash,
        runId: deskMemoryRunId,
      });
      aiLearnedMemory = loadAIMemoryFromDisk(deskMemoryScopeUid);
      if (firebaseAdminFirestore) {
        try {
          await persistAIMemoryToFirestore(aiLearnedMemory, deskMemoryScopeUid);
        } catch (persistError) {
          console.warn('[AI Desk Post-Mortem] Persistenza Firestore fallita:', persistError);
        }
      }
      for (const validation of deskWinnerResults) {
        const foundAfter = aiLearnedMemory.find((entry) => entry.topic === validation.topic);
        if (foundAfter && foundAfter.learnedAt !== deskMemoryBefore.get(validation.topic)) {
          deskPersistedCount += 1;
        }
      }
      aiLearnedMemory = await loadAIMemoryForUser(deskMemoryScopeUid);
    }

    const deskGateDetail =
      deskTestedPredicates.length === 0
        ? `${deskDecisiveSample}/${MIN_REAL_TRADE_SAMPLE} trade decisivi: nessun predicato con campione sufficiente.`
        : deskTestedPredicates
            .map(
              (entry) =>
                `PREDICATO ${entry.predicateId}: n=${entry.n}, q=${entry.qValue.toFixed(4)}, ` +
                `avgR=${entry.avgR.toFixed(2)}, profitFactor=${entry.profitFactor.toFixed(2)}`
            )
            .join(' | ');

    const deskOutcome = resolveSpecializationOutcome({
      hasOpenRouterKey: Boolean(openRouterKey),
      geminiAvailable: isGeminiAvailable(),
      llmErrorDetail,
      validDirectivesCount: deskWinningPredicates.length,
      discardedCount: 0,
      llmDirectiveCount: shapeValidDirectives.length,
      testedCount: deskTestedPredicates.length,
      decisiveSample: deskDecisiveSample,
      minSample: MIN_REAL_TRADE_SAMPLE,
      writtenCount: deskPersistedCount,
      gateDetail: deskGateDetail,
    });

    return res.json({
      success: true,
      market,
      reason: deskOutcome.reason,
      reasonDetail: deskOutcome.reasonDetail,
      sampleDecisive: deskDecisiveSample,
      minSample: MIN_REAL_TRADE_SAMPLE,
      postMortem: {
        executiveSummary: generated.executiveSummary,
        strengths: generated.strengths || [],
        failurePatterns: generated.failurePatterns || [],
        tacticalAdvice: generated.tacticalAdvice,
        generatedAt: new Date().toISOString(),
        // ADDITIVO: distingue un'analisi LLM reale da un riepilogo deterministico.
        llmUnavailable: generated.llmUnavailable === true,
        metrics: {
          total,
          wins: wins.length,
          losses: losses.length,
          breakevens: breakevens.length,
          expired: expired.length,
          winRatePct: Number(winRate),
          netPnlEur: Number(netPnl),
          avgR: Number(avgR),
        },
      },
      // Fase 3.3: campione dichiarato anche nel post-mortem.
      runId: deskMemoryRunId,
      datasetSource: deskCanonicalSample.source,
      datasetHash: deskDatasetHash,
      rejectedTrades: deskCanonicalSample.rejected,
      newDirectivesAdded: deskPersistedCount,
      proposedDirectives,
      discardedCount: deskDiscardedCount,
      note: deskPersistedCount > 0
        ? 'Direttive validate e persistite con gli stessi gate statistici dell\'handler di specializzazione.'
        : 'Le proposte del post-mortem non sono persistite; la memoria richiede validazione statistica sui trade reali.',
      deskAnalysis: deskAnalysisPayload,
      totalRules: aiLearnedMemory.length,
      directives: aiLearnedMemory,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

function applyOpenRouterCooldown(status: number, errBody: string, modelDesc: string): void {
  const lower = String(errBody || '').toLowerCase();
  const isDailyOrCredits =
    status === 402 ||
    lower.includes('free-models-per-day') ||
    lower.includes('per-day') ||
    lower.includes('credits');
  const cooldownMs = isDailyOrCredits ? 60 * 60 * 1000 : 90 * 1000;
  openRouterRateLimitedUntil = Date.now() + cooldownMs;
  const label = isDailyOrCredits ? 'quota giornaliera/crediti (cooldown 60m)' : 'rate limit RPM temporaneo (cooldown 90s)';
  console.info(`[OpenRouter] HTTP ${status} per ${modelDesc} — ${label}. Transizione a fallback.`);
}

// Helper: Invoca OpenRouter con timeout, parse JSON e gestione errori/crediti
async function callOpenRouterModel(
  modelOrModels: string | string[],
  systemInstruction: string,
  userPrompt: string,
  apiKey: string,
  timeoutMs: number = 15000,
  options: { endpoint?: AiLlmEndpoint; budget?: AiLlmRequestBudget | null } = {}
): Promise<{
  data: any;
  keyInvalid?: boolean;
  creditsExhausted?: boolean;
  status?: number;
  /** ADDITIVO (P5): modello che ha davvero risposto, per il log shadow. */
  model?: string;
  /** ADDITIVO (P10): motivo dello scarto quando la risposta non rispetta lo schema. */
  schemaError?: string;
} | null> {
  if (Date.now() < openRouterRateLimitedUntil) {
    return null;
  }

  const modelDesc = Array.isArray(modelOrModels) ? modelOrModels.join(' -> ') : modelOrModels;
  // P10: tetto di token dichiarato per endpoint (valori storici invariati).
  const maxTokens = options.endpoint
    ? AI_LLM_ENDPOINT_MAX_TOKENS[options.endpoint]
    : AI_LLM_ENDPOINT_MAX_TOKENS['ai-catalyst'];
  const schema = options.endpoint ? AI_LLM_SCHEMAS[options.endpoint] : undefined;

  // P10: un tentativo = una chiamata al provider, quindi un'unita' di budget
  // anche quando e' un retry. Il budget negato restituisce `null`, cioe' lo
  // stesso "modello assente" di prima: nessun percorso nuovo a valle.
  return runWithLlmRetry<{
    data: any;
    keyInvalid?: boolean;
    creditsExhausted?: boolean;
    status?: number;
    model?: string;
    schemaError?: string;
  } | null>(async () => {
  if (options.budget && !options.budget.tryConsume().ok) {
    console.info(`[OpenRouter] budget LLM esaurito per ${modelDesc}: chiamata non eseguita.`);
    return null;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload: any = {
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      temperature: 0.1,
      reasoning: { enabled: OPENROUTER_ENABLE_REASONING },
    };

    if (Array.isArray(modelOrModels)) {
      payload.models = modelOrModels;
    } else {
      payload.model = modelOrModels;
    }

    const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'HTTP-Referer': process.env.APP_URL || 'https://aistudio.google.com',
        'X-Title': 'Intraday Radar Knock-out',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.status === 401) {
      console.info(`[OpenRouter] 401 Unauthorized per ${modelDesc} - Chiave non valida.`);
      return { data: null, keyInvalid: true, status: 401 };
    }

    // P10: i 429 (e i 503) si ripetono con backoff; gli altri 4xx no, perche'
    // ripeterli brucia quota e nasconde l'errore.
    if (isRetryableLlmStatus(res.status)) {
      const errBody = await res.text().catch(() => '');
      // Il cooldown resta dove era: solo quando i retry sono esauriti.
      return aiLlmRetryRequest({
        status: res.status,
        retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
        exhausted: () => {
          applyOpenRouterCooldown(res.status, errBody, modelDesc);
          return { data: null, creditsExhausted: true, status: res.status };
        },
      });
    }

    if (res.status === 402) {
      const errBody = await res.text().catch(() => '');
      applyOpenRouterCooldown(res.status, errBody, modelDesc);
      return { data: null, creditsExhausted: true, status: res.status };
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.info(`[OpenRouter] HTTP ${res.status} per ${modelDesc}: ${errText.slice(0, 150)}`);
      return { data: null, status: res.status };
    }

    const json = await res.json();
    const rawContent = json.choices?.[0]?.message?.content;
    if (!rawContent || typeof rawContent !== 'string' || rawContent.trim().length === 0) {
      const finishReason = json.choices?.[0]?.finish_reason ?? 'unknown';
      console.info(`[OpenRouter] Risposta vuota (finish_reason=${finishReason}) per ${json.model || modelDesc}.`);
      return null;
    }

    const cleaned = rawContent
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') {
      // P10: lo schema si controlla PRIMA di leggere o completare i campi. Solo
      // i campi OBBLIGATORI possono far scartare la risposta: un campo
      // facoltativo fuori tipo viene rimosso, un numero fuori intervallo
      // riportato nel bordo, e la valutazione resta valida.
      if (schema) {
        const validated = validateAiLlmObject(parsed, schema);
        if (!validated.ok) {
          console.info(`[OpenRouter] risposta fuori schema per ${modelDesc}: ${validated.reason}.`);
          return { data: null, status: 0, schemaError: validated.reason };
        }
        if (validated.dropped.length > 0 || validated.clamped.length > 0) {
          console.info(
            `[OpenRouter] risposta normalizzata per ${modelDesc}: rimossi [${validated.dropped.join(', ')}], riportati nel bordo [${validated.clamped.join(', ')}].`
          );
        }
        parsed = validated.value;
      }
      const usedModel = json.model || (Array.isArray(modelOrModels) ? modelOrModels[0] : modelOrModels);
      // Coerce required fields if this is a trading signal evaluation
      if (parsed.decisione) {
        parsed.aiProvider = `openrouter:${usedModel}`;
        if (!Array.isArray(parsed.punti_a_favore)) parsed.punti_a_favore = [];
        if (!Array.isArray(parsed.rischi)) parsed.rischi = [];
        if (!Array.isArray(parsed.condizioni_invalidazione)) parsed.condizioni_invalidazione = [];
        if (!Array.isArray(parsed.fonti)) parsed.fonti = [];
        if (typeof parsed.newsBonusScore !== 'number') parsed.newsBonusScore = 0;
      }
      return { data: parsed, model: `openrouter:${String(usedModel)}` };
    }
    return null;
  } catch (err: any) {
    clearTimeout(timeoutId);
    const isAbort = err?.name === 'AbortError' || err?.cause?.name === 'AbortError';
    console.info(`[OpenRouter] ${modelDesc} temporaneamente non disponibile (${isAbort ? `timeout ${timeoutMs}ms` : err?.message || 'connessione'}), transizione a fallback.`);
    return null;
  }
  }, {
    onRetry: ({ attempt, status, delayMs }) =>
      console.info(
        `[OpenRouter] HTTP ${status} per ${modelDesc} — retry ${attempt}/${AI_LLM_RETRY_MAX_ATTEMPTS} fra ${delayMs}ms.`
      ),
  });
}

/**
 * ADDITIVO (Fasi 1-2): variante di `callOpenRouterModel` che NON interpreta la
 * risposta e restituisce il testo grezzo, cosi' il parser dei batch
 * `CANDIDATI_SCANSIONE` distingue JSON invalido (ERRORE_PARSING) da LLM assente.
 * Le funzioni esistenti non cambiano.
 */
async function callOpenRouterRawText(
  modelOrModels: string | string[],
  systemInstruction: string,
  userPrompt: string,
  apiKey: string,
  timeoutMs: number = 15000,
  options: { endpoint?: AiLlmEndpoint; budget?: AiLlmRequestBudget | null } = {}
): Promise<{ text: string; model: string | null } | null> {
  if (Date.now() < openRouterRateLimitedUntil) {
    return null;
  }

  const modelDesc = Array.isArray(modelOrModels) ? modelOrModels.join(' -> ') : modelOrModels;
  const maxTokens = options.endpoint
    ? AI_LLM_ENDPOINT_MAX_TOKENS[options.endpoint]
    : AI_LLM_ENDPOINT_MAX_TOKENS['ai-scan-batch'];

  return runWithLlmRetry<{ text: string; model: string | null } | null>(async () => {
  if (options.budget && !options.budget.tryConsume().ok) {
    console.info(`[OpenRouter] budget LLM esaurito per ${modelDesc} (batch candidati): chiamata non eseguita.`);
    return null;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload: any = {
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      temperature: 0.1,
      reasoning: { enabled: OPENROUTER_ENABLE_REASONING },
    };
    if (Array.isArray(modelOrModels)) {
      payload.models = modelOrModels;
    } else {
      payload.model = modelOrModels;
    }

    const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'HTTP-Referer': process.env.APP_URL || 'https://aistudio.google.com',
        'X-Title': 'Intraday Radar Knock-out',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (isRetryableLlmStatus(res.status)) {
      const errBody = await res.text().catch(() => '');
      return aiLlmRetryRequest({
        status: res.status,
        retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
        exhausted: () => {
          applyOpenRouterCooldown(res.status, errBody, modelDesc);
          return null;
        },
      });
    }
    if (res.status === 402) {
      const errBody = await res.text().catch(() => '');
      applyOpenRouterCooldown(res.status, errBody, modelDesc);
      return null;
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.info(`[OpenRouter] HTTP ${res.status} per ${modelDesc} (batch candidati): ${errText.slice(0, 150)}`);
      return null;
    }

    const json = await res.json();
    const rawContent = json?.choices?.[0]?.message?.content;
    if (typeof rawContent !== 'string' || rawContent.trim().length === 0) return null;
    const usedModel = json?.model ?? (Array.isArray(modelOrModels) ? modelOrModels[0] : modelOrModels);
    return {
      text: rawContent,
      model: typeof usedModel === 'string' && usedModel.length > 0 ? `openrouter:${usedModel}` : null,
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    const isAbort = err?.name === 'AbortError' || err?.cause?.name === 'AbortError';
    console.info(
      `[OpenRouter] ${modelDesc} batch candidati non disponibile (${isAbort ? `timeout ${timeoutMs}ms` : err?.message || 'connessione'}).`
    );
    return null;
  }
  }, {
    onRetry: ({ attempt, status, delayMs }) =>
      console.info(
        `[OpenRouter] HTTP ${status} per ${modelDesc} (batch candidati) — retry ${attempt}/${AI_LLM_RETRY_MAX_ATTEMPTS} fra ${delayMs}ms.`
      ),
  });
}

// Helper: Invoca Gemini con gestione sicura degli errori di credito (402/RESOURCE_EXHAUSTED) e quote
async function callGeminiModel(
  systemInstruction: string,
  userPrompt: string,
  responseSchema?: any,
  options: { endpoint?: AiLlmEndpoint; budget?: AiLlmRequestBudget | null } = {}
): Promise<{ data: any; quotaExhausted?: boolean; model?: string; schemaError?: string } | null> {
  if (!isGeminiAvailable()) {
    return null;
  }

  // P10: tetto di token dichiarato per endpoint, anche sul provider di fallback.
  const maxTokens = options.endpoint
    ? AI_LLM_ENDPOINT_MAX_TOKENS[options.endpoint]
    : AI_LLM_ENDPOINT_MAX_TOKENS['ai-catalyst'];
  const schema = options.endpoint ? AI_LLM_SCHEMAS[options.endpoint] : undefined;

  return runWithLlmRetry<{
    data: any;
    quotaExhausted?: boolean;
    model?: string;
    schemaError?: string;
  } | null>(async () => {
  if (options.budget && !options.budget.tryConsume().ok) {
    console.info('[AI Gemini] budget LLM esaurito: chiamata non eseguita.');
    return null;
  }
  try {
    const config: any = {
      systemInstruction,
      responseMimeType: 'application/json',
      maxOutputTokens: maxTokens,
    };
    if (responseSchema) {
      config.responseSchema = responseSchema;
    }

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: userPrompt,
      config,
    });

    const clean = (response.text || '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsed: any;
    try {
      parsed = JSON.parse(clean || '{}');
    } catch {
      console.info('[AI Gemini] risposta non JSON: nessun dato interpretato.');
      return null;
    }
    // P10: schema prima dei campi, come sul percorso OpenRouter. Solo i campi
    // obbligatori possono far scartare la risposta.
    if (schema) {
      const validated = validateAiLlmObject(parsed, schema);
      if (!validated.ok) {
        console.info(`[AI Gemini] risposta fuori schema: ${validated.reason}.`);
        return { data: null, schemaError: validated.reason };
      }
      if (validated.dropped.length > 0 || validated.clamped.length > 0) {
        console.info(
          `[AI Gemini] risposta normalizzata: rimossi [${validated.dropped.join(', ')}], riportati nel bordo [${validated.clamped.join(', ')}].`
        );
      }
      parsed = validated.value;
    }
    // ADDITIVO (P5): anche Gemini dichiara il proprio modello nel log.
    return { data: parsed, model: `gemini:${GEMINI_MODEL}` };
  } catch (err: any) {
    const status = err?.status || err?.code;
    const msg = String(err?.message || '');
    const is402 = status === 402 || msg.includes('402') || msg.includes('prepayment credits are depleted');
    const is429 = status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');

    if (is402) {
      geminiQuotaExhaustedUntil = Date.now() + 30 * 60 * 1000;
      console.info('[AI Gemini] Crediti prepagati esauriti (HTTP 402). Cooldown 30m e transizione a OpenRouter e regole deterministiche.');
      return { data: null, quotaExhausted: true };
    }

    if (is429) {
      return aiLlmRetryRequest({
        status: 429,
        exhausted: () => {
          geminiQuotaExhaustedUntil = Date.now() + 15 * 60 * 1000;
          console.info('[AI Gemini] Rate limit o quota raggiunta (HTTP 429). Cooldown 15m e transizione a fallback.');
          return { data: null, quotaExhausted: true };
        },
      });
    }

    console.info(`[AI Gemini] Modello non disponibile (${msg.slice(0, 100)}). Transizione a fallback.`);
    return null;
  }
  }, {
    onRetry: ({ attempt, status, delayMs }) =>
      console.info(`[AI Gemini] HTTP ${status} — retry ${attempt}/${AI_LLM_RETRY_MAX_ATTEMPTS} fra ${delayMs}ms.`),
  });
}

// Endpoint diagnostico per verificare la chiave OpenRouter
app.post('/api/test-openrouter', requireServerApiKey, async (req: Request, res: Response) => {
  try {
    const rawKey = (req.body?.apiKey || process.env.OPENROUTER_API_KEY || '').trim();
    if (!rawKey) {
      return res.status(400).json({
        success: false,
        error: 'Nessuna API Key fornita. Inseriscila nel corpo { "apiKey": "..." } o nel file .env (OPENROUTER_API_KEY).',
      });
    }

    const masked = rawKey.length > 14
      ? `${rawKey.slice(0, 10)}...${rawKey.slice(-4)}`
      : '***';

    const testPrompt = 'Rispondi solo con questo JSON: {"status": "ok", "message": "connessione riuscita"}';
    const modelsToTest = [OPENROUTER_PRIMARY_MODEL, OPENROUTER_FALLBACK_MODEL];

    const modelResults: any[] = [];
    for (const model of modelsToTest) {
      const t0 = Date.now();
      try {
        const resp = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${rawKey}`,
            'HTTP-Referer': process.env.APP_URL || 'https://aistudio.google.com',
            'X-Title': 'Intraday Radar Test',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: testPrompt }],
            response_format: { type: 'json_object' },
            max_tokens: 300,
            temperature: 0.1,
            reasoning: { enabled: OPENROUTER_ENABLE_REASONING },
          }),
        });

        const elapsed = Date.now() - t0;
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          modelResults.push({
            model,
            status: 'error',
            httpCode: resp.status,
            latencyMs: elapsed,
            error: errBody.slice(0, 200),
          });
        } else {
          const data = await resp.json();
          const contentReply = data.choices?.[0]?.message?.content;
          modelResults.push({
            model,
            status: contentReply ? 'ok' : 'empty_content',
            latencyMs: elapsed,
            finishReason: data.choices?.[0]?.finish_reason ?? null,
            reply: typeof contentReply === 'string' ? contentReply.slice(0, 120) : null,
          });
        }
      } catch (e: any) {
        modelResults.push({
          model,
          status: 'network_error',
          error: e?.message || String(e),
        });
      }
    }

    const anyOk = modelResults.some((m) => m.status === 'ok');
    return res.json({
      success: anyOk,
      apiKeyMasked: masked,
      models: modelResults,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// Analyze Catalyst (Gerarchia: Guardrail deterministici -> OpenRouter -> Fallback Gemini; zero risposte simulate)
const AI_CATALYST_PROMPT_VERSION = 'ai-catalyst@3';

function readEmpiricalVetoContext(market: 'EU' | 'US', vetoCode: string | null | undefined): string {
  if (!vetoCode) return 'nessun veto attivo';
  try {
    const vetoLogPath = path.join(process.cwd(), VETO_LOG_RELATIVE_PATH);
    if (!fs.existsSync(vetoLogPath)) return `${vetoCode} (storico controfattuale non ancora presente)`;
    const stat = fs.statSync(vetoLogPath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return vetoCode;
    const rows = summarizeVetoOutcomes(foldVetoLog(fs.readFileSync(vetoLogPath, 'utf8')));
    const matched = rows.find((r) => r.market === market && r.veto === vetoCode);
    if (!matched || matched.n === 0) {
      return `${vetoCode} (campione storico locale n=0)`;
    }
    return `${vetoCode} (storico locale ${market}: n=${matched.n}, target=${matched.target}, stop=${matched.stop}, meanRMarket=${matched.meanRMarket ?? 'n.d.'})`;
  } catch {
    return vetoCode;
  }
}

function buildMechanicalInvalidations(candidate: any): string[] {
  const ccy = typeof candidate?.currency === 'string' && candidate.currency ? candidate.currency : '';
  const fmt = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(2)}${ccy ? ` ${ccy}` : ''}` : null;
  const out: string[] = [];
  const vwap = fmt(candidate?.vwapState?.vwapLevel ?? candidate?.vwap);
  if (vwap) out.push(`Chiusura 5m avversa oltre VWAP di sessione (${vwap})`);
  const isShort = (candidate?.gapPercent ?? 0) < 0;
  const orbBound = fmt(isShort ? candidate?.orbHigh : candidate?.orbLow);
  if (orbBound) {
    out.push(
      isShort
        ? `Rottura al rialzo del massimo ORB (${orbBound})`
        : `Rottura al ribasso del minimo ORB (${orbBound})`
    );
  }
  const prevClose = fmt(candidate?.prevClose);
  if (prevClose) out.push(`Riassorbimento completo del gap verso chiusura precedente (${prevClose})`);
  return out;
}

app.post('/api/analyze-catalyst', requireApiAuth, async (req: Request, res: Response) => {
  try {
    const { candidate, news, futures } = req.body;

    if (!candidate || !candidate.ticker) {
      return res.status(400).json({ error: 'Candidato mancante per analisi' });
    }

    const realNews: NewsItem[] = Array.isArray(news) ? news : [];
    const nowMs = Date.now();
    const freshCheck = filterRelevantFreshNews(
      realNews,
      String(candidate.ticker),
      String(candidate.name || ''),
      nowMs,
      72
    );
    const verifiedNews = freshCheck.fresh;

    const hasTodayEarnings = candidate.daysToEarnings === 0 && Boolean(candidate.nextEarningsDate);
    const hasImminentEarnings =
      typeof candidate.daysToEarnings === 'number' &&
      candidate.daysToEarnings >= 0 &&
      candidate.daysToEarnings <= 2 &&
      Boolean(candidate.nextEarningsDate);

    // Normalizza il payload futures sia quando arriva completo ({ europe, usa }) sia come slice ({ dax } / { sp500 })
    const normalizedFutures = normalizeFuturesPayload(futures, candidate.market);
    const futuresChangeForCandidate = normalizedFutures.changePercent;
    const candidateSetupScore = calculateCandidateScore(candidate, futuresChangeForCandidate, null, {
      volume: candidate.lastBarVolume ?? null,
      barTime: candidate.lastBarTime ?? null,
    });
    const mechanicalInvalidations = buildMechanicalInvalidations(candidate);
    const hasFeedError =
      Array.isArray(candidate?.vwapState?.flags) &&
      candidate.vwapState.flags.includes('DATA_QUALITY:FEED_ERROR');

    // Guardrail 1: Trimestrale odierna sempre bloccante (prima di ogni chiamata LLM)
    if (hasTodayEarnings) {
      return res.json({
        decisione: 'NESSUN_TRADE',
        direzione: 'NESSUNA',
        catalizzatore: `Giorno di pubblicazione trimestrale (${candidate.nextEarningsDate}) per ${candidate.ticker}: rischio estremo di gap, spike bid/ask e knock-out anticipato sui certificati a leva.`,
        punti_a_favore: [],
        rischi: [
          `Trimestrale odierna (${candidate.nextEarningsDate}): allargamento spread emittente e volatilità non prezzabile intraday`,
        ],
        condizioni_invalidazione: [
          'Attendere il giorno successivo alla pubblicazione dei conti e la normalizzazione di spread e VWAP',
          ...mechanicalInvalidations,
        ],
        fonti: verifiedNews.map((n) => ({ title: n.title, url: n.url, source: n.source, time: n.publishedAt })),
        newsBonusScore: 0,
      });
    }

    // Guardrail 2: Dati intraday incompleti o feed error — evita di consumare quota LLM su dati corrotti
    if (hasFeedError || candidateSetupScore.warmupIncomplete) {
      return res.json({
        decisione: 'NESSUN_TRADE',
        direzione: 'NESSUNA',
        catalizzatore: `Dati intraday incompleti o feed non affidabile per ${candidate.ticker} (${hasFeedError ? 'DATA_QUALITY:FEED_ERROR' : 'warmup indicatori 5m incompleto'}).`,
        punti_a_favore: [],
        rischi: [
          'Serie 5m incompleta o degradata: impossibile validare il catalizzatore rispetto a VWAP/struttura intraday.',
        ],
        condizioni_invalidazione: [
          'Attendere il ripristino della copertura barre intraday e il completamento del warm-up',
          ...mechanicalInvalidations,
        ],
        fonti: verifiedNews.map((n) => ({ title: n.title, url: n.url, source: n.source, time: n.publishedAt })),
        newsBonusScore: 0,
      });
    }

    // Guardrail 3: Assenza di notizie fresche (<=72h) e pertinenti al ticker -> rigoroso NESSUN_TRADE lato catalizzatore
    // senza consumare chiamate LLM (mantiene la dicitura "Assenza di notizie verificate" per calculator.ts).
    if (verifiedNews.length === 0) {
      const discardDetail =
        freshCheck.staleCount > 0 || freshCheck.offTickerCount > 0
          ? ` (scartati ${freshCheck.staleCount} articoli obsoleti >72h e ${freshCheck.offTickerCount} articoli fuori-ticker)`
          : '';
      return res.json({
        decisione: 'NESSUN_TRADE',
        direzione: 'NESSUNA',
        // ADDITIVO (2.6): il motivo e' dichiarato, non dedotto dalla prosa.
        vetoReason: 'NO_NEWS',
        vetoSource: 'deterministic',
        catalizzatore:
          `Assenza di notizie verificate nelle ultime 72 ore per ${candidate.ticker}${discardDetail}: nessun catalizzatore fondamentale confermato.`,
        punti_a_favore: [],
        rischi: [
          `Assenza di notizie verificate e pertinenti nelle ultime 72 ore${discardDetail}.`,
          ...(hasImminentEarnings
            ? [
                `Attenzione: trimestrale imminente il ${candidate.nextEarningsDate} (tra ${candidate.daysToEarnings} gg) — evitare esposizione aggressiva su leva KO.`,
              ]
            : []),
        ],
        condizioni_invalidazione:
          mechanicalInvalidations.length > 0
            ? mechanicalInvalidations
            : ['Rottura del VWAP intraday nella prima ora', 'Riassorbimento totale del gap in apertura'],
        fonti: [],
        newsBonusScore: 0,
      });
    }

    let macroContextLine = 'nessun blackout macro attivo';
    let activeMacroWarning: string | null = null;
    try {
      const macroState = await getMacroCalendarState();
      if (macroState?.isBlackoutActive && macroState?.activeBlackoutEvent) {
        const evt = macroState.activeBlackoutEvent;
        macroContextLine = `BLACKOUT MACRO ATTIVO: ${evt.event} (${evt.currency}, ore ${evt.timeCET} CET, impatto ${evt.impact})`;
        activeMacroWarning = `Blackout macroeconomico attivo (${evt.event} ${evt.timeCET} CET): rischio allargamento spread certificati Knock-Out.`;
      } else if (Array.isArray(macroState?.events) && macroState.events.length > 0) {
        const upcoming = macroState.events
          .filter((e: any) => typeof e?.minutesToEvent === 'number' && e.minutesToEvent > 15 && e.minutesToEvent <= 90)
          .map((e: any) => `${e.event} (${e.timeCET} CET, tra ${e.minutesToEvent}m)`);
        if (upcoming.length > 0) {
          macroContextLine = `Rilascio macro imminente entro 90m: ${upcoming.join('; ')}`;
        }
      }
    } catch {
      // non bloccante
    }

    const candMarket: 'EU' | 'US' = candidate.market === 'US' ? 'US' : 'EU';
    const vetoContextLine = readEmpiricalVetoContext(candMarket, candidateSetupScore.veto);

    // Fase 3: il prompt del catalizzatore inietta solo la memoria di questo utente.
    aiLearnedMemory = await loadAIMemoryForUser(aiMemoryScopeUidOf(res));
    // ADDITIVO (2.5): le stesse regole che entrano nel testo restano attribuibili.
    // La riga di log del catalizzatore porta i loro id, cosi' un effetto si puo'
    // misurare su una regola precisa e non su "la memoria" in blocco.
    // Fase 4.1-4.2: entrano nel prompt solo regole validate, non revocate, non
    // scadute e ri-testate negli ultimi 90 giorni. Il testo non contiene
    // percentuali: mostra q, n, scadenza e modello.
    const memoryRulesUsed = selectActiveRules(aiLearnedMemory, Date.now()).slice(-6);
    const memoryRuleIds = memoryRulesUsed
      .map((directive) => (typeof directive.id === 'string' ? directive.id.trim() : ''))
      .filter((id) => id.length > 0);
    const activeDirectives = buildMemoryPromptBlock(memoryRulesUsed, Date.now());

    const systemInstruction = `Sei un analista di trading intraday rigoroso. Ricevi dati di mercato già calcolati dal codice e notizie reali con fonti.
REGOLE TASSATIVE:
- Usa esclusivamente i dati forniti. Non inventare prezzi, notizie, livelli o statistiche.
- Non fornire prezzi obiettivo, target o numeri non presenti nei dati.
- Valuta SOLO il catalizzatore: tipo, direzione, freschezza, affidabilità della fonte, rischi (utili imminenti, notizie già scontate, mercato/futures opposti al titolo).
- Preferisci rispondere "NESSUN_TRADE" piuttosto che forzare un segnale se le notizie sono generiche, contraddittorie, già scontate, stantie o opposte al regime di mercato/gap.
- Rispondi "TRADE" solo se esiste un catalizzatore chiaro, fresco e coerente con la direzione operativa e senza rischi ostativi (es. trimestrale odierna, contenziosi, downgrade severo).
- Indica sempre cosa invalida operativamente la tesi usando i livelli reali forniti.
- Non promettere mai rendimenti.
- Rispondi in italiano, rispettando esattamente la struttura JSON specificata.${
      activeDirectives
        ? `\n\nDIRETTIVE STATISTICHE VALIDATE DALLA MEMORIA DEL SISTEMA:\n${activeDirectives}`
        : ''
    }`;

    const userPrompt = `Analizza questo candidato per la sessione odierna basandoti ESCLUSIVAMENTE sulle notizie reali fornite:
DATI SOTTOSTANTE:
- Ticker: ${candidate.ticker} (${candidate.name})
- Mercato: ${candidate.market} | Valuta: ${candidate.currency}
- Prezzo Ultimo/Pre-market: ${candidate.preMarketPrice ?? candidate.currentPrice ?? 'dato non disponibile'}
- Chiusura Precedente: ${candidate.prevClose ?? 'dato non disponibile'}
- Gap %: ${candidate.gapPercent != null ? candidate.gapPercent + '%' : 'dato non disponibile'}
- Relative Volume (RVOL): ${candidate.rvol ?? 'dato non disponibile'}
- ATR(14) Giornaliero: ${candidate.atr14 ?? 'dato non disponibile'}
- Range Ieri: Min ${candidate.prevLow ?? 'nd'} - Max ${candidate.prevHigh ?? 'nd'}
- ORB Intraday: Min ${candidate.orbLow ?? 'nd'} - Max ${candidate.orbHigh ?? 'nd'}
- VWAP di sessione: ${candidate.vwapState ? `${candidate.vwapState.state} (livello ${candidate.vwapState.vwapLevel ?? candidate.vwap ?? 'nd'}) | distanza ${candidate.vwapState.distAtr ?? 'nd'} ATR | pendenza ${candidate.vwapState.slopeAtr ?? 'nd'} ATR | coverage ${candidate.vwapState.coverage ?? 'nd'} | volume ${candidate.vwapState.volumeRatio ?? 'nd'}x media 5m | flag ${(candidate.vwapState.flags || []).join(',') || 'nessuno'}` : 'dato non disponibile'}
- Supertrend 5m: ${candidate.setupIndicators?.supertrend
        ? `${candidate.setupIndicators.supertrend.status}${candidate.setupIndicators.supertrend.status === 'OK' ? ` | direction ${candidate.setupIndicators.supertrend.direction} | flip ${candidate.setupIndicators.supertrend.barsSinceFlip ?? 'nd'} barre fa` : ` | motivo ${candidate.setupIndicators.supertrend.reason}`}`
        : 'dato non disponibile'}
- ADX 5m: ${candidate.setupIndicators?.adx
        ? `${candidate.setupIndicators.adx.status}${candidate.setupIndicators.adx.status === 'OK' ? ` | value ${candidate.setupIndicators.adx.value} | plusDI ${candidate.setupIndicators.adx.plusDI} | minusDI ${candidate.setupIndicators.adx.minusDI}` : ` | motivo ${candidate.setupIndicators.adx.reason}`}`
        : 'dato non disponibile'}
- StochRSI 5m: ${candidate.setupIndicators?.stochRsi
        ? `${candidate.setupIndicators.stochRsi.status}${candidate.setupIndicators.stochRsi.status === 'OK' ? ` | k ${candidate.setupIndicators.stochRsi.k} | d ${candidate.setupIndicators.stochRsi.d} | lastCross ${candidate.setupIndicators.stochRsi.lastCross} | barsSinceCross ${candidate.setupIndicators.stochRsi.barsSinceCross ?? 'nd'}` : ` | motivo ${candidate.setupIndicators.stochRsi.reason}`}`
        : 'dato non disponibile'}
- PSAR 5m: ${candidate.setupIndicators?.psar
        ? `${candidate.setupIndicators.psar.status}${candidate.setupIndicators.psar.status === 'OK' ? ` | value ${candidate.setupIndicators.psar.value} | direction ${candidate.setupIndicators.psar.direction}` : ` | motivo ${candidate.setupIndicators.psar.reason}`}`
        : 'dato non disponibile'}
- Score breakdown: ${JSON.stringify(candidateSetupScore.scoreBreakdown)} | totale ${candidateSetupScore.total}/100
- Veto setup e storico controfattuale: ${vetoContextLine}
- Stato Calendario Macroeconomico Live: ${macroContextLine}
- Prossima Trimestrale (Calendario Reale): ${candidate.nextEarningsDate ? `${candidate.nextEarningsDate} (tra ${candidate.daysToEarnings ?? 'nd'} giorni, livello ${candidate.earningsRiskLevel ?? 'nd'})` : 'non segnalata / non disponibile'}
- Futures Indice Riferimento (${normalizedFutures.benchmarkLabel}): ${futuresChangeForCandidate !== null ? `${futuresChangeForCandidate >= 0 ? '+' : ''}${futuresChangeForCandidate.toFixed(2)}%` : 'dato non disponibile'} | dettaglio ${JSON.stringify(normalizedFutures.normalized)}

NOTIZIE REALI VERIFICATE (<=72h, pertinenti a ${candidate.ticker}):
${verifiedNews
  .map(
    (n, i) =>
      `[${i + 1}] Titolo: "${n.title}" | Fonte: ${n.source} | Data: ${n.publishedAt} | URL: ${n.url}\nRiassunto: ${n.summary}`
  )
  .join('\n\n')}

${VWAP_PROMPT_BLOCK}

${SETUP_PROMPT_BLOCK}
Istruzione: Valuta il catalizzatore qualitativo e rispondi ESCLUSIVAMENTE in JSON valido con questi campi:
decisione: "TRADE" oppure "NESSUN_TRADE"
direzione: "LONG" oppure "SHORT" oppure "NESSUNA"
catalizzatore: tipo, freschezza, affidabilità e descrizione del catalizzatore basata solo sulle notizie fornite
punti_a_favore: array di stringhe
rischi: array di stringhe (es. utili imminenti, notizie già scontate, futures opposti, rilasci macro imminenti)
condizioni_invalidazione: array di stringhe con condizioni concrete basate sui dati forniti
fonti: array di oggetti { title, url, source, time }
newsBonusScore: numero intero da 0 a 15 (15 per upgrade/contratti/catalizzatori freschi <24h da agenzia primaria; 5-10 per news rilevanti ma moderate; 0 se NESSUN_TRADE o news neutre/scontate)
confidenza: numero intero da 0 a 100 sulla solidità del catalizzatore nel contesto tecnico/futures fornito`;

    let parsed: any = null;
    let usedCatalystModel: string | null = null;
    let llmErrorDetail: string | null = null;
    const openRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();
    const catalystStartedAt = Date.now();
    // P10: budget per richiesta e per utente anche sul catalizzatore, che e'
    // l'endpoint chiamato piu' spesso (uno per candidato analizzato).
    const catalystUid =
      typeof res.locals.authenticatedUid === 'string' ? res.locals.authenticatedUid : null;
    const llmBudget = openAiLlmRequest(catalystUid);
    const budgetGate = llmBudget.peek();
    if (!budgetGate.ok) {
      return res.status(429).json({
        success: false,
        error: 'llm_budget_exhausted',
        scope: budgetGate.scope,
        limit: budgetGate.limit,
      });
    }

    // 1. TIER 1 & 2: OpenRouter
    if (openRouterKey) {
      const openRouterRes = await callOpenRouterModel(
        [OPENROUTER_PRIMARY_MODEL, OPENROUTER_FALLBACK_MODEL],
        systemInstruction,
        userPrompt,
        openRouterKey,
        15000,
        { endpoint: 'ai-catalyst', budget: llmBudget }
      );

      if (openRouterRes?.data?.decisione) {
        parsed = openRouterRes.data;
        usedCatalystModel = openRouterRes.model ?? null;
      } else if (openRouterRes?.keyInvalid) {
        llmErrorDetail = 'openrouter:401';
      } else if (openRouterRes?.creditsExhausted) {
        llmErrorDetail = 'openrouter:402/429';
      } else if (typeof openRouterRes?.status === 'number' && openRouterRes.status > 0) {
        llmErrorDetail = `openrouter:${openRouterRes.status}`;
      } else if (openRouterRes?.schemaError) {
        // P10 (revisione): un rifiuto per schema non e' "provider assente".
        llmErrorDetail = 'openrouter:schema';
      }
    }

    // 2. TIER 3: Fallback Gemini
    if ((!parsed || !parsed.decisione) && isGeminiAvailable()) {
      const gemRes = await callGeminiModel(systemInstruction, userPrompt, {
        type: Type.OBJECT,
        properties: {
          decisione: {
            type: Type.STRING,
            description: '"TRADE" o "NESSUN_TRADE"',
          },
          direzione: {
            type: Type.STRING,
            description: '"LONG" o "SHORT" o "NESSUNA"',
          },
          catalizzatore: {
            type: Type.STRING,
            description: 'Tipo, freschezza, affidabilita e valutazione del catalizzatore qualitativo',
          },
          punti_a_favore: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Punti a supporto della tesi',
          },
          rischi: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Rischi e criticita del catalizzatore o contesto',
          },
          condizioni_invalidazione: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Cosa invalida operativamente la tesi',
          },
          fonti: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                url: { type: Type.STRING },
                source: { type: Type.STRING },
                time: { type: Type.STRING },
              },
              required: ['title', 'source'],
            },
          },
          newsBonusScore: {
            type: Type.INTEGER,
            description: 'Punti bonus da 0 a 15 assegnati per il catalizzatore/notizia',
          },
          confidenza: {
            type: Type.INTEGER,
            description: 'Confidenza 0-100 sulla solidita del catalizzatore nel contesto tecnico/futures fornito',
          },
        },
        required: [
          'decisione',
          'direzione',
          'catalizzatore',
          'punti_a_favore',
          'rischi',
          'condizioni_invalidazione',
          'fonti',
        ],
      }, { endpoint: 'ai-catalyst', budget: llmBudget });

      if (gemRes?.data?.decisione) {
        parsed = gemRes.data;
        usedCatalystModel = gemRes.model || `gemini:${GEMINI_MODEL}`;
      } else if (gemRes?.quotaExhausted) {
        llmErrorDetail = 'gemini:402/429';
      } else if (gemRes?.schemaError) {
        llmErrorDetail = 'gemini:schema';
      }
    }

    const catalystDurationMs = Date.now() - catalystStartedAt;
    const activeRunId = getLastScanRunId();
    // Chiave prefissata `catalyst:` per non sovrascrivere la riga `scan` dello stesso
    // `runId:ticker` in `dedupeEntries`, pur restando una candidateRow valida per `catalystLift`.
    const catalystCandidateKey = activeRunId
      ? `catalyst:${activeRunId}:${candidate.ticker}`
      : `catalyst-${Date.now()}:${candidate.ticker}`;

    // Propagazione trasparente dell'errore upstream: nessuna risposta AI simulata
    if (!parsed || !parsed.decisione) {
      safeAppendAiShadowLog(
        {
          ticker: String(candidate.ticker),
          market: candMarket,
          direction: (candidate.gapPercent ?? 0) >= 0 ? 'LONG' : 'SHORT',
          setup: `catalyst news=${verifiedNews.length}`,
          aiOutcome: null,
          aiCategory: null,
          source: 'catalyst',
          evaluated: false,
          discarded: false,
          discardReason: 'LLM_NON_DISPONIBILE',
          decision: null,
          candidateSource: 'body',
          candidateKey: catalystCandidateKey,
          runId: activeRunId,
          durationMs: catalystDurationMs,
          promptVersion: AI_CATALYST_PROMPT_VERSION,
          model: null,
          memoryRuleIds,
        },
        path.join(process.cwd(), AI_SHADOW_LOG_RELATIVE_PATH)
      );
      return res.status(503).json({
        error:
          'Modello AI temporaneamente non disponibile per valutare le notizie del catalizzatore. Riprova tra qualche istante.',
        code: 'AI_UNAVAILABLE',
        llmErrorDetail: llmErrorDetail ?? 'no_provider_response',
      });
    }

    // Normalizzazione & guardrail deterministici post-LLM
    if (String(parsed.decisione).trim().toUpperCase() === 'NESSUN TRADE') {
      parsed.decisione = 'NESSUN_TRADE';
    } else if (String(parsed.decisione).trim().toUpperCase() !== 'TRADE') {
      parsed.decisione = 'NESSUN_TRADE';
    } else {
      parsed.decisione = 'TRADE';
    }

    const rawDir = String(parsed.direzione ?? '').trim().toUpperCase();
    parsed.direzione =
      parsed.decisione === 'NESSUN_TRADE'
        ? 'NESSUNA'
        : rawDir === 'LONG' || rawDir === 'SHORT'
          ? rawDir
          : (candidate.gapPercent ?? 0) >= 0
            ? 'LONG'
            : 'SHORT';

    const rawBonus = Number(parsed.newsBonusScore);
    let normalizedBonus =
      parsed.decisione === 'TRADE' && Number.isFinite(rawBonus)
        ? Math.max(0, Math.min(15, Math.round(rawBonus)))
        : 0;
    const rawConf = Number(parsed.confidenza);
    const normalizedConf = Number.isFinite(rawConf)
      ? Math.max(0, Math.min(100, Math.round(rawConf)))
      : null;

    // Tetto deterministico di credibilita': se nessuna notizia e' <24h E nessuna proviene da wire primario,
    // limita newsBonusScore a max +5 (o 0 se confidenza < 55) per impedire gonfiaggi da RSS secondari datati.
    if (parsed.decisione === 'TRADE' && !freshCheck.hasRecent24h && !freshCheck.hasPrimaryWire && normalizedBonus > 0) {
      const capped = normalizedConf !== null && normalizedConf < 55 ? 0 : Math.min(normalizedBonus, 5);
      if (capped < normalizedBonus) {
        normalizedBonus = capped;
        const existingRisks = Array.isArray(parsed.rischi) ? parsed.rischi : [];
        parsed.rischi = [
          ...existingRisks,
          `Tetto prudenziale bonus notizia (+${capped}): articoli tra 24h e 72h da fonti secondarie.`,
        ];
      }
    }

    // Filtro anti-overtrading contro-regime: se il catalizzatore e' opposto SIA al gap reale
    // (>= 0.3%) SIA ai futures di riferimento (>= 0.4%) con confidenza bassa (< 65), declassa a NESSUN_TRADE.
    const gapVal = typeof candidate.gapPercent === 'number' && Number.isFinite(candidate.gapPercent) ? candidate.gapPercent : null;
    const gapSign = gapVal != null && Math.abs(gapVal) >= 0.3 ? (gapVal > 0 ? 'LONG' : 'SHORT') : null;
    const futSign =
      futuresChangeForCandidate != null && Math.abs(futuresChangeForCandidate) >= 0.4
        ? futuresChangeForCandidate > 0
          ? 'LONG'
          : 'SHORT'
        : null;
    const dirMatch: 'aligned' | 'opposed' | 'neutral' =
      parsed.direzione === 'NESSUNA' || gapSign === null
        ? 'neutral'
        : parsed.direzione === gapSign
          ? 'aligned'
          : 'opposed';
    const regimeMatch: 'aligned' | 'opposed' | 'neutral' =
      parsed.direzione === 'NESSUNA' || futSign === null
        ? 'neutral'
        : parsed.direzione === futSign
          ? 'aligned'
          : 'opposed';

    if (
      parsed.decisione === 'TRADE' &&
      dirMatch === 'opposed' &&
      regimeMatch === 'opposed' &&
      (normalizedConf !== null ? normalizedConf < 65 : normalizedBonus < 10)
    ) {
      parsed.decisione = 'NESSUN_TRADE';
      parsed.direzione = 'NESSUNA';
      normalizedBonus = 0;
      parsed.vetoReason = 'COUNTER_REGIME';
      parsed.vetoSource = 'deterministic';
      const existingRisks = Array.isArray(parsed.rischi) ? parsed.rischi : [];
      parsed.rischi = [
        ...existingRisks,
        `Filtro anti-overtrading: direzione del catalizzatore opposta sia al gap intraday (${gapVal?.toFixed(2)}%) sia ai futures ${normalizedFutures.benchmarkLabel} (${futuresChangeForCandidate?.toFixed(2)}%) con confidenza insufficiente.`,
      ];
    }

    // Arricchisci con avviso blackout macro attivo, trimestrale imminente e livelli meccanici reali di invalidazione
    if (activeMacroWarning) {
      const existingRisks = Array.isArray(parsed.rischi) ? parsed.rischi : [];
      if (!existingRisks.some((r: unknown) => String(r).toLowerCase().includes('blackout macro'))) {
        parsed.rischi = [...existingRisks, activeMacroWarning];
      }
    }

    if (hasImminentEarnings) {
      const existingRisks = Array.isArray(parsed.rischi) ? parsed.rischi : [];
      const alreadyMentioned = existingRisks.some((r: unknown) =>
        String(r).toLowerCase().includes('trimestrale')
      );
      if (!alreadyMentioned) {
        parsed.rischi = [
          ...existingRisks,
          `Trimestrale imminente il ${candidate.nextEarningsDate} (tra ${candidate.daysToEarnings} gg): ridurre aggressività su leva KO.`,
        ];
      }
    }

    const existingInvalidations: string[] = Array.isArray(parsed.condizioni_invalidazione)
      ? parsed.condizioni_invalidazione.filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
      : [];
    for (const mech of mechanicalInvalidations) {
      if (!existingInvalidations.some((line) => line.includes(mech.slice(0, 20)))) {
        existingInvalidations.push(mech);
      }
    }
    parsed.condizioni_invalidazione = existingInvalidations;
    parsed.newsBonusScore = normalizedBonus;
    if (normalizedConf !== null) parsed.confidenza = normalizedConf;
    if (usedCatalystModel) parsed.aiProvider = usedCatalystModel;
    if (!Array.isArray(parsed.fonti) || parsed.fonti.length === 0) {
      parsed.fonti = verifiedNews.map((n) => ({
        title: n.title,
        url: n.url,
        source: n.source,
        time: n.publishedAt,
      }));
    }

    // Registra la valutazione del catalizzatore nel log Shadow AI per misurare empiricamente
    // il lift reale di newsBonusScore e dell'allineamento direzionale in /api/shadow/ai-calibration.
    safeAppendAiShadowLog(
      {
        ticker: String(candidate.ticker),
        market: candMarket,
        direction: parsed.direzione === 'NESSUNA' ? ((candidate.gapPercent ?? 0) >= 0 ? 'LONG' : 'SHORT') : parsed.direzione,
        setup: `catalyst score=${candidateSetupScore.total}/100 news=${verifiedNews.length} bonus=+${normalizedBonus}`,
        aiOutcome: String(parsed.catalizzatore || '').slice(0, 280),
        aiCategory: `newsBonus=${normalizedBonus};dirMatch=${dirMatch};regime=${regimeMatch}`,
        source: 'catalyst',
        evaluated: true,
        discarded: false,
        discardReason: null,
        decision: parsed.decisione === 'TRADE' ? 'AZIONE' : 'SCARTO',
        candidateSource: 'body',
        candidateKey: catalystCandidateKey,
        runId: activeRunId,
        durationMs: catalystDurationMs,
        promptVersion: AI_CATALYST_PROMPT_VERSION,
        model: usedCatalystModel,
        memoryRuleIds,
      },
      path.join(process.cwd(), AI_SHADOW_LOG_RELATIVE_PATH)
    );

    return res.json(parsed);
  } catch (error: any) {
    console.error('[Analyze Catalyst] Errore interno:', error?.message || error);
    return res.status(500).json({
      error: 'Errore interno durante la valutazione del catalizzatore.',
      code: 'CATALYST_INTERNAL_ERROR',
    });
  }
});

// Cache control endpoint
app.post('/api/cache/clear', requireApiAuth, (_req: Request, res: Response) => {
  cache.clear();
  res.json({ message: 'Cache svuotata con successo' });
});

let nightlyLearningInProgress = false;
async function executeNightlyLearning() {
  if (nightlyLearningInProgress) throw new Error('Nightly learning già in esecuzione su questa istanza');
  nightlyLearningInProgress = true;
  try {
    const persistentMemory = await loadPersistentAIMemory();
    saveAIMemoryLocally(persistentMemory);
    const results = await runNightlyLearning(false);
    aiLearnedMemory = loadAIMemoryFromDisk();
    await persistAIMemoryToFirestore(aiLearnedMemory);
    return results;
  } finally {
    nightlyLearningInProgress = false;
  }
}

app.post('/api/ai/learning/run', requireServerApiKey, async (_req: Request, res: Response) => {
  try {
    const results = await executeNightlyLearning();
    return res.json({ success: true, validatedPatterns: results.length });
  } catch (error: any) {
    return res.status(409).json({ success: false, error: error?.message || String(error) });
  }
});

if (process.env.K_SERVICE) {
  console.warn('[Cron] Cloud Run: configura Cloud Scheduler su POST /api/ai/learning/run (cron in-process disabilitato per evitare duplicati e cold start).');
} else {
  cron.schedule('0 2 * * 1-5', () => {
    void executeNightlyLearning().catch((error: unknown) => {
      console.error('[Cron] Nightly learning fallito:', error);
    });
  }, { timezone: 'Europe/Rome' });
  console.log('[Cron] Nightly learning schedulato: 02:00 Europe/Rome lun-ven');
}

// Sola lettura export Shadow V2 (CSV o JSONL da artifacts/shadow_v2/signals.jsonl)
app.get('/api/shadow/v2/export', async (req: Request, res: Response) => {
  const format = String(req.query.format || 'csv').toLowerCase() === 'jsonl' ? 'jsonl' : 'csv';
  const signalsPath = path.join(process.cwd(), 'artifacts', 'shadow_v2', 'signals.jsonl');
  const records: ShadowV2Record[] = [];
  try {
    const raw = await fs.promises.readFile(signalsPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        records.push(JSON.parse(t));
      } catch {
        // ignora riga corrotta
      }
    }
  } catch {
    // file non ancora creato: esporta header vuoto (CSV) o payload vuoto (JSONL)
  }

  const ordered = [...records].sort((a, b) => (b.signalBarTs ?? 0) - (a.signalBarTs ?? 0));
  if (format === 'jsonl') {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="shadow_v2_signals.jsonl"');
    return res.status(200).send(formatShadowV2SignalsJsonl(ordered));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="shadow_v2_signals.csv"');
  return res.status(200).send(formatShadowV2SignalsCsv(ordered));
});

app.use(express.static(path.join(__dirname, 'public')));

// Set up Vite or Static Serving
async function startServer() {
  // Registra le route Shadow e avvia il collector PRIMA del middleware Vite/SPA
  // (altrimenti app.get('*') cattura /api/shadow/*).
  registerShadowRoutesFromDisk(app);
  // ADDITIVO (Fase 9): se il file locale ha meno di `limit` voci e il flag
  // SHADOW_AI_LOG_FIRESTORE e' acceso, le voci mancanti arrivano da Firestore
  // (fallback in lettura). In errore la risposta resta quella del file.
  app.get('/api/shadow/ai-log', async (req: Request, res: Response) => {
    try {
      const includeScan =
        (req.query as any)?.includeScan === '1' || (req.query as any)?.includeScan === 'true';
      const body = await buildAiShadowLogResponseWithFallback(
        (req.query as any)?.limit,
        path.join(process.cwd(), AI_SHADOW_LOG_RELATIVE_PATH),
        { includeScan }
      );
      return res.json(body);
    } catch (err: any) {
      return res.status(500).json({ entries: [], count: 0, error: err?.message || String(err) });
    }
  });
  // ADDITIVO (PR-C): calibrazione read-only decisione AI -> esito forward.
  // Nessuna scrittura, nessun cambio di memoria o gate: legge il log AI shadow
  // e gli esiti gia' persistiti da Shadow V1-live (segnali emessi + near-miss)
  // e li abbina per ticker + tempo.
  // Factory, non oggetto: le barre del costo si leggono una volta per richiesta
  // (Fase 6.3), non una volta per processo.
  registerAiCalibrationRoute(app, createAiCalibrationDeps);
  // L'auth viaggia con la registrazione della route (non come middleware
  // registrato a parte): la garanzia non dipende dall'ordine di registrazione e
  // la stessa logica resta unica (resolveApiAuth).
  const v1CollectorReg = registerShadowV1LiveCollector(app, {
    deferInitialCycle: true,
    authorize: async (req) => {
      const auth = await resolveApiAuthFor(req as Request);
      return auth.ok ? auth.uid : null;
    },
  });
  registerShadowV1LiveViewRoute(app);
  flushShadowV1LiveBarsToDisk();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  syncShadowV2SummaryFromDisk(__dirname);
  aiLearnedMemory = await loadPersistentAIMemory();

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Intraday Radar] Server running at http://0.0.0.0:${PORT}`);
    if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_AUTO_MARKET_SCAN !== 'true') {
      const warmupTimer = setTimeout(() => {
        void runScheduledMarketScan();
      }, 15_000);
      if (typeof warmupTimer.unref === 'function') warmupTimer.unref();

      const intervalTimer = setInterval(() => {
        void runScheduledMarketScan();
      }, SHADOW_MARKET_SCAN_INTERVAL_MS);
      if (typeof intervalTimer.unref === 'function') intervalTimer.unref();
    }
  });

  // Punto 9: il listen e' gia' attivo, l'idratazione Shadow gira in background e le scansioni
  // attendono `startupShadowHydrationPromise` (limitata dal timeout Firestore 5s) cosi'
  // `/api/market-data` al cold start non restituisce mai un radar vuoto.
  // Nota sui tempi: le letture di hydrateAllShadowStateFromFirestore sono 6 chiamate
  // sequenziali con timeout di 5s (massimo teorico 30s); le scritture e i sync successivi
  // non hanno timeout, quindi il gate può durare più dei 5s citati sopra.
  if (firebaseAdminFirestore) {
    setShadowFirestoreAdapter(createAdminFirestoreAdapter(firebaseAdminFirestore));
    startupShadowHydrationPromise = hydrateAllShadowStateFromFirestore(__dirname)
      .then(() => {
        syncShadowV2SummaryFromDisk(__dirname);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[Startup] Idratazione Shadow da Firestore non riuscita: ${message}`);
      })
      .finally(() => {
        startupShadowHydrationState = 'ready';
        v1CollectorReg.triggerCycle?.();
        console.log('[Startup] Idratazione Shadow da Firestore conclusa: scansioni e rivalutazione V1-live abilitate.');
      });
  } else {
    startupShadowHydrationState = 'ready';
    startupShadowHydrationPromise = Promise.resolve();
    v1CollectorReg.triggerCycle?.();
    console.log('[Startup] Firestore non configurato: nessuna idratazione Shadow, scansioni abilitate.');
  }

  let shuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] Ricevuto ${signal}: salvo barre e sincronizzo Shadow su Firestore...`);
    flushShadowV1LiveBarsToDisk();
    saveShadowV2BarsToDisk(__dirname);
    void flushPendingShadowFirestoreSync().finally(() => {
      httpServer.close(() => {
        process.exit(0);
      });
      const forceTimer = setTimeout(() => process.exit(0), 2_000);
      if (typeof forceTimer.unref === 'function') forceTimer.unref();
    });
  };

  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
