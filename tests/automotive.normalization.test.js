const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractDtcs,
  extractCanonicalProfile,
  classifyManualSection,
  buildCanonicalSearchTerms
} = require('../src/core/automotive.normalization');

test('extracts and deduplicates DTCs', () => {
  assert.deepEqual(extractDtcs('P0300 with p0171 and P0300 history'), ['P0300', 'P0171']);
});

test('normalizes mechanic sound and operating condition vocabulary', () => {
  const profile = extractCanonicalProfile({
    symptoms: 'Makes a thump when I let off the gas and a clunk with the wheel turned all the way',
    obdCodes: ['P0300', 'P0171']
  });

  assert.ok(profile.sounds.includes('bump'));
  assert.ok(profile.sounds.includes('clunk'));
  assert.ok(profile.conditions.includes('deceleration'));
  assert.ok(profile.conditions.includes('full_lock'));
  assert.ok(profile.dtcs.includes('P0300'));
  assert.ok(profile.dtcs.includes('P0171'));
});

test('builds page-ranking terms without vehicle identity or loose raw tokens', () => {
  const { profile, terms, vehicleTerms } = buildCanonicalSearchTerms(
    { year: 2008, make: 'Kia', model: 'Sorento', engine: '3.8L' },
    { symptoms: 'bump on accelerator release', obdCodes: ['P0300'] }
  );

  assert.ok(profile.conditions.includes('deceleration'));
  assert.ok(terms.includes('deceleration'));
  assert.ok(terms.includes('p0300'));
  assert.ok(!terms.includes('kia'));
  assert.ok(!terms.includes('sorento'));
  assert.ok(!terms.includes('3.8l'));
  assert.ok(!terms.includes('release'));
  assert.deepEqual(vehicleTerms, ['kia', 'sorento', '3.8l']);
});

test('classifies common manual section types', () => {
  assert.equal(classifyManualSection({ title: 'Testing and Inspection - P0171' }), 'TEST');
  assert.equal(classifyManualSection({ title: 'Removal and Installation - Steering Gear' }), 'REPAIR');
  assert.equal(classifyManualSection({ title: 'Torque Specifications' }), 'SPEC');
  assert.equal(classifyManualSection({ title: 'Technical Service Bulletin' }), 'TSB');
});

test('does not classify every Lemon page as diagnosis from the parent folder URL', () => {
  const result = classifyManualSection({
    title: 'Fuel Pressure Release — 2008 Kia Sorento Service Manual',
    url: 'https://lemon-manuals.la/Kia/2008/Sorento%202WD%20V6-3.8L/Repair%20and%20Diagnosis/Engine%2C%20Cooling%20and%20Exhaust/Engine/Tune-up/Fuel%20Filter/Fuel%20Pressure%20Release/'
  });
  assert.notEqual(result, 'DIAGNOSIS');
});

test('captures the exact Sorento runtime complaint triggers', () => {
  const profile = extractCanonicalProfile({
    symptoms: 'repetitive bump on accelerator release; clunk at full steering lock',
    obdCodes: ['P0300', 'P0171']
  });

  assert.ok(profile.triggers.includes('deceleration'));
  assert.ok(profile.triggers.includes('turning'));
  assert.ok(profile.conditions.includes('full_lock'));
});
