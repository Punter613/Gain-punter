const NodeCache = require('node-cache');
const { scrapeLEMONManuals } = require('./lemon');
const { harvestVehicleTsbs } = require('./tsb.harvester');

const cache = new NodeCache({ stdTTL: 60 * 60 * 12, checkperiod: 600, useClones: false });
const NHTSA_BASE = 'https://api.nhtsa.gov';

function clean(value) { return String(value || '').trim(); }
function vehicleKey(vehicle) {
  return [
    vehicle.year,
    vehicle.make,
    vehicle.model,
    vehicle.trim,
    vehicle.engine,
    vehicle.drivetrain || vehicle.driveType || vehicle.drive
  ].map(clean).join('|').toLowerCase();
}

async function getJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'SKSK-ProTech/1.1 vehicle-evidence' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function classifyComponent(text) {
  const value = clean(text).toLowerCase();
  const groups = [
    ['steering', ['steering', 'rack', 'tie rod', 'intermediate shaft']],
    ['suspension', ['suspension', 'control arm', 'ball joint', 'stabilizer', 'sway bar', 'bushing', 'strut']],
    ['drivetrain', ['cv axle', 'constant velocity', 'driveshaft', 'propeller shaft', 'differential', 'transmission', 'mount']],
    ['engine', ['engine', 'misfire', 'fuel', 'ignition', 'air/fuel']],
    ['brakes', ['brake', 'rotor', 'caliper', 'abs']],
    ['electrical', ['electrical', 'battery', 'alternator', 'starter', 'wiring']],
    ['cooling', ['cooling', 'radiator', 'water pump', 'thermostat']]
  ];
  return groups.find(([, terms]) => terms.some(term => value.includes(term)))?.[0] || 'other';
}

function buildKnownIssues(complaints) {
  const groups = new Map();
  for (const complaint of complaints) {
    const text = [complaint.components, complaint.summary, complaint.crash, complaint.fire].filter(Boolean).join(' ');
    const system = classifyComponent(text);
    const key = `${system}:${clean(complaint.components) || clean(complaint.summary).slice(0, 100)}`;
    if (!groups.has(key)) groups.set(key, { system, component: clean(complaint.components) || 'Unspecified component', reports: 0, examples: [] });
    const item = groups.get(key);
    item.reports += 1;
    if (item.examples.length < 3 && complaint.summary) item.examples.push(clean(complaint.summary));
  }
  return [...groups.values()].sort((a, b) => b.reports - a.reports).slice(0, 12).map((item, index) => ({ ...item, rank: index + 1, source: 'NHTSA ODI complaints' }));
}

function classifyFactoryItems(items) {
  return (items || []).map(item => {
    const meta = item.meta || {};
    const text = [item.title, item.url, meta.headings, meta.snippet, meta.matchedKeywords, meta.facts].filter(Boolean).join(' ').toLowerCase();
    const type = /\btsb\b|technical.?service.?bulletin|service.?bulletin/.test(text)
      ? 'TSB_CANDIDATE'
      : /repair|diagnos|service|maintenance|specification|procedure|inspection|torque|removal|installation/.test(text)
        ? 'FACTORY_SERVICE_REFERENCE' : 'FACTORY_REFERENCE';
    let facts = null;
    if (meta.facts) { try { facts = JSON.parse(meta.facts); } catch (_) {} }
    return { ...item, evidenceType: type, sourceAuthority: 'LEMON_MANUALS', extractedFacts: facts, relevanceScore: Number(meta.relevanceScore || 0) };
  });
}

function tsbCorpusToReferences(bulletins) {
  return (bulletins || []).map(item => ({
    title: item.title || item.subject || 'Technical Service Bulletin',
    url: item.url,
    evidenceType: 'TSB_CANDIDATE',
    sourceAuthority: item.source || 'LEMON_MANUALS',
    relevanceScore: Number(item.score || 0),
    matchedKeywords: item.matchedKeywords || [],
    bulletinNumber: item.bulletinNumber || '',
    bulletinDate: item.bulletinDate || '',
    groupName: item.groupName || '',
    subject: item.subject || '',
    extractedFacts: item.extractedFacts || {},
    snippet: String(item.bodyText || '').slice(0, 3500)
  }));
}

