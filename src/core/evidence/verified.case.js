'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 1;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => {
    if (value[key] !== undefined) out[key] = stable(value[key]);
    return out;
  }, {});
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function buildVerifiedCase(job = {}) {
  const verification = job.verification || {};
  const confirmedCause = clean(verification.confirmedCause, 300);
  if (job.status !== 'VERIFIED' || verification.confirmed !== true || !confirmedCause) {
    throw new Error('Verified case requires persisted VERIFIED status and an explicit confirmed cause');
  }
  if (!job.diagnosis?.result) throw new Error('Verified case requires a persisted diagnosis');
  if (!Array.isArray(job.tests) || job.tests.length === 0) throw new Error('Verified case requires recorded tests');

  const sourcePacket = clone(job.diagnosis.evidencePacket || null);
  const verifiedCase = {
    schemaVersion: SCHEMA_VERSION,
    stage: 'VERIFIED',
    jobId: job.jobId,
    vehicle: clone(sourcePacket?.vehicle || job.vehicle || {}),
    diagnosis: {
      primaryCause: clean(job.diagnosis.result.primaryCause, 300),
      probability: clone(job.diagnosis.result.probability || []),
      evidencePacketSchemaVersion: sourcePacket?.schemaVersion ?? null
    },
    evidencePacket: sourcePacket,
    tests: clone(job.tests),
    verification: {
      confirmed: true,
      confirmedCause,
      conclusion: clean(verification.conclusion, 1000),
      notes: clean(verification.notes, 1000),
      verifiedAt: verification.verifiedAt || null
    },
    repairScope: [{ component: confirmedCause, cause: confirmedCause }]
  };

  return Object.freeze({ ...verifiedCase, fingerprint: fingerprint(verifiedCase) });
}

function verifiedEstimateInput(verifiedCase) {
  if (!verifiedCase || verifiedCase.stage !== 'VERIFIED' || !verifiedCase.fingerprint) {
    throw new Error('Estimate requires a canonical VERIFIED_CASE');
  }
  const snapshot = clone(verifiedCase);
  if (fingerprint(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'fingerprint'))) !== snapshot.fingerprint) {
    throw new Error('VERIFIED_CASE integrity check failed');
  }
  return {
    verifiedCase: snapshot,
    diagnosisVerified: true,
    verificationStatus: 'VERIFIED',
    verifiedFaults: clone(snapshot.repairScope),
    diagnosticTests: clone(snapshot.tests)
  };
}

module.exports = { SCHEMA_VERSION, buildVerifiedCase, verifiedEstimateInput, fingerprint };
