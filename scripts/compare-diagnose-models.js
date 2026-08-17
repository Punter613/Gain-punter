#!/usr/bin/env node
/**
 * Head-to-head: openai/gpt-oss-20b vs openai/gpt-oss-120b.
 * Each model runs once with json_object and once with strict json_schema.
 * The prompt, test case, temperature, reasoning effort, and token budget are
 * intentionally unchanged from Round 1 so Round 2 remains directly comparable.
 */

const Groq = require('groq-sdk');
const { buildDiagnoseJsonSchema } = require('../src/services/ai/diagnose.schema');

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
- Never recommend replacing a component the mechanic notes already replaced.
MULTI-CONDITION REASONING: When the same symptom occurs under two or more distinct operating conditions (e.g. deceleration AND full steering lock, or cold-start AND hard acceleration), analyze what changes mechanically in each condition, then prioritize causes plausible under ALL the reported conditions over causes that only fit one. Consider three hypotheses: (1) one component explains every occurrence, (2) different components in the same system produce a similar-sounding reaction, (3) two unrelated faults happen to sound alike. Use the overlap between conditions to narrow the diagnostic tree rather than anchoring on the most obvious single-condition match.
- Output raw JSON only.`;

const userPrompt = `Vehicle: KIA Sorento | VIN: KNDJC736385765089 | Mileage: N/A | Codes: P0300, P0171 | Symptoms: Loud audible clunking noise upon deceleration and full steering wheel rotation, possibly indicating a loose or worn-out component in the steering or suspension system, such as a ball joint or tie rod end | Tech Notes: Already replaced both cv axles replaced the lower ball joints on both front and the upper control arm ball joint assembly on both front | Technical Keywords: deceleration clunk, full-lock steering noise, ball joint, tie rod end`;

// The benchmark and production provider path share one canonical semantic
// contract. The fixed benchmark case supplies its real DTCs here; production
// derives the same per-code keys from DIAGNOSTIC_EVIDENCE_PACKET_V1.
const diagnosisJsonSchema = buildDiagnoseJsonSchema(
  ['P0300', 'P0171'],
  'diagnostic_output'
);

async function runModel(groq, model, mode) {
  const started = Date.now();
  const response_format = mode === 'json_schema'
    ? { type: 'json_schema', json_schema: diagnosisJsonSchema }
    : { type: 'json_object' };

  let res;
  let requestError = null;
  try {
    res = await groq.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.15,
      max_tokens: 2500,
      reasoning_effort: 'low',
      response_format
    });
  } catch (e) {
    requestError = e.message;
  }

  const latencyMs = Date.now() - started;
  if (requestError) return { model, mode, latencyMs, requestError };

  const content = res?.choices?.[0]?.message?.content || '';
  let parsed = null;
  let parseError = null;
  try { parsed = JSON.parse(content); } catch (e) { parseError = e.message; }

  let schemaFieldsPresent = null;
  if (mode === 'json_schema' && parsed) {
    schemaFieldsPresent = diagnosisJsonSchema.schema.required.every(k => k in parsed);
  }

  return {
    model,
    mode,
    latencyMs,
    finishReason: res?.choices?.[0]?.finish_reason || null,
    usage: res?.usage || null,
    parsed,
    parseError,
    schemaFieldsPresent,
    contentLength: content.length,
    content
  };
}

async function runComparison(apiKey = process.env.GROQ_API_KEY) {
  if (!apiKey) throw new Error('GROQ_API_KEY is not configured.');
  const groq = new Groq({ apiKey });
  const models = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];
  const modes = ['json_object', 'json_schema'];
  const results = [];

  for (const model of models) {
    for (const mode of modes) {
      const result = await runModel(groq, model, mode)
        .catch(e => ({ model, mode, error: e.message }));
      results.push(result);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    testCase: '2008 Kia Sorento: clunk on deceleration and full steering lock; CV axles, lower ball joints, upper control-arm/ball-joint assemblies already replaced',
    note: 'Round 2: strict schema corrected for the fixed P0300/P0171 benchmark case.',
    results
  };
}

async function cli() {
  const result = await runComparison();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  cli().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { runComparison, systemPrompt, userPrompt, diagnosisJsonSchema };