async function scrapeNhtsa(vehicle) {
  const params = new URLSearchParams({ make: clean(vehicle.make), model: clean(vehicle.model), modelYear: String(vehicle.year) });
  const [recallsResult, complaintsResult] = await Promise.allSettled([
    getJson(`${NHTSA_BASE}/recalls/recallsByVehicle?${params}`),
    getJson(`${NHTSA_BASE}/complaints/complaintsByVehicle?${params}`)
  ]);
  const recalls = recallsResult.status === 'fulfilled' ? (recallsResult.value?.results || []) : [];
  const complaints = complaintsResult.status === 'fulfilled' ? (complaintsResult.value?.results || []) : [];
  return {
    recalls: recalls.slice(0, 25).map(item => ({ campaignNumber: item.NHTSACampaignNumber || item.CampaignNumber || '', component: item.Component || '', summary: item.Summary || '', consequence: item.Conequence || item.Consequence || '', remedy: item.Remedy || '', manufacturer: item.Manufacturer || '', source: 'NHTSA' })),
    knownIssues: buildKnownIssues(complaints),
    complaintCount: complaints.length,
    source: 'NHTSA ODI'
  };
}

async function collectVehicleEvidence(vehicle, context = {}) {
  if (!vehicle?.make || !vehicle?.model || !vehicle?.year) return { available: false, error: 'Vehicle year, make, and model are required' };

  const key = vehicleKey(vehicle);
  const cached = cache.get(key);
  if (cached) return { ...cached, fromCache: true };

  const result = {
    available: false, fromCache: false, collectedAt: new Date().toISOString(),
    vehicle: {
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      trim: vehicle.trim || '',
      engine: vehicle.engine || '',
      drivetrain: vehicle.drivetrain || vehicle.driveType || vehicle.drive || ''
    },
    oem: { references: [], source: 'LEMON_MANUALS' },
    tsbs: {
      references: [],
      corpusTotal: 0,
      corpusStored: false,
      corpusHarvested: false,
      corpusTruncated: false,
      status: 'candidate references only; verify bulletin identity/applicability before claiming a TSB'
    },
    recalls: [], knownIssues: [], sources: [], errors: []
  };

  const [manualResult, tsbResult, nhtsaResult] = await Promise.allSettled([
    scrapeLEMONManuals(vehicle, context),
    harvestVehicleTsbs(vehicle, { ...context, keywords: context.keywords || [] }),
    scrapeNhtsa(vehicle)
  ]);

  if (manualResult.status === 'fulfilled') {
    const manual = manualResult.value || {};
    const references = classifyFactoryItems(manual.items || []).sort((a, b) => b.relevanceScore - a.relevanceScore);
    result.oem = {
      references: references.filter(item => item.evidenceType !== 'TSB_CANDIDATE').slice(0, 20),
      source: 'LEMON_MANUALS', fromCache: !!manual.fromCache,
      scraped: !!manual.scraped, schemaVersion: manual.schemaVersion || 1, crawledUrls: manual.crawled_urls || 0
    };
    if (references.length) result.sources.push('LEMON_MANUALS');
    if (manual.error) result.errors.push(`LEMON: ${manual.error}`);
  } else result.errors.push(`LEMON: ${manualResult.reason?.message || 'scrape failed'}`);

  if (tsbResult.status === 'fulfilled') {
    const corpus = tsbResult.value || {};
    const references = tsbCorpusToReferences(corpus.bulletins || []).sort((a, b) => b.relevanceScore - a.relevanceScore);
    result.tsbs = {
      ...result.tsbs,
      references: references.slice(0, 15),
      corpusTotal: Number(corpus.total || references.length || 0),
      corpusStored: !!corpus.fromStore || (!!corpus.harvested && !corpus.error),
      corpusHarvested: !!corpus.harvested,
      corpusTruncated: !!corpus.truncated,
      crawledUrls: Number(corpus.crawledUrls || 0),
      rootUrl: corpus.tsbRootUrl || ''
    };
    if (references.length && !result.sources.includes('LEMON_MANUALS')) result.sources.push('LEMON_MANUALS');
    if (corpus.error) result.errors.push(`LEMON TSB corpus: ${corpus.error}`);
  } else result.errors.push(`LEMON TSB corpus: ${tsbResult.reason?.message || 'harvest failed'}`);

  if (nhtsaResult.status === 'fulfilled') {
    const nhtsa = nhtsaResult.value || {};
    result.recalls = nhtsa.recalls || [];
    result.knownIssues = nhtsa.knownIssues || [];
    result.complaintCount = nhtsa.complaintCount || 0;
    if (result.recalls.length || result.knownIssues.length) result.sources.push('NHTSA_ODI');
  } else result.errors.push(`NHTSA: ${nhtsaResult.reason?.message || 'lookup failed'}`);

  result.available = result.sources.length > 0;
  cache.set(key, result);
  return result;
}

module.exports = { collectVehicleEvidence };
