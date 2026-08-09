const router = require('express').Router();
const { aiChat } = require('../services/ai/aiClient');
const { extractJSON } = require('../services/estimateHelpers');

/**
 * Phase 3 fix: this route used to call runDiagnosticPipeline() +
 * parseGroqJson() from pipeline.engine.js. pipeline.engine.js is a
 * deterministic planner only (see its own header comment) - it never
 * called Groq, and parseGroqJson was never defined anywhere in the
 * repo. Every real request threw "parseGroqJson is not a function".
 *
 * Fixed to go through the same aiClient -> providerRouter -> Groq
 * path as the rest of the AI layer, and to use the shared extractJSON
 * utility from estimateHelpers.js instead of a nonexistent one.
 */
router.post('/', async (req, res, next) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'No text provided' });

    if (!process.env.GROQ_API_KEY) {
      return res.json({ translated: text, keywords: [] });
    }

    const prompt = `You are an expert automotive technician. A customer described their car problem in plain everyday language. Translate it into precise technical mechanic language that a shop tech would write on a repair order.

Customer said: "${text}"

Respond with JSON ONLY:
{
  "translated": "technical mechanic description of the same symptom",
  "keywords": ["technical term 1", "technical term 2"]
}`;

    const aiRes = await aiChat({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
      temperature: 0.2,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' }
    });

    const raw = aiRes?.choices?.[0]?.message?.content || '';
    const parsed = extractJSON(raw);

    if (!parsed) {
      console.warn('[Translate] JSON extract failed, falling back to original text.');
    }

    res.json({
      translated: parsed?.translated || text,
      keywords: parsed?.keywords || []
    });
  } catch (err) {
    console.error('[Translate System Fault]:', err.message);
    next(err);
  }
});

module.exports = router;
