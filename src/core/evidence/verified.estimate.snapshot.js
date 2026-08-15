'use strict';

const { fingerprint, verifiedEstimateInput } = require('./verified.case');
const { assertRepairResolutionIntegrity } = require('./verified.repair.resolution');

const SCHEMA_VERSION = 1;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function buildVerifiedEstimateSnapshot(job = {}, estimate = {}) {
  const verifiedCase = verifiedEstimateInput(job.verifiedCase).verifiedCase;
  const repairResolution = assertRepairResolutionIntegrity(estimate.repairResolution, verifiedCase);
  const candidate = {
    ...clone(estimate),
    schemaVersion: SCHEMA_VERSION,
    stage: 'ESTIMATED',
    jobId: job.jobId,
    estimateNumber: job.jobId,
    verifiedCaseFingerprint: verifiedCase.fingerprint,
    repairResolutionFingerprint: repairResolution.fingerprint,
    createdAt: new Date().toISOString()
  };
  delete candidate.fingerprint;
  return Object.freeze({ ...candidate, fingerprint: fingerprint(candidate) });
}

function assertVerifiedEstimateSnapshot(snapshot, job = {}) {
  if (!snapshot || snapshot.stage !== 'ESTIMATED' || !snapshot.fingerprint) {
    throw new Error('Invoice requires a canonical ESTIMATED snapshot');
  }
  const verifiedCase = verifiedEstimateInput(job.verifiedCase).verifiedCase;
  if (snapshot.jobId !== job.jobId) throw new Error('Estimate snapshot does not belong to job');
  if (snapshot.verifiedCaseFingerprint !== verifiedCase.fingerprint) {
    throw new Error('Estimate snapshot does not belong to VERIFIED_CASE');
  }
  const repairResolution = assertRepairResolutionIntegrity(snapshot.repairResolution, verifiedCase);
  if (snapshot.repairResolutionFingerprint !== repairResolution.fingerprint) {
    throw new Error('Estimate snapshot repair resolution fingerprint mismatch');
  }
  const copy = clone(snapshot);
  const provided = copy.fingerprint;
  delete copy.fingerprint;
  if (fingerprint(copy) !== provided) throw new Error('Estimate snapshot integrity check failed');
  return clone(snapshot);
}

module.exports = {
  SCHEMA_VERSION,
  buildVerifiedEstimateSnapshot,
  assertVerifiedEstimateSnapshot
};
