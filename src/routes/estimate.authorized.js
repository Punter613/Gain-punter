const express = require('express');
const router = express.Router();
const estimateRouter = require('./estimate');
const { getJob } = require('../services/job.lifecycle');
const { authorizeJobRepair } = require('../middleware/repair.authorization.middleware');
const { evaluateRepairAuthorization } = require('../core/orchestrator/repair.authorization.guard');

router.post('/', async (req, res, next) => {
  try {
    let result;

    if (req.body?.jobId) {
      const job = await getJob(req.body.jobId);
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found', jobId: req.body.jobId });
      }
      result = authorizeJobRepair(job);
    } else {
      result = evaluateRepairAuthorization(req.body || {});
    }

    if (!result.authorized) {
      return res.status(409).json({
        success: false,
        error: 'Verification is required before estimate generation.',
        status: result.status,
        authorization: result
      });
    }

    req.repairAuthorization = result;
    req.body = {
      ...(req.body || {}),
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
