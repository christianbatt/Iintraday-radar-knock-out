import React, { useEffect, useState } from 'react';
import {
  Radar,
  Clock,
  FileSpreadsheet,
  ShieldAlert,
  RotateCcw,
  Zap,
  Sparkles,
} from 'lucide-react';
import { SessionInfo } from '../types/radar';

interface HeaderProps {
  sessionInfo: SessionInfo | null;
  onOpenCsvManager: () => void;
  underlyingsCount: number;
  isPaperMode: boolean;
  onTogglePaperMode: () => void;
  tradesTodayCount: number;
  dailyPnlPercent: number;
  isCircuitBreakerActive: boolean;
  onResetCache: () => void;
  currentSession?: 'EU' | 'US' | 'GLOBAL';
  isInstallable?: boolean;
  onInstallApp?: () => void;
  onOpenContactModal?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  sessionInfo,
  onOpenCsvManager,
  underlyingsCount,
  isPaperMode,
  onTogglePaperMode,
  tradesTodayCount,
  dailyPnlPercent,
  isCircuitBreakerActive,
  onResetCache,
  currentSession,
  isInstallable,
  onInstallApp,
  onOpenContactModal,
}) => {
  const [liveCetTime, setLiveCetTime] = useState<string>('00:00:00 CET');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const cetStr = new Intl.DateTimeFormat('it-IT', {
        timeZone: 'Europe/Rome',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(now);
      setLiveCetTime(`${cetStr} CET`);
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const isEuropeWindow = sessionInfo?.cet?.isEuropeWindow ?? false;
  const isUsaWindow = sessionInfo?.cet?.isUSAWindow ?? false;

  return (
    <header className="bg-slate-950 border-b border-slate-800/80 sticky top-0 z-30 shadow-lg">
      <div className="max-w-7xl mx-auto px-4 py-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          {/* Logo & Platform Info */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
              <Radar className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
                  INTRADAY RADAR
                  <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                    Trade Republic KO
                  </span>
                </h1>
              </div>
              <p className="text-xs text-slate-400">
                Screening Pre-Market & Live • Risk Governance • Analisi Catalizzatori
              </p>
            </div>
          </div>

          {/* Real-time Status Badges */}
          <div className="flex flex-wrap items-center gap-2 md:gap-3 text-xs">
            {/* Live CET Clock */}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-900 border border-slate-800 font-mono text-slate-200">
              <Clock className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span>{liveCetTime}</span>
            </div>

            {/* Session Window Badges */}
            {currentSession === 'GLOBAL' ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-indigo-950/70 border border-indigo-600/70 text-indigo-300 font-medium">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                Live Globale (EU: {sessionInfo?.cet?.isEuropeLive ? 'Aperto' : 'Pre/Post'} • US: {sessionInfo?.cet?.isUSALive ? 'Aperto' : 'Pre-Mkt'})
              </span>
            ) : currentSession === 'EU' ? (
              sessionInfo?.cet?.isEuropeLive ? (
                <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-emerald-950/80 border border-emerald-600/80 text-emerald-300 font-medium">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  Borse Europee: NEGOZIAZIONE LIVE (09:00–17:35 CET)
                </span>
              ) : isEuropeWindow ? (
                <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-emerald-950/60 border border-emerald-600/60 text-emerald-300 font-medium">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  Pre-Market Europa (07:30–08:55 CET)
                </span>
              ) : (
                <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-900 border border-slate-800 text-slate-400">
                  <span className="w-2 h-2 rounded-full bg-slate-500" />
                  Borse Europee Chiuse (Apertura 09:00 CET)
                </span>
              )
            ) : sessionInfo?.cet?.isUSALive ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-sky-950/80 border border-sky-600/80 text-sky-300 font-medium">
                <span className="w-2 h-2 rounded-full bg-sky-400 animate-ping" />
                Wall Street: NEGOZIAZIONE LIVE (15:30–22:05 CET)
              </span>
            ) : isUsaWindow ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-sky-950/60 border border-sky-600/60 text-sky-300 font-medium">
                <span className="w-2 h-2 rounded-full bg-sky-400" />
                Finestra USA Pre-Market (14:30–15:25 CET)
              </span>
            ) : sessionInfo?.cet?.isUSAPreMarket ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-sky-950/40 border border-sky-700/50 text-sky-300 font-medium">
                <span className="w-2 h-2 rounded-full bg-sky-400" />
                Pre-Market USA Attivo (Apertura Cash 15:30 CET)
              </span>
            ) : (
              <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-900 border border-slate-800 text-slate-400">
                <span className="w-2 h-2 rounded-full bg-slate-500" />
                Borsa USA Chiusa (Pre-Market dalle 10:00 CET)
              </span>
            )}

            {/* Daily Limits Pill */}
            <div
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border font-mono ${
                isCircuitBreakerActive
                  ? 'bg-rose-950/60 border-rose-600/80 text-rose-300'
                  : 'bg-slate-900 border-slate-800 text-slate-300'
              }`}
            >
              <ShieldAlert className={`w-3.5 h-3.5 ${isCircuitBreakerActive ? 'text-rose-400' : 'text-slate-400'}`} />
              <span>Trade: {tradesTodayCount}/2</span>
              <span>•</span>
              <span className={dailyPnlPercent < 0 ? 'text-rose-400' : dailyPnlPercent > 0 ? 'text-emerald-400' : 'text-slate-400'}>
                Stop G.: {dailyPnlPercent > 0 ? `+${dailyPnlPercent.toFixed(1)}%` : `${dailyPnlPercent.toFixed(1)}%`}
              </span>
            </div>

            {/* Paper Trading Toggle */}
            <button
              onClick={onTogglePaperMode}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border transition-colors ${
                isPaperMode
                  ? 'bg-indigo-950/60 border-indigo-600/60 text-indigo-300'
                  : 'bg-amber-950/60 border-amber-600/60 text-amber-300'
              }`}
              title="Alterna modalità Paper Trading e Monitoraggio Reale"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{isPaperMode ? 'Paper Trading' : 'Modalità Reale'}</span>
            </button>

            {/* Underlyings CSV Manager Trigger */}
            <button
              onClick={onOpenCsvManager}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 text-slate-300 transition-colors"
              title="Gestisci Sottostanti Trade Republic KO"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
              <span>Sottostanti ({underlyingsCount})</span>
            </button>

            {/* PWA Install Button */}
            {isInstallable && onInstallApp && (
              <button
                onClick={onInstallApp}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 transition-colors font-mono font-semibold animate-pulse cursor-pointer"
                title="Installa applicazione PWA su Desktop / Mobile"
              >
                <Zap className="w-3.5 h-3.5 text-emerald-400" />
                <span>Installa App</span>
              </button>
            )}

            {/* Creator & Contact Modal Trigger */}
            {onOpenContactModal && (
              <button
                onClick={onOpenContactModal}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-indigo-950/50 hover:bg-indigo-900/60 border border-indigo-700/60 text-indigo-300 hover:text-indigo-200 transition-colors font-medium cursor-pointer"
                title="Profilo Sviluppatore (Christian Battistoni) & Modulo Contatti"
              >
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                <span>Creator & Info</span>
              </button>
            )}

            {/* Reset Cache Button */}
            <button
              onClick={onResetCache}
              className="p-1.5 rounded-md bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              title="Svuota Cache Dati"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
