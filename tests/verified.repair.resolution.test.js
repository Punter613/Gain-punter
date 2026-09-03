'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { buildVerifiedCase, fingerprint } = require('../src/core/evidence/verified.case');
const {
  buildVerifiedRepairResolution,
  assertRepairResolutionIntegrity,
  MAX_PART_LINES,
  verifiedOperations
} = require('../src/core/evidence/verified.repair.resolution');

function makeVerifiedCase() {
  const evidencePacket = {
    schemaVersion: 1,
    stage: 'DIAGNOSE',
    vehicle: { year: 2016, make: 'Chevrolet', model: 'Malibu', engine: '2.5L' },
    observations: { customer: ['rough idle'], mechanic: [], completedWork: [] },
    dtcs: ['P0301'],
    measurements: { trust: 'TRUSTED_PRE_TAG_INPUT', values: {} },
    deterministic: { vehicleProfile: { vehicleId: 'CHEVROLET_MALIBU_TEST' } },
    evidence: { oem: [], tsbs: [], sources: [], available: false },
    contradictions: []
  };

  return buildVerifiedCase({
    jobId: 'repair-resolution-job',
    status: 'VERIFIED',
    vehicle: evidencePacket.vehicle,
    diagnosis: { result: { primaryCause: 'Ignition coil failure', probability: [] }, evidencePacket, revision: 1 },
    tests: [{
      id: 'T1',
      name: 'coil swap',
      result: 'misfire moved',
      evidenceRole: 'CONFIRMS',
      confirmedFault: 'Ignition coil failure'
    }],
    verification: {
      confirmed: true,
      confirmedCause: 'Ignition coil failure',
      conclusion: 'Fault followed coil',
      notes: 'Confirmed by mechanic',
      evidenceTestIds: ['T1'],
      diagnosisRevision: 1,
      verifiedAt: '2026-08-15T00:00:00.000Z'
    }
  });
}

test('repair resolution is bound to VERIFIED_CASE and mechanic-owned pricing inputs', () => {
  const verifiedCase = makeVerifiedCase();
  const resolution = buildVerifiedRepairResolution({
    verifiedCase,
    laborRate: 65,
    laborRateSource: 'MECHANIC_INPUT',
    laborHours: 1.5,
    modelEstimatedHours: 4,
    parts: [
      { partNumber: 'COIL-1', description: 'Ignition coil', quantity: 1, unitPrice: 72.5 },
      { partNumber: 'BOOT-1', description: 'Coil boot', quantity: 2, unitPrice: 6.25 }
    ]
  });

  assert.equal(resolution.verifiedCaseFingerprint, verifiedCase.fingerprint);
  assert.deepEqual(resolution.repairScope, verifiedCase.repairScope);
  assert.deepEqual(resolution.operations, verifiedOperations(verifiedCase.repairScope));
  assert.equal(resolution.operations.length, 1);
  assert.equal(resolution.labor.operationId, resolution.operations[0].operationId);
  assert.ok(resolution.parts.every(part => part.operationId === resolution.operations[0].operationId));
  assert.equal(resolution.labor.hours, 1.5);
  assert.equal(resolution.labor.hoursSource, 'MECHANIC_INPUT');
  assert.equal(resolution.labor.hourlyRate, 65);
  assert.equal(resolution.labor.rateSource, 'MECHANIC_INPUT');
  assert.equal(resolution.partsTotal, 85);
  assert.equal(resolution.pricingAuthority, 'MECHANIC');
  assert.equal(resolution.diagnosticAuthority, 'VERIFIED_CASE');
  assert.ok(resolution.fingerprint);
  assert.doesNotThrow(() => assertRepairResolutionIntegrity(resolution, verifiedCase));
});

test('model labor hours remain explicitly advisory when mechanic hours are absent', () => {
  const verifiedCase = makeVerifiedCase();
  const resolution = buildVerifiedRepairResolution({
    verifiedCase,
    laborRate: 70,
    modelEstimatedHours: 2.25,
    partsCost: 90
  });

  assert.equal(resolution.labor.hours, 2.25);
  assert.equal(resolution.labor.hoursSource, 'MODEL_ADVISORY');
  assert.equal(resolution.partsTotal, 90);
  assert.equal(resolution.parts[0].source, 'MECHANIC_INPUT');
});

