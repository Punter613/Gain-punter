const express = require('express');
const router = express.Router();
const jobsRouter = require('./jobs');
const { getJob } = require('../services/job.lifecycle');

const PLACEHOLDER_RESULTS = new Set([
  '?', '??', '???', 'unknown', 'tbd', 'pending', 'n/a', 'na', 'not sure', 'not tested', 'not performed'
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isMeaningfulTestResult(value) {
  const result = clean(value);
  if (!result || !/[a-z0-9]/i.test(result)) return false;
  return !PLACEHOLDER_RESULTS.has(result.toLowerCase());
}

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
// and bind that conclusion to persisted test evidence selected by the mechanic.
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
        error: 'Verification requires at least one explicitly selected supporting test.',
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

    req.body.evidenceTestIds = evidenceTestIds;
    return next();
  } catch (err) {
    return res.status(409).json({ success: false, error: err.message, jobId: req.params.id, status: 'TESTING' });
  }
});

router.use(jobsRouter);

module.exports = router;
module.exports.isMeaningfulTestResult = isMeaningfulTestResult;
