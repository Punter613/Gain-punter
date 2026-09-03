const express = require('express');
const router = express.Router();
const { getJob, patchJob, addTest, verifyJob, recordUnverifiedDiagnosis } = require('../services/job.lifecycle');
const {
  hasNewEvidenceSinceDiagnosis,
  needsDtcProvenanceReassessment,
  reassessmentReason,
  reassessDiagnosis,
  jobDtcEvidence,
  trustedJobDtcs
} = require('../services/diagnostic.reassessment');
const { publicDtcEvidence, summarizeDtcProvenance } = require('../core/evidence/dtc.provenance');
const { buildVerifiedCase } = require('../core/evidence/verified.case');
const {
  buildRepairCompletedEvent,
  buildOutcomeEvent,
  buildConfirmedRepairCase,
  deriveActiveOutcomeEvent
} = require('../core/evidence/confirmed.repair.case');
const { recordOutcomeEvent, getJobOutcomeEvents } = require('../services/job.outcome.events');

router.get('/:id', async (req, res) => {
  const job = await getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  return res.json({
    success: true,
    status: job.status,
    job,
    result: job.diagnosis?.result || job.result || null,
    unverifiedDiagnosis: job.unverifiedDiagnosis || null,
    estimate: job.estimate || null,
    invoice: job.invoice || null
  });
});

router.post('/:id/unverified-diagnosis', async (req, res) => {
  try {
    let current = await getJob(req.params.id);
    if (!current) return res.status(404).json({ success: false, error: 'Job not found' });

    const provenanceRefreshRequired = needsDtcProvenanceReassessment(current);
    const newEvidenceAvailable = hasNewEvidenceSinceDiagnosis(current);
    const reason = reassessmentReason(current);

    if (current.diagnosis?.result && (newEvidenceAvailable || provenanceRefreshRequired)) {
      try {
        const reassessed = await reassessDiagnosis(current);
        if (reassessed) {
          const previousDiagnosis = current.diagnosis;
          const revision = Math.max(1, Number(previousDiagnosis.revision) || 1) + 1;
          const migrationRecords = provenanceRefreshRequired ? jobDtcEvidence(current) : null;
          const migratedEvidencePacket = provenanceRefreshRequired
            ? {
                ...(previousDiagnosis.evidencePacket || {}),
                schemaVersion: 2,
                dtcs: trustedJobDtcs(current),
                dtcProvenance: summarizeDtcProvenance(migrationRecords)
              }
            : previousDiagnosis.evidencePacket;

          current = await patchJob(req.params.id, {
            ...(provenanceRefreshRequired ? {
              intake: {
                ...(current.intake || {}),
                dtcEvidence: publicDtcEvidence(migrationRecords),
                obdCodes: trustedJobDtcs(current)
              }
            } : {}),
            diagnosisHistory: [...(current.diagnosisHistory || []), previousDiagnosis],
            diagnosis: {
              ...previousDiagnosis,
              evidencePacket: migratedEvidencePacket,
              result: reassessed,
              revision,
              reassessmentReason: reason || reassessed.reassessment?.reason || 'REASSESSMENT',
              recordedAt: new Date().toISOString()
            }
          });
        }
      } catch (reassessmentError) {
        if (provenanceRefreshRequired) {
          console.warn(`[jobs] required DTC provenance reassessment failed for ${req.params.id}:`, reassessmentError.message);
          throw new Error('This diagnosis predates DTC provenance enforcement and could not be safely refreshed. Re-run Diagnose before relying on an unverified diagnosis.');
        }
        console.warn(`[jobs] diagnostic reassessment failed for ${req.params.id}; retaining prior diagnosis:`, reassessmentError.message);
      }
    }

    // Never surface a stale pre-provenance candidate if the mandatory refresh
    // failed to replace and persist its DTC boundary.
    if (needsDtcProvenanceReassessment(current)) {
      throw new Error('This diagnosis predates DTC provenance enforcement. Re-run Diagnose before relying on an unverified diagnosis.');
    }

    const job = await recordUnverifiedDiagnosis(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    return res.json({
      success: true,
      jobId: job.jobId,
      status: job.status,
      diagnosisState: job.unverifiedDiagnosis?.state || 'UNVERIFIED_DIAGNOSIS',
      diagnosisRevision: Number(job.diagnosis?.revision) || 1,
      reassessmentApplied: job.diagnosis?.result?.reassessment?.applied === true,
      reassessmentReason: job.diagnosis?.result?.reassessment?.reason || job.diagnosis?.reassessmentReason || null,
      unverifiedDiagnosis: job.unverifiedDiagnosis,
      verifiedCase: job.verifiedCase || null,
      estimateReady: false
    });
  } catch (err) {
    return res.status(409).json({
      success: false,
      error: err.message,
      jobId: req.params.id,
      status: 'TESTING',
      estimateReady: false
    });
  }
});

router.post('/:id/tests', async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    const test = await addTest(req.params.id, req.body || {});
    return res.status(201).json({ success: true, jobId: req.params.id, status: 'TESTING', test });
  } catch (err) {
    return res.status(409).json({ success: false, error: err.message, jobId: req.params.id });
  }
});

