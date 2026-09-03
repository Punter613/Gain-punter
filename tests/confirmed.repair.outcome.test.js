'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { buildDiagnosticEvidencePacket } = require('../src/core/evidence/diagnostic.evidence.packet');
const { buildVerifiedCase } = require('../src/core/evidence/verified.case');
const {
  buildRepairCompletedEvent,
  buildOutcomeEvent,
  buildConfirmedRepairCase,
  deriveActiveOutcomeEvent,
  eligibleForTrustedLearning,
  resolveLineage
} = require('../src/core/evidence/confirmed.repair.case');
const MechanicFeedbackLoop = require('../src/core/learning/mechanic.feedback.loop');

function jobFixture(overrides = {}) {
  const evidencePacket = buildDiagnosticEvidencePacket({
    vin: 'KNDJC735785123456',
    mileage: 150000,
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: '3.8L', drivetrain: '4WD' },
    customerObservations: ['bump on accelerator release'],
    mechanicObservations: ['CV axles replaced'],
    dtcs: ['P0300'],
    evidenceAvailable: true
  });

  const confirmedCause = 'Worn outer CV joint';
  const job = {
    jobId: 'SKSK-OUTCOME-TEST',
    status: 'VERIFIED',
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    diagnosis: {
      result: { primaryCause: confirmedCause, probability: [{ cause: confirmedCause, likelihood: 80 }] },
      evidencePacket,
      revision: 1
    },
    tests: [{
      id: 'T1',
      name: 'Axle rotation test',
      result: 'clicking on turn',
      evidenceRole: 'CONFIRMS',
      confirmedFault: confirmedCause,
      recordedAt: '2026-08-15T00:00:00.000Z'
    }],
    verification: {
      confirmed: true,
      confirmedCause,
      conclusion: 'Clicking isolated to CV joint',
      evidenceTestIds: ['T1'],
      diagnosisRevision: 1,
      notes: '',
      verifiedAt: '2026-08-15T00:01:00.000Z'
    },
    estimate: null,
    invoice: null
  };
  // Build verifiedCase off a genuinely VERIFIED job first (buildVerifiedCase
  // itself requires that), then apply any status override afterward. This
  // matches the real scenario the status-guard tests care about: a job
  // that already has a valid, frozen verifiedCase but whose current status
  // isn't in COMPLETABLE_STATUSES.
  job.verifiedCase = buildVerifiedCase(job);
  Object.assign(job, overrides);
  return job;
}

test('resolveLineage never produces an invoiceFingerprint field', () => {
  const job = jobFixture();
  const lineage = resolveLineage(job);
  assert.equal('invoiceFingerprint' in lineage, false);
  assert.equal(lineage.invoicedEstimateFingerprint, null);
});

test('a job can reach REPAIR_COMPLETED with no estimate or invoice at all', () => {
  const job = jobFixture();
  const event = buildRepairCompletedEvent({ job, completedBy: 'brian' });
  assert.equal(event.eventType, 'REPAIR_COMPLETED');
  assert.equal(event.estimateFingerprint, null);
  assert.equal(event.invoicedEstimateFingerprint, null);
  assert.ok(event.verifiedCaseFingerprint);
  assert.ok(event.performedRepair.operationIds.length > 0);
});

test('repair completion rejects a job that is not VERIFIED/ESTIMATED/INVOICED', () => {
  const job = jobFixture({ status: 'TESTING' });
  assert.throws(() => buildRepairCompletedEvent({ job, completedBy: 'brian' }), /VERIFIED, ESTIMATED, or INVOICED/);
});

test('outcome event rejects an invalid result', () => {
  const job = jobFixture();
  const completed = buildRepairCompletedEvent({ job, completedBy: 'brian' });
  assert.throws(
    () => buildOutcomeEvent({ job, completionEvent: completed, outcome: { result: 'maybe' }, recordedBy: 'brian' }),
    /outcome\.result must be one of/
  );
});

test('outcome event rejects a completion event from a different job', () => {
  const job = jobFixture();
  const otherJob = jobFixture({ jobId: 'SKSK-OTHER' });
  const completedForOther = buildRepairCompletedEvent({ job: otherJob, completedBy: 'brian' });
  assert.throws(
    () => buildOutcomeEvent({ job, completionEvent: completedForOther, outcome: { result: 'correct' }, recordedBy: 'brian' }),
    /does not belong to this job/
  );
});

test('a superseding outcome event becomes active; the original stays in history but inactive', () => {
  const job = jobFixture();
  const completed = buildRepairCompletedEvent({ job, completedBy: 'brian' });
  const wrong = buildOutcomeEvent({ job, completionEvent: completed, outcome: { result: 'wrong', symptomResolved: false }, recordedBy: 'brian' });
  const corrected = buildOutcomeEvent({
    job, completionEvent: completed,
    outcome: { result: 'correct', symptomResolved: true },
    recordedBy: 'brian',
    supersedesEventFingerprint: wrong.fingerprint
  });

  const events = [completed, wrong, corrected];
  const active = deriveActiveOutcomeEvent(events);
  assert.equal(active.fingerprint, corrected.fingerprint);
  assert.equal(active.outcome.result, 'CORRECT');

  const confirmedCase = buildConfirmedRepairCase(job, events);
  assert.equal(confirmedCase.outcome.result, 'CORRECT');
  assert.equal(confirmedCase.correctionCount, 1);
});

test('two active outcome events with no supersede link is a rejected integrity failure, not a silent pick', () => {
  const job = jobFixture();
  const completed = buildRepairCompletedEvent({ job, completedBy: 'brian' });
  const a = buildOutcomeEvent({ job, completionEvent: completed, outcome: { result: 'wrong' }, recordedBy: 'brian' });
  const b = buildOutcomeEvent({ job, completionEvent: completed, outcome: { result: 'correct' }, recordedBy: 'brian' });
  assert.throws(() => deriveActiveOutcomeEvent([completed, a, b]), /Multiple active outcome events/);
});

