const express = require('express');

function createLifecycleTestApp() {
  const app = express();
  app.use(express.json());

  const diagnose = require('../../src/routes/diagnose');
  const estimateHeuristic = require('../../src/routes/estimate.authorized');
  const jobsRouter = require('../../src/routes/jobs.protected');
  const { diagnosisLifecycle, estimateLifecycle } = require('../../src/middleware/job.lifecycle.middleware');

  // Mount the same public lifecycle routers and middleware used by api/server.js.
  app.use('/api/jobs', jobsRouter);
  app.use('/api/diagnose', diagnosisLifecycle, diagnose);
  app.use('/api/estimateHeuristic', estimateLifecycle, estimateHeuristic);

  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Server error' });
  });

  return app;
}

module.exports = { createLifecycleTestApp };
