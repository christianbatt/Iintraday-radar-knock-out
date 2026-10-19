import React, { useEffect, useState } from 'react';
import {
  Filter,
  X,
  ExternalLink,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Info,
  ChevronRight,
  TrendingDown,
  Activity,
  Layers,
  Sparkles,
} from 'lucide-react';
import { FilteringAuditReport } from '../types/radar';

interface FilteringAuditBannerProps {
  report: FilteringAuditReport | null;
  durationMs?: number; // default 4500ms (4.5s)
  onOpenDetailsModal?: () => void;
  onOpenExcludedAnalyzer?: () => void;
  onDismiss?: () => void;
}

export const FilteringAuditBanner: React.FC<FilteringAuditBannerProps> = ({
  report,
  durationMs = 4800,
  onOpenDetailsModal,
  onOpenExcludedAnalyzer,
  onDismiss,
}) => {
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(100);
  const onDismissRef = React.useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!report) {
      setIsVisible(false);
      return;
    }

    setIsVisible(true);
    setProgress(100);

    const startTime = Date.now();
    const endTime = startTime + durationMs;

    const intervalTimer = setInterval(() => {
      const now = Date.now();
      const remaining = Math.max(0, endTime - now);
      const pct = (remaining / durationMs) * 100;
      setProgress(pct);
    }, 50);

    const dismissTimeout = setTimeout(() => {
      setIsVisible(false);
      onDismissRef.current?.();
    }, durationMs);

    return () => {
      clearInterval(intervalTimer);
      clearTimeout(dismissTimeout);
    };
  }, [report, durationMs]);

  if (!isVisible || !report) return null;

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 w-full max-w-4xl px-4 pointer-events-auto transition-all animate-in fade-in slide-in-from-top-4 duration-300">
      <div className="bg-slate-950/95 border border-amber-500/60 rounded-2xl p-3.5 sm:p-4 shadow-2xl backdrop-blur-md text-slate-100 font-mono ring-1 ring-amber-500/30">
        <div className="flex items-start justify-between gap-3">
          {/* Left Icon */}
          <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-center text-amber-400 shrink-0 mt-0.5">
            <Filter className="w-5 h-5 animate-pulse" />
          </div>

          {/* Center Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="font-bold text-xs uppercase tracking-wider text-amber-300 flex items-center gap-1.5">
                <span>Visual Audit del Filtraggio</span>
                <span className="text-[10px] text-slate-400 font-normal">({report.timestamp})</span>
              </span>
              <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700">
                {report.totalScanned} Analizzati
              </span>
              <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800">
                {report.qualifiedCount} Qualificati
              </span>
              <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-rose-950 text-rose-300 border border-rose-800">
                {report.excludedCount} Scartati
              </span>
            </div>

            {/* Reasons Summary */}
            <p className="text-xs text-slate-200 font-sans leading-relaxed">
              Il sistema ha escluso i candidati non idonei per difendere il capitale:{' '}
              <span className="text-amber-200 font-mono font-semibold">
                {report.bulletSummary.slice(0, 3).join(' • ')}
                {report.bulletSummary.length > 3 ? ` • +${report.bulletSummary.length - 3} altre cause` : ''}
              </span>
            </p>
          </div>

          {/* Right Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {onOpenExcludedAnalyzer && (
              <button
                type="button"
                onClick={onOpenExcludedAnalyzer}
                className="px-2.5 py-1.5 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/40 text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                title="Apri l'autoanalisi per verificare quanti esclusi sono andati a target"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Autoanalisi Esclusi</span>
              </button>
            )}
            {onOpenDetailsModal && (
              <button
                type="button"
                onClick={onOpenDetailsModal}
                className="px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer"
              >
                <span>Dettagli</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setIsVisible(false);
                if (onDismiss) onDismiss();
              }}
              className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              title="Chiudi notifica"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Progress Bar (4.5s countdown timer) */}
        <div className="w-full h-1 bg-slate-800 rounded-full mt-3 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-75"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
};
