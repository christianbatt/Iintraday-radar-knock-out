import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  signOut,
  onAuthStateChanged,
  User,
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
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  OptimizationProposal,
  SystemParameters,
  TradeJournalEntry,
  UnderlyingItem,
} from '../types/radar';

// Initialize Firebase App
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

// Initialize Auth
export const auth = getAuth(app);

// Initialize Firestore with robust long-polling auto-detection for cloud iframes & web sandboxes
const databaseId =
  firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== '(default)'
    ? firebaseConfig.firestoreDatabaseId
    : '(default)';

let firestoreInstance;
try {
  firestoreInstance = initializeFirestore(
    app,
    {
      experimentalAutoDetectLongPolling: true,
    },
    databaseId
  );
} catch {
  firestoreInstance = getFirestore(app, databaseId);
}

export const db = firestoreInstance;

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
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

/**
 * Sign in anonymously if user does not want to log in immediately
 */
export async function signInGuest(): Promise<User> {
  const result = await signInAnonymously(auth);
  return result.user;
}

/**
 * Sign out
 */
export async function logoutUser(): Promise<void> {
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
  if (trades.length === 0) return;
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
    (err) => console.error('[Firebase] Settings listener error:', err)
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
    (err) => console.error('[Firebase] Trades listener error:', err)
  );

  return () => {
    unsubSettings();
    unsubTrades();
  };
}
