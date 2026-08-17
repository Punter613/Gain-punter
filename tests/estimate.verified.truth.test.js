'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { buildVerifiedCase } = require('../src/core/evidence/verified.case');

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let lastPrompt = '';
stubModule('../src/services/ai/aiClient', {
  aiChat: async payload => {
    lastPrompt = payload.messages.map(message => message.content).join('\n');
    return {
      model: 'test-model',
      _provider: 'test',
      choices: [{ message: { content: JSON.stringify({
        priority: 'medium',
        diagnosis: 'Completely different alternator failure',
        estimatedHours: 1.5,
        candidates: [{
          cause: 'Alternator failure',
          component: 'alternator',
          modelConfidence: 99,
          evidenceRefs: [],
          contradictions: [],
          confirmationTests: ['Replace alternator'],
          evidenceClass: 'MODEL_INFERENCE',
          factorySupported: false,
          mechanicSupported: false,
          measuredSupported: false,
          confirmationRequired: false,
          confirmed: true,
          repairAuthorized: true
        }],
        repairActions: [{
          action: 'Replace alternator',
          component: 'alternator',
          evidenceRefs: [],
          confirmationRequired: false,
          repairAuthorized: true
        }],
        repairSteps: ['Remove alternator'],
        proTips: [],
        additionalChecks: [],
        notes: 'Contradictory model output'
      }) } }]
    };
  }
});

const estimateRouter = require('../src/routes/estimate');

function makeVerifiedCase({ rustMultiplier } = {}) {
  const vehicleProfile = { vehicleId: 'KIA_SORENTO_TEST' };
  if (rustMultiplier !== undefined) vehicleProfile.rustMultiplier = rustMultiplier;

  const evidencePacket = {
    schemaVersion: 1,
    stage: 'DIAGNOSE',
    vehicle: { vin: 'KNDTEST123', year: 2008, make: 'Kia', model: 'Sorento', mileage: 150000, drivetrain: '4WD' },
    observations: {
      customer: ['clunk on deceleration'],
      mechanic: ['CV axles replaced'],
      completedWork: ['cv axle']
    },
    dtcs: ['P0300'],
    measurements: { trust: 'TRUSTED_PRE_TAG_INPUT', values: {} },
    deterministic: { vehicleProfile },
    evidence: {
      oem: [{ source: 'LEMON_MANUALS', title: 'Verified OEM page', url: 'https://verified.example/oem', excerpt: 'mount inspection' }],
      tsbs: [{ source: 'NHTSA_BULK', title: 'Verified TSB', url: 'https://verified.example/tsb', excerpt: 'mount concern' }],
      sources: ['LEMON_MANUALS', 'NHTSA_BULK'],
      available: true
    },
    contradictions: []
  };

  return buildVerifiedCase({
    jobId: 'job-estimate-truth',
    status: 'VERIFIED',
    vehicle: evidencePacket.vehicle,
    diagnosis: {
      result: { primaryCause: 'Engine mount failure', probability: [{ cause: 'Engine mount failure', likelihood: 90 }] },
      evidencePacket
    },
    tests: [{ id: 'T1', name: 'Power-brake mount test', result: 'excessive engine movement', notes: 'mount separates under load' }],
    verification: {
      confirmed: true,
      confirmedCause: 'Engine mount failure',
      conclusion: 'Movement reproduced and isolated to failed mount',
      notes: 'Confirmed by mechanic',
      supportingTestIds: ['T1'],
      verifiedAt: '2026-08-15T00:00:00.000Z'
    }
  });
}

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

