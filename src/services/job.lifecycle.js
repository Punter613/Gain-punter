const crypto = require('crypto');
const { supabase } = require('../db');
const {
  buildVerifiedEstimateSnapshot,
  assertVerifiedEstimateSnapshot
} = require('../core/evidence/verified.estimate.snapshot');

const VALID_STATES = new Set([
  'DIAGNOSING', 'TESTING', 'VERIFIED', 'ESTIMATED', 'INVOICED', 'DIAG_FAILED',
  'REPAIR_COMPLETED', 'OUTCOME_CONFIRMED'
]);

function nowIso() {
  return new Date().toISOString();
}

function makeJobId() {
  const now = new Date();
  const date = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SKSK-${date}-${suffix}`;
}

function normalizeCustomer(input = {}) {
  const customer = input.customer || input.customerInfo || {};
  return {
    name: customer.name || input.customerName || '',
    phone: customer.phone || input.phone || '',
    email: customer.email || input.email || ''
  };
}

function normalizeVehicle(input = {}) {
  const vehicle = input.vehicle || input.vehicleInfo || {};
  return {
    year: vehicle.year || input.year || '',
    make: vehicle.make || input.make || '',
    model: vehicle.model || input.model || '',
    trim: vehicle.trim || input.trim || '',
    engine: vehicle.engine || input.engine || '',
    vin: input.vin || vehicle.vin || '',
    mileage: input.mileage || vehicle.mileage || 0
  };
}

function memoryStore() {
  global.__jobs = global.__jobs || {};
  return global.__jobs;
}

async function persist(job) {
  memoryStore()[job.jobId] = job;
  if (!supabase) return job;

  const row = {
    job_id: job.jobId,
    status: job.status,
    customer_name: job.customer.name || null,
    customer_phone: job.customer.phone || null,
    customer_email: job.customer.email || null,
    vehicle_year: Number(job.vehicle.year) || null,
    vehicle_make: job.vehicle.make || null,
    vehicle_model: job.vehicle.model || null,
    vehicle_vin: job.vehicle.vin || null,
    mileage: Number(job.vehicle.mileage) || null,
    payload: job,
    updated_at: nowIso()
  };

  try {
    const { error } = await supabase.from('service_jobs').upsert(row, { onConflict: 'job_id' });
    if (error) console.warn('[JobLifecycle] Supabase persist failed, memory copy retained:', error.message);
  } catch (err) {
    console.warn('[JobLifecycle] Supabase persist threw, memory copy retained:', err.message);
  }
  return job;
}

async function getJob(jobId) {
  if (!jobId) return null;
  const memory = memoryStore()[jobId];
  if (memory) return memory;
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('service_jobs')
      .select('payload')
      .eq('job_id', jobId)
      .maybeSingle();
    if (error || !data?.payload) return null;
    memoryStore()[jobId] = data.payload;
    return data.payload;
  } catch {
    return null;
  }
}

async function createJob(input = {}) {
  const jobId = input.jobId || makeJobId();
  const createdAt = nowIso();
  const job = {
    jobId,
    invoiceNumber: jobId,
    status: 'DIAGNOSING',
    createdAt,
    updatedAt: createdAt,
    customer: normalizeCustomer(input),
    vehicle: normalizeVehicle(input),
    intake: {
      customerStates: input.customerStates || input.symptoms || [],
      mechanicNotices: input.mechanicNotices || input.notes || [],
      obdCodes: input.obdCodes || input.codes || []
    },
    diagnosis: null,
    tests: [],
    verification: null,
    estimate: null,
    invoice: null
  };
  return persist(job);
}

async function patchJob(jobId, patch = {}) {
  const job = await getJob(jobId);
  if (!job) return null;
  const nextStatus = patch.status || job.status;
  if (!VALID_STATES.has(nextStatus)) throw new Error(`Invalid job status: ${nextStatus}`);
  const updated = { ...job, ...patch, status: nextStatus, updatedAt: nowIso() };
  return persist(updated);
}

async function recordDiagnosis(jobId, diagnosis, traceLog = null) {
  return patchJob(jobId, {
    status: 'TESTING',
    diagnosis: { result: diagnosis, traceLog, recordedAt: nowIso() }
  });
}

async function recordDiagnosisFailure(jobId, error) {
  return patchJob(jobId, {
    status: 'DIAG_FAILED',
    diagnosis: { error: String(error || 'Diagnosis failed'), recordedAt: nowIso() }
  });
}

async function addTest(jobId, test = {}) {
  const job = await getJob(jobId);
  if (!job) return null;
  if (!['TESTING', 'DIAGNOSING'].includes(job.status)) {
    throw new Error(`Tests cannot be added while job is ${job.status}`);
  }
  const entry = {
    id: test.id || crypto.randomUUID(),
    name: test.name || test.test || '',
    result: test.result ?? '',
    units: test.units || '',
    notes: test.notes || '',
    passed: typeof test.passed === 'boolean' ? test.passed : null,
    recordedAt: nowIso()
  };
  job.tests = [...(job.tests || []), entry];
  job.status = 'TESTING';
  job.updatedAt = nowIso();
  await persist(job);
  return entry;
}

async function verifyJob(jobId, verification = {}) {
  const job = await getJob(jobId);
  if (!job) return null;
  if (!job.diagnosis?.result) throw new Error('Diagnosis must exist before verification');
  if (!Array.isArray(job.tests) || job.tests.length === 0) throw new Error('At least one recorded test is required before verification');

  const confirmed = verification.confirmed === true;
  if (!confirmed) {
    job.verification = {
      confirmed: false,
      conclusion: verification.conclusion || '',
      confirmedCause: verification.confirmedCause || '',
      notes: verification.notes || '',
      verifiedAt: nowIso()
    };
    job.status = 'TESTING';
    job.updatedAt = nowIso();
    await persist(job);
    return job;
  }

  job.verification = {
    confirmed: true,
    conclusion: verification.conclusion || '',
    confirmedCause: verification.confirmedCause || job.diagnosis.result.primaryCause || '',
    notes: verification.notes || '',
    verifiedAt: nowIso()
  };
  job.status = 'VERIFIED';
  job.updatedAt = nowIso();
  await persist(job);
  return job;
}

async function attachEstimate(jobId, estimate) {
  const job = await getJob(jobId);
  if (!job) return null;
  if (job.status !== 'VERIFIED') throw new Error('Estimate requires a VERIFIED diagnosis');
  job.estimate = buildVerifiedEstimateSnapshot(job, estimate);
  job.status = 'ESTIMATED';
  job.updatedAt = nowIso();
  await persist(job);
  return job.estimate;
}

async function attachInvoice(jobId, invoice) {
  const job = await getJob(jobId);
  if (!job) return null;
  if (!job.estimate) throw new Error('Invoice requires an estimate');
  assertVerifiedEstimateSnapshot(job.estimate, job);
  job.invoice = { ...invoice, invoiceNumber: jobId, jobId, estimateFingerprint: job.estimate.fingerprint, createdAt: nowIso() };
  job.status = 'INVOICED';
  job.updatedAt = nowIso();
  await persist(job);
  return job.invoice;
}

function hydrateEstimateInput(job, incoming = {}) {
  return {
    ...incoming,
    jobId: job.jobId,
    customer: { ...job.customer, ...(incoming.customer || {}) },
    vehicle: { ...job.vehicle, ...(incoming.vehicle || {}) },
    vin: incoming.vin || job.vehicle.vin || '',
    mileage: incoming.mileage || job.vehicle.mileage || 0,
    customerStates: incoming.customerStates?.length ? incoming.customerStates : job.intake.customerStates,
    mechanicNotices: incoming.mechanicNotices?.length ? incoming.mechanicNotices : job.intake.mechanicNotices,
    obdCodes: incoming.obdCodes?.length ? incoming.obdCodes : job.intake.obdCodes,
    diagnosticTests: incoming.diagnosticTests?.length
      ? incoming.diagnosticTests
      : (job.tests || []).map(t => `${t.name}: ${t.result}${t.units ? ` ${t.units}` : ''}${t.notes ? ` — ${t.notes}` : ''}`),
    verifiedDiagnosis: job.verification
  };
}

function hydrateInvoiceInput(job, incoming = {}) {
  const estimate = assertVerifiedEstimateSnapshot(job.estimate, job);
  return {
    jobId: job.jobId,
    estimate,
    customerInfo: clonePlain(job.customer),
    vehicleInfo: clonePlain(job.vehicle),
    notes: typeof incoming.notes === 'string' ? incoming.notes : ''
  };
}

function clonePlain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

module.exports = {
  makeJobId,
  createJob,
  getJob,
  patchJob,
  recordDiagnosis,
  recordDiagnosisFailure,
  addTest,
  verifyJob,
  attachEstimate,
  attachInvoice,
  hydrateEstimateInput,
  hydrateInvoiceInput
};
