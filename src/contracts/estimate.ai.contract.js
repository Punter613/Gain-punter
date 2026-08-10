const SCHEMA_VERSION = 'estimate-ai-v1';

const ESTIMATE_AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'priority',
    'diagnosis',
    'estimatedHours',
    'candidates',
    'repairActions',
    'repairSteps',
    'proTips',
    'additionalChecks',
    'notes'
  ],
  properties: {
    priority: { type: 'string', enum: ['high', 'medium', 'low'] },
    diagnosis: { type: 'string' },
    estimatedHours: { type: 'number', minimum: 0, maximum: 40 },
    candidates: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'cause',
          'component',
          'modelConfidence',
          'evidenceRefs',
          'contradictions',
          'confirmationTests',
          'evidenceClass',
          'factorySupported',
          'mechanicSupported',
          'measuredSupported',
          'confirmationRequired',
          'confirmed',
          'repairAuthorized'
        ],
        properties: {
          cause: { type: 'string' },
          component: { type: 'string' },
          modelConfidence: { type: 'integer', minimum: 0, maximum: 100 },
          evidenceRefs: {
            type: 'array',
            maxItems: 12,
            items: { type: 'string' }
          },
          contradictions: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string' }
          },
          confirmationTests: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: { type: 'string' }
          },
          evidenceClass: {
            type: 'string',
            enum: [
              'MEASURED_FACT',
              'OEM_TSB',
              'MECHANIC_OBSERVATION',
              'CUSTOMER_STATEMENT',
              'MODEL_INFERENCE',
              'MIXED'
            ]
          },
          factorySupported: { type: 'boolean' },
          mechanicSupported: { type: 'boolean' },
          measuredSupported: { type: 'boolean' },
          confirmationRequired: { type: 'boolean' },
          confirmed: { type: 'boolean' },
          repairAuthorized: { type: 'boolean' }
        }
      }
    },
    repairActions: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'action',
          'component',
          'evidenceRefs',
          'confirmationRequired',
          'repairAuthorized'
        ],
        properties: {
          action: { type: 'string' },
          component: { type: 'string' },
          evidenceRefs: {
            type: 'array',
            maxItems: 12,
            items: { type: 'string' }
          },
          confirmationRequired: { type: 'boolean' },
          repairAuthorized: { type: 'boolean' }
        }
      }
    },
    repairSteps: {
      type: 'array',
      maxItems: 10,
      items: { type: 'string' }
    },
    proTips: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tip', 'evidenceRefs', 'factorySupported'],
        properties: {
          tip: { type: 'string' },
          evidenceRefs: {
            type: 'array',
            maxItems: 12,
            items: { type: 'string' }
          },
          factorySupported: { type: 'boolean' }
        }
      }
    },
    additionalChecks: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string' }
    },
    notes: { type: 'string' }
  }
};

const ESTIMATE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'sksk_estimate_reasoning',
    strict: true,
    schema: ESTIMATE_AI_SCHEMA
  }
};

const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'under', 'during',
  'front', 'rear', 'left', 'right', 'upper', 'lower', 'vehicle', 'system', 'assembly',
  'component', 'hardware', 'worn', 'loose', 'failed', 'damaged', 'failure', 'fault',
  'issue', 'causing', 'cause', 'check', 'inspect', 'replace', 'mounting'
]);

function clean(value) {
  return String(value || '').trim();
}

function textOfFacts(facts) {
  try {
    return typeof facts === 'string' ? facts : JSON.stringify(facts || {});
  } catch (_) {
    return '';
  }
}

function buildEvidenceLedger({
  oemReferences = [],
  relevantTsbs = [],
  customerStates = [],
  mechanicNotices = [],
  obdCodes = [],
  diagnosticTests = []
} = {}) {
  const ledger = [];

  oemReferences.forEach((ref, index) => {
    ledger.push({
      id: `OEM_${String(index + 1).padStart(3, '0')}`,
      type: 'OEM_FACTORY',
      title: clean(ref.title),
      url: clean(ref.url),
      text: [ref.title, textOfFacts(ref.extractedFacts)].filter(Boolean).join(' '),
      facts: ref.extractedFacts || {}
    });
  });

  relevantTsbs.forEach((ref, index) => {
    ledger.push({
      id: `TSB_${String(index + 1).padStart(3, '0')}`,
      type: 'TSB',
      title: clean(ref.title || ref.subject),
      url: clean(ref.url),
      text: [ref.title, ref.subject, ref.groupName, textOfFacts(ref.extractedFacts)].filter(Boolean).join(' '),
      facts: ref.extractedFacts || {}
    });
  });

  mechanicNotices.forEach((value, index) => {
    const text = clean(value);
    if (text) ledger.push({ id: `MECH_${String(index + 1).padStart(3, '0')}`, type: 'MECHANIC_OBSERVATION', text });
  });

  customerStates.forEach((value, index) => {
    const text = clean(value);
    if (text) ledger.push({ id: `CUST_${String(index + 1).padStart(3, '0')}`, type: 'CUSTOMER_STATEMENT', text });
  });

  obdCodes.forEach((value, index) => {
    const text = clean(value).toUpperCase();
    if (text) ledger.push({ id: `CODE_${String(index + 1).padStart(3, '0')}`, type: 'MEASURED_FACT', text });
  });

  diagnosticTests.forEach((test, index) => {
    const text = clean(typeof test === 'string' ? test : [test?.component, test?.test, test?.result, test?.interpretation].filter(Boolean).join(' | '));
    if (text) ledger.push({ id: `TEST_${String(index + 1).padStart(3, '0')}`, type: 'MEASURED_FACT', text });
  });

  return ledger;
}

