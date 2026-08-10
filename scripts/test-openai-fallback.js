const assert = require('assert');

const openai = require('../src/services/ai/providers/openai');
const { isRetryableProviderError, fallbackReason } = require('../src/services/ai/providerRouter');
const { isRetryableGroqError, groqFallbackReason } = require('../src/services/groq');

const request = openai.buildRequest([
  { role: 'system', content: 'Return JSON only.' },
  { role: 'user', content: 'diagnose this' }
], {
  model: 'gpt-5-mini',
  max_tokens: 800,
  reasoning_effort: 'low',
  response_format: { type: 'json_object' }
});

assert.equal(request.model, 'gpt-5-mini');
assert.equal(request.instructions, 'Return JSON only.');
assert.equal(request.input.length, 1);
assert.equal(request.input[0].role, 'user');
assert.equal(request.max_output_tokens, 800);
assert.equal(request.reasoning.effort, 'low');
assert.equal(request.text.format.type, 'json_object');
assert.equal(request.store, false);

assert.equal(openai.resolveModel('openai/gpt-oss-120b'), process.env.OPENAI_FALLBACK_MODEL || 'gpt-5-mini');
assert.equal(openai.resolveModel('gpt-5-mini'), 'gpt-5-mini');

const normalized = openai.normalizeResponse({
  id: 'resp_test',
  model: 'gpt-5-mini',
  status: 'completed',
  output: [{
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }]
  }],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, output_tokens_details: { reasoning_tokens: 2 } }
}, 123, 'RATE_LIMIT_EXCEEDED_429');

assert.equal(normalized.choices[0].message.content, '{"ok":true}');
assert.equal(normalized.choices[0].finish_reason, 'stop');
assert.equal(normalized.usage.prompt_tokens, 10);
assert.equal(normalized.usage.completion_tokens, 5);
assert.equal(normalized._provider, 'openai');
assert.equal(normalized._fallbackReason, 'RATE_LIMIT_EXCEEDED_429');

const rateLimit = Object.assign(new Error('Rate limit reached'), { status: 429, code: 'rate_limit_exceeded' });
assert.equal(isRetryableProviderError(rateLimit), true);
assert.equal(isRetryableGroqError(rateLimit), true);
assert.equal(fallbackReason(rateLimit), 'RATE_LIMIT_EXCEEDED_429');
assert.equal(groqFallbackReason(rateLimit), 'RATE_LIMIT_EXCEEDED_429');

const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
assert.equal(isRetryableProviderError(authError), false);
assert.equal(isRetryableGroqError(authError), false);

console.log('OpenAI fallback regression: PASS');
