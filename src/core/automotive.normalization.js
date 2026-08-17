const { detectRawTriggers } = require('./observation/observation-normalizer');

const SOUND_ALIASES = {
  clunk: ['clunk', 'clunking', 'knock when turning'],
  knock: ['knock', 'knocking', 'pinging'],
  rattle: ['rattle', 'rattling', 'chatter'],
  click: ['click', 'clicking', 'ticking'],
  grind: ['grind', 'grinding', 'grating'],
  whine: ['whine', 'whining'],
  hum: ['hum', 'humming', 'droning'],
  squeak: ['squeak', 'squeaking', 'squeal', 'squealing'],
  bump: ['bump', 'bumping', 'thump', 'thumping', 'bang'],
  vibration: ['vibration', 'vibrating', 'shake', 'shaking', 'shimmy'],
  shudder: ['shudder', 'shuddering', 'stumble']
};

// Static/non-event operating conditions only. Dynamic physical events such as
// acceleration, deceleration, turning, braking and road impact come from the
// shared observation trigger detector so there is one deterministic definition.
const CONDITION_ALIASES = {
  cold_start: ['cold start', 'cold startup', 'first start', 'startup cold'],
  hot: ['hot', 'warm', 'at operating temperature'],
  idle: ['idle', 'idling', 'at a stop'],
  steady_cruise: ['steady cruise', 'cruising', 'light throttle', 'highway cruise'],
  full_lock: ['full lock', 'full steering lock', 'steering lock', 'wheel turned all the way', 'turned all the way'],
  highway_speed: ['highway', 'highway speed', 'at speed'],
  low_speed: ['low speed', 'parking lot', 'slow turn'],
  reverse: ['reverse', 'backing up'],
  after_refuel: ['after refuel', 'after refueling', 'after filling up', 'after gas fill']
};

const SYSTEM_ALIASES = {
  engine: ['engine', 'motor', 'combustion', 'misfire', 'fuel trim'],
  fuel_emissions: ['fuel', 'evap', 'purge', 'emission', 'lean', 'rich'],
  transmission: ['transmission', 'transaxle', 'gearbox', 'shift', 'tcm', 'pcm/tecm'],
  steering: ['steering', 'tie rod', 'steering rack', 'intermediate shaft'],
  suspension: ['suspension', 'ball joint', 'control arm', 'bushing', 'sway bar', 'stabilizer', 'strut', 'shock'],
  driveline: ['driveline', 'driveshaft', 'propeller shaft', 'cv axle', 'constant velocity', 'u-joint', 'differential'],
  brakes: ['brake', 'rotor', 'caliper', 'parking brake'],
  wheels_tires: ['wheel', 'tire', 'tpms', 'alignment', 'wheel bearing'],
  electrical: ['electrical', 'software', 'module', 'battery', 'charging', 'wiring'],
  srs: ['air bag', 'airbag', 'srs', 'restraint'],
  body: ['body', 'structure', 'door', 'latch', 'liftgate'],
  hvac: ['hvac', 'air conditioning', 'a/c', 'heater'],
  visibility: ['visibility', 'mirror', 'windshield', 'wiper']
};

const SECTION_PATTERNS = [
  ['DIAGNOSIS', /diagnos|troubleshoot|symptom|dtc|trouble code|fault code|pinpoint test/],
  ['TEST', /test(?:ing)?|inspection|inspect|check|measurement|verification|verify/],
  ['SPEC', /specification|torque|tighten|clearance|limit|pressure|resistance|voltage/],
  ['REPAIR', /service and repair|repair|removal|remove|installation|install|replacement|replace|overhaul|adjustment/],
  ['PARTS', /parts|component location|component information|exploded view|assembly/],
  ['LABOR', /labor|labour|flat rate|operation time|standard time|book time/],
  ['TSB', /technical service bulletin|service bulletin|\btsb\b/]
];

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9.+/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDtcs(value) {
  const text = String(value || '').toUpperCase();
  const matches = text.match(/\b[PCBU][0-9A-F]{4}\b/g) || [];
  return [...new Set(matches)];
}

function collectAliases(text, map) {
  const normalized = normalizeText(text);
  const found = [];
  for (const [canonical, aliases] of Object.entries(map)) {
    if (aliases.some(alias => normalized.includes(normalizeText(alias)))) found.push(canonical);
  }
  return found;
}

