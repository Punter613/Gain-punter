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

const MANUAL_HOSTS = new Set(['lemon-manuals.la', 'lemon-manuals.org.ua', 'lemon-manuals.gy', 'charm.li']);
const DEFAULT_MAX_PAGES = Number(process.env.LEMON_MAX_PAGES || 160);
const DEFAULT_MAX_DEPTH = Number(process.env.LEMON_MAX_DEPTH || 4);
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
  if (queryProfile.triggers.includes(term)) return 'trigger';
  if (queryProfile.sounds.includes(term)) return 'sound';
  if (queryProfile.conditions.includes(term)) return 'condition';
  if (queryProfile.systems.includes(term)) return 'system';
  return 'other';
}

function semanticMatchWeight(term, queryProfile, sectionType) {
  const kind = semanticKind(term, queryProfile);
  if (kind === 'dtc') return 28;
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
  const matchedDtc = uniqueMatchedTerms.some(term => queryProfile.dtcs?.some(code => normalizeText(code) === normalizeText(term)));

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
    exactDtc: next.exactDtc || dtcPriority > 0
  };
}

function compareQueueEntries(a, b) {
  return Number(b.exactDtc) - Number(a.exactDtc) ||
    Number(b.priority || 0) - Number(a.priority || 0) ||
    Number(a.depth || 0) - Number(b.depth || 0);
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
  const { profile: queryProfile, terms } = buildCanonicalSearchTerms(vehicle, context);
  const resolution = await resolveRepairDiagnosisUrl(vehicle);
  const baseUrl = resolution.url;
  const source = resolution.source || (new URL(baseUrl).hostname.toLowerCase() === 'charm.li' ? 'CHARM' : 'LEMON_MANUALS');
  const applicability = checkDrivetrainCompatibility(
    vehicle.drivetrain || vehicle.driveType || vehicle.drive,
    baseUrl,
    { allowUnknown: options.allowUnknownDrivetrain === true }
  );
  const crawlStartedAt = Date.now();

  const queue = [{ url: baseUrl, depth: 0, priority: 1000, exactDtc: false }];
  const queued = new Set([baseUrl]);
  const visited = new Set();
  const candidatePages = [];
  let timeBudgetExceeded = false;

  while (queue.length && visited.size < maxPages) {
    if (maxElapsedMs > 0 && Date.now() - crawlStartedAt >= maxElapsedMs) {
      timeBudgetExceeded = true;
      break;
    }

    queue.sort(compareQueueEntries);
    const next = queue.shift();
    if (!next || visited.has(next.url) || next.depth > maxDepth) continue;
    visited.add(next.url);

    try {
      const remainingMs = maxElapsedMs > 0 ? maxElapsedMs - (Date.now() - crawlStartedAt) : fetchTimeoutMs;
      if (maxElapsedMs > 0 && remainingMs <= 0) {
        timeBudgetExceeded = true;
        break;
      }
      const requestTimeoutMs = maxElapsedMs > 0
        ? Math.max(250, Math.min(fetchTimeoutMs, remainingMs))
        : fetchTimeoutMs;
      const page = { ...extractPage(await fetchHtml(next.url, requestTimeoutMs), next.url), url: next.url };
      const relevance = scorePage(page, terms, normalizedScope, queryProfile);
      candidatePages.push({ page, relevance, depth: next.depth });

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
      canonicalSearchTerms: terms
    },
    applicability,
    resolvedUrl: baseUrl,
    pathResolution: resolution.method,
    crawledPages: visited.size,
    selectedPages: selected.length,
    pages: selected,
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
  console.log(`Selected ${output.selectedPages} relevant page(s) from ${output.crawledPages} crawled page(s)`);
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
  normalizedRetrievalPath,
  normalizedRetrievalKey,
  exactDtcLinkPriority,
  scorePage,
  VALID_DRIVETRAINS
};
