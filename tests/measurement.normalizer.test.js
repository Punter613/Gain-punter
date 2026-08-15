'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const deterministicOrchestrator = require('../src/core/orchestrator/deterministic.orchestrator');
const {
  normalizeVehicleMeasurements,
  monthsSince,
  parseServiceDate,
  toFiniteNumber
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

test('derives TAG brake-fluid age from a strict service date only when canonical value is missing', () => {
  const now = Date.UTC(2026, 7, 14);
  const normalized = normalizeVehicleMeasurements({
    componentData: {
      brakes: { brakeFluidServiceDate: '2024-07-01' }
    }
  }, { now });

  assert.ok(normalized.componentData.brakes.brakeFluid > 24);

  const explicit = normalizeVehicleMeasurements({
    componentData: {
      brakes: {
        brakeFluid: 6,
        brakeFluidServiceDate: '2020-01-01'
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

test('numeric parser rejects coercion-prone and non-finite values', async () => {
  const invalidValues = [' ', false, true, 'abc', NaN, Infinity, -Infinity, [], {}, '12V'];

  for (const value of invalidValues) {
    assert.equal(toFiniteNumber(value), undefined, `expected ${String(value)} to remain unknown`);

    const normalized = normalizeVehicleMeasurements({
      componentData: { brakes: { padThicknessMm: value } }
    });

    assert.equal(normalized.componentData.brakes.padThickness, undefined);

    const tagResult = await deterministicOrchestrator.process(normalized, 'pad thickness supplied');
    assert.equal(
      tagResult.overrides.some(item => item.component === 'brakes' && item.metric === 'padThickness'),
      false,
      `invalid value ${String(value)} must not become a TAG brake measurement`
    );
  }
});

test('service-date parser accepts only real YYYY-MM-DD calendar dates', () => {
  assert.ok(parseServiceDate('2026-02-28') instanceof Date);
  assert.equal(parseServiceDate(true), undefined);
  assert.equal(parseServiceDate(false), undefined);
  assert.equal(parseServiceDate('0'), undefined);
  assert.equal(parseServiceDate('2026/02/28'), undefined);
  assert.equal(parseServiceDate('2026-2-28'), undefined);
  assert.equal(parseServiceDate('2026-02-30'), undefined);
  assert.equal(parseServiceDate('2026-13-01'), undefined);
  assert.equal(parseServiceDate('2026-00-10'), undefined);
  assert.equal(parseServiceDate('2024-07-01T00:00:00.000Z'), undefined);
});

test('invalid and future service dates remain unknown and cannot trigger brake-fluid TAG', async () => {
  const now = Date.UTC(2026, 7, 14);
  const invalidDates = [
    true,
    false,
    '0',
    'not-a-date',
    '2026-02-30',
    '2026/01/01',
    '2027-01-01'
  ];

  assert.equal(monthsSince(null, now), undefined);

  for (const dateValue of invalidDates) {
    assert.equal(monthsSince(dateValue, now), undefined);

    const normalized = normalizeVehicleMeasurements({
      componentData: { brakes: { brakeFluidServiceDate: dateValue } }
    }, { now });

    assert.equal(normalized.componentData.brakes.brakeFluid, undefined);

    const tagResult = await deterministicOrchestrator.process(normalized, 'brake fluid service date supplied');
    assert.equal(
      tagResult.overrides.some(item => item.component === 'brakes' && item.metric === 'brakeFluid'),
      false,
      `invalid/future service date ${String(dateValue)} must remain unknown`
    );
    assert.equal(tagResult.canUseAI, true);
  }
});
