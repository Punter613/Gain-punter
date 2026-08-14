'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractCompletedWork,
  applyCompletedWorkGuard
} = require('../src/core/orchestrator/completed.work.guard');

test('completed work guard recognizes completed lower ball joint replacement', () => {
  assert.deepEqual(extractCompletedWork('Replaced lower ball joint.'), ['lower ball joint']);
});

test('completed work guard does not treat negated work as completed', () => {
  assert.deepEqual(extractCompletedWork('Did NOT replace lower ball joint.'), []);
  assert.deepEqual(extractCompletedWork('Lower ball joint was not replaced.'), []);
});

test('completed work guard does not treat future work as completed', () => {
  assert.deepEqual(extractCompletedWork('Needs to replace lower ball joint.'), []);
  assert.deepEqual(extractCompletedWork('Should replace lower ball joint.'), []);
});

test('completed work guard does not treat inspection-only history as completed', () => {
  assert.deepEqual(extractCompletedWork('Inspected lower ball joint for play.'), []);
  assert.deepEqual(extractCompletedWork('Checked lower ball joint and found no play.'), []);
});

test('completed work guard resolves CV axle aliases to one canonical completed-work item', () => {
  assert.deepEqual(extractCompletedWork('Replaced constant velocity axle.'), ['cv axle']);
  assert.deepEqual(extractCompletedWork('Installed CV joint.'), ['cv axle']);
});

test('completed work guard removes duplicate repair recommendations but preserves diagnostic reinspection', () => {
  const input = {
    recommendations: [
      'Replace lower ball joint',
      'Inspect lower ball joint for installation play',
      'Check steering rack mounts'
    ]
  };

  const result = applyCompletedWorkGuard(input, ['Replaced lower ball joint.']);

  assert.equal(result.changed, true);
  assert.deepEqual(result.completedWork, ['lower ball joint']);
  assert.deepEqual(result.output.recommendations, [
    'Inspect lower ball joint for installation play',
    'Check steering rack mounts'
  ]);
  assert.equal(result.removed.length, 1);
  assert.match(result.removed[0], /replace lower ball joint/i);
});

test('completed work guard removes CV-joint replacement recommendation after CV-axle work', () => {
  const input = {
    repairs: [
      { description: 'Replace CV joint due to suspected wear' },
      { description: 'Inspect engine mounts for excess movement' }
    ]
  };

  const result = applyCompletedWorkGuard(input, ['Replaced CV axle.']);

  assert.equal(result.changed, true);
  assert.equal(result.output.repairs.length, 1);
  assert.match(result.output.repairs[0].description, /inspect engine mounts/i);
  assert.equal(result.removed.length, 1);
});