test('eligibleForTrustedLearning accepts a genuine confirmed case and rejects a tampered one', () => {
  const job = jobFixture();
  const completed = buildRepairCompletedEvent({ job, completedBy: 'brian' });
  const outcome = buildOutcomeEvent({ job, completionEvent: completed, outcome: { result: 'correct', symptomResolved: true }, recordedBy: 'brian' });
  const confirmedCase = buildConfirmedRepairCase(job, [completed, outcome]);

  assert.equal(eligibleForTrustedLearning(confirmedCase), true);

  const tampered = { ...confirmedCase, outcome: { ...confirmedCase.outcome, result: 'WRONG' } };
  assert.equal(eligibleForTrustedLearning(tampered), false);
  assert.equal(eligibleForTrustedLearning(null), false);
  assert.equal(eligibleForTrustedLearning({ stage: 'VERIFIED_CASE' }), false);
});

// --- HTTP-level: routes + atomic status projection via job.outcome.events.js ---

function createOutcomeTestApp() {
  const app = express();
  app.use(express.json());
  const jobsRouter = require('../src/routes/jobs.protected');
  app.use('/api/jobs', jobsRouter);
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Server error' });
  });
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json() };
}

async function get(base, path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function withServer(fn) {
  const app = createOutcomeTestApp();
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('HTTP: repair-completed then outcome moves job status atomically through both stages', async () => {
  await withServer(async (base) => {
    global.__jobs = global.__jobs || {};
    const job = jobFixture({ jobId: 'SKSK-HTTP-OUTCOME-1' });
    global.__jobs[job.jobId] = job;

    const completed = await post(base, `/api/jobs/${job.jobId}/repair-completed`, { completedBy: 'brian' });
    assert.equal(completed.status, 201);
    assert.equal(completed.body.status, 'REPAIR_COMPLETED');
    assert.equal(global.__jobs[job.jobId].status, 'REPAIR_COMPLETED');

    const outcome = await post(base, `/api/jobs/${job.jobId}/outcome`, { result: 'correct', symptomResolved: true, recordedBy: 'brian' });
    assert.equal(outcome.status, 201);
    assert.equal(outcome.body.status, 'OUTCOME_CONFIRMED');
    assert.equal(global.__jobs[job.jobId].status, 'OUTCOME_CONFIRMED');

    const events = await get(base, `/api/jobs/${job.jobId}/outcome-events`);
    assert.equal(events.body.events.length, 2);
  });
});

test('HTTP: outcome without a prior repair-completed event is rejected, job status untouched', async () => {
  await withServer(async (base) => {
    global.__jobs = global.__jobs || {};
    const job = jobFixture({ jobId: 'SKSK-HTTP-OUTCOME-2' });
    global.__jobs[job.jobId] = job;

    const outcome = await post(base, `/api/jobs/${job.jobId}/outcome`, { result: 'correct', recordedBy: 'brian' });
    assert.equal(outcome.status, 409);
    assert.equal(global.__jobs[job.jobId].status, 'VERIFIED');
  });
});

test('HTTP: repair-completed rejects a job stuck in TESTING, status stays unchanged', async () => {
  await withServer(async (base) => {
    global.__jobs = global.__jobs || {};
    const job = jobFixture({ jobId: 'SKSK-HTTP-OUTCOME-3', status: 'TESTING' });
    global.__jobs[job.jobId] = job;

    const completed = await post(base, `/api/jobs/${job.jobId}/repair-completed`, { completedBy: 'brian' });
    assert.equal(completed.status, 409);
    assert.equal(global.__jobs[job.jobId].status, 'TESTING');
  });
});

// --- Learning corpus gate ---

test('getTrainingDataset only admits examples explicitly tagged trustedForTraining', async () => {
  const examples = [];
  const adapter = {
    save: async (e) => { examples.push({ ...e, id: `ex_${examples.length}` }); return examples[examples.length - 1]; },
    getExamples: async () => examples
  };
  const loop = new MechanicFeedbackLoop(adapter);

  await loop.recordRepairOutcome({
    requestId: 'legacy-1',
    aiRecommendation: { cause: 'x' },
    mechanicAssessment: { diagnosisCorrect: 'correct', fixWorked: true },
    actualRepair: { part: 'x' },
    economicActual: { estimatedTotal: 100, totalCost: 100 }
  });

  const job = jobFixture();
  const completed = buildRepairCompletedEvent({ job, completedBy: 'brian' });
  const outcome = buildOutcomeEvent({ job, completionEvent: completed, outcome: { result: 'correct', symptomResolved: true }, recordedBy: 'brian' });
  const confirmedCase = buildConfirmedRepairCase(job, [completed, outcome]);

  await loop.recordConfirmedOutcome({ confirmedRepairCase: confirmedCase, aiRecommendation: { cause: 'x' }, vehicle: job.vehicle });

  const dataset = await loop.getTrainingDataset();
  assert.equal(dataset.length, 1);
  assert.equal(dataset[0].metadata.source, 'confirmed_repair_case');
});

test('recordConfirmedOutcome refuses anything that is not a valid CONFIRMED_REPAIR_CASE', async () => {
  const adapter = { save: async (e) => e, getExamples: async () => [] };
  const loop = new MechanicFeedbackLoop(adapter);

  await assert.rejects(
    () => loop.recordConfirmedOutcome({ confirmedRepairCase: { stage: 'CONFIRMED_REPAIR_CASE', outcome: { result: 'CORRECT' } } }),
    /valid, non-superseded CONFIRMED_REPAIR_CASE/
  );
});
