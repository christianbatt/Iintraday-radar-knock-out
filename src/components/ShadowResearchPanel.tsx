import React from 'react';

/**
 * ShadowResearchPanel — display di sola lettura (Passo L).
 *
 * NON calcola, NON addestra, NON applica, NON esegue processi: mostra un
 * artefatto prodotto offline (`bun scripts/shadow_report.ts`,
 * `bun scripts/ai_cycle.ts deathcheck`). Se l'artefatto manca, lo dice.
 *
 * Il suo primo lavoro non e' mostrare il risultato: e' mostrare il dubbio.
 * Se il fill e' sospetto, la sezione 2 sale in testa con il warning.
 *
 * Vietati per costruzione: punteggio composito, badge di qualita', percentuali
 * di affidabilita', qualunque numero senza n accanto.
 */

export type ShadowRuleRow = {
  id: string;
  name: string;
  family: string;
  status: 'computed' | 'insufficient_sample' | 'missing_input' | 'not_invocable' | string;
  value: number | null;
  unit: string | null;
  n: number | null;
  note: string;
};

export type ShadowProposalRow = {
  hypothesisId: string;
  status: string;
  holdoutN: number | null;
  meanRHoldout: number | null;
  meanRNullP95: number | null;
  alphaEffective: number | null;
  beatsNull: boolean | null;
  nullReason: string | null;
  verdict: string;
};

export type ShadowPanelData = {
  available: boolean;
  reason?: string;
  generatedAt?: string | null;
  sample?: {
    nDays: number | null;
    nSetups: number | null;
    nClusters: number | null;
    barMinutes: number | null;
  } | null;
  emissionsByDay?: Array<{
    day: string;
    candidates: number | null;
    emitted: number | null;
    blocked: number | null;
    firstFailingGate: string | null;
  }>;
  deathCriterion?: {
    status: string;
    trigger: { needSetups: number; haveSetups: number | null; needDays: number; haveDays: number | null };
    nCells: number | null;
    nAdmissibleCells: number | null;
    alphaEffective: number | null;
    alphaBonferroni: number | null;
    reason: string;
  } | null;
  fillIntegrity?: string | null;
  rules?: ShadowRuleRow[];
  spreadEstimate?: {
    perSymbol: Array<{ symbol: string; spreadPct: number | null; n: number | null }>;
    vsParametricPct: number | null;
    deltaPct: number | null;
    caveat: string;
  } | null;
  deflatedSharpe?: {
    nTrials: number | null;
    nTrialsSource: string;
    dsr: number | null;
    pValue: number | null;
    alphaBonferroni: number | null;
    alphaEffective: number | null;
    note: string;
  } | null;
  proposals?: ShadowProposalRow[];
  cessation?: {
    available?: boolean | null;
    rowsWithReason?: number | null;
    dominantCauseAfter?: string | null;
    daysNeededCalendar?: number | null;
    daysNeededEmitting?: number | null;
    reasonBreakdown?: Array<{ causa: string; prima: number; dopo: number; deltaPt: number | null }>;
    assumption?: string | null;
  } | null;
  limitations?: string[];
  flags?: { SETUP_SELECTOR_LIVE: string; STALENESS_USE_MARKET_TS: string };
};

const SECTION = 'rounded-xl border border-slate-800 bg-slate-950 p-4 space-y-2';

const STATUS_LABEL: Record<string, string> = {
  computed: 'calcolato',
  insufficient_sample: 'campione insufficiente',
  missing_input: 'input mancante',
  not_invocable: 'non invocabile',
  hypothesis: 'ipotesi',
  accepted: 'accettata',
  rejected: 'respinta',
  inconclusive: 'inconcludente',
  insufficient_holdout: 'holdout insufficiente',
  not_yet_evaluable: 'non ancora valutabile',
  survives: 'sopravvive',
  closed: 'chiuso',
};

/** S04 e S11 sono calcolabili ma non interpretabili (K, R6): valore senza lettura. */
const NOT_INTERPRETABLE: Record<string, string> = {
  S04: 'DSR a 0.000 con p 0.5000: nessuna evidenza. Il numero esiste, la lettura no.',
  S11: 'p su R LORDO con media negativa: il test e corretto, la serie no.',
};

