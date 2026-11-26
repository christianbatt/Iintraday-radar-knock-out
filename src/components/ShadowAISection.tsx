import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  SHADOW_AI_SECTION,
  isShadowAiSectionEnabled,
  type ShadowAiSectionFlag,
} from '../config/shadowAiSection';

export interface AiShadowLogEntry {
  id: string;
  timestamp: string;
  ticker: string | null;
  market: string;
  direction: string | null;
  setup: string | null;
  aiOutcome: string | null;
  aiCategory: string | null;
  source: 'scan' | 'specialize' | 'desk';
  status: 'NON_VALIDATO';
  outcome: null | unknown;
  evaluated?: boolean;
  discarded?: boolean;
  discardReason?: string | null;
  /** ADDITIVO (P3): `runId:ticker`, condiviso fra riga di scansione e riga handler. */
  candidateKey?: string | null;
  /** ADDITIVO (P2): origine dei candidati. */
  candidateSource?: 'body' | 'snapshot' | 'none' | null;
}

export interface ShadowLogSummary {
  knownOutcomeCount: number;
  discardedCount: number;
  notEvaluatedCount: number;
  evaluatedCount: number;
}

/**
 * ADDITIVO (P3): conteggio per `candidateKey` distinto, con la riga piu'
 * recente come stato del candidato. Le righe senza `candidateKey` (direttive
 * LLM e voci storiche) restano contate singolarmente per `id`.
 *
 * Cosi' una riga `source: 'scan'` con NON_INVIATO_ALLA_LLM non viene piu'
 * contata come "non valutata" quando lo stesso candidato e' stato poi
 * valutato dall'handler.
 */
export function summarizeShadowLogEntries(
  entries: ReadonlyArray<AiShadowLogEntry> | null | undefined
): ShadowLogSummary {
  if (!Array.isArray(entries)) {
    return { knownOutcomeCount: 0, discardedCount: 0, notEvaluatedCount: 0, evaluatedCount: 0 };
  }
  const latestByCandidate = new Map<string, AiShadowLogEntry>();
  entries.forEach((entry, index) => {
    const key =
      typeof entry?.candidateKey === 'string' && entry.candidateKey.length > 0
        ? `candidate:${entry.candidateKey}`
        : `raw:${entry?.id ?? index}`;
    latestByCandidate.set(key, entry);
  });
  const latest = [...latestByCandidate.values()];
  return {
    knownOutcomeCount: entries.filter((e) => e.outcome !== null && e.outcome !== undefined).length,
    discardedCount: entries.filter((e) => e.discarded === true).length,
    notEvaluatedCount: latest.filter((e) => e.evaluated === false).length,
    evaluatedCount: latest.filter((e) => e.evaluated === true).length,
  };
}

/**
 * Vista di calibrazione (PR-C): solo aggregati, nessun ricalcolo nel client.
 * Dichiarata qui invece di importare il modulo server, che resta fuori dal bundle.
 */
interface AiCalibrationView {
  available?: boolean;
  verdict?: 'insufficient' | 'evidence';
  edgeR?: number | null;
  minSample?: number;
  counts?: { matched?: number };
  buckets?: { decision: string; n: number }[];
  skippedWinners?: unknown[];
}

export interface ShadowAISectionProps {
  entries?: AiShadowLogEntry[] | null;
  loading?: boolean;
  error?: string | null;
  refreshSignal?: string | null;
  fetchImpl?: typeof fetch;
  flag?: ShadowAiSectionFlag;
}

