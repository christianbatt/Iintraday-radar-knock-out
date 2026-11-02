import { loadParameters, resolveRemoteParameters } from '../paramSync';

type P = {
  version: number;
  minScore: number;
  minScoreEurope: number;
  minScoreUSA: number;
  minGapEurope: number;
  target1Multiplier: number;
};
const BASE: P = { version: 112, minScore: 55, minScoreEurope: 60, minScoreUSA: 58, minGapEurope: 0.15, target1Multiplier: 1.35 };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
let failed = 0;
function check(id: string, ok: boolean) {
  console.log('[' + id + '] ' + (ok ? 'PASS' : 'FAIL'));
  if (!ok) failed++;
}

check('T1_null_saved', eq(loadParameters(null, BASE), BASE));
check('T2_partial_keeps_saved', (() => {
  const r = loadParameters('{"minScoreEurope":65}', BASE);
  return r.minScoreEurope === 65 && r.target1Multiplier === 1.35;
})());
check('T3_invalid_json', eq(loadParameters('{not json', BASE), BASE));
check('T4_same_version_conflict', (() => {
  const r = resolveRemoteParameters(BASE, { ...BASE, minScore: 70 }, BASE);
  return r.conflict && eq(r.result, BASE);
})());
check('T5_higher_version_merged', (() => {
  const r = resolveRemoteParameters(BASE, { version: 113, minScoreEurope: 62 } as P, BASE);
  return !r.conflict && r.result.version === 113 && r.result.minScoreEurope === 62 && r.result.target1Multiplier === 1.35;
})());
check('T6_lower_version_ignored', (() => {
  const r = resolveRemoteParameters(BASE, { ...BASE, version: 111 }, BASE);
  return !r.conflict && eq(r.result, BASE);
})());
check('T7_null_remote', eq(resolveRemoteParameters(BASE, null, BASE).result, BASE));
check('T8_score_sanitized', resolveRemoteParameters(BASE, { version: 113, minScoreEurope: 150 } as P, BASE).result.minScoreEurope === 90);

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAIL');
process.exitCode = failed === 0 ? 0 : 1;
