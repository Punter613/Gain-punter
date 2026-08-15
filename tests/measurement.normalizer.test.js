'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const deterministicOrchestrator = require('../src/core/orchestrator/deterministic.orchestrator');
const {
  normalizeVehicleMeasurements,
  monthsSince
} = require('../src/core/measurement/measurement-normalizer');

test('preserves zero as a real measurement and does not mutate input', () => {
  const profile = {
    componentData: {
      brakes: { padThickness: 0, brakeFluid: 0 },
      coolant: { condition: 0 }
    }
  };

  const normalized = normalizeVehicleMeasurements(profile, { now: Date.UTC(2026, 7, 14) });

  assert.equal(normalized.componentData.brakes.padThickness, 0);
  assert.equal(normalized.componentData.brakes.brakeFluid, 0);
  assert.equal(normalized.componentData.coolant.condition, 0);
  assert.notEqual(normalized.componentData, profile.componentData);
  assert.notEqual(normalized.componentData.brakes, profile.componentData.brakes);
});

test('derives TAG brake-fluid age from a service date only when canonical value is missing', () => {
  const now = Date.UTC(2026, 7, 14);
  const normalized = normalizeVehicleMeasurements({
    componentData: {
      brakes: { brakeFluidServiceDate: '2024-07-01T00:00:00.000Z' }
    }
  }, { now });

  assert.ok(normalized.componentData.brakes.brakeFluid > 24);

  const explicit = normalizeVehicleMeasurements({
    componentData: {
      brakes: {
        brakeFluid: 6,
        brakeFluidServiceDate: '2020-01-01T00:00:00.000Z'
      }
    }
  }, { now });

  assert.equal(explicit.componentData.brakes.brakeFluid, 6);
});

test('maps unit-labeled observation fields into canonical TAG scalars', () => {
  const normalized = normalizeVehicleMeasurements({
    componentData: {
      brakes: { padThicknessMm: '1.5', rotorRunoutMm: '0.06' },
      coolant: { ph: '6.8' },
      transmission: { darknessScore: '4' },
      steering: { playInches: '2.5' },
      suspension: { sagInches: '1.25' },
      electrical: { batteryVoltageV: '12.1', alternatorOutputV: '15.1' },
      exhaust: { carbonMonoxidePpm: '120' }
    }
  });

  assert.equal(normalized.componentData.brakes.padThickness, 1.5);
  assert.equal(normalized.componentData.brakes.rotorRunout, 0.06);
  assert.equal(normalized.componentData.coolant.condition, 6.8);
  assert.equal(normalized.componentData.transmission.fluidCondition, 4);
  assert.equal(normalized.componentData.steering.play, 2.5);
  assert.equal(normalized.componentData.suspension.sag, 1.25);
  assert.equal(normalized.componentData.electrical.batteryVoltage, 12.1);
  assert.equal(normalized.componentData.electrical.alternatorOutput, 15.1);
  assert.equal(normalized.componentData.exhaust.carbonMonoxide, 120);
});

test('invalid, future, null, and undefined dates remain unknown', async () => {
  const now = Date.UTC(2026, 7, 14);
  assert.equal(monthsSince('not-a-date', now), undefined);
  assert.equal(monthsSince(null, now), undefined);
  assert.equal(monthsSince('2027-01-01T00:00:00.000Z', now), undefined);

  const invalid = normalizeVehicleMeasurements({
    componentData: { brakes: { brakeFluidServiceDate: 'not-a-date' } }
  }, { now });
  assert.equal(invalid.componentData.brakes.brakeFluid, undefined);

  const future = normalizeVehicleMeasurements({
    componentData: { brakes: { brakeFluidServiceDate: '2027-01-01T00:00:00.000Z' } }
  }, { now });

  assert.equal(future.componentData.brakes.brakeFluid, undefined);

  const tagResult = await deterministicOrchestrator.process(future, 'brake fluid service date supplied');
  assert.equal(
    tagResult.overrides.some(item => item.component === 'brakes' && item.metric === 'brakeFluid'),
    false,
    'an impossible future service date must remain unknown rather than becoming a brake-fluid safety classification'
  );
  assert.equal(tagResult.canUseAI, true);
});
