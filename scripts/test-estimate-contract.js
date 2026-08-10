const assert = require('assert');
const {
  ESTIMATE_AI_SCHEMA,
  ESTIMATE_RESPONSE_FORMAT,
  buildEvidenceLedger,
  buildFinalEstimate
} = require('../src/contracts/estimate.ai.contract');

function candidateSchema() {
  return ESTIMATE_AI_SCHEMA.properties.candidates.items.properties;
}

assert.strictEqual(ESTIMATE_RESPONSE_FORMAT.type, 'json_schema');
assert.strictEqual(ESTIMATE_RESPONSE_FORMAT.json_schema.strict, true);
for (const field of [
  'factorySupported',
  'mechanicSupported',
  'measuredSupported',
  'confirmationRequired',
  'confirmed',
  'repairAuthorized'
]) {
  assert.strictEqual(candidateSchema()[field].type, 'boolean', `${field} must be a JSON boolean`);
}

const ledger = buildEvidenceLedger({
  oemReferences: [{
    title: 'Steering Wheel Free Play Check',
    url: 'https://example.invalid/oem',
    extractedFacts: { inspections: ['Inspect steering shaft and tie rod ball joints'] }
  }],
  mechanicNotices: [
    'ABS and ESC lights are on and a front passenger wheel speed sensor code is in history'
  ],
  customerStates: [
    'Clunking at full steering lock and bumping when throttle is released'
  ],
  obdCodes: []
});

const ai = {
  priority: 'high',
  diagnosis: 'Front right wheel speed sensor circuit is a leading candidate; driveline play remains unresolved.',
  estimatedHours: 2.5,
  candidates: [
    {
      cause: 'Intermittent front right wheel speed sensor circuit',
      component: 'front right wheel speed sensor',
      modelConfidence: 85,
      evidenceRefs: ['MECH_001', 'OEM_001', 'FAKE_999'],
      contradictions: [],
      confirmationTests: ['Compare all four live wheel-speed PIDs during a slow full-lock turn'],
      evidenceClass: 'MIXED',
      factorySupported: true,
      mechanicSupported: true,
      measuredSupported: true,
      confirmationRequired: false,
      confirmed: true,
      repairAuthorized: true
    },
    {
      cause: 'Driveshaft U-joint or spline play during torque reversal',
      component: 'driveshaft u-joint',
      modelConfidence: 70,
      evidenceRefs: [],
      contradictions: [],
      confirmationTests: ['Check driveline lash and U-joint play during torque reversal'],
      evidenceClass: 'MODEL_INFERENCE',
      factorySupported: false,
      mechanicSupported: false,
      measuredSupported: false,
      confirmationRequired: true,
      confirmed: false,
      repairAuthorized: false
    }
  ],
  repairActions: [
    {
      action: 'Replace front right wheel speed sensor',
      component: 'front right wheel speed sensor',
      evidenceRefs: ['MECH_001'],
      confirmationRequired: false,
      repairAuthorized: true
    }
  ],
  repairSteps: ['Replace the sensor'],
  proTips: [],
  additionalChecks: [],
  notes: 'Contract regression fixture'
};

const result = buildFinalEstimate(ai, {
  ledger,
  laborRate: 65,
  partsCost: 80,
  rustMultiplier: 1
});

assert.strictEqual(result.partsCost, 80, 'mechanic-entered parts cost must be immutable');
assert.strictEqual(result.laborCost, 162.5, 'labor must be deterministic from hours x mechanic rate');
assert.strictEqual(result.total, 242.5, 'total must be deterministic');
assert.strictEqual(result.probability.reduce((sum, item) => sum + item.likelihood, 0), 100, 'display probabilities must sum to 100');

const wheelSpeed = result.candidates[0];
assert.strictEqual(wheelSpeed.mechanicSupported, true, 'matching mechanic evidence should support the candidate');
assert.strictEqual(wheelSpeed.factorySupported, false, 'irrelevant OEM steering evidence must not become factory support for wheel-speed sensor claim');
assert.strictEqual(wheelSpeed.measuredSupported, false, 'historical mechanic note is not measured confirmation');
assert.strictEqual(wheelSpeed.confirmed, false, 'model cannot self-confirm without measured evidence');
assert.strictEqual(wheelSpeed.repairAuthorized, false, 'model cannot self-authorize replacement without confirmation');
assert.ok(wheelSpeed.invalidEvidenceRefs.includes('FAKE_999'), 'invented evidence IDs must be rejected');
assert.ok(wheelSpeed.finalConfidence <= 65, 'mechanic-only evidence must respect deterministic confidence cap');
assert.ok(result.candidates[1].finalConfidence <= 45, 'model-only candidate must respect tier-0 confidence cap');
assert.deepStrictEqual(result.repairs, ['Perform targeted confirmation tests before replacement']);
assert.ok(result.repairSteps.some(step => /wheel-speed PIDs/i.test(step)), 'confirmation tests should replace unauthorized repair procedure');

console.log('estimate contract regression: PASS');
