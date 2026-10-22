import React from 'react';
import {
  X,
  Sparkles,
  ExternalLink,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Newspaper,
  Layers,
} from 'lucide-react';
import { ScoredCandidate, NewsItem, GeminiCatalystAnalysis } from '../types/radar';

interface CatalystModalProps {
  isOpen: boolean;
  onClose: () => void;
  candidate: ScoredCandidate | null;
  news: NewsItem[];
  catalyst: GeminiCatalystAnalysis | null;
  isLoading: boolean;
  onReanalyze: () => void;
}

export const CatalystModal: React.FC<CatalystModalProps> = ({
  isOpen,
  onClose,
  candidate,
  news,
  catalyst,
  isLoading,
  onReanalyze,
}) => {
  if (!isOpen || !candidate) return null;

  const q = candidate.quote;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-slate-100">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white font-mono">
                  {q.ticker} • {q.name}
                </h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  Rank #{candidate.rank}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Analisi Qualitativa Catalizzatore & Fonti Notiziose (Ultime 24h)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Market Snapshot Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-950 p-3.5 rounded-lg border border-slate-800 font-mono">
            <div>
              <span className="text-slate-500 block text-[10px]">Prezzo Ultimo:</span>
              <span className="font-bold text-white">
                {q.preMarketPrice ?? q.currentPrice ?? 'nd'} {q.currency}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px]">Gap Odierno:</span>
              <span
                className={`font-bold ${
                  (q.gapPercent ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {(q.gapPercent ?? 0) >= 0 ? '+' : ''}
                {q.gapPercent ?? 0}%
              </span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px]">Relative Volume:</span>
              <span className="font-bold text-amber-300">
                {q.rvol != null ? `${q.rvol}x` : 'nd'}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px]">ATR(14):</span>
              <span className="font-bold text-slate-300">
                {q.atr14 ?? 'nd'} {q.currency}
              </span>
            </div>
          </div>

          {/* Synthetic Level-2 Order Flow Snapshot if available */}
          {q.orderFlow && (
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2 font-mono text-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-cyan-400" />
                  <span className="font-bold text-slate-200 uppercase tracking-wider text-[11px]">
                    Order Flow & Delta L2 (30m Intraday)
                  </span>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                  q.orderFlow.cvdTrend === 'ABSORPTION_TRAP'
                    ? 'bg-rose-950 text-rose-300 border border-rose-600 animate-pulse'
                    : q.orderFlow.netDeltaPercent >= 0
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                    : 'bg-rose-950 text-rose-300 border border-rose-800'
                }`}>
                  Delta: {q.orderFlow.netDeltaPercent >= 0 ? `+${q.orderFlow.netDeltaPercent}% Ask` : `${q.orderFlow.netDeltaPercent}% Bid`}
                </span>
              </div>
              <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden flex">
                <div className="bg-emerald-500" style={{ width: `${q.orderFlow.buyerVolumePercent}%` }} />
                <div className="bg-rose-500" style={{ width: `${q.orderFlow.sellerVolumePercent}%` }} />
              </div>
              <div className="text-[11px] text-slate-400 pt-0.5">
                {q.orderFlow.summary}
              </div>
            </div>
          )}

          {/* Gemini Catalyst Analysis Section */}
          <div className="bg-slate-950 p-5 rounded-xl border border-slate-800 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-400" />
                <h4 className="text-xs font-bold uppercase tracking-wider text-white">
                  Valutazione Rigorosa Gemini
                </h4>
              </div>
              <button
                onClick={onReanalyze}
                disabled={isLoading}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-300 transition-colors"
              >
                <RotateCcw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
                <span>Rianalizza</span>
              </button>
            </div>

            {isLoading ? (
              <div className="py-8 text-center text-slate-400 text-xs flex flex-col items-center gap-2">
                <RotateCcw className="w-6 h-6 animate-spin text-emerald-400" />
                <span>Interrogazione modello per verifica fonti e catalizzatori in corso...</span>
              </div>
            ) : catalyst ? (
              <div className="space-y-4 text-xs">
                {/* Decision Badge */}
                <div className="flex items-center gap-3">
                  <span
                    className={`px-3 py-1 rounded-full font-mono font-bold text-xs border ${
                      catalyst.decisione === 'TRADE'
                        ? 'bg-emerald-950 text-emerald-300 border-emerald-700'
                        : 'bg-rose-950 text-rose-300 border-rose-700'
                    }`}
                  >
                    DECISIONE: {catalyst.decisione}
                  </span>
                  <span className="font-mono text-slate-300">
                    Direzione suggerita:{' '}
                    <strong className="text-white">{catalyst.direzione}</strong>
                  </span>
                </div>

                {/* Catalyst Detail */}
                <div>
                  <span className="text-[11px] uppercase tracking-wider text-slate-400 block mb-1 font-semibold">
                    Descrizione Catalizzatore
                  </span>
                  <p className="text-slate-200 text-xs leading-relaxed bg-slate-900 p-3 rounded-lg border border-slate-800">
                    {catalyst.catalizzatore}
                  </p>
                </div>

                {/* Pro & Contra */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Points in favor */}
                  <div className="bg-emerald-950/20 p-3 rounded-lg border border-emerald-900/40">
                    <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Punti a Favore
                    </span>
                    <ul className="list-disc list-inside space-y-1 text-emerald-200/90 text-[11px]">
                      {catalyst.punti_a_favore.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>

                  {/* Identified Risks */}
                  <div className="bg-rose-950/20 p-3 rounded-lg border border-rose-900/40">
                    <span className="text-[11px] font-bold text-rose-400 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Rischi & Controindicazioni
                    </span>
                    <ul className="list-disc list-inside space-y-1 text-rose-200/90 text-[11px]">
                      {catalyst.rischi.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Invalidation Conditions */}
                {catalyst.condizioni_invalidazione.length > 0 && (
                  <div className="bg-slate-900 p-3 rounded-lg border border-slate-800">
                    <span className="text-[11px] font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5 mb-1.5">
                      <ShieldAlert className="w-3.5 h-3.5" />
                      Condizioni che Invalidano la Tesi
                    </span>
                    <ul className="list-disc list-inside space-y-1 text-slate-300 text-[11px]">
                      {catalyst.condizioni_invalidazione.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-4 text-slate-500 text-xs">
                Nessuna analisi disponibile per questo titolo. Clicca su "Rianalizza".
              </div>
            )}
          </div>

          {/* Raw News Feed (Last 24h) */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2 mb-3">
              <Newspaper className="w-4 h-4 text-slate-500" />
              Notizie Raccolte con Fonti Verificate ({news.length})
            </h4>

            <div className="space-y-3">
              {news.map((item) => (
                <div
                  key={item.id}
                  className="bg-slate-950 p-3.5 rounded-lg border border-slate-800 hover:border-slate-700 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <h5 className="font-semibold text-white text-xs">{item.title}</h5>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1 hover:bg-slate-800 text-emerald-400 hover:text-emerald-300 rounded transition-colors shrink-0"
                      title="Apri fonte notizia"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed mb-2">
                    {item.summary}
                  </p>
                  <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono">
                    <span>Fonte: {item.source}</span>
                    <span>•</span>
                    <span>Pubblicato: {new Date(item.publishedAt).toLocaleString('it-IT')}</span>
                  </div>
                </div>
              ))}

              {news.length === 0 && (
                <div className="p-4 bg-slate-950 border border-slate-800 rounded-lg text-center text-slate-500 text-xs">
                  Nessuna notizia rilevante trovata per il ticker nelle ultime 24 ore.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950 flex items-center justify-between text-xs text-slate-400">
          <span className="font-mono text-[11px]">
            Gemini valuta solo il catalizzatore qualitativo. I numeri di trading sono calcolati dal codice.
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-medium transition-colors"
          >
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
};
