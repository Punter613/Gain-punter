'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let failReassessment = false;
stubModule('../src/services/ai/aiClient', {
  aiChat: async () => {
    if (failReassessment) throw new Error('provider unavailable');
    return {
      model: 'test-model',
      _provider: 'test',
      choices: [{ message: { content: JSON.stringify({
        primaryCause: 'Driveline lash requires physical confirmation',
        secondaryCauses: ['Powertrain mount movement'],
        probability: [
          { cause: 'Driveline lash requires physical confirmation', likelihood: 60 },
          { cause: 'Powertrain mount movement', likelihood: 40 }
        ],
        recommendedTests: ['Inspect driveline rotational play under safe static conditions'],
        notes: 'Legacy unprovenanced DTC values were excluded from this reassessment.',
        diagnosticConfidence: { percentage: 45, rating: 'LOW' }
      }) } }]
    };
  }
});

const jobsRouter = require('../src/routes/jobs');

function legacyJob(jobId) {
  return {
    jobId,
    invoiceNumber: jobId,
    status: 'TESTING',
    customer: {},
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: '2.7L V6' },
    intake: {
      customerStates: ['Thump during throttle release'],
      mechanicNotices: [],
      obdCodes: ['P0300', 'P0171']
    },
    diagnosis: {
      result: {
        primaryCause: 'Legacy code-anchored candidate',
        secondaryCauses: [],
        probability: [{ cause: 'Legacy code-anchored candidate', likelihood: 80 }],
        recommendedTests: ['Continue testing'],
        diagnosticConfidence: { percentage: 30, rating: 'LOW' }
      },
      evidencePacket: { schemaVersion: 1, dtcs: ['P0300', 'P0171'] },
      revision: 1,
      recordedAt: '2026-09-02T20:00:00.000Z'
    },
    diagnosisHistory: [],
    tests: [],
    verification: null,
    unverifiedDiagnosis: null,
    verifiedCase: null,
    estimate: null,
    invoice: null
  };
}

async function withServer(run) {
  const app = express();
  app.use(express.json());
  app.use('/api/jobs', jobsRouter);
  const server = app.listen(0, '127.0.0.1');
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

async function post(base, path, body = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test.beforeEach(() => {
  global.__jobs = {};
  failReassessment = false;
});

test('legacy TESTING job is reassessed without unprovenanced DTCs before unverified diagnosis is surfaced', async () => {
  const job = legacyJob('SKSK-LEGACY-DTC-MIGRATE');
  global.__jobs[job.jobId] = job;

  await withServer(async base => {
    const result = await post(base, `/api/jobs/${job.jobId}/unverified-diagnosis`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.diagnosisRevision, 2);
    assert.equal(result.body.reassessmentApplied, true);
    assert.equal(result.body.reassessmentReason, 'DTC_PROVENANCE_MIGRATION');
    assert.equal(result.body.unverifiedDiagnosis.mostLikelyCause, 'Driveline lash requires physical confirmation');
    assert.deepEqual(result.body.unverifiedDiagnosis.evidenceUsed.dtcs, []);
    assert.equal(result.body.unverifiedDiagnosis.evidenceUsed.dtcProvenance.excludedCount, 2);
    assert.equal(global.__jobs[job.jobId].diagnosisHistory.length, 1);
    assert.equal(global.__jobs[job.jobId].diagnosis.result.reassessment.reason, 'DTC_PROVENANCE_MIGRATION');
  });
});

test('legacy TESTING job fails closed if mandatory provenance reassessment cannot run', async () => {
  const job = legacyJob('SKSK-LEGACY-DTC-FAIL');
  global.__jobs[job.jobId] = job;
  failReassessment = true;

  await withServer(async base => {
    const result = await post(base, `/api/jobs/${job.jobId}/unverified-diagnosis`);
    assert.equal(result.status, 409);
    assert.match(result.body.error, /predates DTC provenance enforcement/i);
    assert.equal(result.body.estimateReady, false);
    assert.equal(global.__jobs[job.jobId].unverifiedDiagnosis, null);
    assert.equal(global.__jobs[job.jobId].diagnosis.revision, 1);
  });
});
