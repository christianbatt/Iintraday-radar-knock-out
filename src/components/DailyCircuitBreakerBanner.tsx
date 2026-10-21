import React from 'react';
import { ShieldAlert, AlertOctagon } from 'lucide-react';

interface DailyCircuitBreakerBannerProps {
  isTriggered: boolean;
  reason: string;
  tradesTodayCount: number;
  dailyPnlPercent: number;
}

export const DailyCircuitBreakerBanner: React.FC<DailyCircuitBreakerBannerProps> = ({
  isTriggered,
  reason,
  tradesTodayCount,
  dailyPnlPercent,
}) => {
  if (!isTriggered) return null;

  return (
    <div className="bg-rose-950/80 border-2 border-rose-600 rounded-xl p-5 shadow-2xl mb-6 text-rose-200">
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-xl bg-rose-900/60 border border-rose-500 flex items-center justify-center text-rose-300 shrink-0">
          <AlertOctagon className="w-7 h-7 animate-bounce" />
        </div>
        <div className="space-y-1.5 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold uppercase tracking-wider text-white">
              🚨 CIRCUIT BREAKER ATTIVO — BLOCCO RIGOROSO SEGNALI
            </h3>
            <span className="px-2 py-0.5 rounded bg-rose-900 font-mono text-xs font-bold text-rose-200 border border-rose-700">
              Stop Operativo
            </span>
          </div>
          <p className="text-xs text-rose-200 leading-relaxed font-mono">
            {reason}
          </p>
          <div className="flex flex-wrap items-center gap-4 text-xs font-mono pt-2 text-rose-300">
            <span>Trade eseguiti oggi: <strong className="text-white">{tradesTodayCount} / 2</strong></span>
            <span>•</span>
            <span>P&L giornaliero: <strong className="text-white">{dailyPnlPercent.toFixed(2)}%</strong></span>
            <span>•</span>
            <span className="text-amber-300 font-semibold">
              Modalità Osservazione Attiva: Scansione continua ogni 20s, setup sempre visibili e monitoraggio prezzi live attivo sulle posizioni a giornale. Nuovi ingressi a giornale bloccati per rigore operativo.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
