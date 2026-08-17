const LEMON_HOSTS = new Set(['lemon-manuals.la', 'lemon-manuals.org.ua', 'lemon-manuals.gy']);
const CHARM_HOST = 'charm.li';
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

function classifyDrivetrain(value) {
  const source = String(value || '');
  if (/\b4wd\b|\b4x4\b|four[ -]?wheel drive/i.test(source)) return '4wd';
  if (/\bawd\b|all[ -]?wheel drive/i.test(source)) return 'awd';
  if (/\bfwd\b|front[ -]?wheel drive/i.test(source)) return 'fwd';
  if (/\brwd\b|rear[ -]?wheel drive/i.test(source)) return 'rwd';
  if (/\b2wd\b|two[ -]?wheel drive/i.test(source)) return '2wd';
  return '';
}

function getVehicleSignals(vehicle = {}) {
  const source = [
    vehicle.model,
    vehicle.trim,
    vehicle.engine,
    vehicle.engineCylinders,
    vehicle.drivetrain,
    vehicle.driveType,
    vehicle.drive,
    vehicle.bodyClass
  ].filter(Boolean).join(' ');

  const normalized = normalize(source);
  const displacement = String(source).match(/\b(\d(?:\.\d)?)\s*l\b/i)?.[1] || '';
  const cylinderMatch = String(source).match(/\b(?:v\s*)?(4|6|8|10|12)\s*(?:cyl(?:inder)?s?)?\b/i);
  const cylinders = cylinderMatch?.[1] || '';

  return {
    model: normalize(vehicle.model),
    displacement,
    cylinders,
    drivetrain: classifyDrivetrain(source),
    raw: normalized
  };
}

function drivetrainsConflict(requested, candidate) {
  if (!requested || !candidate) return false;
  if (requested === candidate) return false;
  if (requested === '2wd' && (candidate === 'fwd' || candidate === 'rwd')) return false;
  if (candidate === '2wd' && (requested === 'fwd' || requested === 'rwd')) return false;
  return true;
}

function scoreVehicleFolderCandidate(candidate, vehicle) {
  const signals = getVehicleSignals(vehicle);
  const decoded = `${candidate.text || ''} ${decodeURIComponentSafe(candidate.url || '')}`;
  const text = normalize(decoded);
  if (!signals.model || !text.includes(signals.model)) return -1000;

  const candidateDrivetrain = classifyDrivetrain(decoded);
  if (drivetrainsConflict(signals.drivetrain, candidateDrivetrain)) return -1000;

  let score = 100;
  const modelTokens = signals.model.split(' ').filter(Boolean);
  for (const token of modelTokens) if (text.includes(token)) score += 20;

  if (signals.displacement) {
    const displacementPattern = new RegExp(`\\b${signals.displacement.replace('.', '[ .]?')}\\s*l?\\b`, 'i');
    if (displacementPattern.test(decoded)) score += 45;
    else score -= 20;
  }

  if (signals.cylinders) {
    if (new RegExp(`\\bv?${signals.cylinders}\\b`, 'i').test(decoded)) score += 30;
    else score -= 10;
  }

  if (signals.drivetrain) {
    if (candidateDrivetrain === signals.drivetrain) score += 60;
    else if (!candidateDrivetrain) score -= 20;
  }

  return score;
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); }
  catch (_) { return String(value || ''); }
}

