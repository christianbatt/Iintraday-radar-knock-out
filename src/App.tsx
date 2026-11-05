import React, { useState, useEffect, useCallback } from 'react';
import {
  UnderlyingItem,
  RawQuoteData,
  ScoredCandidate,
  ExecutionSetup,
  SessionInfo,
  NewsItem,
  GeminiCatalystAnalysis,
  TradeJournalEntry,
  SystemParameters,
  OptimizationProposal,
  DualOptimizationProposals,
  FilteringAuditReport,
  ExcludedSetupRecord,
  ExcludedSetupsAutoAnalysis,
  MarketFreezeState,
  EntryMode,
  MacroCalendarState,
} from './types/radar';
import { TRADING_PARAMS } from './config/tradingParams';
import { getMarketTime } from './utils/timezone';
import { loadParameters, sanitizeScoreParameters, shouldApplyPolledParameters, shouldApplyCloudParameters, shouldPushLocalParameters } from './utils/paramSync';
import { DEFAULT_TRADE_REPUBLIC_UNDERLYINGS } from './data/defaultUnderlyings';
import {
  getDualTopCandidates,
  buildExecutionSetup,
  DEFAULT_SYSTEM_PARAMETERS,
  evaluateSystemOptimization,
  evaluateDualSystemOptimization,
  generateFilteringAuditReport,
  buildTheoreticalSetupForExcluded,
  updateExcludedSetupsWithLiveQuotes,
  runExcludedSetupsAutoAnalysis,
  isCandidateCompliantWithParameters,
  applyOptimizationProposal,
  createJournalEntryFromSetup,
  checkQuoteStaleness,
  evaluateOpenPositionLifecycle,
} from './utils/calculator';
import {
  fetchSessionInfo,
  fetchBenchmarkFutures,
  fetchMarketData,
  fetchTickerNews,
  analyzeCatalystWithGemini,
  clearServerCache,
  fetchSharedAppState,
  pushSharedAppState,
  fetchMacroCalendar,
} from './services/api';
import {
  auth,
  signInWithGoogle,
  logoutUser,
  syncSystemSettingsToCloud,
  syncTradeToCloud,
  deleteTradeFromCloud,
  clearAllTradesFromCloud,
  batchUploadTradesToCloud,
  subscribeToUserCloudData,
} from './services/firebaseSync';
import { mergeTradesWithTombstones } from './utils/tradeMerge';
import { User, onAuthStateChanged } from 'firebase/auth';

import { RiskBanner } from './components/RiskBanner';
import { Header } from './components/Header';
import { ScreeningControls } from './components/ScreeningControls';
import { MacroCalendarBanner } from './components/MacroCalendarBanner';
import { DailyCircuitBreakerBanner } from './components/DailyCircuitBreakerBanner';
import { SystemOptimizationBanner } from './components/SystemOptimizationBanner';
import { DualExecutionHero } from './components/DualExecutionHero';
import { TopCandidatesTable } from './components/TopCandidatesTable';
import { BenchmarkCorrelationHeatmap } from './components/BenchmarkCorrelationHeatmap';
import { IntradaySeasonalityAnalysis } from './components/IntradaySeasonalityAnalysis';
import { TradeJournal } from './components/TradeJournal';
import { CsvManagerModal } from './components/CsvManagerModal';
import { CatalystModal } from './components/CatalystModal';
import { CreatorContactModal } from './components/CreatorContactModal';
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt';
import { SystemOptimizerModal } from './components/SystemOptimizerModal';
import { FilteringAuditBanner } from './components/FilteringAuditBanner';
import { FilteringAuditModal } from './components/FilteringAuditModal';
import { ExcludedSetupsAnalyzerModal } from './components/ExcludedSetupsAnalyzerModal';

function migrateUnderlyings(items: UnderlyingItem[]): UnderlyingItem[] {
  const seen = new Set<string>();
  const res: UnderlyingItem[] = [];
  for (const item of items) {
    let t = item.ticker;
    let n = item.nome;
    let m = item.mercato;
    let v = item.valuta;
    if (t === 'LEO.MI' || t === 'LEO' || t === 'LDO') {
      t = 'LDO.MI';
      n = 'Leonardo S.p.A.';
      m = 'EU';
      v = 'EUR';
    }
    if (t === 'SPACEX') {
      t = 'SPCX';
      n = 'SpaceX (Space Exploration Tech)';
      m = 'US';
      v = 'USD';
    }
    if (!seen.has(t)) {
      seen.add(t);
      res.push({ ticker: t, nome: n, mercato: m, valuta: v });
    }
  }
  return res;
}

