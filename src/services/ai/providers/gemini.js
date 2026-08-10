const DEFAULT_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

function apiKey() {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
}

function resolveModel(requestedModel) {
  const requested = String(requestedModel || '').trim();
  if (!requested || !/^gemini-/i.test(requested)) return DEFAULT_MODEL;
  return requested;
}

// Gemini 3.6 Flash uses the current GenerateContent structured-output shape:
// generationConfig.responseFormat.text.{mimeType,schema}.
// Keep SKSK's provider-neutral response_format contract at the router boundary and
// translate it here instead of leaking Gemini-specific wire fields into callers.
function jsonGenerationConfig(responseFormat) {
  if (!responseFormat) return {};

  if (responseFormat.type === 'json_object') {
    return {
      responseFormat: {
        text: {
          mimeType: 'application/json'
        }
      }
    };
  }

  if (responseFormat.type === 'json_schema') {
    const schemaConfig = responseFormat.json_schema || responseFormat;
    return {
      responseFormat: {
        text: {
          mimeType: 'application/json',
          ...(schemaConfig.schema ? { schema: schemaConfig.schema } : {})
        }
      }
    };
  }

  return {};
}

function buildRequest(messages, options = {}) {
  const systemText = messages
    .filter(message => message?.role === 'system')
    .map(message => String(message?.content || ''))
    .filter(Boolean)
    .join('\n\n');

  const contents = messages
    .filter(message => message?.role !== 'system')
    .map(message => ({
      role: message?.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(message?.content || '') }]
    }));

  const generationConfig = {
    ...(options.temperature !== undefined ? { temperature: Number(options.temperature) } : {}),
    ...(options.max_tokens ? { maxOutputTokens: Number(options.max_tokens) } : {}),
    ...jsonGenerationConfig(options.response_format)
  };

  return {
    model: resolveModel(options.model),
    body: {
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      contents,
      ...(Object.keys(generationConfig).length ? { generationConfig } : {})
    }
  };
}

function extractOutputText(response) {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(part => typeof part?.text === 'string')
    .map(part => part.text)
    .join('');
}

function normalizeResponse(response, model, latencyMs, fallbackReason = null) {
  const content = extractOutputText(response);
  const usage = response?.usageMetadata || {};
  const finishReason = response?.candidates?.[0]?.finishReason || 'STOP';

  return {
    id: response?.responseId || null,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: String(finishReason).toLowerCase() === 'stop' ? 'stop' : String(finishReason).toLowerCase()
    }],
    usage: {
      prompt_tokens: usage.promptTokenCount ?? null,
      completion_tokens: usage.candidatesTokenCount ?? null,
      total_tokens: usage.totalTokenCount ?? null,
      completion_tokens_details: usage.thoughtsTokenCount !== undefined
        ? { reasoning_tokens: usage.thoughtsTokenCount }
        : null
    },
    _provider: 'gemini',
    _fallbackReason: fallbackReason,
    _latency: latencyMs
  };
}

function compactErrorDetails(details) {
  if (!details) return null;
  try {
    const text = JSON.stringify(details);
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  } catch (_) {
    return String(details).slice(0, 4000);
  }
}

async function chat(payload = {}) {
  const { messages, fallbackReason = null } = payload;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('[providers/gemini.chat] payload.messages must be a non-empty array.');
  }
  if (!isConfigured()) {
    throw new Error('GEMINI_API_KEY is not configured. Cannot reach Gemini.');
  }

  const request = buildRequest(messages, payload);
  const url = `${API_BASE}/${encodeURIComponent(request.model)}:generateContent`;
  const textFormat = request.body.generationConfig?.responseFormat?.text || null;

  console.log('[geminiChat] request:', {
    model: request.model,
    temperature: request.body.generationConfig?.temperature ?? null,
    maxOutputTokens: request.body.generationConfig?.maxOutputTokens ?? null,
    responseFormat: textFormat
      ? {
          mimeType: textFormat.mimeType || null,
          hasSchema: Boolean(textFormat.schema)
        }
      : null,
    messageCount: messages.length,
    fallbackReason
  });

  const startedAt = Date.now();
  let response;
  try {
    const httpResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey(),
        'x-goog-api-client': 'sksk-protech/1.0.0'
      },
      body: JSON.stringify(request.body)
    });

    response = await httpResponse.json().catch(() => ({}));
    if (!httpResponse.ok) {
      const error = new Error(
        response?.error?.message ||
        response?.message ||
        `Gemini request failed (${httpResponse.status})`
      );
      error.status = httpResponse.status;
      error.code = response?.error?.status || response?.error?.code || null;
      error.provider = 'gemini';
      error.details = response?.error?.details || null;
      throw error;
    }
  } catch (error) {
    console.error('[geminiChat] request FAILED after', Date.now() - startedAt, 'ms:', {
      message: error.message,
      status: error.status || null,
      code: error.code || null,
      details: compactErrorDetails(error.details)
    });
    throw error;
  }

  const latencyMs = Date.now() - startedAt;
  const normalized = normalizeResponse(response, request.model, latencyMs, fallbackReason);
  console.log('[geminiChat] response:', {
    latencyMs,
    model: normalized.model,
    contentLength: normalized.choices[0].message.content.length,
    contentIsEmpty: !normalized.choices[0].message.content.trim(),
    usage: normalized.usage,
    fallbackReason
  });

  if (!normalized.choices[0].message.content.trim()) {
    const blockReason = response?.promptFeedback?.blockReason;
    throw new Error(`Gemini returned no text${blockReason ? ` (blockReason=${blockReason})` : ''}.`);
  }

  return normalized;
}

module.exports = {
  chat,
  isConfigured,
  apiKey,
  resolveModel,
  jsonGenerationConfig,
  buildRequest,
  extractOutputText,
  normalizeResponse
};