function extractLinks(html, baseUrl, allowedHosts) {
  const links = [];
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(String(html || '')))) {
    const href = String(match[1] || '').replace(/&amp;/g, '&').trim();
    const text = clean(String(match[2] || '').replace(/<[^>]+>/g, ' '));
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    try {
      const absolute = new URL(href, baseUrl).toString();
      if (!allowedHosts.has(new URL(absolute).hostname.toLowerCase())) continue;
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
        'User-Agent': 'Mozilla/5.0 (compatible; SKSK-ProTech/1.5; manual-path-resolver)'
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

function buildVehicleLabels(vehicle) {
  const model = clean(vehicle.model);
  const signals = getVehicleSignals(vehicle);
  const labels = [];
  if (signals.cylinders && signals.displacement && signals.drivetrain) {
    labels.push(`${model} ${signals.drivetrain.toUpperCase()} V${signals.cylinders}-${signals.displacement}L`);
  }
  if (signals.cylinders && signals.displacement) labels.push(`${model} V${signals.cylinders}-${signals.displacement}L`);
  if (vehicle.trim) labels.push(`${model} ${clean(vehicle.trim)}`);
  labels.push(model);
  return [...new Set(labels)];
}

function buildDirectCandidates(vehicle, host, makeLabels) {
  const year = clean(vehicle.year);
  const labels = buildVehicleLabels(vehicle);
  const candidates = [];
  for (const make of makeLabels) {
    for (const label of labels) {
      candidates.push({
        label,
        make,
        url: `https://${host}/${encodeURIComponent(make)}/${encodeURIComponent(year)}/${encodeURIComponent(label)}/Repair%20and%20Diagnosis/`
      });
    }
  }
  return candidates;
}

async function probeRepairUrl(url) {
  try {
    await fetchHtml(url, 7000);
    return true;
  } catch (_) {
    return false;
  }
}

async function resolveFromSource(vehicle, { host, makeLabels, allowedHosts, source }) {
  const signals = getVehicleSignals(vehicle);
  for (const candidate of buildDirectCandidates(vehicle, host, makeLabels)) {
    if (signals.drivetrain && drivetrainsConflict(signals.drivetrain, classifyDrivetrain(candidate.label))) continue;
    if (await probeRepairUrl(candidate.url)) {
      return {
        url: candidate.url,
        method: 'direct-candidate',
        candidate: candidate.label,
        drivetrain: signals.drivetrain,
        source
      };
    }
  }

  for (const make of makeLabels) {
    const yearUrl = `https://${host}/${encodeURIComponent(make)}/${encodeURIComponent(clean(vehicle.year))}/`;
    let html;
    try {
      html = await fetchHtml(yearUrl);
    } catch (_) {
      continue;
    }
    const yearRoot = decodeURIComponentSafe(yearUrl).toLowerCase();
    const ranked = extractLinks(html, yearUrl, allowedHosts)
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
          drivetrain: signals.drivetrain,
          yearIndexUrl: yearUrl,
          source
        };
      }
    }
  }

  throw new Error(`No matching ${source} vehicle folder found`);
}

async function resolveRepairDiagnosisUrlUncached(vehicle = {}) {
  if (!vehicle.make || !vehicle.year || !vehicle.model) {
    throw new Error('Vehicle make, year, and model are required for Repair & Diagnosis path resolution');
  }

  const make = titleCase(vehicle.make);
  let lemonError;
  try {
    return await resolveFromSource(vehicle, {
      host: 'lemon-manuals.la',
      makeLabels: [make],
      allowedHosts: LEMON_HOSTS,
      source: 'LEMON_MANUALS'
    });
  } catch (error) {
    lemonError = error;
  }

  try {
    return await resolveFromSource(vehicle, {
      host: CHARM_HOST,
      makeLabels: [make, `${make} Truck`],
      allowedHosts: new Set([CHARM_HOST]),
      source: 'CHARM'
    });
  } catch (charmError) {
    throw new Error(`LEMON failed (${lemonError.message}); CHARM failed (${charmError.message})`);
  }
}

async function resolveRepairDiagnosisUrl(vehicle = {}) {
  const key = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim, vehicle.engine, vehicle.engineCylinders, vehicle.drivetrain, vehicle.driveType]
    .map(normalize)
    .join('|');

  if (!resolutionCache.has(key)) {
    resolutionCache.set(key, resolveRepairDiagnosisUrlUncached(vehicle).catch(error => {
      resolutionCache.delete(key);
      throw error;
    }));
  }

  return resolutionCache.get(key);
}

module.exports = {
  resolveRepairDiagnosisUrl,
  scoreVehicleFolderCandidate,
  getVehicleSignals,
  classifyDrivetrain,
  drivetrainsConflict,
  buildVehicleLabels,
  buildDirectCandidates
};