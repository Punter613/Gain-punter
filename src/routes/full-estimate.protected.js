const express = require('express');
const router = express.Router();
const fullEstimateRouter = require('./full-estimate');
const { getJob } = require('../services/job.lifecycle');
const { authorizeJobRepair } = require('../middleware/repair.authorization.middleware');
const { evaluateRepairAuthorization } = require('../core/orchestrator/repair.authorization.guard');

router.post('/', async (req, res, next) => {
  try {
    let authorization;

    if (req.body?.jobId) {
      const job = await getJob(req.body.jobId);
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found', jobId: req.body.jobId });
      }
      authorization = authorizeJobRepair(job);
    } else {
      authorization = evaluateRepairAuthorization(req.body || {});
    }

    if (!authorization.authorized) {
      return res.status(409).json({
        success: false,
        error: 'Verified diagnosis required before estimate generation',
        status: authorization.status,
        authorization
      });
    }

    req.repairAuthorization = authorization;
    req.body = {
      ...(req.body || {}),
      verifiedFaults: authorization.repairScope,
      diagnosisVerified: true,
      verificationStatus: 'VERIFIED'
    };
    return next();
  } catch (err) {
    return res.status(409).json({ success: false, error: err.message || 'Estimate authorization failed' });
  }
});

router.use(fullEstimateRouter);

module.exports = router;
