'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeJobRepair } = require('../src/middleware/repair.authorization.middleware');

test('job adapter rejects VERIFIED state without a bounded mechanic-confirmed cause', () => {
  const result = authorizeJobRepair({ status: 'VERIFIED', verification: { confirmed: true }, tests: [{ name: 'test', result: 'done' }] });
  assert.equal(result.authorized, false);
});

test('job adapter authorizes only persisted explicit verification plus bounded cause', () => {
  const result = authorizeJobRepair({
    status: 'VERIFIED',
    verification: {
      confirmed: true,
      confirmedCause: 'right front wheel speed sensor circuit',
      conclusion: 'sensor physically damaged and signal fault confirmed'
    },
    tests: [{ name: 'wheel speed comparison', result: 'RF signal invalid' }]
  });
  assert.equal(result.authorized, true);
  assert.equal(result.repairScope[0].component, 'right front wheel speed sensor circuit');
});
