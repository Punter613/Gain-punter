'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getJob, patchJob } = require('../src/services/job.lifecycle');
const {
  createEstimateOnlyLifecycle,
  createQuickEstimate,
  recordCustomerDecisions
} = require('../src/services/customer.estimate.center');
const {
  createWorkOrder,
  updateWorkItemState
} = require('../src/services/work.order');
const {
  FINAL_INVOICE_POLICY,
  createFinalInvoice,
  getFinalInvoice
} = require('../src/services/final.work.invoice');

function resetJobs() {
  global.__jobs = {};
}

async function seedCommercialLifecycle(idSuffix = 'BASE') {
  const job = await createEstimateOnlyLifecycle({
    customer: { name: `Invoice Test ${idSuffix}` },
    vehicle: { year: 2018, make: 'Honda', model: 'Accord', mileage: 90000 },
    requestedService: 'Customer requested brake and alignment service'
  });

  const estimate = await createQuickEstimate(job.jobId, {
    basis: 'CUSTOMER_REQUEST',
    laborRate: 100,
    taxRate: 0,
    workItems: [
      { description: 'Front brake service', partsCost: 300, laborHours: 2, priority: 'WARNING' },
      { description: 'Wheel alignment', partsCost: 0, laborHours: 1, priority: 'ROUTINE' },
      { description: 'Cabin air filter', partsCost: 40, laborHours: 0.2, priority: 'ADVISORY' }
    ]
  });

  await recordCustomerDecisions(job.jobId, estimate.estimateId, estimate.revision, [
    { itemId: 'LI-001', decision: 'AUTHORIZED', note: 'Approved brakes' },
    { itemId: 'LI-002', decision: 'AUTHORIZED', note: 'Approved alignment' },
    { itemId: 'LI-003', decision: 'DEFERRED', note: 'Do later' }
  ]);

  const orderResult = await createWorkOrder(job.jobId, {
    estimateId: estimate.estimateId,
    revision: estimate.revision,
    itemIds: ['LI-001', 'LI-002'],
    requestId: `invoice-test-${idSuffix}`,
    recordedBy: 'service desk'
  });

  return { jobId: job.jobId, estimate, workOrder: orderResult.workOrder };
}

async function startAndComplete(jobId, workOrderId, workItemId, note) {
  await updateWorkItemState(jobId, workOrderId, workItemId, {
    state: 'IN_PROGRESS',
    recordedBy: 'technician label'
  });
  return updateWorkItemState(jobId, workOrderId, workItemId, {
    state: 'COMPLETED',
    completionNote: note,
    recordedBy: 'technician label'
  });
}

test('final invoice fails closed while authorized Work Order scope remains open', async () => {
  resetJobs();
  const { jobId, workOrder } = await seedCommercialLifecycle('OPEN');
  await startAndComplete(jobId, workOrder.workOrderId, 'WOI-001', 'Front brake service completed and checked.');

  await assert.rejects(
    createFinalInvoice(jobId, { requestId: 'final-open' }),
    error => error?.code === 'WORK_REMAINS_OPEN'
  );

  const persisted = await getJob(jobId);
  assert.equal(persisted.invoice, null);
  assert.notEqual(persisted.status, 'INVOICED');
});

