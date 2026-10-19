import React, { useState } from 'react';
import {
  X,
  Target,
  ShieldCheck,
  ShieldAlert,
  Sliders,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Search,
  Filter,
  RefreshCw,
  Sparkles,
  ArrowRight,
  HelpCircle,
  Trash2,
} from 'lucide-react';
import {
  ExcludedSetupRecord,
  ExcludedSetupsAutoAnalysis,
  ExcludedCategoryAnalysis,
  SystemParameters,
  ExclusionCategory,
} from '../types/radar';

interface ExcludedSetupsAnalyzerModalProps {
  isOpen: boolean;
  onClose: () => void;
  analysis: ExcludedSetupsAutoAnalysis;
  records: ExcludedSetupRecord[];
  currentParameters: SystemParameters;
  onApplyCorrection: (paramKey: keyof SystemParameters, proposedValue: any, explanation: string) => void;
  onApplyAllUrgentCorrections: () => void;
  onClearRecords: () => void;
  accountCapital: number;
}

export const ExcludedSetupsAnalyzerModal: React.FC<ExcludedSetupsAnalyzerModalProps> = ({
  isOpen,
  onClose,
  analysis,
  records,
  currentParameters,
  onApplyCorrection,
  onApplyAllUrgentCorrections,
  onClearRecords,
  accountCapital,
}) => {
  const [activeTab, setActiveTab] = useState<'CATEGORIES' | 'CANDIDATES'>('CATEGORIES');
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('ALL');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  if (!isOpen) return null;

  const filteredRecords = records.filter((rec) => {
    if (selectedCategoryFilter !== 'ALL' && rec.primaryReasonCategory !== selectedCategoryFilter) {
      return false;
    }
    if (selectedStatusFilter !== 'ALL' && rec.outcomeStatus !== selectedStatusFilter) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return rec.ticker.toLowerCase().includes(q) || rec.name.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-5xl w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden text-slate-100 font-mono">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white uppercase tracking-wider">
                  Autoanalisi Setup Esclusi & Counterfactual Tracking
                </h3>
                <span className="text-[10px] px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800 font-bold">
                  {analysis.totalTracked} Monitorati
                </span>
              </div>
              <p className="text-xs text-slate-400 font-sans mt-0.5">
                Verifica se i titoli esclusi dai filtri sono poi andati a profitto e calibra i parametri per la prossima sessione
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Global KPI Summary Banner */}
        <div className="p-5 border-b border-slate-800 bg-slate-950/70 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="bg-slate-900/90 p-3 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase">Esclusi a Profitto 🎯</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-xl font-bold text-emerald-400">{analysis.totalProfitable}</span>
              <span className="text-[11px] text-emerald-500/80">({analysis.overallMissedWinRate}% win rate)</span>
            </div>
            <span className="text-[10px] text-slate-500 block mt-0.5">
              +{analysis.totalMissedPnlEur} € persi per filtri severi
            </span>
          </div>

          <div className="bg-slate-900/90 p-3 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase">Stop Evitati 🛡️</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-xl font-bold text-indigo-400">{analysis.totalStopped}</span>
              <span className="text-[11px] text-indigo-300">Falsi segnali</span>
            </div>
            <span className="text-[10px] text-indigo-400/80 block mt-0.5">
              +{analysis.totalCapitalSavedEur} € di perdite scampate
            </span>
          </div>

          <div className="bg-slate-900/90 p-3 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase">In Monitoraggio Live ⏳</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-xl font-bold text-amber-400">{analysis.totalMonitoring}</span>
              <span className="text-[11px] text-slate-400">/{analysis.totalTracked}</span>
            </div>
            <span className="text-[10px] text-slate-500 block mt-0.5">
              {analysis.totalExpired} scaduti al cutoff
            </span>
          </div>

          <div className="bg-slate-900/90 p-3 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase">Diagnosi Filtri ⚙️</span>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              {analysis.urgentCorrections.length > 0 ? (
                <>
                  <span className="text-xl font-bold text-amber-400">{analysis.urgentCorrections.length}</span>
                  <span className="text-[11px] text-amber-300 font-bold">Troppo severi</span>
                </>
              ) : (
                <>
                  <span className="text-lg font-bold text-emerald-400">Ottimale</span>
                  <span className="text-[10px] text-emerald-500">Nessun abuso</span>
                </>
              )}
            </div>
            <span className="text-[10px] text-slate-500 block mt-0.5">
              Calibrazione adattiva attiva
            </span>
          </div>
        </div>

        {/* Urgent Corrections Notification & One-Click Apply */}
        {analysis.urgentCorrections.length > 0 && (
          <div className="mx-6 mt-4 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-xs font-bold text-amber-300 uppercase tracking-wide">
                    Rilevati {analysis.urgentCorrections.length} filtri troppo severi: scartati setup che sono andati a target!
                  </h4>
                  <p className="text-[11px] text-slate-300 font-sans mt-0.5">
                    Il sistema suggerisce di allentare le soglie per la sessione successiva, permettendo di includere più opportunità ad alta probabilità senza sacrificare la sicurezza.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onApplyAllUrgentCorrections}
                className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-amber-500/20 shrink-0 cursor-pointer transition-all"
              >
                <Sliders className="w-3.5 h-3.5" />
                <span>Applica Tutte le Correzioni</span>
              </button>
            </div>
          </div>
        )}

        {/* Tab Selector */}
        <div className="flex items-center justify-between px-6 pt-4 pb-2 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('CATEGORIES')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                activeTab === 'CATEGORIES'
                  ? 'bg-purple-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              Matrice di Efficacia per Categoria ({analysis.categories.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('CANDIDATES')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                activeTab === 'CANDIDATES'
                  ? 'bg-purple-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              Registro Setup Esclusi ({records.length})
            </button>
          </div>

          {records.length > 0 && (
            <button
              type="button"
              onClick={onClearRecords}
              className="text-[11px] text-slate-400 hover:text-rose-400 flex items-center gap-1 cursor-pointer transition-colors"
              title="Azzera storico esclusioni"
            >
              <Trash2 className="w-3 h-3" />
              <span>Azzera Registro</span>
            </button>
          )}
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          
          {/* TAB 1: Matrice per Categoria di Esclusione */}
          {activeTab === 'CATEGORIES' && (
            <div className="space-y-4">
              {analysis.categories.length === 0 ? (
                <div className="p-8 text-center text-slate-400">
                  <Clock className="w-8 h-8 mx-auto mb-2 text-slate-500 animate-spin" />
                  <p className="text-xs">Nessun titolo escluso al momento. Esegui uno screening per popolare il registro.</p>
                </div>
              ) : (
                analysis.categories.map((cat) => {
                  const resolved = cat.profitCount + cat.lossCount + cat.expiredCount;
                  const profitPct = resolved > 0 ? (cat.profitCount / resolved) * 100 : 0;
                  const lossPct = resolved > 0 ? (cat.lossCount / resolved) * 100 : 0;
                  const expiredPct = resolved > 0 ? (cat.expiredCount / resolved) * 100 : 0;

                  return (
                    <div
                      key={cat.category}
                      className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 hover:border-slate-700 transition-all space-y-3"
                    >
                      {/* Category Header & Verdict */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-white">{cat.label}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-bold">
                              {cat.totalExcluded} Esclusi
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 font-sans mt-0.5">
                            {cat.verdictDescription}
                          </p>
                        </div>

                        {/* Verdict Badge */}
                        <div className="shrink-0">
                          {cat.verdict === 'TOO_RESTRICTIVE' && (
                            <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-amber-950/80 text-amber-300 border border-amber-800 flex items-center gap-1.5">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              <span>Filtro Troppo Severo</span>
                            </span>
                          )}
                          {cat.verdict === 'EFFECTIVE_SHIELD' && (
                            <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-950/80 text-emerald-300 border border-emerald-800 flex items-center gap-1.5">
                              <ShieldCheck className="w-3.5 h-3.5" />
                              <span>Scudo Efficace (+{cat.savedPnlEur} €)</span>
                            </span>
                          )}
                          {cat.verdict === 'BALANCED' && (
                            <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-slate-800 text-slate-300 border border-slate-700">
                              Bilanciato
                            </span>
                          )}
                          {cat.verdict === 'INSUFFICIENT_SAMPLE' && (
                            <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-800/60 text-slate-400 border border-slate-700/60">
                              Dati in accumulazione
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Distribution Bar */}
                      <div>
                        <div className="flex items-center justify-between text-[11px] mb-1.5 text-slate-400">
                          <span className="text-emerald-400 font-bold">
                            {cat.profitCount} a Profitto ({profitPct.toFixed(1)}%)
                          </span>
                          <span className="text-rose-400 font-bold">
                            {cat.lossCount} in Stop ({lossPct.toFixed(1)}%)
                          </span>
                          <span className="text-amber-400 font-bold">
                            {cat.expiredCount} Scaduti
                          </span>
                          {cat.monitoringCount > 0 && (
                            <span className="text-indigo-400 font-bold">
                              {cat.monitoringCount} in Monitoraggio
                            </span>
                          )}
                        </div>
                        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden flex">
                          <div
                            style={{ width: `${profitPct}%` }}
                            className="bg-emerald-500 h-full transition-all"
                            title={`A Profitto: ${cat.profitCount}`}
                          />
                          <div
                            style={{ width: `${lossPct}%` }}
                            className="bg-rose-500 h-full transition-all"
                            title={`In Stop Loss: ${cat.lossCount}`}
                          />
                          <div
                            style={{ width: `${expiredPct}%` }}
                            className="bg-amber-500 h-full transition-all"
                            title={`Scaduti: ${cat.expiredCount}`}
                          />
                        </div>
                      </div>

                      {/* Proposal Action Box if TOO_RESTRICTIVE */}
                      {cat.correctionProposal && (
                        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
                          <div>
                            <span className="text-[10px] uppercase font-bold text-amber-300 block">
                              Miglioramento Consigliato per la Prossima Sessione:
                            </span>
                            <p className="text-slate-200 font-sans mt-0.5">
                              {cat.correctionProposal.explanation}
                            </p>
                            <div className="flex items-center gap-2 mt-1 text-[11px] font-mono">
                              <span className="text-slate-400">Attuale: {cat.correctionProposal.currentValue}</span>
                              <ArrowRight className="w-3 h-3 text-amber-400" />
                              <span className="text-amber-300 font-bold">Proposto: {cat.correctionProposal.proposedValue}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              onApplyCorrection(
                                cat.correctionProposal!.parameterKey,
                                cat.correctionProposal!.proposedValue,
                                cat.correctionProposal!.explanation
                              )
                            }
                            className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/50 font-bold text-xs shrink-0 cursor-pointer transition-colors"
                          >
                            Applica Correzione
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* TAB 2: Registro Dettagliato Setup Esclusi */}
          {activeTab === 'CANDIDATES' && (
            <div className="space-y-3">
              {/* Filter controls */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <div className="relative flex-1 sm:w-64">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Cerca ticker o nome..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 placeholder-slate-500 text-xs focus:outline-none focus:border-purple-500"
                    />
                  </div>

                  <select
                    value={selectedStatusFilter}
                    onChange={(e) => setSelectedStatusFilter(e.target.value)}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none"
                  >
                    <option value="ALL">Tutti gli Esiti</option>
                    <option value="THEORETICAL_PROFIT">A Profitto 🎯</option>
                    <option value="THEORETICAL_STOP">In Stop 🛑</option>
                    <option value="MONITORING">In Monitoraggio ⏳</option>
                    <option value="THEORETICAL_EXPIRED">Scaduti ⏰</option>
                  </select>
                </div>

                <div className="text-[11px] text-slate-400">
                  Visualizzati: {filteredRecords.length} su {records.length}
                </div>
              </div>

              {/* Records Table */}
              <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px] border-b border-slate-800">
                    <tr>
                      <th className="p-3">Ticker & Mercato</th>
                      <th className="p-3">Causa di Esclusione</th>
                      <th className="p-3">Direzione</th>
                      <th className="p-3">Prezzo / Trigger</th>
                      <th className="p-3">Target / Stop</th>
                      <th className="p-3">Esito Live</th>
                      <th className="p-3 text-right">P&L Teorico</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono">
                    {filteredRecords.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="p-6 text-center text-slate-500">
                          Nessun record corrispondente ai filtri impostati.
                        </td>
                      </tr>
                    ) : (
                      filteredRecords.map((r) => {
                        return (
                          <tr key={r.id} className="hover:bg-slate-900/40 transition-colors">
                            <td className="p-3">
                              <span className="font-bold text-white block">{r.ticker}</span>
                              <span className="text-[10px] text-slate-400 block truncate max-w-[140px] font-sans">
                                {r.name}
                              </span>
                            </td>
                            <td className="p-3">
                              <span className="text-amber-300 font-semibold text-[11px] block">
                                {r.primaryReasonLabel}
                              </span>
                              <span className="text-[10px] text-slate-400 font-sans block max-w-xs truncate">
                                {r.detail}
                              </span>
                            </td>
                            <td className="p-3">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  r.direction === 'LONG'
                                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                                    : 'bg-rose-950 text-rose-400 border border-rose-800'
                                }`}
                              >
                                {r.direction}
                              </span>
                            </td>
                            <td className="p-3">
                              <span className="text-slate-200 block">
                                Iniziale: {r.initialPrice.toFixed(2)} {r.currency}
                              </span>
                              <span className="text-[10px] text-slate-400 block">
                                Trigger: {r.entryTrigger.toFixed(2)}
                              </span>
                            </td>
                            <td className="p-3">
                              <span className="text-emerald-400 block text-[11px]">
                                T1: {r.target1.toFixed(2)}
                              </span>
                              <span className="text-rose-400 block text-[10px]">
                                SL: {r.stopLoss.toFixed(2)}
                              </span>
                            </td>
                            <td className="p-3">
                              {r.outcomeStatus === 'THEORETICAL_PROFIT' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950 text-emerald-300 border border-emerald-800 flex items-center gap-1 w-max">
                                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                                  <span>TARGET RAGGIUNTO</span>
                                </span>
                              )}
                              {r.outcomeStatus === 'THEORETICAL_STOP' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-950 text-rose-300 border border-rose-800 flex items-center gap-1 w-max">
                                  <ShieldAlert className="w-3 h-3 text-rose-400" />
                                  <span>STOP LOSS TOCCATO</span>
                                </span>
                              )}
                              {r.outcomeStatus === 'MONITORING' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-950 text-indigo-300 border border-indigo-800 flex items-center gap-1 w-max">
                                  <Clock className="w-3 h-3 animate-spin text-indigo-400" />
                                  <span>IN MONITORAGGIO</span>
                                </span>
                              )}
                              {r.outcomeStatus === 'THEORETICAL_EXPIRED' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700 w-max">
                                  SCADUTO AL CUTOFF
                                </span>
                              )}
                            </td>
                            <td className="p-3 text-right">
                              {r.outcomeStatus === 'THEORETICAL_PROFIT' && (
                                <div>
                                  <span className="text-emerald-400 font-bold block">
                                    +{r.theoreticalRMultiple}R
                                  </span>
                                  <span className="text-[10px] text-emerald-500 block">
                                    +{r.theoreticalPnlEur} €
                                  </span>
                                </div>
                              )}
                              {r.outcomeStatus === 'THEORETICAL_STOP' && (
                                <div>
                                  <span className="text-rose-400 font-bold block">
                                    -1.00R
                                  </span>
                                  <span className="text-[10px] text-rose-500 block">
                                    {r.theoreticalPnlEur} €
                                  </span>
                                </div>
                              )}
                              {r.outcomeStatus === 'MONITORING' && (
                                <span className="text-slate-500 text-[10px]">In corso...</span>
                              )}
                              {r.outcomeStatus === 'THEORETICAL_EXPIRED' && (
                                <span className="text-slate-500 text-[10px]">0.0R (BE)</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800 bg-slate-950 text-xs">
          <div className="flex items-center gap-2 text-slate-400">
            <HelpCircle className="w-4 h-4 text-slate-500" />
            <span>
              L'autoanalisi converte i falsi negativi in apprendimento continuo, allentando i filtri solo quando i dati reali confermano profitti persi.
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold cursor-pointer transition-colors"
          >
            Chiudi
          </button>
        </div>

      </div>
    </div>
  );
};
