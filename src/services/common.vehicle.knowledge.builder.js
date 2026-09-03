'use strict';

const { supabase: defaultSupabase } = require('../db');

const COVERAGE_POLICY = 'DURABLE_FIRST_STRUCTURED_CORPUS';
const CATALOG_VERSION = 'CURATED_COMMON_SERVICE_PLATFORMS_V1';
const MAX_TSB_SCAN = 20000;
const MAX_REPAIR_SCAN = 10000;
const PAGE_SIZE = 1000;

// This is a service-priority catalog, not a claim of exact annual sales rank.
// The goal is to focus ingestion and verified-outcome collection on common US
// shop platforms first while keeping the ranking editable and deterministic.
const COMMON_PLATFORM_CATALOG = Object.freeze([
  { make: 'Ford', model: 'F-150', fromYear: 2011, toYear: 2025, marketPriority: 100 },
  { make: 'Chevrolet', model: 'Silverado 1500', fromYear: 2011, toYear: 2025, marketPriority: 99, aliases: ['Silverado'] },
  { make: 'Ram', model: '1500', fromYear: 2011, toYear: 2025, marketPriority: 97 },
  { make: 'Toyota', model: 'Camry', fromYear: 2012, toYear: 2025, marketPriority: 96 },
  { make: 'Toyota', model: 'Corolla', fromYear: 2014, toYear: 2025, marketPriority: 95 },
  { make: 'Toyota', model: 'RAV4', fromYear: 2013, toYear: 2025, marketPriority: 95 },
  { make: 'Honda', model: 'CR-V', fromYear: 2012, toYear: 2025, marketPriority: 94 },
  { make: 'Honda', model: 'Civic', fromYear: 2012, toYear: 2025, marketPriority: 93 },
  { make: 'Honda', model: 'Accord', fromYear: 2013, toYear: 2025, marketPriority: 92 },
  { make: 'Nissan', model: 'Rogue', fromYear: 2014, toYear: 2025, marketPriority: 90 },
  { make: 'Nissan', model: 'Altima', fromYear: 2013, toYear: 2025, marketPriority: 88 },
  { make: 'Chevrolet', model: 'Equinox', fromYear: 2010, toYear: 2025, marketPriority: 87 },
  { make: 'Ford', model: 'Escape', fromYear: 2013, toYear: 2025, marketPriority: 86 },
  { make: 'Ford', model: 'Explorer', fromYear: 2011, toYear: 2025, marketPriority: 86 },
  { make: 'Jeep', model: 'Grand Cherokee', fromYear: 2011, toYear: 2025, marketPriority: 85 },
  { make: 'Hyundai', model: 'Tucson', fromYear: 2016, toYear: 2025, marketPriority: 83 },
  { make: 'Hyundai', model: 'Elantra', fromYear: 2011, toYear: 2025, marketPriority: 82 },
  { make: 'Kia', model: 'Sorento', fromYear: 2011, toYear: 2025, marketPriority: 82 },
  { make: 'Kia', model: 'Sportage', fromYear: 2011, toYear: 2025, marketPriority: 80 },
  { make: 'Honda', model: 'Odyssey', fromYear: 2011, toYear: 2025, marketPriority: 78 }
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalModel(value) {
  return norm(value)
    .replace(/\bcrew cab\b|\bextended cab\b|\bregular cab\b/g, ' ')
    .replace(/\b2wd\b|\b4wd\b|\bawd\b|\bfwd\b|\brwd\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function targetKey(year, make, model) {
  return `${Number(year)}|${norm(make)}|${canonicalModel(model)}`;
}

function expandCatalog(catalog = COMMON_PLATFORM_CATALOG) {
  const rows = [];
  for (const item of catalog) {
    for (let year = Number(item.fromYear); year <= Number(item.toYear); year += 1) {
      rows.push({
        year,
        make: item.make,
        model: item.model,
        marketPriority: Number(item.marketPriority || 0),
        aliases: Array.isArray(item.aliases) ? item.aliases : []
      });
    }
  }
  return rows;
}

function rowMatchesTarget(row = {}, target = {}) {
  if (Number(row.year) !== Number(target.year)) return false;
  if (norm(row.make) !== norm(target.make)) return false;
  const model = canonicalModel(row.model);
  const acceptable = [target.model, ...(target.aliases || [])].map(canonicalModel);
  return acceptable.some(value => model === value || model.startsWith(`${value} `) || value.startsWith(`${model} `));
}

function isOfficialStoredSource(source) {
  return /^nhtsa(?:_|\b)/i.test(clean(source));
}

function isOptionalExternalSource(source) {
  return /lemon|manual/i.test(clean(source));
}

function broadSystem(row = {}) {
  const text = norm([row.group_name, row.subject, row.title].filter(Boolean).join(' '));
  const groups = [
    ['ENGINE', /engine|fuel|ignition|emission|exhaust|powertrain/],
    ['TRANSMISSION_DRIVELINE', /transmission|drivetrain|driveline|differential|axle|transfer case|propeller|drive shaft/],
    ['BRAKES_ABS', /brake|abs|stability|traction/],
    ['STEERING_SUSPENSION', /steering|suspension|wheel|tire|alignment/],
    ['ELECTRICAL', /electrical|battery|charging|starter|wiring|software|module|communication/],
    ['HVAC', /hvac|air condition|heater|climate/],
    ['BODY_SAFETY', /body|structure|air bag|airbag|seat belt|door|latch|visibility/],
    ['COOLING', /cooling|radiator|thermostat|coolant/]
  ];
  return groups.find(([, pattern]) => pattern.test(text))?.[0] || 'OTHER';
}

function latestTrustedRepairs(rows = []) {
  const trusted = rows.filter(row => row?.metadata?.trustedForTraining === true && row?.labels?.confirmedRepairCase);
  const latest = new Map();
  for (const row of trusted) {
    const id = clean(row.request_id || row.requestId || row.id);
    if (!id) continue;
    const correction = Number(row.labels?.confirmedRepairCase?.correctionCount || 0);
    const at = Date.parse(row.metadata?.createdAt || row.stored_at || '') || 0;
    const current = latest.get(id);
    const currentCorrection = Number(current?.labels?.confirmedRepairCase?.correctionCount || 0);
    const currentAt = Date.parse(current?.metadata?.createdAt || current?.stored_at || '') || 0;
    if (!current || correction > currentCorrection || (correction === currentCorrection && at > currentAt)) latest.set(id, row);
  }
  return [...latest.values()];
}

function coverageScore(metrics = {}) {
  const official = Math.min(45, Number(metrics.officialBulletins || 0) * 3);
  const systems = Math.min(20, Number(metrics.systemBreadth || 0) * 4);
  const repairs = Math.min(25, Number(metrics.verifiedRepairCases || 0) * 5);
  const durableDiversity = Number(metrics.officialBulletins || 0) > 0 && Number(metrics.verifiedRepairCases || 0) > 0
    ? 10
    : Number(metrics.officialBulletins || 0) > 0 || Number(metrics.verifiedRepairCases || 0) > 0
      ? 5
      : 0;
  return Math.min(100, official + systems + repairs + durableDiversity);
}

function gapList(metrics = {}) {
  const gaps = [];
  if (!metrics.officialBulletins) gaps.push('NO_OFFICIAL_PUBLISHED_EVIDENCE');
  if (!metrics.verifiedRepairCases) gaps.push('NO_VERIFIED_REPAIR_OUTCOMES');
  if (metrics.systemBreadth < 3) gaps.push('LOW_SYSTEM_BREADTH');
  if (metrics.optionalEvidence > 0 && metrics.officialBulletins === 0 && metrics.verifiedRepairCases === 0) gaps.push('OPTIONAL_SOURCE_DEPENDENCE');
  if (metrics.officialBulletins === 0 && metrics.verifiedRepairCases === 0) gaps.push('NO_DURABLE_EVIDENCE');
  return gaps;
}

function recommendedActions(gaps = []) {
  const actions = [];
  if (gaps.includes('NO_OFFICIAL_PUBLISHED_EVIDENCE')) actions.push('INGEST_NHTSA_BULK');
  if (gaps.includes('NO_VERIFIED_REPAIR_OUTCOMES')) actions.push('COLLECT_VERIFIED_REPAIR_OUTCOMES');
  if (gaps.includes('LOW_SYSTEM_BREADTH')) actions.push('EXPAND_SYSTEM_COVERAGE');
  if (gaps.includes('OPTIONAL_SOURCE_DEPENDENCE')) actions.push('REPLACE_OPTIONAL_DEPENDENCE_WITH_DURABLE_FACTS');
  if (gaps.includes('NO_DURABLE_EVIDENCE')) actions.push('PRIORITIZE_FOR_DURABLE_CORPUS_BUILD');
  return [...new Set(actions)];
}

function buildCoverageSnapshot({ tsbRows = [], repairRows = [], catalog = COMMON_PLATFORM_CATALOG, scanTelemetry = {} } = {}) {
  const targets = expandCatalog(catalog);
  const trustedRepairs = latestTrustedRepairs(repairRows);
  const items = targets.map(target => {
    const tsbs = tsbRows.filter(row => rowMatchesTarget(row, target));
    const repairs = trustedRepairs.filter(row => rowMatchesTarget(row.labels?.vehicle || row.metadata?.vehicle || {}, target));
    const officialRows = tsbs.filter(row => isOfficialStoredSource(row.source));
    const optionalRows = tsbs.filter(row => isOptionalExternalSource(row.source));
    const systems = new Set(officialRows.map(broadSystem));
    const metrics = {
      officialBulletins: new Set(officialRows.map(row => clean(row.bulletin_number) || clean(row.source_url) || clean(row.id)).filter(Boolean)).size,
      optionalEvidence: optionalRows.length,
      verifiedRepairCases: repairs.length,
      systemBreadth: systems.size,
      durableSourceTypes: [officialRows.length ? 'NHTSA_BULK' : null, repairs.length ? 'VERIFIED_REPAIR_OUTCOMES' : null].filter(Boolean)
    };
    const score = coverageScore(metrics);
    const gaps = gapList(metrics);
    const priorityScore = Math.round((target.marketPriority * 0.55) + ((100 - score) * 0.45));
    return {
      key: targetKey(target.year, target.make, target.model),
      year: target.year,
      make: target.make,
      model: target.model,
      marketPriority: target.marketPriority,
      coverageScore: score,
      priorityScore,
      metrics,
      gaps,
      recommendedActions: recommendedActions(gaps),
      durableReady: metrics.officialBulletins > 0 || metrics.verifiedRepairCases > 0
    };
  }).sort((a, b) => b.priorityScore - a.priorityScore || a.coverageScore - b.coverageScore || b.year - a.year);

  const officialBulletinRows = tsbRows.filter(row => isOfficialStoredSource(row.source)).length;
  const optionalEvidenceRows = tsbRows.filter(row => isOptionalExternalSource(row.source)).length;
  const durableReadyCount = items.filter(item => item.durableReady).length;
  const optionalDependentCount = items.filter(item => item.gaps.includes('OPTIONAL_SOURCE_DEPENDENCE')).length;
  const averageCoverageScore = items.length
    ? Math.round(items.reduce((sum, item) => sum + item.coverageScore, 0) / items.length)
    : 0;

  return {
    policy: COVERAGE_POLICY,
    catalogVersion: CATALOG_VERSION,
    catalogNote: 'Curated common-service platform priority; not an exact annual sales ranking.',
    generatedAt: new Date().toISOString(),
    sourceRules: {
      durableCoverageSources: ['NHTSA_BULK', 'VERIFIED_REPAIR_OUTCOMES'],
      optionalExternalSources: ['LEMON_MANUALS'],
      optionalExternalCountsTowardDurableCoverage: false,
      rawOptionalManualContentReturned: false
    },
    summary: {
      targetYearMakeModels: items.length,
      durableReadyCount,
      durableCoveragePercent: items.length ? Math.round((durableReadyCount / items.length) * 100) : 0,
      optionalDependentCount,
      averageCoverageScore,
      officialBulletinRows,
      optionalEvidenceRows,
      verifiedRepairCases: trustedRepairs.length
    },
    scanTelemetry,
    items
  };
}

async function scanTable(client, table, select, maxScan) {
  if (!client) return { rows: [], scanned: 0, scanLimitReached: false, error: 'database not configured' };
  const rows = [];
  let exhausted = false;
  try {
    for (let offset = 0; offset < maxScan; offset += PAGE_SIZE) {
      const requestSize = Math.min(PAGE_SIZE, maxScan - offset);
      let query = client.from(table).select(select);
      if (typeof query.order === 'function') query = query.order('id', { ascending: true });
      const { data, error } = await query.range(offset, offset + requestSize - 1);
      if (error) throw error;
      const page = Array.isArray(data) ? data : [];
      rows.push(...page);
      if (page.length < requestSize) {
        exhausted = true;
        break;
      }
    }
    return { rows, scanned: rows.length, scanLimitReached: !exhausted && rows.length >= maxScan, error: null };
  } catch (error) {
    return { rows, scanned: rows.length, scanLimitReached: false, error: error.message || String(error) };
  }
}

async function buildCommonVehicleCoverage(options = {}) {
  const client = options.client === undefined ? defaultSupabase : options.client;
  const [tsbResult, repairResult] = await Promise.all([
    scanTable(client, 'vehicle_tsb_corpus', 'id,year,make,model,title,bulletin_number,group_name,subject,source,source_url', MAX_TSB_SCAN),
    scanTable(client, 'feedback_examples', 'id,request_id,stored_at,metadata,labels', MAX_REPAIR_SCAN)
  ]);
  const snapshot = buildCoverageSnapshot({
    tsbRows: tsbResult.rows,
    repairRows: repairResult.rows,
    scanTelemetry: {
      vehicleTsbCorpus: { rowsScanned: tsbResult.scanned, maxScan: MAX_TSB_SCAN, scanLimitReached: tsbResult.scanLimitReached, error: tsbResult.error || undefined },
      verifiedRepairCorpus: { rowsScanned: repairResult.scanned, maxScan: MAX_REPAIR_SCAN, scanLimitReached: repairResult.scanLimitReached, error: repairResult.error || undefined }
    }
  });
  return snapshot;
}

function filterCoverage(snapshot, filters = {}) {
  const make = norm(filters.make);
  const model = canonicalModel(filters.model);
  const year = Number(filters.year || 0);
  const limit = Math.max(1, Math.min(250, Number(filters.limit || 50)));
  const items = (snapshot.items || []).filter(item => {
    if (make && norm(item.make) !== make) return false;
    if (model && canonicalModel(item.model) !== model) return false;
    if (year && Number(item.year) !== year) return false;
    return true;
  }).slice(0, limit);
  return { ...snapshot, items, returned: items.length };
}

module.exports = {
  COVERAGE_POLICY,
  CATALOG_VERSION,
  COMMON_PLATFORM_CATALOG,
  expandCatalog,
  rowMatchesTarget,
  isOfficialStoredSource,
  isOptionalExternalSource,
  broadSystem,
  latestTrustedRepairs,
  coverageScore,
  gapList,
  recommendedActions,
  buildCoverageSnapshot,
  buildCommonVehicleCoverage,
  filterCoverage
};