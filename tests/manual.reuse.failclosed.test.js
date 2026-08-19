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

function manualItem({ code, title, snippet, key }) {
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
      matchedKeywords: code || '',
      headings: 'Powertrain Management | Testing and Inspection',
      snippet,
      facts: JSON.stringify({
        dtcs: code ? [code] : [],
        sounds: [],
        conditions: [],
        systems: ['engine'],
        canonicalTerms: code ? [code.toLowerCase()] : []
      }),
      contentHash: `hash-${key}`,
      alternateSourceUrls: ''
    }
  };
}

function storedRow(vehicle, items, key = 'stored') {
  return {
    vehicle_key: `${key}:${vehicle.trim || 'no-trim'}`,
    scraped_at: '2026-08-18T23:30:00.000Z',
    data: {
      schemaVersion: 5,
      source: 'LEMON_MANUALS',
      vehicle: { ...vehicle },
      resolved_url: 'https://lemon-manuals.la/Kia/2008/Sorento/Repair%20and%20Diagnosis/',
      applicability: { exact: true, requiresVerification: false },
      items,
      corpusItems: [],
      navigationLinks: []
    }
  };
}

function outputPage({ code, key }) {
  return {
    sourceEvidence: {
      source: 'LEMON_MANUALS',
      sourceUrl: `https://lemon-manuals.la/live/${key}`,
      title: `${code} Testing and Inspection`,
      headings: ['Powertrain Management'],
      bodyText: `${code} current-context diagnostic testing.`,
      contentHash: `live-${key}`,
      alternateSourceUrls: []
    },
    derivedIndex: {
      sectionType: 'TEST',
      relevanceScore: 90,
      semanticScore: 60,
      scopeScore: 30,
      matchedTerms: [code],
      matchLocations: { [code]: ['title'] },
      dtcs: [code],
      sounds: [],
      conditions: [],
      systems: ['engine'],
      canonicalTerms: [code.toLowerCase()],
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
    navigationLinkCount: 0,
    resolvedUrl: 'https://lemon-manuals.la/Kia/2008/Sorento/Repair%20and%20Diagnosis/',
    pathResolution: 'test-live-fallback',
    applicability: { exact: true, requiresVerification: false },
    pages: [outputPage({ code, key: `${code}-selected` })],
    corpusPages: [outputPage({ code, key: `${code}-corpus` })],
    navigationLinks: [],
    elapsedMs: 25,
    timeBudgetExceeded: false,
    crawlTruncated: false,
    seedLinkCount: 0,
    seededNavigationUsed: false,
    seedEarlyStop: false,
    seedMatchedDtcs: []
  };
}

async function withLemonDbMock(rows, fn) {
  const lemonPath = require.resolve('../src/services/lemon');
  const reusePath = require.resolve('../src/services/manual.evidence.reuse');
  const navigationPath = require.resolve('../src/services/manual.navigation.seeds');
  const dbPath = require.resolve('../src/db');
  const workerPath = require.resolve('../src/services/lemon.worker');

  const dbMock = {
    getCachedManual: async () => null,
    getCachedManualVehicleEvidence: async () => rows,
    getCachedManualPathHint: async () => '',
    saveScrapedManual: async () => null,
    buildManualCacheKey: (_vehicle, context = {}) => `key:${context.query || (context.obdCodes || []).join(',')}`
  };
  const restoreDb = replaceModule(dbPath, dbMock);
  const restoreWorker = replaceModule(workerPath, {
    runTargetedEvidenceWorker: async () => {
      throw new Error('unexpected real worker call in test');
    }
  });

  delete require.cache[reusePath];
  delete require.cache[navigationPath];
  delete require.cache[lemonPath];
  try {
    return await fn(require(lemonPath), require(reusePath));
  } finally {
    delete require.cache[lemonPath];
    delete require.cache[navigationPath];
    delete require.cache[reusePath];
    restoreWorker();
    restoreDb();
  }
}

const sorento = {
  year: 2008,
  make: 'KIA',
  model: 'Sorento',
  trim: 'BL',
  engine: '3.8L',
  drivetrain: '4WD'
};

function p0300Item(key = 'p0300') {
  return manualItem({
    code: 'P0300',
    title: 'Random Multiple Cylinder Misfire Testing',
    snippet: 'P0300 random multiple cylinder misfire diagnosis and ignition checks.',
    key
  });
}

function p0171Item(key = 'p0171') {
  return manualItem({
    code: 'P0171',
    title: 'System Too Lean Bank 1 Fuel Trim Testing',
    snippet: 'P0171 system too lean bank 1 diagnosis with fuel trim and intake checks.',
    key
  });
}

test('multi-DTC stored reuse fails closed when accepted candidates cover only one requested DTC', async () => {
  const rows = [storedRow(sorento, [p0300Item()])];

  await withLemonDbMock(rows, async ({ scrapeLEMONManuals }) => {
    let liveCalls = 0;
    const result = await scrapeLEMONManuals(
      sorento,
      { query: 'P0300 P0171 random misfire lean bank 1', obdCodes: ['P0300', 'P0171'] },
      {
        targetedRunner: async () => {
          liveCalls += 1;
          return targetedFixture(sorento, 'P0171');
        }
      }
    );

    assert.equal(liveCalls, 1, 'partial stored DTC coverage must fall through to live retrieval');
    assert.equal(result.fromCache, false);
    assert.equal(result.cacheMode, 'live-targeted');
  });
});

test('multi-DTC stored reuse succeeds only when the accepted candidate set collectively covers every requested DTC', async () => {
  const rows = [storedRow(sorento, [p0300Item(), p0171Item()])];

  await withLemonDbMock(rows, async ({ scrapeLEMONManuals }) => {
    let liveCalls = 0;
    const result = await scrapeLEMONManuals(
      sorento,
      { query: 'P0300 P0171 random misfire lean bank 1', obdCodes: ['P0300', 'P0171'] },
      {
        targetedRunner: async () => {
          liveCalls += 1;
          return targetedFixture(sorento, 'P0300');
        }
      }
    );

    assert.equal(liveCalls, 0, 'complete stored DTC coverage should remain reusable');
    assert.equal(result.fromCache, true);
    assert.equal(result.cacheMode, 'vehicle-cross-context');
    assert.deepEqual(result.retrieval.requestedDtcs, ['P0300', 'P0171']);
    assert.deepEqual(new Set(result.retrieval.coveredDtcs), new Set(['P0300', 'P0171']));
    assert.equal(result.items.length, 2);
  });
});

test('explicit trim mismatch rejects cross-context reuse and falls through to live retrieval', async () => {
  const optima = {
    year: 2020,
    make: 'KIA',
    model: 'Optima',
    trim: 'LX, S, SE',
    engine: '2.4L',
    drivetrain: 'FWD'
  };
  const wrongTrim = { ...optima, trim: 'EX' };
  const rows = [storedRow(wrongTrim, [manualItem({
    code: 'P1326',
    title: 'P1326 Knock Sensor Testing',
    snippet: 'P1326 knock sensor detection testing.',
    key: 'wrong-trim-p1326'
  })], 'wrong-trim')];

  await withLemonDbMock(rows, async ({ scrapeLEMONManuals }, { sameVehicleIdentity }) => {
    let liveCalls = 0;
    assert.equal(sameVehicleIdentity(wrongTrim, optima), false, 'explicit disjoint trims are different reuse identities');

    const result = await scrapeLEMONManuals(
      optima,
      { query: 'P1326 knock signal', obdCodes: ['P1326'] },
      {
        targetedRunner: async () => {
          liveCalls += 1;
          return targetedFixture(optima, 'P1326');
        }
      }
    );

    assert.equal(liveCalls, 1, 'explicit trim mismatch must fail closed to live retrieval');
    assert.equal(result.cacheMode, 'live-targeted');
  });
});

test('unknown trim remains compatible while overlapping explicit trim sets remain reusable', async () => {
  const { trimsCompatible } = require('../src/services/manual.evidence.reuse');
  assert.equal(trimsCompatible({ trim: '' }, { trim: 'LX, S, SE' }), true);
  assert.equal(trimsCompatible({ trim: 'SE' }, { trim: 'LX, S, SE' }), true);
  assert.equal(trimsCompatible({ trim: 'EX Premium' }, { trim: 'EX' }), true);
  assert.equal(trimsCompatible({ trim: 'EX' }, { trim: 'LX, S, SE' }), false);
});
