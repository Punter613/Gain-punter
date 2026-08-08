const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getCachedManual, saveScrapedManual } = require('../db');

async function scrapeLEMONManuals(vehicle) {
  if (!vehicle || !vehicle.make || !vehicle.year || !vehicle.model) {
    return { items: [], error: 'Insufficient vehicle data for scraping' };
  }

  const cached = await getCachedManual(vehicle);
  if (cached && cached.data) {
    console.log(`[Scraper] Cache HIT for ${vehicle.year} ${vehicle.make} ${vehicle.model} - skipping live scrape`);
    return { ...cached.data, fromCache: true, cachedAt: cached.scraped_at };
  }

  console.log(`[Scraper] Cache MISS for ${vehicle.year} ${vehicle.make} ${vehicle.model} - scraping live`);
  const freshResult = await scrapeLive(vehicle);

  if (freshResult && !freshResult.error && freshResult.items?.length > 0) {
    await saveScrapedManual(vehicle, freshResult);
  }

  return { ...freshResult, fromCache: false };
}

function buildBaseUrl(vehicle) {
  const make = encodeURIComponent(vehicle.make);
  const year = encodeURIComponent(vehicle.year);
  const model = encodeURIComponent(vehicle.model);
  const engine = vehicle.engine ? encodeURIComponent(String(vehicle.engine).replace(/\s+/g, '-')) : '';
  return `https://lemon-manuals.la/${make}/${year}/${model}${engine ? '-' + engine : ''}/Repair%20and%20Diagnosis/`;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(value) {
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractPage(html, url) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripTags(titleMatch?.[1] || 'Factory Service Reference');
  const links = [];
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html))) {
    const href = decodeHtml(match[1]).trim();
    const text = stripTags(match[2]);
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    try {
      const absolute = new URL(href, url).toString();
      if (!/^https?:\/\//i.test(absolute)) continue;
      const host = new URL(absolute).hostname.toLowerCase();
      if (!['lemon-manuals.la', 'lemon-manuals.org.ua', 'lemon-manuals.gy'].includes(host)) continue;
      if (/\.(pdf|jpg|jpeg|png|gif|zip)(\?|$)/i.test(absolute)) continue;
      links.push({ url: absolute, text });
    } catch (_) {}
  }

  return { title, links };
}

async function fetchHtml(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; SKSK-ProTech/1.0; +https://skskprotech.com)'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeNative(baseUrl) {
  const queue = [{ url: baseUrl, depth: 0 }];
  const visited = new Set();
  const items = [];
  const maxPages = 12;
  const maxDepth = 2;

  while (queue.length && visited.size < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url) || depth > maxDepth) continue;
    visited.add(url);

    try {
      const html = await fetchHtml(url);
      const page = extractPage(html, url);
      items.push({
        title: page.title,
        url,
        price: null,
        meta: {
          snippet: page.links.slice(0, 5).map(link => link.text).filter(Boolean).join(' | '),
          scraper: 'node-native'
        }
      });

      for (const link of page.links) {
        if (depth + 1 <= maxDepth && !visited.has(link.url)) {
          queue.push({ url: link.url, depth: depth + 1 });
        }
      }
    } catch (error) {
      console.warn(`[Scraper] Native fetch failed for ${url}: ${error.message}`);
    }
  }

  const unique = [];
  const seen = new Set();
  for (const item of items) {
    const key = `${item.url}|${item.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  return { items: unique, crawled_urls: visited.size };
}

async function scrapeLive(vehicle) {
  const baseUrl = buildBaseUrl(vehicle);
  const scraperPath = process.env.LEMON_PATH || path.join(process.cwd(), 'tools', 'lemon_scraper', 'target', 'release', 'lemon_scraper');

  if (fs.existsSync(scraperPath)) {
    return new Promise((resolve) => {
      exec(`"${scraperPath}" "${baseUrl}"`, { timeout: 20000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (!error) {
          try {
            return resolve(JSON.parse(stdout));
          } catch (_) {
            console.warn('[Scraper] Rust scraper returned non-JSON output; using native fallback.');
          }
        } else {
          console.warn(`[Scraper] Rust scraper failed: ${error.message}; using native fallback.`);
        }
        scrapeNative(baseUrl)
          .then(resolve)
          .catch(nativeError => resolve({ items: [], error: nativeError.message }));
      });
    });
  }

  console.warn(`[Scraper] No Rust binary at ${scraperPath}; using Node-native scraper.`);
  try {
    return await scrapeNative(baseUrl);
  } catch (error) {
    return { items: [], error: error.message };
  }
}

module.exports = { scrapeLEMONManuals };
