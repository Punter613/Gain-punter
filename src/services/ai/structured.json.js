'use strict';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function tryParseObject(text) {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}

function stripOuterFence(text) {
  const trimmed = String(text ?? '').trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function scanBalancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }

  return null;
}

function parseStructuredJsonObject(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const direct = tryParseObject(raw);
  if (direct) return direct;

  const unfenced = stripOuterFence(raw);
  if (unfenced !== raw) {
    const fenced = tryParseObject(unfenced);
    if (fenced) return fenced;
  }

  // Dirty-provider fallback: locate a balanced JSON object while respecting
  // quoted strings and escapes so braces inside notes do not alter depth.
  for (let start = 0; start < unfenced.length; start++) {
    if (unfenced[start] !== '{') continue;
    const candidate = scanBalancedObject(unfenced, start);
    if (!candidate) continue;
    const parsed = tryParseObject(candidate);
    if (parsed) return parsed;
  }

  return null;
}

module.exports = {
  parseStructuredJsonObject,
  stripOuterFence,
  scanBalancedObject
};
