'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const gemini = require('../src/services/ai/providers/gemini');

test('Gemini request timeout defaults to 30 seconds and accepts a positive override', () => {
  const originalTimeout = process.env.GEMINI_REQUEST_TIMEOUT_MS;
  try {
    delete process.env.GEMINI_REQUEST_TIMEOUT_MS;
    assert.equal(gemini.requestTimeoutMs(), 30000);

    process.env.GEMINI_REQUEST_TIMEOUT_MS = '1234';
    assert.equal(gemini.requestTimeoutMs(), 1234);

    process.env.GEMINI_REQUEST_TIMEOUT_MS = '0';
    assert.equal(gemini.requestTimeoutMs(), 30000);
  } finally {
    if (originalTimeout === undefined) delete process.env.GEMINI_REQUEST_TIMEOUT_MS;
    else process.env.GEMINI_REQUEST_TIMEOUT_MS = originalTimeout;
  }
});

test('Gemini adapter aborts a hung request at the configured ceiling', async () => {
  const originalFetch = global.fetch;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalGoogleKey = process.env.GOOGLE_API_KEY;
  const originalTimeout = process.env.GEMINI_REQUEST_TIMEOUT_MS;

  process.env.GEMINI_API_KEY = 'test-only-key';
  delete process.env.GOOGLE_API_KEY;
  process.env.GEMINI_REQUEST_TIMEOUT_MS = '15';

  global.fetch = async (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  try {
    await assert.rejects(
      gemini.chat({ messages: [{ role: 'user', content: 'diagnose this' }] }),
      error => {
        assert.equal(error.status, 408);
        assert.equal(error.code, 'request_timeout');
        assert.equal(error.provider, 'gemini');
        assert.match(error.message, /timed out after 15ms/i);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    if (originalGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogleKey;
    if (originalTimeout === undefined) delete process.env.GEMINI_REQUEST_TIMEOUT_MS;
    else process.env.GEMINI_REQUEST_TIMEOUT_MS = originalTimeout;
  }
});
