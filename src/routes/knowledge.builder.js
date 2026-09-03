'use strict';

const express = require('express');
const router = express.Router();
const {
  COMMON_PLATFORM_CATALOG,
  COVERAGE_POLICY,
  CATALOG_VERSION,
  buildCommonVehicleCoverage,
  filterCoverage
} = require('../services/common.vehicle.knowledge.builder');

const SNAPSHOT_TTL_MS = Math.max(30000, Number(process.env.KNOWLEDGE_COVERAGE_CACHE_MS || 5 * 60 * 1000));
let cachedSnapshot = null;
let cachedAt = 0;
let inFlight = null;

async function getCoverageSnapshot() {
  const now = Date.now();
  if (cachedSnapshot && now - cachedAt < SNAPSHOT_TTL_MS) return { snapshot: cachedSnapshot, fromCache: true };
  if (!inFlight) {
    inFlight = buildCommonVehicleCoverage()
      .then(snapshot => {
        cachedSnapshot = snapshot;
        cachedAt = Date.now();
        return snapshot;
      })
      .finally(() => { inFlight = null; });
  }
  return { snapshot: await inFlight, fromCache: false };
}

router.get('/catalog', (req, res) => {
  res.json({
    success: true,
    policy: COVERAGE_POLICY,
    catalogVersion: CATALOG_VERSION,
    note: 'Curated common-service platform priority; not an exact annual sales ranking.',
    platforms: COMMON_PLATFORM_CATALOG
  });
});

router.get('/coverage', async (req, res) => {
  try {
    const { snapshot, fromCache } = await getCoverageSnapshot();
    const filtered = filterCoverage(snapshot, {
      make: req.query.make,
      model: req.query.model,
      year: req.query.year,
      limit: req.query.limit
    });
    return res.json({ success: true, fromCache, cacheTtlMs: SNAPSHOT_TTL_MS, ...filtered });
  } catch (error) {
    console.error('[Knowledge Builder] coverage failed:', error.stack || error.message || error);
    return res.status(500).json({
      success: false,
      error: 'Knowledge coverage build failed',
      details: error.message || 'Unknown error'
    });
  }
});

module.exports = router;
module.exports.getCoverageSnapshot = getCoverageSnapshot;
