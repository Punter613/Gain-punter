'use strict';

const CONFIGURATION_STATUS = Object.freeze({
  VIN_VERIFIED: 'VIN_VERIFIED',
  MANUAL_UNVERIFIED: 'MANUAL_UNVERIFIED',
  UNKNOWN: 'UNKNOWN'
});

const COMPONENT_RULES = Object.freeze([
  {
    key: 'CENTER_SUPPORT_BEARING',
    family: 'DRIVELINE',
    proof: 'PRESENCE',
    pattern: /\b(?:drive\s*shaft|driveshaft|propeller\s*shaft)?\s*(?:center\s+support|carrier|center)\s+bearing\b/i
  },
  {
    key: 'TRANSFER_CASE',
    family: 'DRIVELINE',
    proof: 'PRESENCE',
    pattern: /\btransfer\s+case\b/i
  },
  {
    key: 'POWER_TRANSFER_UNIT',
    family: 'DRIVELINE',
    proof: 'PRESENCE',
    pattern: /\b(?:power\s+transfer\s+unit|PTU)\b/i
  },
  {
    key: 'CENTER_DIFFERENTIAL',
    family: 'DRIVELINE',
    proof: 'PRESENCE',
    pattern: /\bcenter\s+differential\b/i
  },
  {
    key: 'FRONT_DIFFERENTIAL',
    family: 'DRIVELINE',
    proof: 'AWD_4WD_OR_PRESENCE',
    pattern: /\bfront\s+differential\b/i
  },
  {
    key: 'REAR_DIFFERENTIAL',
    family: 'DRIVELINE',
    proof: 'RWD_AWD_4WD_OR_PRESENCE',
    pattern: /\brear\s+differential\b/i
  },
  {
    key: 'DRIVESHAFT',
    family: 'DRIVELINE',
    proof: 'RWD_AWD_4WD_OR_PRESENCE',
    pattern: /\b(?:drive\s*shaft|driveshaft|propeller\s*shaft)\b/i
  },
  {
    key: 'UNIVERSAL_JOINT',
    family: 'DRIVELINE',
    proof: 'RWD_AWD_4WD_OR_PRESENCE',
    pattern: /\b(?:universal\s+joint|u[-\s]?joint)s?\b/i
  },
  {
    key: 'TURBOCHARGER',
    family: 'ENGINE',
    proof: 'PRESENCE',
    pattern: /\bturbo(?:charger|charged|\s+charger)?\b/i
  },
  {
    key: 'SUPERCHARGER',
    family: 'ENGINE',
    proof: 'PRESENCE',
    pattern: /\bsupercharger\b/i
  },
  {
    key: 'HIGH_VOLTAGE_BATTERY',
    family: 'HYBRID',
    proof: 'PRESENCE',
    pattern: /\b(?:high[-\s]?voltage|traction|hybrid)\s+battery\b/i
  },
  {
    key: 'DIESEL_PARTICULATE_FILTER',
    family: 'EMISSIONS',
    proof: 'PRESENCE',
    pattern: /\b(?:diesel\s+particulate\s+filter|DPF)\b/i
  }
]);

const PRESENCE_VERBS = /\b(?:inspect(?:ed|ing)?|measure(?:d|ment)?|replace(?:d|ment)?|remove(?:d|al)?|install(?:ed|ation)?|visible|present|equipped|located|found|observed|play\s+(?:at|in)|loose|worn|failed|damaged)\b/i;

