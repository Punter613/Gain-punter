#!/usr/bin/env node
/**
 * Repeatability harness: runs the SAME real test case N times per
 * (model, mode) combination and scores how stable the output is.
 *
 * Motivated directly by a real finding from the single-shot comparison:
 * gpt-oss-120b flipped safetyRisk (true -> false) and urgency
 * (immediate -> soon) between json_object and json_schema mode on an
 * IDENTICAL input. safetyRisk drives a user-visible "do not drive"
 * banner in the app - a single run isn't enough evidence to trust
 * either mode's safety call. This measures whether that instability is
 * a real pattern or was a one-off sample.
 *
 * Run: GROQ_API_KEY=your_key node scripts/repeatability-harness.js
 * Optional: RUNS_PER_COMBO=5 to reduce from the default 10 (faster,
 * cheaper, less statistically solid).
 *
 * Standalone script, not required by any live route.
 */

const Groq = require('groq-sdk');

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error('Set GROQ_API_KEY first: GROQ_API_KEY=your_key node scripts/repeatability-harness.js');
  process.exit(1);
}

const groq = new Groq({ apiKey });
const RUNS_PER_COMBO = Number(process.env.RUNS_PER_COMBO || 10);

// Current live system prompt from src/routes/diagnose.js, including the
// strengthened KNOWN ISSUES / VEHICLE-SPECIFIC CLAIMS rule.
const systemPrompt = `You are the expert diagnostic logic unit of SKSK ProTech — a master automotive diagnostician with 25 years of real shop experience.
Output a single valid JSON object ONLY. No backticks, markdown, or text before/after.
{
 "urgency":"immediate|soon|monitor","safetyRisk":false,"primaryCause":"string","secondaryCauses":["string"],
 "codeExplanations":{"P0300":"string"},"probability":[{"cause":"string","likelihood":80}],
 "knownIssues":["string"],"repairSteps":["string"],"proTips":["string"],"recommendedTests":["string"],
 "additionalChecks":["string"],"estimatedRepairTime":"string","notes":"string"
}
RULES:
- urgency exactly immediate, soon, or monitor. safetyRisk true only if driving the vehicle as-is risks loss of control, fire, or injury.
- codeExplanations must cover every OBD code provided, keyed exactly as given (e.g. "P0300").
- probability likelihoods should roughly sum to 100 across all listed causes; rank by evidence, not by which symptom was mentioned first.
- All array values must be strings.
- Never invent a TSB number, recall number, or campaign number — omit rather than fabricate.
- KNOWN ISSUES / VEHICLE-SPECIFIC CLAIMS: never state that a condition is common, known, frequent, or specific to this model/year/manufacturer unless that claim is directly supported by evidence actually supplied in this prompt. Do not rely on general model memory for knownIssues. If no supplied evidence supports a known-issue claim, return knownIssues as an empty array rather than writing a plausible-sounding one.
- Never recommend replacing a component the mechanic notes already replaced.
MULTI-CONDITION REASONING: When the same symptom occurs under two or more distinct operating conditions (e.g. deceleration AND full steering lock, or cold-start AND hard acceleration), analyze what changes mechanically in each condition, then prioritize causes plausible under ALL the reported conditions over causes that only fit one. Consider three hypotheses: (1) one component explains every occurrence, (2) different components in the same system produce a similar-sounding reaction, (3) two unrelated faults happen to sound alike. Use the overlap between conditions to narrow the diagnostic tree rather than anchoring on the most obvious single-condition match.
- Output raw JSON only.`;

const userPrompt = `Vehicle: KIA Sorento | VIN: KNDJC736385765089 | Mileage: N/A | Codes: P0300, P0171 | Symptoms: Loud audible clunking noise upon deceleration and full steering wheel rotation, possibly indicating a loose or worn-out component in the steering or suspension system, such as a ball joint or tie rod end | Tech Notes: Already replaced both cv axles replaced the lower ball joints on both front and the upper control arm ball joint assembly on both front | Technical Keywords: deceleration clunk, full-lock steering noise, ball joint, tie rod end`;

const codes = ['P0300', 'P0171'];

