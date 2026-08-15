'use strict';

const { fingerprint } = require('./verified.case');

const SCHEMA_VERSION = 1;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function buildEstimateSnapshot({ jobId, estimate } = {}) {
  const id = String(jobId || '').trim();
  if (!id) throw new Error('Estimate snapshot requires a persisted job id');
  if (!estimate || typeof estimate !== 'object') throw new Error('Estimate snapshot requires estimate data');

  const verifiedCaseFingerprint = String(estimate?.evidence?.verifiedCaseFingerprint || '').trim();
  const repairResolutionFingerprint = String(estimate?.evidence?.repairResolutionFingerprint || '').trim();
  if (!verifiedCaseFingerprint || !repairResolutionFingerprint) {
    throw new Error('Estimate snapshot requires verified-case and repair-resolution fingerprints');
  }

  const payload = clone(estimate);
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    stage: 'ESTIMATE_LOCKED',
    jobId: id,
    verifiedCaseFingerprint,
    repairResolutionFingerprint,
    total: Number(payload.total) || 0,
    estimate: payload
  };

  return Object.freeze({ ...snapshot, fingerprint: fingerprint(snapshot) });
}

function assertEstimateSnapshotIntegrity(snapshot) {
  if (!snapshot || snapshot.stage !== 'ESTIMATE_LOCKED' || !snapshot.fingerprint) {
    throw new Error('A canonical locked estimate snapshot is required');
  }
  const copy = clone(snapshot);
  const provided = copy.fingerprint;
  delete copy.fingerprint;
  if (fingerprint(copy) !== provided) throw new Error('Estimate snapshot integrity check failed');
  return clone(snapshot);
}

module.exports = {
  SCHEMA_VERSION,
  buildEstimateSnapshot,
  assertEstimateSnapshotIntegrity
};
