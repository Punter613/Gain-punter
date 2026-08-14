'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const groqClient = require('../src/services/groq');
const groqProvider = require('../src/services/ai/providers/groq');

test('Groq provider adapter delegates fallback ownership to providerRouter', async () => {
  const originalGroqChat = groqClient.groqChat;
  let capturedMessages;
  let capturedOptions;

  groqClient.groqChat = async (messages, options) => {
    capturedMessages = messages;
    capturedOptions = options;
    return {
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { total_tokens: 1 },
      _provider: 'groq'
    };
  };

  try {
    const messages = [{ role: 'user', content: 'diagnose this' }];
    const result = await groqProvider.chat({
      messages,
      model: 'openai/gpt-oss-120b',
      temperature: 0.15,
      max_tokens: 800,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' }
    });

    assert.equal(result._provider, 'groq');
    assert.deepEqual(capturedMessages, messages);
    assert.equal(capturedOptions.model, 'openai/gpt-oss-120b');
    assert.equal(capturedOptions.temperature, 0.15);
    assert.equal(capturedOptions.max_tokens, 800);
    assert.equal(capturedOptions.reasoning_effort, 'low');
    assert.deepEqual(capturedOptions.response_format, { type: 'json_object' });
    assert.equal(
      capturedOptions.disable_fallback,
      true,
      'providerRouter must own Groq→Gemini fallback for aiClient calls'
    );
  } finally {
    groqClient.groqChat = originalGroqChat;
  }
});
