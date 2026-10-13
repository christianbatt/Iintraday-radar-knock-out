import React, { useState } from 'react';
import {
  ExecutionSetup,
  KnockOutCalculatorInput,
  KnockOutSafetyCheck,
  ScoredCandidate,
} from '../types/radar';
import { calculateKnockOutSafety } from '../utils/calculator';
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
  const [tradeSaved, setTradeSaved] = useState<boolean>(false);
  const [showKoCalculator, setShowKoCalculator] = useState<boolean>(false);

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
  };

  const koSafety: KnockOutSafetyCheck = setup
    ? calculateKnockOutSafety(setup, koInput)
    : {
        entryPrice: 0,
        stopLoss: 0,
        barrierStrike: 0,
        stopDistance: 0,
        barrierDistance: 0,
        safetyRatio: 0,
        isSafe: false,
        maxRiskEur: 0,
        suggestedCertificates: 0,
        totalInvestedEur: 0,
        potentialLossEur: 0,
        potentialGainT1Eur: 0,
        potentialGainT2Eur: 0,
      };

  const handleLogTrade = () => {
    if (circuitBreakerActive) {
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

              <div className="flex items-center gap-1.5 text-sky-400">
                <ShieldCheck className="w-4 h-4 text-sky-400 shrink-0" />
                <span>
                  Barriera KO Sicura: <strong className="text-white">{setup.suggestedKoBarrier?.toFixed(2)}</strong> (&gt;2.5x stop)
                </span>
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
                  <span>Calcolatore Rischio KO Trade Republic (1% Capitale)</span>
                </div>
                <span className="text-sky-400 text-[11px] font-semibold">
                  {showKoCalculator ? 'Nascondi ▲' : 'Configura & Quote ▼'}
                </span>
              </button>

              {showKoCalculator && (
                <div className="mt-3 p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3 font-mono text-xs">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
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
                        <option value={5}>5x (Bassa leva)</option>
                        <option value={8}>8x</option>
                        <option value={10}>10x (Standard)</option>
                        <option value={15}>15x (Dinamica)</option>
                        <option value={20}>20x (Alta leva)</option>
                      </select>
                    </div>
                    <div className="col-span-2 sm:col-span-1">
                      <label className="text-[10px] text-slate-400 block mb-1">
                        Prezzo Certificato (€)
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        value={certPrice || ''}
                        onChange={(e) => setCertPrice(parseFloat(e.target.value) || 1)}
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
                      Quote: {koSafety.suggestedCertificates} pz
                    </span>
                  </div>

                  {/* Loss vs Gain overview */}
                  <div className="grid grid-cols-3 gap-2 text-center text-[11px] pt-1 border-t border-slate-800/80">
                    <div>
                      <span className="text-slate-400 block">Rischio Max (1%)</span>
                      <span className="text-rose-400 font-bold">-{koSafety.maxRiskEur} €</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Guadagno T1</span>
                      <span className="text-emerald-400 font-bold">+{koSafety.potentialGainT1Eur} €</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Guadagno T2</span>
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
              disabled={circuitBreakerActive}
              className={`flex-1 py-2.5 px-3 rounded-xl text-xs font-bold font-mono flex items-center justify-center gap-1.5 transition-all shadow-md cursor-pointer ${
                tradeSaved
                  ? 'bg-emerald-500 text-slate-950'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white active:scale-95'
              }`}
            >
              {tradeSaved ? (
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
