#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveRepairDiagnosisUrl, classifyDrivetrain, drivetrainsConflict } = require('../src/services/lemon.path.resolver');
const {
  cleanText,
  normalizeText,
  extractCanonicalProfile,
  classifyManualSection,
  buildCanonicalSearchTerms
} = require('../src/core/automotive.normalization');
const { buildDtcRetrievalIntent, matchDtcAnchors } = require('../src/core/knowledge/dtc.retrieval.intent');

const MANUAL_HOSTS = new Set(['lemon-manuals.la', 'lemon-manuals.org.ua', 'lemon-manuals.gy', 'charm.li']);
const DEFAULT_MAX_PAGES = Number(process.env.LEMON_MAX_PAGES || 160);
const DEFAULT_MAX_DEPTH = Number(process.env.LEMON_MAX_DEPTH || 4);
const DEFAULT_CORPUS_BODY_CHARS = Number(process.env.LEMON_CORPUS_BODY_CHARS || 3500);
const DEFAULT_NAVIGATION_LIMIT = Number(process.env.LEMON_NAVIGATION_MAX_LINKS || 500);
const DEFAULT_SEED_FETCH_TIMEOUT_MS = Number(process.env.LEMON_SEED_FETCH_TIMEOUT_MS || 2500);
const DEFAULT_SEED_PROBE_BUDGET_MS = Number(process.env.LEMON_SEED_PROBE_BUDGET_MS || 4500);
const OUTPUT_PATH = process.env.LEMON_OUTPUT_PATH || path.join(process.cwd(), 'artifacts', 'lemon-targeted-evidence.json');

const VALID_DRIVETRAINS = new Set(['2WD', '4WD', 'AWD', 'FWD', 'RWD']);

const SCOPE_SECTION_WEIGHTS = {
  diagnosis: { DIAGNOSIS: 30, TEST: 28, SPEC: 18, TSB: 16, REPAIR: 5, PARTS: 3, LABOR: 3, OTHER: 0 },
  repair: { REPAIR: 30, PARTS: 24, LABOR: 24, SPEC: 22, TEST: 12, DIAGNOSIS: 8, TSB: 8, OTHER: 0 },
  all: { DIAGNOSIS: 18, TEST: 18, SPEC: 18, REPAIR: 18, PARTS: 18, LABOR: 18, TSB: 18, OTHER: 0 }
};

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/');
}

function stripTags(value) {
  return decodeHtml(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPage(html, url) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripTags(titleMatch?.[1] || 'Factory Service Reference');
  const headings = [];
  const headingRegex = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let headingMatch;
  while ((headingMatch = headingRegex.exec(html))) {
    const text = stripTags(headingMatch[1]);
    if (text) headings.push(text);
  }

  const links = [];
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html))) {
    const href = decodeHtml(linkMatch[1]).trim();
    const text = stripTags(linkMatch[2]);
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    try {
      const absolute = new URL(href, url).toString();
      const parsed = new URL(absolute);
      if (!MANUAL_HOSTS.has(parsed.hostname.toLowerCase())) continue;
      if (/\.(pdf|jpg|jpeg|png|gif|zip)(\?|$)/i.test(absolute)) continue;
      links.push({ url: absolute, text });
    } catch (_) {}
  }

  return { title, headings, bodyText: stripTags(html), links };
}

function contentHash(page) {
  const stable = [page.title, ...(page.headings || []), page.bodyText].map(cleanText).join('\n');
  return crypto.createHash('sha256').update(stable).digest('hex');
}

async function fetchHtml(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; SKSK-ProTech/1.3; manufacturer-evidence-retrieval)'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseCsv(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function uniq(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function dtcIntentText(context = {}) {
  return [
    context.query,
    context.symptoms,
    ...(Array.isArray(context.mechanicNotices) ? context.mechanicNotices : [context.mechanicNotices]),
    ...(Array.isArray(context.obdCodes) ? context.obdCodes : [context.obdCodes]),
    ...(Array.isArray(context.keywords) ? context.keywords : [context.keywords])
  ].filter(Boolean).join(' ');
}

