'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  rankNhtsaRows,
  mergeTsbReferences,
  normalizeBulletinId
} = require('../src/services/nhtsa.tsb.corpus');
const { selectRelevantTsbs } = require('../src/services/vehicle.evidence');

function row(overrides = {}) {
  return {
    bulletin_number: 'KT-TEST-001',
    bulletin_date: '2009-05-08',
    group_name: 'ENGINE AND ENGINE COOLING',
    subject: 'Engine performance',
    body_text: 'Diagnostic information for lean condition and engine misfire P0171 P0300.',
    extracted_facts: {},
    source: 'NHTSA_BULK',
    ...overrides
  };
}

test('ranks code and symptom-matched NHTSA rows above unrelated communications', () => {
  const ranked = rankNhtsaRows([
    row(),
    row({
      bulletin_number: 'KT-UNRELATED-002',
      group_name: 'LABELS',
      subject: 'Certification label',
      body_text: 'Updated certification label placement information.'
    })
  ], {
    symptoms: 'engine runs lean and misfires at idle',
    obdCodes: ['P0300', 'P0171']
  }, { minScore: 1, limit: 8 });

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].bulletinNumber, 'KT-TEST-001');
  assert.equal(ranked[0].sourceAuthority, 'NHTSA_BULK');
  assert.ok(ranked[0].relevanceScore >= 60);
});

test('diagnose relevance filter accepts a strongly matched NHTSA engine-performance candidate', () => {
  const context = { symptoms: 'random misfire lean condition', obdCodes: ['P0300', 'P0171'] };
  const refs = rankNhtsaRows([row()], context, { minScore: 1, limit: 8 });
  const selected = selectRelevantTsbs({ tsbs: { references: refs } }, context, 12);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].bulletinNumber, 'KT-TEST-001');
});

test('deduplicates bulletin formatting variants and preserves primary Lemon reference with NHTSA verification', () => {
  const lemon = [{
    bulletinNumber: 'TSB-21-001A',
    title: 'Exact-config Lemon reference',
    subject: 'Driveline clunk',
    snippet: 'Inspect driveline for clunk on load reversal.',
    sourceAuthority: 'LEMON_MANUALS',
    relevanceScore: 25
  }];
  const nhtsa = [{
    bulletinNumber: 'TSB 21 001A',
    title: 'NHTSA manufacturer communication',
    subject: 'Driveline clunk',
    snippet: 'Manufacturer communication concerning driveline clunk.',
    sourceAuthority: 'NHTSA_BULK',
    relevanceScore: 30
  }];

  const merged = mergeTsbReferences(lemon, nhtsa, 15);

  assert.equal(normalizeBulletinId('TSB-21-001A'), normalizeBulletinId('TSB 21 001A'));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceAuthority, 'LEMON_MANUALS');
  assert.equal(merged[0].nhtsaVerified, true);
  assert.equal(merged[0].nhtsaReference.sourceAuthority, 'NHTSA_BULK');
});

test('keeps the evidence packet bounded instead of returning the full vehicle corpus', () => {
  const rows = Array.from({ length: 40 }, (_, index) => row({
    bulletin_number: `P0300-${index}`,
    body_text: `P0300 misfire diagnostic bulletin number ${index}`
  }));

  const ranked = rankNhtsaRows(rows, { symptoms: 'misfire', obdCodes: ['P0300'] }, { minScore: 1, limit: 8 });
  assert.equal(ranked.length, 8);
});
