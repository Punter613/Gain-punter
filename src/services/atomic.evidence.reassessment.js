'use strict';

const crypto = require('crypto');
const {
  getJob,
  patchJob,
  recordUnverifiedDiagnosis,
  isMeaningfulTestResult,
  normalizeEvidenceRole,
  TEST_EVIDENCE_ROLES
} = require('./job.lifecycle');
const {
  hasNewEvidenceSinceDiagnosis,
  needsDtcProvenanceReassessment,
  reassessmentReason,
  reassessDiagnosis,
  jobDtcEvidence,
  trustedJobDtcs
} = require('./diagnostic.reassessment');
const { publicDtcEvidence, summarizeDtcProvenance } = require('../core/evidence/dtc.provenance');

const MAX_ATOMIC_EVIDENCE_ITEMS = 20;
const jobMutationQueues = new Map();

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function withJobMutationLock(jobId, operation) {
  const key = clean(jobId);
  const prior = jobMutationQueues.get(key) || Promise.resolve();
  const next = prior.catch(() => {}).then(operation);
  jobMutationQueues.set(key, next);
  return next.finally(() => {
    if (jobMutationQueues.get(key) === next) jobMutationQueues.delete(key);
  });
}

function normalizeAtomicEvidence(test = {}) {
  const id = clean(test.id || test.evidenceId || test.clientEvidenceId);
  if (!id) throw new Error('Atomic evidence requires a stable evidence id for retry safety');
  if (id.length > 160) throw new Error('Evidence id is too long');

  const name = clean(test.name || test.test);
  const result = clean(test.result);
  if (!name) throw new Error('Recorded test requires a test name');
  if (!isMeaningfulTestResult(result)) {
    throw new Error('Recorded test requires an actual observation or measurement; placeholders do not count as evidence');
  }

  const requestedRole = clean(test.evidenceRole || test.evidenceStrength || test.role);
  const evidenceRole = normalizeEvidenceRole(requestedRole);
  if (!evidenceRole) {
    throw new Error('Recorded test evidence role must be NEUTRAL, SUPPORTS, REFUTES, or CONFIRMS');
  }

  const confirmedFault = evidenceRole === TEST_EVIDENCE_ROLES.CONFIRMS
    ? clean(test.confirmedFault)
    : '';
  if (evidenceRole === TEST_EVIDENCE_ROLES.CONFIRMS && !confirmedFault) {
    throw new Error('A CONFIRMS test must name the exact fault that the physical evidence confirms');
  }

  return {
    id,
    name,
    result,
    units: clean(test.units),
    notes: clean(test.notes),
    passed: typeof test.passed === 'boolean' ? test.passed : null,
    evidenceRole,
    confirmedFault
  };
}

function evidenceFingerprint(test = {}) {
  return JSON.stringify({
    name: clean(test.name),
    result: clean(test.result),
    units: clean(test.units),
    notes: clean(test.notes),
    passed: typeof test.passed === 'boolean' ? test.passed : null,
    evidenceRole: clean(test.evidenceRole).toUpperCase(),
    confirmedFault: clean(test.confirmedFault)
  });
}

function normalizeEvidenceBatch(evidence = []) {
  if (!Array.isArray(evidence)) throw new Error('evidence must be an array');
  if (evidence.length > MAX_ATOMIC_EVIDENCE_ITEMS) {
    throw new Error(`Atomic evidence is limited to ${MAX_ATOMIC_EVIDENCE_ITEMS} items per request`);
  }

  const byId = new Map();
  for (const raw of evidence) {
    const normalized = normalizeAtomicEvidence(raw);
    const prior = byId.get(normalized.id);
    if (prior && evidenceFingerprint(prior) !== evidenceFingerprint(normalized)) {
      throw new Error(`Evidence id ${normalized.id} was reused with different content`);
    }
    byId.set(normalized.id, prior || normalized);
  }
  return [...byId.values()];
}

function staleDiagnosisPatch(job, recordedAt) {
  if (!job.diagnosis) return job.diagnosis;
  return {
    ...job.diagnosis,
    stale: true,
    staleReason: 'NEW_TEST_EVIDENCE',
    staleAt: recordedAt
  };
}

