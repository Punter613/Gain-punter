'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { buildVerifiedCase } = require('../src/core/evidence/verified.case');
const { buildVerifiedRepairResolution } = require('../src/core/evidence/verified.repair.resolution');
const {
  buildVerifiedEstimateSnapshot,
  assertVerifiedEstimateSnapshot
} = require('../src/core/evidence/verified.estimate.snapshot');

function makeJob() {
  const vehicle = { year: 2016, make: 'Chevrolet', model: 'Malibu', engine: '2.5L', vin: '1G11A5SA0GF000001', mileage: 100000 };
  const evidencePacket = {
    schemaVersion: 1,
    stage: 'DIAGNOSE',
    vehicle,
    observations: { customer: ['rough idle'], mechanic: [], completedWork: [] },
    dtcs: ['P0301'],
    measurements: { trust: 'TRUSTED_PRE_TAG_INPUT', values: {} },
    deterministic: { vehicleProfile: { vehicleId: 'CHEVROLET_MALIBU_TEST' } },
    evidence: { oem: [], tsbs: [], sources: [], available: false },
    contradictions: []
  };
  const base = {
    jobId: 'SKSK-INVOICE-HANDOFF',
    status: 'VERIFIED',
    customer: { name: 'Jane Customer', phone: '555-0100', email: 'jane@example.com' },
    vehicle,
    diagnosis: {
      result: { primaryCause: 'Ignition coil failure', probability: [] },
      evidencePacket
    },
    tests: [{ id: 'T1', name: 'coil swap', result: 'misfire moved' }],
    verification: {
      confirmed: true,
      confirmedCause: 'Ignition coil failure',
      conclusion: 'Fault followed coil',
      evidenceTestIds: ['T1'],
      verifiedAt: '2026-08-15T00:00:00.000Z'
    },
    estimate: null,
    invoice: null
  };
  base.verifiedCase = buildVerifiedCase(base);
  const repairResolution = buildVerifiedRepairResolution({
    verifiedCase: base.verifiedCase,
    laborRate: 65,
    laborRateSource: 'MECHANIC_INPUT',
    laborHours: 1.5,
    parts: [{ partNumber: 'COIL-1', description: 'Ignition coil', quantity: 1, unitPrice: 80 }]
  });
  base.estimate = buildVerifiedEstimateSnapshot(base, {
    priority: 'medium',
    diagnosis: 'Verified fault: Ignition coil failure',
    estimatedHours: 1.5,
    laborCost: 97.5,
    partsCost: 80,
    total: 177.5,
    repairs: ['Repair verified fault: Ignition coil failure'],
    repairSteps: [],
    proTips: [],
    knownIssues: [],
    repairResolution
  });
  base.status = 'ESTIMATED';
  return base;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  const invoice = require('../src/routes/invoice');
  const { invoiceLifecycle } = require('../src/middleware/job.lifecycle.middleware');
  app.use('/api/invoice', invoiceLifecycle, invoice);
  return app;
}

async function withServer(run) {
  const server = makeApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function post(base, body) {
  const response = await fetch(`${base}/api/invoice/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

test.beforeEach(() => { global.__jobs = {}; });

test('canonical estimate snapshot binds VERIFIED_CASE and repair resolution fingerprints', () => {
  const job = makeJob();
  assert.equal(job.estimate.stage, 'ESTIMATED');
  assert.equal(job.estimate.verifiedCaseFingerprint, job.verifiedCase.fingerprint);
  assert.equal(job.estimate.repairResolutionFingerprint, job.estimate.repairResolution.fingerprint);
  assert.doesNotThrow(() => assertVerifiedEstimateSnapshot(job.estimate, job));
});

test('invoice happy path uses persisted estimate resolution lines and canonical customer/vehicle', async () => {
  const job = makeJob();
  global.__jobs[job.jobId] = job;
  await withServer(async base => {
    const { response, body } = await post(base, { jobId: job.jobId });
    assert.equal(response.status, 200);
    assert.equal(body.invoiceNumber, job.jobId);
    assert.equal(body.estimateFingerprint, job.estimate.fingerprint);
    assert.equal(body.customer.name, 'Jane Customer');
    assert.equal(body.vehicle.make, 'Chevrolet');
    assert.equal(body.totals.laborTotal, 97.5);
    assert.equal(body.totals.partsTotal, 80);
    assert.equal(body.lineItems[0].operationId, job.estimate.repairResolution.operations[0].operationId);
    assert.equal(body.lineItems[1].partNumber, 'COIL-1');
  });
});

test('invoice ignores tampered request estimate customer vehicle and labor rate', async () => {
  const job = makeJob();
  global.__jobs[job.jobId] = job;
  await withServer(async base => {
    const { response, body } = await post(base, {
      jobId: job.jobId,
      estimate: { laborCost: 1, partsCost: 1, diagnosis: 'Replace transmission' },
      customerInfo: { name: 'Attacker' },
      vehicleInfo: { year: 2025, make: 'Ford', model: 'F-150' },
      laborRate: 1
    });
    assert.equal(response.status, 200);
    assert.equal(body.customer.name, 'Jane Customer');
    assert.equal(body.vehicle.make, 'Chevrolet');
    assert.equal(body.diagnosis.primary, 'Verified fault: Ignition coil failure');
    assert.equal(body.totals.laborTotal, 97.5);
    assert.equal(body.totals.partsTotal, 80);
  });
});

test('tampered persisted estimate snapshot fails closed before invoice generation', async () => {
  const job = makeJob();
  job.estimate = JSON.parse(JSON.stringify(job.estimate));
  job.estimate.partsCost = 1;
  global.__jobs[job.jobId] = job;
  await withServer(async base => {
    const { response, body } = await post(base, { jobId: job.jobId });
    assert.equal(response.status, 409);
    assert.equal(body.success, false);
    assert.equal(body.code, 'ESTIMATE_SNAPSHOT_REQUIRED_OR_INVALID');
  });
});

test('mismatched canonical estimate totals fail closed and are not attached as invoice', async () => {
  const job = makeJob();
  const badEstimate = { ...JSON.parse(JSON.stringify(job.estimate)), laborCost: 1 };
  delete badEstimate.fingerprint;
  job.estimate = buildVerifiedEstimateSnapshot(job, badEstimate);
  global.__jobs[job.jobId] = job;
  await withServer(async base => {
    const { response, body } = await post(base, { jobId: job.jobId });
    assert.equal(response.status, 409);
    assert.equal(body.success, false);
    assert.equal(global.__jobs[job.jobId].invoice, null);
    assert.equal(global.__jobs[job.jobId].status, 'ESTIMATED');
  });
});