router.post('/:id/verify', async (req, res) => {
  try {
    let job = await verifyJob(req.params.id, req.body || {});
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    if (job.status === 'VERIFIED') {
      const verifiedCase = buildVerifiedCase(job);
      job = await patchJob(job.jobId, { verifiedCase });
    }

    return res.json({
      success: true,
      jobId: job.jobId,
      invoiceNumber: job.invoiceNumber,
      status: job.status,
      verification: job.verification,
      verifiedCase: job.verifiedCase || null,
      estimateReady: job.status === 'VERIFIED'
    });
  } catch (err) {
    return res.status(409).json({ success: false, error: err.message, jobId: req.params.id });
  }
});

// completedBy/recordedBy below are self-reported request-body values, not
// authenticated server identity - there is no auth middleware wired into
// this API yet (see AGENTS.md landmines). They're recorded honestly as
// claimed provenance, not treated or labeled as verified identity. Wire
// this to real auth context once it exists instead of trusting the body.

router.post('/:id/repair-completed', async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    const { operationIds, completedBy, notes } = req.body || {};
    const event = buildRepairCompletedEvent({ job, operationIds, completedBy, notes });
    await recordOutcomeEvent(event);
    const updated = await getJob(req.params.id);

    return res.status(201).json({
      success: true,
      jobId: req.params.id,
      status: updated?.status || 'REPAIR_COMPLETED',
      event
    });
  } catch (err) {
    return res.status(409).json({ success: false, error: err.message, jobId: req.params.id });
  }
});

router.post('/:id/outcome', async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    const events = await getJobOutcomeEvents(req.params.id);
    const completionEvent = events.filter(e => e.eventType === 'REPAIR_COMPLETED').slice(-1)[0];
    if (!completionEvent) {
      return res.status(409).json({ success: false, error: 'No REPAIR_COMPLETED event recorded for this job yet', jobId: req.params.id });
    }

    const { result, symptomResolved, remainingSymptoms, notes, evidenceRefs, recordedBy, supersedesEventFingerprint } = req.body || {};
    const event = buildOutcomeEvent({
      job,
      completionEvent,
      outcome: { result, symptomResolved, remainingSymptoms, notes, evidenceRefs },
      recordedBy,
      supersedesEventFingerprint
    });
    await recordOutcomeEvent(event);
    const updated = await getJob(req.params.id);

    let learningIngested = false;
    let learningError = null;
    try {
      const allEvents = await getJobOutcomeEvents(req.params.id);
      const activeOutcome = deriveActiveOutcomeEvent(allEvents);
      if (activeOutcome && activeOutcome.fingerprint === event.fingerprint) {
        const confirmedRepairCase = buildConfirmedRepairCase(job, allEvents);
        const { feedbackLoop } = require('../core/learning');
        await feedbackLoop.recordConfirmedOutcome({
          confirmedRepairCase,
          aiRecommendation: job.diagnosis?.result || null,
          vehicle: job.vehicle,
          mechanicId: recordedBy || null
        });
        learningIngested = true;
      }
    } catch (learningErr) {
      learningError = learningErr.message;
      console.warn(`[jobs] outcome recorded for ${req.params.id} but learning-corpus ingestion failed:`, learningErr.message);
    }

    return res.status(201).json({
      success: true,
      jobId: req.params.id,
      status: updated?.status || 'OUTCOME_CONFIRMED',
      event,
      learningIngested,
      ...(learningError ? { learningError } : {})
    });
  } catch (err) {
    return res.status(409).json({ success: false, error: err.message, jobId: req.params.id });
  }
});

router.get('/:id/outcome-events', async (req, res) => {
  try {
    const events = await getJobOutcomeEvents(req.params.id);
    return res.json({ success: true, jobId: req.params.id, events });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, jobId: req.params.id });
  }
});

module.exports = router;
