import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  SHADOW_V1_LIVE_VIEW_PANEL,
  isShadowV1LivePanelEnabled,
  type ShadowV1LiveViewPanelFlag,
} from '../config/shadowV1LiveView';
import type {
  ShadowV1LiveViewRecord,
  ShadowV1LiveViewResponse,
} from '../server/shadowV1LiveView';

/**
 * Pannello SHADOW V1 LIVE (PR D2) — sola lettura.
 *
 * Mostra i record persistiti letti da `GET /api/shadow/v1-live/signals` e
 * affianca i numeri V2, senza calcolare alcun confronto: le due popolazioni
 * non sono omogenee (ingresso, barriera temporale, costi) e la metriche V1
 * `r` e' un R di prezzo, non un `rNet`. Il confronto quantitativo e'
 * dichiarato non disponibile, non simulato.
 *
 * Flag `SHADOW_V1_LIVE_VIEW_PANEL` (acceso di default; spegnibile via `'off'`):
 * a flag OFF il componente non renderizza nulla e non fa richieste.
 * `data`/`v2`/`error` sono iniettabili per i test statici e per evitare doppio fetch nella modale.
 */
export interface ShadowV1LiveV2Summary {
  nSignals?: number;
  nResolved?: number;
  meanRGross?: number | null;
  meanRNet?: number | null;
  winRatePct?: number | null;
}

export interface ShadowV1LiveDiagnosticsSummary {
  lastScanAt?: string;
  scannedTickers?: number;
  evaluatedTickers?: number;
  emittedThisScan?: number;
  persistedThisScan?: number;
  blockedThisScan?: number;
  topEU?: string | null;
  topUS?: string | null;
  gateCounts?: Array<{ gate: string; label: string; count: number }>;
  sampleCandidates?: Array<{
    ticker: string;
    market: 'EU' | 'US';
    score: number;
    isTopPick: boolean;
    decision: 'TRADE' | 'BLOCKED';
    gate: string | null;
    reason: string | null;
  }>;
}

export interface ShadowV1LiveMark {
  key: string;
  ticker: string;
  market: 'EU' | 'US';
  direction: 'LONG' | 'SHORT';
  status: 'PENDING_FILL' | 'OPEN';
  currency: string;
  lastPrice: number;
  lastPriceAtMs: number | null;
  unrealizedR: number | null;
  pctFromEntry: number | null;
  priceSource: 'quote' | 'bar5m';
}

export interface ShadowV1LiveMarksSummary {
  version?: number;
  updatedAt?: string;
  marks?: ShadowV1LiveMark[];
}

export interface ShadowV1LivePanelProps {
  data?: ShadowV1LiveViewResponse | null;
  v2?: ShadowV1LiveV2Summary | null;
  diagnostics?: ShadowV1LiveDiagnosticsSummary | null;
  liveMarks?: ShadowV1LiveMarksSummary | null;
  refreshSignal?: string | null;
  error?: string | null;
  loading?: boolean;
  fetchImpl?: typeof fetch;
  /** Solo per i test: in produzione vale la costante di config. */
  flag?: ShadowV1LiveViewPanelFlag;
}

/** Quante voci di `gateCounts` restano visibili: il resto e' nei conteggi. */
export const SHADOW_V1_LIVE_PANEL_GATES_SHOWN = 5;

/**
 * Metodo dichiarato dal nucleo per i record nuovi. Il valore duplica
 * `SHADOW_V1_LIVE_MODULE_VERSION` di `src/server/shadowV1LiveStore.ts` per non
 * portare `node:fs` nel bundle client; il test del pannello ne verifica il valore.
 */
export const SHADOW_V1_LIVE_METHOD_CURRENT = 'shadowV1Live@2';

/**
 * Etichetta del metodo per singolo record (solo testo): `shadowV1Live@2` =
 * barra della decisione + stop in gap; qualunque altro valore o campo assente =
 * record prodotto dal metodo precedente, mai ricalcolato.
 */
export function shadowV1LiveMethodLabel(moduleVersion: string | null | undefined): string {
  return moduleVersion === SHADOW_V1_LIVE_METHOD_CURRENT ? 'metodo v2' : 'metodo precedente';
}

const STATUS_LABEL: Record<ShadowV1LiveViewRecord['status'], string> = {
  PENDING_FILL: 'in attesa',
  OPEN: 'aperto',
  STOP: 'stop',
  TARGET: 'target',
  EXPIRED: 'scaduto',
  NOT_FILLED: 'non riempito',
};

function num(value: number | null | undefined, decimals = 2, suffix = ''): string {
  if (value == null || !Number.isFinite(value)) return 'n/d';
  return `${value.toFixed(decimals)}${suffix}`;
}

