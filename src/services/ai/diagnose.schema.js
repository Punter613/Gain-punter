'use strict';

const DIAGNOSE_SCHEMA_NAME = 'sksk_diagnose_reasoning';
const DIAGNOSE_CANONICAL_FIELDS = Object.freeze([
  'urgency',
  'safetyRisk',
  'primaryCause',
  'secondaryCauses',
  'codeExplanations',
  'probability',
  'knownIssues',
  'repairSteps',
  'proTips',
  'recommendedTests',
  'additionalChecks',
  'estimatedRepairTime',
  'notes'
]);

// Diagnose replaces this field with TSB-backed evidence after the model
// response. Keep it in the canonical route contract, but do not ask Gemini to
// spend output budget on model memory that the route will discard.
const DIAGNOSE_DOWNSTREAM_OWNED_FIELDS = Object.freeze(['knownIssues']);
const DIAGNOSE_MODEL_OWNED_FIELDS = Object.freeze(
  DIAGNOSE_CANONICAL_FIELDS.filter(field => !DIAGNOSE_DOWNSTREAM_OWNED_FIELDS.includes(field))
);

const OBD_CODE_PATTERN = /^[PCBU][0-3][0-9A-F]{3}$/;
const OBD_CODE_SEARCH_PATTERN = /\b[PCBU][0-3][0-9A-F]{3}\b/gi;
const EVIDENCE_PACKET_MARKERS = Object.freeze([
  'DIAGNOSTIC_EVIDENCE_PACKET_V2:',
  'DIAGNOSTIC_EVIDENCE_PACKET_V1:'
]);

function normalizeObdCodes(values = []) {
  const codes = Array.isArray(values) ? values : [values];
  return [...new Set(codes
    .map(value => String(value || '').trim().toUpperCase())
    .filter(value => OBD_CODE_PATTERN.test(value)))]
    .slice(0, 20);
}

function extractEvidencePacket(text = '') {
  const source = String(text || '');
  for (const marker of EVIDENCE_PACKET_MARKERS) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex === -1) continue;
    const packetText = source.slice(markerIndex + marker.length).trim();
    try {
      const packet = JSON.parse(packetText);
      return packet && typeof packet === 'object' ? packet : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

function extractDiagnoseObdCodes(payload = {}) {
  const userMessages = (Array.isArray(payload.messages) ? payload.messages : [])
    .filter(message => message?.role === 'user')
    .map(message => String(message?.content || ''));

  const packetCodes = userMessages.flatMap(message => {
    const packet = extractEvidencePacket(message);
    return Array.isArray(packet?.dtcs) ? packet.dtcs : [];
  });
  if (packetCodes.length) return normalizeObdCodes(packetCodes);

  // Legacy/benchmark prompts do not carry the evidence packet. Search only
  // user text so the P0300 example in the system prompt cannot become a fake
  // required code.
  return normalizeObdCodes(userMessages.flatMap(message => message.match(OBD_CODE_SEARCH_PATTERN) || []));
}

function buildCodeExplanationSchema(codeList = []) {
  const codes = normalizeObdCodes(codeList);
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(codes.map(code => [code, { type: 'string' }])),
    required: codes
  };
}

function diagnoseProperties(codeList = []) {
  return {
    urgency: { type: 'string', enum: ['immediate', 'soon', 'monitor'] },
    safetyRisk: { type: 'boolean' },
    primaryCause: { type: 'string' },
    secondaryCauses: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string' }
    },
    codeExplanations: buildCodeExplanationSchema(codeList),
    probability: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cause', 'likelihood'],
        properties: {
          cause: { type: 'string' },
          likelihood: { type: 'integer', minimum: 0, maximum: 100 }
        }
      }
    },
    knownIssues: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string' }
    },
    repairSteps: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string' }
    },
    proTips: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string' }
    },
    recommendedTests: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string' }
    },
    additionalChecks: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string' }
    },
    estimatedRepairTime: { type: 'string' },
    notes: { type: 'string' }
  };
}

function buildDiagnoseSchema(codeList = [], fields = DIAGNOSE_CANONICAL_FIELDS) {
  const allProperties = diagnoseProperties(codeList);
  return {
    type: 'object',
    additionalProperties: false,
    required: [...fields],
    properties: Object.fromEntries(fields.map(field => [field, allProperties[field]]))
  };
}

function buildDiagnoseCanonicalSchema(codeList = []) {
  return buildDiagnoseSchema(codeList, DIAGNOSE_CANONICAL_FIELDS);
}

function buildGeminiDiagnoseSchema(codeList = []) {
  return buildDiagnoseSchema(codeList, DIAGNOSE_MODEL_OWNED_FIELDS);
}

function buildDiagnoseJsonSchema(codeList = [], name = DIAGNOSE_SCHEMA_NAME) {
  return {
    name,
    strict: true,
    schema: buildDiagnoseCanonicalSchema(codeList)
  };
}

function buildGeminiDiagnoseResponseFormat(codeList = []) {
  return {
    type: 'json_schema',
    json_schema: {
      name: DIAGNOSE_SCHEMA_NAME,
      strict: true,
      schema: buildGeminiDiagnoseSchema(codeList)
    }
  };
}

const DIAGNOSE_CANONICAL_SCHEMA = buildDiagnoseCanonicalSchema();
const DIAGNOSE_GEMINI_SCHEMA = buildGeminiDiagnoseSchema();
const DIAGNOSE_GEMINI_RESPONSE_FORMAT = buildGeminiDiagnoseResponseFormat();

function isDiagnosePayload(payload = {}) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const systemText = messages
    .filter(message => message?.role === 'system')
    .map(message => String(message?.content || ''))
    .join('\n');
  const userText = messages
    .filter(message => message?.role === 'user')
    .map(message => String(message?.content || ''))
    .join('\n');
  return systemText.includes('expert diagnostic logic unit of SKSK ProTech') ||
    EVIDENCE_PACKET_MARKERS.some(marker => userText.includes(marker.slice(0, -1)));
}

function prepareGeminiDiagnosePayload(payload = {}) {
  if (!isDiagnosePayload(payload)) return payload;
  return {
    ...payload,
    max_tokens: Math.max(4096, Number(payload.max_tokens || 0)),
    response_format: buildGeminiDiagnoseResponseFormat(extractDiagnoseObdCodes(payload))
  };
}

module.exports = {
  DIAGNOSE_SCHEMA_NAME,
  DIAGNOSE_CANONICAL_FIELDS,
  DIAGNOSE_DOWNSTREAM_OWNED_FIELDS,
  DIAGNOSE_MODEL_OWNED_FIELDS,
  DIAGNOSE_CANONICAL_SCHEMA,
  DIAGNOSE_GEMINI_SCHEMA,
  DIAGNOSE_GEMINI_RESPONSE_FORMAT,
  EVIDENCE_PACKET_MARKERS,
  normalizeObdCodes,
  extractEvidencePacket,
  extractDiagnoseObdCodes,
  buildCodeExplanationSchema,
  buildDiagnoseSchema,
  buildDiagnoseCanonicalSchema,
  buildGeminiDiagnoseSchema,
  buildDiagnoseJsonSchema,
  buildGeminiDiagnoseResponseFormat,
  isDiagnosePayload,
  prepareGeminiDiagnosePayload
};
