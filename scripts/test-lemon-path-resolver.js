const assert = require('assert');
const { scoreVehicleFolderCandidate, getVehicleSignals } = require('../src/services/lemon.path.resolver');

const sorento = {
  year: 2008,
  make: 'KIA',
  model: 'Sorento',
  trim: 'BL 6cyl 3.8L',
  engine: 'BL 6cyl 3.8L'
};

const signals = getVehicleSignals(sorento);
assert.strictEqual(signals.model, 'sorento');
assert.strictEqual(signals.cylinders, '6');
assert.strictEqual(signals.displacement, '3.8');

const expected = scoreVehicleFolderCandidate({
  text: 'Sorento 4WD V6-3.8L',
  url: 'https://lemon-manuals.la/Kia/2008/Sorento%204WD%20V6-3.8L/'
}, sorento);

const wrongEngine = scoreVehicleFolderCandidate({
  text: 'Sorento 2WD V6-3.3L',
  url: 'https://lemon-manuals.la/Kia/2008/Sorento%202WD%20V6-3.3L/'
}, sorento);

const wrongModel = scoreVehicleFolderCandidate({
  text: 'Sportage 4WD V6-3.8L',
  url: 'https://lemon-manuals.la/Kia/2008/Sportage%204WD%20V6-3.8L/'
}, sorento);

assert(expected > wrongEngine, `expected 3.8L Sorento folder (${expected}) to outrank 3.3L folder (${wrongEngine})`);
assert(wrongModel < 0, `wrong model should be rejected, got ${wrongModel}`);

console.log('LEMON path resolver regression passed:', { expected, wrongEngine, wrongModel, signals });
