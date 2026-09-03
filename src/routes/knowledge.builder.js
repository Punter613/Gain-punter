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
    const snapshot = await buildCommonVehicleCoverage();
    const filtered = filterCoverage(snapshot, {
      make: req.query.make,
      model: req.query.model,
      year: req.query.year,
      limit: req.query.limit
    });
    return res.json({ success: true, ...filtered });
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