function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function delayLabel(delayMs: number | null): string {
  if (delayMs == null || !Number.isFinite(delayMs)) return 'n/d';
  const minutes = delayMs / 60_000;
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)}m`;
}

function currencySymbol(currency: string): string {
  const c = currency.toUpperCase();
  if (c === 'EUR') return '€';
  if (c === 'USD') return '$';
  return `${c} `;
}

function signed(value: number, decimals = 2, suffix = ''): string {
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(decimals)}${suffix}`;
}

export const ShadowV1LivePanel: React.FC<ShadowV1LivePanelProps> = ({
  data: dataProp,
  v2: v2Prop,
  diagnostics: diagnosticsProp,
  liveMarks: liveMarksProp,
  refreshSignal = null,
  error: errorProp,
  loading: loadingProp,
  fetchImpl,
  flag,
}) => {
  const enabled = isShadowV1LivePanelEnabled(flag ?? SHADOW_V1_LIVE_VIEW_PANEL);
  const live = dataProp === undefined;

  const [fetched, setFetched] = useState<ShadowV1LiveViewResponse | null>(null);
  const [v2Fetched, setV2Fetched] = useState<ShadowV1LiveV2Summary | null>(null);
  const [liveMarksFetched, setLiveMarksFetched] = useState<ShadowV1LiveMarksSummary | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(live && enabled);
  const [tick, setTick] = useState(0);
  const prevRefreshSignalRef = useRef(refreshSignal);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (prevRefreshSignalRef.current === refreshSignal) return;
    prevRefreshSignalRef.current = refreshSignal;
    if (enabled && live && refreshSignal) {
      refresh();
    }
  }, [refreshSignal, enabled, live, refresh]);

  const shouldFetchLatest = v2Prop === undefined || liveMarksProp === undefined;

  useEffect(() => {
    if (!enabled || !live) return;
    let alive = true;
    const doFetch = fetchImpl ?? fetch;
    setLoading(true);
    setNetError(null);

    const readJson = (url: string): Promise<unknown> =>
      doFetch(url).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });

    Promise.all([
      readJson('/api/shadow/v1-live/signals'),
      shouldFetchLatest ? readJson('/api/shadow/latest').catch(() => null) : Promise.resolve(null),
    ])
      .then(([v1, shadow]) => {
        if (!alive) return;
        setFetched(v1 as ShadowV1LiveViewResponse);
        if (shouldFetchLatest) {
          const shadowObj = shadow as {
            shadowV2?: ShadowV1LiveV2Summary;
            v1LiveMarks?: ShadowV1LiveMarksSummary;
          } | null;
          if (v2Prop === undefined) setV2Fetched(shadowObj?.shadowV2 ?? null);
          if (liveMarksProp === undefined) setLiveMarksFetched(shadowObj?.v1LiveMarks ?? null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setNetError('errore di rete: impossibile leggere i record V1-live');
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [enabled, live, shouldFetchLatest, v2Prop, liveMarksProp, fetchImpl, tick]);

  if (!enabled) return null;

  const data = live ? fetched : dataProp;
  const v2 = v2Prop !== undefined ? v2Prop : v2Fetched;
  const liveMarks = liveMarksProp !== undefined ? liveMarksProp : liveMarksFetched;
  const shownError = errorProp ?? netError;
  const isLoading = loadingProp ?? loading;

  const records = data?.records ?? [];
  const counts = data?.counts ?? null;
  const metrics = data?.metrics ?? null;
  const markByKey = new Map<string, ShadowV1LiveMark>();
  for (const m of liveMarks?.marks ?? []) {
    if (m && m.key) markByKey.set(m.key, m);
  }

  return (
    <section
      data-testid="v1live-panel"
      className="rounded-lg border border-slate-700 bg-slate-950/40 p-3 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="text-xs font-bold text-white">Shadow V1-live</span>{' '}
          <span className="text-[10px] text-slate-500">sola lettura, dati persistiti</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500">esplorativo</span>
          {live && (
            <button
              type="button"
              onClick={refresh}
              disabled={isLoading}
              data-testid="v1live-refresh"
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-bold cursor-pointer disabled:opacity-50"
            >
              Aggiorna
            </button>
          )}
        </div>
      </div>

      {isLoading && (
        <p className="text-xs text-slate-400" data-testid="v1live-loading">
          caricamento…
        </p>
      )}

      {shownError && (
        <p className="text-xs text-rose-300" data-testid="v1live-error">
          {shownError}
        </p>
      )}

      {!isLoading && !shownError && data && !data.available && (
        <p className="text-xs text-amber-300" data-testid="v1live-unavailable">
          vista non disponibile: {data.reason ?? 'motivo non dichiarato'}
        </p>
      )}

      {diagnosticsProp && (
        <div
          className="rounded border border-slate-800 bg-slate-900/60 p-2.5 space-y-1.5"
          data-testid="v1live-diagnostics"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px]">
            <span className="font-bold text-slate-200">
              Scansione automatica server (tutto il paniere: {diagnosticsProp.scannedTickers ?? 0} titoli)
            </span>
            <span className="font-mono text-slate-400">
              {diagnosticsProp.lastScanAt ? stamp(Date.parse(diagnosticsProp.lastScanAt)) : 'n/d'}
            </span>
          </div>
          <div className="text-[10px] text-slate-300 flex flex-wrap gap-3">
            <span>
              Emessi nell&apos;ultima scansione: <strong className="text-white">{diagnosticsProp.emittedThisScan ?? 0}</strong>
            </span>
            <span>
              Bloccati dai filtri V1: <strong className="text-amber-300">{diagnosticsProp.blockedThisScan ?? 0}</strong>
            </span>
            <span>
              Top-1 EU: <strong className="text-white">{diagnosticsProp.topEU ?? 'n/d'}</strong> · Top-1 US:{' '}
              <strong className="text-white">{diagnosticsProp.topUS ?? 'n/d'}</strong>
            </span>
          </div>
          {(diagnosticsProp.gateCounts?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {diagnosticsProp.gateCounts!.slice(0, SHADOW_V1_LIVE_PANEL_GATES_SHOWN).map((g) => (
                <span
                  key={g.gate}
                  className="px-1.5 py-0.5 rounded bg-slate-950/80 border border-slate-800 text-[10px] text-slate-300"
                >
                  <strong className="text-amber-300">{g.gate}</strong> {g.label}: {g.count}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {!isLoading && !shownError && data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded bg-slate-900/60 p-2">
              <div className="text-[10px] text-slate-500">Record</div>
              <div className="text-sm font-bold text-white">{counts?.persisted ?? 0}</div>
            </div>
            <div className="rounded bg-slate-900/60 p-2">
              <div className="text-[10px] text-slate-500">Non terminali (stale)</div>
              <div className="text-sm font-bold text-white">
                {counts?.nonTerminal ?? 0} ({counts?.stale ?? 0})
              </div>
            </div>
            <div className="rounded bg-slate-900/60 p-2">
              <div className="text-[10px] text-slate-500">Con esito / non riempiti</div>
              <div className="text-sm font-bold text-white">
                {(counts?.terminal ?? 0) - (counts?.notFilled ?? 0)} / {counts?.notFilled ?? 0}
              </div>
            </div>
            <div className="rounded bg-slate-900/60 p-2">
              <div className="text-[10px] text-slate-500">Righe ignorate</div>
              <div className="text-sm font-bold text-white">{data.skippedLines}</div>
            </div>
          </div>

          {data.truncated && (
            <p className="text-[10px] text-amber-300" data-testid="v1live-truncated">
              mostrati gli ultimi {data.limit} record per data di decisione; la vista e'
              troncata, non completa.
            </p>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded bg-slate-900/60 p-2">
              <div className="text-[10px] text-slate-500">
                R medio (n={metrics?.resolved ?? 0})
              </div>
              <div className="text-sm font-bold text-white">{num(metrics?.meanR, 3, 'R')}</div>
            </div>
            <div className="rounded bg-slate-900/60 p-2">
              <div className="text-[10px] text-slate-500">Quota R&gt;0</div>
              <div className="text-sm font-bold text-white">
                {num(metrics?.winRatePct, 1, '%')}
              </div>
            </div>
            <div className="rounded bg-slate-900/60 p-2">
              <div className="text-[10px] text-slate-500">Somma R</div>
              <div className="text-sm font-bold text-white">{num(metrics?.sumR, 2, 'R')}</div>
            </div>
            <div className="rounded bg-slate-900/60 p-2">
              <div className="text-[10px] text-slate-500">Max DD</div>
              <div className="text-sm font-bold text-white">
                {num(metrics?.maxDrawdownR, 2, 'R')}
              </div>
            </div>
          </div>

          {metrics?.note && <p className="text-[10px] text-slate-500">{metrics.note}</p>}

          <p className="text-[10px] text-amber-200" data-testid="v1live-late-note">
            metriche calcolate escludendo i record in ritardo di osservazione
            {data.lateThresholdMs ? ` (> ${Math.round(data.lateThresholdMs / 60_000)} min)` : ''}:
            inclusi {metrics?.resolved ?? 0}, esclusi {metrics?.nLate ?? 0}, senza ritardo
            calcolabile {metrics?.nDelayUnavailable ?? 0}, su {metrics?.nResolvedAll ?? 0} con
            esito.
          </p>

          {records.length === 0 ? (
            <p className="text-xs text-slate-400" data-testid="v1live-empty">
              nessun record persistito
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[10px] text-slate-300">
                <thead className="text-slate-500">
                  <tr>
                    <th className="text-left font-normal">decisione</th>
                    <th className="text-left font-normal">ticker</th>
                    <th className="text-left font-normal">mercato</th>
                    <th className="text-left font-normal">direzione</th>
                    <th className="text-left font-normal">stato</th>
                    <th className="text-right font-normal">prezzo / var.</th>
                    <th className="text-right font-normal">ritardo</th>
                    <th className="text-right font-normal">R</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => {
                    const mark = markByKey.get(r.key);
                    const isActive = r.status === 'OPEN' || r.status === 'PENDING_FILL';
                    return (
                      <tr key={r.key} data-testid="v1live-row" className="border-t border-slate-800">
                        <td className="py-1">{stamp(r.decidedAtMs)}</td>
                        <td className="py-1 font-bold text-white">{r.ticker}</td>
                        <td className="py-1">{r.market}</td>
                        <td className="py-1">{r.direction}</td>
                        <td className="py-1">
                          {STATUS_LABEL[r.status]}
                          <span
                            className="ml-1 text-[9px] text-slate-500"
                            data-testid="v1live-method"
                          >
                            {shadowV1LiveMethodLabel(r.moduleVersion)}
                          </span>
                          {r.stale && (
                            <span
                              className="ml-1 text-[9px] text-amber-300"
                              data-testid="v1live-stale"
                            >
                              stale
                            </span>
                          )}
                          {r.late && (
                            <span
                              className="ml-1 text-[9px] text-rose-300"
                              data-testid="v1live-late"
                            >
                              late
                            </span>
                          )}
                        </td>
                        <td className="py-1 text-right font-mono" data-testid="v1live-mark">
                          {isActive && mark ? (
                            <span className="inline-flex flex-col items-end leading-tight">
                              <span className="text-slate-200">
                                {currencySymbol(mark.currency)}
                                {mark.lastPrice.toFixed(2)}
                              </span>
                              {r.status === 'OPEN' && mark.unrealizedR != null ? (
                                <span
                                  className={
                                    mark.unrealizedR >= 0 ? 'text-emerald-300 text-[9px]' : 'text-rose-300 text-[9px]'
                                  }
                                >
                                  {signed(mark.unrealizedR, 2, 'R')}
                                  {mark.pctFromEntry != null ? ` (${signed(mark.pctFromEntry, 2, '%')})` : ''}
                                </span>
                              ) : mark.pctFromEntry != null ? (
                                <span className="text-slate-400 text-[9px]">
                                  dall&apos;ingresso {signed(mark.pctFromEntry, 2, '%')}
                                </span>
                              ) : null}
                            </span>
                          ) : !isActive && r.exitPrice != null && Number.isFinite(r.exitPrice) ? (
                            <span className="text-slate-400">uscita {r.exitPrice.toFixed(2)}</span>
                          ) : (
                            <span className="text-slate-500">n/d</span>
                          )}
                        </td>
                        <td className="py-1 text-right text-slate-400">
                          {delayLabel(r.delayMs)}
                        </td>
                        <td className="py-1 text-right">{r.r != null ? num(r.r, 2, 'R') : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="rounded bg-slate-900/60 p-2 space-y-1" data-testid="v1live-nocompare">
        <p className="text-[10px] font-bold text-amber-300">
          Confronto quantitativo V1-live / V2 non disponibile
        </p>
        <p className="text-[10px] text-slate-500">
          Le due popolazioni non sono omogenee: ingresso V1 al tocco del livello e V2
          all&apos;apertura della barra successiva; barriera temporale V1 alla chiusura di
          sessione e V2 a fine finestra verticale; V1 senza costi ne&apos; leva, V2 con
          frizioni e leva KO. Le etichette &quot;R&quot; non indicano la stessa metrica.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
          <div className="rounded bg-slate-950/60 p-2">
            <div className="text-[10px] text-slate-400 font-bold">V1-live</div>
            <div className="text-[10px] text-slate-500">
              R di prezzo, n={metrics?.resolved ?? 0} record con esito
            </div>
            <div className="text-[10px] text-slate-300">
              medio {num(metrics?.meanR, 3, 'R')} · somma {num(metrics?.sumR, 2, 'R')}
            </div>
          </div>
          <div className="rounded bg-slate-950/60 p-2">
            <div className="text-[10px] text-slate-400 font-bold">V2 (riferimento, campione diverso)</div>
            <div className="text-[10px] text-slate-500">
              n={v2?.nResolved ?? 0} risolti su {v2?.nSignals ?? 0} segnali
            </div>
            <div className="text-[10px] text-slate-300">
              lordo {num(v2?.meanRGross, 3, 'R')} · netto {num(v2?.meanRNet, 3, 'R')}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default ShadowV1LivePanel;
