const express = require('express');
const router = express.Router();
const { getJob, patchJob, addTest, verifyJob } = require('../services/job.lifecycle');
const { buildVerifiedCase } = require('../core/evidence/verified.case');
const {
  buildRepairCompletedEvent,
  buildOutcomeEvent,
  buildConfirmedRepairCase
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
    estimate: job.estimate || null,
    invoice: job.invoice || null
  });
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
    const updated = await getJob(req.params.id) || { ...job, status: 'OUTCOME_CONFIRMED' };

    // Outcome truth is already durable at this point. Learning persistence is
    // deliberately downstream: a feedback-store outage must not make callers
    // retry and create a second outcome event. The response reports whether the
    // derived trusted example landed so it can be backfilled operationally.
    let confirmedRepairCase = null;
    let trustedLearningRecorded = false;
    let trustedLearningExampleId = null;
    try {
      const updatedEvents = await getJobOutcomeEvents(req.params.id);
      confirmedRepairCase = buildConfirmedRepairCase(updated, updatedEvents);
      const { feedbackLoop } = require('../core/learning');
      const learningExample = await feedbackLoop.recordConfirmedOutcome({
        confirmedRepairCase,
        aiRecommendation: updated.diagnosis?.result || null,
        vehicle: updated.vehicle || null,
        mechanicId: recordedBy || null
      });
      trustedLearningRecorded = true;
      trustedLearningExampleId = learningExample?.id || null;
    } catch (learningError) {
      console.warn('[JobOutcome] confirmed outcome persisted, trusted learning derivation/write failed:', learningError.message);
    }

    return res.status(201).json({
      success: true,
      jobId: req.params.id,
      status: updated?.status || 'OUTCOME_CONFIRMED',
      event,
      confirmedRepairCase,
      trustedLearningRecorded,
      trustedLearningExampleId
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
