'use strict';

const { buildCanonicalSearchTerms } = require('../core/automotive.normalization');
const { scorePage: scoreTargetedPage } = require('../../scripts/scrape-lemon-targeted-evidence');

const CURRENT_MANUAL_SCHEMA = 5;

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalized(value) {
  return clean(value).toLowerCase();
}

function normalizeDrive(value) {
  const raw = normalized(value);
  if (/\b4wd\b|\b4x4\b|four[ -]?wheel drive/.test(raw)) return '4wd';
  if (/\bawd\b|all[ -]?wheel drive/.test(raw)) return 'awd';
  if (/\bfwd\b|front[ -]?wheel drive/.test(raw)) return 'fwd';
  if (/\brwd\b|rear[ -]?wheel drive/.test(raw)) return 'rwd';
  if (/\b2wd\b|two[ -]?wheel drive/.test(raw)) return '2wd';
  return 'drive-unknown';
}

function vehicleIdentity(vehicle = {}) {
  return [
    clean(vehicle.year),
    normalized(vehicle.make),
    normalized(vehicle.model),
    normalized(vehicle.engine || 'base'),
    normalizeDrive(vehicle.drivetrain || vehicle.driveType || vehicle.drive)
  ].join('|');
}

function sameVehicleIdentity(a = {}, b = {}) {
  return vehicleIdentity(a) === vehicleIdentity(b);
}

function parseHeadings(meta = {}) {
  return String(meta.headings || '')
    .split('|')
    .map(clean)
    .filter(Boolean)
    .slice(0, 20);
}

function manualItemToPage(item = {}) {
  return {
    title: clean(item.title || 'Repair & Diagnosis reference'),
    headings: parseHeadings(item.meta || {}),
    url: clean(item.url),
    bodyText: clean(item.meta?.snippet || '')
  };
}

function findMatchedTerm(relevance = {}, term = '') {
  const needle = normalized(term);
  return (relevance.matchedTerms || []).find(value => normalized(value) === needle) || '';
}

function hasStrongLocation(relevance = {}, term = '') {
  const matched = findMatchedTerm(relevance, term);
  if (!matched) return false;
  const locations = relevance.matchLocations?.[matched] || [];
  return locations.some(location => ['title', 'heading', 'path'].includes(location));
}

function hasStrongStoredMatch(relevance = {}, queryProfile = {}) {
  const dtcs = Array.isArray(queryProfile.dtcs) ? queryProfile.dtcs : [];
  if (dtcs.length) {
    return dtcs.some(code => Boolean(findMatchedTerm(relevance, code)));
  }

  const components = Array.isArray(queryProfile.components) ? queryProfile.components : [];
  if (components.some(component => hasStrongLocation(relevance, component))) return true;

  const discriminators = [
    ...(queryProfile.sounds || []),
    ...(queryProfile.triggers || []),
    ...(queryProfile.conditions || [])
  ];
  const matchedDiscriminators = [...new Set(discriminators.filter(term => findMatchedTerm(relevance, term)))];
  if (matchedDiscriminators.length >= 2) return true;

  const matchedSystem = (queryProfile.systems || []).some(system => findMatchedTerm(relevance, system));
  if (matchedDiscriminators.length >= 1 && matchedSystem) return true;

  return false;
}

function parseFacts(value) {
  if (!value) return {};
  try { return JSON.parse(value); }
  catch (_) { return {}; }
}

function applyCurrentRelevance(item = {}, relevance = {}) {
  const previousFacts = parseFacts(item.meta?.facts);
  return {
    ...item,
    meta: {
      ...(item.meta || {}),
      relevanceScore: String(Number(relevance.score || 0)),
      semanticScore: String(Number(relevance.semanticScore || 0)),
      scopeScore: String(Number(relevance.scopeScore || 0)),
      sectionType: relevance.sectionType || item.meta?.sectionType || 'OTHER',
      matchedKeywords: (relevance.matchedTerms || []).join(', '),
      facts: JSON.stringify({
        ...previousFacts,
        dtcs: relevance.profile?.dtcs || previousFacts.dtcs || [],
        sounds: relevance.profile?.sounds || previousFacts.sounds || [],
        conditions: relevance.profile?.conditions || previousFacts.conditions || [],
        systems: relevance.profile?.systems || previousFacts.systems || [],
        canonicalTerms: relevance.profile?.canonicalTerms || previousFacts.canonicalTerms || []
      })
    }
  };
}

