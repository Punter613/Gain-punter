'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagnosticEvidencePacket } = require('../src/core/evidence/diagnostic.evidence.packet');
const { buildVerifiedCase, verifiedEstimateInput } = require('../src/core/evidence/verified.case');

function jobFixture() {
  const evidencePacket = buildDiagnosticEvidencePacket({
    vin: 'KNDJC735785123456',
    mileage: 150000,
    vehicle: {
      year: 2008,
      make: 'Kia', model: 'Sorento',
      engine: '3.8L',
      drivetrain: '4WD',
      componentData: { brakes: { padThicknessMm: 0 } }
    },
    customerObservations: ['bump on accelerator release'],
    mechanicObservations: ['CV axles replaced'],
    dtcEvidence: [
      { code: 'P0300', source: 'SCAN_TOOL', verified: true },
      { code: 'P0171', source: 'SCAN_TOOL', verified: true }
    ],
    tsbReferences: [{ sourceAuthority: 'NHTSA_BULK', bulletinNumber: 'TEST-1', title: 'Misfire bulletin', bodyText: 'P0300 diagnostic information' }],
    evidenceAvailable: true
  });

  return {
    jobId: 'SKSK-TEST-1',
    status: 'VERIFIED',
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    diagnosis: {
      result: { primaryCause: 'Engine mount failure', probability: [{ cause: 'Engine mount failure', likelihood: 80 }] },
      evidencePacket,
      revision: 2
    },
    tests: [{
      id: 'T1',
      name: 'Power-brake mount test',
      result: 'excess movement',
      evidenceRole: 'CONFIRMS',
      confirmedFault: 'Engine mount failure',
      recordedAt: '2026-08-15T00:00:00.000Z'
    }],
    verification: {
      confirmed: true,
      confirmedCause: 'Engine mount failure',
      conclusion: 'Excess engine movement observed under load',
      evidenceTestIds: ['T1'],
      notes: 'Fault confirmed by technician',
      diagnosisRevision: 2,
      verifiedAt: '2026-08-15T00:01:00.000Z'
    }
  };
}

test('VERIFIED_CASE freezes the persisted diagnosis packet, tests, explicit fault, and confirmation-grade evidence', () => {
  const source = jobFixture();
  const verifiedCase = buildVerifiedCase(source);

  assert.equal(verifiedCase.schemaVersion, 1);
  assert.equal(verifiedCase.stage, 'VERIFIED');
  assert.equal(verifiedCase.verification.confirmedCause, 'Engine mount failure');
  assert.deepEqual(verifiedCase.verification.evidenceTestIds, ['T1']);
  assert.equal(verifiedCase.verification.diagnosisRevision, 2);
  assert.equal(verifiedCase.diagnosis.revision, 2);
  assert.equal(verifiedCase.tests[0].evidenceRole, 'CONFIRMS');
  assert.equal(verifiedCase.tests[0].confirmedFault, 'Engine mount failure');
  assert.equal(verifiedCase.tests[0].result, 'excess movement');
  assert.equal(verifiedCase.evidencePacket.dtcs[0], 'P0300');
  assert.equal(verifiedCase.evidencePacket.dtcProvenance.verifiedCount, 2);
  assert.equal(verifiedCase.evidencePacket.measurements.values.brakes.padThickness, 0);
  assert.ok(verifiedCase.fingerprint);

  source.tests[0].result = 'request body tried to rewrite test';
  source.verification.evidenceTestIds[0] = 'OTHER';
  source.diagnosis.evidencePacket.dtcs[0] = 'P9999';
  assert.equal(verifiedCase.tests[0].result, 'excess movement');
  assert.deepEqual(verifiedCase.verification.evidenceTestIds, ['T1']);
  assert.equal(verifiedCase.evidencePacket.dtcs[0], 'P0300');
});

test('estimate handoff derives authorization fields only from VERIFIED_CASE', () => {
  const verifiedCase = buildVerifiedCase(jobFixture());
  const input = verifiedEstimateInput(verifiedCase);

  assert.equal(input.diagnosisVerified, true);
  assert.equal(input.verificationStatus, 'VERIFIED');
  assert.deepEqual(input.verifiedFaults, [{ component: 'Engine mount failure', cause: 'Engine mount failure' }]);
  assert.equal(input.diagnosticTests[0].result, 'excess movement');
});

test('tampering with a persisted VERIFIED_CASE fails integrity validation', () => {
  const verifiedCase = JSON.parse(JSON.stringify(buildVerifiedCase(jobFixture())));
  verifiedCase.verification.confirmedCause = 'Injected request-body fault';
  assert.throws(() => verifiedEstimateInput(verifiedCase), /integrity check failed/i);
});

test('verified case cannot be created from unverified state, implicit cause, unbound evidence, or non-confirming evidence', () => {
  const unverified = jobFixture();
  unverified.status = 'TESTING';
  assert.throws(() => buildVerifiedCase(unverified), /VERIFIED status/i);

  const missingCause = jobFixture();
  missingCause.verification.confirmedCause = '   ';
  assert.throws(() => buildVerifiedCase(missingCause), /explicit confirmed cause/i);

  const missingEvidence = jobFixture();
  missingEvidence.verification.evidenceTestIds = [];
  assert.throws(() => buildVerifiedCase(missingEvidence), /confirmation-grade test evidence/i);

  const foreignEvidence = jobFixture();
  foreignEvidence.verification.evidenceTestIds = ['NOT-A-JOB-TEST'];
  assert.throws(() => buildVerifiedCase(foreignEvidence), /persisted job tests/i);

  const neutralEvidence = jobFixture();
  neutralEvidence.tests[0].evidenceRole = 'NEUTRAL';
  neutralEvidence.tests[0].confirmedFault = '';
  assert.throws(() => buildVerifiedCase(neutralEvidence), /classified CONFIRMS/i);

  const mismatchedFault = jobFixture();
  mismatchedFault.tests[0].confirmedFault = 'Transmission mount failure';
  assert.throws(() => buildVerifiedCase(mismatchedFault), /same confirmed fault/i);
});
