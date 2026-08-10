const express = require('express');
const router = express.Router();
const { runDiagnosticPipeline } = require('../services/pipeline.engine');
const { groqChat } = require('../services/groq');
const { collectVehicleEvidence } = require('../services/vehicle.evidence');
const { decodeVinNhtsa } = require('../services/vin');
const { extractCompletedWork } = require('../core/orchestrator/completed.work.guard');
const { supabase } = require('../db');

const MIN_TSB_RELEVANCE = 12;

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
    evidence: { oem: [], tsbs: [], sources: [] }, ...overrides
  };
}

function normalizeCompletedWork(mechanicNotices) {
  return extractCompletedWork(mechanicNotices);
}

function filterCompletedRepairs(repairs, completedWork) {
  if (!Array.isArray(repairs) || !completedWork.length) return repairs;
  return repairs.filter(repair => {
    const value = String(repair || '').toLowerCase();
    return !completedWork.some(done => done.split(' ').every(term => value.includes(term)));
  });
}

async function buildEvidenceVehicle(vehicle, vin) {
  const enriched = {
    ...vehicle,
    vin,
    year: vehicle.year,
    make: vehicle.make,
    model: vehicle.model,
    trim: vehicle.trim,
    engine: vehicle.engine || vehicle.trim,
    drivetrain: vehicle.drivetrain || '',
    driveType: vehicle.driveType || ''
  };

  const hasDriveSignal = enriched.drivetrain || enriched.driveType;
  if (!hasDriveSignal && String(vin || '').trim().length === 17) {
    try {
      const decoded = await decodeVinNhtsa(String(vin).trim());
      if (decoded) {
        enriched.driveType = decoded.driveType || enriched.driveType;
        enriched.engineCylinders = decoded.engineCylinders || enriched.engineCylinders;
        enriched.bodyClass = decoded.bodyClass || enriched.bodyClass;
        enriched.transmissionStyle = decoded.transmissionStyle || enriched.transmissionStyle;
        if (!enriched.engine) enriched.engine = decoded.engine || '';
        console.log(`[Estimate Evidence] VIN applicability enriched: ${enriched.driveType || 'drive type unavailable'}`);
      }
    } catch (err) {
      console.warn('[Estimate Evidence] VIN applicability decode failed (non-fatal):', err.message);
    }
  }

  return enriched;
}

function getRelevantTsbs(vehicleEvidence) {
  return (vehicleEvidence.tsbs?.references || [])
    .filter(ref => Number(ref.relevanceScore || 0) >= MIN_TSB_RELEVANCE)
    .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));
}

function torqueSignatures(text) {
  const signatures = new Set();
  const re = /(\d+(?:\.\d+)?)(?:\s*[-–—]\s*(\d+(?:\.\d+)?))?\s*(n\s*[·.]?\s*m|nm|ft\.?\s*-?\s*lb|lb\.?\s*-?\s*ft)/gi;
  let match;
  while ((match = re.exec(String(text || '')))) {
    const unit = /n/i.test(match[3]) ? 'nm' : 'ftlb';
    signatures.add(`${match[1]}-${match[2] || match[1]}-${unit}`);
  }
  return signatures;
}

