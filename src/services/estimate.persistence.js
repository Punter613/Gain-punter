'use strict';

const { supabase } = require('../db');
const { assertEstimateSnapshotIntegrity } = require('../core/evidence/estimate.snapshot');

function memoryStore() {
  global.__lockedEstimates = global.__lockedEstimates || {};
  return global.__lockedEstimates;
}

async function persistLockedEstimate(snapshot) {
  const locked = assertEstimateSnapshotIntegrity(snapshot);

  if (supabase) {
    const { data, error } = await supabase
      .from('estimates')
      .insert({
        total: locked.total,
        details: {
          ...locked.estimate,
          estimateLock: {
            stage: locked.stage,
            schemaVersion: locked.schemaVersion,
            fingerprint: locked.fingerprint,
            verifiedCaseFingerprint: locked.verifiedCaseFingerprint,
            repairResolutionFingerprint: locked.repairResolutionFingerprint
          }
        }
      })
      .select('id')
      .single();

    if (error) throw new Error(`Estimate persistence failed: ${error.message}`);
    memoryStore()[locked.jobId] = locked;
    return {
      storage: 'SUPABASE',
      recordId: data?.id ?? null,
      fingerprint: locked.fingerprint
    };
  }

  memoryStore()[locked.jobId] = locked;
  return {
    storage: 'MEMORY',
    recordId: locked.jobId,
    fingerprint: locked.fingerprint
  };
}

function getLockedEstimate(jobId) {
  return memoryStore()[jobId] || null;
}

module.exports = { persistLockedEstimate, getLockedEstimate };
