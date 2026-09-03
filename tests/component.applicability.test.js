'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONFIGURATION_STATUS,
  buildVehicleConfigurationBoundary,
  applyComponentApplicabilityGuard
} = require('../src/core/evidence/component.applicability');
const {
  sanitizeReassessment,
  buildReassessmentPayload
} = require('../src/services/diagnostic.reassessment');

function manualSorentoBoundary() {
  return buildVehicleConfigurationBoundary({
    suppliedVehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: '2.7L V6' },
    resolvedVehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: '2.7L V6' },
    vinDecoded: false
  });
}

test('manual intake cannot promote configuration-sensitive driveline parts to primary diagnosis', () => {
  const guarded = applyComponentApplicabilityGuard({
    primaryCause: 'Worn driveshaft center support bearing or universal joints',
    secondaryCauses: ['Transfer case mount wear'],
    probability: [
      { cause: 'Center support bearing wear', likelihood: 55 },
      { cause: 'Universal joint wear', likelihood: 45 }
    ],
    recommendedTests: [
      'Inspect driveshaft center support bearing and universal joints for play.'
    ],
    additionalChecks: [],
    notes: '',
    diagnosticConfidence: { percentage: 78, rating: 'HIGH' }
  }, manualSorentoBoundary(), { mechanicObservations: [] });

  assert.equal(guarded.changed, true);
  assert.match(guarded.output.primaryCause, /Driveline \/ torque-transfer mechanical fault/i);
  assert.doesNotMatch(guarded.output.primaryCause, /center support|universal joint|u-joint/i);
  assert.match(guarded.output.secondaryCauses[0], /if equipped/i);
  assert.ok(guarded.output.probability.every(item => /if equipped/i.test(item.cause)));
  assert.match(guarded.output.recommendedTests[0], /^If equipped on this exact vehicle configuration:/i);
  assert.equal(guarded.output.diagnosticConfidence.rating, 'LOW');
  assert.ok(guarded.output.diagnosticConfidence.percentage <= 40);
  assert.equal(guarded.output.vehicleConfiguration.guardApplied, true);
});

test('manual engine and missing drivetrain remain explicitly unverified', () => {
  const boundary = manualSorentoBoundary();
  assert.equal(boundary.vinStatus, CONFIGURATION_STATUS.MANUAL_UNVERIFIED);
  assert.equal(boundary.engineStatus, CONFIGURATION_STATUS.MANUAL_UNVERIFIED);
  assert.equal(boundary.drivetrainStatus, CONFIGURATION_STATUS.UNKNOWN);
  assert.match(boundary.warnings.join(' '), /manual intake/i);
  assert.match(boundary.warnings.join(' '), /drivetrain configuration is not established/i);
});

test('physical mechanic evidence can establish a named component presence', () => {
  const boundary = manualSorentoBoundary();
  const guarded = applyComponentApplicabilityGuard({
    primaryCause: 'Center support bearing wear',
    secondaryCauses: [],
    probability: [{ cause: 'Center support bearing wear', likelihood: 70 }],
    recommendedTests: ['Measure play at center support bearing'],
    additionalChecks: [],
    diagnosticConfidence: { percentage: 65, rating: 'MODERATE' }
  }, boundary, {
    mechanicObservations: ['Inspected the center support bearing and measured visible play at the bearing.']
  });

  assert.equal(guarded.changed, false);
  assert.equal(guarded.output.primaryCause, 'Center support bearing wear');
  assert.doesNotMatch(guarded.output.recommendedTests[0], /^If equipped/i);
});

