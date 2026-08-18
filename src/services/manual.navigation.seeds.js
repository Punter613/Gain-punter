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

const STRUCTURAL_DTC_HINTS = Object.freeze({
  P0300: Object.freeze([
    ['ignition', 900], ['fuel delivery', 800], ['fuel injection', 800],
    ['engine control', 700], ['powertrain management', 650],
    ['diagnostic trouble', 550], ['testing and inspection', 120]
  ]),
  P0171: Object.freeze([
    ['fuel trim', 1000], ['air intake', 900], ['vacuum', 900],
    ['fuel delivery', 800], ['fuel injection', 800], ['emission control', 750],
    ['engine control', 700], ['powertrain management', 650],
    ['diagnostic trouble', 550], ['testing and inspection', 120]
  ]),
  P0174: Object.freeze([
    ['fuel trim', 1000], ['air intake', 900], ['vacuum', 900],
    ['fuel delivery', 800], ['fuel injection', 800], ['emission control', 750],
    ['engine control', 700], ['powertrain management', 650],
    ['diagnostic trouble', 550], ['testing and inspection', 120]
  ]),
  P0420: Object.freeze([
    ['catalyst', 1000], ['exhaust', 850], ['emission control', 800],
    ['engine control', 600], ['diagnostic trouble', 550], ['testing and inspection', 120]
  ]),
  P0442: Object.freeze([
    ['evap', 1000], ['evaporative emission', 1000], ['fuel vapor', 900],
    ['emission control', 800], ['diagnostic trouble', 550], ['testing and inspection', 120]
  ]),
  P0455: Object.freeze([
    ['evap', 1000], ['evaporative emission', 1000], ['fuel vapor', 900],
    ['emission control', 800], ['diagnostic trouble', 550], ['testing and inspection', 120]
  ]),
  P2135: Object.freeze([
    ['throttle', 1000], ['engine control', 700], ['powertrain management', 650],
    ['diagnostic trouble', 550], ['testing and inspection', 120]
  ]),
  P2138: Object.freeze([
    ['accelerator pedal', 1000], ['throttle', 900], ['engine control', 700],
    ['powertrain management', 650], ['diagnostic trouble', 550], ['testing and inspection', 120]
  ]),
  P1326: Object.freeze([
    ['knock sensor', 1000], ['engine mechanical', 850], ['engine control', 700],
    ['powertrain management', 650], ['diagnostic trouble', 550], ['testing and inspection', 120]
  ])
});

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeSafe(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch (_) { return String(value || ''); }
}

function normalizedPathname(value) {
  try {
    return decodeSafe(new URL(value).pathname)
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
  return [link.text, decodeSafe(link.url)].filter(Boolean).join(' ');
}

function structuralNavigationScore(sourceText = '', dtcIntent = {}) {
  if (dtcIntent.mode !== 'DTC_ANCHORED') return 0;
  const haystack = clean(sourceText).toLowerCase();
  let score = 0;
  for (const anchor of dtcIntent.anchors || []) {
    const hints = STRUCTURAL_DTC_HINTS[anchor.code] || [];
    let bestForCode = 0;
    for (const [term, weight] of hints) {
      if (haystack.includes(term)) bestForCode = Math.max(bestForCode, weight);
    }
    score += bestForCode;
  }
  return score;
}

function rankNavigationLink(link = {}, vehicle = {}, search = {}, scope = 'diagnosis') {
  const sourceText = navigationSourceText(link);
  if (!sourceText || search.dtcIntent?.mode !== 'DTC_ANCHORED') return null;
  if (!checkEngineApplicability(vehicle, sourceText).compatible) return null;

  const anchorMatch = matchDtcAnchors(sourceText, search.dtcIntent);
  const structuralScore = anchorMatch.matched ? 0 : structuralNavigationScore(sourceText, search.dtcIntent);
  if (!anchorMatch.matched && structuralScore <= 0) return null;

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

  const directPriority =
    (anchorMatch.exactDtcs?.length || 0) * 10000 +
    (anchorMatch.matchedDtcs?.length || 0) * 1000;
  const priority = directPriority + structuralScore + Number(relevance.score || 0);

  return {
    url: clean(link.url),
    text: clean(link.text).slice(0, 240),
    priority,
    seedKind: anchorMatch.matched ? 'DTC_ANCHOR' : 'STRUCTURAL_NAVIGATION',
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
  STRUCTURAL_DTC_HINTS,
  normalizedPathname,
  isWithinManualRoot,
  navigationSourceText,
  structuralNavigationScore,
  rankNavigationLink,
  buildStoredNavigationSeeds
};