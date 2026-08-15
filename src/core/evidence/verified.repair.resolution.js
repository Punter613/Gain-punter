'use strict';

const { verifiedEstimateInput, fingerprint } = require('./verified.case');

const SCHEMA_VERSION = 1;
const MAX_PART_LINES = 40;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

function hours(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(40, Math.round(n * 4) / 4);
}

function normalizeParts(parts = [], aggregatePartsCost = 0) {
  if (Array.isArray(parts) && parts.length) {
    return parts.slice(0, MAX_PART_LINES).map((part, index) => {
      const quantity = Math.max(0, Number(part?.quantity) || 0);
      const unitPrice = money(part?.unitPrice);
      return {
        line: index + 1,
        partNumber: clean(part?.partNumber, 120),
        description: clean(part?.description || part?.name || `Part ${index + 1}`, 300),
        quantity,
        unitPrice,
        total: money(quantity * unitPrice),
        source: 'MECHANIC_INPUT'
      };
    });
  }

  const total = money(aggregatePartsCost);
  return total > 0
    ? [{
        line: 1,
        partNumber: '',
        description: 'Mechanic-entered aggregate parts cost',
        quantity: 1,
        unitPrice: total,
        total,
        source: 'MECHANIC_INPUT'
      }]
    : [];
}

function buildVerifiedRepairResolution({
  verifiedCase,
  laborRate,
  laborHours,
  modelEstimatedHours,
  parts,
  partsCost
} = {}) {
  const canonical = verifiedEstimateInput(verifiedCase);
  const snapshot = canonical.verifiedCase;
  const repairScope = clone(snapshot.repairScope || []);
  if (!repairScope.length) throw new Error('Verified repair resolution requires persisted repair scope');

  const explicitHours = hours(laborHours);
  const advisoryHours = hours(modelEstimatedHours);
  const resolvedHours = explicitHours ?? advisoryHours ?? 0;
  const laborHoursSource = explicitHours != null ? 'MECHANIC_INPUT' : advisoryHours != null ? 'MODEL_ADVISORY' : 'UNKNOWN';
  const rate = money(laborRate);
  const partLines = normalizeParts(parts, partsCost);
  const partsTotal = money(partLines.reduce((sum, part) => sum + part.total, 0));

  const resolution = {
    schemaVersion: SCHEMA_VERSION,
    stage: 'REPAIR_RESOLVED',
    verifiedCaseFingerprint: snapshot.fingerprint,
    repairScope,
    labor: {
      hours: resolvedHours,
      hourlyRate: rate,
      hoursSource: laborHoursSource,
      rateSource: 'MECHANIC_INPUT'
    },
    parts: partLines,
    partsTotal,
    pricingAuthority: 'MECHANIC',
    diagnosticAuthority: 'VERIFIED_CASE'
  };

  return Object.freeze({ ...resolution, fingerprint: fingerprint(resolution) });
}

function assertRepairResolutionIntegrity(resolution, verifiedCase) {
  if (!resolution || resolution.stage !== 'REPAIR_RESOLVED' || !resolution.fingerprint) {
    throw new Error('Estimate requires a canonical repair resolution');
  }
  const canonical = verifiedEstimateInput(verifiedCase).verifiedCase;
  if (resolution.verifiedCaseFingerprint !== canonical.fingerprint) {
    throw new Error('Repair resolution does not belong to VERIFIED_CASE');
  }
  const snapshot = clone(resolution);
  const provided = snapshot.fingerprint;
  delete snapshot.fingerprint;
  if (fingerprint(snapshot) !== provided) throw new Error('Repair resolution integrity check failed');
  return clone(resolution);
}

module.exports = {
  SCHEMA_VERSION,
  buildVerifiedRepairResolution,
  assertRepairResolutionIntegrity,
  normalizeParts
};
