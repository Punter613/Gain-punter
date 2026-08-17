const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCanonicalSearchTerms } = require('../src/core/automotive.normalization');
const { extractPage, scorePage } = require('../scripts/scrape-lemon-targeted-evidence');
const { targetedToManual } = require('../src/services/lemon');

test('A/C clutch query expands into factory-manual HVAC terms', () => {
  const { profile, terms } = buildCanonicalSearchTerms(
    { year: 2008, make: 'Kia', model: 'Sorento' },
    { query: 'ac clutch whining when on', symptoms: 'ac clutch whining when on' }
  );

  assert.ok(profile.systems.includes('hvac'));
  assert.ok(profile.sounds.includes('whine'));
  assert.ok(terms.includes('hvac'));
  assert.ok(terms.includes('air conditioning'));
  assert.ok(terms.includes('compressor clutch'));
});

test('tuned parser keeps corrected regex behavior and follows manual hosts', () => {
  const html = `
    <html><head><title>Compressor Clutch Relay</title>
    <script>const fake = '<a href="https://evil.example/nope">bad</a>';</script></head>
    <body>
      <h2>Heating and Air Conditioning</h2>
      <a href="/Kia/2008/Sorento%204WD%20V6-3.8L/Repair%20and%20Diagnosis/HVAC/Compressor%20Clutch%20Relay/">Relay test</a>
      <a href="https://charm.li/Kia/2008/Sorento%204WD%20V6-3.8L/Repair%20and%20Diagnosis/HVAC/Compressor%20Clutch%20Relay/">CHARM mirror</a>
    </body></html>`;

  const page = extractPage(html, 'https://lemon-manuals.la/Kia/2008/Sorento%204WD%20V6-3.8L/Repair%20and%20Diagnosis/');
  assert.equal(page.title, 'Compressor Clutch Relay');
  assert.deepEqual(page.headings, ['Heating and Air Conditioning']);
  assert.equal(page.links.length, 2);
  assert.doesNotMatch(page.bodyText, /const fake|evil\.example/);
});

test('tuned scorer ranks compressor clutch manual page for A/C query', () => {
  const context = { query: 'ac clutch whining when on', symptoms: 'ac clutch whining when on' };
  const { profile, terms } = buildCanonicalSearchTerms({}, context);
  const relevance = scorePage({
    title: 'Compressor Clutch Relay - Testing and Inspection',
    headings: ['Heating and Air Conditioning', 'Compressor Clutch Relay'],
    url: 'https://charm.li/example/Repair%20and%20Diagnosis/HVAC/Compressor%20Clutch%20Relay/',
    bodyText: 'Inspect the air conditioning compressor clutch relay when compressor clutch operation is abnormal.'
  }, terms, 'diagnosis', profile);

  assert.ok(relevance.score > 0);
  assert.ok(relevance.matchedTerms.includes('air conditioning'));
  assert.ok(relevance.matchedTerms.includes('compressor clutch'));
});

test('live manual adapter preserves targeted scraper provenance', () => {
  const manual = targetedToManual({
    source: 'CHARM',
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    crawledPages: 12,
    selectedPages: 1,
    resolvedUrl: 'https://charm.li/Kia/2008/Sorento/Repair%20and%20Diagnosis/',
    pathResolution: 'year-index-discovery',
    applicability: { exact: false, requiresVerification: true },
    pages: [{
      sourceEvidence: {
        source: 'CHARM',
        sourceUrl: 'https://charm.li/example/compressor-clutch',
        title: 'Compressor Clutch Relay',
        headings: ['Heating and Air Conditioning'],
        bodyText: 'Testing and inspection procedure.',
        contentHash: 'abc',
        alternateSourceUrls: []
      },
      derivedIndex: {
        sectionType: 'TEST', relevanceScore: 42, semanticScore: 20, scopeScore: 22,
        matchedTerms: ['air conditioning', 'compressor clutch'], dtcs: [], sounds: [],
        conditions: [], systems: ['hvac'], canonicalTerms: ['hvac'], sourceVariantCount: 1
      }
    }]
  });

  assert.equal(manual.schemaVersion, 4);
  assert.equal(manual.source, 'CHARM');
  assert.equal(manual.items.length, 1);
  assert.equal(manual.items[0].title, 'Compressor Clutch Relay');
  assert.equal(manual.items[0].meta.relevanceScore, '42');
  assert.equal(manual.applicability.requiresVerification, true);
});
