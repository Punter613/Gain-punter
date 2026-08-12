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

test('builds canonical terms without replacing original user wording', () => {
  const { profile, terms } = buildCanonicalSearchTerms(
    { year: 2008, make: 'Kia', model: 'Sorento', engine: '3.8L' },
    { symptoms: 'bump when accelerator is released', obdCodes: ['P0300'] }
  );

  assert.ok(profile.conditions.includes('deceleration'));
  assert.ok(terms.includes('deceleration'));
  assert.ok(terms.includes('kia'));
  assert.ok(terms.includes('sorento'));
  assert.ok(terms.includes('3.8l'));
  assert.ok(terms.includes('p0300'));
});

test('classifies common manual section types', () => {
  assert.equal(classifyManualSection({ title: 'Testing and Inspection - P0171' }), 'TEST');
  assert.equal(classifyManualSection({ title: 'Removal and Installation - Steering Gear' }), 'REPAIR');
  assert.equal(classifyManualSection({ title: 'Torque Specifications' }), 'SPEC');
  assert.equal(classifyManualSection({ title: 'Technical Service Bulletin' }), 'TSB');
});