async function post(base, body) {
  const response = await fetch(`${base}/estimate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

function assertSafeVerifiedCaseFailure(result) {
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'Verified diagnostic truth is required for estimate generation.');
  assert.equal(result.body.code, 'VERIFIED_CASE_REQUIRED_OR_INVALID');
  assert.equal('details' in result.body, false);
  assert.equal('estimate' in result.body, false);
  assert.ok(result.body.traceId);
}

test('Estimate fails closed without a canonical VERIFIED_CASE', async () => {
  await withServer(async base => {
    const result = await post(base, { laborRate: 65, partsCost: 80 });
    assertSafeVerifiedCaseFailure(result);
  });
});

test('Estimate forces contradictory model diagnosis back to verified cause', async () => {
  const verifiedCase = makeVerifiedCase();
  await withServer(async base => {
    const result = await post(base, {
      verifiedCase,
      laborRate: 65,
      partsCost: 80,
      vin: 'TAMPEREDVIN',
      obdCodes: ['P9999'],
      customerStates: ['different symptom']
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.estimate.diagnosis, 'Verified fault: Engine mount failure');
    assert.equal(result.body.estimate.candidates.length, 1);
    assert.equal(result.body.estimate.candidates[0].cause, 'Engine mount failure');
    assert.equal(result.body.estimate.candidates[0].component, 'Engine mount failure');
    assert.equal(result.body.estimate.candidates[0].confirmed, true);
    assert.equal(result.body.estimate.candidates[0].repairAuthorized, true);
    assert.deepEqual(result.body.estimate.probability, [{ cause: 'Engine mount failure', likelihood: 100 }]);
    assert.deepEqual(result.body.estimate.repairs, ['Repair verified fault: Engine mount failure']);
    assert.deepEqual(result.body.estimate.repairSteps, []);
    assert.doesNotMatch(JSON.stringify(result.body.estimate), /alternator|TAMPEREDVIN|P9999|different symptom/i);
    assert.match(lastPrompt, /VERIFIED CAUSE: Engine mount failure/);
    assert.doesNotMatch(lastPrompt, /TAMPEREDVIN|P9999|different symptom/);
  });
});

test('Estimate uses only evidence frozen in VERIFIED_CASE and makes missing rust adjustment explicit', async () => {
  const verifiedCase = makeVerifiedCase();
  await withServer(async base => {
    const result = await post(base, { verifiedCase, laborRate: 70, partsCost: 125 });
    assert.equal(result.status, 200);
    assert.equal(result.body.estimate.evidence.oem[0].title, 'Verified OEM page');
    assert.equal(result.body.estimate.evidence.tsbs[0].title, 'Verified TSB');
    assert.equal(result.body.estimate.evidence.verifiedCaseFingerprint, verifiedCase.fingerprint);
    assert.equal(result.body.estimate.laborCost, 105);
    assert.equal(result.body.estimate.partsCost, 125);
    assert.equal(result.body.estimate.total, 230);
    assert.equal(result.body.appliedRustPenalty, false);
    assert.deepEqual(result.body.estimate.rustAdjustment, {
      applied: false,
      reason: 'not_present_in_verified_packet'
    });
  });
});

test('Estimate applies rust adjustment only when it is persisted in VERIFIED_CASE', async () => {
  const verifiedCase = makeVerifiedCase({ rustMultiplier: 1.2 });
  await withServer(async base => {
    const result = await post(base, { verifiedCase, laborRate: 100, partsCost: 50 });
    assert.equal(result.status, 200);
    assert.equal(result.body.appliedRustPenalty, true);
    assert.equal(result.body.estimate.laborCost, 180);
    assert.equal(result.body.estimate.partsCost, 50);
    assert.equal(result.body.estimate.total, 230);
    assert.deepEqual(result.body.estimate.rustAdjustment, {
      applied: true,
      multiplier: 1.2,
      source: 'VERIFIED_CASE'
    });
  });
});

test('Estimate rejects a mutated VERIFIED_CASE fingerprint without leaking internals', async () => {
  const verifiedCase = JSON.parse(JSON.stringify(makeVerifiedCase()));
  verifiedCase.verification.confirmedCause = 'Tampered steering rack failure';
  await withServer(async base => {
    const result = await post(base, { verifiedCase });
    assertSafeVerifiedCaseFailure(result);
    assert.doesNotMatch(JSON.stringify(result.body), /integrity check failed|steering rack/i);
  });
});