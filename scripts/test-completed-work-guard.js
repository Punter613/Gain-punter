'use strict';

const assert = require('assert');
const { extractCompletedWork } = require('../src/core/orchestrator/completed.work.guard');

function sorted(values) {
  return [...values].sort();
}

const cases = [
  {
    name: 'inspection with explicit not-replaced must remain diagnostically active',
    notices: [`Replaced the axle seal on the left side and the front wheel bearing.
Also replaced the rear axle assembly. Upper ball joint was inspected
but not replaced — still shows minor play.`],
    expected: ['rear axle assembly', 'wheel bearing']
  },
  {
    name: 'completed list inherits the leading replacement verb',
    notices: ['Replaced the cv axles the lower ball joints and the upper control arms'],
    expected: ['cv axle', 'lower ball joint', 'upper control arm']
  },
  {
    name: 'inspected but not replaced is not completed work',
    notices: ['Upper ball joint was inspected but not replaced and still has minor play'],
    expected: []
  },
  {
    name: 'inspection followed by actual replacement is completed',
    notices: ['Upper ball joint was inspected, then replaced'],
    expected: ['upper ball joint']
  },
  {
    name: 'future work request is not completed work',
    notices: ['Need to replace the upper ball joint'],
    expected: []
  },
  {
    name: 'inspection resets completion context before next component',
    notices: ['Replaced the CV axle and inspected the upper ball joint but did not replace it'],
    expected: ['cv axle']
  }
];

for (const testCase of cases) {
  const actual = extractCompletedWork(testCase.notices);
  assert.deepStrictEqual(sorted(actual), sorted(testCase.expected), testCase.name);
  console.log(`PASS: ${testCase.name} -> ${actual.join(', ') || 'none'}`);
}

console.log(`Completed-work guard regression harness passed ${cases.length}/${cases.length} cases.`);