function buildTargetedSearchContext(vehicle = {}, context = {}) {
  const canonical = buildCanonicalSearchTerms(vehicle, context);
  const dtcIntent = buildDtcRetrievalIntent(vehicle, dtcIntentText(context));
  const resolvedDtcTerms = dtcIntent.mode === 'DTC_ANCHORED'
    ? uniq((dtcIntent.anchors || []).flatMap(anchor => anchor.terms || []))
    : [];

  return {
    queryProfile: {
      ...canonical.profile,
      resolvedDtcTerms
    },
    terms: uniq([...(canonical.terms || []), ...resolvedDtcTerms]),
    dtcIntent,
    resolvedDtcTerms
  };
}

function getInput() {
  const year = String(process.env.LEMON_YEAR || '').trim();
  const make = String(process.env.LEMON_MAKE || '').trim();
  const model = String(process.env.LEMON_MODEL || '').trim();
  if (!year || !make || !model) throw new Error('LEMON_YEAR, LEMON_MAKE, and LEMON_MODEL are required');

  const scopeRaw = String(process.env.LEMON_SCOPE || 'diagnosis').trim().toLowerCase();
  const scope = SCOPE_SECTION_WEIGHTS[scopeRaw] ? scopeRaw : 'diagnosis';
  const drivetrainRaw = String(process.env.LEMON_DRIVETRAIN || '').trim();
  if (drivetrainRaw && !VALID_DRIVETRAINS.has(drivetrainRaw.toUpperCase())) {
    throw new Error(
      `LEMON_DRIVETRAIN must be one of 2WD, 4WD, AWD, FWD, or RWD (case-insensitive). Received: "${drivetrainRaw}"`
    );
  }
  const vehicle = {
    year,
    make,
    model,
    trim: String(process.env.LEMON_TRIM || '').trim(),
    engine: String(process.env.LEMON_ENGINE || '').trim(),
    drivetrain: drivetrainRaw
  };
  const context = {
    symptoms: String(process.env.LEMON_SYMPTOMS || '').trim(),
    mechanicNotices: parseCsv(process.env.LEMON_MECHANIC_NOTICES),
    obdCodes: parseCsv(process.env.LEMON_DTCS)
  };
  return { vehicle, context, scope };
}

function semanticKind(term, queryProfile) {
  const normalized = normalizeText(term);
  if (queryProfile.dtcs.some(code => normalizeText(code) === normalized)) return 'dtc';
  if ((queryProfile.resolvedDtcTerms || []).some(value => normalizeText(value) === normalized)) return 'dtc-meaning';
  if (queryProfile.triggers.includes(term)) return 'trigger';
  if (queryProfile.sounds.includes(term)) return 'sound';
  if (queryProfile.conditions.includes(term)) return 'condition';
  if (queryProfile.systems.includes(term)) return 'system';
  return 'other';
}

function semanticMatchWeight(term, queryProfile, sectionType) {
  const kind = semanticKind(term, queryProfile);
  if (kind === 'dtc') return 28;
  if (kind === 'dtc-meaning') return 22;
  if (kind === 'trigger') return 18;
  if (kind === 'sound') return 16;
  if (kind === 'condition') return 14;
  if (kind === 'system') return sectionType === 'SPEC' ? 4 : 8;
  return 5;
}

