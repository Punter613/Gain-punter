'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SKSKOrchestrator = require('../src/core/orchestrator/main.orchestrator');
const aiRouter = require('../src/services/ai/ai.specialist.router');

async function withBlockedAIRouter(runTest) {
  const originalRoute = aiRouter.route;
  const originalExecute = aiRouter.execute;
  let routeCalls = 0;
  let executeCalls = 0;

  aiRouter.route = async () => {
    routeCalls++;
    throw new Error('AI router should not be called for deterministic override');
  };
  aiRouter.execute = async () => {
    executeCalls++;
    throw new Error('AI execute should not be called for deterministic override');
  };

  try {
    await runTest(() => ({ routeCalls, executeCalls }));
  } finally {
    aiRouter.route = originalRoute;
    aiRouter.execute = originalExecute;
  }
}

test('HIGH-severity mandatory rule blocks AI and returns DETERMINISTIC_OVERRIDE', async () => {
  await withBlockedAIRouter(async (getCalls) => {
    const orchestrator = new SKSKOrchestrator();
    const result = await orchestrator.process({
      input: 'Vehicle feels unstable over bumps',
      vehicleProfile: {
        vin: 'TESTVIN1234567890',
        componentData: {
          suspension: {
            sag: 2.0
          }
        }
      },
      context: {}
    });

    assert.equal(result.status, 'DETERMINISTIC_OVERRIDE');
    assert.equal(result.decision.action, 'SAFETY_ADVISORY');
    assert.equal(result.decision.urgency, 'HIGH');
    assert.equal(result.aiBypassed, true);
    assert.equal(result.humanReviewRequired, false);
    assert.equal(orchestrator.pipelineStats.deterministicOverrides, 1);
    assert.deepEqual(getCalls(), { routeCalls: 0, executeCalls: 0 });
  });
});

test('CRITICAL-severity rule still blocks AI and returns DETERMINISTIC_OVERRIDE', async () => {
  await withBlockedAIRouter(async (getCalls) => {
    const orchestrator = new SKSKOrchestrator();
    const result = await orchestrator.process({
      input: 'Brake pedal feels soft',
      vehicleProfile: {
        vin: 'TESTVIN1234567890',
        componentData: {
          brakes: {
            padThickness: 1.5
          }
        }
      },
      context: {}
    });

    assert.equal(result.status, 'DETERMINISTIC_OVERRIDE');
    assert.equal(result.decision.action, 'MANDATORY_ACTION_REQUIRED');
    assert.equal(result.decision.urgency, 'CRITICAL');
    assert.equal(result.aiBypassed, true);
    assert.equal(result.humanReviewRequired, true);
    assert.equal(orchestrator.pipelineStats.deterministicOverrides, 1);
    assert.deepEqual(getCalls(), { routeCalls: 0, executeCalls: 0 });
  });
});

test('newly activated HIGH rule (brakeFluid 25mo) blocks AI end-to-end', async () => {
  await withBlockedAIRouter(async (getCalls) => {
    const orchestrator = new SKSKOrchestrator();
    const result = await orchestrator.process({
      input: 'Brake fluid looks old, due for service',
      vehicleProfile: {
        vin: 'TESTVIN1234567890',
        componentData: {
          brakes: {
            brakeFluid: 25
          }
        }
      },
      context: {}
    });

    assert.equal(result.status, 'DETERMINISTIC_OVERRIDE');
    assert.equal(result.decision.action, 'SAFETY_ADVISORY');
    assert.equal(result.decision.urgency, 'HIGH');
    assert.equal(result.aiBypassed, true);
    assert.equal(result.humanReviewRequired, false);
    assert.equal(orchestrator.pipelineStats.deterministicOverrides, 1);
    assert.deepEqual(getCalls(), { routeCalls: 0, executeCalls: 0 });
  });
});
