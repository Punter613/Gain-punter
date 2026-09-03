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

const CONFIRMED_COIL_FAULT = 'Cylinder 1 ignition coil failure';

function confirmingCoilTest(overrides = {}) {
  return {
    name: 'Swap cylinder 1 ignition coil',
    result: 'misfire moved to swapped cylinder',
    notes: 'Fault followed coil',
    evidenceRole: 'CONFIRMS',
    confirmedFault: CONFIRMED_COIL_FAULT,
    ...overrides
  };
}

test.beforeEach(resetJobs);

test('HTTP lifecycle: Diagnose -> confirmation-grade Test -> VERIFY -> Estimate', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', fixture);
    assert.equal(diagnosed.status, 200);
    assert.ok(diagnosed.body.jobId);
    assert.ok(diagnosed.body.result.recommendedTests.length > 0);
    const jobId = diagnosed.body.jobId;

    const afterDiagnosis = await get(base, `/api/jobs/${jobId}`);
    assert.equal(afterDiagnosis.body.status, 'TESTING');

    const recorded = await post(base, `/api/jobs/${jobId}/tests`, confirmingCoilTest());
    assert.equal(recorded.status, 201);
    assert.equal(recorded.body.status, 'TESTING');
    assert.ok(recorded.body.test.id);
    assert.equal(recorded.body.test.evidenceRole, 'CONFIRMS');
    assert.equal(recorded.body.test.confirmedFault, CONFIRMED_COIL_FAULT);

    const prematureEstimate = await post(base, '/api/estimateHeuristic', { jobId });
    assert.equal(prematureEstimate.status, 409);
    assert.equal(prematureEstimate.body.jobId, jobId);

    const verified = await post(base, `/api/jobs/${jobId}/verify`, {
      confirmed: true,
      confirmedCause: CONFIRMED_COIL_FAULT,
      conclusion: 'Misfire moved with the selected coil swap test, confirming the coil as the fault.',
      notes: 'Misfire moved with coil swap',
      evidenceTestIds: [recorded.body.test.id]
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.status, 'VERIFIED');
    assert.equal(verified.body.estimateReady, true);
    assert.equal(verified.body.verification.diagnosisRevision, 1);
    assert.deepEqual(verified.body.verification.evidenceTestIds, [recorded.body.test.id]);
    assert.deepEqual(verified.body.verifiedCase.verification.evidenceTestIds, [recorded.body.test.id]);
    assert.equal(verified.body.verifiedCase.verification.diagnosisRevision, 1);

    const estimated = await post(base, '/api/estimateHeuristic', { jobId, laborRate: 65, partsCost: 80 });
    assert.equal(estimated.status, 200);
    assert.ok(estimated.body.estimate);

    const finalJob = await get(base, `/api/jobs/${jobId}`);
    assert.equal(finalJob.body.status, 'ESTIMATED');
    assert.ok(finalJob.body.estimate);
  });
});

test('HTTP lifecycle: placeholder test results do not count as evidence', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', fixture);
    const jobId = diagnosed.body.jobId;

    for (const result of ['?', 'unknown', 'N/A']) {
      const recorded = await post(base, `/api/jobs/${jobId}/tests`, {
        name: 'Swap cylinder 1 ignition coil',
        result
      });
      assert.equal(recorded.status, 409);
      assert.match(recorded.body.error, /actual observation or measurement|placeholders/i);
    }

    const job = await get(base, `/api/jobs/${jobId}`);
    assert.equal(job.body.job.tests.length, 0);
  });
});

