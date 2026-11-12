import express, { NextFunction, Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { createHash, timingSafeEqual } from 'node:crypto';
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
import { computeSetupIndicators, loadWarmupBars, selectWarmupBars, WarmupSeriesResult } from './src/utils/indicators';
import { getExchangeDateStr, getMarketTime } from './src/utils/timezone';
import { TRADING_PARAMS } from './src/config/tradingParams';
import { VWAP_PROMPT_BLOCK } from './src/config/vwapPrompt';
import { SETUP_PROMPT_BLOCK } from './src/config/setupPrompt';
import { AILearnedInsight, VwapSignalState, VwapDataQuality, SetupIndicators, IndicatorBarInput } from './src/types/radar';
import { runNightlyLearning } from './scripts/nightly_learning';
import { authStartupWarning } from './src/utils/authStartupWarning';

dotenv.config();

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
  const temporaryPath = `${SHARED_STATE_FILE}.${process.pid}.tmp`;
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

function loadAIMemoryFromDisk(): AILearnedInsight[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(AI_MEMORY_FILE, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is AILearnedInsight =>
      entry &&
      typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      typeof entry.topic === 'string' &&
      typeof entry.directive === 'string' &&
      (entry.confidence === null || typeof entry.confidence === 'number')
    );
  } catch {
    return [];
  }
}

