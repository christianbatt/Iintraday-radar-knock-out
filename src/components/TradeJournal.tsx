import React, { useState } from 'react';
import {
  TradeJournalEntry,
  OptimizationProposal,
  RawQuoteData,
} from '../types/radar';
import {
  BookOpen,
  Plus,
  Trash2,
  Download,
  Award,
  BarChart2,
  List,
  LayoutGrid,
  Sparkles,
  CheckCircle2,
  XCircle,
  MinusCircle,
  TrendingUp,
  Clock,
  Sliders,
  AlertTriangle,
  Zap,
  Target,
  Cloud,
  Smartphone,
} from 'lucide-react';
import { User } from 'firebase/auth';
import { PerformanceSummary } from './PerformanceSummary';
import { HistoricalEquityDashboard } from './HistoricalEquityDashboard';

interface TradeJournalProps {
  entries: TradeJournalEntry[];
  quotes?: RawQuoteData[];
  onAddEntry: (entry: TradeJournalEntry) => void;
  onUpdateEntry?: (entry: TradeJournalEntry) => void;
  onDeleteEntry: (id: string) => void;
  onClearAll: () => void;
  accountCapital: number;
  isPaperMode: boolean;
  onOpenOptimizerModal?: () => void;
  optimizationProposal?: OptimizationProposal | null;
  currentUser?: User | null;
  onSignInGoogle?: () => void;
}

