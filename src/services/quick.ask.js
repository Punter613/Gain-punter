'use strict';

const STOP_WORDS = new Set([
  'a','an','and','are','as','at','be','been','but','by','can','cause','causes','could','do','does','for','from',
  'have','how','i','in','is','it','my','of','on','or','the','this','to','was','what','when','where','which','with','would'
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase();
}

function tokens(value) {
  return [...new Set(
    norm(value)
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(token => token.length >= 3 && !STOP_WORDS.has(token))
  )];
}

function textScore(text, queryTokens) {
  if (!queryTokens.length) return 1;
  const haystack = norm(text);
  if (!haystack) return 0;
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function sameVehicle(candidate = {}, vehicle = {}) {
  const year = Number(vehicle.year) || null;
  const candidateYear = Number(candidate.year) || null;
  if (year && candidateYear && year !== candidateYear) return false;
  if (vehicle.make && norm(candidate.make) !== norm(vehicle.make)) return false;
  if (vehicle.model && norm(candidate.model) !== norm(vehicle.model)) return false;
  return true;
}

function latestTrustedRows(rows = []) {
  const latestByJob = new Map();
  for (const row of rows) {
    const metadata = row?.metadata || {};
    const labels = row?.labels || {};
    if (metadata.trustedForTraining !== true) continue;
    const jobKey = row.request_id || row.id;
    const correctionCount = Number(labels.confirmedRepairCase?.correctionCount || 0);
    const current = latestByJob.get(jobKey);
    const currentCorrectionCount = Number(current?.labels?.confirmedRepairCase?.correctionCount || 0);
    const rowTime = new Date(row.stored_at || 0).getTime();
    const currentTime = new Date(current?.stored_at || 0).getTime();
    if (!current || correctionCount > currentCorrectionCount || (correctionCount === currentCorrectionCount && rowTime > currentTime)) {
      latestByJob.set(jobKey, row);
    }
  }
  return [...latestByJob.values()];
}

function extractCause(row) {
  const ai = row?.labels?.rawAiOutput || {};
  return clean(ai.primaryCause || ai.diagnosis || ai.cause || '');
}

function rankConfirmedRepairs(rows = [], vehicle = {}, question = '') {
  const queryTokens = tokens(question);
  const latest = latestTrustedRows(rows);
  const matched = [];

  for (const row of latest) {
    const labels = row.labels || {};
    const candidateVehicle = labels.vehicle || row.metadata?.vehicle || {};
    if (!sameVehicle(candidateVehicle, vehicle)) continue;

    const cause = extractCause(row);
    if (!cause) continue;
    const searchable = JSON.stringify(labels.rawAiOutput || {});
    const score = textScore(`${cause} ${searchable}`, queryTokens);
    if (queryTokens.length && score === 0) continue;

    matched.push({
      cause,
      score,
      assessment: labels.mechanicAssessment?.diagnosisCorrect || null,
      fixWorked: labels.mechanicAssessment?.fixWorked ?? null,
      jobId: row.request_id || null
    });
  }

  const denominator = matched.length;
  const groups = new Map();
  for (const item of matched) {
    if (item.assessment !== 'correct' || item.fixWorked !== true) continue;
    const key = norm(item.cause);
    const existing = groups.get(key) || { cause: item.cause, supportCount: 0, score: 0, jobIds: [] };
    existing.supportCount += 1;
    existing.score += item.score;
    if (item.jobId) existing.jobIds.push(item.jobId);
    groups.set(key, existing);
  }

  return [...groups.values()]
    .map(group => ({
      cause: group.cause,
      supportCount: group.supportCount,
      sampleSize: denominator,
      probability: denominator ? Number((group.supportCount / denominator).toFixed(3)) : null,
      basis: 'confirmed_repair_outcomes'
    }))
    .sort((a, b) => b.supportCount - a.supportCount || b.probability - a.probability)
    .slice(0, 5);
}

function rankTsbEvidence(rows = [], question = '') {
  const queryTokens = tokens(question);
  return rows
    .map(row => ({
      row,
      score: textScore(`${row.title || ''} ${row.subject || ''} ${row.group_name || ''} ${row.body_text || ''}`, queryTokens)
    }))
    .filter(item => !queryTokens.length || item.score > 0)
    .sort((a, b) => b.score - a.score || String(b.row.bulletin_date || '').localeCompare(String(a.row.bulletin_date || '')))
    .slice(0, 5)
    .map(({ row, score }) => ({
      bulletinNumber: row.bulletin_number || null,
      date: row.bulletin_date || null,
      title: row.title || row.subject || 'Manufacturer communication',
      subject: row.subject || row.group_name || null,
      summary: clean(row.body_text).slice(0, 500),
      source: row.source || 'NHTSA_BULK',
      sourceUrl: row.source_url || null,
      relevanceScore: score
    }));
}

function buildQuickAskResponse({ vehicle = {}, question = '', feedbackRows = [], tsbRows = [] } = {}) {
  const commonFindings = rankConfirmedRepairs(feedbackRows, vehicle, question);
  const publishedEvidence = rankTsbEvidence(tsbRows, question);
  const confirmedSampleSize = commonFindings.length ? Math.max(...commonFindings.map(item => item.sampleSize || 0)) : 0;

  return {
    vehicle: {
      year: Number(vehicle.year) || null,
      make: clean(vehicle.make),
      model: clean(vehicle.model)
    },
    question: clean(question),
    commonFindings,
    confirmedSampleSize,
    publishedEvidence,
    evidenceCount: publishedEvidence.length,
    boundaries: {
      repairAuthorized: false,
      verified: false,
      probabilityBasis: 'Only eligible confirmed repair outcomes contribute to probability. TSB counts never become diagnostic probability.'
    }
  };
}

module.exports = {
  tokens,
  textScore,
  sameVehicle,
  latestTrustedRows,
  rankConfirmedRepairs,
  rankTsbEvidence,
  buildQuickAskResponse
};
