import React from 'react';
import {
  TrendingUp,
  TrendingDown,
  Play,
  RotateCcw,
  Layers,
  Database,
  Radio,
  Globe,
  Filter,
  Sparkles,
} from 'lucide-react';
import { MarketSentimentIndicator } from './MarketSentimentIndicator';
import { RawQuoteData, ExecutionSetup, FilteringAuditReport } from '../types/radar';

interface ScreeningControlsProps {
  currentSession: 'EU' | 'US' | 'GLOBAL';
  onSelectSession: (session: 'EU' | 'US' | 'GLOBAL') => void;
  futures: any;
  quotes?: RawQuoteData[];
  activeSetup?: ExecutionSetup | null;
  isScanning: boolean;
  onRunScan: () => void;
  cachedAt?: string;
  totalUnderlyingsForSession: number;
  circuitBreakerActive: boolean;
  isAutoRefresh: boolean;
  onToggleAutoRefresh: () => void;
  autoRefreshCountdown: number;
  rsiFilterActive: boolean;
  onToggleRsiFilter: () => void;
  auditReport?: FilteringAuditReport | null;
  onOpenAuditModal?: () => void;
  onOpenExcludedAnalyzer?: () => void;
  excludedProfitCount?: number;
}

export const ScreeningControls: React.FC<ScreeningControlsProps> = ({
  currentSession,
  onSelectSession,
  futures,
  quotes,
  activeSetup,
  isScanning,
  onRunScan,
  cachedAt,
  totalUnderlyingsForSession,
  circuitBreakerActive,
  isAutoRefresh,
  onToggleAutoRefresh,
  autoRefreshCountdown,
  rsiFilterActive,
  onToggleRsiFilter,
  auditReport,
  onOpenAuditModal,
  onOpenExcludedAnalyzer,
  excludedProfitCount = 0,
}) => {
  const euFutures = futures?.europe;
  const usFutures = futures?.usa;

  const renderFutureItem = (
    label: string,
    subLabel: string,
    data: any,
    key: string
  ) => {
    return (
      <div
        key={key}
        className="bg-slate-950 border border-slate-800/90 hover:border-slate-700/80 rounded-xl p-3 flex items-center justify-between gap-3 min-w-0 transition-colors shadow-sm"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400 truncate">
            <span className="font-bold text-slate-200">{label}</span>
            <span className="text-[10px] text-slate-500">• {subLabel}</span>
          </div>
          <div className="text-sm sm:text-base font-mono font-bold text-white tabular-nums whitespace-nowrap mt-0.5">
            {data?.price != null ? (
              data.price.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            ) : (
              <span className="text-slate-500 font-normal text-xs">non disp.</span>
            )}
          </div>
        </div>

        {data?.changePercent != null ? (
          <div
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-mono font-bold shrink-0 whitespace-nowrap border ${
              data.changePercent >= 0
                ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/80'
                : 'bg-rose-950/80 text-rose-400 border-rose-800/80'
            }`}
          >
            {data.changePercent >= 0 ? (
              <TrendingUp className="w-3.5 h-3.5" />
            ) : (
              <TrendingDown className="w-3.5 h-3.5" />
            )}
            <span>
              {data.changePercent >= 0 ? '+' : ''}
              {data.changePercent.toFixed(2)}%
            </span>
          </div>
        ) : (
          <span className="text-xs text-slate-500 font-mono shrink-0">nd</span>
        )}
      </div>
    );
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 shadow-xl mb-6 space-y-4">
      {/* Top Controls Row: Session Mode Selector + Actions */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
        {/* Left: Session Mode Selector */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block font-mono">
              Modalità Screening Sessione
            </span>
            {isAutoRefresh && (
              <span className="flex items-center gap-1 text-[11px] font-mono text-emerald-400 xl:hidden">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                Auto-scan: {autoRefreshCountdown}s
              </span>
            )}
          </div>

          <div className="flex flex-wrap rounded-lg bg-slate-950 p-1 border border-slate-800 gap-1">
            {/* Europa */}
            <button
              onClick={() => onSelectSession('EU')}
              disabled={isScanning}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                currentSession === 'EU'
                  ? 'bg-emerald-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span>Europa</span>
              <span className="text-[10px] font-mono opacity-80">(07:30–08:55)</span>
            </button>

            {/* USA */}
            <button
              onClick={() => onSelectSession('US')}
              disabled={isScanning}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                currentSession === 'US'
                  ? 'bg-sky-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-sky-400" />
              <span>USA</span>
              <span className="text-[10px] font-mono opacity-80">(14:30–15:25)</span>
            </button>

            {/* Globale Live (EU + US) */}
            <button
              onClick={() => onSelectSession('GLOBAL')}
              disabled={isScanning}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                currentSession === 'GLOBAL'
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Globe className="w-3.5 h-3.5 text-indigo-300" />
              <span>Globale Live</span>
              <span className="text-[10px] font-mono opacity-90 bg-indigo-950/80 px-1 py-0.5 rounded border border-indigo-700/50">
                EU + USA
              </span>
            </button>
          </div>
        </div>

        {/* Right: Actions & Auto-refresh */}
        <div className="flex flex-col items-start xl:items-end justify-center gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* RSI Filter Toggle Button */}
            <button
              onClick={onToggleRsiFilter}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                rsiFilterActive
                  ? 'bg-indigo-950/80 border-indigo-500 text-indigo-200 shadow-sm shadow-indigo-950/50 ring-1 ring-indigo-500/40'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
              }`}
              title="Filtro RSI Multi-Timeframe (5m Intraday prioritario + 1D): esclude i titoli in ipercomprato (≥70) o ipervenduto (≤30) per proteggere i certificati Turbo Knock-Out da ritracciamenti ed esaurimento momentum"
            >
              <Filter className={`w-3.5 h-3.5 ${rsiFilterActive ? 'text-indigo-400' : 'text-slate-500'}`} />
              <div className="flex items-center gap-1.5">
                <span>Filtro RSI</span>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${
                    rsiFilterActive
                      ? 'bg-indigo-500/30 text-indigo-200 border border-indigo-400/40'
                      : 'bg-slate-800 text-slate-500'
                  }`}
                >
                  {rsiFilterActive ? 'ATTIVO (5m SANO)' : 'OFF'}
                </span>
              </div>
            </button>

            {/* Visual Audit Filtri Modal Trigger */}
            {onOpenAuditModal && auditReport && (
              <button
                type="button"
                onClick={onOpenAuditModal}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-amber-950/50 hover:bg-amber-900/60 text-amber-300 border border-amber-600/60 shadow-sm transition-all cursor-pointer"
                title="Visualizza audit di esclusione: quanti titoli sono stati scartati e perché"
              >
                <Filter className="w-3.5 h-3.5 text-amber-400" />
                <span>Audit Filtri ({auditReport.excludedCount} Esclusi)</span>
              </button>
            )}

            {/* Autoanalisi Setup Esclusi & Counterfactual Tracking Trigger */}
            {onOpenExcludedAnalyzer && (
              <button
                type="button"
                onClick={onOpenExcludedAnalyzer}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-purple-950/60 hover:bg-purple-900/70 text-purple-200 border border-purple-500/60 shadow-sm transition-all cursor-pointer"
                title="Autoanalisi setup esclusi: verifica quanti sono andati a target e calibra i filtri per non scartarli nella prossima sessione"
              >
                <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                <span>Autoanalisi Esclusi</span>
                {excludedProfitCount > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-emerald-500 text-slate-950">
                    {excludedProfitCount} a Target 🎯
                  </span>
                )}
              </button>
            )}

            {/* Auto-Refresh Toggle Button */}
            <button
              onClick={onToggleAutoRefresh}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                isAutoRefresh
                  ? 'bg-emerald-950/70 border-emerald-600 text-emerald-300 shadow-sm'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
              title="Attiva/Disattiva aggiornamento automatico in tempo reale"
            >
              <Radio className={`w-3.5 h-3.5 ${isAutoRefresh ? 'text-emerald-400 animate-pulse' : ''}`} />
              <span>{isAutoRefresh ? `Live Auto (${autoRefreshCountdown}s)` : 'Auto-Scan OFF'}</span>
            </button>

            {/* Scan Button */}
            <button
              onClick={onRunScan}
              disabled={isScanning || circuitBreakerActive}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold shadow-lg transition-all cursor-pointer ${
                circuitBreakerActive
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                  : isScanning
                  ? 'bg-slate-800 text-emerald-400 border border-emerald-500/50 cursor-wait'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white active:scale-95'
              }`}
            >
              {isScanning ? (
                <>
                  <RotateCcw className="w-4 h-4 animate-spin text-emerald-400" />
                  <span>Aggiornamento Tick Live...</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current" />
                  <span>Aggiorna Tick & Screening ({totalUnderlyingsForSession})</span>
                </>
              )}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 font-mono">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block" />
            <Database className="w-3 h-3 text-emerald-400" />
            <span>Feed Live: Tick 15s • Bypass CDN</span>
            {rsiFilterActive && (
              <span className="text-indigo-400 font-semibold">
                • Esclusione Ipercomprato/Ipervenduto Attiva
              </span>
            )}
            {cachedAt && <span>• Ultimo: {new Date(cachedAt).toLocaleTimeString('it-IT')}</span>}
          </div>
        </div>
      </div>

      {/* Real-Time Market Sentiment Indicator (1-10 Scale Bearish/Bullish) */}
      <MarketSentimentIndicator
        currentSession={currentSession}
        futures={futures}
        quotes={quotes}
        activeSetup={activeSetup}
      />

      {/* Bottom Section: Benchmark Index Futures Board (Full Width, Zero Overlap!) */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5 font-mono">
            <Layers className="w-3.5 h-3.5 text-indigo-400" />
            Futures Indice di Riferimento{' '}
            {currentSession === 'GLOBAL'
              ? '(Europa & USA Simultanei)'
              : currentSession === 'EU'
              ? '(Europa)'
              : '(USA)'}
          </span>
          <span className="text-[10px] text-slate-500 font-mono">
            Dati Live Reali da CME & Eurex • Quotazioni Ufficiali
          </span>
        </div>

        <div
          className={`grid gap-3 ${
            currentSession === 'GLOBAL'
              ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
              : 'grid-cols-1 sm:grid-cols-2'
          }`}
        >
          {currentSession === 'EU' && (
            <>
              {renderFutureItem('FDAX 40', 'DAX Eurex Future', euFutures?.dax, 'dax')}
              {renderFutureItem('FESX 50', 'Euro Stoxx Future', euFutures?.eurostoxx, 'eurostoxx')}
            </>
          )}

          {currentSession === 'US' && (
            <>
              {renderFutureItem('ES (S&P 500)', 'CME E-mini Future', usFutures?.sp500, 'sp500')}
              {renderFutureItem('NQ (Nasdaq 100)', 'CME E-mini Future', usFutures?.nasdaq, 'nasdaq')}
            </>
          )}

          {currentSession === 'GLOBAL' && (
            <>
              {renderFutureItem('FDAX 40', 'DAX Eurex Future', euFutures?.dax, 'dax')}
              {renderFutureItem('FESX 50', 'Euro Stoxx Future', euFutures?.eurostoxx, 'eurostoxx')}
              {renderFutureItem('ES (S&P 500)', 'CME E-mini Future', usFutures?.sp500, 'sp500')}
              {renderFutureItem('NQ (Nasdaq 100)', 'CME E-mini Future', usFutures?.nasdaq, 'nasdaq')}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
