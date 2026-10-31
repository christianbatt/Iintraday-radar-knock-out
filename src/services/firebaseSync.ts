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
  Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  OptimizationProposal,
  SystemParameters,
  TradeJournalEntry,
  UnderlyingItem,
} from '../types/radar';

// Safe Firebase Config resolution (priority: VITE_ environment variables > config file)
const rawConfig = (firebaseConfig || {}) as Record<string, any>;
const apiKey =
  import.meta.env.VITE_FIREBASE_API_KEY ||
  (rawConfig.apiKey && rawConfig.apiKey !== 'YOUR_FIREBASE_API_KEY'
    ? rawConfig.apiKey
    : '');
const projectId =
  import.meta.env.VITE_FIREBASE_PROJECT_ID ||
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
    await setDoc(
      ref,
      {
        userId,
        accountCapital: settings.accountCapital,
        isPaperMode: settings.isPaperMode,
        parameters: settings.parameters,
        pendingProposal: settings.pendingProposal,
        underlyings: settings.underlyings || null,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
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
    await setDoc(
      ref,
      {
        ...trade,
        userId,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
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
    trades.forEach((trade) => {
      const ref = doc(db, 'users', userId, 'trades', trade.id);
      batch.set(
        ref,
        {
          ...trade,
          userId,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    });
    await batch.commit();
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
