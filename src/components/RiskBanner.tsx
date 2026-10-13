import React from 'react';
import { AlertTriangle } from 'lucide-react';

export const RiskBanner: React.FC = () => {
  return (
    <div className="bg-amber-950/40 border-b border-amber-800/60 text-amber-200 px-4 py-2.5 text-xs">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>
            <strong className="font-semibold text-amber-300">AVVISO PERMANENTE DI RISCHIO:</strong>{' '}
            I certificati Knock-Out (Turbo/KO) sono strumenti finanziari derivati a leva complessi ad alto rischio. Comportano il rischio concreto di perdita totale del capitale investito al raggiungimento della barriera. Nessuna informazione costituisce consulenza finanziaria né sollecitazione all'investimento.
          </span>
        </div>
        <span className="hidden md:inline-block font-mono bg-amber-900/40 px-2 py-0.5 rounded text-[11px] text-amber-300/80 shrink-0 border border-amber-700/40">
          Trade Republic KO • Rischio Max 1%
        </span>
      </div>
    </div>
  );
};
