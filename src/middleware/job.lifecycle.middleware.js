const {
  createJob,
  getJob,
  patchJob,
  recordDiagnosis,
  recordDiagnosisFailure,
  attachEstimate,
  attachInvoice,
  hydrateEstimateInput,
  hydrateInvoiceInput
} = require('../services/job.lifecycle');
const { buildDiagnosticEvidencePacket } = require('../core/evidence/diagnostic.evidence.packet');

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

function packetFromDiagnosisRequest(req, payload) {
  const body = req.body || {};
  const evidence = payload?.result?.evidence || {};
  const vehicle = body.vehicle || {};
  return buildDiagnosticEvidencePacket({
    vin: body.vin || vehicle.vin || '',
    mileage: body.mileage || vehicle.mileage,
    vehicle,
    customerObservations: [
      ...(Array.isArray(body.symptoms) ? body.symptoms : []),
      ...(Array.isArray(body.customerStates) ? body.customerStates : [])
    ],
    mechanicObservations: [
      ...(Array.isArray(body.mechanicNotices) ? body.mechanicNotices : []),
      ...(Array.isArray(body.notes) ? body.notes : [])
    ],
    dtcs: Array.isArray(body.codes) && body.codes.length ? body.codes : (body.obdCodes || []),
    deterministicProfile: payload?.result?.localVehicleTelemetry || null,
    localSafetyTriggered: payload?.result?.safetyRisk === true,
    safetyNotes: payload?.result?.notes || '',
    matchedPatterns: payload?.result?.injectedFieldProtocols || [],
    oemReferences: evidence.oem || [],
    tsbReferences: evidence.tsbs || [],
    sources: evidence.sources || [],
    evidenceAvailable: evidence.available === true,
    warmupStatus: evidence.warmup || null
  });
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
        const persisted = await getJob(job.jobId);
        const evidencePacket = packetFromDiagnosisRequest(req, payload);
        await patchJob(job.jobId, {
          diagnosis: { ...(persisted?.diagnosis || {}), evidencePacket }
        });
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
  if (!jobId) return next();

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
  if (!jobId) return next();

  try {
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found', jobId });
    if (job.status !== 'ESTIMATED' || !job.estimate) {
      return res.status(409).json({ success: false, error: 'Canonical estimate must exist before invoice generation', jobId, status: job.status });
    }

    req.body = hydrateInvoiceInput(job, req.body || {});
    wrapJson(res, async payload => {
      if (payload?.success === false) return { ...payload, jobId };
      const invoice = await attachInvoice(jobId, payload || {});
      return invoice;
    });
    next();
  } catch (err) {
    return res.status(409).json({
      success: false,
      error: 'Canonical estimate is invalid for invoice generation.',
      code: 'ESTIMATE_SNAPSHOT_REQUIRED_OR_INVALID',
      jobId
    });
  }
}

module.exports = { diagnosisLifecycle, estimateLifecycle, invoiceLifecycle, packetFromDiagnosisRequest };
