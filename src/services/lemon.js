const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getCachedManual, saveScrapedManual } = require('../db');

const LEMON_HOSTS = new Set([
  'lemon-manuals.la',
  'lemon-manuals.org.ua',
  'lemon-manuals.gy'
]);

const DEFAULT_KEYWORDS = [
  'repair', 'diagnosis', 'diagnostic', 'inspection', 'procedure',
  'removal', 'installation', 'service', 'specification', 'torque',
  'ball joint', 'control arm', 'bushing', 'stabilizer', 'sway bar',
  'steering', 'rack', 'tie rod', 'intermediate shaft', 'cv axle',
  'constant velocity', 'driveshaft', 'propeller shaft', 'suspension',
  'noise', 'clunk', 'vibration', 'wheel alignment', 'wheel bearing',
  'fastener', 'special tool', 'lubrication', 'clearance'
];

function clean(value) {
  return String(value || '').replace(/\\n/g, ' ').replace(/\\s+/g, ' ').trim();
}

function normalizeToken(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function scrapeLEMONManuals(vehicle, context = {}) {
  if (!vehicle || !vehicle.make || !vehicle.year || !vehicle.model) {
    return { items: [], error: 'Insufficient vehicle data for scraping' };
  }

  const cached = await getCachedManual(vehicle);
  if (cached && cached.data) {
    console.log(`[Scraper] Cache HIT for ${vehicle.year} ${vehicle.make} ${vehicle.model} - using stored manual evidence`);
    return { ...cached.data, fromCache: true, cachedAt: cached.scraped_at };
  }

  console.log(`[Scraper] Cache MISS for ${vehicle.year} ${vehicle.make} ${vehicle.model} - targeted Lemon Manuals scrape`);
  const freshResult = await scrapeLive(vehicle, context);

  if (freshResult && !freshResult.error && freshResult.items?.length > 0) {
    await saveScrapedManual(vehicle, freshResult);
  }

  return { ...freshResult, fromCache: false };
}

function buildBaseUrl(vehicle) {
  const make = encodeURIComponent(String(vehicle.make).trim());
  const year = encodeURIComponent(String(vehicle.year).trim());
  const model = encodeURIComponent(String(vehicle.model).trim());
  // Lemon's public index is model-first. Do not append an engine slug unless
  // the caller provides a known manual URL; engine text from VIN decoding is
  // often a trim description and can create a dead URL.
  return `https://lemon-manuals.la/${make}/${year}/${model}/Repair%20and%20Diagnosis/`;
}

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
    .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
    .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
    .replace(/<noscript[\\s\\S]*?<\\/noscript>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\\s+/g, ' ')
    .trim();
}

function extractPage(html, url) {
  const titleMatch = html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i);
  const title = stripTags(titleMatch?.[1] || 'Factory Service Reference');
  const headings = [];
  const headingRegex = /<h[1-6]\\b[^>]*>([\\s\\S]*?)<\\/h[1-6]>/gi;
  let headingMatch;
  while ((headingMatch = headingRegex.exec(html))) {
    const text = stripTags(headingMatch[1]);
    if (text) headings.push(text);
  }

  const links = [];
  const linkRegex = /<a\\b[^>]*href=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html))) {
    const href = decodeHtml(match[1]).trim();
    const text = stripTags(match[2]);
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    try {
      const absolute = new URL(href, url).toString();
      if (!/^https?:\\/\\//i.test(absolute)) continue;
      const host = new URL(absolute).hostname.toLowerCase();
      if (!LEMON_HOSTS.has(host)) continue;
      if (/\\.(pdf|jpg|jpeg|png|gif|zip)(\\?|$)/i.test(absolute)) continue;
      links.push({ url: absolute, text });
    } catch (_) {}
  }

  const bodyText = stripTags(html);
  return { title, headings, bodyText, links };
}

