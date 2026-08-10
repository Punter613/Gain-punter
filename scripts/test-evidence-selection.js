const assert = require('assert');
const { selectRelevantTsbs, evidenceContextKey } = require('../src/services/vehicle.evidence');

const context = {
  symptoms: 'clunking noise when accelerator is released and steering is at full lock',
  mechanicNotices: [],
  obdCodes: ['P0300', 'P0171'],
  keywords: ['clunk', 'full steering lock', 'torque reversal', 'driveline']
};

const evidence = {
  tsbs: {
    references: [
      {
        title: 'Engine Controls - Engine Management DTCs P2135 and P2138',
        subject: 'Electronic throttle control correlation',
        snippet: 'Diagnostic information for accelerator position sensor DTC P2135 and P2138.',
        relevanceScore: 24,
        extractedFacts: {}
      },
      {
        title: '2003-2009 Driveline Noise on 4WD Equipped Sorento Models',
        subject: 'Driveline noise on 4WD Sorento',
        snippet: 'Sharp metallic ping or creak through driveshaft and transfer case during Neutral to Drive or Reverse load change.',
        relevanceScore: 28,
        extractedFacts: { symptoms: ['driveline noise'], conditions: ['reverse', 'drive'] }
      }
    ]
  }
};

const selected = selectRelevantTsbs(evidence, context, 12);
assert.equal(selected.length, 1);
assert.ok(selected[0].title.includes('Driveline Noise'));
assert.notEqual(evidenceContextKey({ symptoms: 'clunk' }), evidenceContextKey({ symptoms: 'misfire' }));

const codeContext = { ...context, symptoms: 'accelerator pedal warning', obdCodes: ['P2135'], keywords: [] };
const codeSelected = selectRelevantTsbs(evidence, codeContext, 12);
assert.ok(codeSelected.some(item => item.title.includes('P2135')));

console.log('evidence selection regression: PASS');
