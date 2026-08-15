const test = require('node:test');
const assert = require('node:assert/strict');

const { runDiagnosticPipeline } = require('../src/services/pipeline.engine');
const { getVehicleRiskProfile } = require('../src/knowledge/vehicle.risk.table');

function ford54(model) {
  return runDiagnosticPipeline({
    vehicle: { year: 2008, make: 'Ford', model, engine: '5.4L Triton' },
    vin: '',
    symptoms: ['rattle on cold start'],
    codes: []
  });
}

test('Diagnose pipeline resolves common F-150 model spellings and returns explicit adapter context', () => {
  for (const model of ['F-150', 'f150', 'F 150']) {
    const result = ford54(model);
    assert.equal(result.type, 'diagnostic_plan', model);
    assert.equal(result.profile?.vehicleId, 'FORD_F150_3V_TRITON', model);
    assert.equal(result.vinBuildProfile, null, model);
    assert.equal(result.localSafetyTriggered, false, model);
    assert.equal(result.safetyNotes, '', model);
    assert.deepEqual(result.matchedPatterns, [], model);
    assert.equal(result.assemblyData, null, model);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'dynamicRisk'), false, model);
    assert.deepEqual(result.confidence, { percentage: 30, rating: 'LOW' }, model);
    assert.deepEqual(result.symptomTelemetry, {
      hasMismatchedSignals: false,
      categories: {},
      overlappingClassesCount: 0
    }, model);
  }
});

test('vehicle risk lookup normalizes canonical and punctuated F-150 spellings', () => {
  for (const model of ['F-150', 'f150', 'F 150']) {
    const profile = getVehicleRiskProfile({ year: 2008, make: 'Ford', model, engine: '5.4L Triton' });
    assert.equal(profile?.vehicleId, 'FORD_F150_3V_TRITON', model);
  }
});

test('recognized vehicle does not fabricate dynamic risk when no risk engine computed it', () => {
  const result = ford54('F-150');
  assert.equal(result.profile?.vehicleId, 'FORD_F150_3V_TRITON');
  assert.equal('dynamicRisk' in result, false);
});

test('unknown vehicle remains explicit unknown context rather than missing adapter properties', () => {
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
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'dynamicRisk'), false);
});
