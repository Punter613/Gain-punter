const groq = require('./providers/groq');
const gemini = require('./providers/gemini');
const { prepareGeminiDiagnosePayload } = require('./diagnose.schema');

const providers = { groq, gemini };

function configuredProvider() {
  const requested = String(process.env.AI_PRIMARY_PROVIDER || 'groq').trim().toLowerCase();
  return providers[requested] ? requested : 'groq';
}

let activeProvider = configuredProvider();

function getProvider() {
  const provider = providers[activeProvider];
  if (!provider) throw new Error('No active provider set: ' + activeProvider);
  return provider;
}

function setProvider(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!providers[normalized]) throw new Error('Unknown provider: ' + name);
  activeProvider = normalized;
}

function isRetryableProviderError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  if ([408, 409, 413, 429].includes(status) || status >= 500) return true;
  if (['rate_limit_exceeded', 'request_timeout', 'server_error', 'unavailable'].includes(code)) return true;
  return /rate limit|too many requests|timeout|timed out|temporarily unavailable|unavailable|overloaded|capacity|high demand/.test(message);
}

function fallbackReason(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || '').trim();
  if (code) return `${code}${status ? `_${status}` : ''}`.toUpperCase();
  if (status) return `HTTP_${status}`;
  return 'PROVIDER_RETRYABLE_ERROR';
}

function geminiPayload(payload, extra = {}) {
  return prepareGeminiDiagnosePayload({
    ...payload,
    ...extra,
    model: payload.gemini_model || process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash'
  });
}

function geminiFallbackPayload(payload, reason) {
  return geminiPayload(payload, { fallbackReason: reason });
}

async function groqFallback(payload, reason) {
  const response = await groq.chat(payload);
  if (response && typeof response === 'object') {
    response._fallbackReason = reason;
  }
  return response;
}

async function routeProvider(payload) {
  const provider = getProvider();

  if (activeProvider === 'groq' && !process.env.GROQ_API_KEY && gemini.isConfigured()) {
    const reason = 'GROQ_NOT_CONFIGURED';
    console.warn(`[AI Router] Groq unavailable (${reason}); falling back to Gemini.`);
    return gemini.chat(geminiFallbackPayload(payload, reason));
  }

  try {
    if (activeProvider === 'gemini') {
      return await gemini.chat(geminiPayload(payload));
    }
    return await provider.chat(payload);
  } catch (error) {
    if (!isRetryableProviderError(error)) throw error;

    const reason = fallbackReason(error);
    if (activeProvider === 'groq' && gemini.isConfigured()) {
      console.warn(`[AI Router] Groq unavailable (${reason}); falling back to Gemini.`);
      return gemini.chat(geminiFallbackPayload(payload, reason));
    }
    if (activeProvider === 'gemini' && process.env.GROQ_API_KEY) {
      console.warn(`[AI Router] Gemini unavailable (${reason}); falling back to Groq.`);
      return groqFallback(payload, reason);
    }
    throw error;
  }
}

module.exports = {
  routeProvider,
  setProvider,
  isRetryableProviderError,
  fallbackReason
};
