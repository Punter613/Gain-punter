const express = require('express');
const router = express.Router();
const estimateRouter = require('./estimate');
const { evaluateRepairAuthorization } = require('../core/orchestrator/repair.authorization.guard');

router.post('/', (req, res, next) => {
  const result = evaluateRepairAuthorization(req.body || {});
  if (!result.authorized) {
    return res.status(409).json({
      success: false,
      error: 'Verification is required before estimate generation.',
      status: result.status,
      authorization: result
    });
  }

  req.repairAuthorization = result;
  return next();
});

router.use(estimateRouter);

module.exports = router;
