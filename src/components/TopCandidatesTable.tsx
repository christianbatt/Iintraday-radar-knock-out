import React, { useState, useMemo } from 'react';
import {
  ScoredCandidate,
  RawQuoteData,
} from '../types/radar';
import {
  TrendingUp,
  TrendingDown,
  Sparkles,
  Info,
  CheckCircle2,
  AlertTriangle,
  Activity,
  Sliders,
  ChevronDown,
  ChevronUp,
  Target,
  Zap,
  Filter,
  Search,
  Globe,
  Flame,
} from 'lucide-react';

interface TopCandidatesTableProps {
  candidates: ScoredCandidate[];
  selectedCandidate: ScoredCandidate | null;
  onSelectCandidate: (candidate: ScoredCandidate) => void;
  onViewCatalyst: (candidate: ScoredCandidate) => void;
  isLoadingNewsFor: string | null;
  topEU?: ScoredCandidate | null;
  topUS?: ScoredCandidate | null;
}

type RadarFilter = 'ALL' | 'EU' | 'US' | 'QUALIFIED' | 'HIGH_RVOL' | 'RVOL_20M' | 'HIGH_VOL' | 'RSI_HEALTHY';

export const TopCandidatesTable: React.FC<TopCandidatesTableProps> = ({
  candidates,
  selectedCandidate,
  onSelectCandidate,
  onViewCatalyst,
  isLoadingNewsFor,
  topEU,
  topUS,
}) => {
  const [activeFilter, setActiveFilter] = useState<RadarFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedStopTicker, setExpandedStopTicker] = useState<string | null>(null);

  // Filter and search candidates
  const filteredCandidates = useMemo(() => {
    return candidates.filter((item) => {
      const q = item.quote;
      // Search text filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesTicker = q.ticker.toLowerCase().includes(query);
        const matchesName = q.name?.toLowerCase().includes(query) ?? false;
        if (!matchesTicker && !matchesName) return false;
      }

      // Category filter
      if (activeFilter === 'EU') return q.market === 'EU';
      if (activeFilter === 'US') return q.market === 'US';
      if (activeFilter === 'QUALIFIED') return item.score.total >= 55;
      if (activeFilter === 'HIGH_RVOL') return (q.rvol ?? 0) >= 1.3;
      if (activeFilter === 'RVOL_20M') return (q.rvol20m ?? 0) >= 1.25;
      if (activeFilter === 'HIGH_VOL') {
        const refPrice = q.preMarketPrice ?? q.currentPrice ?? 0;
        const atrPct = q.atr14 && refPrice > 0 ? (q.atr14 / refPrice) * 100 : 0;
        return atrPct >= 1.5;
      }
      if (activeFilter === 'RSI_HEALTHY') {
        const rsi = q.rsi5m ?? q.rsi14;
        return rsi != null && rsi > 30 && rsi < 70;
      }
      return true;
    });
  }, [candidates, activeFilter, searchQuery]);

  if (candidates.length === 0) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-slate-400 mb-8">
        <p className="text-sm font-mono">
          Nessuna classifica calcolata. Clicca su "Esegui Screening" o attendi l'auto-refresh per avviare il radar live.
        </p>
      </div>
    );
  }

  const toggleStopCalibration = (ticker: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedStopTicker((prev) => (prev === ticker ? null : ticker));
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl mb-8">
      {/* 1. Header & Title */}
      <div className="px-5 py-4 border-b border-slate-800 bg-slate-950 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wider text-white font-mono flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              <span>Intraday Live Radar: Titoli & Setup a Mercati Aperti</span>
            </h2>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
              Screening Dinamico
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5 font-mono">
            Radar completo dei sottostanti monitorati: individua tempestivamente opportunità secondarie durante la giornata.
          </p>
        </div>

        {/* Quick Search Bar */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Cerca ticker o nome..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 pr-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors w-48 sm:w-56"
          />
        </div>
      </div>

      {/* 2. Interactive Switch Filters */}
      <div className="px-5 py-2.5 bg-slate-950/60 border-b border-slate-800/80 flex flex-wrap items-center gap-2 overflow-x-auto">
        <span className="text-[11px] font-mono text-slate-400 flex items-center gap-1 mr-1">
          <Filter className="w-3 h-3 text-slate-400" />
          Filtri:
        </span>

        <button
          onClick={() => setActiveFilter('ALL')}
          className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition-colors cursor-pointer ${
            activeFilter === 'ALL'
              ? 'bg-slate-700 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          Tutti i Titoli ({candidates.length})
        </button>

        <button
          onClick={() => setActiveFilter('EU')}
          className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeFilter === 'EU'
              ? 'bg-emerald-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <span>🇪🇺 Europa</span>
          <span className="text-[10px] opacity-75">
            ({candidates.filter((c) => c.quote.market === 'EU').length})
          </span>
        </button>

        <button
          onClick={() => setActiveFilter('US')}
          className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeFilter === 'US'
              ? 'bg-sky-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <span>🇺🇸 USA (Wall Street)</span>
          <span className="text-[10px] opacity-75">
            ({candidates.filter((c) => c.quote.market === 'US').length})
          </span>
        </button>

        <button
          onClick={() => setActiveFilter('QUALIFIED')}
          className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeFilter === 'QUALIFIED'
              ? 'bg-amber-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <span>🎯 Score Qualificato (≥55)</span>
          <span className="text-[10px] opacity-75">
            ({candidates.filter((c) => c.score.total >= 55).length})
          </span>
        </button>

        <button
          onClick={() => setActiveFilter('HIGH_RVOL')}
          className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeFilter === 'HIGH_RVOL'
              ? 'bg-purple-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <span>🚀 Forte RVOL (&gt;1.3x)</span>
        </button>

        <button
          onClick={() => setActiveFilter('RVOL_20M')}
          className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeFilter === 'RVOL_20M'
              ? 'bg-amber-600 text-white shadow-sm ring-1 ring-amber-400/50'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
          title="Filtra i titoli con accelerazione di volume negli ultimi 20 minuti rispetto alla media mobile (RVOL 20m ≥ 1.25x)"
        >
          <span>⚡ Spike Vol 20m (≥1.25x)</span>
          <span className="text-[10px] opacity-75">
            ({candidates.filter((c) => (c.quote.rvol20m ?? 0) >= 1.25).length})
          </span>
        </button>

        <button
          onClick={() => setActiveFilter('HIGH_VOL')}
          className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeFilter === 'HIGH_VOL'
              ? 'bg-rose-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <span>🔥 Alta Volatilità (ATR &gt;1.5%)</span>
        </button>

        <button
          onClick={() => setActiveFilter('RSI_HEALTHY')}
          className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeFilter === 'RSI_HEALTHY'
              ? 'bg-indigo-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <span>⚖️ RSI Sano (30–70)</span>
          <span className="text-[10px] opacity-75">
            ({candidates.filter((c) => {
              const r = c.quote.rsi5m ?? c.quote.rsi14;
              return r != null && r > 30 && r < 70;
            }).length})
          </span>
        </button>
      </div>

      {/* 3. High-Fidelity Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs font-mono">
          <thead className="bg-slate-950 text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-800">
            <tr>
              <th className="py-3 px-3 text-center">Rank</th>
              <th className="py-3 px-3">Sottostante</th>
              <th className="py-3 px-3 text-right">Prezzo Live</th>
              <th className="py-3 px-3 text-right">Chiusura Ieri</th>
              <th className="py-3 px-3 text-right">Gap %</th>
              <th className="py-3 px-3 text-right">RVOL (Tot / 20m) & RSI</th>
              {/* ATR & Volatility Column */}
              <th className="py-3 px-3 text-right bg-slate-900/60 border-x border-slate-800">
                <div className="flex flex-col items-end">
                  <div className="flex items-center gap-1 text-slate-200">
                    <Activity className="w-3.5 h-3.5 text-amber-400" />
                    <span>ATR(14) / Volatilità</span>
                  </div>
                  <span className="text-[10px] text-amber-300 font-medium">
                    Guida Stop-Loss (0.5x–1.0x)
                  </span>
                </div>
              </th>
              <th className="py-3 px-3 text-center">Range Ieri (H / L)</th>
              <th className="py-3 px-3 text-center">Score</th>
              <th className="py-3 px-3 text-center">Stato Radar</th>
              <th className="py-3 px-3 text-right">Azioni</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {filteredCandidates.map((cand) => {
              const q = cand.quote;
              const isSelected = selectedCandidate?.quote.ticker === q.ticker;
              const isTopEU = topEU?.quote.ticker === q.ticker;
              const isTopUS = topUS?.quote.ticker === q.ticker;
              const isStopExpanded = expandedStopTicker === q.ticker;
              const gapVal = q.gapPercent ?? 0;

              const refPrice = q.preMarketPrice ?? q.currentPrice ?? q.prevClose ?? 0;
              const atrVal = q.atr14;
              const volPct = atrVal != null && refPrice > 0 ? ((atrVal / refPrice) * 100).toFixed(1) : null;
              const stopBuffer05 = atrVal != null ? +(atrVal * 0.5).toFixed(2) : null;
              const stopBuffer075 = atrVal != null ? +(atrVal * 0.75).toFixed(2) : null;
              const stopBuffer10 = atrVal != null ? +(atrVal * 1.0).toFixed(2) : null;

              return (
                <React.Fragment key={q.ticker}>
                  <tr
                    onClick={() => onSelectCandidate(cand)}
                    className={`cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-emerald-950/40 hover:bg-emerald-950/50'
                        : isTopEU || isTopUS
                        ? 'bg-slate-800/50 hover:bg-slate-800/70'
                        : 'hover:bg-slate-800/30'
                    }`}
                  >
                    {/* Rank */}
                    <td className="py-3 px-3 text-center">
                      <span
                        className={`inline-block w-6 h-6 leading-6 rounded-md font-bold text-xs ${
                          cand.rank === 1
                            ? 'bg-amber-500 text-slate-950'
                            : cand.rank <= 3
                            ? 'bg-slate-800 text-amber-300'
                            : 'bg-slate-900 text-slate-400'
                        }`}
                      >
                        {cand.rank}
                      </span>
                    </td>

                    {/* Sottostante */}
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <span className="text-base select-none">
                          {q.market === 'EU' ? '🇪🇺' : '🇺🇸'}
                        </span>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-white tracking-wide">
                              {q.ticker}
                            </span>
                            <span className="text-[10px] text-slate-400 px-1.5 py-0.2 rounded bg-slate-800">
                              {q.currency}
                            </span>
                            {isTopEU && (
                              <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/40">
                                TOP EU
                              </span>
                            )}
                            {isTopUS && (
                              <span className="text-[9px] px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-300 font-bold border border-sky-500/40">
                                TOP USA
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400 truncate max-w-[150px]">
                            {q.name}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Prezzo Live */}
                    <td className="py-3 px-3 text-right">
                      <span className="font-bold text-white tabular-nums">
                        {refPrice > 0 ? refPrice.toFixed(2) : 'n/d'}
                      </span>
                      <span className="text-[10px] text-slate-400 ml-1">{q.currency}</span>
                    </td>

                    {/* Chiusura Ieri */}
                    <td className="py-3 px-3 text-right text-slate-400 tabular-nums">
                      {q.prevClose ? q.prevClose.toFixed(2) : 'n/d'}
                    </td>

                    {/* Gap % */}
                    <td className="py-3 px-3 text-right">
                      {q.gapPercent != null ? (
                        <div
                          className={`inline-flex items-center gap-1 font-bold tabular-nums px-2 py-0.5 rounded text-xs ${
                            gapVal >= 0
                              ? 'bg-emerald-950/70 text-emerald-400 border border-emerald-800/80'
                              : 'bg-rose-950/70 text-rose-400 border border-rose-800/80'
                          }`}
                        >
                          {gapVal >= 0 ? (
                            <TrendingUp className="w-3 h-3" />
                          ) : (
                            <TrendingDown className="w-3 h-3" />
                          )}
                          <span>
                            {gapVal >= 0 ? '+' : ''}
                            {gapVal.toFixed(2)}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-500">n/d</span>
                      )}
                    </td>

                    {/* RVOL / RSI(14) */}
                    <td className="py-3 px-3 text-right">
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-1.5 flex-wrap justify-end">
                          {q.rvol != null ? (
                            <span
                              className={`font-semibold tabular-nums ${
                                q.rvol >= 1.5
                                  ? 'text-purple-400 font-bold'
                                  : q.rvol >= 1.1
                                  ? 'text-slate-200'
                                  : 'text-slate-500'
                              }`}
                              title={`RVOL Cumulativo di Sessione: ${q.rvol.toFixed(2)}x`}
                            >
                              {q.rvol.toFixed(2)}x
                            </span>
                          ) : (
                            <span className="text-slate-600">nd</span>
                          )}

                          {q.rvol20m != null && (
                            <span
                              className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold tracking-tight inline-flex items-center gap-0.5 ${
                                q.rvol20m >= 1.5
                                  ? 'bg-amber-950/90 text-amber-300 border border-amber-700/80 animate-pulse'
                                  : q.rvol20m >= 1.1
                                  ? 'bg-sky-950/80 text-sky-300 border border-sky-800/60'
                                  : 'bg-slate-900 text-slate-500 border border-slate-800'
                              }`}
                              title={`Relative Volume ultimi 20 minuti: ${q.rvol20m.toFixed(2)}x rispetto alla media mobile 20m`}
                            >
                              <span>{q.rvol20m >= 1.5 ? '🔥' : '⚡'} 20m:</span>
                              <span>{q.rvol20m.toFixed(1)}x</span>
                            </span>
                          )}
                        </div>

                        {q.rsi5m != null ? (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold tracking-tight inline-flex items-center gap-0.5 ${
                              q.rsi5m >= 70
                                ? 'bg-rose-950/90 text-rose-300 border border-rose-800'
                                : q.rsi5m <= 30
                                ? 'bg-indigo-950/90 text-indigo-300 border border-indigo-800'
                                : 'bg-emerald-950/90 text-emerald-300 border border-emerald-800/80'
                            }`}
                            title={`RSI 5m Intraday: ${q.rsi5m} (Timing ottimale per Turbo Knock-Out)${q.rsi14 != null ? ` | RSI 1D Daily: ${q.rsi14}` : ''}`}
                          >
                            <span className="text-[9px] text-slate-400 font-normal">5m:</span>
                            <span>{q.rsi5m}</span>
                          </span>
                        ) : q.rsi14 != null ? (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold tracking-tight ${
                              q.rsi14 >= 70
                                ? 'bg-rose-950/90 text-rose-300 border border-rose-800'
                                : q.rsi14 <= 30
                                ? 'bg-indigo-950/90 text-indigo-300 border border-indigo-800'
                                : 'bg-slate-800/90 text-slate-300 border border-slate-700/60'
                            }`}
                            title={`RSI(14) Giornaliero: ${q.rsi14}`}
                          >
                            RSI {q.rsi14}
                          </span>
                        ) : null}

                        {q.rsi5m != null && q.rsi14 != null && (
                          <span
                            className="text-[9px] px-1 py-0.2 rounded font-mono text-slate-400 bg-slate-900 border border-slate-800 hidden sm:inline-block"
                            title={`RSI 1D Daily di fondo: ${q.rsi14}`}
                          >
                            1D:{q.rsi14}
                          </span>
                        )}

                        {q.orderFlow != null && (
                          <span
                            className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold tracking-tight inline-flex items-center gap-1 ${
                              q.orderFlow.cvdTrend === 'ABSORPTION_TRAP'
                                ? 'bg-rose-950 text-rose-300 border border-rose-600 animate-pulse'
                                : q.orderFlow.flowQuality === 'INSTITUTIONAL_BUYING'
                                ? 'bg-emerald-950 text-emerald-300 border border-emerald-700/80'
                                : q.orderFlow.flowQuality === 'INSTITUTIONAL_SELLING'
                                ? 'bg-rose-950 text-rose-300 border border-rose-800'
                                : 'bg-slate-900 text-slate-300 border border-slate-700'
                            }`}
                            title={`Order Flow Synthetic L2 (30m): ${q.orderFlow.buyerVolumePercent}% Ask / ${q.orderFlow.sellerVolumePercent}% Bid (Delta: ${q.orderFlow.netDeltaPercent >= 0 ? '+' : ''}${q.orderFlow.netDeltaPercent}%). VPOC: ${q.orderFlow.vpocPrice ?? 'N/D'}`}
                          >
                            <span>L2 Delta:</span>
                            <span>{q.orderFlow.netDeltaPercent >= 0 ? `+${q.orderFlow.netDeltaPercent}% Ask` : `${q.orderFlow.netDeltaPercent}% Bid`}</span>
                            {q.orderFlow.cvdTrend === 'ABSORPTION_TRAP' && <span>⚠️</span>}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* ATR Column with calibration button */}
                    <td className="py-3 px-3 text-right bg-slate-900/60 border-x border-slate-800">
                      {atrVal != null ? (
                        <div className="flex flex-col items-end">
                          <button
                            type="button"
                            onClick={(e) => toggleStopCalibration(q.ticker, e)}
                            className="inline-flex items-center gap-1 font-bold text-amber-300 hover:text-amber-200 tabular-nums text-xs px-2 py-0.5 rounded bg-amber-950/50 border border-amber-800/60 transition-colors cursor-pointer"
                            title="Clicca per calibrare Stop-Loss e Barriere Knock-Out basate su ATR"
                          >
                            <Activity className="w-3 h-3 text-amber-400" />
                            <span>{atrVal.toFixed(2)} {q.currency}</span>
                            {volPct && (
                              <span className="text-[10px] text-amber-400/80 font-normal">
                                ({volPct}%)
                              </span>
                            )}
                            {isStopExpanded ? (
                              <ChevronUp className="w-3 h-3 ml-0.5 text-amber-400" />
                            ) : (
                              <ChevronDown className="w-3 h-3 ml-0.5 text-amber-400" />
                            )}
                          </button>
                        </div>
                      ) : (
                        <span className="text-slate-600">nd</span>
                      )}
                    </td>

                    {/* Range Ieri */}
                    <td className="py-3 px-3 text-center text-slate-400 tabular-nums text-[11px]">
                      {q.prevHigh != null && q.prevLow != null
                        ? `${q.prevHigh.toFixed(2)} / ${q.prevLow.toFixed(2)}`
                        : 'nd'}
                    </td>

                    {/* Score */}
                    <td className="py-3 px-3 text-center">
                      <span
                        className={`font-bold tabular-nums px-2 py-0.5 rounded text-xs ${
                          cand.score.total >= 70
                            ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                            : cand.score.total >= 55
                            ? 'bg-sky-950 text-sky-400 border border-sky-800'
                            : 'bg-slate-900 text-slate-500 border border-slate-800'
                        }`}
                      >
                        {cand.score.total}/100
                      </span>
                    </td>

                    {/* Stato Radar */}
                    <td className="py-3 px-3 text-center">
                      {cand.score.total >= 55 ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 font-semibold bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/40">
                          <CheckCircle2 className="w-3 h-3" />
                          <span>QUALIFICATO</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 font-medium bg-slate-950/80 px-2 py-0.5 rounded border border-slate-800">
                          <span>IN OSSERVAZIONE</span>
                        </span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="py-3 px-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onViewCatalyst(cand);
                          }}
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer border border-slate-700"
                          title="Analizza Notizie & Catalizzatore"
                        >
                          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectCandidate(cand);
                          }}
                          className={`px-2 py-1 rounded-lg text-[11px] font-semibold transition-colors cursor-pointer ${
                            isSelected
                              ? 'bg-emerald-500 text-slate-950 font-bold'
                              : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                          }`}
                        >
                          {isSelected ? 'Selezionato' : 'Carica Setup'}
                        </button>
                      </div>
                    </td>
                  </tr>

                  {/* Expanded ATR Stop-Loss Calibration Subrow */}
                  {isStopExpanded && atrVal != null && (
                    <tr className="bg-amber-950/20 border-b border-amber-900/30">
                      <td colSpan={11} className="py-3 px-6">
                        <div className="flex flex-wrap items-center justify-between gap-4 text-xs font-mono">
                          <div className="flex items-center gap-2">
                            <Sliders className="w-4 h-4 text-amber-400" />
                            <span className="text-amber-200 font-bold">
                              Calibrazione Stop-Loss con ATR(14) per {q.ticker}:
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-6">
                            <div>
                              <span className="text-slate-400 text-[11px]">Stop Anti-Rumore (0.5x ATR): </span>
                              <strong className="text-emerald-400">
                                ±{stopBuffer05} {q.currency}
                              </strong>
                            </div>
                            <div>
                              <span className="text-slate-400 text-[11px]">Stop Normale (0.75x ATR): </span>
                              <strong className="text-sky-400">
                                ±{stopBuffer075} {q.currency}
                              </strong>
                            </div>
                            <div>
                              <span className="text-slate-400 text-[11px]">Stop Conservativo (1.0x ATR): </span>
                              <strong className="text-amber-400">
                                ±{stopBuffer10} {q.currency}
                              </strong>
                            </div>
                            <div className="text-[11px] text-slate-300 bg-slate-950 px-2.5 py-1 rounded border border-slate-800">
                              🛡️ Barriera KO Consigliata: distanza &gt;{' '}
                              <strong className="text-white font-bold">
                                {(atrVal * 2.5).toFixed(2)} {q.currency}
                              </strong>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
