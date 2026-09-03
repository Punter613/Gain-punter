'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-key';

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stubModule('../src/services/ai/aiClient', {
  aiChat: async () => ({
    choices: [{ message: { content: JSON.stringify({
      urgency: 'soon',
      safetyRisk: false,
      primaryCause: 'Driveline movement requires confirmation',
      secondaryCauses: [],
      codeExplanations: {},
      probability: [{ cause: 'Driveline movement requires confirmation', likelihood: 100 }],
      knownIssues: [],
      repairSteps: [],
      proTips: [],
      recommendedTests: ['Road test under controlled throttle release'],
      additionalChecks: [],
      estimatedRepairTime: 'N/A',
      notes: 'Confirm before repair.'
    }) } }],
    model: 'test-model',
    _provider: 'test'
  })
});

stubModule('../src/services/vehicle.warmup', {
  resolveVehicleProfile: async (vin, vehicle = {}) => vehicle,
  waitForVehicleWarmup: async () => ({ status: 'TEST_STUB' })
});

stubModule('../src/services/vehicle.evidence', {
  collectVehicleEvidence: async () => ({
    available: false,
    oem: { references: [] },
    tsbs: { references: [] },
    recalls: [],
    knownIssues: [],
    sources: [],
    errors: []
  }),
  selectRelevantTsbs: () => []
});

const { createLifecycleTestApp } = require('./helpers/lifecycle.http.app');

async function withServer(run) {
  const app = createLifecycleTestApp();
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

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function get(base, path) {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

function baseFixture(overrides = {}) {
  return {
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: '2.7L V6' },
    customerStates: ['Thump during throttle release'],
    mechanicNotices: ['Road-test observation pending'],
    ...overrides
  };
}

test.beforeEach(() => { global.__jobs = {}; });

test('lifecycle persists all entered DTC provenance while trusted obdCodes contains only verified scan-tool evidence', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', baseFixture({
      dtcEvidence: [
        { code: 'P0300', source: 'SCAN_TOOL', verified: true },
        { code: 'P0171', source: 'PLACEHOLDER', verified: false },
        { code: 'U0100', source: 'CUSTOMER_REPORTED', verified: false }
      ]
    }));
    assert.equal(diagnosed.status, 200);
    assert.equal(diagnosed.body.result.dtcProvenance.verifiedCount, 1);
    assert.equal(diagnosed.body.result.dtcProvenance.excludedCount, 2);

    const job = await get(base, `/api/jobs/${diagnosed.body.jobId}`);
    assert.equal(job.status, 200);
    assert.deepEqual(job.body.job.intake.obdCodes, ['P0300']);
    assert.deepEqual(job.body.job.diagnosis.evidencePacket.dtcs, ['P0300']);
    assert.equal(job.body.job.diagnosis.evidencePacket.schemaVersion, 2);
    assert.deepEqual(job.body.job.intake.dtcEvidence, [
      { code: 'P0300', source: 'SCAN_TOOL', verified: true },
      { code: 'P0171', source: 'PLACEHOLDER', verified: false },
      { code: 'U0100', source: 'CUSTOMER_REPORTED', verified: false }
    ]);
    assert.doesNotMatch(JSON.stringify(job.body.job.diagnosis.evidencePacket), /P0171|U0100/);
  });
});

test('legacy bare code arrays are retained as untrusted audit records and excluded from downstream trusted obdCodes', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', baseFixture({ codes: ['P0300', 'P0171'] }));
    assert.equal(diagnosed.status, 200);
    assert.equal(diagnosed.body.result.dtcProvenance.verifiedCount, 0);
    assert.equal(diagnosed.body.result.dtcProvenance.excludedCount, 2);

    const job = await get(base, `/api/jobs/${diagnosed.body.jobId}`);
    assert.deepEqual(job.body.job.intake.obdCodes, []);
    assert.deepEqual(job.body.job.diagnosis.evidencePacket.dtcs, []);
    assert.deepEqual(job.body.job.intake.dtcEvidence, [
      { code: 'P0300', source: 'LEGACY_UNSPECIFIED', verified: false },
      { code: 'P0171', source: 'LEGACY_UNSPECIFIED', verified: false }
    ]);
  });
});