export default function App() {
  // 1. Underlyings State (strictly Trade Republic KO list)
  const [underlyings, setUnderlyings] = useState<UnderlyingItem[]>(() => {
    try {
      const saved = localStorage.getItem('intraday_radar_underlyings');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const migrated = migrateUnderlyings(parsed);
          const existingTickers = new Set(migrated.map((p: UnderlyingItem) => p.ticker));
          const missingDefaults = DEFAULT_TRADE_REPUBLIC_UNDERLYINGS.filter(
            (d) => !existingTickers.has(d.ticker)
          );
          if (missingDefaults.length > 0) {
            return [...migrated, ...missingDefaults];
          }
          return migrated;
        }
      }
    } catch {
      // fallback
    }
    return DEFAULT_TRADE_REPUBLIC_UNDERLYINGS;
  });

  // Save underlyings to localStorage
  useEffect(() => {
    localStorage.setItem('intraday_radar_underlyings', JSON.stringify(underlyings));
  }, [underlyings]);

  // 2. Session & Clock State
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [macroCalendar, setMacroCalendar] = useState<MacroCalendarState | null>(null);
  const [currentSession, setCurrentSession] = useState<'EU' | 'US' | 'GLOBAL'>('GLOBAL');
  const [futures, setFutures] = useState<any>(null);
  const [isAutoRefresh, setIsAutoRefresh] = useState<boolean>(true);
  const [autoRefreshCountdown, setAutoRefreshCountdown] = useState<number>(20);

  // 3. Market Quotes & Dual-Market Screening State
  const [quotes, setQuotes] = useState<RawQuoteData[]>([]);
  const [topCandidates, setTopCandidates] = useState<ScoredCandidate[]>([]);
  const [topCandidateEU, setTopCandidateEU] = useState<ScoredCandidate | null>(null);
  const [topCandidateUS, setTopCandidateUS] = useState<ScoredCandidate | null>(null);
  const [setupEU, setSetupEU] = useState<ExecutionSetup | null>(null);
  const [setupUS, setSetupUS] = useState<ExecutionSetup | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<ScoredCandidate | null>(null);

  // 3.5. Selection Freeze / Snapshot State (09:15 CET for Europe & 15:45 CET for USA)
  const [freezeStateEU, setFreezeStateEU] = useState<MarketFreezeState>(() => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const saved = localStorage.getItem(`intraday_radar_freeze_EU_${today}`);
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      isFrozen: false,
      frozenTicker: null,
      frozenAt: null,
      frozenTimeFormatted: null,
      isAutoFrozen: false,
      unlockedByUser: false,
    };
  });

  const [freezeStateUS, setFreezeStateUS] = useState<MarketFreezeState>(() => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const saved = localStorage.getItem(`intraday_radar_freeze_US_${today}`);
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      isFrozen: false,
      frozenTicker: null,
      frozenAt: null,
      frozenTimeFormatted: null,
      isAutoFrozen: false,
      unlockedByUser: false,
    };
  });

  const isRemoteSyncingRef = React.useRef(false);
  const sharedStateVersionRef = React.useRef(0);
  const hasInitialSyncCompletedRef = React.useRef(false);

  const freezeStateEURef = React.useRef(freezeStateEU);
  const freezeStateUSRef = React.useRef(freezeStateUS);
  useEffect(() => {
    freezeStateEURef.current = freezeStateEU;
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem(`intraday_radar_freeze_EU_${today}`, JSON.stringify(freezeStateEU));
    if (!isRemoteSyncingRef.current && hasInitialSyncCompletedRef.current) {
      pushSharedAppState({ freezeStateEU });
    }
  }, [freezeStateEU]);

  useEffect(() => {
    freezeStateUSRef.current = freezeStateUS;
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem(`intraday_radar_freeze_US_${today}`, JSON.stringify(freezeStateUS));
    if (!isRemoteSyncingRef.current && hasInitialSyncCompletedRef.current) {
      pushSharedAppState({ freezeStateUS });
    }
  }, [freezeStateUS]);

  const getActiveEntryMode = useCallback((market: 'EU' | 'US'): EntryMode => {
    const freeze = market === 'EU' ? freezeStateEURef.current : freezeStateUSRef.current;
    return freeze.isAutoFrozen
      ? 'SNAPSHOT_0915'
      : freeze.unlockedByUser
      ? 'UNFROZEN_LATE'
      : freeze.isFrozen
      ? 'MANUAL_FREEZE'
      : 'UNFROZEN_LATE';
  }, []);

  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [cachedAt, setCachedAt] = useState<string | undefined>(undefined);
  const [scanError, setScanError] = useState<string | null>(null);
  const [rsiFilterActive, setRsiFilterActive] = useState<boolean>(false);

  // 4. News & Catalyst State
  const [newsCache, setNewsCache] = useState<Record<string, NewsItem[]>>({});
  const [catalystCache, setCatalystCache] = useState<Record<string, GeminiCatalystAnalysis>>({});
  const [activeCatalystCandidate, setActiveCatalystCandidate] = useState<ScoredCandidate | null>(null);
  const [isCatalystModalOpen, setIsCatalystModalOpen] = useState<boolean>(false);
  const [isLoadingCatalyst, setIsLoadingCatalyst] = useState<boolean>(false);
  const [loadingNewsTicker, setLoadingNewsTicker] = useState<string | null>(null);

  // 4.5. Visual Filtering Audit State
  const [auditReport, setAuditReport] = useState<FilteringAuditReport | null>(null);
  const [isAuditModalOpen, setIsAuditModalOpen] = useState<boolean>(false);
  const [showAuditBanner, setShowAuditBanner] = useState<boolean>(false);

  // 4.6. Excluded Setups Counterfactual & Auto-Analysis State
  const [excludedRecords, setExcludedRecords] = useState<ExcludedSetupRecord[]>(() => {
    try {
      const saved = localStorage.getItem('intraday_radar_excluded_setups_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // fallback
    }
    return [];
  });
  const [isExcludedAnalyzerOpen, setIsExcludedAnalyzerOpen] = useState<boolean>(false);

  useEffect(() => {
    localStorage.setItem('intraday_radar_excluded_setups_v1', JSON.stringify(excludedRecords));
  }, [excludedRecords]);

  // 5. Account & Risk Management
  const [accountCapital, setAccountCapital] = useState<number>(() => {
    const saved = localStorage.getItem('intraday_radar_capital');
    return saved ? parseFloat(saved) : 10000;
  });

  const [isPaperMode, setIsPaperMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('intraday_radar_paper_mode');
    return saved !== null ? saved === 'true' : true;
  });

  const [journalEntries, setJournalEntries] = useState<TradeJournalEntry[]>(() => {
    try {
      const saved = localStorage.getItem('intraday_radar_journal');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          // Strictly purge any legacy mock sample trades
          return parsed.filter((e: TradeJournalEntry) => !e.id?.startsWith('sample-'));
        }
      }
    } catch {
      // fallback
    }
    return [];
  });

  // PWA Install State
  const [installPrompt, setInstallPrompt] = useState<{
    ready: boolean;
    trigger: () => void;
  }>({ ready: false, trigger: () => {} });

  // Modal Controls
  const [isCsvModalOpen, setIsCsvModalOpen] = useState<boolean>(false);
  const [isContactModalOpen, setIsContactModalOpen] = useState<boolean>(false);

  // Sync capital & paper mode
  useEffect(() => {
    localStorage.setItem('intraday_radar_capital', accountCapital.toString());
  }, [accountCapital]);

  useEffect(() => {
    localStorage.setItem('intraday_radar_paper_mode', isPaperMode.toString());
  }, [isPaperMode]);

  useEffect(() => {
    localStorage.setItem('intraday_radar_journal', JSON.stringify(journalEntries));
  }, [journalEntries]);

  // 6. System Parameters & Adaptive Self-Optimization (Every 20 Setups)
  const [parameters, setParameters] = useState<SystemParameters>(() =>
    loadParameters(localStorage.getItem('intraday_radar_parameters'), DEFAULT_SYSTEM_PARAMETERS)
  );

  // 6a. Excluded Setups Auto-Analysis & Optimization Calculation
  const excludedAutoAnalysis = React.useMemo(() => {
    return runExcludedSetupsAutoAnalysis(excludedRecords, parameters, accountCapital);
  }, [excludedRecords, parameters, accountCapital]);

  const [pendingProposal, setPendingProposal] = useState<OptimizationProposal | null>(() => {
    try {
      const saved = localStorage.getItem('intraday_radar_pending_proposal');
      if (saved) return JSON.parse(saved);
    } catch {
      // fallback
    }
    return null;
  });

  const [dualProposals, setDualProposals] = useState<DualOptimizationProposals | null>(() => {
    return evaluateDualSystemOptimization(journalEntries, parameters, 15);
  });

  const [isOptimizerModalOpen, setIsOptimizerModalOpen] = useState<boolean>(false);
  const [optimizationNotification, setOptimizationNotification] = useState<string | null>(null);

  // 6e. Avviso latenza feed europeo
  useEffect(() => {
    const staleEUCount = quotes.filter(
      (quote) => quote.market === 'EU' && checkQuoteStaleness(quote).isStale
    ).length;
    if (staleEUCount === 0) return;

    setOptimizationNotification(
      `Feed Europa in ritardo: ${staleEUCount} titolo/i con dati superiori a 5 min. Verificare connessione dati.`
    );
    const timeoutId = window.setTimeout(() => setOptimizationNotification(null), 8000);
    return () => window.clearTimeout(timeoutId);
  }, [quotes]);

  // 6b. Firebase Cloud Sync & Cross-Device Authentication State
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [cloudSyncStatus, setCloudSyncStatus] = useState<'LOCAL_ONLY' | 'SYNCED' | 'SYNCING'>('LOCAL_ONLY');

  const parametersRef = React.useRef(parameters);
  const lastAppliedRemoteVersionRef = React.useRef<number | null>(null);
  const cloudSnapshotReceivedRef = React.useRef(false);
  const currentUserRef = React.useRef<User | null>(null);

  // Sync parameters & proposal to localStorage & Shared Server
  useEffect(() => {
    parametersRef.current = parameters;
    localStorage.setItem('intraday_radar_parameters', JSON.stringify(parameters));
    if (currentUserRef.current && !cloudSnapshotReceivedRef.current) return;
    if (!isRemoteSyncingRef.current && hasInitialSyncCompletedRef.current) {
      if (!shouldPushLocalParameters(parameters, lastAppliedRemoteVersionRef.current)) return;
      pushSharedAppState({ parameters });
    }
  }, [parameters]);

  useEffect(() => {
    if (pendingProposal) {
      localStorage.setItem('intraday_radar_pending_proposal', JSON.stringify(pendingProposal));
    } else {
      localStorage.removeItem('intraday_radar_pending_proposal');
    }
    if (!isRemoteSyncingRef.current && hasInitialSyncCompletedRef.current) {
      pushSharedAppState({ pendingProposal });
    }
  }, [pendingProposal]);

  useEffect(() => {
    localStorage.setItem('intraday_radar_journal_trades', JSON.stringify(journalEntries));
    if (!isRemoteSyncingRef.current && hasInitialSyncCompletedRef.current) {
      pushSharedAppState({ journalEntries });
    }
  }, [journalEntries]);

  useEffect(() => {
    localStorage.setItem('intraday_radar_excluded_records', JSON.stringify(excludedRecords));
    if (!isRemoteSyncingRef.current && hasInitialSyncCompletedRef.current) {
      pushSharedAppState({ excludedRecords });
    }
  }, [excludedRecords]);

  // 100% Universal Synchronization across all devices (Desktop, Mobile PWA, Dev preview)
  useEffect(() => {
    let isMounted = true;

    const performSync = async () => {
      try {
        const res = await fetchSharedAppState(sharedStateVersionRef.current);
        if (!isMounted || !res || !res.hasUpdates || !res.state) {
          if (isMounted) hasInitialSyncCompletedRef.current = true;
          return;
        }

        const s = res.state;
        if (res.version) sharedStateVersionRef.current = res.version;

        isRemoteSyncingRef.current = true;

        // 1. Parametri: applica solo se la versione remota è strettamente maggiore della locale
        if (s.parameters && shouldApplyPolledParameters(parametersRef.current, s.parameters)) {
          const sanitizedParams = sanitizeScoreParameters(s.parameters);
          setParameters(sanitizedParams);
          parametersRef.current = sanitizedParams;
          lastAppliedRemoteVersionRef.current = sanitizedParams.version;
          localStorage.setItem('intraday_radar_parameters', JSON.stringify(sanitizedParams));
        }

        // 2. Setup monitorati e congelati di oggi (EU / US)
        const today = new Date().toISOString().slice(0, 10);
        if (s.freezeStateEU && s.freezeStateEU.frozenAt && s.freezeStateEU.frozenAt.startsWith(today)) {
          setFreezeStateEU(s.freezeStateEU);
          freezeStateEURef.current = s.freezeStateEU;
          localStorage.setItem(`intraday_radar_freeze_EU_${today}`, JSON.stringify(s.freezeStateEU));
        }
        if (s.freezeStateUS && s.freezeStateUS.frozenAt && s.freezeStateUS.frozenAt.startsWith(today)) {
          setFreezeStateUS(s.freezeStateUS);
          freezeStateUSRef.current = s.freezeStateUS;
          localStorage.setItem(`intraday_radar_freeze_US_${today}`, JSON.stringify(s.freezeStateUS));
        }

        // 3. Diario di trading
        if (Array.isArray(s.journalEntries) && s.journalEntries.length > 0) {
          const merged = mergeTradesWithTombstones(
            journalEntriesRef.current,
            s.journalEntries,
            deletedTradeIdsRef.current
          );
          setJournalEntries(merged);
          localStorage.setItem('intraday_radar_journal_trades', JSON.stringify(merged));
        }

        // 4. Setup esclusi (Autoanalisi scartati)
        if (Array.isArray(s.excludedRecords) && s.excludedRecords.length > 0) {
          setExcludedRecords((prevLocal) => {
            const map = new Map<string, ExcludedSetupRecord>();
            prevLocal.forEach((r) => map.set(r.id || `${r.ticker}_${r.timestamp}`, r));
            s.excludedRecords.forEach((r: ExcludedSetupRecord) => map.set(r.id || `${r.ticker}_${r.timestamp}`, r));
            const merged = Array.from(map.values()).slice(-500);
            localStorage.setItem('intraday_radar_excluded_records', JSON.stringify(merged));
            return merged;
          });
        }

        // 5. Account Capital & Paper Mode
        if (typeof s.accountCapital === 'number') {
          setAccountCapital(s.accountCapital);
          localStorage.setItem('intraday_radar_account_capital', JSON.stringify(s.accountCapital));
        }
        if (typeof s.isPaperMode === 'boolean') {
          setIsPaperMode(s.isPaperMode);
          localStorage.setItem('intraday_radar_paper_mode', JSON.stringify(s.isPaperMode));
        }

        if (s.pendingProposal !== undefined) {
          setPendingProposal(s.pendingProposal);
        }
        if (s.dualProposals !== undefined) {
          setDualProposals(s.dualProposals);
        }

        if (Array.isArray(s.underlyings) && s.underlyings.length > 0) {
          setUnderlyings(migrateUnderlyings(s.underlyings));
        }

        setTimeout(() => {
          if (isMounted) {
            isRemoteSyncingRef.current = false;
            hasInitialSyncCompletedRef.current = true;
          }
        }, 300);
      } catch (err) {
        if (isMounted) {
          isRemoteSyncingRef.current = false;
          hasInitialSyncCompletedRef.current = true;
        }
      }
    };

    performSync();
    const pollTimer = setInterval(performSync, 6000);

    const handleFocusOrVis = () => {
      if (document.visibilityState === 'visible') performSync();
    };
    window.addEventListener('visibilitychange', handleFocusOrVis);
    window.addEventListener('focus', handleFocusOrVis);

    return () => {
      isMounted = false;
      clearInterval(pollTimer);
      window.removeEventListener('visibilitychange', handleFocusOrVis);
      window.removeEventListener('focus', handleFocusOrVis);
    };
  }, []);

  // Real-time Cloud Sync with Firebase across PC, Mobile, and Tablet
  useEffect(() => {
    if (!auth) {
      setCloudSyncStatus('LOCAL_ONLY');
      return;
    }

    let unsubData: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (unsubData) {
        unsubData();
        unsubData = null;
      }

      setCurrentUser(user);
      currentUserRef.current = user;
      cloudSnapshotReceivedRef.current = false;
      if (user) {
        setCloudSyncStatus('SYNCING');
        unsubData = subscribeToUserCloudData(
          user.uid,
          (cloudSettings) => {
            cloudSnapshotReceivedRef.current = true;
            if (shouldApplyCloudParameters(parametersRef.current, cloudSettings.parameters)) {
              setParameters(sanitizeScoreParameters(cloudSettings.parameters));
              lastAppliedRemoteVersionRef.current = cloudSettings.parameters.version;
            }
            if (cloudSettings.pendingProposal !== undefined) {
              setPendingProposal(cloudSettings.pendingProposal);
            }
            if (cloudSettings.accountCapital !== undefined) {
              setAccountCapital(cloudSettings.accountCapital);
            }
            if (cloudSettings.isPaperMode !== undefined) {
              setIsPaperMode(cloudSettings.isPaperMode);
            }
            if (cloudSettings.underlyings && cloudSettings.underlyings.length > 0) {
              setUnderlyings(migrateUnderlyings(cloudSettings.underlyings));
            }
            if (Array.isArray(cloudSettings.deletedTradeIds) && cloudSettings.deletedTradeIds.length > 0) {
              const mergedIds = Array.from(new Set([...deletedTradeIdsRef.current, ...cloudSettings.deletedTradeIds]));
              deletedTradeIdsRef.current = mergedIds;
              setDeletedTradeIds(mergedIds);
            }
            setCloudSyncStatus('SYNCED');
          },
          (cloudTrades) => {
            // AUDIT ROUND2 V4: il merge rispetta i tombstone (un trade eliminato non risorge).
            const tombstones = deletedTradeIdsRef.current;
            const blocked = new Set(tombstones);
            const cloudIds = new Set(cloudTrades.map((t) => t.id));
            const missingInCloud = journalEntriesRef.current.filter(
              (t) => !cloudIds.has(t.id) && !blocked.has(t.id)
            );
            setJournalEntries(mergeTradesWithTombstones(journalEntriesRef.current, cloudTrades, tombstones));
            if (missingInCloud.length > 0) {
              batchUploadTradesToCloud(user.uid, missingInCloud);
            }
            setCloudSyncStatus('SYNCED');
          },
          () => {
            cloudSnapshotReceivedRef.current = true;
          }
        );
      } else {
        setCloudSyncStatus('LOCAL_ONLY');
      }
    });

    return () => {
      if (unsubData) unsubData();
      unsubAuth();
    };
  }, []);

  // AUDIT ROUND2 V4: tombstone dei trade eliminati.
  // IPOTESI: i tombstone sono mantenuti tutti (nessun limite di retention).
  const [deletedTradeIds, setDeletedTradeIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('intraday_radar_deleted_trade_ids');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  });
  const deletedTradeIdsRef = React.useRef<string[]>(deletedTradeIds);
  const journalEntriesRef = React.useRef<TradeJournalEntry[]>(journalEntries);
  useEffect(() => {
    journalEntriesRef.current = journalEntries;
  }, [journalEntries]);
  useEffect(() => {
    deletedTradeIdsRef.current = deletedTradeIds;
    try {
      localStorage.setItem('intraday_radar_deleted_trade_ids', JSON.stringify(deletedTradeIds));
    } catch {
      /* storage non disponibile: i tombstone restano in memoria */
    }
  }, [deletedTradeIds]);
  const rememberDeletedTrades = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const next = Array.from(new Set([...deletedTradeIdsRef.current, ...ids]));
    deletedTradeIdsRef.current = next;
    setDeletedTradeIds(next);
    if (currentUser) {
      syncSystemSettingsToCloud(currentUser.uid, {
        parameters,
        pendingProposal,
        accountCapital,
        isPaperMode,
        deletedTradeIds: next,
      });
    }
  }, [currentUser, parameters, pendingProposal, accountCapital, isPaperMode]);

  // AUDIT ROUND2 V5: lo stato letto dalla scansione passa da ref aggiornati in un effect dedicato,
  // cosi' le dipendenze della scansione non cambiano e l'effetto non si rilancia da solo.
  const macroCalendarRef = React.useRef<MacroCalendarState | null>(macroCalendar);
  const sessionInfoRef = React.useRef<SessionInfo | null>(sessionInfo);
  const catalystCacheRef = React.useRef<Record<string, GeminiCatalystAnalysis>>(catalystCache);
  const newsCacheRef = React.useRef<Record<string, NewsItem[]>>(newsCache);
  useEffect(() => {
    sessionInfoRef.current = sessionInfo;
    macroCalendarRef.current = macroCalendar;
    catalystCacheRef.current = catalystCache;
    newsCacheRef.current = newsCache;
  }, [sessionInfo, macroCalendar, catalystCache, newsCache]);

  // Compute Daily Risk Tracker & Circuit Breaker
  const todayStr = new Date().toLocaleDateString('it-IT');
  const todayTrades = journalEntries.filter((e) => e.date === todayStr);
  const tradesTodayCount = todayTrades.length;
  const todayPnlEur = todayTrades.reduce((acc, curr) => acc + curr.pnlEur, 0);
  const dailyPnlPercent = accountCapital > 0 ? +((todayPnlEur / accountCapital) * 100).toFixed(2) : 0;

  // Circuit Breaker triggers if 2 trades reached OR loss exceeds -2.0%
  const isLossCircuitBreaker = dailyPnlPercent <= -2.0;
  const isTradesCountCircuitBreaker = tradesTodayCount >= 2;
  const circuitBreakerActive = isLossCircuitBreaker || isTradesCountCircuitBreaker;
  const circuitBreakerReason = isLossCircuitBreaker
    ? `Raggiunto lo Stop Loss Giornaliero del -2.00% (perdita odierna: ${todayPnlEur.toFixed(2)} €). La piattaforma blocca ogni nuovo segnale per preservare il capitale e prevenire revenge trading.`
    : isTradesCountCircuitBreaker
    ? `Raggiunto il limite massimo di 2 trade al giorno (${tradesTodayCount}/2 eseguiti). Per disciplina operativa, non sono ammesse nuove aperture fino a domani.`
    : '';

  // Initial load: session clock, futures, auto-screening, macro calendar
  useEffect(() => {
    const initApp = async () => {
      try {
        const [sess, futs, macro] = await Promise.all([
          fetchSessionInfo(),
          fetchBenchmarkFutures(),
          fetchMacroCalendar(),
        ]);
        setSessionInfo(sess);
        setFutures(futs);
        setMacroCalendar(macro);
      } catch (err) {
        console.error('Errore inizializzazione sessione:', err);
      }
    };
    initApp();
  }, []);

  // Filter underlyings for active scanning
  const activeUnderlyingsForSession =
    currentSession === 'GLOBAL'
      ? underlyings
      : underlyings.filter((u) => u.mercato === currentSession);

  // Helper to fetch news and catalyst for candidate
  const resolveCandidateCatalyst = async (
    candidate: ScoredCandidate | null,
    marketFutures: any
  ): Promise<GeminiCatalystAnalysis | null> => {
    if (!candidate) return null;
    const ticker = candidate.quote.ticker;

    // Check memory cache first
    if (catalystCacheRef.current[ticker]) return catalystCacheRef.current[ticker];

    try {
      let newsItems = newsCacheRef.current[ticker];
      if (!newsItems) {
        newsItems = await fetchTickerNews(ticker, candidate.quote.name);
        setNewsCache((prev) => ({ ...prev, [ticker]: newsItems }));
      }
      const res = await analyzeCatalystWithGemini(candidate.quote, newsItems, marketFutures);
      setCatalystCache((prev) => ({ ...prev, [ticker]: res }));
      return res;
    } catch (err) {
      console.warn(`Fallback setup per ${ticker} (catalyst non disponibile):`, err);
      return null;
    }
  };

  // Run Screening Function (Dual-Market Europe & USA)
  // AUDIT ROUND2 V6: una nuova scansione annulla la precedente.
  const scanAbortRef = React.useRef<AbortController | null>(null);

  const handleRunScreening = useCallback(async () => {
    scanAbortRef.current?.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;
    const isAlive = () => !controller.signal.aborted;

    if (underlyings.length === 0) {
      setScanError('Nessun sottostante caricato nel paniere. Aggiungine nel gestore CSV.');
      return;
    }

    setIsScanning(true);
    setScanError(null);
    setAutoRefreshCountdown(20);

    try {
      // 1. Fetch live quotes and fresh futures simultaneously
      // Ensure all open journal positions are also fetched so their live prices stay up to date
      const openTradesList = journalEntries.filter((t) => t.status === 'OPEN');
      const scanBasket = [...underlyings];
      openTradesList.forEach((ot) => {
        if (!scanBasket.some((u) => u.ticker === ot.ticker)) {
          const isEu = ot.session === 'EU' || ot.market === 'EU' || ot.ticker.endsWith('.MI');
          scanBasket.push({
            ticker: ot.ticker,
            nome: ot.ticker,
            mercato: isEu ? 'EU' : 'US',
            valuta: isEu ? 'EUR' : 'USD',
          });
        }
      });

      const [freshFutures, rawQuotes] = await Promise.all([
        fetchBenchmarkFutures(true).catch(() => futures),
        fetchMarketData(scanBasket, true),
      ]);
      if (!isAlive()) return;

      if (freshFutures) {
        setFutures(freshFutures);
      }
      fetchMacroCalendar().then((m) => { if (m) setMacroCalendar(m); }).catch(() => {});
      setQuotes(rawQuotes);
      setCachedAt(new Date().toISOString());

      // 2. Identify relevant benchmark futures for each market
      const activeFut = freshFutures || futures;
      const euChange = activeFut?.europe?.dax?.changePercent ?? (activeFut?.europe?.eurostoxx?.changePercent ?? 0);
      const usChange = activeFut?.usa?.sp500?.changePercent ?? (activeFut?.usa?.nasdaq?.changePercent ?? 0);
      const futuresMapping = { EU: euChange, US: usChange };

      // 3. Dual-Market Ranking: Top 1 Europe, Top 1 USA, and All Ranked
      const dual = getDualTopCandidates(rawQuotes, futuresMapping, { rsiFilterActive, parameters });

      const freezeEU = freezeStateEURef.current;
      const freezeUS = freezeStateUSRef.current;

      // Determine candidate for EU: if frozen, lock to the frozen ticker with real-time live quotes
      let activeTopEU = dual.topEU;
      if (freezeEU.isFrozen && freezeEU.frozenTicker) {
        const matched = dual.allRanked.find((c) => c.quote.ticker === freezeEU.frozenTicker);
        if (matched) {
          activeTopEU = matched;
        }
      }

      // Determine candidate for US: if frozen, lock to the frozen ticker with real-time live quotes
      let activeTopUS = dual.topUS;
      if (freezeUS.isFrozen && freezeUS.frozenTicker) {
        const matched = dual.allRanked.find((c) => c.quote.ticker === freezeUS.frozenTicker);
        if (matched) {
          activeTopUS = matched;
        }
      }

      // Auto-freeze at 09:15 Rome for Europe and 09:45 NY for USA using Intl.DateTimeFormat
      const marketTimeEU = getMarketTime('EU');
      const marketTimeUS = getMarketTime('US');

      if (
        marketTimeEU.isAfterOrb &&
        marketTimeEU.isSessionActive &&
        !freezeEU.isFrozen &&
        !freezeEU.unlockedByUser &&
        activeTopEU
      ) {
        const newFreeze: MarketFreezeState = {
          isFrozen: true,
          frozenTicker: activeTopEU.quote.ticker,
          frozenAt: new Date().toISOString(),
          frozenTimeFormatted: '09:15 Rome (Snapshot ORB 15m)',
          isAutoFrozen: true,
          unlockedByUser: false,
        };
        setFreezeStateEU(newFreeze);
        freezeStateEURef.current = newFreeze;
      }

      if (
        marketTimeUS.isAfterOrb &&
        marketTimeUS.isSessionActive &&
        !freezeUS.isFrozen &&
        !freezeUS.unlockedByUser &&
        activeTopUS
      ) {
        const newFreeze: MarketFreezeState = {
          isFrozen: true,
          frozenTicker: activeTopUS.quote.ticker,
          frozenAt: new Date().toISOString(),
          frozenTimeFormatted: '09:45 NY (Snapshot ORB 15m)',
          isAutoFrozen: true,
          unlockedByUser: false,
        };
        setFreezeStateUS(newFreeze);
        freezeStateUSRef.current = newFreeze;
      }

      setTopCandidateEU(activeTopEU);
      setTopCandidateUS(activeTopUS);
      setTopCandidates(dual.allRanked);

      // Select default candidate
      if (currentSession === 'US') {
        setSelectedCandidate(activeTopUS || activeTopEU);
      } else {
        setSelectedCandidate(activeTopEU || activeTopUS);
      }

      // 4. Concurrently analyze catalysts & build execution setups for both Top picks
      let finalTopEU = activeTopEU;
      let finalTopUS = activeTopUS;

      const [catEU, catUS] = await Promise.all([
        resolveCandidateCatalyst(activeTopEU, activeFut?.europe),
        resolveCandidateCatalyst(activeTopUS, activeFut?.usa),
      ]);

      let finalCatEU = catEU;
      let finalCatUS = catUS;

      // If top candidate is disqualified by negative catalyst, check if a qualified runner-up has a valid catalyst (only when not frozen)
      if (!freezeEU.isFrozen && catEU?.decisione === 'NESSUN_TRADE' && dual.rankedEU.length > 1) {
        const runnerUp = dual.rankedEU.find(
          (c) =>
            c.quote.ticker !== dual.topEU?.quote.ticker &&
            isCandidateCompliantWithParameters(c.quote, c.score.total, parameters, rsiFilterActive).compliant
        );
        if (runnerUp) {
          const runnerCat = await resolveCandidateCatalyst(runnerUp, activeFut?.europe);
          if (runnerCat?.decisione !== 'NESSUN_TRADE') {
            finalTopEU = runnerUp;
            finalCatEU = runnerCat;
          }
        }
      }

      if (!freezeUS.isFrozen && catUS?.decisione === 'NESSUN_TRADE' && dual.rankedUS.length > 1) {
        const runnerUp = dual.rankedUS.find(
          (c) =>
            c.quote.ticker !== dual.topUS?.quote.ticker &&
            isCandidateCompliantWithParameters(c.quote, c.score.total, parameters, rsiFilterActive).compliant
        );
        if (runnerUp) {
          const runnerCat = await resolveCandidateCatalyst(runnerUp, activeFut?.usa);
          if (runnerCat?.decisione !== 'NESSUN_TRADE') {
            finalTopUS = runnerUp;
            finalCatUS = runnerCat;
          }
        }
      }

      const entryModeEU: EntryMode = freezeEU.isAutoFrozen
        ? 'SNAPSHOT_0915'
        : freezeEU.unlockedByUser
        ? 'UNFROZEN_LATE'
        : freezeEU.isFrozen
        ? 'MANUAL_FREEZE'
        : 'UNFROZEN_LATE';

      const entryModeUS: EntryMode = freezeUS.isAutoFrozen
        ? 'SNAPSHOT_0915'
        : freezeUS.unlockedByUser
        ? 'UNFROZEN_LATE'
        : freezeUS.isFrozen
        ? 'MANUAL_FREEZE'
        : 'UNFROZEN_LATE';

      if (!isAlive()) return;
      setTopCandidateEU(finalTopEU);
      setTopCandidateUS(finalTopUS);
      setSetupEU(buildExecutionSetup(finalTopEU, finalCatEU, 'EU', parameters, { entryMode: entryModeEU, macroEvents: macroCalendarRef.current?.events }));
      setSetupUS(buildExecutionSetup(finalTopUS, finalCatUS, 'US', parameters, { entryMode: entryModeUS, macroEvents: macroCalendarRef.current?.events }));

      // 4.5. Visual Filtering Audit Generation (triggers 3-5s notification banner)
      const currentCache: Record<string, GeminiCatalystAnalysis> = { ...catalystCacheRef.current };
      if (finalTopEU && finalCatEU) currentCache[finalTopEU.quote.ticker] = finalCatEU;
      if (finalTopUS && finalCatUS) currentCache[finalTopUS.quote.ticker] = finalCatUS;

      const audit = generateFilteringAuditReport(
        rawQuotes,
        { topEU: finalTopEU, topUS: finalTopUS },
        futuresMapping,
        parameters,
        currentCache,
        rsiFilterActive,
        sessionInfoRef.current?.cet?.currentMinutes
      );
      setAuditReport(audit);
      setShowAuditBanner(true);

      // Auto-register excluded candidates into Counterfactual Analyzer
      if (audit.excludedList.length > 0) {
        setExcludedRecords((prev) => {
          const today = new Date().toLocaleDateString('it-IT');
          const existingKeys = new Set(prev.map((r) => `${r.ticker}-${r.sessionDate}`));
          const newEntries: ExcludedSetupRecord[] = [];

          audit.excludedList.forEach((cand) => {
            const key = `${cand.ticker}-${today}`;
            if (!existingKeys.has(key)) {
              const matchingQuote = rawQuotes.find((q) => q.ticker === cand.ticker);
              if (matchingQuote) {
                const setup = buildTheoreticalSetupForExcluded(cand, matchingQuote, parameters);
                if (setup) {
                  newEntries.push(setup);
                  existingKeys.add(key);
                }
              }
            }
          });

          if (newEntries.length === 0) return prev;
          return [...newEntries, ...prev].slice(0, 150);
        });
      }
    } catch (err: any) {
      if (!isAlive()) return;
      setScanError(`Errore durante il recupero dei dati di mercato: ${err.message || 'Controlla la connessione'}`);
    } finally {
      if (scanAbortRef.current === controller) setIsScanning(false);
    }
  }, [underlyings, currentSession, futures, rsiFilterActive, parameters, journalEntries]);

  // Re-rank instantly when RSI Filter or parameters are changed
  useEffect(() => {
    if (quotes.length === 0) return;
    const activeFut = futures;
    const euChange = activeFut?.europe?.dax?.changePercent ?? (activeFut?.europe?.eurostoxx?.changePercent ?? 0);
    const usChange = activeFut?.usa?.sp500?.changePercent ?? (activeFut?.usa?.nasdaq?.changePercent ?? 0);
    const futuresMapping = { EU: euChange, US: usChange };

    const dual = getDualTopCandidates(quotes, futuresMapping, { rsiFilterActive, parameters });
    const freezeEU = freezeStateEURef.current;
    const freezeUS = freezeStateUSRef.current;

    let activeTopEU = dual.topEU;
    if (freezeEU.isFrozen && freezeEU.frozenTicker) {
      const matched = dual.allRanked.find((c) => c.quote.ticker === freezeEU.frozenTicker);
      if (matched) activeTopEU = matched;
    }

    let activeTopUS = dual.topUS;
    if (freezeUS.isFrozen && freezeUS.frozenTicker) {
      const matched = dual.allRanked.find((c) => c.quote.ticker === freezeUS.frozenTicker);
      if (matched) activeTopUS = matched;
    }

    setTopCandidateEU(activeTopEU);
    setTopCandidateUS(activeTopUS);
    setTopCandidates(dual.allRanked);

    if (currentSession === 'US') {
      setSelectedCandidate(activeTopUS || activeTopEU);
    } else {
      setSelectedCandidate(activeTopEU || activeTopUS);
    }

    Promise.all([
      resolveCandidateCatalyst(activeTopEU, activeFut?.europe),
      resolveCandidateCatalyst(activeTopUS, activeFut?.usa),
    ]).then(async ([catEU, catUS]) => {
      let finalTopEU = activeTopEU;
      let finalTopUS = activeTopUS;
      let finalCatEU = catEU;
      let finalCatUS = catUS;

      // If top candidate is disqualified by negative catalyst, check runner-up qualified candidate (only when not frozen)
      if (!freezeEU.isFrozen && catEU?.decisione === 'NESSUN_TRADE' && dual.rankedEU.length > 1) {
        const runnerUp = dual.rankedEU.find(
          (c) =>
            c.quote.ticker !== dual.topEU?.quote.ticker &&
            isCandidateCompliantWithParameters(c.quote, c.score.total, parameters, rsiFilterActive).compliant
        );
        if (runnerUp) {
          const runnerCat = await resolveCandidateCatalyst(runnerUp, activeFut?.europe);
          if (runnerCat?.decisione !== 'NESSUN_TRADE') {
            finalTopEU = runnerUp;
            finalCatEU = runnerCat;
          }
        }
      }

      if (!freezeUS.isFrozen && catUS?.decisione === 'NESSUN_TRADE' && dual.rankedUS.length > 1) {
        const runnerUp = dual.rankedUS.find(
          (c) =>
            c.quote.ticker !== dual.topUS?.quote.ticker &&
            isCandidateCompliantWithParameters(c.quote, c.score.total, parameters, rsiFilterActive).compliant
        );
        if (runnerUp) {
          const runnerCat = await resolveCandidateCatalyst(runnerUp, activeFut?.usa);
          if (runnerCat?.decisione !== 'NESSUN_TRADE') {
            finalTopUS = runnerUp;
            finalCatUS = runnerCat;
          }
        }
      }

      const entryModeEU: EntryMode = freezeEU.isAutoFrozen
        ? 'SNAPSHOT_0915'
        : freezeEU.unlockedByUser
        ? 'UNFROZEN_LATE'
        : freezeEU.isFrozen
        ? 'MANUAL_FREEZE'
        : 'UNFROZEN_LATE';

      const entryModeUS: EntryMode = freezeUS.isAutoFrozen
        ? 'SNAPSHOT_0915'
        : freezeUS.unlockedByUser
        ? 'UNFROZEN_LATE'
        : freezeUS.isFrozen
        ? 'MANUAL_FREEZE'
        : 'UNFROZEN_LATE';

      setTopCandidateEU(finalTopEU);
      setTopCandidateUS(finalTopUS);
      setSetupEU(buildExecutionSetup(finalTopEU, finalCatEU, 'EU', parameters, { entryMode: entryModeEU, macroEvents: macroCalendar?.events }));
      setSetupUS(buildExecutionSetup(finalTopUS, finalCatUS, 'US', parameters, { entryMode: entryModeUS, macroEvents: macroCalendar?.events }));

      const currentCache: Record<string, GeminiCatalystAnalysis> = { ...catalystCache };
      if (finalTopEU && finalCatEU) currentCache[finalTopEU.quote.ticker] = finalCatEU;
      if (finalTopUS && finalCatUS) currentCache[finalTopUS.quote.ticker] = finalCatUS;

      const audit = generateFilteringAuditReport(
        quotes,
        { topEU: finalTopEU, topUS: finalTopUS },
        futuresMapping,
        parameters,
        currentCache,
        rsiFilterActive,
        sessionInfo?.cet?.currentMinutes
      );
      setAuditReport(audit);
    });
  }, [rsiFilterActive, parameters]);

  // Auto-refresh interval (Real-time live monitoring)
  const handleRunScreeningRef = React.useRef(handleRunScreening);
  useEffect(() => {
    handleRunScreeningRef.current = handleRunScreening;
  });

  const autoRefreshCountdownRef = React.useRef(20);
  useEffect(() => {
    autoRefreshCountdownRef.current = autoRefreshCountdown;
  }, [autoRefreshCountdown]);

  useEffect(() => {
    if (!isAutoRefresh) return;

    const timer = setInterval(() => {
      // AUDIT ROUND2 V6: il tick e il side effect stanno fuori dall'updater di stato.
      const base = autoRefreshCountdownRef.current;
      const next = base <= 1 ? 20 : base - 1;
      autoRefreshCountdownRef.current = next;
      setAutoRefreshCountdown(next);
      if (next === 20) handleRunScreeningRef.current();
    }, 1000);

    return () => clearInterval(timer);
  }, [isAutoRefresh]);

  // Freeze / Unfreeze Toggles for Europe and USA
  const handleToggleFreezeEU = useCallback(() => {
    setFreezeStateEU((prev) => {
      if (prev.isFrozen) {
        const updated: MarketFreezeState = {
          isFrozen: false,
          frozenTicker: null,
          frozenAt: null,
          frozenTimeFormatted: null,
          isAutoFrozen: false,
          unlockedByUser: true,
        };
        freezeStateEURef.current = updated;
        return updated;
      } else {
        const candTicker = topCandidateEU?.quote.ticker || null;
        if (!candTicker || topCandidateEU?.score.warmupIncomplete) return prev;
        const updated: MarketFreezeState = {
          isFrozen: true,
          frozenTicker: candTicker,
          frozenAt: new Date().toISOString(),
          frozenTimeFormatted: `${sessionInfo?.cet?.formatted || 'Manuale'} CET`,
          isAutoFrozen: false,
          unlockedByUser: false,
        };
        freezeStateEURef.current = updated;
        return updated;
      }
    });
    setTimeout(() => handleRunScreeningRef.current(), 30);
  }, [topCandidateEU, sessionInfo]);

  const handleToggleFreezeUS = useCallback(() => {
    setFreezeStateUS((prev) => {
      if (prev.isFrozen) {
        const updated: MarketFreezeState = {
          isFrozen: false,
          frozenTicker: null,
          frozenAt: null,
          frozenTimeFormatted: null,
          isAutoFrozen: false,
          unlockedByUser: true,
        };
        freezeStateUSRef.current = updated;
        return updated;
      } else {
        const candTicker = topCandidateUS?.quote.ticker || null;
        if (!candTicker || topCandidateUS?.score.warmupIncomplete) return prev;
        const updated: MarketFreezeState = {
          isFrozen: true,
          frozenTicker: candTicker,
          frozenAt: new Date().toISOString(),
          frozenTimeFormatted: `${sessionInfo?.cet?.formatted || 'Manuale'} CET`,
          isAutoFrozen: false,
          unlockedByUser: false,
        };
        freezeStateUSRef.current = updated;
        return updated;
      }
    });
    setTimeout(() => handleRunScreeningRef.current(), 30);
  }, [topCandidateUS, sessionInfo]);

  // Run initial scan once futures are available
  const initialScanDoneRef = React.useRef(false);
  useEffect(() => {
    if (futures && !initialScanDoneRef.current) {
      initialScanDoneRef.current = true;
      handleRunScreeningRef.current();
    }
  }, [futures]);

  // Trigger Catalyst modal for any candidate
  const handleOpenCatalystModal = async (cand: ScoredCandidate) => {
    setActiveCatalystCandidate(cand);
    setIsCatalystModalOpen(true);

    const ticker = cand.quote.ticker;
    let newsItems = newsCache[ticker];

    if (!newsItems) {
      setIsLoadingCatalyst(true);
      newsItems = await fetchTickerNews(ticker, cand.quote.name);
      setNewsCache((prev) => ({ ...prev, [ticker]: newsItems }));
    }

    if (!catalystCache[ticker]) {
      setIsLoadingCatalyst(true);
      try {
        const currentFut = cand.quote.market === 'EU' ? futures?.europe : futures?.usa;
        const res = await analyzeCatalystWithGemini(cand.quote, newsItems, currentFut);
        setCatalystCache((prev) => ({ ...prev, [ticker]: res }));
      } catch (err) {
        console.error('Errore catalyst Gemini:', err);
      } finally {
        setIsLoadingCatalyst(false);
      }
    }
  };

  const handleReanalyzeActiveCatalyst = async () => {
    if (!activeCatalystCandidate) return;
    const cand = activeCatalystCandidate;
    const ticker = cand.quote.ticker;
    setIsLoadingCatalyst(true);
    try {
      const currentFut = cand.quote.market === 'EU' ? futures?.europe : futures?.usa;
      const newsItems = await fetchTickerNews(ticker, cand.quote.name);
      setNewsCache((prev) => ({ ...prev, [ticker]: newsItems }));
      const res = await analyzeCatalystWithGemini(cand.quote, newsItems, currentFut);
      setCatalystCache((prev) => ({ ...prev, [ticker]: res }));

      // Update setups if active candidate is either top EU or top US
      if (!cand.score.warmupIncomplete && topCandidateEU?.quote.ticker === ticker) {
        setSetupEU(buildExecutionSetup(cand, res, 'EU', parameters, { entryMode: getActiveEntryMode('EU'), macroEvents: macroCalendar?.events }));
      }
      if (!cand.score.warmupIncomplete && topCandidateUS?.quote.ticker === ticker) {
        setSetupUS(buildExecutionSetup(cand, res, 'US', parameters, { entryMode: getActiveEntryMode('US'), macroEvents: macroCalendar?.events }));
      }
    } catch (err) {
      console.error('Errore rianalisi:', err);
    } finally {
      setIsLoadingCatalyst(false);
    }
  };

  // Select alternative candidate from Live Radar and promote to setup
  const handleSelectCandidate = async (cand: ScoredCandidate) => {
    if (cand.score.warmupIncomplete) {
      console.warn(`Selezione bloccata: ${cand.quote.ticker} in warm-up incompleto`);
      return;
    }
    setSelectedCandidate(cand);
    let existingCat: GeminiCatalystAnalysis | null = catalystCache[cand.quote.ticker] || null;
    const market = cand.quote.market;

    if (!existingCat) {
      const activeFut = market === 'EU' ? futures?.europe : futures?.usa;
      existingCat = await resolveCandidateCatalyst(cand, activeFut);
    }

    const newSetup = buildExecutionSetup(cand, existingCat, market, parameters, {
      entryMode: getActiveEntryMode(market),
      macroEvents: macroCalendar?.events,
    });

    if (market === 'EU') {
      setTopCandidateEU(cand);
      setSetupEU(newSetup);
    } else {
      setTopCandidateUS(cand);
      setSetupUS(newSetup);
    }
  };

  // 6c. Autonomous Live Trade Monitor
  // Evaluates every active OPEN position against live tick prices, excursions (MFE/MAE), and market sessions
  useEffect(() => {
    if (quotes.length === 0) return;

    // AUDIT ROUND2 V6: nessun side effect dentro l'updater di stato.
    const prevEntries = journalEntriesRef.current;
    {
      const openTrades = prevEntries.filter((t) => t.status === 'OPEN');
      if (openTrades.length === 0) return;

      let hasAnyChange = false;
      let notificationToDisplay = '';
      const now = new Date();

      const updatedList = prevEntries.map((trade) => {
        if (trade.status !== 'OPEN') return trade;

        const matchingQuote = quotes.find((q) => q.ticker === trade.ticker);
        const evalResult = evaluateOpenPositionLifecycle(trade, matchingQuote, now, {
          sessionInfo,
          accountCapital,
        });

        if (evalResult.updatedTrade !== trade) {
          hasAnyChange = true;
          if (evalResult.notification) {
            notificationToDisplay = evalResult.notification;
          }
          return evalResult.updatedTrade;
        }
        return trade;
      });

      if (!hasAnyChange) return;

      setJournalEntries(updatedList);

      if (notificationToDisplay) {
        setOptimizationNotification(notificationToDisplay);
        setTimeout(() => setOptimizationNotification(null), 6000);
      }

      // Cloud sync updated list if logged in
      if (currentUser) {
        updatedList.forEach((t) => {
          if (t.status === 'CLOSED' && t.closeReason) {
            syncTradeToCloud(currentUser.uid, t);
          }
        });
      }
    }
  }, [quotes, sessionInfo, accountCapital, currentUser]);

  // 6d. Autonomous Excluded Setups Live Monitor (Counterfactual Tick-by-Tick Evaluation)
  useEffect(() => {
    if (quotes.length === 0) return;

    setExcludedRecords((prev) => {
      if (prev.length === 0) return prev;
      const hasMonitoring = prev.some((r) => r.outcomeStatus === 'MONITORING');
      if (!hasMonitoring) return prev;

      const { updated, newlyResolvedCount } = updateExcludedSetupsWithLiveQuotes(
        prev,
        quotes,
        sessionInfo?.cet?.currentMinutes,
        accountCapital
      );

      if (newlyResolvedCount > 0) {
        return updated;
      }
      return prev;
    });
  }, [quotes, sessionInfo?.cet?.currentMinutes, accountCapital]);

  // Journal Actions
  const handleAddJournalTrade = (tradeData: any) => {
    let entry: TradeJournalEntry;
    try {
      const market: 'EU' | 'US' = tradeData.market || (tradeData.session === 'US' ? 'US' : 'EU');
      const resolvedMode: EntryMode =
        tradeData.entryMode ||
        (tradeData.status === 'CLOSED' || !tradeData.triggerLevel ? 'MANUAL_FREEZE' : getActiveEntryMode(market));

      entry = createJournalEntryFromSetup({ ...tradeData, entryMode: resolvedMode, market }, parameters);
    } catch (err: any) {
      console.error('Salvataggio trade nel diario fallito (nessun record creato):', err);
      setOptimizationNotification(`Errore salvataggio trade: ${err?.message || 'Dati non validi'}`);
      setTimeout(() => setOptimizationNotification(null), 5000);
      return;
    }

    setJournalEntries((prev) => {
      const updated = [entry, ...prev];
      const completedCount = updated.filter((t) => t.status !== 'OPEN').length;
      const dual = evaluateDualSystemOptimization(updated, parameters, 15);
      setDualProposals(dual);
      if (completedCount > 0 && completedCount % 20 === 0) {
        const cycleNum = Math.floor(completedCount / 20);
        const prop = evaluateSystemOptimization(updated, parameters, cycleNum);
        setPendingProposal(prop);
        setOptimizationNotification(
          `Ciclo #${cycleNum} concluso (${completedCount} setup completati)! Nuova proposta di automiglioramento parametri pronta.`
        );
      }
      return updated;
    });

    // Sync trade to Firebase Cloud in real time
    if (currentUser) {
      syncTradeToCloud(currentUser.uid, entry);
    }
  };

  const handleUpdateJournalTrade = (updated: TradeJournalEntry) => {
    setJournalEntries((prev) => {
      const newList = prev.map((t) => (t.id === updated.id ? updated : t));
      const completedCount = newList.filter((t) => t.status !== 'OPEN').length;
      const dual = evaluateDualSystemOptimization(newList, parameters, 15);
      setDualProposals(dual);
      if (completedCount > 0 && completedCount % 20 === 0) {
        const cycleNum = Math.floor(completedCount / 20);
        const prop = evaluateSystemOptimization(newList, parameters, cycleNum);
        setPendingProposal(prop);
        setOptimizationNotification(
          `Ciclo #${cycleNum} concluso (${completedCount} setup completati)! Nuova proposta di automiglioramento parametri pronta.`
        );
      }
      return newList;
    });

    // Sync updated trade to Firebase Cloud
    if (currentUser) {
      syncTradeToCloud(currentUser.uid, updated);
    }
  };

  const handleDeleteJournalTrade = (id: string) => {
    // AUDIT ROUND2 V4: tombstone prima della rimozione, cosi' lo snapshot cloud non lo riaggiunge.
    rememberDeletedTrades([id]);
    setJournalEntries((prev) => prev.filter((item) => item.id !== id));
    if (currentUser) {
      deleteTradeFromCloud(currentUser.uid, id);
    }
  };

  const handleClearJournal = () => {
    rememberDeletedTrades(journalEntries.map((trade) => trade.id));
    setJournalEntries([]);
    setPendingProposal(null);
    if (currentUser) {
      clearAllTradesFromCloud(currentUser.uid);
      syncSystemSettingsToCloud(currentUser.uid, {
        parameters,
        pendingProposal: null,
        accountCapital,
        isPaperMode,
      });
    }
  };

  // Google Sign In & Sign Out for Multi-Device synchronization
  const handleSignInGoogle = async () => {
    try {
      setCloudSyncStatus('SYNCING');
      const user = await signInWithGoogle();
      setCurrentUser(user);
      setOptimizationNotification(
        `Cloud Connesso: ${user.displayName || user.email}! Parametri V${parameters.version} e diario sincronizzati in tempo reale tra tutti i dispositivi.`
      );
      setTimeout(() => setOptimizationNotification(null), 6000);
    } catch (err: any) {
      console.error('Google Sign In error:', err);
      setCloudSyncStatus('LOCAL_ONLY');
    }
  };

  const handleSignOut = async () => {
    try {
      await logoutUser();
      setCurrentUser(null);
      setCloudSyncStatus('LOCAL_ONLY');
      setOptimizationNotification('Account disconnesso. La piattaforma continua in modalità offline locale.');
      setTimeout(() => setOptimizationNotification(null), 4000);
    } catch (err: any) {
      console.error('Sign Out error:', err);
    }
  };

  // 7. System Optimization Proposal Execution (Accept / Reject / Audit)
  const handleAcceptProposal = (market?: 'EU' | 'US' | 'GLOBAL') => {
    const targetProposal =
      market === 'EU'
        ? dualProposals?.eu
        : market === 'US'
        ? dualProposals?.us
        : (pendingProposal || dualProposals?.eu || dualProposals?.us);

    if (!targetProposal || targetProposal.proposedChanges.length === 0) return;

    // AUDIT V12: unica sorgente di verita' per l'applicazione di una proposta accettata.
    // Scrive i campi proposti nei SystemParameters ATTIVI (quelli usati dallo screening) e
    // conserva i valori precedenti in parameterHistory: nulla viene sovrascritto senza traccia.
    const { parameters: newParams, changes } = applyOptimizationProposal(
      parameters,
      targetProposal,
      market ?? 'GLOBAL'
    );
    if (changes.some((c) => c.parameterKey === 'rsiFilterActive')) {
      setRsiFilterActive(newParams.rsiFilterActive);
    }

    const acceptedProposal: OptimizationProposal = {
      ...targetProposal,
      status: 'ACCEPTED',
      appliedAt: new Date().toISOString(),
    };

    const updatedDual = dualProposals ? {
      eu: market === 'EU' ? acceptedProposal : dualProposals.eu,
      us: market === 'US' ? acceptedProposal : dualProposals.us,
    } : null;

    setParameters(newParams);
    localStorage.setItem('intraday_radar_parameters', JSON.stringify(newParams));
    setPendingProposal(acceptedProposal);
    if (updatedDual) {
      setDualProposals(updatedDual);
    }
    setIsOptimizerModalOpen(false);
    const mLabel = market === 'EU' ? 'Sessione Europa' : market === 'US' ? 'Sessione USA' : 'Sistema';
    setOptimizationNotification(`Parametri ${mLabel} aggiornati alla Versione V${newParams.version}! Nuovi calcoli attivi.`);
    setTimeout(() => setOptimizationNotification(null), 6000);

    // Sync accepted parameters & proposal to Cloud and Multi-Device Gateway
    if (currentUser) {
      syncSystemSettingsToCloud(currentUser.uid, {
        parameters: newParams,
        pendingProposal: acceptedProposal,
        accountCapital,
        isPaperMode,
      });
    }
    pushSharedAppState({
      parameters: newParams,
      pendingProposal: acceptedProposal,
      dualProposals: updatedDual,
    });

    // Refresh setups immediately
    if (quotes.length > 0) {
      const activeFut = futures;
      const euChange = activeFut?.europe?.dax?.changePercent ?? (activeFut?.europe?.eurostoxx?.changePercent ?? 0);
      const usChange = activeFut?.usa?.sp500?.changePercent ?? (activeFut?.usa?.nasdaq?.changePercent ?? 0);
      const futuresMapping = { EU: euChange, US: usChange };
      const dual = getDualTopCandidates(quotes, futuresMapping, { rsiFilterActive, parameters: newParams, catalystCache });
      setTopCandidateEU(dual.topEU);
      setTopCandidateUS(dual.topUS);
      setTopCandidates(dual.allRanked);
      if (dual.topEU) {
        setSetupEU(buildExecutionSetup(dual.topEU, catalystCache[dual.topEU.quote.ticker] || null, 'EU', newParams, { entryMode: getActiveEntryMode('EU'), macroEvents: macroCalendar?.events }));
      }
      if (dual.topUS) {
        setSetupUS(buildExecutionSetup(dual.topUS, catalystCache[dual.topUS.quote.ticker] || null, 'US', newParams, { entryMode: getActiveEntryMode('US'), macroEvents: macroCalendar?.events }));
      }
      const audit = generateFilteringAuditReport(
        quotes,
        { topEU: dual.topEU, topUS: dual.topUS },
        futuresMapping,
        newParams,
        catalystCache,
        rsiFilterActive,
        sessionInfo?.cet?.currentMinutes
      );
      setAuditReport(audit);
    } else {
      if (topCandidateEU) {
        setSetupEU(buildExecutionSetup(topCandidateEU, catalystCache[topCandidateEU.quote.ticker] || null, 'EU', newParams, { entryMode: getActiveEntryMode('EU'), macroEvents: macroCalendar?.events }));
      }
      if (topCandidateUS) {
        setSetupUS(buildExecutionSetup(topCandidateUS, catalystCache[topCandidateUS.quote.ticker] || null, 'US', newParams, { entryMode: getActiveEntryMode('US'), macroEvents: macroCalendar?.events }));
      }
    }
  };

  const handleRejectProposal = (market?: 'EU' | 'US' | 'GLOBAL') => {
    const targetProposal =
      market === 'EU'
        ? dualProposals?.eu
        : market === 'US'
        ? dualProposals?.us
        : (pendingProposal || dualProposals?.eu || dualProposals?.us);
    if (!targetProposal) return;
    const rejectedProposal: OptimizationProposal = {
      ...targetProposal,
      status: 'REJECTED',
    };
    const updatedDual = dualProposals ? {
      eu: market === 'EU' ? rejectedProposal : dualProposals.eu,
      us: market === 'US' ? rejectedProposal : dualProposals.us,
    } : null;
    setPendingProposal(rejectedProposal);
    if (updatedDual) {
      setDualProposals(updatedDual);
    }
    setIsOptimizerModalOpen(false);
    const mLabel = market === 'EU' ? 'Sessione Europa' : market === 'US' ? 'Sessione USA' : 'Sistema';
    setOptimizationNotification(`Proposta ${mLabel} rifiutata. Parametri V${parameters.version} mantenuti invariati.`);
    setTimeout(() => setOptimizationNotification(null), 5000);

    // Sync rejected status to Cloud and Gateway
    if (currentUser) {
      syncSystemSettingsToCloud(currentUser.uid, {
        parameters,
        pendingProposal: rejectedProposal,
        accountCapital,
        isPaperMode,
      });
    }
    pushSharedAppState({
      pendingProposal: rejectedProposal,
      dualProposals: updatedDual,
    });
  };

  const handleRunAuditOnDemand = () => {
    if (journalEntries.length === 0) {
      setOptimizationNotification('Nessun trade reale registrato nel diario. Registra almeno un trade per calcolare l\'audit.');
      setTimeout(() => setOptimizationNotification(null), 5000);
      return;
    }
    const dual = evaluateDualSystemOptimization(journalEntries, parameters, 15);
    setDualProposals(dual);
    pushSharedAppState({ dualProposals: dual });
    setOptimizationNotification('Audit del sistema ricalcolato sui trade presenti nel diario!');
    setTimeout(() => setOptimizationNotification(null), 4000);
  };

  // 7b. Excluded Setups Calibration Handlers (Next Session Improvement)
  const handleApplyExcludedCorrection = (
    paramKey: keyof SystemParameters,
    proposedValue: any,
    explanation: string
  ) => {
    let parsedVal = proposedValue;
    let newRsiActive = rsiFilterActive;
    if (paramKey === 'rsiFilterActive') {
      parsedVal = proposedValue === true || proposedValue === 'true' || proposedValue === 'Attivo';
      newRsiActive = parsedVal;
      setRsiFilterActive(parsedVal);
    } else if (typeof proposedValue === 'string') {
      if (proposedValue.includes('x')) parsedVal = parseFloat(proposedValue.replace('x', ''));
      else if (proposedValue.includes('%')) parsedVal = parseFloat(proposedValue.replace('%', ''));
      else if (proposedValue.includes('/100')) parsedVal = parseFloat(proposedValue.replace('/100', ''));
      else if (!isNaN(Number(proposedValue))) parsedVal = Number(proposedValue);
    }

    const updated: SystemParameters = {
      ...parameters,
      [paramKey]: parsedVal,
      lastUpdated: new Date().toISOString(),
      version: parameters.version + 1,
    };

    // 1. Immediately close the modal as requested
    setIsExcludedAnalyzerOpen(false);

    // 2. Persist immediately to state and localStorage
    setParameters(updated);
    localStorage.setItem('intraday_radar_parameters', JSON.stringify(updated));

    if (currentUser) {
      syncSystemSettingsToCloud(currentUser.uid, {
        parameters: updated,
        pendingProposal,
        accountCapital,
        isPaperMode,
      });
    }
    pushSharedAppState({ parameters: updated });

    // 3. Immediately re-evaluate setups, candidates and audit with newly applied filters
    const activeFut = futures;
    const euChange = activeFut?.europe?.dax?.changePercent ?? (activeFut?.europe?.eurostoxx?.changePercent ?? 0);
    const usChange = activeFut?.usa?.sp500?.changePercent ?? (activeFut?.usa?.nasdaq?.changePercent ?? 0);
    const futuresMapping = { EU: euChange, US: usChange };

    if (quotes.length > 0) {
      const dual = getDualTopCandidates(quotes, futuresMapping, {
        rsiFilterActive: newRsiActive,
        parameters: updated,
        catalystCache,
      });
      setTopCandidateEU(dual.topEU);
      setTopCandidateUS(dual.topUS);
      setTopCandidates(dual.allRanked);

      if (currentSession === 'US') {
        setSelectedCandidate(dual.topUS || dual.topEU);
      } else {
        setSelectedCandidate(dual.topEU || dual.topUS);
      }

      if (dual.topEU) {
        setSetupEU(buildExecutionSetup(dual.topEU, catalystCache[dual.topEU.quote.ticker] || null, 'EU', updated, { entryMode: getActiveEntryMode('EU'), macroEvents: macroCalendar?.events }));
      }
      if (dual.topUS) {
        setSetupUS(buildExecutionSetup(dual.topUS, catalystCache[dual.topUS.quote.ticker] || null, 'US', updated, { entryMode: getActiveEntryMode('US'), macroEvents: macroCalendar?.events }));
      }

      const audit = generateFilteringAuditReport(
        quotes,
        { topEU: dual.topEU, topUS: dual.topUS },
        futuresMapping,
        updated,
        catalystCache,
        newRsiActive,
        sessionInfo?.cet?.currentMinutes
      );
      setAuditReport(audit);
    }

    setOptimizationNotification(
      `⚙️ Calibrazione Applicata: ${String(paramKey)} impostato a ${parsedVal}! I filtri sono stati ricalcolati in tempo reale.`
    );
    setTimeout(() => setOptimizationNotification(null), 6000);
  };

  const handleApplyAllUrgentCorrections = () => {
    if (excludedAutoAnalysis.urgentCorrections.length === 0) return;

    let updated = { ...parameters };
    let newRsiActive = rsiFilterActive;

    excludedAutoAnalysis.urgentCorrections.forEach((corr) => {
      let val = corr.proposedValue;
      if (corr.parameterKey === 'rsiFilterActive') {
        val = val === true || val === 'true' || val === 'Attivo';
        newRsiActive = val;
        setRsiFilterActive(val);
      } else if (typeof val === 'string') {
        if (val.includes('x')) val = parseFloat(val.replace('x', ''));
        else if (val.includes('%')) val = parseFloat(val.replace('%', ''));
        else if (val.includes('/100')) val = parseFloat(val.replace('/100', ''));
        else if (!isNaN(Number(val))) val = Number(val);
      }
      updated = {
        ...updated,
        [corr.parameterKey]: val,
      };
    });
    updated.lastUpdated = new Date().toISOString();
    updated.version = parameters.version + 1;

    // 1. Immediately close the modal
    setIsExcludedAnalyzerOpen(false);

    // 2. Persist immediately to state and localStorage
    setParameters(updated);
    localStorage.setItem('intraday_radar_parameters', JSON.stringify(updated));

    if (currentUser) {
      syncSystemSettingsToCloud(currentUser.uid, {
        parameters: updated,
        pendingProposal,
        accountCapital,
        isPaperMode,
      });
    }
    pushSharedAppState({ parameters: updated });

    // 3. Immediately re-evaluate setups, candidates and audit with newly applied filters
    const activeFut = futures;
    const euChange = activeFut?.europe?.dax?.changePercent ?? (activeFut?.europe?.eurostoxx?.changePercent ?? 0);
    const usChange = activeFut?.usa?.sp500?.changePercent ?? (activeFut?.usa?.nasdaq?.changePercent ?? 0);
    const futuresMapping = { EU: euChange, US: usChange };

    if (quotes.length > 0) {
      const dual = getDualTopCandidates(quotes, futuresMapping, {
        rsiFilterActive: newRsiActive,
        parameters: updated,
        catalystCache,
      });
      setTopCandidateEU(dual.topEU);
      setTopCandidateUS(dual.topUS);
      setTopCandidates(dual.allRanked);

      if (currentSession === 'US') {
        setSelectedCandidate(dual.topUS || dual.topEU);
      } else {
        setSelectedCandidate(dual.topEU || dual.topUS);
      }

      if (dual.topEU) {
        setSetupEU(buildExecutionSetup(dual.topEU, catalystCache[dual.topEU.quote.ticker] || null, 'EU', updated, { entryMode: getActiveEntryMode('EU'), macroEvents: macroCalendar?.events }));
      }
      if (dual.topUS) {
        setSetupUS(buildExecutionSetup(dual.topUS, catalystCache[dual.topUS.quote.ticker] || null, 'US', updated, { entryMode: getActiveEntryMode('US'), macroEvents: macroCalendar?.events }));
      }

      const audit = generateFilteringAuditReport(
        quotes,
        { topEU: dual.topEU, topUS: dual.topUS },
        futuresMapping,
        updated,
        catalystCache,
        newRsiActive,
        sessionInfo?.cet?.currentMinutes
      );
      setAuditReport(audit);
    }

    setOptimizationNotification(
      `🚀 Applicate ${excludedAutoAnalysis.urgentCorrections.length} calibrazioni di filtro in tempo reale! Setup ricalcolati.`
    );
    setTimeout(() => setOptimizationNotification(null), 7000);
  };

  const handleClearExcludedRecords = () => {
    setExcludedRecords([]);
    localStorage.removeItem('intraday_radar_excluded_setups_v1');
    setOptimizationNotification('Registro setup esclusi azzerato.');
    setTimeout(() => setOptimizationNotification(null), 3000);
  };

  // Reset Server Cache
  const [cacheNotification, setCacheNotification] = useState<string | null>(null);

  const handleResetCache = async () => {
    try {
      await clearServerCache();
      setNewsCache({});
      setCatalystCache({});
      await handleRunScreening();
      setCacheNotification('Cache server svuotata con successo e dati di mercato riaggiornati.');
      setTimeout(() => setCacheNotification(null), 4000);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500/30 selection:text-emerald-200">
      {/* 1. Permanent Risk Disclaimer */}
      <RiskBanner />

      {/* 2. Platform Header with PWA install button and Real-time Cloud Sync */}
      <Header
        sessionInfo={sessionInfo}
        onOpenCsvManager={() => setIsCsvModalOpen(true)}
        underlyingsCount={underlyings.length}
        isPaperMode={isPaperMode}
        onTogglePaperMode={() => setIsPaperMode(!isPaperMode)}
        tradesTodayCount={tradesTodayCount}
        dailyPnlPercent={dailyPnlPercent}
        isCircuitBreakerActive={circuitBreakerActive}
        onResetCache={handleResetCache}
        currentSession={currentSession}
        isInstallable={installPrompt.ready}
        onInstallApp={installPrompt.trigger}
        onOpenContactModal={() => setIsContactModalOpen(true)}
        currentUser={currentUser}
        cloudSyncStatus={cloudSyncStatus}
        onSignInGoogle={handleSignInGoogle}
        onSignOut={handleSignOut}
      />

      {/* Main Trading Terminal Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-6">
        {/* Error Notification if any */}
        {scanError && (
          <div className="mb-6 p-4 rounded-xl bg-rose-950/40 border border-rose-800 text-rose-300 text-xs">
            <p className="font-semibold">{scanError}</p>
          </div>
        )}

        {/* Cache Reset Notification */}
        {cacheNotification && (
          <div className="mb-6 p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-800 text-emerald-300 text-xs font-mono flex items-center justify-between animate-fadeIn">
            <span>✓ {cacheNotification}</span>
            <button
              onClick={() => setCacheNotification(null)}
              className="text-emerald-400 hover:text-white text-xs cursor-pointer ml-3"
            >
              Chiudi
            </button>
          </div>
        )}

        {/* Self-Optimization Notification Toast */}
        {optimizationNotification && (
          <div className="mb-6 p-3.5 rounded-xl bg-amber-950/50 border border-amber-500/60 text-amber-200 text-xs font-mono flex items-center justify-between animate-fadeIn shadow-lg shadow-amber-950/30">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
              <span>{optimizationNotification}</span>
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsOptimizerModalOpen(true)}
                className="px-2.5 py-1 rounded bg-amber-500 text-slate-950 font-bold hover:bg-amber-400 transition-colors text-[11px] cursor-pointer"
              >
                Vedi Proposta
              </button>
              <button
                onClick={() => setOptimizationNotification(null)}
                className="text-amber-400 hover:text-white text-xs cursor-pointer ml-2"
              >
                Chiudi
              </button>
            </div>
          </div>
        )}

        {/* 2.5. Visual Filtering Audit Banner (3-5s transient notification explaining candidate exclusions) */}
        {showAuditBanner && (
          <FilteringAuditBanner
            report={auditReport}
            durationMs={4500}
            onOpenDetailsModal={() => setIsAuditModalOpen(true)}
            onOpenExcludedAnalyzer={() => setIsExcludedAnalyzerOpen(true)}
            onDismiss={() => setShowAuditBanner(false)}
          />
        )}

        {/* 2.8. Macroeconomic High-Impact Event & Knock-Out Spread Guard Banner */}
        <MacroCalendarBanner macroCalendar={macroCalendar} />

        {/* 3. Daily Circuit Breaker Alert (Blocking Rule) */}
        <DailyCircuitBreakerBanner
          isTriggered={circuitBreakerActive}
          reason={circuitBreakerReason}
          tradesTodayCount={tradesTodayCount}
          dailyPnlPercent={dailyPnlPercent}
        />

        {/* 3.5. System Adaptive Self-Optimization Banner (20 Setups Cycle) */}
        <SystemOptimizationBanner
          proposal={pendingProposal}
          parameters={parameters}
          totalCompletedSetups={journalEntries.length}
          onOpenAuditModal={() => setIsOptimizerModalOpen(true)}
        />

        {/* 4. Screening Controls (Mode Selector, Benchmark Futures, Scan CTA) */}
        <ScreeningControls
          currentSession={currentSession}
          onSelectSession={(sess) => {
            setCurrentSession(sess);
            // Trigger automatic re-scan for selected session
            setTimeout(() => handleRunScreening(), 50);
          }}
          futures={futures}
          quotes={quotes}
          activeSetup={currentSession === 'US' ? setupUS : setupEU}
          isScanning={isScanning}
          onRunScan={handleRunScreening}
          cachedAt={cachedAt}
          totalUnderlyingsForSession={activeUnderlyingsForSession.length}
          circuitBreakerActive={circuitBreakerActive}
          isAutoRefresh={isAutoRefresh}
          onToggleAutoRefresh={() => setIsAutoRefresh(!isAutoRefresh)}
          autoRefreshCountdown={autoRefreshCountdown}
          rsiFilterActive={rsiFilterActive}
          onToggleRsiFilter={() => setRsiFilterActive((prev) => !prev)}
          auditReport={auditReport}
          onOpenAuditModal={() => setIsAuditModalOpen(true)}
          onOpenExcludedAnalyzer={() => setIsExcludedAnalyzerOpen(true)}
          excludedProfitCount={excludedAutoAnalysis.totalProfitable}
        />

        {/* 5. Dual Hero Execution Cards: Affiancate Top EU e Top USA */}
        <DualExecutionHero
          setupEU={setupEU}
          setupUS={setupUS}
          candidateEU={topCandidateEU}
          candidateUS={topCandidateUS}
          accountCapital={accountCapital}
          onUpdateAccountCapital={setAccountCapital}
          onSaveToJournal={handleAddJournalTrade}
          onViewCatalyst={handleOpenCatalystModal}
          isPaperMode={isPaperMode}
          circuitBreakerActive={circuitBreakerActive}
          currentSession={currentSession}
          freezeStateEU={freezeStateEU}
          freezeStateUS={freezeStateUS}
          onToggleFreezeEU={handleToggleFreezeEU}
          onToggleFreezeUS={handleToggleFreezeUS}
        />

        {/* 6. Intraday Live Radar: Titoli a Mercati Aperti con Filtri e ATR Esteso */}
        <TopCandidatesTable
          candidates={topCandidates}
          selectedCandidate={selectedCandidate}
          onSelectCandidate={handleSelectCandidate}
          onViewCatalyst={handleOpenCatalystModal}
          isLoadingNewsFor={loadingNewsTicker}
          topEU={topCandidateEU}
          topUS={topCandidateUS}
        />

        {/* 6.5. Benchmark Correlation & Relative Strength Heatmap (DAX, EuroStoxx, S&P 500, Nasdaq) */}
        <BenchmarkCorrelationHeatmap
          candidates={topCandidates}
          futures={futures}
          onSelectCandidate={handleSelectCandidate}
          onViewCatalyst={handleOpenCatalystModal}
        />

        {/* 6.8. Analisi Stagionalità Intraday • Pattern Temporali & Finestre Orarie d'Oro */}
        <IntradaySeasonalityAnalysis
          entries={journalEntries}
          currentCetMinutes={sessionInfo?.cet?.currentMinutes}
          currentSession={currentSession}
        />

        {/* 7. Trade Journal with Risk Management, Expired Tracking & Self-Optimization */}
        <TradeJournal
          entries={journalEntries}
          quotes={quotes}
          onAddEntry={handleAddJournalTrade}
          onUpdateEntry={handleUpdateJournalTrade}
          onDeleteEntry={handleDeleteJournalTrade}
          onClearAll={handleClearJournal}
          accountCapital={accountCapital}
          isPaperMode={isPaperMode}
          onOpenOptimizerModal={() => setIsOptimizerModalOpen(true)}
          optimizationProposal={pendingProposal}
          currentUser={currentUser}
          onSignInGoogle={handleSignInGoogle}
        />
      </main>

      {/* Modals */}
      <SystemOptimizerModal
        isOpen={isOptimizerModalOpen}
        onClose={() => setIsOptimizerModalOpen(false)}
        proposal={pendingProposal}
        dualProposals={dualProposals}
        currentParameters={parameters}
        onAcceptProposal={handleAcceptProposal}
        onRejectProposal={handleRejectProposal}
        onRunAuditOnDemand={handleRunAuditOnDemand}
        trades={journalEntries}
      />
      <FilteringAuditModal
        isOpen={isAuditModalOpen}
        onClose={() => setIsAuditModalOpen(false)}
        report={auditReport}
        onOpenOptimizerModal={() => setIsOptimizerModalOpen(true)}
        onOpenExcludedAnalyzer={() => setIsExcludedAnalyzerOpen(true)}
      />
      <ExcludedSetupsAnalyzerModal
        isOpen={isExcludedAnalyzerOpen}
        onClose={() => setIsExcludedAnalyzerOpen(false)}
        analysis={excludedAutoAnalysis}
        records={excludedRecords}
        currentParameters={parameters}
        onApplyCorrection={handleApplyExcludedCorrection}
        onApplyAllUrgentCorrections={handleApplyAllUrgentCorrections}
        onClearRecords={handleClearExcludedRecords}
        accountCapital={accountCapital}
        trades={journalEntries}
      />
      <CsvManagerModal
        isOpen={isCsvModalOpen}
        onClose={() => setIsCsvModalOpen(false)}
        underlyings={underlyings}
        onUpdateUnderlyings={(newItems) => {
          setUnderlyings(newItems);
          if (currentUser) {
            syncSystemSettingsToCloud(currentUser.uid, {
              parameters,
              pendingProposal,
              accountCapital,
              isPaperMode,
              underlyings: newItems,
            });
          }
        }}
      />

      <CatalystModal
        isOpen={isCatalystModalOpen}
        onClose={() => setIsCatalystModalOpen(false)}
        candidate={activeCatalystCandidate}
        news={activeCatalystCandidate ? newsCache[activeCatalystCandidate.quote.ticker] || [] : []}
        catalyst={activeCatalystCandidate ? catalystCache[activeCatalystCandidate.quote.ticker] || null : null}
        isLoading={isLoadingCatalyst}
        onReanalyze={handleReanalyzeActiveCatalyst}
      />

      {/* Creator Profile & Contact Modal */}
      <CreatorContactModal
        isOpen={isContactModalOpen}
        onClose={() => setIsContactModalOpen(false)}
      />

      {/* 8. PWA Service Worker Update Listener & Install Notification */}
      <PwaUpdatePrompt
        onInstallReady={(ready, trigger) => {
          setInstallPrompt({ ready, trigger });
        }}
      />

      {/* Footer & Demo Legal Notice */}
      <footer className="bg-slate-950 border-t border-slate-900 py-8 text-xs text-slate-400">
        <div className="max-w-7xl mx-auto px-4 space-y-4">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 pb-4 border-b border-slate-900">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold font-mono text-sm">
                CB
              </div>
              <div>
                <p className="font-semibold text-slate-200">
                  Ideato e Sviluppato da Christian Battistoni
                </p>
                <p className="text-[11px] text-slate-400">
                  AI Orchestrator & AI Prompt Engineer • Vibe Coding Specialist
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setIsContactModalOpen(true)}
                className="px-3 py-1.5 rounded-lg bg-indigo-950/60 hover:bg-indigo-900/80 border border-indigo-700/60 text-indigo-300 text-xs font-medium transition-colors cursor-pointer"
              >
                Contatta Christian Battistoni
              </button>
              <a
                href="mailto:christian.battistoni.eu@gmail.com"
                className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs font-mono transition-colors"
              >
                christian.battistoni.eu@gmail.com
              </a>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-[11px] leading-relaxed text-slate-400">
            <div>
              <p className="font-semibold text-slate-300 mb-1">
                ⚠️ Natura Dimostrativa (DEMO) & Esclusione Consulenza Finanziaria:
              </p>
              <p>
                Questa piattaforma è esclusivamente un'applicazione dimostrativa (DEMO) creata a scopo tecnologico, formativo e di portfolio per mostrare le capacità di sviluppo software tramite Vibe Coding avanzato, integrazione di modelli di intelligenza artificiale (Google Gemini) e orchestrazione di prompt complessi. <strong>Christian Battistoni non effettua alcun tipo di consulenza finanziaria</strong>, raccomandazione d'investimento personalizzata o gestione del risparmio.
              </p>
            </div>
            <div>
              <p className="font-semibold text-slate-300 mb-1">
                Risk Governance & Dati di Mercato:
              </p>
              <p>
                I derivati a leva (come certificati Turbo Knock-Out e CFD) comportano un elevato rischio di perdita del capitale. Il sistema applica regole rigorose di gestione del rischio (massimo 2 operazioni giornaliere, circuit breaker su perdita giornaliera del -2% del capitale, stop-loss tassativi). Dati e quotazioni sono sincronizzati in tempo reale dai mercati di riferimento.
              </p>
            </div>
          </div>

          <div className="pt-2 text-center text-[10px] text-slate-400 font-mono">
            Intraday Radar Pro • Open Source GitHub Ready • Zero Hardcoded API Keys
          </div>
        </div>
      </footer>
    </div>
  );
}
