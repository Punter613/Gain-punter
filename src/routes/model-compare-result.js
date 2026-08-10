const express = require('express');
const router = express.Router();
const { runComparison } = require('../../scripts/compare-diagnose-models');

const state = {
  status: 'pending',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  result: null,
  error: null
};

(async () => {
  if (!process.env.GROQ_API_KEY) {
    state.status = 'error';
    state.error = 'GROQ_API_KEY is not configured on this runtime.';
    state.finishedAt = new Date().toISOString();
    return;
  }

  try {
    state.status = 'running';
    state.result = await runComparison(process.env.GROQ_API_KEY);
    state.status = 'complete';
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
  } finally {
    state.finishedAt = new Date().toISOString();
  }
})();

router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(state.status === 'complete' ? 200 : state.status === 'error' ? 500 : 202).json({
    success: state.status === 'complete',
    temporary: true,
    ...state
  });
});

module.exports = router;
