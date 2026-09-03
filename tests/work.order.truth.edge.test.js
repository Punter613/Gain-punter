'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEstimateOnlyLifecycle,
  createQuickEstimate,
  recordCustomerDecisions
} = require('../src/services/customer.estimate.center');
const { getJob, patchJob } = require('../src/services/job.lifecycle');
const { createWorkOrder } = require('../src/services/work.order');

function resetJobs() {
  global.__jobs = {};
}

async function createAuthorizedEstimate(jobId, description) {
  const estimate = await createQuickEstimate(jobId, {
    basis: 'CUSTOMER_REQUEST',
    laborRate: 100,
    taxRate: 0,
    workItems: [{ description, partsCost: 50, laborHours: 0.5 }]
  });
  await recordCustomerDecisions(jobId, estimate.estimateId, estimate.revision, [
    { itemId: 'LI-001', decision: 'AUTHORIZED', note: 'Approved by customer' }
  ]);
  return estimate;
}

test.beforeEach(resetJobs);

test('requestId cannot be reused for a different source estimate revision', async () => {
  const job = await createEstimateOnlyLifecycle({
    customer: { name: 'Idempotency Edge Customer' },
    vehicle: { year: 2020, make: 'Toyota', model: 'Camry' },
    requestedService: 'Service request'
  });
  const firstEstimate = await createAuthorizedEstimate(job.jobId, 'First service');
  await createWorkOrder(job.jobId, {
    estimateId: firstEstimate.estimateId,
    revision: firstEstimate.revision,
    requestId: 'stable-mobile-request-1'
  });

  const secondEstimate = await createAuthorizedEstimate(job.jobId, 'Second service');
  await assert.rejects(
    () => createWorkOrder(job.jobId, {
      estimateId: secondEstimate.estimateId,
      revision: secondEstimate.revision,
      requestId: 'stable-mobile-request-1'
    }),
    error => error.code === 'WORK_ORDER_IDEMPOTENCY_KEY_REUSED'
  );
});

test('a verified case elsewhere on the lifecycle does not automatically verify Quick Estimate Work Order lines', async () => {
  const job = await createEstimateOnlyLifecycle({
    customer: { name: 'Truth Link Customer' },
    vehicle: { year: 2019, make: 'Honda', model: 'Civic' },
    requestedService: 'Cabin air filter replacement'
  });
  const estimate = await createAuthorizedEstimate(job.jobId, 'Cabin air filter replacement');

  await patchJob(job.jobId, {
    verifiedCase: {
      stage: 'VERIFIED',
      fingerprint: 'verified-case-fingerprint-test-only',
      verification: {
        confirmedCause: 'Left front wheel bearing fault',
        verifiedAt: new Date().toISOString()
      }
    }
  });

  const created = await createWorkOrder(job.jobId, {
    estimateId: estimate.estimateId,
    revision: estimate.revision
  });

  assert.equal(created.workOrder.diagnosticTruthSnapshot.status, 'VERIFIED_CASE_PRESENT_BUT_SCOPE_UNLINKED');
  assert.equal(created.workOrder.diagnosticTruthSnapshot.verifiedCasePresent, true);
  assert.equal(created.workOrder.diagnosticTruthSnapshot.physicallyVerified, false);
  assert.equal(created.workOrder.diagnosticTruthSnapshot.scopeMatchEstablished, false);
  assert.equal(created.workOrder.workItems[0].truthBasis.physicallyVerified, false);
  assert.equal(created.workOrder.workItems[0].truthBasis.scopeMatchEstablished, false);
});

test('an AUTHORIZED flag without a persisted customer-decision timestamp is not enough to create execution scope', async () => {
  const job = await createEstimateOnlyLifecycle({
    customer: { name: 'Timestamp Boundary Customer' },
    vehicle: { year: 2017, make: 'Ford', model: 'Escape' },
    requestedService: 'Requested service'
  });
  const estimate = await createAuthorizedEstimate(job.jobId, 'Requested service');
  const current = await getJob(job.jobId);
  const versions = current.customerEstimateCenter.quickEstimates.map(version => ({
    ...version,
    workItems: version.workItems.map(item => item.itemId === 'LI-001'
      ? { ...item, decisionAt: null }
      : item)
  }));
  await patchJob(job.jobId, {
    customerEstimateCenter: {
      ...current.customerEstimateCenter,
      quickEstimates: versions
    }
  });

  await assert.rejects(
    () => createWorkOrder(job.jobId, {
      estimateId: estimate.estimateId,
      revision: estimate.revision,
      itemIds: ['LI-001']
    }),
    error => error.code === 'AUTHORIZATION_TIMESTAMP_REQUIRED'
  );
});
