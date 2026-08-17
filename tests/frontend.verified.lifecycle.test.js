'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'lifecycle.html'), 'utf8');
const redirects = fs.readFileSync(path.join(__dirname, '..', 'public', '_redirects'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'api', 'server.js'), 'utf8');

test('public root enters the verified lifecycle UI', () => {
  assert.match(redirects, /^\/ \/lifecycle\.html 200/m);
  assert.match(html, /DIAGNOSE/);
  assert.match(html, /TEST/);
  assert.match(html, /VERIFY/);
  assert.match(html, /ESTIMATE/);
  assert.match(html, /INVOICE/);
});

test('frontend captures engine trim and sends engine plus DTC context through retrieval', () => {
  assert.match(html, /<label>Engine \/ Trim<\/label><input id="engine"/);
  const enginePayloadUses = html.match(/engine:\$\('engine'\)\.value\.trim\(\)/g) || [];
  assert.equal(enginePayloadUses.length, 2);
  assert.match(html, /const codeContext=list\(\$\('codes'\)\.value\)\.join\(' '\)/);
  assert.match(html, /query:retrievalQuery/);
});

test('lifecycle restores explicit VIN decode autofill and shared customer-language normalization', () => {
  assert.match(html, /id="decodeVin"[^>]*>🔍 Decode/);
  assert.match(html, /post\('\/api\/vehicle\/decode',\{vin\}\)/);
  assert.match(html, /\$\('year'\)\.value=v\.year\|\|''/);
  assert.match(html, /\$\('make'\)\.value=v\.make\|\|''/);
  assert.match(html, /\$\('model'\)\.value=v\.model\|\|''/);
  assert.match(html, /\$\('engine'\)\.value=engineLabel/);
  assert.match(html, /id="translateSymptoms"[^>]*>🔄 Translate to Tech/);
  assert.match(html, /post\('\/api\/translate',\{text:raw\}\)/);
  assert.match(html, /el\.dataset\.aiTranslation=d\.translated\|\|''/);
  assert.match(html, /el\.dataset\.aiKeywords=JSON\.stringify/);
  assert.doesNotMatch(html, /\$\('symptoms'\)\.value=d\.translated/);
  assert.match(serverSource, /app\.use\('\/api\/translate'/);
  assert.match(serverSource, /app\.use\('\/api\/vehicle'/);
});

test('normalizer keywords narrow both diagnosis evidence and Customer States fallback Quick Ask', () => {
  assert.match(html, /function translatedSymptomContext\(\)/);
  assert.match(html, /keywords:translated\.keywords/);
  assert.match(html, /const retrievalQuery=\[query,translatedContext,keywordContext,codeContext\]/);
  assert.match(html, /symptoms:lines\(\$\('symptoms'\)\.value\)/);
});

test('Run Diagnosis and Ask SKSK are equally prominent major actions', () => {
  assert.match(html, /\.btn\.major\{flex:1;min-width:220px/);
  assert.match(html, /id="diag" class="btn primary major"/);
  assert.match(html, /id="quickAsk" class="btn knowledge major"/);
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
  assert.match(html, /placeholder.*do not count as evidence/i);
});

test('Quick Ask presents focused service-manual pointers rather than scraped text dumps', () => {
  assert.match(html, /Service Manual Reference/);
  assert.match(html, /Matched keywords:/);
  assert.match(html, /Open service-manual reference/);
  assert.match(html, /External service-manual reference/);
  assert.match(html, /No focused service-manual reference found for these keywords/);
  assert.doesNotMatch(html, /\$\{m\.snippet\?/);
  assert.doesNotMatch(html, /\$\{esc\(m\.source\|\|d\.repairDiagnosisSource/);
});

test('Quick Ask visibly warns when a bounded retrieval source may be partial', () => {
  assert.match(html, /scanWarnings=.*scan bound/);
  assert.match(html, /Retrieval bound reached\./);
  assert.match(html, /status warn/);
});

test('Render PR preview can call its own API without opening CORS to arbitrary Render apps', () => {
  assert.match(serverSource, /\^p613-backend-pr-\\d\+\\\.onrender\\\.com\$/);
  assert.doesNotMatch(serverSource, /hostname\.endsWith\(['"]\.onrender\.com['"]\)/);
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
