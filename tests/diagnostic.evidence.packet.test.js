'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_OBSERVATIONS,
  MAX_EVIDENCE_EXCERPT,
  buildDiagnosticEvidencePacket,
  compactDiagnosticEvidencePacket
} = require('../src/core/evidence/diagnostic.evidence.packet');

function build(overrides = {}) {
  return buildDiagnosticEvidencePacket({
    vin: 'KNDJC735785123456',
    mileage: 150000,
    vehicle: {
      year: 2008,
      make: 'Kia',
      model: 'Sorento',
      engine: '3.8L',
      drivetrain: '4WD',
      componentData: {
        brakes: { padThicknessMm: 0, brakeFluidAgeMonths: '18' },
        electrical: { batteryVoltageV: '12.2' }
      }
    },
    customerObservations: ['repetitive bump on accelerator release', 'clunk at full steering lock'],
    mechanicObservations: ['CV axles replaced', 'upper control arms replaced', 'lower ball joints replaced'],
    dtcs: ['p0300', 'P0171'],
    deterministicProfile: null,
    oemReferences: [],
    tsbReferences: [],
    sources: [],
    ...overrides
  });
}

test('canonical packet separates observations, completed work, DTCs, and trusted measurements', () => {
  const packet = build();

  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.stage, 'DIAGNOSE');
  assert.equal(packet.vehicle.make, 'Kia');
  assert.deepEqual(packet.dtcs, ['P0300', 'P0171']);
  assert.deepEqual(packet.observations.customer, [
    'repetitive bump on accelerator release',
    'clunk at full steering lock'
  ]);
  assert.ok(packet.observations.completedWork.includes('cv axle'));
  assert.ok(packet.observations.completedWork.includes('upper control arm'));
  assert.ok(packet.observations.completedWork.includes('lower ball joint'));
  assert.equal(packet.measurements.trust, 'TRUSTED_PRE_TAG_INPUT');
  assert.equal(packet.measurements.values.brakes.padThickness, 0, 'real zero must survive');
  assert.equal(packet.measurements.values.brakes.brakeFluid, 18);
  assert.equal(packet.measurements.values.electrical.batteryVoltage, 12.2);
});

test('evidence references remain bounded while preserving source, matched signals, and supporting excerpt', () => {
  const longText = `P0300 supporting statement. ${'evidence '.repeat(300)}`;
  const packet = build({
    tsbReferences: [{
      sourceAuthority: 'NHTSA_BULK',
      bulletinNumber: 'KT-TEST-001',
      title: 'Engine performance bulletin',
      relevanceScore: 42,
      matchedSignals: ['DTC:P0300', 'OVERLAP:engine-performance'],
      bodyText: longText
    }]
  });

  const ref = packet.evidence.tsbs[0];
  assert.equal(ref.source, 'NHTSA_BULK');
  assert.equal(ref.bulletinNumber, 'KT-TEST-001');
  assert.equal(ref.relevanceScore, 42);
  assert.ok(ref.matchedSignals.includes('DTC:P0300'));
  assert.ok(ref.excerpt.includes('P0300 supporting statement'));
  assert.ok(ref.excerpt.length <= MAX_EVIDENCE_EXCERPT);
});

test('packet is bounded and excludes live ODI/retrieval-only metadata from model context', () => {
  const packet = build({
    customerObservations: Array.from({ length: 30 }, (_, i) => `customer observation ${i} ${'x'.repeat(900)}`),
    sources: ['LEMON_MANUALS', 'NHTSA_BULK', 'NHTSA_ODI'],
    keywords: ['this-must-never-enter-the-packet']
  });

  assert.equal(packet.observations.customer.length, MAX_OBSERVATIONS);
  assert.ok(packet.observations.customer.every(item => item.length <= 500));
  assert.deepEqual(packet.evidence.sources, ['LEMON_MANUALS', 'NHTSA_BULK']);
  assert.doesNotMatch(compactDiagnosticEvidencePacket(packet), /this-must-never-enter-the-packet/);
});

test('invalid measurements remain unknown instead of becoming deterministic zeroes', () => {
  const packet = build({
    vehicle: {
      year: 2008,
      make: 'Kia',
      model: 'Sorento',
      componentData: {
        brakes: { padThicknessMm: ' ', brakeFluidAgeMonths: false },
        electrical: { batteryVoltageV: Infinity }
      }
    }
  });

  assert.deepEqual(packet.measurements.values, {});
});

test('deterministic profile is compacted instead of copying arbitrary registry payload', () => {
  const packet = build({
    deterministicProfile: {
      vehicleId: 'FORD_F150_3V_TRITON',
      make: 'Ford',
      model: 'F150',
      engineCode: '5.4L 3V',
      minYear: 2004,
      maxYear: 2010,
      baseRiskScore: 78,
      safetyCriticalComponents: ['spark_plugs', 'brakes'],
      commonFailures: ['spark_plug_separation'],
      giantInternalBlob: 'DO_NOT_COPY'.repeat(1000)
    }
  });

  assert.equal(packet.deterministic.vehicleProfile.vehicleId, 'FORD_F150_3V_TRITON');
  assert.equal(packet.deterministic.vehicleProfile.baseRiskScore, 78);
  assert.equal('giantInternalBlob' in packet.deterministic.vehicleProfile, false);
  assert.doesNotMatch(JSON.stringify(packet), /DO_NOT_COPY/);
});
