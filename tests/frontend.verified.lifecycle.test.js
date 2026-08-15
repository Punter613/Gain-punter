'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'lifecycle.html'), 'utf8');
const redirects = fs.readFileSync(path.join(__dirname, '..', 'public', '_redirects'), 'utf8');

test('public root enters the verified lifecycle UI', () => {
  assert.match(redirects, /^\/ \/lifecycle\.html 200/m);
  assert.match(html, /DIAGNOSE/);
  assert.match(html, /TEST/);
  assert.match(html, /VERIFY/);
  assert.match(html, /ESTIMATE/);
  assert.match(html, /INVOICE/);
});

test('frontend exposes explicit verify action before estimate unlock', () => {
  assert.match(html, /id="verify"[^>]*>✅ VERIFY FAULT — Unlock Estimate/);
  assert.match(html, /\/api\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/tests/);
  assert.match(html, /\/api\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/verify/);
  assert.match(html, /d\.status!==['"]VERIFIED['"]\|\|!d\.verifiedCase/);
});

test('estimate and invoice follow the same persisted job', () => {
  assert.match(html, /post\(['"]\/api\/estimateHeuristic['"],\{jobId/);
  assert.match(html, /post\(['"]\/api\/invoice\/build['"],\{jobId\}\)/);
  assert.doesNotMatch(html, /post\(['"]\/api\/invoice\/build['"],\{jobId,estimate:/);
});

test('not verified keeps estimate locked', () => {
  assert.match(html, /Not verified\. Continue testing; estimate remains locked\./);
  assert.match(html, /\$\('estimateCard'\)\.hidden=true/);
});
