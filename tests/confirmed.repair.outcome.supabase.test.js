'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  return () => {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

function dropCache(modulePath) {
  try { delete require.cache[require.resolve(modulePath)]; } catch (_) { /* not loaded yet */ }
}

// A small in-memory stand-in for the two tables record_job_outcome_event()
// and getJob()/getJobOutcomeEvents() touch, implementing just enough of the
// Supabase chainable query shape that the real code calls. The point is to
// actually exercise src/services/job.outcome.events.js and
// src/services/job.lifecycle.js's Supabase branches - the ones the memory
// tests in confirmed.repair.outcome.test.js never touch at all, which is
// exactly how the supersession-identity mismatch bug shipped unnoticed.
function makeFakeSupabase() {
  const serviceJobs = new Map();
  const outcomeEvents = [];
  const feedbackExamples = new Map();

  function seedJob(jobId, payload) {
    serviceJobs.set(jobId, { status: payload.status, payload });
  }

  const client = {
    async rpc(fnName, params) {
      if (fnName !== 'record_job_outcome_event') {
        return { data: null, error: { message: `unknown rpc ${fnName}` } };
      }
      const job = serviceJobs.get(params.p_job_id);
      if (!job) return { data: null, error: { message: `job ${params.p_job_id} not found` } };

      const completableFrom = new Set(['VERIFIED', 'ESTIMATED', 'INVOICED']);
      const outcomeFrom = new Set(['REPAIR_COMPLETED', 'OUTCOME_CONFIRMED']);
      let nextStatus;
      if (params.p_event_type === 'REPAIR_COMPLETED') {
        if (!completableFrom.has(job.status)) {
          return { data: null, error: { message: `job is ${job.status}, cannot record REPAIR_COMPLETED` } };
        }
        nextStatus = 'REPAIR_COMPLETED';
      } else if (params.p_event_type === 'OUTCOME_RECORDED') {
        if (!outcomeFrom.has(job.status)) {
          return { data: null, error: { message: `job is ${job.status}, cannot record OUTCOME_RECORDED` } };
        }
        nextStatus = 'OUTCOME_CONFIRMED';
      } else {
        return { data: null, error: { message: `invalid event_type ${params.p_event_type}` } };
      }

      const row = {
        id: `evt_${outcomeEvents.length + 1}`,
        job_id: params.p_job_id,
        event_type: params.p_event_type,
        verified_case_fingerprint: params.p_verified_case_fingerprint,
        repair_resolution_fingerprint: params.p_repair_resolution_fingerprint,
        estimate_fingerprint: params.p_estimate_fingerprint,
        invoiced_estimate_fingerprint: params.p_invoiced_estimate_fingerprint,
        performed_repair: params.p_performed_repair,
        completion_event_fingerprint: params.p_completion_event_fingerprint,
        outcome: params.p_outcome,
        supersedes_event_fingerprint: params.p_supersedes_event_fingerprint,
        recorded_by: params.p_recorded_by,
        recorded_at: new Date(1755000000000 + outcomeEvents.length * 1000).toISOString(),
        schema_version: params.p_schema_version,
        fingerprint: params.p_fingerprint
      };
      outcomeEvents.push(row);

      // Mirrors the real RPC: status column AND embedded payload.status
      // move together, in the same "transaction" (here, the same call).
      job.status = nextStatus;
      job.payload = { ...job.payload, status: nextStatus };

      return { data: row, error: null };
    },
    from(table) {
      if (table === 'job_outcome_events') {
        return {
          select: () => ({
            eq: (_col, jobId) => ({
              order: () => ({ data: outcomeEvents.filter(r => r.job_id === jobId), error: null })
            })
          })
        };
      }
      if (table === 'service_jobs') {
        return {
          select: () => ({
            eq: (_col, jobId) => ({
              maybeSingle: () => {
                const job = serviceJobs.get(jobId);
                return { data: job ? { payload: job.payload } : null, error: null };
              }
            })
          })
        };
      }
      if (table === 'feedback_examples') {
        return {
          upsert: (row) => {
            feedbackExamples.set(row.id, row);
            return { error: null };
          },
          select: () => ({
            order: () => ({
              order: () => ({
                limit: () => ({ data: [...feedbackExamples.values()], error: null })
              })
            })
          })
        };
      }
      throw new Error(`fake supabase: unhandled table ${table}`);
    }
  };

  return { client, seedJob };
}

function freshRequire(modulePath) {
  dropCache(modulePath);
  return require(modulePath);
}

async function withSupabaseBackedApp(fn) {
  const { client, seedJob } = makeFakeSupabase();
  const unstubDb = stubModule('../src/db', { supabase: client });

  // Force every module in the chain to re-require '../db' now that it's
  // stubbed, instead of running on whatever (unstubbed, memory-mode)
  // copies earlier test files may have already cached.
  dropCache('../src/services/job.lifecycle');
  dropCache('../src/services/job.outcome.events');
  dropCache('../src/core/learning/feedback.supabase.adapter');
  dropCache('../src/core/learning');
  dropCache('../src/routes/jobs');
  dropCache('../src/routes/jobs.protected');

  const jobLifecycle = freshRequire('../src/services/job.lifecycle');
  freshRequire('../src/services/job.outcome.events');
  const jobsRouter = freshRequire('../src/routes/jobs.protected');

  const app = express();
  app.use(express.json());
  app.use('/api/jobs', jobsRouter);
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ success: false, error: err.message }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await fn({ base, seedJob, jobLifecycle });
  } finally {
    server.close();
    unstubDb();
    dropCache('../src/services/job.lifecycle');
    dropCache('../src/services/job.outcome.events');
    dropCache('../src/core/learning/feedback.supabase.adapter');
    dropCache('../src/core/learning');
    dropCache('../src/routes/jobs');
    dropCache('../src/routes/jobs.protected');
  }
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

