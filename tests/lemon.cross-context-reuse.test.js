'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function replaceModule(modulePath, exports) {
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
  return () => {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  };
}

function storedRow(vehicle, code = 'P1326') {
  return {
    vehicle_key: `stored:${code}`,
    scraped_at: '2026-08-18T21:00:00.000Z',
    data: {
      schemaVersion: 5,
      source: 'LEMON_MANUALS',
      vehicle: { ...vehicle },
      resolved_url: 'https://lemon-manuals.la/Kia/2020/Optima/Repair%20and%20Diagnosis/',
      applicability: { exact: true, requiresVerification: false },
      items: [{
        title: `${code} Testing and Inspection`,
        url: `https://lemon-manuals.la/test/${code}`,
        price: null,
        meta: {
          scraper: 'targeted-evidence-v2',
          sectionType: 'TEST',
          relevanceScore: '90',
          semanticScore: '60',
          scopeScore: '30',
          matchedKeywords: code.toLowerCase(),
          headings: 'Engine Control | Testing and Inspection',
          snippet: `${code} knock sensor signal testing and inspection procedure.`,
          facts: JSON.stringify({ dtcs: [code], sounds: [], conditions: [], systems: ['engine'], canonicalTerms: [code.toLowerCase()] }),
          contentHash: `hash-${code}`,
          alternateSourceUrls: ''
        }
      }]
    }
  };
}

function targetedFixture(vehicle, code = 'P0300') {
  return {
    source: 'LEMON_MANUALS',
    vehicle: { ...vehicle },
    query: {},
    crawledPages: 1,
    selectedPages: 1,
    resolvedUrl: 'https://lemon-manuals.la/Kia/2020/Optima/Repair%20and%20Diagnosis/',
    pathResolution: 'test',
    applicability: { exact: true, requiresVerification: false },
    pages: [{
      sourceEvidence: {
        source: 'LEMON_MANUALS',
        sourceUrl: `https://lemon-manuals.la/test/${code}`,
        title: `${code} Testing and Inspection`,
        headings: ['Engine Control'],
        bodyText: `${code} diagnostic testing.`,
        contentHash: `live-${code}`,
        alternateSourceUrls: []
      },
      derivedIndex: {
        sectionType: 'TEST',
        relevanceScore: 90,
        semanticScore: 60,
        scopeScore: 30,
        matchedTerms: [code.toLowerCase()],
        matchLocations: { [code.toLowerCase()]: ['title'] },
        dtcs: [code],
        sounds: [],
        conditions: [],
        systems: ['engine'],
        canonicalTerms: [code.toLowerCase()],
        sourceVariantCount: 1
      }
    }],
    elapsedMs: 25,
    timeBudgetExceeded: false,
    crawlTruncated: false
  };
}

async function withLemonDbMock(dbExports, fn) {
  const lemonPath = require.resolve('../src/services/lemon');
  const reusePath = require.resolve('../src/services/manual.evidence.reuse');
  const dbPath = require.resolve('../src/db');
  const restoreDb = replaceModule(dbPath, dbExports);
  delete require.cache[reusePath];
  delete require.cache[lemonPath];
  try {
    return await fn(require(lemonPath));
  } finally {
    delete require.cache[lemonPath];
    delete require.cache[reusePath];
    restoreDb();
  }
}

function baseDbMock(rows = []) {
  return {
    getCachedManual: async () => null,
    getCachedManualVehicleEvidence: async () => rows,
    getCachedManualPathHint: async () => '',
    saveScrapedManual: async () => null,
    buildManualCacheKey: (_vehicle, context = {}) => `key:${context.query || (context.obdCodes || []).join(',')}`
  };
}

test('same vehicle can reuse stored DTC evidence across a different context hash without live crawl', async () => {
  const vehicle = { year: 2020, make: 'KIA', model: 'Optima', engine: '2.4L', drivetrain: 'FWD' };
  const rows = [storedRow(vehicle, 'P1326')];

  await withLemonDbMock(baseDbMock(rows), async ({ scrapeLEMONManuals }) => {
    let liveCalls = 0;
    const result = await scrapeLEMONManuals(
      vehicle,
      { query: 'P1326 knock signal after water splash', obdCodes: ['P1326'] },
      { targetedRunner: async () => { liveCalls += 1; return targetedFixture(vehicle, 'P1326'); } }
    );

    assert.equal(liveCalls, 0, 'strong stored DTC evidence should avoid the live crawler');
    assert.equal(result.fromCache, true);
    assert.equal(result.cacheMode, 'vehicle-cross-context');
    assert.equal(result.reusedStoredEvidence, true);
    assert.equal(result.items.length, 1);
    assert.match(result.items[0].meta.matchedKeywords, /p1326/i);
  });
});

test('unrelated DTC context does not reuse stored pages and falls through to live crawl', async () => {
  const vehicle = { year: 2020, make: 'KIA', model: 'Optima', engine: '2.4L', drivetrain: 'FWD' };
  const rows = [storedRow(vehicle, 'P1326')];

  await withLemonDbMock(baseDbMock(rows), async ({ scrapeLEMONManuals }) => {
    let liveCalls = 0;
    const result = await scrapeLEMONManuals(
      vehicle,
      { query: 'P0300 random misfire', obdCodes: ['P0300'] },
      { targetedRunner: async () => { liveCalls += 1; return targetedFixture(vehicle, 'P0300'); } }
    );

    assert.equal(liveCalls, 1, 'unrelated stored evidence must not suppress current-context retrieval');
    assert.equal(result.fromCache, false);
    assert.equal(result.cacheMode, 'live-targeted');
  });
});

test('stored evidence from an explicit engine variant mismatch is not reused', async () => {
  const vehicle = { year: 2020, make: 'KIA', model: 'Optima', engine: '2.4L', drivetrain: 'FWD' };
  const wrongVariant = { ...vehicle, engine: '1.6L' };
  const rows = [storedRow(wrongVariant, 'P1326')];

  await withLemonDbMock(baseDbMock(rows), async ({ scrapeLEMONManuals }) => {
    let liveCalls = 0;
    const result = await scrapeLEMONManuals(
      vehicle,
      { query: 'P1326 knock signal', obdCodes: ['P1326'] },
      { targetedRunner: async () => { liveCalls += 1; return targetedFixture(vehicle, 'P1326'); } }
    );

    assert.equal(liveCalls, 1, 'cross-variant rows must fail closed to live retrieval');
    assert.equal(result.cacheMode, 'live-targeted');
  });
});

test('stored evidence from an explicit drivetrain mismatch is not reused', async () => {
  const vehicle = { year: 2008, make: 'KIA', model: 'Sorento', engine: '3.8L', drivetrain: '4WD' };
  const wrongVariant = { ...vehicle, drivetrain: '2WD' };
  const rows = [storedRow(wrongVariant, 'P0300')];

  await withLemonDbMock(baseDbMock(rows), async ({ scrapeLEMONManuals }) => {
    let liveCalls = 0;
    const result = await scrapeLEMONManuals(
      vehicle,
      { query: 'P0300 misfire', obdCodes: ['P0300'] },
      { targetedRunner: async () => { liveCalls += 1; return targetedFixture(vehicle, 'P0300'); } }
    );

    assert.equal(liveCalls, 1, 'cross-drivetrain rows must fail closed to live retrieval');
    assert.equal(result.cacheMode, 'live-targeted');
  });
});