'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const retiredFullEstimateRouter = require('../src/routes/full-estimate.protected');

test('legacy full-estimate route remains retired and points to verified estimate flow', async (t) => {
  const app = express();
  app.use('/api/full-estimate', retiredFullEstimateRouter);

  const server = app.listen(0);
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/full-estimate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vin: 'KNDJC736385765089' })
  });
  const body = await response.json();

  assert.equal(response.status, 410);
  assert.equal(body.success, false);
  assert.equal(body.replacement, '/api/estimateHeuristic');
  assert.equal(body.lifecycle, 'DIAGNOSE -> TEST -> VERIFY -> ESTIMATE');
  assert.match(body.error, /Legacy full-estimate route retired/);
});
