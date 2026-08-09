const express = require('express');
const router = express.Router();
const { runDiagnosticPipeline } = require('../services/pipeline.engine');
const { groqChat } = require('../services/groq');
const { collectVehicleEvidence } = require('../services/vehicle.evidence');
const { supabase } = require('../db');

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
      if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

function safeEstimate(laborRate, partsCost, overrides = {}) {
  return {
    priority: 'medium', diagnosis: 'Manual inspection required', laborCost: laborRate, partsCost,
    total: laborRate + partsCost, repairs: ['Diagnostic inspection required'], probability: [], knownIssues: [],
    repairSteps: [], proTips: [], additionalChecks: [], notes: '', estimatedHours: 1,
    evidence: { oem: [], tsbs: [], recalls: [], knownIssues: [], sources: [] }, ...overrides
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
    return !completedWork.some(done => done.split(' ').every(term => value.includes(term)));
  });
}

router.post('/', async (req, res) => {
  try {
    const { vehicle = {}, obdCodes = [], customerStates = [], mechanicNotices = [], keywords = [], laborRate = 65, partsCost = 0, mileage = 0, vin = '', customer = {} } = req.body;
    const laborRateNum = Math.max(0, Number(laborRate));
    const partsCostNum = Math.max(0, Number(partsCost));

    let pipelineResults = {};
    let rustBeltMultiplier = 1.0;
    try {
      pipelineResults = runDiagnosticPipeline({ vehicle, vin, symptoms: [...customerStates, ...mechanicNotices], codes: obdCodes, mileage, laborRate: laborRateNum }, { log: () => {} });
      if (pipelineResults.profile?.rustMultiplier > 1.0) rustBeltMultiplier = pipelineResults.profile.rustMultiplier;
    } catch (e) { console.warn('[Estimate Engine] Pipeline background pass skipped:', e.message); }

    let vehicleEvidence = { available: false, oem: { references: [] }, tsbs: { references: [] }, recalls: [], knownIssues: [], sources: [], errors: [] };
    try {
      vehicleEvidence = await collectVehicleEvidence({
        ...vehicle, vin, year: vehicle.year, make: vehicle.make, model: vehicle.model,
        trim: vehicle.trim, engine: vehicle.engine || vehicle.trim
      }, {
        symptoms: customerStates.join(' '), mechanicNotices, obdCodes, keywords
      });
    } catch (e) {
      console.warn('[Estimate Evidence] Collection failed:', e.message);
      vehicleEvidence.errors = [e.message];
    }

    const completedWork = normalizeCompletedWork(mechanicNotices);
    const vehicleStr = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ') || 'Unknown Vehicle';
    const evidenceText = JSON.stringify({
      OEM_FACTORY_REFERENCES: (vehicleEvidence.oem?.references || []).slice(0, 12).map(x => ({ title: x.title, url: x.url, type: x.evidenceType, facts: x.extractedFacts })),
      TSB_CANDIDATES: (vehicleEvidence.tsbs?.references || []).slice(0, 10).map(x => ({ title: x.title, url: x.url, facts: x.extractedFacts })),
      NHTSA_RECALLS: (vehicleEvidence.recalls || []).slice(0, 10),
      KNOWN_ISSUE_PATTERNS: (vehicleEvidence.knownIssues || []).slice(0, 10),
      EVIDENCE_SOURCES: vehicleEvidence.sources || []
    });

    const systemPrompt = `You are the expert estimation module of SKSK ProTech — a master automotive mechanic with 25 years of real shop experience.
Output a single valid JSON object ONLY. No backticks, markdown, or text before/after.
{
 "priority":"high|medium|low","diagnosis":"string","estimatedHours":2.5,"laborCost":162.50,"partsCost":${partsCostNum},"total":242.50,
 "repairs":["string"],"probability":[{"cause":"string","likelihood":80}],"knownIssues":["string"],"repairSteps":["string"],"proTips":["string"],"additionalChecks":["string"],"notes":"string"
}
RULES:
- priority exactly high, medium, or low.
- laborCost = estimatedHours x ${laborRateNum} x ${rustBeltMultiplier}; total = laborCost + partsCost.
- All array values must be strings.
- OEM/factory manual facts are primary technical evidence for procedures, construction, torque, inspections, and component identification.
- TSB candidates must be labeled as candidates unless a real bulletin identity is verified. Never invent a TSB number.
- Use NHTSA recalls as vehicle-specific safety evidence.
- Use NHTSA complaint frequency only as a pattern signal, NOT proof of failure.
- Never invent an OEM procedure, torque value, bulletin number, campaign number, or known issue.
- Never recommend replacing a component explicitly documented as already replaced by the mechanic.
- Prefer a confirmation test before replacement when evidence is inconclusive.
- If factory evidence says a part is bolt-in, press-in, riveted, integral, etc., use that construction fact in the repair plan when relevant.
- Evidence must change the diagnosis/ranking when relevant.
MULTI-CONDITION REASONING: When the same symptom occurs under two or more distinct operating conditions (e.g. deceleration AND full steering lock, or cold-start AND hard acceleration), analyze what changes mechanically in each condition, then prioritize causes plausible under ALL the reported conditions over causes that only fit one. Consider three hypotheses: (1) one component explains every occurrence, (2) different components in the same system produce a similar-sounding reaction, (3) two unrelated faults happen to sound alike. Use the overlap between conditions to narrow the diagnostic tree rather than anchoring on the most obvious single-condition match.
- Output raw JSON only.`;

    const keywordsList = Array.isArray(keywords) ? keywords.filter(k => typeof k === 'string' && k.trim()) : [];
    const userPrompt = `Vehicle: ${vehicleStr}\nVIN: ${vin || 'N/A'}\nShop Rate: $${laborRateNum}/hr | Parts Budget: $${partsCostNum} | Rust Multiplier: ${rustBeltMultiplier}x\nOBD Codes: ${obdCodes.join(', ') || 'None'}\nCustomer Reports: ${customerStates.join(', ') || 'N/A'}\nMechanic Notices: ${mechanicNotices.join(', ') || 'N/A'}\nCompleted Work Detected: ${completedWork.join(', ') || 'None'}${keywordsList.length ? `\nTechnical Keywords: ${keywordsList.join(', ')}` : ''}\n\nVEHICLE EVIDENCE:\n${evidenceText}`;

    const groqRes = await groqChat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], { max_tokens: 2500, temperature: 0.2, reasoning_effort: 'low' });
    const aiText = typeof groqRes === 'string' ? groqRes : (groqRes?.choices?.[0]?.message?.content || '');
    if (!aiText) throw new Error('Groq returned empty response strings');

    let parsed = extractJSON(aiText);
    if (!parsed) parsed = safeEstimate(laborRateNum, partsCostNum, { notes: 'AI parse failed — output falling back to safety defaults.' });
    const finalEstimate = { ...safeEstimate(laborRateNum, partsCostNum), ...parsed };
    finalEstimate.repairs = filterCompletedRepairs(finalEstimate.repairs, completedWork);
    if (!finalEstimate.repairs.length) finalEstimate.repairs = ['Perform targeted confirmation tests before replacement'];

    const evidenceKnownIssues = [];
    for (const x of (vehicleEvidence.tsbs?.references || []).slice(0, 3)) evidenceKnownIssues.push(`TSB candidate: ${x.title || 'Factory service bulletin reference'}${x.url ? ` — ${x.url}` : ''}`);
    for (const x of (vehicleEvidence.recalls || []).slice(0, 3)) evidenceKnownIssues.push(`NHTSA recall ${x.campaignNumber || 'reference'}: ${x.component || 'vehicle component'} — ${x.summary || 'see recall remedy'}`);
    for (const x of (vehicleEvidence.knownIssues || []).slice(0, 5)) evidenceKnownIssues.push(`${x.component || 'Vehicle component'} — ${x.reports} NHTSA complaint pattern report${x.reports === 1 ? '' : 's'}`);
    for (const x of (vehicleEvidence.oem?.references || []).filter(x => x.evidenceType === 'FACTORY_SERVICE_REFERENCE').slice(0, 5)) {
      const facts = x.extractedFacts || {};
      const construction = (facts.construction || []).slice(0, 1).join(' ');
      evidenceKnownIssues.push(`OEM/factory reference: ${x.title || 'Service procedure'}${construction ? ` — ${construction}` : ''}${x.url ? ` — ${x.url}` : ''}`);
    }
    finalEstimate.knownIssues = evidenceKnownIssues.length ? evidenceKnownIssues : (finalEstimate.knownIssues || []);

    const sourceLabel = (vehicleEvidence.sources || []).join(', ') || 'No external evidence source returned';
    finalEstimate.notes = [finalEstimate.notes, `Evidence used: ${sourceLabel}. Completed repairs excluded: ${completedWork.join(', ') || 'none'}.`].filter(Boolean).join(' ');
    finalEstimate.evidence = {
      oem: (vehicleEvidence.oem?.references || []).slice(0, 12),
      tsbs: (vehicleEvidence.tsbs?.references || []).slice(0, 10),
      recalls: (vehicleEvidence.recalls || []).slice(0, 10),
      knownIssues: (vehicleEvidence.knownIssues || []).slice(0, 10),
      sources: vehicleEvidence.sources || [], available: !!vehicleEvidence.available,
      completedWorkExcluded: completedWork
    };

    if (!['high', 'medium', 'low'].includes(finalEstimate.priority)) finalEstimate.priority = 'medium';
    try {
      if (supabase) await supabase.from('estimates').insert({ total: finalEstimate.total, details: { ...finalEstimate, customer, vehicle } });
    } catch (e) { /* DB target optional */ }
    res.json({ success: true, appliedRustPenalty: rustBeltMultiplier > 1.0, estimate: finalEstimate });
  } catch (err) {
    console.error('[Estimate System Fault]:', err.message);
    res.status(500).json({ success: false, error: 'Estimate generation failed completely.', details: err.message });
  }
});

module.exports = router;
