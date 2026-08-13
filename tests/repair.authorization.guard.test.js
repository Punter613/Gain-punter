'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateRepairAuthorization,
  buildStagedRepairPlan
} = require('../src/core/orchestrator/repair.authorization.guard');

test('does not authorize repair from codes or symptoms alone', () => {
  const result = evaluateRepairAuthorization({
    obdCodes: ['C1203', 'C1204', 'C1205'],
    customerStates: ['clunk when turning']
  });
  assert.equal(result.authorized, false);
  assert.equal(result.status, 'DIAGNOSIS_REQUIRED');
});

test('does not authorize repair from diagnosisVerified without a bounded fault', () => {
  const result = evaluateRepairAuthorization({ diagnosisVerified: true });
  assert.equal(result.authorized, false);
});

test('authorizes a bounded explicitly verified fault', () => {
  const result = evaluateRepairAuthorization({
    diagnosisVerified: true,
    verifiedFaults: [{
      component: 'right front wheel speed sensor',
      finding: 'retaining bolt missing and sensor physically damaged'
    }]
  });
  assert.equal(result.authorized, true);
  assert.equal(result.repairScope.length, 1);
});

test('staged repair planning protects safety and downstream parts before affordability', () => {
  const plan = buildStagedRepairPlan([
    { component: 'cosmetic trim', affordabilityPriority: 5 },
    { component: 'brake hose', safetyPriority: 5, damagePropagationRisk: 4 },
    { component: 'dependent sensor', repairDependencyRisk: 4, diagnosticLeverage: 3 }
  ]);
  assert.equal(plan[0].component, 'brake hose');
  assert.equal(plan[0].stage, 1);
  assert.equal(plan.every(item => item.retestRequired), true);
});