export const TradeJournal: React.FC<TradeJournalProps> = ({
  entries,
  quotes = [],
  onAddEntry,
  onUpdateEntry,
  onDeleteEntry,
  onClearAll,
  accountCapital,
  isPaperMode,
  onOpenOptimizerModal,
  optimizationProposal,
  currentUser,
  onSignInGoogle,
}) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [filterMode, setFilterMode] = useState<'ALL' | 'PAPER' | 'REAL'>('ALL');
  const [outcomeFilter, setOutcomeFilter] = useState<'ALL' | 'OPEN' | 'WIN' | 'LOSS' | 'BREAKEVEN' | 'EXPIRED'>('ALL');
  const [viewMode, setViewMode] = useState<'EQUITY' | 'SUMMARY' | 'TABLE' | 'BOTH'>('BOTH');

  // New trade manual entry state
  const [ticker, setTicker] = useState('');
  const [session, setSession] = useState<'EU' | 'US'>('EU');
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [strategy, setStrategy] = useState('Opening Range Breakout (5m / 15m)');
  const [entryPrice, setEntryPrice] = useState<number>(100);
  const [exitPrice, setExitPrice] = useState<number>(102);
  const [stopLoss, setStopLoss] = useState<number>(98.5);
  const [target1, setTarget1] = useState<number>(103);
  const [pnlEur, setPnlEur] = useState<number>(150);
  const [manualOutcome, setManualOutcome] = useState<'AUTO' | 'WIN' | 'LOSS' | 'BREAKEVEN' | 'EXPIRED'>('AUTO');
  const [notes, setNotes] = useState('');

  const filteredEntries = entries.filter((e) => {
    if (filterMode === 'PAPER' && !e.isPaper) return false;
    if (filterMode === 'REAL' && e.isPaper) return false;
    if (outcomeFilter === 'OPEN') return e.status === 'OPEN';
    if (outcomeFilter !== 'ALL' && e.outcome !== outcomeFilter) return false;
    return true;
  });

  // Calculate Key Performance Indicators (KPI)
  const totalTrades = filteredEntries.length;
  const wins = filteredEntries.filter((e) => e.outcome === 'WIN');
  const losses = filteredEntries.filter((e) => e.outcome === 'LOSS');
  const breakevens = filteredEntries.filter((e) => e.outcome === 'BREAKEVEN');
  const expired = filteredEntries.filter((e) => e.outcome === 'EXPIRED');

  const winRate = totalTrades > 0 ? +((wins.length / totalTrades) * 100).toFixed(1) : 0;
  const expiredRate = totalTrades > 0 ? +((expired.length / totalTrades) * 100).toFixed(1) : 0;

  const totalGainsEur = wins.reduce((acc, curr) => acc + curr.pnlEur, 0);
  const totalLossesEur = Math.abs(losses.reduce((acc, curr) => acc + curr.pnlEur, 0));
  const profitFactor =
    totalLossesEur > 0
      ? +(totalGainsEur / totalLossesEur).toFixed(2)
      : totalGainsEur > 0
      ? 99.9
      : 0;

  const netPnlEur = +(filteredEntries.reduce((acc, curr) => acc + curr.pnlEur, 0)).toFixed(2);
  const netPnlPercent = accountCapital > 0 ? +((netPnlEur / accountCapital) * 100).toFixed(2) : 0;

  const avgR =
    totalTrades > 0
      ? +(filteredEntries.reduce((acc, curr) => acc + curr.rMultiple, 0) / totalTrades).toFixed(2)
      : 0;

  // Compute Maximum Drawdown
  let peak = 0;
  let runningPnl = 0;
  let maxDdEur = 0;
  for (const t of filteredEntries) {
    runningPnl += t.pnlEur;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDdEur) maxDdEur = dd;
  }
  const maxDdPercent = accountCapital > 0 ? +((maxDdEur / accountCapital) * 100).toFixed(1) : 0;

  const handleCreateEntry = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticker.trim()) return;

    const riskDistance = Math.abs(entryPrice - stopLoss) || 1;
    const gainedDistance = direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
    let rMultiple = +(gainedDistance / riskDistance).toFixed(2);

    let finalOutcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'EXPIRED' = 'BREAKEVEN';
    let finalPnl = pnlEur;
    let finalExitPrice = exitPrice;

    if (manualOutcome === 'AUTO') {
      if (pnlEur > 2) finalOutcome = 'WIN';
      else if (pnlEur < -2) finalOutcome = 'LOSS';
      else finalOutcome = 'BREAKEVEN';
    } else {
      finalOutcome = manualOutcome;
      if (manualOutcome === 'EXPIRED') {
        rMultiple = 0;
        if (pnlEur === 150) finalPnl = -2.0; // default friction
        finalExitPrice = entryPrice;
      }
    }

    const newEntry: TradeJournalEntry = {
      id: `trade-${Date.now()}`,
      timestamp: new Date().toISOString(),
      date: new Date().toLocaleDateString('it-IT'),
      session,
      market: session === 'US' ? 'US' : 'EU',
      ticker: ticker.trim().toUpperCase(),
      direction,
      strategy,
      entryPrice,
      exitPrice: finalExitPrice,
      stopLoss,
      target1,
      pnlEur: finalPnl,
      rMultiple,
      outcome: finalOutcome,
      notes: notes || (finalOutcome === 'EXPIRED' ? 'Setup scaduto al cutoff orario senza raggiungere target né stop' : ''),
      isPaper: isPaperMode,
      status: 'CLOSED',
      closedAt: new Date().toISOString(),
      entryMode: 'MANUAL_FREEZE',
    };

    onAddEntry(newEntry);
    setShowAddForm(false);
    setTicker('');
    setNotes('');
  };

  const handleQuickSetOutcome = (
    trade: TradeJournalEntry,
    newOutcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'EXPIRED'
  ) => {
    let exitPrice = trade.exitPrice;
    let pnlEur = trade.pnlEur;
    let rMultiple = trade.rMultiple;
    let notes = trade.notes;

    if (newOutcome === 'WIN') {
      exitPrice = trade.target1;
      rMultiple = 1.6;
      pnlEur = trade.pnlEur <= 0 ? 160 : trade.pnlEur;
      notes = 'Target 1 centrato con pieno profitto.';
    } else if (newOutcome === 'LOSS') {
      exitPrice = trade.stopLoss;
      rMultiple = -1.0;
      pnlEur = trade.pnlEur >= 0 ? -100 : trade.pnlEur;
      notes = 'Stop loss tassativo eseguito.';
    } else if (newOutcome === 'BREAKEVEN') {
      exitPrice = trade.entryPrice;
      rMultiple = 0;
      pnlEur = -2.0;
      notes = 'Chiuso a pareggio (spese commissionali).';
    } else if (newOutcome === 'EXPIRED') {
      exitPrice = trade.entryPrice;
      rMultiple = 0;
      pnlEur = -2.0;
      notes = 'Setup scaduto al cutoff di sessione: nessun breakout.';
    }

    const updated: TradeJournalEntry = {
      ...trade,
      outcome: newOutcome,
      exitPrice,
      pnlEur,
      rMultiple,
      notes,
      status: 'CLOSED',
      closedAt: new Date().toISOString(),
    };

    if (onUpdateEntry) {
      onUpdateEntry(updated);
    }
  };

  const handleExportJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(entries, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `intraday_radar_journal_${new Date().toISOString().split('T')[0]}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleExportCsv = () => {
    if (entries.length === 0) return;
    const headers = [
      'ID',
      'Data',
      'Sessione',
      'Ticker',
      'Direzione',
      'Strategia',
      'Entry',
      'Exit',
      'StopLoss',
      'Target1',
      'PnL_EUR',
      'R_Multiple',
      'Esito',
      'Stato',
      'Barriera_KO',
      'Leva',
      'Quote',
      'Rischio_EUR',
      'Note',
    ];
    const rows = entries.map((e) => [
      e.id,
      e.date,
      e.session,
      e.ticker,
      e.direction,
      `"${e.strategy}"`,
      e.entryPrice,
      e.exitPrice,
      e.stopLoss,
      e.target1,
      e.pnlEur,
      e.rMultiple,
      e.outcome,
      e.status || 'CLOSED',
      e.barrierStrike ?? '',
      e.leverage ?? '',
      e.suggestedCertificates ?? '',
      e.maxRiskEur ?? '',
      `"${(e.notes || '').replace(/"/g, '""')}"`,
    ]);
    const csvContent =
      'data:text/csv;charset=utf-8,' +
      [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `intraday_radar_trades_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  // Identify any open positions in monitoring
  const openTrades = entries.filter((e) => e.status === 'OPEN');

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl mb-8">
      {/* 1. Header Primary Row: Title, View Switcher, Add Trade & Quick Actions */}
      <div className="px-5 py-3.5 border-b border-slate-800 bg-slate-950 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
            <BookOpen className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
              <span>Diario di Trading & Statistiche di Performance</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 font-semibold">
                {entries.length} Trade Registrati
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              Tracciamento rigoroso esecuzioni • Regola stop giornaliero -2% e monitoraggio setup Scaduti (Expired)
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start md:self-auto">
          {/* View Mode Switcher: Curva di Equità / Statistiche & R / Table / Both */}
          <div className="flex rounded-lg bg-slate-900 p-0.5 border border-slate-800 text-xs font-mono">
            <button
              onClick={() => setViewMode('EQUITY')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                viewMode === 'EQUITY'
                  ? 'bg-emerald-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Visualizza Curva di Equità storica (Equity Curve Line Chart) nel tempo"
            >
              <TrendingUp className="w-3.5 h-3.5" />
              <span>Curva di Equità</span>
            </button>
            <button
              onClick={() => setViewMode('SUMMARY')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                viewMode === 'SUMMARY'
                  ? 'bg-indigo-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Visualizza metriche aggregate e distribuzioni R-multiple"
            >
              <BarChart2 className="w-3.5 h-3.5" />
              <span>Statistiche & R</span>
            </button>
            <button
              onClick={() => setViewMode('TABLE')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                viewMode === 'TABLE'
                  ? 'bg-slate-800 text-white font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Visualizza registro esecuzioni tabellare"
            >
              <List className="w-3.5 h-3.5" />
              <span>Registro Tabellare</span>
            </button>
            <button
              onClick={() => setViewMode('BOTH')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                viewMode === 'BOTH'
                  ? 'bg-sky-600 text-white font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Vista completa con Curva di Equità, statistiche e tabella affiancati"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>Vista Completa</span>
            </button>
          </div>

          <button
            onClick={() => {
              setShowAddForm(!showAddForm);
              if (!showAddForm && viewMode === 'SUMMARY') setViewMode('BOTH');
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors cursor-pointer shadow-sm"
          >
            <Plus className="w-4 h-4" />
            <span>Aggiungi Trade</span>
          </button>

          <button
            onClick={handleExportCsv}
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors cursor-pointer text-xs font-mono flex items-center gap-1"
            title="Esporta diario in CSV (compatibile Excel/Fogli)"
          >
            <Download className="w-3.5 h-3.5 text-emerald-400" />
            <span>CSV</span>
          </button>

          <button
            onClick={handleExportJson}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
            title="Esporta diario in JSON"
          >
            <Download className="w-4 h-4" />
          </button>

          {entries.length > 0 && (
            <button
              onClick={() => {
                if (window.confirm('Cancellare tutti i trade registrati dal diario?')) onClearAll();
              }}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950/60 text-slate-400 hover:text-rose-400 border border-slate-700 transition-colors cursor-pointer"
              title="Azzera diario"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* 1.5. Cross-Device Cloud Sync Information */}
      {!currentUser ? (
        <div className="px-5 py-2.5 bg-sky-950/40 border-b border-sky-800/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs font-mono">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-md bg-sky-900/80 border border-sky-500/50 flex items-center justify-center text-sky-400 shrink-0">
              <Cloud className="w-3.5 h-3.5" />
            </div>
            <div>
              <span className="text-sky-300 font-bold">Sincronizzazione Desktop ⟷ Mobile (Stessa App): </span>
              <span className="text-slate-300">
                Sei in memoria locale. Per visualizzare gli stessi trade su PC e Smartphone e raggiungere insieme il ciclo di 20 trade, accedi con Google.
              </span>
            </div>
          </div>
          {onSignInGoogle && (
            <button
              onClick={onSignInGoogle}
              className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer self-start sm:self-center shadow"
            >
              <Cloud className="w-3.5 h-3.5" />
              <span>Connetti Google</span>
            </button>
          )}
        </div>
      ) : (
        <div className="px-5 py-2 bg-emerald-950/30 border-b border-emerald-800/40 flex items-center justify-between text-[11px] font-mono text-emerald-300">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>
              Cloud Sync Attivo ({currentUser.displayName || currentUser.email}): Ogni trade registrato su Desktop o Mobile è condiviso in tempo reale sul database unico.
            </span>
          </div>
          <span className="text-slate-500 text-[10px] hidden sm:inline">Ciclo di 20 trade unificato</span>
        </div>
      )}

      {/* 2. Sub-Toolbar: Filters & 20-Setup Cycle Badge (Zero Overlap!) */}
      <div className="px-5 py-2.5 bg-slate-950/80 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2.5 text-xs font-mono">
        <div className="flex flex-wrap items-center gap-2">
          {/* Paper / Real Filter */}
          <div className="flex rounded-lg bg-slate-900 p-0.5 border border-slate-800">
            <button
              onClick={() => setFilterMode('ALL')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                filterMode === 'ALL' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tutti ({entries.length})
            </button>
            <button
              onClick={() => setFilterMode('PAPER')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                filterMode === 'PAPER' ? 'bg-indigo-950 text-indigo-300 font-bold border border-indigo-700' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Paper ({entries.filter(e => e.isPaper).length})
            </button>
            <button
              onClick={() => setFilterMode('REAL')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                filterMode === 'REAL' ? 'bg-amber-950 text-amber-300 font-bold border border-amber-700' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Reale ({entries.filter(e => !e.isPaper).length})
            </button>
          </div>

          {/* Outcome Filter */}
          <div className="flex flex-wrap rounded-lg bg-slate-900 p-0.5 border border-slate-800">
            <button
              onClick={() => setOutcomeFilter('ALL')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                outcomeFilter === 'ALL' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tutti
            </button>
            <button
              onClick={() => setOutcomeFilter('OPEN')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                outcomeFilter === 'OPEN' ? 'bg-sky-950 text-sky-300 font-bold border border-sky-600' : 'text-slate-400 hover:text-sky-300'
              }`}
            >
              ⚡ In Corso ({entries.filter(e => e.status === 'OPEN').length})
            </button>
            <button
              onClick={() => setOutcomeFilter('WIN')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                outcomeFilter === 'WIN' ? 'bg-emerald-950 text-emerald-300 font-bold border border-emerald-800' : 'text-slate-400 hover:text-emerald-300'
              }`}
            >
              Win ({entries.filter(e => e.outcome === 'WIN').length})
            </button>
            <button
              onClick={() => setOutcomeFilter('LOSS')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                outcomeFilter === 'LOSS' ? 'bg-rose-950 text-rose-300 font-bold border border-rose-800' : 'text-slate-400 hover:text-rose-300'
              }`}
            >
              Loss ({entries.filter(e => e.outcome === 'LOSS').length})
            </button>
            <button
              onClick={() => setOutcomeFilter('EXPIRED')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                outcomeFilter === 'EXPIRED' ? 'bg-amber-950 text-amber-300 font-bold border border-amber-800' : 'text-slate-400 hover:text-amber-300'
              }`}
            >
              Expired ({entries.filter(e => e.outcome === 'EXPIRED').length})
            </button>
          </div>
        </div>

        {/* Right side: Cycle and Demo actions */}
        <div className="flex flex-wrap items-center gap-2">
          {onOpenOptimizerModal && (
            <button
              onClick={onOpenOptimizerModal}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/40 text-xs font-mono transition-colors cursor-pointer"
              title="Apri pannello di audit ogni 20 setup e gestione parametri"
            >
              <Sliders className="w-3.5 h-3.5 text-amber-400" />
              <span>Ciclo Automiglioramento ({entries.filter(e => e.status !== 'OPEN').length % 20}/20)</span>
            </button>
          )}
        </div>
      </div>

      {/* 3. Open Positions Alert Strip (Live Autonomous Monitoring) */}
      {openTrades.length > 0 && (
        <div className="p-3.5 bg-amber-950/40 border-b border-amber-500/50 text-xs font-mono space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-amber-300 font-bold text-[11px]">
            <span className="flex items-center gap-1.5">
              <Zap className="w-4 h-4 text-amber-400 animate-pulse shrink-0" />
              <span>
                {openTrades.length} POSIZIONE IN MONITORAGGIO AUTONOMO ATTIVO (Target / Stop / Cutoff)
              </span>
            </span>
            <div className="flex items-center gap-2 text-[10px] text-slate-400">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              <span>Verifica automatica continua ad ogni tick del feed</span>
            </div>
          </div>

          <div className="space-y-2">
            {openTrades.map((t) => {
              const liveQ = quotes.find((q) => q.ticker === t.ticker);
              const livePrice = liveQ?.currentPrice ?? liveQ?.preMarketPrice;
              const isLong = t.direction === 'LONG';
              const riskDist = Math.abs(t.entryPrice - t.stopLoss);

              let floatingPnlEur = 0;
              let floatingR = 0;
              let distToTarget = 0;
              let distToStop = 0;

              if (livePrice && riskDist > 0) {
                const diff = isLong ? livePrice - t.entryPrice : t.entryPrice - livePrice;
                floatingR = +(diff / riskDist).toFixed(2);
                floatingPnlEur = +(floatingR * (accountCapital * 0.01)).toFixed(2);
                distToTarget = +(Math.abs(t.target1 - livePrice)).toFixed(2);
                distToStop = +(Math.abs(livePrice - t.stopLoss)).toFixed(2);
              }

              return (
                <div
                  key={t.id}
                  className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 p-3 rounded-xl bg-slate-950 border border-slate-800 shadow-lg"
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="font-bold text-white text-sm">{t.ticker}</span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        t.direction === 'LONG'
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                          : 'bg-rose-950 text-rose-300 border border-rose-800'
                      }`}
                    >
                      {t.direction}
                    </span>

                    <span className="text-slate-400 text-[11px]">
                      Entry: <strong className="text-white">{t.entryPrice.toFixed(2)}</strong> | Stop: <strong className="text-rose-400">{t.stopLoss.toFixed(2)}</strong> | Target: <strong className="text-emerald-400">{t.target1.toFixed(2)}</strong>
                    </span>

                    {livePrice != null ? (
                      <div className="flex items-center gap-2 bg-slate-900 px-2.5 py-1 rounded-lg border border-slate-700/80">
                        <span className="text-[10px] text-slate-400">Prezzo Live:</span>
                        <span className="font-bold text-white text-xs">{livePrice.toFixed(2)}</span>
                        <span
                          className={`font-bold text-xs ${
                            floatingPnlEur > 0 ? 'text-emerald-400' : floatingPnlEur < 0 ? 'text-rose-400' : 'text-slate-300'
                          }`}
                        >
                          {floatingPnlEur > 0 ? `+${floatingPnlEur}` : floatingPnlEur} € ({floatingR > 0 ? `+${floatingR}` : floatingR}R)
                        </span>
                      </div>
                    ) : (
                      <span className="text-[10px] text-slate-500 italic">Prezzo tick in attesa...</span>
                    )}

                    {livePrice != null && (
                      <span className="text-[10px] text-slate-400 font-sans">
                        (Mancano <strong>{distToTarget}</strong> pt al Target / <strong>{distToStop}</strong> pt allo Stop)
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap self-end lg:self-center shrink-0">
                    <span className="text-[10px] text-slate-500 mr-1 hidden sm:inline">Risoluzione manuale anticipata:</span>
                    <button
                      onClick={() => handleQuickSetOutcome(t, 'WIN')}
                      className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[10px] transition-colors cursor-pointer"
                      title="Forza chiusura immediata su Target 1"
                    >
                      🎯 Target (WIN)
                    </button>
                    <button
                      onClick={() => handleQuickSetOutcome(t, 'LOSS')}
                      className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white font-bold text-[10px] transition-colors cursor-pointer"
                      title="Forza chiusura immediata su Stop Loss"
                    >
                      🛑 Stop (LOSS)
                    </button>
                    <button
                      onClick={() => handleQuickSetOutcome(t, 'BREAKEVEN')}
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-[10px] transition-colors cursor-pointer"
                      title="Chiudi a pareggio"
                    >
                      ⚖️ BE
                    </button>
                    <button
                      onClick={() => handleQuickSetOutcome(t, 'EXPIRED')}
                      className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold text-[10px] transition-colors cursor-pointer"
                      title="Chiudi come scaduto al cutoff"
                    >
                      ⏰ Expired
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 4. KPI Cards (Responsive grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 with zero overlap!) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 p-4 bg-slate-950/60 border-b border-slate-800 text-xs font-mono">
        {/* Win Rate */}
        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 min-w-0 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 block mb-1 truncate">Win Rate %</span>
          <div className="text-base font-bold text-white flex items-center gap-1.5">
            <Award className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{winRate}%</span>
          </div>
          <span className="text-[10px] text-slate-500 truncate block mt-1">
            {wins.length}W / {losses.length}L / {breakevens.length}BE
          </span>
        </div>

        {/* Expired Rate (Crucial!) */}
        <div
          className={`p-3 rounded-lg border min-w-0 flex flex-col justify-between ${
            expiredRate >= 20 ? 'bg-rose-950/40 border-rose-600/60' : 'bg-slate-900 border-slate-800'
          }`}
        >
          <span className="text-[10px] text-slate-400 block mb-1 flex items-center justify-between">
            <span className="truncate">Tasso Scaduti</span>
            <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          </span>
          <div
            className={`text-base font-bold ${
              expiredRate >= 20 ? 'text-rose-400' : 'text-amber-300'
            }`}
          >
            {expiredRate}%
          </div>
          <span className="text-[10px] text-slate-400 truncate block mt-1">
            {expired.length} su {totalTrades} non chiusi
          </span>
        </div>

        {/* Profit Factor */}
        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 min-w-0 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 block mb-1 truncate">Profit Factor</span>
          <div className="text-base font-bold text-emerald-400">
            {profitFactor > 0 ? profitFactor.toFixed(2) : '0.00'}
          </div>
          <span className="text-[10px] text-slate-500 truncate block mt-1">
            +{totalGainsEur.toFixed(0)}€ / -{totalLossesEur.toFixed(0)}€
          </span>
        </div>

        {/* Rapporto Medio R */}
        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 min-w-0 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 block mb-1 truncate">R:R Medio Effettivo</span>
          <div className="text-base font-bold text-sky-400">
            {avgR > 0 ? `+${avgR.toFixed(2)}R` : `${avgR.toFixed(2)}R`}
          </div>
          <span className="text-[10px] text-slate-500 truncate block mt-1">Target min 1.6R</span>
        </div>

        {/* Net PnL € */}
        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 min-w-0 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 block mb-1 truncate">P&L Netto Totale</span>
          <div
            className={`text-base font-bold truncate ${
              netPnlEur > 0 ? 'text-emerald-400' : netPnlEur < 0 ? 'text-rose-400' : 'text-white'
            }`}
          >
            {netPnlEur > 0 ? `+${netPnlEur.toFixed(2)}` : netPnlEur.toFixed(2)} €
          </div>
          <span className="text-[10px] text-slate-400 truncate block mt-1">
            {netPnlPercent > 0 ? `+${netPnlPercent.toFixed(2)}%` : `${netPnlPercent.toFixed(2)}%`}
          </span>
        </div>

        {/* Max Drawdown */}
        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 min-w-0 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 block mb-1 truncate">Max Drawdown</span>
          <div className="text-base font-bold text-rose-400">
            -{maxDdEur.toFixed(0)} €
          </div>
          <span className="text-[10px] text-rose-300 truncate block mt-1">-{maxDdPercent}% capitale</span>
        </div>
      </div>

      {/* 1. Historical Equity Dashboard View (Equity Curve Line Chart, HWM & Underwater Drawdown) */}
      {(viewMode === 'EQUITY' || viewMode === 'BOTH') && (
        <HistoricalEquityDashboard
          entries={filteredEntries}
          accountCapital={accountCapital}
        />
      )}

      {/* 2. Performance Summary View (Recharts Statistical Breakdown & R Distributions) */}
      {(viewMode === 'SUMMARY' || viewMode === 'BOTH') && (
        <PerformanceSummary
          entries={filteredEntries}
          accountCapital={accountCapital}
        />
      )}

      {/* Manual Entry Form */}
      {showAddForm && (
        <form
          onSubmit={handleCreateEntry}
          className="p-5 border-b border-slate-800 bg-slate-950 space-y-4 text-xs"
        >
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-white uppercase tracking-wider text-[11px] flex items-center gap-2">
              <Plus className="w-4 h-4 text-emerald-400" />
              Registra Esecuzione Trade
            </h4>
            <span className="font-mono text-indigo-300 text-[11px]">
              Modalità: {isPaperMode ? 'Paper Trading' : 'Reale'}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
            <div>
              <label className="block text-slate-400 text-[11px] mb-1">Ticker Sottostante</label>
              <input
                type="text"
                required
                placeholder="es. NVDA o SAP.DE"
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-white uppercase font-mono"
              />
            </div>

            <div>
              <label className="block text-slate-400 text-[11px] mb-1">Direzione</label>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as 'LONG' | 'SHORT')}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-white"
              >
                <option value="LONG">LONG</option>
                <option value="SHORT">SHORT</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-400 text-[11px] mb-1">Sessione</label>
              <select
                value={session}
                onChange={(e) => setSession(e.target.value as 'EU' | 'US')}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-white"
              >
                <option value="EU">Europa</option>
                <option value="US">USA</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-400 text-[11px] mb-1">Esito Specifico</label>
              <select
                value={manualOutcome}
                onChange={(e) => setManualOutcome(e.target.value as any)}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-white font-mono"
              >
                <option value="AUTO">Automatico (da P&L)</option>
                <option value="WIN">WIN (Target Raggiunto)</option>
                <option value="LOSS">LOSS (Stop Loss Colpito)</option>
                <option value="BREAKEVEN">BREAKEVEN (Pareggio)</option>
                <option value="EXPIRED">EXPIRED (Scaduto al Cutoff)</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-400 text-[11px] mb-1">Strategia</label>
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-white"
              >
                <option value="Opening Range Breakout (5m / 15m)">Opening Range Breakout</option>
                <option value="Gap and Go">Gap and Go</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-400 text-[11px] mb-1">Prezzo Ingresso</label>
              <input
                type="number"
                step="0.01"
                value={entryPrice}
                onChange={(e) => setEntryPrice(parseFloat(e.target.value) || 0)}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-white font-mono"
              />
            </div>

            <div>
              <label className="block text-slate-400 text-[11px] mb-1">Prezzo Uscita</label>
              <input
                type="number"
                step="0.01"
                value={exitPrice}
                onChange={(e) => setExitPrice(parseFloat(e.target.value) || 0)}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-white font-mono"
              />
            </div>

            <div>
              <label className="block text-slate-400 text-[11px] mb-1">Stop Loss</label>
              <input
                type="number"
                step="0.01"
                value={stopLoss}
                onChange={(e) => setStopLoss(parseFloat(e.target.value) || 0)}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-white font-mono"
              />
            </div>

            <div>
              <label className="block text-slate-400 text-[11px] mb-1">Risultato Netto (€)</label>
              <input
                type="number"
                step="0.5"
                value={pnlEur}
                onChange={(e) => setPnlEur(parseFloat(e.target.value) || 0)}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-white font-mono"
              />
            </div>

            <div className="sm:col-span-3">
              <label className="block text-slate-400 text-[11px] mb-1">Note sull'esecuzione</label>
              <input
                type="text"
                placeholder="es. Scaduto ore 11:30 senza rottura range, chiuso a mercato..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-white"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md font-medium"
            >
              Annulla
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md font-bold shadow-md cursor-pointer"
            >
              Salva Esecuzione
            </button>
          </div>
        </form>
      )}

      {/* Trade Journal Table */}
      {(viewMode === 'TABLE' || viewMode === 'BOTH') && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-800">
              <tr>
                <th className="py-2.5 px-3">Data & Ora</th>
                <th className="py-2.5 px-3">Sottostante</th>
                <th className="py-2.5 px-3">Direzione</th>
                <th className="py-2.5 px-3">Strategia</th>
                <th className="py-2.5 px-3 text-right">Ingresso</th>
                <th className="py-2.5 px-3 text-right">Uscita</th>
                <th className="py-2.5 px-3 text-right">Risultato (€)</th>
                <th className="py-2.5 px-3 text-right">R-Multiple</th>
                <th className="py-2.5 px-3 text-center">Esito</th>
                <th className="py-2.5 px-3 text-center">Risoluzione Rapida</th>
                <th className="py-2.5 px-3">Modalità</th>
                <th className="py-2.5 px-3">Note</th>
                <th className="py-2.5 px-3 text-right">Azione</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {filteredEntries.map((trade) => {
                const isOpen = trade.status === 'OPEN';
                const isWin = trade.outcome === 'WIN';
                const isLoss = trade.outcome === 'LOSS';
                const isExpired = trade.outcome === 'EXPIRED';

                const liveQ = isOpen ? quotes.find((q) => q.ticker === trade.ticker) : null;
                const livePrice = liveQ?.currentPrice ?? liveQ?.preMarketPrice;
                const isLong = trade.direction === 'LONG';
                const riskDist = Math.abs(trade.entryPrice - trade.stopLoss);

                let floatingR = trade.rMultiple;
                let floatingPnlEur = trade.pnlEur;
                let distToTarget = 0;
                let distToStop = 0;

                if (isOpen && livePrice != null && riskDist > 0) {
                  const diff = isLong ? livePrice - trade.entryPrice : trade.entryPrice - livePrice;
                  floatingR = +(diff / riskDist).toFixed(2);
                  floatingPnlEur = +(floatingR * (accountCapital * 0.01)).toFixed(2);
                  distToTarget = +(Math.abs(trade.target1 - livePrice)).toFixed(2);
                  distToStop = +(Math.abs(livePrice - trade.stopLoss)).toFixed(2);
                }

                return (
                  <tr key={trade.id} className={`hover:bg-slate-800/40 transition-colors ${isOpen ? 'bg-sky-950/20' : ''}`}>
                    <td className="py-2 px-3 text-slate-400 text-[11px]">
                      <div>{trade.date}</div>
                      <div className="text-[10px] text-slate-500">
                        {new Date(trade.timestamp).toLocaleTimeString('it-IT')}
                      </div>
                    </td>
                    <td className="py-2 px-3 font-bold text-white">
                      {trade.ticker}
                      <span className="ml-1 text-[10px] font-normal text-slate-400">({trade.session})</span>
                      {trade.entryMode && (
                        <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded bg-sky-950/70 text-sky-300 border border-sky-800/60 font-mono font-normal">
                          {trade.entryMode}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                          trade.direction === 'LONG'
                            ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800'
                            : 'bg-rose-950/60 text-rose-400 border-rose-800'
                        }`}
                      >
                        {trade.direction}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-300 font-sans text-[11px] truncate max-w-[130px]">
                      {trade.strategy}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-300">
                      {trade.entryPrice.toFixed(2)}
                    </td>
                    <td className="py-2 px-3 text-right">
                      {isOpen ? (
                        <div>
                          <span className="text-sky-400 font-bold font-mono">
                            {livePrice != null ? livePrice.toFixed(2) : '---'}
                          </span>
                          <span className="text-[9px] block text-sky-400/90 font-sans font-semibold">TICK LIVE</span>
                        </div>
                      ) : (
                        <span className="text-white font-bold">{trade.exitPrice.toFixed(2)}</span>
                      )}
                    </td>
                    <td
                      className={`py-2 px-3 text-right font-bold ${
                        (isOpen ? floatingPnlEur : trade.pnlEur) > 0
                          ? 'text-emerald-400'
                          : (isOpen ? floatingPnlEur : trade.pnlEur) < 0
                          ? 'text-rose-400'
                          : 'text-slate-300'
                      }`}
                    >
                      <div>
                        <span>
                          {(isOpen ? floatingPnlEur : trade.pnlEur) > 0
                            ? `+${(isOpen ? floatingPnlEur : trade.pnlEur).toFixed(2)}`
                            : (isOpen ? floatingPnlEur : trade.pnlEur).toFixed(2)}{' '}
                          €
                        </span>
                        {isOpen && (
                          <span className="text-[9px] block text-slate-500 font-sans font-normal">
                            Non Realizzato
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-right font-bold">
                      <span
                        className={
                          (isOpen ? floatingR : trade.rMultiple) > 0
                            ? 'text-emerald-400'
                            : (isOpen ? floatingR : trade.rMultiple) < 0
                            ? 'text-rose-400'
                            : 'text-slate-400'
                        }
                      >
                        {(isOpen ? floatingR : trade.rMultiple) > 0
                          ? `+${(isOpen ? floatingR : trade.rMultiple).toFixed(2)}R`
                          : `${(isOpen ? floatingR : trade.rMultiple).toFixed(2)}R`}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-center">
                      {isOpen ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-sky-950 text-sky-300 border border-sky-500 text-[10px] font-bold shadow-sm">
                          <span className="inline-block w-2 h-2 rounded-full bg-sky-400 animate-ping" />
                          IN CORSO
                        </span>
                      ) : isWin ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400 font-bold text-[11px]">
                          <CheckCircle2 className="w-3.5 h-3.5" /> WIN
                        </span>
                      ) : isLoss ? (
                        <span className="inline-flex items-center gap-1 text-rose-400 font-bold text-[11px]">
                          <XCircle className="w-3.5 h-3.5" /> LOSS
                        </span>
                      ) : isExpired ? (
                        <span className="inline-flex items-center gap-1 text-amber-400 font-bold text-[11px]">
                          <Clock className="w-3.5 h-3.5" /> EXPIRED
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-slate-400 font-bold text-[11px]">
                          <MinusCircle className="w-3.5 h-3.5" /> BE
                        </span>
                      )}
                    </td>

                    {/* Quick Outcome Resolution Buttons */}
                    <td className="py-2 px-3 text-center">
                      <div className="inline-flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
                        <button
                          onClick={() => handleQuickSetOutcome(trade, 'WIN')}
                          className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-all ${
                            isWin
                              ? 'bg-emerald-600 text-white font-black shadow-sm'
                              : 'text-slate-400 hover:text-emerald-300 hover:bg-emerald-950/40'
                          }`}
                          title="Segna come WIN (+1.6R Target 1)"
                        >
                          WIN
                        </button>
                        <button
                          onClick={() => handleQuickSetOutcome(trade, 'LOSS')}
                          className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-all ${
                            isLoss
                              ? 'bg-rose-600 text-white font-black shadow-sm'
                              : 'text-slate-400 hover:text-rose-300 hover:bg-rose-950/40'
                          }`}
                          title="Segna come LOSS (-1.0R Stop Loss)"
                        >
                          LOSS
                        </button>
                        <button
                          onClick={() => handleQuickSetOutcome(trade, 'BREAKEVEN')}
                          className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-all ${
                            trade.outcome === 'BREAKEVEN'
                              ? 'bg-slate-700 text-white font-black'
                              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                          }`}
                          title="Segna come BREAKEVEN (Pareggio)"
                        >
                          BE
                        </button>
                        <button
                          onClick={() => handleQuickSetOutcome(trade, 'EXPIRED')}
                          className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-all ${
                            isExpired
                              ? 'bg-amber-600 text-slate-950 font-black shadow-sm'
                              : 'text-slate-400 hover:text-amber-300 hover:bg-amber-950/40'
                          }`}
                          title="Segna come EXPIRED (Scaduto al cutoff senza target né stop)"
                        >
                          EXP
                        </button>
                      </div>
                    </td>

                    <td className="py-2 px-3">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-sans ${
                          trade.isPaper
                            ? 'bg-indigo-950 text-indigo-300 border border-indigo-800'
                            : 'bg-amber-950 text-amber-300 border border-amber-800'
                        }`}
                      >
                        {trade.isPaper ? 'Paper' : 'Reale'}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-400 font-sans text-[11px] truncate max-w-[150px]" title={trade.notes}>
                      {isOpen && livePrice != null ? (
                        <span className="text-sky-300 font-mono text-[10px]">
                          Target -{distToTarget} | Stop -{distToStop}
                        </span>
                      ) : (
                        trade.notes || '—'
                      )}
                    </td>
                    <td className="py-2 px-3 text-right">
                      <button
                        onClick={() => onDeleteEntry(trade.id)}
                        className="p-1 hover:bg-rose-950/60 text-slate-500 hover:text-rose-400 rounded transition-colors"
                        title="Elimina voce dal diario"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}

              {filteredEntries.length === 0 && (
                <tr>
                  <td colSpan={13} className="py-8 text-center text-slate-500 font-sans">
                    Nessun trade registrato corrispondente ai filtri selezionati.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
