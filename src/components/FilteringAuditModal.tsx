import React, { useState } from 'react';
import {
  X,
  Filter,
  ShieldAlert,
  Search,
  CheckCircle2,
  AlertTriangle,
  Info,
  Sliders,
  TrendingDown,
  Activity,
  Layers,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { FilteringAuditReport, ExclusionCategory } from '../types/radar';

interface FilteringAuditModalProps {
  isOpen: boolean;
  onClose: () => void;
  report: FilteringAuditReport | null;
  onOpenOptimizerModal?: () => void;
  onOpenExcludedAnalyzer?: () => void;
}

export const FilteringAuditModal: React.FC<FilteringAuditModalProps> = ({
  isOpen,
  onClose,
  report,
  onOpenOptimizerModal,
  onOpenExcludedAnalyzer,
}) => {
  const [filterCategory, setFilterCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  if (!isOpen || !report) return null;

  const filteredList = report.excludedList.filter((item) => {
    if (filterCategory !== 'ALL' && item.primaryReasonCategory !== filterCategory) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return item.ticker.toLowerCase().includes(q) || item.name.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-slate-100 font-mono">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <Filter className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white uppercase tracking-wider">
                  Visual Audit del Filtraggio • Analisi Rigore
                </h3>
                <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  {report.totalScanned} Sottostanti
                </span>
              </div>
              <p className="text-xs text-slate-400 font-sans mt-0.5">
                Trasparenza al 100%: visualizza esattamente quanti titoli sono stati esclusi e quale regola di preservazione del capitale li ha scartati
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

        {/* Breakdown Stats Grid */}
        <div className="p-5 border-b border-slate-800 bg-slate-950/60 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase">Titoli Scansionati</span>
            <span className="text-lg font-bold text-white">{report.totalScanned}</span>
            <span className="text-[10px] text-slate-500 block mt-0.5">Paniere attivo</span>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase">Idonei a Setup</span>
            <span className="text-lg font-bold text-emerald-400">{report.qualifiedCount}</span>
            <span className="text-[10px] text-emerald-500/80 block mt-0.5">Hanno passato tutti i filtri</span>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase">Scartati / Esclusi</span>
            <span className="text-lg font-bold text-rose-400">{report.excludedCount}</span>
            <span className="text-[10px] text-rose-500/80 block mt-0.5">Protezione del capitale</span>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase">Tasso di Selettività</span>
            <span className="text-lg font-bold text-amber-400">
              {report.totalScanned > 0 ? +((report.excludedCount / report.totalScanned) * 100).toFixed(1) : 0}%
            </span>
            <span className="text-[10px] text-slate-500 block mt-0.5">Filtri di rigore attivi</span>
          </div>
        </div>

        {/* Filter Categories Toolbar */}
        <div className="px-6 py-3 bg-slate-950/40 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <button
              onClick={() => setFilterCategory('ALL')}
              className={`px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                filterCategory === 'ALL'
                  ? 'bg-slate-700 text-white font-bold'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
              }`}
            >
              Tutti gli Esclusi ({report.excludedCount})
            </button>
            {report.countsByCategory.gapInsufficient > 0 && (
              <button
                onClick={() => setFilterCategory('GAP_INSUFFICIENT')}
                className={`px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                  filterCategory === 'GAP_INSUFFICIENT'
                    ? 'bg-rose-900/80 text-rose-200 font-bold border border-rose-700'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                Gap Insufficiente ({report.countsByCategory.gapInsufficient})
              </button>
            )}
            {report.countsByCategory.rvolInsufficient > 0 && (
              <button
                onClick={() => setFilterCategory('RVOL_INSUFFICIENT')}
                className={`px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                  filterCategory === 'RVOL_INSUFFICIENT'
                    ? 'bg-amber-900/80 text-amber-200 font-bold border border-amber-700'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                RVOL Basso ({report.countsByCategory.rvolInsufficient})
              </button>
            )}
            {report.countsByCategory.rsiExtreme > 0 && (
              <button
                onClick={() => setFilterCategory('RSI_EXTREME')}
                className={`px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                  filterCategory === 'RSI_EXTREME'
                    ? 'bg-purple-900/80 text-purple-200 font-bold border border-purple-700'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                RSI Fuori Range ({report.countsByCategory.rsiExtreme})
              </button>
            )}
            {report.countsByCategory.scoreBelowMin > 0 && (
              <button
                onClick={() => setFilterCategory('SCORE_BELOW_MIN')}
                className={`px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                  filterCategory === 'SCORE_BELOW_MIN'
                    ? 'bg-indigo-900/80 text-indigo-200 font-bold border border-indigo-700'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                Score Basso ({report.countsByCategory.scoreBelowMin})
              </button>
            )}
            {report.countsByCategory.catalystUnverified > 0 && (
              <button
                onClick={() => setFilterCategory('CATALYST_UNVERIFIED')}
                className={`px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                  filterCategory === 'CATALYST_UNVERIFIED'
                    ? 'bg-sky-900/80 text-sky-200 font-bold border border-sky-700'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                Catalizzatore / Utili ({report.countsByCategory.catalystUnverified})
              </button>
            )}
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Filtra ticker..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-7 pr-3 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white placeholder-slate-500 w-36 sm:w-44 focus:outline-none focus:border-amber-500"
            />
          </div>
        </div>

        {/* Scrollable List of Excluded Candidates */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {filteredList.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-xs">
              Nessun titolo corrisponde ai criteri di filtro selezionati.
            </div>
          ) : (
            filteredList.map((item) => (
              <div
                key={item.ticker}
                className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/80 hover:border-slate-700 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-bold text-white text-sm">{item.ticker}</span>
                    <span className="text-slate-400 font-sans text-xs truncate max-w-xs">{item.name}</span>
                    <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-slate-900 text-slate-400 border border-slate-800">
                      {item.market}
                    </span>
                    <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-slate-900 text-amber-300 border border-slate-800">
                      Score: {item.score}/100
                    </span>
                  </div>

                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-bold text-rose-400 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      {item.primaryReasonLabel}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 font-sans mt-0.5 leading-relaxed">
                    {item.detail}
                  </p>
                </div>

                <div className="flex items-center gap-2 text-right text-[11px] bg-slate-900/60 p-2 rounded-lg border border-slate-800 shrink-0 self-end sm:self-center">
                  <div>
                    <span className="text-[9px] text-slate-500 block">Gap %</span>
                    <span className={`font-bold ${(item.gapPercent ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {item.gapPercent != null ? `${(item.gapPercent ?? 0) >= 0 ? '+' : ''}${item.gapPercent}%` : 'nd'}
                    </span>
                  </div>
                  <div className="border-l border-slate-800 pl-2">
                    <span className="text-[9px] text-slate-500 block">RVOL</span>
                    <span className="font-bold text-amber-300">
                      {item.rvol != null ? `${item.rvol}x` : 'nd'}
                    </span>
                  </div>
                  <div className="border-l border-slate-800 pl-2">
                    <span className="text-[9px] text-slate-500 block">RSI</span>
                    <span className="font-bold text-sky-300">
                      {item.rsi != null ? item.rsi : 'nd'}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer with Optimizer CTA */}
        <div className="p-4 border-t border-slate-800 bg-slate-950 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-slate-400 text-[11px] font-sans">
            <Info className="w-4 h-4 text-sky-400 shrink-0" />
            <span>
              Troppi titoli scartati? Puoi ricalibrare la soglia di score o i filtri minimi tramite l'Ottimizzatore Parametri.
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {onOpenExcludedAnalyzer && (
              <button
                onClick={() => {
                  onClose();
                  onOpenExcludedAnalyzer();
                }}
                className="px-3 py-1.5 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/40 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Apri autoanalisi per verificare quanti esclusi sono andati a target"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Autoanalisi Esclusi</span>
              </button>
            )}
            {onOpenOptimizerModal && (
              <button
                onClick={() => {
                  onClose();
                  onOpenOptimizerModal();
                }}
                className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Sliders className="w-3.5 h-3.5" />
                <span>Ricalibra Parametri</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-colors cursor-pointer"
            >
              Chiudi
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
