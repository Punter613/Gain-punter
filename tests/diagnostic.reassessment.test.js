'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReassessmentPayload,
  hasNewEvidenceSinceDiagnosis,
  needsDtcProvenanceReassessment,
  reassessmentReason,
  sanitizeReassessment
} = require('../src/services/diagnostic.reassessment');
const { uniqueAlternatives } = require('../src/core/evidence/unverified.diagnosis');

function sorentoJob() {
  return {
    jobId: 'SKSK-TEST-SORENTO',
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: '2.7L V6', mileage: 150000 },
    intake: {
      customerStates: ['Thump occurs when releasing the accelerator and gets louder'],
      mechanicNotices: ['RF wheel-speed sensor was replaced and ABS warning remained off afterward'],
      dtcEvidence: [
        { code: 'P0300', source: 'SCAN_TOOL', verified: true },
        { code: 'P0171', source: 'SCAN_TOOL', verified: true }
      ],
      obdCodes: ['P0300', 'P0171']
    },
    diagnosis: {
      recordedAt: '2026-09-02T20:00:00.000Z',
      evidencePacket: {
        schemaVersion: 2,
        dtcs: ['P0300', 'P0171'],
        dtcProvenance: { policy: 'VERIFIED_SCAN_TOOL_ONLY', verifiedCount: 2, excludedCount: 0 }
      },
      result: {
        primaryCause: 'Improperly installed RF wheel speed sensor',
        secondaryCauses: ['Loose RF wheel speed sensor wiring'],
        probability: [
          { cause: 'Improperly installed RF wheel speed sensor', likelihood: 70 },
          { cause: 'Loose RF wheel speed sensor wiring', likelihood: 30 }
        ],
        recommendedTests: ['Wiggle the ABS sensor connector with the engine running and note any change in thump'],
        notes: 'No DTCs are present, so inspect the sensor.',
        diagnosticConfidence: { percentage: 30, rating: 'LOW' }
      }
    },
    tests: [
      {
        id: 'road-test-1',
        name: 'Additional mechanic finding',
        result: 'Road-tested as passenger. Mechanical driveline impact is felt during throttle release and torque reversal.',
        evidenceRole: 'NEUTRAL',
        confirmedFault: '',
        recordedAt: '2026-09-02T20:05:00.000Z'
      }
    ]
  };
}

test('new persisted mechanic evidence makes the diagnosis eligible for reassessment', () => {
  const job = sorentoJob();
  assert.equal(hasNewEvidenceSinceDiagnosis(job), true);
  assert.equal(needsDtcProvenanceReassessment(job), false);
  assert.equal(reassessmentReason(job), 'NEW_TEST_EVIDENCE');
  job.tests[0].recordedAt = '2026-09-02T19:59:00.000Z';
  assert.equal(hasNewEvidenceSinceDiagnosis(job), false);
  assert.equal(reassessmentReason(job), null);
});

test('reassessment packet carries verified DTCs, provenance summary, prior ranking, evidence role, and recorded evidence', () => {
  const packet = buildReassessmentPayload(sorentoJob());
  assert.deepEqual(packet.dtcs, ['P0300', 'P0171']);
  assert.equal(packet.dtcProvenance.verifiedCount, 2);
  assert.equal(packet.dtcProvenance.excludedCount, 0);
  assert.equal(packet.reassessmentReason, 'NEW_TEST_EVIDENCE');
  assert.equal(packet.previousDiagnosis.primaryCause, 'Improperly installed RF wheel speed sensor');
  assert.equal(packet.recordedEvidence.length, 1);
  assert.match(packet.recordedEvidence[0].result, /torque reversal/i);
  assert.equal(packet.recordedEvidence[0].evidenceRole, 'NEUTRAL');
  assert.equal(packet.recordedEvidence[0].confirmedFault, '');
});

test('reassessment excludes non-verified DTC values instead of letting them re-anchor diagnosis', () => {
  const job = sorentoJob();
  job.intake.dtcEvidence = [
    { code: 'P0300', source: 'PLACEHOLDER', verified: false },
    { code: 'P0171', source: 'MANUAL_ENTRY', verified: false },
    { code: 'U0100', source: 'CUSTOMER_REPORTED', verified: false }
  ];
  job.intake.obdCodes = [];
  job.diagnosis.evidencePacket = {
    schemaVersion: 2,
    dtcs: [],
    dtcProvenance: { policy: 'VERIFIED_SCAN_TOOL_ONLY', verifiedCount: 0, excludedCount: 3 }
  };
  const packet = buildReassessmentPayload(job);
  assert.deepEqual(packet.dtcs, []);
  assert.equal(packet.dtcProvenance.verifiedCount, 0);
  assert.equal(packet.dtcProvenance.excludedCount, 3);
  assert.doesNotMatch(JSON.stringify(packet), /P0300|P0171|U0100/);
});

