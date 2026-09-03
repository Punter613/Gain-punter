'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/jobs', require('../src/routes/jobs.protected'));
  return app;
}

async function withServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function request(base, path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

function resetJobs() {
  global.__jobs = {};
}

test.beforeEach(resetJobs);

test('quick estimate supports line-item authorization without creating diagnostic truth', async () => {
  await withServer(async base => {
    const created = await request(base, '/api/jobs/estimate-center/job', 'POST', {
      customer: { name: 'Estimate Customer', phone: '555-0123' },
      vehicle: { year: 2018, make: 'Honda', model: 'Accord', mileage: 88000 },
      requestedService: 'Price several repairs before authorizing work'
    });
    assert.equal(created.status, 201);
    assert.match(created.body.lifecycleNumber, /^SKSK-\d{8}-[0-9A-F]{6}$/);
    const jobId = created.body.lifecycleNumber;

    const quoted = await request(base, `/api/jobs/estimate-center/${jobId}/quick`, 'POST', {
      basis: 'CUSTOMER_REQUEST',
      title: 'Customer requested repair options',
      laborRate: 100,
      taxRate: 0,
      workItems: [
        { description: 'Front brake service', priority: 'CRITICAL', partsCost: 280, laborHours: 2 },
        { description: 'Rear wheel bearing', priority: 'WARNING', partsCost: 320, laborHours: 3 },
        { description: 'Valve cover leak repair', priority: 'ADVISORY', partsCost: 190, laborHours: 2 }
      ]
    });
    assert.equal(quoted.status, 201);
    assert.equal(quoted.body.estimate.documentNumber, 'QE-001-R1');
    assert.equal(quoted.body.estimate.totals.identified, 1490);
    assert.equal(quoted.body.estimate.totals.authorized, 0);
    assert.match(quoted.body.estimate.disclaimer, /not a confirmed diagnosis/i);

    const presented = await request(base, `/api/jobs/estimate-center/${jobId}/quick/QE-001/1/present`, 'POST', {});
    assert.equal(presented.status, 200);
    assert.equal(presented.body.estimate.status, 'PRESENTED');

    const decided = await request(base, `/api/jobs/estimate-center/${jobId}/quick/QE-001/1/decisions`, 'POST', {
      decisions: [
        { itemId: 'LI-001', decision: 'AUTHORIZED', note: 'Customer can afford this repair today' },
        { itemId: 'LI-002', decision: 'DEFERRED', note: 'Budget limitation' },
        { itemId: 'LI-003', decision: 'DEFERRED', note: 'Budget limitation' }
      ]
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.estimate.status, 'PARTIALLY_AUTHORIZED');
    assert.equal(decided.body.totalIdentified, 1490);
    assert.equal(decided.body.authorizedToday, 480);
    assert.equal(decided.body.deferred, 1010);

    const center = await request(base, `/api/jobs/estimate-center/${jobId}`);
    assert.equal(center.status, 200);
    assert.equal(center.body.quickEstimates.length, 1);
    assert.equal(center.body.quickEstimates[0].workItems[0].decision, 'AUTHORIZED');
    assert.equal(center.body.quickEstimates[0].workItems[1].decision, 'DEFERRED');
    assert.equal(center.body.verifiedEstimate, null);
    assert.equal(center.body.invoice, null);

    const job = await request(base, `/api/jobs/${jobId}`);
    assert.equal(job.status, 200);
    assert.equal(job.body.job.status, 'DIAGNOSING');
    assert.equal(job.body.job.verifiedCase, undefined);
    assert.equal(job.body.job.estimate, null);
    assert.equal(job.body.job.customerEstimateCenter.quickEstimates[0].status, 'PARTIALLY_AUTHORIZED');
  });
});

test('quick estimate revisions preserve the prior document and require fresh authorization', async () => {
  await withServer(async base => {
    const created = await request(base, '/api/jobs/estimate-center/job', 'POST', {
      customer: { name: 'Revision Customer' },
      vehicle: { year: 2020, make: 'Ford', model: 'Escape' }
    });
    const jobId = created.body.lifecycleNumber;

    const first = await request(base, `/api/jobs/estimate-center/${jobId}/quick`, 'POST', {
      laborRate: 120,
      workItems: [{ description: 'Front brake service', priority: 'CRITICAL', partsCost: 250, laborHours: 1.5 }]
    });
    assert.equal(first.body.estimate.documentNumber, 'QE-001-R1');

    const authorization = await request(base, `/api/jobs/estimate-center/${jobId}/quick/QE-001/1/decisions`, 'POST', {
      decisions: [{ itemId: 'LI-001', decision: 'AUTHORIZED', note: 'Approved at original price' }]
    });
    assert.equal(authorization.status, 200);
    assert.equal(authorization.body.estimate.status, 'AUTHORIZED');
    assert.equal(authorization.body.authorizedToday, 430);

    const revision = await request(base, `/api/jobs/estimate-center/${jobId}/quick/QE-001/revise`, 'POST', {
      laborRate: 120,
      workItems: [{ itemId: 'LI-001', description: 'Front brake service with additional hardware', priority: 'CRITICAL', partsCost: 300, laborHours: 1.5 }]
    });
    assert.equal(revision.status, 201);
    assert.equal(revision.body.estimate.documentNumber, 'QE-001-R2');
    assert.equal(revision.body.estimate.workItems[0].decision, 'PROPOSED');
    assert.equal(revision.body.estimate.totals.authorized, 0);

    const center = await request(base, `/api/jobs/estimate-center/${jobId}`);
    const r1 = center.body.quickEstimates.find(x => x.documentNumber === 'QE-001-R1');
    const r2 = center.body.quickEstimates.find(x => x.documentNumber === 'QE-001-R2');
    assert.ok(r1);
    assert.ok(r2);
    assert.equal(r1.status, 'SUPERSEDED');
    assert.equal(r1.supersededBy, 'QE-001-R2');
    assert.equal(r1.workItems[0].decision, 'AUTHORIZED');
    assert.equal(r2.status, 'DRAFT');
    assert.equal(r2.workItems[0].decision, 'PROPOSED');
    assert.equal(r1.totals.identified, 430);
    assert.equal(r2.totals.identified, 480);
  });
});
