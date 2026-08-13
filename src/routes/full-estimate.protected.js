const express = require('express');
const router = express.Router();

// The legacy combined route contained an emergency rescue engine that could
// manufacture replacement/economic output when its orchestrator failed. Keep the
// URL explicit, but retire the behavior. The supported production path is now:
// Diagnose -> record test -> explicit VERIFY -> /api/estimateHeuristic.
router.all('/', (req, res) => {
  return res.status(410).json({
    success: false,
    error: 'Legacy full-estimate route retired. Complete diagnosis verification before estimate generation.',
    replacement: '/api/estimateHeuristic',
    lifecycle: 'DIAGNOSE -> TEST -> VERIFY -> ESTIMATE'
  });
});

module.exports = router;
