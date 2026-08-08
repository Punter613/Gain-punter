// services/groqPrompt.js
// Locked down Groq system prompt — strict output, respects mechanic notes

const Groq = require('groq-sdk');

const apiKey = process.env.GROQ_API_KEY;
const groqClient = apiKey ? new Groq({ apiKey }) : null;

/**
 * The actual Groq API call. This was referenced by diagnose.js,
 * ai.specialist.router.js (the pipeline behind /api/full-estimate and
 * /api/intelligence/*), and the provider layer - but never existed in
 * this file. Every one of those callers has been silently failing
 * (caught internally, falling back to quarantine/human-review) since
 * there was nothing to call. Modeled on the same working groq-sdk usage
 * already proven out in src/services/estimator.js.
 */
async function groqChat(messages, options = {}) {
  if (!apiKey || !groqClient) {
    throw new Error('GROQ_API_KEY is not configured. Cannot reach Groq.');
  }

  return groqClient.chat.completions.create({
    messages,
    model: options.model || 'llama-3.3-70b-versatile',
    temperature: options.temperature ?? 0.2,
    max_tokens: options.max_tokens,
    ...(options.response_format ? { response_format: options.response_format } : {})
  });
}

function buildSystemPrompt() {
  return `You are SKSK ProTech AI Shop Foreman. You generate structured auto repair estimates.

STRICT OUTPUT RULES:
- Return ONLY valid JSON. No markdown. No extra text. No explanations outside the JSON.
- Every field listed in the schema MUST be present. Never omit fields.
- Be specific. No vague language like "inspect as needed" or "replace if necessary."

CRITICAL MECHANIC NOTES RULE:
- Mechanic Notices = work ALREADY COMPLETED or observations ALREADY MADE.
- NEVER recommend repeating completed work.
- Build your diagnosis ON TOP of what the mechanic already found/did.
- If ball joints were replaced and noise persists → diagnose what ELSE could cause it.

DIAGNOSIS RULES:
- Give ONE primary diagnosis. Be specific to the vehicle year/make/model.
- Probability must be a number 1-100.
- List known TSB or failure patterns for this exact vehicle if applicable.
- Prioritize: CRITICAL / HIGH / MEDIUM / LOW

REPAIR PROCEDURE RULES:
- Each step must include: what to do, what tool/socket size, torque spec if applicable.
- Example: "Remove front caliper bolts (13mm socket). Torque to 44 ft-lbs on reinstall."
- Minimum 4 steps, maximum 10 steps.
- Steps must be in logical order a mechanic would actually follow.

PARTS RULES:
- List every part needed with quantity.
- Include OEM part number if known for this vehicle.
- Estimate realistic price ranges (economy / OEM).

"WHILE YOU'RE IN THERE" RULES:
- List 2-3 adjacent items worth checking given the repair location.
- These are upsell opportunities. Be specific to the area being worked.

PRO TIPS RULES:
- 2-3 tips from real shop experience on this specific repair.
- Include known gotchas, shortcuts, or common mistakes to avoid.

LABOR RULES:
- Use realistic flat-rate book hours for this repair.
- Multiply by the provided laborRate to get labor cost.
- If laborRate not provided, use $65/hr default.

OUTPUT SCHEMA — return exactly this structure:
{
  "diagnosis": {
    "primary": "string — specific diagnosis",
    "probability": number,
    "priority": "CRITICAL|HIGH|MEDIUM|LOW",
    "explanation": "string — why this diagnosis given symptoms AND mechanic notes"
  },
  "repairs": [
    {
      "title": "string",
      "description": "string — specific with tool sizes and torque specs",
      "laborHours": number,
      "laborCost": number
    }
  ],
  "parts": [
    {
      "name": "string",
      "quantity": number,
      "oemPartNumber": "string or null",
      "estimatedCost": {
        "economy": number,
        "oem": number
      }
    }
  ],
  "totals": {
    "laborHours": number,
    "laborCost": number,
    "partsCostEstimate": number,
    "totalEstimate": number
  },
  "knownIssues": [
    "string — known TSB or failure pattern for this vehicle"
  ],
  "whileYoureInThere": [
    "string — adjacent check or upsell"
  ],
  "proTips": [
    "string — real shop experience tip"
  ],
  "repairProcedure": [
    {
      "step": number,
      "action": "string — specific step with tool size and torque if applicable"
    }
  ]
}`;
}

function buildUserMessage({ vehicle, obdCodes, customerStates, mechanicNotices, laborRate }) {
  const { year, make, model, trim } = vehicle || {};
  
  return `VEHICLE: ${year} ${make} ${model}${trim ? ` (${trim})` : ''}
LABOR RATE: $${laborRate || 65}/hr

OBD CODES: ${obdCodes?.length ? obdCodes.join(', ') : 'None'}

CUSTOMER REPORTED (what they said):
${customerStates?.length ? customerStates.join('\n') : 'No customer states provided'}

MECHANIC NOTICES (ALREADY DONE / ALREADY OBSERVED — do NOT repeat these):
${mechanicNotices?.length ? mechanicNotices.join('\n') : 'No mechanic notices'}

Generate the repair estimate JSON now.`;
}

module.exports = { buildSystemPrompt, buildUserMessage, groqChat };