function scorePage(page, searchTerms, scope, queryProfile = {}) {
  const title = normalizeText(page.title);
  const headings = normalizeText((page.headings || []).join(' '));
  const url = normalizeText(page.url);
  const body = normalizeText(page.bodyText).slice(0, 50000);
  const sectionType = classifyManualSection(page);
  const profile = extractCanonicalProfile(page);
  const matchedTerms = [];
  const matchLocations = {};
  let semanticScore = 0;

  for (const term of searchTerms) {
    const normalized = normalizeText(term);
    if (!normalized || normalized.length < 3) continue;

    const locations = [];
    if (title.includes(normalized)) locations.push('title');
    if (headings.includes(normalized)) locations.push('heading');
    if (url.includes(normalized)) locations.push('path');
    if (body.includes(normalized)) locations.push('body');
    if (!locations.length) continue;

    const kind = semanticKind(term, queryProfile);
    if (kind === 'system' && !locations.some(location => location === 'title' || location === 'heading')) continue;

    const baseWeight = semanticMatchWeight(term, queryProfile, sectionType);
    let locationMultiplier = 0;
    if (locations.includes('title')) locationMultiplier = Math.max(locationMultiplier, 1.0);
    if (locations.includes('heading')) locationMultiplier = Math.max(locationMultiplier, 0.9);
    if (locations.includes('path')) locationMultiplier = Math.max(locationMultiplier, 0.75);
    if (locations.includes('body')) locationMultiplier = Math.max(locationMultiplier, 0.25);

    semanticScore += Math.round(baseWeight * locationMultiplier);
    matchedTerms.push(term);
    matchLocations[term] = locations;
  }

  const uniqueMatchedTerms = [...new Set(matchedTerms)];
  const matchedTrigger = uniqueMatchedTerms.some(term => queryProfile.triggers?.includes(term));
  const matchedSound = uniqueMatchedTerms.some(term => queryProfile.sounds?.includes(term));
  const matchedDtc = uniqueMatchedTerms.some(term =>
    queryProfile.dtcs?.some(code => normalizeText(code) === normalizeText(term)) ||
    queryProfile.resolvedDtcTerms?.some(value => normalizeText(value) === normalizeText(term))
  );

  if (matchedTrigger && matchedSound) semanticScore += 18;
  if (matchedDtc && ['DIAGNOSIS', 'TEST'].includes(sectionType)) semanticScore += 12;

  const scopeScore = uniqueMatchedTerms.length ? (SCOPE_SECTION_WEIGHTS[scope][sectionType] || 0) : 0;
  const score = semanticScore + scopeScore;

  return {
    score,
    semanticScore,
    scopeScore,
    sectionType,
    profile,
    matchedTerms: uniqueMatchedTerms.slice(0, 60),
    matchLocations
  };
}

function exactDtcLinkPriority(link, queryProfile = {}) {
  const haystack = normalizeText(`${link.text || ''} ${decodeURIComponentSafe(link.url || '')}`);
  return (queryProfile.dtcs || []).some(code => haystack.includes(normalizeText(code))) ? 10000 : 0;
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); }
  catch (_) { return String(value || ''); }
}

