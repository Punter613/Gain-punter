'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildStoredNavigationSeeds,
  isWithinManualRoot
} = require('../src/services/manual.navigation.seeds');
const {
  buildNavigationIndex,
  prepareSeedLinks,
  seedCoverageSatisfied
} = require('../scripts/scrape-lemon-targeted-evidence');
const {
  safeSeedLinks,
  safeWorkerOptions
} = require('../src/services/lemon.worker');

const vehicle = {
  year: 2008,
  make: 'KIA',
  model: 'Sorento',
  engine: '3.8L',
  drivetrain: '4WD'
};

const rootUrl = 'https://charm.li/Kia/2008/Sorento%204WD%20V6-3.8L/Repair%20and%20Diagnosis/';

function storedRow(links, vehicleOverride = vehicle) {
  return {
    vehicle_key: '2008|kia|sorento|3.8l|4wd|ctx-test',
    scraped_at: '2026-08-18T22:00:00.000Z',
    data: {
      schemaVersion: 5,
      source: 'LEMON_MANUALS',
      vehicle: { ...vehicleOverride },
      resolved_url: rootUrl,
      navigationLinks: links,
      items: [],
      corpusItems: []
    }
  };
}

test('manual-root boundary accepts descendants and rejects sibling vehicle/manual paths', () => {
  assert.equal(
    isWithinManualRoot(`${rootUrl}Powertrain%20Management/Fuel%20Delivery/`, rootUrl),
    true
  );
  assert.equal(
    isWithinManualRoot('https://charm.li/Kia/2008/Optima/Repair%20and%20Diagnosis/', rootUrl),
    false
  );
});

test('same-vehicle navigation index yields deterministic DTC-meaning seeds without generic engine links', () => {
  const rows = [storedRow([
    {
      url: `${rootUrl}Powertrain%20Management/Computers%20and%20Control%20Systems/Testing%20and%20Inspection/System%20Too%20Lean%20Bank%201/`,
      text: 'System Too Lean Bank 1 - Fuel Trim Testing'
    },
    {
      url: `${rootUrl}Powertrain%20Management/Computers%20and%20Control%20Systems/Description%20and%20Operation/`,
      text: 'Engine Control Overview'
    },
    {
      url: 'https://charm.li/Kia/2008/Optima/Repair%20and%20Diagnosis/Powertrain/',
      text: 'System Too Lean Bank 1'
    }
  ])];

  const seeds = buildStoredNavigationSeeds(
    rows,
    vehicle,
    { query: 'P0171 lean bank 1 fuel trim', obdCodes: ['P0171'] },
    'diagnosis'
  );

  assert.equal(seeds.length, 1);
  assert.match(seeds[0].text, /fuel trim/i);
  assert.deepEqual(seeds[0].matchedDtcs, ['P0171']);
  assert.ok(seeds[0].priority > 0);
});

test('stored navigation seeds do not cross explicit vehicle engine identity', () => {
  const rows = [storedRow([
    {
      url: `${rootUrl}Powertrain%20Management/Testing%20and%20Inspection/P0300/`,
      text: 'P0300 Random Multiple Cylinder Misfire'
    }
  ], { ...vehicle, engine: '2.5L' })];

  const seeds = buildStoredNavigationSeeds(
    rows,
    vehicle,
    { query: 'P0300 random misfire', obdCodes: ['P0300'] },
    'diagnosis'
  );

  assert.deepEqual(seeds, []);
});

test('cold-crawl navigation index retains only bounded links inside the resolved manual root', () => {
  const candidates = [{
    page: {
      links: [
        { url: `${rootUrl}A/`, text: 'P0300 Random Misfire' },
        { url: `${rootUrl}B/`, text: 'P0171 Fuel Trim' },
        { url: `${rootUrl}B/`, text: 'P0171 Fuel Trim Testing and Inspection' },
        { url: 'https://charm.li/Kia/2008/Optima/Repair%20and%20Diagnosis/C/', text: 'P0171' }
      ]
    }
  }];

  const index = buildNavigationIndex(candidates, rootUrl, 2);
  assert.equal(index.length, 2);
  assert.ok(index.every(link => link.url.startsWith(rootUrl)));
  assert.equal(index.find(link => /\/B\/$/.test(link.url)).text, 'P0171 Fuel Trim Testing and Inspection');
});

test('worker seed sanitizer bounds data and crawler seed prep rechecks manual-root containment', () => {
  const raw = [
    { url: `${rootUrl}A/`, text: ' P0300   Random Misfire ', priority: 99, matchedDtcs: ['P0300'] },
    { url: 'javascript:alert(1)', text: 'bad' },
    { url: 'https://example.com/not-manual', text: 'P0171', priority: 500 }
  ];
  const sanitized = safeSeedLinks(raw);
  assert.equal(sanitized.length, 2, 'worker boundary keeps only http(s); manual-root validation happens in crawler');
  assert.equal(sanitized[0].text, 'P0300 Random Misfire');

  const safeOptions = safeWorkerOptions({ seedLinks: raw, seedProbeBudgetMs: 4000, seedFetchTimeoutMs: 2000 });
  assert.equal(safeOptions.seedLinks.length, 2);
  assert.equal(safeOptions.seedProbeBudgetMs, 4000);
  assert.equal(safeOptions.seedFetchTimeoutMs, 2000);

  const prepared = prepareSeedLinks(safeOptions.seedLinks, rootUrl);
  assert.equal(prepared.length, 1);
  assert.match(prepared[0].url, /\/A\/$/);
});

test('seed early-stop requires coverage of every resolved DTC anchor', () => {
  const intent = {
    mode: 'DTC_ANCHORED',
    anchors: [{ code: 'P0300' }, { code: 'P0171' }]
  };
  assert.equal(seedCoverageSatisfied(intent, new Set(['P0300'])), false);
  assert.equal(seedCoverageSatisfied(intent, new Set(['P0300', 'P0171'])), true);
});
