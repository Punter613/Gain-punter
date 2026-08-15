const test = require('node:test');
const assert = require('node:assert/strict');

const { runDiagnosticPipeline } = require('../src/services/pipeline.engine');

test('Diagnose pipeline returns the complete adapter contract instead of undefined enrichment fields', () => {
  const result = runDiagnosticPipeline({
    vehicle: { year: 2008, make: 'Ford', model: 'F-150', engine: '5.4L Triton' },
    vin: '',
    symptoms: ['rattle on cold start'],
    codes: []
  });

  assert.equal(result.type, 'diagnostic_plan');
  assert.equal(result.profile?.vehicleId, 'FORD_F150_3V_TRITON');
  assert.equal(result.vinBuildProfile, null);
  assert.equal(result.localSafetyTriggered, false);
  assert.equal(result.safetyNotes, '');
  assert.deepEqual(result.matchedPatterns, []);
  assert.equal(result.assemblyData, null);
  assert.equal(result.dynamicRisk, 0);
  assert.deepEqual(result.confidence, { percentage: 30, rating: 'LOW' });
  assert.deepEqual(result.symptomTelemetry, {
    hasMismatchedSignals: false,
    categories: {},
    overlappingClassesCount: 0
  });
});

test('unknown vehicle remains explicit unknown context rather than missing properties', () => {
  const result = runDiagnosticPipeline({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: '3.8L' },
    symptoms: ['bump on accelerator release'],
    codes: ['P0300', 'P0171']
  });

  assert.equal(result.profile, null);
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'vinBuildProfile'));
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'assemblyData'));
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'confidence'));
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'symptomTelemetry'));
});
