'use strict';

const INVALID_EXACT_CAUSES = new Set([
  'manual inspection required',
  'diagnosis generation failed',
  'diagnostic generation failed',
  'unable to determine diagnosis'
]);

function clean(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isInvalidCauseText(value) {
  const cause = clean(value).toLowerCase();
  if (!cause) return true;
  if (INVALID_EXACT_CAUSES.has(cause)) return true;
  return false;
}

function selectDiagnosticCandidate(result = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (result.generationFailed === true || result.parseFailed === true || result.invalidStructuredOutput === true) return null;

  const direct = clean(result.primaryCause || result.diagnosis);
  // If a direct cause is present and is a known failure sentinel, do not let a
  // secondary probability entry rescue the result into trusted lifecycle state.
  if (direct) return isInvalidCauseText(direct) ? null : direct;

  const ranked = (Array.isArray(result.probability) ? result.probability : [])
    .map(item => ({
      cause: clean(item?.cause),
      likelihood: Number(item?.likelihood)
    }))
    .filter(item => item.cause && !isInvalidCauseText(item.cause))
    .sort((a, b) => {
      const aScore = Number.isFinite(a.likelihood) ? a.likelihood : -1;
      const bScore = Number.isFinite(b.likelihood) ? b.likelihood : -1;
      return bScore - aScore;
    });

  return ranked[0]?.cause || null;
}

function isValidDiagnosticCandidate(result) {
  return Boolean(selectDiagnosticCandidate(result));
}

function assertValidDiagnosticCandidate(result, message = 'A valid persisted diagnostic candidate is required') {
  const candidate = selectDiagnosticCandidate(result);
  if (!candidate) throw new Error(message);
  return candidate;
}

module.exports = {
  INVALID_EXACT_CAUSES,
  selectDiagnosticCandidate,
  isValidDiagnosticCandidate,
  assertValidDiagnosticCandidate
};
