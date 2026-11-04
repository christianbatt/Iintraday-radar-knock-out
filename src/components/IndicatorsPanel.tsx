import React from 'react';
import type { ScoreBreakdown, SetupIndicators, VwapSignalState } from '../types/radar';
import {
  INDICATOR_HINT,
  SCORE_COMPONENT_LABELS,
  SCORE_COMPONENT_MAX,
  UNKNOWN_HINT,
  UNKNOWN_LABEL,
  WARMUP_INCOMPLETE_HINT,
  WARMUP_INCOMPLETE_LABEL,
  vetoLabel,
} from '../config/setupLabels';

type Direction = 'LONG' | 'SHORT';

const badgeClass =
  'inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9px] font-mono font-bold tracking-tight border';

export const UnknownValue: React.FC = () => (
  <span className="text-slate-500 font-mono" title={UNKNOWN_HINT}>
    {UNKNOWN_LABEL}
  </span>
);

const Badge: React.FC<{
  label: string;
  value: string;
  title: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
}> = ({ label, value, title, tone = 'neutral' }) => {
  const toneClass =
    tone === 'danger'
      ? 'bg-rose-950/80 text-rose-300 border-rose-800/80'
      : tone === 'warn'
      ? 'bg-amber-950/80 text-amber-300 border-amber-800/80'
      : tone === 'ok'
      ? 'bg-emerald-950/70 text-emerald-300 border-emerald-800/80'
      : 'bg-slate-900 text-slate-300 border-slate-700/80';
  return (
    <span className={`${badgeClass} ${toneClass}`} title={title}>
      <span className="text-slate-400 font-normal">{label}</span>
      <span>{value}</span>
    </span>
  );
};

export interface IndicatorBadgesProps {
  indicators?: SetupIndicators | null;
  vwapState?: VwapSignalState | null;
  veto?: string | null;
  warmupIncomplete?: boolean;
  direction?: Direction;
}

/**
 * Badge compatti per VWAP, Supertrend, ADX, Stoch RSI, PSAR + veto e WARMUP_INCOMPLETE.
 * Legge solo i campi del payload: i valori non disponibili restano "n.d." (dato assente),
 * mai interpretati come segnale negativo.
 */
