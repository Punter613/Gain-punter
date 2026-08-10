const assert = require('assert');
const { mergeVehicleProfile } = require('../src/services/vehicle.warmup');

const merged = mergeVehicleProfile(
  { year: '2008', make: 'KIA', model: 'Sorento', engine: '3.8L', engineCylinders: '6', driveType: '4WD' },
  { year: '2007', make: 'Wrong', model: 'Wrong', trim: 'BL 6cyl 3.8L' },
  'KNDJC736385765089'
);
assert.equal(merged.year, '2008');
assert.equal(merged.make, 'KIA');
assert.equal(merged.model, 'Sorento');
assert.equal(merged.driveType, '4WD');
assert.equal(merged.drivetrain, '4WD');
assert.equal(merged.trim, 'BL 6cyl 3.8L');
console.log('vehicle profile merge regression: PASS');
