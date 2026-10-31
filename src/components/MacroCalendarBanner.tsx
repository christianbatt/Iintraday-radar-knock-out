import React, { useState } from 'react';
import { MacroCalendarState } from '../types/radar';
import { AlertTriangle, Clock, ShieldAlert, ChevronDown, ChevronUp, BellRing } from 'lucide-react';

interface MacroCalendarBannerProps {
  macroCalendar: MacroCalendarState | null;
}

export const MacroCalendarBanner: React.FC<MacroCalendarBannerProps> = ({ macroCalendar }) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(false);

  if (!macroCalendar || !macroCalendar.events || macroCalendar.events.length === 0) {
    return null;
  }

  const { isBlackoutActive, activeBlackoutEvent, spreadWarningTradeRepublic, events } = macroCalendar;

  // Check if any event is upcoming in the next 45 minutes
  const upcomingEvent = events.find((e) => e.minutesToEvent > 0 && e.minutesToEvent <= 45);

  if (!isBlackoutActive && !upcomingEvent) {
    return null;
  }

  return (
    <div
      className={`rounded-xl border p-4 mb-6 shadow-xl transition-all ${
        isBlackoutActive
          ? 'bg-rose-950/85 border-rose-600 text-rose-200'
          : 'bg-amber-950/80 border-amber-600/80 text-amber-200'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 flex-1">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
              isBlackoutActive
                ? 'bg-rose-900/60 border-rose-500 text-rose-300 animate-pulse'
                : 'bg-amber-900/60 border-amber-500 text-amber-300'
            }`}
          >
            {isBlackoutActive ? (
              <ShieldAlert className="w-6 h-6" />
            ) : (
              <BellRing className="w-5 h-5 animate-bounce" />
            )}
          </div>

          <div className="space-y-1 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`px-2 py-0.5 rounded font-mono text-[11px] font-bold uppercase border ${
                  isBlackoutActive
                    ? 'bg-rose-900 text-white border-rose-600 animate-pulse'
                    : 'bg-amber-900 text-amber-100 border-amber-600'
                }`}
              >
                {isBlackoutActive ? '🚨 MACRO BLACKOUT ATTIVO' : '⏳ EVENTO MACRO IMMINENTE'}
              </span>

              {isBlackoutActive && activeBlackoutEvent && (
                <span className="text-xs font-mono font-bold text-white">
                  {activeBlackoutEvent.event} ({activeBlackoutEvent.timeCET} CET)
                </span>
              )}

              {!isBlackoutActive && upcomingEvent && (
                <span className="text-xs font-mono font-bold text-white">
                  {upcomingEvent.event} tra {upcomingEvent.minutesToEvent} min ({upcomingEvent.timeCET} CET)
                </span>
              )}
            </div>

            <p className="text-xs font-mono leading-relaxed">
              {isBlackoutActive
                ? spreadWarningTradeRepublic ||
                  'Finestra di volatilità estrema (±15 min dal rilascio). Gli emittenti dei Knock-Out allargano gli spread denaro/lettera o ritirano le quotazioni su Lang & Schwarz. Operatività rigorosamente sospesa.'
                : 'Attenzione agli spread su Trade Republic: in prossimità del rilascio macro, la volatilità può provocare spike improvvisi e slippage sui Knock-Out.'}
            </p>
          </div>
        </div>

        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-xs font-mono px-2 py-1 rounded bg-slate-900/60 hover:bg-slate-900 border border-slate-700/60 flex items-center gap-1 shrink-0 text-slate-300"
        >
          <span>{isExpanded ? 'Chiudi' : 'Dettagli Eventi'}</span>
          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      </div>

      {isExpanded && (
        <div className="mt-3 pt-3 border-t border-slate-800/80 space-y-2">
          <div className="text-[11px] font-mono text-slate-300 uppercase tracking-wider font-bold">
            Calendario Market Mover ad Alto Impatto (Oggi):
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs font-mono">
            {events.map((evt) => (
              <div
                key={evt.id}
                className={`p-2 rounded border flex items-center justify-between gap-2 ${
                  evt.isBlackoutNow
                    ? 'bg-rose-900/40 border-rose-700 text-rose-200'
                    : 'bg-slate-900/60 border-slate-800 text-slate-300'
                }`}
              >
                <div>
                  <div className="font-bold flex items-center gap-1.5">
                    <span className="text-amber-400">{evt.timeCET} CET</span>
                    <span>{evt.event}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 truncate max-w-[280px]">
                    {evt.description}
                  </div>
                </div>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase shrink-0 ${
                    evt.isBlackoutNow
                      ? 'bg-rose-600 text-white animate-pulse'
                      : evt.minutesToEvent > 0
                      ? 'bg-slate-800 text-amber-300'
                      : 'bg-slate-800 text-slate-500'
                  }`}
                >
                  {evt.isBlackoutNow
                    ? 'Blackout'
                    : evt.minutesToEvent > 0
                    ? `-${evt.minutesToEvent}m`
                    : 'Passato'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
