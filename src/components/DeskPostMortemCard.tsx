import React from 'react';
import { AlertTriangle, CheckCircle2, Lightbulb } from 'lucide-react';
import type { DeskPostMortemReport } from '../services/api';

export interface DeskPostMortemCardProps {
  report: DeskPostMortemReport;
  directivesAdded?: number;
}

/**
 * Presentazione del post-mortem del desk.
 *
 * Regola: una sezione esiste solo se ha contenuto. Con `llmUnavailable` il
 * componente mostra il motivo e le metriche deterministiche, mai due card
 * vuote con il solo titolo.
 */
export const DeskPostMortemCard: React.FC<DeskPostMortemCardProps> = ({
  report,
  directivesAdded = 0,
}) => {
  const strengths = Array.isArray(report.strengths)
    ? report.strengths.filter((item) => typeof item === 'string' && item.trim().length > 0)
    : [];
  const failurePatterns = Array.isArray(report.failurePatterns)
    ? report.failurePatterns.filter((item) => typeof item === 'string' && item.trim().length > 0)
    : [];
  const metrics = report.metrics;
  const showUnavailable = report.llmUnavailable === true;

  return (
    <div className="space-y-3 pt-2 text-xs animate-in fade-in">
      {report.executiveSummary && (
        <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-purple-300 block font-mono">
            Sintesi Esecutiva del Risk Officer
          </span>
          <p className="text-slate-200 font-sans leading-relaxed">{report.executiveSummary}</p>
        </div>
      )}

      {showUnavailable && (
        <div className="p-2.5 rounded-lg bg-amber-950/40 border border-amber-800/60 text-[11px] text-amber-200 font-sans leading-relaxed">
          Il modello AI non ha risposto: questa e' una sintesi deterministica delle metriche del diario, senza
          interpretazioni qualitative. Rilancia piu' tardi per l'analisi del desk.
        </div>
      )}

      {showUnavailable && metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {[
            { label: 'Trade analizzati', value: String(metrics.total) },
            { label: 'Win rate', value: `${metrics.winRatePct.toFixed(1)}%` },
            { label: 'P&L netto', value: `${metrics.netPnlEur.toFixed(2)} €` },
            { label: 'R medio', value: `${metrics.avgR.toFixed(2)}R` },
          ].map((item) => (
            <div key={item.label} className="p-2 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-[9px] uppercase tracking-wider text-slate-400 block font-mono">
                {item.label}
              </span>
              <span className="text-slate-100 font-mono text-[13px]">{item.value}</span>
            </div>
          ))}
        </div>
      )}

      {(strengths.length > 0 || failurePatterns.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {strengths.length > 0 && (
            <div className="p-3 rounded-xl bg-emerald-950/30 border border-emerald-800/40 space-y-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 block font-mono flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Punti di Forza dell'Esecuzione</span>
              </span>
              <ul className="space-y-1 text-[11px] text-slate-300 font-sans list-disc list-inside">
                {strengths.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {failurePatterns.length > 0 && (
            <div className="p-3 rounded-xl bg-rose-950/30 border border-rose-800/40 space-y-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-rose-400 block font-mono flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Pattern di Errore & Falsi Breakout</span>
              </span>
              <ul className="space-y-1 text-[11px] text-slate-300 font-sans list-disc list-inside">
                {failurePatterns.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {report.tacticalAdvice && (
        <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/40 flex items-start gap-2.5">
          <Lightbulb className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300 block font-mono">
              Raccomandazione Tattica per la Prossima Sessione:
            </span>
            <p className="text-[11px] text-slate-200 font-sans mt-0.5 leading-relaxed">{report.tacticalAdvice}</p>
          </div>
        </div>
      )}

      {directivesAdded > 0 && (
        <div className="p-2.5 rounded-lg bg-purple-950/80 border border-purple-700 text-purple-200 text-[11px] flex items-center gap-2 font-mono">
          <CheckCircle2 className="w-4 h-4 text-purple-300 shrink-0" />
          <span>
            {directivesAdded} nuove direttive qualitative salvate nella Memoria Continua! Ora attive per filtrare
            trappole o convalidare catalizzatori.
          </span>
        </div>
      )}
    </div>
  );
};
