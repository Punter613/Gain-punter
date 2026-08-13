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
  full_lock: ['full lock', 'steering lock', 'wheel turned all the way', 'turned all the way'],
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

  const canonicalTerms = [...new Set([
    ...dtcs.map(code => code.toLowerCase()),
    ...sounds,
    ...conditions,
    ...systems
  ])];

  return { dtcs, sounds, conditions, systems, triggers, canonicalTerms };
}

function classifyManualSection(input = {}) {
  const titleHeadingsUrl = normalizeText([
    input.title,
    ...(Array.isArray(input.headings) ? input.headings : []),
    input.url
  ].filter(Boolean).join(' '));
  const body = normalizeText(input.bodyText || '').slice(0, 12000);
  const weightedText = `${titleHeadingsUrl} ${titleHeadingsUrl} ${body}`;

  const scores = new Map();
  for (const [type, pattern] of SECTION_PATTERNS) {
    let score = 0;
    if (pattern.test(titleHeadingsUrl)) score += 3;
    if (pattern.test(weightedText)) score += 1;
    if (score) scores.set(type, score);
  }

  if (!scores.size) return 'OTHER';
  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function buildCanonicalSearchTerms(vehicle = {}, context = {}) {
  const profile = extractCanonicalProfile(context);
  const terms = new Set(profile.canonicalTerms);

  for (const value of [vehicle.make, vehicle.model, vehicle.trim, vehicle.engine]) {
    const normalized = normalizeText(value);
    if (normalized) terms.add(normalized);
  }

  const rawContext = cleanText([
    context.symptoms,
    ...(Array.isArray(context.mechanicNotices) ? context.mechanicNotices : [context.mechanicNotices]),
    ...(Array.isArray(context.obdCodes) ? context.obdCodes : [context.obdCodes])
  ].filter(Boolean).join(' '));

  for (const token of normalizeText(rawContext).split(' ')) {
    if (token.length >= 4) terms.add(token);
  }

  return { profile, terms: [...terms].filter(Boolean) };
}

module.exports = {
  cleanText,
  normalizeText,
  extractDtcs,
  extractCanonicalProfile,
  classifyManualSection,
  buildCanonicalSearchTerms
};
