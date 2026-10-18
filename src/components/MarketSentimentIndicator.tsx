import React, { useState, useMemo } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Compass,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Zap,
  Info,
  ShieldCheck,
  Activity,
  Layers,
} from 'lucide-react';
import { RawQuoteData, ExecutionSetup } from '../types/radar';

interface MarketSentimentIndicatorProps {
  currentSession: 'EU' | 'US' | 'GLOBAL';
  futures: any;
  quotes?: RawQuoteData[];
  activeSetup?: ExecutionSetup | null;
}

export interface SentimentAnalysis {
  score: number; // 1 to 10
  label: string;
  regime: 'EXTREME_BEARISH' | 'MODERATE_BEARISH' | 'NEUTRAL' | 'MODERATE_BULLISH' | 'STRONG_BULLISH';
  description: string;
  badgeBg: string;
  badgeBorder: string;
  badgeText: string;
  futuresAvg: number;
  advancersCount: number;
  declinersCount: number;
  advancersRatio: number;
  setupAlignment: {
    status: 'TAILWIND' | 'HEADWIND' | 'NEUTRAL';
    title: string;
    advice: string;
    badgeColor: string;
  };
}

export const MarketSentimentIndicator: React.FC<MarketSentimentIndicatorProps> = ({
  currentSession,
  futures,
  quotes = [],
  activeSetup,
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(false);

  const sentiment = useMemo<SentimentAnalysis>(() => {
    // 1. Calculate Average Benchmark Futures Performance
    const euFutures = futures?.europe;
    const usFutures = futures?.usa;

    const relevantFutures: number[] = [];
    if (currentSession === 'EU' || currentSession === 'GLOBAL') {
      if (typeof euFutures?.dax?.changePercent === 'number') relevantFutures.push(euFutures.dax.changePercent);
      if (typeof euFutures?.eurostoxx?.changePercent === 'number') relevantFutures.push(euFutures.eurostoxx.changePercent);
    }
    if (currentSession === 'US' || currentSession === 'GLOBAL') {
      if (typeof usFutures?.sp500?.changePercent === 'number') relevantFutures.push(usFutures.sp500.changePercent);
      if (typeof usFutures?.nasdaq?.changePercent === 'number') relevantFutures.push(usFutures.nasdaq.changePercent);
    }

    const futuresAvg =
      relevantFutures.length > 0
        ? relevantFutures.reduce((a, b) => a + b, 0) / relevantFutures.length
        : 0;

    // Futures Score (1 - 10, centered at 5 for 0% change, +1.5% gives 10, -1.5% gives 1)
    // Formula: 5 + (futuresAvg * 3.33)
    const rawFuturesScore = Math.min(10, Math.max(1, 5 + futuresAvg * 3.33));

    // 2. Calculate Market Breadth (Advance / Decline ratio from quotes)
    const sessionQuotes =
      currentSession === 'GLOBAL'
        ? quotes
        : quotes.filter((q) => q.market === currentSession);

    let advancers = 0;
    let decliners = 0;
    let advancersRatio = 50;

    if (sessionQuotes.length > 0) {
      sessionQuotes.forEach((q) => {
        const gap = q.gapPercent ?? 0;
        if (gap > 0.05) advancers++;
        else if (gap < -0.05) decliners++;
      });
      const validActive = advancers + decliners;
      advancersRatio = validActive > 0 ? (advancers / validActive) * 100 : 50;
    }

    // Breadth Score (1 - 10, 50% advancers = 5.5)
    const rawBreadthScore = 1 + (advancersRatio / 100) * 9;

    // 3. News & Catalyst Directional Bias
    let rawNewsBiasScore = 5.0;
    if (activeSetup) {
      if (activeSetup.decision === 'TRADE') {
        rawNewsBiasScore = activeSetup.direction === 'LONG' ? 7.2 : 2.8;
      } else {
        rawNewsBiasScore = advancersRatio >= 55 ? 5.8 : advancersRatio <= 45 ? 4.2 : 5.0;
      }
    } else {
      rawNewsBiasScore = advancersRatio >= 55 ? 6.5 : advancersRatio <= 45 ? 3.5 : 5.0;
    }

    // Weighted Combined Score (60% Futures Trend, 25% Paniere Breadth, 15% Catalyst Bias)
    const finalScore = +(
      rawFuturesScore * 0.6 +
      rawBreadthScore * 0.25 +
      rawNewsBiasScore * 0.15
    ).toFixed(1);

    const boundedScore = Math.min(10, Math.max(1, finalScore));

    // Regime classification
    let regime: SentimentAnalysis['regime'] = 'NEUTRAL';
    let label = 'NEUTRALE (Bilanciato)';
    let description = 'Forze ribassiste e rialziste in equilibrio. I benchmark non mostrano espansione direzionale univoca.';
    let badgeBg = 'bg-amber-950/70';
    let badgeBorder = 'border-amber-700/80';
    let badgeText = 'text-amber-300';

    if (boundedScore >= 7.6) {
      regime = 'STRONG_BULLISH';
      label = 'FORTE BULLISH (Risk-On Spinto)';
      description = 'Futures indici in netta accelerazione rialzista e ampiezza di mercato marcatamente positiva.';
      badgeBg = 'bg-emerald-950/80';
      badgeBorder = 'border-emerald-600';
      badgeText = 'text-emerald-300';
    } else if (boundedScore >= 5.8) {
      regime = 'MODERATE_BULLISH';
      label = 'MODERATO BULLISH (Risk-On Ordinato)';
      description = 'Sentiment positivo supportato da futures e prevalenza di sottostanti in territorio positivo.';
      badgeBg = 'bg-emerald-950/50';
      badgeBorder = 'border-emerald-700/60';
      badgeText = 'text-emerald-400';
    } else if (boundedScore <= 2.5) {
      regime = 'EXTREME_BEARISH';
      label = 'ESTREMO BEARISH (Risk-Off Intenso)';
      description = 'Pressione ribassista diffusa sui benchmark. Vendite istituzionali e diffusa avversione al rischio.';
      badgeBg = 'bg-rose-950/80';
      badgeBorder = 'border-rose-600';
      badgeText = 'text-rose-300';
    } else if (boundedScore <= 4.2) {
      regime = 'MODERATE_BEARISH';
      label = 'MODERATO BEARISH (Pressione Venditrice)';
      description = 'Futures sotto pressione e debolezza diffusa del mercato. Cautela sugli acquisti.';
      badgeBg = 'bg-rose-950/50';
      badgeBorder = 'border-rose-700/60';
      badgeText = 'text-rose-400';
    }

    // 4. Setup Contextual Advice
    const setupDir = activeSetup?.direction;
    let setupAlignment: SentimentAnalysis['setupAlignment'] = {
      status: 'NEUTRAL',
      title: 'Mercato Bilanciato: Focus 100% sul Catalizzatore Singolo',
      advice: 'I benchmark non ostacolano né spingono il trade: l\'esito dipende unicamente dal volume e dal catalizzatore del titolo.',
      badgeColor: 'text-amber-300 bg-amber-950/60 border-amber-800',
    };

    if (setupDir === 'LONG') {
      if (boundedScore >= 5.8) {
        setupAlignment = {
          status: 'TAILWIND',
          title: 'Vento a Favore (+Allineamento Indici Bullish)',
          advice: 'Il sentiment generale spinge nella stessa direzione del Turbo Long. Minore rischio di rigetto e maggiore probabilità di allungo verso Target 1.',
          badgeColor: 'text-emerald-300 bg-emerald-950/80 border-emerald-600',
        };
      } else if (boundedScore <= 4.2) {
        setupAlignment = {
          status: 'HEADWIND',
          title: 'Attenzione: Setup Long contro Trend di Mercato (Contrarian)',
          advice: 'Il mercato complessivo è in vendita/debolezza mentre il setup cerca un rialzo. Richiede disciplina ferrea: non spostare mai lo Stop Loss e non anticipare l\'ingresso.',
          badgeColor: 'text-rose-300 bg-rose-950/80 border-rose-600',
        };
      }
    } else if (setupDir === 'SHORT') {
      if (boundedScore <= 4.2) {
        setupAlignment = {
          status: 'TAILWIND',
          title: 'Vento a Favore (+Pressione Ribassista Indici)',
          advice: 'La debolezza dei benchmark favorisce la discesa del Turbo Short. La gravità del mercato accelera il raggiungimento dei target ribassisti.',
          badgeColor: 'text-emerald-300 bg-emerald-950/80 border-emerald-600',
        };
      } else if (boundedScore >= 5.8) {
        setupAlignment = {
          status: 'HEADWIND',
          title: 'Attenzione: Setup Short contro Trend Rialzista (Contrarian)',
          advice: 'Gli indici stanno salendo con decisione. Aprire uno Short in contesto Risk-On comporta rischio squeeze se il mercato strappa al rialzo.',
          badgeColor: 'text-rose-300 bg-rose-950/80 border-rose-600',
        };
      }
    }

    return {
      score: boundedScore,
      label,
      regime,
      description,
      badgeBg,
      badgeBorder,
      badgeText,
      futuresAvg,
      advancersCount: advancers,
      declinersCount: decliners,
      advancersRatio: +advancersRatio.toFixed(0),
      setupAlignment,
    };
  }, [currentSession, futures, quotes, activeSetup]);

  // Position percentage for gauge needle / bar (1 = 0%, 10 = 100%)
  const gaugePercent = Math.min(100, Math.max(0, ((sentiment.score - 1) / 9) * 100));

  return (
    <div className="bg-slate-950/90 border border-slate-800/90 hover:border-slate-700/80 rounded-xl p-3 sm:p-3.5 mb-3 shadow-md font-mono transition-all">
      {/* Top Header: Score + Regime Badge + Toggle Button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-950/70 border border-indigo-700/60 flex items-center justify-center shrink-0">
            <Compass className="w-5 h-5 text-indigo-400" />
          </div>

          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Sentiment di Mercato Intraday
              </span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${sentiment.badgeBg} ${sentiment.badgeBorder} ${sentiment.badgeText}`}
              >
                {sentiment.label}
              </span>
            </div>

            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-xl sm:text-2xl font-bold font-mono text-white tabular-nums">
                {sentiment.score.toFixed(1)}
              </span>
              <span className="text-xs text-slate-500 font-mono">/ 10</span>
              <span className="text-xs text-slate-400 font-sans hidden md:inline-block">
                • {sentiment.description}
              </span>
            </div>
          </div>
        </div>

        {/* Right: Quick Context Pill & Expand Toggle */}
        <div className="flex items-center gap-2 self-end sm:self-center">
          {activeSetup && (
            <div
              className={`text-[11px] px-2.5 py-1 rounded-lg border font-semibold flex items-center gap-1.5 ${sentiment.setupAlignment.badgeColor}`}
              title={sentiment.setupAlignment.advice}
            >
              {sentiment.setupAlignment.status === 'TAILWIND' ? (
                <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              ) : sentiment.setupAlignment.status === 'HEADWIND' ? (
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              ) : (
                <Zap className="w-3.5 h-3.5 shrink-0" />
              )}
              <span className="truncate max-w-[200px] sm:max-w-[240px]">
                {sentiment.setupAlignment.title}
              </span>
            </div>
          )}

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 px-2 py-1 rounded border border-slate-800 bg-slate-900 transition-colors cursor-pointer"
            title="Dettagli e Scomposizione del Sentiment"
          >
            <span>{isExpanded ? 'Comprimi' : 'Dettagli'}</span>
            {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Visual Spectrum Bar (1 to 10 Gauge) */}
      <div className="mt-3 pt-2 border-t border-slate-800/60">
        <div className="relative w-full h-2 rounded-full bg-slate-800 overflow-hidden">
          {/* Gradient fill from Deep Red (1) through Yellow (5) to Bright Green (10) */}
          <div
            className="absolute inset-0 bg-gradient-to-r from-rose-600 via-amber-500 to-emerald-500 opacity-80"
          />
        </div>

        {/* Cursor Indicator */}
        <div className="relative w-full h-3">
          <div
            className="absolute top-0 -translate-x-1/2 flex flex-col items-center transition-all duration-300"
            style={{ left: `${gaugePercent}%` }}
          >
            <div className="w-2.5 h-2.5 bg-white rounded-full shadow-lg border border-slate-950 ring-2 ring-indigo-400" />
          </div>
        </div>

        {/* Spectrum Scale Labels */}
        <div className="flex justify-between text-[9px] text-slate-500 font-mono uppercase tracking-wider px-0.5 mt-0.5">
          <span className="text-rose-400">1 Bearish</span>
          <span className="text-rose-300">3 Prudenza</span>
          <span className="text-amber-400">5 Neutrale</span>
          <span className="text-emerald-300">7 Risk-On</span>
          <span className="text-emerald-400">10 Bullish</span>
        </div>
      </div>

      {/* Expanded Breakdown & Tactical Context Card */}
      {isExpanded && (
        <div className="mt-3 pt-3 border-t border-slate-800 grid grid-cols-1 md:grid-cols-3 gap-2.5 text-xs">
          {/* 1. Futures Breakdown */}
          <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span className="flex items-center gap-1 font-semibold">
                <Layers className="w-3 h-3 text-indigo-400" />
                Futures Indici (60%)
              </span>
              <span
                className={`font-bold tabular-nums ${
                  sentiment.futuresAvg >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {sentiment.futuresAvg >= 0 ? '+' : ''}
                {sentiment.futuresAvg.toFixed(2)}%
              </span>
            </div>
            <p className="text-[10px] text-slate-400 font-sans leading-relaxed">
              Variazione media pesata dei benchmark di riferimento per la sessione corrente.
            </p>
          </div>

          {/* 2. Breadth Breakdown */}
          <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span className="flex items-center gap-1 font-semibold">
                <Activity className="w-3 h-3 text-amber-400" />
                Ampiezza Titoli (25%)
              </span>
              <span className="font-bold text-white tabular-nums">
                {sentiment.advancersRatio}% Verdi
              </span>
            </div>
            <div className="text-[10px] text-slate-400 font-sans flex items-center justify-between">
              <span>{sentiment.advancersCount} in rialzo</span>
              <span>•</span>
              <span>{sentiment.declinersCount} in ribasso</span>
            </div>
          </div>

          {/* 3. Setup Contextual Recommendation */}
          <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span className="flex items-center gap-1 font-semibold">
                <Info className="w-3 h-3 text-sky-400" />
                Impatto sul Turbo KO
              </span>
              <span className="text-[10px] font-bold text-indigo-300">
                {activeSetup?.direction ? `Setup ${activeSetup.direction}` : 'Setup'}
              </span>
            </div>
            <p className="text-[10px] text-slate-300 font-sans leading-relaxed">
              {sentiment.setupAlignment.advice}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