test('HTTP lifecycle: VERIFY is refused until a confirmation test is recorded', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', fixture);
    assert.equal(diagnosed.status, 200);
    const jobId = diagnosed.body.jobId;

    const verify = await post(base, `/api/jobs/${jobId}/verify`, {
      confirmed: true,
      confirmedCause: CONFIRMED_COIL_FAULT,
      conclusion: 'Coil swap confirmed the failure.',
      evidenceTestIds: ['missing-test']
    });
    assert.equal(verify.status, 409);
    assert.match(verify.body.error, /recorded test|persisted/i);

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

    const recorded = await post(base, `/api/jobs/${jobId}/tests`, confirmingCoilTest());
    assert.equal(recorded.status, 201);

    for (const confirmedCause of [undefined, '   ']) {
      const body = {
        confirmed: true,
        conclusion: 'Misfire moved with the selected coil test.',
        evidenceTestIds: [recorded.body.test.id]
      };
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

test('HTTP lifecycle: positive VERIFY requires selected persisted evidence and mechanic conclusion', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', fixture);
    const jobId = diagnosed.body.jobId;
    const recorded = await post(base, `/api/jobs/${jobId}/tests`, confirmingCoilTest());
    assert.equal(recorded.status, 201);

    const noEvidence = await post(base, `/api/jobs/${jobId}/verify`, {
      confirmed: true,
      confirmedCause: CONFIRMED_COIL_FAULT,
      conclusion: 'Misfire moved with coil swap.'
    });
    assert.equal(noEvidence.status, 409);
    assert.match(noEvidence.body.error, /confirmation-grade test/i);

    const foreignEvidence = await post(base, `/api/jobs/${jobId}/verify`, {
      confirmed: true,
      confirmedCause: CONFIRMED_COIL_FAULT,
      conclusion: 'Misfire moved with coil swap.',
      evidenceTestIds: ['not-this-job']
    });
    assert.equal(foreignEvidence.status, 409);
    assert.match(foreignEvidence.body.error, /persisted on this job/i);

    const noConclusion = await post(base, `/api/jobs/${jobId}/verify`, {
      confirmed: true,
      confirmedCause: CONFIRMED_COIL_FAULT,
      evidenceTestIds: [recorded.body.test.id]
    });
    assert.equal(noConclusion.status, 409);
    assert.match(noConclusion.body.error, /mechanic conclusion/i);

    const job = await get(base, `/api/jobs/${jobId}`);
    assert.equal(job.body.status, 'TESTING');
    assert.equal(job.body.job.verification, null);
  });
});

test('HTTP lifecycle: neutral/supporting/refuting evidence can rerank but cannot unlock VERIFY', async () => {
  await withServer(async base => {
    for (const evidenceRole of ['NEUTRAL', 'SUPPORTS', 'REFUTES']) {
      resetJobs();
      const diagnosed = await post(base, '/api/diagnose', fixture);
      const jobId = diagnosed.body.jobId;
      const recorded = await post(base, `/api/jobs/${jobId}/tests`, {
        name: 'Road-test torque reversal observation',
        result: 'Mechanical driveline impact reproduced during throttle release and torque reversal.',
        evidenceRole
      });
      assert.equal(recorded.status, 201);
      assert.equal(recorded.body.test.evidenceRole, evidenceRole);

      const verify = await post(base, `/api/jobs/${jobId}/verify`, {
        confirmed: true,
        confirmedCause: 'Worn propeller shaft U-joint',
        conclusion: 'Road test points toward the driveline.',
        evidenceTestIds: [recorded.body.test.id]
      });
      assert.equal(verify.status, 409);
      assert.match(verify.body.error, /CONFIRMS|confirmation-grade/i);

      const job = await get(base, `/api/jobs/${jobId}`);
      assert.equal(job.body.status, 'TESTING');
      assert.equal(job.body.job.verification, null);

      const estimate = await post(base, '/api/estimateHeuristic', { jobId });
      assert.equal(estimate.status, 409);
    }
  });
});

test('HTTP lifecycle: CONFIRMS evidence must name the fault at test-save time', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', fixture);
    const jobId = diagnosed.body.jobId;

    const recorded = await post(base, `/api/jobs/${jobId}/tests`, {
      name: 'Coil swap',
      result: 'misfire moved with coil',
      evidenceRole: 'CONFIRMS'
    });
    assert.equal(recorded.status, 409);
    assert.match(recorded.body.error, /must name the exact fault/i);

    const job = await get(base, `/api/jobs/${jobId}`);
    assert.equal(job.body.job.tests.length, 0);
  });
});

test('HTTP lifecycle: positive VERIFY fault must match selected CONFIRMS evidence', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', fixture);
    const jobId = diagnosed.body.jobId;
    const recorded = await post(base, `/api/jobs/${jobId}/tests`, confirmingCoilTest());
    assert.equal(recorded.status, 201);

    const verify = await post(base, `/api/jobs/${jobId}/verify`, {
      confirmed: true,
      confirmedCause: 'Cylinder 1 spark plug failure',
      conclusion: 'Trying to bind a different fault to the same test.',
      evidenceTestIds: [recorded.body.test.id]
    });
    assert.equal(verify.status, 409);
    assert.match(verify.body.error, /must exactly match/i);

    const job = await get(base, `/api/jobs/${jobId}`);
    assert.equal(job.body.status, 'TESTING');
    assert.equal(job.body.job.verification, null);
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
      verifiedFaults: [CONFIRMED_COIL_FAULT]
    });

    assert.equal(bypass.status, 409);
    assert.equal(bypass.body.jobId, jobId);
    assert.equal(aiCalls, 1, 'only Diagnose may call AI before persisted VERIFY');
  });
});

