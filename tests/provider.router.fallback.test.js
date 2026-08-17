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

function diagnoseRequestPayload() {
  return {
    messages: [
      { role: 'system', content: 'You are the expert diagnostic logic unit of SKSK ProTech.' },
      {
        role: 'user',
        content: `DIAGNOSTIC_EVIDENCE_PACKET_V1:\n${JSON.stringify({
          stage: 'DIAGNOSE',
          dtcs: ['P0300', 'P0171']
        })}`
      }
    ],
    max_tokens: 2500,
    response_format: { type: 'json_object' }
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

test('direct Gemini and Groq fallback receive the same Diagnose semantic schema', async () => {
  await withProviderMocks(async () => {
    process.env.GROQ_API_KEY = 'test-only-key';

    const capturedPayloads = [];
    geminiProvider.isConfigured = () => true;
    geminiProvider.chat = async payload => {
      capturedPayloads.push(payload);
      return normalizedGeminiResponse(payload.fallbackReason || null);
    };

    aiClient.setProvider('gemini');
    await aiClient.aiChat(diagnoseRequestPayload());

    aiClient.setProvider('groq');
    groqProvider.chat = async () => {
      throw Object.assign(new Error('Rate limit reached'), {
        status: 429,
        code: 'rate_limit_exceeded'
      });
    };
    await aiClient.aiChat(diagnoseRequestPayload());

    assert.equal(capturedPayloads.length, 2);
    assert.deepEqual(capturedPayloads[0].response_format, capturedPayloads[1].response_format);
    assert.equal(capturedPayloads[0].fallbackReason, undefined);
    assert.equal(capturedPayloads[1].fallbackReason, 'RATE_LIMIT_EXCEEDED_429');

    const schema = capturedPayloads[0].response_format.json_schema.schema;
    for (const field of ['codeExplanations', 'repairSteps', 'proTips', 'estimatedRepairTime']) {
      assert.ok(schema.properties[field], `${field} must be present for both Gemini paths`);
    }
    assert.equal(Object.hasOwn(schema.properties, 'knownIssues'), false);
  });
});
