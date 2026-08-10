const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = process.env.OPENAI_FALLBACK_MODEL || 'gpt-5-mini';

function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function resolveModel(requestedModel) {
  const requested = String(requestedModel || '').trim();
  // Groq-hosted model ids such as "openai/gpt-oss-120b" are not valid
  // OpenAI API model ids. When the router hands us one, use the configured
  // OpenAI fallback model instead.
  if (!requested || requested.includes('/')) return DEFAULT_MODEL;
  return requested;
}

function toTextFormat(responseFormat) {
  if (!responseFormat) return undefined;
  if (responseFormat.type === 'json_object') {
    return { format: { type: 'json_object' } };
  }
  if (responseFormat.type === 'json_schema') {
    const schemaConfig = responseFormat.json_schema || responseFormat;
    return {
      format: {
        type: 'json_schema',
        name: schemaConfig.name || 'sksk_response',
        schema: schemaConfig.schema || {},
        strict: schemaConfig.strict !== false,
        ...(schemaConfig.description ? { description: schemaConfig.description } : {})
      }
    };
  }
  return undefined;
}

function buildRequest(messages, options = {}) {
  const systemText = messages
    .filter(message => message?.role === 'system')
    .map(message => String(message?.content || ''))
    .filter(Boolean)
    .join('\n\n');

  const input = messages
    .filter(message => message?.role !== 'system')
    .map(message => ({
      role: message?.role === 'assistant' ? 'assistant' : 'user',
      content: String(message?.content || '')
    }));

  const request = {
    model: resolveModel(options.model),
    input,
    store: false,
    ...(systemText ? { instructions: systemText } : {}),
    ...(options.max_tokens ? { max_output_tokens: options.max_tokens } : {}),
    ...(options.reasoning_effort ? { reasoning: { effort: options.reasoning_effort } } : {}),
    ...(toTextFormat(options.response_format) ? { text: toTextFormat(options.response_format) } : {})
  };

  return request;
}

function extractOutputText(response) {
  return (response?.output || [])
    .filter(item => item?.type === 'message')
    .flatMap(item => Array.isArray(item.content) ? item.content : [])
    .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

function normalizeResponse(response, latencyMs, fallbackReason = null) {
  const content = extractOutputText(response);
  const usage = response?.usage || {};
  return {
    id: response?.id || null,
    model: response?.model || DEFAULT_MODEL,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: response?.status === 'completed' ? 'stop' : (response?.status || 'unknown')
    }],
    usage: {
      prompt_tokens: usage.input_tokens ?? null,
      completion_tokens: usage.output_tokens ?? null,
      total_tokens: usage.total_tokens ?? null,
      completion_tokens_details: usage.output_tokens_details || null
    },
    _provider: 'openai',
    _fallbackReason: fallbackReason,
    _latency: latencyMs
  };
}

async function chat(payload = {}) {
  const { messages, fallbackReason = null } = payload;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('[providers/openai.chat] payload.messages must be a non-empty array.');
  }
  if (!isConfigured()) {
    throw new Error('OPENAI_API_KEY is not configured. Cannot reach OpenAI.');
  }

  const requestBody = buildRequest(messages, payload);
  console.log('[openaiChat] request:', {
    model: requestBody.model,
    max_output_tokens: requestBody.max_output_tokens || null,
    reasoning_effort: requestBody.reasoning?.effort || null,
    response_format: requestBody.text?.format?.type || null,
    messageCount: messages.length,
    fallbackReason
  });

  const startedAt = Date.now();
  let response;
  try {
    const httpResponse = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    response = await httpResponse.json().catch(() => ({}));
    if (!httpResponse.ok) {
      const error = new Error(response?.error?.message || `OpenAI request failed (${httpResponse.status})`);
      error.status = httpResponse.status;
      error.code = response?.error?.code || null;
      error.provider = 'openai';
      throw error;
    }
  } catch (error) {
    console.error('[openaiChat] request FAILED after', Date.now() - startedAt, 'ms:', error.message);
    throw error;
  }

  const latencyMs = Date.now() - startedAt;
  const normalized = normalizeResponse(response, latencyMs, fallbackReason);
  console.log('[openaiChat] response:', {
    latencyMs,
    model: normalized.model,
    contentLength: normalized.choices[0].message.content.length,
    contentIsEmpty: !normalized.choices[0].message.content.trim(),
    usage: normalized.usage,
    fallbackReason
  });

  return normalized;
}

module.exports = {
  chat,
  isConfigured,
  resolveModel,
  buildRequest,
  extractOutputText,
  normalizeResponse
};
