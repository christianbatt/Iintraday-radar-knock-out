import { sanitizeScoreParameters, shouldApplyPolledParameters, shouldApplyCloudParameters } from '../paramSync';

let failed = 0;
function check(name: string, ok: boolean) {
  console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failed++;
}

const LOCAL: any = { version: 112, minScore: 90, minScoreEurope: 90, minScoreUSA: 92 };

// Polling
check('P1_remote_null', shouldApplyPolledParameters(LOCAL, null) === false);
check('P2_version_missing', shouldApplyPolledParameters(LOCAL, { minScore: 80 }) === false);
check('P3_version_not_number', shouldApplyPolledParameters(LOCAL, { version: '113' }) === false);
check('P4_equal', shouldApplyPolledParameters(LOCAL, { version: 112 }) === false);
check('P5_lower', shouldApplyPolledParameters(LOCAL, { version: 111 }) === false);
check('P6_greater', shouldApplyPolledParameters(LOCAL, { version: 113 }) === true);
check('P7_local_missing_remote_1', shouldApplyPolledParameters(null, { version: 1 }) === true);
check('P8_local_missing_remote_0', shouldApplyPolledParameters(null, { version: 0 }) === false);

// Cloud
check('C1_remote_null', shouldApplyCloudParameters(LOCAL, null) === false);
check('C2_version_missing', shouldApplyCloudParameters(LOCAL, { minScore: 80 }) === false);
check('C3_version_not_number', shouldApplyCloudParameters(LOCAL, { version: null }) === false);
check('C4_equal', shouldApplyCloudParameters(LOCAL, { version: 112 }) === false);
check('C5_lower', shouldApplyCloudParameters(LOCAL, { version: 111 }) === false);
check('C6_greater', shouldApplyCloudParameters(LOCAL, { version: 113 }) === true);
check('C7_local_missing_remote_0', shouldApplyCloudParameters(null, { version: 0 }) === true);
check('C8_local_missing_remote_negative', shouldApplyCloudParameters(null, { version: -1 }) === true);

// Differenza voluta tra le due guardie
check('D1_diff_local_missing_version_0', shouldApplyPolledParameters(null, { version: 0 }) !== shouldApplyCloudParameters(null, { version: 0 }));

// Sanitizzazione
const raw: any = { version: 113, minScore: 150, minScoreEurope: 2400, minScoreUSA: 120 };
const snapshot = JSON.stringify(raw);
const clean: any = sanitizeScoreParameters(raw);
check('S1_minScore_fallback_90', clean.minScore === 90);
check('S2_europe_divided_by_1000', clean.minScoreEurope === 2);
check('S3_usa_fallback_92', clean.minScoreUSA === 92);
check('S4_value_in_range_kept', sanitizeScoreParameters({ minScore: 95 } as any).minScore === 95);
check('S5_input_not_mutated', JSON.stringify(raw) === snapshot);

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAIL');
process.exitCode = failed === 0 ? 0 : 1;
