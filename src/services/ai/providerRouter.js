const groq = require('./providers/groq');
const gemini = require('./providers/gemini');

const providers = {
  groq,
  gemini
};

let activeProvider = 'groq';

function getProvider() {
  const provider = providers[activeProvider];
  if (!provider) throw new Error("No active provider set: " + activeProvider);
  return provider;
}

function setProvider(name) {
  if (!providers[name]) throw new Error("Unknown provider: " + name);
  activeProvider = name;
}

function isRetryableProviderError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();

  if ([408, 409, 413, 429].includes(status) || status >= 500) return true;
  if (['rate_limit_exceeded', 'request_timeout', 'server_error'].includes(code)) return true;
  return /rate limit|too many requests|timeout|timed out|temporarily unavailable|overloaded|capacity/.test(message);
}

function fallbackReason(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || '').trim();
  if (code) return `${code}${status ? `_${status}` : ''}`.toUpperCase();
  if (status) return `HTTP_${status}`;
  return 'PROVIDER_RETRYABLE_ERROR';
}

function geminiFallbackPayload(payload, reason) {
  return {
    ...payload,
    model: payload.gemini_model || process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash',
    fallbackReason: reason
  };
}

async function routeProvider(payload) {
  const provider = getProvider();

  // providerRouter owns configuration-time fallback for the aiClient path.
  // Do this before entering the Groq adapter so a missing key does not rely on
  // legacy error-message matching to reach Gemini.
  if (activeProvider === 'groq' && !process.env.GROQ_API_KEY && gemini.isConfigured()) {
    const reason = 'GROQ_NOT_CONFIGURED';
    console.warn(`[AI Router] Groq unavailable (${reason}); falling back to Gemini.`);
    return gemini.chat(geminiFallbackPayload(payload, reason));
  }

  try {
    return await provider.chat(payload);
  } catch (error) {
    const canFallback = activeProvider === 'groq' && gemini.isConfigured() && isRetryableProviderError(error);
    if (!canFallback) throw error;

    const reason = fallbackReason(error);
    console.warn(`[AI Router] Groq unavailable (${reason}); falling back to Gemini.`);
    return gemini.chat(geminiFallbackPayload(payload, reason));
  }
}

module.exports = {
  routeProvider,
  setProvider,
  isRetryableProviderError,
  fallbackReason
};
