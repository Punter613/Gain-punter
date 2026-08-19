'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildStoredNavigationSeeds,
  rankNavigationLink
} = require('../src/services/manual.navigation.seeds');
const { buildCurrentSearchContext } = require('../src/services/manual.evidence.reuse');

const vehicle = {
  year: 2008,
  make: 'KIA',
  model: 'Sorento',
  trim: 'BL',
  engine: '3.8L',
  drivetrain: '4WD'
};

const rootUrl = 'https://charm.li/Kia/2008/Sorento%204WD%20V6-3.8L/Repair%20and%20Diagnosis/';

function link(path, text) {
  return { url: `${rootUrl}${path}/`, text };
}

function storedRow(links) {
  return {
    vehicle_key: '2008|kia|sorento|3.8l|4wd|ctx-balance',
    scraped_at: '2026-08-18T23:50:00.000Z',
    data: {
      schemaVersion: 5,
      source: 'LEMON_MANUALS',
      vehicle: { ...vehicle },
      resolved_url: rootUrl,
      items: [],
      corpusItems: [],
      navigationLinks: links
    }
  };
}

test('multi-DTC stored navigation seeds are balanced and reserve probe depth below branch roots', () => {
  const links = [
    link('Powertrain%20Management/Ignition%20System/A', 'Ignition System Testing A'),
    link('Powertrain%20Management/Ignition%20System/B', 'Ignition System Testing B'),
    link('Powertrain%20Management/Ignition%20System/C', 'Ignition System Testing C'),
    link('Powertrain%20Management/Ignition%20System/D', 'Ignition System Testing D'),
    link('Powertrain%20Management/Ignition%20System/E', 'Ignition System Testing E'),
    link('Powertrain%20Management/Ignition%20System/F', 'Ignition System Testing F'),
    link('Powertrain%20Management/Ignition%20System/G', 'Ignition System Testing G'),
    link('Powertrain%20Management/Ignition%20System/H', 'Ignition System Testing H'),
    link('Powertrain%20Management/Air%20Intake/A', 'Air Intake Vacuum Testing A'),
    link('Powertrain%20Management/Air%20Intake/B', 'Air Intake Vacuum Testing B'),
    link('Powertrain%20Management/Fuel%20Trim/A', 'Fuel Trim Testing A'),
    link('Powertrain%20Management/Fuel%20Trim/B', 'Fuel Trim Testing B')
  ];

  const seeds = buildStoredNavigationSeeds(
    [storedRow(links)],
    vehicle,
    { query: 'P0300 P0171 random misfire lean bank 1', obdCodes: ['P0300', 'P0171'] },
    'diagnosis',
    { limit: 12 }
  );

  assert.equal(seeds.length, 6, 'two-DTC probe keeps three structural entry points per code and leaves page budget for descendants');
  assert.ok(seeds.some(seed => seed.routingDtcs.includes('P0300')), 'seed set must route toward P0300');
  assert.ok(seeds.some(seed => seed.routingDtcs.includes('P0171')), 'seed set must route toward P0171');
  assert.ok(seeds.some(seed => /ignition/i.test(`${seed.text} ${decodeURIComponent(seed.url)}`)));
  assert.ok(seeds.some(seed => /air intake|fuel trim|vacuum/i.test(`${seed.text} ${decodeURIComponent(seed.url)}`)));
});

test('structural routing metadata never masquerades as evidence DTC coverage', () => {
  const search = buildCurrentSearchContext(
    vehicle,
    { query: 'P0300 P0171 random misfire lean bank 1', obdCodes: ['P0300', 'P0171'] }
  );
  const ranked = rankNavigationLink(
    link('Powertrain%20Management/Air%20Intake/Testing', 'Air Intake Vacuum Testing'),
    vehicle,
    search,
    'diagnosis'
  );

  assert.ok(ranked);
  assert.equal(ranked.seedKind, 'STRUCTURAL_NAVIGATION');
  assert.deepEqual(ranked.matchedDtcs, [], 'structural navigation does not claim source evidence');
  assert.ok(ranked.routingDtcs.includes('P0171'), 'routing metadata may guide the P0171 probe');
});