test('legacy pre-provenance diagnoses with DTC values require a migration reassessment even without new test evidence', () => {
  const job = sorentoJob();
  delete job.intake.dtcEvidence;
  job.diagnosis.evidencePacket = { schemaVersion: 1, dtcs: ['P0300', 'P0171'] };
  job.tests[0].recordedAt = '2026-09-02T19:59:00.000Z';
  assert.equal(hasNewEvidenceSinceDiagnosis(job), false);
  assert.equal(needsDtcProvenanceReassessment(job), true);
  assert.equal(reassessmentReason(job), 'DTC_PROVENANCE_MIGRATION');
  const packet = buildReassessmentPayload(job);
  assert.deepEqual(packet.dtcs, []);
  assert.equal(packet.dtcProvenance.excludedCount, 2);
  assert.equal(packet.reassessmentReason, 'DTC_PROVENANCE_MIGRATION');
});

test('legacy diagnosis plus new evidence carries both reassessment reasons', () => {
  const job = sorentoJob();
  delete job.intake.dtcEvidence;
  job.diagnosis.evidencePacket = { schemaVersion: 1, dtcs: ['P0300', 'P0171'] };
  assert.equal(reassessmentReason(job), 'NEW_TEST_EVIDENCE_AND_DTC_PROVENANCE');
});

test('reassessment packet preserves explicit confirmation-grade evidence semantics', () => {
  const job = sorentoJob();
  job.tests.push({
    id: 'u-joint-check',
    name: 'U-joint physical play inspection',
    result: 'Rear joint has visible radial play and clunks by hand under load reversal.',
    evidenceRole: 'CONFIRMS',
    confirmedFault: 'Rear propeller shaft U-joint failure',
    recordedAt: '2026-09-02T20:07:00.000Z'
  });
  const packet = buildReassessmentPayload(job);
  const confirming = packet.recordedEvidence.find(item => item.id === 'u-joint-check');
  assert.equal(confirming.evidenceRole, 'CONFIRMS');
  assert.equal(confirming.confirmedFault, 'Rear propeller shaft U-joint failure');
});

test('sanitizer removes anchoring artifacts, impossible stationary test and verified-DTC contradiction', () => {
  const job = sorentoJob();
  const candidate = {
    primaryCause: 'Propeller shaft or U-joint lash during torque reversal',
    secondaryCauses: [
      'Propeller shaft or U-joint lash during torque reversal',
      'Differential or transfer-case lash',
      'differential or transfer-case lash'
    ],
    probability: [
      { cause: 'Propeller shaft or U-joint lash during torque reversal', likelihood: 50 },
      { cause: 'Differential or transfer-case lash', likelihood: 30 },
      { cause: 'differential or transfer-case lash', likelihood: 20 }
    ],
    recommendedTests: [
      'Wiggle the ABS sensor connector with the engine running and note any change in thump',
      'Inspect propeller shaft and U-joints for rotational play and binding',
      'Road test while observing driveline response during controlled throttle lift'
    ],
    notes: 'No DTCs are present. New road-test evidence points to driveline torque reversal.',
    diagnosticConfidence: { percentage: 55, rating: 'MODERATE' }
  };

  const output = sanitizeReassessment(job, job.diagnosis.result, candidate);
  assert.equal(output.secondaryCauses.length, 1);
  assert.equal(output.secondaryCauses[0], 'Differential or transfer-case lash');
  assert.equal(output.probability.length, 2);
  assert.equal(output.recommendedTests.some(x => /wiggle.*engine running/i.test(x)), false);
  assert.equal(output.recommendedTests.some(x => /road test/i.test(x)), true);
  assert.doesNotMatch(output.notes, /no dtcs? (?:are )?present/i);
  assert.match(output.notes, /Verified scan-tool DTC context is present/i);
  assert.equal(output.reassessment.applied, true);
  assert.equal(output.reassessment.reason, 'NEW_TEST_EVIDENCE');
});

test('unverified alternatives are deduplicated case-insensitively and exclude primary cause', () => {
  const alternatives = uniqueAlternatives([
    'Primary fault',
    'Secondary fault',
    'secondary fault',
    'Third fault'
  ], 'primary fault');
  assert.deepEqual(alternatives, ['Secondary fault', 'Third fault']);
});
