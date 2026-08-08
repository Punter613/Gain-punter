const Groq = require('groq-sdk');
const { generateForemanPrompt } = require('./aiForemanPrompt');

const apiKey = process.env.GROQ_API_KEY;
const groq = apiKey ? new Groq({ apiKey }) : null;

const processSingleEstimate = async ({ vehicle, notes }) => {
  if (!apiKey) {
    // Previously returned fabricated diagnostic data ("Cylinder 2 misfire",
    // "Brake pads at 3mm") on every request when the key was missing, with
    // no signal to the caller that it wasn't real. Fail loudly instead —
    // this route is live at /api/fleet.
    throw new Error('[Estimator] GROQ_API_KEY is not configured. Cannot generate an estimate.');
  }

  const prompts = generateForemanPrompt(vehicle, notes);

  const chatCompletion = await groq.chat.completions.create({
    messages: [
      { role: 'system', content: prompts.system },
      { role: 'user', content: prompts.user }
    ],
    model: 'llama-3.3-70b-versatile',
    temperature: 0.1,
    response_format: { type: "json_object" }
  });

  return JSON.parse(chatCompletion.choices[0].message.content.trim());
};

module.exports = { processSingleEstimate };
