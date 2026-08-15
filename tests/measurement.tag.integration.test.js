'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const SKSKOrchestrator = require('../src/core/orchestrator/main.orchestrator');
const aiRouter = require('../src/services/ai/ai.specialist.router');

test('derived brake-fluid age reaches TAG and blocks AI', async () => {
  const originalRoute = aiRouter.route;
  const originalExecute = aiRouter.execute;
  let routeCalls = 0;
  let executeCalls = 0;

  aiRouter.route = async () => {
    routeCalls += 1;
    throw new Error('AI route must not run after deterministic measurement override');
  };
  aiRouter.execute = async () => {
    executeCalls += 1;
    throw new Error('AI execute must not run after deterministic measurement override');
  };

  try {
    const orchestrator = new SKSKOrchestrator();
    const result = await orchestrator.process({
      input: 'Brake fluid service history is overdue',
      vehicleProfile: {
        vin: 'TESTVIN1234567890',
        make: 'Kia',
        model: 'Sorento',
        year: 2008,
        mileage: 150000,
        componentData: {
          brakes: {
            brakeFluidServiceDate: '2020-01-01'
          }
        }
      },
      context: {}
    });

    assert.equal(result.status, 'DETERMINISTIC_OVERRIDE');
    assert.equal(result.aiBypassed, true);
    assert.equal(result.decision.urgency, 'HIGH');
    assert.equal(result.decision.overrides[0].component, 'brakes');
    assert.equal(result.decision.overrides[0].metric, 'brakeFluid');
    assert.equal(result.decision.overrides[0].requiredAction, 'MANDATORY_FLUSH');
    assert.ok(result.decision.overrides[0].value > 24);
    assert.equal(routeCalls, 0);
    assert.equal(executeCalls, 0);
  } finally {
    aiRouter.route = originalRoute;
    aiRouter.execute = originalExecute;
  }
});

test('zero pad thickness is normalized as data and triggers CRITICAL override', async () => {
  const orchestrator = new SKSKOrchestrator();
  const result = await orchestrator.process({
    input: 'Measured front brake pad thickness',
    vehicleProfile: {
      vin: 'TESTVIN1234567890',
      make: 'Kia',
      model: 'Sorento',
      year: 2008,
      mileage: 150000,
      componentData: {
        brakes: { padThicknessMm: 0 }
      }
    },
    context: {}
  });

  assert.equal(result.status, 'DETERMINISTIC_OVERRIDE');
  assert.equal(result.decision.urgency, 'CRITICAL');
  assert.equal(result.decision.overrides[0].value, 0);
  assert.equal(result.decision.overrides[0].requiredAction, 'MANDATORY_REPLACE');
});
