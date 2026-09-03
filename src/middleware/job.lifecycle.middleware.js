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
const {
  resolveRequestDtcEvidence,
  trustedDtcCodes,
  publicDtcEvidence
} = require('../core/evidence/dtc.provenance');
const {
  buildVehicleConfigurationBoundary,
  applyComponentApplicabilityGuard
} = require('../core/evidence/component.applicability');
const { resolveVehicleProfile } = require('../services/vehicle.warmup');

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

function diagnosisMechanicObservations(body = {}) {
  return [
    ...(Array.isArray(body.mechanicNotices) ? body.mechanicNotices : []),
    ...(Array.isArray(body.notes) ? body.notes : [])
  ];
}

async function applyDiagnosisConfigurationBoundary(req, payload) {
  if (!payload?.success || !payload?.result) return payload;
  const body = req.body || {};
  const suppliedVehicle = body.vehicle || {};
  const vin = body.vin || suppliedVehicle.vin || '';
  let resolvedVehicle = suppliedVehicle;
  let vinDecoded = false;

  try {
    resolvedVehicle = await resolveVehicleProfile(vin, suppliedVehicle);
    vinDecoded = /^[A-HJ-NPR-Z0-9]{17}$/i.test(String(vin || '').trim());
  } catch (err) {
    console.warn('[JobLifecycle] vehicle configuration resolution failed closed:', err.message);
  }

  const boundary = buildVehicleConfigurationBoundary({
    vin,
    suppliedVehicle,
    resolvedVehicle,
    vinDecoded
  });
  const guarded = applyComponentApplicabilityGuard(payload.result, boundary, {
    mechanicObservations: diagnosisMechanicObservations(body)
  });

  const traceLog = payload.traceLog && typeof payload.traceLog === 'object'
    ? { ...payload.traceLog, logs: Array.isArray(payload.traceLog.logs) ? [...payload.traceLog.logs] : [] }
    : payload.traceLog;
  if (guarded.changed && traceLog?.logs) {
    traceLog.logs.push(`[COMPONENT_APPLICABILITY] Bounded ${guarded.guardedKeys.length} configuration-sensitive component candidate(s); exact fitment must be proven or labeled if equipped.`);
  }

  return { ...payload, result: guarded.output, traceLog };
}

function packetFromDiagnosisRequest(req, payload) {
  const body = req.body || {};
  const evidence = payload?.result?.evidence || {};
  const vehicle = body.vehicle || {};
  const dtcEvidence = resolveRequestDtcEvidence(body);
  const packet = buildDiagnosticEvidencePacket({
    vin: body.vin || vehicle.vin || '',
    mileage: body.mileage || vehicle.mileage,
    vehicle,
    customerObservations: [
      ...(Array.isArray(body.symptoms) ? body.symptoms : []),
      ...(Array.isArray(body.customerStates) ? body.customerStates : [])
    ],
    mechanicObservations: diagnosisMechanicObservations(body),
    dtcEvidence,
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
  return {
    ...packet,
    vehicleConfiguration: payload?.result?.vehicleConfiguration || null
  };
}

async function diagnosisLifecycle(req, res, next) {
  if (req.method !== 'POST' || req.path !== '/') return next();

  try {
    const dtcEvidence = resolveRequestDtcEvidence(req.body || {});
    let job = await createJob(req.body || {});

    // Sanitize provenance immediately, before the Diagnose route runs. This
    // means even a failed diagnosis job cannot leave raw typed/placeholder DTCs
    // sitting in the trusted obdCodes field.
    job = await patchJob(job.jobId, {
      intake: {
        ...(job.intake || {}),
        dtcEvidence: publicDtcEvidence(dtcEvidence),
        obdCodes: trustedDtcCodes(dtcEvidence)
      }
    });

    req.jobLifecycle = job;
    req.body = { ...(req.body || {}), jobId: job.jobId };

    wrapJson(res, async originalPayload => {
      const payload = await applyDiagnosisConfigurationBoundary(req, originalPayload);
      if (payload?.success && payload?.result) {
        await recordDiagnosis(job.jobId, payload.result, payload.traceLog || null);
        const persisted = await getJob(job.jobId);
        const evidencePacket = packetFromDiagnosisRequest(req, payload);
        await patchJob(job.jobId, {
          intake: {
            ...(persisted?.intake || {}),
            dtcEvidence: publicDtcEvidence(dtcEvidence),
            obdCodes: trustedDtcCodes(dtcEvidence)
          },
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

module.exports = {
  diagnosisLifecycle,
  estimateLifecycle,
  invoiceLifecycle,
  packetFromDiagnosisRequest,
  applyDiagnosisConfigurationBoundary
};
