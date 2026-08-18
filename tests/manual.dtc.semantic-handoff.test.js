'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCurrentSearchContext,
  rerankStoredManualEvidence
} = require('../src/services/manual.evidence.reuse');

function storedRow(vehicle, item) {
  return {
    vehicle_key: 'stored:test',
    scraped_at: '2026-08-18T22:00:00.000Z',
    data: {
      schemaVersion: 5,
      source: 'LEMON_MANUALS',
      vehicle: { ...vehicle },
      resolved_url: 'https://lemon-manuals.la/Kia/2008/Sorento/Repair%20and%20Diagnosis/',
      applicability: { exact: true, requiresVerification: false },
      corpusItems: [item],
      items: []
    }
  };
}

function manualItem({ title = 'Testing and Inspection', snippet, key }) {
  return {
    title,
    url: `https://lemon-manuals.la/Kia/2008/Sorento/Repair%20and%20Diagnosis/Powertrain/${key}/`,
    price: null,
    meta: {
      scraper: 'targeted-evidence-v2',
      sectionType: 'TEST',
      relevanceScore: '0',
      semanticScore: '0',
      scopeScore: '0',
      matchedKeywords: '',
      headings: 'Powertrain Control | Testing and Inspection',
      snippet,
      facts: JSON.stringify({ dtcs: [], sounds: [], conditions: [], systems: [], canonicalTerms: [] }),
      contentHash: `hash-${key}`,
      alternateSourceUrls: ''
    }
  };
}

test('resolved DTC meaning terms survive the canonical-system boundary for manual scoring', () => {
  const vehicle = { year: 2008, make: 'KIA', model: 'Sorento', engine: '3.8L', drivetrain: '4WD' };
  const context = { query: 'P0171 system too lean bank 1 fuel trim', obdCodes: ['P0171'] };
  const search = buildCurrentSearchContext(vehicle, context);

  assert.equal(search.dtcIntent.mode, 'DTC_ANCHORED');
  assert.ok(search.terms.includes('p0171'));
  assert.ok(search.terms.includes('fuel trim'));
  assert.ok(search.terms.includes('system too lean'));
});

test('body-only deterministic P0171 meaning can qualify retained corpus without a literal code or generic engine word', () => {
  const vehicle = { year: 2008, make: 'KIA', model: 'Sorento', engine: '3.8L', drivetrain: '4WD' };
  const rows = [storedRow(vehicle, manualItem({
    snippet: 'When fuel trim remains positive, inspect for a system too lean condition and intake vacuum leakage.',
    key: 'lean-diagnosis'
  }))];

  const result = rerankStoredManualEvidence(
    rows,
    vehicle,
    { query: 'P0171 lean bank 1', obdCodes: ['P0171'] },
    'diagnosis'
  );

  assert.ok(result, 'resolved DTC meaning in source text should be scoreable instead of collapsing to a generic system');
  assert.equal(result.fromCache, true);
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].meta.matchedKeywords, /fuel trim|system too lean/i);
});

test('unknown DTC still receives no invented manual meaning terms', () => {
  const vehicle = { year: 2008, make: 'KIA', model: 'Sorento', engine: '3.8L', drivetrain: '4WD' };
  const search = buildCurrentSearchContext(vehicle, { query: 'P1999 fuel trim', obdCodes: ['P1999'] });

  assert.equal(search.dtcIntent.mode, 'SYMPTOM_FALLBACK_UNRESOLVED_DTC');
  assert.deepEqual(search.resolvedDtcTerms, []);
});
