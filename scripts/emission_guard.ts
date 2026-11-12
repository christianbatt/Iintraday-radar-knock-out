/**
 * scripts/emission_guard.ts — Passo N
 *
 * Due funzioni pure, usate dal replay (`delay_replay.ts` / `replay_adapter.ts`)
 * e testate senza eseguire la pipeline:
 *
 * 1. `applyEmissionGuard`: una sola emissione per (symbol, setupKey) per
 *    giornata di contrattazione, alla PRIMA decisione in cui la condizione e'
 *    vera. Le successive restano nel dataset come `emitted: false` con
 *    `reason: 'REEMISSIONE'`: non si cancellano righe, si declassano.
 *    Nessuna soglia, nessun gate, nessun parametro cambia.
 *
 * 2. `reasonFromGates`: traduce i gate G1..G13 in una delle 7 cause gia' usate
 *    dal lavoro, senza toccare calculator.ts.
 */

export type Row = {
  symbol: string;
  decisionTs: number;
  emitted: boolean;
  direction: string | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  gates: string[] | null;
  reason?: string | null;
};

/** Chiave del setup: (symbol, entry, stop). Stessa definizione di `setupKey` in ai_cycle.ts. */
export function setupKeyOf(r: Row): string {
  return `${r.symbol}|${r.entry}|${r.stop}`;
}

/** Giorno di contrattazione in UTC (le barre sono gia' normalizzate a UTC). */
export function dayOf(decisionTs: number): string {
  return new Date(decisionTs * 1000).toISOString().slice(0, 10);
}

/** Regola dichiarata di deduplica: si tiene la prima emissione (decisionTs minimo). */
export const KEPT_ROW_RULE = 'first_decisionTs' as const;

/**
 * Declassa le riemissioni intraday. Le righe restano, l'emissione no.
 * Regola: vince il decisionTs MINIMO del gruppo (symbol|entry|stop|giorno),
 * indipendentemente dall'ordine delle righe in input.
 */
export function applyEmissionGuard<T extends Row>(rows: T[]): T[] {
  // primo passo: decisionTs minimo per gruppo
  const minTs = new Map<string, number>();
  for (const r of rows) {
    if (!r.emitted) continue;
    const key = `${setupKeyOf(r)}|${dayOf(r.decisionTs)}`;
    const cur = minTs.get(key);
    if (cur === undefined || r.decisionTs < cur) minTs.set(key, r.decisionTs);
  }
  const keptSeen = new Set<string>();
  return rows.map(r => {
    if (!r.emitted) return r;
    const key = `${setupKeyOf(r)}|${dayOf(r.decisionTs)}`;
    if (r.decisionTs === minTs.get(key) && !keptSeen.has(key)) {
      keptSeen.add(key);
      return r;
    }
    return { ...r, emitted: false, reason: 'REEMISSIONE' };
  });
}

/** Le sette cause, nella stessa partizione usata dal lavoro. */
export const CAUSE_BY_GATE: Record<string, string> = {
  G1: 'liquidita',
  G2: 'struttura',
  G3: 'struttura',
  G4: 'leva',
  G5: 'rischio',
  G6: 'rischio',
  G7: 'orario',
  G8: 'barriera',
  G9: 'barriera',
  G10: 'vari',
  G11: 'vari',
  G12: 'vari',
  G13: 'vari',
};

export const CAUSES = ['liquidita', 'struttura', 'leva', 'rischio', 'orario', 'barriera', 'vari'] as const;

/**
 * Prima causa di blocco: il gate fallito con numero piu' basso.
 * Ritorna null se nessun gate risulta fallito (input mancante non e' un default).
 */
export function reasonFromGates(
  gateResults: Record<string, { passed?: boolean }> | null | undefined
): string | null {
  if (gateResults === null || gateResults === undefined) return null;
  const failed = Object.keys(gateResults)
    .filter(k => gateResults[k]?.passed === false)
    .sort((a, b) => Number(a.replace(/[^0-9]/g, '')) - Number(b.replace(/[^0-9]/g, '')));
  if (!failed.length) return null;
  const gate = failed[0];
  return CAUSE_BY_GATE[gate] ?? 'vari';
}

/** Etichetta diagnostica: causa + gate + messaggio, per il post-mortem. */
export function reasonLabel(
  gateResults: Record<string, { passed?: boolean; message?: string }> | null | undefined
): string | null {
  if (gateResults === null || gateResults === undefined) return null;
  const failed = Object.keys(gateResults)
    .filter(k => gateResults[k]?.passed === false)
    .sort((a, b) => Number(a.replace(/[^0-9]/g, '')) - Number(b.replace(/[^0-9]/g, '')));
  if (!failed.length) return null;
  const gate = failed[0];
  const cause = CAUSE_BY_GATE[gate] ?? 'vari';
  const msg = gateResults[gate]?.message;
  return typeof msg === 'string' && msg.length > 0 ? `${cause}:${gate}:${msg}` : `${cause}:${gate}`;
}
