/**
 * Potenza statistica (Fase 5.1).
 *
 * La domanda a cui risponde: quanti trade servono perché un differenziale di R
 * sia distinguibile dal rumore? Senza questo numero, ogni lettura di `edgeR` su
 * dieci casi è un'opinione.
 *
 * Approssimazione dichiarata: test t a una coda di segno, ma con quantili
 * normali (campionе grande). Non è una promessa, è un ordine di grandezza onesto
 * — e la formula è quella classica n = (z_{1-α/2} + z_power)² · σ² / δ².
 */

export const AI_POWER_DEFAULT_ALPHA = 0.05;
export const AI_POWER_DEFAULT_POWER = 0.8;
/** Effetto che il desk deve poter distinguere, in R netti per trade. */
export const AI_POWER_TARGET_EFFECT_R = 0.1;

/** Quantile della normale standard (Acklam, errore relativo < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return Number.NaN;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  q = p - 0.5;
  r = q * q;
  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

export interface PowerRequest {
  /** Varianza del R netto per trade (σ²). */
  varianceR: number;
  /** Effetto da rilevare, in R netti. */
  effectR: number;
  alpha?: number;
  power?: number;
}

export interface PowerEstimate {
  n: number;
  alpha: number;
  power: number;
  method: 'normal-approximation-one-mean';
}

/**
 * Campione minimo per rilevare `effectR` con la varianza data.
 * `null` quando l'input non permette una stima: effetto o varianza non positivi,
 * valori non finiti, alpha/potenza fuori da (0,1).
 */
export function requiredSampleSize(request: PowerRequest): PowerEstimate | null {
  const variant = Number(request?.varianceR);
  const effect = Number(request?.effectR);
  const alpha = request?.alpha ?? AI_POWER_DEFAULT_ALPHA;
  const power = request?.power ?? AI_POWER_DEFAULT_POWER;
  if (!Number.isFinite(variant) || variant <= 0) return null;
  if (!Number.isFinite(effect) || effect === 0) return null;
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) return null;
  if (!Number.isFinite(power) || power <= 0 || power >= 1) return null;

  const zAlpha = normalQuantile(1 - alpha / 2);
  const zPower = normalQuantile(power);
  if (!Number.isFinite(zAlpha) || !Number.isFinite(zPower)) return null;
  const raw = ((zAlpha + zPower) ** 2) * variant / effect ** 2;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return {
    n: Math.max(2, Math.ceil(raw)),
    alpha,
    power,
    method: 'normal-approximation-one-mean',
  };
}

/** Varianza campionaria (denominatore n-1); `null` sotto due valori. */
export function sampleVariance(values: readonly number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length < 2) return null;
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  const squares = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return squares / (clean.length - 1);
}

/**
 * Riga per l'utente: "servono N trade per rilevare +0,1 R; ne hai M".
 * Quando non si può stimare, lo dice invece di mostrare un numero inventato.
 */
export function formatPowerLine(input: {
  requiredN: number | null;
  observedN: number;
  effectR?: number;
}): string {
  const effect = Number.isFinite(input.effectR) ? Number(input.effectR) : AI_POWER_TARGET_EFFECT_R;
  const effectText = `${effect > 0 ? '+' : ''}${effect.toFixed(2)} R`;
  const observed = Math.max(0, Math.floor(Number(input.observedN) || 0));
  if (input.requiredN === null || !Number.isFinite(input.requiredN)) {
    return `Campione troppo piccolo per stimare la potenza su ${effectText}: ne hai ${observed}.`;
  }
  const required = Math.ceil(input.requiredN);
  const verdict =
    observed >= required
      ? `campione sufficiente (${observed} ≥ ${required})`
      : `mancano ${required - observed} trade`;
  return `Per rilevare ${effectText} servono ${required} trade; ne hai ${observed} — ${verdict}.`;
}