test('null blank and boolean laborHours do not override advisory hours', () => {
  const verifiedCase = makeVerifiedCase();
  for (const laborHours of [null, '', '   ', false, true]) {
    const resolution = buildVerifiedRepairResolution({
      verifiedCase,
      laborRate: 65,
      laborHours,
      modelEstimatedHours: 2.5
    });
    assert.equal(resolution.labor.hours, 2.5, `unexpected override for ${String(laborHours)}`);
    assert.equal(resolution.labor.hoursSource, 'MODEL_ADVISORY');
  }
});

test('explicit numeric zero labor hours is preserved as mechanic input', () => {
  const verifiedCase = makeVerifiedCase();
  for (const laborHours of [0, '0']) {
    const resolution = buildVerifiedRepairResolution({
      verifiedCase,
      laborRate: 65,
      laborHours,
      modelEstimatedHours: 2.5
    });
    assert.equal(resolution.labor.hours, 0);
    assert.equal(resolution.labor.hoursSource, 'MECHANIC_INPUT');
  }
});

test('labor rate provenance preserves system default source', () => {
  const verifiedCase = makeVerifiedCase();
  const resolution = buildVerifiedRepairResolution({
    verifiedCase,
    laborRate: 65,
    laborRateSource: 'SYSTEM_DEFAULT',
    modelEstimatedHours: 1
  });
  assert.equal(resolution.labor.hourlyRate, 65);
  assert.equal(resolution.labor.rateSource, 'SYSTEM_DEFAULT');
});

test('oversized part lists fail closed instead of truncating totals', () => {
  const verifiedCase = makeVerifiedCase();
  const parts = Array.from({ length: MAX_PART_LINES + 1 }, (_, index) => ({
    description: `Part ${index + 1}`,
    quantity: 1,
    unitPrice: 1
  }));
  assert.throws(
    () => buildVerifiedRepairResolution({ verifiedCase, laborRate: 65, modelEstimatedHours: 1, parts }),
    /at most 40 part lines/i
  );
});

test('altered labor operation identifiers fail closed', () => {
  const verifiedCase = makeVerifiedCase();
  assert.throws(
    () => buildVerifiedRepairResolution({
      verifiedCase,
      laborRate: 65,
      laborHours: 1,
      operationId: 'VERIFY_OP_999_ALTERNATE_REPAIR'
    }),
    /bind to a VERIFIED_CASE repair operation/i
  );
});

test('part lines cannot bind to an operation outside VERIFIED_CASE', () => {
  const verifiedCase = makeVerifiedCase();
  assert.throws(
    () => buildVerifiedRepairResolution({
      verifiedCase,
      laborRate: 65,
      laborHours: 1,
      parts: [{
        operationId: 'VERIFY_OP_999_UNVERIFIED_REPAIR',
        description: 'Unverified repair part',
        quantity: 1,
        unitPrice: 50
      }]
    }),
    /bind to a VERIFIED_CASE repair operation/i
  );
});

test('altered operation set fails integrity validation even with recomputed outer fingerprint', () => {
  const verifiedCase = makeVerifiedCase();
  const resolution = JSON.parse(JSON.stringify(buildVerifiedRepairResolution({
    verifiedCase,
    laborRate: 65,
    laborHours: 1,
    partsCost: 80
  })));
  resolution.operations[0].cause = 'Different repair';
  delete resolution.fingerprint;
  resolution.fingerprint = fingerprint(resolution);
  assert.throws(() => assertRepairResolutionIntegrity(resolution, verifiedCase), /operation set/i);
});

test('tampered repair resolution fails integrity validation', () => {
  const verifiedCase = makeVerifiedCase();
  const resolution = JSON.parse(JSON.stringify(buildVerifiedRepairResolution({
    verifiedCase,
    laborRate: 65,
    laborHours: 1,
    partsCost: 80
  })));
  resolution.labor.hours = 9;
  assert.throws(() => assertRepairResolutionIntegrity(resolution, verifiedCase), /integrity/i);
});

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let lastAiPrompt = '';
stubModule('../src/services/ai/aiClient', {
  aiChat: async payload => {
    lastAiPrompt = (payload?.messages || []).map(message => message.content).join('\n');
    return {
      model: 'test-model',
      _provider: 'test',
      choices: [{ message: { content: JSON.stringify({
        priority: 'medium',
        diagnosis: 'wrong model wording',
        estimatedHours: 4,
        candidates: [{
          cause: 'wrong cause', component: 'wrong component', modelConfidence: 80,
          evidenceRefs: [], contradictions: [], confirmationTests: [], evidenceClass: 'MODEL_INFERENCE',
          factorySupported: false, mechanicSupported: false, measuredSupported: false,
          confirmationRequired: false, confirmed: true, repairAuthorized: true
        }],
        repairActions: [], repairSteps: [], proTips: [], additionalChecks: [], notes: ''
      }) } }]
    };
  }
});

