const DEFAULT_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_JSON_MIME_TYPE = 'APPLICATION_JSON';
const ESTIMATE_SCHEMA_NAME = 'sksk_estimate_reasoning';
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

function apiKey() {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
}

function requestTimeoutMs() {
  const configured = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REQUEST_TIMEOUT_MS;
}

function resolveModel(requestedModel) {
  const requested = String(requestedModel || '').trim();
  if (!requested || !/^gemini-/i.test(requested)) return DEFAULT_MODEL;
  return requested;
}

function pickProperties(source = {}, names = []) {
  const out = {};
  for (const name of names) {
    if (source[name]) out[name] = source[name];
  }
  return out;
}

// Gemini documents that very large/deep schemas may be rejected. SKSK's full
// Estimate contract contains several nested presentation-only branches that the
// deterministic formatter does not need from the model. For Gemini only, keep
// the reasoning/evidence/authorization core under schema enforcement and let
// SKSK deterministically rebuild the final shop-facing response.
function compactEstimateSchema(schema) {
  const top = schema?.properties || {};
  const candidateSource = top.candidates?.items?.properties || {};
  const actionSource = top.repairActions?.items?.properties || {};

  const candidateProperties = pickProperties(candidateSource, [
    'cause',
    'component',
    'modelConfidence',
    'evidenceRefs',
    'contradictions',
    'confirmationTests',
    'confirmed',
    'repairAuthorized'
  ]);

  const actionProperties = pickProperties(actionSource, [
    'action',
    'component',
    'evidenceRefs',
    'repairAuthorized'
  ]);

  return {
    type: 'object',
    additionalProperties: false,
    required: ['priority', 'diagnosis', 'estimatedHours', 'candidates', 'repairActions', 'additionalChecks', 'notes'],
    properties: {
      priority: top.priority || { type: 'string', enum: ['high', 'medium', 'low'] },
      diagnosis: top.diagnosis || { type: 'string' },
      estimatedHours: top.estimatedHours || { type: 'number' },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'cause',
            'component',
            'modelConfidence',
            'evidenceRefs',
            'contradictions',
            'confirmationTests',
            'confirmed',
            'repairAuthorized'
          ],
          properties: candidateProperties
        }
      },
      repairActions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'component', 'evidenceRefs', 'repairAuthorized'],
          properties: actionProperties
        }
      },
      additionalChecks: top.additionalChecks || { type: 'array', items: { type: 'string' } },
      notes: top.notes || { type: 'string' }
    }
  };
}

function schemaForGemini(responseFormat) {
  if (!responseFormat || responseFormat.type !== 'json_schema') {
    return { schema: null, variant: 'none' };
  }

  const schemaConfig = responseFormat.json_schema || responseFormat;
  const original = schemaConfig.schema || null;
  if (!original) return { schema: null, variant: 'none' };

  if (schemaConfig.name === ESTIMATE_SCHEMA_NAME) {
    return { schema: compactEstimateSchema(original), variant: 'estimate-compact-v1' };
  }

  return { schema: original, variant: 'provider-shared' };
}

// Gemini 3.6 Flash uses generationConfig.responseFormat.text.{mimeType,schema}.
// The raw v1beta REST endpoint defines mimeType as an enum. Live API traces show
// this endpoint rejects the SDK-friendly literal "application/json" and expects
// APPLICATION_JSON. Keep provider-specific wire handling isolated here.
function jsonGenerationConfig(responseFormat) {
  if (!responseFormat) return {};

  if (responseFormat.type === 'json_object') {
    return {
      responseFormat: {
        text: {
          mimeType: GEMINI_JSON_MIME_TYPE
        }
      }
    };
  }

  if (responseFormat.type === 'json_schema') {
    const prepared = schemaForGemini(responseFormat);
    return {
      responseFormat: {
        text: {
          mimeType: GEMINI_JSON_MIME_TYPE,
          ...(prepared.schema ? { schema: prepared.schema } : {})
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

  const schemaVariant = schemaForGemini(options.response_format).variant;

  return {
    model: resolveModel(options.model),
    schemaVariant,
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

function normalizeResponse(response, model, latencyMs, fallbackReason = null, schemaVariant = 'none') {
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
    _schemaVariant: schemaVariant,
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
  const schemaBytes = textFormat?.schema ? Buffer.byteLength(JSON.stringify(textFormat.schema), 'utf8') : 0;
  const timeoutMs = requestTimeoutMs();

  console.log('[geminiChat] request:', {
    model: request.model,
    temperature: request.body.generationConfig?.temperature ?? null,
    maxOutputTokens: request.body.generationConfig?.maxOutputTokens ?? null,
    responseFormat: textFormat
      ? {
          mimeType: textFormat.mimeType || null,
          hasSchema: Boolean(textFormat.schema),
          schemaVariant: request.schemaVariant,
          schemaBytes
        }
      : null,
    messageCount: messages.length,
    fallbackReason,
    timeoutMs
  });

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    const httpResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey(),
        'x-goog-api-client': 'sksk-protech/1.0.0'
      },
      body: JSON.stringify(request.body),
      signal: controller.signal
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
      error.schemaVariant = request.schemaVariant;
      throw error;
    }
  } catch (error) {
    let failure = error;
    if (error?.name === 'AbortError') {
      failure = new Error(`Gemini request timed out after ${timeoutMs}ms`);
      failure.status = 408;
      failure.code = 'request_timeout';
      failure.provider = 'gemini';
      failure.schemaVariant = request.schemaVariant;
    }
    console.error('[geminiChat] request FAILED after', Date.now() - startedAt, 'ms:', {
      message: failure.message,
      status: failure.status || null,
      code: failure.code || null,
      details: compactErrorDetails(failure.details),
      schemaVariant: failure.schemaVariant || request.schemaVariant,
      schemaBytes
    });
    throw failure;
  } finally {
    clearTimeout(timeout);
  }

  const latencyMs = Date.now() - startedAt;
  const normalized = normalizeResponse(response, request.model, latencyMs, fallbackReason, request.schemaVariant);
  console.log('[geminiChat] response:', {
    latencyMs,
    model: normalized.model,
    contentLength: normalized.choices[0].message.content.length,
    contentIsEmpty: !normalized.choices[0].message.content.trim(),
    usage: normalized.usage,
    fallbackReason,
    schemaVariant: request.schemaVariant
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
  requestTimeoutMs,
  resolveModel,
  compactEstimateSchema,
  schemaForGemini,
  jsonGenerationConfig,
  buildRequest,
  extractOutputText,
  normalizeResponse
};
