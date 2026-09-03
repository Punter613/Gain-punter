'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEstimateOnlyLifecycle,
  createQuickEstimate,
  recordCustomerDecisions,
  reviseQuickEstimate
} = require('../src/services/customer.estimate.center');
const { getJob, patchJob } = require('../src/services/job.lifecycle');
const {
  WORK_ORDER_POLICY,
  createWorkOrder,
  getWorkOrder,
  listWorkOrders,
  updateWorkItemState
} = require('../src/services/work.order');

function resetJobs() {
  global.__jobs = {};
}

async function makeEstimate(workItems = null) {
  const job = await createEstimateOnlyLifecycle({
    customer: { name: 'Work Order Test Customer' },
    vehicle: { year: 2018, make: 'Honda', model: 'Accord', mileage: 90000 },
    requestedService: 'Customer-requested maintenance and inspection'
  });
  const estimate = await createQuickEstimate(job.jobId, {
    basis: 'CUSTOMER_REQUEST',
    laborRate: 100,
    taxRate: 0,
    workItems: workItems || [
      { description: 'Front brake service', partsCost: 300, laborHours: 2, priority: 'WARNING' },
      { description: 'Wheel alignment', partsCost: 0, laborHours: 1, priority: 'ROUTINE' },
      { description: 'Cabin air filter', partsCost: 40, laborHours: 0.2, priority: 'ADVISORY' }
    ]
  });
  return { job, estimate };
}

test.beforeEach(resetJobs);

test('Work Order snapshots AUTHORIZED lines only and does not create diagnostic truth or invoice truth', async () => {
  const { job, estimate } = await makeEstimate();
  await recordCustomerDecisions(job.jobId, estimate.estimateId, estimate.revision, [
    { itemId: 'LI-001', decision: 'AUTHORIZED', note: 'Customer approved brakes today' },
    { itemId: 'LI-002', decision: 'DEFERRED', note: 'Schedule later' },
    { itemId: 'LI-003', decision: 'DECLINED', note: 'Customer declined filter' }
  ]);

  const created = await createWorkOrder(job.jobId, {
    estimateId: estimate.estimateId,
    revision: estimate.revision,
    requestId: 'wo-test-1',
    recordedBy: 'service desk'
  });

  assert.equal(created.created, true);
  assert.equal(created.workOrder.truthPolicy, WORK_ORDER_POLICY);
  assert.equal(created.workOrder.status, 'READY');
  assert.equal(created.workOrder.workItems.length, 1);
  assert.equal(created.workOrder.workItems[0].sourceItemId, 'LI-001');
  assert.equal(created.workOrder.workItems[0].authorizationSnapshot.decision, 'AUTHORIZED');
  assert.equal(created.workOrder.workItems[0].truthBasis.physicallyVerified, false);
  assert.equal(created.workOrder.diagnosticTruthSnapshot.status, 'NOT_VERIFIED');
  assert.equal(created.workOrder.authorizationRequest.identityVerified, false);
  assert.equal(created.workOrder.totals.authorizedPlanned, 500);

  const persisted = await getJob(job.jobId);
  assert.equal(persisted.verifiedCase, undefined);
  assert.equal(persisted.invoice, null);
});