function extractCanonicalProfile(input = {}) {
  const complaintText = [
    input.query,
    input.symptoms,
    input.customerStates,
    ...(Array.isArray(input.mechanicNotices) ? input.mechanicNotices : [input.mechanicNotices])
  ].filter(Boolean).join(' ');

  const joined = [
    complaintText,
    ...(Array.isArray(input.obdCodes) ? input.obdCodes : [input.obdCodes]),
    input.title,
    ...(Array.isArray(input.headings) ? input.headings : []),
    input.url,
    input.bodyText
  ].filter(Boolean).join(' ');

  const dtcs = extractDtcs(joined);
  const sounds = collectAliases(joined, SOUND_ALIASES);
  const triggers = detectRawTriggers(joined);
  const staticConditions = collectAliases(joined, CONDITION_ALIASES);
  const conditions = [...new Set([...staticConditions, ...triggers])];
  const systems = collectAliases(joined, SYSTEM_ALIASES);
  if (/(^|[^a-z0-9])(?:a\s*[\/.\-]?\s*c|ac|hvac)(?=$|[^a-z0-9])|air[ -]?condition(?:ing)?/i.test(joined) && !systems.includes('hvac')) {
    systems.push('hvac');
  }

  const canonicalTerms = [...new Set([
    ...dtcs.map(code => code.toLowerCase()),
    ...sounds,
    ...conditions,
    ...systems
  ])];

  return { dtcs, sounds, conditions, systems, triggers, canonicalTerms };
}

function sectionPathText(url) {
  if (!url) return '';
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const parts = pathname.split('/').filter(Boolean);
    const repairIndex = parts.findIndex(part => /^repair and diagnosis$/i.test(part));
    const sectionParts = repairIndex >= 0 ? parts.slice(repairIndex + 1) : parts.slice(-3);
    return sectionParts.join(' ');
  } catch (_) {
    return '';
  }
}

function classifyManualSection(input = {}) {
  // Do not classify from Lemon's common parent folder "Repair and Diagnosis".
  // Every page inherits that path and it would otherwise make every page look DIAGNOSIS.
  const titleHeadingsPath = normalizeText([
    input.title,
    ...(Array.isArray(input.headings) ? input.headings : []),
    sectionPathText(input.url)
  ].filter(Boolean).join(' '));
  const body = normalizeText(input.bodyText || '').slice(0, 12000);

  const scores = new Map();
  for (const [type, pattern] of SECTION_PATTERNS) {
    let score = 0;
    if (pattern.test(titleHeadingsPath)) score += 3;
    if (pattern.test(body)) score += 1;
    if (score) scores.set(type, score);
  }

  if (!scores.size) return 'OTHER';
  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function buildCanonicalSearchTerms(vehicle = {}, context = {}) {
  const profile = extractCanonicalProfile(context);

  // Vehicle identity belongs to applicability/path resolution, not page ranking.
  // Raw complaint words are intentionally not promoted independently because
  // generic tokens such as "release" can create false matches like
  // "accelerator release" -> "Fuel Pressure Release".
  const terms = [...profile.canonicalTerms];
  const complaintText = normalizeText([
    context.query,
    context.symptoms,
    ...(Array.isArray(context.mechanicNotices) ? context.mechanicNotices : [context.mechanicNotices])
  ].filter(Boolean).join(' '));

  // Canonical HVAC is an internal system name; service manuals commonly spell
  // the tree out as "Air Conditioning" and title components directly. When a
  // mechanic names the clutch, preserve that component intent so generic HVAC
  // sensors do not outrank compressor/clutch pages merely for being in HVAC.
  if (profile.systems.includes('hvac')) {
    terms.push('air conditioning');
    if (/\bclutch\b/.test(complaintText)) terms.push('compressor clutch', 'clutch', 'compressor');
    else if (/\bcompressor\b/.test(complaintText)) terms.push('compressor');
  }

  const vehicleTerms = [vehicle.make, vehicle.model, vehicle.trim, vehicle.engine]
    .map(normalizeText)
    .filter(Boolean);

  return {
    profile,
    terms: [...new Set(terms)].filter(Boolean),
    vehicleTerms: [...new Set(vehicleTerms)]
  };
}

module.exports = {
  cleanText,
  normalizeText,
  extractDtcs,
  extractCanonicalProfile,
  classifyManualSection,
  buildCanonicalSearchTerms,
  sectionPathText
};