function buildSearchTerms(vehicle, context = {}) {
  const symptomText = [
    context.symptoms,
    ...(Array.isArray(context.mechanicNotices) ? context.mechanicNotices : []),
    ...(Array.isArray(context.obdCodes) ? context.obdCodes : [])
  ].filter(Boolean).join(' ');

  const symptomTerms = normalizeToken(symptomText)
    .split(' ')
    .filter(token => token.length >= 4);

  const terms = new Set(DEFAULT_KEYWORDS);
  const normalized = normalizeToken(symptomText);
  for (const keyword of DEFAULT_KEYWORDS) {
    if (normalized.includes(normalizeToken(keyword))) terms.add(keyword);
  }

  // Keep vehicle identifiers available for scoring, but never let them alone
  // make a page highly relevant.
  terms.add(normalizeToken(vehicle.make));
  terms.add(normalizeToken(vehicle.model));
  for (const token of symptomTerms.slice(0, 30)) terms.add(token);
  return [...terms].filter(Boolean);
}

function scorePage(page, terms) {
  const title = normalizeToken(page.title);
  const headings = normalizeToken((page.headings || []).join(' '));
  const url = normalizeToken(page.url);
  const body = normalizeToken(page.bodyText || '').slice(0, 12000);
  let score = 0;
  const matched = [];

  for (const term of terms) {
    const t = normalizeToken(term);
    if (!t || t.length < 3) continue;
    if (title.includes(t)) { score += 10; matched.push(term); }
    if (headings.includes(t)) { score += 7; matched.push(term); }
    if (url.includes(t)) { score += 6; matched.push(term); }
    if (body.includes(t)) { score += 2; matched.push(term); }
  }

  const evidenceBoosts = [
    [/torque|tighten|fastener/, 8, 'torque/fastener'],
    [/remove|removal|install|installation/, 6, 'remove/install'],
    [/inspect|inspection|check for wear|check for damage/, 6, 'inspection'],
    [/special tool|special service tool|sst/, 5, 'special-tool'],
    [/alignment|wheel alignment/, 5, 'alignment'],
    [/tsb|technical service bulletin|service bulletin/, 12, 'tsb'],
    [/ball joint|control arm|bushing|stabilizer|sway bar|cv axle|constant velocity|driveshaft|steering/, 9, 'target-component']
  ];

  const text = `${title} ${headings} ${body}`;
  for (const [pattern, boost, label] of evidenceBoosts) {
    if (pattern.test(text)) { score += boost; matched.push(label); }
  }

  return {
    score,
    matchedKeywords: [...new Set(matched)].slice(0, 30)
  };
}

function extractFacts(page) {
  const text = clean(page.bodyText || '');
  const facts = {
    componentType: [],
    torqueSpecs: [],
    procedures: [],
    inspections: [],
    specialTools: [],
    alignment: [],
    bulletins: [],
    construction: []
  };

  const sentences = text.split(/(?<=[.!?])\\s+/).map(clean).filter(Boolean);
  const collect = (key, patterns, max = 8) => {
    for (const sentence of sentences) {
      const normalized = sentence.toLowerCase();
      if (patterns.some(pattern => pattern.test(normalized)) && !facts[key].includes(sentence)) {
        facts[key].push(sentence.slice(0, 700));
        if (facts[key].length >= max) break;
      }
    }
  };

  collect('torqueSpecs', [/\\btorque\\b/, /ft[. ]?lb/, /n[· ]?m\\b/, /tighten/]);
  collect('procedures', [/remove/, /install/, /replacement/, /procedure/]);
  collect('inspections', [/inspect/, /inspection/, /check for wear/, /check for damage/, /free play/, /clearance/]);
  collect('specialTools', [/special tool/, /special service tool/, /sst\\b/]);
  collect('alignment', [/alignment/, /wheel align/]);
  collect('bulletins', [/\\btsb\\b/, /technical service bulletin/, /service bulletin/]);
  collect('construction', [/bolt[- ]?in/, /press[- ]?in/, /integral/, /assembled with/, /riveted/]);
  collect('componentType', [/ball joint/, /control arm/, /bushing/, /stabilizer link/, /cv axle/, /constant velocity/, /driveshaft/, /steering rack/]);

  return facts;
}

