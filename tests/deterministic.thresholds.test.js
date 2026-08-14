'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const orchestrator = require('../src/core/orchestrator/deterministic.orchestrator');

const run = (componentData) => orchestrator.process({ componentData }, 'test input');

test('brakes.padThickness 1.9 mm triggers CRITICAL / MANDATORY_REPLACE', async () => {
  const r = await run({ brakes: { padThickness: 1.9 } });
  assert.equal(r.approved, false);
  assert.equal(r.canUseAI, false);
  assert.equal(r.overrides[0].severity, 'CRITICAL');
  assert.equal(r.overrides[0].action, 'MANDATORY_REPLACE');
});

test('brakes.padThickness 2.0 mm passes boundary', async () => {
  const r = await run({ brakes: { padThickness: 2.0 } });
  assert.equal(r.approved, true);
  assert.equal(r.canUseAI, true);
  assert.equal(r.overrides.length, 0);
});

test('suspension.sag 1.1 inches triggers HIGH / MANDATORY_INSPECT', async () => {
  const r = await run({ suspension: { sag: 1.1 } });
  assert.equal(r.approved, true);
  assert.equal(r.canUseAI, false);
  assert.equal(r.overrides[0].severity, 'HIGH');
  assert.equal(r.overrides[0].action, 'MANDATORY_INSPECT');
});

test('suspension.sag 1.0 inches passes boundary', async () => {
  const r = await run({ suspension: { sag: 1.0 } });
  assert.equal(r.approved, true);
  assert.equal(r.canUseAI, true);
  assert.equal(r.overrides.length, 0);
});

test('brakes.brakeFluid 25 months triggers HIGH / MANDATORY_FLUSH', async () => {
  const r = await run({ brakes: { brakeFluid: 25 } });
  assert.equal(r.approved, true);
  assert.equal(r.canUseAI, false);
  assert.equal(r.overrides[0].severity, 'HIGH');
  assert.equal(r.overrides[0].action, 'MANDATORY_FLUSH');
});

test('brakes.brakeFluid 24 months passes boundary', async () => {
  const r = await run({ brakes: { brakeFluid: 24 } });
  assert.equal(r.approved, true);
  assert.equal(r.canUseAI, true);
  assert.equal(r.overrides.length, 0);
});

test('coolant.condition pH 6.9 triggers HIGH / MANDATORY_FLUSH', async () => {
  const r = await run({ coolant: { condition: 6.9 } });
  assert.equal(r.approved, true);
  assert.equal(r.canUseAI, false);
  assert.equal(r.overrides[0].action, 'MANDATORY_FLUSH');
});

test('coolant.condition pH 11.1 triggers HIGH / MANDATORY_FLUSH', async () => {
  const r = await run({ coolant: { condition: 11.1 } });
  assert.equal(r.approved, true);
  assert.equal(r.canUseAI, false);
  assert.equal(r.overrides[0].action, 'MANDATORY_FLUSH');
});

test('coolant.condition pH 7.0 and 11.0 pass boundaries', async () => {
  const rMin = await run({ coolant: { condition: 7.0 } });
  const rMax = await run({ coolant: { condition: 11.0 } });
  assert.equal(rMin.overrides.length, 0);
  assert.equal(rMax.overrides.length, 0);
});

test('transmission.fluidCondition darkness 4 triggers HIGH / MANDATORY_SERVICE', async () => {
  const r = await run({ transmission: { fluidCondition: 4 } });
  assert.equal(r.approved, true);
  assert.equal(r.canUseAI, false);
  assert.equal(r.overrides[0].action, 'MANDATORY_SERVICE');
});

test('transmission.fluidCondition darkness 3 passes boundary', async () => {
  const r = await run({ transmission: { fluidCondition: 3 } });
  assert.equal(r.overrides.length, 0);
});
