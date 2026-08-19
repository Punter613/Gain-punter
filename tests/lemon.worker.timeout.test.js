'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveHardTimeoutMs } = require('../src/services/lemon.worker');

test('normal 20s crawler keeps the existing 30s worker hard wall', () => {
  assert.equal(resolveHardTimeoutMs({ maxElapsedMs: 20000, hardTimeoutMs: 30000 }), 30000);
});

test('short navigation probe gets bounded resolver plus startup headroom without widening its crawl budget', () => {
  assert.equal(resolveHardTimeoutMs({ maxElapsedMs: 4500, hardTimeoutMs: 6500 }), 16500);
});

test('explicit larger hard timeout is preserved', () => {
  assert.equal(resolveHardTimeoutMs({ maxElapsedMs: 4500, hardTimeoutMs: 20000 }), 20000);
});
