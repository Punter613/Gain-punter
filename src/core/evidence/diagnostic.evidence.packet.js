'use strict';

const { normalizeVehicleMeasurements } = require('../measurement/measurement-normalizer');
const { extractCompletedWork } = require('../orchestrator/completed.work.guard');
const { getVehicleRiskProfile } = require('../../knowledge/vehicle.risk.table');

const SCHEMA_VERSION = 1;
const MAX_OBSERVATIONS = 12;
const MAX_OBSERVATION_CHARS = 500;
const MAX_OEM_REFERENCES = 6;
const MAX_TSB_REFERENCES = 5;
const MAX_EVIDENCE_EXCERPT = 800;
const MAX_MATCHED_SIGNALS = 12;

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function boundedText(value, max) {
  return cleanText(value).slice(0, max);
}

function boundedList(values, limit = MAX_OBSERVATIONS, maxChars = MAX_OBSERVATION_CHARS) {
  return (Array.isArray(values) ? values : [values])
    .map(value => boundedText(value, maxChars))
    .filter(Boolean)
    .slice(0, limit);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean' || Array.isArray(value) || typeof value === 'object') return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function optionalPositiveNumber(value) {
  const numeric = optionalNumber(value);
  return numeric !== undefined && numeric > 0 ? numeric : undefined;
}

const CANONICAL_MEASUREMENTS = {
  brakes: ['padThickness', 'rotorRunout', 'brakeFluid'],
  coolant: ['condition'],
  transmission: ['fluidCondition'],
  steering: ['play'],
  suspension: ['sag'],
  electrical: ['batteryVoltage', 'alternatorOutput'],
  exhaust: ['carbonMonoxide']
};

function compactTrustedMeasurements(vehicle = {}) {
  const normalized = normalizeVehicleMeasurements(vehicle);
  const componentData = normalized.componentData || {};
  const values = {};

  for (const [component, metrics] of Object.entries(CANONICAL_MEASUREMENTS)) {
    const source = componentData[component];
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;

    const compact = {};
    for (const metric of metrics) {
      const value = finiteNumber(source[metric]);
      if (value !== undefined) compact[metric] = value;
    }
    if (Object.keys(compact).length) values[component] = compact;
  }

  return { trust: 'TRUSTED_PRE_TAG_INPUT', values };
}

function compactDeterministicProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  return {
    vehicleId: boundedText(profile.vehicleId || '', 120) || undefined,
    make: boundedText(profile.make || '', 80) || undefined,
    model: boundedText(profile.model || '', 120) || undefined,
    engineCode: boundedText(profile.engineCode || '', 120) || undefined,
    yearRange: {
      min: optionalNumber(profile.minYear),
      max: optionalNumber(profile.maxYear)
    },
    baseRiskScore: optionalNumber(profile.baseRiskScore),
    safetyCriticalComponents: boundedList(profile.safetyCriticalComponents || [], 12, 120),
    commonFailures: boundedList(profile.commonFailures || [], 12, 160)
  };
}

function compactEvidenceReference(reference = {}) {
  const facts = reference.extractedFacts || {};
  const source = boundedText(reference.sourceAuthority || reference.source || facts.source || '', 80);
  const excerpt = boundedText(
    reference.excerpt || facts.evidenceExcerpt || reference.snippet || reference.bodyText || '',
    MAX_EVIDENCE_EXCERPT
  );
  const matchedSignals = boundedList(
    reference.matchedSignals || facts.matchedSignals || [],
    MAX_MATCHED_SIGNALS,
    120
  );

  const compact = {
    source: source || 'UNKNOWN',
    evidenceType: boundedText(reference.evidenceType || '', 80) || undefined,
    bulletinNumber: boundedText(reference.bulletinNumber || '', 120) || undefined,
    title: boundedText(reference.title || reference.subject || 'Evidence reference', 300),
    url: boundedText(reference.url || '', 1200) || undefined,
    relevanceScore: finiteNumber(reference.relevanceScore),
    matchedSignals,
    excerpt
  };

  return Object.fromEntries(Object.entries(compact).filter(([, value]) => value !== undefined && value !== ''));
}

function buildDiagnosticEvidencePacket(input = {}) {
  const vehicle = input.vehicle || {};
  const customerObservations = boundedList(input.customerObservations || []);
  const mechanicObservations = boundedList(input.mechanicObservations || []);
  const dtcs = boundedList(input.dtcs || [], 20, 32).map(code => code.toUpperCase());
  const completedWork = extractCompletedWork(mechanicObservations);
  const oemReferences = (input.oemReferences || []).slice(0, MAX_OEM_REFERENCES).map(compactEvidenceReference);
  const tsbReferences = (input.tsbReferences || []).slice(0, MAX_TSB_REFERENCES).map(compactEvidenceReference);
  const sources = boundedList(input.sources || [], 12, 80)
    .filter(source => source !== 'NHTSA_ODI' && source !== 'NHTSA ODI');
  const resolvedDeterministicProfile = input.deterministicProfile || getVehicleRiskProfile(vehicle, input.vin || '') || null;

  const deterministic = {
    vehicleProfile: compactDeterministicProfile(resolvedDeterministicProfile),
    safetyTriggered: input.localSafetyTriggered === true,
    safetyNotes: boundedText(input.safetyNotes || '', 800),
    matchedPatterns: boundedList(input.matchedPatterns || [], 12, 240)
  };

  const contradictions = [];
  if (input.symptomTelemetry?.hasMismatchedSignals) {
    contradictions.push({ code: 'MULTIPLE_SYMPTOM_CLASSES', detail: 'Observed symptoms span multiple classes; verify whether one fault or multiple faults are present.' });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    stage: 'DIAGNOSE',
    vehicle: {
      vin: boundedText(input.vin || '', 64) || undefined,
      year: optionalPositiveNumber(vehicle.year),
      make: boundedText(vehicle.make || '', 80) || undefined,
      model: boundedText(vehicle.model || '', 120) || undefined,
      trim: boundedText(vehicle.trim || '', 120) || undefined,
      engine: boundedText(vehicle.engine || '', 120) || undefined,
      drivetrain: boundedText(vehicle.driveType || vehicle.drivetrain || vehicle.drive || '', 80) || undefined,
      mileage: optionalPositiveNumber(input.mileage)
    },
    observations: { customer: customerObservations, mechanic: mechanicObservations, completedWork },
    dtcs,
    measurements: compactTrustedMeasurements(vehicle),
    deterministic,
    evidence: {
      oem: oemReferences,
      tsbs: tsbReferences,
      sources,
      available: input.evidenceAvailable === true,
      warmupStatus: boundedText(input.warmupStatus?.status || '', 80) || undefined
    },
    contradictions
  };
}

function compactDiagnosticEvidencePacket(packet) {
  return JSON.stringify(packet);
}

module.exports = {
  SCHEMA_VERSION,
  MAX_OBSERVATIONS,
  MAX_OBSERVATION_CHARS,
  MAX_OEM_REFERENCES,
  MAX_TSB_REFERENCES,
  MAX_EVIDENCE_EXCERPT,
  buildDiagnosticEvidencePacket,
  compactDiagnosticEvidencePacket,
  compactEvidenceReference,
  compactTrustedMeasurements,
  compactDeterministicProfile
};
