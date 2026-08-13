const TRIGGER_PATTERNS = [
  {
    key: 'deceleration',
    patterns: [
      /\breleas(?:e|ed|ing)\s+(?:the\s+)?(?:gas|accelerator|throttle)\b/i,
      /\b(?:gas|accelerator|throttle)\s+(?:is|was|gets?|got)\s+releas(?:ed|ing)\b/i,
      /\blet(?:ting)?\s+off\s+(?:the\s+)?(?:gas|accelerator|throttle)\b/i,
      /\blift(?:ing)?\s+off\s+(?:the\s+)?(?:gas|accelerator|throttle)\b/i,
      /\bdeceler(?:ate|ating|ation)\b/i,
      /\bcoast(?:ing)?\b/i
    ]
  },
  {
    key: 'acceleration',
    patterns: [
      /\baccelerat(?:e|ing|ion)\b/i,
      /\b(?:press|step|push)(?:ing)?\s+(?:on\s+)?(?:the\s+)?(?:gas|accelerator|throttle)\b/i,
      /\bunder\s+(?:hard\s+)?throttle\b/i
    ]
  },
  {
    key: 'turning',
    patterns: [
      /\bfull[- ]?(?:lock|turn)\b/i,
      /\bturn(?:ing)?\s+(?:left|right)\b/i,
      /\bwhile\s+turning\b/i,
      /\bwhen\s+turning\b/i,
      /\bsteer(?:ing)?\s+(?:left|right)\b/i,
      /\bwhile\s+steer(?:ing)?\b/i,
      /\bwhen\s+steer(?:ing)?\b/i,
      /\block[- ]to[- ]lock\b/i
    ]
  },
  {
    key: 'braking',
    patterns: [
      /\bbrak(?:e|ing)\b/i,
      /\bbrake\s+pedal\b/i,
      /\b(?:press|apply|step)(?:ing|ied)?\s+(?:on\s+)?(?:the\s+)?brake(?:\s+pedal)?\b/i,
      /\bunder\s+braking\b/i
    ]
  },
  {
    key: 'road_impact',
    patterns: [
      /\bhit(?:ting)?\s+(?:a\s+)?(?:bump|pothole)\b/i,
      /\bover\s+(?:a\s+)?(?:bump|pothole|rough road)\b/i,
      /\bon\s+rough\s+roads?\b/i
    ]
  }
];

const CANONICAL_TRIGGER_ALIASES = {
  deceleration: [
    'deceleration', 'decelerating', 'throttle released', 'accelerator released',
    'gas released', 'lift off throttle', 'coasting', 'coast down'
  ],
  acceleration: [
    'acceleration', 'accelerating', 'under throttle', 'on throttle', 'under load'
  ],
  turning: [
    'turning', 'full steering turn', 'full lock', 'steering lock', 'lock to lock',
    'turning left', 'turning right', 'steering left', 'steering right'
  ],
  braking: [
    'braking', 'brake applied', 'brake pedal applied', 'under braking'
  ],
  road_impact: [
    'road impact', 'bump impact', 'pothole', 'rough road'
  ]
};

function clean(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function detectRawTriggers(customerComplaint = '') {
  const found = [];
  for (const trigger of TRIGGER_PATTERNS) {
    if (trigger.patterns.some(pattern => pattern.test(customerComplaint))) found.push(trigger.key);
  }
  return found;
}

function collectCanonicalObservationText(canonicalData = {}) {
  const observations = Array.isArray(canonicalData.observations) ? canonicalData.observations : [];
  const values = [];

  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') continue;
    values.push(observation.trigger, observation.subject);
    if (Array.isArray(observation.operating_conditions)) values.push(...observation.operating_conditions);
    else values.push(observation.operating_conditions);

    const steeringState = observation.load_state?.steering?.state;
    if (steeringState) values.push(steeringState);
  }

  return values.filter(Boolean).map(clean);
}

function detectCanonicalTriggers(canonicalData = {}) {
  const values = collectCanonicalObservationText(canonicalData);
  const found = [];

  for (const [key, aliases] of Object.entries(CANONICAL_TRIGGER_ALIASES)) {
    const normalizedAliases = aliases.map(clean);
    if (values.some(value => normalizedAliases.some(alias => value === alias || value.includes(alias)))) {
      found.push(key);
    }
  }

  return found;
}

function assertTriggerSurvival(customerComplaint = '', canonicalData = {}) {
  const rawTriggers = detectRawTriggers(customerComplaint);
  const canonicalTriggers = detectCanonicalTriggers(canonicalData);
  const missingTriggers = rawTriggers.filter(trigger => !canonicalTriggers.includes(trigger));

  return {
    valid: missingTriggers.length === 0,
    rawTriggers,
    canonicalTriggers,
    missingTriggers
  };
}

module.exports = {
  TRIGGER_PATTERNS,
  detectRawTriggers,
  detectCanonicalTriggers,
  assertTriggerSurvival
};