function sanitizeUnsupportedTorque(finalEstimate, evidenceText) {
  const allowed = torqueSignatures(evidenceText);
  let removed = 0;
  const specRe = /\b(?:usually|typically|approximately|approx\.?\s*)?(\d+(?:\.\d+)?)(?:\s*[-–—]\s*(\d+(?:\.\d+)?))?\s*(n\s*[·.]?\s*m|nm|ft\.?\s*-?\s*lb|lb\.?\s*-?\s*ft)\b/gi;

  function sanitize(value) {
    return String(value || '').replace(specRe, (whole, first, second, unitRaw) => {
      const unit = /n/i.test(unitRaw) ? 'nm' : 'ftlb';
      const signature = `${first}-${second || first}-${unit}`;
      if (allowed.has(signature)) return whole;
      removed += 1;
      return 'factory specification';
    });
  }

  finalEstimate.diagnosis = sanitize(finalEstimate.diagnosis);
  finalEstimate.notes = sanitize(finalEstimate.notes);
  for (const key of ['repairs', 'repairSteps', 'proTips', 'additionalChecks']) {
    if (Array.isArray(finalEstimate[key])) finalEstimate[key] = finalEstimate[key].map(sanitize);
  }

  return removed;
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

    const evidenceVehicle = await buildEvidenceVehicle(vehicle, vin);

    // collectVehicleEvidence may still collect NHTSA for shared/cache use, but Estimate intentionally
    // consumes and returns only OEM/TSB evidence. NHTSA presentation stays in the VIN Decode flow.
    let vehicleEvidence = { available: false, oem: { references: [] }, tsbs: { references: [] }, recalls: [], knownIssues: [], sources: [], errors: [] };
    try {
      vehicleEvidence = await collectVehicleEvidence(evidenceVehicle, {
        symptoms: customerStates.join(' '), mechanicNotices, obdCodes, keywords
      });
    } catch (e) {
      console.warn('[Estimate Evidence] Collection failed:', e.message);
      vehicleEvidence.errors = [e.message];
    }

    const completedWork = normalizeCompletedWork(mechanicNotices);
    const vehicleStr = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ') || 'Unknown Vehicle';
    const relevantTsbs = getRelevantTsbs(vehicleEvidence);
    const oemReferences = (vehicleEvidence.oem?.references || []).slice(0, 8);
    const estimateSources = (vehicleEvidence.sources || [])
      .filter(source => source !== 'NHTSA_ODI' && source !== 'NHTSA ODI')
      .filter(source => source !== 'LEMON_MANUALS' || oemReferences.length || relevantTsbs.length);

    const evidencePayload = {
      OEM_FACTORY_REFERENCES: oemReferences.map(x => ({ title: x.title, url: x.url, type: x.evidenceType, facts: x.extractedFacts })),
      TSB_CANDIDATES: relevantTsbs.slice(0, 6).map(x => ({ title: x.title, url: x.url, facts: x.extractedFacts, relevanceScore: x.relevanceScore })),
      EVIDENCE_SOURCES: estimateSources
    };
    const evidenceText = JSON.stringify(evidencePayload);

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
- EVIDENCE HIERARCHY: measured/verified technical facts and supplied OEM/TSB evidence outrank mechanic observations; mechanic observations outrank customer-translated symptom wording. Treat translated customer wording as no more than ~5% directional influence: use it to preserve WHEN/WHERE/HOW the symptom occurs, not to select a component merely because a component/system word appears in the translation.
- MECHANIC NOTICES are high-value context. Completed work, observed play, leaks, measured values, failed tests, noise location, installation history, and technician observations must materially affect ranking when relevant.
- RETRIEVAL KEYWORDS are search hints only. Do not use translator-generated keywords as diagnostic evidence or as a reason to favor a component. The AI is intentionally not shown those keywords; reason from the symptom facts, mechanic notices, and retrieved evidence instead.
- OEM/factory manual facts are primary technical evidence for procedures, construction, torque, inspections, and component identification.
- TSB candidates must be labeled as candidates unless a real bulletin identity is verified. Never invent a TSB number.
- Never invent an OEM procedure, torque value, bulletin number, campaign number, or known issue.
- Never recommend replacing a component explicitly documented as already replaced by the mechanic.
- Prefer a confirmation test before replacement when evidence is inconclusive.
- If factory evidence says a part is bolt-in, press-in, riveted, integral, etc., use that construction fact in the repair plan when relevant.
- Evidence must change the diagnosis/ranking when relevant.
MULTI-CONDITION REASONING: When the same symptom occurs under two or more distinct operating conditions (e.g. deceleration AND full steering lock, or cold-start AND hard acceleration), analyze what changes mechanically in each condition, then prioritize causes plausible under ALL the reported conditions over causes that only fit one. Consider three hypotheses: (1) one component explains every occurrence, (2) different components in the same system produce a similar-sounding reaction, (3) two unrelated faults happen to sound alike. Use the overlap between conditions to narrow the diagnostic tree rather than anchoring on the most obvious single-condition match.
- Output raw JSON only.`;

    const userPrompt = `Vehicle: ${vehicleStr}\nVIN: ${vin || 'N/A'}\nVehicle applicability: ${evidenceVehicle.driveType || evidenceVehicle.drivetrain || 'drivetrain not decoded'}\nShop Rate: $${laborRateNum}/hr | Parts Budget: $${partsCostNum} | Rust Multiplier: ${rustBeltMultiplier}x\nOBD Codes: ${obdCodes.join(', ') || 'None'}\nLOW-WEIGHT CUSTOMER SYMPTOM CONTEXT (~5%): ${customerStates.join(', ') || 'N/A'}\nHIGH-WEIGHT MECHANIC NOTICES: ${mechanicNotices.join(', ') || 'N/A'}\nCompleted Work Detected: ${completedWork.join(', ') || 'None'}\n\nVEHICLE EVIDENCE:\n${evidenceText}`;

    const groqRes = await groqChat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], { max_tokens: 2500, temperature: 0.2, reasoning_effort: 'low' });
    const aiText = typeof groqRes === 'string' ? groqRes : (groqRes?.choices?.[0]?.message?.content || '');
    if (!aiText) throw new Error('Groq returned empty response strings');

    let parsed = extractJSON(aiText);
    if (!parsed) parsed = safeEstimate(laborRateNum, partsCostNum, { notes: 'AI parse failed — output falling back to safety defaults.' });
    const finalEstimate = { ...safeEstimate(laborRateNum, partsCostNum), ...parsed };
    finalEstimate.repairs = filterCompletedRepairs(finalEstimate.repairs, completedWork);
    if (!finalEstimate.repairs.length) finalEstimate.repairs = ['Perform targeted confirmation tests before replacement'];

    // Only symptom-relevant TSBs are visible as Known Issues. Factory procedure pages remain
    // available to reasoning/evidence but are not mislabeled as vehicle "known issues".
    finalEstimate.knownIssues = relevantTsbs.slice(0, 3).map(x =>
      `TSB candidate: ${x.title || 'Factory service bulletin reference'}${x.url ? ` — ${x.url}` : ''}`
    );

    // Hard stop: numeric torque values that were not present in supplied OEM/TSB evidence
    // do not reach the mechanic. The model may reason, but it may not manufacture specifications.
    const unsupportedTorqueSpecsRemoved = sanitizeUnsupportedTorque(finalEstimate, evidenceText);

    const sourceLabel = estimateSources.join(', ') || 'No external OEM/TSB evidence source returned';
    finalEstimate.notes = [finalEstimate.notes, `Evidence used: ${sourceLabel}. Completed repairs excluded: ${completedWork.join(', ') || 'none'}.`].filter(Boolean).join(' ');
    finalEstimate.evidence = {
      oem: oemReferences,
      tsbs: relevantTsbs.slice(0, 6),
      sources: estimateSources,
      available: !!(oemReferences.length || relevantTsbs.length),
      completedWorkExcluded: completedWork,
      drivetrain: evidenceVehicle.driveType || evidenceVehicle.drivetrain || '',
      tsbRelevanceFloor: MIN_TSB_RELEVANCE,
      unsupportedTorqueSpecsRemoved
    };

    if (!['high', 'medium', 'low'].includes(finalEstimate.priority)) finalEstimate.priority = 'medium';
    try {
      if (supabase) await supabase.from('estimates').insert({ total: finalEstimate.total, details: { ...finalEstimate, customer, vehicle: evidenceVehicle } });
    } catch (e) { /* DB target optional */ }
    res.json({ success: true, appliedRustPenalty: rustBeltMultiplier > 1.0, estimate: finalEstimate });
  } catch (err) {
    console.error('[Estimate System Fault]:', err.message);
    res.status(500).json({ success: false, error: 'Estimate generation failed completely.', details: err.message });
  }
});

module.exports = router;