function staleUnverifiedPatch(job, recordedAt) {
  if (job.unverifiedDiagnosis?.state !== 'UNVERIFIED_DIAGNOSIS') return job.unverifiedDiagnosis;
  return {
    ...job.unverifiedDiagnosis,
    stale: true,
    supersededBy: 'NEW_TEST_EVIDENCE',
    supersededAt: recordedAt
  };
}

async function persistEvidenceBatchUnlocked(jobId, evidence = []) {
  let job = await getJob(jobId);
  if (!job) throw Object.assign(new Error('Job not found'), { statusCode: 404 });
  if (!['TESTING', 'DIAGNOSING'].includes(job.status)) {
    throw new Error(`Tests cannot be added while job is ${job.status}`);
  }

  const normalized = normalizeEvidenceBatch(evidence);
  if (!normalized.length) return { job, saved: [], reused: [] };

  // Validate the entire request before changing the job. A malformed item cannot
  // leave half of a mobile batch persisted.
  const existingById = new Map((job.tests || []).map(item => [clean(item.id), item]));
  const saved = [];
  const reused = [];
  const newItems = [];

  for (const item of normalized) {
    const existing = existingById.get(item.id);
    if (existing) {
      if (evidenceFingerprint(existing) !== evidenceFingerprint(item)) {
        throw new Error(`Evidence id ${item.id} already exists with different content`);
      }
      reused.push(existing);
      continue;
    }
    newItems.push(item);
  }

  if (!newItems.length) return { job, saved, reused };

  const diagnosisMs = Date.parse(job.diagnosis?.recordedAt || '') || 0;
  const latestTestMs = Math.max(0, ...(job.tests || []).map(test => Date.parse(test?.recordedAt || '') || 0));
  const baseMs = Math.max(Date.now(), diagnosisMs + 1, latestTestMs + 1);
  const entries = newItems.map((item, index) => ({
    ...item,
    recordedAt: new Date(baseMs + index).toISOString()
  }));
  const staleAt = entries[entries.length - 1].recordedAt;

  job = await patchJob(jobId, {
    status: 'TESTING',
    tests: [...(job.tests || []), ...entries],
    diagnosis: staleDiagnosisPatch(job, staleAt),
    unverifiedDiagnosis: staleUnverifiedPatch(job, staleAt)
  });
  if (!job) throw new Error('Evidence persistence failed');

  saved.push(...entries);
  return { job, saved, reused };
}

async function persistEvidenceBatch(jobId, evidence = []) {
  return withJobMutationLock(jobId, () => persistEvidenceBatchUnlocked(jobId, evidence));
}

async function applyReassessment(jobId, current, reason, reassessDiagnosisFn) {
  const provenanceRefreshRequired = needsDtcProvenanceReassessment(current);
  const reassessed = await reassessDiagnosisFn(current);
  if (!reassessed) throw new Error('Diagnostic reassessment produced no replacement diagnosis');

  const previousDiagnosis = current.diagnosis;
  const revision = Math.max(1, Number(previousDiagnosis.revision) || 1) + 1;
  const migrationRecords = provenanceRefreshRequired ? jobDtcEvidence(current) : null;
  const migratedEvidencePacket = provenanceRefreshRequired
    ? {
        ...(previousDiagnosis.evidencePacket || {}),
        schemaVersion: 2,
        dtcs: trustedJobDtcs(current),
        dtcProvenance: summarizeDtcProvenance(migrationRecords)
      }
    : previousDiagnosis.evidencePacket;
  // A reassessment must be chronologically newer than every evidence item it consumed.
  // The evidence saver may intentionally assign timestamps 1ms after the prior
  // diagnosis, so Date.now() alone can still land on or before that evidence on
  // a fast runner. Force the replacement diagnosis past the latest persisted test.
  const latestEvidenceMs = Math.max(0, ...(current.tests || []).map(test => Date.parse(test?.recordedAt || '') || 0));
  const previousDiagnosisMs = Date.parse(previousDiagnosis?.recordedAt || '') || 0;
  const reassessedAt = new Date(Math.max(Date.now(), latestEvidenceMs + 1, previousDiagnosisMs + 1)).toISOString();

  return patchJob(jobId, {
    ...(provenanceRefreshRequired ? {
      intake: {
        ...(current.intake || {}),
        dtcEvidence: publicDtcEvidence(migrationRecords),
        obdCodes: trustedJobDtcs(current)
      }
    } : {}),
    diagnosisHistory: [...(current.diagnosisHistory || []), previousDiagnosis],
    diagnosis: {
      ...previousDiagnosis,
      evidencePacket: migratedEvidencePacket,
      result: reassessed,
      revision,
      reassessmentReason: reason || reassessed.reassessment?.reason || 'REASSESSMENT',
      recordedAt: reassessedAt,
      stale: false,
      staleReason: null,
      staleAt: null
    }
  });
}

