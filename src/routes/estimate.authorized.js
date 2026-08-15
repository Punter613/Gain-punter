const express = require('express');
const router = express.Router();
const estimateRouter = require('./estimate');
const { getJob } = require('../services/job.lifecycle');
const { authorizeJobRepair } = require('../middleware/repair.authorization.middleware');
const { verifiedEstimateInput } = require('../core/evidence/verified.case');

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

    const canonical = verifiedEstimateInput(job.verifiedCase);
    const packet = canonical.verifiedCase.evidencePacket || {};
    const vehicle = packet.vehicle || canonical.verifiedCase.vehicle || job.vehicle || {};
    req.repairAuthorization = result;
    req.body = {
      ...(req.body || {}),
      jobId,
      ...canonical,
      vehicle,
      vin: vehicle.vin || '',
      mileage: vehicle.mileage,
      customerStates: packet.observations?.customer || [],
      mechanicNotices: packet.observations?.mechanic || [],
      obdCodes: packet.dtcs || [],
      diagnosticTests: canonical.diagnosticTests,
      verifiedDiagnosis: canonical.verifiedCase.verification
    };
    return next();
  } catch (err) {
    return res.status(409).json({ success: false, error: err.message || 'Estimate authorization failed' });
  }
});

router.use(estimateRouter);

module.exports = router;
