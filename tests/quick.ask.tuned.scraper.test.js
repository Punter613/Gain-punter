const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCanonicalSearchTerms } = require('../src/core/automotive.normalization');
const { extractPage, scorePage } = require('../scripts/scrape-lemon-targeted-evidence');
const { targetedToManual } = require('../src/services/lemon');
const { QuickAskRetriever, manualFocusScore } = require('../src/core/knowledge/quick.ask.retriever');

test('A/C clutch query expands into factory-manual HVAC and component terms', () => {
  const { profile, terms } = buildCanonicalSearchTerms(
    { year: 2008, make: 'Kia', model: 'Sorento' },
    { query: 'ac clutch whining when on', symptoms: 'ac clutch whining when on' }
  );

  assert.ok(profile.systems.includes('hvac'));
  assert.ok(profile.components.includes('compressor clutch'));
  assert.ok(profile.sounds.includes('whine'));
  assert.ok(terms.includes('hvac'));
  assert.ok(terms.includes('air conditioning'));
  assert.ok(terms.includes('compressor clutch'));
  assert.ok(terms.includes('clutch'));
  assert.ok(terms.includes('compressor'));
});

test('automotive aliases require word boundaries and preserve warm-up context', () => {
  const photo = buildCanonicalSearchTerms({}, { query: 'Photo 1', symptoms: 'Photo 1' }).profile;
  const humidity = buildCanonicalSearchTerms({}, { query: 'Humidity sensor', symptoms: 'Humidity sensor' }).profile;
  const idler = buildCanonicalSearchTerms({}, { query: 'Idler pulley bearing', symptoms: 'Idler pulley bearing' }).profile;
  const warmup = buildCanonicalSearchTerms({}, {
    query: 'smoke from under the hood when I drive some distance and engine warms up',
    symptoms: 'smoke from under the hood when I drive some distance and engine warms up'
  }).profile;

  assert.equal(photo.conditions.includes('hot'), false, 'Photo must never substring-match hot');
  assert.equal(humidity.sounds.includes('hum'), false, 'Humidity must never substring-match hum');
  assert.equal(idler.conditions.includes('idle'), false, 'Idler must never substring-match idle');
  assert.ok(warmup.conditions.includes('operating_temperature'));
  assert.equal(warmup.conditions.includes('hot'), false, 'warm-up context must not collapse into generic hot');
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

test('Quick Ask component keyword gate refuses generic same-system pages', () => {
  const exact = manualFocusScore({
    title: 'Compressor Clutch Relay — 2008 Kia Sorento',
    url: 'https://lemon-manuals.la/example/HVAC/Compressor%20Clutch%20Relay/',
    meta: {
      headings: 'Heating and Air Conditioning | Compressor Clutch Relay',
      snippet: 'Inspect compressor clutch operation when a whine is present.',
      relevanceScore: '60'
    }
  }, 'ac clutch whining when on');

  const generic = manualFocusScore({
    title: 'Ambient Temperature Sensor / Switch HVAC — 2008 Kia Sorento',
    url: 'https://lemon-manuals.la/example/HVAC/Ambient%20Temperature%20Sensor/',
    meta: {
      headings: 'Heating and Air Conditioning | Ambient Temperature Sensor',
      snippet: 'HVAC ambient temperature sensor testing.',
      relevanceScore: '90'
    }
  }, 'ac clutch whining when on');

  assert.equal(exact.eligible, true);
  assert.ok(exact.matchedComponents.includes('compressor clutch'));
  assert.equal(generic.eligible, false, 'system-only HVAC match must not surface when component was named');
});

test('Quick Ask returns focused component reference instead of first HVAC children', async () => {
  const manualProvider = async () => ({
    source: 'LEMON_MANUALS',
    items: [
      {
        title: 'Ambient Temperature Sensor / Switch HVAC — 2008 Kia Sorento 2WD V6-3.3L',
        url: 'https://lemon-manuals.la/HVAC/Ambient/',
        meta: { headings: 'Heating and Air Conditioning | Ambient Temperature Sensor', snippet: 'HVAC sensor testing.', relevanceScore: '95' }
      },
      {
        title: 'Coolant Temperature Sensor / Switch HVAC — 2008 Kia Sorento 2WD V6-3.3L',
        url: 'https://lemon-manuals.la/HVAC/Coolant/',
        meta: { headings: 'Heating and Air Conditioning | Coolant Temperature Sensor', snippet: 'HVAC sensor testing.', relevanceScore: '90' }
      },
      {
        title: 'Power Transistor HVAC — 2008 Kia Sorento 2WD V6-3.3L',
        url: 'https://lemon-manuals.la/HVAC/PowerTransistor/',
        meta: { headings: 'Heating and Air Conditioning | Power Transistor HVAC', snippet: 'HVAC blower control testing.', relevanceScore: '85' }
      },
      {
        title: 'Compressor Clutch Relay — 2008 Kia Sorento 2WD V6-3.3L',
        url: 'https://lemon-manuals.la/HVAC/Compressor%20Clutch%20Relay/',
        meta: { headings: 'Heating and Air Conditioning | Compressor Clutch Relay', snippet: 'Compressor clutch relay testing when clutch operation is abnormal.', relevanceScore: '50' }
      }
    ]
  });

  const out = await new QuickAskRetriever(null, manualProvider).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    query: 'ac clutch'
  });

  assert.equal(out.repairDiagnosisEvidence.length, 1);
  assert.match(out.repairDiagnosisEvidence[0].title, /compressor clutch relay/i);
  assert.match(out.repairDiagnosisEvidence[0].matchedKeywords, /compressor clutch/i);
});