function compactLedgerForModel(ledger = []) {
  return ledger.map(ref => ({
    id: ref.id,
    type: ref.type,
    ...(ref.title ? { title: ref.title } : {}),
    ...(ref.url ? { url: ref.url } : {}),
    text: clean(ref.text).slice(0, 5000),
    ...(ref.facts ? { facts: ref.facts } : {})
  }));
}

function claimTokens(candidate = {}) {
  const text = `${clean(candidate.component)} ${clean(candidate.cause)}`.toLowerCase();
  return [...new Set(text.split(/[^a-z0-9]+/).filter(token => token.length >= 3 && !STOP_TOKENS.has(token)))];
}

function referenceSupportsCandidate(reference, candidate) {
  const refText = clean(reference?.text).toLowerCase();
  if (!refText) return false;

  const codeMatches = `${clean(candidate?.component)} ${clean(candidate?.cause)}`.toUpperCase().match(/\b[BCPU][0-9A-F]{4}\b/g) || [];
  if (codeMatches.some(code => refText.toUpperCase().includes(code))) return true;

  const tokens = claimTokens(candidate);
  if (!tokens.length) return false;
  const overlap = tokens.filter(token => refText.includes(token));
  const threshold = tokens.length >= 3 ? 3 : Math.min(2, tokens.length);
  return overlap.length >= threshold;
}

function safeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function deriveEvidenceClass({ measuredSupported, factorySupported, mechanicSupported, customerSupported }) {
  const active = [measuredSupported, factorySupported, mechanicSupported, customerSupported].filter(Boolean).length;
  if (active > 1) return 'MIXED';
  if (measuredSupported) return 'MEASURED_FACT';
  if (factorySupported) return 'OEM_TSB';
  if (mechanicSupported) return 'MECHANIC_OBSERVATION';
  if (customerSupported) return 'CUSTOMER_STATEMENT';
  return 'MODEL_INFERENCE';
}

function confidenceCap({ confirmed, measuredSupported, factorySupported, mechanicSupported, customerSupported, contradictions }) {
  let cap = 45;
  if (customerSupported) cap = Math.max(cap, 45);
  if (mechanicSupported) cap = Math.max(cap, 65);
  if (factorySupported) cap = Math.max(cap, 80);
  if (measuredSupported) cap = Math.max(cap, 85);
  if (confirmed && measuredSupported) cap = factorySupported ? 95 : 90;
  const penalty = Math.min(30, (Array.isArray(contradictions) ? contradictions.length : 0) * 10);
  return Math.max(20, cap - penalty);
}

function evaluateCandidates(candidates = [], ledger = []) {
  const byId = new Map(ledger.map(ref => [ref.id, ref]));

  return candidates.slice(0, 6).map((candidate, index) => {
    const requestedRefs = Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs.map(clean).filter(Boolean) : [];
    const validRefs = [...new Set(requestedRefs.filter(id => byId.has(id)))];
    const invalidEvidenceRefs = [...new Set(requestedRefs.filter(id => !byId.has(id)))];
    const supportingRefs = validRefs
      .map(id => byId.get(id))
      .filter(ref => referenceSupportsCandidate(ref, candidate));

    const measuredSupported = supportingRefs.some(ref => ref.type === 'MEASURED_FACT');
    const factorySupported = supportingRefs.some(ref => ref.type === 'OEM_FACTORY' || ref.type === 'TSB');
    const mechanicSupported = supportingRefs.some(ref => ref.type === 'MECHANIC_OBSERVATION');
    const customerSupported = supportingRefs.some(ref => ref.type === 'CUSTOMER_STATEMENT');

    // A model assertion is not a confirmation. Confirmation only survives when a measured/test
    // reference actually supports the candidate.
    const confirmed = candidate.confirmed === true && measuredSupported;
    const repairAuthorized = candidate.repairAuthorized === true && confirmed;
    const contradictions = Array.isArray(candidate.contradictions) ? candidate.contradictions.map(clean).filter(Boolean).slice(0, 8) : [];
    const cap = confidenceCap({ confirmed, measuredSupported, factorySupported, mechanicSupported, customerSupported, contradictions });
    const modelConfidence = safeConfidence(candidate.modelConfidence);

    return {
      rank: index + 1,
      cause: clean(candidate.cause) || 'Unspecified candidate',
      component: clean(candidate.component) || 'Unspecified component',
      modelConfidence,
      finalConfidence: Math.min(modelConfidence, cap),
      confidenceCap: cap,
      evidenceRefs: validRefs,
      invalidEvidenceRefs,
      supportingEvidenceRefs: supportingRefs.map(ref => ref.id),
      evidenceClass: deriveEvidenceClass({ measuredSupported, factorySupported, mechanicSupported, customerSupported }),
      factorySupported,
      mechanicSupported,
      measuredSupported,
      customerSupported,
      confirmationRequired: !confirmed,
      confirmed,
      repairAuthorized,
      contradictions,
      confirmationTests: Array.isArray(candidate.confirmationTests)
        ? candidate.confirmationTests.map(clean).filter(Boolean).slice(0, 8)
        : []
    };
  });
}

