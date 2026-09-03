'use strict';

const DTC_SOURCES = Object.freeze({
  SCAN_TOOL: 'SCAN_TOOL',
  MANUAL_ENTRY: 'MANUAL_ENTRY',
  CUSTOMER_REPORTED: 'CUSTOMER_REPORTED',
  PLACEHOLDER: 'PLACEHOLDER',
  LEGACY_UNSPECIFIED: 'LEGACY_UNSPECIFIED'
});

const TRUST_POLICY = 'VERIFIED_SCAN_TOOL_ONLY';
const MAX_DTC_RECORDS = 20;

function clean(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeDtcCode(value) {
  const compact = clean(value, 32).toUpperCase().replace(/\s+/g, '');
  if (!/^[PBCU][0-9A-F]{4}$/.test(compact)) return '';
  return compact;
}

function normalizeSource(value, fallback = DTC_SOURCES.LEGACY_UNSPECIFIED) {
  const raw = clean(value, 40).toUpperCase().replace(/[\s-]+/g, '_');
  const aliases = {
    SCAN: DTC_SOURCES.SCAN_TOOL,
    SCANNER: DTC_SOURCES.SCAN_TOOL,
    SCAN_TOOL: DTC_SOURCES.SCAN_TOOL,
    OBD_SCANNER: DTC_SOURCES.SCAN_TOOL,
    OBD2_SCANNER: DTC_SOURCES.SCAN_TOOL,
    MANUAL: DTC_SOURCES.MANUAL_ENTRY,
    MANUAL_ENTRY: DTC_SOURCES.MANUAL_ENTRY,
    TYPED: DTC_SOURCES.MANUAL_ENTRY,
    CUSTOMER: DTC_SOURCES.CUSTOMER_REPORTED,
    CUSTOMER_REPORTED: DTC_SOURCES.CUSTOMER_REPORTED,
    REPORTED: DTC_SOURCES.CUSTOMER_REPORTED,
    PLACEHOLDER: DTC_SOURCES.PLACEHOLDER,
    TEST: DTC_SOURCES.PLACEHOLDER,
    TEST_DATA: DTC_SOURCES.PLACEHOLDER,
    DUMMY: DTC_SOURCES.PLACEHOLDER,
    LEGACY: DTC_SOURCES.LEGACY_UNSPECIFIED,
    LEGACY_UNSPECIFIED: DTC_SOURCES.LEGACY_UNSPECIFIED,
    UNKNOWN: DTC_SOURCES.LEGACY_UNSPECIFIED
  };
  return aliases[raw] || fallback;
}

function isTrustedDtcEvidence(record = {}) {
  return normalizeSource(record.source) === DTC_SOURCES.SCAN_TOOL
    && record.verified === true
    && !!normalizeDtcCode(record.code);
}

function normalizeRecord(value, fallbackSource = DTC_SOURCES.LEGACY_UNSPECIFIED) {
  if (typeof value === 'string' || typeof value === 'number') {
    const code = normalizeDtcCode(value);
    return code ? { code, source: fallbackSource, verified: false } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const code = normalizeDtcCode(value.code || value.dtc || value.value);
  if (!code) return null;
  const source = normalizeSource(value.source || value.provenance || value.origin, fallbackSource);
  const verified = source === DTC_SOURCES.SCAN_TOOL && value.verified === true;
  return { code, source, verified };
}

function recordTrustRank(record = {}) {
  if (isTrustedDtcEvidence(record)) return 100;
  switch (normalizeSource(record.source)) {
    case DTC_SOURCES.MANUAL_ENTRY: return 40;
    case DTC_SOURCES.CUSTOMER_REPORTED: return 30;
    case DTC_SOURCES.LEGACY_UNSPECIFIED: return 20;
    case DTC_SOURCES.PLACEHOLDER: return 10;
    default: return 0;
  }
}

function normalizeDtcEvidence(values = [], options = {}) {
  const fallbackSource = normalizeSource(options.fallbackSource, DTC_SOURCES.LEGACY_UNSPECIFIED);
  const raw = Array.isArray(values) ? values : [values];
  const byCode = new Map();

  for (const value of raw.slice(0, MAX_DTC_RECORDS * 2)) {
    const record = normalizeRecord(value, fallbackSource);
    if (!record) continue;
    const prior = byCode.get(record.code);
    if (!prior || recordTrustRank(record) > recordTrustRank(prior)) byCode.set(record.code, record);
  }

  return [...byCode.values()].slice(0, MAX_DTC_RECORDS);
}

function resolveRequestDtcEvidence(body = {}) {
  if (Array.isArray(body.dtcEvidence) && body.dtcEvidence.length) {
    return normalizeDtcEvidence(body.dtcEvidence, { fallbackSource: DTC_SOURCES.MANUAL_ENTRY });
  }

  const legacyCodes = Array.isArray(body.codes) && body.codes.length
    ? body.codes
    : (Array.isArray(body.obdCodes) ? body.obdCodes : []);

  // Legacy arrays never carry trustworthy provenance. Treat them as entered
  // context only so old clients cannot silently promote typed/dummy codes into
  // scan-tool evidence.
  return normalizeDtcEvidence(legacyCodes, { fallbackSource: DTC_SOURCES.LEGACY_UNSPECIFIED });
}

function trustedDtcCodes(records = []) {
  return normalizeDtcEvidence(records)
    .filter(isTrustedDtcEvidence)
    .map(record => record.code);
}

function summarizeDtcProvenance(records = []) {
  const normalized = normalizeDtcEvidence(records);
  const verified = normalized.filter(isTrustedDtcEvidence);
  const excluded = normalized.filter(record => !isTrustedDtcEvidence(record));
  const sourceCounts = normalized.reduce((counts, record) => {
    counts[record.source] = (counts[record.source] || 0) + 1;
    return counts;
  }, {});

  return {
    policy: TRUST_POLICY,
    verifiedCount: verified.length,
    excludedCount: excluded.length,
    sourceCounts
  };
}

function publicDtcEvidence(records = []) {
  return normalizeDtcEvidence(records).map(record => ({
    code: record.code,
    source: record.source,
    verified: isTrustedDtcEvidence(record)
  }));
}

module.exports = {
  DTC_SOURCES,
  TRUST_POLICY,
  MAX_DTC_RECORDS,
  normalizeDtcCode,
  normalizeSource,
  normalizeDtcEvidence,
  resolveRequestDtcEvidence,
  isTrustedDtcEvidence,
  trustedDtcCodes,
  summarizeDtcProvenance,
  publicDtcEvidence
};
