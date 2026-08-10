const LEMON_HOSTS = ['lemon-manuals.la', 'lemon-manuals.org.ua', 'lemon-manuals.gy'];
const resolutionCache = new Map();

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(value) {
  return clean(value)
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = re.exec(String(html || '')))) {
    const href = decodeHtml(match[1]).trim();
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    try {
      const url = new URL(href, baseUrl);
      if (!LEMON_HOSTS.includes(url.hostname.toLowerCase())) continue;
      links.push({ url: url.toString(), text: stripTags(match[2]) });
    } catch (_) {}
  }

  return links;
}

function vehicleDetailTokens(vehicle) {
  const text = normalize([
    vehicle.trim,
    vehicle.engine,
    vehicle.drivetrain,
    vehicle.driveType,
    vehicle.transmission
  ].filter(Boolean).join(' '));

  const tokens = new Set(text.split(' ').filter(token => token.length >= 2));
  const displacement = text.match(/\b(\d(?:\.\d)?)\s*l\b/);
  if (displacement) tokens.add(displacement[1]);

  if (/\b(?:6cyl|6 cyl|v6)\b/.test(text)) tokens.add('v6');
  if (/\b(?:8cyl|8 cyl|v8)\b/.test(text)) tokens.add('v8');
  if (/\b(?:4cyl|4 cyl|i4|l4)\b/.test(text)) tokens.add('4cyl');

  return [...tokens];
}

function scoreVariant(link, vehicle) {
  let decodedPath = '';
  try { decodedPath = decodeURIComponent(new URL(link.url).pathname); } catch (_) {}
  const label = normalize(`${link.text} ${decodedPath}`);
  const model = normalize(vehicle.model);
  if (!model || !label.includes(model)) return -Infinity;

  let score = 100;
  for (const token of vehicleDetailTokens(vehicle)) {
    if (label.includes(token)) score += token.length >= 4 ? 8 : 5;
  }

  const requestedDrive = normalize(`${vehicle.drivetrain || ''} ${vehicle.driveType || ''}`).match(/\b(4wd|awd|fwd|rwd|2wd)\b/)?.[1];
  const candidateDrive = label.match(/\b(4wd|awd|fwd|rwd|2wd)\b/)?.[1];
  if (requestedDrive && candidateDrive) score += requestedDrive === candidateDrive ? 30 : -40;

  if (/repair and diagnosis/i.test(decodedPath)) score += 5;
  if (/single page/i.test(decodedPath)) score -= 2;
  return score;
}

function toRepairDiagnosisUrl(variantUrl) {
  const url = new URL(variantUrl);
  const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
  const repairIndex = parts.findIndex(part => /^repair and diagnosis(?: \(single page\))?$/i.test(part));
  const vehicleParts = repairIndex >= 0 ? parts.slice(0, repairIndex) : parts;
  url.pathname = `/${vehicleParts.map(part => encodeURIComponent(part)).join('/')}/Repair%20and%20Diagnosis/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function cacheKey(vehicle) {
  return normalize([
    vehicle.make,
    vehicle.year,
    vehicle.model,
    vehicle.trim,
    vehicle.engine,
    vehicle.drivetrain || vehicle.driveType
  ].filter(Boolean).join('|'));
}

async function tryFetch(fetchHtml, url) {
  try {
    return { ok: true, html: await fetchHtml(url) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function resolveRepairDiagnosisUrl(vehicle, { fetchHtml, refresh = false } = {}) {
  if (!vehicle?.make || !vehicle?.year || !vehicle?.model) {
    return { url: null, error: 'Vehicle make, year, and model are required' };
  }
  if (typeof fetchHtml !== 'function') {
    return { url: null, error: 'LEMON resolver requires fetchHtml' };
  }

  const key = cacheKey(vehicle);
  if (!refresh && resolutionCache.has(key)) return { ...resolutionCache.get(key), fromResolverCache: true };

  const makeCandidates = unique([clean(vehicle.make), titleCase(vehicle.make)]);
  const hostCandidates = unique([
    process.env.LEMON_HOST && String(process.env.LEMON_HOST).replace(/^https?:\/\//, '').replace(/\/$/, ''),
    ...LEMON_HOSTS
  ]);

  const attempts = [];

  // First try the old simple path. It is cheap and still works for vehicles whose
  // LEMON folder is exactly the model name.
  for (const host of hostCandidates) {
    for (const make of makeCandidates) {
      const simpleUrl = `https://${host}/${encodeURIComponent(make)}/${encodeURIComponent(String(vehicle.year))}/${encodeURIComponent(clean(vehicle.model))}/Repair%20and%20Diagnosis/`;
      const simple = await tryFetch(fetchHtml, simpleUrl);
      attempts.push({ url: simpleUrl, ok: simple.ok });
      if (simple.ok) {
        const result = { url: simpleUrl, resolvedBy: 'direct-model-path', attempts };
        resolutionCache.set(key, result);
        return result;
      }
    }
  }

  // LEMON commonly stores year/model variants as folders such as
  // "Sorento 4WD V6-3.8L". Discover the year index and rank matching variants
  // using model + engine/trim/drivetrain tokens rather than guessing the folder.
  for (const host of hostCandidates) {
    for (const make of makeCandidates) {
      const yearUrl = `https://${host}/${encodeURIComponent(make)}/${encodeURIComponent(String(vehicle.year))}/`;
      const yearPage = await tryFetch(fetchHtml, yearUrl);
      attempts.push({ url: yearUrl, ok: yearPage.ok });
      if (!yearPage.ok) continue;

      const candidates = extractLinks(yearPage.html, yearUrl)
        .map(link => ({ ...link, score: scoreVariant(link, vehicle) }))
        .filter(link => Number.isFinite(link.score))
        .sort((a, b) => b.score - a.score);

      for (const candidate of candidates.slice(0, 8)) {
        const repairUrl = toRepairDiagnosisUrl(candidate.url);
        const probe = await tryFetch(fetchHtml, repairUrl);
        attempts.push({ url: repairUrl, ok: probe.ok, score: candidate.score });
        if (probe.ok) {
          const result = {
            url: repairUrl,
            resolvedBy: 'year-index-variant-match',
            variantLabel: candidate.text,
            variantScore: candidate.score,
            attempts
          };
          resolutionCache.set(key, result);
          return result;
        }
      }
    }
  }

  return { url: null, error: 'Unable to resolve LEMON vehicle variant path', attempts };
}

module.exports = { resolveRepairDiagnosisUrl, scoreVariant, toRepairDiagnosisUrl };
