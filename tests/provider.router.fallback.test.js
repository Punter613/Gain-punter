'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const aiClient = require('../src/services/ai/aiClient');
const groqProvider = require('../src/services/ai/providers/groq');
const geminiProvider = require('../src/services/ai/providers/gemini');

function normalizedGeminiResponse(reason) {
  return {
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    usage: { total_tokens: 1 },
    _provider: 'gemini',
    _fallbackReason: reason
  };
}

async function withProviderMocks(fn) {
  const originalGroqChat = groqProvider.chat;
  const originalGeminiChat = geminiProvider.chat;
  const originalGeminiConfigured = geminiProvider.isConfigured;
  const originalGroqKey = process.env.GROQ_API_KEY;

  aiClient.setProvider('groq');

  try {
    await fn();
  } finally {
    groqProvider.chat = originalGroqChat;
    geminiProvider.chat = originalGeminiChat;
    geminiProvider.isConfigured = originalGeminiConfigured;
    aiClient.setProvider('groq');

    if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroqKey;
  }
}

test('missing GROQ_API_KEY falls back to Gemini exactly once through aiClient', async () => {
  await withProviderMocks(async () => {
    delete process.env.GROQ_API_KEY;

    let groqCalls = 0;
    let geminiCalls = 0;
    let capturedPayload;

    groqProvider.chat = async () => {
      groqCalls++;
      throw new Error('Groq adapter should not be called without a key when Gemini is configured');
    };
    geminiProvider.isConfigured = () => true;
    geminiProvider.chat = async (payload) => {
      geminiCalls++;
      capturedPayload = payload;
      return normalizedGeminiResponse(payload.fallbackReason);
    };

    const result = await aiClient.aiChat({
      messages: [{ role: 'user', content: 'diagnose this' }],
      model: 'openai/gpt-oss-120b',
      temperature: 0.2,
      max_tokens: 500
    });

    assert.equal(groqCalls, 0);
    assert.equal(geminiCalls, 1);
    assert.equal(capturedPayload.fallbackReason, 'GROQ_NOT_CONFIGURED');
    assert.match(capturedPayload.model, /^gemini-/i);
    assert.equal(result._provider, 'gemini');
    assert.equal(result._fallbackReason, 'GROQ_NOT_CONFIGURED');
    assert.equal(result.choices[0].message.content, '{"ok":true}');
  });
});

test('retryable Groq runtime failure falls back to Gemini exactly once', async () => {
  await withProviderMocks(async () => {
    process.env.GROQ_API_KEY = 'test-only-key';

    let groqCalls = 0;
    let geminiCalls = 0;
    let capturedPayload;

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
      capturedPayload = payload;
      return normalizedGeminiResponse(payload.fallbackReason);
    };

    const result = await aiClient.aiChat({
      messages: [{ role: 'user', content: 'estimate this' }],
      model: 'openai/gpt-oss-120b',
      response_format: { type: 'json_object' }
    });

    assert.equal(groqCalls, 1);
    assert.equal(geminiCalls, 1);
    assert.equal(capturedPayload.fallbackReason, 'RATE_LIMIT_EXCEEDED_429');
    assert.match(capturedPayload.model, /^gemini-/i);
    assert.equal(result._provider, 'gemini');
    assert.equal(result._fallbackReason, 'RATE_LIMIT_EXCEEDED_429');
  });
});
