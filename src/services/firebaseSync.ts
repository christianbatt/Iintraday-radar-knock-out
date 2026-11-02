import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  signOut,
  User,
  Auth,
} from 'firebase/auth';
import {
  initializeFirestore,
  getFirestore,
  doc,
  collection,
  onSnapshot,
  setDoc,
  deleteDoc,
  writeBatch,
  getDocs,
  getDoc,
  runTransaction,
  Firestore,
} from 'firebase/firestore';
import {
  AILearnedInsight,
  OptimizationProposal,
  SystemParameters,
  TradeJournalEntry,
  UnderlyingItem,
} from '../types/radar';

// Safe Firebase Config resolution (priority: VITE_ environment variables > optional local config)
const firebaseConfigModules = typeof import.meta.glob === 'function'
  ? import.meta.glob('../../firebase-applet-config.json', {
      eager: true,
      import: 'default',
    })
  : {};
const firebaseConfig = Object.values(firebaseConfigModules)[0] as Record<string, any> | undefined;
const rawConfig = firebaseConfig || {};
const metaEnv = typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined;
const apiKey =
  metaEnv?.VITE_FIREBASE_API_KEY ||
  process.env.VITE_FIREBASE_API_KEY ||
  (rawConfig.apiKey && rawConfig.apiKey !== 'YOUR_FIREBASE_API_KEY'
    ? rawConfig.apiKey
    : '');
const projectId =
  metaEnv?.VITE_FIREBASE_PROJECT_ID ||
  process.env.VITE_FIREBASE_PROJECT_ID ||
  (rawConfig.projectId && rawConfig.projectId !== 'YOUR_FIREBASE_PROJECT_ID'
    ? rawConfig.projectId
    : '');

export const isFirebaseConfigured = Boolean(apiKey && projectId);

let appInstance: any = null;
let authInstance: Auth | null = null;
let firestoreInstance: Firestore | null = null;

if (isFirebaseConfigured) {
  try {
    const resolvedFirebaseConfig: Record<string, any> = {
      ...rawConfig,
      apiKey,
      projectId,
    };
    appInstance = getApps().length > 0 ? getApp() : initializeApp(resolvedFirebaseConfig as any);
    authInstance = getAuth(appInstance);

    const databaseId =
      resolvedFirebaseConfig.firestoreDatabaseId && resolvedFirebaseConfig.firestoreDatabaseId !== '(default)'
        ? resolvedFirebaseConfig.firestoreDatabaseId
        : '(default)';

    try {
      firestoreInstance = initializeFirestore(
        appInstance,
        {
          experimentalAutoDetectLongPolling: true,
        },
        databaseId
      );
    } catch {
      firestoreInstance = getFirestore(appInstance, databaseId);
    }
  } catch (err) {
    console.warn('[Firebase] Inizializzazione saltata o non riuscita:', err);
    authInstance = null;
    firestoreInstance = null;
  }
}

export const auth: Auth | null = authInstance;
export const db: Firestore | null = firestoreInstance;

export function createAIMemoryPayload(memory: AILearnedInsight[], version: number) {
  return {
    memory,
    updatedAt: new Date().toISOString(),
    version,
    rulesCount: memory.length,
    validatedCount: memory.filter((rule) => rule.confidence !== null).length,
  };
}

/** Persist memory for an authenticated user's devices and retain version snapshots. */
export async function syncAIMemoryToFirebase(uid: string, memory: AILearnedInsight[]): Promise<void> {
  if (!db || !uid) return;

  try {
    const currentRef = doc(db, 'users', uid, 'ai_specialization_memory', 'current');
    await runTransaction(db, async (transaction) => {
      const currentSnapshot = await transaction.get(currentRef);
      const currentVersion = currentSnapshot.data()?.version;
      const version = typeof currentVersion === 'number' && Number.isFinite(currentVersion)
        ? currentVersion + 1
        : 1;
      const payload = createAIMemoryPayload(memory, version);
      const versionRef = doc(db, 'users', uid, 'ai_specialization_memory', 'current', 'versions', String(version));
      transaction.set(currentRef, payload, { merge: true });
      transaction.set(versionRef, payload);
    });
  } catch (error) {
    console.error('[Firebase Sync] Errore scrittura AI memory:', error);
  }
}

