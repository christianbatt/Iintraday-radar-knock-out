/**
 * VALIDATORE DETERMINISTICO DEL DESK AI (`ai-desk-validation@2`).
 *
 * La calibrazione (PR-C, `src/server/aiCalibration.ts`) misura lo scarto di
 * rendimento fra cio' che il desk AI ha approvato (`AZIONE`) e cio' che ha
 * scartato (`SCARTO`). Fin qui il desk resta `NON_VALIDATO`: la vista e'
 * esplorativa e nessun numero viene presentato come validazione.
 *
 * Questo modulo applica regole FISSE, dichiarate PRIMA di guardare i dati, e
 * risponde con un verdetto:
 *
 *   INSUFFICIENTE   il campione non permette di pronunciarsi
 *   NON_CONFERMATO  il campione e' adeguato ma le regole non sono rispettate
 *   CONFERMATO      tutte le regole sono rispettate: il desk e' VALIDATO
 *
 * Regole (tutte inclusive sul bordo, nessuna adattiva):
 *
 * | Codice             | Regola                                              |
 * |--------------------|-----------------------------------------------------|
 * | `sample_classified`| casi classificati (AZIONE+ATTESA+SCARTO) >= 30       |
 * | `sample_per_bucket`| almeno 10 AZIONE e 10 SCARTO (le medie servono)      |
 * | `sample_integrity` | SCONOSCIUTO <= 30% degli abbinamenti                 |
 * | `edge_r`           | edgeR >= +0.2 R                                      |
 * | `win_rate_gap`     | successo AZIONE - successo SCARTO >= 10 punti        |
 * | `net_profitability`| meanRNet(AZIONE) >= +0,1 R (redditività assoluta)   |
 *
 * Perche' serve `net_profitability`: `edge_r` e' una DIFFERENZA di medie, e un
 * costo costante per trade si semplifica nella differenza. Un desk puo' quindi
 * discriminare bene ed essere comunque in perdita su ogni trade preso. Il
 * check chiede che la spazzatura non venga chiamata validazione: AZIONE deve
 * essere positiva al netto dei costi dichiarati. Senza il dato il check e'
 * `insufficient`, mai un pass implicito.
 *
 * Puro e deterministico: nessun I/O, nessuna LLM, nessun orologio, nessuna
 * scrittura. Stesso input => stesso verdetto. Non tocca gate, memoria AI o
 * selezione dei setup, e non riscrive lo `status: NON_VALIDATO` delle righe del
 * log storico: pubblica solo il verdetto su questa vista.
 */

export const AI_DESK_VALIDATION_VERSION = 'ai-desk-validation@2';

/** Soglia di campione classificato (la stessa della calibrazione). */
export const AI_DESK_VALIDATION_MIN_CLASSIFIED = 30;
/**
 * Minimo per bucket: una media su meno di 10 casi e' troppo rumorosa per
 * sostenere una differenza. Vale per entrambi i lati del confronto.
 */
export const AI_DESK_VALIDATION_MIN_PER_BUCKET = 10;
/** Edge minimo per parlare di discriminazione: 0.2 R di differenza fra medie. */
export const AI_DESK_VALIDATION_MIN_EDGE_R = 0.2;
/** Divario minimo di successo fra AZIONE e SCARTO, in punti percentuali. */
export const AI_DESK_VALIDATION_MIN_WIN_RATE_GAP_PCT = 10;
/** Quota massima di abbinamenti in SCONOSCIUTO: oltre, il campione e' sporco. */
export const AI_DESK_VALIDATION_MAX_UNKNOWN_SHARE = 0.3;
/**
 * Redditività minima per trade di AZIONE, al netto dei costi dichiarati.
 * Una soglia positiva (non solo `> 0`) lascia un margine: un desk che guadagna
 * 0,01 R per trade non copre la varianza che si porta dietro.
 */
export const AI_DESK_VALIDATION_MIN_NET_R = 0.1;

export type AiDeskValidationVerdict = 'CONFERMATO' | 'NON_CONFERMATO' | 'INSUFFICIENTE';
export type AiDeskValidationCheckCode =
  | 'sample_classified'
  | 'sample_per_bucket'
  | 'sample_integrity'
  | 'edge_r'
  | 'edge_r_ci'
  | 'win_rate_gap'
  | 'net_profitability';
/**
 * `insufficient` non e' un fallimento del desk: e' l'impossibilita' di
 * misurare (campione corto, bucket vuoto, quoziente non calcolabile).
 */
export type AiDeskValidationCheckStatus = 'pass' | 'fail' | 'insufficient';

export interface AiDeskValidationCheck {
  code: AiDeskValidationCheckCode;
  label: string;
  status: AiDeskValidationCheckStatus;
  /** Valore osservato (null quando non calcolabile). */
  observed: number | null;
  /** Soglia applicata, sempre positiva e dichiarata. */
  threshold: number;
  unit: 'count' | 'R' | 'pct' | 'share';
  detail: string;
}

