'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Module = require('node:module');

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };
  return () => {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

async function withServer(router, mountPath, run) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function readJson(response) {
  return { status: response.status, body: await response.json() };
}

const diagnosticPayload = JSON.stringify({
  urgency: 'soon',
  safetyRisk: false,
  primaryCause: 'Ignition fault requires confirmation',
  secondaryCauses: [],
  codeExplanations: {},
  probability: [{ cause: 'Ignition fault', likelihood: 100 }],
  knownIssues: [],
  repairSteps: [],
  proTips: [],
  recommendedTests: ['Inspect and measure the ignition system before repair'],
  additionalChecks: [],
  estimatedRepairTime: 'N/A',
  notes: 'Confirm the fault before repair.'
});

test('Diagnose does not require GROQ_API_KEY before delegating to aiClient/providerRouter', { concurrency: false }, async () => {
  const originalGroqKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;

  let aiCalls = 0;
  const restores = [
    stubModule('../src/services/ai/aiClient', {
      aiChat: async () => {
        aiCalls += 1;
        return {
          choices: [{ message: { content: diagnosticPayload } }],
          model: 'gemini-test-model',
          _provider: 'gemini'
        };
      }
    }),
    stubModule('../src/services/vehicle.warmup', {
      resolveVehicleProfile: async (vin, vehicle = {}) => vehicle,
      waitForVehicleWarmup: async () => ({ status: 'TEST_STUB' })
    }),
    stubModule('../src/services/vehicle.evidence', {
      collectVehicleEvidence: async () => ({
        available: false,
        oem: { references: [] },
        tsbs: { references: [] },
        recalls: [],
        knownIssues: [],
        sources: [],
        errors: []
      }),
      selectRelevantTsbs: () => []
    }),
    stubModule('../src/services/pipeline.engine', {
      runDiagnosticPipeline: () => ({
        type: 'diagnostic_plan',
        steps: [],
        profile: null,
        vinBuildProfile: null,
        localSafetyTriggered: false,
        safetyNotes: '',
        matchedPatterns: [],
        assemblyData: null,
        confidence: { percentage: 30, rating: 'LOW' },
        symptomTelemetry: { hasMismatchedSignals: false, categories: {}, overlappingClassesCount: 0 }
      })
    }),
    stubModule('../src/knowledge/vehicle.risk.table', { getVehicleRiskProfile: () => null }),
    stubModule('../src/knowledge/failure.patterns', { findKnownPatterns: () => [] }),
    stubModule('../src/knowledge/procedure.data', { getLocalProcedure: () => null })
  ];

  const routePath = require.resolve('../src/routes/diagnose');
  delete require.cache[routePath];

  try {
    const router = require('../src/routes/diagnose');
    await withServer(router, '/api/diagnose', async base => {
      const result = await readJson(await fetch(`${base}/api/diagnose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          vehicle: { year: 2016, make: 'Chevrolet', model: 'Malibu', engine: '2.5L' },
          customerStates: ['Rough idle'],
          obdCodes: ['P0301'],
          mechanicNotices: ['No parts replaced yet']
        })
      }));

      assert.equal(result.status, 200);
      assert.equal(result.body.success, true);
      assert.equal(aiCalls, 1, 'Diagnose must reach aiClient even when GROQ_API_KEY is absent');
    });
  } finally {
    delete require.cache[routePath];
    restores.reverse().forEach(restore => restore());
    if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroqKey;
  }
});

test('intelligence routes fail closed when the orchestrator cannot load', { concurrency: false }, async () => {
  const routePath = require.resolve('../src/routes/intelligence.routes');
  delete require.cache[routePath];

  const originalLoad = Module._load;
  const originalConsoleError = console.error;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../core/orchestrator/main.orchestrator' && parent?.filename === routePath) {
      throw new Error('test orchestrator load failure');
    }
    if (request === '../core/economic/economic.engine' && parent?.filename === routePath) {
      return class TestEconomicEngine {
        analyze() { return {}; }
        analyzeBatch() { return []; }
        getAssumptions() { return {}; }
      };
    }
    return originalLoad.apply(this, arguments);
  };
  console.error = () => {};

  try {
    const router = require('../src/routes/intelligence.routes');
    Module._load = originalLoad;

    await withServer(router, '/api/intelligence', async base => {
      const vehicleProfile = {
        vin: 'TESTVIN1234567890',
        make: 'Kia',
        model: 'Sorento',
        year: 2008,
        mileage: 150000
      };

      const analyzed = await readJson(await fetch(`${base}/api/intelligence/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'Diagnose a clunk', vehicleProfile })
      }));

      assert.equal(analyzed.status, 503);
      assert.equal(analyzed.body.status, 'UNAVAILABLE');
      assert.equal(analyzed.body.code, 'ORCHESTRATOR_UNAVAILABLE');
      assert.equal(analyzed.body.fallback?.action, 'HUMAN_HANDOFF');
      assert.doesNotMatch(JSON.stringify(analyzed.body), /PROXY_SUCCESS/);

      const health = await readJson(await fetch(`${base}/api/intelligence/health`));
      assert.equal(health.status, 503);
      assert.equal(health.body.ok, false);
      assert.equal(health.body.code, 'ORCHESTRATOR_UNAVAILABLE');
    });
  } finally {
    Module._load = originalLoad;
    console.error = originalConsoleError;
    delete require.cache[routePath];
  }
});
