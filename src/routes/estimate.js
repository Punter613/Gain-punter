const express = require('express');
const router = express.Router();
const { runDiagnosticPipeline } = require('../services/pipeline.engine');
const { groqChat } = require('../services/groq');


// Bracket-depth extraction logic to handle loose markdown text boundaries safely
function extractJSON(text) {
  if (!text) return null;
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

function safeEstimate(laborRate, partsCost, overrides = {}) {
  return {
    priority: 'medium',
    diagnosis: 'Manual inspection required',
    laborCost: laborRate,
    partsCost: partsCost,
    total: laborRate + partsCost,
    repairs: ['Diagnostic inspection required'],
    probability: [],
    knownIssues: [],
    repairSteps: [],
    proTips: [],
    additionalChecks: [],
    notes: '',
    estimatedHours: 1,
    ...overrides
  };
}

router.post('/', async (req, res) => {
  try {
    const {
      vehicle = {},
      obdCodes = [],
      customerStates = [],
      mechanicNotices = [],
      keywords = [],
      laborRate = 65,
      partsCost = 0,
      mileage = 0,
      vin = '',
      customer = {}
    } = req.body;

    const laborRateNum = Math.max(0, Number(laborRate));
    const partsCostNum = Math.max(0, Number(partsCost));

    // Run the hardened production compiler pipeline pass (Graceful Fallback)
    let pipelineResults = {};
    let rustBeltMultiplier = 1.0;

    try {
      // Map incoming arrays to expected compiler structure fields cleanly
      pipelineResults = runDiagnosticPipeline({
        vehicle,
        vin,
        symptoms: [...customerStates, ...mechanicNotices],
        codes: obdCodes,
        mileage,
        laborRate: laborRateNum
      }, { log: () => {} }); // Trace stub to suppress console noise in estimation passes

      if (pipelineResults.profile && pipelineResults.profile.rustMultiplier > 1.0) {
        rustBeltMultiplier = pipelineResults.profile.rustMultiplier;
      }
    } catch (pipelineErr) {
      console.warn('[Estimate Engine] Pipeline background pass skipped:', pipelineErr.message);
    }

    // FIX: Dynamically construct the vehicle identity string from ACTUAL real-time request parameters
    const vehicleStr = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
      .filter(Boolean).join(' ') || 'Unknown Vehicle';

    const systemPrompt = `You are the expert estimation module of SKSK ProTech — a master automotive mechanic with 25 years of real shop experience.

Output a single valid JSON object ONLY. No backticks, no markdown, no text before or after.

{
  "priority": "high",
  "diagnosis": "string",
  "estimatedHours": 2.5,
  "laborCost": 162.50,
  "partsCost": ${partsCostNum},
  "total": 242.50,
  "repairs": ["string"],
  "probability": [{"cause": "string", "likelihood": 80}],
  "knownIssues": ["string"],
  "repairSteps": ["string"],
  "proTips": ["string"],
  "additionalChecks": ["string"],
  "notes": "string"
}

RULES:
- priority: exactly "high", "medium", or "low"
- laborCost = estimatedHours x ${laborRateNum} x ${rustBeltMultiplier}
- total = laborCost + partsCost
- All array values must be strings
- Output raw JSON only`;

    const keywordsList = Array.isArray(keywords) ? keywords.filter(k => typeof k === 'string' && k.trim()) : [];

    const userPrompt = `Vehicle: ${vehicleStr}
VIN: ${vin || 'N/A'}
Shop Rate: $${laborRateNum}/hr | Parts Budget: $${partsCostNum} | Rust Multiplier: ${rustBeltMultiplier}x
OBD Codes: ${obdCodes.join(', ') || 'None'}
Customer Reports: ${customerStates.join(', ') || 'N/A'}
Mechanic Notices: ${mechanicNotices.join(', ') || 'N/A'}${keywordsList.length ? `
Technical Keywords (from symptom translation, use to sharpen diagnosis): ${keywordsList.join(', ')}` : ''}`;

    const groqRes = await groqChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { max_tokens: 1400, temperature: 0.2 });

    const aiText = typeof groqRes === 'string' ? groqRes : (groqRes?.choices?.[0]?.message?.content || '');
    if (!aiText) throw new Error('Groq returned empty response strings');

    let parsed = extractJSON(aiText);
    if (!parsed) {
      console.warn('[Estimate Engine] JSON extract failed. Falling back.');
      parsed = safeEstimate(laborRateNum, partsCostNum, { notes: 'AI parse failed — output falling back to safety defaults.' });
    }

    const finalEstimate = { ...safeEstimate(laborRateNum, partsCostNum), ...parsed };

    if (!['high', 'medium', 'low'].includes(finalEstimate.priority)) {
      finalEstimate.priority = 'medium';
    }

    try {
      const db = require('../services/db');
      if (db) await db.from('estimates').insert({
        total: finalEstimate.total,
        details: { ...finalEstimate, customer, vehicle }
      });
    } catch (e) { /* DB target optional */ }

    res.json({
      success: true,
      appliedRustPenalty: rustBeltMultiplier > 1.0,
      estimate: finalEstimate
    });

  } catch (err) {
    console.error('[Estimate System Fault]:', err.message);
    res.status(500).json({ success: false, error: 'Estimate generation failed completely.', details: err.message });
  }
});

module.exports = router;
