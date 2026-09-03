'use strict';

const SOURCE_RESILIENCE_POLICY = 'NO_SINGLE_EXTERNAL_SOURCE_REQUIRED';

const SOURCE_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
  SKIPPED: 'SKIPPED'
});

const SOURCE_CLASS = Object.freeze({
  OFFICIAL_STORED: 'OFFICIAL_STORED',
  OFFICIAL_PUBLIC_API: 'OFFICIAL_PUBLIC_API',
  OPTIONAL_EXTERNAL_REFERENCE: 'OPTIONAL_EXTERNAL_REFERENCE',
  INTERNAL_TRUSTED: 'INTERNAL_TRUSTED'
});

const SOURCE_DEFINITIONS = Object.freeze({
  NHTSA_BULK: Object.freeze({ sourceClass: SOURCE_CLASS.OFFICIAL_STORED, required: false, durable: true }),
  NHTSA_ODI: Object.freeze({ sourceClass: SOURCE_CLASS.OFFICIAL_PUBLIC_API, required: false, durable: true }),
  LEMON_MANUALS: Object.freeze({ sourceClass: SOURCE_CLASS.OPTIONAL_EXTERNAL_REFERENCE, required: false, durable: false }),
  LEMON_TSB_CORPUS: Object.freeze({ sourceClass: SOURCE_CLASS.OPTIONAL_EXTERNAL_REFERENCE, required: false, durable: false }),
  CONFIRMED_REPAIRS: Object.freeze({ sourceClass: SOURCE_CLASS.INTERNAL_TRUSTED, required: false, durable: true })
});

function clean(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function booleanEnv(name, fallback = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return !/^(?:0|false|off|no|disabled)$/i.test(String(raw).trim());
}

function isOptionalExternalSourceEnabled(source) {
  if (source === 'LEMON_MANUALS' || source === 'LEMON_TSB_CORPUS') {
    return booleanEnv('LEMON_EVIDENCE_ENABLED', true);
  }
  return true;
}

function sourceDefinition(source) {
  return SOURCE_DEFINITIONS[source] || { sourceClass: 'OTHER', required: false, durable: false };
}

function sourceHealthEntry(source, status, details = {}) {
  const definition = sourceDefinition(source);
  return {
    source,
    status: SOURCE_STATUS[status] || status || SOURCE_STATUS.UNAVAILABLE,
    sourceClass: definition.sourceClass,
    required: definition.required === true,
    durable: definition.durable === true,
    evidenceCount: Math.max(0, Number(details.evidenceCount || 0)),
    fromCache: details.fromCache === true,
    reason: clean(details.reason || '') || undefined
  };
}

function summarizeSourceHealth(entries = []) {
  const normalized = (Array.isArray(entries) ? entries : Object.values(entries || {})).filter(Boolean);
  const unavailable = normalized.filter(entry => entry.status === SOURCE_STATUS.UNAVAILABLE);
  const degraded = normalized.filter(entry => entry.status === SOURCE_STATUS.DEGRADED);
  const optionalUnavailable = unavailable.filter(entry => entry.required !== true);
  const durableAvailable = normalized.some(entry => entry.durable === true && entry.status === SOURCE_STATUS.AVAILABLE);
  const anyAvailable = normalized.some(entry => entry.status === SOURCE_STATUS.AVAILABLE);
  const mode = unavailable.length || degraded.length ? 'DEGRADED' : 'NORMAL';

  return {
    policy: SOURCE_RESILIENCE_POLICY,
    diagnosticOperation: 'CONTINUE',
    mode,
    anyAvailable,
    durableAvailable,
    unavailableCount: unavailable.length,
    optionalUnavailableCount: optionalUnavailable.length,
    entries: normalized
  };
}

function sourceStatusMessage(summary = {}) {
  const entries = Array.isArray(summary.entries) ? summary.entries : [];
  const unavailableOptional = entries
    .filter(entry => entry.required !== true && entry.status === SOURCE_STATUS.UNAVAILABLE)
    .map(entry => entry.source);
  const skippedOptional = entries
    .filter(entry => entry.required !== true && entry.status === SOURCE_STATUS.SKIPPED)
    .map(entry => entry.source);

  if (!unavailableOptional.length && !skippedOptional.length) {
    return 'Evidence sources operating normally; no single external provider is required for diagnosis.';
  }

  const affected = [...new Set([...unavailableOptional, ...skippedOptional])].join(', ');
  return `Optional evidence source unavailable or disabled: ${affected}. Continuing with other available evidence sources; diagnosis does not depend on any single external manual provider.`;
}

function publicSourceHealth(summary = {}) {
  return {
    policy: summary.policy || SOURCE_RESILIENCE_POLICY,
    diagnosticOperation: summary.diagnosticOperation || 'CONTINUE',
    mode: summary.mode || 'NORMAL',
    durableAvailable: summary.durableAvailable === true,
    optionalUnavailableCount: Number(summary.optionalUnavailableCount || 0),
    entries: (summary.entries || []).map(entry => ({
      source: clean(entry.source, 80),
      status: clean(entry.status, 30),
      sourceClass: clean(entry.sourceClass, 80),
      required: entry.required === true,
      durable: entry.durable === true,
      evidenceCount: Math.max(0, Number(entry.evidenceCount || 0)),
      fromCache: entry.fromCache === true
    }))
  };
}

module.exports = {
  SOURCE_RESILIENCE_POLICY,
  SOURCE_STATUS,
  SOURCE_CLASS,
  SOURCE_DEFINITIONS,
  isOptionalExternalSourceEnabled,
  sourceDefinition,
  sourceHealthEntry,
  summarizeSourceHealth,
  sourceStatusMessage,
  publicSourceHealth
};
