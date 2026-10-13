import React, { useState } from 'react';
import {
  TradeJournalEntry,
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
} from 'lucide-react';
import { PerformanceSummary } from './PerformanceSummary';

interface TradeJournalProps {
  entries: TradeJournalEntry[];
  onAddEntry: (entry: TradeJournalEntry) => void;
  onDeleteEntry: (id: string) => void;
  onClearAll: () => void;
  accountCapital: number;
  isPaperMode: boolean;
  onLoadSampleTrades?: () => void;
}

export const TradeJournal: React.FC<TradeJournalProps> = ({
  entries,
  onAddEntry,
  onDeleteEntry,
  onClearAll,
  accountCapital,
  isPaperMode,
  onLoadSampleTrades,
}) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [filterMode, setFilterMode] = useState<'ALL' | 'PAPER' | 'REAL'>('ALL');
  const [viewMode, setViewMode] = useState<'SUMMARY' | 'TABLE' | 'BOTH'>('SUMMARY');

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
  const [notes, setNotes] = useState('');

  const filteredEntries = entries.filter((e) => {
    if (filterMode === 'PAPER') return e.isPaper;
    if (filterMode === 'REAL') return !e.isPaper;
    return true;
  });

  // Calculate Key Performance Indicators (KPI)
  const totalTrades = filteredEntries.length;
  const wins = filteredEntries.filter((e) => e.outcome === 'WIN');
  const losses = filteredEntries.filter((e) => e.outcome === 'LOSS');
  const winRate = totalTrades > 0 ? +((wins.length / totalTrades) * 100).toFixed(1) : 0;

  const totalGainsEur = wins.reduce((acc, curr) => acc + curr.pnlEur, 0);
  const totalLossesEur = Math.abs(losses.reduce((acc, curr) => acc + curr.pnlEur, 0));
  const profitFactor = totalLossesEur > 0 ? +(totalGainsEur / totalLossesEur).toFixed(2) : totalGainsEur > 0 ? 99.9 : 0;

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
    const rMultiple = +(gainedDistance / riskDistance).toFixed(2);

    let outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' = 'BREAKEVEN';
    if (pnlEur > 2) outcome = 'WIN';
    else if (pnlEur < -2) outcome = 'LOSS';

    const newEntry: TradeJournalEntry = {
      id: `trade-${Date.now()}`,
      timestamp: new Date().toISOString(),
      date: new Date().toLocaleDateString('it-IT'),
      session,
      ticker: ticker.trim().toUpperCase(),
      direction,
      strategy,
      entryPrice,
      exitPrice,
      stopLoss,
      target1,
      pnlEur,
      rMultiple,
      outcome,
      notes,
      isPaper: isPaperMode,
    };

    onAddEntry(newEntry);
    setShowAddForm(false);
    setTicker('');
    setNotes('');
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

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl mb-8">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800 bg-slate-950 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <BookOpen className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-white">
              Diario di Trading & Statistiche di Performance
            </h2>
            <p className="text-xs text-slate-400">
              Tracciamento rigoroso esecuzioni • Regola stop giornaliero -2% e max 2 trade/giorno
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* View Mode Switcher: Performance Summary / Table / Both */}
          <div className="flex rounded-lg bg-slate-900 p-0.5 border border-slate-800 text-xs font-mono">
            <button
              onClick={() => setViewMode('SUMMARY')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors ${
                viewMode === 'SUMMARY'
                  ? 'bg-indigo-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Visualizza grafici interattivi Recharts e distribuzioni statistiche"
            >
              <BarChart2 className="w-3.5 h-3.5" />
              <span>Performance Summary</span>
            </button>
            <button
              onClick={() => setViewMode('TABLE')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors ${
                viewMode === 'TABLE'
                  ? 'bg-slate-800 text-white font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Visualizza registro esecuzioni tabellare"
            >
              <List className="w-3.5 h-3.5" />
              <span>Registro Esecuzioni</span>
            </button>
            <button
              onClick={() => setViewMode('BOTH')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors ${
                viewMode === 'BOTH'
                  ? 'bg-slate-800 text-white font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Vista completa con grafici e tabella affiancati"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>Completa</span>
            </button>
          </div>

          {/* Paper / Real Filter */}
          <div className="flex rounded-lg bg-slate-900 p-0.5 border border-slate-800 text-xs font-mono">
            <button
              onClick={() => setFilterMode('ALL')}
              className={`px-2 py-1 rounded-md transition-colors ${
                filterMode === 'ALL' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tutti ({entries.length})
            </button>
            <button
              onClick={() => setFilterMode('PAPER')}
              className={`px-2 py-1 rounded-md transition-colors ${
                filterMode === 'PAPER' ? 'bg-indigo-950 text-indigo-300 font-bold border border-indigo-700' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Paper
            </button>
            <button
              onClick={() => setFilterMode('REAL')}
              className={`px-2 py-1 rounded-md transition-colors ${
                filterMode === 'REAL' ? 'bg-amber-950 text-amber-300 font-bold border border-amber-700' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Reale
            </button>
          </div>

          {onLoadSampleTrades && (
            <button
              onClick={onLoadSampleTrades}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-950/70 hover:bg-indigo-900/90 text-indigo-300 border border-indigo-700/60 text-xs font-mono transition-colors"
              title="Carica 8 operazioni storiche dimostrative per testare grafici Recharts e statistiche"
            >
              <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
              <span>Demo Trades</span>
            </button>
          )}

          <button
            onClick={() => {
              setShowAddForm(!showAddForm);
              if (!showAddForm && viewMode === 'SUMMARY') setViewMode('BOTH');
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>Aggiungi Trade</span>
          </button>

          <button
            onClick={handleExportJson}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
            title="Esporta diario in JSON"
          >
            <Download className="w-4 h-4" />
          </button>

          {entries.length > 0 && (
            <button
              onClick={() => {
                if (window.confirm('Cancellare tutti i trade registrati dal diario?')) onClearAll();
              }}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950/60 text-slate-400 hover:text-rose-400 border border-slate-700 transition-colors"
              title="Azzera diario"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 p-5 bg-slate-950/60 border-b border-slate-800 text-xs font-mono">
        {/* Win Rate */}
        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800">
          <span className="text-[10px] text-slate-400 block mb-1">Win Rate %</span>
          <div className="text-base font-bold text-white flex items-center gap-1.5">
            <Award className="w-4 h-4 text-amber-400" />
            <span>{winRate}%</span>
          </div>
          <span className="text-[10px] text-slate-500">{wins.length}W / {losses.length}L</span>
        </div>

        {/* Profit Factor */}
        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800">
          <span className="text-[10px] text-slate-400 block mb-1">Profit Factor</span>
          <div className="text-base font-bold text-emerald-400">
            {profitFactor > 0 ? profitFactor.toFixed(2) : '0.00'}
          </div>
          <span className="text-[10px] text-slate-500">Lorda +{totalGainsEur.toFixed(0)}€ / -{totalLossesEur.toFixed(0)}€</span>
        </div>

        {/* Rapporto Medio R */}
        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800">
          <span className="text-[10px] text-slate-400 block mb-1">R:R Medio Effettivo</span>
          <div className="text-base font-bold text-sky-400">
            {avgR > 0 ? `+${avgR.toFixed(2)}R` : `${avgR.toFixed(2)}R`}
          </div>
          <span className="text-[10px] text-slate-500">Target minimo 1.6R</span>
        </div>

        {/* Net PnL € */}
        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800">
          <span className="text-[10px] text-slate-400 block mb-1">P&L Netto Totale</span>
          <div
            className={`text-base font-bold ${
              netPnlEur > 0 ? 'text-emerald-400' : netPnlEur < 0 ? 'text-rose-400' : 'text-white'
            }`}
          >
            {netPnlEur > 0 ? `+${netPnlEur.toFixed(2)}` : netPnlEur.toFixed(2)} €
          </div>
          <span className="text-[10px] text-slate-400">
            {netPnlPercent > 0 ? `+${netPnlPercent.toFixed(2)}%` : `${netPnlPercent.toFixed(2)}%`}
          </span>
        </div>

        {/* Max Drawdown */}
        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800">
          <span className="text-[10px] text-slate-400 block mb-1">Max Drawdown</span>
          <div className="text-base font-bold text-rose-400">
            -{maxDdEur.toFixed(0)} €
          </div>
          <span className="text-[10px] text-rose-300">-{maxDdPercent}% capitale</span>
        </div>

        {/* Daily Safety Status */}
        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800">
          <span className="text-[10px] text-slate-400 block mb-1">Governance Giornaliera</span>
          <div className="text-xs font-bold text-slate-200">
            Max 2 Trade / Giorno
          </div>
          <span className="text-[10px] text-amber-300">Stop G. -2% capitale</span>
        </div>
      </div>

      {/* Performance Summary View (Recharts Visualizations & Distributions) */}
      {(viewMode === 'SUMMARY' || viewMode === 'BOTH') && (
        <PerformanceSummary
          entries={filteredEntries}
          accountCapital={accountCapital}
          onLoadSampleTrades={onLoadSampleTrades}
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

            <div className="sm:col-span-4">
              <label className="block text-slate-400 text-[11px] mb-1">Note sull'esecuzione</label>
              <input
                type="text"
                placeholder="es. Uscita su Target 1, confermato VWAP dopo 5 min..."
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
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md font-bold shadow-md"
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
              <th className="py-2.5 px-3">Modalità</th>
              <th className="py-2.5 px-3">Note</th>
              <th className="py-2.5 px-3 text-right">Azione</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 font-mono">
            {filteredEntries.map((trade) => {
              const isWin = trade.outcome === 'WIN';
              const isLoss = trade.outcome === 'LOSS';

              return (
                <tr key={trade.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="py-2 px-3 text-slate-400 text-[11px]">
                    <div>{trade.date}</div>
                    <div className="text-[10px] text-slate-500">
                      {new Date(trade.timestamp).toLocaleTimeString('it-IT')}
                    </div>
                  </td>
                  <td className="py-2 px-3 font-bold text-white">
                    {trade.ticker}
                    <span className="ml-1 text-[10px] font-normal text-slate-400">({trade.session})</span>
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
                  <td className="py-2 px-3 text-slate-300 font-sans text-[11px] truncate max-w-[140px]">
                    {trade.strategy}
                  </td>
                  <td className="py-2 px-3 text-right text-slate-300">
                    {trade.entryPrice.toFixed(2)}
                  </td>
                  <td className="py-2 px-3 text-right text-white font-bold">
                    {trade.exitPrice.toFixed(2)}
                  </td>
                  <td
                    className={`py-2 px-3 text-right font-bold ${
                      trade.pnlEur > 0 ? 'text-emerald-400' : trade.pnlEur < 0 ? 'text-rose-400' : 'text-slate-300'
                    }`}
                  >
                    {trade.pnlEur > 0 ? `+${trade.pnlEur.toFixed(2)}` : trade.pnlEur.toFixed(2)} €
                  </td>
                  <td className="py-2 px-3 text-right font-bold">
                    <span
                      className={trade.rMultiple > 0 ? 'text-emerald-400' : trade.rMultiple < 0 ? 'text-rose-400' : 'text-slate-400'}
                    >
                      {trade.rMultiple > 0 ? `+${trade.rMultiple.toFixed(2)}R` : `${trade.rMultiple.toFixed(2)}R`}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-center">
                    {isWin ? (
                      <span className="inline-flex items-center gap-1 text-emerald-400 font-bold text-[11px]">
                        <CheckCircle2 className="w-3.5 h-3.5" /> WIN
                      </span>
                    ) : isLoss ? (
                      <span className="inline-flex items-center gap-1 text-rose-400 font-bold text-[11px]">
                        <XCircle className="w-3.5 h-3.5" /> LOSS
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-slate-400 font-bold text-[11px]">
                        <MinusCircle className="w-3.5 h-3.5" /> BE
                      </span>
                    )}
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
                  <td className="py-2 px-3 text-slate-400 font-sans text-[11px] truncate max-w-[150px]">
                    {trade.notes || '—'}
                  </td>
                  <td className="py-2 px-3 text-right">
                    <button
                      onClick={() => onDeleteEntry(trade.id)}
                      className="p-1 hover:bg-rose-950/60 text-slate-500 hover:text-rose-400 rounded transition-colors"
                      title="Elimina voce"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}

            {filteredEntries.length === 0 && (
              <tr>
                <td colSpan={12} className="py-8 text-center text-slate-500 font-sans">
                  Nessun trade registrato nel diario. I trade salvati dal calcolatore o aggiunti manualmente appariranno qui.
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
