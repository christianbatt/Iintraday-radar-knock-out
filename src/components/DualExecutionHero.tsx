import React, { useState } from 'react';
import {
  ExecutionSetup,
  KnockOutCalculatorInput,
  KnockOutSafetyCheck,
  ScoredCandidate,
} from '../types/radar';
import { calculateKnockOutSafety, createDefaultSafetyCheck } from '../utils/calculator';
import { ImpliedVolatilityGauge } from './ImpliedVolatilityGauge';
import {
  ShieldAlert,
  ShieldCheck,
  ArrowUpRight,
  ArrowDownRight,
  Clock,
  Ban,
  Activity,
  Target,
  Sparkles,
  ExternalLink,
  Sliders,
  CheckCircle2,
  AlertTriangle,
  Globe,
  TrendingUp,
  Scale,
  Layers,
  Lock,
  ChevronDown,
  ChevronUp,
  Info,
} from 'lucide-react';

interface SingleMarketHeroCardProps {
  market: 'EU' | 'US';
  marketLabel: string;
  flag: string;
  benchmarkLabel: string;
  setup: ExecutionSetup | null;
  candidate: ScoredCandidate | null;
  accountCapital: number;
  onUpdateAccountCapital: (val: number) => void;
  onSaveToJournal: (tradeData: any) => void;
  onViewCatalyst: (candidate: ScoredCandidate) => void;
  isPaperMode: boolean;
  circuitBreakerActive: boolean;
  isPreferredSession?: boolean;
}

