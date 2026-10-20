import React, { useState, useMemo } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Cell,
} from 'recharts';
import { ScoredCandidate } from '../types/radar';
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Compass,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  Filter,
  BarChart2,
  Layers,
  Sparkles,
  Info,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';

interface BenchmarkCorrelationHeatmapProps {
  candidates: ScoredCandidate[];
  futures: any;
  onSelectCandidate?: (cand: ScoredCandidate) => void;
  onViewCatalyst?: (cand: ScoredCandidate) => void;
}

type MarketFilter = 'ALL' | 'EU' | 'US';
type SortOrder = 'ALPHA_DESC' | 'ALPHA_ASC' | 'DIVERGENCE';

export const BenchmarkCorrelationHeatmap: React.FC<BenchmarkCorrelationHeatmapProps> = ({
  candidates,
  futures,
  onSelectCandidate,
  onViewCatalyst,
}) => {
  const [marketFilter, setMarketFilter] = useState<MarketFilter>('ALL');
  const [sortOrder, setSortOrder] = useState<SortOrder>('ALPHA_DESC');
  const [activeBenchmarkMetric, setActiveBenchmarkMetric] = useState<'PRIMARY' | 'BOTH'>('BOTH');

  // Extract Benchmark values
  const daxChange = futures?.europe?.dax?.changePercent ?? 0;
  const eurostoxxChange = futures?.europe?.eurostoxx?.changePercent ?? 0;
  const spxChange = futures?.usa?.sp500?.changePercent ?? 0;
  const ndxChange = futures?.usa?.nasdaq?.changePercent ?? 0;

  // Compute Relative Strength & Alpha metrics for each candidate
  const processedData = useMemo(() => {
    return candidates.map((cand) => {
      const isEU = cand.quote.market === 'EU';
      const tickerChange = cand.quote.gapPercent ?? 0;

      // Identify primary and secondary benchmarks
      const primaryBenchName = isEU ? 'FDAX (DAX 40)' : 'NQ (Nasdaq 100)';
      const primaryBenchChange = isEU ? daxChange : ndxChange;

      const secondaryBenchName = isEU ? 'FESX (Euro Stoxx 50)' : 'ES (S&P 500)';
      const secondaryBenchChange = isEU ? eurostoxxChange : spxChange;

      // Relative Alpha: Stock Performance minus Benchmark Performance
      const alphaPrimary = +(tickerChange - primaryBenchChange).toFixed(2);
      const alphaSecondary = +(tickerChange - secondaryBenchChange).toFixed(2);

      // Average Alpha
      const avgAlpha = +((alphaPrimary + alphaSecondary) / 2).toFixed(2);

      // Relative Strength Categorization
      let performanceStatus:
        | 'STRONG_OUTPERFORM'
        | 'MODERATE_OUTPERFORM'
        | 'IN_LINE'
        | 'MODERATE_UNDERPERFORM'
        | 'STRONG_UNDERPERFORM';

      if (alphaPrimary >= 1.5) {
        performanceStatus = 'STRONG_OUTPERFORM';
      } else if (alphaPrimary >= 0.5) {
        performanceStatus = 'MODERATE_OUTPERFORM';
      } else if (alphaPrimary <= -1.5) {
        performanceStatus = 'STRONG_UNDERPERFORM';
      } else if (alphaPrimary <= -0.5) {
        performanceStatus = 'MODERATE_UNDERPERFORM';
      } else {
        performanceStatus = 'IN_LINE';
      }

      // Regime of Confluence or Contrarian Divergence
      let confluenceType:
        | 'CONFLUENCE_LONG'
        | 'DIVERGENCE_BULLISH'
        | 'CONFLUENCE_SHORT'
        | 'DIVERGENCE_BEARISH'
        | 'NEUTRAL';

      if (tickerChange > 0 && primaryBenchChange > 0) {
        confluenceType = 'CONFLUENCE_LONG';
      } else if (tickerChange > 0 && primaryBenchChange <= 0) {
        confluenceType = 'DIVERGENCE_BULLISH'; // Decoupled outperformance
      } else if (tickerChange < 0 && primaryBenchChange < 0) {
        confluenceType = 'CONFLUENCE_SHORT';
      } else if (tickerChange < 0 && primaryBenchChange >= 0) {
        confluenceType = 'DIVERGENCE_BEARISH'; // Decoupled weakness
      } else {
        confluenceType = 'NEUTRAL';
      }

      // Heatmap Color mapping
      let heatmapColor = '#64748b'; // Neutral slate
      if (alphaPrimary >= 3.0) heatmapColor = '#06b6d4'; // Extreme cyan outperformance
      else if (alphaPrimary >= 1.5) heatmapColor = '#10b981'; // Solid green outperformance
      else if (alphaPrimary >= 0.5) heatmapColor = '#34d399'; // Moderate green
      else if (alphaPrimary <= -3.0) heatmapColor = '#e11d48'; // Extreme dark rose underperformance
      else if (alphaPrimary <= -1.5) heatmapColor = '#f43f5e'; // Solid rose underperformance
      else if (alphaPrimary <= -0.5) heatmapColor = '#fb7185'; // Moderate rose

      return {
        candidate: cand,
        ticker: cand.quote.ticker,
        name: cand.quote.name,
        market: cand.quote.market,
        price: cand.quote.currentPrice ?? cand.quote.preMarketPrice ?? 0,
        currency: cand.quote.currency,
        tickerChange,
        primaryBenchName,
        primaryBenchChange,
        secondaryBenchName,
        secondaryBenchChange,
        alphaPrimary,
        alphaSecondary,
        avgAlpha,
        performanceStatus,
        confluenceType,
        heatmapColor,
        score: cand.score.total,
        rvol: cand.quote.rvol ?? null,
      };
    });
  }, [candidates, daxChange, eurostoxxChange, spxChange, ndxChange]);

  // Filter by market
  const filteredData = useMemo(() => {
    let list = processedData;
    if (marketFilter === 'EU') {
      list = list.filter((item) => item.market === 'EU');
    } else if (marketFilter === 'US') {
      list = list.filter((item) => item.market === 'US');
    }

    // Sort
    return [...list].sort((a, b) => {
      if (sortOrder === 'ALPHA_DESC') {
        return b.alphaPrimary - a.alphaPrimary;
      }
      if (sortOrder === 'ALPHA_ASC') {
        return a.alphaPrimary - b.alphaPrimary;
      }
      // Divergence (absolute difference vs benchmark)
      return Math.abs(b.alphaPrimary) - Math.abs(a.alphaPrimary);
    });
  }, [processedData, marketFilter, sortOrder]);

  // Key Aggregated Counts
  const outperformingCount = filteredData.filter((d) => d.alphaPrimary > 0.5).length;
  const underperformingCount = filteredData.filter((d) => d.alphaPrimary < -0.5).length;
  const inLineCount = filteredData.filter((d) => Math.abs(d.alphaPrimary) <= 0.5).length;
  const decoupledCount = filteredData.filter(
    (d) => d.confluenceType === 'DIVERGENCE_BULLISH' || d.confluenceType === 'DIVERGENCE_BEARISH'
  ).length;

  // Custom Tooltip for Heatmap Recharts
  const CustomHeatmapTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-slate-950/95 border border-slate-700 p-3.5 rounded-xl shadow-2xl text-xs space-y-2 z-50 max-w-xs font-mono">
          <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
            <span className="font-bold text-white text-sm">
              {data.ticker} • {data.name}
            </span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300">
              {data.market}
            </span>
          </div>

          <div className="space-y-1 text-[11px]">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Rendimento Titolo:</span>
              <span
                className={`font-bold ${
                  data.tickerChange > 0
                    ? 'text-emerald-400'
                    : data.tickerChange < 0
                    ? 'text-rose-400'
                    : 'text-slate-300'
                }`}
              >
                {data.tickerChange > 0 ? `+${data.tickerChange}%` : `${data.tickerChange}%`}
              </span>
            </div>

            <div className="flex justify-between items-center text-slate-400">
              <span>{data.primaryBenchName}:</span>
              <span className={data.primaryBenchChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {data.primaryBenchChange >= 0 ? `+${data.primaryBenchChange}%` : `${data.primaryBenchChange}%`}
              </span>
            </div>

            <div className="flex justify-between items-center text-slate-400">
              <span>{data.secondaryBenchName}:</span>
              <span className={data.secondaryBenchChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {data.secondaryBenchChange >= 0 ? `+${data.secondaryBenchChange}%` : `${data.secondaryBenchChange}%`}
              </span>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-800 flex flex-col gap-1.5">
            <div className="flex justify-between items-center">
              <span className="text-slate-300 font-semibold">Alpha Relativo:</span>
              <span
                className={`font-bold text-sm ${
                  data.alphaPrimary > 0
                    ? 'text-emerald-400'
                    : data.alphaPrimary < 0
                    ? 'text-rose-400'
                    : 'text-slate-300'
                }`}
              >
                {data.alphaPrimary > 0 ? `+${data.alphaPrimary}%` : `${data.alphaPrimary}%`}
              </span>
            </div>

            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="text-slate-400">Regime:</span>
              <span
                className={`px-1.5 py-0.5 rounded font-bold ${
                  data.confluenceType === 'CONFLUENCE_LONG'
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                    : data.confluenceType === 'DIVERGENCE_BULLISH'
                    ? 'bg-cyan-950 text-cyan-300 border border-cyan-800'
                    : data.confluenceType === 'CONFLUENCE_SHORT'
                    ? 'bg-rose-950 text-rose-300 border border-rose-800'
                    : data.confluenceType === 'DIVERGENCE_BEARISH'
                    ? 'bg-amber-950 text-amber-300 border border-amber-800'
                    : 'bg-slate-800 text-slate-300'
                }`}
              >
                {data.confluenceType === 'CONFLUENCE_LONG'
                  ? 'Confluenza Long (+Titolo / +Indice)'
                  : data.confluenceType === 'DIVERGENCE_BULLISH'
                  ? 'Forza Decoupled (+Titolo / -Indice)'
                  : data.confluenceType === 'CONFLUENCE_SHORT'
                  ? 'Confluenza Short (-Titolo / -Indice)'
                  : data.confluenceType === 'DIVERGENCE_BEARISH'
                  ? 'Debolezza Decoupled (-Titolo / +Indice)'
                  : 'Neutro'}
              </span>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  if (candidates.length === 0) {
    return null;
  }

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl p-4 sm:p-6 mb-8 font-mono">
      {/* 1. Header Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
            <Compass className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm sm:text-base font-bold text-white uppercase tracking-wider">
                Analisi Correlazione & Forza Relativa (Heatmap)
              </h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-950 text-cyan-300 border border-cyan-800">
                Alpha vs Benchmark
              </span>
            </div>
            <p className="text-xs text-slate-400 font-sans mt-0.5">
              Identifica se i titoli stanno sovraperformando o sottoperformando gli indici guida (DAX / EuroStoxx e S&P 500 / Nasdaq)
            </p>
          </div>
        </div>

        {/* Filters & Sorters */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Market Filter */}
          <div className="flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs">
            <button
              onClick={() => setMarketFilter('ALL')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                marketFilter === 'ALL'
                  ? 'bg-cyan-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tutti ({processedData.length})
            </button>
            <button
              onClick={() => setMarketFilter('EU')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                marketFilter === 'EU'
                  ? 'bg-cyan-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              🇪🇺 Europa
            </button>
            <button
              onClick={() => setMarketFilter('US')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                marketFilter === 'US'
                  ? 'bg-cyan-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              🇺🇸 USA
            </button>
          </div>

          {/* Sort Order */}
          <div className="flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs">
            <button
              onClick={() => setSortOrder('ALPHA_DESC')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                sortOrder === 'ALPHA_DESC'
                  ? 'bg-slate-800 text-slate-100 font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="I titoli più forti in sovraperformance (Alpha positivo decrescente)"
            >
              Leader (Alpha +)
            </button>
            <button
              onClick={() => setSortOrder('ALPHA_ASC')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                sortOrder === 'ALPHA_ASC'
                  ? 'bg-slate-800 text-slate-100 font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="I titoli più deboli in sottoperformance (Alpha negativo crescente)"
            >
              Laggard (Alpha -)
            </button>
            <button
              onClick={() => setSortOrder('DIVERGENCE')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                sortOrder === 'DIVERGENCE'
                  ? 'bg-slate-800 text-slate-100 font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Massima divergenza e distacco dal mercato di riferimento"
            >
              Divergenza
            </button>
          </div>
        </div>
      </div>

      {/* 2. Benchmark Reference Barometer (4 Key Indices) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 my-4">
        {/* DAX */}
        <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-[10px] text-slate-400 block">🇪🇺 FDAX (DAX 40 Future)</span>
            <span className="text-sm font-bold text-white mt-0.5 block">
              {futures?.europe?.dax?.price ? `${futures.europe.dax.price.toLocaleString('it-IT')} pt` : 'In linea'}
            </span>
          </div>
          <span
            className={`text-xs font-bold px-2 py-1 rounded ${
              daxChange >= 0 ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-rose-950 text-rose-400 border border-rose-800'
            }`}
          >
            {daxChange >= 0 ? `+${daxChange}%` : `${daxChange}%`}
          </span>
        </div>

        {/* EuroStoxx 50 */}
        <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-[10px] text-slate-400 block">🇪🇺 FESX (Euro Stoxx 50)</span>
            <span className="text-sm font-bold text-white mt-0.5 block">
              {futures?.europe?.eurostoxx?.price ? `${futures.europe.eurostoxx.price.toLocaleString('it-IT')} pt` : 'In linea'}
            </span>
          </div>
          <span
            className={`text-xs font-bold px-2 py-1 rounded ${
              eurostoxxChange >= 0 ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-rose-950 text-rose-400 border border-rose-800'
            }`}
          >
            {eurostoxxChange >= 0 ? `+${eurostoxxChange}%` : `${eurostoxxChange}%`}
          </span>
        </div>

        {/* S&P 500 */}
        <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-[10px] text-slate-400 block">🇺🇸 ES (S&P 500 Future)</span>
            <span className="text-sm font-bold text-white mt-0.5 block">
              {futures?.usa?.sp500?.price ? `${futures.usa.sp500.price.toLocaleString('it-IT')} pt` : 'In linea'}
            </span>
          </div>
          <span
            className={`text-xs font-bold px-2 py-1 rounded ${
              spxChange >= 0 ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-rose-950 text-rose-400 border border-rose-800'
            }`}
          >
            {spxChange >= 0 ? `+${spxChange}%` : `${spxChange}%`}
          </span>
        </div>

        {/* Nasdaq 100 */}
        <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-[10px] text-slate-400 block">🇺🇸 NQ (Nasdaq 100 Future)</span>
            <span className="text-sm font-bold text-white mt-0.5 block">
              {futures?.usa?.nasdaq?.price ? `${futures.usa.nasdaq.price.toLocaleString('it-IT')} pt` : 'In linea'}
            </span>
          </div>
          <span
            className={`text-xs font-bold px-2 py-1 rounded ${
              ndxChange >= 0 ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-rose-950 text-rose-400 border border-rose-800'
            }`}
          >
            {ndxChange >= 0 ? `+${ndxChange}%` : `${ndxChange}%`}
          </span>
        </div>
      </div>

      {/* 3. Heatmap Stats Summary Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-slate-950/80 border border-slate-800 text-xs mb-5">
        <div className="flex items-center gap-4">
          <span className="text-slate-400">Ripartizione del Paniere:</span>
          <span className="text-emerald-400 font-semibold flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            {outperformingCount} Sovraperformano (Leader)
          </span>
          <span className="text-slate-400 flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-slate-500" />
            {inLineCount} In Linea
          </span>
          <span className="text-rose-400 font-semibold flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-rose-400" />
            {underperformingCount} Sottoperformano (Laggard)
          </span>
        </div>

        <div className="text-[11px] text-cyan-300 font-medium">
          {decoupledCount} titoli con divergenza antitetica (flusso autonomo)
        </div>
      </div>

      {/* 4. Interactive Recharts Relative Strength Heatmap Bar Chart */}
      <div className="bg-slate-950/90 border border-slate-800/80 rounded-xl p-4 sm:p-5 mb-5 shadow-inner">
        <div className="flex items-center justify-between mb-3 text-xs">
          <div className="flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-cyan-400" />
            <span className="text-white font-bold uppercase tracking-wider">
              Grafico Alpha Relativo: Distacco % dal Benchmark (Spread)
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-400">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-cyan-500" /> Alpha &gt; +3%
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Alpha &gt; +1.5%
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-slate-600" /> In linea (±0.5%)
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-rose-500" /> Alpha &lt; -1.5%
            </span>
          </div>
        </div>

        <div className="w-full h-80 pt-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={filteredData.slice(0, 18)}
              layout="vertical"
              margin={{ top: 5, right: 30, left: 15, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
              <XAxis
                type="number"
                stroke="#64748b"
                tick={{ fontSize: 10 }}
                tickLine={false}
                tickFormatter={(v) => `${v > 0 ? `+${v}` : v}%`}
              />
              <YAxis
                type="category"
                dataKey="ticker"
                stroke="#94a3b8"
                tick={{ fontSize: 11, fontWeight: 'bold' }}
                tickLine={false}
                width={70}
              />
              <ReferenceLine x={0} stroke="#475569" strokeWidth={1.5} />
              <Tooltip content={<CustomHeatmapTooltip />} />
              <Bar dataKey="alphaPrimary" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                {filteredData.slice(0, 18).map((entry, index) => (
                  <Cell
                    key={`cell-${entry.ticker}-${index}`}
                    fill={entry.heatmapColor}
                    className="cursor-pointer hover:opacity-85 transition-opacity"
                    onClick={() => {
                      if (onSelectCandidate) onSelectCandidate(entry.candidate);
                      if (onViewCatalyst) onViewCatalyst(entry.candidate);
                    }}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 5. Dense Heatmap Tile Matrix (Visual Mosaic Grid) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span className="uppercase tracking-wider font-bold text-slate-300">
            Matrice a Tasselli Heatmap ({filteredData.length} Titoli)
          </span>
          <span className="text-[11px]">Clicca su una casella per visualizzare o aprire il catalizzatore</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
          {filteredData.map((item) => {
            const isSelected = item.alphaPrimary >= 1.5;
            return (
              <div
                key={`matrix-${item.ticker}`}
                onClick={() => {
                  if (onSelectCandidate) onSelectCandidate(item.candidate);
                  if (onViewCatalyst) onViewCatalyst(item.candidate);
                }}
                className={`p-2.5 rounded-xl border transition-all cursor-pointer relative overflow-hidden group hover:scale-[1.02] ${
                  item.alphaPrimary >= 1.5
                    ? 'bg-emerald-950/50 border-emerald-500/40 hover:border-emerald-400'
                    : item.alphaPrimary >= 0.5
                    ? 'bg-emerald-950/20 border-emerald-800/40 hover:border-emerald-500'
                    : item.alphaPrimary <= -1.5
                    ? 'bg-rose-950/50 border-rose-500/40 hover:border-rose-400'
                    : item.alphaPrimary <= -0.5
                    ? 'bg-rose-950/20 border-rose-800/40 hover:border-rose-500'
                    : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                }`}
              >
                {/* Micro Color indicator bar */}
                <div
                  className="absolute top-0 left-0 right-0 h-1"
                  style={{ backgroundColor: item.heatmapColor }}
                />

                <div className="flex items-center justify-between pt-1">
                  <span className="font-bold text-white text-xs tracking-wider group-hover:text-cyan-300 transition-colors">
                    {item.ticker}
                  </span>
                  <span
                    className={`text-[10px] font-bold ${
                      item.alphaPrimary > 0
                        ? 'text-emerald-400'
                        : item.alphaPrimary < 0
                        ? 'text-rose-400'
                        : 'text-slate-400'
                    }`}
                  >
                    {item.alphaPrimary > 0 ? `+${item.alphaPrimary}%` : `${item.alphaPrimary}%`}
                  </span>
                </div>

                <div className="text-[10px] text-slate-400 truncate mt-0.5">
                  {item.name}
                </div>

                <div className="flex items-center justify-between text-[10px] mt-2 pt-1 border-t border-slate-800/80">
                  <span className="text-slate-400">Titolo:</span>
                  <span
                    className={`font-semibold ${
                      item.tickerChange > 0
                        ? 'text-emerald-400'
                        : item.tickerChange < 0
                        ? 'text-rose-400'
                        : 'text-slate-300'
                    }`}
                  >
                    {item.tickerChange > 0 ? `+${item.tickerChange}%` : `${item.tickerChange}%`}
                  </span>
                </div>

                <div className="flex items-center justify-between text-[10px] text-slate-400 mt-0.5">
                  <span className="truncate max-w-[65px]">{item.primaryBenchName.split(' ')[0]}:</span>
                  <span className={item.primaryBenchChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {item.primaryBenchChange >= 0 ? `+${item.primaryBenchChange}%` : `${item.primaryBenchChange}%`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
