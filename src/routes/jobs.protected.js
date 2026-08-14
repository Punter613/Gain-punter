const express = require('express');
const router = express.Router();
const jobsRouter = require('./jobs');

// Protective boundary in front of the existing jobs router.
// A positive VERIFY action must name the bounded fault explicitly.
router.post('/:id/verify', (req, res, next) => {
  const body = req.body || {};
  const confirmedCause = String(body.confirmedCause || '').trim();

  if (body.confirmed === true && !confirmedCause) {
    return res.status(409).json({
      success: false,
      error: 'Verification requires an explicit confirmed cause/fault.',
      jobId: req.params.id,
      status: 'TESTING'
    });
  }

  return next();
});

router.use(jobsRouter);

module.exports = router;
