'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const economicEngine = require('../src/core/economic/economic.engine');

test('coolant ageMonths: 0 is treated as a real just-serviced value, not absent', () => {
  const usage = economicEngine._getUsageMetric('coolant', {
    componentData: { coolant: { ageMonths: 0 } }
  });
  assert.equal(usage, 0);
});

test('coolant ageMonths: 5 is used as-is', () => {
  const usage = economicEngine._getUsageMetric('coolant', {
    componentData: { coolant: { ageMonths: 5 } }
  });
  assert.equal(usage, 5);
});

test('battery falls back to lastServiceDate when ageMonths absent', () => {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const usage = economicEngine._getUsageMetric('battery', {
    lastServiceDate: sixMonthsAgo.toISOString(),
    componentData: {}
  });
  assert.ok(usage >= 5.9 && usage <= 6.1, `expected ~6 months, got ${usage}`);
});

test('battery falls back to default 12 when no ageMonths and no lastServiceDate', () => {
  const usage = economicEngine._getUsageMetric('battery', {
    componentData: {}
  });
  assert.equal(usage, 12);
});
