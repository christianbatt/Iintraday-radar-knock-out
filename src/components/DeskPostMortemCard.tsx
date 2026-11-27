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

  // ADDITIVO (P7): analisi ancorata al fascicolo (`ai-desk@1`). Il server la
  // produce da sempre, ma il client la scartava: qui diventa visibile, con le
  // chiavi citate e con cio' che il validatore ha rifiutato.
  const anchored =
    report.deskAnalysis && report.deskAnalysis.available === true ? report.deskAnalysis : null;
  const anchoredUnavailable =
    report.deskAnalysis !== undefined &&
    report.deskAnalysis !== null &&
    report.deskAnalysis.available === false;
  const anchoredClaims = Array.isArray(anchored?.analysis?.claims)
    ? anchored.analysis.claims.filter(
        (claim) => typeof claim?.statement === 'string' && claim.statement.trim().length > 0
      )
    : [];
  const anchoredGaps = Array.isArray(anchored?.analysis?.dataGaps)
    ? anchored.analysis.dataGaps.filter((gap) => typeof gap === 'string' && gap.trim().length > 0)
    : [];
  const anchoredRejected = Array.isArray(anchored?.analysis?.rejected)
    ? anchored.analysis.rejected.filter((item) => typeof item?.code === 'string')
    : [];
  const anchoredMissing = Array.isArray(anchored?.missingSections) ? anchored.missingSections : [];
  const hasAnchoredContent =
    anchored !== null &&
    (anchoredClaims.length > 0 ||
      anchoredGaps.length > 0 ||
      anchoredRejected.length > 0 ||
      anchored.summaryVerified === true);

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

      {anchoredUnavailable && (
        <p
          data-testid="desk-anchored-unavailable"
          className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-400 font-sans"
        >
          Analisi ancorata al fascicolo non disponibile in questa risposta: la sintesi sopra non e'
          stata verificata contro chiavi citabili.
        </p>
      )}

      {hasAnchoredContent && anchored && (
        <div
          data-testid="desk-anchored-analysis"
          className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2"
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300 font-mono">
              Analisi ancorata al fascicolo
            </span>
            <span
              data-testid="desk-anchored-verified"
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                anchored.analysis.verified
                  ? 'bg-emerald-900/50 text-emerald-300'
                  : 'bg-amber-900/40 text-amber-300'
              }`}
            >
              {anchored.analysis.verified ? 'verificata' : 'non verificata'}
            </span>
          </div>
          <p className="text-[10px] text-slate-500 font-mono" data-testid="desk-anchored-meta">
            contratto {anchored.contractVersion} · fascicolo {anchored.evidencePackVersion} ·{' '}
            {anchored.evidenceKeys ?? 0} chiavi citabili
            {anchoredMissing.length > 0 ? ` · sezioni mancanti: ${anchoredMissing.join(', ')}` : ''}
          </p>
          {anchoredClaims.length > 0 && (
            <ul className="space-y-1.5" data-testid="desk-anchored-claims">
              {anchoredClaims.map((claim, index) => (
                <li key={index} className="text-[11px] text-slate-200 font-sans leading-relaxed">
                  <span className={claim.insufficient ? 'text-amber-300' : undefined}>
                    {claim.statement}
                    {claim.insufficient ? ' (campione insufficiente)' : ''}
                  </span>
                  <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
                    {(claim.evidenceRefs ?? []).map((ref) => (
                      <code
                        key={ref}
                        className="px-1 py-0.5 rounded bg-slate-800 text-[9px] text-slate-400 font-mono"
                      >
                        {ref}
                      </code>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {anchoredRejected.length > 0 && (
            <p className="text-[10px] text-rose-300" data-testid="desk-anchored-rejected">
              scartate dal validatore: {anchoredRejected.length} (
              {[...new Set(anchoredRejected.map((item) => item.code))].join(', ')})
            </p>
          )}
          {anchoredGaps.length > 0 && (
            <p className="text-[10px] text-slate-400" data-testid="desk-anchored-gaps">
              dati mancanti o insufficienti: {anchoredGaps.join(' · ')}
            </p>
          )}
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
