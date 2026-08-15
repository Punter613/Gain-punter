const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-key';

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };
}

const diagnosticPayload = JSON.stringify({
  urgency: 'soon',
  safetyRisk: false,
  primaryCause: 'Cylinder 1 ignition fault requires confirmation',
  secondaryCauses: ['Spark plug fault'],
  codeExplanations: { P0301: 'Cylinder 1 misfire detected' },
  probability: [
    { cause: 'Ignition coil fault', likelihood: 70 },
    { cause: 'Spark plug fault', likelihood: 30 }
  ],
  knownIssues: [],
  repairSteps: [],
  proTips: [],
  recommendedTests: ['Swap cylinder 1 ignition coil with another cylinder and recheck misfire counts'],
  additionalChecks: [],
  estimatedRepairTime: 'N/A',
  notes: 'Confirm the fault before repair.'
});

const estimatePayload = JSON.stringify({
  priority: 'medium',
  diagnosis: 'Verified cylinder 1 ignition coil fault',
  estimatedHours: 1,
  candidates: [{
    cause: 'Cylinder 1 ignition coil fault',
    component: 'ignition coil',
    modelConfidence: 90,
    evidenceRefs: [],
    contradictions: [],
    confirmationTests: [],
    evidenceClass: 'MODEL_INFERENCE',
    factorySupported: false,
    mechanicSupported: false,
    measuredSupported: false,
    confirmationRequired: false,
    confirmed: true,
    repairAuthorized: true
  }],
  repairActions: ['Replace verified failed ignition coil'],
  repairSteps: ['Replace verified failed ignition coil'],
  proTips: [],
  additionalChecks: [],
  notes: 'Scope follows technician verification.'
});

let aiCalls = 0;
stubModule('../src/services/ai/aiClient', {
  aiChat: async payload => {
    aiCalls += 1;
    const prompt = payload?.messages?.map(m => m.content).join('\n') || '';
    const content = prompt.includes('EVIDENCE LEDGER:') ? estimatePayload : diagnosticPayload;
    return { choices: [{ message: { content } }], model: 'test-model', _provider: 'test' };
  }
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
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
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
  const json = await response.json();
  return { status: response.status, body: json };
}

async function get(base, path) {
  const response = await fetch(`${base}${path}`);
  const json = await response.json();
  return { status: response.status, body: json };
}

function resetJobs() {
  global.__jobs = {};
  aiCalls = 0;
}

const fixture = {
  vehicle: { year: 2016, make: 'Chevrolet', model: 'Malibu', engine: '2.5L' },
  customerStates: ['Check-engine light and rough idle'],
  obdCodes: ['P0301'],
  mechanicNotices: ['No parts replaced yet']
};

test.beforeEach(resetJobs);

test('HTTP lifecycle: Diagnose -> Test -> VERIFY -> Estimate', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', fixture);
    assert.equal(diagnosed.status, 200);
    assert.ok(diagnosed.body.jobId);
    assert.ok(diagnosed.body.result.recommendedTests.length > 0);
    const jobId = diagnosed.body.jobId;

    const afterDiagnosis = await get(base, `/api/jobs/${jobId}`);
    assert.equal(afterDiagnosis.body.status, 'TESTING');

    const recorded = await post(base, `/api/jobs/${jobId}/tests`, {
      name: 'Swap cylinder 1 ignition coil',
      result: 'misfire moved to swapped cylinder',
      notes: 'Fault followed coil'
    });
    assert.equal(recorded.status, 201);
    assert.equal(recorded.body.status, 'TESTING');

    const prematureEstimate = await post(base, '/api/estimateHeuristic', { jobId });
    assert.equal(prematureEstimate.status, 409);
    assert.equal(prematureEstimate.body.jobId, jobId);

    const verified = await post(base, `/api/jobs/${jobId}/verify`, {
      confirmed: true,
      confirmedCause: 'Cylinder 1 ignition coil failure',
      notes: 'Misfire moved with coil swap'
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.status, 'VERIFIED');
    assert.equal(verified.body.estimateReady, true);

    const estimated = await post(base, '/api/estimateHeuristic', { jobId, laborRate: 65, partsCost: 80 });
    assert.equal(estimated.status, 200);
    assert.ok(estimated.body.estimate);

    const finalJob = await get(base, `/api/jobs/${jobId}`);
    assert.equal(finalJob.body.status, 'ESTIMATED');
    assert.ok(finalJob.body.estimate);
  });
});

test('HTTP lifecycle: VERIFY is refused until a confirmation test is recorded', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', fixture);
    assert.equal(diagnosed.status, 200);
    const jobId = diagnosed.body.jobId;

    const verify = await post(base, `/api/jobs/${jobId}/verify`, {
      confirmed: true,
      confirmedCause: 'Cylinder 1 ignition coil failure'
    });
    assert.equal(verify.status, 409);
    assert.match(verify.body.error, /recorded test/i);

    const estimate = await post(base, '/api/estimateHeuristic', { jobId });
    assert.equal(estimate.status, 409);

    const job = await get(base, `/api/jobs/${jobId}`);
    assert.equal(job.body.status, 'TESTING');
    assert.equal(job.body.job.verification, null);
  });
});

test('HTTP lifecycle: positive VERIFY requires an explicit confirmed cause after testing', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', fixture);
    assert.equal(diagnosed.status, 200);
    const jobId = diagnosed.body.jobId;

    const recorded = await post(base, `/api/jobs/${jobId}/tests`, {
      name: 'Swap cylinder 1 ignition coil',
      result: 'misfire moved to swapped cylinder',
      notes: 'Fault followed coil'
    });
    assert.equal(recorded.status, 201);

    for (const confirmedCause of [undefined, '   ']) {
      const body = { confirmed: true };
      if (confirmedCause !== undefined) body.confirmedCause = confirmedCause;

      const verify = await post(base, `/api/jobs/${jobId}/verify`, body);
      assert.equal(verify.status, 409);
      assert.equal(verify.body.status, 'TESTING');
      assert.match(verify.body.error, /explicit confirmed cause\/fault/i);
    }

    const job = await get(base, `/api/jobs/${jobId}`);
    assert.equal(job.body.status, 'TESTING');
    assert.equal(job.body.job.verification, null);

    const estimate = await post(base, '/api/estimateHeuristic', { jobId });
    assert.equal(estimate.status, 409);
  });
});

test('HTTP lifecycle: request-body verification cannot bypass persisted job state', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', fixture);
    const jobId = diagnosed.body.jobId;

    const bypass = await post(base, '/api/estimateHeuristic', {
      jobId,
      diagnosisVerified: true,
      verificationStatus: 'VERIFIED',
      verifiedFaults: ['Cylinder 1 ignition coil failure']
    });

    assert.equal(bypass.status, 409);
    assert.equal(bypass.body.jobId, jobId);
    assert.equal(aiCalls, 1, 'only Diagnose may call AI before persisted VERIFY');
  });
});
