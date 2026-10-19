import React, { useState, useMemo } from 'react';
import {
  Clock,
  Calendar,
  TrendingUp,
  TrendingDown,
  ShieldAlert,
  Award,
  Zap,
  Filter,
  BarChart2,
  CheckCircle2,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Layers,
  Flame,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ReferenceLine,
} from 'recharts';
import { TradeJournalEntry, SeasonalityReport, HourlySeasonalitySlot } from '../types/radar';
import { calculateIntradaySeasonality } from '../utils/calculator';

interface IntradaySeasonalityAnalysisProps {
  entries: TradeJournalEntry[];
  currentCetMinutes?: number;
  currentSession?: 'EU' | 'US' | 'GLOBAL';
}

type MarketFilter = 'ALL' | 'EU' | 'US';
type MetricView = 'WIN_RATE' | 'AVG_R' | 'PNL';

export const IntradaySeasonalityAnalysis: React.FC<IntradaySeasonalityAnalysisProps> = ({
  entries,
  currentCetMinutes,
  currentSession = 'GLOBAL',
}) => {
  const [marketFilter, setMarketFilter] = useState<MarketFilter>('ALL');
  const [metricView, setMetricView] = useState<MetricView>('WIN_RATE');
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [selectedSlotKey, setSelectedSlotKey] = useState<string | null>(null);

  // Compute Seasonality Report
  const report: SeasonalityReport = useMemo(() => {
    return calculateIntradaySeasonality(entries, currentCetMinutes, marketFilter);
  }, [entries, currentCetMinutes, marketFilter]);

  // Selected slot or current slot for detailed inspection
  const inspectedSlot: HourlySeasonalitySlot | null = useMemo(() => {
    if (selectedSlotKey) {
      return report.hourlySlots.find((s) => s.slotKey === selectedSlotKey) || null;
    }
    return report.currentActiveSlot || report.hourlySlots[1] || null;
  }, [selectedSlotKey, report]);

  // Chart data preparation
  const chartData = useMemo(() => {
    return report.hourlySlots.map((slot) => {
      let value = slot.winRate;
      if (metricView === 'AVG_R') value = slot.avgRMultiple;
      if (metricView === 'PNL') value = slot.netPnlEur;

      return {
        slotKey: slot.slotKey,
        shortLabel: slot.slotKey.split(' - ')[0],
        fullLabel: slot.label,
        value,
        winRate: slot.winRate,
        avgR: slot.avgRMultiple,
        pnl: slot.netPnlEur,
        trades: slot.tradesCount,
        status: slot.status,
        isCurrent: slot.isCurrentHour,
      };
    });
  }, [report, metricView]);

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl mb-8 font-mono">
      {/* 1. Header Toolbar */}
      <div className="px-5 py-4 border-b border-slate-800 bg-slate-950 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
            <Clock className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm sm:text-base font-bold text-white uppercase tracking-wider">
                Analisi Stagionalità Intraday • Pattern Temporali & Orari d'Oro
              </h3>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  report.isJournalDataAvailable
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                    : 'bg-indigo-950 text-indigo-300 border border-indigo-800'
                }`}
              >
                {report.isJournalDataAvailable
                  ? `Diario Reale: ${report.totalAnalyzedTrades} Trade Analizzati`
                  : 'Benchmark Mercati Cash (In attesa di eseguiti nel diario)'}
              </span>
            </div>
            <p className="text-xs text-slate-400 font-sans mt-0.5">
              Identificazione delle ore della giornata con massima asimmetria statistica per i Knock-Out ed esclusione dei periodi di chop
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Market Filter */}
          <div className="flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs">
            <button
              onClick={() => setMarketFilter('ALL')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                marketFilter === 'ALL'
                  ? 'bg-slate-800 text-slate-100 font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tutti ({report.totalAnalyzedTrades})
            </button>
            <button
              onClick={() => setMarketFilter('EU')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer flex items-center gap-1 ${
                marketFilter === 'EU'
                  ? 'bg-emerald-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>🇪🇺 Europa</span>
            </button>
            <button
              onClick={() => setMarketFilter('US')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer flex items-center gap-1 ${
                marketFilter === 'US'
                  ? 'bg-sky-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>🇺🇸 USA</span>
            </button>
          </div>

          {/* Metric Selector */}
          <div className="flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs">
            <button
              onClick={() => setMetricView('WIN_RATE')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                metricView === 'WIN_RATE'
                  ? 'bg-amber-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Visualizza probabilità di vincita per fascia oraria"
            >
              Win Rate %
            </button>
            <button
              onClick={() => setMetricView('AVG_R')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                metricView === 'AVG_R'
                  ? 'bg-indigo-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Visualizza rendimento R-Multiplo medio per fascia oraria"
            >
              R-Medio
            </button>
            <button
              onClick={() => setMetricView('PNL')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                metricView === 'PNL'
                  ? 'bg-emerald-600 text-white font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Visualizza utile netto cumulato per fascia oraria"
            >
              P&L (€)
            </button>
          </div>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
            title={isExpanded ? 'Comprimi sezione' : 'Espandi sezione'}
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="p-4 sm:p-6 space-y-6">
          {/* 2. Live Active Time Window Alert Strip */}
          <div
            className={`p-4 rounded-xl border flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs ${
              report.recommendationForNow.verdict === 'FAVORABLE'
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                : report.recommendationForNow.verdict === 'CAUTION_CHOP'
                ? 'bg-rose-950/40 border-rose-500/40 text-rose-200'
                : 'bg-amber-950/30 border-amber-500/40 text-amber-200'
            }`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                  report.recommendationForNow.verdict === 'FAVORABLE'
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : report.recommendationForNow.verdict === 'CAUTION_CHOP'
                    ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                    : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                }`}
              >
                {report.recommendationForNow.verdict === 'FAVORABLE' ? (
                  <Flame className="w-5 h-5 animate-pulse" />
                ) : report.recommendationForNow.verdict === 'CAUTION_CHOP' ? (
                  <AlertTriangle className="w-5 h-5 animate-bounce" />
                ) : (
                  <Clock className="w-5 h-5" />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-sm tracking-wide text-white">
                    {report.recommendationForNow.title}
                  </span>
                  {report.currentActiveSlot && (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-900 border border-slate-700 text-white">
                      Finestra Attuale: {report.currentActiveSlot.slotKey} CET
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-300 font-sans mt-1 leading-relaxed">
                  {report.recommendationForNow.message}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 self-start md:self-center shrink-0">
              <div className="text-right">
                <span className="text-[10px] text-slate-400 block uppercase">Verdetto Operativo</span>
                <span
                  className={`font-bold text-xs uppercase ${
                    report.recommendationForNow.verdict === 'FAVORABLE'
                      ? 'text-emerald-400'
                      : report.recommendationForNow.verdict === 'CAUTION_CHOP'
                      ? 'text-rose-400'
                      : 'text-amber-400'
                  }`}
                >
                  {report.recommendationForNow.verdict === 'FAVORABLE'
                    ? '✅ Setup Raccomandato'
                    : report.recommendationForNow.verdict === 'CAUTION_CHOP'
                    ? '⚠️ Evitare / Size Ridotta'
                    : '⚖️ Regolare con Cautela'}
                </span>
              </div>
            </div>
          </div>

          {/* 3. Recharts Hourly Distribution Bar Chart */}
          <div className="bg-slate-950/80 border border-slate-800/80 rounded-xl p-4 shadow-inner">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-amber-400" />
                <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                  Distribuzione Temporale: {metricView === 'WIN_RATE' ? 'Tasso di Successo (Win Rate %)' : metricView === 'AVG_R' ? 'Rendimento R-Multiplo Medio' : 'P&L Netto (€)'}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-slate-400 font-sans">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded bg-emerald-500 inline-block" />
                  <span>Alta Convinzione (≥65%)</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded bg-indigo-500 inline-block" />
                  <span>Neutrale (45-64%)</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded bg-rose-500 inline-block" />
                  <span>Chop / Rischio Elevato (&lt;45%)</span>
                </span>
              </div>
            </div>

            <div className="w-full h-64 sm:h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 15, right: 15, left: -10, bottom: 25 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis
                    dataKey="shortLabel"
                    stroke="#64748b"
                    tick={{ fontSize: 10, fill: '#94a3b8' }}
                    tickLine={false}
                    interval={0}
                  />
                  <YAxis
                    stroke="#64748b"
                    tick={{ fontSize: 10, fill: '#94a3b8' }}
                    tickLine={false}
                    domain={metricView === 'WIN_RATE' ? [0, 100] : ['auto', 'auto']}
                    tickFormatter={(v) => (metricView === 'WIN_RATE' ? `${v}%` : metricView === 'AVG_R' ? `${v}R` : `${v}€`)}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null;
                      const item = payload[0].payload;
                      return (
                        <div className="bg-slate-950/95 border border-slate-700 p-3 rounded-xl shadow-2xl text-xs space-y-1.5 z-50 max-w-xs font-mono">
                          <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-1">
                            <span className="font-bold text-white">{item.fullLabel}</span>
                            {item.isCurrent && (
                              <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-amber-950 text-amber-300 border border-amber-700">
                                ORA ATTUALE
                              </span>
                            )}
                          </div>
                          <div className="text-slate-400 text-[11px]">Orario CET: {item.slotKey}</div>
                          <div className="grid grid-cols-2 gap-2 text-[11px] pt-1">
                            <div>
                              <span className="text-slate-500 block text-[10px]">Win Rate:</span>
                              <span className="font-bold text-emerald-400">{item.winRate}%</span>
                            </div>
                            <div>
                              <span className="text-slate-500 block text-[10px]">R-Medio:</span>
                              <span className="font-bold text-sky-400">{item.avgR > 0 ? `+${item.avgR}` : item.avgR}R</span>
                            </div>
                            <div>
                              <span className="text-slate-500 block text-[10px]">P&L Totale:</span>
                              <span className={`font-bold ${item.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {item.pnl >= 0 ? `+${item.pnl}` : item.pnl} €
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500 block text-[10px]">Trade Eseguiti:</span>
                              <span className="font-bold text-slate-200">{item.trades}</span>
                            </div>
                          </div>
                        </div>
                      );
                    }}
                  />
                  {metricView === 'WIN_RATE' && (
                    <ReferenceLine y={50} stroke="#475569" strokeDasharray="3 3" label={{ value: '50% Break-Even', fill: '#64748b', fontSize: 10 }} />
                  )}
                  <Bar
                    dataKey="value"
                    radius={[4, 4, 0, 0]}
                    onClick={(entry: any) => setSelectedSlotKey(entry?.slotKey || null)}
                    className="cursor-pointer"
                  >
                    {chartData.map((entry, index) => {
                      let fillColor = '#6366f1';
                      if (entry.status === 'HIGH_CONVICTION') fillColor = '#10b981';
                      else if (entry.status === 'CHOP_RISK') fillColor = '#f43f5e';

                      return (
                        <Cell
                          key={`cell-${index}`}
                          fill={fillColor}
                          stroke={entry.isCurrent ? '#f59e0b' : 'none'}
                          strokeWidth={entry.isCurrent ? 2 : 0}
                          opacity={entry.isCurrent ? 1 : 0.85}
                        />
                      );
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 4. Intraday Time Slots Grid Cards */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-emerald-400" />
                Matrice delle 9 Finestre Intraday • Dettagli Operativi
              </span>
              <span className="text-[11px] text-slate-500">
                Clicca su una finestra per visualizzare la scheda tattica
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {report.hourlySlots.map((slot) => {
                const isSelected = inspectedSlot?.slotKey === slot.slotKey;
                return (
                  <div
                    key={slot.slotKey}
                    onClick={() => setSelectedSlotKey(slot.slotKey)}
                    className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-slate-900 border-amber-500/80 shadow-lg ring-1 ring-amber-500/40'
                        : slot.isCurrentHour
                        ? 'bg-slate-900/90 border-emerald-500/70'
                        : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1.5">
                      <span className="font-bold text-xs text-white truncate">{slot.label}</span>
                      {slot.isCurrentHour && (
                        <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse shrink-0">
                          ORA
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-400 border-b border-slate-800/80 pb-2 mb-2">
                      <span>{slot.slotKey} CET</span>
                      <span
                        className={`font-bold ${
                          slot.status === 'HIGH_CONVICTION'
                            ? 'text-emerald-400'
                            : slot.status === 'CHOP_RISK'
                            ? 'text-rose-400'
                            : 'text-indigo-400'
                        }`}
                      >
                        {slot.status === 'HIGH_CONVICTION'
                          ? 'Alta Convinzione'
                          : slot.status === 'CHOP_RISK'
                          ? 'Rischio Chop'
                          : 'Neutrale'}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center text-xs mb-2">
                      <div className="bg-slate-900/60 p-1.5 rounded border border-slate-800">
                        <span className="text-[10px] text-slate-500 block">Win Rate</span>
                        <span className="font-bold text-white">{slot.winRate}%</span>
                      </div>
                      <div className="bg-slate-900/60 p-1.5 rounded border border-slate-800">
                        <span className="text-[10px] text-slate-500 block">R-Medio</span>
                        <span className="font-bold text-sky-400">
                          {slot.avgRMultiple > 0 ? `+${slot.avgRMultiple}` : slot.avgRMultiple}R
                        </span>
                      </div>
                      <div className="bg-slate-900/60 p-1.5 rounded border border-slate-800">
                        <span className="text-[10px] text-slate-500 block">Trade</span>
                        <span className="font-bold text-slate-300">{slot.tradesCount}</span>
                      </div>
                    </div>

                    <p className="text-[11px] text-slate-400 font-sans line-clamp-2 leading-relaxed">
                      {slot.tacticalAdvice}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 5. Weekday Seasonality Heatmap Strip */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Calendar className="w-4 h-4 text-sky-400" />
                Stagionalità per Giorno della Settimana (Lunedì - Venerdì)
              </span>
              <span className="text-[11px] text-slate-500">
                Pattern di volatilità settimanale sui derivati a leva
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
              {report.daySlots.map((day) => (
                <div
                  key={day.dayName}
                  className={`p-3 rounded-lg border text-center ${
                    day.isToday
                      ? 'bg-slate-900 border-amber-500/80 ring-1 ring-amber-500/30'
                      : 'bg-slate-900/50 border-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <span className="font-bold text-white text-xs">{day.dayName}</span>
                    {day.isToday && (
                      <span className="px-1 py-0.2 rounded text-[9px] font-bold bg-amber-950 text-amber-300 border border-amber-700">
                        OGGI
                      </span>
                    )}
                  </div>
                  <div className="text-sm font-bold text-emerald-400 mb-0.5">{day.winRate}%</div>
                  <div className="text-[10px] text-slate-400">R-Medio: {day.avgRMultiple > 0 ? `+${day.avgRMultiple}` : day.avgRMultiple}R</div>
                  <div className="text-[10px] text-slate-500 mt-1">{day.tradesCount} Trade eseguiti</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
