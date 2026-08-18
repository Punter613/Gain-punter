'use strict';

const {
  sameVehicleIdentity,
  buildCurrentSearchContext
} = require('./manual.evidence.reuse');
const {
  matchDtcAnchors,
  checkEngineApplicability
} = require('../core/knowledge/dtc.retrieval.intent');
const { scorePage } = require('../../scripts/scrape-lemon-targeted-evidence');

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedPathname(value) {
  try {
    return decodeURIComponent(new URL(value).pathname)
      .replace(/\\/g, '/')
      .replace(/\/{2,}/g, '/')
      .replace(/\/$/, '')
      .toLowerCase();
  } catch (_) {
    return '';
  }
}

function isWithinManualRoot(url, rootUrl) {
  try {
    const candidate = new URL(url);
    const root = new URL(rootUrl);
    if (candidate.hostname.toLowerCase() !== root.hostname.toLowerCase()) return false;
    const candidatePath = normalizedPathname(candidate.toString());
    const rootPath = normalizedPathname(root.toString());
    if (!candidatePath || !rootPath) return false;
    return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
  } catch (_) {
    return false;
  }
}

function navigationSourceText(link = {}) {
  return [link.text, link.url].filter(Boolean).join(' ');
}

function rankNavigationLink(link = {}, vehicle = {}, search = {}, scope = 'diagnosis') {
  const sourceText = navigationSourceText(link);
  if (!sourceText || search.dtcIntent?.mode !== 'DTC_ANCHORED') return null;

  const anchorMatch = matchDtcAnchors(sourceText, search.dtcIntent);
  if (!anchorMatch.matched) return null;
  if (!checkEngineApplicability(vehicle, sourceText).compatible) return null;

  const relevance = scorePage(
    {
      title: clean(link.text || 'Manual navigation'),
      headings: [],
      url: clean(link.url),
      bodyText: clean(link.text)
    },
    search.terms || [],
    scope,
    search.queryProfile || {}
  );

  const priority =
    (anchorMatch.exactDtcs?.length || 0) * 10000 +
    (anchorMatch.matchedDtcs?.length || 0) * 1000 +
    Number(relevance.score || 0);

  return {
    url: clean(link.url),
    text: clean(link.text).slice(0, 240),
    priority,
    matchedDtcs: anchorMatch.matchedDtcs || [],
    matchedDtcTerms: anchorMatch.matchedTerms || []
  };
}

function buildStoredNavigationSeeds(rows = [], vehicle = {}, context = {}, scope = 'diagnosis', options = {}) {
  const limit = Math.max(1, Math.min(24, Number(options.limit || 12)));
  const search = buildCurrentSearchContext(vehicle, context);
  if (search.dtcIntent?.mode !== 'DTC_ANCHORED') return [];

  const best = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.data?.schemaVersion !== 5) continue;
    if (!sameVehicleIdentity(row.data?.vehicle || {}, vehicle)) continue;

    const rootUrl = clean(row.data?.resolved_url || row.data?.resolvedUrl);
    if (!rootUrl) continue;

    for (const link of Array.isArray(row.data?.navigationLinks) ? row.data.navigationLinks : []) {
      if (!isWithinManualRoot(link?.url, rootUrl)) continue;
      const ranked = rankNavigationLink(link, vehicle, search, scope);
      if (!ranked) continue;
      const key = ranked.url.toLowerCase();
      const current = best.get(key);
      if (!current || ranked.priority > current.priority) best.set(key, ranked);
    }
  }

  return [...best.values()]
    .sort((a, b) => b.priority - a.priority || a.url.localeCompare(b.url))
    .slice(0, limit);
}

module.exports = {
  normalizedPathname,
  isWithinManualRoot,
  navigationSourceText,
  rankNavigationLink,
  buildStoredNavigationSeeds
};