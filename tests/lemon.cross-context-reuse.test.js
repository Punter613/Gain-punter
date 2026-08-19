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

function manualItem({ title, snippet, key, code = '' }) {
  return {
    title,
    url: `https://lemon-manuals.la/test/${key}`,
    price: null,
    meta: {
      scraper: 'targeted-evidence-v2',
      sectionType: 'TEST',
      relevanceScore: '80',
      semanticScore: '50',
      scopeScore: '30',
      matchedKeywords: code.toLowerCase(),
      headings: 'Engine Control | Testing and Inspection',
      snippet,
      facts: JSON.stringify({ dtcs: code ? [code] : [], sounds: [], conditions: [], systems: ['engine'], canonicalTerms: code ? [code.toLowerCase()] : [] }),
      contentHash: `hash-${key}`,
      alternateSourceUrls: ''
    }
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
      items: [manualItem({
        title: `${code} Testing and Inspection`,
        snippet: `${code} knock sensor signal testing and inspection procedure.`,
        key: code,
        code
      })]
    }
  };
}

function storedMeaningRow(vehicle, { title, snippet, key }) {
  return {
    vehicle_key: `stored:meaning:${key}`,
    scraped_at: '2026-08-18T21:05:00.000Z',
    data: {
      schemaVersion: 5,
      source: 'LEMON_MANUALS',
      vehicle: { ...vehicle },
      resolved_url: 'https://lemon-manuals.la/Kia/Repair%20and%20Diagnosis/',
      applicability: { exact: true, requiresVerification: false },
      items: [manualItem({ title, snippet, key })]
    }
  };
}

function storedCorpusRow(vehicle, { title, snippet, key }) {
  return {
    vehicle_key: `stored:corpus:${key}`,
    scraped_at: '2026-08-18T21:10:00.000Z',
    data: {
      schemaVersion: 5,
      source: 'LEMON_MANUALS',
      vehicle: { ...vehicle },
      resolved_url: 'https://lemon-manuals.la/Kia/Repair%20and%20Diagnosis/',
      applicability: { exact: true, requiresVerification: false },
      items: [manualItem({
        title: 'Unrelated prior-query selection',
        snippet: 'A steering trim page selected for a different diagnostic question.',
        key: `${key}-old-selection`
      })],
      corpusItems: [manualItem({ title, snippet, key })]
    }
  };
}