export interface AiDeskValidation {
  version: typeof AI_DESK_VALIDATION_VERSION;
  verdict: AiDeskValidationVerdict;
  /** Stato del desk derivato dal verdetto: VALIDATO solo se CONFERMATO. */
  deskStatus: 'VALIDATO' | 'NON_VALIDATO';
  /** Frase breve con i numeri che hanno deciso il verdetto. */
  headline: string;
  minClassified: number;
  minPerBucket: number;
  minEdgeR: number;
  minWinRateGapPct: number;
  maxUnknownShare: number;
  /** Soglia di redditività netta applicata ad AZIONE. */
  minNetR: number;
  checks: AiDeskValidationCheck[];
  limitations: string[];
}

/** Forma strutturale del bucket di calibrazione (nessun import: niente cicli). */
export interface AiDeskValidationBucket {
  decision: string;
  n: number;
  meanR?: number | null;
  /**
   * R medio al netto dei costi dichiarati. Serve al check `net_profitability`:
   * `meanR` lordo non dice se il trade ha guadagnato davvero.
   */
  meanRNet?: number | null;
  winRatePct?: number | null;
  /** Successo al netto dei costi dichiarati: preferito a `winRatePct` quando c'e'. */
  winRateNetPct?: number | null;
}

export interface AiDeskValidationAlertLike {
  code: string;
}

