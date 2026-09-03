'use strict';

const express = require('express');
const router = express.Router();
const {
  persistEvidenceBatch,
  atomicUnverifiedDiagnosis
} = require('../services/atomic.evidence.reassessment');

function errorPayload(error, jobId) {
  return {
    success: false,
    error: error.message,
    code: error.code || 'ATOMIC_EVIDENCE_REASSESSMENT_FAILED',
    jobId,
    status: 'TESTING',
    estimateReady: false,
    evidenceSaved: error.evidenceSaved === true,
    evidenceSavedCount: Number(error.evidenceSavedCount || 0),
    evidenceReusedCount: Number(error.evidenceReusedCount || 0),
    savedEvidence: Array.isArray(error.savedEvidence) ? error.savedEvidence : [],
    reusedEvidence: Array.isArray(error.reusedEvidence) ? error.reusedEvidence : [],
    diagnosisStale: error.diagnosisStale === true,
    reassessmentReason: error.reassessmentReason || null
  };
}

router.post('/:id/tests/batch', async (req, res) => {
  try {
    const result = await persistEvidenceBatch(req.params.id, req.body?.evidence || req.body?.tests || []);
    return res.status(result.saved.length ? 201 : 200).json({
      success: true,
      jobId: req.params.id,
      status: 'TESTING',
      evidenceSavedCount: result.saved.length,
      evidenceReusedCount: result.reused.length,
      tests: result.saved,
      reusedTests: result.reused,
      diagnosisStale: result.saved.length > 0
    });
  } catch (error) {
    return res.status(error.statusCode || 409).json(errorPayload(error, req.params.id));
  }
});

// This route intentionally shadows the legacy jobs.js unverified-diagnosis route.
// It accepts optional unsaved evidence, persists the whole batch first, marks the
// prior candidate stale, reassesses from the persisted case, and only then emits
// a fresh UNVERIFIED_DIAGNOSIS. If reassessment fails after persistence, the
// response fails closed and explicitly reports that the prior diagnosis is stale.
router.post('/:id/unverified-diagnosis', async (req, res) => {
  try {
    const result = await atomicUnverifiedDiagnosis(req.params.id, req.body?.evidence || []);
    const job = result.job;
    return res.json({
      success: true,
      jobId: job.jobId,
      status: job.status,
      diagnosisState: job.unverifiedDiagnosis?.state || 'UNVERIFIED_DIAGNOSIS',
      diagnosisRevision: Number(job.diagnosis?.revision) || 1,
      reassessmentApplied: result.reassessmentApplied,
      reassessmentReason: result.reassessmentReason,
      unverifiedDiagnosis: job.unverifiedDiagnosis,
      verifiedCase: job.verifiedCase || null,
      estimateReady: false,
      evidenceSavedCount: result.evidenceSavedCount,
      evidenceReusedCount: result.evidenceReusedCount,
      savedEvidence: result.savedEvidence,
      reusedEvidence: result.reusedEvidence,
      diagnosisStale: false
    });
  } catch (error) {
    return res.status(error.statusCode || 409).json(errorPayload(error, req.params.id));
  }
});

module.exports = router;
