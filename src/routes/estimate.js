const express = require('express');
const router = express.Router();
const { runDiagnosticPipeline } = require('../services/pipeline.engine');
const { groqChat } = require('../services/groq');
const { collectVehicleEvidence } = require('../services/vehicle.evidence');

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
    partsCost,
    total: laborRate + partsCost,
    repairs: ['Diagnostic inspection required'],
    probability: [],
    knownIssues: [],
    repairSteps: [],
    proTips: [],
    additionalChecks: [],
    notes: '',
    estimatedHours: 1,
    evidence: { oem: [], tsbs: [], recalls: [], knownIssues: [], sources: [] },
    ...overrides
  };
}

function normalizeCompletedWork(mechanicNotices) {
  const text = (mechanicNotices || []).join(' ').toLowerCase();
  const patterns = [
    ['cv axle', /(?:replaced|replace|new|installed).{0,60}cv\s*axles?/i],
    ['lower ball joint', /(?:replaced|replace|new|installed).{0,60}lower\s+ball\s+joints?/i],
    ['upper ball joint', /(?:replaced|replace|new|installed).{0,60}upper\s+ball\s+joints?/i],
    ['upper control arm', /(?:replaced|replace|new|installed).{0,60}upper\s+control\s+arms?/i],
    ['lower control arm', /(?:replaced|replace|new|installed).{0,60}lower\s+control\s+arms?/i]
  ];
  return patterns.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function filterCompletedRepairs(repairs, completedWork) {
  if (!Array.isArray(repairs) || !completedWork.length) return repairs;
  return repairs.filter(repair => {
    const value = String(repair || '').toLowerCase();
    return !completedWork.some(done => {
      const terms = done.split(' ');
      return terms.every(term => value.includes(term));
    });
  });
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

    let pipelineResults = {};
    let rustBeltMultiplier = 1.0;
    try {
      pipelineResults = runDiagnosticPipeline({
        vehicle,
        vin,
        symptoms: [...customerStates, ...mechanicNotices],
        codes: obdCodes,
        mileage,
        laborRate: laborRateNum
      }, { log: () => {} });
      if (pipelineResults.profile && pipelineResults.profile.rustMultiplier > 1.0) {
        rustBeltMultiplier = pipelineResults.profile.rustMultiplier;
      }
    } catch (pipelineErr) {
      console.warn('[Estimate Engine] Pipeline background pass skipped:', pipelineErr.message);
    }

    // Evidence is collected BEFORE the AI estimate so OEM references, TSB candidates,
    // recalls, and complaint-derived patterns can change the ranking instead of merely
    // being displayed after the fact.
    let vehicleEvidence = {
      available: false,
      oem: { references: [] },
      tsbs: { references: [] },
      recalls: [],
      knownIssues: [],
      sources: [],
      errors: []
    };
    try {
      vehicleEvidence = await collectVehicleEvidence({
        ...vehicle,
        vin,
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        trim: vehicle.trim,
        engine: vehicle.engine || vehicle.trim
      });
    } catch (e) {
      console.warn('[Estimate Evidence] Collection failed:', e.message);
      vehicleEvidence.errors = [e.message];
    }

    const completedWork = normalizeCompletedWork(mechanicNotices);
    const vehicleStr = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
      .filter(Boolean).join(' ') || 'Unknown Vehicle';

    const evidenceText = JSON.stringify({
      OEM_FACTORY_REFERENCES: (vehicleEvidence.oem?.references || []).slice(0, 8).map(x => ({ title: x.title, url: x.url, type: x.evidenceType })),
      TSB_CANDIDATES: (vehicleEvidence.tsbs?.references || []).slice(0, 8).map(x => ({ title: x.title, url: x.url })),
      NHTSA_RECALLS: (vehicleEvidence.recalls || []).slice(0, 10),
      KNOWN_ISSUE_PATTERNS: (vehicleEvidence.knownIssues || []).slice(0, 10),
      EVIDENCE_SOURCES: vehicleEvidence.sources || []
    });

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
- Use OEM/factory references and verified TSB candidates as higher-authority evidence than generic AI guesses.
- Use NHTSA recalls as vehicle-specific safety evidence.
- Treat NHTSA complaint frequency as a pattern signal, NOT proof that a component failed.
- Never invent a TSB number, campaign number, OEM procedure, or known issue.
- If there is no verified TSB candidate, do not claim a TSB exists.
- Do NOT recommend replacing a component explicitly documented as already replaced by the mechanic. Instead diagnose what remains plausible and tell the mechanic how to confirm it.
- Evidence must change the diagnosis/ranking when it is relevant; do not merely repeat the customer's symptom.
- Prefer a confirmation test before replacement when evidence is inconclusive.
- Output raw JSON only.`;

    const keywordsList = Array.isArray(keywords) ? keywords.filter(k => typeof k === 'string' && k.trim()) : [];
    const userPrompt = `Vehicle: ${vehicleStr}
VIN: ${vin || 'N/A'}
Shop Rate: $${laborRateNum}/hr | Parts Budget: $${partsCostNum} | Rust Multiplier: ${rustBeltMultiplier}x
OBD Codes: ${obdCodes.join(', ') || 'None'}
Customer Reports: ${customerStates.join(', ') || 'N/A'}
Mechanic Notices: ${mechanicNotices.join(', ') || 'N/A'}
Completed Work Detected: ${completedWork.join(', ') || 'None'}${keywordsList.length ? `\nTechnical Keywords: ${keywordsList.join(', ')}` : ''}

VEHICLE EVIDENCE — use this to rank the diagnosis:
${evidenceText}`;

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
    finalEstimate.repairs = filterCompletedRepairs(finalEstimate.repairs, completedWork);
    if (!finalEstimate.repairs.length) finalEstimate.repairs = ['Perform targeted confirmation tests before replacement'];

    const evidenceKnownIssues = (vehicleEvidence.knownIssues || []).slice(0, 5).map(x => {
      const component = x.component || 'Vehicle component';
      return `${component} — ${x.reports} NHTSA complaint pattern report${x.reports === 1 ? '' : 's'}`;
    });
    finalEstimate.knownIssues = evidenceKnownIssues.length
      ? evidenceKnownIssues
      : (finalEstimate.knownIssues || []);

    finalEstimate.evidence = {
      oem: (vehicleEvidence.oem?.references || []).slice(0, 8),
      tsbs: (vehicleEvidence.tsbs?.references || []).slice(0, 8),
      recalls: (vehicleEvidence.recalls || []).slice(0, 10),
      knownIssues: (vehicleEvidence.knownIssues || []).slice(0, 10),
      sources: vehicleEvidence.sources || [],
      available: !!vehicleEvidence.available,
      completedWorkExcluded: completedWork
    };

    if (!['high', 'medium', 'low'].includes(finalEstimate.priority)) finalEstimate.priority = 'medium';

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
