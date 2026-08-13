const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectRawTriggers,
  assertTriggerSurvival
} = require('../src/core/observation/observation-normalizer');

test('handles noun vs verb operational context correctly', () => {
  const complaint = 'vibration felt in the accelerator pedal while braking';
  const canonicalData = {
    observations: [{
      subject: 'pedal',
      trigger: 'braking',
      operating_conditions: ['braking']
    }]
  };

  const result = assertTriggerSurvival(complaint, canonicalData);
  assert.equal(result.valid, true);
  assert.deepEqual(result.rawTriggers, ['braking']);
});

test('does not mistake engine stopping for a braking trigger', () => {
  assert.deepEqual(
    detectRawTriggers('the engine keeps stopping at red lights'),
    []
  );
});

test('does not mistake stopping language for braking without brake context', () => {
  assert.deepEqual(
    detectRawTriggers('engine vibration happens while stopping unexpectedly'),
    []
  );
});

test('does detect braking when brake context is explicit', () => {
  assert.deepEqual(
    detectRawTriggers('vibration starts when I press the brake pedal'),
    ['braking']
  );
});

test('does not mistake the word bump for a road-impact trigger', () => {
  assert.deepEqual(
    detectRawTriggers('bump bump bump when I let off the throttle'),
    ['deceleration']
  );
});

test('does recognize an actual road-impact event', () => {
  assert.deepEqual(
    detectRawTriggers('front end clunks when I hit a bump'),
    ['road_impact']
  );
});

test('distinguishes accelerator as a subject from acceleration as a trigger', () => {
  assert.deepEqual(
    detectRawTriggers('accelerator pedal vibrates while braking'),
    ['braking']
  );
});

test('does not mistake static steering-system complaints for a turning trigger', () => {
  assert.deepEqual(
    detectRawTriggers('power steering pump is leaking and the steering wheel feels loose'),
    []
  );
});

test('does detect steering as an operating event when turn context is explicit', () => {
  assert.deepEqual(
    detectRawTriggers('clunks when steering left'),
    ['turning']
  );
});

test('preserves three independent operating conditions', () => {
  const complaint = 'clunks when I release the gas, vibrates while braking, and pops at full lock';
  const canonicalData = {
    observations: [
      { trigger: 'throttle released', operating_conditions: ['deceleration'] },
      { trigger: 'braking' },
      { trigger: 'full steering turn', load_state: { steering: { state: 'full_lock' } } }
    ]
  };

  const result = assertTriggerSurvival(complaint, canonicalData);
  assert.equal(result.valid, true);
  assert.deepEqual(result.rawTriggers, ['deceleration', 'turning', 'braking']);
  assert.deepEqual(result.missingTriggers, []);
});

test('fails when provider canonicalization drops a physical trigger', () => {
  const complaint = 'clunks when I release the gas and pops at full lock';
  const canonicalData = {
    observations: [{ trigger: 'throttle released', operating_conditions: ['deceleration'] }]
  };

  const result = assertTriggerSurvival(complaint, canonicalData);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingTriggers, ['turning']);
});