const estimateRouter = require('../src/routes/estimate');

async function withServer(run) {
  const app = express();
  app.use(express.json());
  app.use('/estimate', estimateRouter);
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

test('Estimate deterministically consumes resolved mechanic labor and parts while keeping verified scope', async () => {
  const verifiedCase = makeVerifiedCase();
  await withServer(async base => {
    const response = await fetch(`${base}/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        verifiedCase,
        laborRate: 65,
        laborHours: 1.5,
        parts: [
          { description: 'Ignition coil', quantity: 1, unitPrice: 75 },
          { description: 'Boot', quantity: 2, unitPrice: 5 }
        ]
      })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.estimate.estimatedHours, 1.5);
    assert.equal(body.estimate.laborCost, 97.5);
    assert.equal(body.estimate.partsCost, 85);
    assert.equal(body.estimate.total, 182.5);
    assert.equal(body.estimate.repairResolution.labor.hoursSource, 'MECHANIC_INPUT');
    assert.equal(body.estimate.repairResolution.labor.rateSource, 'MECHANIC_INPUT');
    assert.equal(body.estimate.repairResolution.partsTotal, 85);
    assert.equal(body.estimate.repairResolution.verifiedCaseFingerprint, verifiedCase.fingerprint);
    assert.equal(body.estimate.repairResolution.labor.operationId, body.estimate.repairResolution.operations[0].operationId);
    assert.ok(body.estimate.repairResolution.parts.every(part => part.operationId === body.estimate.repairResolution.operations[0].operationId));
    assert.equal(body.estimate.candidates[0].cause, 'Ignition coil failure');
    assert.equal(body.estimate.probability[0].likelihood, 100);
    assert.equal(body.estimate.evidence.repairResolutionFingerprint, body.estimate.repairResolution.fingerprint);
  });
});

test('Estimate ignores tampered request vehicle and repair text in favor of VERIFIED_CASE', async () => {
  const verifiedCase = makeVerifiedCase();
  lastAiPrompt = '';
  await withServer(async base => {
    const response = await fetch(`${base}/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        verifiedCase,
        vehicle: { year: 2025, make: 'Ford', model: 'F-150' },
        vin: 'TAMPEREDVIN',
        repairScope: [{ cause: 'Replace transmission' }],
        verifiedDiagnosis: { confirmedCause: 'Replace transmission' },
        laborHours: 1,
        partsCost: 10
      })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.match(lastAiPrompt, /2016 Chevrolet Malibu/);
    assert.doesNotMatch(lastAiPrompt, /2025 Ford F-150|TAMPEREDVIN|Replace transmission/);
    assert.equal(body.estimate.repairResolution.repairScope[0].cause, 'Ignition coil failure');
    assert.equal(body.estimate.candidates[0].cause, 'Ignition coil failure');
  });
});

test('Estimate fails closed when a part line names an unverified operation', async () => {
  const verifiedCase = makeVerifiedCase();
  await withServer(async base => {
    const response = await fetch(`${base}/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        verifiedCase,
        laborHours: 1,
        parts: [{
          operationId: 'VERIFY_OP_999_UNVERIFIED_REPAIR',
          description: 'Transmission assembly',
          quantity: 1,
          unitPrice: 1000
        }]
      })
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.success, false);
    assert.equal(body.code, 'VERIFIED_CASE_REQUIRED_OR_INVALID');
    assert.equal(body.estimate, undefined);
  });
});

test('Estimate marks omitted labor rate as system default', async () => {
  const verifiedCase = makeVerifiedCase();
  await withServer(async base => {
    const response = await fetch(`${base}/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verifiedCase, laborHours: 1, partsCost: 10 })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.estimate.repairResolution.labor.hourlyRate, 65);
    assert.equal(body.estimate.repairResolution.labor.rateSource, 'SYSTEM_DEFAULT');
  });
});
