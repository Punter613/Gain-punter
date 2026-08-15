'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_EVIDENCE_EXCERPT,
  rankNhtsaRows,
  mergeTsbReferences,
  normalizeBulletinId
} = require('../src/services/nhtsa.tsb.corpus');
const { selectRelevantTsbs } = require('../src/services/vehicle.evidence');
const { buildEvidenceLedger, compactLedgerForModel } = require('../src/contracts/estimate.ai.contract');

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
  assert.ok(ranked[0].matchedSignals.includes('DTC:P0300'));
  assert.ok(ranked[0].matchedSignals.includes('DTC:P0171'));
});

test('matched NHTSA body text is preserved as bounded model-facing evidence in Diagnose and Estimate shapes', () => {
  const bodyText = `P0300 isolated in NHTSA body text. ${'diagnostic evidence '.repeat(100)}`;
  const ranked = rankNhtsaRows([
    row({ subject: 'Engine performance', body_text: bodyText })
  ], { obdCodes: ['P0300'] }, { minScore: 1, limit: 8 });

  assert.equal(ranked.length, 1);
  const ref = ranked[0];
  assert.ok(ref.extractedFacts.evidenceExcerpt.includes('P0300 isolated in NHTSA body text'));
  assert.ok(ref.extractedFacts.evidenceExcerpt.length <= MAX_EVIDENCE_EXCERPT);
  assert.ok(ref.extractedFacts.matchedSignals.includes('DTC:P0300'));
  assert.equal(ref.extractedFacts.source, 'NHTSA_BULK');

  // Diagnose's compact packet currently passes extractedFacts as `facts`.
  const diagnoseModelCandidate = {
    title: ref.title,
    url: ref.url,
    facts: ref.extractedFacts,
    relevanceScore: ref.relevanceScore
  };
  const diagnosePayload = JSON.stringify(diagnoseModelCandidate);
  assert.ok(diagnosePayload.includes('P0300 isolated in NHTSA body text'));
  assert.ok(diagnosePayload.includes('DTC:P0300'));

  // Estimate uses the evidence-ledger contract; the same excerpt must survive there too.
  const ledger = buildEvidenceLedger({ relevantTsbs: [ref] });
  const compactLedger = compactLedgerForModel(ledger);
  const estimatePayload = JSON.stringify(compactLedger);
  assert.ok(estimatePayload.includes('P0300 isolated in NHTSA body text'));
  assert.ok(estimatePayload.includes('DTC:P0300'));
});

test('diagnose relevance filter accepts a strongly matched NHTSA engine-performance candidate', () => {
  const context = { symptoms: 'random misfire lean condition', obdCodes: ['P0300', 'P0171'] };
  const refs = rankNhtsaRows([row()], context, { minScore: 1, limit: 8 });
  const selected = selectRelevantTsbs({ tsbs: { references: refs } }, context, 12);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].bulletinNumber, 'KT-TEST-001');
  assert.ok(selected[0].extractedFacts.evidenceExcerpt.includes('P0171 P0300'));
});

test('deduplicates bulletin formatting variants and preserves primary Lemon reference with strongest NHTSA relevance', () => {
  const lemon = [{
    bulletinNumber: 'TSB-21-001A',
    title: 'Exact-config Lemon reference',
    subject: 'Driveline clunk',
    snippet: 'Inspect driveline for clunk on load reversal.',
    sourceAuthority: 'LEMON_MANUALS',
    relevanceScore: 0,
    matchedSignals: []
  }];
  const nhtsa = [{
    bulletinNumber: 'TSB 21 001A',
    title: 'NHTSA manufacturer communication',
    subject: 'Driveline clunk',
    snippet: 'P0300 manufacturer communication concerning driveline clunk.',
    excerpt: 'P0300 manufacturer communication concerning driveline clunk.',
    extractedFacts: { evidenceExcerpt: 'P0300 manufacturer communication concerning driveline clunk.', matchedSignals: ['DTC:P0300'] },
    matchedSignals: ['DTC:P0300'],
    sourceAuthority: 'NHTSA_BULK',
    relevanceScore: 30
  }];

  const merged = mergeTsbReferences(lemon, nhtsa, 15);

  assert.equal(normalizeBulletinId('TSB-21-001A'), normalizeBulletinId('TSB 21 001A'));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceAuthority, 'LEMON_MANUALS');
  assert.equal(merged[0].relevanceScore, 30);
  assert.ok(merged[0].matchedSignals.includes('DTC:P0300'));
  assert.ok(merged[0].extractedFacts.evidenceExcerpt.includes('P0300'));
  assert.equal(merged[0].nhtsaVerified, true);
  assert.equal(merged[0].nhtsaReference.sourceAuthority, 'NHTSA_BULK');

  const selected = selectRelevantTsbs(
    { tsbs: { references: merged } },
    { obdCodes: ['P0300'] },
    12
  );
  assert.equal(selected.length, 1, 'strong NHTSA duplicate must keep the Lemon-primary merged record above threshold');
});

test('dedupe keeps the strongest duplicate even when a low-score row arrives first', () => {
  const context = { obdCodes: ['P0300'] };
  const ranked = rankNhtsaRows([
    row({
      bulletin_number: 'TSB-42-100',
      subject: 'General engine communication',
      body_text: 'No diagnostic trouble code is present in this copy.'
    }),
    row({
      bulletin_number: 'TSB 42 100',
      subject: 'Misfire diagnostic communication',
      body_text: 'P0300 diagnostic procedure and misfire verification steps.'
    })
  ], context, { minScore: 12, limit: 8 });

  assert.equal(ranked.length, 1);
  assert.equal(normalizeBulletinId(ranked[0].bulletinNumber), 'TSB42100');
  assert.ok(ranked[0].relevanceScore >= 30);
  assert.ok(ranked[0].extractedFacts.evidenceExcerpt.includes('P0300 diagnostic procedure'));
});

test('keeps the evidence packet bounded instead of returning the full vehicle corpus', () => {
  const rows = Array.from({ length: 40 }, (_, index) => row({
    bulletin_number: `P0300-${index}`,
    body_text: `P0300 misfire diagnostic bulletin number ${index}`
  }));

  const ranked = rankNhtsaRows(rows, { symptoms: 'misfire', obdCodes: ['P0300'] }, { minScore: 1, limit: 8 });
  assert.equal(ranked.length, 8);
});
