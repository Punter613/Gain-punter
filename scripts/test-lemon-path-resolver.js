const assert = require('assert');
const { scoreVehicleFolderCandidate, getVehicleSignals } = require('../src/services/lemon.path.resolver');
const { buildVehicleCacheKey } = require('../src/db');

const sorento = {
  year: 2008,
  make: 'KIA',
  model: 'Sorento',
  trim: 'BL 6cyl 3.8L',
  engine: 'BL 6cyl 3.8L',
  driveType: '4WD/4-Wheel Drive/4x4'
};

const signals = getVehicleSignals(sorento);
assert.strictEqual(signals.model, 'sorento');
assert.strictEqual(signals.cylinders, '6');
assert.strictEqual(signals.displacement, '3.8');
assert.strictEqual(signals.drivetrain, '4wd');

const expected = scoreVehicleFolderCandidate({
  text: 'Sorento 4WD V6-3.8L',
  url: 'https://lemon-manuals.la/Kia/2008/Sorento%204WD%20V6-3.8L/'
}, sorento);

const wrongDrive = scoreVehicleFolderCandidate({
  text: 'Sorento 2WD V6-3.8L',
  url: 'https://lemon-manuals.la/Kia/2008/Sorento%202WD%20V6-3.8L/'
}, sorento);

const wrongEngine = scoreVehicleFolderCandidate({
  text: 'Sorento 4WD V6-3.3L',
  url: 'https://lemon-manuals.la/Kia/2008/Sorento%204WD%20V6-3.3L/'
}, sorento);

const wrongModel = scoreVehicleFolderCandidate({
  text: 'Sportage 4WD V6-3.8L',
  url: 'https://lemon-manuals.la/Kia/2008/Sportage%204WD%20V6-3.8L/'
}, sorento);

assert(expected > wrongEngine, `expected 3.8L Sorento folder (${expected}) to outrank 3.3L folder (${wrongEngine})`);
assert(wrongDrive < 0, `explicit 2WD sibling must be hard-rejected for 4WD VIN, got ${wrongDrive}`);
assert(wrongModel < 0, `wrong model should be rejected, got ${wrongModel}`);

const fourWheelKey = buildVehicleCacheKey(sorento);
const twoWheelKey = buildVehicleCacheKey({ ...sorento, driveType: '2WD' });
assert.notStrictEqual(fourWheelKey, twoWheelKey, '2WD and 4WD evidence must never share the same cache key');
assert(fourWheelKey.endsWith('|4wd'), `4WD cache key should end in |4wd, got ${fourWheelKey}`);

console.log('LEMON applicability regression passed:', {
  expected,
  wrongDrive,
  wrongEngine,
  wrongModel,
  fourWheelKey,
  twoWheelKey,
  signals
});