export const IndicatorBadges: React.FC<IndicatorBadgesProps> = ({
  indicators,
  vwapState,
  veto,
  warmupIncomplete,
  direction,
}) => {
  const st = indicators?.supertrend;
  const adx = indicators?.adx;
  const sr = indicators?.stochRsi;
  const psar = indicators?.psar;
  const threshold = indicators?.adxThreshold;

  const vwapOk = vwapState != null && vwapState.state !== 'UNKNOWN';
  const stOk = st?.status === 'OK' && st.direction !== 0;
  const adxOk = adx?.status === 'OK' && adx.value != null;
  const srOk = sr?.status === 'OK' && sr.k != null && sr.d != null;
  const psarOk = psar?.status === 'OK' && psar.value != null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {vwapOk ? (
        <Badge
          label="VWAP"
          value={`${vwapState!.state}${vwapState!.distAtr != null ? ` ${vwapState!.distAtr.toFixed(2)} ATR` : ''}${
            vwapState!.volumeRatio != null ? ` (vol ${vwapState!.volumeRatio.toFixed(2)}x)` : ''
          }`}
          title={`VWAP di sessione: stato ${vwapState!.state}. Distanza in ATR${
            vwapState!.distAtr != null ? ` ${vwapState!.distAtr.toFixed(2)}` : ' n.d.'
          }, volume relativo ${vwapState!.volumeRatio != null ? `${vwapState!.volumeRatio.toFixed(2)}x` : UNKNOWN_LABEL}. ${INDICATOR_HINT}`}
        />
      ) : (
        <Badge label="VWAP" value={UNKNOWN_LABEL} title={UNKNOWN_HINT} />
      )}

      {stOk ? (
        <Badge
          label="ST"
          value={`${st!.direction === 1 ? 'LONG' : 'SHORT'}${st!.barsSinceFlip != null ? ` flip ${st!.barsSinceFlip}` : ''}`}
          title={`Supertrend 5m: direzione ${st!.direction === 1 ? 'LONG' : 'SHORT'}, flip ${st!.barsSinceFlip ?? 'n.d.'} barre fa. ${INDICATOR_HINT}`}
          tone={direction && (st!.direction === 1 ? 'LONG' : 'SHORT') !== direction ? 'warn' : 'ok'}
        />
      ) : (
        <Badge label="ST" value={UNKNOWN_LABEL} title={`Supertrend 5m: ${UNKNOWN_HINT}`} />
      )}

      {adxOk ? (
        <Badge
          label="ADX"
          value={`${adx!.value!.toFixed(1)}${adx!.plusDI != null && adx!.minusDI != null ? ` +${adx!.plusDI.toFixed(0)}/-${adx!.minusDI.toFixed(0)}` : ''}${
            threshold ? ` soglia ${threshold.min}/${threshold.strong}` : ''
          }`}
          title={`ADX 5m ${adx!.value!.toFixed(1)} | +DI ${adx!.plusDI?.toFixed(1) ?? UNKNOWN_LABEL} / -DI ${
            adx!.minusDI?.toFixed(1) ?? UNKNOWN_LABEL
          } | soglie mercato ${threshold ? `${threshold.min} (veto) / ${threshold.strong} (trend forte)` : UNKNOWN_LABEL}. ${INDICATOR_HINT}`}
          tone={threshold && adx!.value! < threshold.min ? 'danger' : 'ok'}
        />
      ) : (
        <Badge label="ADX" value={UNKNOWN_LABEL} title={`ADX 5m: ${UNKNOWN_HINT}`} />
      )}

      {srOk ? (
        <Badge
          label="StochRSI"
          value={`K ${sr!.k!.toFixed(0)}/D ${sr!.d!.toFixed(0)}${sr!.lastCross !== 'NONE' ? ` ${sr!.lastCross} ${sr!.barsSinceCross ?? ''}` : ''}`}
          title={`Stoch RSI 5m: K ${sr!.k!.toFixed(1)} / D ${sr!.d!.toFixed(1)}, ultimo incrocio ${sr!.lastCross}${
            sr!.barsSinceCross != null ? ` ${sr!.barsSinceCross} barre fa` : ''
          }. ${INDICATOR_HINT}`}
        />
      ) : (
        <Badge label="StochRSI" value={UNKNOWN_LABEL} title={`Stoch RSI 5m: ${UNKNOWN_HINT}`} />
      )}

      {psarOk ? (
        <Badge
          label="PSAR"
          value={`${psar!.value!.toFixed(2)} ${psar!.direction === 1 ? 'LONG' : psar!.direction === -1 ? 'SHORT' : ''}`.trim()}
          title={`PSAR 5m: ${psar!.value!.toFixed(2)}, direzione ${
            psar!.direction === 1 ? 'LONG' : psar!.direction === -1 ? 'SHORT' : UNKNOWN_LABEL
          }. Usato per stop e uscita, non assegna punti. ${INDICATOR_HINT}`}
        />
      ) : (
        <Badge label="PSAR" value={UNKNOWN_LABEL} title={`PSAR: ${UNKNOWN_HINT}`} />
      )}

      {warmupIncomplete && (
        <Badge label="" value={WARMUP_INCOMPLETE_LABEL} title={WARMUP_INCOMPLETE_HINT} tone="warn" />
      )}

      {veto && <Badge label="VETO" value={vetoLabel(veto) ?? veto} title={`Veto: ${vetoLabel(veto) ?? veto}`} tone="danger" />}
    </div>
  );
};

export interface ScoreBreakdownPanelProps {
  score: ScoreBreakdown;
}

/**
 * Pannello di dettaglio dello score: punti/max per componente e totale 0-100.
 * Usa solo `scoreBreakdown` e `total` presenti nel payload del candidato.
 */
export const ScoreBreakdownPanel: React.FC<ScoreBreakdownPanelProps> = ({ score }) => {
  const breakdown = score.scoreBreakdown ?? {};
  const keys = Object.keys(SCORE_COMPONENT_LABELS);

  return (
    <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <span className="text-[11px] font-mono text-slate-400">
          Score totale{' '}
          <strong className={`text-sm ${score.total >= 70 ? 'text-emerald-400' : score.total >= 55 ? 'text-sky-300' : 'text-slate-300'}`}>
            {score.total}/100
          </strong>
          <span className="text-[10px] text-slate-500 ml-2">{INDICATOR_HINT}</span>
        </span>
        <span className="flex flex-wrap items-center gap-1">
          {score.veto && (
            <span
              className={`${badgeClass} bg-rose-950/80 text-rose-300 border-rose-800/80`}
              title={`Veto: ${vetoLabel(score.veto) ?? score.veto}`}
            >
              VETO {vetoLabel(score.veto) ?? score.veto}
            </span>
          )}
          {score.warmupIncomplete && (
            <span className={`${badgeClass} bg-amber-950/80 text-amber-300 border-amber-800/80`} title={WARMUP_INCOMPLETE_HINT}>
              {WARMUP_INCOMPLETE_LABEL}
            </span>
          )}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {keys.map((key) => (
          <div
            key={key}
            className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-slate-900/70 border border-slate-800 text-[10px] font-mono"
            title={`${SCORE_COMPONENT_LABELS[key]}: ${breakdown[key] ?? 0} punti su ${SCORE_COMPONENT_MAX[key]}`}
          >
            <span className="text-slate-400">{SCORE_COMPONENT_LABELS[key]}</span>
            <span className="text-slate-200 font-bold">
              {breakdown[key] ?? 0}/{SCORE_COMPONENT_MAX[key]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