function outputPage({ title, bodyText, key, code = '' }) {
  return {
    sourceEvidence: {
      source: 'LEMON_MANUALS',
      sourceUrl: `https://lemon-manuals.la/test/${key}`,
      title,
      headings: ['Engine Control'],
      bodyText,
      contentHash: `live-${key}`,
      alternateSourceUrls: []
    },
    derivedIndex: {
      sectionType: 'TEST',
      relevanceScore: code ? 90 : 10,
      semanticScore: code ? 60 : 5,
      scopeScore: code ? 30 : 5,
      matchedTerms: code ? [code.toLowerCase()] : [],
      matchLocations: code ? { [code.toLowerCase()]: ['title'] } : {},
      dtcs: code ? [code] : [],
      sounds: [],
      conditions: [],
      systems: ['engine'],
      canonicalTerms: code ? [code.toLowerCase()] : [],
      sourceVariantCount: 1
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
    corpusPageCount: 1,
    resolvedUrl: 'https://lemon-manuals.la/Kia/2020/Optima/Repair%20and%20Diagnosis/',
    pathResolution: 'test',
    applicability: { exact: true, requiresVerification: false },
    pages: [outputPage({
      title: `${code} Testing and Inspection`,
      bodyText: `${code} diagnostic testing.`,
      key: code,
      code
    })],
    corpusPages: [outputPage({
      title: `${code} Testing and Inspection`,
      bodyText: `${code} diagnostic testing.`,
      key: `${code}-corpus`,
      code
    })],
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

test('resolved DTC meaning can reuse a focused stored page even when the literal code is absent', async () => {
  const vehicle = { year: 2008, make: 'KIA', model: 'Sorento', engine: '3.8L', drivetrain: '4WD' };
  const rows = [storedMeaningRow(vehicle, {
    title: 'Cylinder Misfire Testing and Inspection',
    snippet: 'Inspect ignition and fuel delivery for a random or multiple cylinder misfire.',
    key: 'cylinder-misfire'
  })];

  await withLemonDbMock(baseDbMock(rows), async ({ scrapeLEMONManuals }) => {
    let liveCalls = 0;
    const result = await scrapeLEMONManuals(
      vehicle,
      { query: 'P0300 random misfire', obdCodes: ['P0300'] },
      { targetedRunner: async () => { liveCalls += 1; return targetedFixture(vehicle, 'P0300'); } }
    );

    assert.equal(liveCalls, 0, 'deterministically resolved P0300 meaning should qualify focused stored misfire evidence');
    assert.equal(result.cacheMode, 'vehicle-cross-context');
    assert.equal(result.items.length, 1);
    assert.match(result.items[0].title, /misfire/i);
  });
});

test('retained same-vehicle corpus can satisfy a new DTC context even when prior selected pages cannot', async () => {
  const vehicle = { year: 2008, make: 'KIA', model: 'Sorento', engine: '3.8L', drivetrain: '4WD' };
  const rows = [storedCorpusRow(vehicle, {
    title: 'Fuel Trim System Lean Testing',
    snippet: 'System too lean bank 1 diagnosis checks fuel trim and intake vacuum leaks.',
    key: 'lean-fuel-trim'
  })];

  await withLemonDbMock(baseDbMock(rows), async ({ scrapeLEMONManuals }) => {
    let liveCalls = 0;
    const result = await scrapeLEMONManuals(
      vehicle,
      { query: 'P0171 lean bank 1 fuel trim', obdCodes: ['P0171'] },
      { targetedRunner: async () => { liveCalls += 1; return targetedFixture(vehicle, 'P0171'); } }
    );

    assert.equal(liveCalls, 0, 'retained corpus should avoid a new crawl when visible source text satisfies P0171 meaning');
    assert.equal(result.cacheMode, 'vehicle-cross-context');
    assert.equal(result.items.length, 1);
    assert.match(result.items[0].title, /fuel trim/i);
  });
});

test('cold crawl persists corpus pages even when focused selected pages are empty', async () => {
  const vehicle = { year: 2008, make: 'KIA', model: 'Sorento', engine: '3.8L', drivetrain: '4WD' };
  let saved = null;
  const db = {
    ...baseDbMock([]),
    saveScrapedManual: async (_vehicle, manual) => { saved = manual; }
  };

  await withLemonDbMock(db, async ({ scrapeLEMONManuals }) => {
    const result = await scrapeLEMONManuals(
      vehicle,
      { query: 'P0171 lean bank 1', obdCodes: ['P0171'] },
      {
        targetedRunner: async () => ({
          ...targetedFixture(vehicle, 'P0171'),
          selectedPages: 0,
          pages: [],
          corpusPageCount: 1,
          corpusPages: [outputPage({
            title: 'Fuel Trim System Lean Testing',
            bodyText: 'System too lean bank 1 fuel trim diagnosis.',
            key: 'persisted-corpus'
          })]
        })
      }
    );

    assert.equal(result.items.length, 0);
    assert.equal(result.corpusItems.length, 1);
    assert.ok(saved, 'bounded fetched-page corpus should still be persisted');
    assert.equal(saved.corpusItems.length, 1);
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

test('unknown DTC does not borrow a meaning from unrelated stored evidence', async () => {
  const vehicle = { year: 2008, make: 'KIA', model: 'Sorento', engine: '3.8L', drivetrain: '4WD' };
  const rows = [storedMeaningRow(vehicle, {
    title: 'Cylinder Misfire Testing and Inspection',
    snippet: 'Inspect ignition and fuel delivery for a random cylinder misfire.',
    key: 'unknown-code-guard'
  })];

  await withLemonDbMock(baseDbMock(rows), async ({ scrapeLEMONManuals }) => {
    let liveCalls = 0;
    const result = await scrapeLEMONManuals(
      vehicle,
      { query: 'P1999 random misfire', obdCodes: ['P1999'] },
      { targetedRunner: async () => { liveCalls += 1; return targetedFixture(vehicle, 'P1999'); } }
    );

    assert.equal(liveCalls, 1, 'unresolved DTC reuse stays exact-code only');
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