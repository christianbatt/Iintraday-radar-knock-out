/**
 * Test del validatore deterministico del desk (`ai-desk-validation@1`).
 *
 * Dati SINTETICI: nessuna misura di performance, nessuna LLM. Le soglie sono
 * quelle dichiarate nel modulo e i casi verificano anche i bordi (uguale alla
 * soglia = passa, perche' le regole sono inclusive).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_DESK_VALIDATION_MAX_UNKNOWN_SHARE,
  AI_DESK_VALIDATION_MIN_CLASSIFIED,
  AI_DESK_VALIDATION_MIN_EDGE_R,
  AI_DESK_VALIDATION_MIN_PER_BUCKET,
  AI_DESK_VALIDATION_MIN_WIN_RATE_GAP_PCT,
  AI_DESK_VALIDATION_VERSION,
  validateAiDeskSample,
  type AiDeskValidationInput,
} from '../../server/aiDeskValidator';

/** Campione forte: 40 classificati, 20/14 nei due lati, edge 0.7 R, gap 20 pt. */
function strongSample(override: Partial<AiDeskValidationInput> = {}): AiDeskValidationInput {
  return {
    classified: 40,
    buckets: [
      { decision: 'AZIONE', n: 20, meanR: 0.8, winRatePct: 60 },
      { decision: 'ATTESA', n: 6, meanR: 0.1, winRatePct: 50 },
      { decision: 'SCARTO', n: 14, meanR: 0.1, winRatePct: 40 },
      { decision: 'SCONOSCIUTO', n: 2, meanR: null, winRatePct: null },
    ],
    edgeR: 0.7,
    alerts: [],
    ...override,
  };
}

describe('aiDeskValidator — soglie dichiarate', () => {
  it('espone le costanti usate nei controlli', () => {
    assert.equal(AI_DESK_VALIDATION_VERSION, 'ai-desk-validation@1');
    assert.equal(AI_DESK_VALIDATION_MIN_CLASSIFIED, 30);
    assert.equal(AI_DESK_VALIDATION_MIN_PER_BUCKET, 10);
    assert.equal(AI_DESK_VALIDATION_MIN_EDGE_R, 0.2);
    assert.equal(AI_DESK_VALIDATION_MIN_WIN_RATE_GAP_PCT, 10);
    assert.equal(AI_DESK_VALIDATION_MAX_UNKNOWN_SHARE, 0.3);
  });
});

describe('aiDeskValidator — verdetto', () => {
  it('campione forte: CONFERMATO e desk VALIDATO', () => {
    const out = validateAiDeskSample(strongSample());
    assert.equal(out.verdict, 'CONFERMATO');
    assert.equal(out.deskStatus, 'VALIDATO');
    assert.match(out.headline, /CONFERMATO/);
    assert.ok(out.checks.every((check) => check.status === 'pass'));
  });

  it('campione corto: INSUFFICIENTE, mai un verdetto inventato', () => {
    const out = validateAiDeskSample({
      classified: 3,
      buckets: [
        { decision: 'AZIONE', n: 2, meanR: 1, winRatePct: 100 },
        { decision: 'SCARTO', n: 1, meanR: 0, winRatePct: 0 },
      ],
      edgeR: 1,
    });
    assert.equal(out.verdict, 'INSUFFICIENTE');
    assert.equal(out.deskStatus, 'NON_VALIDATO');
    assert.equal(
      out.checks.find((check) => check.code === 'sample_classified')?.status,
      'insufficient'
    );
    assert.match(out.headline, /INSUFFICIENTE/);
  });

  it('campione sufficiente ma lato SCARTO vuoto: INSUFFICIENTE (media non confrontabile)', () => {
    const out = validateAiDeskSample({
      classified: 40,
      buckets: [
        { decision: 'AZIONE', n: 40, meanR: 0.9, winRatePct: 65 },
        { decision: 'SCARTO', n: 0, meanR: null, winRatePct: null },
      ],
      edgeR: null,
    });
    assert.equal(out.verdict, 'INSUFFICIENTE');
    assert.equal(out.checks.find((check) => check.code === 'sample_per_bucket')?.status, 'insufficient');
    assert.equal(out.checks.find((check) => check.code === 'edge_r')?.status, 'insufficient');
  });

  it('edge sotto soglia: NON_CONFERMATO', () => {
    const out = validateAiDeskSample(strongSample({ edgeR: 0.1 }));
    assert.equal(out.verdict, 'NON_CONFERMATO');
    assert.equal(out.deskStatus, 'NON_VALIDATO');
    assert.equal(out.checks.find((check) => check.code === 'edge_r')?.status, 'fail');
    assert.match(out.headline, /NON CONFERMATO/);
  });

  it('divario di successo sotto soglia: NON_CONFERMATO anche con edge buono', () => {
    const out = validateAiDeskSample(
      strongSample({
        buckets: [
          { decision: 'AZIONE', n: 20, meanR: 0.8, winRatePct: 52 },
          { decision: 'SCARTO', n: 14, meanR: 0.1, winRatePct: 46 },
          { decision: 'SCONOSCIUTO', n: 0, meanR: null, winRatePct: null },
        ],
      })
    );
    assert.equal(out.verdict, 'NON_CONFERMATO');
    assert.equal(out.checks.find((check) => check.code === 'win_rate_gap')?.status, 'fail');
    assert.equal(out.checks.find((check) => check.code === 'edge_r')?.status, 'pass');
  });

  it('preferisce i valori netti: gap netto sotto soglia => NON_CONFERMATO', () => {
    const out = validateAiDeskSample({
      classified: 40,
      buckets: [
        // Lordo: 60% vs 40% (gap 20). Netto: 48% vs 42% (gap 6, sotto soglia 10).
        { decision: 'AZIONE', n: 20, meanR: 0.8, winRatePct: 60, winRateNetPct: 48 },
        { decision: 'SCARTO', n: 14, meanR: 0.1, winRatePct: 40, winRateNetPct: 42 },
        { decision: 'SCONOSCIUTO', n: 0, meanR: null, winRatePct: null },
      ],
      edgeR: 0.7,
      edgeRNet: 0.7,
    });
    assert.equal(out.verdict, 'NON_CONFERMATO');
    const gap = out.checks.find((check) => check.code === 'win_rate_gap');
    assert.equal(gap?.observed, 6);
    assert.equal(gap?.status, 'fail');
    assert.match(
      out.checks.find((check) => check.code === 'edge_r')?.detail ?? '',
      /edgeR netto/
    );
  });

  it('SCONOSCIUTO sopra il 30%: campione sporco => INSUFFICIENTE', () => {
    const out = validateAiDeskSample(
      strongSample({
        buckets: [
          { decision: 'AZIONE', n: 20, meanR: 0.8, winRatePct: 60 },
          { decision: 'SCARTO', n: 14, meanR: 0.1, winRatePct: 40 },
          { decision: 'SCONOSCIUTO', n: 16, meanR: null, winRatePct: null },
        ],
      })
    );
    assert.equal(out.verdict, 'INSUFFICIENTE');
    assert.equal(out.checks.find((check) => check.code === 'sample_integrity')?.status, 'insufficient');
  });

  it('allarme di formato attivo: il campione non basta anche con quota bassa', () => {
    const out = validateAiDeskSample(
      strongSample({ alerts: [{ code: 'DIRECTIVES_SHARE_HIGH' }] })
    );
    assert.equal(out.verdict, 'INSUFFICIENTE');
    assert.equal(out.checks.find((check) => check.code === 'sample_integrity')?.status, 'insufficient');
  });
});

