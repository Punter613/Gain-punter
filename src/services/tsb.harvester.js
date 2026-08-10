const { supabase, buildVehicleCacheKey } = require('../db');

const LEMON_HOSTS = new Set(['lemon-manuals.la', 'lemon-manuals.org.ua', 'lemon-manuals.gy']);

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/');
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

function normalize(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function fetchHtml(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; SKSK-ProTech/1.3; tsb-corpus-ingestion)'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractPage(html, url) {
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || 'Technical Service Bulletin');
  const headings = [];
  const headingRegex = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let hm;
  while ((hm = headingRegex.exec(html))) {
    const value = stripTags(hm[1]);
    if (value) headings.push(value);
  }

  const links = [];
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let lm;
  while ((lm = linkRegex.exec(html))) {
    const href = decodeHtml(lm[1]).trim();
    const text = stripTags(lm[2]);
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    try {
      const absolute = new URL(href, url).toString();
      if (!LEMON_HOSTS.has(new URL(absolute).hostname.toLowerCase())) continue;
      links.push({ url: absolute, text });
    } catch (_) {}
  }

  return { title, headings, bodyText: stripTags(html), links };
}

function buildRepairDiagnosisUrl(vehicle) {
  const make = encodeURIComponent(String(vehicle.make).trim());
  const year = encodeURIComponent(String(vehicle.year).trim());
  const model = encodeURIComponent(String(vehicle.model).trim());
  return `https://lemon-manuals.la/${make}/${year}/${model}/Repair%20and%20Diagnosis/`;
}

function isTsbSectionLink(link) {
  const haystack = normalize(`${link.text} ${link.url}`);
  return haystack.includes('technical service bulletins') || haystack.includes('technical service bulletin');
}

function isWithinTsbBranch(url, rootUrl) {
  const root = decodeURIComponent(rootUrl).replace(/\/$/, '').toLowerCase();
  const candidate = decodeURIComponent(url).toLowerCase();
  return candidate.startsWith(root);
}

