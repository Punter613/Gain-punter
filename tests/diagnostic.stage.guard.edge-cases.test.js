'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyDiagnosticStageGuard,
  sanitizeText,
  isForbiddenDiagnosticAction
} = require('../src/core/orchestrator/diagnostic.stage.guard');

test('diagnostic-stage guard preserves a pure inspection instruction', () => {
  const result = sanitizeText('Inspect slip yoke for binding.');
  assert.equal(result.changed, false);
  assert.equal(result.removed, false);
  assert.equal(result.text, 'Inspect slip yoke for binding.');
});

test('diagnostic-stage guard strips repair clause while preserving safe diagnostic clause', () => {
  const result = sanitizeText('Check slip yoke for binding, greasing or replacing as needed.');
  assert.equal(result.changed, true);
  assert.equal(result.removed, false);
  assert.equal(result.text, 'Check slip yoke for binding.');
  assert.equal(isForbiddenDiagnosticAction(result.text), false);
});

test('diagnostic-stage guard preserves check and strips conditional replacement clause', () => {
  const result = sanitizeText('Check engine mount movement, then replace if torn.');
  assert.equal(result.changed, true);
  assert.equal(result.removed, false);
  assert.equal(result.text, 'Check engine mount movement.');
  assert.equal(isForbiddenDiagnosticAction(result.text), false);
});

test('diagnostic-stage guard removes a repair-only instruction', () => {
  const result = sanitizeText('Replace engine mount.');
  assert.equal(result.changed, true);
  assert.equal(result.removed, true);
  assert.equal(result.text, '');
});

test('diagnostic-stage guard removes invasive action from DIAG arrays and keeps tests', () => {
  const input = {
    repairSteps: [
      'Inspect steering rack mounts for movement',
      'Replace steering rack bushings'
    ],
    recommendedTests: [
      'Measure driveline backlash',
      'Check mount movement, then replace if torn'
    ],
    notes: 'Initial diagnosis'
  };

  const result = applyDiagnosticStageGuard(input);

  assert.equal(result.changed, true);
  assert.deepEqual(result.output.repairSteps, [
    'Inspect steering rack mounts for movement'
  ]);
  assert.deepEqual(result.output.recommendedTests, [
    'Measure driveline backlash',
    'Check mount movement.'
  ]);
  assert.equal(result.removed.length, 1);
  assert.equal(result.rewritten.length, 1);
  assert.equal(result.output.diagnosticStageGuard.enforced, true);
  assert.match(result.output.notes, /sanitized 2 repair\/invasive actions pending verification/i);
});

test('diagnostic-stage guard preserves object shape when rewriting supported text field', () => {
  const input = {
    additionalChecks: [
      { test: 'Verify mount movement, then replace if torn', priority: 'high' }
    ]
  };

  const result = applyDiagnosticStageGuard(input);

  assert.equal(result.changed, true);
  assert.equal(result.output.additionalChecks.length, 1);
  assert.equal(result.output.additionalChecks[0].test, 'Verify mount movement.');
  assert.equal(result.output.additionalChecks[0].priority, 'high');
});
