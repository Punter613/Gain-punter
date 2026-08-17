const { extractCanonicalProfile, extractDtcs, normalizeText } = require('../automotive.normalization');

// Quick Ask remains retrieval-only. These entries provide deterministic search
// vocabulary for codes SKSK can resolve without asking a model to invent a DTC
// meaning. SAE/generic entries may apply across makes; manufacturer-specific P1xxx
// entries are scoped by make.
const GENERIC_DTC_CONTEXTS = Object.freeze({
  P0300: Object.freeze({
    description: 'Random/multiple cylinder misfire detected',
    terms: Object.freeze(['random misfire', 'multiple cylinder misfire', 'cylinder misfire', 'misfire'])
  }),
  P0171: Object.freeze({
    description: 'System too lean, bank 1',
    terms: Object.freeze(['system too lean', 'lean bank 1', 'bank 1 lean', 'fuel trim'])
  }),
  P0174: Object.freeze({
    description: 'System too lean, bank 2',
    terms: Object.freeze(['system too lean', 'lean bank 2', 'bank 2 lean', 'fuel trim'])
  }),
  P0420: Object.freeze({
    description: 'Catalyst system efficiency below threshold, bank 1',
    terms: Object.freeze(['catalyst efficiency', 'catalytic converter', 'catalyst monitor', 'bank 1 catalyst'])
  }),
  P0442: Object.freeze({
    description: 'Evaporative emission system small leak detected',
    terms: Object.freeze(['evap small leak', 'evaporative emission leak', 'small leak detected'])
  }),
  P0455: Object.freeze({
    description: 'Evaporative emission system gross/large leak detected',
    terms: Object.freeze(['evap large leak', 'evap gross leak', 'evaporative emission leak'])
  }),
  P2135: Object.freeze({
    description: 'Throttle/pedal position sensor voltage correlation fault',
    terms: Object.freeze(['throttle position sensor correlation', 'throttle position correlation', 'tp sensor correlation'])
  }),
  P2138: Object.freeze({
    description: 'Accelerator pedal position sensor voltage correlation fault',
    terms: Object.freeze(['accelerator pedal position correlation', 'pedal position sensor correlation', 'app sensor correlation'])
  })
});

const MAKE_SPECIFIC_DTC_CONTEXTS = Object.freeze({
  kia: Object.freeze({
    P1326: Object.freeze({
      description: 'Knock signal range/performance / knock-sensor detection context',
      terms: Object.freeze([
        'knock signal',
        'knock sensor',
        'knock sensor detection system',
        'ksds',
        'bearing clearance',
        'rod bearing'
      ])
    })
  }),
  hyundai: Object.freeze({
    P1326: Object.freeze({
      description: 'Knock signal range/performance / knock-sensor detection context',
      terms: Object.freeze([
        'knock signal',
        'knock sensor',
        'knock sensor detection system',
        'ksds',
        'bearing clearance',
        'rod bearing'
      ])
    })
  })
});

