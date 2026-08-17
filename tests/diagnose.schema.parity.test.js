'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DIAGNOSE_CANONICAL_FIELDS,
  DIAGNOSE_DOWNSTREAM_OWNED_FIELDS,
  DIAGNOSE_MODEL_OWNED_FIELDS,
  buildDiagnoseCanonicalSchema,
  buildGeminiDiagnoseSchema,
  extractDiagnoseObdCodes,
  prepareGeminiDiagnosePayload
} = require('../src/services/ai/diagnose.schema');
const geminiProvider = require('../src/services/ai/providers/gemini');
const { diagnosisJsonSchema } = require('../scripts/compare-diagnose-models');

const LIVE_IMPACT_FIELDS = [
  'codeExplanations',
  'repairSteps',
  'proTips',
  'estimatedRepairTime'
];

const PRE_FIX_GEMINI_FIELDS = [
  'urgency',
  'safetyRisk',
  'primaryCause',
  'secondaryCauses',
  'probability',
  'recommendedTests',
  'additionalChecks',
  'notes'
];

const actualModelResponse = {
  urgency: 'soon',
  safetyRisk: false,
  primaryCause: 'Engine mount movement requires confirmation',
  secondaryCauses: ['Driveline lash'],
  codeExplanations: {
    P0300: 'Random or multiple-cylinder misfire detected',
    P0171: 'Bank 1 fuel mixture is lean'
  },
  probability: [{ cause: 'Engine mount movement', likelihood: 65 }],
  repairSteps: ['Measure mount movement under controlled load'],
  proTips: ['Compare cold and warm mount movement'],
  recommendedTests: ['Observe powertrain movement during a controlled brake-torque test'],
  additionalChecks: ['Inspect transmission mount condition'],
  estimatedRepairTime: '0.5 hour diagnostic inspection',
  notes: 'Confirm the fault before repair.'
};

function diagnosePayload(extra = {}) {
  return {
    messages: [
      {
        role: 'system',
        content: 'You are the expert diagnostic logic unit of SKSK ProTech.'
      },
      {
        role: 'user',
        content: `DIAGNOSTIC_EVIDENCE_PACKET_V1:\n${JSON.stringify({
          stage: 'DIAGNOSE',
          dtcs: ['p0300', 'P0171', 'P0300', 'not-a-code']
        })}`
      }
    ],
    max_tokens: 2500,
    response_format: { type: 'json_object' },
    ...extra
  };
}

function rejectedKeys(schema, value) {
  if (schema.additionalProperties !== false) return [];
  return Object.keys(value).filter(key => !Object.hasOwn(schema.properties, key));
}

test('pre-fix Gemini schema rejects the four model-owned fields that reached users as defaults', () => {
  const preFixSchema = {
    additionalProperties: false,
    properties: Object.fromEntries(PRE_FIX_GEMINI_FIELDS.map(field => [field, {}]))
  };

  assert.deepEqual(rejectedKeys(preFixSchema, actualModelResponse), LIVE_IMPACT_FIELDS);
});

test('canonical Diagnose contract documents all 13 route response fields', () => {
  const schema = buildDiagnoseCanonicalSchema(['P0300', 'P0171']);

  assert.deepEqual(schema.required, [...DIAGNOSE_CANONICAL_FIELDS]);
  assert.deepEqual(Object.keys(schema.properties), [...DIAGNOSE_CANONICAL_FIELDS]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.codeExplanations.required, ['P0300', 'P0171']);
});

test('Gemini strict schema restores all model-owned fields and omits only downstream TSB output', () => {
  const schema = buildGeminiDiagnoseSchema(['P0300', 'P0171']);

  assert.deepEqual(DIAGNOSE_DOWNSTREAM_OWNED_FIELDS, ['knownIssues']);
  assert.deepEqual(schema.required, [...DIAGNOSE_MODEL_OWNED_FIELDS]);
  assert.deepEqual(Object.keys(schema.properties), [...DIAGNOSE_MODEL_OWNED_FIELDS]);
  assert.deepEqual(rejectedKeys(schema, actualModelResponse), []);
  assert.equal(Object.hasOwn(schema.properties, 'knownIssues'), false);

  for (const field of LIVE_IMPACT_FIELDS) {
    assert.ok(schema.properties[field], `${field} must survive Gemini schema preparation`);
  }
});

test('Gemini preparation derives per-code schema keys from the bounded evidence packet', () => {
  const prepared = prepareGeminiDiagnosePayload(diagnosePayload());
  const schema = prepared.response_format.json_schema.schema;

  assert.equal(prepared.max_tokens, 4096);
  assert.deepEqual(schema.properties.codeExplanations.required, ['P0300', 'P0171']);
  assert.deepEqual(
    Object.keys(schema.properties.codeExplanations.properties),
    ['P0300', 'P0171']
  );
});

test('direct Gemini and Groq fallback prepare the same Diagnose contract', () => {
  const direct = prepareGeminiDiagnosePayload(diagnosePayload());
  const fallback = prepareGeminiDiagnosePayload(diagnosePayload({
    fallbackReason: 'RATE_LIMIT_EXCEEDED_429'
  }));

  assert.deepEqual(direct.response_format, fallback.response_format);
  assert.equal(fallback.fallbackReason, 'RATE_LIMIT_EXCEEDED_429');
});

test('Gemini REST adapter transmits the derived Diagnose schema unchanged', () => {
  const prepared = prepareGeminiDiagnosePayload(diagnosePayload());
  const request = geminiProvider.buildRequest(prepared.messages, prepared);
  const wireSchema = request.body.generationConfig.responseFormat.text.schema;

  assert.equal(request.schemaVariant, 'provider-shared');
  assert.deepEqual(wireSchema, prepared.response_format.json_schema.schema);
  assert.deepEqual(wireSchema.properties.codeExplanations.required, ['P0300', 'P0171']);
  for (const field of LIVE_IMPACT_FIELDS) assert.ok(wireSchema.properties[field]);
});

test('Diagnose DTC extraction ignores the system example and normalizes legacy prompts', () => {
  assert.deepEqual(extractDiagnoseObdCodes(diagnosePayload()), ['P0300', 'P0171']);

  const legacyPrompt = diagnosePayload({
    messages: [
      { role: 'system', content: 'Expert diagnostic prompt. Example P0420.' },
      { role: 'user', content: 'Vehicle codes: p0455 and U1000.' }
    ]
  });
  assert.deepEqual(extractDiagnoseObdCodes(legacyPrompt), ['P0455', 'U1000']);
});

test('Groq benchmark schema is generated from the production canonical contract', () => {
  assert.deepEqual(
    diagnosisJsonSchema.schema,
    buildDiagnoseCanonicalSchema(['P0300', 'P0171'])
  );
});

test('non-Diagnose Gemini payloads are not rewritten', () => {
  const payload = {
    messages: [{ role: 'user', content: 'Estimate verified work' }],
    max_tokens: 800,
    response_format: { type: 'json_object' }
  };
  assert.equal(prepareGeminiDiagnosePayload(payload), payload);
});
