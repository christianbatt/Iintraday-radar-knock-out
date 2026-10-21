import React from 'react';
import {
  OptimizationProposal,
  SystemParameters,
  TradeJournalEntry,
} from '../types/radar';
import {
  Sliders,
  Sparkles,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  TrendingUp,
  X,
  ArrowRight,
  ShieldAlert,
  Award,
  RefreshCw,
  Info,
} from 'lucide-react';

interface SystemOptimizerModalProps {
  isOpen: boolean;
  onClose: () => void;
  proposal: OptimizationProposal | null;
  currentParameters: SystemParameters;
  onAcceptProposal: () => void;
  onRejectProposal: () => void;
  onRunAuditOnDemand: () => void;
  trades: TradeJournalEntry[];
}

export const SystemOptimizerModal: React.FC<SystemOptimizerModalProps> = ({
  isOpen,
  onClose,
  proposal,
  currentParameters,
  onAcceptProposal,
  onRejectProposal,
  onRunAuditOnDemand,
  trades,
}) => {
  if (!isOpen) return null;

  const totalCompletedTrades = trades.length;
  const currentBatchTrades = trades.slice(0, 20);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-slate-950/80 backdrop-blur-md overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-4xl shadow-2xl overflow-hidden my-auto max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-950 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white uppercase tracking-wider font-mono">
                  Motore di Automiglioramento Sistemico
                </h2>
                <span className="text-[10px] px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 font-mono font-bold">
                  Versione V{currentParameters.version}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Audit quantitativo ogni 20 setup: diagnosi dei punti deboli e proposta di ricalibrazione
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onRunAuditOnDemand}
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono transition-colors"
              title="Ricalcola audit istantaneamente sui setup presenti nel diario"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Ricalcola Audit</span>
            </button>

            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Scrollable Body */}
        <div className="p-6 overflow-y-auto space-y-6 text-xs text-slate-200">
          {/* Summary / Proposal Banner */}
          {proposal ? (
            <div
              className={`p-4 rounded-xl border ${
                proposal.performanceRating === 'EXCELLENT'
                  ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-200'
                  : proposal.performanceRating === 'CRITICAL'
                  ? 'bg-rose-950/40 border-rose-500/60 text-rose-200'
                  : 'bg-amber-950/40 border-amber-500/50 text-amber-200'
              }`}
            >
              <div className="flex items-start gap-3">
                {proposal.performanceRating === 'EXCELLENT' ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-white font-mono">
                      {proposal.summaryTitle}
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-300">
                      Ciclo #{proposal.cycleNumber} • {proposal.evaluatedTradesCount} Setup
                    </span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed font-sans">
                    {proposal.summaryExplanation}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 text-slate-400 flex items-center justify-between gap-3">
              <div>
                <span className="text-white font-bold block mb-1">
                  Nessun audit completato per il ciclo attuale ({totalCompletedTrades}/20 Setup)
                </span>
                <span>
                  Registra o carica i 20 setup conclusi per attivare automaticamente l'analisi di ottimizzazione.
                </span>
              </div>
              <button
                onClick={onRunAuditOnDemand}
                className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold font-mono transition-colors shrink-0"
              >
                Esegui Audit Ora
              </button>
            </div>
          )}

          {/* Key Metrics of Evaluated Batch */}
          {proposal && (
            <div>
              <h4 className="font-bold uppercase tracking-wider text-[11px] text-slate-400 mb-2.5 font-mono flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                <span>Statistiche del Ciclo Analizzato ({proposal.evaluatedTradesCount} Setup)</span>
              </h4>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2.5 font-mono">
                {/* Win Rate */}
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                  <span className="text-[10px] text-slate-400 block mb-1">Win Rate %</span>
                  <div className="text-sm font-bold text-white flex items-center gap-1">
                    <Award className="w-3.5 h-3.5 text-amber-400" />
                    <span>{proposal.metrics.winRate}%</span>
                  </div>
                  <span className="text-[10px] text-slate-500">
                    {proposal.metrics.wins}W / {proposal.metrics.totalSetups} Totali
                  </span>
                </div>

                {/* Expired Rate (Crucial Metric!) */}
                <div
                  className={`p-3 rounded-xl border ${
                    proposal.metrics.expiredRate >= 20
                      ? 'bg-rose-950/50 border-rose-600/70'
                      : 'bg-slate-950 border-slate-800'
                  }`}
                >
                  <span className="text-[10px] text-slate-400 block mb-1 flex items-center justify-between">
                    <span>Scaduti (Expired)</span>
                    <Clock className="w-3 h-3 text-amber-400" />
                  </span>
                  <div
                    className={`text-sm font-bold ${
                      proposal.metrics.expiredRate >= 20 ? 'text-rose-400' : 'text-slate-200'
                    }`}
                  >
                    {proposal.metrics.expiredRate}%
                  </div>
                  <span className="text-[10px] text-slate-400">
                    {proposal.metrics.expired} setup non chiusi
                  </span>
                </div>

                {/* Losses */}
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                  <span className="text-[10px] text-slate-400 block mb-1">Stop Loss (-1R)</span>
                  <div className="text-sm font-bold text-rose-400">
                    {proposal.metrics.lossRate}%
                  </div>
                  <span className="text-[10px] text-slate-500">
                    {proposal.metrics.losses} stop colpiti
                  </span>
                </div>

                {/* Breakevens */}
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                  <span className="text-[10px] text-slate-400 block mb-1">Breakeven / Flat</span>
                  <div className="text-sm font-bold text-slate-300">
                    {proposal.metrics.breakevens}
                  </div>
                  <span className="text-[10px] text-slate-500">Uscite a 0R</span>
                </div>

                {/* Net P&L € */}
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                  <span className="text-[10px] text-slate-400 block mb-1">P&L Netto Ciclo</span>
                  <div
                    className={`text-sm font-bold ${
                      proposal.metrics.netPnlEur > 0
                        ? 'text-emerald-400'
                        : proposal.metrics.netPnlEur < 0
                        ? 'text-rose-400'
                        : 'text-white'
                    }`}
                  >
                    {proposal.metrics.netPnlEur > 0
                      ? `+${proposal.metrics.netPnlEur}`
                      : proposal.metrics.netPnlEur}{' '}
                    €
                  </div>
                  <span className="text-[10px] text-slate-400">
                    Post-commissioni
                  </span>
                </div>

                {/* Profit Factor */}
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                  <span className="text-[10px] text-slate-400 block mb-1">Profit Factor</span>
                  <div className="text-sm font-bold text-sky-400">
                    {proposal.metrics.profitFactor.toFixed(2)}
                  </div>
                  <span className="text-[10px] text-slate-500">R:R medio {proposal.metrics.avgR}R</span>
                </div>
              </div>
            </div>
          )}

          {/* Strengths & Weaknesses Breakdown */}
          {proposal && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Strengths */}
              <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-4">
                <h5 className="font-bold text-emerald-400 uppercase tracking-wider text-[11px] mb-2 flex items-center gap-1.5 font-mono">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>Cosa Ha Funzionato Bene</span>
                </h5>
                {proposal.identifiedStrengths.length > 0 ? (
                  <ul className="space-y-1.5 text-xs text-slate-300">
                    {proposal.identifiedStrengths.map((s, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="text-emerald-400 font-bold">•</span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-slate-500 italic text-[11px]">
                    Nessun punto di forza statisticamente rilevante isolato nel ciclo.
                  </p>
                )}
              </div>

              {/* Weaknesses */}
              <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-4">
                <h5 className="font-bold text-amber-400 uppercase tracking-wider text-[11px] mb-2 flex items-center gap-1.5 font-mono">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  <span>Punti Deboli Individuati</span>
                </h5>
                {proposal.identifiedWeaknesses.length > 0 ? (
                  <ul className="space-y-1.5 text-xs text-slate-300">
                    {proposal.identifiedWeaknesses.map((w, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="text-amber-400 font-bold">•</span>
                        <span>{w}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-emerald-400 text-[11px] flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Nessuna criticità rilevata. Il sistema opera in piena efficienza.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Proposed Changes Table & User Decision Box */}
          {proposal && proposal.proposedChanges.length > 0 ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-bold uppercase tracking-wider text-[11px] text-amber-300 font-mono flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-amber-400" />
                  <span>Modifiche ai Parametri Proposte dal Sistema ({proposal.proposedChanges.length})</span>
                </h4>
                <span className="text-[11px] text-slate-400 font-mono">
                  Richiesta tua approvazione esplicita
                </span>
              </div>

              <div className="border border-amber-500/30 rounded-xl overflow-hidden bg-slate-950/90 shadow-xl">
                <div className="divide-y divide-slate-800">
                  {proposal.proposedChanges.map((change, idx) => (
                    <div key={idx} className="p-4 space-y-2.5">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div>
                          <span className="font-bold text-white text-xs block font-mono">
                            {change.label}
                          </span>
                          <span className="text-[10px] text-slate-500 font-mono">
                            Parametro: <code className="text-slate-400">{change.parameterKey}</code>
                          </span>
                        </div>

                        {/* Current -> Proposed Badge */}
                        <div className="flex items-center gap-2 font-mono text-xs">
                          <span className="px-2.5 py-1 rounded-md bg-slate-900 border border-slate-700 text-slate-300">
                            Attuale: <strong className="text-white">{String(change.currentValue)}</strong>
                          </span>
                          <ArrowRight className="w-3.5 h-3.5 text-amber-400" />
                          <span className="px-2.5 py-1 rounded-md bg-amber-500/20 border border-amber-500/50 text-amber-300 font-bold">
                            Proposto: {String(change.proposedValue)}
                          </span>
                        </div>
                      </div>

                      {/* Why & Expected Benefit */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-1 text-slate-300 font-sans text-xs">
                        <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800">
                          <strong className="text-amber-400 text-[11px] block font-mono mb-0.5">
                            Perché Modificare:
                          </strong>
                          <p className="text-[11px] text-slate-300 leading-relaxed">
                            {change.reason}
                          </p>
                        </div>

                        <div className="bg-emerald-950/30 p-2.5 rounded-lg border border-emerald-800/40">
                          <strong className="text-emerald-400 text-[11px] block font-mono mb-0.5">
                            Benefici Reali Attesi:
                          </strong>
                          <p className="text-[11px] text-emerald-200 leading-relaxed">
                            {change.expectedBenefit}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Decision Action Bar */}
                {proposal.status === 'PENDING' && (
                  <div className="p-4 bg-slate-900/90 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3">
                    <div className="text-[11px] text-slate-400 font-sans">
                      Seleziona <strong>"Accetta"</strong> per iniziare ad applicare i nuovi parametri nei prossimi setup, oppure <strong>"Rifiuta"</strong> per mantenere invariata la configurazione attuale.
                    </div>

                    <div className="flex items-center gap-3 w-full sm:w-auto shrink-0">
                      <button
                        onClick={() => {
                          onRejectProposal();
                          onClose();
                        }}
                        className="flex-1 sm:flex-initial px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-bold font-mono text-xs transition-colors cursor-pointer"
                      >
                        Rifiuta (Mantieni Attuali)
                      </button>

                      <button
                        onClick={() => {
                          onAcceptProposal();
                          onClose();
                        }}
                        className="flex-1 sm:flex-initial px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold font-mono text-xs shadow-lg shadow-emerald-900/40 flex items-center justify-center gap-1.5 transition-all active:scale-95 cursor-pointer"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Accetta Modifiche</span>
                      </button>
                    </div>
                  </div>
                )}

                {proposal.status === 'ACCEPTED' && (
                  <div className="p-3 bg-emerald-950/60 border-t border-emerald-800/80 text-emerald-300 text-xs font-mono flex items-center justify-center gap-2">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Modifiche ACCETTATE ed applicate con successo! Parametri attivi: Versione V{currentParameters.version}.</span>
                  </div>
                )}

                {proposal.status === 'REJECTED' && (
                  <div className="p-3 bg-slate-800/80 border-t border-slate-700 text-slate-300 text-xs font-mono flex items-center justify-center gap-2">
                    <XCircle className="w-4 h-4 text-slate-400" />
                    <span>Proposta RIFIUTATA. Il sistema continua con i parametri correnti (Versione V{currentParameters.version}).</span>
                  </div>
                )}
              </div>
            </div>
          ) : proposal && proposal.status === 'NO_CHANGES_NEEDED' ? (
            <div className="p-5 rounded-xl bg-slate-950 border border-emerald-500/30 text-center space-y-2">
              <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
              <h4 className="text-sm font-bold text-white font-mono">
                Prestazioni Ottimali: Nessuna Modifica Necessaria
              </h4>
              <p className="text-xs text-slate-400 max-w-lg mx-auto">
                Con un Win Rate del {proposal.metrics.winRate}%, PnL positivo di +{proposal.metrics.netPnlEur} € e un tasso di Expired controllato al {proposal.metrics.expiredRate}%, la configurazione attuale soddisfa a pieno i criteri quantitativi. Nessun parametro viene alterato.
              </p>
            </div>
          ) : null}

          {/* Current Active Parameters Inspector */}
          <div className="border border-slate-800 rounded-xl bg-slate-950 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h5 className="font-bold text-xs uppercase tracking-wider text-slate-300 font-mono flex items-center gap-2">
                <Sliders className="w-4 h-4 text-indigo-400" />
                <span>Parametri Attivi del Sistema (Versione V{currentParameters.version})</span>
              </h5>
              <span className="text-[10px] text-slate-500 font-mono">
                Ultimo aggiornamento: {new Date(currentParameters.lastUpdated).toLocaleDateString('it-IT')}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono text-xs">
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block">Score Min EU / USA</span>
                <span className="text-white font-bold">{currentParameters.minScoreEurope ?? 48} / {currentParameters.minScoreUSA ?? 58}</span>
              </div>
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block">RVOL Min EU / USA</span>
                <span className="text-white font-bold">{currentParameters.minRvolEurope ?? 0.85}x / {currentParameters.minRvolUSA ?? 1.15}x</span>
              </div>
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block">Gap Min Europa / USA</span>
                <span className="text-white font-bold">{currentParameters.minGapEurope}% / {currentParameters.minGapUSA}%</span>
              </div>
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block">Target 1 (R-Multiple)</span>
                <span className="text-emerald-400 font-bold">{currentParameters.target1Multiplier}x R</span>
              </div>
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block">Target 2 (R-Multiple)</span>
                <span className="text-emerald-400 font-bold">{currentParameters.target2Multiplier}x R</span>
              </div>
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block">Offset Trigger Prezzo</span>
                <span className="text-white font-bold">{currentParameters.triggerOffsetPercent}%</span>
              </div>
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block">Tolleranza Stop Loss</span>
                <span className="text-rose-400 font-bold">{currentParameters.normalRiskMultiplier}x ATR</span>
              </div>
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block">Filtro RSI Attivo</span>
                <span className={`font-bold ${currentParameters.rsiFilterActive ? 'text-emerald-400' : 'text-slate-400'}`}>
                  {currentParameters.rsiFilterActive ? 'SÌ' : 'NO'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950 flex items-center justify-between gap-3 shrink-0">
          <div className="text-[11px] text-slate-400 flex items-center gap-1.5 font-sans">
            <Info className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span>I parametri vengono aggiornati solo su tua esplicita conferma e salvati nel browser.</span>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-colors"
          >
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
};
