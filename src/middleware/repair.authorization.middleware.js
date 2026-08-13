'use strict';

const { evaluateRepairAuthorization } = require('../core/orchestrator/repair.authorization.guard');

function verificationPayloadFromJob(job = {}) {
  const verification = job.verification || {};
  const confirmedCause = String(verification.confirmedCause || '').trim();
  return {
    diagnosisVerified: verification.confirmed === true,
    verificationStatus: job.status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED',
    verifiedFaults: confirmedCause ? [{
      component: confirmedCause,
      cause: confirmedCause,
      finding: String(verification.conclusion || verification.notes || '').trim()
    }] : [],
    diagnosticTests: job.tests || []
  };
}

function authorizeJobRepair(job = {}) {
  return evaluateRepairAuthorization(verificationPayloadFromJob(job));
}

module.exports = { verificationPayloadFromJob, authorizeJobRepair };
