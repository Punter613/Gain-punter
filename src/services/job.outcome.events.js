'use strict';

const { supabase } = require('../db');

function memoryStore() {
  global.__jobOutcomeEvents = global.__jobOutcomeEvents || {};
  return global.__jobOutcomeEvents;
}

// Mirrors job.lifecycle.js's own in-memory job store so dev/test runs
// without Supabase configured still exercise the real status transition,
// not just the event insert.
function memoryJobs() {
  global.__jobs = global.__jobs || {};
  return global.__jobs;
}

function nextStatusFor(eventType) {
  if (eventType === 'REPAIR_COMPLETED') return 'REPAIR_COMPLETED';
  if (eventType === 'OUTCOME_RECORDED') return 'OUTCOME_CONFIRMED';
  throw new Error(`Unknown outcome event type: ${eventType}`);
}

const COMPLETABLE_FROM = new Set(['VERIFIED', 'ESTIMATED', 'INVOICED']);
const OUTCOME_FROM = new Set(['REPAIR_COMPLETED', 'OUTCOME_CONFIRMED']);

function assertLegalTransition(currentStatus, eventType) {
  if (eventType === 'REPAIR_COMPLETED' && !COMPLETABLE_FROM.has(currentStatus)) {
    throw new Error(`Job is ${currentStatus}, cannot record REPAIR_COMPLETED`);
  }
  if (eventType === 'OUTCOME_RECORDED' && !OUTCOME_FROM.has(currentStatus)) {
    throw new Error(`Job is ${currentStatus}, cannot record OUTCOME_RECORDED`);
  }
}

function assertSupersession(events, event, currentStatus) {
  if (event.eventType !== 'OUTCOME_RECORDED') return;

  const targetFingerprint = event.supersedesEventFingerprint || null;
  if (currentStatus === 'REPAIR_COMPLETED' && targetFingerprint) {
    throw new Error('First outcome cannot supersede another outcome');
  }
  if (currentStatus === 'OUTCOME_CONFIRMED' && !targetFingerprint) {
    throw new Error('Corrected outcome must supersede the active outcome');
  }
  if (!targetFingerprint) return;

  const target = events.find(candidate =>
    candidate.eventType === 'OUTCOME_RECORDED'
    && candidate.fingerprint === targetFingerprint
    && candidate.completionEventFingerprint === event.completionEventFingerprint
  );
  if (!target) throw new Error('Superseded outcome is not in this repair chain');

  const alreadySuperseded = events.some(candidate =>
    candidate.supersedesEventFingerprint === targetFingerprint
  );
  if (alreadySuperseded) throw new Error('Superseded outcome is no longer active');
}

function updateMemoryProjection(jobId, eventType, updatedAt) {
  const job = memoryJobs()[jobId];
  if (!job) return;
  job.status = nextStatusFor(eventType);
  job.updatedAt = updatedAt || new Date().toISOString();
}

// The one write path for outcome events. event is an already-built,
// already-fingerprinted object from confirmed.repair.case.js - this
// function does not re-derive or re-validate the diagnostic/lineage
// content, only the row insert + status projection, atomically.
//
// Unlike job.lifecycle.js's persist(), a Supabase failure here is NOT
// swallowed into a memory-only fallback. The whole point of this table is
// durable, un-mutatable truth; silently degrading to memory-only on a
// write that's supposed to survive a restart would recreate the exact
// "wiped on redeploy" bug that feedback_examples had before it moved to
// Supabase. If Supabase is configured, the write must actually land there
// or the caller needs to know it didn't.
async function recordOutcomeEvent(event) {
  if (supabase) {
    const { data, error } = await supabase.rpc('record_job_outcome_event', {
      p_job_id: event.jobId,
      p_event_type: event.eventType,
      p_verified_case_fingerprint: event.verifiedCaseFingerprint,
      p_repair_resolution_fingerprint: event.repairResolutionFingerprint,
      p_estimate_fingerprint: event.estimateFingerprint,
      p_invoiced_estimate_fingerprint: event.invoicedEstimateFingerprint,
      p_performed_repair: event.performedRepair,
      p_completion_event_fingerprint: event.completionEventFingerprint,
      p_outcome: event.outcome,
      p_supersedes_event_fingerprint: event.supersedesEventFingerprint || null,
      p_recorded_by: event.recordedBy || event.performedRepair?.completedBy || event.outcome?.recordedBy || null,
      p_schema_version: event.schemaVersion,
      p_fingerprint: event.fingerprint
    });
    if (error) throw new Error(`record_job_outcome_event failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('record_job_outcome_event returned no event row');
    updateMemoryProjection(event.jobId, event.eventType, row.recorded_at);
    return { row, event };
  }

  const jobs = memoryJobs();
  const job = jobs[event.jobId];
  if (!job) throw new Error(`Job ${event.jobId} not found`);
  assertLegalTransition(job.status, event.eventType);

  const events = memoryStore();
  events[event.jobId] = events[event.jobId] || [];
  assertSupersession(events[event.jobId], event, job.status);
  events[event.jobId].push(event);
  updateMemoryProjection(event.jobId, event.eventType);

  return { row: event, event };
}

async function getJobOutcomeEvents(jobId) {
  if (supabase) {
    const { data, error } = await supabase
      .from('job_outcome_events')
      .select('*')
      .eq('job_id', jobId)
      .order('recorded_at', { ascending: true });
    if (error) throw new Error(`Failed to load outcome events for ${jobId}: ${error.message}`);
    return (data || []).map(fromRow);
  }
  return memoryStore()[jobId] || [];
}

function fromRow(row) {
  return {
    schemaVersion: row.schema_version,
    eventType: row.event_type,
    jobId: row.job_id,
    verifiedCaseFingerprint: row.verified_case_fingerprint,
    repairResolutionFingerprint: row.repair_resolution_fingerprint,
    estimateFingerprint: row.estimate_fingerprint,
    invoicedEstimateFingerprint: row.invoiced_estimate_fingerprint,
    performedRepair: row.performed_repair,
    completionEventFingerprint: row.completion_event_fingerprint,
    outcome: row.outcome,
    supersedesEventFingerprint: row.supersedes_event_fingerprint || null,
    fingerprint: row.fingerprint
  };
}

module.exports = { recordOutcomeEvent, getJobOutcomeEvents };
