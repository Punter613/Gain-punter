'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildDiagnosticEvidencePacket } = require('../src/core/evidence/diagnostic.evidence.packet');
const { buildVerifiedCase } = require('../src/core/evidence/verified.case');
const {
  buildRepairCompletedEvent,
  buildOutcomeEvent,
  buildConfirmedRepairCase,
  deriveActiveOutcomeEvent
} = require('../src/core/evidence/confirmed.repair.case');
const MechanicFeedbackLoop = require('../src/core/learning/mechanic.feedback.loop');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function jobFixture() {
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
    jobId: 'SKSK-SUPABASE-CONTRACT',
    status: 'VERIFIED',
    updatedAt: '2026-08-16T00:00:00.000Z',
    customer: { name: 'Contract Test' },
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    intake: { customerStates: [], mechanicNotices: [], obdCodes: ['P0300'] },
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

class SelectQuery {
  constructor(result) {
    this.result = result;
    this.filters = [];
    this.max = null;
  }

  select() { return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  order() { return this; }
  limit(value) { this.max = value; return this; }

  maybeSingle() {
    const rows = this._rows();
    return Promise.resolve({ data: rows[0] || null, error: null });
  }

  _rows() {
    let rows = this.result().filter(row =>
      this.filters.every(([column, value]) => row[column] === value)
    );
    if (this.max != null) rows = rows.slice(0, this.max);
    return clone(rows);
  }

  then(resolve, reject) {
    return Promise.resolve({ data: this._rows(), error: null }).then(resolve, reject);
  }
}

class FakeSupabase {
  constructor(job) {
    this.jobs = new Map([[job.jobId, {
      job_id: job.jobId,
      status: job.status,
      payload: clone(job),
      updated_at: job.updatedAt
    }]]);
    this.outcomeEvents = [];
    this.feedbackExamples = new Map();
    this.rpcCalls = [];
  }

  async rpc(name, args) {
    assert.equal(name, 'record_job_outcome_event');
    this.rpcCalls.push(clone(args));
    const job = this.jobs.get(args.p_job_id);
    if (!job) return { data: null, error: { message: 'job not found' } };

    const nextStatus = args.p_event_type === 'REPAIR_COMPLETED'
      ? 'REPAIR_COMPLETED'
      : 'OUTCOME_CONFIRMED';
    const recordedAt = new Date(Date.UTC(2026, 7, 16, 12, 0, this.outcomeEvents.length)).toISOString();
    const row = {
      id: `00000000-0000-0000-0000-${String(this.outcomeEvents.length + 1).padStart(12, '0')}`,
      job_id: args.p_job_id,
      event_type: args.p_event_type,
      verified_case_fingerprint: args.p_verified_case_fingerprint,
      repair_resolution_fingerprint: args.p_repair_resolution_fingerprint,
      estimate_fingerprint: args.p_estimate_fingerprint,
      invoiced_estimate_fingerprint: args.p_invoiced_estimate_fingerprint,
      performed_repair: clone(args.p_performed_repair),
      completion_event_fingerprint: args.p_completion_event_fingerprint,
      outcome: clone(args.p_outcome),
      supersedes_event_fingerprint: args.p_supersedes_event_fingerprint,
      recorded_by: args.p_recorded_by,
      recorded_at: recordedAt,
      schema_version: args.p_schema_version,
      fingerprint: args.p_fingerprint
    };

    this.outcomeEvents.push(row);
    job.status = nextStatus;
    job.updated_at = recordedAt;
    job.payload = { ...job.payload, status: nextStatus, updatedAt: recordedAt };
    return { data: clone(row), error: null };
  }

  from(table) {
    if (table === 'job_outcome_events') {
      return new SelectQuery(() => this.outcomeEvents);
    }
    if (table === 'service_jobs') {
      return new SelectQuery(() => Array.from(this.jobs.values()));
    }
    if (table === 'feedback_examples') {
      const query = new SelectQuery(() => Array.from(this.feedbackExamples.values()));
      query.upsert = async row => {
        this.feedbackExamples.set(row.id, clone(row));
        return { error: null };
      };
      return query;
    }
    throw new Error(`Unexpected fake Supabase table: ${table}`);
  }
}

function loadAgainst(fakeSupabase) {
  const dbPath = require.resolve('../src/db');
  const modulePaths = [
    require.resolve('../src/services/job.outcome.events'),
    require.resolve('../src/services/job.lifecycle'),
    require.resolve('../src/core/learning/feedback.supabase.adapter')
  ];
  const previous = new Map([[dbPath, require.cache[dbPath]]]);
  for (const modulePath of modulePaths) previous.set(modulePath, require.cache[modulePath]);

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { supabase: fakeSupabase }
  };
  for (const modulePath of modulePaths) delete require.cache[modulePath];

  const outcomeStore = require('../src/services/job.outcome.events');
  const jobLifecycle = require('../src/services/job.lifecycle');
  const FeedbackSupabaseAdapter = require('../src/core/learning/feedback.supabase.adapter');

  return {
    outcomeStore,
    jobLifecycle,
    FeedbackSupabaseAdapter,
    restore() {
      for (const [modulePath, cached] of previous) {
        if (cached) require.cache[modulePath] = cached;
        else delete require.cache[modulePath];
      }
    }
  };
}

test('Supabase contract preserves repair → outcome → correction fingerprints and projections across reload', async t => {
  const migration = fs.readFileSync(
    path.join(__dirname, '../db/migrations/009_repair_outcome_lifecycle.sql'),
    'utf8'
  );
  assert.match(migration, /p_supersedes_event_fingerprint text/);
  assert.doesNotMatch(migration, /supersedes_event_id/);
  assert.match(migration, /payload = jsonb_set\(/);

  const job = jobFixture();
  const fake = new FakeSupabase(job);
  const loaded = loadAgainst(fake);
  t.after(() => {
    loaded.restore();
    delete global.__jobs;
    delete global.__jobOutcomeEvents;
  });

  global.__jobs = { [job.jobId]: job };
  const { recordOutcomeEvent, getJobOutcomeEvents } = loaded.outcomeStore;
  const loop = new MechanicFeedbackLoop(
    new loaded.FeedbackSupabaseAdapter(),
    { outcomeEventReader: getJobOutcomeEvents }
  );

  const completed = buildRepairCompletedEvent({ job, completedBy: 'brian' });
  await recordOutcomeEvent(completed);
  assert.equal(global.__jobs[job.jobId].status, 'REPAIR_COMPLETED');
  assert.equal(fake.jobs.get(job.jobId).payload.status, 'REPAIR_COMPLETED');

  const firstOutcome = buildOutcomeEvent({
    job,
    completionEvent: completed,
    outcome: { result: 'partial', symptomResolved: false },
    recordedBy: 'brian'
  });
  await recordOutcomeEvent(firstOutcome);
  assert.equal(global.__jobs[job.jobId].status, 'OUTCOME_CONFIRMED');
  assert.equal(fake.jobs.get(job.jobId).payload.status, 'OUTCOME_CONFIRMED');

  let persistedEvents = await getJobOutcomeEvents(job.jobId);
  const firstCase = buildConfirmedRepairCase(global.__jobs[job.jobId], persistedEvents);
  await loop.recordConfirmedOutcome({
    confirmedRepairCase: firstCase,
    aiRecommendation: job.diagnosis.result,
    vehicle: job.vehicle
  });
  assert.equal((await loop.getTrainingDataset()).length, 1);

  const correctedOutcome = buildOutcomeEvent({
    job: global.__jobs[job.jobId],
    completionEvent: completed,
    outcome: { result: 'correct', symptomResolved: true },
    recordedBy: 'brian',
    supersedesEventFingerprint: firstOutcome.fingerprint
  });
  await recordOutcomeEvent(correctedOutcome);

  const correctionCall = fake.rpcCalls.at(-1);
  assert.equal(correctionCall.p_supersedes_event_fingerprint, firstOutcome.fingerprint);
  assert.equal('p_supersedes_event_id' in correctionCall, false);

  // Simulate a fresh process: no in-memory job projection survives.
  global.__jobs = {};
  const reloadedJob = await loaded.jobLifecycle.getJob(job.jobId);
  persistedEvents = await getJobOutcomeEvents(job.jobId);
  assert.equal(reloadedJob.status, 'OUTCOME_CONFIRMED');
  assert.equal(persistedEvents.length, 3);
  assert.equal(persistedEvents[2].supersedesEventFingerprint, firstOutcome.fingerprint);
  assert.equal(deriveActiveOutcomeEvent(persistedEvents).fingerprint, correctedOutcome.fingerprint);

  // The old example remains append-only in feedback storage, but is no longer
  // eligible because its source event is not active after the correction.
  assert.equal((await loop.getTrainingDataset()).length, 0);

  const correctedCase = buildConfirmedRepairCase(reloadedJob, persistedEvents);
  await loop.recordConfirmedOutcome({
    confirmedRepairCase: correctedCase,
    aiRecommendation: reloadedJob.diagnosis.result,
    vehicle: reloadedJob.vehicle
  });
  const dataset = await loop.getTrainingDataset();
  assert.equal(dataset.length, 1);
  assert.equal(dataset[0].confirmedRepairCase.sourceEventFingerprint, correctedOutcome.fingerprint);
});
