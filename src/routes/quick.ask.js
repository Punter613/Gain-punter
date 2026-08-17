const express = require('express');
const router = express.Router();
const { QuickAskRetriever } = require('../core/knowledge/quick.ask.retriever');

router.post('/', async (req, res) => {
  try {
    const { vehicle = {}, query = '', limit = 5 } = req.body || {};
    const result = await new QuickAskRetriever().ask({ vehicle, query, limit });
    return res.json(result);
  } catch (error) {
    const status = /requires vehicle\.make and vehicle\.model/.test(error.message) ? 400 : 500;
    return res.status(status).json({
      status: 'ERROR',
      error: error.message,
      mode: 'RETRIEVAL_ONLY'
    });
  }
});

module.exports = router;
