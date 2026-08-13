'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  verificationPayloadFromJob,
  authorizeJobRepair
} = require('../src/middleware/repair.authorization.middleware');

test('maps persisted job verification into the guard contract exactly', () => {
  const job = {
    status: 'VERIFIED',
    verification: {
      confirmed: true,
      confirmedCause: 'component A',
      conclusion: 'measured result confirmed fault'
    },
    tests: [
      { name: 'comparison test', result: 'out of range' }
    ]
  };

  const payload = verificationPayloadFromJob(job);

  assert.equal(payload.diagnosisVerified, true);
  assert.equal(payload.verificationStatus, 'VERIFIED');
  assert.equal(payload.verifiedFaults.length, 1);
  assert.equal(payload.verifiedFaults[0].component, 'component A');
  assert.equal(payload.verifiedFaults[0].finding, 'measured result confirmed fault');
  assert.deepEqual(payload.diagnosticTests, job.tests);
});

test('does not authorize a bounded cause when persisted job status is not VERIFIED', () => {
  const result = authorizeJobRepair({
    status: 'TESTING',
    verification: {
      confirmed: true,
      confirmedCause: 'component A'
    },
    tests: [{ name: 'comparison test', result: 'out of range' }]
  });

  assert.equal(result.authorized, false);
  assert.equal(result.status, 'DIAGNOSIS_REQUIRED');
});

test('does not authorize VERIFIED status without a bounded confirmed cause', () => {
  const result = authorizeJobRepair({
    status: 'VERIFIED',
    verification: { confirmed: true, confirmedCause: '' },
    tests: [{ name: 'inspection', result: 'completed' }]
  });

  assert.equal(result.authorized, false);
});
