'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isMeaningfulTestResult } = require('../src/services/job.lifecycle');
const protectedJobs = require('../src/routes/jobs.protected');

const PUNCTUATED_PLACEHOLDERS = [
  'unknown.', 'unknown?', 'unknown...',
  'pending...', 'pending,', 'pending!',
  'tbd,', 'tbd.', 'tbd:',
  'not sure.', 'not sure,', 'not sure?',
  'n/a.', 'na.', 'not tested.', 'not performed.',
  '(unknown)', '[pending]', '{tbd}',
  '"tbd."', "'not sure?'", '“unknown.”',
  'unknown…', '—pending—', '(n/a)'
];

const UNCERTAINTY_PLACEHOLDERS = [
  'maybe', 'Maybe', 'possibly', 'probably', 'unsure', 'uncertain',
  '(maybe)', '“possibly.”', 'probably…', '[unsure]', '—uncertain—'
];

function assertRejected(values, predicate, label) {
  for (const value of values) {
    assert.equal(predicate(value), false, `${label} should reject: ${JSON.stringify(value)}`);
  }
}

test('punctuation-wrapped placeholder words do not count as physical evidence (lifecycle gate)', () => {
  assertRejected(PUNCTUATED_PLACEHOLDERS, isMeaningfulTestResult, 'lifecycle');
});

test('punctuation-wrapped placeholder words do not count as physical evidence (protected route gate)', () => {
  assertRejected(PUNCTUATED_PLACEHOLDERS, protectedJobs.isMeaningfulTestResult, 'protected');
});

test('standalone uncertainty words do not count as physical evidence at either gate', () => {
  assertRejected(UNCERTAINTY_PLACEHOLDERS, isMeaningfulTestResult, 'lifecycle');
  assertRejected(UNCERTAINTY_PLACEHOLDERS, protectedJobs.isMeaningfulTestResult, 'protected');
});

test('protected route reuses the lifecycle validator instead of maintaining a duplicate rule', () => {
  assert.strictEqual(protectedJobs.isMeaningfulTestResult, isMeaningfulTestResult);
});

test('actual observations and measurements remain valid after evidence hardening', () => {
  const valid = [
    '1/8 inch rotational play',
    'no binding observed at full lock',
    'rubber mount torn on left side',
    'pad thickness 3mm',
    'reading: 12.4V',
    'Connector dry; no corrosion observed.',
    '“5.01 V reference measured”'
  ];

  for (const value of valid) {
    assert.equal(isMeaningfulTestResult(value), true, `lifecycle should keep: ${JSON.stringify(value)}`);
    assert.equal(protectedJobs.isMeaningfulTestResult(value), true, `protected should keep: ${JSON.stringify(value)}`);
  }
});