test('VIN-decoded configuration conflicts are surfaced and lower confidence', () => {
  const boundary = buildVehicleConfigurationBoundary({
    vin: '1HGCM82633A004352',
    vinDecoded: true,
    suppliedVehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: '2.7L V6', drivetrain: 'FWD' },
    resolvedVehicle: { vin: '1HGCM82633A004352', year: 2008, make: 'Kia', model: 'Sorento', engine: '3.8L V6', driveType: '4WD' }
  });
  assert.equal(boundary.vinStatus, CONFIGURATION_STATUS.VIN_VERIFIED);
  assert.ok(boundary.contradictions.some(item => item.code === 'VIN_ENGINE_MISMATCH'));
  assert.ok(boundary.contradictions.some(item => item.code === 'VIN_DRIVETRAIN_MISMATCH'));

  const guarded = applyComponentApplicabilityGuard({
    primaryCause: 'General driveline lash',
    secondaryCauses: [],
    probability: [],
    recommendedTests: [],
    additionalChecks: [],
    diagnosticConfidence: { percentage: 80, rating: 'HIGH' }
  }, boundary, {});
  assert.equal(guarded.changed, true);
  assert.equal(guarded.output.diagnosticConfidence.rating, 'LOW');
});

test('reassessment payload carries the persisted vehicle configuration boundary', () => {
  const boundary = manualSorentoBoundary();
  const job = {
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: '2.7L V6' },
    intake: { customerStates: ['Continuous clunk thump'], mechanicNotices: [], dtcEvidence: [] },
    diagnosis: {
      result: { primaryCause: 'Driveline fault', probability: [], recommendedTests: [], diagnosticConfidence: { percentage: 30, rating: 'LOW' } },
      evidencePacket: { schemaVersion: 2, dtcProvenance: { policy: 'VERIFIED_SCAN_TOOL_ONLY' }, vehicleConfiguration: boundary },
      recordedAt: '2026-09-03T00:00:00.000Z'
    },
    tests: [{ id: 'T1', name: 'Road test', result: 'Clunk reproduced on throttle release', evidenceRole: 'NEUTRAL', recordedAt: '2026-09-03T00:01:00.000Z' }]
  };
  const payload = buildReassessmentPayload(job, 'NEW_TEST_EVIDENCE');
  assert.equal(payload.vehicleConfiguration.policy, 'PROVE_COMPONENT_EXISTS_OR_QUALIFY_IF_EQUIPPED');
  assert.equal(payload.vehicleConfiguration.drivetrainStatus, CONFIGURATION_STATUS.UNKNOWN);
});

test('reassessment cannot resurrect an unproven component-specific primary cause', () => {
  const boundary = manualSorentoBoundary();
  const previous = {
    primaryCause: 'Driveline fault',
    secondaryCauses: [],
    probability: [],
    recommendedTests: [],
    diagnosticConfidence: { percentage: 30, rating: 'LOW' }
  };
  const job = {
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: '2.7L V6' },
    intake: { customerStates: ['Continuous clunk thump'], mechanicNotices: [], dtcEvidence: [] },
    diagnosis: {
      result: previous,
      evidencePacket: { schemaVersion: 2, dtcProvenance: { policy: 'VERIFIED_SCAN_TOOL_ONLY' }, vehicleConfiguration: boundary },
      recordedAt: '2026-09-03T00:00:00.000Z'
    },
    tests: [{ id: 'T1', name: 'Road test', result: 'Clunk reproduced on throttle release', evidenceRole: 'NEUTRAL', recordedAt: '2026-09-03T00:01:00.000Z' }]
  };
  const candidate = {
    primaryCause: 'Worn driveshaft center support bearing',
    secondaryCauses: ['Transfer case lash'],
    probability: [{ cause: 'Center support bearing wear', likelihood: 70 }],
    recommendedTests: ['Inspect center support bearing for play'],
    notes: '',
    diagnosticConfidence: { percentage: 75, rating: 'HIGH' }
  };

  const result = sanitizeReassessment(job, previous, candidate, 'NEW_TEST_EVIDENCE');
  assert.match(result.primaryCause, /Driveline \/ torque-transfer mechanical fault/i);
  assert.doesNotMatch(result.primaryCause, /center support bearing/i);
  assert.match(result.secondaryCauses[0], /if equipped/i);
  assert.match(result.recommendedTests[0], /^If equipped/i);
  assert.equal(result.diagnosticConfidence.rating, 'LOW');
});
