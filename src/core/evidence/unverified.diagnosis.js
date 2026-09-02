'use strict';

const SCHEMA_VERSION = 1;
const STATE = 'UNVERIFIED_DIAGNOSIS';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clean(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function list(values, maxItems = 12, maxLen = 500) {
  return (Array.isArray(values) ? values : [])
    .map(value => clean(value, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeConfidence(result = {}) {
  const raw = result.diagnosticConfidence || {};
  const percentage = Number.isFinite(Number(raw.percentage))
    ? Math.max(0, Math.min(100, Math.round(Number(raw.percentage))))
    : null;
  const supplied = clean(raw.rating, 30).toUpperCase();
  const rating = ['LOW', 'MODERATE', 'MEDIUM', 'HIGH'].includes(supplied)
    ? (supplied === 'MEDIUM' ? 'MODERATE' : supplied)
    : percentage == null
      ? 'LOW'
      : percentage >= 80 ? 'HIGH' : percentage >= 50 ? 'MODERATE' : 'LOW';
  return { percentage, rating };
}

function selectMostLikelyCause(result = {}) {
  const direct = clean(result.primaryCause || result.diagnosis, 300);
  if (direct && !/^manual inspection required$/i.test(direct)) return direct;

  const ranked = Array.isArray(result.probability) ? result.probability : [];
  const best = ranked
    .map(item => ({ cause: clean(item?.cause, 300), likelihood: Number(item?.likelihood) || 0 }))
    .filter(item => item.cause)
    .sort((a, b) => b.likelihood - a.likelihood)[0];
  if (best?.cause) return best.cause;

  throw new Error('Unverified diagnosis requires a persisted diagnostic candidate');
}

function completedTestNames(job = {}) {
  return new Set((job.tests || []).map(test => clean(test?.name, 500).toLowerCase()).filter(Boolean));
}

function remainingVerificationSteps(job = {}, result = {}) {
  const completed = completedTestNames(job);
  const recommended = list(result.recommendedTests || result.tests || result.confirmWithTests, 20, 800);
  return recommended.filter(step => !completed.has(step.toLowerCase())).slice(0, 12);
}

function buildRationale(job = {}, result = {}, mostLikelyCause) {
  const reasons = [];
  const dtcs = list(job.intake?.obdCodes, 12, 30);
  const customer = list(job.intake?.customerStates, 6, 300);
  const mechanic = list(job.intake?.mechanicNotices, 6, 300);
  const ranked = Array.isArray(result.probability) ? result.probability : [];
  const matching = ranked.find(item => clean(item?.cause, 300).toLowerCase() === mostLikelyCause.toLowerCase()) || ranked[0];

  if (dtcs.length) reasons.push(`DTC context: ${dtcs.join(', ')}`);
  if (customer.length) reasons.push(`Customer symptoms: ${customer.join(' | ')}`);
  if (mechanic.length) reasons.push(`Mechanic observations: ${mechanic.join(' | ')}`);
  if (matching?.cause) {
    const likelihood = Number(matching.likelihood);
    reasons.push(Number.isFinite(likelihood)
      ? `Candidate ranking weight: ${clean(matching.cause, 300)} at ${Math.max(0, Math.min(100, Math.round(likelihood)))}% of the current candidate weighting`
      : `Candidate ranking: ${clean(matching.cause, 300)}`);
  }
  if (result.notes) reasons.push(clean(result.notes, 500));
  return reasons.slice(0, 8);
}

function uniqueAlternatives(values = [], mostLikelyCause = '') {
  const primaryKey = clean(mostLikelyCause, 300).toLowerCase();
  const seen = new Set();
  return values.filter(value => {
    const cleaned = clean(value, 300);
    const key = cleaned.toLowerCase();
    if (!key || key === primaryKey || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

function buildUnverifiedDiagnosis(job = {}, recordedAt = new Date().toISOString()) {
  const result = job.diagnosis?.result;
  if (!result) throw new Error('Unverified diagnosis requires a persisted diagnosis');

  const mostLikelyCause = selectMostLikelyCause(result);
  const evidencePacket = job.diagnosis?.evidencePacket || {};
  const evidence = result.evidence || {};
  const alternatives = uniqueAlternatives([
    ...list(result.secondaryCauses, 5, 300),
    ...(Array.isArray(result.probability) ? result.probability.map(item => clean(item?.cause, 300)) : [])
  ], mostLikelyCause);

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    state: STATE,
    jobId: clean(job.jobId, 120),
    recordedAt,
    mostLikelyCause,
    confidence: normalizeConfidence(result),
    alternatives,
    whySkskThinksThis: buildRationale(job, result, mostLikelyCause),
    whatRemainsUnverified: remainingVerificationSteps(job, result),
    evidenceUsed: {
      vehicle: clone(evidencePacket.vehicle || job.vehicle || {}),
      dtcs: list(job.intake?.obdCodes, 12, 30),
      customerStates: list(job.intake?.customerStates, 8, 400),
      mechanicNotices: list(job.intake?.mechanicNotices, 8, 400),
      recordedTests: clone(job.tests || []),
      oemReferenceCount: Array.isArray(evidence.oem) ? evidence.oem.length : Array.isArray(evidencePacket.oemReferences) ? evidencePacket.oemReferences.length : 0,
      tsbReferenceCount: Array.isArray(evidence.tsbs) ? evidence.tsbs.length : Array.isArray(evidencePacket.tsbReferences) ? evidencePacket.tsbReferences.length : 0,
      evidencePacketSchemaVersion: evidencePacket.schemaVersion ?? null
    },
    physicallyVerified: false,
    repairAuthorized: false,
    estimateReady: false,
    learningEligible: false,
    warning: 'This diagnosis has not been physically verified. It does not authorize a repair and does not unlock Estimate.'
  });
}

module.exports = {
  SCHEMA_VERSION,
  STATE,
  buildUnverifiedDiagnosis,
  normalizeConfidence,
  selectMostLikelyCause,
  remainingVerificationSteps,
  uniqueAlternatives
};