export const ShadowAISection: React.FC<ShadowAISectionProps> = ({
  entries: entriesProp,
  loading: loadingProp,
  error: errorProp,
  refreshSignal = null,
  fetchImpl,
  flag,
}) => {
  const enabled = isShadowAiSectionEnabled(flag ?? SHADOW_AI_SECTION);
  const live = entriesProp === undefined;

  const [fetched, setFetched] = useState<AiShadowLogEntry[] | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(live && enabled);
  const [tick, setTick] = useState(0);
  const [calibration, setCalibration] = useState<AiCalibrationView | null>(null);
  const prevRefreshSignalRef = useRef(refreshSignal);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (prevRefreshSignalRef.current === refreshSignal) return;
    prevRefreshSignalRef.current = refreshSignal;
    if (enabled && live && refreshSignal) {
      refresh();
    }
  }, [refreshSignal, enabled, live, refresh]);

  useEffect(() => {
    if (!enabled || !live) return;
    let alive = true;
    const doFetch = fetchImpl ?? fetch;
    setLoading(true);
    setNetError(null);
    doFetch('/api/shadow/ai-log')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { entries?: AiShadowLogEntry[] }) => {
        if (!alive) return;
        setFetched(Array.isArray(d?.entries) ? d.entries : []);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setNetError('errore di rete: impossibile leggere il log AI shadow');
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [enabled, live, fetchImpl, tick]);

  useEffect(() => {
    if (!enabled || !live) return;
    let alive = true;
    const doFetch = fetchImpl ?? fetch;
    doFetch('/api/shadow/ai-calibration')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: AiCalibrationView | null) => {
        if (!alive) return;
        // Nessun placeholder: si mostra solo quando c'e' qualcosa di reale.
        setCalibration(d && d.available === true ? d : null);
      })
      .catch(() => {
        if (!alive) return;
        setCalibration(null);
      });
    return () => {
      alive = false;
    };
  }, [enabled, live, fetchImpl, tick]);

  if (!enabled) return null;

  const entries = live ? fetched : (entriesProp ?? null);
  const shownError = errorProp ?? netError;
  const shownLoading = loadingProp !== undefined ? loadingProp : loading;

  const summary = summarizeShadowLogEntries(entries);
  const knownOutcomeCount = summary.knownOutcomeCount;
  const discardedCount = summary.discardedCount;
  const notEvaluatedCount = summary.notEvaluatedCount;

  return (
    <div data-testid="shadow-ai-section" data-section="shadow-ai" className="rounded border border-slate-700 bg-slate-900/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-200">Osservazioni AI shadow (NON VALIDATO)</span>
        <button
          type="button"
          onClick={refresh}
          data-testid="shadow-ai-refresh"
          className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
        >
          Aggiorna
        </button>
      </div>
      {shownLoading && <p className="text-xs text-slate-400" data-testid="shadow-ai-loading">caricamento…</p>}
      {shownError && (
        <p className="text-xs text-rose-300" data-testid="shadow-ai-error">
          {shownError}
        </p>
      )}
      {!shownLoading && !shownError && (
        <>
          {(!entries || entries.length === 0) ? (
            <p className="text-xs text-slate-400" data-testid="shadow-ai-empty">nessuna osservazione</p>
          ) : (
            <ul className="space-y-1" data-testid="shadow-ai-list">
              {entries.map((e) => (
                <li key={e.id} className="text-[11px] text-slate-300 flex items-center gap-2">
                  <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 font-bold">NON VALIDATO</span>
                  <span>{e.ticker ?? '—'} · {e.market} · {e.aiCategory ?? '—'}</span>
                  <span className="text-slate-500 truncate">{e.aiOutcome ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-slate-500" data-testid="shadow-ai-known-outcome-count">
            esiti noti: {knownOutcomeCount}
          </p>
          <p className="text-[10px] text-slate-500" data-testid="shadow-ai-discarded-count">
            scartate: {discardedCount}
          </p>
          <p className="text-[10px] text-slate-500" data-testid="shadow-ai-not-evaluated-count">
            non valutate: {notEvaluatedCount}
          </p>
          {calibration && (
            <div
              data-testid="shadow-ai-calibration"
              className="border-t border-slate-700 pt-2 space-y-1"
            >
              <p className="text-[10px] font-bold text-slate-300">
                Calibrazione AI (esplorativa) —{' '}
                {calibration.verdict === 'evidence' ? 'campione sufficiente' : 'campione insufficiente'}
              </p>
              <p className="text-[10px] text-slate-400" data-testid="shadow-ai-calibration-matched">
                abbinate: {calibration.counts?.matched ?? 0} / min {calibration.minSample ?? 0}
              </p>
              <p className="text-[10px] text-slate-400">
                {calibration.buckets?.map((b) => `${b.decision} ${b.n}`).join(' · ')}
              </p>
              <p className="text-[10px] text-slate-400" data-testid="shadow-ai-calibration-edge">
                edgeR: {calibration.edgeR === null || calibration.edgeR === undefined
                  ? 'non calcolabile'
                  : calibration.edgeR}
                {calibration.verdict === 'evidence' ? '' : ' (non un risultato)'}
              </p>
              {(calibration.skippedWinners?.length ?? 0) > 0 && (
                <p className="text-[10px] text-amber-300">
                  scarti andati in positivo: {calibration.skippedWinners?.length}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ShadowAISection;
