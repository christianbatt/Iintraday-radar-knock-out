import React from 'react';
import { OptimizationProposal, SystemParameters } from '../types/radar';
import {
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Sliders,
  ChevronRight,
  TrendingUp,
  Clock,
} from 'lucide-react';

interface SystemOptimizationBannerProps {
  proposal: OptimizationProposal | null;
  parameters: SystemParameters;
  totalCompletedSetups: number;
  onOpenAuditModal: () => void;
}

export const SystemOptimizationBanner: React.FC<SystemOptimizationBannerProps> = ({
  proposal,
  parameters,
  totalCompletedSetups,
  onOpenAuditModal,
}) => {
  const currentCycleProgress = totalCompletedSetups % 20;
  const currentCycleNumber = Math.max(1, Math.floor(totalCompletedSetups / 20) + (currentCycleProgress === 0 && totalCompletedSetups > 0 ? 0 : 1));

  // If there is a pending proposal with changes, show prominent alert notification
  if (proposal && proposal.status === 'PENDING' && proposal.proposedChanges.length > 0) {
    const expiredCount = proposal.metrics.expired;
    const isCriticalExpired = proposal.metrics.expiredRate >= 20;

    return (
      <div className="mb-6 rounded-2xl bg-gradient-to-r from-amber-950/80 via-slate-900 to-indigo-950/80 border-2 border-amber-500/60 p-4 sm:p-5 shadow-2xl shadow-amber-950/30 animate-fadeIn">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/50 flex items-center justify-center text-amber-400 shrink-0 mt-0.5">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500 text-slate-950 uppercase">
                  Ciclo #{proposal.cycleNumber} Concluso (20 Setup)
                </span>
                <span className="text-xs font-mono text-amber-300 font-semibold flex items-center gap-1">
                  <Sliders className="w-3.5 h-3.5" /> Proposta di Automiglioramento Pronta
                </span>
                {proposal.statisticalSignificance && (
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono border font-bold ${
                      proposal.statisticalSignificance === 'ELEVATA'
                        ? 'bg-emerald-950 text-emerald-300 border-emerald-700'
                        : proposal.statisticalSignificance === 'MODERATA'
                        ? 'bg-sky-950 text-sky-300 border-sky-700'
                        : 'bg-amber-950 text-amber-300 border-amber-700'
                    }`}
                  >
                    Statistica: {proposal.statisticalSignificance} ({proposal.evaluatedTradesCount}/15 min)
                  </span>
                )}
                {isCriticalExpired && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-rose-950 text-rose-300 border border-rose-700 flex items-center gap-1">
                    <Clock className="w-3 h-3 text-rose-400" /> {expiredCount} Expired Rilevati
                  </span>
                )}
              </div>
              <h3 className="text-sm sm:text-base font-bold text-white mt-1">
                {proposal.summaryTitle}
              </h3>
              <p className="text-xs text-slate-300 mt-0.5 max-w-2xl leading-relaxed">
                Il motore quantitativo ha analizzato gli ultimi 20 setup completati e ha individuato{' '}
                <strong className="text-amber-300">{proposal.proposedChanges.length} modifiche ai parametri</strong> per{' '}
                {isCriticalExpired ? 'abbattere il tasso di expired e anticipare i target' : 'migliorare il win rate ed eliminare i falsi breakout'}.
                È richiesta la tua autorizzazione per applicare i nuovi parametri.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={onOpenAuditModal}
              className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 text-xs font-bold font-mono shadow-lg shadow-amber-950/40 flex items-center justify-center gap-2 transition-all active:scale-95 cursor-pointer"
            >
              <span>Esamina e Decidi</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // If proposal exists and was accepted or no changes needed
  if (proposal && proposal.status === 'NO_CHANGES_NEEDED') {
    return (
      <div className="mb-6 rounded-xl bg-slate-900/90 border border-emerald-500/40 p-3 sm:p-4 shadow-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 font-mono text-xs">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
            <CheckCircle2 className="w-4 h-4" />
          </div>
          <div>
            <div className="text-white font-bold flex items-center gap-2">
              <span>Ciclo #{proposal.cycleNumber} Concluso: Parametri Confermati</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
                Win Rate {proposal.metrics.winRate}% • Netto +{proposal.metrics.netPnlEur} €
              </span>
            </div>
            <p className="text-slate-400 text-[11px] font-sans">
              Ottimo rendimento senza debolezze strutturali. Secondo le regole quantitative, i parametri attuali (V{parameters.version}) restano in vigore.
            </p>
          </div>
        </div>

        <button
          onClick={onOpenAuditModal}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] transition-colors shrink-0"
        >
          Vedi Dettagli Ciclo
        </button>
      </div>
    );
  }

  // Baseline Progress Banner: X/20 setups in the current cycle
  return (
    <div className="mb-6 rounded-xl bg-slate-900/60 border border-slate-800 p-3 sm:p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 font-mono text-xs">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
          <Sliders className="w-4 h-4" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-white font-bold text-xs uppercase tracking-wider">
              Motore di Automiglioramento Sistemico
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800">
              Parametri V{parameters.version}
            </span>
          </div>
          <div className="text-[11px] text-slate-400 font-sans mt-0.5">
            Analisi quantitativa automatica eseguita ogni <strong>20 setup conclusi</strong> per ridurre gli expired e massimizzare il win rate.
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end">
        {/* Progress bar to 20 setups */}
        <div className="flex items-center gap-2">
          <div className="w-24 bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
            <div
              className="bg-indigo-500 h-full transition-all duration-300"
              style={{ width: `${Math.min(100, (currentCycleProgress / 20) * 100)}%` }}
            />
          </div>
          <span className="text-[11px] text-indigo-300 font-bold font-mono">
            {currentCycleProgress}/20 Setup
          </span>
        </div>

        <button
          onClick={onOpenAuditModal}
          className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-[11px] transition-colors shrink-0"
          title="Apri pannello di audit e parametri del motore"
        >
          Audit Motore
        </button>
      </div>
    </div>
  );
};