function normalizedPercentages(values = []) {
  if (!values.length) return [];
  const safe = values.map(value => Math.max(0, Number(value) || 0));
  const total = safe.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    const base = Math.floor(100 / safe.length);
    const out = safe.map(() => base);
    for (let i = 0; i < 100 - base * safe.length; i++) out[i] += 1;
    return out;
  }

  const raw = safe.map(value => (value / total) * 100);
  const out = raw.map(Math.floor);
  let remaining = 100 - out.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; i < remaining; i++) out[order[i % order.length].index] += 1;
  return out;
}

function sanitizeHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(40, Math.round(n * 4) / 4));
}

function buildFinalEstimate(ai = {}, context = {}) {
  const candidates = evaluateCandidates(ai.candidates || [], context.ledger || []);
  const displayLikelihoods = normalizedPercentages(candidates.map(candidate => candidate.finalConfidence));
  const probability = candidates.map((candidate, index) => ({
    cause: candidate.cause,
    likelihood: displayLikelihoods[index] || 0
  }));

  const estimatedHours = sanitizeHours(ai.estimatedHours);
  const laborRate = Math.max(0, Number(context.laborRate) || 0);
  const partsCost = Math.max(0, Number(context.partsCost) || 0);
  const rustMultiplier = Math.max(0, Number(context.rustMultiplier) || 1);
  const laborCost = Math.round(estimatedHours * laborRate * rustMultiplier * 100) / 100;
  const total = Math.round((laborCost + partsCost) * 100) / 100;

  const authorizedComponents = new Set(candidates.filter(candidate => candidate.repairAuthorized).map(candidate => candidate.component.toLowerCase()));
  const proposedActions = Array.isArray(ai.repairActions) ? ai.repairActions : [];
  const repairs = proposedActions
    .filter(action => {
      const component = clean(action?.component).toLowerCase();
      return action?.repairAuthorized === true && [...authorizedComponents].some(value => component.includes(value) || value.includes(component));
    })
    .map(action => clean(action.action))
    .filter(Boolean)
    .slice(0, 6);

  const confirmationSteps = candidates
    .flatMap(candidate => candidate.confirmationTests.map(test => `${candidate.component}: ${test}`))
    .filter(Boolean)
    .slice(0, 8);

  const repairSteps = repairs.length
    ? (Array.isArray(ai.repairSteps) ? ai.repairSteps.map(clean).filter(Boolean).slice(0, 10) : [])
    : confirmationSteps;

  const finalRepairs = repairs.length
    ? repairs
    : ['Perform targeted confirmation tests before replacement'];

  const proTips = (Array.isArray(ai.proTips) ? ai.proTips : [])
    .map(item => clean(item?.tip))
    .filter(Boolean)
    .slice(0, 6);

  const directFactoryCount = candidates.filter(candidate => candidate.factorySupported).length;
  const modelInferenceCount = candidates.filter(candidate => candidate.evidenceClass === 'MODEL_INFERENCE').length;

  return {
    priority: ['high', 'medium', 'low'].includes(ai.priority) ? ai.priority : 'medium',
    diagnosis: clean(ai.diagnosis) || 'Manual inspection required',
    estimatedHours,
    laborCost,
    partsCost,
    total,
    repairs: finalRepairs,
    probability,
    repairSteps,
    proTips,
    additionalChecks: Array.isArray(ai.additionalChecks) ? ai.additionalChecks.map(clean).filter(Boolean).slice(0, 8) : [],
    notes: clean(ai.notes),
    candidates,
    validation: {
      schemaVersion: SCHEMA_VERSION,
      probabilityNormalized: probability.reduce((sum, item) => sum + Number(item.likelihood || 0), 0) === 100,
      mechanicOwnedPricing: true,
      repairAuthorizationRequired: true,
      factorySupportedCandidateCount: directFactoryCount,
      modelInferenceCandidateCount: modelInferenceCount
    }
  };
}

module.exports = {
  SCHEMA_VERSION,
  ESTIMATE_AI_SCHEMA,
  ESTIMATE_RESPONSE_FORMAT,
  buildEvidenceLedger,
  compactLedgerForModel,
  referenceSupportsCandidate,
  evaluateCandidates,
  normalizedPercentages,
  buildFinalEstimate
};