function clean(value) {
  return String(value || '').trim();
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripDtcs(value) {
  return clean(value)
    .replace(/\b[PCBU][0-9A-F]{4}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveDtcContext(code, vehicle = {}) {
  const normalizedCode = clean(code).toUpperCase();
  const make = normalizeText(vehicle.make || '');
  const makeSpecific = MAKE_SPECIFIC_DTC_CONTEXTS[make]?.[normalizedCode];
  const generic = GENERIC_DTC_CONTEXTS[normalizedCode];
  const entry = makeSpecific || generic;
  if (!entry) return null;
  return {
    code: normalizedCode,
    description: entry.description,
    terms: [...entry.terms],
    scope: makeSpecific ? `MAKE:${make.toUpperCase()}` : 'GENERIC'
  };
}

function buildDtcRetrievalIntent(vehicle = {}, query = '') {
  const originalQuery = clean(query);
  const dtcs = extractDtcs(originalQuery);
  const anchors = dtcs.map(code => resolveDtcContext(code, vehicle)).filter(Boolean);
  const resolvedCodes = new Set(anchors.map(anchor => anchor.code));
  const unresolvedDtcs = dtcs.filter(code => !resolvedCodes.has(code));
  const symptomQuery = stripDtcs(originalQuery);

  if (anchors.length) {
    // Symptoms refine a DTC search, but generic system words are intentionally not
    // promoted. This prevents broad words such as "engine" from qualifying an
    // unrelated page simply because a DTC also exists in the request.
    const symptomProfile = extractCanonicalProfile({ query: symptomQuery, symptoms: symptomQuery });
    const refiners = uniq([
      ...(symptomProfile.components || []),
      ...(symptomProfile.sounds || []),
      ...(symptomProfile.conditions || [])
    ]);
    const anchorTerms = uniq(anchors.flatMap(anchor => [anchor.code, ...anchor.terms]));
    return {
      mode: 'DTC_ANCHORED',
      originalQuery,
      dtcs,
      anchors,
      unresolvedDtcs,
      symptomQuery,
      refiners,
      searchQuery: uniq([...anchorTerms, ...refiners]).join(' ')
    };
  }

  return {
    mode: dtcs.length ? 'SYMPTOM_FALLBACK_UNRESOLVED_DTC' : 'SYMPTOM_FALLBACK',
    originalQuery,
    dtcs,
    anchors: [],
    unresolvedDtcs,
    symptomQuery,
    refiners: [],
    searchQuery: symptomQuery
  };
}

function phrasePresent(text, phrase) {
  const haystack = ` ${normalizeText(text)} `;
  const needle = normalizeText(phrase);
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(haystack);
}

function matchDtcAnchors(text, intent = {}) {
  if (intent.mode !== 'DTC_ANCHORED') {
    return { matched: true, matchedDtcs: [], matchedTerms: [], exactDtcs: [] };
  }

  const textDtcs = new Set(extractDtcs(text));
  const matchedDtcs = [];
  const exactDtcs = [];
  const matchedTerms = [];

  for (const anchor of intent.anchors || []) {
    const exact = textDtcs.has(anchor.code);
    const terms = (anchor.terms || []).filter(term => phrasePresent(text, term));
    if (exact || terms.length) {
      matchedDtcs.push(anchor.code);
      if (exact) exactDtcs.push(anchor.code);
      matchedTerms.push(...terms);
    }
  }

  return {
    matched: matchedDtcs.length > 0,
    matchedDtcs: uniq(matchedDtcs),
    exactDtcs: uniq(exactDtcs),
    matchedTerms: uniq(matchedTerms)
  };
}

function normalizeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(2));
}

function extractEngineSignals(value) {
  const text = clean(value).toLowerCase();
  const displacements = [];
  const cylinders = [];

  for (const match of text.matchAll(/\b(\d{1,2}(?:\.\d+)?)\s*(?:l|liters?|litres?)\b/gi)) {
    const displacement = normalizeNumber(match[1]);
    if (displacement !== null) displacements.push(displacement);
  }
  for (const match of text.matchAll(/\b(\d{1,2})\s*[- ]?cyl(?:inder)?s?\b/gi)) {
    cylinders.push(Number(match[1]));
  }
  for (const match of text.matchAll(/\bv\s*(3|4|5|6|8|10|12)\b/gi)) {
    cylinders.push(Number(match[1]));
  }

  return {
    displacements: uniq(displacements),
    cylinders: uniq(cylinders)
  };
}

function intersects(left = [], right = []) {
  const rightSet = new Set(right.map(String));
  return left.some(value => rightSet.has(String(value)));
}

function checkEngineApplicability(vehicle = {}, sourceText = '') {
  const requested = extractEngineSignals([vehicle.engine, vehicle.trim].filter(Boolean).join(' '));
  const candidate = extractEngineSignals(sourceText);

  const displacementConflict = requested.displacements.length > 0 &&
    candidate.displacements.length > 0 &&
    !intersects(requested.displacements, candidate.displacements);
  const cylinderConflict = requested.cylinders.length > 0 &&
    candidate.cylinders.length > 0 &&
    !intersects(requested.cylinders, candidate.cylinders);

  return {
    compatible: !displacementConflict && !cylinderConflict,
    requested,
    candidate,
    reason: displacementConflict
      ? `explicit displacement mismatch: requested ${requested.displacements.join('/')}L, source ${candidate.displacements.join('/')}L`
      : cylinderConflict
        ? `explicit cylinder-count mismatch: requested ${requested.cylinders.join('/')}, source ${candidate.cylinders.join('/')}`
        : null
  };
}

function annotateAnchoredItem(item, text, intent) {
  const match = matchDtcAnchors(text, intent);
  if (!match.matched) return null;
  return {
    ...item,
    matchedDtcs: match.matchedDtcs,
    matchedDtcTerms: match.matchedTerms
  };
}

function applyQuickAskRetrievalGuards(result = {}, vehicle = {}, intent = {}) {
  const telemetry = {
    manualEngineMismatchRejected: 0,
    manualDtcMismatchRejected: 0,
    tsbEngineMismatchRejected: 0,
    tsbDtcMismatchRejected: 0,
    confirmedRepairDtcMismatchRejected: 0
  };

  const manual = [];
  for (const item of result.repairDiagnosisEvidence || []) {
    // Use high-signal page identity for engine applicability. Snippets can mention
    // sibling variants and must not rescue an explicitly wrong page title/path.
    const identity = [item.title, item.headings, item.url].filter(Boolean).join(' ');
    if (!checkEngineApplicability(vehicle, identity).compatible) {
      telemetry.manualEngineMismatchRejected += 1;
      continue;
    }
    if (intent.mode === 'DTC_ANCHORED') {
      const anchored = annotateAnchoredItem(item, [identity, item.snippet, item.matchedKeywords].filter(Boolean).join(' '), intent);
      if (!anchored) {
        telemetry.manualDtcMismatchRejected += 1;
        continue;
      }
      manual.push(anchored);
    } else {
      manual.push(item);
    }
  }

  const tsbs = [];
  for (const item of result.publishedEvidence || []) {
    const text = [item.title, item.group_name, item.subject, item.body_text, item.bulletin_number].filter(Boolean).join(' ');
    if (!checkEngineApplicability(vehicle, text).compatible) {
      telemetry.tsbEngineMismatchRejected += 1;
      continue;
    }
    if (intent.mode === 'DTC_ANCHORED') {
      const anchored = annotateAnchoredItem(item, text, intent);
      if (!anchored) {
        telemetry.tsbDtcMismatchRejected += 1;
        continue;
      }
      tsbs.push(anchored);
    } else {
      tsbs.push(item);
    }
  }

  const repairs = [];
  for (const item of result.commonConfirmedRepairs || []) {
    if (intent.mode === 'DTC_ANCHORED') {
      const anchored = annotateAnchoredItem(item, item.cause, intent);
      if (!anchored) {
        telemetry.confirmedRepairDtcMismatchRejected += 1;
        continue;
      }
      repairs.push(anchored);
    } else {
      repairs.push(item);
    }
  }

  result.repairDiagnosisEvidence = manual;
  result.publishedEvidence = tsbs;
  result.commonConfirmedRepairs = repairs;
  result.confirmedRepairSampleSize = repairs.reduce((sum, item) => sum + Number(item.confirmedCases || 0), 0);
  result.retrievalTelemetry = {
    ...(result.retrievalTelemetry || {}),
    applicabilityGuard: telemetry
  };
  return result;
}

function publicIntent(intent = {}) {
  return {
    mode: intent.mode || 'SYMPTOM_FALLBACK',
    dtcs: (intent.dtcs || []).map(code => ({
      code,
      resolved: (intent.anchors || []).some(anchor => anchor.code === code),
      description: (intent.anchors || []).find(anchor => anchor.code === code)?.description || null
    })),
    unresolvedDtcs: [...(intent.unresolvedDtcs || [])],
    refiners: [...(intent.refiners || [])]
  };
}

module.exports = {
  GENERIC_DTC_CONTEXTS,
  MAKE_SPECIFIC_DTC_CONTEXTS,
  stripDtcs,
  resolveDtcContext,
  buildDtcRetrievalIntent,
  matchDtcAnchors,
  extractEngineSignals,
  checkEngineApplicability,
  applyQuickAskRetrievalGuards,
  publicIntent
};
