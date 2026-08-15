'use strict';

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30;
const STRICT_NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const STRICT_SERVICE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Safety-boundary contract:
 * componentData aliases normalized here must come from mechanic-entered values or
 * trusted instrumentation/structured vehicle data. AI/OCR/vision-extracted values
 * must not be promoted into componentData aliases before TAG without a separate
 * provenance/confidence gate.
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value !== 'string') return undefined;

  const text = value.trim();
  if (!text || !STRICT_NUMERIC.test(text)) return undefined;

  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseServiceDate(value) {
  if (typeof value !== 'string') return undefined;

  const match = STRICT_SERVICE_DATE.exec(value.trim());
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return date;
}

function monthsSince(dateValue, now = Date.now()) {
  const date = parseServiceDate(dateValue);
  if (!date) return undefined;

  const timestamp = date.getTime();
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs) || timestamp > nowMs) return undefined;

  return (nowMs - timestamp) / MS_PER_MONTH;
}

function ensureComponent(componentData, component) {
  const current = componentData[component];
  if (current && typeof current === 'object' && !Array.isArray(current)) return current;
  const next = {};
  componentData[component] = next;
  return next;
}

function setNumericIfMissing(target, key, candidates) {
  if (target[key] !== undefined && target[key] !== null) {
    const normalized = toFiniteNumber(target[key]);
    if (normalized !== undefined) target[key] = normalized;
    else delete target[key];
    return;
  }

  for (const candidate of candidates) {
    const normalized = toFiniteNumber(candidate);
    if (normalized !== undefined) {
      target[key] = normalized;
      return;
    }
  }
}

function normalizeVehicleMeasurements(vehicleProfile = {}, options = {}) {
  const now = options.now ?? Date.now();
  const sourceComponentData = vehicleProfile.componentData || {};
  const componentData = {};

  for (const [component, data] of Object.entries(sourceComponentData)) {
    componentData[component] = data && typeof data === 'object' && !Array.isArray(data)
      ? { ...data }
      : data;
  }

  const brakes = ensureComponent(componentData, 'brakes');
  setNumericIfMissing(brakes, 'padThickness', [brakes.padThicknessMm]);
  setNumericIfMissing(brakes, 'rotorRunout', [brakes.rotorRunoutMm]);
  setNumericIfMissing(brakes, 'brakeFluid', [brakes.brakeFluidAgeMonths]);
  if (brakes.brakeFluid === undefined || brakes.brakeFluid === null) {
    const age = monthsSince(brakes.brakeFluidServiceDate || brakes.lastBrakeFluidServiceDate, now);
    if (age !== undefined) brakes.brakeFluid = age;
  }

  const coolant = ensureComponent(componentData, 'coolant');
  setNumericIfMissing(coolant, 'condition', [coolant.ph, coolant.pH]);

  const transmission = ensureComponent(componentData, 'transmission');
  setNumericIfMissing(transmission, 'fluidCondition', [transmission.darknessScore, transmission.darkness]);

  const steering = ensureComponent(componentData, 'steering');
  setNumericIfMissing(steering, 'play', [steering.playInches]);

  const suspension = ensureComponent(componentData, 'suspension');
  setNumericIfMissing(suspension, 'sag', [suspension.sagInches]);

  const electrical = ensureComponent(componentData, 'electrical');
  setNumericIfMissing(electrical, 'batteryVoltage', [electrical.batteryVoltageV]);
  setNumericIfMissing(electrical, 'alternatorOutput', [electrical.alternatorOutputV]);

  const exhaust = ensureComponent(componentData, 'exhaust');
  setNumericIfMissing(exhaust, 'carbonMonoxide', [exhaust.carbonMonoxidePpm, exhaust.carbonMonoxidePPM]);

  return {
    ...vehicleProfile,
    componentData
  };
}

module.exports = {
  normalizeVehicleMeasurements,
  monthsSince,
  parseServiceDate,
  toFiniteNumber
};
