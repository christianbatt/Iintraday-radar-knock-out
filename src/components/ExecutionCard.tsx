import React, { useState } from 'react';
import {
  ExecutionSetup,
  KnockOutCalculatorInput,
  KnockOutSafetyCheck,
} from '../types/radar';
import { calculateKnockOutSafety } from '../utils/calculator';
import {
  ShieldAlert,
  ShieldCheck,
  Calculator,
  ArrowUpRight,
  ArrowDownRight,
  Clock,
  Ban,
  CheckCircle,
  AlertTriangle,
  PlusCircle,
  Target,
  Sparkles,
} from 'lucide-react';

interface ExecutionCardProps {
  setup: ExecutionSetup;
  accountCapital: number;
  onUpdateAccountCapital: (val: number) => void;
  onSaveToJournal: (tradeData: any) => void;
  isPaperMode: boolean;
  circuitBreakerActive: boolean;
}

export const ExecutionCard: React.FC<ExecutionCardProps> = ({
  setup,
  accountCapital,
  onUpdateAccountCapital,
  onSaveToJournal,
  isPaperMode,
  circuitBreakerActive,
}) => {
  const isNoTrade = setup.decision === 'NESSUN_TRADE';

  const trigger = setup.triggerLevel ?? setup.candidate.preMarketPrice ?? setup.candidate.currentPrice ?? 0;
  const stop = setup.stopLossLevel ?? 0;
  const dist = Math.abs(trigger - stop);
  const defaultBarrier =
    trigger > 0 && dist > 0
      ? setup.direction === 'LONG'
        ? +(trigger - dist * 2.5).toFixed(2)
        : +(trigger + dist * 2.5).toFixed(2)
      : 0;

  const [barrierStrike, setBarrierStrike] = useState<number>(defaultBarrier);
  const [leverage, setLeverage] = useState<number>(10);
  const [certPrice, setCertPrice] = useState<number>(2.5);
  const [maxRiskPercent, setMaxRiskPercent] = useState<number>(1.0);
  const [tradeSaved, setTradeSaved] = useState<boolean>(false);

  // Sync barrier when selected candidate setup changes
  React.useEffect(() => {
    if (trigger > 0 && dist > 0) {
      setBarrierStrike(setup.direction === 'LONG' ? +(trigger - dist * 2.5).toFixed(2) : +(trigger + dist * 2.5).toFixed(2));
    }
  }, [setup.triggerLevel, setup.stopLossLevel, setup.direction]);

  // Recompute safety check whenever inputs or setup change
  const koInput: KnockOutCalculatorInput = {
    barrierStrike,
    leverage,
    certificatePrice: certPrice,
    accountCapital,
    maxRiskPercent,
  };

  const koSafety: KnockOutSafetyCheck = calculateKnockOutSafety(setup, koInput);

  const handleLogTrade = () => {
    if (circuitBreakerActive) {
      return;
    }

    onSaveToJournal({
      session: setup.candidate.market || 'EU',
      ticker: setup.candidate.ticker,
      direction: setup.direction,
      strategy: setup.strategy,
      entryPrice: setup.triggerLevel,
      stopLoss: setup.stopLossLevel,
      target1: setup.target1Level,
      target2: setup.target2Level,
      barrierStrike,
      leverage,
      suggestedCertificates: koSafety.suggestedCertificates,
      maxRiskEur: koSafety.maxRiskEur,
      investedEur: koSafety.totalInvestedEur,
      isPaper: isPaperMode,
    });
    setTradeSaved(true);
    setTimeout(() => setTradeSaved(false), 4000);
  };

  // If No Trade is decreed:
  if (isNoTrade) {
    return (
      <div className="bg-slate-900 border-2 border-slate-700 rounded-xl p-6 shadow-2xl mb-6">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400">
              <Ban className="w-6 h-6 text-slate-300" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold font-mono text-slate-200">
                  NESSUN TRADE OGGI
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400 text-xs font-mono border border-slate-700">
                  Preservazione Capitale
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Regola di disciplina: preferire non operare piuttosto che forzare un segnale con statistiche avverse.
              </p>
            </div>
          </div>
          <div className="text-xs font-mono bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800 text-slate-400">
            Orario Limite Sessione: {setup.cutoffTime}
          </div>
        </div>

        <div className="mt-5 p-4 rounded-lg bg-slate-950 border border-slate-800">
          <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <ShieldAlert className="w-4 h-4 text-amber-400" />
            Motivazione Esclusione
          </h4>
          <p className="text-sm text-slate-300 leading-relaxed font-mono">
            {setup.reasonNoTrade ||
              'Nessun titolo analizzato soddisfa contemporaneamente i filtri minimi di Gap, Relative Volume (RVOL), coerenza con i futures indice e catalizzatore verificato.'}
          </p>
        </div>

        {setup.catalystAnalysis && setup.catalystAnalysis.rischi.length > 0 && (
          <div className="mt-4 p-4 rounded-lg bg-rose-950/20 border border-rose-900/40 text-xs text-rose-300">
            <span className="font-semibold block mb-1">Criticità individuate dall'analisi:</span>
            <ul className="list-disc list-inside space-y-1 text-rose-300/80">
              {setup.catalystAnalysis.rischi.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // Active Qualified Trade Setup
  const isLong = setup.direction === 'LONG';

  return (
    <div className="bg-slate-900 border-2 border-emerald-500/40 rounded-xl overflow-hidden shadow-2xl mb-6">
      {/* Top Banner: Single Candidate Title */}
      <div className="bg-slate-950 px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className={`w-12 h-12 rounded-xl flex items-center justify-center font-bold text-white shadow-lg ${
              isLong ? 'bg-emerald-600' : 'bg-rose-600'
            }`}
          >
            {isLong ? <ArrowUpRight className="w-7 h-7" /> : <ArrowDownRight className="w-7 h-7" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold font-mono text-white">
                {setup.candidate.ticker}
              </span>
              <span className="text-xs text-slate-400 font-medium">({setup.candidate.name})</span>
              <span
                className={`px-2.5 py-0.5 rounded-full font-mono text-xs font-bold ${
                  isLong ? 'bg-emerald-950 text-emerald-300 border border-emerald-700' : 'bg-rose-950 text-rose-300 border border-rose-700'
                }`}
              >
                DIREZIONE: {setup.direction}
              </span>
              <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-xs font-mono border border-slate-700">
                UNICO CANDIDATO SESSIONE
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Setup: <strong className="text-slate-200">{setup.strategy}</strong> • Mercato {setup.candidate.market} ({setup.candidate.currency})
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 font-mono text-xs bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800 text-slate-300">
          <Clock className="w-3.5 h-3.5 text-amber-400" />
          <span>Cutoff Uscita: <strong className="text-amber-300">{setup.cutoffTime}</strong></span>
        </div>
      </div>

      <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column (7 cols): Execution Levels & Rules */}
        <div className="lg:col-span-7 space-y-5">
          {/* Key Price Levels Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* Trigger / Entry */}
            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-slate-400 block mb-1">
                Livello Trigger Entrata
              </span>
              <div className="text-base font-bold font-mono text-white">
                {setup.triggerLevel} {setup.candidate.currency}
              </div>
              <span className="text-[10px] text-emerald-400 font-medium">Breakout confermato</span>
            </div>

            {/* Stop Loss Underlying */}
            <div className="bg-slate-950 p-3 rounded-lg border border-rose-900/50">
              <span className="text-[10px] font-mono uppercase text-rose-400 block mb-1">
                Stop Loss Sottostante
              </span>
              <div className="text-base font-bold font-mono text-rose-400">
                {setup.stopLossLevel} {setup.candidate.currency}
              </div>
              <span className="text-[10px] text-slate-400 font-mono">
                Rischio: {Math.abs((setup.triggerLevel || 0) - (setup.stopLossLevel || 0)).toFixed(2)} pts
              </span>
            </div>

            {/* Target 1 (1.6R) */}
            <div className="bg-slate-950 p-3 rounded-lg border border-emerald-900/50">
              <span className="text-[10px] font-mono uppercase text-emerald-400 block mb-1">
                Target 1 (1.6R)
              </span>
              <div className="text-base font-bold font-mono text-emerald-300">
                {setup.target1Level} {setup.candidate.currency}
              </div>
              <span className="text-[10px] text-emerald-400 font-medium">Prendi 70% profitto</span>
            </div>

            {/* Target 2 (2.8R) */}
            <div className="bg-slate-950 p-3 rounded-lg border border-emerald-900/50">
              <span className="text-[10px] font-mono uppercase text-emerald-400 block mb-1">
                Target 2 (2.8R)
              </span>
              <div className="text-base font-bold font-mono text-emerald-400">
                {setup.target2Level} {setup.candidate.currency}
              </div>
              <span className="text-[10px] text-slate-400 font-mono">Trailing VWAP</span>
            </div>
          </div>

          {/* Operational Confirmation Checklist */}
          <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-2.5 text-xs">
            <h4 className="font-semibold text-slate-200 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5 text-emerald-400" />
              Condizioni di Ingresso Precise sul Sottostante
            </h4>
            <div className="space-y-2 text-slate-300">
              <div className="flex items-start gap-2">
                <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="text-white">Conferma VWAP:</strong> {setup.vwapCondition}
                </div>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="text-white">Volume al Breakout:</strong> {setup.volumeCondition}
                </div>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="text-white">Filtro Gap:</strong> Gap attuale{' '}
                  <span className="font-mono text-emerald-400 font-bold">
                    {setup.candidate.gapPercent != null ? `${setup.candidate.gapPercent}%` : 'nd'}
                  </span>{' '}
                  e RVOL <span className="font-mono text-amber-300">{setup.candidate.rvol}x</span>.
                </div>
              </div>
            </div>
          </div>

          {/* Invalidation Rules */}
          <div className="bg-rose-950/20 p-4 rounded-lg border border-rose-900/50 text-xs">
            <h4 className="font-semibold text-rose-300 uppercase tracking-wider text-[11px] mb-2 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
              Cosa Invalida il Trade ed Uscita di Emergenza
            </h4>
            <ul className="list-disc list-inside space-y-1 text-rose-200/90 text-[11px]">
              {setup.invalidationConditions.map((cond, idx) => (
                <li key={idx}>{cond}</li>
              ))}
            </ul>
          </div>

          {/* Catalyst Note if present */}
          {setup.catalystAnalysis && (
            <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 text-xs">
              <div className="flex items-center gap-1.5 text-slate-300 font-semibold mb-1 text-[11px]">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                Catalizzatore Fondamentale Verificato da Gemini:
              </div>
              <p className="text-slate-300 text-[11px] leading-relaxed">
                {setup.catalystAnalysis.catalizzatore}
              </p>
            </div>
          )}
        </div>

        {/* Right Column (5 cols): Trade Republic Knock Out Sizing & Barrier Safety */}
        <div className="lg:col-span-5 bg-slate-950 p-5 rounded-xl border border-slate-800 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-white flex items-center gap-2">
                <Calculator className="w-4 h-4 text-emerald-400" />
                Calcolatore KO Trade Republic
              </h3>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                Rischio Max 1%
              </span>
            </div>

            {/* Inputs */}
            <div className="space-y-3 text-xs mb-4">
              <div>
                <label className="block text-slate-400 text-[11px] mb-1">
                  Capitale di Trading (€)
                </label>
                <input
                  type="number"
                  min="500"
                  step="500"
                  value={accountCapital}
                  onChange={(e) => onUpdateAccountCapital(parseFloat(e.target.value) || 0)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 text-[11px] mb-1">
                    Strike Barriera KO ({setup.candidate.currency})
                  </label>
                  <input
                    type="number"
                    step="0.05"
                    value={barrierStrike}
                    onChange={(e) => setBarrierStrike(parseFloat(e.target.value) || 0)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 text-[11px] mb-1">
                    Leva Certificato (x)
                  </label>
                  <input
                    type="number"
                    min="2"
                    max="100"
                    value={leverage}
                    onChange={(e) => setLeverage(parseFloat(e.target.value) || 1)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 text-[11px] mb-1">
                    Prezzo Certificato KO (€)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    value={certPrice}
                    onChange={(e) => setCertPrice(parseFloat(e.target.value) || 1)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 text-[11px] mb-1">
                    Rischio Max per Trade (%)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.2"
                    max="2.0"
                    value={maxRiskPercent}
                    onChange={(e) => setMaxRiskPercent(parseFloat(e.target.value) || 1)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>
            </div>

            {/* AUTOMATED BARRIER SAFETY CHECK */}
            <div
              className={`p-3 rounded-lg border text-xs mb-4 ${
                koSafety.isSafe
                  ? 'bg-emerald-950/40 border-emerald-700/80 text-emerald-300'
                  : 'bg-rose-950/60 border-rose-600 text-rose-300 animate-pulse'
              }`}
            >
              <div className="flex items-center gap-2 font-bold mb-1">
                {koSafety.isSafe ? (
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                ) : (
                  <ShieldAlert className="w-4 h-4 text-rose-400" />
                )}
                <span>
                  {koSafety.isSafe
                    ? `✓ BARRIERA KO SICURA (${koSafety.safetyRatio}x Distanza Stop)`
                    : '⚠️ ALLARME PERICOLO KNOCK-OUT'}
                </span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed font-mono">
                {koSafety.isSafe
                  ? `La barriera dista ${koSafety.barrierDistance} pts dal prezzo, ovvero ${koSafety.safetyRatio}x la distanza dello stop (${koSafety.stopDistance} pts). Conforme al margine minimo di sicurezza 2.0x.`
                  : koSafety.warningMessage}
              </p>
            </div>

            {/* Position Sizing Breakdown */}
            <div className="bg-slate-900 p-3.5 rounded-lg border border-slate-800 space-y-2 text-xs font-mono">
              <div className="flex justify-between text-slate-400">
                <span>Rischio Max 1% Capitale:</span>
                <span className="text-white font-bold">{koSafety.maxRiskEur.toFixed(2)} €</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Certificati KO suggeriti:</span>
                <span className="text-emerald-400 font-bold">{koSafety.suggestedCertificates} pz</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Capitale investito KO:</span>
                <span className="text-white font-bold">{koSafety.totalInvestedEur.toFixed(2)} €</span>
              </div>
              <div className="flex justify-between text-rose-400 pt-1 border-t border-slate-800">
                <span>Perdita max allo Stop:</span>
                <span className="font-bold">-{koSafety.potentialLossEur.toFixed(2)} € (-1.0%)</span>
              </div>
              <div className="flex justify-between text-emerald-400">
                <span>Guadagno stimato a Target 1:</span>
                <span className="font-bold">+{koSafety.potentialGainT1Eur.toFixed(2)} € (+{((koSafety.potentialGainT1Eur / accountCapital) * 100).toFixed(2)}%)</span>
              </div>
              <div className="flex justify-between text-emerald-400">
                <span>Guadagno stimato a Target 2:</span>
                <span className="font-bold">+{koSafety.potentialGainT2Eur.toFixed(2)} € (+{((koSafety.potentialGainT2Eur / accountCapital) * 100).toFixed(2)}%)</span>
              </div>
            </div>
          </div>

          {/* Action: Add to Journal */}
          <div className="mt-5">
            <button
              onClick={handleLogTrade}
              disabled={circuitBreakerActive || !koSafety.isSafe}
              className={`w-full py-2.5 px-4 rounded-lg text-xs font-bold flex items-center justify-center gap-2 shadow-md transition-all ${
                circuitBreakerActive || !koSafety.isSafe
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white active:scale-95'
              }`}
            >
              <PlusCircle className="w-4 h-4" />
              <span>
                {tradeSaved
                  ? 'Trade registrato nel diario!'
                  : `Registra nel Diario (${isPaperMode ? 'Paper Trading' : 'Reale'})`}
              </span>
            </button>
            {!koSafety.isSafe && (
              <span className="block text-[10px] text-rose-400 text-center mt-1">
                Regola di blocco: correggi la barriera KO prima di registrare l'ordine.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
