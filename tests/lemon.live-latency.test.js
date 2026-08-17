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

function targetedFixture() {
  return {
    source: 'LEMON_MANUALS',
    vehicle: { year: 2020, make: 'KIA', model: 'Optima' },
    query: {},
    crawledPages: 1,
    selectedPages: 1,
    resolvedUrl: 'https://lemon-manuals.la/Kia/2020/Optima/Repair%20and%20Diagnosis/',
    pathResolution: 'test',
    applicability: { exact: true, requiresVerification: false },
    pages: [{
      sourceEvidence: {
        source: 'LEMON_MANUALS',
        sourceUrl: 'https://lemon-manuals.la/test/P1326',
        title: 'P1326 Testing and Inspection',
        headings: ['Engine Control'],
        bodyText: 'Knock sensor signal inspection.',
        contentHash: 'abc',
        alternateSourceUrls: []
      },
      derivedIndex: {
        sectionType: 'TEST',
        relevanceScore: 90,
        semanticScore: 60,
        scopeScore: 30,
        matchedTerms: ['p1326'],
        matchLocations: { p1326: ['title'] },
        dtcs: ['P1326'],
        sounds: [],
        conditions: [],
        systems: ['engine'],
        canonicalTerms: ['p1326'],
        sourceVariantCount: 1
      }
    }],
    elapsedMs: 25,
    timeBudgetExceeded: false,
    crawlTruncated: false
  };
}

test('same manual cache key joins one in-flight live scrape', async () => {
  const lemonPath = require.resolve('../src/services/lemon');
  const dbPath = require.resolve('../src/db');
  const scraperPath = require.resolve('../scripts/scrape-lemon-targeted-evidence');
  const restoreDb = replaceModule(dbPath, {
    getCachedManual: async () => null,
    saveScrapedManual: async () => null,
    buildManualCacheKey: (_vehicle, context = {}) => `key:${context.query || ''}`
  });

  let scrapeCalls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const restoreScraper = replaceModule(scraperPath, {
    scorePage: () => ({ score: 0 }),
    scrapeTargetedEvidence: async () => {
      scrapeCalls += 1;
      await gate;
      return targetedFixture();
    }
  });

  delete require.cache[lemonPath];
  try {
    const { scrapeLEMONManuals } = require(lemonPath);
    const vehicle = { year: 2020, make: 'KIA', model: 'Optima', engine: '2.4L', drivetrain: 'FWD' };
    const context = { query: 'P1326 knock signal', obdCodes: ['P1326'] };

    const first = scrapeLEMONManuals(vehicle, context);
    const second = scrapeLEMONManuals(vehicle, context);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(scrapeCalls, 1, 'duplicate callers must join the same live scrape');
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.items.length, 1);
    assert.equal(b.items.length, 1);
  } finally {
    delete require.cache[lemonPath];
    restoreScraper();
    restoreDb();
  }
});

test('different manual context keys remain independent', async () => {
  const lemonPath = require.resolve('../src/services/lemon');
  const dbPath = require.resolve('../src/db');
  const scraperPath = require.resolve('../scripts/scrape-lemon-targeted-evidence');
  const restoreDb = replaceModule(dbPath, {
    getCachedManual: async () => null,
    saveScrapedManual: async () => null,
    buildManualCacheKey: (_vehicle, context = {}) => `key:${context.query || ''}`
  });

  let scrapeCalls = 0;
  const restoreScraper = replaceModule(scraperPath, {
    scorePage: () => ({ score: 0 }),
    scrapeTargetedEvidence: async () => {
      scrapeCalls += 1;
      return targetedFixture();
    }
  });

  delete require.cache[lemonPath];
  try {
    const { scrapeLEMONManuals } = require(lemonPath);
    const vehicle = { year: 2020, make: 'KIA', model: 'Optima', engine: '2.4L', drivetrain: 'FWD' };
    await Promise.all([
      scrapeLEMONManuals(vehicle, { query: 'P1326' }),
      scrapeLEMONManuals(vehicle, { query: 'P0300' })
    ]);
    assert.equal(scrapeCalls, 2);
  } finally {
    delete require.cache[lemonPath];
    restoreScraper();
    restoreDb();
  }
});

test('vehicle warmup uses stored evidence only and does not launch a live manual crawl', async () => {
  const warmupPath = require.resolve('../src/services/vehicle.warmup');
  const tsbPath = require.resolve('../src/services/tsb.harvester');
  const dbPath = require.resolve('../src/db');
  const vinPath = require.resolve('../src/services/vin');

  let storedReads = 0;
  const restoreTsb = replaceModule(tsbPath, {
    loadStoredTsbCorpus: async () => {
      storedReads += 1;
      return [];
    }
  });
  const restoreDb = replaceModule(dbPath, {
    buildVehicleCacheKey: vehicle => `${vehicle.year}|${String(vehicle.make).toLowerCase()}|${String(vehicle.model).toLowerCase()}`
  });
  const restoreVin = replaceModule(vinPath, { decodeVinNhtsa: async () => null });

  delete require.cache[warmupPath];
  try {
    const { warmVehicleEvidence, getVehicleWarmupStatus } = require(warmupPath);
    const vehicle = { year: 2020, make: 'KIA', model: 'Optima', engine: '2.4L', drivetrain: 'FWD' };
    const started = warmVehicleEvidence(vehicle);
    await started.promise;

    assert.equal(storedReads, 1);
    assert.equal(getVehicleWarmupStatus(vehicle).status, 'READY');
  } finally {
    delete require.cache[warmupPath];
    restoreVin();
    restoreDb();
    restoreTsb();
  }
});

test('resolver probes candidate folders concurrently in bounded batches', async () => {
  const resolverPath = require.resolve('../src/services/lemon.path.resolver');
  delete require.cache[resolverPath];
  const { findReachableCandidate } = require(resolverPath);
  const originalFetch = global.fetch;
  let active = 0;
  let maxActive = 0;
  const calls = [];

  global.fetch = async url => {
    calls.push(String(url));
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    const ok = String(url).includes('/hit');
    return { ok, status: ok ? 200 : 404, text: async () => '<html></html>' };
  };

  try {
    const hit = await findReachableCandidate([
      { candidate: { label: 'one' }, repairUrl: 'https://lemon-manuals.la/one' },
      { candidate: { label: 'two' }, repairUrl: 'https://lemon-manuals.la/two' },
      { candidate: { label: 'hit' }, repairUrl: 'https://lemon-manuals.la/hit' },
      { candidate: { label: 'four' }, repairUrl: 'https://lemon-manuals.la/four' }
    ], 2);

    assert.equal(hit.candidate.label, 'hit');
    assert.equal(maxActive, 2, 'resolver should probe each batch concurrently but respect its concurrency bound');
    assert.equal(calls.length, 4, 'second batch is required before the hit is found');
  } finally {
    global.fetch = originalFetch;
    delete require.cache[resolverPath];
  }
});
