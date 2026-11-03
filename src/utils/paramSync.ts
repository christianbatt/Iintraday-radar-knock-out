export interface ParamSyncResult {
  result: any;
  conflict: boolean;
}

// Chiavi punteggio: valori sopra 100 vengono corretti (sopra 1000 diviso 1000, altrimenti fallback)
const SCORE_FALLBACK: any = {
  minScore: 90,
  minScoreEurope: 90,
  minScoreUSA: 92,
};

export function loadParameters(saved: string | null, baseline: any): any {
  if (saved) {
    try {
      const parsed: unknown = JSON.parse(saved);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...baseline, ...parsed };
      }
    } catch {
      // JSON non valido: usa la baseline
    }
  }
  return { ...baseline };
}

function sameContent(a: any, b: any): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

export function resolveRemoteParameters(local: any, remote: any, baseline: any): ParamSyncResult {
  if (!remote || typeof remote.version !== 'number') return { result: local, conflict: false };
  if (local.version > remote.version) return { result: local, conflict: false };
  if (remote.version === local.version) {
    return sameContent(local, remote)
      ? { result: local, conflict: false }
      : { result: local, conflict: true };
  }
  const merged: any = { ...baseline, ...remote };
  for (const k of Object.keys(SCORE_FALLBACK)) {
    const v = merged[k];
    if (typeof v === 'number' && v > 100) {
      merged[k] = v > 1000 ? Math.round(v / 1000) : SCORE_FALLBACK[k];
    }
  }
  return { result: merged, conflict: false };
}

// Sanitizzazione dei punteggi minimi: usata sia nel polling sia nel callback Firebase.
// Stessa regola di performSync: valore > 100 -> se > 1000 diviso 1000, altrimenti fallback.
export function sanitizeScoreParameters<T extends Record<string, any>>(params: T): T {
  const out: any = { ...params };
  for (const k of Object.keys(SCORE_FALLBACK)) {
    const v = out[k];
    if (typeof v === 'number' && v > 100) {
      out[k] = v > 1000 ? Math.round(v / 1000) : SCORE_FALLBACK[k];
    }
  }
  return out as T;
}

// Polling (performSync): con locale assente la versione locale vale 0.
export function shouldApplyPolledParameters(local: any, remote: any): boolean {
  if (!remote || typeof remote.version !== 'number') return false;
  return remote.version > (local?.version || 0);
}

// Callback Firebase: con locale assente applica sempre.
// Differenza voluta rispetto al polling: non unificare le due funzioni.
export function shouldApplyCloudParameters(local: any, remote: any): boolean {
  if (!remote || typeof remote.version !== 'number') return false;
  if (!local) return true;
  return remote.version > local.version;
}

// Il push al server è necessario solo se la versione locale non è quella già applicata dal cloud.
export function shouldPushLocalParameters(parameters: any, lastAppliedRemoteVersion: number | null): boolean {
  if (!parameters || typeof parameters.version !== 'number') return false;
  return parameters.version !== lastAppliedRemoteVersion;
}
