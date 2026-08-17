'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  latestTrustedRows,
  rankConfirmedRepairs,
  rankTsbEvidence,
  buildQuickAskResponse
} = require('../src/services/quick.ask');

function feedback({ id, jobId, cause, result = 'correct', fixWorked = true, correctionCount = 0, storedAt = '2026-08-17T00:00:00Z', vehicle = { year: 2008, make: 'Kia', model: 'Sorento' } }) {
  return {
    id,
    request_id: jobId,
    stored_at: storedAt,
    metadata: { trustedForTraining: true },
    labels: {
      vehicle,
      rawAiOutput: { primaryCause: cause, notes: `${cause} symptom evidence` },
      mechanicAssessment: { diagnosisCorrect: result, fixWorked },
      confirmedRepairCase: { correctionCount }
    }
  };
}

test('Quick Ask keeps only the latest trusted correction per job', () => {
  const rows = [
    feedback({ id: 'old', jobId: 'J1', cause: 'Wrong old cause', result: 'wrong', fixWorked: false, correctionCount: 0 }),
    feedback({ id: 'new', jobId: 'J1', cause: 'A/C compressor clutch bearing', correctionCount: 1, storedAt: '2026-08-17T01:00:00Z' })
  ];
  const latest = latestTrustedRows(rows);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].id, 'new');
});

test('probability comes only from confirmed repair outcomes, not TSB counts', () => {
  const rows = [
    feedback({ id: '1', jobId: 'J1', cause: 'A/C compressor clutch bearing' }),
    feedback({ id: '2', jobId: 'J2', cause: 'A/C compressor clutch bearing' }),
    feedback({ id: '3', jobId: 'J3', cause: 'Idler pulley bearing', result: 'wrong', fixWorked: false })
  ];
  const findings = rankConfirmedRepairs(rows, { year: 2008, make: 'Kia', model: 'Sorento' }, 'bearing noise');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].cause, 'A/C compressor clutch bearing');
  assert.equal(findings[0].supportCount, 2);
  assert.equal(findings[0].sampleSize, 3);
  assert.equal(findings[0].probability, 0.667);
  assert.equal(findings[0].basis, 'confirmed_repair_outcomes');
});

test('TSB evidence is ranked separately and never changes repair probability', () => {
  const tsbs = [
    { bulletin_number: 'A', bulletin_date: '2024-01-01', title: 'Brake lamp', body_text: 'Brake lamp switch', source: 'NHTSA_BULK' },
    { bulletin_number: 'B', bulletin_date: '2023-01-01', title: 'A/C noise', body_text: 'Air conditioning compressor bearing noise', source: 'NHTSA_BULK' }
  ];
  const ranked = rankTsbEvidence(tsbs, 'compressor noise');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].bulletinNumber, 'B');
});

test('Quick Ask response is explicitly non-authorizing and non-verified', () => {
  const answer = buildQuickAskResponse({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    question: 'whining with ac on',
    feedbackRows: [],
    tsbRows: []
  });
  assert.equal(answer.boundaries.repairAuthorized, false);
  assert.equal(answer.boundaries.verified, false);
  assert.match(answer.boundaries.probabilityBasis, /confirmed repair outcomes/i);
});
