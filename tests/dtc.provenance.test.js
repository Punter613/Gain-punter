'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDtcCode,
  normalizeDtcEvidence,
  resolveRequestDtcEvidence,
  trustedDtcCodes,
  summarizeDtcProvenance,
  publicDtcEvidence
} = require('../src/core/evidence/dtc.provenance');

test('DTC syntax stays aligned with provider schema', () => {
  assert.equal(normalizeDtcCode('p0300'), 'P0300');
  assert.equal(normalizeDtcCode(' U0100 '), 'U0100');
  assert.equal(normalizeDtcCode('P4000'), '');
  assert.equal(normalizeDtcCode('P03ZZ'), '');
  assert.equal(normalizeDtcCode('not-a-code'), '');
});

test('only explicitly verified scan-tool records become trusted diagnostic codes', () => {
  const records = normalizeDtcEvidence([
    { code: 'P0300', source: 'SCAN_TOOL', verified: true },
    { code: 'P0171', source: 'SCAN_TOOL', verified: false },
    { code: 'U0100', source: 'MANUAL_ENTRY', verified: true },
    { code: 'B1234', source: 'CUSTOMER_REPORTED', verified: false },
    { code: 'C1234', source: 'PLACEHOLDER', verified: false }
  ]);
  assert.deepEqual(trustedDtcCodes(records), ['P0300']);
  const summary = summarizeDtcProvenance(records);
  assert.equal(summary.verifiedCount, 1);
  assert.equal(summary.excludedCount, 4);
});

test('verified scanner provenance wins duplicate-code normalization', () => {
  const records = normalizeDtcEvidence([
    { code: 'P0300', source: 'PLACEHOLDER', verified: false },
    { code: 'P0300', source: 'SCAN_TOOL', verified: true },
    { code: 'P0300', source: 'CUSTOMER_REPORTED', verified: false }
  ]);
  assert.deepEqual(publicDtcEvidence(records), [
    { code: 'P0300', source: 'SCAN_TOOL', verified: true }
  ]);
});

test('unverified scanner provenance is retained for audit but remains excluded', () => {
  const records = normalizeDtcEvidence([
    { code: 'P0171', source: 'PLACEHOLDER', verified: false },
    { code: 'P0171', source: 'SCAN_TOOL', verified: false }
  ]);
  assert.deepEqual(publicDtcEvidence(records), [
    { code: 'P0171', source: 'SCAN_TOOL', verified: false }
  ]);
  assert.deepEqual(trustedDtcCodes(records), []);
});

test('legacy bare arrays always resolve as untrusted provenance', () => {
  const records = resolveRequestDtcEvidence({ codes: ['P0300', 'P0171'] });
  assert.deepEqual(publicDtcEvidence(records), [
    { code: 'P0300', source: 'LEGACY_UNSPECIFIED', verified: false },
    { code: 'P0171', source: 'LEGACY_UNSPECIFIED', verified: false }
  ]);
  assert.deepEqual(trustedDtcCodes(records), []);
});
