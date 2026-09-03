#!/usr/bin/env node
'use strict';

const { buildCommonVehicleCoverage } = require('../src/services/common.vehicle.knowledge.builder');

function q(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

(async () => {
  const limit = Math.max(1, Math.min(100, Number(process.env.KNOWLEDGE_BUILD_LIMIT || 25)));
  const snapshot = await buildCommonVehicleCoverage();
  const items = (snapshot.items || []).slice(0, limit);

  console.log(`\nSKSK Common Vehicle Knowledge Builder`);
  console.log(`Policy: ${snapshot.policy}`);
  console.log(`Catalog: ${snapshot.catalogVersion}`);
  console.log(`Durable coverage: ${snapshot.summary.durableCoveragePercent}% (${snapshot.summary.durableReadyCount}/${snapshot.summary.targetYearMakeModels})`);
  console.log(`\nTop ${items.length} durable-corpus build priorities:\n`);

  items.forEach((item, index) => {
    console.log(`${String(index + 1).padStart(2, '0')}. ${item.year} ${item.make} ${item.model}`);
    console.log(`    priority=${item.priorityScore} coverage=${item.coverageScore}/100 official=${item.metrics.officialBulletins} verifiedRepairs=${item.metrics.verifiedRepairCases}`);
    console.log(`    gaps=${item.gaps.join(', ') || 'none'}`);
    if (item.gaps.includes('NO_OFFICIAL_PUBLISHED_EVIDENCE')) {
      console.log(`    official-ingest: NHTSA_TSB_YEAR=${item.year} NHTSA_TSB_MAKE=${q(item.make)} NHTSA_TSB_MODEL=${q(item.model)} node scripts/ingest-nhtsa-tsb-bulk.js`);
    }
    if (item.gaps.includes('NO_VERIFIED_REPAIR_OUTCOMES')) {
      console.log('    verified-outcomes: prioritize real TEST → CONFIRMS → VERIFY → completed-repair feedback for this vehicle');
    }
  });

  console.log('\nOptional manual-source rows never count toward durable readiness and are not copied by this planner.');
})().catch(error => {
  console.error('Knowledge ingestion plan failed:', error.stack || error.message || error);
  process.exit(1);
});
