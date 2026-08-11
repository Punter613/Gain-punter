const express = require('express');
const router = express.Router();
const { getJob, addTest, verifyJob } = require('../services/job.lifecycle');

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
    const job = await verifyJob(req.params.id, req.body || {});
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    return res.json({
      success: true,
      jobId: job.jobId,
      invoiceNumber: job.invoiceNumber,
      status: job.status,
      verification: job.verification,
      estimateReady: job.status === 'VERIFIED'
    });
  } catch (err) {
    return res.status(409).json({ success: false, error: err.message, jobId: req.params.id });
  }
});

module.exports = router;
