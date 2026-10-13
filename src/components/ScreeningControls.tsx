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
} from 'lucide-react';

interface ScreeningControlsProps {
  currentSession: 'EU' | 'US' | 'GLOBAL';
  onSelectSession: (session: 'EU' | 'US' | 'GLOBAL') => void;
  futures: any;
  isScanning: boolean;
  onRunScan: () => void;
  cachedAt?: string;
  totalUnderlyingsForSession: number;
  circuitBreakerActive: boolean;
  isAutoRefresh: boolean;
  onToggleAutoRefresh: () => void;
  autoRefreshCountdown: number;
}

export const ScreeningControls: React.FC<ScreeningControlsProps> = ({
  currentSession,
  onSelectSession,
  futures,
  isScanning,
  onRunScan,
  cachedAt,
  totalUnderlyingsForSession,
  circuitBreakerActive,
  isAutoRefresh,
  onToggleAutoRefresh,
  autoRefreshCountdown,
}) => {
  const euFutures = futures?.europe;
  const usFutures = futures?.usa;

  const renderFutureItem = (
    label: string,
    data: any,
    key: string
  ) => {
    return (
      <div key={key} className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-mono text-slate-400">{label}</div>
          <div className="text-sm font-mono font-bold text-white">
            {data?.price != null ? (
              data.price.toLocaleString('it-IT', { minimumFractionDigits: 2 })
            ) : (
              <span className="text-slate-500 font-normal text-xs">dato non disponibile</span>
            )}
          </div>
        </div>
        {data?.changePercent != null ? (
          <div
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-mono font-semibold ${
              data.changePercent >= 0
                ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/80'
                : 'bg-rose-950/80 text-rose-400 border border-rose-800/80'
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
          <span className="text-xs text-slate-500 font-mono">nd</span>
        )}
      </div>
    );
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl mb-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
        {/* Session Mode Selector */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400 block">
              Modalità Screening Sessione
            </span>
            {isAutoRefresh && (
              <span className="flex items-center gap-1 text-[11px] font-mono text-emerald-400">
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
              className={`flex items-center gap-2 px-3.5 py-2 rounded-md text-xs font-semibold transition-all ${
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
              className={`flex items-center gap-2 px-3.5 py-2 rounded-md text-xs font-semibold transition-all ${
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
              className={`flex items-center gap-2 px-3.5 py-2 rounded-md text-xs font-semibold transition-all ${
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

        {/* Benchmark Index Futures Board */}
        <div className="flex-1 max-w-2xl">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-slate-500" />
              Futures Indice di Riferimento{' '}
              {currentSession === 'GLOBAL'
                ? '(Europa & USA Simultanei)'
                : currentSession === 'EU'
                ? '(Europa)'
                : '(USA)'}
            </span>
            <span className="text-[10px] text-slate-500 font-mono">Dati Live Reali da CME & Eurex</span>
          </div>

          <div
            className={`grid gap-2.5 ${
              currentSession === 'GLOBAL' ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2'
            }`}
          >
            {currentSession === 'EU' && (
              <>
                {renderFutureItem('FDAX (DAX 40)', euFutures?.dax, 'dax')}
                {renderFutureItem('FESX (Euro Stoxx 50)', euFutures?.eurostoxx, 'eurostoxx')}
              </>
            )}

            {currentSession === 'US' && (
              <>
                {renderFutureItem('ES (S&P 500)', usFutures?.sp500, 'sp500')}
                {renderFutureItem('NQ (Nasdaq 100)', usFutures?.nasdaq, 'nasdaq')}
              </>
            )}

            {currentSession === 'GLOBAL' && (
              <>
                {renderFutureItem('FDAX (DAX 40)', euFutures?.dax, 'dax')}
                {renderFutureItem('FESX (Euro Stoxx)', euFutures?.eurostoxx, 'eurostoxx')}
                {renderFutureItem('ES (S&P 500)', usFutures?.sp500, 'sp500')}
                {renderFutureItem('NQ (Nasdaq 100)', usFutures?.nasdaq, 'nasdaq')}
              </>
            )}
          </div>
        </div>

        {/* Actions & Auto-refresh */}
        <div className="flex flex-col items-start lg:items-end justify-center gap-2">
          <div className="flex items-center gap-2">
            {/* Auto-Refresh Toggle Button */}
            <button
              onClick={onToggleAutoRefresh}
              className={`flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-xs font-semibold border transition-all ${
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
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-bold shadow-lg transition-all ${
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

          <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block" />
            <Database className="w-3 h-3 text-emerald-400" />
            <span>Feed Live: Tick 15s • Bypass CDN</span>
            {cachedAt && <span>• Ultimo: {new Date(cachedAt).toLocaleTimeString('it-IT')}</span>}
          </div>
        </div>
      </div>
    </div>
  );
};