function normalizedManualPath(value) {
  try {
    return decodeURIComponentSafe(new URL(value).pathname)
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
    const candidatePath = normalizedManualPath(candidate.toString());
    const rootPath = normalizedManualPath(root.toString());
    return !!candidatePath && !!rootPath && (candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`));
  } catch (_) {
    return false;
  }
}

function prepareSeedLinks(seedLinks = [], rootUrl, limit = 24) {
  const best = new Map();
  for (const seed of Array.isArray(seedLinks) ? seedLinks : []) {
    const url = String(seed?.url || '').trim();
    if (!url || !isWithinManualRoot(url, rootUrl)) continue;
    const normalized = url.toLowerCase();
    const candidate = {
      url,
      text: String(seed?.text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      priority: Number(seed?.priority || 0),
      matchedDtcs: Array.isArray(seed?.matchedDtcs) ? seed.matchedDtcs.map(String).slice(0, 12) : []
    };
    const current = best.get(normalized);
    if (!current || candidate.priority > current.priority) best.set(normalized, candidate);
  }
  return [...best.values()]
    .sort((a, b) => b.priority - a.priority || a.url.localeCompare(b.url))
    .slice(0, Math.max(1, Math.min(24, Number(limit || 24))));
}

function buildNavigationIndex(candidatePages = [], rootUrl, limit = DEFAULT_NAVIGATION_LIMIT) {
  const byUrl = new Map();
  for (const candidate of candidatePages) {
    for (const link of candidate?.page?.links || []) {
      if (!isWithinManualRoot(link?.url, rootUrl)) continue;
      const url = String(link.url || '').trim();
      if (!url) continue;
      const key = url.toLowerCase();
      const item = {
        url,
        text: String(link.text || '').replace(/\s+/g, ' ').trim().slice(0, 240)
      };
      const current = byUrl.get(key);
      if (!current || item.text.length > current.text.length) byUrl.set(key, item);
    }
  }
  return [...byUrl.values()]
    .sort((a, b) => a.url.localeCompare(b.url))
    .slice(0, Math.max(1, Math.min(1000, Number(limit || DEFAULT_NAVIGATION_LIMIT))));
}

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'ref', 'refid', 'session', 'sid'
]);

function normalizedRetrievalPath(url) {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponentSafe(parsed.pathname)
      .toLowerCase()
      .replace(/\/+$/, '');
    const keptParams = [...parsed.searchParams.entries()]
      .filter(([key]) => !TRACKING_QUERY_PARAMS.has(key.toLowerCase()))
      .sort(([keyA, valueA], [keyB, valueB]) =>
        keyA.toLowerCase().localeCompare(keyB.toLowerCase()) ||
        valueA.toLowerCase().localeCompare(valueB.toLowerCase())
      )
      .map(([key, value]) => `${key.toLowerCase()}=${value.toLowerCase()}`)
      .join('&');
    return keptParams ? `${pathname}?${keptParams}` : pathname;
  } catch (_) {
    return normalizeText(url);
  }
}

function normalizedRetrievalKey(page, relevance) {
  const title = normalizeText(page.title)
    .replace(/\b\d{4}\s+(kia|honda|ford|chevrolet|toyota|nissan|hyundai)\b.*$/i, '')
    .replace(/\bservice manual\b.*$/i, '')
    .trim();
  const pathKey = normalizedRetrievalPath(page.url);
  return `${relevance.sectionType}|${title}|${pathKey}`;
}

function buildOutputPage(candidate, source) {
  const { page, relevance, alternates = [] } = candidate;
  return {
    sourceEvidence: {
      source,
      sourceUrl: page.url,
      alternateSourceUrls: alternates.map(item => item.page.url).filter(url => url !== page.url),
      title: page.title,
      headings: page.headings,
      bodyText: page.bodyText,
      contentHash: contentHash(page)
    },
    derivedIndex: {
      sectionType: relevance.sectionType,
      relevanceScore: relevance.score,
      semanticScore: relevance.semanticScore,
      scopeScore: relevance.scopeScore,
      matchedTerms: relevance.matchedTerms,
      matchLocations: relevance.matchLocations,
      dtcs: relevance.profile.dtcs,
      sounds: relevance.profile.sounds,
      conditions: relevance.profile.conditions,
      systems: relevance.profile.systems,
      canonicalTerms: relevance.profile.canonicalTerms,
      sourceVariantCount: 1 + alternates.length
    }
  };
}

function buildCorpusPage(candidate, source, maxBodyChars = DEFAULT_CORPUS_BODY_CHARS) {
  const output = buildOutputPage({ ...candidate, alternates: [] }, source);
  const bodyLimit = Math.max(500, Math.min(10000, Number(maxBodyChars || DEFAULT_CORPUS_BODY_CHARS)));
  output.sourceEvidence.bodyText = String(output.sourceEvidence.bodyText || '').slice(0, bodyLimit);
  output.sourceEvidence.alternateSourceUrls = [];
  return output;
}

function checkDrivetrainCompatibility(requestedDrivetrainRaw, resolvedUrl, options = {}) {
  const resolvedDrivetrain = classifyDrivetrain(decodeURIComponentSafe(resolvedUrl));
  const requestedDrivetrain = classifyDrivetrain(requestedDrivetrainRaw);
  if (!requestedDrivetrain && resolvedDrivetrain) {
    if (options.allowUnknown === true) {
      return { requestedDrivetrain, resolvedDrivetrain, exact: false, requiresVerification: true };
    }
    throw new Error(
      `LEMON resolved a drive-specific ${resolvedDrivetrain.toUpperCase()} manual while drivetrain is unknown. ` +
      'Set LEMON_DRIVETRAIN (for example 2WD or 4WD) before creating manufacturer evidence.'
    );
  }
  if (requestedDrivetrain && resolvedDrivetrain && drivetrainsConflict(requestedDrivetrain, resolvedDrivetrain)) {
    throw new Error(`Manual drivetrain mismatch: requested ${requestedDrivetrain}, resolved ${resolvedDrivetrain}`);
  }
  return {
    requestedDrivetrain,
    resolvedDrivetrain,
    exact: !!requestedDrivetrain && (!resolvedDrivetrain || requestedDrivetrain === resolvedDrivetrain),
    requiresVerification: false
  };
}

function buildDescendantQueueEntry(next, link, linkRelevance, dtcPriority) {
  return {
    url: link.url,
    depth: next.depth + 1,
    priority: linkRelevance.score + dtcPriority,
    exactDtc: next.exactDtc || dtcPriority > 0,
    seed: false
  };
}

function compareQueueEntries(a, b) {
  return Number(b.seed) - Number(a.seed) ||
    Number(b.exactDtc) - Number(a.exactDtc) ||
    Number(b.priority || 0) - Number(a.priority || 0) ||
    Number(a.depth || 0) - Number(b.depth || 0);
}

function seedCoverageSatisfied(dtcIntent = {}, matchedDtcs = new Set()) {
  if (dtcIntent.mode !== 'DTC_ANCHORED') return false;
  const required = (dtcIntent.anchors || []).map(anchor => anchor.code);
  return required.length > 0 && required.every(code => matchedDtcs.has(code));
}

async function scrapeTargetedEvidence(vehicle, context = {}, scope = 'diagnosis', options = {}) {
  if (!vehicle?.year || !vehicle?.make || !vehicle?.model) {
    throw new Error('Vehicle year, make, and model are required for targeted manual retrieval');
  }
  const startedAt = Date.now();
  const normalizedScope = SCOPE_SECTION_WEIGHTS[scope] ? scope : 'diagnosis';
  const maxPages = Math.max(1, Number(options.maxPages || DEFAULT_MAX_PAGES));
  const maxDepth = Math.max(0, Number(options.maxDepth ?? DEFAULT_MAX_DEPTH));
  const fetchTimeoutMs = Math.max(250, Number(options.fetchTimeoutMs || 12000));
  const maxElapsedMs = Math.max(0, Number(options.maxElapsedMs || 0));
  const corpusLimit = Math.max(1, Math.min(maxPages, Number(options.corpusLimit || maxPages)));
  const corpusBodyChars = Math.max(500, Math.min(10000, Number(options.corpusBodyChars || DEFAULT_CORPUS_BODY_CHARS)));
  const navigationLimit = Math.max(1, Math.min(1000, Number(options.navigationLimit || DEFAULT_NAVIGATION_LIMIT)));
  const seedFetchTimeoutMs = Math.max(250, Math.min(fetchTimeoutMs, Number(options.seedFetchTimeoutMs || DEFAULT_SEED_FETCH_TIMEOUT_MS)));
  const seedProbeBudgetMs = Math.max(500, Number(options.seedProbeBudgetMs || DEFAULT_SEED_PROBE_BUDGET_MS));
  const { queryProfile, terms, dtcIntent, resolvedDtcTerms } = buildTargetedSearchContext(vehicle, context);
  const resolution = await resolveRepairDiagnosisUrl(vehicle);
  const baseUrl = resolution.url;
  const source = resolution.source || (new URL(baseUrl).hostname.toLowerCase() === 'charm.li' ? 'CHARM' : 'LEMON_MANUALS');
  const applicability = checkDrivetrainCompatibility(
    vehicle.drivetrain || vehicle.driveType || vehicle.drive,
    baseUrl,
    { allowUnknown: options.allowUnknownDrivetrain === true }
  );
  const crawlStartedAt = Date.now();
  const preparedSeeds = prepareSeedLinks(options.seedLinks, baseUrl, 24);

  const queue = [
    ...preparedSeeds.map((seed, index) => ({
      url: seed.url,
      depth: 0,
      priority: 20000 + Number(seed.priority || 0) - index,
      exactDtc: true,
      seed: true
    })),
    { url: baseUrl, depth: 0, priority: 1000, exactDtc: false, seed: false }
  ];
  const queued = new Set(queue.map(item => item.url));
  const visited = new Set();
  const candidatePages = [];
  const seedMatchedDtcs = new Set();
  let seedEarlyStop = false;
  let timeBudgetExceeded = false;

  while (queue.length && visited.size < maxPages) {
    if (maxElapsedMs > 0 && Date.now() - crawlStartedAt >= maxElapsedMs) {
      timeBudgetExceeded = true;
      break;
    }

    queue.sort(compareQueueEntries);
    const next = queue.shift();
    if (!next || visited.has(next.url) || next.depth > maxDepth) continue;
    if (next.seed && Date.now() - crawlStartedAt >= seedProbeBudgetMs) continue;
    visited.add(next.url);

    try {
      const remainingMs = maxElapsedMs > 0 ? maxElapsedMs - (Date.now() - crawlStartedAt) : fetchTimeoutMs;
      if (maxElapsedMs > 0 && remainingMs <= 0) {
        timeBudgetExceeded = true;
        break;
      }
      let requestTimeoutMs = maxElapsedMs > 0
        ? Math.max(250, Math.min(fetchTimeoutMs, remainingMs))
        : fetchTimeoutMs;
      if (next.seed) requestTimeoutMs = Math.min(requestTimeoutMs, seedFetchTimeoutMs);

      const page = { ...extractPage(await fetchHtml(next.url, requestTimeoutMs), next.url), url: next.url };
      const relevance = scorePage(page, terms, normalizedScope, queryProfile);
      candidatePages.push({ page, relevance, depth: next.depth });

      if (next.seed && dtcIntent.mode === 'DTC_ANCHORED' &&
          ['DIAGNOSIS', 'TEST', 'SPEC'].includes(relevance.sectionType) &&
          Number(relevance.score || 0) > 0) {
        const visibleText = [page.title, ...(page.headings || []), page.url, page.bodyText].filter(Boolean).join(' ');
        const anchored = matchDtcAnchors(visibleText, dtcIntent);
        for (const code of anchored.matchedDtcs || []) seedMatchedDtcs.add(code);
        if (seedCoverageSatisfied(dtcIntent, seedMatchedDtcs)) {
          seedEarlyStop = true;
          break;
        }
      }

      for (const link of page.links) {
        if (visited.has(link.url) || queued.has(link.url) || next.depth + 1 > maxDepth) continue;
        const linkPage = { title: link.text, headings: [], bodyText: link.text, url: link.url };
        const linkRelevance = scorePage(linkPage, terms, normalizedScope, queryProfile);
        const dtcPriority = exactDtcLinkPriority(link, queryProfile);
        queued.add(link.url);
        queue.push(buildDescendantQueueEntry(next, link, linkRelevance, dtcPriority));
      }
    } catch (error) {
      if (options.onFetchError) options.onFetchError(next.url, error);
    }
  }

  const navigationLinks = buildNavigationIndex(candidatePages, baseUrl, navigationLimit);

  const corpusByHash = new Map();
  for (const candidate of candidatePages) {
    const hash = contentHash(candidate.page);
    if (!corpusByHash.has(hash)) corpusByHash.set(hash, candidate);
  }
  const corpusPages = [...corpusByHash.values()]
    .slice(0, corpusLimit)
    .map(candidate => buildCorpusPage(candidate, source, corpusBodyChars));

  const byHash = new Map();
  for (const candidate of candidatePages) {
    if (!candidate.relevance.matchedTerms.length) continue;
    const hash = contentHash(candidate.page);
    const current = byHash.get(hash);
    if (!current || candidate.relevance.score > current.relevance.score) byHash.set(hash, candidate);
  }

  const byRetrievalKey = new Map();
  for (const candidate of byHash.values()) {
    const key = normalizedRetrievalKey(candidate.page, candidate.relevance);
    const current = byRetrievalKey.get(key);
    if (!current) {
      byRetrievalKey.set(key, { ...candidate, alternates: [] });
      continue;
    }

    if (candidate.relevance.score > current.relevance.score) {
      byRetrievalKey.set(key, { ...candidate, alternates: [current, ...(current.alternates || [])] });
    } else {
      current.alternates.push(candidate);
    }
  }

  const selected = [...byRetrievalKey.values()]
    .sort((a, b) => b.relevance.score - a.relevance.score)
    .slice(0, Number(options.limit || 60))
    .map(candidate => buildOutputPage(candidate, source));

  return {
    schemaVersion: 2,
    source,
    evidencePolicy: {
      sourceEvidenceImmutable: true,
      derivedIndexRebuildable: true,
      note: 'Manufacturer text is preserved in sourceEvidence. SKSK normalization and ranking live only in derivedIndex.'
    },
    vehicle,
    query: {
      scope: normalizedScope,
      symptoms: context.symptoms || context.query || '',
      mechanicNotices: context.mechanicNotices || [],
      dtcs: context.obdCodes || [],
      canonicalProfile: queryProfile,
      canonicalSearchTerms: terms,
      resolvedDtcTerms,
      retrievalIntentMode: dtcIntent.mode
    },
    applicability,
    resolvedUrl: baseUrl,
    pathResolution: resolution.method,
    crawledPages: visited.size,
    selectedPages: selected.length,
    corpusPageCount: corpusPages.length,
    navigationLinkCount: navigationLinks.length,
    seedLinkCount: preparedSeeds.length,
    seededNavigationUsed: preparedSeeds.length > 0,
    seedEarlyStop,
    seedMatchedDtcs: [...seedMatchedDtcs],
    pages: selected,
    corpusPages,
    navigationLinks,
    elapsedMs: Date.now() - startedAt,
    timeBudgetExceeded,
    crawlTruncated: queue.length > 0,
    scrapedAt: new Date().toISOString()
  };
}

async function main() {
  const { vehicle, context, scope } = getInput();
  console.log(`Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.engine}`.trim());
  console.log(`Scope: ${scope}`);
  const output = await scrapeTargetedEvidence(vehicle, context, scope, {
    onFetchError: (url, error) => console.warn(`Fetch failed: ${url}: ${error.message}`)
  });
  console.log(`Resolved ${output.source} path (${output.pathResolution}): ${output.resolvedUrl}`);
  console.log('Canonical query profile:', output.query.canonicalProfile);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(
    `Selected ${output.selectedPages} relevant page(s) from ${output.crawledPages} crawled page(s); ` +
    `retained ${output.corpusPageCount} bounded corpus page(s) and ${output.navigationLinkCount} navigation link(s)`
  );
  console.log(`Wrote ${OUTPUT_PATH}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  scrapeTargetedEvidence,
  getInput,
  extractPage,
  checkDrivetrainCompatibility,
  buildDescendantQueueEntry,
  compareQueueEntries,
  normalizedManualPath,
  isWithinManualRoot,
  prepareSeedLinks,
  buildNavigationIndex,
  seedCoverageSatisfied,
  normalizedRetrievalPath,
  normalizedRetrievalKey,
  exactDtcLinkPriority,
  buildCorpusPage,
  buildTargetedSearchContext,
  scorePage,
  VALID_DRIVETRAINS
};