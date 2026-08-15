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
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(40, Math.round(n * 4) / 4);
}

function canonicalOperationId(scope = {}, index = 0) {
  const identity = clean(scope.cause || scope.component, 300).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!identity) throw new Error('Verified repair scope contains an invalid operation');
  return `VERIFY_OP_${index + 1}_${identity}`;
}

function verifiedOperations(repairScope = []) {
  if (!Array.isArray(repairScope) || !repairScope.length) {
    throw new Error('Verified repair resolution requires persisted repair scope');
  }
  return repairScope.map((scope, index) => Object.freeze({
    operationId: canonicalOperationId(scope, index),
    component: clean(scope.component, 300),
    cause: clean(scope.cause, 300)
  }));
}

function assertOperationBinding(operationId, allowedIds, label) {
  const id = clean(operationId, 200);
  if (!id || !allowedIds.has(id)) throw new Error(`${label} must bind to a VERIFIED_CASE repair operation`);
  return id;
}

function normalizeParts(parts = [], aggregatePartsCost = 0, operations = []) {
  const allowedIds = new Set(operations.map(operation => operation.operationId));
  const defaultOperationId = operations.length === 1 ? operations[0].operationId : '';
  if (Array.isArray(parts) && parts.length) {
    if (parts.length > MAX_PART_LINES) {
      throw new Error(`Verified repair resolution supports at most ${MAX_PART_LINES} part lines`);
    }
    return parts.map((part, index) => {
      const operationId = assertOperationBinding(part?.operationId || defaultOperationId, allowedIds, 'Part line');
      const quantity = Math.max(0, Number(part?.quantity) || 0);
      const unitPrice = money(part?.unitPrice);
      return {
        line: index + 1,
        operationId,
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
        operationId: assertOperationBinding(defaultOperationId, allowedIds, 'Aggregate parts line'),
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
  laborRateSource = 'MECHANIC_INPUT',
  laborHours,
  modelEstimatedHours,
  parts,
  partsCost,
  operationId
} = {}) {
  const canonical = verifiedEstimateInput(verifiedCase);
  const snapshot = canonical.verifiedCase;
  const repairScope = clone(snapshot.repairScope || []);
  const operations = verifiedOperations(repairScope);
  const allowedIds = new Set(operations.map(operation => operation.operationId));
  const defaultOperationId = operations.length === 1 ? operations[0].operationId : '';
  const laborOperationId = assertOperationBinding(operationId || defaultOperationId, allowedIds, 'Labor line');

  const explicitHours = hours(laborHours);
  const advisoryHours = hours(modelEstimatedHours);
  const resolvedHours = explicitHours ?? advisoryHours ?? 0;
  const laborHoursSource = explicitHours != null ? 'MECHANIC_INPUT' : advisoryHours != null ? 'MODEL_ADVISORY' : 'UNKNOWN';
  const rate = money(laborRate);
  const partLines = normalizeParts(parts, partsCost, operations);
  const partsTotal = money(partLines.reduce((sum, part) => sum + part.total, 0));

  const resolution = {
    schemaVersion: SCHEMA_VERSION,
    stage: 'REPAIR_RESOLVED',
    verifiedCaseFingerprint: snapshot.fingerprint,
    repairScope,
    operations,
    labor: {
      operationId: laborOperationId,
      hours: resolvedHours,
      hourlyRate: rate,
      hoursSource: laborHoursSource,
      rateSource: clean(laborRateSource, 80) || 'UNKNOWN'
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
  const expectedOperations = verifiedOperations(canonical.repairScope || []);
  if (fingerprint(resolution.operations || []) !== fingerprint(expectedOperations)) {
    throw new Error('Repair resolution operation set does not match VERIFIED_CASE');
  }
  const allowedIds = new Set(expectedOperations.map(operation => operation.operationId));
  assertOperationBinding(resolution.labor?.operationId, allowedIds, 'Labor line');
  for (const part of resolution.parts || []) assertOperationBinding(part?.operationId, allowedIds, 'Part line');

  const snapshot = clone(resolution);
  const provided = snapshot.fingerprint;
  delete snapshot.fingerprint;
  if (fingerprint(snapshot) !== provided) throw new Error('Repair resolution integrity check failed');
  return clone(resolution);
}

module.exports = {
  SCHEMA_VERSION,
  MAX_PART_LINES,
  buildVerifiedRepairResolution,
  assertRepairResolutionIntegrity,
  normalizeParts,
  hours,
  canonicalOperationId,
  verifiedOperations
};
