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
} from './types/radar';
import { DEFAULT_TRADE_REPUBLIC_UNDERLYINGS } from './data/defaultUnderlyings';
import { SAMPLE_JOURNAL_ENTRIES } from './data/sampleTrades';
import {
  getDualTopCandidates,
  buildExecutionSetup,
  DEFAULT_SYSTEM_PARAMETERS,
  evaluateSystemOptimization,
} from './utils/calculator';
import {
  fetchSessionInfo,
  fetchBenchmarkFutures,
  fetchMarketData,
  fetchTickerNews,
  analyzeCatalystWithGemini,
  clearServerCache,
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
import { User, onAuthStateChanged } from 'firebase/auth';

import { RiskBanner } from './components/RiskBanner';
import { Header } from './components/Header';
import { ScreeningControls } from './components/ScreeningControls';
import { DailyCircuitBreakerBanner } from './components/DailyCircuitBreakerBanner';
import { SystemOptimizationBanner } from './components/SystemOptimizationBanner';
import { DualExecutionHero } from './components/DualExecutionHero';
import { TopCandidatesTable } from './components/TopCandidatesTable';
import { TradeJournal } from './components/TradeJournal';
import { CsvManagerModal } from './components/CsvManagerModal';
import { CatalystModal } from './components/CatalystModal';
import { CreatorContactModal } from './components/CreatorContactModal';
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt';
import { SystemOptimizerModal } from './components/SystemOptimizerModal';

export default function App() {
  // 1. Underlyings State (strictly Trade Republic KO list)
  const [underlyings, setUnderlyings] = useState<UnderlyingItem[]>(() => {
    try {
      const saved = localStorage.getItem('intraday_radar_underlyings');
      if (saved) return JSON.parse(saved);
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
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // fallback
    }
    return SAMPLE_JOURNAL_ENTRIES;
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
  const [parameters, setParameters] = useState<SystemParameters>(() => {
    try {
      const saved = localStorage.getItem('intraday_radar_parameters');
      if (saved) return JSON.parse(saved);
    } catch {
      // fallback
    }
    return DEFAULT_SYSTEM_PARAMETERS;
  });

  const [pendingProposal, setPendingProposal] = useState<OptimizationProposal | null>(() => {
    try {
      const saved = localStorage.getItem('intraday_radar_pending_proposal');
      if (saved) return JSON.parse(saved);
    } catch {
      // fallback
    }
    // Calculate initial proposal on default sample trades if present
    if (SAMPLE_JOURNAL_ENTRIES.length >= 20) {
      return evaluateSystemOptimization(SAMPLE_JOURNAL_ENTRIES, DEFAULT_SYSTEM_PARAMETERS, 1);
    }
    return null;
  });

  const [isOptimizerModalOpen, setIsOptimizerModalOpen] = useState<boolean>(false);
  const [optimizationNotification, setOptimizationNotification] = useState<string | null>(null);

  // 6b. Firebase Cloud Sync & Cross-Device Authentication State
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [cloudSyncStatus, setCloudSyncStatus] = useState<'LOCAL_ONLY' | 'SYNCED' | 'SYNCING'>('LOCAL_ONLY');

  // Sync parameters & proposal to localStorage
  useEffect(() => {
    localStorage.setItem('intraday_radar_parameters', JSON.stringify(parameters));
  }, [parameters]);

  useEffect(() => {
    if (pendingProposal) {
      localStorage.setItem('intraday_radar_pending_proposal', JSON.stringify(pendingProposal));
    } else {
      localStorage.removeItem('intraday_radar_pending_proposal');
    }
  }, [pendingProposal]);

  // Real-time Cloud Sync with Firebase across PC, Mobile, and Tablet
  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (user) {
        setCloudSyncStatus('SYNCING');
        const unsubData = subscribeToUserCloudData(
          user.uid,
          (cloudSettings) => {
            if (cloudSettings.parameters) {
              setParameters(cloudSettings.parameters);
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
            setCloudSyncStatus('SYNCED');
          },
          (cloudTrades) => {
            if (cloudTrades.length > 0) {
              setJournalEntries(cloudTrades);
            } else {
              // If cloud is newly initialized, migrate existing local trades
              if (journalEntries.length > 0) {
                batchUploadTradesToCloud(user.uid, journalEntries);
                syncSystemSettingsToCloud(user.uid, {
                  parameters,
                  pendingProposal,
                  accountCapital,
                  isPaperMode,
                });
              }
            }
            setCloudSyncStatus('SYNCED');
          }
        );
        return () => unsubData();
      } else {
        setCloudSyncStatus('LOCAL_ONLY');
      }
    });

    return () => unsubAuth();
  }, []);

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

  // Initial load: session clock, futures, auto-screening
  useEffect(() => {
    const initApp = async () => {
      try {
        const [sess, futs] = await Promise.all([
          fetchSessionInfo(),
          fetchBenchmarkFutures(),
        ]);
        setSessionInfo(sess);
        setFutures(futs);
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
    if (catalystCache[ticker]) return catalystCache[ticker];

    try {
      let newsItems = newsCache[ticker];
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
  const handleRunScreening = useCallback(async () => {
    if (underlyings.length === 0) {
      setScanError('Nessun sottostante caricato nel paniere. Aggiungine nel gestore CSV.');
      return;
    }

    setIsScanning(true);
    setScanError(null);
    setAutoRefreshCountdown(20);

    try {
      // 1. Fetch live quotes and fresh futures simultaneously
      const [freshFutures, rawQuotes] = await Promise.all([
        fetchBenchmarkFutures(true).catch(() => futures),
        fetchMarketData(underlyings, true),
      ]);

      if (freshFutures) {
        setFutures(freshFutures);
      }
      setQuotes(rawQuotes);
      setCachedAt(new Date().toISOString());

      // 2. Identify relevant benchmark futures for each market
      const activeFut = freshFutures || futures;
      const euChange = activeFut?.europe?.dax?.changePercent ?? (activeFut?.europe?.eurostoxx?.changePercent ?? 0);
      const usChange = activeFut?.usa?.sp500?.changePercent ?? (activeFut?.usa?.nasdaq?.changePercent ?? 0);
      const futuresMapping = { EU: euChange, US: usChange };

      // 3. Dual-Market Ranking: Top 1 Europe, Top 1 USA, and All Ranked
      const dual = getDualTopCandidates(rawQuotes, futuresMapping, { rsiFilterActive, parameters });

      setTopCandidateEU(dual.topEU);
      setTopCandidateUS(dual.topUS);
      setTopCandidates(dual.allRanked);

      // Select default candidate
      if (currentSession === 'US') {
        setSelectedCandidate(dual.topUS || dual.topEU);
      } else {
        setSelectedCandidate(dual.topEU || dual.topUS);
      }

      // 4. Concurrently analyze catalysts & build execution setups for both Top picks
      const [catEU, catUS] = await Promise.all([
        resolveCandidateCatalyst(dual.topEU, activeFut?.europe),
        resolveCandidateCatalyst(dual.topUS, activeFut?.usa),
      ]);

      setSetupEU(buildExecutionSetup(dual.topEU, catEU, 'EU', parameters));
      setSetupUS(buildExecutionSetup(dual.topUS, catUS, 'US', parameters));
    } catch (err: any) {
      setScanError(`Errore durante il recupero dei dati di mercato: ${err.message || 'Controlla la connessione'}`);
    } finally {
      setIsScanning(false);
    }
  }, [underlyings, currentSession, futures, rsiFilterActive, parameters]);

  // Re-rank instantly when RSI Filter or parameters are changed
  useEffect(() => {
    if (quotes.length === 0) return;
    const activeFut = futures;
    const euChange = activeFut?.europe?.dax?.changePercent ?? (activeFut?.europe?.eurostoxx?.changePercent ?? 0);
    const usChange = activeFut?.usa?.sp500?.changePercent ?? (activeFut?.usa?.nasdaq?.changePercent ?? 0);
    const futuresMapping = { EU: euChange, US: usChange };

    const dual = getDualTopCandidates(quotes, futuresMapping, { rsiFilterActive, parameters });
    setTopCandidateEU(dual.topEU);
    setTopCandidateUS(dual.topUS);
    setTopCandidates(dual.allRanked);

    if (currentSession === 'US') {
      setSelectedCandidate(dual.topUS || dual.topEU);
    } else {
      setSelectedCandidate(dual.topEU || dual.topUS);
    }

    Promise.all([
      resolveCandidateCatalyst(dual.topEU, activeFut?.europe),
      resolveCandidateCatalyst(dual.topUS, activeFut?.usa),
    ]).then(([catEU, catUS]) => {
      setSetupEU(buildExecutionSetup(dual.topEU, catEU, 'EU', parameters));
      setSetupUS(buildExecutionSetup(dual.topUS, catUS, 'US', parameters));
    });
  }, [rsiFilterActive, parameters]);

  // Auto-refresh interval (Real-time live monitoring)
  useEffect(() => {
    if (!isAutoRefresh || circuitBreakerActive) return;

    const timer = setInterval(() => {
      setAutoRefreshCountdown((prev) => {
        if (prev <= 1) {
          handleRunScreening();
          return 20;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isAutoRefresh, circuitBreakerActive, handleRunScreening]);

  // Run initial scan once futures are available
  useEffect(() => {
    if (futures && topCandidates.length === 0) {
      handleRunScreening();
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
      if (topCandidateEU?.quote.ticker === ticker) {
        setSetupEU(buildExecutionSetup(cand, res, 'EU', parameters));
      }
      if (topCandidateUS?.quote.ticker === ticker) {
        setSetupUS(buildExecutionSetup(cand, res, 'US', parameters));
      }
    } catch (err) {
      console.error('Errore rianalisi:', err);
    } finally {
      setIsLoadingCatalyst(false);
    }
  };

  // Select alternative candidate from Live Radar and promote to setup
  const handleSelectCandidate = async (cand: ScoredCandidate) => {
    setSelectedCandidate(cand);
    const existingCat = catalystCache[cand.quote.ticker] || null;
    const market = cand.quote.market;
    const newSetup = buildExecutionSetup(cand, existingCat, market, parameters);

    if (market === 'EU') {
      setTopCandidateEU(cand);
      setSetupEU(newSetup);
    } else {
      setTopCandidateUS(cand);
      setSetupUS(newSetup);
    }
  };

  // Journal Actions
  const handleAddJournalTrade = (tradeData: any) => {
    const initialOutcome = tradeData.outcome || 'OPEN';
    let pnlEur = tradeData.pnlEur != null ? tradeData.pnlEur : 0;
    let rMultiple = tradeData.rMultiple != null ? tradeData.rMultiple : 0;
    let exitPrice = tradeData.exitPrice || tradeData.target1 || 102;
    let status: 'OPEN' | 'CLOSED' = initialOutcome === 'OPEN' ? 'OPEN' : 'CLOSED';

    if (initialOutcome === 'WIN') {
      exitPrice = tradeData.target1 || tradeData.entryPrice * 1.02;
      rMultiple = +(parameters.target1Multiplier || 1.6).toFixed(2);
      pnlEur = tradeData.potentialGainT1Eur != null ? tradeData.potentialGainT1Eur : +(100 * rMultiple).toFixed(2);
    } else if (initialOutcome === 'LOSS') {
      exitPrice = tradeData.stopLoss || tradeData.entryPrice * 0.98;
      rMultiple = -1.0;
      pnlEur = -(tradeData.maxRiskEur != null ? tradeData.maxRiskEur : 100);
    } else if (initialOutcome === 'EXPIRED') {
      exitPrice = tradeData.entryPrice || 100;
      rMultiple = 0;
      pnlEur = -2.0; // fee friction
    } else if (initialOutcome === 'BREAKEVEN') {
      exitPrice = tradeData.entryPrice || 100;
      rMultiple = 0;
      pnlEur = -2.0;
    }

    const entry: TradeJournalEntry = {
      id: `trade-${Date.now()}`,
      timestamp: new Date().toISOString(),
      date: new Date().toLocaleDateString('it-IT'),
      session: tradeData.session,
      ticker: tradeData.ticker,
      direction: tradeData.direction,
      strategy: tradeData.strategy,
      entryPrice: tradeData.entryPrice || 100,
      exitPrice,
      stopLoss: tradeData.stopLoss || 98,
      target1: tradeData.target1 || 103,
      pnlEur,
      rMultiple,
      outcome: initialOutcome === 'OPEN' ? 'BREAKEVEN' : initialOutcome,
      status,
      closedAt: status === 'CLOSED' ? new Date().toISOString() : undefined,
      notes:
        tradeData.notes ||
        (initialOutcome === 'OPEN'
          ? `KO Strike ${tradeData.barrierStrike} | Leva ${tradeData.leverage}x | ${tradeData.suggestedCertificates} quote. In monitoraggio attivo.`
          : initialOutcome === 'WIN'
          ? `Target 1 (+${rMultiple}R) raggiunto con successo. Guadagno netto +${pnlEur} €.`
          : initialOutcome === 'LOSS'
          ? `Stop loss eseguito a protezione del capitale. Perdita controllata ${pnlEur} €.`
          : initialOutcome === 'EXPIRED'
          ? `Setup scaduto al cutoff orario senza rottura trigger né stop.`
          : `Chiuso a pareggio.`),
      isPaper: tradeData.isPaper,
    };

    setJournalEntries((prev) => {
      const updated = [entry, ...prev];
      const completedCount = updated.filter((t) => t.status !== 'OPEN').length;
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
    setJournalEntries((prev) => prev.filter((item) => item.id !== id));
    if (currentUser) {
      deleteTradeFromCloud(currentUser.uid, id);
    }
  };

  const handleClearJournal = () => {
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
  const handleAcceptProposal = () => {
    if (!pendingProposal || pendingProposal.proposedChanges.length === 0) return;

    const newParams: SystemParameters = {
      ...parameters,
      version: parameters.version + 1,
      lastUpdated: new Date().toISOString(),
    };

    pendingProposal.proposedChanges.forEach((change) => {
      if (change.parameterKey === 'minScore') {
        newParams.minScore = typeof change.proposedValue === 'number' ? change.proposedValue : parseInt(String(change.proposedValue)) || newParams.minScore;
      } else if (change.parameterKey === 'minRvol') {
        newParams.minRvol = typeof change.proposedValue === 'number' ? change.proposedValue : parseFloat(String(change.proposedValue)) || newParams.minRvol;
      } else if (change.parameterKey === 'target1Multiplier') {
        newParams.target1Multiplier = typeof change.proposedValue === 'number' ? change.proposedValue : parseFloat(String(change.proposedValue)) || newParams.target1Multiplier;
      } else if (change.parameterKey === 'target2Multiplier') {
        newParams.target2Multiplier = typeof change.proposedValue === 'number' ? change.proposedValue : parseFloat(String(change.proposedValue)) || newParams.target2Multiplier;
      } else if (change.parameterKey === 'triggerOffsetPercent') {
        newParams.triggerOffsetPercent = typeof change.proposedValue === 'number' ? change.proposedValue : parseFloat(String(change.proposedValue)) || newParams.triggerOffsetPercent;
      } else if (change.parameterKey === 'normalRiskMultiplier') {
        newParams.normalRiskMultiplier = typeof change.proposedValue === 'number' ? change.proposedValue : parseFloat(String(change.proposedValue)) || newParams.normalRiskMultiplier;
      } else if (change.parameterKey === 'rsiFilterActive') {
        newParams.rsiFilterActive = change.proposedValue === true || change.proposedValue === 'Attivo';
        setRsiFilterActive(newParams.rsiFilterActive);
      } else if (change.parameterKey === 'minGapEurope') {
        newParams.minGapEurope = typeof change.proposedValue === 'number' ? change.proposedValue : parseFloat(String(change.proposedValue)) || newParams.minGapEurope;
      } else if (change.parameterKey === 'minGapUSA') {
        newParams.minGapUSA = typeof change.proposedValue === 'number' ? change.proposedValue : parseFloat(String(change.proposedValue)) || newParams.minGapUSA;
      }
    });

    const acceptedProposal: OptimizationProposal = {
      ...pendingProposal,
      status: 'ACCEPTED',
      appliedAt: new Date().toISOString(),
    };

    setParameters(newParams);
    setPendingProposal(acceptedProposal);
    setOptimizationNotification(`Parametri aggiornati alla Versione V${newParams.version}! Nuovi calcoli attivi.`);
    setTimeout(() => setOptimizationNotification(null), 6000);

    // Sync accepted parameters & proposal to Cloud
    if (currentUser) {
      syncSystemSettingsToCloud(currentUser.uid, {
        parameters: newParams,
        pendingProposal: acceptedProposal,
        accountCapital,
        isPaperMode,
      });
    }

    // Refresh setups immediately
    if (topCandidateEU) {
      setSetupEU(buildExecutionSetup(topCandidateEU, catalystCache[topCandidateEU.quote.ticker] || null, 'EU', newParams));
    }
    if (topCandidateUS) {
      setSetupUS(buildExecutionSetup(topCandidateUS, catalystCache[topCandidateUS.quote.ticker] || null, 'US', newParams));
    }
  };

  const handleRejectProposal = () => {
    if (!pendingProposal) return;
    const rejectedProposal: OptimizationProposal = {
      ...pendingProposal,
      status: 'REJECTED',
    };
    setPendingProposal(rejectedProposal);
    setOptimizationNotification(`Proposta di ottimizzazione rifiutata. Parametri V${parameters.version} mantenuti invariati.`);
    setTimeout(() => setOptimizationNotification(null), 5000);

    // Sync rejected status to Cloud
    if (currentUser) {
      syncSystemSettingsToCloud(currentUser.uid, {
        parameters,
        pendingProposal: rejectedProposal,
        accountCapital,
        isPaperMode,
      });
    }
  };

  const handleRunAuditOnDemand = () => {
    const listToAudit = journalEntries.length > 0 ? journalEntries : SAMPLE_JOURNAL_ENTRIES;
    const cycleNum = Math.max(1, Math.floor(listToAudit.length / 20));
    const prop = evaluateSystemOptimization(listToAudit, parameters, cycleNum);
    setPendingProposal(prop);
    setOptimizationNotification(`Audit calcolato sui ${Math.min(20, listToAudit.length)} setup del ciclo.`);
    setTimeout(() => setOptimizationNotification(null), 5000);
  };

  const handleLoadSampleTrades = () => {
    setJournalEntries(SAMPLE_JOURNAL_ENTRIES);
    const prop = evaluateSystemOptimization(SAMPLE_JOURNAL_ENTRIES, parameters, 1);
    setPendingProposal(prop);
    setOptimizationNotification('Caricati 20 setup storici completi nel diario (inclusi 4 Expired). Audit del ciclo pronto!');
    setTimeout(() => setOptimizationNotification(null), 6000);
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

        {/* 7. Trade Journal with Risk Management, Expired Tracking & Self-Optimization */}
        <TradeJournal
          entries={journalEntries}
          onAddEntry={(entry) => setJournalEntries((prev) => [entry, ...prev])}
          onUpdateEntry={handleUpdateJournalTrade}
          onDeleteEntry={handleDeleteJournalTrade}
          onClearAll={handleClearJournal}
          accountCapital={accountCapital}
          isPaperMode={isPaperMode}
          onLoadSampleTrades={handleLoadSampleTrades}
          onOpenOptimizerModal={() => setIsOptimizerModalOpen(true)}
          optimizationProposal={pendingProposal}
        />
      </main>

      {/* Modals */}
      <SystemOptimizerModal
        isOpen={isOptimizerModalOpen}
        onClose={() => setIsOptimizerModalOpen(false)}
        proposal={pendingProposal}
        currentParameters={parameters}
        onAcceptProposal={handleAcceptProposal}
        onRejectProposal={handleRejectProposal}
        onRunAuditOnDemand={handleRunAuditOnDemand}
        trades={journalEntries}
      />
      <CsvManagerModal
        isOpen={isCsvModalOpen}
        onClose={() => setIsCsvModalOpen(false)}
        underlyings={underlyings}
        onUpdateUnderlyings={(newItems) => {
          setUnderlyings(newItems);
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
