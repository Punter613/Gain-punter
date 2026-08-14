'use strict';

const { evaluateRepairAuthorization } = require('../core/orchestrator/repair.authorization.guard');

function verificationPayloadFromJob(job = {}) {
  const verification = job.verification || {};
  const confirmedCause = String(verification.confirmedCause || '').trim();
  const statusVerified = job.status === 'VERIFIED';
  // Require the job's persisted lifecycle status AND the verification
  // record to agree before treating this as verified. Reading
  // verification.confirmed in isolation let a job stuck in an earlier
  // status (e.g. still 'TESTING') authorize a repair anyway, since the
  // guard's explicitVerified check is an OR across diagnosisVerified and
  // verificationStatus - either signal alone was enough. These two
  // fields are meant to move together (see job.lifecycle.js's
  // verifyJob); this makes that assumption explicit instead of trusting
  // it implicitly.
  const diagnosisVerified = statusVerified && verification.confirmed === true;
  return {
    diagnosisVerified,
    verificationStatus: statusVerified ? 'VERIFIED' : 'UNVERIFIED',
    verifiedFaults: (diagnosisVerified && confirmedCause) ? [{
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
