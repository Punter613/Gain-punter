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

test('frontend does not prefill the diagnostic hypothesis as the confirmed fault', () => {
  assert.match(html, /\$\('candidate'\)\.textContent=cause;\$\('cause'\)\.value=''/);
  assert.doesNotMatch(html, /\$\('cause'\)\.value=cause/);
  assert.match(html, /Diagnostic candidate — hypothesis only/);
});

test('frontend requires selected persisted tests and mechanic conclusion for positive VERIFY', () => {
  assert.match(html, /id="verifyEvidence"/);
  assert.match(html, /class="verifyEvidenceCheck"/);
  assert.match(html, /evidenceTestIds=\[\.\.\.document\.querySelectorAll\('\.verifyEvidenceCheck:checked'\)\]/);
  assert.match(html, /Select at least one recorded test that supports this confirmed fault/);
  assert.match(html, /Explain why the selected test evidence confirms this fault/);
  assert.match(html, /placeholders do not count as evidence/i);
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
