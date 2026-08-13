'use strict';

function clean(value) {
  return String(value || '').trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function normalizeVerification(input = {}) {
  const verifiedFaults = asArray(input.verifiedFaults || input.verifiedRepairs || input.confirmedFaults)
    .map(item => typeof item === 'string' ? { component: clean(item), finding: clean(item) } : item)
    .filter(item => item && (clean(item.component) || clean(item.finding) || clean(item.cause)));

  const diagnosticTests = asArray(input.diagnosticTests).filter(Boolean);
  const explicitVerified = input.diagnosisVerified === true || input.verificationStatus === 'VERIFIED';

  return {
    status: explicitVerified || verifiedFaults.length ? 'VERIFIED' : 'UNVERIFIED',
    verifiedFaults,
    diagnosticTests,
    explicitVerified
  };
}

function evaluateRepairAuthorization(input = {}) {
  const verification = normalizeVerification(input);
  const authorized = verification.status === 'VERIFIED' && verification.verifiedFaults.length > 0;

  return {
    authorized,
    status: authorized ? 'REPAIR_AUTHORIZED' : 'DIAGNOSIS_REQUIRED',
    reason: authorized
      ? 'At least one fault has explicit verification evidence and a bounded repair scope.'
      : 'No bounded verified fault was supplied. Continue diagnosis and discriminating tests before authorizing repair parts/labor.',
    verification,
    repairScope: authorized ? verification.verifiedFaults : []
  };
}

function buildStagedRepairPlan(items = []) {
  return asArray(items)
    .map((item, index) => {
      const source = typeof item === 'string' ? { component: item } : (item || {});
      const safety = Number(source.safetyPriority || source.safety || 0);
      const damage = Number(source.damagePropagationRisk || source.damageRisk || 0);
      const dependency = Number(source.repairDependencyRisk || source.dependencyRisk || 0);
      const leverage = Number(source.diagnosticLeverage || source.causalLeverage || 0);
      const affordability = Number(source.affordabilityPriority || 0);
      const score = safety * 5 + damage * 4 + dependency * 4 + leverage * 2 + affordability;
      return {
        ...source,
        stageScore: score,
        originalOrder: index,
        retestRequired: source.retestRequired !== false
      };
    })
    .sort((a, b) => b.stageScore - a.stageScore || a.originalOrder - b.originalOrder)
    .map((item, index) => ({ ...item, stage: index + 1 }));
}

module.exports = {
  normalizeVerification,
  evaluateRepairAuthorization,
  buildStagedRepairPlan
};