function failClosedAfterEvidence(error, saveResult, reason) {
  const failure = new Error(
    'Evidence is saved, but diagnostic reassessment failed. The prior diagnosis is stale and will not be presented as current.'
  );
  failure.code = 'REASSESSMENT_FAILED_AFTER_EVIDENCE_SAVE';
  failure.statusCode = 409;
  failure.evidenceSaved = saveResult.saved.length > 0;
  failure.evidenceSavedCount = saveResult.saved.length;
  failure.evidenceReusedCount = saveResult.reused.length;
  failure.savedEvidence = saveResult.saved;
  failure.reusedEvidence = saveResult.reused;
  failure.diagnosisStale = true;
  failure.reassessmentReason = reason || 'NEW_TEST_EVIDENCE';
  failure.internalCause = error;
  return failure;
}

async function atomicUnverifiedDiagnosis(jobId, evidence = [], options = {}) {
  return withJobMutationLock(jobId, async () => {
    const saveResult = await persistEvidenceBatchUnlocked(jobId, evidence);
    let current = saveResult.job;
    if (!current?.diagnosis?.result) throw new Error('Diagnosis must exist before requesting an unverified diagnosis');

    const reason = reassessmentReason(current);
    const provenanceRefreshRequired = needsDtcProvenanceReassessment(current);
    const newEvidenceAvailable = hasNewEvidenceSinceDiagnosis(current);
    const reassessDiagnosisFn = options.reassessDiagnosisFn || reassessDiagnosis;

    if (reason) {
      try {
        current = await applyReassessment(jobId, current, reason, reassessDiagnosisFn);
      } catch (error) {
        if (newEvidenceAvailable) {
          console.warn(`[atomic-reassessment] evidence persisted but reassessment failed for ${jobId}:`, error.message);
          throw failClosedAfterEvidence(error, saveResult, reason);
        }
        if (provenanceRefreshRequired) {
          console.warn(`[atomic-reassessment] required DTC provenance reassessment failed for ${jobId}:`, error.message);
          throw new Error('This diagnosis predates DTC provenance enforcement and could not be safely refreshed. Re-run Diagnose before relying on an unverified diagnosis.');
        }
        throw error;
      }
    }

    if (!current) throw new Error('Diagnostic reassessment could not be persisted');
    if (needsDtcProvenanceReassessment(current)) {
      throw new Error('This diagnosis predates DTC provenance enforcement. Re-run Diagnose before relying on an unverified diagnosis.');
    }
    if (current.diagnosis?.stale === true || hasNewEvidenceSinceDiagnosis(current)) {
      throw failClosedAfterEvidence(new Error('Diagnosis remains stale after reassessment'), saveResult, reason);
    }

    const job = await recordUnverifiedDiagnosis(jobId);
    if (!job) throw Object.assign(new Error('Job not found'), { statusCode: 404 });

    return {
      job,
      savedEvidence: saveResult.saved,
      reusedEvidence: saveResult.reused,
      evidenceSavedCount: saveResult.saved.length,
      evidenceReusedCount: saveResult.reused.length,
      reassessmentReason: job.diagnosis?.result?.reassessment?.reason || job.diagnosis?.reassessmentReason || null,
      reassessmentApplied: job.diagnosis?.result?.reassessment?.applied === true
    };
  });
}

module.exports = {
  MAX_ATOMIC_EVIDENCE_ITEMS,
  normalizeAtomicEvidence,
  normalizeEvidenceBatch,
  evidenceFingerprint,
  withJobMutationLock,
  persistEvidenceBatch,
  atomicUnverifiedDiagnosis,
  failClosedAfterEvidence
};
