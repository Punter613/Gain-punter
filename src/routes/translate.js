const router = require('express').Router();
const { aiChat } = require('../services/ai/aiClient');
const { extractJSON } = require('../services/estimateHelpers');

/**
 * Customer-language normalization only.
 *
 * This route must NOT diagnose. It converts vague customer wording into
 * neutral technician language and extracts broad retrieval keywords for
 * LEMON/OEM/NHTSA evidence lookup. Those keywords are search hints, not
 * diagnostic evidence and should not be treated as component conclusions.
 */
router.post('/', async (req, res, next) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'No text provided' });

    if (!process.env.GROQ_API_KEY) {
      return res.json({ translated: text, keywords: [] });
    }

    const prompt = `You are an automotive service-writer translator, NOT a diagnostician.
A customer described a vehicle symptom in everyday language. Convert it into neutral, precise technician wording that preserves ONLY what the customer actually observed: sound, feel, location if stated, timing, speed, load, steering position, temperature, braking/acceleration/deceleration, warning lights, and other operating conditions.

DO NOT infer or suggest a failed component, system cause, diagnosis, repair, probability, or likely culprit unless the customer explicitly named it. If the customer guesses a cause, preserve it only as "customer suspects ...", never as a technical conclusion.

Also return broad technical retrieval keywords. Keywords exist ONLY to help evidence search (LEMON/OEM/NHTSA) find nearby service information. Prefer symptom/condition/system-family terms such as "clunk", "deceleration", "full steering lock", "torque reversal", "steering", "suspension", "driveline". Do not turn keywords into a diagnosis.

Customer said: "${text}"

Respond with JSON ONLY:
{
  "translated": "neutral technician description of the observed symptom and operating conditions",
  "keywords": ["retrieval keyword 1", "retrieval keyword 2"]
}`;

    const aiRes = await aiChat({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
      temperature: 0.15,
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
      keywords: Array.isArray(parsed?.keywords) ? parsed.keywords : []
    });
  } catch (err) {
    console.error('[Translate System Fault]:', err.message);
    next(err);
  }
});

module.exports = router;
