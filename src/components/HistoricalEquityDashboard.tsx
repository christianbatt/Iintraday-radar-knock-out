import React, { useState, useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  AreaChart,
  Area,
} from 'recharts';
import { TradeJournalEntry } from '../types/radar';
import {
  TrendingUp,
  TrendingDown,
  ShieldAlert,
  Award,
  Activity,
  Layers,
  Sparkles,
  ArrowUpRight,
  ArrowDownRight,
  Maximize2,
  Calendar,
  Filter,
} from 'lucide-react';

interface HistoricalEquityDashboardProps {
  entries: TradeJournalEntry[];
  accountCapital: number;
}

type CurveMetricMode = 'EQUITY' | 'CUM_PNL' | 'R_CURVE';
type TimeRangeFilter = 'ALL' | 'CYCLE_20' | 'LAST_40';

export const HistoricalEquityDashboard: React.FC<HistoricalEquityDashboardProps> = ({
  entries,
  accountCapital,
}) => {
  const [metricMode, setMetricMode] = useState<CurveMetricMode>('EQUITY');
  const [rangeFilter, setRangeFilter] = useState<TimeRangeFilter>('ALL');
  const [showHighWaterMark, setShowHighWaterMark] = useState<boolean>(true);
  const [showUnderwaterDd, setShowUnderwaterDd] = useState<boolean>(true);

  // Filter and sort entries chronologically
  const sortedEntries = useMemo(() => {
    return [...entries].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }, [entries]);

  const activeEntries = useMemo(() => {
    if (rangeFilter === 'CYCLE_20') {
      return sortedEntries.slice(-20);
    }
    if (rangeFilter === 'LAST_40') {
      return sortedEntries.slice(-40);
    }
    return sortedEntries;
  }, [sortedEntries, rangeFilter]);

  // Compute equity curve points and quantitative metrics
  const {
    curveData,
    currentEquity,
    netProfitEur,
    netProfitPercent,
    maxDrawdownEur,
    maxDrawdownPercent,
    highWaterMarkValue,
    recoveryFactor,
    maxWinStreak,
    maxLossStreak,
    profitFactor,
    winRate,
    avgRMultiple,
  } = useMemo(() => {
    const baseCapital = accountCapital > 0 ? accountCapital : 10000;
    let runningPnl = 0;
    let runningR = 0;
    let runningEquity = baseCapital;
    let peakEquity = baseCapital;
    let peakPnl = 0;
    let maxDdEur = 0;
    let maxDdPct = 0;

    let curWinStreak = 0;
    let maxWStreak = 0;
    let curLossStreak = 0;
    let maxLStreak = 0;

    let winsCount = 0;
    let totalWinsEur = 0;
    let totalLossesEur = 0;

    const points: any[] = [
      {
        index: 0,
        tradeId: 'start',
        tradeNum: 0,
        label: 'Inizio',
        ticker: 'CAPITALE INIZIALE',
        date: activeEntries[0]?.date || 'Baseline',
        time: '',
        direction: '',
        outcome: 'START',
        pnl: 0,
        rMultiple: 0,
        equity: baseCapital,
        cumPnl: 0,
        cumR: 0,
        highWaterMark: baseCapital,
        drawdownEur: 0,
        drawdownPercent: 0,
      },
    ];

    activeEntries.forEach((trade, i) => {
      runningPnl += trade.pnlEur;
      runningR += trade.rMultiple;
      runningEquity = baseCapital + runningPnl;

      if (runningEquity > peakEquity) {
        peakEquity = runningEquity;
      }
      if (runningPnl > peakPnl) {
        peakPnl = runningPnl;
      }

      const currentDdEur = Math.max(0, peakEquity - runningEquity);
      const currentDdPct = peakEquity > 0 ? (currentDdEur / peakEquity) * 100 : 0;

      if (currentDdEur > maxDdEur) maxDdEur = currentDdEur;
      if (currentDdPct > maxDdPct) maxDdPct = currentDdPct;

      if (trade.outcome === 'WIN') {
        winsCount++;
        totalWinsEur += trade.pnlEur;
        curWinStreak++;
        curLossStreak = 0;
        if (curWinStreak > maxWStreak) maxWStreak = curWinStreak;
      } else if (trade.outcome === 'LOSS') {
        totalLossesEur += Math.abs(trade.pnlEur);
        curLossStreak++;
        curWinStreak = 0;
        if (curLossStreak > maxLStreak) maxLStreak = curLossStreak;
      } else {
        curWinStreak = 0;
        curLossStreak = 0;
      }

      points.push({
        index: i + 1,
        tradeId: trade.id,
        tradeNum: i + 1,
        label: `#${i + 1} ${trade.ticker}`,
        ticker: trade.ticker,
        date: trade.date,
        time: new Date(trade.timestamp).toLocaleTimeString('it-IT', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        direction: trade.direction,
        strategy: trade.strategy,
        outcome: trade.outcome,
        pnl: trade.pnlEur,
        rMultiple: trade.rMultiple,
        equity: +runningEquity.toFixed(2),
        cumPnl: +runningPnl.toFixed(2),
        cumR: +runningR.toFixed(2),
        highWaterMark: +peakEquity.toFixed(2),
        drawdownEur: -+currentDdEur.toFixed(2),
        drawdownPercent: -+currentDdPct.toFixed(2),
      });
    });

    const netProf = runningPnl;
    const netProfPct = baseCapital > 0 ? (netProf / baseCapital) * 100 : 0;
    const recFactor = maxDdEur > 0 ? +(netProf / maxDdEur).toFixed(2) : netProf > 0 ? 99.0 : 0;
    const pFactor =
      totalLossesEur > 0
        ? +(totalWinsEur / totalLossesEur).toFixed(2)
        : totalWinsEur > 0
        ? 99.0
        : 0;
    const wRate = activeEntries.length > 0 ? +((winsCount / activeEntries.length) * 100).toFixed(1) : 0;
    const avgR =
      activeEntries.length > 0
        ? +(activeEntries.reduce((acc, t) => acc + t.rMultiple, 0) / activeEntries.length).toFixed(2)
        : 0;

    return {
      curveData: points,
      currentEquity: +runningEquity.toFixed(2),
      netProfitEur: +netProf.toFixed(2),
      netProfitPercent: +netProfPct.toFixed(2),
      maxDrawdownEur: +maxDdEur.toFixed(2),
      maxDrawdownPercent: +maxDdPct.toFixed(2),
      highWaterMarkValue: +peakEquity.toFixed(2),
      recoveryFactor: recFactor,
      maxWinStreak: maxWStreak,
      maxLossStreak: maxLStreak,
      profitFactor: pFactor,
      winRate: wRate,
      avgRMultiple: avgR,
    };
  }, [activeEntries, accountCapital]);

  if (entries.length === 0) {
    return (
      <div className="p-8 text-center bg-slate-900/60 rounded-xl border border-slate-800 my-4 font-mono">
        <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
          <TrendingUp className="w-6 h-6" />
        </div>
        <h3 className="text-sm font-bold text-white mb-1">
          Nessuna operazione registrata per tracciare la Curva di Equità
        </h3>
        <p className="text-xs text-slate-400 max-w-md mx-auto mb-2 font-sans">
          Registra i tuoi trade reali dal pannello operativo o inseriscili manualmente nel diario per tracciare la progressione dell'equity reale, la curva di drawdown e gli indicatori quantitativi di robustezza del conto (zero dati simulati).
        </p>
      </div>
    );
  }

  // Custom Dot renderer for trade outcomes along the Equity Curve
  const renderCustomDot = (props: any) => {
    const { cx, cy, payload } = props;
    if (!payload || payload.outcome === 'START') return null;

    let fillColor = '#64748b';
    if (payload.outcome === 'WIN') fillColor = '#10b981';
    else if (payload.outcome === 'LOSS') fillColor = '#f43f5e';
    else if (payload.outcome === 'EXPIRED') fillColor = '#f59e0b';

    return (
      <circle
        key={`dot-${payload.tradeId || payload.index}`}
        cx={cx}
        cy={cy}
        r={3.5}
        fill="#0f172a"
        stroke={fillColor}
        strokeWidth={2}
      />
    );
  };

  // Custom Tooltip for Equity Curve
  const CustomEquityTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      if (data.outcome === 'START') {
        return (
          <div className="bg-slate-900 border border-slate-700 p-3 rounded-xl shadow-2xl text-xs font-mono">
            <span className="text-slate-400 font-bold block">Punto di Partenza</span>
            <div className="text-white mt-1">Capitale Iniziale: {accountCapital.toLocaleString('it-IT')} €</div>
          </div>
        );
      }

      return (
        <div className="bg-slate-950/95 border border-slate-700 p-3.5 rounded-xl shadow-2xl text-xs space-y-2 z-50 max-w-xs font-mono">
          <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-1.5">
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

          <div className="text-[11px] text-slate-400">
            {data.date} {data.time && `• ${data.time}`} {data.direction && `• ${data.direction}`}
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px] pt-1 border-t border-slate-800/80">
            <div>
              <span className="text-slate-400 block text-[10px]">P&L Trade:</span>
              <span
                className={`font-bold ${
                  data.pnl > 0 ? 'text-emerald-400' : data.pnl < 0 ? 'text-rose-400' : 'text-slate-300'
                }`}
              >
                {data.pnl > 0 ? `+${data.pnl.toFixed(2)}` : data.pnl.toFixed(2)} €
              </span>
            </div>
            <div>
              <span className="text-slate-400 block text-[10px]">R-Multiple:</span>
              <span className="font-bold text-sky-400">
                {data.rMultiple > 0 ? `+${data.rMultiple}` : data.rMultiple}R
              </span>
            </div>
          </div>

          <div className="pt-1.5 border-t border-slate-800 flex flex-col gap-1 text-[11px]">
            <div className="flex justify-between items-center">
              <span className="text-slate-300 font-semibold">Equity Conto:</span>
              <span className="font-bold text-white text-xs">{data.equity.toLocaleString('it-IT')} €</span>
            </div>
            <div className="flex justify-between items-center text-slate-400">
              <span>P&L Cumulato:</span>
              <span className={data.cumPnl >= 0 ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                {data.cumPnl >= 0 ? `+${data.cumPnl.toFixed(2)}` : data.cumPnl.toFixed(2)} €
              </span>
            </div>
            <div className="flex justify-between items-center text-slate-400">
              <span>Drawdown da picco:</span>
              <span className="text-rose-400 font-semibold">
                {data.drawdownPercent.toFixed(2)}% ({data.drawdownEur.toFixed(2)} €)
              </span>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  // Determine active data key and formatting based on selected metric mode
  const activeDataKey = metricMode === 'EQUITY' ? 'equity' : metricMode === 'CUM_PNL' ? 'cumPnl' : 'cumR';
  const baselineValue = metricMode === 'EQUITY' ? accountCapital : 0;
  const unitLabel = metricMode === 'R_CURVE' ? 'R' : '€';

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl p-4 sm:p-6 mb-8 font-mono">
      {/* 1. Header Toolbar with Mode Switchers and Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm sm:text-base font-bold text-white uppercase tracking-wider">
                Dashboard Analisi Storica • Curva di Equità
              </h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950 text-emerald-300 border border-emerald-800">
                {activeEntries.length} Trade Analizzati
              </span>
            </div>
            <p className="text-xs text-slate-400 font-sans mt-0.5">
              Progressione temporale del capitale, tenuta dell'High-Water Mark e contenimento del drawdown
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Mode Switcher: Equity (€) / P&L (€) / R-Curve */}
          <div className="flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs">
            <button
              onClick={() => setMetricMode('EQUITY')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                metricMode === 'EQUITY'
                  ? 'bg-emerald-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Mostra capitale account totale nel tempo (Equity = Capitale + Guadagni)"
            >
              Equity (€)
            </button>
            <button
              onClick={() => setMetricMode('CUM_PNL')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                metricMode === 'CUM_PNL'
                  ? 'bg-indigo-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Mostra P&L netto progressivo cumulato"
            >
              P&L Netto (€)
            </button>
            <button
              onClick={() => setMetricMode('R_CURVE')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                metricMode === 'R_CURVE'
                  ? 'bg-sky-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Mostra Curva di R-Multipli cumulati (indipendente dalla size monetaria)"
            >
              Curva R (R-Multipli)
            </button>
          </div>

          {/* Time Range Filter */}
          <div className="flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs">
            <button
              onClick={() => setRangeFilter('ALL')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                rangeFilter === 'ALL'
                  ? 'bg-slate-800 text-slate-100 font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Tutti i trade disponibili"
            >
              Tutto
            </button>
            <button
              onClick={() => setRangeFilter('CYCLE_20')}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                rangeFilter === 'CYCLE_20'
                  ? 'bg-slate-800 text-slate-100 font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Ultimo Ciclo (ultimi 20 setup)"
            >
              Ultimi 20
            </button>
            {sortedEntries.length > 20 && (
              <button
                onClick={() => setRangeFilter('LAST_40')}
                className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                  rangeFilter === 'LAST_40'
                    ? 'bg-slate-800 text-slate-100 font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Ultimi 40 setup"
              >
                Ultimi 40
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 2. Key Robustness Metrics Strip (6 KPI Cards) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 my-5 text-xs">
        {/* Equity Attuale */}
        <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1">
            Equity Attuale
          </span>
          <div className="text-base sm:text-lg font-bold text-white truncate">
            {currentEquity.toLocaleString('it-IT')} €
          </div>
          <span
            className={`text-[10px] font-semibold mt-1 flex items-center gap-1 ${
              netProfitEur >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {netProfitEur >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {netProfitEur >= 0 ? `+${netProfitPercent}%` : `${netProfitPercent}%`}
          </span>
        </div>

        {/* PnL Netto */}
        <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1">
            P&L Netto Totale
          </span>
          <div
            className={`text-base sm:text-lg font-bold truncate ${
              netProfitEur >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {netProfitEur >= 0 ? `+${netProfitEur.toFixed(2)}` : netProfitEur.toFixed(2)} €
          </div>
          <span className="text-[10px] text-slate-400 mt-1">
            Capitale Base: {accountCapital.toLocaleString('it-IT')} €
          </span>
        </div>

        {/* Max Drawdown */}
        <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1 flex items-center justify-between">
            <span>Max Drawdown</span>
            <ShieldAlert className="w-3 h-3 text-rose-400" />
          </span>
          <div className="text-base sm:text-lg font-bold text-rose-400 truncate">
            -{maxDrawdownPercent.toFixed(1)}%
          </div>
          <span className="text-[10px] text-rose-400/80 mt-1">
            -{maxDrawdownEur.toFixed(0)} € da picco
          </span>
        </div>

        {/* High-Water Mark */}
        <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1">
            Picco Max (HWM)
          </span>
          <div className="text-base sm:text-lg font-bold text-sky-400 truncate">
            {highWaterMarkValue.toLocaleString('it-IT')} €
          </div>
          <span className="text-[10px] text-slate-400 mt-1">
            Recovery Factor: <strong className="text-white">{recoveryFactor}x</strong>
          </span>
        </div>

        {/* Profit Factor & Win Rate */}
        <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1">
            Profit Factor & Win%
          </span>
          <div className="text-base sm:text-lg font-bold text-indigo-400 truncate">
            PF {profitFactor.toFixed(2)}
          </div>
          <span className="text-[10px] text-slate-400 mt-1">
            Win Rate: <strong className="text-emerald-400">{winRate}%</strong>
          </span>
        </div>

        {/* Streaks (Strisce) */}
        <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800 flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1">
            Strisce Vincenti / Perdenti
          </span>
          <div className="text-sm sm:text-base font-bold text-white truncate flex items-center gap-2">
            <span className="text-emerald-400">+{maxWinStreak}W</span>
            <span className="text-slate-600">/</span>
            <span className="text-rose-400">-{maxLossStreak}L</span>
          </div>
          <span className="text-[10px] text-slate-400 mt-1">
            R-Medio: <strong className="text-sky-300">{avgRMultiple > 0 ? `+${avgRMultiple}` : avgRMultiple}R</strong>
          </span>
        </div>
      </div>

      {/* 3. Primary Line Chart: Historical Equity Curve */}
      <div className="bg-slate-950/90 border border-slate-800/80 rounded-xl p-4 sm:p-5 mb-4 shadow-inner">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-300 font-bold uppercase tracking-wider">
              {metricMode === 'EQUITY'
                ? 'Curva di Equità Reale nel Tempo (Account Equity)'
                : metricMode === 'CUM_PNL'
                ? 'Progressione Temporale del P&L Netto Cumulato'
                : 'Curva di Rendimento in R-Multipli Cumulati (R-Curve)'}
            </span>
          </div>

          <div className="flex items-center gap-4 text-[11px] text-slate-400 font-mono">
            {metricMode === 'EQUITY' && (
              <label className="flex items-center gap-1.5 cursor-pointer hover:text-slate-200">
                <input
                  type="checkbox"
                  checked={showHighWaterMark}
                  onChange={(e) => setShowHighWaterMark(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-900 text-sky-500 focus:ring-0"
                />
                <span className="inline-block w-2.5 h-0.5 bg-sky-400 border border-sky-400" />
                <span>High-Water Mark (Picco)</span>
              </label>
            )}
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full border border-emerald-400 bg-slate-950" />
              <span>Win</span>
              <span className="inline-block w-2 h-2 rounded-full border border-rose-400 bg-slate-950" />
              <span>Loss</span>
              <span className="inline-block w-2 h-2 rounded-full border border-amber-400 bg-slate-950" />
              <span>Expired</span>
            </div>
          </div>
        </div>

        {/* Line Chart */}
        <div className="w-full h-72 sm:h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={curveData} margin={{ top: 15, right: 20, left: 0, bottom: 5 }}>
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
                tickFormatter={(val) => `${val}${unitLabel}`}
              />
              <ReferenceLine
                y={baselineValue}
                stroke="#475569"
                strokeDasharray="4 4"
                label={{
                  value: metricMode === 'EQUITY' ? `Base: ${baselineValue}€` : '0',
                  fill: '#64748b',
                  fontSize: 10,
                  position: 'insideBottomRight',
                }}
              />
              <Tooltip content={<CustomEquityTooltip />} />

              {/* Optional High-Water Mark Ceiling Line */}
              {metricMode === 'EQUITY' && showHighWaterMark && (
                <Line
                  type="stepAfter"
                  dataKey="highWaterMark"
                  stroke="#38bdf8"
                  strokeWidth={1.5}
                  strokeDasharray="5 5"
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                  name="High-Water Mark"
                />
              )}

              {/* Main Equity Curve Line */}
              <Line
                type="monotone"
                dataKey={activeDataKey}
                stroke={netProfitEur >= 0 ? '#10b981' : '#f43f5e'}
                strokeWidth={2.5}
                dot={renderCustomDot}
                activeDot={{ r: 6, fill: '#10b981', stroke: '#ffffff', strokeWidth: 2 }}
                isAnimationActive={false}
                name="Equity"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 4. Secondary Sub-Chart: Underwater Drawdown Curve (%) */}
      {showUnderwaterDd && (
        <div className="bg-slate-950/80 border border-slate-800/80 rounded-xl p-4 shadow-inner">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5" />
                Curva Sottomarina del Drawdown (%)
              </span>
              <span className="text-[10px] text-slate-500">
                Perdita percentuale istantanea rispetto al picco massimo (HWM)
              </span>
            </div>
            <span className="text-xs font-bold text-rose-400">
              Max Drawdown: -{maxDrawdownPercent.toFixed(1)}%
            </span>
          </div>

          <div className="w-full h-32 pt-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={curveData} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="drawdownGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#f43f5e" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke="#64748b"
                  tick={{ fontSize: 9 }}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  stroke="#64748b"
                  tick={{ fontSize: 9 }}
                  tickLine={false}
                  tickFormatter={(val) => `${val}%`}
                  domain={[-Math.max(5, Math.ceil(maxDrawdownPercent * 1.2)), 0]}
                />
                <ReferenceLine y={0} stroke="#475569" strokeWidth={1} />
                <Tooltip
                  formatter={(val: any) => [`${val}%`, 'Drawdown da Picco']}
                  labelFormatter={(lbl) => `Trade ${lbl}`}
                  contentStyle={{ backgroundColor: '#090d16', borderColor: '#334155', fontSize: '11px' }}
                />
                <Area
                  type="monotone"
                  dataKey="drawdownPercent"
                  stroke="#f43f5e"
                  strokeWidth={1.8}
                  isAnimationActive={false}
                  fill="url(#drawdownGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
};