export interface AiDeskValidationInput {
  /** Casi classificati dichiarati dalla calibrazione (fallback: dai bucket). */
  classified?: number;
  buckets?: readonly AiDeskValidationBucket[];
  edgeR?: number | null;
  /** Edge netto di costi: se presente vince su `edgeR`. */
  edgeRNet?: number | null;
  alerts?: readonly AiDeskValidationAlertLike[];
  /**
   * Intervalli deterministici sul R netto. Quando presenti, il check
   * `edge_r_ci` chiede che il limite inferiore dell'edge sia > 0; quando
   * assenti (risposte storiche o campione troppo corto) il check non esiste e
   * il verdetto resta quello delle regole puntuali.
   */
  uncertainty?: {
    edgeR?: { lower: number; upper: number } | null;
    winRateGapPct?: { lower: number; upper: number } | null;
  } | null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function bucketOf(buckets: readonly AiDeskValidationBucket[], decision: string): AiDeskValidationBucket | null {
  for (const bucket of buckets) {
    if (bucket && bucket.decision === decision) return bucket;
  }
  return null;
}

function nOf(buckets: readonly AiDeskValidationBucket[], decision: string): number {
  const bucket = bucketOf(buckets, decision);
  if (!bucket || !finite(bucket.n)) return 0;
  return Math.max(0, Math.floor(bucket.n));
}

/**
 * Applica le regole al campione gia' aggregato. Pura: non lancia, non legge,
 * non scrive; input incompleto => `INSUFFICIENTE`, mai un verdetto inventato.
 */
export function validateAiDeskSample(input: AiDeskValidationInput): AiDeskValidation {
  const buckets = Array.isArray(input.buckets) ? input.buckets.filter(Boolean) : [];
  const actionN = nOf(buckets, 'AZIONE');
  const skipN = nOf(buckets, 'SCARTO');
  const unknownN = nOf(buckets, 'SCONOSCIUTO');
  const matched = buckets.reduce((total, bucket) => total + Math.max(0, Math.floor(finite(bucket.n) ? bucket.n : 0)), 0);
  const classifiedFromBuckets = actionN + skipN + nOf(buckets, 'ATTESA');
  const classified = finite(input.classified)
    ? Math.max(0, Math.floor(input.classified))
    : classifiedFromBuckets;
  const unknownShare = matched > 0 ? unknownN / matched : null;
  // Preferenza dichiarata per i valori NETTI: se la calibrazione li fornisce,
  // le regole si applicano al netto dei costi, non al lordo di prezzo.
  const netEdge = finite(input.edgeRNet) ? input.edgeRNet : null;
  const edgeR = netEdge !== null ? netEdge : finite(input.edgeR) ? input.edgeR : null;
  const edgeIsNet = netEdge !== null;

  const action = bucketOf(buckets, 'AZIONE');
  const skip = bucketOf(buckets, 'SCARTO');
  const winOf = (bucket: AiDeskValidationBucket | null): number | null => {
    if (!bucket) return null;
    if (finite(bucket.winRateNetPct)) return bucket.winRateNetPct;
    if (finite(bucket.winRatePct)) return bucket.winRatePct;
    return null;
  };
  const actionWin = winOf(action);
  const skipWin = winOf(skip);
  const winRateGap =
    actionWin !== null && skipWin !== null ? round(actionWin - skipWin, 2) : null;

  const checks: AiDeskValidationCheck[] = [];

  checks.push({
    code: 'sample_classified',
    label: 'campione classificato',
    status: classified >= AI_DESK_VALIDATION_MIN_CLASSIFIED ? 'pass' : 'insufficient',
    observed: classified,
    threshold: AI_DESK_VALIDATION_MIN_CLASSIFIED,
    unit: 'count',
    detail: `${classified} casi classificati (soglia ${AI_DESK_VALIDATION_MIN_CLASSIFIED}).`,
  });

  const smallestBucket = Math.min(actionN, skipN);
  checks.push({
    code: 'sample_per_bucket',
    label: 'numerosita per bucket',
    status: smallestBucket >= AI_DESK_VALIDATION_MIN_PER_BUCKET ? 'pass' : 'insufficient',
    observed: smallestBucket,
    threshold: AI_DESK_VALIDATION_MIN_PER_BUCKET,
    unit: 'count',
    detail:
      `AZIONE ${actionN}, SCARTO ${skipN}: il lato piu' piccolo ha ${smallestBucket} casi ` +
      `(soglia ${AI_DESK_VALIDATION_MIN_PER_BUCKET}).`,
  });

  // `COVERAGE_LOW` degrada il campione quanto un formato rotto: se il desk non
  // ha visto i candidati, le regole misurano la pipeline e non la selezione.
  const degradingAlert = (Array.isArray(input.alerts) ? input.alerts : []).some(
    (alert) =>
      alert &&
      (alert.code === 'UNKNOWN_SHARE_HIGH' ||
        alert.code === 'DIRECTIVES_SHARE_HIGH' ||
        alert.code === 'COVERAGE_LOW')
  );
  checks.push({
    code: 'sample_integrity',
    label: 'integrita del campione',
    status:
      unknownShare === null
        ? 'insufficient'
        : unknownShare <= AI_DESK_VALIDATION_MAX_UNKNOWN_SHARE && !degradingAlert
          ? 'pass'
          : 'insufficient',
    observed: unknownShare === null ? null : round(unknownShare, 4),
    threshold: AI_DESK_VALIDATION_MAX_UNKNOWN_SHARE,
    unit: 'share',
    detail:
      unknownShare === null
        ? 'nessun abbinamento: quota SCONOSCIUTO non calcolabile.'
        : `${unknownN}/${matched} abbinamenti in SCONOSCIUTO (` +
          `${round(unknownShare * 100, 1)}%, soglia ${round(AI_DESK_VALIDATION_MAX_UNKNOWN_SHARE * 100, 0)}%)` +
          (degradingAlert ? ' con allarme di formato attivo.' : '.'),
  });

  checks.push({
    code: 'edge_r',
    label: 'edgeR netto di costi',
    status: edgeR === null ? 'insufficient' : edgeR >= AI_DESK_VALIDATION_MIN_EDGE_R ? 'pass' : 'fail',
    observed: edgeR,
    threshold: AI_DESK_VALIDATION_MIN_EDGE_R,
    unit: 'R',
    detail:
      edgeR === null
        ? 'edgeR non calcolabile: manca AZIONE o SCARTO con esiti.'
        : `edgeR${edgeIsNet ? ' netto' : ''} ${edgeR} R (soglia +${AI_DESK_VALIDATION_MIN_EDGE_R} R).`,
  });

  checks.push({
    code: 'win_rate_gap',
    label: 'divario di successo',
    status:
      winRateGap === null
        ? 'insufficient'
        : winRateGap >= AI_DESK_VALIDATION_MIN_WIN_RATE_GAP_PCT
          ? 'pass'
          : 'fail',
    observed: winRateGap,
    threshold: AI_DESK_VALIDATION_MIN_WIN_RATE_GAP_PCT,
    unit: 'pct',
    detail:
      winRateGap === null
        ? 'divario non calcolabile: manca il successo di AZIONE o di SCARTO.'
        : `successo AZIONE ${actionWin}% - SCARTO ${skipWin}% = ${winRateGap} punti ` +
          `(soglia ${AI_DESK_VALIDATION_MIN_WIN_RATE_GAP_PCT}).`,
  });

  // Redditività ASSOLUTA. `edge_r` misura una differenza di medie: un costo
  // costante per trade si semplifica, quindi un desk può discriminare bene ed
  // essere comunque in perdita. Questo check chiede che AZIONE sia positiva al
  // netto; senza il dato resta `insufficient`, mai un pass implicito.
  const actionMeanRNet = action && finite(action.meanRNet) ? action.meanRNet : null;
  checks.push({
    code: 'net_profitability',
    label: 'redditività netta di AZIONE',
    status:
      actionMeanRNet === null
        ? 'insufficient'
        : actionMeanRNet >= AI_DESK_VALIDATION_MIN_NET_R
          ? 'pass'
          : 'fail',
    observed: actionMeanRNet,
    threshold: AI_DESK_VALIDATION_MIN_NET_R,
    unit: 'R',
    detail:
      actionMeanRNet === null
        ? 'meanRNet(AZIONE) non disponibile: la differenza edgeR non basta a dire se il desk guadagna.'
        : `meanRNet(AZIONE) ${actionMeanRNet} R (soglia +${AI_DESK_VALIDATION_MIN_NET_R} R): ` +
          (actionMeanRNet >= AI_DESK_VALIDATION_MIN_NET_R
            ? 'positiva al netto dei costi dichiarati.'
            : 'la differenza fra AZIONE e SCARTO non compensa il costo per trade.'),
  });

  // Incertezza: solo se il chiamante fornisce gli intervalli. Regola dichiarata:
  // il limite inferiore dell'edge netto deve stare sopra zero. E' una richiesta
  // di SEGNO, non di magnitudine: la soglia +0.2 R resta sul punto.
  const uncertainty =
    input.uncertainty && typeof input.uncertainty === 'object' ? input.uncertainty : null;
  if (uncertainty) {
    const interval =
      uncertainty.edgeR &&
      finite(uncertainty.edgeR.lower) &&
      finite(uncertainty.edgeR.upper)
        ? uncertainty.edgeR
        : null;
    checks.push({
      code: 'edge_r_ci',
      label: 'edgeR positivo al 95%',
      status: interval === null ? 'insufficient' : interval.lower > 0 ? 'pass' : 'fail',
      observed: interval === null ? null : interval.lower,
      threshold: 0,
      unit: 'R',
      detail:
        interval === null
          ? 'intervallo non calcolabile: servono almeno 2 esiti per lato.'
          : `limite inferiore IC95% ${interval.lower} R (superiore ${interval.upper} R): ` +
            (interval.lower > 0
              ? 'edge positivo anche nel caso sfavorevole.'
              : 'edge non distinguibile da zero: il punto non basta.'),
    });
  }

  const insufficient = checks.filter((check) => check.status === 'insufficient');
  const failed = checks.filter((check) => check.status === 'fail');
  const verdict: AiDeskValidationVerdict =
    insufficient.length > 0 ? 'INSUFFICIENTE' : failed.length > 0 ? 'NON_CONFERMATO' : 'CONFERMATO';

  const headline =
    verdict === 'CONFERMATO'
      ? `CONFERMATO: ${classified} casi classificati, edgeR ${edgeR} R, ` +
        `divario di successo ${winRateGap} punti.`
      : verdict === 'NON_CONFERMATO'
        ? `NON CONFERMATO: ${failed.map((check) => check.detail).join(' ')}`
        : `INSUFFICIENTE: ${insufficient.map((check) => check.detail).join(' ')}`;

  return {
    version: AI_DESK_VALIDATION_VERSION,
    verdict,
    deskStatus: verdict === 'CONFERMATO' ? 'VALIDATO' : 'NON_VALIDATO',
    headline,
    minClassified: AI_DESK_VALIDATION_MIN_CLASSIFIED,
    minPerBucket: AI_DESK_VALIDATION_MIN_PER_BUCKET,
    minEdgeR: AI_DESK_VALIDATION_MIN_EDGE_R,
    minWinRateGapPct: AI_DESK_VALIDATION_MIN_WIN_RATE_GAP_PCT,
    maxUnknownShare: AI_DESK_VALIDATION_MAX_UNKNOWN_SHARE,
    minNetR: AI_DESK_VALIDATION_MIN_NET_R,
    checks,
    limitations: [
      'Deterministico e in sola lettura: nessun I/O, nessuna LLM, nessuna scrittura; lo stesso campione produce sempre lo stesso verdetto.',
      'Conferma solo questa vista: non riscrive lo status NON_VALIDATO delle righe del log, non cambia memoria AI, gate o selezione dei setup.',
      'Con edgeR/misure nette fornite, le regole si applicano al netto dei costi; senza, restano sul lordo di prezzo. In nessun caso dimostrano che la decisione AI abbia causato l esito.',
      'Redditività: `edge_r` e `win_rate_gap` misurano una differenza fra AZIONE e SCARTO, in cui un costo costante per trade si semplifica. Solo `net_profitability` chiede che AZIONE sia positiva al netto (soglia +0,1 R): un desk può discriminare bene e perdere su ogni trade preso.',
      'Le soglie sono dichiarate prima dei dati e inclusive sul bordo; un campione troncato o sporco resta INSUFFICIENTE.',
      'Se forniti, gli intervalli bootstrap richiedono solo un edge di segno positivo (limite inferiore > 0): non dimostrano che l edge superi 0.2 R con il 95% di confidenza.',
    ],
  };
}
