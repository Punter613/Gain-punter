'use strict';

const { fingerprint, verifiedEstimateInput } = require('./verified.case');
const { assertRepairResolutionIntegrity, verifiedOperations } = require('./verified.repair.resolution');
const { assertVerifiedEstimateSnapshot } = require('./verified.estimate.snapshot');

const SCHEMA_VERSION = 1;
const VALID_RESULTS = new Set(['CORRECT', 'PARTIAL', 'WRONG']);
const COMPLETABLE_STATUSES = new Set(['VERIFIED', 'ESTIMATED', 'INVOICED']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(values, limit, max) {
  return (Array.isArray(values) ? values : []).map(v => clean(v, max)).filter(Boolean).slice(0, limit);
}

function assertOutcomeEventIntegrity(event, expectedType = null) {
  if (!event || !event.fingerprint || !event.eventType) {
    throw new Error('Outcome history contains an invalid event');
  }
  if (expectedType && event.eventType !== expectedType) {
    throw new Error(`Outcome history expected ${expectedType} event`);
  }

  const copy = clone(event);
  const provided = copy.fingerprint;
  delete copy.fingerprint;
  if (fingerprint(copy) !== provided) {
    throw new Error(`Outcome event fingerprint mismatch: ${provided}`);
  }
  return event;
}

// verifiedCaseFingerprint is the only mandatory lineage anchor - a job can
// reach REPAIR_COMPLETED without ever being priced through SKSK Estimate
// (side job, warranty work, cash job). repairResolution/estimate/invoice
// are optional, but if present on the job they're validated through their
// own integrity checks so a stale or tampered one can't ride along quietly.
function resolveLineage(job = {}) {
  const verifiedCase = verifiedEstimateInput(job.verifiedCase).verifiedCase;

  let repairResolutionFingerprint = null;
  let estimateFingerprint = null;
  let invoicedEstimateFingerprint = null;

  if (job.estimate) {
    const estimateSnapshot = assertVerifiedEstimateSnapshot(job.estimate, job);
    estimateFingerprint = estimateSnapshot.fingerprint;
    repairResolutionFingerprint = estimateSnapshot.repairResolutionFingerprint;
  }

  if (job.invoice) {
    if (!job.estimate) throw new Error('Job has an invoice but no estimate; lineage is inconsistent');
    if (job.invoice.estimateFingerprint !== estimateFingerprint) {
      throw new Error('Invoice does not belong to this job\'s estimate lineage');
    }
    // There's no independently-fingerprinted invoice object today (see
    // src/routes/invoice.js) - it only carries the estimateFingerprint it
    // was built from. Naming this invoiceFingerprint would claim a
    // provenance it doesn't have. invoicedEstimateFingerprint says exactly
    // what it proves: this job was invoiced, and that invoice matches this
    // estimate lineage. A genuine invoice-level fingerprint can be added
    // later without redefining what this field has always meant.
    invoicedEstimateFingerprint = job.invoice.estimateFingerprint;
  }

  return {
    verifiedCase,
    verifiedCaseFingerprint: verifiedCase.fingerprint,
    repairResolutionFingerprint,
    estimateFingerprint,
    invoicedEstimateFingerprint
  };
}

function buildRepairCompletedEvent({ job, operationIds, completedBy, notes } = {}) {
  if (!COMPLETABLE_STATUSES.has(job?.status)) {
    throw new Error(`Repair completion requires job status VERIFIED, ESTIMATED, or INVOICED (was ${job?.status})`);
  }

  const lineage = resolveLineage(job);
  // Canonical operation IDs are derived straight from VERIFIED_CASE.repairScope,
  // independent of whether a priced repairResolution was ever built - so
  // completion can be recorded whether or not the job went through Estimate.
  const operations = verifiedOperations(lineage.verifiedCase.repairScope || []);
  const allowedIds = new Set(operations.map(op => op.operationId));
  const requested = Array.isArray(operationIds) && operationIds.length
    ? operationIds
    : operations.map(op => op.operationId);
  const boundOperationIds = requested.map(id => {
    const opId = clean(id, 200);
    if (!allowedIds.has(opId)) throw new Error('performedRepair.operationIds must bind to a VERIFIED_CASE repair operation');
    return opId;
  });

  const event = {
    schemaVersion: SCHEMA_VERSION,
    eventType: 'REPAIR_COMPLETED',
    jobId: job.jobId,
    verifiedCaseFingerprint: lineage.verifiedCaseFingerprint,
    repairResolutionFingerprint: lineage.repairResolutionFingerprint,
    estimateFingerprint: lineage.estimateFingerprint,
    invoicedEstimateFingerprint: lineage.invoicedEstimateFingerprint,
    performedRepair: {
      operationIds: boundOperationIds,
      completedBy: clean(completedBy, 120),
      completedAt: new Date().toISOString(),
      notes: clean(notes, 1000)
    },
    outcome: null,
    completionEventFingerprint: null,
    supersedesEventFingerprint: null
  };
  return Object.freeze({ ...event, fingerprint: fingerprint(event) });
}

function buildOutcomeEvent({ job, completionEvent, outcome = {}, recordedBy, supersedesEventFingerprint = null } = {}) {
  if (!completionEvent || completionEvent.eventType !== 'REPAIR_COMPLETED' || !completionEvent.fingerprint) {
    throw new Error('Outcome requires a canonical REPAIR_COMPLETED event');
  }
  assertOutcomeEventIntegrity(completionEvent, 'REPAIR_COMPLETED');
  if (completionEvent.jobId !== job?.jobId) throw new Error('Completion event does not belong to this job');

  const lineage = resolveLineage(job);
  if (completionEvent.verifiedCaseFingerprint !== lineage.verifiedCaseFingerprint) {
    throw new Error('Completion event does not belong to this job\'s VERIFIED_CASE lineage');
  }

  const result = String(outcome.result || '').toUpperCase();
  if (!VALID_RESULTS.has(result)) {
    throw new Error(`outcome.result must be one of ${[...VALID_RESULTS].join(', ')}`);
  }

  const event = {
    schemaVersion: SCHEMA_VERSION,
    eventType: 'OUTCOME_RECORDED',
    jobId: job.jobId,
    verifiedCaseFingerprint: lineage.verifiedCaseFingerprint,
    repairResolutionFingerprint: lineage.repairResolutionFingerprint,
    estimateFingerprint: lineage.estimateFingerprint,
    invoicedEstimateFingerprint: lineage.invoicedEstimateFingerprint,
    performedRepair: null,
    completionEventFingerprint: completionEvent.fingerprint,
    outcome: {
      result,
      symptomResolved: typeof outcome.symptomResolved === 'boolean' ? outcome.symptomResolved : null,
      remainingSymptoms: cleanList(outcome.remainingSymptoms, 12, 300),
      notes: clean(outcome.notes, 1000),
      evidenceRefs: cleanList(outcome.evidenceRefs, 20, 200),
      recordedBy: clean(recordedBy, 120),
      recordedAt: new Date().toISOString()
    },
    supersedesEventFingerprint: supersedesEventFingerprint ? clean(supersedesEventFingerprint, 200) : null
  };
  return Object.freeze({ ...event, fingerprint: fingerprint(event) });
}

// "Active" = not referenced by any other event's supersedesEventFingerprint.
// Two active outcome events for the same job with no chain between them is
// a data integrity problem, not a state to silently resolve by picking one.
function deriveActiveOutcomeEvent(events = []) {
  const outcomes = events
    .filter(e => e.eventType === 'OUTCOME_RECORDED')
    .map(event => assertOutcomeEventIntegrity(event, 'OUTCOME_RECORDED'));
  const superseded = new Set(outcomes.map(e => e.supersedesEventFingerprint).filter(Boolean));
  const active = outcomes.filter(e => !superseded.has(e.fingerprint));
  if (active.length > 1) {
    throw new Error('Multiple active outcome events for job; missing supersedesEventFingerprint linkage');
  }
  return active[0] || null;
}

function buildConfirmedRepairCase(job, events = []) {
  const activeOutcome = deriveActiveOutcomeEvent(events);
  if (!activeOutcome) throw new Error('No active outcome event for this job');

  const completionEvent = events.find(
    e => e.eventType === 'REPAIR_COMPLETED' && e.fingerprint === activeOutcome.completionEventFingerprint
  );
  if (!completionEvent) throw new Error('Active outcome event references a missing REPAIR_COMPLETED event');
  assertOutcomeEventIntegrity(completionEvent, 'REPAIR_COMPLETED');

  const lineage = resolveLineage(job);
  if (activeOutcome.verifiedCaseFingerprint !== lineage.verifiedCaseFingerprint) {
    throw new Error('Active outcome event does not match current job VERIFIED_CASE lineage');
  }

  const confirmedCase = {
    schemaVersion: SCHEMA_VERSION,
    stage: 'CONFIRMED_REPAIR_CASE',
    jobId: job.jobId,
    verifiedCaseFingerprint: lineage.verifiedCaseFingerprint,
    repairResolutionFingerprint: lineage.repairResolutionFingerprint,
    estimateFingerprint: lineage.estimateFingerprint,
    invoicedEstimateFingerprint: lineage.invoicedEstimateFingerprint,
    performedRepair: completionEvent.performedRepair,
    outcome: activeOutcome.outcome,
    sourceEventFingerprint: activeOutcome.fingerprint,
    correctionCount: events.filter(e => e.eventType === 'OUTCOME_RECORDED').length - 1
  };
  return Object.freeze({ ...confirmedCase, fingerprint: fingerprint(confirmedCase) });
}

// The single door into the trusted learning corpus. Not an API route, not
// an admin action, not a direct Supabase insert - mechanic.feedback.loop.js
// must call this and get true before treating anything as trusted training
// data. Re-verifies integrity itself rather than trusting the caller,
// since the object may have round-tripped through storage.
function eligibleForTrustedLearning(confirmedCase) {
  if (!confirmedCase || confirmedCase.stage !== 'CONFIRMED_REPAIR_CASE' || !confirmedCase.fingerprint) return false;
  if (!confirmedCase.verifiedCaseFingerprint) return false;
  if (!VALID_RESULTS.has(confirmedCase.outcome?.result)) return false;

  const copy = clone(confirmedCase);
  const provided = copy.fingerprint;
  delete copy.fingerprint;
  return fingerprint(copy) === provided;
}

module.exports = {
  SCHEMA_VERSION,
  VALID_RESULTS,
  COMPLETABLE_STATUSES,
  assertOutcomeEventIntegrity,
  resolveLineage,
  buildRepairCompletedEvent,
  buildOutcomeEvent,
  deriveActiveOutcomeEvent,
  buildConfirmedRepairCase,
  eligibleForTrustedLearning
};
