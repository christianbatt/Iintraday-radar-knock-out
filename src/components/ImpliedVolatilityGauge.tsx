import React, { useState } from 'react';
import { ImpliedVolatilityMetrics, RawQuoteData } from '../types/radar';
import { calculateImpliedVolatilityMetrics } from '../utils/calculator';
import {
  Gauge,
  Info,
  TrendingUp,
  AlertTriangle,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  Flame,
} from 'lucide-react';

interface ImpliedVolatilityGaugeProps {
  quote: RawQuoteData | undefined | null;
  metrics?: ImpliedVolatilityMetrics;
  compact?: boolean;
}

export const ImpliedVolatilityGauge: React.FC<ImpliedVolatilityGaugeProps> = ({
  quote,
  metrics: explicitMetrics,
  compact = false,
}) => {
  const [showExplanation, setShowExplanation] = useState(false);

  const m: ImpliedVolatilityMetrics =
    explicitMetrics || calculateImpliedVolatilityMetrics(quote);

  // Angle calculation for SVG needle:
  // Gauge range: 0% to 100% maps to -90deg (far left) to +90deg (far right)
  const angle = -90 + (m.gaugePercent / 100) * 180;

  // Color mapping based on regime
  const regimeConfig = {
    COMPRESSED: {
      badgeBg: 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300',
      textColor: 'text-emerald-400',
      pillColor: 'bg-emerald-500',
      needleColor: '#10b981',
      glowColor: 'rgba(16, 185, 129, 0.35)',
      statusLabel: 'SCONTO VOLATILITÀ',
    },
    FAIR: {
      badgeBg: 'bg-sky-950/60 border-sky-500/40 text-sky-300',
      textColor: 'text-sky-400',
      pillColor: 'bg-sky-400',
      needleColor: '#38bdf8',
      glowColor: 'rgba(56, 189, 248, 0.35)',
      statusLabel: 'PREMIO EQUO / BILANCIATO',
    },
    ELEVATED: {
      badgeBg: 'bg-amber-950/60 border-amber-500/50 text-amber-300',
      textColor: 'text-amber-400',
      pillColor: 'bg-amber-400',
      needleColor: '#f59e0b',
      glowColor: 'rgba(245, 158, 11, 0.45)',
      statusLabel: 'PREMIO AL RISCHIO ELEVATO',
    },
    EXTREME: {
      badgeBg: 'bg-rose-950/70 border-rose-500/60 text-rose-300 animate-pulse',
      textColor: 'text-rose-400',
      pillColor: 'bg-rose-500',
      needleColor: '#f43f5e',
      glowColor: 'rgba(244, 63, 94, 0.55)',
      statusLabel: 'RISCHIO ESTREMO (IV CRUSH)',
    },
  }[m.regime];

  return (
    <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 font-mono text-xs">
      {/* Header Row */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          <Gauge className={`w-3.5 h-3.5 ${regimeConfig.textColor}`} />
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-200">
            Implied Volatility (IV) vs Media 30gg
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <span
            className={`text-[9px] px-2 py-0.5 rounded-full font-bold border ${regimeConfig.badgeBg}`}
          >
            {regimeConfig.statusLabel}
          </span>
          <button
            type="button"
            onClick={() => setShowExplanation(!showExplanation)}
            className="text-slate-400 hover:text-white transition-colors p-0.5 rounded cursor-pointer"
            title="Dettagli e spiegazione del Premio al Rischio"
          >
            <Info className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Gauge Graphic & Metric Readout */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        {/* Semi-Circular SVG Gauge Dial */}
        <div className="relative w-36 h-20 shrink-0 flex items-center justify-center">
          <svg viewBox="0 0 160 90" className="w-full h-full overflow-visible">
            <defs>
              <linearGradient id="gaugeArcGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#10b981" />
                <stop offset="35%" stopColor="#06b6d4" />
                <stop offset="65%" stopColor="#f59e0b" />
                <stop offset="100%" stopColor="#f43f5e" />
              </linearGradient>
              <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>

            {/* Background Arc Track */}
            <path
              d="M 15 80 A 65 65 0 0 1 145 80"
              fill="none"
              stroke="#1e293b"
              strokeWidth="12"
              strokeLinecap="round"
            />

            {/* Gradient Colored Arc */}
            <path
              d="M 15 80 A 65 65 0 0 1 145 80"
              fill="none"
              stroke="url(#gaugeArcGradient)"
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray="204"
              strokeDashoffset={Math.max(0, 204 - (m.gaugePercent / 100) * 204)}
              className="transition-all duration-700 ease-out"
            />

            {/* Dial Tick Marks */}
            {/* 0% (Far Left) */}
            <line x1="15" y1="80" x2="25" y2="80" stroke="#64748b" strokeWidth="1.5" />
            {/* 50% (Top Center) */}
            <line x1="80" y1="15" x2="80" y2="25" stroke="#64748b" strokeWidth="1.5" />
            {/* 100% (Far Right) */}
            <line x1="145" y1="80" x2="135" y2="80" stroke="#64748b" strokeWidth="1.5" />

            {/* Rotating Needle Pointer */}
            <g
              transform={`rotate(${angle}, 80, 80)`}
              className="transition-transform duration-700 ease-out"
            >
              {/* Pointer line */}
              <line
                x1="80"
                y1="80"
                x2="80"
                y2="24"
                stroke={regimeConfig.needleColor}
                strokeWidth="2.5"
                strokeLinecap="round"
                filter="url(#glow)"
              />
              {/* Needle Arrow Tip */}
              <polygon
                points="77,26 80,18 83,26"
                fill={regimeConfig.needleColor}
              />
            </g>

            {/* Center Pivot Hub */}
            <circle cx="80" cy="80" r="6" fill="#0f172a" stroke="#cbd5e1" strokeWidth="2" />
            <circle cx="80" cy="80" r="2.5" fill={regimeConfig.needleColor} />
          </svg>

          {/* Under-Dial Position Text */}
          <div className="absolute bottom-0 text-[9px] text-slate-400 font-mono">
            {m.gaugePercent}% scala
          </div>
        </div>

        {/* Numeric Comparison Breakdown */}
        <div className="flex-1 w-full space-y-1.5">
          <div className="grid grid-cols-2 gap-2">
            {/* IV Current */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2">
              <span className="text-[10px] text-slate-400 block leading-tight">
                IV Attuale (Derivati)
              </span>
              <div className="text-base font-black text-white tabular-nums mt-0.5">
                {m.impliedVol.toFixed(1)}%
              </div>
              <span className="text-[9px] text-slate-500">
                IV Rank: <strong className="text-slate-300">{m.ivRank}%</strong>
              </span>
            </div>

            {/* 30d Average Realized Vol */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2">
              <span className="text-[10px] text-slate-400 block leading-tight">
                Media Storica (30gg)
              </span>
              <div className="text-base font-bold text-slate-300 tabular-nums mt-0.5">
                {m.avg30dVol.toFixed(1)}%
              </div>
              <span className="text-[9px] text-slate-500">Benchmark Realized</span>
            </div>
          </div>

          {/* Risk Premium Spread Callout */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
              <TrendingUp className="w-3 h-3 text-slate-400" />
              <span>Premio al Rischio:</span>
            </div>
            <div className="flex items-center gap-1 text-[11px] font-bold tabular-nums">
              <span
                className={
                  m.riskPremium > 0
                    ? m.riskPremiumPercent > 25
                      ? 'text-rose-400'
                      : 'text-amber-400'
                    : 'text-emerald-400'
                }
              >
                {m.riskPremium > 0 ? '+' : ''}
                {m.riskPremium.toFixed(1)}%
              </span>
              <span className="text-slate-400 font-normal text-[10px]">
                ({m.riskPremiumPercent > 0 ? '+' : ''}
                {m.riskPremiumPercent.toFixed(1)}% vs media)
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Practical Derivative Implication */}
      <div className="mt-2 pt-2 border-t border-slate-800/70 text-[10px] leading-relaxed text-slate-300 flex items-start gap-1.5">
        {m.regime === 'EXTREME' || m.regime === 'ELEVATED' ? (
          <Flame className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
        ) : (
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
        )}
        <p className="flex-1 font-sans">
          <strong className="text-slate-200 font-mono">Impatto Derivati KO: </strong>
          {m.implication}
        </p>
      </div>

      {/* Educational Collapsible Explainer */}
      {showExplanation && (
        <div className="mt-2.5 p-2.5 rounded-lg bg-slate-900/95 border border-slate-700/80 text-[10px] space-y-1.5 font-sans animate-fadeIn">
          <div className="flex items-center justify-between text-slate-200 font-bold font-mono text-[11px]">
            <span>Come interpretare il Premio al Rischio (IV vs 30d Avg):</span>
            <button
              type="button"
              onClick={() => setShowExplanation(false)}
              className="text-slate-400 hover:text-white"
            >
              ✕
            </button>
          </div>
          <p className="text-slate-300">
            • <strong>Volatilità Implicita (IV):</strong> È il livello di rischio futuro che i market maker incorporano nei prezzi dei Knock-Out, turbo e opzioni.
          </p>
          <p className="text-slate-300">
            • <strong>Media 30gg:</strong> È la volatilità reale misurata sulle chiusure dell'ultimo mese di borsa.
          </p>
          <p className="text-slate-300">
            • <strong>Premio al Rischio Positivo (+):</strong> Se l'IV è sensibilmente superiore alla media, il mercato anticipa forte volatilità (es. per catalizzatori, trimestrali o gap). Gli emittenti ampliano gli spread bid/ask dei certificati.
          </p>
          <p className="text-slate-300">
            • <strong>Sconto Volatilità (-):</strong> Segnala compressione di volatilità prima di un possibile breakout violento, con spread minimi e massimo rendimento asimmetrico.
          </p>
        </div>
      )}
    </div>
  );
};
