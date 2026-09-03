'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVerifiedCase } = require('../src/core/evidence/verified.case');
const {
  buildVerifiedRepairResolution,
  canonicalOperationId,
  verifiedOperations
} = require('../src/core/evidence/verified.repair.resolution');

function makeVerifiedCase(confirmedCause = 'Ignition coil failure') {
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
    jobId: 'repair-resolution-edge-job',
    status: 'VERIFIED',
    vehicle: evidencePacket.vehicle,
    diagnosis: { result: { primaryCause: confirmedCause, probability: [] }, evidencePacket, revision: 1 },
    tests: [{
      id: 'T1',
      name: 'confirmation test',
      result: 'fault confirmed',
      evidenceRole: 'CONFIRMS',
      confirmedFault: confirmedCause
    }],
    verification: {
      confirmed: true,
      confirmedCause,
      conclusion: 'Confirmed by test',
      notes: 'Edge-case fixture',
      evidenceTestIds: ['T1'],
      diagnosisRevision: 1,
      verifiedAt: '2026-08-15T00:00:00.000Z'
    }
  });
}

test('missing or non-numeric advisory labor hours fail closed instead of resolving to zero', () => {
  const verifiedCase = makeVerifiedCase();
  for (const modelEstimatedHours of [undefined, null, '', 'not-a-number', false]) {
    assert.throws(
      () => buildVerifiedRepairResolution({
        verifiedCase,
        laborRate: 65,
        modelEstimatedHours,
        partsCost: 80
      }),
      /requires explicit or valid advisory labor hours/i,
      `expected fail-closed behavior for ${String(modelEstimatedHours)}`
    );
  }
});

test('explicit mechanic zero hours remains valid even when advisory hours are missing', () => {
  const verifiedCase = makeVerifiedCase();
  const resolution = buildVerifiedRepairResolution({
    verifiedCase,
    laborRate: 65,
    laborHours: 0,
    modelEstimatedHours: undefined,
    partsCost: 80
  });
  assert.equal(resolution.labor.hours, 0);
  assert.equal(resolution.labor.hoursSource, 'MECHANIC_INPUT');
});

test('Unicode-only verified causes receive stable bounded operation IDs', () => {
  const verifiedCase = makeVerifiedCase('点火コイル故障');
  const operations = verifiedOperations(verifiedCase.repairScope);
  assert.equal(operations.length, 1);
  assert.match(operations[0].operationId, /^VERIFY_OP_1_[a-f0-9]{32}$/);
  assert.ok(operations[0].operationId.length < 200);

  const resolution = buildVerifiedRepairResolution({
    verifiedCase,
    laborRate: 65,
    laborHours: 1,
    partsCost: 80
  });
  assert.equal(resolution.labor.operationId, operations[0].operationId);
});

test('long verified causes cannot exceed operation binding length', () => {
  const longCause = `Front suspension ${'control-arm-bushing-failure '.repeat(20)}`.slice(0, 300);
  const verifiedCase = makeVerifiedCase(longCause);
  const operationId = canonicalOperationId(verifiedCase.repairScope[0], 0);
  assert.match(operationId, /^VERIFY_OP_1_[a-f0-9]{32}$/);
  assert.ok(operationId.length < 200);

  const resolution = buildVerifiedRepairResolution({
    verifiedCase,
    laborRate: 65,
    laborHours: 2,
    parts: [{ operationId, description: 'Verified repair part', quantity: 1, unitPrice: 25 }]
  });
  assert.equal(resolution.labor.operationId, operationId);
  assert.equal(resolution.parts[0].operationId, operationId);
});

test('operation IDs are deterministic for the same verified scope and distinct across scopes', () => {
  const first = canonicalOperationId({ component: 'coil', cause: '点火コイル故障' }, 0);
  const second = canonicalOperationId({ component: 'coil', cause: '点火コイル故障' }, 0);
  const different = canonicalOperationId({ component: 'coil', cause: '別の故障' }, 0);
  assert.equal(first, second);
  assert.notEqual(first, different);
});
