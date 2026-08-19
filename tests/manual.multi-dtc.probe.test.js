'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function replaceModule(modulePath, exports) {
  const previous = require.cache[modulePath];
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
  return () => {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  };
}

const vehicle = {
  year: 2008,
  make: 'KIA',
  model: 'Sorento',
  trim: 'BL',
  engine: '3.8L',
  drivetrain: '4WD'
};

const rootUrl = 'https://lemon-manuals.la/Kia/2008/Sorento%204WD%20V6-3.8L/Repair%20and%20Diagnosis/';

function navigationRow() {
  return {
    vehicle_key: 'stored:navigation',
    scraped_at: '2026-08-19T00:00:00.000Z',
    data: {
      schemaVersion: 5,
      source: 'LEMON_MANUALS',
      vehicle: { ...vehicle },
      resolved_url: rootUrl,
      items: [],
      corpusItems: [],
      navigationLinks: [
        { url: `${rootUrl}Powertrain%20Management/Ignition%20System/`, text: 'Ignition System' },
        { url: `${rootUrl}Powertrain%20Management/Computers%20and%20Control%20Systems/Fuel%20Trim/`, text: 'Fuel Trim' },
        { url: `${rootUrl}Powertrain%20Management/Air%20Intake/`, text: 'Air Intake Vacuum' }
      ]
    }
  };
}

function outputPage(code) {
  const detail = code === 'P0171'
    ? 'P0171 system too lean bank 1 fuel trim intake vacuum diagnosis.'
    : 'P0300 random multiple cylinder misfire ignition diagnosis.';
  return {
    sourceEvidence: {
      source: 'LEMON_MANUALS',
      sourceUrl: `${rootUrl}${code}/Testing%20and%20Inspection/`,
      title: `${code} Testing and Inspection`,
      headings: ['Powertrain Management', 'Testing and Inspection'],
      bodyText: detail,
      contentHash: `hash-${code}`,
      alternateSourceUrls: []
    },
    derivedIndex: {
      sectionType: 'TEST',
      relevanceScore: 95,
      semanticScore: 65,
      scopeScore: 30,
      matchedTerms: [code],
      matchLocations: { [code]: ['title', 'path', 'body'] },
      dtcs: [code],
      sounds: [],
      conditions: [],
      systems: ['engine'],
      canonicalTerms: [code.toLowerCase()],
      sourceVariantCount: 1
    }
  };
}

function targetedFixture(code, options = {}) {
  const page = outputPage(code);
  return {
    source: 'LEMON_MANUALS',
    vehicle: { ...vehicle },
    query: {},
    crawledPages: 2,
    selectedPages: 1,
    corpusPageCount: 1,
    navigationLinkCount: 1,
    resolvedUrl: rootUrl,
    pathResolution: 'cached-path-hint',
    applicability: { exact: true, requiresVerification: false },
    pages: options.unrelated ? [] : [page],
    corpusPages: options.unrelated ? [] : [page],
    navigationLinks: [{ url: `${rootUrl}${code}/`, text: code }],
    elapsedMs: 80,
    timeBudgetExceeded: false,
    crawlTruncated: false,
    seedLinkCount: 1,
    seededNavigationUsed: true,
    seedEarlyStop: !options.unrelated,
    seedMatchedDtcs: options.unrelated ? [] : [code]
  };
}

async function withDbMock(fn) {
  const lemonPath = require.resolve('../src/services/lemon');
  const reusePath = require.resolve('../src/services/manual.evidence.reuse');
  const navPath = require.resolve('../src/services/manual.navigation.seeds');
  const dbPath = require.resolve('../src/db');
  let saved = [];
  const restoreDb = replaceModule(dbPath, {
    getCachedManual: async () => null,
    getCachedManualVehicleEvidence: async () => [navigationRow()],
    getCachedManualPathHint: async () => rootUrl,
    saveScrapedManual: async (_vehicle, manual, context) => { saved.push({ manual, context }); },
    buildManualCacheKey: () => 'sorento-multi-dtc'
  });
  delete require.cache[reusePath];
  delete require.cache[navPath];
  delete require.cache[lemonPath];
  try {
    return await fn(require(lemonPath), () => saved);
  } finally {
    delete require.cache[lemonPath];
    delete require.cache[navPath];
    delete require.cache[reusePath];
    restoreDb();
  }
}

test('multi-DTC cold path probes each requested DTC independently, merges visible evidence, and avoids full crawl', async () => {
  await withDbMock(async ({ scrapeLEMONManuals }, getSaved) => {
    const calls = [];
    const result = await scrapeLEMONManuals(
      vehicle,
      { query: 'P0300 P0171 random misfire lean bank 1', obdCodes: ['P0300', 'P0171'] },
      {
        targetedRunner: async (_vehicle, context) => {
          calls.push([...context.obdCodes]);
          assert.equal(context.obdCodes.length, 1, 'multi-DTC probe must isolate one code per worker');
          return targetedFixture(context.obdCodes[0]);
        }
      }
    );

    assert.equal(calls.length, 2, 'complete per-code probes should avoid the full mixed crawl');
    assert.deepEqual(new Set(calls.flat()), new Set(['P0300', 'P0171']));
    assert.equal(result.cacheMode, 'stored-navigation-multi-dtc-probe');
    assert.equal(result.fromCache, false, 'network probe must not be mislabeled as cache');
    assert.deepEqual(new Set(result.retrieval.coveredDtcs), new Set(['P0300', 'P0171']));
    assert.equal(result.items.length, 2);
    assert.equal(getSaved().length, 1, 'merged complete result should persist under the original multi-DTC context');
    assert.deepEqual(getSaved()[0].context.obdCodes, ['P0300', 'P0171']);
  });
});

test('multi-DTC cold path fails closed to full retrieval when one independent probe lacks visible evidence', async () => {
  await withDbMock(async ({ scrapeLEMONManuals }) => {
    const calls = [];
    const result = await scrapeLEMONManuals(
      vehicle,
      { query: 'P0300 P0171 random misfire lean bank 1', obdCodes: ['P0300', 'P0171'] },
      {
        targetedRunner: async (_vehicle, context) => {
          calls.push([...context.obdCodes]);
          if (context.obdCodes.length === 2) return targetedFixture('P0300');
          if (context.obdCodes[0] === 'P0171') return targetedFixture('P0171', { unrelated: true });
          return targetedFixture(context.obdCodes[0]);
        }
      }
    );

    assert.equal(calls.length, 3, 'incomplete merged coverage must invoke the existing full mixed retrieval fallback');
    assert.ok(calls.some(codes => codes.length === 2), 'full fallback must receive the original multi-DTC context');
    assert.equal(result.cacheMode, 'live-targeted');
    assert.equal(result.fromCache, false);
  });
});
