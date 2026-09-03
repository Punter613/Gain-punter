'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createJob,
  getJob,
  patchJob,
  recordDiagnosis,
  recordUnverifiedDiagnosis
} = require('../src/services/job.lifecycle');
const {
  persistEvidenceBatch,
  atomicUnverifiedDiagnosis
} = require('../src/services/atomic.evidence.reassessment');

function resetJobs() {
  global.__jobs = {};
}

async function seedJob(id) {
  const job = await createJob({
    jobId: id,
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: '2.7L V6', mileage: 150000 },
    customerStates: ['Clunk on throttle release'],
    mechanicNotices: [],
    obdCodes: []
  });

  await recordDiagnosis(job.jobId, {
    primaryCause: 'Driveline torque-transfer fault requires confirmation',
    secondaryCauses: ['Powertrain mount movement'],
    probability: [
      { cause: 'Driveline torque-transfer fault requires confirmation', likelihood: 60 },
      { cause: 'Powertrain mount movement', likelihood: 40 }
    ],
    recommendedTests: ['Road test during throttle release'],
    notes: 'Initial diagnosis is unverified.',
    diagnosticConfidence: { percentage: 40, rating: 'LOW' }
  });

  const current = await getJob(job.jobId);
  await patchJob(job.jobId, {
    diagnosis: {
      ...current.diagnosis,
      evidencePacket: {
        schemaVersion: 2,
        dtcs: [],
        dtcProvenance: {
          policy: 'VERIFIED_SCAN_TOOL_ONLY',
          verifiedCount: 0,
          excludedCount: 0,
          sourceCounts: {},
          records: []
        }
      }
    }
  });
  return getJob(job.jobId);
}

function roadEvidence(id = 'road-evidence-1') {
  return {
    id,
    name: 'Road test during throttle release',
    result: 'Mechanical clunk is reproduced exactly during throttle lift and torque reversal.',
    passed: null,
    evidenceRole: 'NEUTRAL',
    confirmedFault: ''
  };
}

function successfulReassessment(job) {
  return {
    ...job.diagnosis.result,
    primaryCause: 'Driveline / torque-transfer mechanical fault',
    secondaryCauses: ['Powertrain mount movement'],
    probability: [
      { cause: 'Driveline / torque-transfer mechanical fault', likelihood: 70 },
      { cause: 'Powertrain mount movement', likelihood: 30 }
    ],
    recommendedTests: ['Inspect applicable driveline components and mounts for physical play'],
    notes: 'Road-test evidence shifts the diagnostic direction toward the driveline system.',
    diagnosticConfidence: { percentage: 60, rating: 'MODERATE' },
    reassessment: {
      applied: true,
      reason: 'NEW_TEST_EVIDENCE',
      evidenceCount: job.tests.length,
      reassessedAt: new Date().toISOString()
    }
  };
}

test('atomic batch validates every item before persisting any evidence', async () => {
  resetJobs();
  const job = await seedJob('SKSK-ATOMIC-VALIDATION');

  await assert.rejects(
    persistEvidenceBatch(job.jobId, [
      roadEvidence('valid-first'),
      { id: 'bad-second', name: 'Second test', result: 'unknown', evidenceRole: 'NEUTRAL' }
    ]),
    /actual observation or measurement/i
  );

  const persisted = await getJob(job.jobId);
  assert.equal(persisted.tests.length, 0);
  assert.notEqual(persisted.diagnosis?.stale, true);
});

test('stable evidence ids make retries idempotent', async () => {
  resetJobs();
  const job = await seedJob('SKSK-ATOMIC-IDEMPOTENT');
  const first = await persistEvidenceBatch(job.jobId, [roadEvidence()]);
  const retry = await persistEvidenceBatch(job.jobId, [roadEvidence()]);
  const persisted = await getJob(job.jobId);

  assert.equal(first.saved.length, 1);
  assert.equal(first.reused.length, 0);
  assert.equal(retry.saved.length, 0);
  assert.equal(retry.reused.length, 1);
  assert.equal(persisted.tests.length, 1);
  assert.equal(persisted.diagnosis.stale, true);
});

test('one atomic action saves evidence, reassesses, and presents only the fresh revision', async () => {
  resetJobs();
  const job = await seedJob('SKSK-ATOMIC-SUCCESS');

  const result = await atomicUnverifiedDiagnosis(job.jobId, [roadEvidence()], {
    reassessDiagnosisFn: async current => successfulReassessment(current)
  });

  assert.equal(result.evidenceSavedCount, 1);
  assert.equal(result.evidenceReusedCount, 0);
  assert.equal(result.job.tests.length, 1);
  assert.equal(result.job.diagnosis.revision, 2);
  assert.equal(result.job.diagnosis.stale, false);
  assert.equal(result.job.unverifiedDiagnosis.state, 'UNVERIFIED_DIAGNOSIS');
  assert.equal(result.job.unverifiedDiagnosis.stale, false);
  assert.match(result.job.unverifiedDiagnosis.mostLikelyCause, /driveline/i);

  const retry = await atomicUnverifiedDiagnosis(job.jobId, [roadEvidence()], {
    reassessDiagnosisFn: async () => {
      throw new Error('Retry should not need another reassessment');
    }
  });
  assert.equal(retry.evidenceSavedCount, 0);
  assert.equal(retry.evidenceReusedCount, 1);
  assert.equal(retry.job.tests.length, 1);
  assert.equal(retry.job.diagnosis.revision, 2);
});

test('reassessment failure after evidence save fails closed and leaves old diagnosis stale', async () => {
  resetJobs();
  const job = await seedJob('SKSK-ATOMIC-FAIL-CLOSED');
  await recordUnverifiedDiagnosis(job.jobId);

  let failure;
  try {
    await atomicUnverifiedDiagnosis(job.jobId, [roadEvidence()], {
      reassessDiagnosisFn: async () => { throw new Error('provider unavailable'); }
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.equal(failure.code, 'REASSESSMENT_FAILED_AFTER_EVIDENCE_SAVE');
  assert.equal(failure.evidenceSaved, true);
  assert.equal(failure.diagnosisStale, true);

  const persisted = await getJob(job.jobId);
  assert.equal(persisted.tests.length, 1);
  assert.equal(persisted.diagnosis.revision, 1);
  assert.equal(persisted.diagnosis.stale, true);
  assert.equal(persisted.unverifiedDiagnosis.stale, true);
  assert.equal(persisted.unverifiedDiagnosis.supersededBy, 'NEW_TEST_EVIDENCE');
});

test('concurrent mobile retries serialize so evidence and diagnosis revision are not duplicated', async () => {
  resetJobs();
  const job = await seedJob('SKSK-ATOMIC-CONCURRENT');
  let reassessCalls = 0;
  const reassess = async current => {
    reassessCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return successfulReassessment(current);
  };

  const [first, second] = await Promise.all([
    atomicUnverifiedDiagnosis(job.jobId, [roadEvidence()], { reassessDiagnosisFn: reassess }),
    atomicUnverifiedDiagnosis(job.jobId, [roadEvidence()], { reassessDiagnosisFn: reassess })
  ]);

  const persisted = await getJob(job.jobId);
  assert.equal(reassessCalls, 1);
  assert.equal(persisted.tests.length, 1);
  assert.equal(persisted.diagnosis.revision, 2);
  assert.equal(first.job.diagnosis.revision, 2);
  assert.equal(second.job.diagnosis.revision, 2);
});
