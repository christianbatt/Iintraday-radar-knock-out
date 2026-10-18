import React, { useState } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Cell,
} from 'recharts';
import { TradeJournalEntry } from '../types/radar';
import {
  TrendingUp,
  TrendingDown,
  Activity,
  Award,
  AlertCircle,
  BarChart2,
  PieChart,
  Zap,
  Target,
  Sparkles,
} from 'lucide-react';

interface PerformanceSummaryProps {
  entries: TradeJournalEntry[];
  accountCapital: number;
  onLoadSampleTrades?: () => void;
}

export const PerformanceSummary: React.FC<PerformanceSummaryProps> = ({
  entries,
  accountCapital,
  onLoadSampleTrades,
}) => {
  // If no trades, display empty state with prompt
  if (entries.length === 0) {
    return (
      <div className="p-8 text-center bg-slate-950/40 rounded-xl border border-slate-800/80 my-4">
        <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
          <BarChart2 className="w-6 h-6" />
        </div>
        <h3 className="text-sm font-bold text-white mb-1">
          Nessuna esecuzione registrata per il calcolo delle statistiche
        </h3>
        <p className="text-xs text-slate-400 max-w-md mx-auto mb-4">
          Aggiungi un'operazione manualmente tramite il pulsante <strong>"Aggiungi Trade"</strong> oppure salva un'esecuzione consigliata dal pannello operativo per generare i grafici di P&L cumulato e la distribuzione R.
        </p>
        {onLoadSampleTrades && (
          <button
            onClick={onLoadSampleTrades}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-900/30 transition-all cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Carica 8 Trade Storici Dimostrativi
          </button>
        )}
      </div>
    );
  }

  const [chartType, setChartType] = useState<'EQUITY_LINE' | 'PNL_AREA'>('EQUITY_LINE');

  // Chronological order for cumulative PnL progression
  const sortedEntries = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  let runningCumPnl = 0;
  const pnlTrendData = [
    {
      index: 0,
      label: 'Avvio',
      tradeNum: 0,
      ticker: 'INIZIO',
      direction: '',
      pnl: 0,
      cumPnl: 0,
      equity: accountCapital,
      cumPnlPercent: 0,
      rMultiple: 0,
      outcome: 'START',
      date: 'Baseline',
    },
    ...sortedEntries.map((trade, i) => {
      runningCumPnl += trade.pnlEur;
      const cumPnl = +runningCumPnl.toFixed(2);
      const equity = +(accountCapital + cumPnl).toFixed(2);
      const cumPnlPercent =
        accountCapital > 0 ? +((cumPnl / accountCapital) * 100).toFixed(2) : 0;
      return {
        index: i + 1,
        label: `#${i + 1} ${trade.ticker}`,
        tradeNum: i + 1,
        ticker: trade.ticker,
        direction: trade.direction,
        strategy: trade.strategy,
        pnl: trade.pnlEur,
        cumPnl,
        equity,
        cumPnlPercent,
        rMultiple: trade.rMultiple,
        outcome: trade.outcome,
        date: trade.date,
        time: new Date(trade.timestamp).toLocaleTimeString('it-IT', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }),
  ];

  // R-Multiple Distribution Bins
  const rBinsConfig = [
    { bin: '< -1.5R', label: 'Perdita Grave (< -1.5R)', min: -Infinity, max: -1.5, color: '#e11d48', type: 'loss' },
    { bin: '-1.5R a -0.5R', label: 'Stop Loss 1R Standard', min: -1.5, max: -0.5, color: '#f43f5e', type: 'loss' },
    { bin: '-0.5R a +0.5R', label: 'Breakeven / Scratch (0R)', min: -0.5, max: 0.5, color: '#64748b', type: 'be' },
    { bin: '+0.5R a +1.5R', label: 'Profitto Parziale (+1R)', min: 0.5, max: 1.5, color: '#38bdf8', type: 'win' },
    { bin: '+1.5R a +2.5R', label: 'Target 1 Pieno (~2R)', min: 1.5, max: 2.5, color: '#10b981', type: 'win' },
    { bin: '> +2.5R', label: 'Runner / Target 2 (> 2.5R)', min: 2.5, max: Infinity, color: '#059669', type: 'win' },
  ];

  const rDistributionData = rBinsConfig.map((binDef) => {
    const matchingTrades = entries.filter(
      (t) => t.rMultiple >= binDef.min && t.rMultiple < binDef.max
    );
    const count = matchingTrades.length;
    const percentage =
      entries.length > 0 ? +((count / entries.length) * 100).toFixed(1) : 0;
    return {
      bin: binDef.bin,
      label: binDef.label,
      count,
      percentage,
      color: binDef.color,
      type: binDef.type,
      tickers: matchingTrades
        .map((t) => `${t.ticker} (${t.rMultiple > 0 ? `+${t.rMultiple}` : t.rMultiple}R)`)
        .slice(0, 5)
        .join(', '),
    };
  });

  // Calculate detailed performance metrics
  const totalTrades = entries.length;
  const wins = entries.filter((e) => e.outcome === 'WIN');
  const losses = entries.filter((e) => e.outcome === 'LOSS');
  const breakevens = entries.filter((e) => e.outcome === 'BREAKEVEN');
  const expired = entries.filter((e) => e.outcome === 'EXPIRED');

  const winRate = totalTrades > 0 ? +((wins.length / totalTrades) * 100).toFixed(1) : 0;
  const lossRate = totalTrades > 0 ? +((losses.length / totalTrades) * 100).toFixed(1) : 0;
  const expiredRate = totalTrades > 0 ? +((expired.length / totalTrades) * 100).toFixed(1) : 0;

  const totalGainsEur = wins.reduce((acc, curr) => acc + curr.pnlEur, 0);
  const totalLossesEur = Math.abs(losses.reduce((acc, curr) => acc + curr.pnlEur, 0));
  const netPnlEur = +(totalGainsEur - totalLossesEur).toFixed(2);
  const netPnlPercent = accountCapital > 0 ? +((netPnlEur / accountCapital) * 100).toFixed(2) : 0;

  const avgWinEur = wins.length > 0 ? +(totalGainsEur / wins.length).toFixed(2) : 0;
  const avgLossEur = losses.length > 0 ? +(totalLossesEur / losses.length).toFixed(2) : 0;

  const avgWinR =
    wins.length > 0
      ? +(wins.reduce((acc, c) => acc + c.rMultiple, 0) / wins.length).toFixed(2)
      : 0;
  const avgLossR =
    losses.length > 0
      ? +(Math.abs(losses.reduce((acc, c) => acc + c.rMultiple, 0)) / losses.length).toFixed(2)
      : 0;

  // Expectancy (EV) in R per trade = (Win% * AvgWinR) - (Loss% * AvgLossR)
  const expectancyR =
    totalTrades > 0
      ? +( (winRate / 100) * avgWinR - (lossRate / 100) * avgLossR ).toFixed(2)
      : 0;

  // Best & Worst Trade
  const bestTrade = entries.reduce(
    (max, t) => (t.pnlEur > (max?.pnlEur ?? -Infinity) ? t : max),
    null as TradeJournalEntry | null
  );
  const worstTrade = entries.reduce(
    (min, t) => (t.pnlEur < (min?.pnlEur ?? Infinity) ? t : min),
    null as TradeJournalEntry | null
  );

  // Gradient offset calculation for positive/negative PnL area coloring
  const cumPnlValues = pnlTrendData.map((d) => d.cumPnl);
  const maxCumPnl = Math.max(...cumPnlValues);
  const minCumPnl = Math.min(...cumPnlValues);

  let gradientOffset = 0.5;
  if (maxCumPnl <= 0) {
    gradientOffset = 0;
  } else if (minCumPnl >= 0) {
    gradientOffset = 1;
  } else {
    gradientOffset = maxCumPnl / (maxCumPnl - minCumPnl);
  }

  // Custom Tooltip for Cumulative PnL Trend
  const CustomPnlTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      if (data.outcome === 'START') {
        return (
          <div className="bg-slate-900 border border-slate-700 p-2.5 rounded-lg shadow-xl text-xs font-mono">
            <span className="text-slate-400 font-bold">Punto di Partenza</span>
            <div className="text-white mt-1">P&L Cumulato: 0.00 €</div>
          </div>
        );
      }
      return (
        <div className="bg-slate-900 border border-slate-700 p-3 rounded-lg shadow-2xl text-xs space-y-1.5 z-50 max-w-xs">
          <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-1.5 font-mono">
            <span className="font-bold text-white">
              Trade #{data.tradeNum} • {data.ticker}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                data.outcome === 'WIN'
                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                  : data.outcome === 'LOSS'
                  ? 'bg-rose-950 text-rose-400 border border-rose-800'
                  : data.outcome === 'EXPIRED'
                  ? 'bg-amber-950 text-amber-300 border border-amber-700'
                  : 'bg-slate-800 text-slate-300'
              }`}
            >
              {data.outcome}
            </span>
          </div>
          <div className="text-[11px] text-slate-400 font-mono">
            {data.date} {data.time && `• ${data.time}`} {data.direction && `• ${data.direction}`}
          </div>
          <div className="flex justify-between items-center text-xs font-mono pt-1">
            <span className="text-slate-400">P&L Singolo:</span>
            <span
              className={`font-bold ${
                data.pnl > 0 ? 'text-emerald-400' : data.pnl < 0 ? 'text-rose-400' : 'text-slate-300'
              }`}
            >
              {data.pnl > 0 ? `+${data.pnl.toFixed(2)}` : data.pnl.toFixed(2)} € ({data.rMultiple > 0 ? `+${data.rMultiple}` : data.rMultiple}R)
            </span>
          </div>
          <div className="flex justify-between items-center text-xs font-mono border-t border-slate-800 pt-1">
            <span className="text-slate-300 font-semibold">P&L Cumulato:</span>
            <span
              className={`font-bold ${
                data.cumPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {data.cumPnl >= 0 ? `+${data.cumPnl.toFixed(2)}` : data.cumPnl.toFixed(2)} € ({data.cumPnlPercent >= 0 ? `+${data.cumPnlPercent}` : data.cumPnlPercent}%)
            </span>
          </div>
          {data.equity !== undefined && (
            <div className="flex justify-between items-center text-xs font-mono">
              <span className="text-slate-400">Equity Conto:</span>
              <span className="font-bold text-white">
                {data.equity.toLocaleString('it-IT')} €
              </span>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  // Custom Tooltip for R-Multiple Distribution
  const CustomRTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-slate-900 border border-slate-700 p-3 rounded-lg shadow-2xl text-xs space-y-1.5 z-50 max-w-xs">
          <div className="font-bold text-white border-b border-slate-800 pb-1">
            {data.label}
          </div>
          <div className="flex justify-between text-slate-300 font-mono text-xs">
            <span>Frequenza Esecuzioni:</span>
            <span className="font-bold text-white">{data.count} ({data.percentage}%)</span>
          </div>
          {data.tickers && (
            <div className="text-[11px] text-slate-400 font-mono border-t border-slate-800 pt-1">
              <span className="text-slate-500 block text-[10px] uppercase">Esempi Titoli:</span>
              <span>{data.tickers}</span>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="p-5 space-y-6 bg-slate-950/70 border-b border-slate-800 animate-in fade-in duration-200">
      {/* Top Statistical Summary Banner */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 text-xs font-mono">
        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 min-w-0 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1 truncate">
            Aspettativa (EV)
          </span>
          <div
            className={`text-base font-bold flex items-center gap-1 ${
              expectancyR >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            <Target className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{expectancyR >= 0 ? `+${expectancyR.toFixed(2)}R` : `${expectancyR.toFixed(2)}R`}</span>
          </div>
          <span className="text-[10px] text-slate-500 truncate block mt-1">per ogni trade preso</span>
        </div>

        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 min-w-0 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1 truncate">
            Media Vincita (Win)
          </span>
          <div className="text-base font-bold text-emerald-400 truncate">
            +{avgWinEur.toFixed(2)} €
          </div>
          <span className="text-[10px] text-emerald-400/80 truncate block mt-1">+{avgWinR.toFixed(2)}R medio</span>
        </div>

        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 min-w-0 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1 truncate">
            Media Perdita (Loss)
          </span>
          <div className="text-base font-bold text-rose-400 truncate">
            -{avgLossEur.toFixed(2)} €
          </div>
          <span className="text-[10px] text-rose-400/80 truncate block mt-1">-{avgLossR.toFixed(2)}R medio</span>
        </div>

        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 min-w-0 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1 truncate">
            Win/Loss & Scaduti
          </span>
          <div className="text-base font-bold text-sky-400 truncate">
            {losses.length > 0 ? (wins.length / losses.length).toFixed(2) : wins.length > 0 ? '∞' : '0.00'}
          </div>
          <span className="text-[10px] text-slate-400 truncate block mt-1">
            {wins.length}W · {losses.length}L · <strong className={expired.length > 0 ? 'text-amber-400' : 'text-slate-400'}>{expired.length} Exp ({expiredRate}%)</strong>
          </span>
        </div>

        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 min-w-0 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1 truncate">
            Miglior Trade
          </span>
          <div className="text-base font-bold text-emerald-400 truncate">
            {bestTrade ? `+${bestTrade.pnlEur.toFixed(0)}€` : '—'}
          </div>
          <span className="text-[10px] text-slate-400 truncate block mt-1">
            {bestTrade ? `${bestTrade.ticker} (+${bestTrade.rMultiple}R)` : 'Nessuno'}
          </span>
        </div>

        <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 min-w-0 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1 truncate">
            Peggior Trade
          </span>
          <div className="text-base font-bold text-rose-400 truncate">
            {worstTrade ? `${worstTrade.pnlEur.toFixed(0)}€` : '—'}
          </div>
          <span className="text-[10px] text-slate-400 truncate block mt-1">
            {worstTrade ? `${worstTrade.ticker} (${worstTrade.rMultiple}R)` : 'Nessuno'}
          </span>
        </div>
      </div>

      {/* Two Interactive Recharts Visualizations Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Chart 1: Cumulative PnL Trend */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-xl flex flex-col">
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                <TrendingUp className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                  Trend P&L Cumulato (€ & %)
                </h4>
                <p className="text-[10px] text-slate-400">
                  Progressione temporale del capitale netto sulle {sortedEntries.length} esecuzioni
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex rounded-md bg-slate-950 p-0.5 border border-slate-800 text-[10px]">
                <button
                  onClick={() => setChartType('EQUITY_LINE')}
                  className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                    chartType === 'EQUITY_LINE'
                      ? 'bg-emerald-600 text-white font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Mostra Curva di Equità (Line Chart)"
                >
                  Curva Equità
                </button>
                <button
                  onClick={() => setChartType('PNL_AREA')}
                  className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                    chartType === 'PNL_AREA'
                      ? 'bg-indigo-600 text-white font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Mostra P&L Cumulato (Area Chart)"
                >
                  P&L Cumulato
                </button>
              </div>

              <div className="text-right font-mono">
                <span
                  className={`text-sm font-bold block ${
                    netPnlEur >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {chartType === 'EQUITY_LINE'
                    ? `${(accountCapital + netPnlEur).toLocaleString('it-IT')} €`
                    : `${netPnlEur >= 0 ? `+${netPnlEur.toFixed(2)}` : netPnlEur.toFixed(2)} €`}
                </span>
                <span className="text-[10px] text-slate-400">
                  {netPnlPercent >= 0 ? `+${netPnlPercent.toFixed(2)}%` : `${netPnlPercent.toFixed(2)}%`}
                </span>
              </div>
            </div>
          </div>

          <div className="w-full h-64 pt-2">
            {chartType === 'EQUITY_LINE' ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={pnlTrendData} margin={{ top: 10, right: 15, left: -5, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke="#64748b"
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    stroke="#64748b"
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    domain={['auto', 'auto']}
                    tickFormatter={(val) => `${val}€`}
                  />
                  <ReferenceLine
                    y={accountCapital}
                    stroke="#475569"
                    strokeDasharray="4 4"
                    label={{
                      value: `Base ${accountCapital}€`,
                      fill: '#64748b',
                      fontSize: 10,
                      position: 'insideBottomRight',
                    }}
                  />
                  <Tooltip content={<CustomPnlTooltip />} />
                  <Line
                    type="monotone"
                    dataKey="equity"
                    stroke={netPnlEur >= 0 ? '#10b981' : '#f43f5e'}
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: '#0f172a', stroke: '#10b981', strokeWidth: 1.5 }}
                    activeDot={{ r: 5, fill: '#10b981', stroke: '#ffffff', strokeWidth: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={pnlTrendData} margin={{ top: 10, right: 15, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="pnlSplitGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset={gradientOffset} stopColor="#10b981" stopOpacity={0.35} />
                      <stop offset={gradientOffset} stopColor="#f43f5e" stopOpacity={0.35} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke="#64748b"
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    stroke="#64748b"
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    tickFormatter={(val) => `${val}€`}
                  />
                  <ReferenceLine y={0} stroke="#475569" strokeDasharray="4 4" strokeWidth={1} />
                  <Tooltip content={<CustomPnlTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="cumPnl"
                    stroke={netPnlEur >= 0 ? '#10b981' : '#f43f5e'}
                    strokeWidth={2.5}
                    fill="url(#pnlSplitGradient)"
                    dot={{ r: 3, fill: '#0f172a', stroke: '#10b981', strokeWidth: 1.5 }}
                    activeDot={{ r: 5, fill: '#10b981', stroke: '#ffffff', strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400 font-mono">
            <span>Capitale iniziale: {accountCapital.toLocaleString('it-IT')} €</span>
            <span className="text-emerald-400 font-semibold">
              Picco massimo: +{maxCumPnl.toFixed(2)} €
            </span>
          </div>
        </div>

        {/* Chart 2: R-Multiple Distribution Histogram */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-xl flex flex-col">
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
                <BarChart2 className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                  Distribuzione R-Multiple Effettivo
                </h4>
                <p className="text-[10px] text-slate-400">
                  Frequenza esecuzioni per scaglione di rischio/rendimento (R)
                </p>
              </div>
            </div>
            <div className="text-right font-mono">
              <span className="text-xs font-bold text-sky-400 block">
                Target ≥ 1.6R
              </span>
              <span className="text-[10px] text-slate-400">
                EV: {expectancyR >= 0 ? `+${expectancyR}R` : `${expectancyR}R`}
              </span>
            </div>
          </div>

          <div className="w-full h-64 pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rDistributionData} margin={{ top: 10, right: 15, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis
                  dataKey="bin"
                  stroke="#64748b"
                  tick={{ fontSize: 9 }}
                  tickLine={false}
                />
                <YAxis
                  stroke="#64748b"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<CustomRTooltip />} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {rDistributionData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400 font-mono">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-rose-500" />
              <span>Loss (≤ -1R)</span>
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-500 ml-1" />
              <span>BE (0R)</span>
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500 ml-1" />
              <span>Win (≥ +1R)</span>
            </div>
            <span className="text-slate-300 font-semibold">
              {wins.filter((w) => w.rMultiple >= 1.6).length} / {totalTrades} con R ≥ 1.6R
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
