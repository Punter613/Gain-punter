const express = require('express');
const router = express.Router();
const estimateRouter = require('./estimate');
const { getJob } = require('../services/job.lifecycle');
const { authorizeJobRepair } = require('../middleware/repair.authorization.middleware');

router.post('/', async (req, res, next) => {
  try {
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) {
      return res.status(409).json({
        success: false,
        error: 'A persisted diagnostic job must be verified before estimate generation.',
        status: 'DIAGNOSIS_REQUIRED'
      });
    }

    const job = await getJob(jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found', jobId });
    }

    const result = authorizeJobRepair(job);
    if (!result.authorized) {
      return res.status(409).json({
        success: false,
        error: 'Verification is required before estimate generation.',
        status: result.status,
        jobId,
        authorization: result
      });
    }

    req.repairAuthorization = result;
    req.body = {
      ...(req.body || {}),
      jobId,
      diagnosisVerified: true,
      verificationStatus: 'VERIFIED',
      verifiedFaults: result.repairScope
    };
    return next();
  } catch (err) {
    return res.status(409).json({ success: false, error: err.message || 'Estimate authorization failed' });
  }
});

router.use(estimateRouter);

module.exports = router;
