#!/usr/bin/env node
/**
 * Head-to-head comparison: llama-3.3-70b-versatile vs openai/gpt-oss-20b
 * using the live diagnose prompt and the Kia Sorento multi-condition case.
 *
 * CLI: GROQ_API_KEY=your_key node scripts/compare-diagnose-models.js
 * Also exports runComparison() so Render can execute the exact same test
 * with its existing GROQ_API_KEY without exposing that secret.
 */

const Groq = require('groq-sdk');

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

async function runModel(groq, model) {
  const started = Date.now();
  const res = await groq.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.15,
    max_tokens: 1500,
    response_format: { type: 'json_object' }
  });

  const content = res?.choices?.[0]?.message?.content || '';
  let parsed = null;
  let parseError = null;
  try { parsed = JSON.parse(content); } catch (e) { parseError = e.message; }

  return {
    model,
    latencyMs: Date.now() - started,
    finishReason: res?.choices?.[0]?.finish_reason || null,
    usage: res?.usage || null,
    parsed,
    parseError,
    content
  };
}

async function runComparison(apiKey = process.env.GROQ_API_KEY) {
  if (!apiKey) throw new Error('GROQ_API_KEY is not configured.');
  const groq = new Groq({ apiKey });

  const llama = await runModel(groq, 'llama-3.3-70b-versatile').catch(e => ({ model: 'llama-3.3-70b-versatile', error: e.message }));
  const oss = await runModel(groq, 'openai/gpt-oss-20b').catch(e => ({ model: 'openai/gpt-oss-20b', error: e.message }));

  return {
    generatedAt: new Date().toISOString(),
    testCase: '2008 Kia Sorento: clunk on deceleration and full steering lock; CV axles, lower ball joints, upper control-arm/ball-joint assemblies already replaced',
    models: [llama, oss]
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

module.exports = { runComparison, systemPrompt, userPrompt };