function clean(value, max = 800) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalized(value) {
  return clean(value, 300).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function validVin(vin) {
  return /^[A-HJ-NPR-Z0-9]{17}$/i.test(clean(vin, 32));
}

function valuesConflict(a, b) {
  const left = normalized(a);
  const right = normalized(b);
  if (!left || !right) return false;
  if (left === right) return false;
  return !left.includes(right) && !right.includes(left);
}

function driveClass(vehicle = {}) {
  const drive = clean(vehicle.driveType || vehicle.drivetrain || vehicle.drive, 120).toUpperCase();
  if (!drive) return 'UNKNOWN';
  if (/\b(?:4WD|4X4|FOUR WHEEL)\b/.test(drive)) return '4WD';
  if (/\b(?:AWD|ALL WHEEL)\b/.test(drive)) return 'AWD';
  if (/\b(?:RWD|REAR WHEEL)\b/.test(drive)) return 'RWD';
  if (/\b(?:FWD|FRONT WHEEL)\b/.test(drive)) return 'FWD';
  return 'OTHER';
}

function buildVehicleConfigurationBoundary(input = {}) {
  const vin = clean(input.vin || input.resolvedVehicle?.vin || input.suppliedVehicle?.vin, 32).toUpperCase();
  const supplied = input.suppliedVehicle || {};
  const resolved = input.resolvedVehicle || supplied;
  const vinVerified = input.vinDecoded === true && validVin(vin);
  const drive = driveClass(resolved);
  const engine = clean(resolved.engine, 160);
  const suppliedEngine = clean(supplied.engine, 160);
  const suppliedDrive = clean(supplied.driveType || supplied.drivetrain || supplied.drive, 120);
  const contradictions = [];

  if (vinVerified) {
    if (valuesConflict(supplied.year, resolved.year)) contradictions.push({ code: 'VIN_YEAR_MISMATCH', field: 'year' });
    if (valuesConflict(supplied.make, resolved.make)) contradictions.push({ code: 'VIN_MAKE_MISMATCH', field: 'make' });
    if (valuesConflict(supplied.model, resolved.model)) contradictions.push({ code: 'VIN_MODEL_MISMATCH', field: 'model' });
    if (valuesConflict(suppliedEngine, engine)) contradictions.push({ code: 'VIN_ENGINE_MISMATCH', field: 'engine' });
    if (valuesConflict(suppliedDrive, resolved.driveType || resolved.drivetrain)) contradictions.push({ code: 'VIN_DRIVETRAIN_MISMATCH', field: 'drivetrain' });
  }

  const warnings = [];
  if (!vinVerified) warnings.push('Vehicle configuration is based on manual intake and is not fitment proof.');
  if (!engine) warnings.push('Engine configuration is not established.');
  else if (!vinVerified) warnings.push('Engine entry is manual/unverified and must not be used as component fitment proof.');
  if (drive === 'UNKNOWN') warnings.push('Drivetrain configuration is not established.');
  if (contradictions.length) warnings.push('Manual intake conflicts with VIN-decoded configuration; VIN-decoded identity must control applicability.');

  return {
    policy: 'PROVE_COMPONENT_EXISTS_OR_QUALIFY_IF_EQUIPPED',
    vinStatus: vinVerified ? CONFIGURATION_STATUS.VIN_VERIFIED : (validVin(vin) ? CONFIGURATION_STATUS.UNKNOWN : CONFIGURATION_STATUS.MANUAL_UNVERIFIED),
    engineStatus: engine ? (vinVerified ? CONFIGURATION_STATUS.VIN_VERIFIED : CONFIGURATION_STATUS.MANUAL_UNVERIFIED) : CONFIGURATION_STATUS.UNKNOWN,
    drivetrainStatus: drive !== 'UNKNOWN' ? (vinVerified ? CONFIGURATION_STATUS.VIN_VERIFIED : CONFIGURATION_STATUS.MANUAL_UNVERIFIED) : CONFIGURATION_STATUS.UNKNOWN,
    driveClass: drive,
    contradictions,
    warnings
  };
}

function mechanicPresenceEvidence(rule, mechanicObservations = []) {
  return (Array.isArray(mechanicObservations) ? mechanicObservations : [])
    .map(value => clean(value, 1200))
    .some(text => rule.pattern.test(text) && PRESENCE_VERBS.test(text));
}

function ruleEstablished(rule, boundary = {}, mechanicObservations = []) {
  if (mechanicPresenceEvidence(rule, mechanicObservations)) return true;
  const drive = boundary.driveClass || 'UNKNOWN';
  if (rule.proof === 'RWD_AWD_4WD_OR_PRESENCE') return ['RWD', 'AWD', '4WD'].includes(drive);
  if (rule.proof === 'AWD_4WD_OR_PRESENCE') return ['AWD', '4WD'].includes(drive);
  return false;
}

function unresolvedRules(text, boundary = {}, mechanicObservations = []) {
  const value = clean(text, 1600);
  if (!value) return [];
  return COMPONENT_RULES.filter(rule => rule.pattern.test(value) && !ruleEstablished(rule, boundary, mechanicObservations));
}

function broadCause(family) {
  if (family === 'DRIVELINE') return 'Driveline / torque-transfer mechanical fault (specific component fitment not yet verified)';
  if (family === 'ENGINE') return 'Engine system fault (specific component fitment not yet verified)';
  if (family === 'HYBRID') return 'Hybrid / high-voltage system fault (specific component fitment not yet verified)';
  if (family === 'EMISSIONS') return 'Engine / emissions system fault (specific component fitment not yet verified)';
  return 'Vehicle system fault (specific component fitment not yet verified)';
}

function qualifyCandidate(text, rules) {
  const value = clean(text, 900);
  if (!value || !rules.length || /if equipped|fitment not (?:verified|confirmed)|configuration not (?:verified|confirmed)/i.test(value)) return value;
  return `${value} (if equipped — configuration not verified)`;
}

function qualifyTest(text, rules) {
  const value = clean(text, 1200);
  if (!value || !rules.length || /^if equipped\b/i.test(value)) return value;
  return `If equipped on this exact vehicle configuration: ${value}`;
}

function lowerConfidence(confidence = {}, forcedLow = false) {
  const raw = Number(confidence?.percentage);
  const percentage = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 30;
  if (!forcedLow) return { percentage, rating: clean(confidence?.rating, 20).toUpperCase() || (percentage >= 80 ? 'HIGH' : percentage >= 50 ? 'MODERATE' : 'LOW') };
  return { percentage: Math.min(40, percentage), rating: 'LOW' };
}

function applyComponentApplicabilityGuard(result = {}, boundary = {}, context = {}) {
  const mechanicObservations = Array.isArray(context.mechanicObservations) ? context.mechanicObservations : [];
  const guardedKeys = new Set();
  const primaryRules = unresolvedRules(result.primaryCause || result.diagnosis, boundary, mechanicObservations);
  primaryRules.forEach(rule => guardedKeys.add(rule.key));

  const primaryCause = primaryRules.length
    ? broadCause(primaryRules[0].family)
    : clean(result.primaryCause || result.diagnosis, 900);

  const secondaryCauses = (Array.isArray(result.secondaryCauses) ? result.secondaryCauses : []).map(cause => {
    const rules = unresolvedRules(cause, boundary, mechanicObservations);
    rules.forEach(rule => guardedKeys.add(rule.key));
    return qualifyCandidate(cause, rules);
  }).filter(Boolean);

  const probability = (Array.isArray(result.probability) ? result.probability : []).map(item => {
    const cause = clean(item?.cause, 900);
    const rules = unresolvedRules(cause, boundary, mechanicObservations);
    rules.forEach(rule => guardedKeys.add(rule.key));
    return { ...item, cause: qualifyCandidate(cause, rules) };
  }).filter(item => item.cause);

  const recommendedTests = (Array.isArray(result.recommendedTests) ? result.recommendedTests : []).map(test => {
    const rules = unresolvedRules(test, boundary, mechanicObservations);
    rules.forEach(rule => guardedKeys.add(rule.key));
    return qualifyTest(test, rules);
  }).filter(Boolean);

  const additionalChecks = (Array.isArray(result.additionalChecks) ? result.additionalChecks : []).map(test => {
    const rules = unresolvedRules(test, boundary, mechanicObservations);
    rules.forEach(rule => guardedKeys.add(rule.key));
    return qualifyTest(test, rules);
  }).filter(Boolean);

  const guardApplied = guardedKeys.size > 0 || (Array.isArray(boundary.contradictions) && boundary.contradictions.length > 0);
  const warning = guardedKeys.size
    ? 'Component-specific diagnosis was bounded because exact vehicle fitment has not been established. Verify VIN/configuration or physically establish that the component is present before promoting it as the diagnosis.'
    : '';
  const priorNotes = clean(result.notes, 1400);
  const notes = warning ? `${priorNotes}${priorNotes ? ' ' : ''}${warning}` : priorNotes;

  return {
    output: {
      ...result,
      primaryCause,
      secondaryCauses,
      probability,
      recommendedTests,
      additionalChecks,
      notes,
      diagnosticConfidence: lowerConfidence(result.diagnosticConfidence, primaryRules.length > 0 || (boundary.contradictions || []).length > 0),
      vehicleConfiguration: {
        ...boundary,
        guardApplied,
        guardedCandidateCount: guardedKeys.size
      }
    },
    changed: guardApplied,
    guardedKeys: [...guardedKeys]
  };
}

module.exports = {
  CONFIGURATION_STATUS,
  COMPONENT_RULES,
  buildVehicleConfigurationBoundary,
  driveClass,
  mechanicPresenceEvidence,
  unresolvedRules,
  applyComponentApplicabilityGuard
};
