const LEMON_HOSTS = new Set(['lemon-manuals.la', 'lemon-manuals.org.ua', 'lemon-manuals.gy']);
const resolutionCache = new Map();

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleCase(value) {
  return clean(value)
    .toLowerCase()
    .replace(/(^|\s|-)([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

function getVehicleSignals(vehicle = {}) {
  const source = [
    vehicle.model,
    vehicle.trim,
    vehicle.engine,
    vehicle.drivetrain,
    vehicle.driveType,
    vehicle.drive,
    vehicle.bodyClass
  ].filter(Boolean).join(' ');

  const normalized = normalize(source);
  const displacement = String(source).match(/\b(\d(?:\.\d)?)\s*l\b/i)?.[1] || '';
  const cylinderMatch = String(source).match(/\b(?:v\s*)?(4|6|8|10|12)\s*(?:cyl(?:inder)?s?)?\b/i);
  const cylinders = cylinderMatch?.[1] || '';
  const drivetrain = /\b4wd\b|\b4x4\b|four wheel drive/i.test(source) ? '4wd'
    : /\bawd\b|all wheel drive/i.test(source) ? 'awd'
      : /\bfwd\b|front wheel drive/i.test(source) ? 'fwd'
        : /\brwd\b|rear wheel drive/i.test(source) ? 'rwd'
          : '';

  return {
    model: normalize(vehicle.model),
    displacement,
    cylinders,
    drivetrain,
    raw: normalized
  };
}

function scoreVehicleFolderCandidate(candidate, vehicle) {
  const signals = getVehicleSignals(vehicle);
  const text = normalize(`${candidate.text || ''} ${candidate.url || ''}`);
  if (!signals.model || !text.includes(signals.model)) return -1000;

  let score = 100;
  const modelTokens = signals.model.split(' ').filter(Boolean);
  for (const token of modelTokens) if (text.includes(token)) score += 20;

  if (signals.displacement) {
    const displacementPattern = new RegExp(`\\b${signals.displacement.replace('.', '[ .]?')}\\s*l?\\b`, 'i');
    if (displacementPattern.test(`${candidate.text || ''} ${decodeURIComponentSafe(candidate.url || '')}`)) score += 45;
    else score -= 15;
  }

  if (signals.cylinders) {
    const raw = `${candidate.text || ''} ${decodeURIComponentSafe(candidate.url || '')}`;
    if (new RegExp(`\\bv?${signals.cylinders}\\b`, 'i').test(raw)) score += 30;
  }

  if (signals.drivetrain) {
    const aliases = signals.drivetrain === '4wd' ? /\b4wd\b|\b4x4\b|four wheel drive/i
      : signals.drivetrain === 'awd' ? /\bawd\b|all wheel drive/i
        : signals.drivetrain === 'fwd' ? /\bfwd\b|front wheel drive/i
          : /\brwd\b|rear wheel drive/i;
    if (aliases.test(`${candidate.text || ''} ${decodeURIComponentSafe(candidate.url || '')}`)) score += 35;
    else score -= 10;
  }

  return score;
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); }
  catch (_) { return String(value || ''); }
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(String(html || '')))) {
    const href = String(match[1] || '').replace(/&amp;/g, '&').trim();
    const text = clean(String(match[2] || '').replace(/<[^>]+>/g, ' '));
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    try {
      const absolute = new URL(href, baseUrl).toString();
      if (!LEMON_HOSTS.has(new URL(absolute).hostname.toLowerCase())) continue;
      links.push({ url: absolute, text });
    } catch (_) {}
  }
  return links;
}

async function fetchHtml(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; SKSK-ProTech/1.4; lemon-path-resolver)'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function ensureRepairDiagnosisUrl(url) {
  const decoded = decodeURIComponentSafe(url).replace(/\/$/, '');
  if (/\/repair and diagnosis$/i.test(decoded)) return `${url.replace(/\/$/, '')}/`;
  return `${url.replace(/\/$/, '')}/Repair%20and%20Diagnosis/`;
}

function buildDirectCandidates(vehicle) {
  const make = titleCase(vehicle.make);
  const year = clean(vehicle.year);
  const model = clean(vehicle.model);
  const signals = getVehicleSignals(vehicle);
  const labels = new Set([model]);

  if (signals.cylinders && signals.displacement) {
    labels.add(`${model} V${signals.cylinders}-${signals.displacement}L`);
    if (signals.drivetrain) labels.add(`${model} ${signals.drivetrain.toUpperCase()} V${signals.cylinders}-${signals.displacement}L`);
  }

  if (vehicle.trim) labels.add(`${model} ${clean(vehicle.trim)}`);

  return [...labels].map(label => ({
    label,
    url: `https://lemon-manuals.la/${encodeURIComponent(make)}/${encodeURIComponent(year)}/${encodeURIComponent(label)}/Repair%20and%20Diagnosis/`
  }));
}

async function probeRepairUrl(url) {
  try {
    await fetchHtml(url, 7000);
    return true;
  } catch (_) {
    return false;
  }
}

async function resolveLemonVehiclePathUncached(vehicle = {}) {
  if (!vehicle.make || !vehicle.year || !vehicle.model) {
    throw new Error('Vehicle make, year, and model are required for LEMON path resolution');
  }

  for (const candidate of buildDirectCandidates(vehicle)) {
    if (await probeRepairUrl(candidate.url)) {
      return { url: candidate.url, method: 'direct-candidate', candidate: candidate.label };
    }
  }

  const make = titleCase(vehicle.make);
  const year = clean(vehicle.year);
  const yearUrl = `https://lemon-manuals.la/${encodeURIComponent(make)}/${encodeURIComponent(year)}/`;
  const html = await fetchHtml(yearUrl);
  const yearRoot = decodeURIComponentSafe(yearUrl).toLowerCase();
  const ranked = extractLinks(html, yearUrl)
    .filter(link => decodeURIComponentSafe(link.url).toLowerCase().startsWith(yearRoot))
    .map(link => ({ ...link, score: scoreVehicleFolderCandidate(link, vehicle) }))
    .filter(link => link.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const candidate of ranked.slice(0, 12)) {
    const repairUrl = ensureRepairDiagnosisUrl(candidate.url);
    if (await probeRepairUrl(repairUrl)) {
      return {
        url: repairUrl,
        method: 'year-index-discovery',
        candidate: clean(candidate.text) || decodeURIComponentSafe(candidate.url),
        score: candidate.score,
        yearIndexUrl: yearUrl
      };
    }
  }

  throw new Error(`No matching LEMON vehicle folder found under ${yearUrl}`);
}

async function resolveRepairDiagnosisUrl(vehicle = {}) {
  const key = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim, vehicle.engine, vehicle.drivetrain, vehicle.driveType]
    .map(normalize)
    .join('|');

  if (!resolutionCache.has(key)) {
    resolutionCache.set(key, resolveLemonVehiclePathUncached(vehicle).catch(error => {
      resolutionCache.delete(key);
      throw error;
    }));
  }

  return resolutionCache.get(key);
}

module.exports = {
  resolveRepairDiagnosisUrl,
  scoreVehicleFolderCandidate,
  getVehicleSignals
};
