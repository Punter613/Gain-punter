const DIAGNOSE_GEMINI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'urgency',
    'safetyRisk',
    'primaryCause',
    'secondaryCauses',
    'probability',
    'recommendedTests',
    'additionalChecks',
    'notes'
  ],
  properties: {
    urgency: { type: 'string', enum: ['immediate', 'soon', 'monitor'] },
    safetyRisk: { type: 'boolean' },
    primaryCause: { type: 'string' },
    secondaryCauses: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string' }
    },
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
    notes: { type: 'string' }
  }
};

const DIAGNOSE_GEMINI_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'sksk_diagnose_reasoning',
    strict: true,
    schema: DIAGNOSE_GEMINI_SCHEMA
  }
};

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
    userText.includes('DIAGNOSTIC_EVIDENCE_PACKET_V1');
}

function prepareGeminiDiagnosePayload(payload = {}) {
  if (!isDiagnosePayload(payload)) return payload;
  return {
    ...payload,
    max_tokens: Math.max(4096, Number(payload.max_tokens || 0)),
    response_format: DIAGNOSE_GEMINI_RESPONSE_FORMAT
  };
}

module.exports = {
  DIAGNOSE_GEMINI_SCHEMA,
  DIAGNOSE_GEMINI_RESPONSE_FORMAT,
  isDiagnosePayload,
  prepareGeminiDiagnosePayload
};