test('replaying the same authorized scope is idempotent and does not create a second Work Order', async () => {
  const { job, estimate } = await makeEstimate();
  await recordCustomerDecisions(job.jobId, estimate.estimateId, estimate.revision, [
    { itemId: 'LI-001', decision: 'AUTHORIZED' }
  ]);

  const first = await createWorkOrder(job.jobId, {
    estimateId: estimate.estimateId,
    revision: estimate.revision,
    itemIds: ['LI-001'],
    requestId: 'same-mobile-submit'
  });
  const second = await createWorkOrder(job.jobId, {
    estimateId: estimate.estimateId,
    revision: estimate.revision,
    itemIds: ['LI-001'],
    requestId: 'same-mobile-submit'
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.workOrder.workOrderId, first.workOrder.workOrderId);
  const orders = await listWorkOrders(job.jobId);
  assert.equal(orders.length, 1);
});

test('deferred, declined, or merely proposed lines cannot enter a Work Order', async () => {
  const { job, estimate } = await makeEstimate();
  await recordCustomerDecisions(job.jobId, estimate.estimateId, estimate.revision, [
    { itemId: 'LI-001', decision: 'AUTHORIZED' },
    { itemId: 'LI-002', decision: 'DEFERRED' },
    { itemId: 'LI-003', decision: 'DECLINED' }
  ]);

  await assert.rejects(
    () => createWorkOrder(job.jobId, {
      estimateId: estimate.estimateId,
      revision: estimate.revision,
      itemIds: ['LI-001', 'LI-002']
    }),
    error => error.code === 'UNAUTHORIZED_WORK_SCOPE'
  );

  const orders = await listWorkOrders(job.jobId);
  assert.equal(orders.length, 0);
});

test('authorization snapshot remains immutable if the source estimate decision later changes', async () => {
  const { job, estimate } = await makeEstimate();
  await recordCustomerDecisions(job.jobId, estimate.estimateId, estimate.revision, [
    { itemId: 'LI-001', decision: 'AUTHORIZED', note: 'Approved at counter' }
  ]);
  const created = await createWorkOrder(job.jobId, {
    estimateId: estimate.estimateId,
    revision: estimate.revision,
    itemIds: ['LI-001'],
    requestId: 'snapshot-test'
  });

  await recordCustomerDecisions(job.jobId, estimate.estimateId, estimate.revision, [
    { itemId: 'LI-001', decision: 'DEFERRED', note: 'Customer changed future preference after WO creation' }
  ]);

  const order = await getWorkOrder(job.jobId, created.workOrder.workOrderId);
  assert.equal(order.workItems[0].authorizationSnapshot.decision, 'AUTHORIZED');
  assert.equal(order.workItems[0].authorizationSnapshot.decisionNote, 'Approved at counter');
  assert.equal(order.workItems[0].pricingSnapshot.estimatedTotal, 500);
});

test('superseded estimate revisions cannot create new Work Orders', async () => {
  const { job, estimate } = await makeEstimate();
  await recordCustomerDecisions(job.jobId, estimate.estimateId, estimate.revision, [
    { itemId: 'LI-001', decision: 'AUTHORIZED' }
  ]);
  await reviseQuickEstimate(job.jobId, estimate.estimateId, {
    workItems: [
      { description: 'Front brake service revised price', partsCost: 325, laborHours: 2, laborRate: 100 }
    ]
  });

  await assert.rejects(
    () => createWorkOrder(job.jobId, {
      estimateId: estimate.estimateId,
      revision: 1,
      itemIds: ['LI-001']
    }),
    error => error.code === 'SUPERSEDED_ESTIMATE_READ_ONLY'
  );
});

test('ALL_OR_NONE dependency packages cannot be split into unsafe partial work', async () => {
  const { job, estimate } = await makeEstimate([
    { description: 'Left side safety repair', partsCost: 200, laborHours: 1 },
    { description: 'Right side safety repair', partsCost: 200, laborHours: 1 }
  ]);
  await recordCustomerDecisions(job.jobId, estimate.estimateId, estimate.revision, [
    { itemId: 'LI-001', decision: 'AUTHORIZED' },
    { itemId: 'LI-002', decision: 'AUTHORIZED' }
  ]);

  const current = await getJob(job.jobId);
  const versions = current.customerEstimateCenter.quickEstimates.map(version => ({
    ...version,
    workItems: version.workItems.map(item => ({
      ...item,
      packageId: 'SAFETY-AXLE-1',
      packagePolicy: 'ALL_OR_NONE'
    }))
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
    error => error.code === 'WORK_PACKAGE_SPLIT_BLOCKED'
  );

  const completePackage = await createWorkOrder(job.jobId, {
    estimateId: estimate.estimateId,
    revision: estimate.revision,
    itemIds: ['LI-001', 'LI-002']
  });
  assert.equal(completePackage.workOrder.workItems.length, 2);
});

test('completion requires execution evidence and only completed authorized work becomes completion-eligible', async () => {
  const { job, estimate } = await makeEstimate();
  await recordCustomerDecisions(job.jobId, estimate.estimateId, estimate.revision, [
    { itemId: 'LI-001', decision: 'AUTHORIZED' }
  ]);
  const created = await createWorkOrder(job.jobId, {
    estimateId: estimate.estimateId,
    revision: estimate.revision,
    itemIds: ['LI-001']
  });
  const workOrderId = created.workOrder.workOrderId;
  const workItemId = created.workOrder.workItems[0].workItemId;

  await updateWorkItemState(job.jobId, workOrderId, workItemId, {
    state: 'IN_PROGRESS',
    recordedBy: 'tech label'
  });
  await assert.rejects(
    () => updateWorkItemState(job.jobId, workOrderId, workItemId, { state: 'COMPLETED' }),
    error => error.code === 'COMPLETION_EVIDENCE_REQUIRED'
  );

  const completed = await updateWorkItemState(job.jobId, workOrderId, workItemId, {
    state: 'COMPLETED',
    completionNote: 'Replaced front brake components and completed final mechanical check.',
    recordedBy: 'tech label'
  });
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.totals.completed, 500);
  assert.equal(completed.totals.remaining, 0);
  assert.equal(completed.workItems[0].executionHistory.at(-1).actor.identityVerified, false);

  const persisted = await getJob(job.jobId);
  assert.equal(persisted.invoice, null, 'Work Order completion does not create an invoice in #131');
});
