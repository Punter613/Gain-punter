'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReassessmentPayload,
  hasNewEvidenceSinceDiagnosis,
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
      obdCodes: ['P0300', 'P0171']
    },
    diagnosis: {
      recordedAt: '2026-09-02T20:00:00.000Z',
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
        recordedAt: '2026-09-02T20:05:00.000Z'
      }
    ]
  };
}

test('new persisted mechanic evidence makes the diagnosis eligible for reassessment', () => {
  const job = sorentoJob();
  assert.equal(hasNewEvidenceSinceDiagnosis(job), true);
  job.tests[0].recordedAt = '2026-09-02T19:59:00.000Z';
  assert.equal(hasNewEvidenceSinceDiagnosis(job), false);
});

test('reassessment packet carries original intake, DTCs, prior ranking and recorded evidence', () => {
  const packet = buildReassessmentPayload(sorentoJob());
  assert.deepEqual(packet.dtcs, ['P0300', 'P0171']);
  assert.equal(packet.previousDiagnosis.primaryCause, 'Improperly installed RF wheel speed sensor');
  assert.equal(packet.recordedEvidence.length, 1);
  assert.match(packet.recordedEvidence[0].result, /torque reversal/i);
});

test('sanitizer removes anchoring artifacts, impossible stationary test and DTC contradiction', () => {
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
  assert.match(output.notes, /DTC context is present/i);
  assert.equal(output.reassessment.applied, true);
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