// Dynamic per-code strict schema, as discussed — no hardcoded master
// OBD code list, generated from whatever codes are actually in the case.
function buildStrictSchema(codeList) {
  const codeProperties = Object.fromEntries(codeList.map(c => [c, { type: 'string' }]));
  return {
    type: 'json_schema',
    json_schema: {
      name: 'diagnostic_output',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          urgency: { type: 'string', enum: ['immediate', 'soon', 'monitor'] },
          safetyRisk: { type: 'boolean' },
          primaryCause: { type: 'string' },
          secondaryCauses: { type: 'array', items: { type: 'string' } },
          codeExplanations: {
            type: 'object',
            properties: codeProperties,
            required: codeList,
            additionalProperties: false
          },
          probability: {
            type: 'array',
            items: {
              type: 'object',
              properties: { cause: { type: 'string' }, likelihood: { type: 'number' } },
              required: ['cause', 'likelihood'],
              additionalProperties: false
            }
          },
          knownIssues: { type: 'array', items: { type: 'string' } },
          repairSteps: { type: 'array', items: { type: 'string' } },
          proTips: { type: 'array', items: { type: 'string' } },
          recommendedTests: { type: 'array', items: { type: 'string' } },
          additionalChecks: { type: 'array', items: { type: 'string' } },
          estimatedRepairTime: { type: 'string' },
          notes: { type: 'string' }
        },
        required: [
          'urgency', 'safetyRisk', 'primaryCause', 'secondaryCauses', 'codeExplanations',
          'probability', 'knownIssues', 'repairSteps', 'proTips', 'recommendedTests',
          'additionalChecks', 'estimatedRepairTime', 'notes'
        ],
        additionalProperties: false
      }
    }
  };
}

async function runOnce(model, mode) {
  const response_format = mode === 'json_schema'
    ? buildStrictSchema(codes)
    : { type: 'json_object' };

  const started = Date.now();
  try {
    const res = await groq.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.15,
      max_tokens: 1800,
      reasoning_effort: 'low',
      response_format
    });
    const latencyMs = Date.now() - started;
    const content = res?.choices?.[0]?.message?.content || '';
    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      parseError = e.message;
    }
    return { model, mode, latencyMs, finishReason: res?.choices?.[0]?.finish_reason, parsed, parseError };
  } catch (e) {
    return { model, mode, latencyMs: Date.now() - started, requestError: e.message };
  }
}

function mode_(arr) {
  const counts = {};
  arr.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  let best = null, bestCount = -1;
  for (const [v, c] of Object.entries(counts)) {
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return { value: best, count: bestCount, distribution: counts };
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stdev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
}

async function scoreCombo(model, mode) {
  console.log(`\n--- ${model} / ${mode}: running ${RUNS_PER_COMBO}x ---`);
  const runs = [];
  for (let i = 0; i < RUNS_PER_COMBO; i++) {
    const r = await runOnce(model, mode);
    process.stdout.write(r.parseError || r.requestError ? 'x' : '.');
    runs.push(r);
  }
  console.log('');

  const ok = runs.filter(r => r.parsed && !r.parseError && !r.requestError);
  const schemaFailures = runs.length - ok.length;

  const safetyRisks = ok.map(r => String(r.parsed.safetyRisk));
  const urgencies = ok.map(r => r.parsed.urgency);
  const primaryCauses = ok.map(r => r.parsed.primaryCause);
  const knownIssuesNonEmpty = ok.filter(r => Array.isArray(r.parsed.knownIssues) && r.parsed.knownIssues.length > 0).length;
  const latencies = ok.map(r => r.latencyMs);

  return {
    model,
    mode,
    totalRuns: runs.length,
    schemaFailures,
    safetyRiskDistribution: mode_(safetyRisks),
    urgencyDistribution: mode_(urgencies),
    primaryCauseDistribution: mode_(primaryCauses),
    knownIssuesNonEmptyRate: ok.length ? `${knownIssuesNonEmpty}/${ok.length}` : 'n/a',
    latency: ok.length ? { meanMs: Math.round(mean(latencies)), stdevMs: Math.round(stdev(latencies)), minMs: Math.min(...latencies), maxMs: Math.max(...latencies) } : null
  };
}

(async () => {
  const combos = [
    ['openai/gpt-oss-20b', 'json_object'],
    ['openai/gpt-oss-20b', 'json_schema'],
    ['openai/gpt-oss-120b', 'json_object'],
    ['openai/gpt-oss-120b', 'json_schema']
  ];

  const results = [];
  for (const [model, mode] of combos) {
    results.push(await scoreCombo(model, mode));
  }

  console.log('\n\n=== SUMMARY ===');
  for (const r of results) {
    console.log(`\n${r.model} / ${r.mode}`);
    console.log(`  schema failures: ${r.schemaFailures}/${r.totalRuns}`);
    console.log(`  safetyRisk:  ${JSON.stringify(r.safetyRiskDistribution.distribution)} (majority: ${r.safetyRiskDistribution.value}, ${r.safetyRiskDistribution.count}/${r.totalRuns - r.schemaFailures})`);
    console.log(`  urgency:     ${JSON.stringify(r.urgencyDistribution.distribution)}`);
    console.log(`  primaryCause majority: "${r.primaryCauseDistribution.value}" (${r.primaryCauseDistribution.count}/${r.totalRuns - r.schemaFailures} runs agreed)`);
    console.log(`  knownIssues non-empty: ${r.knownIssuesNonEmptyRate} (post-fix, this should trend toward 0 since no evidence is supplied)`);
    if (r.latency) console.log(`  latency: mean=${r.latency.meanMs}ms stdev=${r.latency.stdevMs}ms range=[${r.latency.minMs}, ${r.latency.maxMs}]`);
  }
})();