/** Pull a user's memory; return null to let callers fall back to local/server state. */
export async function pullAIMemoryFromFirebase(uid: string): Promise<AILearnedInsight[] | null> {
  if (!db || !uid) return null;

  try {
    const reference = doc(db, 'users', uid, 'ai_specialization_memory', 'current');
    const snapshot = await getDoc(reference);
    if (!snapshot.exists()) return null;
    const memory: unknown = snapshot.data()?.memory;
    if (!Array.isArray(memory)) return null;

    const validMemory = memory.filter((rule): rule is AILearnedInsight =>
      rule != null &&
      typeof rule === 'object' &&
      typeof rule.id === 'string' &&
      typeof rule.learnedAt === 'string' &&
      (rule.market === 'EU' || rule.market === 'US' || rule.market === 'GLOBAL') &&
      typeof rule.topic === 'string' &&
      typeof rule.directive === 'string' &&
      (rule.confidence === null || typeof rule.confidence === 'number') &&
      typeof rule.sampleEvidence === 'string'
    );
    return validMemory.length === memory.length ? validMemory : null;
  } catch (error) {
    console.error('[Firebase Sync] Errore lettura AI memory:', error);
    return null;
  }
}

const googleProvider = new GoogleAuthProvider();

export interface CloudSystemSettings {
  parameters: SystemParameters;
  pendingProposal: OptimizationProposal | null;
  accountCapital: number;
  isPaperMode: boolean;
  underlyings?: UnderlyingItem[];
  updatedAt: string;
}

/**
 * Sign in using Google popup (for cross-device synchronization on PC, Mobile, Tablet)
 */
export async function signInWithGoogle(): Promise<User> {
  if (!auth) {
    throw new Error('Firebase non è ancora configurato con chiavi attive. Il sistema usa la sincronizzazione universale integrata.');
  }
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

/**
 * Sign in anonymously if user does not want to log in immediately
 */
export async function signInGuest(): Promise<User> {
  if (!auth) {
    throw new Error('Firebase non è configurato.');
  }
  const result = await signInAnonymously(auth);
  return result.user;
}

/**
 * Sign out
 */
export async function logoutUser(): Promise<void> {
  if (!auth) return;
  await signOut(auth);
}

/**
 * Recursively strips undefined keys from plain JavaScript objects.
 * Preserves non-plain objects (such as Firestore Timestamps, FieldValue, Dates, etc.)
 * and handles nested arrays.
 */
export function stripUndefined<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    const isPlainObject = proto === Object.prototype || proto === null;
    if (!isPlainObject) {
      return value;
    }
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      if (val !== undefined) {
        result[key] = stripUndefined(val);
      }
    }
    return result as T;
  }
  return value;
}

/**
 * Save or update system parameters & proposals in Firestore
 */
export async function syncSystemSettingsToCloud(
  userId: string,
  settings: {
    parameters: SystemParameters;
    pendingProposal: OptimizationProposal | null;
    accountCapital: number;
    isPaperMode: boolean;
    underlyings?: UnderlyingItem[];
  }
): Promise<void> {
  if (!db) return;
  try {
    const ref = doc(db, 'users', userId, 'settings', 'system');
    const rawPayload = {
      userId,
      accountCapital: settings.accountCapital,
      isPaperMode: settings.isPaperMode,
      parameters: settings.parameters,
      pendingProposal: settings.pendingProposal,
      underlyings: settings.underlyings || null,
      updatedAt: new Date().toISOString(),
    };
    await setDoc(ref, stripUndefined(rawPayload), { merge: true });
  } catch (err) {
    console.error('[Firebase] Errore salvataggio impostazioni nel Cloud:', err);
  }
}

/**
 * Save or update a single trade in Firestore
 */
export async function syncTradeToCloud(
  userId: string,
  trade: TradeJournalEntry
): Promise<void> {
  if (!db) return;
  try {
    const ref = doc(db, 'users', userId, 'trades', trade.id);
    const rawPayload = {
      ...trade,
      closedAt: trade.closedAt ?? null,
      userId,
      updatedAt: new Date().toISOString(),
    };
    await setDoc(ref, stripUndefined(rawPayload), { merge: true });
  } catch (err) {
    console.error(`[Firebase] Errore salvataggio trade ${trade.id} nel Cloud:`, err);
  }
}

/**
 * Delete a trade from Firestore
 */
