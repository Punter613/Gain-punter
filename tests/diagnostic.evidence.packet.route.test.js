'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  return () => {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

async function withServer(router, run) {
  const app = express();
  app.use(express.json());
  app.use('/api/diagnose', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const diagnosticPayload = JSON.stringify({
  urgency: 'soon',
  safetyRisk: false,
  primaryCause: 'Mount or driveline movement requires confirmation',
  secondaryCauses: [],
  codeExplanations: { P0300: 'Random misfire', P0171: 'Bank 1 lean' },
  probability: [{ cause: 'Mount movement', likelihood: 100 }],
  knownIssues: ['Untrusted model-memory known issue'],
  repairSteps: ['Measure mount movement under controlled load'],
  proTips: ['Compare cold and warm mount movement'],
  recommendedTests: ['Inspect mounts under controlled load'],
  additionalChecks: [],
  estimatedRepairTime: '0.5 hour diagnostic inspection',
  notes: 'Confirm before repair.'
});

function stubs(capture) {
  return [
    stubModule('../src/services/ai/aiClient', {
      aiChat: async payload => {
        capture.payload = payload;
        return { choices: [{ message: { content: diagnosticPayload } }], model: 'test-model' };
      }
    }),
    stubModule('../src/services/vehicle.warmup', {
      resolveVehicleProfile: async (vin, vehicle = {}) => vehicle,
      waitForVehicleWarmup: async () => ({ status: 'READY' })
    }),
    stubModule('../src/services/vehicle.evidence', {
      collectVehicleEvidence: async () => ({
        available: true,
        oem: { references: [] },
        tsbs: { references: [{
          sourceAuthority: 'NHTSA_BULK',
          bulletinNumber: 'KT-TEST-001',
          title: 'Engine performance bulletin',
          relevanceScore: 30,
          matchedSignals: ['DTC:P0300'],
          bodyText: 'P0300 diagnostic evidence from manufacturer communication.'
        }] },
        sources: ['NHTSA_BULK']
      }),
      selectRelevantTsbs: evidence => evidence.tsbs.references
    }),
    stubModule('../src/services/pipeline.engine', {
      runDiagnosticPipeline: input => {
        capture.pipelineInput = input;
        return {
          type: 'diagnostic_plan', steps: [], profile: null, vinBuildProfile: null,
          localSafetyTriggered: false, safetyNotes: '', matchedPatterns: [], assemblyData: null,
          confidence: { percentage: 30, rating: 'LOW' },
          symptomTelemetry: { hasMismatchedSignals: false, categories: {}, overlappingClassesCount: 0 }
        };
      }
    }),
    stubModule('../src/knowledge/vehicle.risk.table', { getVehicleRiskProfile: () => null }),
    stubModule('../src/knowledge/failure.patterns', { findKnownPatterns: () => [] }),
    stubModule('../src/knowledge/procedure.data', { getLocalProcedure: () => null })
  ];
}

function baseRequest(overrides = {}) {
  return {
    vin: 'KNDJC735785123456',
    mileage: 150000,
    vehicle: {
      year: 2008, make: 'Kia', model: 'Sorento', engine: '3.8L', drivetrain: '4WD',
      componentData: { brakes: { padThicknessMm: 3.1 } }
    },
    customerStates: ['repetitive bump on accelerator release', 'clunk at full steering lock'],
    mechanicNotices: ['CV axles replaced'],
    dtcEvidence: [
      { code: 'P0300', source: 'SCAN_TOOL', verified: true },
      { code: 'P0171', source: 'SCAN_TOOL', verified: true }
    ],
    keywords: ['search-only-secret'],
    ...overrides
  };
}

test('Diagnose sends one canonical bounded evidence packet with only verified DTC evidence', { concurrency: false }, async () => {
  const capture = {};
  const restores = stubs(capture);
  const routePath = require.resolve('../src/routes/diagnose');
  delete require.cache[routePath];

  try {
    const router = require('../src/routes/diagnose');
    await withServer(router, async base => {
      const response = await fetch(`${base}/api/diagnose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baseRequest())
      });

      assert.equal(response.status, 200);
      const responseBody = await response.json();
      assert.ok(capture.payload);
      const messages = capture.payload.messages;
      assert.equal(messages.length, 2);
      assert.match(messages[0].content, /DIAGNOSTIC_EVIDENCE_PACKET_V2 as the sole structured case context/);
      assert.match(messages[1].content, /^DIAGNOSTIC_EVIDENCE_PACKET_V2:\n/);
      assert.doesNotMatch(messages[1].content, /VEHICLE EVIDENCE:/);
      assert.doesNotMatch(messages[1].content, /search-only-secret/);

      const packet = JSON.parse(messages[1].content.split('\n').slice(1).join('\n'));
      assert.equal(packet.schemaVersion, 2);
      assert.equal(packet.vehicle.model, 'Sorento');
      assert.deepEqual(packet.dtcs, ['P0300', 'P0171']);
      assert.equal(packet.dtcProvenance.verifiedCount, 2);
      assert.equal(packet.dtcProvenance.excludedCount, 0);
      assert.deepEqual(capture.pipelineInput.codes, ['P0300', 'P0171']);
      assert.ok(packet.observations.completedWork.includes('cv axle'));
      assert.equal(packet.measurements.values.brakes.padThickness, 3.1);
      assert.equal(packet.evidence.tsbs[0].source, 'NHTSA_BULK');
      assert.ok(packet.evidence.tsbs[0].excerpt.includes('P0300 diagnostic evidence'));

      assert.deepEqual(responseBody.result.codeExplanations, {
        P0300: 'Random misfire',
        P0171: 'Bank 1 lean'
      });
      assert.equal(responseBody.result.dtcProvenance.verifiedCount, 2);
      assert.equal(responseBody.result.dtcProvenance.excludedCount, 0);
      assert.deepEqual(responseBody.result.repairSteps, ['Measure mount movement under controlled load']);
      assert.deepEqual(responseBody.result.proTips, ['Compare cold and warm mount movement']);
      assert.equal(responseBody.result.estimatedRepairTime, '0.5 hour diagnostic inspection');
      assert.deepEqual(responseBody.result.knownIssues, [
        'TSB candidate: Engine performance bulletin'
      ]);
      assert.doesNotMatch(JSON.stringify(responseBody.result.knownIssues), /Untrusted model-memory/);
    });
  } finally {
    delete require.cache[routePath];
    restores.reverse().forEach(restore => restore());
  }
});

test('Diagnose excludes placeholder/manual/customer DTCs from pipeline, model context, and provider explanations', { concurrency: false }, async () => {
  const capture = {};
  const restores = stubs(capture);
  const routePath = require.resolve('../src/routes/diagnose');
  delete require.cache[routePath];

  try {
    const router = require('../src/routes/diagnose');
    await withServer(router, async base => {
      const response = await fetch(`${base}/api/diagnose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baseRequest({
          dtcEvidence: [
            { code: 'P0300', source: 'SCAN_TOOL', verified: true },
            { code: 'P0171', source: 'PLACEHOLDER', verified: false },
            { code: 'U0100', source: 'MANUAL_ENTRY', verified: false },
            { code: 'B1234', source: 'CUSTOMER_REPORTED', verified: false }
          ]
        }))
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      const modelMessage = capture.payload.messages[1].content;
      const packet = JSON.parse(modelMessage.split('\n').slice(1).join('\n'));

      assert.deepEqual(capture.pipelineInput.codes, ['P0300']);
      assert.deepEqual(packet.dtcs, ['P0300']);
      assert.equal(packet.dtcProvenance.verifiedCount, 1);
      assert.equal(packet.dtcProvenance.excludedCount, 3);
      assert.doesNotMatch(modelMessage, /P0171|U0100|B1234/);
      assert.deepEqual(body.result.codeExplanations, { P0300: 'Random misfire' });
      assert.equal(body.result.dtcProvenance.records.length, 4);
      assert.equal(body.result.dtcProvenance.records.find(x => x.code === 'P0171').source, 'PLACEHOLDER');
      assert.match(body.result.notes, /3 entered DTC records were excluded/i);
    });
  } finally {
    delete require.cache[routePath];
    restores.reverse().forEach(restore => restore());
  }
});

test('legacy bare code arrays are untrusted and cannot silently become diagnostic evidence', { concurrency: false }, async () => {
  const capture = {};
  const restores = stubs(capture);
  const routePath = require.resolve('../src/routes/diagnose');
  delete require.cache[routePath];

  try {
    const router = require('../src/routes/diagnose');
    await withServer(router, async base => {
      const response = await fetch(`${base}/api/diagnose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baseRequest({ dtcEvidence: undefined, codes: ['P0300', 'P0171'] }))
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      const packet = JSON.parse(capture.payload.messages[1].content.split('\n').slice(1).join('\n'));
      assert.deepEqual(capture.pipelineInput.codes, []);
      assert.deepEqual(packet.dtcs, []);
      assert.equal(packet.dtcProvenance.excludedCount, 2);
      assert.doesNotMatch(capture.payload.messages[1].content, /P0300|P0171/);
      assert.deepEqual(body.result.codeExplanations, {});
      assert.equal(body.result.dtcProvenance.records[0].source, 'LEGACY_UNSPECIFIED');
    });
  } finally {
    delete require.cache[routePath];
    restores.reverse().forEach(restore => restore());
  }
});