function fmt(x: number | null | undefined, digits = 3): string {
  return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(digits) : 'n/d';
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export type CessationData = NonNullable<ShadowPanelData['cessation']>;

/**
 * CessazioneSection — blocco di sola lettura (Passo O).
 * Nessun POST, nessun endpoint nuovo, nessuna scrittura: legge la causa
 * dominante, i giorni necessari e l'assunzione dichiarata.
 */
export const CessationSection: React.FC<{ data?: ShadowPanelData['cessation'] | ShadowPanelData | null }> = ({ data }) => {
  const cess: any = (data && (data as any).cessation !== undefined) ? (data as any).cessation : data;
  if (cess === null || cess === undefined) return null;
  if (cess.available === false) {
    return (
      <div className={SECTION} data-testid="shadow-cessation" data-section="cessation" data-section-alt="cessazione">
        <div data-testid="shadow-cessazione" data-section="cessazione">Cessazione — sola lettura: non disponibile</div>
      </div>
    );
  }
  const rowsWithReason = cess.rowsWithReason ?? null;
  const dominantAfter = cess.dominantCauseAfter ?? 'n/d';
  const daysCal = cess.daysNeededCalendar ?? null;
  const daysEmit = cess.daysNeededEmitting ?? null;
  const breakdown = cess.reasonBreakdown ?? [];
  const ass = cess.assumption ?? 'n/d';
  const d = (n: number | null | undefined) => (typeof n === 'number' ? n.toFixed(1) : 'n/d');
  return (
    <div className={SECTION} data-testid="shadow-cessation" data-section="cessation">
      <div data-testid="shadow-cessazione" data-section="cessazione">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300">Cessazione — sola lettura</div>
        <div className="text-[11px] font-mono text-slate-400 space-y-1">
          <div>righe con reason: {rowsWithReason ?? 'n/d'}</div>
          <div>causa dominante dopo il 2026-10-28: {dominantAfter}</div>
          <div>giorni necessari (calendario): {d(daysCal)}</div>
          <div>giorni necessari (giorni con emissione): {d(daysEmit)}</div>
          <div>assunzione: <span className="text-slate-500">{ass}</span></div>
        </div>
        {breakdown.length > 0 && (
          <div className="mt-2">
            <div className="text-[11px] font-mono text-slate-500 mb-1">prima/dopo 2026-10-28 ( pt )</div>
            <table className="w-full text-[11px] font-mono">
              <thead className="text-slate-600">
                <tr>
                  <th className="text-left">causa</th>
                  <th className="text-right">prima</th>
                  <th className="text-right">dopo</th>
                  <th className="text-right">delta pt</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((b: any, i: number) => (
                  <tr key={i} className="text-slate-400 border-t border-slate-900">
                    <td className="text-left">{b.causa}</td>
                    <td className="text-right">{b.prima}</td>
                    <td className="text-right">{b.dopo}</td>
                    <td className="text-right">{b.deltaPt !== null ? b.deltaPt.toFixed(1) : 'n/d'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
export const CessazioneSection = CessationSection;
export const CausazioneSection = CessationSection;
export const Causazione = CessationSection;

export const ShadowResearchPanel: React.FC<{ data: ShadowPanelData | null }> = ({ data }) => {
  if (data === null || data.available !== true) {
    return (
      <div className={SECTION} data-testid="shadow-panel" data-section="empty">
        <div className="text-sm font-bold text-white">Shadow Research</div>
        <p className="text-xs text-slate-400">
          nessun artefatto{data?.reason ? ` (${data.reason})` : ''}: esegui{' '}
          <code className="text-purple-300">bun scripts/shadow_report.ts</code> e{' '}
          <code className="text-purple-300">bun scripts/ai_cycle.ts deathcheck</code>.
        </p>
      </div>
    );
  }

  const sample = data.sample ?? null;
  const nDays = sample?.nDays ?? null;
  const nClusters = sample?.nClusters ?? null;
  const thinSample = (nDays ?? 0) < 30 || (nClusters ?? 0) < 30;
  const dc = data.deathCriterion ?? null;
  const fillSuspect = data.fillIntegrity === 'suspect';
  const rules = data.rules ?? [];
  const proposals = data.proposals ?? [];
  const spread = data.spreadEstimate ?? null;
  const dsr = data.deflatedSharpe ?? null;
  const emissions = data.emissionsByDay ?? [];
  const limitations = data.limitations ?? [];
  const delta = spread?.deltaPct ?? null;

  return (
    <div className="space-y-3" data-testid="shadow-panel">
      {/* 1. banner campione */}
      <div
        className={`rounded-xl border p-4 ${thinSample ? 'border-amber-700/60 bg-amber-950/30' : 'border-slate-800 bg-slate-950'}`}
        data-testid="shadow-sample-banner"
        data-section="sample"
      >
        <div className="text-sm font-bold text-white">
          {`${nDays ?? 'n/d'} giorni · ${sample?.nSetups ?? 'n/d'} setup · ${nClusters ?? 'n/d'} cluster · barre a ${sample?.barMinutes ?? 'n/d'} minuti`}
        </div>
        {thinSample && (
          <div className="text-xs text-amber-300 mt-1">campione insufficiente per inferenza</div>
        )}
      </div>

      {/* 2. integrita' del fill — in testa se sospetta */}
      <div
        className={`${SECTION} ${fillSuspect ? 'border-red-700/70' : ''}`}
        data-testid="shadow-fill"
        data-section="fill"
        data-fill-integrity={data.fillIntegrity ?? 'unknown'}
      >
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300">Integrità del fill</div>
        {fillSuspect ? (
          <p className="text-xs text-red-300">
            gli R di questa superficie sono da rileggere: violazioni di monotonia sul target.
          </p>
        ) : (
          <p className="text-xs text-slate-400">
            fill coerente con la barriera, 0 violazioni su {sample?.nSetups ?? 'n/d'} righe emesse.
          </p>
        )}
      </div>

      {/* 3. criterio di morte */}
      <div className={SECTION} data-testid="shadow-death" data-section="death">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300">Criterio di morte</div>
        {dc ? (
          <div className="text-xs text-slate-300 space-y-1">
            <div>
              stato: <span className="font-bold text-white">{statusLabel(dc.status)}</span> · celle ammissibili{' '}
              {dc.nAdmissibleCells ?? 'n/d'} su {dc.nCells ?? 'n/d'}
            </div>
            <div>
              trigger: setup {dc.trigger.haveSetups ?? 'n/d'}/{dc.trigger.needSetups} · giorni{' '}
              {dc.trigger.haveDays ?? 'n/d'}/{dc.trigger.needDays}
            </div>
            <div>
              soglie: alphaEffective {fmt(dc.alphaEffective, 4)} · Bonferroni {fmt(dc.alphaBonferroni, 4)}
            </div>
            {dc.status === 'not_yet_evaluable' && (
              <div className="text-amber-300">
                bloccato: le emissioni sono ferme dal 2026-10-29, non un&apos;attesa.
              </div>
            )}
            <div className="text-slate-500">{dc.reason}</div>
          </div>
        ) : (
          <p className="text-xs text-slate-400">n/d</p>
        )}
      </div>

      {/* 4. emissioni per giorno */}
      <div className={SECTION} data-testid="shadow-emissions" data-section="emissions">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300">Emissioni per giorno</div>
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-[11px] font-mono">
            <thead className="text-slate-500">
              <tr>
                <th className="text-left">giorno</th>
                <th className="text-right">cand</th>
                <th className="text-right">emessi</th>
                <th className="text-right">bloccati</th>
                <th className="text-left pl-2">primo gate</th>
              </tr>
            </thead>
            <tbody>
              {emissions.map(e => (
                <tr
                  key={e.day}
                  data-day={e.day}
                  className={e.day === '2026-10-28' ? 'bg-amber-950/40 text-amber-200' : 'text-slate-400'}
                >
                  <td>{e.day}</td>
                  <td className="text-right">{e.candidates ?? 'n/d'}</td>
                  <td className="text-right">{e.emitted ?? 'n/d'}</td>
                  <td className="text-right">{e.blocked ?? 'n/d'}</td>
                  <td className="pl-2">{e.firstFailingGate ?? 'n/d'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 5. cessazione (sola lettura) */}
      <CessationSection data={data.cessation ?? data} />

      {/* 6. regole shadow */}
      <div className={SECTION} data-testid="shadow-rules" data-section="rules">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300">
          Regole shadow ({rules.length})
        </div>
        <table className="w-full text-[11px]">
          <thead className="text-slate-500">
            <tr>
              <th className="text-left">id</th>
              <th className="text-left">nome</th>
              <th className="text-left">famiglia</th>
              <th className="text-left">stato</th>
              <th className="text-right">valore</th>
              <th className="text-right">n</th>
            </tr>
          </thead>
          <tbody>
            {rules.map(r => {
              const scrutinio = NOT_INTERPRETABLE[r.id];
              return (
                <tr key={r.id} className="text-slate-300 border-t border-slate-900">
                  <td className="font-mono">{r.id}</td>
                  <td className="font-mono text-slate-400">{r.name}</td>
                  <td className="text-slate-500">{r.family}</td>
                  <td>
                    <span data-rule-status={r.status}>{scrutinio ? 'non interpretabile' : statusLabel(r.status)}</span>
                    {scrutinio && <div className="text-[10px] text-slate-500">{scrutinio}</div>}
                  </td>
                  <td className="text-right font-mono">{scrutinio ? fmt(r.value) : fmt(r.value, 4)}</td>
                  <td className="text-right font-mono">{r.n ?? 'n/d'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 6. spread e DSR */}
      <div className={SECTION} data-testid="shadow-spread" data-section="spread">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300">Spread stimato e DSR</div>
        <div className="text-[11px] font-mono text-slate-400">
          {(spread?.perSymbol ?? []).map(s => `${s.symbol}=${fmt(s.spreadPct, 4)}% (n=${s.n ?? 'n/d'})`).join(' · ') || 'n/d'}
        </div>
        <div className="text-xs text-slate-300">
          parametrico assunto {fmt(spread?.vsParametricPct, 2)}% · delta{' '}
          <span className={delta !== null && Math.abs(delta) > 0.05 ? 'text-amber-300 font-bold' : ''}>
            {fmt(delta, 4)} pt
          </span>
        </div>
        {spread && <div className="text-[11px] text-slate-500">{spread.caveat}</div>}
        <div className="text-xs text-slate-300 border-t border-slate-900 pt-2">
          nTrials {dsr?.nTrials ?? 'n/d'} (fonte: {dsr?.nTrialsSource ?? 'n/d'}) · DSR {fmt(dsr?.dsr, 3)} · p{' '}
          {fmt(dsr?.pValue, 4)} · Bonferroni {fmt(dsr?.alphaBonferroni, 4)} · alphaEffective{' '}
          {fmt(dsr?.alphaEffective, 4)}
        </div>
        <div className="text-[11px] text-slate-500">
          Le due soglie non sono equivalenti: Bonferroni divide per il numero di celle testate, alphaEffective per
          il numero di ipotesi già registrate. Qui la seconda è più severa della prima.
        </div>
      </div>

      {/* 7. proposte */}
      <div className={SECTION} data-testid="shadow-proposals" data-section="proposals">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300">Proposte</div>
        {proposals.length === 0 ? (
          <p className="text-xs text-slate-400">nessuna proposta formulata</p>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="text-slate-500">
              <tr>
                <th className="text-left">ipotesi</th>
                <th className="text-left">stato</th>
                <th className="text-right">holdout n</th>
                <th className="text-right">meanR</th>
                <th className="text-right">nullo p95</th>
                <th className="text-left pl-2">beatsNull</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map(p => (
                <tr key={p.hypothesisId} className="text-slate-300 border-t border-slate-900" data-proposal={p.hypothesisId}>
                  <td className="font-mono">{p.hypothesisId}</td>
                  <td>
                    <span data-proposal-status={p.status}>{statusLabel(p.status)}</span>
                  </td>
                  <td className="text-right font-mono">{p.holdoutN ?? 'n/d'}</td>
                  <td className="text-right font-mono">{fmt(p.meanRHoldout)}</td>
                  <td className="text-right font-mono">{fmt(p.meanRNullP95)}</td>
                  <td className="pl-2 font-mono">
                    {p.beatsNull === null ? (
                      <span className="text-slate-500">{p.nullReason ?? 'non interpretabile'}</span>
                    ) : (
                      String(p.beatsNull)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled
            title="nessun endpoint di promote testabile in questo passo"
            className="px-2.5 py-1 rounded bg-slate-800 text-slate-500 text-[11px] font-bold cursor-not-allowed"
          >
            PROMOTE
          </button>
          <span className="text-[10px] text-slate-500">
            disabilitato: promote non è raggiungibile da questo pannello
          </span>
        </div>
      </div>

      {/* limiti */}
      <div className={SECTION} data-testid="shadow-limits" data-section="limits">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300">Limiti dichiarati</div>
        <ul className="text-[11px] text-slate-400 space-y-1">
          {limitations.map((l, i) => (
            <li key={i}>· {l}</li>
          ))}
        </ul>
        {data.flags && (
          <div className="text-[10px] text-slate-500 font-mono pt-1">
            SETUP_SELECTOR_LIVE={data.flags.SETUP_SELECTOR_LIVE} · STALENESS_USE_MARKET_TS={data.flags.STALENESS_USE_MARKET_TS}
          </div>
        )}
      </div>
    </div>
  );
};

export default ShadowResearchPanel;
