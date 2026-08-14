const groqClient = require('../../groq');

/**
 * Provider contract: chat() takes ONE object.
 *   { messages, model, temperature, max_tokens, response_format }
 * This must match exactly what providerRouter.routeProvider() forwards,
 * and what aiClient.aiChat() accepts from callers.
 *
 * Fallback ownership belongs to providerRouter for calls entering through
 * aiClient. The legacy groqChat helper still supports direct-call fallback for
 * older routes, but this adapter disables that inner fallback so a retryable
 * Groq failure cannot trigger Gemini once inside groqChat and then a second
 * time when providerRouter catches the propagated error.
 */
async function chat(payload = {}) {
  const { messages, model, temperature, max_tokens, response_format, reasoning_effort } = payload;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error(
      '[providers/groq.chat] payload.messages must be a non-empty array. ' +
      'Received: ' + JSON.stringify(payload).slice(0, 200)
    );
  }

  return groqClient.groqChat(messages, {
    model,
    temperature,
    max_tokens,
    response_format,
    reasoning_effort,
    disable_fallback: true
  });
}

module.exports = { chat };
