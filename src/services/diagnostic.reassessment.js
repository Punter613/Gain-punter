'use strict';

const { aiChat } = require('./ai/aiClient');

function clean(value, max = 1200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function list(values, maxItems = 20, maxLen = 800) {
  return (Array.isArray(values) ? values : [])
    .map(value => clean(value, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function extractJSON(text) {
  if (!text) return null;
  const normalized = String(text).replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  const start = normalized.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < normalized.length; i++) {
    if (normalized[i] === '{') depth++;
    if (normalized[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(normalized.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

function hasNewEvidenceSinceDiagnosis(job = {}) {
  const diagnosisAt = Date.parse(job.diagnosis?.recordedAt || '') || 0;
  return (job.tests || []).some(test => (Date.parse(test?.recordedAt || '') || 0) > diagnosisAt);
}

function symptomRequiresVehicleMotion(job = {}) {
  const text = [
    ...(job.intake?.customerStates || []),
    ...(job.tests || []).map(test => `${test?.name || ''} ${test?.result || ''} ${test?.notes || ''}`)
  ].join(' ').toLowerCase();
  return /(deceler|off[- ]?throttle|throttle release|releasing (?:the )?accelerator|torque reversal|while driving|road[- ]?test|vehicle speed|under load)/i.test(text);
}

function isStationaryOnlyTest(test = '') {
  const text = clean(test, 800).toLowerCase();
  return /(wiggle|move|tap).*(connector|sensor|harness).*(engine running|idle)|engine running.*(wiggle|move|tap).*(connector|sensor|harness)/i.test(text)
    && !/(road|driv|moving|deceler|vehicle speed|under load)/i.test(text);
}

function normalizeProbability(values = []) {
  const byCause = new Map();
  for (const item of Array.isArray(values) ? values : []) {
    const cause = clean(item?.cause, 300);
    if (!cause) continue;
    const key = cause.toLowerCase();
    const likelihood = Number(item?.likelihood);
    const normalized = Number.isFinite(likelihood) ? Math.max(0, Math.min(100, Math.round(likelihood))) : null;
    const prior = byCause.get(key);
    if (!prior || (normalized ?? -1) > (prior.likelihood ?? -1)) byCause.set(key, { cause, likelihood: normalized });
  }
  return [...byCause.values()].sort((a, b) => (b.likelihood ?? 0) - (a.likelihood ?? 0)).slice(0, 8);
}

function normalizeConfidence(value = {}, fallback = {}) {
  const rawPercentage = Number(value?.percentage);
  const fallbackPercentage = Number(fallback?.percentage);
  const percentage = Number.isFinite(rawPercentage)
    ? Math.max(0, Math.min(100, Math.round(rawPercentage)))
    : Number.isFinite(fallbackPercentage)
      ? Math.max(0, Math.min(100, Math.round(fallbackPercentage)))
      : 30;
  const supplied = clean(value?.rating || fallback?.rating, 20).toUpperCase();
  const rating = ['LOW', 'MODERATE', 'MEDIUM', 'HIGH'].includes(supplied)
    ? (supplied === 'MEDIUM' ? 'MODERATE' : supplied)
    : percentage >= 80 ? 'HIGH' : percentage >= 50 ? 'MODERATE' : 'LOW';
  return { percentage, rating };
}

function sanitizeNotes(notes, dtcs = []) {
  let output = clean(notes, 1200);
  if (dtcs.length && /no dtcs? (?:are )?(?:present|stored|available)/i.test(output)) {
    output = output.replace(/(?:^|[.!?]\s*)[^.!?]*no dtcs? (?:are )?(?:present|stored|available)[^.!?]*[.!?]?/ig, ' ').replace(/\s+/g, ' ').trim();
    output = `${output}${output ? ' ' : ''}DTC context is present and must be interpreted with the rest of the case evidence.`;
  }
  return output;
}

function sanitizeReassessment(job = {}, previous = {}, candidate = {}) {
  const primaryCause = clean(candidate.primaryCause || candidate.diagnosis || previous.primaryCause || previous.diagnosis, 300);
  const primaryKey = primaryCause.toLowerCase();
  const probability = normalizeProbability(candidate.probability?.length ? candidate.probability : previous.probability);
  const seenSecondary = new Set();
  const secondaryCauses = [
    ...list(candidate.secondaryCauses, 8, 300),
    ...probability.map(item => item.cause)
  ].filter(cause => {
    const key = cause.toLowerCase();
    if (!key || key === primaryKey || seenSecondary.has(key)) return false;
    seenSecondary.add(key);
    return true;
  }).slice(0, 5);

  let recommendedTests = list(candidate.recommendedTests?.length ? candidate.recommendedTests : previous.recommendedTests, 12, 800);
  if (symptomRequiresVehicleMotion(job)) recommendedTests = recommendedTests.filter(test => !isStationaryOnlyTest(test));

  return {
    ...previous,
    ...candidate,
    primaryCause,
    secondaryCauses,
    probability,
    recommendedTests,
    notes: sanitizeNotes(candidate.notes ?? previous.notes, list(job.intake?.obdCodes, 12, 30)),
    diagnosticConfidence: normalizeConfidence(candidate.diagnosticConfidence, previous.diagnosticConfidence),
    reassessment: {
      applied: true,
      reason: 'NEW_TEST_EVIDENCE',
      evidenceCount: Array.isArray(job.tests) ? job.tests.length : 0,
      reassessedAt: new Date().toISOString()
    }
  };
}

function buildReassessmentPayload(job = {}) {
  const previous = job.diagnosis?.result || {};
  return {
    vehicle: job.vehicle || {},
    dtcs: list(job.intake?.obdCodes, 12, 30),
    customerStates: list(job.intake?.customerStates, 8, 500),
    mechanicNotices: list(job.intake?.mechanicNotices, 8, 500),
    previousDiagnosis: {
      primaryCause: clean(previous.primaryCause || previous.diagnosis, 300),
      secondaryCauses: list(previous.secondaryCauses, 8, 300),
      probability: normalizeProbability(previous.probability),
      recommendedTests: list(previous.recommendedTests, 12, 800),
      diagnosticConfidence: previous.diagnosticConfidence || null
    },
    recordedEvidence: (job.tests || []).map(test => ({
      id: clean(test?.id, 120),
      name: clean(test?.name, 500),
      result: clean(test?.result, 800),
      notes: clean(test?.notes, 500),
      passed: typeof test?.passed === 'boolean' ? test.passed : null,
      evidenceRole: clean(test?.evidenceRole || 'NEUTRAL', 30).toUpperCase(),
      confirmedFault: clean(test?.confirmedFault, 300),
      recordedAt: test?.recordedAt || null
    }))
  };
}

async function reassessDiagnosis(job = {}) {
  if (!job.diagnosis?.result || !hasNewEvidenceSinceDiagnosis(job)) return null;
  const previous = job.diagnosis.result;
  const packet = buildReassessmentPayload(job);
  const systemPrompt = `You are SKSK ProTech's diagnostic reassessment unit. Re-rank an existing diagnosis after NEW mechanic test evidence has been recorded. Return one JSON object only.\n\nRequired shape:\n{"primaryCause":"string","secondaryCauses":["string"],"probability":[{"cause":"string","likelihood":0}],"recommendedTests":["string"],"notes":"string","diagnosticConfidence":{"percentage":0,"rating":"LOW|MODERATE|HIGH"}}\n\nRules:\n- New physical observations and measurements can and should overturn the previous hypothesis when they conflict with it. Do not anchor on recently replaced parts merely because they are mentioned.\n- Rank causes by the full evidence packet, especially the operating condition under which the symptom occurs.\n- Evidence roles are semantic boundaries: NEUTRAL is an observation only; SUPPORTS raises a hypothesis but does not verify it; REFUTES lowers a hypothesis; CONFIRMS is mechanic-classified confirmation evidence tied to a named confirmedFault.\n- Use words such as observed, reproduced, supports, or points toward for NEUTRAL/SUPPORTS evidence. Do not say that a component fault was confirmed unless the packet contains matching CONFIRMS evidence for that named fault.\n- Distinguish separate faults when evidence supports more than one condition.\n- Never call an unverified cause repair-authorized.\n- recommendedTests must be physically possible and must reproduce or discriminate the actual operating condition. If a symptom occurs only while the vehicle is moving, do not propose a stationary-only test as though it can reproduce that symptom.\n- Do not duplicate the primary cause in secondaryCauses.\n- If DTCs are supplied, never say that no DTCs are present.\n- probability values are candidate weights, not physical-verification confidence.\n- diagnosticConfidence represents confidence in the current diagnostic direction based on evidence sufficiency, not the top candidate's weight.\n- Do not invent TSBs, measurements, completed repairs, components, or vehicle-specific facts absent from the packet.`;

  const aiRes = await aiChat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `CASE_WITH_NEW_EVIDENCE:\n${JSON.stringify(packet)}` }
    ],
    max_tokens: 1800,
    temperature: 0.1,
    reasoning_effort: 'low',
    response_format: { type: 'json_object' }
  });
  const text = typeof aiRes === 'string' ? aiRes : (aiRes?.choices?.[0]?.message?.content || '');
  const parsed = extractJSON(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('Diagnostic reassessment returned invalid JSON');
  return sanitizeReassessment(job, previous, parsed);
}

module.exports = {
  buildReassessmentPayload,
  hasNewEvidenceSinceDiagnosis,
  normalizeProbability,
  reassessDiagnosis,
  sanitizeReassessment,
  symptomRequiresVehicleMotion,
  isStationaryOnlyTest
};