test('HTTP lifecycle: unverified diagnosis returns a best diagnosis but cannot unlock Estimate', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', fixture);
    assert.equal(diagnosed.status, 200);
    const jobId = diagnosed.body.jobId;

    const fallback = await post(base, `/api/jobs/${jobId}/unverified-diagnosis`, {});
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.status, 'TESTING');
    assert.equal(fallback.body.diagnosisState, 'UNVERIFIED_DIAGNOSIS');
    assert.equal(fallback.body.unverifiedDiagnosis.state, 'UNVERIFIED_DIAGNOSIS');
    assert.equal(fallback.body.unverifiedDiagnosis.mostLikelyCause, 'Cylinder 1 ignition fault requires confirmation');
    assert.equal(fallback.body.unverifiedDiagnosis.physicallyVerified, false);
    assert.equal(fallback.body.unverifiedDiagnosis.repairAuthorized, false);
    assert.equal(fallback.body.unverifiedDiagnosis.estimateReady, false);
    assert.equal(fallback.body.unverifiedDiagnosis.learningEligible, false);
    assert.match(fallback.body.unverifiedDiagnosis.warning, /not been physically verified/i);
    assert.equal(fallback.body.verifiedCase, null);
    assert.equal(fallback.body.estimateReady, false);
    assert.equal(aiCalls, 1, 'fallback must use persisted diagnosis/evidence rather than minting a second unverifiable model answer');

    const estimate = await post(base, '/api/estimateHeuristic', {
      jobId,
      diagnosisVerified: true,
      verificationStatus: 'UNVERIFIED_DIAGNOSIS',
      verifiedFaults: [fallback.body.unverifiedDiagnosis.mostLikelyCause]
    });
    assert.equal(estimate.status, 409);

    const job = await get(base, `/api/jobs/${jobId}`);
    assert.equal(job.body.job.status, 'TESTING');
    assert.equal(job.body.job.verification, null);
    assert.equal(job.body.job.verifiedCase, undefined);
    assert.equal(job.body.unverifiedDiagnosis.state, 'UNVERIFIED_DIAGNOSIS');
  });
});

test('HTTP lifecycle: later physical VERIFY supersedes but never converts UNVERIFIED_DIAGNOSIS into verified truth', async () => {
  await withServer(async base => {
    const diagnosed = await post(base, '/api/diagnose', fixture);
    const jobId = diagnosed.body.jobId;

    const fallback = await post(base, `/api/jobs/${jobId}/unverified-diagnosis`, {});
    assert.equal(fallback.status, 200);

    const noTestVerify = await post(base, `/api/jobs/${jobId}/verify`, {
      confirmed: true,
      confirmedCause: fallback.body.unverifiedDiagnosis.mostLikelyCause,
      conclusion: 'SKSK said it was likely.',
      evidenceTestIds: []
    });
    assert.equal(noTestVerify.status, 409);

    const recorded = await post(base, `/api/jobs/${jobId}/tests`, confirmingCoilTest());
    assert.equal(recorded.status, 201);

    const afterNewEvidence = await get(base, `/api/jobs/${jobId}`);
    assert.equal(afterNewEvidence.body.job.unverifiedDiagnosis.stale, true);
    assert.equal(afterNewEvidence.body.job.unverifiedDiagnosis.supersededBy, 'NEW_TEST_EVIDENCE');

    const verified = await post(base, `/api/jobs/${jobId}/verify`, {
      confirmed: true,
      confirmedCause: CONFIRMED_COIL_FAULT,
      conclusion: 'Misfire moved with the selected coil swap test, physically confirming the coil fault.',
      evidenceTestIds: [recorded.body.test.id]
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.status, 'VERIFIED');
    assert.equal(verified.body.verifiedCase.stage, 'VERIFIED');
    assert.equal(verified.body.verifiedCase.verification.confirmedCause, CONFIRMED_COIL_FAULT);
    assert.ok(!JSON.stringify(verified.body.verifiedCase).includes('UNVERIFIED_DIAGNOSIS'));

    const job = await get(base, `/api/jobs/${jobId}`);
    assert.equal(job.body.job.unverifiedDiagnosis.state, 'UNVERIFIED_DIAGNOSIS');
    assert.equal(job.body.job.unverifiedDiagnosis.supersededBy, 'VERIFIED_CASE');
    assert.ok(job.body.job.unverifiedDiagnosis.supersededAt);
    assert.equal(job.body.job.verifiedCase.verification.confirmedCause, CONFIRMED_COIL_FAULT);
  });
});