async function fetchHtml(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; SKSK-ProTech/1.1; technical-reference-ingestion)'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeNative(baseUrl, vehicle, context = {}) {
  const terms = buildSearchTerms(vehicle, context);
  const queue = [{ url: baseUrl, depth: 0, priority: 100 }];
  const queued = new Set([baseUrl]);
  const visited = new Set();
  const pages = [];
  const maxPages = 80;
  const maxDepth = 3;

  while (queue.length && visited.size < maxPages) {
    queue.sort((a, b) => b.priority - a.priority);
    const { url, depth } = queue.shift();
    if (visited.has(url) || depth > maxDepth) continue;
    visited.add(url);

    try {
      const html = await fetchHtml(url);
      const page = extractPage(html, url);
      const relevance = scorePage(page, terms);
      pages.push({ ...page, depth, ...relevance });

      for (const link of page.links) {
        if (visited.has(link.url) || queued.has(link.url) || depth + 1 > maxDepth) continue;
        const linkScore = scorePage({
          title: link.text,
          headings: [],
          url: link.url,
          bodyText: link.text
        }, terms).score;
        queued.add(link.url);
        queue.push({ url: link.url, depth: depth + 1, priority: linkScore });
      }
    } catch (error) {
      console.warn(`[Scraper] Lemon fetch failed for ${url}: ${error.message}`);
    }
  }

  const ranked = pages
    .filter(page => page.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  const items = ranked.map(page => ({
    title: page.title,
    url: page.url,
    price: null,
    meta: {
      scraper: 'node-targeted',
      depth: String(page.depth),
      relevanceScore: String(page.score),
      matchedKeywords: page.matchedKeywords.join(', '),
      headings: page.headings.slice(0, 12).join(' | '),
      snippet: page.bodyText.slice(0, 1800),
      facts: JSON.stringify(extractFacts(page))
    }
  }));

  return {
    schemaVersion: 2,
    source: 'LEMON_MANUALS',
    vehicle: {
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      trim: vehicle.trim || '',
      engine: vehicle.engine || '',
      vin: vehicle.vin || ''
    },
    query: {
      keywords: terms,
      symptomText: clean([context.symptoms, ...(context.mechanicNotices || [])].filter(Boolean).join(' '))
    },
    items,
    crawled_urls: visited.size,
    relevant_pages: ranked.length,
    scraped: true,
    scraped_at: new Date().toISOString()
  };
}

async function scrapeLive(vehicle, context = {}) {
  const baseUrl = buildBaseUrl(vehicle);
  const scraperPath = process.env.LEMON_PATH || path.join(process.cwd(), 'tools', 'lemon_scraper', 'target', 'release', 'lemon_scraper');

  // The native scraper is intentionally the authoritative path for targeted
  // evidence because the deployed Rust binary historically only returned page
  // titles/URLs and did not preserve the manual text needed by diagnosis.
  if (process.env.LEMON_USE_RUST === 'true' && fs.existsSync(scraperPath)) {
    return new Promise((resolve) => {
      exec(`"${scraperPath}" "${baseUrl}"`, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (!error) {
          try {
            const parsed = JSON.parse(stdout);
            if (parsed?.items?.length) return resolve({
              schemaVersion: 2,
              source: 'LEMON_MANUALS',
              items: parsed.items,
              crawled_urls: parsed.crawled_urls || parsed.items.length,
              scraped: true,
              scraped_at: new Date().toISOString()
            });
          } catch (_) {}
        }
        scrapeNative(baseUrl, vehicle, context)
          .then(resolve)
          .catch(nativeError => resolve({ items: [], error: nativeError.message }));
      });
    });
  }

  try {
    return await scrapeNative(baseUrl, vehicle, context);
  } catch (error) {
    return { items: [], error: error.message };
  }
}

module.exports = { scrapeLEMONManuals };
