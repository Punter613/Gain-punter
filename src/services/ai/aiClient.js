const { routeProvider, setProvider } = require('./providerRouter');

/**
 * The single entry point for all AI calls in this app.
 *
 * Contract (must match providers/*.js exactly):
 *   aiChat({
 *     messages: [{ role, content }, ...],   // required
 *     model: string,                        // optional, provider default if omitted
 *     temperature: number,                  // optional
 *     max_tokens: number,                   // optional
 *     response_format: { type: 'json_object' } | undefined
 *   })
 *
 * Returns whatever the underlying provider SDK returns (currently the
 * Groq SDK's ChatCompletion shape: response.choices[0].message.content).
 */
async function aiChat(payload = {}) {
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new Error(
      '[aiClient.aiChat] payload.messages must be a non-empty array of {role, content}.'
    );
  }
  return routeProvider(payload);
}

module.exports = {
  aiChat,
  setProvider
};