function looksLikeBulletinPage(page) {
  const text = `${page.title} ${(page.headings || []).join(' ')} ${page.bodyText}`;
  return /\b(number|subject|model|group|date)\b/i.test(text) &&
    (/technical service bulletin/i.test(text) || /\bnumber\s*[:#]?\s*[A-Z]{1,6}\d{4,}/i.test(text) || /\bgroup\s*[:#]?/i.test(text));
}

function parseField(bodyText, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\s*[:#]?\\s*([^\\n]{1,180})`, 'i');
  const match = bodyText.match(re);
  return clean(match?.[1] || '');
}

function extractBulletinMetadata(page) {
  const body = page.bodyText || '';
  const numberMatch = body.match(/\b(?:Number|Bulletin(?:\s+No\.?|\s+Number)?)\s*[:#]?\s*([A-Z]{1,8}[A-Z0-9-]{5,})/i);
  const dateMatch = body.match(/\bDate\s*[:#]?\s*([^\n]{3,80})/i);
  const subjectMatch = body.match(/\bSubject\s*[:#]?\s*([^\n]{3,300})/i);
  const groupMatch = body.match(/\bGroup\s*[:#]?\s*([^\n]{2,160})/i);

  return {
    bulletinNumber: clean(numberMatch?.[1] || ''),
    bulletinDate: clean(dateMatch?.[1] || ''),
    subject: clean(subjectMatch?.[1] || page.headings?.find(h => !/technical service bulletins?/i.test(h)) || page.title),
    groupName: clean(groupMatch?.[1] || '')
  };
}

function extractFacts(page) {
  const text = clean(page.bodyText || '');
  const sentences = text.split(/(?<=[.!?])\s+/).map(clean).filter(Boolean);
  const collect = (patterns, max = 12) => {
    const out = [];
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      if (patterns.some(p => p.test(lower)) && !out.includes(sentence)) out.push(sentence.slice(0, 1200));
      if (out.length >= max) break;
    }
    return out;
  };

  return {
    procedures: collect([/inspect/, /remove/, /install/, /replace/, /verify/, /measure/, /check/]),
    torqueSpecs: collect([/\btorque\b/, /ft\.?[- ]?lb/, /n[· ]?m\b/, /tighten/]),
    symptoms: collect([/noise/, /clunk/, /chatter/, /vibration/, /bump/, /buck/, /misfire/, /warning lamp/]),
    conditions: collect([/deceler/, /acceler/, /full lock/, /reverse/, /drive/, /idle/, /cold/, /hot/, /brak/]),
    components: collect([/driveshaft/, /propeller shaft/, /transfer case/, /differential/, /steering/, /suspension/, /engine/, /transmission/, /brake/, /tire/])
  };
}

function scoreBulletin(bulletin, context = {}) {
  const symptomText = normalize([
    context.symptoms,
    ...(Array.isArray(context.mechanicNotices) ? context.mechanicNotices : []),
    ...(Array.isArray(context.keywords) ? context.keywords : [])
  ].filter(Boolean).join(' '));
  const tokens = symptomText.split(' ').filter(t => t.length >= 4);
  const haystack = normalize(`${bulletin.title} ${bulletin.subject} ${bulletin.groupName} ${bulletin.bodyText}`);
  let score = 0;
  const matched = [];

  for (const token of [...new Set(tokens)]) {
    if (haystack.includes(token)) {
      score += 4;
      matched.push(token);
    }
  }

  const boosts = [
    [/clunk|noise|chatter|vibration/, 8, 'noise-family'],
    [/deceler|throttle release|load transfer|reverse|drive/, 8, 'load-change'],
    [/steering|full lock|rack|tie rod/, 6, 'steering'],
    [/driveshaft|propeller shaft|transfer case|differential|driveline/, 8, 'driveline'],
    [/brake|braking/, 4, 'braking']
  ];
  for (const [pattern, points, label] of boosts) {
    if (pattern.test(symptomText) && pattern.test(haystack)) {
      score += points;
      matched.push(label);
    }
  }

  return { score, matchedKeywords: [...new Set(matched)] };
}

async function loadStoredTsbCorpus(vehicle) {
  if (!supabase) return [];
  const vehicleKey = buildVehicleCacheKey(vehicle);
  try {
    const { data, error } = await supabase
      .from('vehicle_tsb_corpus')
      .select('*')
      .eq('vehicle_key', vehicleKey)
      .order('scraped_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn('[TSB Corpus] load failed (non-fatal):', err.message);
    return [];
  }
}

async function persistTsbCorpus(vehicle, bulletins) {
  if (!supabase || !bulletins.length) return;
  const vehicleKey = buildVehicleCacheKey(vehicle);
  const rows = bulletins.map(b => ({
    vehicle_key: vehicleKey,
    year: Number(vehicle.year) || null,
    make: vehicle.make || null,
    model: vehicle.model || null,
    trim: vehicle.trim || null,
    engine: vehicle.engine || null,
    title: b.title,
    source_url: b.url,
    bulletin_number: b.bulletinNumber || null,
    bulletin_date: b.bulletinDate || null,
    group_name: b.groupName || null,
    subject: b.subject || null,
    body_text: b.bodyText || null,
    headings: b.headings || [],
    extracted_facts: b.extractedFacts || {},
    source: 'LEMON_MANUALS',
    scraped_at: new Date().toISOString()
  }));

  try {
    const { error } = await supabase
      .from('vehicle_tsb_corpus')
      .upsert(rows, { onConflict: 'vehicle_key,source_url' });
    if (error) throw error;
  } catch (err) {
    console.warn('[TSB Corpus] persist failed (non-fatal):', err.message);
  }
}

async function harvestVehicleTsbs(vehicle, context = {}, options = {}) {
  if (!vehicle?.year || !vehicle?.make || !vehicle?.model) {
    return { bulletins: [], error: 'Vehicle year, make, and model are required' };
  }

  const refresh = options.refresh === true;
  const stored = refresh ? [] : await loadStoredTsbCorpus(vehicle);
  if (stored.length) {
    const ranked = stored.map(row => {
      const bulletin = {
        title: row.title,
        url: row.source_url,
        bulletinNumber: row.bulletin_number || '',
        bulletinDate: row.bulletin_date || '',
        groupName: row.group_name || '',
        subject: row.subject || row.title,
        bodyText: row.body_text || '',
        headings: row.headings || [],
        extractedFacts: row.extracted_facts || {},
        source: row.source || 'LEMON_MANUALS'
      };
      return { ...bulletin, ...scoreBulletin(bulletin, context) };
    }).sort((a, b) => b.score - a.score);
    return { bulletins: ranked, fromStore: true, harvested: false, total: ranked.length };
  }

  const repairUrl = buildRepairDiagnosisUrl(vehicle);
  let rootPage;
  try {
    rootPage = extractPage(await fetchHtml(repairUrl), repairUrl);
  } catch (err) {
    return { bulletins: [], error: `Repair/Diagnosis index fetch failed: ${err.message}` };
  }

  const sectionLink = rootPage.links.find(isTsbSectionLink);
  if (!sectionLink) {
    return { bulletins: [], error: 'Technical Service Bulletins section not found for vehicle path' };
  }

  const tsbRootUrl = sectionLink.url;
  const queue = [tsbRootUrl];
  const queued = new Set(queue);
  const visited = new Set();
  const pages = [];
  const maxPages = Math.max(50, Number(options.maxPages || process.env.LEMON_TSB_MAX_PAGES || 350));

  while (queue.length && visited.size < maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      const page = extractPage(await fetchHtml(url), url);
      pages.push({ ...page, url });
      for (const link of page.links) {
        if (!isWithinTsbBranch(link.url, tsbRootUrl)) continue;
        if (!visited.has(link.url) && !queued.has(link.url)) {
          queued.add(link.url);
          queue.push(link.url);
        }
      }
    } catch (err) {
      console.warn(`[TSB Corpus] fetch failed for ${url}: ${err.message}`);
    }
  }

  const bulletins = pages
    .filter(page => page.url !== tsbRootUrl && looksLikeBulletinPage(page))
    .map(page => {
      const meta = extractBulletinMetadata(page);
      const bulletin = {
        title: page.title,
        url: page.url,
        headings: page.headings,
        bodyText: page.bodyText,
        extractedFacts: extractFacts(page),
        source: 'LEMON_MANUALS',
        ...meta
      };
      return { ...bulletin, ...scoreBulletin(bulletin, context) };
    })
    .sort((a, b) => b.score - a.score);

  await persistTsbCorpus(vehicle, bulletins);
  return {
    bulletins,
    fromStore: false,
    harvested: true,
    total: bulletins.length,
    crawledUrls: visited.size,
    tsbRootUrl,
    truncated: queue.length > 0
  };
}

module.exports = { harvestVehicleTsbs, scoreBulletin, loadStoredTsbCorpus };
