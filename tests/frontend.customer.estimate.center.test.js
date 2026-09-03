'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'estimate-center.html'), 'utf8');

test('estimate center supports lifecycle lookup and estimate-only lifecycle creation', () => {
  assert.match(html, /SKSK Lifecycle Number/);
  assert.match(html, /\/api\/jobs\/estimate-center\/job/);
  assert.match(html, /\/api\/jobs\/estimate-center\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(html, /New Estimate-Only Lifecycle/);
});

test('estimate center makes preliminary quote boundary explicit', () => {
  assert.match(html, /Quoting a repair is not the same as proving it is needed/);
  assert.match(html, /Preliminary estimates never become diagnostic truth/);
  assert.match(html, /does not convert a preliminary estimate into a verified diagnosis/);
  assert.match(html, /PRELIMINARY \/ CUSTOMER ESTIMATE/);
});

test('estimate center supports per-line authorization, deferral, revision and print', () => {
  assert.match(html, /AUTHORIZED/);
  assert.match(html, /DEFERRED/);
  assert.match(html, /DECLINED/);
  assert.match(html, /Save Decisions/);
  assert.match(html, /Create Revision/);
  assert.match(html, /window\.print\(\)/);
  assert.match(html, /Total authorized today/);
  assert.match(html, /Customer signature \/ authorization/);
});