export async function deleteTradeFromCloud(
  userId: string,
  tradeId: string
): Promise<void> {
  if (!db) return;
  try {
    const ref = doc(db, 'users', userId, 'trades', tradeId);
    await deleteDoc(ref);
  } catch (err) {
    console.error(`[Firebase] Errore cancellazione trade ${tradeId} nel Cloud:`, err);
  }
}

/**
 * Clear all user trades from Firestore
 */
export async function clearAllTradesFromCloud(userId: string): Promise<void> {
  if (!db) return;
  try {
    const tradesRef = collection(db, 'users', userId, 'trades');
    const snapshot = await getDocs(tradesRef);
    const batch = writeBatch(db);
    snapshot.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  } catch (err) {
    console.error('[Firebase] Errore svuotamento trade nel Cloud:', err);
  }
}

/**
 * Batch upload local trades to Firestore (used when first linking an account)
 */
export async function batchUploadTradesToCloud(
  userId: string,
  trades: TradeJournalEntry[]
): Promise<void> {
  if (!db || trades.length === 0) return;
  try {
    const batch = writeBatch(db);
    let validCount = 0;
    trades.forEach((trade) => {
      if (!trade || typeof trade.id !== 'string' || trade.id.trim().length === 0) {
        console.warn('[Firebase] Trade malformato scartato dal batch upload:', trade?.id || 'ID_MANCANTE', trade);
        return;
      }
      const ref = doc(db, 'users', userId, 'trades', trade.id);
      const rawPayload = {
        ...trade,
        closedAt: trade.closedAt ?? null,
        userId,
        updatedAt: new Date().toISOString(),
      };
      batch.set(ref, stripUndefined(rawPayload), { merge: true });
      validCount++;
    });
    if (validCount > 0) {
      await batch.commit();
    }
  } catch (err) {
    console.error('[Firebase] Errore upload batch trade nel Cloud:', err);
  }
}

/**
 * Subscribe to real-time updates for user settings and trades across all devices
 */
export function subscribeToUserCloudData(
  userId: string,
  onSettings: (data: CloudSystemSettings) => void,
  onTrades: (trades: TradeJournalEntry[]) => void
): () => void {
  if (!db) {
    return () => {};
  }

  // 1. Settings listener
  const settingsRef = doc(db, 'users', userId, 'settings', 'system');
  const unsubSettings = onSnapshot(
    settingsRef,
    (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        onSettings({
          parameters: d.parameters,
          pendingProposal: d.pendingProposal,
          accountCapital: d.accountCapital ?? 10000,
          isPaperMode: d.isPaperMode ?? true,
          underlyings: d.underlyings || undefined,
          updatedAt: d.updatedAt || new Date().toISOString(),
        });
      }
    },
    (err) => {
      if (err.code === 'permission-denied') {
        console.info('[Firebase] Accesso impostazioni utente completato/distaccato.');
      } else {
        console.warn('[Firebase] Settings listener notice:', err.message || err);
      }
    }
  );

  // 2. Trades collection listener
  const tradesRef = collection(db, 'users', userId, 'trades');
  const unsubTrades = onSnapshot(
    tradesRef,
    (snap) => {
      const list: TradeJournalEntry[] = [];
      snap.forEach((docSnap) => {
        const t = docSnap.data() as TradeJournalEntry;
        list.push({
          id: t.id || docSnap.id,
          timestamp: t.timestamp || new Date().toISOString(),
          date: t.date || new Date().toLocaleDateString('it-IT'),
          session: t.session,
          ticker: t.ticker,
          direction: t.direction,
          strategy: t.strategy,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          stopLoss: t.stopLoss,
          target1: t.target1,
          pnlEur: t.pnlEur ?? 0,
          rMultiple: t.rMultiple ?? 0,
          outcome: t.outcome,
          status: t.status,
          closedAt: t.closedAt,
          notes: t.notes,
          isPaper: t.isPaper,
        });
      });
      // Sort chronologically descending
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      onTrades(list);
    },
    (err) => {
      if (err.code === 'permission-denied') {
        console.info('[Firebase] Accesso lista trade completato o in attesa di autorizzazione per utente:', userId);
      } else {
        console.warn('[Firebase] Trades listener notice:', err.message || err);
      }
    }
  );

  return () => {
    unsubSettings();
    unsubTrades();
  };
}
