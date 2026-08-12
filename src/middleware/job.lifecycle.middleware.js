const {
  createJob,
  getJob,
  recordDiagnosis,
  recordDiagnosisFailure,
  attachEstimate,
  attachInvoice,
  hydrateEstimateInput,
  hydrateInvoiceInput
} = require('../services/job.lifecycle');

function wrapJson(res, handler) {
  const originalJson = res.json.bind(res);
  res.json = async payload => {
    try {
      const next = await handler(payload);
      return originalJson(next === undefined ? payload : next);
    } catch (err) {
      console.warn('[JobLifecycle] response bridge failed (non-fatal):', err.message);
      return originalJson(payload);
    }
  };
}

async function diagnosisLifecycle(req, res, next) {
  if (req.method !== 'POST' || req.path !== '/') return next();

  try {
    const job = await createJob(req.body || {});
    req.jobLifecycle = job;
    req.body = { ...(req.body || {}), jobId: job.jobId };

    wrapJson(res, async payload => {
      if (payload?.success && payload?.result) {
        await recordDiagnosis(job.jobId, payload.result, payload.traceLog || null);
        return { ...payload, jobId: job.jobId, invoiceNumber: job.jobId };
      }
      await recordDiagnosisFailure(job.jobId, payload?.details || payload?.error || 'Diagnosis failed');
      return { ...payload, jobId: job.jobId, invoiceNumber: job.jobId };
    });
    next();
  } catch (err) {
    next(err);
  }
}

async function estimateLifecycle(req, res, next) {
  if (req.method !== 'POST' || req.path !== '/') return next();
  const jobId = req.body?.jobId;
  if (!jobId) return next(); // preserve standalone legacy estimate behavior

  try {
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found', jobId });
    if (job.status !== 'VERIFIED') {
      return res.status(409).json({
        success: false,
        error: 'Diagnosis must be verified before estimate generation',
        jobId,
        status: job.status
      });
    }

    req.body = hydrateEstimateInput(job, req.body || {});
    wrapJson(res, async payload => {
      if (payload?.success && payload?.estimate) {
        const estimate = await attachEstimate(jobId, payload.estimate);
        return { ...payload, jobId, estimate };
      }
      return { ...payload, jobId };
    });
    next();
  } catch (err) {
    next(err);
  }
}

async function invoiceLifecycle(req, res, next) {
  if (req.method !== 'POST' || req.path !== '/build') return next();
  const jobId = req.body?.jobId;
  if (!jobId) return next(); // preserve standalone legacy invoice behavior

  try {
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found', jobId });
    if (!job.estimate) {
      return res.status(409).json({ success: false, error: 'Estimate must exist before invoice generation', jobId, status: job.status });
    }

    req.body = hydrateInvoiceInput(job, req.body || {});
    wrapJson(res, async payload => {
      const invoice = await attachInvoice(jobId, payload || {});
      return invoice;
    });
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { diagnosisLifecycle, estimateLifecycle, invoiceLifecycle };
