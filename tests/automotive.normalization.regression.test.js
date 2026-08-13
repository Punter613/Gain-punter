const test = require('node:test');
const assert = require('node:assert/strict');

const { extractCanonicalProfile } = require('../src/core/automotive.normalization');

test('uses shared trigger semantics for passive accelerator release wording', () => {
  const profile = extractCanonicalProfile({
    symptoms: 'bump when accelerator is released'
  });

  assert.ok(profile.conditions.includes('deceleration'));
  assert.ok(profile.triggers.includes('deceleration'));
});

test('does not turn static steering system text into a turning condition', () => {
  const profile = extractCanonicalProfile({
    bodyText: 'Power steering pump is leaking. Inspect steering fluid level and hoses.'
  });

  assert.ok(profile.systems.includes('steering'));
  assert.equal(profile.conditions.includes('turning'), false);
  assert.equal(profile.triggers.includes('turning'), false);
});

test('does preserve explicit turning context in manual evidence', () => {
  const profile = extractCanonicalProfile({
    bodyText: 'Clunk may be heard when turning left at low speed.'
  });

  assert.ok(profile.conditions.includes('turning'));
  assert.ok(profile.conditions.includes('low_speed'));
});

test('does not turn engine stopping into a braking condition', () => {
  const profile = extractCanonicalProfile({
    bodyText: 'Engine keeps stopping unexpectedly at idle.'
  });

  assert.equal(profile.conditions.includes('braking'), false);
});
