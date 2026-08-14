'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const aiClient = require('../src/services/ai/aiClient');
const aiRouter = require('../src/services/ai/ai.specialist.router');
const groqProvider = require('../src/services/ai/providers/groq');
const geminiProvider = require('../src/services/ai/providers/gemini');

function normalizedResponse(provider, content, fallbackReason = null) {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { total_tokens: 5 },
    _provider: provider,
    _fallbackReason: fallbackReason,
    _latency: 12
  };
}

test('specialist execute preserves its response contract while calling aiClient', async () => {
  const originalAiChat = aiClient.aiChat;
  let capturedPayload;

  aiClient.aiChat = async (payload) => {
    capturedPayload = payload;
    return normalizedResponse('groq', 'diagnostic-output');
  };

  try {
    const routing = await aiRouter.route('diagnose a clunk', { forceSpecialist: 'diagnostic' });
    const result = await aiRouter.execute(routing, 'diagnose a clunk', {
      vehicleProfile: { year: 2008, make: 'Kia', model: 'Sorento' }
    });

    assert.equal(result.success, true);
    assert.equal(result.specialist, 'Diagnostic AI');
    assert.equal(result.output, 'diagnostic-output');
    assert.equal(result.usage.total_tokens, 5);
    assert.equal(result.latency, 12);
    assert.deepEqual(result.metadata, {
      model: 'openai/gpt-oss-120b',
      jsonMode: false
    });

    assert.equal(capturedPayload.model, 'openai/gpt-oss-120b');
    assert.equal(capturedPayload.temperature, 0.2);
    assert.equal(capturedPayload.max_tokens, 2000);
    assert.equal(capturedPayload.reasoning_effort, 'low');
    assert.equal(capturedPayload.response_format, undefined);
    assert.equal(capturedPayload.messages.length, 2);
    assert.equal(capturedPayload.messages[0].role, 'system');
    assert.equal(capturedPayload.messages[1].role, 'user');
  } finally {
    aiClient.aiChat = originalAiChat;
  }
});

test('specialist path falls back Groq to Gemini exactly once through providerRouter', async () => {
  const originalGroqChat = groqProvider.chat;
  const originalGeminiChat = geminiProvider.chat;
  const originalGeminiConfigured = geminiProvider.isConfigured;
  const originalGroqKey = process.env.GROQ_API_KEY;

  aiClient.setProvider('groq');
  process.env.GROQ_API_KEY = 'test-only-key';

  let groqCalls = 0;
  let geminiCalls = 0;
  let geminiPayload;

  groqProvider.chat = async () => {
    groqCalls++;
    throw Object.assign(new Error('Rate limit reached'), {
      status: 429,
      code: 'rate_limit_exceeded'
    });
  };
  geminiProvider.isConfigured = () => true;
  geminiProvider.chat = async (payload) => {
    geminiCalls++;
    geminiPayload = payload;
    return normalizedResponse('gemini', 'gemini-diagnostic-output', payload.fallbackReason);
  };

  try {
    const routing = await aiRouter.route('diagnose steering noise', { forceSpecialist: 'diagnostic' });
    const result = await aiRouter.execute(routing, 'diagnose steering noise', {});

    assert.equal(groqCalls, 1);
    assert.equal(geminiCalls, 1);
    assert.equal(geminiPayload.fallbackReason, 'RATE_LIMIT_EXCEEDED_429');
    assert.match(geminiPayload.model, /^gemini-/i);

    assert.equal(result.success, true);
    assert.equal(result.specialist, 'Diagnostic AI');
    assert.equal(result.output, 'gemini-diagnostic-output');
    assert.equal(result.usage.total_tokens, 5);
    assert.equal(result.latency, 12);
    assert.deepEqual(result.metadata, {
      model: 'openai/gpt-oss-120b',
      jsonMode: false
    });
  } finally {
    groqProvider.chat = originalGroqChat;
    geminiProvider.chat = originalGeminiChat;
    geminiProvider.isConfigured = originalGeminiConfigured;
    aiClient.setProvider('groq');

    if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroqKey;
  }
});
