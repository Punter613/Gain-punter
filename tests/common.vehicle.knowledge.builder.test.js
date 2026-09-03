'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COVERAGE_POLICY,
  buildCoverageSnapshot,
  filterCoverage
} = require('../src/services/common.vehicle.knowledge.builder');

const catalog = [
  { make: 'Kia', model: 'Sorento', fromYear: 2022, toYear: 2023, marketPriority: 90 },
  { make: 'Honda', model: 'Odyssey', fromYear: 2023, toYear: 2023, marketPriority: 80 }
];

function repair(id, year, make, model, correctionCount = 0) {
  return {
    id,
    request_id: id.split('-')[0],
    stored_at: `2026-09-0${correctionCount + 1}T00:00:00.000Z`,
    metadata: { trustedForTraining: true, createdAt: `2026-09-0${correctionCount + 1}T00:00:00.000Z` },
    labels: {
      vehicle: { year, make, model },
      confirmedRepairCase: { correctionCount }
    }
  };
}

test('durable coverage ignores optional manual rows as readiness evidence', () => {
  const snapshot = buildCoverageSnapshot({
    catalog,
    tsbRows: [
      { id: 'l1', year: 2022, make: 'Kia', model: 'Sorento', source: 'LEMON_MANUALS', bulletin_number: 'L-1', group_name: 'ENGINE' }
    ],
    repairRows: []
  });

  const sorento = snapshot.items.find(item => item.year === 2022 && item.make === 'Kia');
  assert.equal(snapshot.policy, COVERAGE_POLICY);
  assert.equal(sorento.metrics.optionalEvidence, 1);
  assert.equal(sorento.metrics.officialBulletins, 0);
  assert.equal(sorento.metrics.verifiedRepairCases, 0);
  assert.equal(sorento.durableReady, false);
  assert.ok(sorento.gaps.includes('OPTIONAL_SOURCE_DEPENDENCE'));
  assert.equal(snapshot.sourceRules.optionalExternalCountsTowardDurableCoverage, false);
  assert.equal(snapshot.sourceRules.rawOptionalManualContentReturned, false);
});

test('official NHTSA rows plus verified outcomes raise coverage and system breadth', () => {
  const snapshot = buildCoverageSnapshot({
    catalog,
    tsbRows: [
      { id: 'n1', year: 2023, make: 'Honda', model: 'Odyssey', source: 'NHTSA_BULK', bulletin_number: 'A-1', group_name: 'ENGINE' },
      { id: 'n2', year: 2023, make: 'Honda', model: 'Odyssey', source: 'NHTSA_BULK', bulletin_number: 'A-2', group_name: 'ELECTRICAL' },
      { id: 'n3', year: 2023, make: 'Honda', model: 'Odyssey', source: 'NHTSA_BULK', bulletin_number: 'A-3', group_name: 'BRAKES' }
    ],
    repairRows: [repair('job1-0', 2023, 'Honda', 'Odyssey')]
  });

  const odyssey = snapshot.items.find(item => item.make === 'Honda');
  assert.equal(odyssey.metrics.officialBulletins, 3);
  assert.equal(odyssey.metrics.verifiedRepairCases, 1);
  assert.equal(odyssey.metrics.systemBreadth, 3);
  assert.equal(odyssey.durableReady, true);
  assert.ok(odyssey.coverageScore > 0);
  assert.equal(odyssey.gaps.includes('NO_DURABLE_EVIDENCE'), false);
});

test('corrected verified repair outcomes dedupe to the newest repair case', () => {
  const snapshot = buildCoverageSnapshot({
    catalog,
    tsbRows: [],
    repairRows: [
      repair('jobA-old', 2023, 'Kia', 'Sorento', 0),
      repair('jobA-new', 2023, 'Kia', 'Sorento', 1)
    ]
  });

  const sorento = snapshot.items.find(item => item.year === 2023 && item.make === 'Kia');
  assert.equal(sorento.metrics.verifiedRepairCases, 1);
});

test('priority ranking favors high-service-priority platforms with larger gaps', () => {
  const snapshot = buildCoverageSnapshot({
    catalog,
    tsbRows: [
      { id: 'n1', year: 2023, make: 'Honda', model: 'Odyssey', source: 'NHTSA_BULK', bulletin_number: 'A-1', group_name: 'ENGINE' },
      { id: 'n2', year: 2023, make: 'Honda', model: 'Odyssey', source: 'NHTSA_BULK', bulletin_number: 'A-2', group_name: 'BRAKES' },
      { id: 'n3', year: 2023, make: 'Honda', model: 'Odyssey', source: 'NHTSA_BULK', bulletin_number: 'A-3', group_name: 'ELECTRICAL' }
    ],
    repairRows: [repair('job2-0', 2023, 'Honda', 'Odyssey')]
  });

  assert.equal(snapshot.items[0].make, 'Kia');
  assert.ok(snapshot.items[0].recommendedActions.includes('PRIORITIZE_FOR_DURABLE_CORPUS_BUILD'));
});

test('coverage filter limits and scopes the ranked output', () => {
  const snapshot = buildCoverageSnapshot({ catalog, tsbRows: [], repairRows: [] });
  const filtered = filterCoverage(snapshot, { make: 'Kia', year: 2023, limit: 1 });
  assert.equal(filtered.returned, 1);
  assert.equal(filtered.items[0].make, 'Kia');
  assert.equal(filtered.items[0].year, 2023);
});