function verifiedJobPayload(jobId) {
  const { buildDiagnosticEvidencePacket } = require('../src/core/evidence/diagnostic.evidence.packet');
  const { buildVerifiedCase } = require('../src/core/evidence/verified.case');

  const evidencePacket = buildDiagnosticEvidencePacket({
    vin: 'KNDJC735785123456',
    mileage: 150000,
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: '3.8L', drivetrain: '4WD' },
    customerObservations: ['bump on accelerator release'],
    mechanicObservations: ['CV axles replaced'],
    dtcs: ['P0300'],
    evidenceAvailable: true
  });

  const job = {
    jobId,
    status: 'VERIFIED',
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    diagnosis: {
      result: { primaryCause: 'Worn outer CV joint', probability: [{ cause: 'Worn outer CV joint', likelihood: 80 }] },
      evidencePacket
    },
    tests: [{ id: 'T1', name: 'Axle rotation test', result: 'clicking on turn', recordedAt: '2026-08-15T00:00:00.000Z' }],
    verification: {
      confirmed: true,
      confirmedCause: 'Worn outer CV joint',
      conclusion: 'Clicking isolated to CV joint',
      notes: '',
      verifiedAt: '2026-08-15T00:01:00.000Z'
    },
    estimate: null,
    invoice: null
  };
  job.verifiedCase = buildVerifiedCase(job);
  return job;
}

test('Supabase path: REPAIR_COMPLETED -> OUTCOME -> corrected OUTCOME -> reload resolves to the correction, not the original', async () => {
  await withSupabaseBackedApp(async ({ base, seedJob }) => {
    const jobId = 'SKSK-SUPABASE-OUTCOME-1';
    seedJob(jobId, verifiedJobPayload(jobId));

    const completed = await post(base, `/api/jobs/${jobId}/repair-completed`, { completedBy: 'brian' });
    assert.equal(completed.status, 201, JSON.stringify(completed.body));
    assert.equal(completed.body.status, 'REPAIR_COMPLETED');

    // Reload immediately after the write - proves DB status column, the
    // embedded payload.status, and what the route reports back all agree.
    const afterCompletion = await get(base, `/api/jobs/${jobId}`);
    assert.equal(afterCompletion.body.status, 'REPAIR_COMPLETED');

    const wrong = await post(base, `/api/jobs/${jobId}/outcome`, { result: 'wrong', symptomResolved: false, recordedBy: 'brian' });
    assert.equal(wrong.status, 201, JSON.stringify(wrong.body));
    assert.equal(wrong.body.status, 'OUTCOME_CONFIRMED');

    const corrected = await post(base, `/api/jobs/${jobId}/outcome`, {
      result: 'correct',
      symptomResolved: true,
      recordedBy: 'brian',
      supersedesEventFingerprint: wrong.body.event.fingerprint
    });
    assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
    assert.equal(corrected.body.event.supersedesEventFingerprint, wrong.body.event.fingerprint);

    const events = await get(base, `/api/jobs/${jobId}/outcome-events`);
    assert.equal(events.body.events.length, 3);
    // Round-tripped through the fake DB's row shape (snake_case columns ->
    // fromRow()) - this is exactly where the old bug lived: supersession
    // read back as a UUID-shaped value instead of the fingerprint that was
    // actually written, which would silently break this exact check.
    const reloadedCorrection = events.body.events.find(e => e.fingerprint === corrected.body.event.fingerprint);
    assert.equal(reloadedCorrection.supersedesEventFingerprint, wrong.body.event.fingerprint);

    const final = await get(base, `/api/jobs/${jobId}`);
    assert.equal(final.body.status, 'OUTCOME_CONFIRMED');
  });
});

test('Supabase path: outcome ingestion reaches the learning corpus, and a correction supersedes the earlier trusted example', async () => {
  await withSupabaseBackedApp(async ({ base, seedJob }) => {
    const jobId = 'SKSK-SUPABASE-OUTCOME-2';
    seedJob(jobId, verifiedJobPayload(jobId));

    await post(base, `/api/jobs/${jobId}/repair-completed`, { completedBy: 'brian' });
    const wrong = await post(base, `/api/jobs/${jobId}/outcome`, { result: 'wrong', symptomResolved: false, recordedBy: 'brian' });
    assert.equal(wrong.body.learningIngested, true, wrong.body.learningError);

    const corrected = await post(base, `/api/jobs/${jobId}/outcome`, {
      result: 'correct',
      symptomResolved: true,
      recordedBy: 'brian',
      supersedesEventFingerprint: wrong.body.event.fingerprint
    });
    assert.equal(corrected.body.learningIngested, true, corrected.body.learningError);

    const { feedbackLoop } = require('../src/core/learning');
    const dataset = await feedbackLoop.getTrainingDataset();
    const forThisJob = dataset.filter(e => e.requestId === jobId);
    // Both the WRONG and the CORRECT example were recorded (append-only),
    // but only one should still be considered trusted for training - the
    // correction, not the superseded original.
    assert.equal(forThisJob.length, 1);
    assert.equal(forThisJob[0].mechanicAssessment.diagnosisCorrect, 'correct');
  });
});
