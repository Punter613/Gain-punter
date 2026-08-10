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

async function routeProvider(payload) {
  const provider = getProvider();
  try {
    return await provider.chat(payload);
  } catch (error) {
    const canFallback = activeProvider === 'groq' && gemini.isConfigured() && isRetryableProviderError(error);
    if (!canFallback) throw error;

    const reason = fallbackReason(error);
    console.warn(`[AI Router] Groq unavailable (${reason}); falling back to Gemini.`);
    return gemini.chat({
      ...payload,
      model: payload.gemini_model || process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash',
      fallbackReason: reason
    });
  }
}

module.exports = {
  routeProvider,
  setProvider,
  isRetryableProviderError,
  fallbackReason
};
