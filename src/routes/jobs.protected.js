const express = require('express');
const router = express.Router();
const jobsRouter = require('./jobs');
const customerEstimateCenter = require('./customer.estimate.center');
const atomicEvidenceReassessment = require('./atomic.evidence.reassessment');
const workOrderRouter = require('./work.order');
const finalWorkInvoiceRouter = require('./final.work.invoice');
const {
  getJob,
  isMeaningfulTestResult,
  isVerificationEligibleTest,
  testConfirmsFault
} = require('../services/job.lifecycle');

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// Commercial estimate documents live under the persisted lifecycle number but
// remain separate from diagnostic verification truth. A QUICK_ESTIMATE never
// creates VERIFIED_CASE and never unlocks the verified Estimate -> Invoice lane.
router.use('/estimate-center', customerEstimateCenter);

// Work Orders are lifecycle documents created only from customer-authorized
// estimate lines. The route is separate from diagnostic verification truth:
// authorization approves scope, but never proves that a repair is required.
router.use('/:id/work-orders', workOrderRouter);

// Final invoice truth is built only from Work Order lines that are both
// AUTHORIZED and COMPLETED. Deferred, declined, cancelled, blocked, ready, and
// in-progress scope cannot become billable invoice lines.
router.use(finalWorkInvoiceRouter);

// Atomic evidence/reassessment routes intentionally mount before the legacy
// jobs router. They preserve the old endpoint shape while making the mobile
// flow save -> stale -> reassess -> present a single serialized mutation.
router.use(atomicEvidenceReassessment);

// Protective boundary in front of the existing jobs router.
// A recorded confirmation test must contain an actual mechanic observation or measurement.
router.post('/:id/tests', (req, res, next) => {
  const body = req.body || {};
  const name = clean(body.name || body.test);
  const result = clean(body.result);

  if (!name) {
    return res.status(409).json({
      success: false,
      error: 'Recorded test requires a test name.',
      jobId: req.params.id,
      status: 'TESTING'
    });
  }

  if (!isMeaningfulTestResult(result)) {
    return res.status(409).json({
      success: false,
      error: 'Recorded test requires an actual observation or measurement; placeholders do not count as evidence.',
      jobId: req.params.id,
      status: 'TESTING'
    });
  }

  return next();
});

// A positive VERIFY action must name the bounded fault explicitly, explain why,
// and bind that conclusion to persisted confirmation-grade test evidence selected
// by the mechanic. Neutral/supporting/refuting observations can change the
// diagnostic ranking but can never unlock Estimate by themselves.
router.post('/:id/verify', async (req, res, next) => {
  try {
    const body = req.body || {};
    const confirmedCause = clean(body.confirmedCause);

    if (body.confirmed !== true) return next();

    if (!confirmedCause) {
      return res.status(409).json({
        success: false,
        error: 'Verification requires an explicit confirmed cause/fault.',
        jobId: req.params.id,
        status: 'TESTING'
      });
    }

    const conclusion = clean(body.conclusion || body.notes);
    if (!conclusion) {
      return res.status(409).json({
        success: false,
        error: 'Verification requires a mechanic conclusion explaining why the selected test evidence confirms the fault.',
        jobId: req.params.id,
        status: 'TESTING'
      });
    }

    const evidenceTestIds = [...new Set(
      (Array.isArray(body.evidenceTestIds) ? body.evidenceTestIds : [])
        .map(clean)
        .filter(Boolean)
    )];
    if (!evidenceTestIds.length) {
      return res.status(409).json({
        success: false,
        error: 'Verification requires at least one explicitly selected confirmation-grade test.',
        jobId: req.params.id,
        status: 'TESTING'
      });
    }

    const job = await getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found', jobId: req.params.id });
    }

    const testsById = new Map((job.tests || []).map(test => [clean(test.id), test]));
    const selectedTests = evidenceTestIds.map(id => testsById.get(id));
    if (selectedTests.some(test => !test)) {
      return res.status(409).json({
        success: false,
        error: 'Verification evidence must reference tests persisted on this job.',
        jobId: req.params.id,
        status: 'TESTING'
      });
    }

    if (selectedTests.some(test => !isMeaningfulTestResult(test.result))) {
      return res.status(409).json({
        success: false,
        error: 'Selected verification evidence contains a placeholder or empty result.',
        jobId: req.params.id,
        status: 'TESTING'
      });
    }

    if (selectedTests.some(test => !isVerificationEligibleTest(test))) {
      return res.status(409).json({
        success: false,
        error: 'Selected verification evidence must be explicitly classified CONFIRMS and bind the physical result to a named fault.',
        jobId: req.params.id,
        status: 'TESTING'
      });
    }

    if (selectedTests.some(test => !testConfirmsFault(test, confirmedCause))) {
      return res.status(409).json({
        success: false,
        error: 'Confirmed Cause / Fault must exactly match the fault named by every selected CONFIRMS test.',
        jobId: req.params.id,
        status: 'TESTING'
      });
    }

    req.body.evidenceTestIds = evidenceTestIds;
    return next();
  } catch (err) {
    return res.status(409).json({ success: false, error: err.message, jobId: req.params.id, status: 'TESTING' });
  }
});

router.use(jobsRouter);

module.exports = router;
module.exports.isMeaningfulTestResult = isMeaningfulTestResult;
module.exports.isVerificationEligibleTest = isVerificationEligibleTest;
