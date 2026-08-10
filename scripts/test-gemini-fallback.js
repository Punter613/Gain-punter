const assert = require('assert');

const gemini = require('../src/services/ai/providers/gemini');
const { isRetryableProviderError, fallbackReason } = require('../src/services/ai/providerRouter');
const { isRetryableGroqError, groqFallbackReason } = require('../src/services/groq');

const request = gemini.buildRequest([
  { role: 'system', content: 'Return JSON only.' },
  { role: 'user', content: 'diagnose this' },
  { role: 'assistant', content: '{"candidate":"rack"}' },
  { role: 'user', content: 'verify it' }
], {
  model: 'gemini-3.6-flash',
  max_tokens: 800,
  temperature: 0.15,
  response_format: { type: 'json_object' }
});

assert.equal(request.model, 'gemini-3.6-flash');
assert.equal(request.body.systemInstruction.parts[0].text, 'Return JSON only.');
assert.equal(request.body.contents.length, 3);
assert.equal(request.body.contents[0].role, 'user');
assert.equal(request.body.contents[1].role, 'model');
assert.equal(request.body.contents[2].role, 'user');
assert.equal(request.body.generationConfig.maxOutputTokens, 800);
assert.equal(request.body.generationConfig.temperature, 0.15);
assert.equal(request.body.generationConfig.responseMimeType, 'application/json');

assert.equal(
  gemini.resolveModel('openai/gpt-oss-120b'),
  process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash'
);
assert.equal(gemini.resolveModel('gemini-3.6-flash'), 'gemini-3.6-flash');

const schemaRequest = gemini.buildRequest(
  [{ role: 'user', content: 'return object' }],
  {
    response_format: {
      type: 'json_schema',
      json_schema: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false
        }
      }
    }
  }
);
assert.equal(schemaRequest.body.generationConfig.responseMimeType, 'application/json');
assert.equal(schemaRequest.body.generationConfig.responseJsonSchema.type, 'object');

const normalized = gemini.normalizeResponse({
  responseId: 'gemini_test',
  candidates: [{
    finishReason: 'STOP',
    content: { role: 'model', parts: [{ text: '{"ok":true}' }] }
  }],
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 5,
    totalTokenCount: 17,
    thoughtsTokenCount: 2
  }
}, 'gemini-3.6-flash', 123, 'RATE_LIMIT_EXCEEDED_429');

assert.equal(normalized.choices[0].message.content, '{"ok":true}');
assert.equal(normalized.choices[0].finish_reason, 'stop');
assert.equal(normalized.usage.prompt_tokens, 10);
assert.equal(normalized.usage.completion_tokens, 5);
assert.equal(normalized.usage.total_tokens, 17);
assert.equal(normalized.usage.completion_tokens_details.reasoning_tokens, 2);
assert.equal(normalized._provider, 'gemini');
assert.equal(normalized._fallbackReason, 'RATE_LIMIT_EXCEEDED_429');

const rateLimit = Object.assign(new Error('Rate limit reached'), { status: 429, code: 'rate_limit_exceeded' });
assert.equal(isRetryableProviderError(rateLimit), true);
assert.equal(isRetryableGroqError(rateLimit), true);
assert.equal(fallbackReason(rateLimit), 'RATE_LIMIT_EXCEEDED_429');
assert.equal(groqFallbackReason(rateLimit), 'RATE_LIMIT_EXCEEDED_429');

const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
assert.equal(isRetryableProviderError(authError), false);
assert.equal(isRetryableGroqError(authError), false);

console.log('Gemini fallback regression: PASS');