test('Quick Ask symptom gate rejects generic HVAC and whole-manual body matches', async () => {
  const manualProvider = async () => ({
    source: 'LEMON_MANUALS',
    items: [
      {
        title: 'Repair and Diagnosis (Single Page) — 2008 Ford Pickup F150',
        url: 'https://lemon-manuals.la/Ford/2008/F150/Repair%20and%20Diagnosis%20(Single%20Page)/',
        meta: {
          headings: 'Repair and Diagnosis',
          snippet: 'A very large manual containing grind, whine and HVAC text in unrelated sections.',
          relevanceScore: '99'
        }
      },
      {
        title: 'HVAC Control System - General Information And Diagnostics - F-150',
        url: 'https://lemon-manuals.la/Ford/2008/F150/Repair%20and%20Diagnosis/HVAC/HVAC%20Control%20System/',
        meta: {
          headings: 'Heating Ventilation and Air Conditioning | HVAC Control System',
          snippet: 'General HVAC control information.',
          relevanceScore: '95'
        }
      },
      {
        title: 'A/C Compressor Whine and Grinding Noise Diagnosis - F-150',
        url: 'https://lemon-manuals.la/Ford/2008/F150/Repair%20and%20Diagnosis/HVAC/Compressor/Whine%20Grinding%20Noise%20Diagnosis/',
        meta: {
          headings: 'Heating Ventilation and Air Conditioning | Compressor | Whine and Grinding Noise Diagnosis',
          snippet: 'Noise diagnosis for compressor operation with the A/C engaged.',
          relevanceScore: '50'
        }
      }
    ]
  });

  const out = await new QuickAskRetriever(null, manualProvider).ask({
    vehicle: { year: 2008, make: 'Ford', model: 'F-150' },
    query: 'grinding whining when ac is on'
  });

  assert.equal(out.repairDiagnosisEvidence.length, 1);
  assert.match(out.repairDiagnosisEvidence[0].title, /compressor whine and grinding/i);
  assert.match(out.repairDiagnosisEvidence[0].matchedKeywords, /grind/i);
  assert.match(out.repairDiagnosisEvidence[0].matchedKeywords, /whine/i);
  assert.doesNotMatch(out.repairDiagnosisEvidence[0].title, /single page|general information/i);
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
