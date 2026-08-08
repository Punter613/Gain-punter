const { normalizeText, uniqueStrings, toFloat2 } = require('./estimateHelpers');

// Centralized alias catalog mapping component names to technical variations
const EXCLUSION_CATALOG = {
  brake_pads: ['brake pad', 'brake pads', 'pads', 'front pads', 'rear pads'],
  rotors: ['rotor', 'rotors', 'disc', 'brake disc'],
  calipers: ['caliper', 'calipers', 'brake caliper'],
  upper_control_arms: ['upper control arm', 'control arm upper'],
  ball_joints: ['ball joint', 'balljoint'],
  tie_rod_ends: ['tie rod', 'tierod', 'tie rod end'],
  wheel_bearings: ['wheel bearing', 'hub bearing', 'hub assembly'],
  shocks_struts: ['shock', 'strut', 'shock absorber', 'strut assembly'],
  sway_bar_links: ['sway bar link', 'stabilizer link', 'end link'],
  cv_axles: ['cv axle', 'axle shaft', 'cv joint', 'axle']
};

function buildExcludedSet(history = []) {
  return new Set(
    uniqueStrings(history)
      .map(normalizeText)
      .filter(Boolean)
  );
}

/**
 * Gated matching engine to prevent false-positive substring exclusions.
 */
function isExcluded(term, excludedSet) {
  const t = normalizeText(term);
  if (!t) return false;

  for (const item of excludedSet) {
    if (t === item) return true;

    for (const [catalogKey, aliases] of Object.entries(EXCLUSION_CATALOG)) {
      const isMatch = catalogKey === item || aliases.includes(item);
      if (isMatch && aliases.some(alias => t.includes(normalizeText(alias)))) {
        return true;
      }
    }

    if (t.length > 5 && (t.includes(item) || item.includes(t))) {
      return true;
    }
  }
  return false;
}

function sanitizeEstimate(estimate, history = []) {
  if (!estimate || typeof estimate !== 'object') return null;

  const excludedSet = buildExcludedSet(history);
  const clean = { ...estimate };

  clean.priority = ['high', 'medium', 'low'].includes(clean.priority) ? clean.priority : 'medium';

  clean.estimatedHours = Number(clean.estimatedHours);
  clean.laborCost = Number(clean.laborCost);
  clean.partsCost = Number(clean.partsCost);
  clean.total = Number(clean.total);

  if (
    !Number.isFinite(clean.estimatedHours) || clean.estimatedHours <= 0 ||
    !Number.isFinite(clean.laborCost) ||
    !Number.isFinite(clean.partsCost) ||
    !Number.isFinite(clean.total)
  ) {
    return null;
  }

  clean.repairs = Array.isArray(clean.repairs)
    ? clean.repairs.filter(x => !isExcluded(x, excludedSet))
    : [];

  clean.knownIssues = Array.isArray(clean.knownIssues)
    ? clean.knownIssues.filter(x => !isExcluded(x, excludedSet))
    : [];

  clean.probability = Array.isArray(clean.probability)
    ? clean.probability.filter(x => !isExcluded(x?.cause, excludedSet))
    : [];

  // mechanicNotices previously bypassed exclusion filtering entirely —
  // apply the same gate used for repairs/knownIssues/probability.
  if (Array.isArray(clean.mechanicNotices)) {
    clean.mechanicNotices = clean.mechanicNotices.filter(x => !isExcluded(x, excludedSet));
  }

  clean.excludedComponents = uniqueStrings(history);

  if (Array.isArray(clean.recommendedInspection)) {
    clean.recommendedInspection = clean.recommendedInspection.filter(Boolean);
  } else {
    clean.recommendedInspection = ['Visual inspection', 'Component measurement'];
  }

  if (!clean.repairs.length) return null;

  clean.laborCost = toFloat2(clean.laborCost);
  clean.partsCost = toFloat2(clean.partsCost);
  clean.total = toFloat2(clean.laborCost + clean.partsCost);

  return clean;
}

function safeEstimate(laborRate, partsCost, overrides = {}) {
  const estimatedHours = 1;
  const labor = toFloat2(estimatedHours * Number(laborRate || 0));
  const parts = toFloat2(Number(partsCost || 0));
  const total = toFloat2(labor + parts);

  return {
    priority: 'medium',
    source: 'fallback',
    diagnosis: 'Manual inspection required - insufficient data for AI determination',
    estimatedHours,
    laborCost: labor,
    partsCost: parts,
    total,
    repairs: ['Diagnostic inspection required'],
    probability: [],
    knownIssues: [],
    repairSteps: [],
    proTips: [],
    additionalChecks: [],
    notes: '',
    deductiveReasoning: 'AI estimation failed or was rejected by deterministic gating.',
    excludedComponents: [],
    recommendedInspection: ['Full visual inspection', 'Component measurement with calipers'],
    ...overrides
  };
}

module.exports = {
  buildExcludedSet,
  isExcluded,
  sanitizeEstimate,
  safeEstimate
};