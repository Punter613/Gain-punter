#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveRepairDiagnosisUrl } = require('../src/services/lemon.path.resolver');
const {
  cleanText,
  normalizeText,
  extractCanonicalProfile,
  classifyManualSection,
  buildCanonicalSearchTerms
} = require('../src/core/automotive.normalization');

const LEMON_HOSTS = new Set(['lemon-manuals.la', 'lemon-manuals.org.ua', 'lemon-manuals.gy']);
const MAX_PAGES = Number(process.env.LEMON_MAX_PAGES || 80);
const MAX_DEPTH = Number(process.env.LEMON_MAX_DEPTH || 4);
const OUTPUT_PATH = process.env.LEMON_OUTPUT_PATH || path.join(process.cwd(), 'artifacts', 'lemon-targeted-evidence.json');

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
      if (!LEMON_HOSTS.has(parsed.hostname.toLowerCase())) continue;
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
  const vehicle = {
    year,
    make,
    model,
    trim: String(process.env.LEMON_TRIM || '').trim(),
    engine: String(process.env.LEMON_ENGINE || '').trim()
  };
  const context = {
    symptoms: String(process.env.LEMON_SYMPTOMS || '').trim(),
    mechanicNotices: parseCsv(process.env.LEMON_MECHANIC_NOTICES),
    obdCodes: parseCsv(process.env.LEMON_DTCS)
  };
  return { vehicle, context, scope };
}

function scorePage(page, searchTerms, scope) {
  const title = normalizeText(page.title);
  const headings = normalizeText((page.headings || []).join(' '));
  const url = normalizeText(page.url);
  const body = normalizeText(page.bodyText).slice(0, 50000);
  const sectionType = classifyManualSection(page);
  const profile = extractCanonicalProfile(page);
  const matchedTerms = [];
  let score = SCOPE_SECTION_WEIGHTS[scope][sectionType] || 0;

  for (const term of searchTerms) {
    const normalized = normalizeText(term);
    if (!normalized || normalized.length < 3) continue;
    if (title.includes(normalized)) { score += 15; matchedTerms.push(term); }
    if (headings.includes(normalized)) { score += 12; matchedTerms.push(term); }
    if (url.includes(normalized)) { score += 8; matchedTerms.push(term); }
    if (body.includes(normalized)) { score += 2; matchedTerms.push(term); }
  }

  return {
    score,
    sectionType,
    profile,
    matchedTerms: [...new Set(matchedTerms)].slice(0, 60)
  };
}

function buildOutputPage(page, relevance) {
  return {
    sourceEvidence: {
      source: 'LEMON_MANUALS',
      sourceUrl: page.url,
      title: page.title,
      headings: page.headings,
      bodyText: page.bodyText,
      contentHash: contentHash(page)
    },
    derivedIndex: {
      sectionType: relevance.sectionType,
      relevanceScore: relevance.score,
      matchedTerms: relevance.matchedTerms,
      dtcs: relevance.profile.dtcs,
      sounds: relevance.profile.sounds,
      conditions: relevance.profile.conditions,
      systems: relevance.profile.systems,
      canonicalTerms: relevance.profile.canonicalTerms
    }
  };
}

async function main() {
  const { vehicle, context, scope } = getInput();
  const { profile: queryProfile, terms } = buildCanonicalSearchTerms(vehicle, context);
  const resolution = await resolveRepairDiagnosisUrl(vehicle);
  const baseUrl = resolution.url;

  console.log(`Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.engine}`.trim());
  console.log(`Scope: ${scope}`);
  console.log(`Resolved Lemon path (${resolution.method}): ${baseUrl}`);
  console.log('Canonical query profile:', queryProfile);

  const queue = [{ url: baseUrl, depth: 0, priority: 1000 }];
  const queued = new Set([baseUrl]);
  const visited = new Set();
  const candidatePages = [];

  while (queue.length && visited.size < MAX_PAGES) {
    queue.sort((a, b) => b.priority - a.priority);
    const next = queue.shift();
    if (!next || visited.has(next.url) || next.depth > MAX_DEPTH) continue;
    visited.add(next.url);

    try {
      const page = { ...extractPage(await fetchHtml(next.url), next.url), url: next.url };
      const relevance = scorePage(page, terms, scope);
      candidatePages.push({ page, relevance, depth: next.depth });

      for (const link of page.links) {
        if (visited.has(link.url) || queued.has(link.url) || next.depth + 1 > MAX_DEPTH) continue;
        const linkPage = { title: link.text, headings: [], bodyText: link.text, url: link.url };
        const linkRelevance = scorePage(linkPage, terms, scope);
        queued.add(link.url);
        queue.push({ url: link.url, depth: next.depth + 1, priority: linkRelevance.score });
      }
    } catch (error) {
      console.warn(`Fetch failed: ${next.url}: ${error.message}`);
    }
  }

  const byHash = new Map();
  for (const candidate of candidatePages) {
    if (candidate.relevance.score <= 0) continue;
    const hash = contentHash(candidate.page);
    const current = byHash.get(hash);
    if (!current || candidate.relevance.score > current.relevance.score) byHash.set(hash, candidate);
  }

  const selected = [...byHash.values()]
    .sort((a, b) => b.relevance.score - a.relevance.score)
    .slice(0, 60)
    .map(candidate => buildOutputPage(candidate.page, candidate.relevance));

  const output = {
    schemaVersion: 1,
    source: 'LEMON_MANUALS',
    evidencePolicy: {
      sourceEvidenceImmutable: true,
      derivedIndexRebuildable: true,
      note: 'Manufacturer text is preserved in sourceEvidence. SKSK normalization and ranking live only in derivedIndex.'
    },
    vehicle,
    query: {
      scope,
      symptoms: context.symptoms,
      mechanicNotices: context.mechanicNotices,
      dtcs: context.obdCodes,
      canonicalProfile: queryProfile,
      canonicalSearchTerms: terms
    },
    resolvedUrl: baseUrl,
    pathResolution: resolution.method,
    crawledPages: visited.size,
    selectedPages: selected.length,
    pages: selected,
    scrapedAt: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Selected ${selected.length} relevant page(s) from ${visited.size} crawled page(s)`);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