describe('aiDeskValidator — bordi e determinismo', () => {
  it('soglie inclusive: esattamente 30, 10/10, 0.2 R e 10 punti => CONFERMATO', () => {
    const out = validateAiDeskSample({
      classified: 30,
      buckets: [
        { decision: 'AZIONE', n: 10, meanR: 0.3, winRatePct: 50 },
        { decision: 'ATTESA', n: 10, meanR: 0, winRatePct: 50 },
        { decision: 'SCARTO', n: 10, meanR: 0.1, winRatePct: 40 },
      ],
      edgeR: 0.2,
    });
    assert.equal(out.verdict, 'CONFERMATO');
  });

  it('stesso input => stesso output, e nessuna mutazione dell input', () => {
    const input = strongSample();
    const snapshot = JSON.stringify(input);
    const first = validateAiDeskSample(input);
    const second = validateAiDeskSample(input);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(input), snapshot);
    assert.equal(first.version, 'ai-desk-validation@1');
    assert.ok(first.limitations.some((line) => line.includes('NON_VALIDATO')));
  });

  it('input vuoto: INSUFFICIENTE senza lanciare', () => {
    const out = validateAiDeskSample({});
    assert.equal(out.verdict, 'INSUFFICIENTE');
    assert.equal(out.checks.length, 5);
    assert.equal(out.checks.find((check) => check.code === 'win_rate_gap')?.observed, null);
  });
});

describe('aiDeskValidator — incertezza e copertura', () => {
  it('senza intervalli il check non esiste: risposte storiche invariate', () => {
    const out = validateAiDeskSample(strongSample());
    assert.equal(out.checks.some((check) => check.code === 'edge_r_ci'), false);
    assert.equal(out.verdict, 'CONFERMATO');
  });

  it('limite inferiore sopra zero: check superato e CONFERMATO', () => {
    const out = validateAiDeskSample(
      strongSample({ uncertainty: { edgeR: { lower: 0.05, upper: 1.1 } } })
    );
    const check = out.checks.find((item) => item.code === 'edge_r_ci');
    assert.equal(check?.status, 'pass');
    assert.equal(check?.observed, 0.05);
    assert.equal(out.verdict, 'CONFERMATO');
  });

  it('intervallo che tocca lo zero: NON_CONFERMATO anche con stime puntuali forti', () => {
    const out = validateAiDeskSample(
      strongSample({ uncertainty: { edgeR: { lower: -0.15, upper: 1.4 } } })
    );
    assert.equal(out.checks.find((item) => item.code === 'edge_r_ci')?.status, 'fail');
    assert.equal(out.verdict, 'NON_CONFERMATO');
  });

  it('intervallo non calcolabile: INSUFFICIENTE, mai un verdetto inventato', () => {
    const out = validateAiDeskSample(strongSample({ uncertainty: { edgeR: null } }));
    assert.equal(out.checks.find((item) => item.code === 'edge_r_ci')?.status, 'insufficient');
    assert.equal(out.verdict, 'INSUFFICIENTE');
  });

  it('COVERAGE_LOW degrada il campione come un formato rotto', () => {
    const out = validateAiDeskSample(strongSample({ alerts: [{ code: 'COVERAGE_LOW' }] }));
    assert.equal(
      out.checks.find((item) => item.code === 'sample_integrity')?.status,
      'insufficient'
    );
    assert.equal(out.verdict, 'INSUFFICIENTE');
  });
});
