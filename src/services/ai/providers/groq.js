const { groqChat } = require('../../groq');

/**
 * Provider contract: chat() takes ONE object.
 *   { messages, model, temperature, max_tokens, response_format }
 * This must match exactly what providerRouter.routeProvider() forwards,
 * and what aiClient.aiChat() accepts from callers.
 *
 * Previously this took (messages, options) as two separate arguments,
 * but providerRouter called chat(payload) with a single object — so the
 * whole payload landed in `messages` and `options` silently defaulted to
 * {}, dropping model/temperature/max_tokens/response_format on every
 * call through aiClient -> providerRouter -> groq.
 */
async function chat(payload = {}) {
  const { messages, model, temperature, max_tokens, response_format } = payload;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error(
      '[providers/groq.chat] payload.messages must be a non-empty array. ' +
      'Received: ' + JSON.stringify(payload).slice(0, 200)
    );
  }

  return groqChat(messages, { model, temperature, max_tokens, response_format });
}

module.exports = { chat };
