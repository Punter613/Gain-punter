const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCanonicalSearchTerms } = require('../src/core/automotive.normalization');
const { extractPage, scorePage } = require('../scripts/scrape-lemon-targeted-evidence');
const { targetedToManual } = require('../src/services/lemon');
const { QuickAskRetriever } = require('../src/core/knowledge/quick.ask.retriever');

test('A/C clutch query expands into factory-manual HVAC and component terms', () => {
  const { profile, terms } = buildCanonicalSearchTerms(
    { year: 2008, make: 'Kia', model: 'Sorento' },
    { query: 'ac clutch whining when on', symptoms: 'ac clutch whining when on' }
  );

  assert.ok(profile.systems.includes('hvac'));
  assert.ok(profile.sounds.includes('whine'));
  assert.ok(terms.includes('hvac'));
  assert.ok(terms.includes('air conditioning'));
  assert.ok(terms.includes('compressor clutch'));
  assert.ok(terms.includes('clutch'));
  assert.ok(terms.includes('compressor'));
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

test('tuned scorer ranks compressor clutch page above generic HVAC sensor pages', () => {
  const context = { query: 'ac clutch whining when on', symptoms: 'ac clutch whining when on' };
  const { profile, terms } = buildCanonicalSearchTerms({}, context);

  const clutch = scorePage({
    title: 'Compressor Clutch Relay - Testing and Inspection',
    headings: ['Heating and Air Conditioning', 'Compressor Clutch Relay'],
    url: 'https://charm.li/example/Repair%20and%20Diagnosis/HVAC/Compressor%20Clutch%20Relay/',
    bodyText: 'Inspect the air conditioning compressor clutch relay when compressor clutch operation is abnormal.'
  }, terms, 'diagnosis', profile);

  const ambient = scorePage({
    title: 'Ambient Temperature Sensor / Switch HVAC',
    headings: ['Heating and Air Conditioning', 'Ambient Temperature Sensor / Switch HVAC'],
    url: 'https://lemon-manuals.la/example/Repair%20and%20Diagnosis/Heating%20and%20Air%20Conditioning/Ambient%20Temperature%20Sensor/',
    bodyText: 'Ambient temperature sensor testing and inspection for the HVAC system.'
  }, terms, 'diagnosis', profile);

  assert.ok(clutch.score > 0);
  assert.ok(clutch.matchedTerms.includes('air conditioning'));
  assert.ok(clutch.matchedTerms.includes('compressor clutch'));
  assert.ok(clutch.matchedTerms.includes('clutch'));
  assert.ok(clutch.matchedTerms.includes('compressor'));
  assert.ok(clutch.score > ambient.score, `${clutch.score} should outrank generic HVAC ${ambient.score}`);
});

test('Quick Ask collapses duplicate manual paths with the same factory title', async () => {
  const manualProvider = async () => ({
    source: 'LEMON_MANUALS',
    items: [
      {
        title: 'Compressor Clutch Relay — 2008 Kia Sorento 2WD V6-3.3L',
        url: 'https://lemon-manuals.la/direct/Compressor%20Clutch%20Relay/',
        meta: { headings: 'Heating and Air Conditioning | Compressor Clutch Relay', snippet: 'Air conditioning compressor clutch relay testing.' }
      },
      {
        title: 'Compressor Clutch Relay — 2008 Kia Sorento 2WD V6-3.3L',
        url: 'https://lemon-manuals.la/HVAC/Relays/Compressor%20Clutch%20Relay/',
        meta: { headings: 'HVAC | Relays | Compressor Clutch Relay', snippet: 'Air conditioning compressor clutch relay testing and inspection.' }
      }
    ]
  });

  const out = await new QuickAskRetriever(null, manualProvider).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    query: 'ac clutch'
  });

  assert.equal(out.repairDiagnosisEvidence.length, 1);
  assert.match(out.repairDiagnosisEvidence[0].title, /compressor clutch relay/i);
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

  assert.equal(manual.schemaVersion, 5);
  assert.equal(manual.source, 'CHARM');
  assert.equal(manual.items.length, 1);
  assert.equal(manual.items[0].title, 'Compressor Clutch Relay');
  assert.equal(manual.items[0].meta.relevanceScore, '42');
  assert.equal(manual.applicability.requiresVerification, true);
});