export const SingleMarketHeroCard: React.FC<SingleMarketHeroCardProps> = ({
  market,
  marketLabel,
  flag,
  benchmarkLabel,
  setup,
  candidate,
  accountCapital,
  onUpdateAccountCapital,
  onSaveToJournal,
  onViewCatalyst,
  isPaperMode,
  circuitBreakerActive,
  isPreferredSession,
}) => {
  const isNoTrade = !setup || setup.decision === 'NESSUN_TRADE';
  const quote = setup?.candidate || candidate?.quote;

  const trigger = setup?.triggerLevel ?? quote?.preMarketPrice ?? quote?.currentPrice ?? 0;
  const stop = setup?.stopLossLevel ?? 0;
  const dist = Math.abs(trigger - stop);

  const defaultBarrier =
    setup?.suggestedKoBarrier ??
    (trigger > 0 && dist > 0
      ? setup?.direction === 'LONG'
        ? +(trigger - dist * 2.65).toFixed(2)
        : +(trigger + dist * 2.65).toFixed(2)
      : 0);

  const [barrierStrike, setBarrierStrike] = useState<number>(defaultBarrier);
  const [leverage, setLeverage] = useState<number>(10);
  const [certPrice, setCertPrice] = useState<number>(2.5);
  const [maxRiskPercent, setMaxRiskPercent] = useState<number>(1.0);
  const [spreadEur, setSpreadEur] = useState<number>(0.02);
  const [brokerFeeEur, setBrokerFeeEur] = useState<number>(1.0);
  const [tradeSaved, setTradeSaved] = useState<boolean>(false);
  const [showKoCalculator, setShowKoCalculator] = useState<boolean>(false);
  const [showScenarios, setShowScenarios] = useState<boolean>(false);
  const [showFrictionExplainer, setShowFrictionExplainer] = useState<boolean>(false);

  // Sync default barrier when setup updates
  React.useEffect(() => {
    if (setup?.suggestedKoBarrier) {
      setBarrierStrike(setup.suggestedKoBarrier);
    } else if (trigger > 0 && dist > 0) {
      setBarrierStrike(
        setup?.direction === 'LONG'
          ? +(trigger - dist * 2.65).toFixed(2)
          : +(trigger + dist * 2.65).toFixed(2)
      );
    }
  }, [setup?.suggestedKoBarrier, setup?.triggerLevel, setup?.stopLossLevel, setup?.direction]);

  const koInput: KnockOutCalculatorInput = {
    barrierStrike,
    leverage,
    certificatePrice: certPrice,
    accountCapital,
    maxRiskPercent,
    spreadEur,
    brokerFeeEur,
  };

  const koSafety: KnockOutSafetyCheck = setup
    ? calculateKnockOutSafety(setup, koInput)
    : createDefaultSafetyCheck(accountCapital, maxRiskPercent);

  const dynamicBreakeven = koSafety.breakeven || setup?.dynamicBreakeven;
  const stressReport = koSafety.stressReport;
  const isBlockedByStress = stressReport && stressReport.filterStatus === 'CRITICAL_BLOCKED';

  const handleLogTrade = () => {
    if (circuitBreakerActive || isBlockedByStress) {
      return;
    }
    if (!setup || isNoTrade) return;

    onSaveToJournal({
      session: market,
      ticker: quote?.ticker,
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

  const refPrice = quote?.preMarketPrice ?? quote?.currentPrice ?? 0;
  const gapVal = quote?.gapPercent ?? 0;
  const atrVal = quote?.atr14 ?? null;
  const atrPct = atrVal && refPrice > 0 ? ((atrVal / refPrice) * 100).toFixed(1) : null;

  return (
    <div
      className={`relative flex flex-col justify-between rounded-2xl border transition-all duration-200 overflow-hidden shadow-2xl ${
        isNoTrade
          ? 'bg-slate-900/90 border-slate-800'
          : setup?.direction === 'LONG'
          ? 'bg-gradient-to-b from-slate-900 via-slate-900 to-emerald-950/20 border-emerald-500/50 shadow-emerald-950/20'
          : 'bg-gradient-to-b from-slate-900 via-slate-900 to-rose-950/20 border-rose-500/50 shadow-rose-950/20'
      }`}
    >
      {/* Top Header Badge */}
      <div className="px-5 py-4 border-b border-slate-800/80 bg-slate-950/70 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="text-xl select-none">{flag}</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-100 font-mono">
                {marketLabel}
              </span>
              {isPreferredSession && (
                <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/40 font-semibold animate-pulse">
                  Sessione Attiva
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-400 font-mono">
              Benchmark: {benchmarkLabel}
            </div>
          </div>
        </div>

        {/* Trade Decision Badge */}
        <div>
          {isNoTrade ? (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800/80 border border-slate-700 text-slate-300 text-xs font-mono font-semibold">
              <Ban className="w-3.5 h-3.5 text-slate-400" />
              <span>NESSUN TRADE</span>
            </div>
          ) : (
            <div
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold shadow-md ${
                setup?.direction === 'LONG'
                  ? 'bg-emerald-500 text-slate-950 border border-emerald-400'
                  : 'bg-rose-500 text-white border border-rose-400'
              }`}
            >
              {setup?.direction === 'LONG' ? (
                <ArrowUpRight className="w-4 h-4" />
              ) : (
                <ArrowDownRight className="w-4 h-4" />
              )}
              <span>TOP SETUP {setup?.direction}</span>
            </div>
          )}
        </div>
      </div>

      {/* Main Body */}
      <div className="p-5 flex-1 flex flex-col justify-between space-y-5">
        {/* Ticker & Live Price Row */}
        {quote?.ticker ? (
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-black font-mono tracking-tight text-white">
                    {quote.ticker}
                  </span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                    {quote.currency}
                  </span>
                  {candidate && (
                    <span className="text-xs font-mono text-emerald-400 font-medium">
                      Score: {candidate.score.total}/100
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-400 truncate max-w-[220px]">
                  {quote.name}
                </div>
              </div>

              {/* Price & Gap */}
              <div className="text-right font-mono">
                <div className="text-xl font-bold tabular-nums text-white">
                  {refPrice.toFixed(2)} {quote.currency}
                </div>
                <div
                  className={`text-xs font-semibold tabular-nums flex items-center justify-end gap-1 ${
                    gapVal >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  <span>Gap: {gapVal >= 0 ? '+' : ''}{gapVal.toFixed(2)}%</span>
                  {quote.rvol && (
                    <span className="text-slate-400 font-normal">
                      · RVOL {quote.rvol.toFixed(1)}x
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="py-6 text-center text-slate-500 text-xs font-mono">
            Nessun candidato europeo o americano caricato nel paniere.
          </div>
        )}

        {/* If NO TRADE, show strict rationale */}
        {isNoTrade ? (
          <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-4 flex-1 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2 font-mono">
                <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Condizioni Operative Non Soddisfatte</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed font-mono">
                {setup?.reasonNoTrade ||
                  `I titoli monitorati per ${marketLabel} non hanno raggiunto il punteggio minimo (score ≥ 55) o mancano di coerenza tra gap, RVOL e futures. Preservazione del capitale: nessun trade consentito.`}
              </p>
            </div>

            {quote?.ticker && (
              <div className="my-2">
                <ImpliedVolatilityGauge quote={quote} compact />
              </div>
            )}

            <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500 font-mono">
              <span>Orario limite: {setup?.cutoffTime || '11:30 CET'}</span>
              <span>Rigorosa selezione zero-errore umano</span>
            </div>
          </div>
        ) : (
          /* TRADE SETUP ACTIVE */
          <div className="space-y-4">
            {/* Strategy Title */}
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-slate-400">Strategia Primaria:</span>
              <span className="font-semibold text-emerald-300 bg-emerald-950/50 px-2 py-0.5 rounded border border-emerald-800/50">
                {setup.strategy}
              </span>
            </div>

            {/* Execution Levels Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center font-mono">
              {/* Trigger */}
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2.5">
                <div className="text-[10px] text-slate-400 uppercase font-semibold">
                  Trigger Ingresso
                </div>
                <div className="text-sm font-bold text-white tabular-nums mt-0.5">
                  {setup.triggerLevel?.toFixed(2)}
                </div>
                <div className="text-[10px] text-emerald-400">Breakout + VWAP</div>
              </div>

              {/* Stop Loss Tight */}
              <div className="bg-slate-950/80 border border-rose-950/40 rounded-xl p-2.5">
                <div className="text-[10px] text-rose-300 uppercase font-semibold">
                  Stop Loss (0.5x ATR)
                </div>
                <div className="text-sm font-bold text-rose-400 tabular-nums mt-0.5">
                  {setup.stopLossLevel?.toFixed(2)}
                </div>
                <div className="text-[10px] text-slate-400">Anti-Rumore</div>
              </div>

              {/* Target 1 */}
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2.5">
                <div className="text-[10px] text-slate-400 uppercase font-semibold">
                  Target 1 (R:R 1.6)
                </div>
                <div className="text-sm font-bold text-emerald-400 tabular-nums mt-0.5">
                  {setup.target1Level?.toFixed(2)}
                </div>
                <div className="text-[10px] text-slate-400">Primo Scale-Out</div>
              </div>

              {/* Target 2 */}
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2.5">
                <div className="text-[10px] text-slate-400 uppercase font-semibold">
                  Target 2 (R:R 2.8)
                </div>
                <div className="text-sm font-bold text-emerald-300 tabular-nums mt-0.5">
                  {setup.target2Level?.toFixed(2)}
                </div>
                <div className="text-[10px] text-slate-400">Runner Finale</div>
              </div>
            </div>

            {/* Dynamic Breakeven & Execution Friction Strip */}
            {dynamicBreakeven && (
              <div className="bg-slate-950/80 border border-slate-800/90 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 font-mono">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
                    <Scale className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-bold text-slate-200 uppercase tracking-wide">
                        Breakeven Dinamico (Post-Attrito)
                      </span>
                      <span
                        className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${
                          dynamicBreakeven.frictionStatus === 'LOW'
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : dynamicBreakeven.frictionStatus === 'MODERATE'
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                        }`}
                      >
                        {dynamicBreakeven.frictionStatus === 'LOW'
                          ? 'Attrito Basso'
                          : dynamicBreakeven.frictionStatus === 'MODERATE'
                          ? 'Attrito Medio'
                          : 'Attrito Critico'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowFrictionExplainer(!showFrictionExplainer)}
                        className="text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
                        title="Spiegazione Attrito & Breakeven"
                      >
                        <Info className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      Pareggio sottostante reale: <strong className="text-indigo-300 font-bold">{dynamicBreakeven.underlyingBreakevenPrice.toFixed(2)} {quote?.currency}</strong>
                      <span className="text-slate-500 ml-1.5">
                        ({setup.direction === 'LONG' ? '+' : '-'}{dynamicBreakeven.pointsToBreakeven.toFixed(2)} pt / {dynamicBreakeven.percentToBreakeven.toFixed(2)}%)
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs shrink-0 self-end sm:self-center border-t sm:border-t-0 pt-2 sm:pt-0 border-slate-800/80 w-full sm:w-auto justify-between sm:justify-end">
                  <div>
                    <span className="text-[10px] text-slate-500 block">Costo Totale A/R</span>
                    <span className="font-bold text-slate-200 tabular-nums">{dynamicBreakeven.totalFrictionEur.toFixed(2)} €</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Incidenza ATR(14)</span>
                    <span
                      className={`font-bold tabular-nums ${
                        dynamicBreakeven.frictionVsAtrPercent > 20 ? 'text-amber-400' : 'text-emerald-400'
                      }`}
                    >
                      {dynamicBreakeven.frictionVsAtrPercent}% ATR
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Explainer Drawer for Dynamic Breakeven */}
            {showFrictionExplainer && dynamicBreakeven && (
              <div className="bg-indigo-950/20 border border-indigo-800/40 rounded-xl p-3 text-xs font-mono text-slate-300 space-y-1.5 animate-fadeIn">
                <div className="flex items-center justify-between text-indigo-300 font-bold text-[11px]">
                  <span>Come Funziona il Breakeven Dinamico sui Derivati Knock-Out</span>
                  <button
                    type="button"
                    onClick={() => setShowFrictionExplainer(false)}
                    className="text-slate-400 hover:text-white cursor-pointer text-sm"
                  >
                    ×
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Nei certificati a leva (es. Trade Republic/Société Générale), il punto di pareggio reale non coincide con il prezzo d'ingresso del sottostante, ma incorpora:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 text-[11px]">
                  <div className="bg-slate-900/80 p-2 rounded border border-slate-800">
                    <span className="text-slate-400 block">1. Commissioni Broker A/R:</span>
                    <span className="text-white font-bold">{(dynamicBreakeven.brokerFeeEur * 2).toFixed(2)} €</span> (2 ordini: acquisto + vendita)
                  </div>
                  <div className="bg-slate-900/80 p-2 rounded border border-slate-800">
                    <span className="text-slate-400 block">2. Spread Bid/Ask Emittente:</span>
                    <span className="text-white font-bold">{(dynamicBreakeven.spreadEur * koSafety.suggestedCertificates).toFixed(2)} €</span> ({koSafety.suggestedCertificates} quote × {dynamicBreakeven.spreadEur} €)
                  </div>
                </div>
                <p className="text-[10px] text-indigo-300/80 pt-1">
                  Il sottostante deve raggiungere <strong>{dynamicBreakeven.underlyingBreakevenPrice.toFixed(2)} {quote?.currency}</strong> ({dynamicBreakeven.pointsToBreakeven.toFixed(2)} pt di movimento) solo per compensare {dynamicBreakeven.totalFrictionEur.toFixed(2)} € di attrito complessivo prima di iniziare ad accumulare utile netto.
                </p>
              </div>
            )}

            {/* Implied Volatility (IV) Gauge vs 30-Day Average */}
            <ImpliedVolatilityGauge quote={quote} />

            {/* ATR Volatility & Recommended Trade Republic KO Barrier */}
            <div className="bg-slate-950/90 border border-slate-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-amber-400 shrink-0" />
                <div>
                  <span className="text-slate-400">ATR(14): </span>
                  <span className="font-bold text-amber-300">
                    {atrVal?.toFixed(2)} {quote?.currency} {atrPct && `(${atrPct}%)`}
                  </span>
                  <span className="text-slate-500 text-[11px] ml-1.5">
                    · Stop Conservativo: {setup.stopLossConservative?.toFixed(2)}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {quote?.rsi14 != null && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-400">RSI(14):</span>
                    <span
                      className={`font-bold px-1.5 py-0.5 rounded text-[11px] ${
                        quote.rsi14 >= 70
                          ? 'bg-rose-950 text-rose-300 border border-rose-800'
                          : quote.rsi14 <= 30
                          ? 'bg-indigo-950 text-indigo-300 border border-indigo-800'
                          : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                      }`}
                    >
                      {quote.rsi14} {quote.rsi14 >= 70 ? '(Ipercomprato)' : quote.rsi14 <= 30 ? '(Ipervenduto)' : '(Sano)'}
                    </span>
                  </div>
                )}

                <div className="flex items-center gap-1.5 text-sky-400">
                  <ShieldCheck className="w-4 h-4 text-sky-400 shrink-0" />
                  <span>
                    Barriera KO Sicura: <strong className="text-white">{setup.suggestedKoBarrier?.toFixed(2)}</strong> (&gt;2.5x stop)
                  </span>
                </div>
              </div>
            </div>

            {/* Quick Invalidation Rule */}
            <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-2.5 text-[11px] font-mono text-slate-300 flex items-center justify-between gap-2">
              <span className="text-slate-400">Invalidazione:</span>
              <span className="text-rose-300 truncate max-w-[280px]">
                {setup.invalidationConditions[0]}
              </span>
            </div>

            {/* Trade Republic Knock-Out Risk Calculator Toggle */}
            <div className="pt-2">
              <button
                type="button"
                onClick={() => setShowKoCalculator(!showKoCalculator)}
                className="w-full py-2 px-3 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 text-xs font-mono text-slate-300 flex items-center justify-between transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Sliders className="w-3.5 h-3.5 text-sky-400" />
                  <span>Calcolatore Rischio & Breakeven Derivato (1% Capitale)</span>
                </div>
                <span className="text-sky-400 text-[11px] font-semibold">
                  {showKoCalculator ? 'Nascondi ▲' : 'Configura & Quote ▼'}
                </span>
              </button>

              {showKoCalculator && (
                <div className="mt-3 p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3 font-mono text-xs">
                  {/* Parameter Inputs Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                    <div>
                      <label className="text-[10px] text-slate-400 block mb-1">
                        Strike Barriera KO
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        value={barrierStrike || ''}
                        onChange={(e) => setBarrierStrike(parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400 block mb-1">
                        Leva KO
                      </label>
                      <select
                        value={leverage}
                        onChange={(e) => setLeverage(parseInt(e.target.value, 10))}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white"
                      >
                        <option value={5}>5x (Bassa)</option>
                        <option value={8}>8x</option>
                        <option value={10}>10x (Standard)</option>
                        <option value={15}>15x (Dinamica)</option>
                        <option value={20}>20x (Alta)</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400 block mb-1">
                        Prezzo Cert. (€)
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        value={certPrice || ''}
                        onChange={(e) => setCertPrice(parseFloat(e.target.value) || 1)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400 block mb-1">
                        Spread (€/pz)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={spreadEur}
                        onChange={(e) => setSpreadEur(parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400 block mb-1">
                        Broker Fee (€/ord)
                      </label>
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        value={brokerFeeEur}
                        onChange={(e) => setBrokerFeeEur(parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white"
                      />
                    </div>
                  </div>

                  {/* Safety Buffer Indicator */}
                  <div
                    className={`p-2.5 rounded-lg border flex items-center justify-between text-xs ${
                      koSafety.isSafe
                        ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                        : 'bg-rose-950/50 border-rose-800/70 text-rose-300'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {koSafety.isSafe ? (
                        <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                      )}
                      <span>
                        Buffer Barriera: <strong>{koSafety.safetyRatio}x</strong> lo stop
                        {koSafety.isSafe ? ' (Sicuro)' : ' (Pericolo liquidazione!)'}
                      </span>
                    </div>
                    <span className="font-bold">
                      Quote: {koSafety.suggestedCertificates} pz ({koSafety.totalInvestedEur} €)
                    </span>
                  </div>

                  {/* Dynamic Breakeven Breakdown Inside Calculator */}
                  {dynamicBreakeven && (
                    <div className="p-3 rounded-lg bg-slate-900/90 border border-slate-800 space-y-2">
                      <div className="flex items-center justify-between text-[11px] font-bold">
                        <div className="flex items-center gap-1.5 text-indigo-300">
                          <Scale className="w-3.5 h-3.5" />
                          <span>Audit Attrito di Esecuzione & Pareggio Netto</span>
                        </div>
                        <span className="text-slate-400">
                          Totale Attrito A/R: <strong className="text-white">{dynamicBreakeven.totalFrictionEur.toFixed(2)} €</strong>
                        </span>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-[10px] pt-1">
                        <div className="bg-slate-950 p-2 rounded border border-slate-800/80">
                          <span className="text-slate-400 block">Commissioni Broker (A/R)</span>
                          <span className="font-bold text-white text-xs">{((brokerFeeEur || 0) * 2).toFixed(2)} €</span>
                        </div>
                        <div className="bg-slate-950 p-2 rounded border border-slate-800/80">
                          <span className="text-slate-400 block">Spread Totale Emittente</span>
                          <span className="font-bold text-white text-xs">{((spreadEur || 0) * koSafety.suggestedCertificates).toFixed(2)} €</span>
                        </div>
                        <div className="bg-slate-950 p-2 rounded border border-slate-800/80">
                          <span className="text-slate-400 block">Δ Sottostante a Zero</span>
                          <span className="font-bold text-indigo-300 text-xs">+{dynamicBreakeven.pointsToBreakeven.toFixed(2)} pt</span>
                        </div>
                        <div className="bg-slate-950 p-2 rounded border border-slate-800/80">
                          <span className="text-slate-400 block">Quota ATR Assorbita</span>
                          <span
                            className={`font-bold text-xs ${
                              dynamicBreakeven.frictionVsAtrPercent > 20 ? 'text-amber-400' : 'text-emerald-400'
                            }`}
                          >
                            {dynamicBreakeven.frictionVsAtrPercent}%
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Hybrid Stress Filter Banner */}
                  {stressReport && (
                    <div
                      className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                        stressReport.filterStatus === 'CRITICAL_BLOCKED'
                          ? 'bg-rose-950/40 border-rose-800 text-rose-200'
                          : stressReport.filterStatus === 'WARNING'
                          ? 'bg-amber-950/40 border-amber-800 text-amber-200'
                          : 'bg-emerald-950/30 border-emerald-800/60 text-emerald-200'
                      }`}
                    >
                      <div className="flex items-center justify-between font-bold text-[11px]">
                        <div className="flex items-center gap-1.5">
                          {stressReport.filterStatus === 'CRITICAL_BLOCKED' ? (
                            <Lock className="w-3.5 h-3.5 text-rose-400" />
                          ) : stressReport.filterStatus === 'WARNING' ? (
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                          ) : (
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                          )}
                          <span>
                            Stress Test Derivato: {stressReport.stressScore}/100 ({
                              stressReport.filterStatus === 'CRITICAL_BLOCKED'
                                ? 'SETUP BLOCCATO'
                                : stressReport.filterStatus === 'WARNING'
                                ? 'ATTENZIONE RISCHIO'
                                : 'VERIFICATO & OTTIMALE'
                            })
                          </span>
                        </div>
                        <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-black/40">
                          Buffer: {stressReport.barrierSafetyRatio}x stop · {stressReport.barrierVsAtrRatio}x ATR
                        </span>
                      </div>

                      {stressReport.criticalReasons.map((r, i) => (
                        <div key={i} className="text-[11px] text-rose-300 flex items-start gap-1.5">
                          <span className="text-rose-400 font-bold shrink-0">✕</span>
                          <span>{r}</span>
                        </div>
                      ))}

                      {stressReport.warningReasons.map((r, i) => (
                        <div key={i} className="text-[11px] text-amber-300 flex items-start gap-1.5">
                          <span className="text-amber-400 font-bold shrink-0">⚠</span>
                          <span>{r}</span>
                        </div>
                      ))}

                      {stressReport.passReasons.length > 0 && stressReport.criticalReasons.length === 0 && (
                        <div className="text-[10px] text-emerald-300 flex items-center gap-1.5">
                          <span>✓ {stressReport.passReasons[0]}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Collapsible PnL Simulation Section */}
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => setShowScenarios(!showScenarios)}
                      className="w-full py-1.5 px-2.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 text-[11px] font-mono flex items-center justify-between transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-1.5">
                        <Layers className="w-3.5 h-3.5 text-indigo-400" />
                        <span>Simulazione Scenari PnL con Leva ({koSafety.scenarios?.length || 5} Scenari)</span>
                      </div>
                      <span className="text-indigo-400 text-[10px] font-bold">
                        {showScenarios ? 'Nascondi ▲' : 'Espandi Tabella ▼'}
                      </span>
                    </button>

                    {showScenarios && koSafety.scenarios && koSafety.scenarios.length > 0 && (
                      <div className="mt-2 overflow-x-auto rounded-lg border border-slate-800">
                        <table className="w-full text-left text-[11px] font-mono">
                          <thead className="bg-slate-900/90 text-slate-400 uppercase text-[9px] border-b border-slate-800">
                            <tr>
                              <th className="py-2 px-2.5">Scenario</th>
                              <th className="py-2 px-2">Sottostante</th>
                              <th className="py-2 px-2">Certificato</th>
                              <th className="py-2 px-2 text-right">PnL Netto</th>
                              <th className="py-2 px-2 text-right">R-Mult</th>
                              <th className="py-2 px-2.5 text-right">ROI %</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/60 bg-slate-950/60">
                            {koSafety.scenarios.map((sc) => {
                              const isPositive = sc.netPnlEur > 0;
                              const isZero = sc.netPnlEur === 0;
                              return (
                                <tr
                                  key={sc.id}
                                  className={`hover:bg-slate-900/40 transition-colors ${
                                    sc.isBreakeven
                                      ? 'bg-indigo-950/20'
                                      : sc.isStop
                                      ? 'bg-rose-950/20'
                                      : sc.isKnockOut
                                      ? 'bg-rose-950/30'
                                      : ''
                                  }`}
                                >
                                  <td className="py-2 px-2.5 font-semibold text-slate-200">
                                    <div className="flex items-center gap-1.5">
                                      {sc.isKnockOut && <span className="text-rose-500 font-bold">💥</span>}
                                      {sc.isStop && <span className="text-rose-400 font-bold">🛑</span>}
                                      {sc.isBreakeven && <span className="text-indigo-400 font-bold">⚖️</span>}
                                      {!sc.isKnockOut && !sc.isStop && !sc.isBreakeven && (
                                        <span className="text-emerald-400 font-bold">🎯</span>
                                      )}
                                      <span>{sc.label}</span>
                                    </div>
                                    <div className="text-[9px] text-slate-400 font-normal">{sc.notes}</div>
                                  </td>
                                  <td className="py-2 px-2 whitespace-nowrap text-slate-300">
                                    {sc.underlyingPrice.toFixed(2)} {quote?.currency}
                                    <span
                                      className={`text-[10px] ml-1 ${
                                        sc.underlyingChangePercent > 0
                                          ? 'text-emerald-400'
                                          : sc.underlyingChangePercent < 0
                                          ? 'text-rose-400'
                                          : 'text-slate-400'
                                      }`}
                                    >
                                      ({sc.underlyingChangePercent > 0 ? '+' : ''}{sc.underlyingChangePercent}%)
                                    </span>
                                  </td>
                                  <td className="py-2 px-2 whitespace-nowrap text-slate-300">
                                    {sc.certEstimatedPrice.toFixed(2)} €
                                    <span
                                      className={`text-[10px] ml-1 ${
                                        sc.certChangePercent > 0
                                          ? 'text-emerald-400'
                                          : sc.certChangePercent < 0
                                          ? 'text-rose-400'
                                          : 'text-slate-400'
                                      }`}
                                    >
                                      ({sc.certChangePercent > 0 ? '+' : ''}{sc.certChangePercent}%)
                                    </span>
                                  </td>
                                  <td
                                    className={`py-2 px-2 text-right font-bold whitespace-nowrap ${
                                      isZero
                                        ? 'text-indigo-300'
                                        : isPositive
                                        ? 'text-emerald-400'
                                        : 'text-rose-400'
                                    }`}
                                  >
                                    {isPositive ? '+' : ''}{sc.netPnlEur.toFixed(2)} €
                                  </td>
                                  <td className="py-2 px-2 text-right whitespace-nowrap text-slate-300">
                                    {sc.rMultiple > 0 ? `+${sc.rMultiple}R` : `${sc.rMultiple}R`}
                                  </td>
                                  <td
                                    className={`py-2 px-2.5 text-right font-bold whitespace-nowrap ${
                                      isZero
                                        ? 'text-indigo-300'
                                        : isPositive
                                        ? 'text-emerald-400'
                                        : 'text-rose-400'
                                    }`}
                                  >
                                    {isPositive ? '+' : ''}{sc.capitalRoiPercent}%
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Loss vs Gain overview */}
                  <div className="grid grid-cols-3 gap-2 text-center text-[11px] pt-1 border-t border-slate-800/80">
                    <div>
                      <span className="text-slate-400 block">Rischio Max (1%)</span>
                      <span className="text-rose-400 font-bold">-{koSafety.maxRiskEur} €</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Guadagno T1 Netto</span>
                      <span className="text-emerald-400 font-bold">+{koSafety.potentialGainT1Eur} €</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Guadagno T2 Netto</span>
                      <span className="text-emerald-300 font-bold">+{koSafety.potentialGainT2Eur} €</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="pt-2 flex items-center gap-2.5">
          {candidate && (
            <button
              type="button"
              onClick={() => onViewCatalyst(candidate)}
              className="flex-1 py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold font-mono flex items-center justify-center gap-1.5 transition-colors cursor-pointer border border-slate-700"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>Catalizzatore & Notizie</span>
            </button>
          )}

          {!isNoTrade && (
            <button
              type="button"
              onClick={handleLogTrade}
              disabled={circuitBreakerActive || isBlockedByStress}
              className={`flex-1 py-2.5 px-3 rounded-xl text-xs font-bold font-mono flex items-center justify-center gap-1.5 transition-all shadow-md cursor-pointer ${
                isBlockedByStress
                  ? 'bg-rose-950/60 text-rose-300 border border-rose-800/80 cursor-not-allowed opacity-80'
                  : tradeSaved
                  ? 'bg-emerald-500 text-slate-950'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white active:scale-95'
              }`}
            >
              {isBlockedByStress ? (
                <>
                  <Lock className="w-4 h-4 text-rose-400" />
                  <span>Bloccato da Stress Test Derivati</span>
                </>
              ) : tradeSaved ? (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Registrato a Giornale!</span>
                </>
              ) : (
                <>
                  <Target className="w-4 h-4" />
                  <span>Registra a Giornale</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

interface DualExecutionHeroProps {
  setupEU: ExecutionSetup | null;
  setupUS: ExecutionSetup | null;
  candidateEU: ScoredCandidate | null;
  candidateUS: ScoredCandidate | null;
  accountCapital: number;
  onUpdateAccountCapital: (val: number) => void;
  onSaveToJournal: (tradeData: any) => void;
  onViewCatalyst: (candidate: ScoredCandidate) => void;
  isPaperMode: boolean;
  circuitBreakerActive: boolean;
  currentSession: 'EU' | 'US' | 'GLOBAL';
}

export const DualExecutionHero: React.FC<DualExecutionHeroProps> = ({
  setupEU,
  setupUS,
  candidateEU,
  candidateUS,
  accountCapital,
  onUpdateAccountCapital,
  onSaveToJournal,
  onViewCatalyst,
  isPaperMode,
  circuitBreakerActive,
  currentSession,
}) => {
  return (
    <section className="mb-8">
      {/* Section Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold uppercase tracking-wider text-white font-mono flex items-center gap-2">
              <Globe className="w-5 h-5 text-emerald-400" />
              <span>I Due Migliori Setup Intraday (Top EU & Top USA)</span>
            </h2>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
              Dual-Market Rigoroso
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Selezione separata e priva di errore umano: 1 operazione d'eccellenza per l'Europa (FDAX/EuroStoxx) e 1 per Wall Street (S&P/Nasdaq).
          </p>
        </div>

        <div className="text-xs font-mono text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>Filtro Attivo: <strong className="text-white">{currentSession === 'GLOBAL' ? 'Entrambi i Mercati' : currentSession === 'EU' ? 'Solo Europa' : 'Solo USA'}</strong></span>
        </div>
      </div>

      {/* Side-by-Side Dual Hero Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Card 1: TOP EUROPA */}
        <SingleMarketHeroCard
          market="EU"
          marketLabel="Top Pick Europa"
          flag="🇪🇺"
          benchmarkLabel="FDAX / Euro Stoxx 50"
          setup={setupEU}
          candidate={candidateEU}
          accountCapital={accountCapital}
          onUpdateAccountCapital={onUpdateAccountCapital}
          onSaveToJournal={onSaveToJournal}
          onViewCatalyst={onViewCatalyst}
          isPaperMode={isPaperMode}
          circuitBreakerActive={circuitBreakerActive}
          isPreferredSession={currentSession === 'EU' || currentSession === 'GLOBAL'}
        />

        {/* Card 2: TOP USA */}
        <SingleMarketHeroCard
          market="US"
          marketLabel="Top Pick Wall Street (USA)"
          flag="🇺🇸"
          benchmarkLabel="S&P 500 (ES) / Nasdaq (NQ)"
          setup={setupUS}
          candidate={candidateUS}
          accountCapital={accountCapital}
          onUpdateAccountCapital={onUpdateAccountCapital}
          onSaveToJournal={onSaveToJournal}
          onViewCatalyst={onViewCatalyst}
          isPaperMode={isPaperMode}
          circuitBreakerActive={circuitBreakerActive}
          isPreferredSession={currentSession === 'US' || currentSession === 'GLOBAL'}
        />
      </div>
    </section>
  );
};