test('final invoice bills only completed authorized lines and preserves deferred/cancelled truth', async () => {
  resetJobs();
  const { jobId, workOrder } = await seedCommercialLifecycle('COMPLETED');
  await startAndComplete(jobId, workOrder.workOrderId, 'WOI-001', 'Front brake service completed and final mechanical check performed.');
  await updateWorkItemState(jobId, workOrder.workOrderId, 'WOI-002', {
    state: 'CANCELLED',
    note: 'Alignment not performed today.',
    recordedBy: 'service desk'
  });

  const result = await createFinalInvoice(jobId, {
    requestId: 'final-completed-1',
    recordedBy: 'service desk',
    note: 'Customer pickup invoice'
  });

  assert.equal(result.created, true);
  assert.equal(result.invoice.type, 'FINAL_INVOICE');
  assert.equal(result.invoice.status, 'FINAL');
  assert.equal(result.invoice.policy, FINAL_INVOICE_POLICY);
  assert.equal(result.invoice.lineItems.length, 1);
  assert.equal(result.invoice.lineItems[0].sourceEstimateItemId, 'LI-001');
  assert.equal(result.invoice.lineItems[0].sourceWorkItemId, 'WOI-001');
  assert.equal(result.invoice.lineItems[0].pricingSnapshot.total, 500);
  assert.equal(result.invoice.totals.total, 500);
  assert.equal(result.invoice.totals.parts, 300);
  assert.equal(result.invoice.totals.labor, 200);
  assert.equal(result.invoice.lineItems.some(line => line.sourceEstimateItemId === 'LI-002'), false);
  assert.equal(result.invoice.lineItems.some(line => line.sourceEstimateItemId === 'LI-003'), false);
  assert.equal(result.invoice.lineItems[0].diagnosticTruth.physicallyVerified, false);
  assert.equal(result.invoice.lineItems[0].completion.actor.identityVerified, false);
  assert.ok(result.invoice.invoiceFingerprint);

  const persisted = await getJob(jobId);
  assert.equal(persisted.status, 'INVOICED');
  assert.equal(persisted.verifiedCase, undefined);
  assert.equal(persisted.invoice.invoiceFingerprint, result.invoice.invoiceFingerprint);
  const persistedOrder = persisted.workOrderCenter.workOrders[0];
  assert.equal(persistedOrder.workItems[0].billing.invoiceNumber, 'INV-001');
  assert.equal(persistedOrder.workItems[1].billing, undefined);

  const retry = await createFinalInvoice(jobId, { requestId: 'different-retry-id' });
  assert.equal(retry.created, false);
  assert.equal(retry.invoice.invoiceFingerprint, result.invoice.invoiceFingerprint);
  assert.equal((await getFinalInvoice(jobId)).invoiceFingerprint, result.invoice.invoiceFingerprint);
});

test('completed line without persisted authorization timestamp cannot become invoice truth', async () => {
  resetJobs();
  const { jobId, workOrder } = await seedCommercialLifecycle('AUTH-GUARD');
  await startAndComplete(jobId, workOrder.workOrderId, 'WOI-001', 'Brake service completed.');
  await updateWorkItemState(jobId, workOrder.workOrderId, 'WOI-002', {
    state: 'CANCELLED',
    note: 'Alignment cancelled.',
    recordedBy: 'service desk'
  });

  const job = await getJob(jobId);
  const corruptedOrders = JSON.parse(JSON.stringify(job.workOrderCenter.workOrders));
  corruptedOrders[0].workItems[0].authorizationSnapshot.decisionAt = null;
  // Recompute is intentionally not available here. This also demonstrates that
  // the Work Order scope fingerprint prevents authorization-history tampering.
  await patchJob(jobId, {
    workOrderCenter: { ...(job.workOrderCenter || {}), workOrders: corruptedOrders }
  });

  await assert.rejects(
    createFinalInvoice(jobId),
    error => ['WORK_ORDER_SCOPE_INTEGRITY_FAILED', 'COMPLETED_LINE_NOT_AUTHORIZED'].includes(error?.code)
  );
  assert.equal((await getJob(jobId)).invoice, null);
});

test('all-cancelled Work Orders do not produce a zero-dollar final invoice', async () => {
  resetJobs();
  const { jobId, workOrder } = await seedCommercialLifecycle('CANCELLED');
  await updateWorkItemState(jobId, workOrder.workOrderId, 'WOI-001', {
    state: 'CANCELLED',
    note: 'Brake work cancelled.',
    recordedBy: 'service desk'
  });
  await updateWorkItemState(jobId, workOrder.workOrderId, 'WOI-002', {
    state: 'CANCELLED',
    note: 'Alignment cancelled.',
    recordedBy: 'service desk'
  });

  await assert.rejects(
    createFinalInvoice(jobId),
    error => error?.code === 'COMPLETED_AUTHORIZED_WORK_REQUIRED'
  );
});
