#!/usr/bin/env node
/**
 * Head-to-head comparison: llama-3.3-70b-versatile vs openai/gpt-oss-20b
 * on diagnose.js's real system prompt and a real test case (the Kia
 * Sorento clunk-on-deceleration-and-full-lock-steering scenario we've
 * been testing all session).
 *
 * Run: GROQ_API_KEY=your_key node scripts/compare-diagnose-models.js
 *
 * This is a standalone test script - not part of the live app, not
 * required by any route. Safe to delete after comparing results.
 */

const Groq = require('groq-sdk');

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error('Set GROQ_API_KEY first: GROQ_API_KEY=your_key node scripts/compare-diagnose-models.js');
  process.exit(1);
}

const groq = new Groq({ apiKey });

// Exact system prompt currently live in src/routes/diagnose.js as of the
// fix/diagnose-prompt-and-multicondition-reasoning branch.
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

// Real test case - the exact scenario tested repeatedly this session.
const userPrompt = `Vehicle: KIA Sorento | VIN: KNDJC736385765089 | Mileage: N/A | Codes: P0300, P0171 | Symptoms: Loud audible clunking noise upon deceleration and full steering wheel rotation, possibly indicating a loose or worn-out component in the steering or suspension system, such as a ball joint or tie rod end | Tech Notes: Already replaced both cv axles replaced the lower ball joints on both front and the upper control arm ball joint assembly on both front | Technical Keywords: deceleration clunk, full-lock steering noise, ball joint, tie rod end`;

async function run(model) {
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
  const latencyMs = Date.now() - started;
  const content = res?.choices?.[0]?.message?.content || '';
  const finishReason = res?.choices?.[0]?.finish_reason;
  return { model, latencyMs, finishReason, content };
}

(async () => {
  console.log('=== Running llama-3.3-70b-versatile ===');
  const llama = await run('llama-3.3-70b-versatile').catch(e => ({ error: e.message }));
  console.log(JSON.stringify(llama, null, 2));

  console.log('\n=== Running openai/gpt-oss-20b ===');
  const ossResult = await run('openai/gpt-oss-20b').catch(e => ({ error: e.message }));
  console.log(JSON.stringify(ossResult, null, 2));

  console.log('\n=== Side-by-side: primaryCause + top probability ===');
  for (const r of [llama, ossResult]) {
    if (r.error) {
      console.log(`${r.model || '?'}: ERROR - ${r.error}`);
      continue;
    }
    try {
      const parsed = JSON.parse(r.content);
      console.log(`\n${r.model} (${r.latencyMs}ms, finish_reason=${r.finishReason}):`);
      console.log('  primaryCause:', parsed.primaryCause);
      console.log('  probability:', JSON.stringify(parsed.probability));
    } catch (e) {
      console.log(`\n${r.model}: could not parse JSON - ${e.message}`);
      console.log('  raw:', r.content.slice(0, 300));
    }
  }
})();