function candidateKey(item = {}) {
  const hash = clean(item.meta?.contentHash);
  if (hash) return `hash:${hash}`;
  return `url:${normalized(item.url)}|${normalized(item.title)}`;
}

function rerankStoredManualEvidence(rows = [], vehicle = {}, context = {}, scope = 'diagnosis', options = {}) {
  const compatibleRows = (Array.isArray(rows) ? rows : [])
    .filter(row => row?.data?.schemaVersion === CURRENT_MANUAL_SCHEMA)
    .filter(row => sameVehicleIdentity(row.data?.vehicle || {}, vehicle));

  if (!compatibleRows.length) return null;

  const { profile: queryProfile, terms } = buildCanonicalSearchTerms(vehicle, context);
  if (!terms.length) return null;

  const candidates = new Map();
  for (const row of compatibleRows) {
    for (const item of row.data?.items || []) {
      const page = manualItemToPage(item);
      const relevance = scoreTargetedPage(page, terms, scope, queryProfile);
      if (!(relevance.matchedTerms || []).length) continue;
      if (!hasStrongStoredMatch(relevance, queryProfile)) continue;

      const enriched = applyCurrentRelevance(item, relevance);
      const key = candidateKey(enriched);
      const current = candidates.get(key);
      if (!current || Number(relevance.score || 0) > Number(current.relevance.score || 0)) {
        candidates.set(key, { item: enriched, relevance, row });
      }
    }
  }

  const maxItems = Math.max(1, Math.min(30, Number(options.maxItems || 12)));
  const selectedCandidates = [...candidates.values()]
    .sort((a, b) => Number(b.relevance.score || 0) - Number(a.relevance.score || 0))
    .slice(0, maxItems);

  if (!selectedCandidates.length) return null;

  const sourceRows = [...new Set(selectedCandidates.map(candidate => candidate.row.vehicle_key).filter(Boolean))];
  const firstData = selectedCandidates[0].row.data || {};

  return {
    schemaVersion: CURRENT_MANUAL_SCHEMA,
    source: firstData.source || 'LEMON_MANUALS',
    vehicle: { ...vehicle },
    query: {
      scope,
      symptoms: context.symptoms || context.query || '',
      mechanicNotices: context.mechanicNotices || [],
      dtcs: context.obdCodes || [],
      canonicalProfile: queryProfile,
      canonicalSearchTerms: terms
    },
    items: selectedCandidates.map(candidate => candidate.item),
    crawled_urls: 0,
    relevant_pages: selectedCandidates.length,
    resolved_url: compatibleRows.map(row => clean(row.data?.resolved_url || row.data?.resolvedUrl)).find(Boolean) || '',
    path_resolution: 'stored-cross-context',
    applicability: firstData.applicability || null,
    retrieval: {
      elapsedMs: 0,
      timeBudgetExceeded: false,
      crawlTruncated: false,
      storedContextCount: compatibleRows.length,
      reusedContextCount: sourceRows.length
    },
    scraped: false,
    fromCache: true,
    cacheMode: 'vehicle-cross-context',
    reusedStoredEvidence: true,
    scraped_at: compatibleRows.map(row => row.scraped_at).filter(Boolean).sort().slice(-1)[0] || null
  };
}

module.exports = {
  CURRENT_MANUAL_SCHEMA,
  vehicleIdentity,
  sameVehicleIdentity,
  manualItemToPage,
  hasStrongStoredMatch,
  rerankStoredManualEvidence
};