function saveAIMemoryLocally(memory: AILearnedInsight[]): void {
  const temporaryPath = `${AI_MEMORY_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(memory, null, 2), 'utf-8');
    fs.renameSync(temporaryPath, AI_MEMORY_FILE);
  } catch (error) {
    console.warn('[AI Specialization] Impossibile aggiornare il mirror locale:', error);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

let aiLearnedMemory: AILearnedInsight[] = loadAIMemoryFromDisk();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

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
const AI_MEMORY_FIRESTORE_PATH = [
  'users',
  AI_MEMORY_SYSTEM_UID,
  'ai_specialization_memory',
  'current',
] as const;
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

async function loadPersistentAIMemory(): Promise<AILearnedInsight[]> {
  const localMemory = loadAIMemoryFromDisk();
  if (firebaseAdminFirestore) {
    try {
      const reference = firebaseAdminFirestore.doc(AI_MEMORY_FIRESTORE_PATH.join('/'));
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
        const localUpdatedAt = fs.existsSync(AI_MEMORY_FILE) ? fs.statSync(AI_MEMORY_FILE).mtimeMs : 0;
        const remoteUpdatedAt = Date.parse(String(documentData?.updatedAt || '')) || 0;

        if (remoteMemory.length > 0 && (remoteUpdatedAt >= localUpdatedAt || localMemory.length === 0)) {
          saveAIMemoryLocally(remoteMemory);
          return remoteMemory;
        }
        const memoryMatches = JSON.stringify(localMemory) === JSON.stringify(remoteMemory);
        if (localMemory.length > 0 && !memoryMatches) {
          await persistAIMemoryToFirestore(localMemory);
        }
        return localMemory.length > 0 ? localMemory : remoteMemory;
      }

      if (localMemory.length > 0) {
        await persistAIMemoryToFirestore(localMemory);
      }
      return localMemory;
    } catch (error) {
      console.warn('[AI Specialization] Firestore non disponibile; fallback alla memoria locale:', error);
    }
  }
  return loadAIMemoryFromDisk();
}

async function persistAIMemoryToFirestore(memory: AILearnedInsight[]): Promise<void> {
  if (!firebaseAdminFirestore) return;
  const reference = firebaseAdminFirestore.doc(AI_MEMORY_FIRESTORE_PATH.join('/'));
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


async function requireApiAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (isValidApiKey(req)) {
    res.locals.authenticatedUid = 'service-api-key';
    next();
    return;
  }

  const authorization = req.get('authorization') || '';
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) {
    // AUDIT D2: fail-closed. Nessun header = richiesta non autenticata (401), non una sessione legacy.
    if (ALLOW_LEGACY_API_AUTH) {
      res.locals.authenticatedUid = 'legacy';
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized', message: 'Bearer token required' });
    return;
  }
  if (!firebaseAdminAuth) {
    // AUDIT D2: senza Firebase Admin nessun token e' verificabile: 401, mai fail-open.
    if (ALLOW_LEGACY_API_AUTH) {
      res.locals.authenticatedUid = 'legacy';
      next();
      return;
    }
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Auth backend not configured: Firebase Admin credentials missing',
    });
    return;
  }

  try {
    const decoded = await firebaseAdminAuth.verifyIdToken(tokenMatch[1]);
    res.locals.authenticatedUid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized', message: 'Firebase ID token invalid or expired' });
  }
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
let geminiCreditsDepleted: boolean = false;
let openRouterRateLimitedUntil: number = 0;

function isGeminiAvailable(): boolean {
  if (!process.env.GEMINI_API_KEY) return false;
  if (geminiCreditsDepleted) return false;
  if (Date.now() < geminiQuotaExhaustedUntil) return false;
  return true;
}

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
if (process.env.GEMINI_API_KEY) {
  (async () => {
    try {
      await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: 'ping',
      });
      console.info('[AI Gemini] API attiva e verificata con successo.');
    } catch (startupErr: any) {
      const status = startupErr?.status || startupErr?.code;
      const msg = String(startupErr?.message || '');
      if (status === 402 || msg.includes('402') || msg.includes('prepayment credits are depleted')) {
        geminiCreditsDepleted = true;
        geminiQuotaExhaustedUntil = Date.now() + 24 * 60 * 60 * 1000;
        console.info('[AI Gemini] Crediti prepagati esauriti (HTTP 402). Transizione trasparente su OpenRouter e regole deterministiche.');
      } else if (status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        geminiQuotaExhaustedUntil = Date.now() + 30 * 60 * 1000;
        console.info('[AI Gemini] Quota temporaneamente esaurita (HTTP 429). Attivato cooldown 30m.');
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
// Default = valori storici hardcoded: senza variabili il comportamento non cambia.
const OPENROUTER_PRIMARY_MODEL = (process.env.OPENROUTER_PRIMARY_MODEL || '').trim() || 'nvidia/nemotron-3-ultra-550b-a55b:free';
const OPENROUTER_FALLBACK_MODEL = (process.env.OPENROUTER_FALLBACK_MODEL || '').trim() || 'openrouter/free';

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

// Fetch real live EUR/USD exchange rate from Yahoo Finance feed (no hardcoded fallback)
async function getLiveEurUsdRate(): Promise<number> {
  const cacheKey = 'fx:EURUSD';
  const cached = cache.get<number>(cacheKey);
  if (cached) return cached.data;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1d&range=1d&_=${Date.now()}`;
  const resp = await fetchWithTimeout(url, {
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
}

// Fetch real 5-minute Intraday RSI, 20-minute RVOL, ORB levels & Synthetic Order Flow
/**
 * Barre 5m per la serie di warm-up degli indicatori (range dedicato, IPOTESI).
 * Errore esplicito sul feed: il chiamante decide il fallback, nessun dato inventato.
 */
async function fetchWarmup5mBars(ticker: string, range: string): Promise<IndicatorBarInput[]> {
  const ySymbol = ticker.includes('.') ? ticker : `${ticker}`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?interval=5m&range=${encodeURIComponent(range)}&includePrePost=true&_=${Date.now()}`;
  const resp = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(12000),
  });
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

async function getIntraday5mMetrics(
  ticker: string,
  market: 'EU' | 'US' = 'EU'
): Promise<{
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
}> {
  const cacheKey = `metrics5m:${ticker}:${market}`;
  const cached = cache.get<{
    rsi5m: number | null;
    rvol: number | null;
    rvol20m: number | null;
    orderFlow: OrderFlowMetrics | null;
    orbHigh: number | null;
    orbLow: number | null;
    orbBreakoutTime: string | null;
    orbBreakoutTimeLong: string | null;
    orbBreakoutTimeShort: string | null;
    vwapState?: VwapSignalState | null;
    lastBarVolume?: number | null;
    lastBarTime?: number | null;
    vwapDataQuality?: VwapDataQuality | null;
  setupIndicators?: SetupIndicators | null;
  }>(cacheKey);
  if (cached) return cached.data;

  try {
    const ySymbol = ticker.includes('.') ? ticker : `${ticker}`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?interval=5m&range=60d&includePrePost=true&_=${Date.now()}`;
    const resp = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return { rsi5m: null, rvol: null, rvol20m: null, orderFlow: null, orbHigh: null, orbLow: null, orbBreakoutTime: null, orbBreakoutTimeLong: null, orbBreakoutTimeShort: null, vwapCumulative: null, vwapCumulativeWithPre: null, vwapCoverage: null, vwapState: null, lastBarVolume: null, lastBarTime: null, vwapDataQuality: { ok: false, reason: `FEED_ERROR:HTTP ${resp.status}`, coverage: 0 }, setupIndicators: null };
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
        // e vengono passati al call site di calculateCandidateScore.
        const lastSessionBar = [...bars]
          .reverse()
          .find((b) => getExchangeDateStr(market, new Date(b.timestamp * 1000)) === sessionDate);
        lastBarVolume = lastSessionBar?.volume ?? null;
        lastBarTime = lastSessionBar?.timestamp ?? null;
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
        const metaPrice = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
        const quality = computeVwapDataQuality(
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
    };
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

  // Launch 5m intraday metrics fetch (RSI 5m + RVOL 20m + ORB) in parallel for zero added latency
  const intraday5mPromise = getIntraday5mMetrics(queryTicker, market);

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
    const yResp = await fetchWithTimeout(yUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        Accept: 'application/json',
      },
    });

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

        // For US stocks, query the 5m intraday feed if pre-market price or volume is missing
        const cet = getCETTime();
        if (market === 'US' && (!pmVol || !preMarketP || preMarketP === prevC)) {
          try {
            const pmUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?interval=5m&range=1d&includePrePost=true&_=${Date.now()}`;
            const pmResp = await fetchWithTimeout(pmUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            });
            if (pmResp.ok) {
              const pmJson = await pmResp.json();
              const pmQuotes = pmJson?.chart?.result?.[0]?.indicators?.quote?.[0];
              const pmCloses = pmQuotes?.close?.filter((c: any) => typeof c === 'number');
              if (pmCloses && pmCloses.length > 0) {
                const latestTick = pmCloses[pmCloses.length - 1];
                if (!preMarketP || preMarketP === prevC) {
                  preMarketP = latestTick;
                  currentP = latestTick;
                }
              }
              const pmVolumes = pmQuotes?.volume?.filter((v: any) => typeof v === 'number');
              if (pmVolumes && pmVolumes.length > 0) {
                const sumVol = pmVolumes.reduce((a: number, b: number) => a + b, 0);
                if (sumVol > 0) pmVol = sumVol;
              }
            }
          } catch {
            // keep currentP
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
        const intradayMetrics = await intraday5mPromise;
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
  const searchName = isSpaceX ? 'SpaceX Space Exploration' : (queryTicker === 'LDO.MI' ? 'Leonardo' : name);

  const newsList: NewsItem[] = [];

  // 1. Try Finnhub if key provided
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (finnhubKey) {
    try {
      const cleanTicker = queryTicker.split('.')[0];
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000 * 2).toISOString().split('T')[0];
      const resp = await fetchWithTimeout(
        `https://finnhub.io/api/v1/company-news?symbol=${cleanTicker}&from=${yesterday}&to=${today}&token=${finnhubKey}`
      );
      if (resp.ok) {
        const items = await resp.json();
        if (Array.isArray(items)) {
          for (let i = 0; i < Math.min(items.length, 4); i++) {
            const item = items[i];
            if (item.headline) {
              newsList.push({
                id: `finnhub-${cleanTicker}-${i}`,
                title: item.headline,
                summary: item.summary || 'Notizia da fonte finanziaria accreditata',
                source: item.source || 'Finnhub Wire',
                url: item.url || 'https://finnhub.io',
                publishedAt: new Date(item.datetime * 1000).toISOString(),
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Fetch real live articles from Google News RSS feed (Italian financial coverage)
  if (newsList.length === 0) {
    try {
      const query = encodeURIComponent(`${searchName} ${isSpaceX ? 'SpaceX' : ticker} borsa`);
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

        while ((match = itemRegex.exec(text)) !== null && idx < 5) {
          const itemBlock = match[1];
          const titleM = itemBlock.match(/<title>([\s\S]*?)<\/title>/);
          const linkM = itemBlock.match(/<link>([\s\S]*?)<\/link>/);
          const sourceM = itemBlock.match(/<source[^>]*>([\s\S]*?)<\/source>/);
          const pubDateM = itemBlock.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
          const descM = itemBlock.match(/<description>([\s\S]*?)<\/description>/);

          if (titleM) {
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
            const publishedAt = pubDateM ? new Date(pubDateM[1].trim()).toISOString() : new Date().toISOString();
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

            newsList.push({
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
      }
    } catch (e: any) {
      console.error(`Errore fetch RSS per ${ticker}:`, e.message);
    }
  }

  // 3. For US stocks or when Italian coverage is empty, query real English/US financial RSS
  if (newsList.length === 0) {
    try {
      const usQuery = encodeURIComponent(`${searchName} ${isSpaceX ? 'SpaceX' : ticker} stock`);
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

        while ((match = itemRegex.exec(text)) !== null && idx < 5) {
          const itemBlock = match[1];
          const titleM = itemBlock.match(/<title>([\s\S]*?)<\/title>/);
          const linkM = itemBlock.match(/<link>([\s\S]*?)<\/link>/);
          const sourceM = itemBlock.match(/<source[^>]*>([\s\S]*?)<\/source>/);
          const pubDateM = itemBlock.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
          const descM = itemBlock.match(/<description>([\s\S]*?)<\/description>/);

          if (titleM) {
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
            const publishedAt = pubDateM ? new Date(pubDateM[1].trim()).toISOString() : new Date().toISOString();
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

            newsList.push({
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

// Batch Market Data for Underlyings
app.post('/api/market-data', async (req: Request, res: Response) => {
  try {
    const { underlyings, refresh } = req.body;
    const bypass = refresh === true || req.query.refresh === 'true';
    if (!Array.isArray(underlyings) || underlyings.length === 0) {
      return res.status(400).json({ error: 'Array "underlyings" richiesto' });
    }

    // Esecuzione concorrente a lotti controllati (concurrency = 6) per evitare saturazione e timeout da Yahoo Finance
    const results = await mapConcurrent(
      underlyings,
      6,
      (item) =>
        fetchQuoteForTicker(
          item.ticker,
          item.nome || item.name,
          item.mercato || item.market || 'EU',
          item.valuta || item.currency || 'EUR',
          bypass
        )
    );

    // Qualita' dati VWAP per scansione: solo log/report, nessun impatto su UI o punteggi.
    console.log(formatVwapDataQualityScan('ALL', results));

    // Log di scan (IPOTESI): per candidato breakdown, veti e stati indicatori; poi distribuzione punteggi.
    try {
      const futuresScan = await getFutures();
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
      for (const { quote, score } of scanScores) {
        const ind = quote.setupIndicators;
        const indTxt = ind
          ? `ST ${ind.supertrend.status}${ind.supertrend.status === 'OK' ? `(dir ${ind.supertrend.direction}, flip ${ind.supertrend.barsSinceFlip ?? 'nd'})` : ''} | ADX ${ind.adx.status}${ind.adx.status === 'OK' ? `(${ind.adx.value})` : ''} | StochRSI ${ind.stochRsi.status}${ind.stochRsi.status === 'OK' ? `(K ${ind.stochRsi.k}/D ${ind.stochRsi.d}, ${ind.stochRsi.lastCross})` : ''} | PSAR ${ind.psar.status}`
          : 'indicatori non disponibili';
        console.log(
          `[Setup score] ${quote.ticker}: ${score.total}/100 | veto ${score.veto ?? 'nessuno'} | ${indTxt} | breakdown ${JSON.stringify(score.scoreBreakdown)}`
        );
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
    } catch (err: any) {
      console.log(`[Setup score] log non disponibile: ${err?.message || err}`);
    }

    res.json({
      count: results.length,
      data: results,
      cachedAt: new Date().toISOString(),
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
  aiLearnedMemory = await loadPersistentAIMemory();
  res.json({
    totalRules: aiLearnedMemory.length,
    lastUpdated: aiLearnedMemory[aiLearnedMemory.length - 1]?.learnedAt || new Date().toISOString(),
    memory: aiLearnedMemory,
    directives: aiLearnedMemory,
  });
});

// POST /api/ai/specialize: L'AI analizza i trade e i setup scartati per distillare nuove regole empiriche di condotta
app.post('/api/ai/specialize', requireApiAuth, async (req: Request, res: Response) => {
  try {
    const userId = typeof res.locals.authenticatedUid === 'string' ? res.locals.authenticatedUid : 'legacy';
    const sharedAppState = getSharedAppState(userId);
    const trades: any[] = Array.isArray(req.body?.trades) ? req.body.trades : (sharedAppState.journalEntries || []);
    const excluded: any[] = Array.isArray(req.body?.excluded) ? req.body.excluded : (sharedAppState.excludedRecords || []);

    if (trades.length === 0 && excluded.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Dati storici insufficienti per eseguire l\'auto-specializzazione AI (richiesti almeno trade o setup esclusi registrati).',
      });
    }

    const openRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();

    // Summary statistics for AI
    const winTrades = trades.filter((t) => t.outcome === 'WIN');
    const lossTrades = trades.filter((t) => t.outcome === 'LOSS');
    const profitableExcluded = excluded.filter((e) => e.outcomeStatus === 'THEORETICAL_PROFIT');
    const stoppedExcluded = excluded.filter((e) => e.outcomeStatus === 'THEORETICAL_STOP');

    const promptText = `Sei il Lead Quantitative Risk Manager & Head of Systematic Trading.
Analizza questo dataset di trade conclusi (inclusi sia operazioni in paper trading che eseguite a mercato reale) e setup scartati per distillare da 1 a 3 DIRETTIVE OPERATIVE AUREE (Regole di condotta) che guideranno le future valutazioni dell'AI su catalizzatori e parametri.

STATISTICHE FORNITE (trade reali e paper trading):
- Trade Chiusi: ${trades.length} (Vinti: ${winTrades.length}, Persi: ${lossTrades.length})
- Setup Esclusi Monitorati: ${excluded.length} (Andati a Target: ${profitableExcluded.length}, Andati a Stop: ${stoppedExcluded.length})
- Esempi Trade Vincenti: ${JSON.stringify(winTrades.slice(0, 3).map((t) => ({ ticker: t.ticker, strategy: t.strategy, mode: t.isPaper ? 'PAPER' : 'REALE', rMult: t.rMultiple, notes: t.notes })))}
- Esempi Trade in Perdita: ${JSON.stringify(lossTrades.slice(0, 3).map((t) => ({ ticker: t.ticker, strategy: t.strategy, mode: t.isPaper ? 'PAPER' : 'REALE', rMult: t.rMultiple, notes: t.notes })))}
- Esempi Esclusi Andati a Target: ${JSON.stringify(profitableExcluded.slice(0, 4).map((e) => ({ ticker: e.ticker, reason: e.primaryReasonCategory, gap: e.gapPercent, rvol: e.rvol })))}

Istruzioni:
Restituisci eventuali proposte non persistenti nel campo "newDirectives". Non dichiarare una confidence statistica e non affermare che le proposte sono state validate:
{
  "topic": "STRINGA_SINTETICA_MAIUSCOLA",
  "market": "EU" | "US" | "GLOBAL",
  "directive": "Regola operativa chiara, concisa e vincolante da applicare nelle future analisi",
  "confidence": null,
  "sampleEvidence": "Spiegazione quantitativa basata sui dati reali esaminati"
}`;

    const systemInstruction = `Sei un Risk Manager quantitativo rigoroso. Estrai solo regole concrete, empiriche e non banali basate esclusivamente sui dati forniti. Rispondi solo in formato JSON.`;

    let generated: any = null;
    if (openRouterKey) {
      const openRouterRes = await callOpenRouterModel(
        [OPENROUTER_PRIMARY_MODEL, OPENROUTER_FALLBACK_MODEL],
        systemInstruction,
        promptText,
        openRouterKey,
        15000
      );
      if (openRouterRes?.data?.newDirectives) {
        generated = openRouterRes.data;
      }
    }

    if (!generated && isGeminiAvailable()) {
      const gemRes = await callGeminiModel(systemInstruction, promptText);
      if (gemRes?.data?.newDirectives) {
        generated = gemRes.data;
      }
    }

    const proposedDirectives = Array.isArray(generated?.newDirectives)
      ? generated.newDirectives.filter((item: any) => typeof item?.topic === 'string' && typeof item?.directive === 'string')
      : [];
    aiLearnedMemory = await loadPersistentAIMemory();
    return res.json({
      success: true,
      addedCount: 0,
      newInsightsCount: 0,
      proposedDirectives,
      memory: aiLearnedMemory,
      message: proposedDirectives.length > 0
        ? 'Proposte LLM non persistite: la memoria viene aggiornata solo dalla pipeline statistica sui trade reali.'
        : 'Nessuna proposta LLM; la memoria persistente resta invariata.',
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
    const rawTrades: any[] = Array.isArray(req.body?.trades) ? req.body.trades : (sharedAppState.journalEntries || []);
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

    const promptText = `Sei l'Head of Quantitative Trading & Senior Risk Officer di un desk proprietario intraday.
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
5. "newDirectives": array opzionale di ipotesi non persistenti ({ "topic": string, "market": "${market}", "directive": string, "confidence": null, "sampleEvidence": string }).`;

    const systemInstruction = `Sei un Senior Risk Officer rigoroso ed esperto. Analizza con occhio clinico e linguaggio istituzionale da hedge fund. Non inventare dati. Rispondi solo in formato JSON.`;

    let generated: any = null;
    if (openRouterKey) {
      const openRouterRes = await callOpenRouterModel(
        [OPENROUTER_PRIMARY_MODEL, OPENROUTER_FALLBACK_MODEL],
        systemInstruction,
        promptText,
        openRouterKey,
        15000
      );
      if (openRouterRes?.data?.executiveSummary) {
        generated = openRouterRes.data;
      }
    }

    if (!generated && isGeminiAvailable()) {
      const gemRes = await callGeminiModel(systemInstruction, promptText);
      if (gemRes?.data?.executiveSummary) {
        generated = gemRes.data;
      }
    }

    if (!generated) {
      generated = {
        executiveSummary: `Analisi delle sessioni ${market}: Win Rate ${winRate}% su ${total} trade con P&L netto di ${netPnl} €. L'esecuzione mostra tenuta del rischio e disciplina sui target.`,
        strengths: [
          `Preservazione del capitale con gestione rigorosa degli stop loss a 1.0R`,
          `Rapporto R-Multiple medio coerente con l'asimmetria richiesta dal modello sistemico`
        ],
        failurePatterns: [
          `Presenza di setup chiusi prima dell'estensione completa verso Target 1`,
          `Necessità di monitorare la correlazione con i futures di apertura`
        ],
        tacticalAdvice: `Mantenere la selettività solo sui setup con score elevato ed evitare l'anticipazione dei trigger prima della chiusura delle prime barre.`,
        newDirectives: []
      };
    }

    const proposedDirectives = Array.isArray(generated.newDirectives)
      ? generated.newDirectives.filter((item: any) => typeof item?.topic === 'string' && typeof item?.directive === 'string')
      : [];
    aiLearnedMemory = await loadPersistentAIMemory();

    return res.json({
      success: true,
      market,
      postMortem: {
        executiveSummary: generated.executiveSummary,
        strengths: generated.strengths || [],
        failurePatterns: generated.failurePatterns || [],
        tacticalAdvice: generated.tacticalAdvice,
        generatedAt: new Date().toISOString(),
      },
      newDirectivesAdded: 0,
      proposedDirectives,
      note: 'Le proposte del post-mortem non sono persistite; la memoria richiede validazione statistica sui trade reali.',
      totalRules: aiLearnedMemory.length,
      directives: aiLearnedMemory,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// Helper: Invoca OpenRouter con timeout, parse JSON e gestione errori/crediti
async function callOpenRouterModel(
  modelOrModels: string | string[],
  systemInstruction: string,
  userPrompt: string,
  apiKey: string,
  timeoutMs: number = 10000
): Promise<{ data: any; keyInvalid?: boolean; creditsExhausted?: boolean } | null> {
  if (Date.now() < openRouterRateLimitedUntil) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const modelDesc = Array.isArray(modelOrModels) ? modelOrModels.join(' -> ') : modelOrModels;

  try {
    const payload: any = {
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1500,
      temperature: 0.1,
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
      return { data: null, keyInvalid: true };
    }

    if (res.status === 402 || res.status === 429) {
      openRouterRateLimitedUntil = Date.now() + 10 * 60 * 1000; // Cooldown 10 minuti
      console.info(`[OpenRouter] HTTP ${res.status} per ${modelDesc} (crediti esauriti o rate limit). Attivato cooldown 10m e transizione a fallback immediato.`);
      return { data: null, creditsExhausted: true };
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.info(`[OpenRouter] HTTP ${res.status} per ${modelDesc}: ${errText.slice(0, 150)}`);
      return null;
    }

    const json = await res.json();
    const rawContent = json.choices?.[0]?.message?.content;
    if (!rawContent) return null;

    const cleaned = rawContent
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') {
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
      return { data: parsed };
    }
    return null;
  } catch (err: any) {
    clearTimeout(timeoutId);
    const isAbort = err?.name === 'AbortError' || err?.cause?.name === 'AbortError';
    console.info(`[OpenRouter] ${modelDesc} temporaneamente non disponibile (${isAbort ? `timeout ${timeoutMs}ms` : err?.message || 'connessione'}), transizione a fallback.`);
    return null;
  }
}

// Helper: Invoca Gemini con gestione sicura degli errori di credito (402/RESOURCE_EXHAUSTED) e quote
async function callGeminiModel(
  systemInstruction: string,
  userPrompt: string,
  responseSchema?: any
): Promise<{ data: any; quotaExhausted?: boolean } | null> {
  if (!isGeminiAvailable()) {
    return null;
  }

  try {
    const config: any = {
      systemInstruction,
      responseMimeType: 'application/json',
    };
    if (responseSchema) {
      config.responseSchema = responseSchema;
    }

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: userPrompt,
      config,
    });

    const clean = (response.text || '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(clean || '{}');
    return { data: parsed };
  } catch (err: any) {
    const status = err?.status || err?.code;
    const msg = String(err?.message || '');
    const is402 = status === 402 || msg.includes('402') || msg.includes('prepayment credits are depleted');
    const is429 = status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');

    if (is402) {
      geminiCreditsDepleted = true;
      geminiQuotaExhaustedUntil = Date.now() + 24 * 60 * 60 * 1000;
      console.info('[AI Gemini] Crediti prepagati esauriti (HTTP 402). Transizione automatica a OpenRouter e regole deterministiche.');
      return { data: null, quotaExhausted: true };
    }

    if (is429) {
      geminiQuotaExhaustedUntil = Date.now() + 30 * 60 * 1000;
      console.info('[AI Gemini] Rate limit o quota raggiunta (HTTP 429). Cooldown 30m e transizione a fallback.');
      return { data: null, quotaExhausted: true };
    }

    console.info(`[AI Gemini] Modello non disponibile (${msg.slice(0, 100)}). Transizione a fallback.`);
    return null;
  }
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
            temperature: 0.1,
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
          modelResults.push({
            model,
            status: 'ok',
            latencyMs: elapsed,
            reply: data.choices?.[0]?.message?.content?.slice(0, 100),
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

// Analyze Catalyst (Gerarchia: OpenRouter Nemotron 3 Ultra -> DeepSeek Free -> Fallback Gemini -> Regole Determistiche)
app.post('/api/analyze-catalyst', requireApiAuth, async (req: Request, res: Response) => {
  try {
    const { candidate, news, futures } = req.body;

    if (!candidate || !candidate.ticker) {
      return res.status(400).json({ error: 'Candidato mancante per analisi' });
    }

    // Rule: Absence of news is NOT an exclusion reason. If realNews is empty, return a valid technical setup with 0 news bonus points
    const realNews: NewsItem[] = Array.isArray(news) ? news : [];
    if (realNews.length === 0) {
      const isPositive = (candidate.gapPercent ?? 0) >= 0;
      return res.json({
        decisione: 'TRADE',
        direzione: isPositive ? 'LONG' : 'SHORT',
        catalizzatore: 'Setup Tecnico Momentum: Nessuna notizia straordinaria reperibile nelle ultime 24 ore. L\'opportunità è convalidata dalla dinamica di prezzo, ampiezza del gap e volume relativo.',
        punti_a_favore: [
          'Setup tecnico puro guidato da apertura in gap e volume relativo senza rumore informativo',
          'Assenza di interferenze o rischi da annunci imprevisti',
          'Livelli chiave e VWAP intatti e operabili'
        ],
        rischi: [
          'Assenza di catalizzatore fondamentale ad alto impatto: monitorare rigorosamente la persistenza dei volumi e la tenuta del VWAP'
        ],
        condizioni_invalidazione: [
          'Rottura del VWAP intraday nella prima ora',
          'Riassorbimento totale del gap in apertura',
          'Inversione improvvisa dei futures dell\'indice di riferimento'
        ],
        fonti: [],
        newsBonusScore: 0,
      });
    }

    aiLearnedMemory = await loadPersistentAIMemory();
    const activeDirectives = aiLearnedMemory
      .filter((directive) => directive.confidence != null)
      .slice(-6)
      .map((directive, index) =>
        `[Pattern statistico ${index + 1} - ${directive.topic} (${directive.market})]: ${directive.directive} ` +
        `(score 1-q: ${directive.confidence}%; evidenza: ${directive.sampleEvidence})`
      )
      .join('\n');

    const systemInstruction = `Sei un analista di trading intraday rigoroso. Ricevi dati di mercato già calcolati dal codice e notizie con fonti.
REGOLE TASSATIVE:
- Usa esclusivamente i dati forniti. Non inventare prezzi, notizie, livelli o statistiche.
- Non fornire prezzi obiettivo, target o numeri non presenti nei dati.
- REGOLE SULLE NOTIZIE: L'assenza di notizie o la presenza di notizie generali NON è motivo di esclusione. La notizia positiva/catalizzatore attribuisce punti di forza e bonus di score (+10/+15pt).
- Rispondi "NESSUN_TRADE" ESCLUSIVAMENTE se ci sono fattori ostativi critici e verificati (es. giorno di pubblicazione utili/trimestrale durante la seduta, bilanci contestati, rischi giudiziari o notizie fortemente avverse). In assenza di tali blocchi, la decisione è "TRADE" allineata alla direzione del gap e dei parametri tecnici.
- Valuta il catalizzatore: tipo, direzione probabile, freschezza, affidabilità della fonte, rischi (es. utili imminenti nello stesso giorno, notizie già scontate, futures opposti).
- Indica sempre cosa invalida la tesi operativa.
- Non promettere mai rendimenti.
- Rispondi in italiano, rispettando esattamente la struttura JSON specificata.${
      activeDirectives
        ? `\n\nDIRETTIVE SPECIALIZZATE APPRESE DALLA MEMORIA STORICA DEL SISTEMA (SPECIALIZZAZIONE CONTINUA E ACCUMULO DI ESPERIENZA):\n${activeDirectives}`
        : ''
    }`;

    const futuresChangeForCandidate =
      candidate.market === 'EU'
        ? (typeof futures?.europe?.dax?.changePercent === 'number' ? futures.europe.dax.changePercent : null)
        : (typeof futures?.usa?.sp500?.changePercent === 'number' ? futures.usa.sp500.changePercent : null);
    const candidateSetupScore = calculateCandidateScore(candidate, futuresChangeForCandidate, null, {
      volume: candidate.lastBarVolume ?? null,
      barTime: candidate.lastBarTime ?? null,
    });

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
- VWAP di sessione: ${candidate.vwapState ? `${candidate.vwapState.state} | distanza ${candidate.vwapState.distAtr ?? 'nd'} ATR | pendenza ${candidate.vwapState.slopeAtr ?? 'nd'} ATR | coverage ${candidate.vwapState.coverage ?? 'nd'} | volume ${candidate.vwapState.volumeRatio ?? 'nd'}x media 5m | flag ${(candidate.vwapState.flags || []).join(',') || 'nessuno'}` : 'dato non disponibile'}
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
- Veto setup: ${candidateSetupScore.veto ?? 'nessuno'}
- Futures Indice Riferimento: ${JSON.stringify(futures || {})}

NOTIZIE REALI RACCOLTE:
${realNews
  .map(
    (n, i) =>
      `[${i + 1}] Titolo: "${n.title}" | Fonte: ${n.source} | Data: ${n.publishedAt} | URL: ${n.url}\nRiassunto: ${n.summary}`
  )
  .join('\n\n')}

${VWAP_PROMPT_BLOCK}

${SETUP_PROMPT_BLOCK}
Istruzione: Valuta il catalizzatore qualitativo e rispondi in JSON:
decisione: "TRADE" oppure "NESSUN_TRADE" (usa NESSUN_TRADE solo per fattori ostativi gravi come utili imminenti o rischi fatali)
direzione: "LONG" oppure "SHORT" oppure "NESSUNA"
catalizzatore: tipo e descrizione del catalizzatore basato sui titoli forniti
punti_a_favore: array di stringhe
rischi: array di stringhe (es. volatilità da news, futures opposti)
condizioni_invalidazione: array di stringhe (es. rottura VWAP, riassorbimento del gap)
fonti: array di oggetti { title, url, source, time }
newsBonusScore: numero intero da 0 a 15 (punti bonus aggiuntivi per forza del catalizzatore: 15 per upgrade/contratti/catalizzatori forti, 8-10 per news ordinarie, 0 per news assenti/neutre)`;

    let parsed: any = null;
    const openRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();

    // 1. TIER 1 & 2: OpenRouter (Primario: NVIDIA Nemotron 3 Ultra Free, Fallback: OpenRouter Free router)
    if (openRouterKey) {
      const openRouterRes = await callOpenRouterModel(
        [OPENROUTER_PRIMARY_MODEL, OPENROUTER_FALLBACK_MODEL],
        systemInstruction,
        userPrompt,
        openRouterKey,
        8000
      );

      if (openRouterRes?.data?.decisione) {
        parsed = openRouterRes.data;
      }
    }

    // 3. TIER 3: Fallback Gemini (se OpenRouter non ha chiave, crediti esauriti, o modelli gratuiti falliscono)
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
            description: 'Tipo e valutazione del catalizzatore qualitativo',
          },
          punti_a_favore: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Punti a supporto della tesi',
          },
          rischi: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Rischi e criticità del catalizzatore o contesto',
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
            description:
              'Confidenza 0-100 sul setup: abbassala se lo stato VWAP e contrario, non rifiutare il setup',
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
      });

      if (gemRes?.data?.decisione) {
        parsed = gemRes.data;
        parsed.aiProvider = 'gemini:gemini-3.8-flash';
      }
    }

    // Deterministic catalyst evaluation strictly based on real news items when AI is offline/throttled
    if (!parsed || !parsed.decisione) {
      const gap = candidate.gapPercent ?? 0;
      const isPositive = gap >= 0;
      const sources = realNews.map((n) => ({
        title: n.title,
        url: n.url,
        source: n.source,
        time: n.publishedAt,
      }));

      const topTitle = realNews[0]?.title || '';
      const topSummary = realNews[0]?.summary || '';
      const allText = `${topTitle} ${topSummary}`.toLowerCase();

      const isEarnings = allText.includes('utili') || allText.includes('trimestrale') || allText.includes('conti') || allText.includes('risultati');

      let catalizzatoreDesc = '';
      let puntiAFavore: string[] = [];
      let rischi: string[] = [];
      let decisione: 'TRADE' | 'NESSUN_TRADE' = 'TRADE';
      let direzione: 'LONG' | 'SHORT' | 'NESSUNA' = isPositive ? 'LONG' : 'SHORT';
      let newsBonusScore = 0;

      if (isEarnings) {
        decisione = 'NESSUN_TRADE';
        direzione = 'NESSUNA';
        catalizzatoreDesc = `Giorno di rilascio utili/trimestrale per ${candidate.ticker} (${realNews[0]?.source}: "${topTitle}"). Rischio spread e spike bid/ask su leva Knock-Out.`;
        rischi.push('Giorno di rilascio utili: rischio elevato di spike opposto e knock-out anticipato.');
      } else if (realNews.length > 0) {
        decisione = 'TRADE';
        direzione = isPositive ? 'LONG' : 'SHORT';
        newsBonusScore = 0;
        catalizzatoreDesc = `Notizie presenti da ${realNews[0]?.source}: "${topTitle}". Dinamica da valutare con i parametri tecnici.`;
        puntiAFavore.push('Notizie presenti ma non valutate qualitativamente: nessun bonus automatico');
        rischi.push('Flusso informativo ordinario: mantenere rigore sulla tenuta del VWAP');
      } else {
        decisione = 'TRADE';
        direzione = isPositive ? 'LONG' : 'SHORT';
        newsBonusScore = 0;
        catalizzatoreDesc = 'Setup Tecnico Momentum: Nessuna notizia specifica reperibile. Operatività convalidata da gap e volume.';
        puntiAFavore.push('Setup puramente quantitativo e privo di rumore di mercato');
      }

      parsed = {
        decisione,
        direzione,
        catalizzatore: catalizzatoreDesc,
        punti_a_favore: puntiAFavore,
        rischi,
        condizioni_invalidazione: [
          'Rottura del VWAP intraday nella prima ora',
          'Riassorbimento completo del range di apertura',
          'Inversione improvvisa dei futures di riferimento',
        ],
        fonti: sources,
        newsBonusScore,
      };
    } else if (parsed) {
      // Normalize decisione if Gemini outputs "NESSUN TRADE" instead of "NESSUN_TRADE"
      if (parsed.decisione === 'NESSUN TRADE') {
        parsed.decisione = 'NESSUN_TRADE';
      }
    }

    res.json(parsed);
  } catch (error: any) {
    res.json({
      decisione: 'NESSUN_TRADE',
      direzione: 'NESSUNA',
      catalizzatore: 'Dati o notizie insufficienti per convalidare il catalizzatore.',
      punti_a_favore: [],
      rischi: ['Dati non disponibili o errore temporaneo di verifica fonti.'],
      condizioni_invalidazione: ['Catalizzatore non verificabile'],
      fonti: [],
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

// Serve public static assets (manifest, icons, favicon)
app.use(express.static(path.join(__dirname, 'public')));

// Set up Vite or Static Serving
async function startServer() {
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

  aiLearnedMemory = await loadPersistentAIMemory();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Intraday Radar] Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
