const express = require('express');
const router = express.Router();
const { runDiagnosticPipeline } = require('../services/pipeline.engine');
const { aiChat } = require('../services/ai/aiClient');
const { collectVehicleEvidence, selectRelevantTsbs } = require('../services/vehicle.evidence');
const { resolveVehicleProfile, waitForVehicleWarmup } = require('../services/vehicle.warmup');
const { extractCompletedWork } = require('../core/orchestrator/completed.work.guard');
const {
  ESTIMATE_RESPONSE_FORMAT,
  buildEvidenceLedger,
  compactLedgerForModel,
  buildFinalEstimate
} = require('../contracts/estimate.ai.contract');
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
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

function safeAIReasoning(note = '') {
  return {
    priority: 'medium',
    diagnosis: 'Manual inspection required',
    estimatedHours: 1,
    candidates: [{
      cause: 'Insufficient validated evidence for a component-level diagnosis',
      component: 'undetermined',
      modelConfidence: 0,
      evidenceRefs: [],
      contradictions: [],
      confirmationTests: ['Perform targeted mechanical inspection and record the result'],
      evidenceClass: 'MODEL_INFERENCE',
      factorySupported: false,
      mechanicSupported: false,
      measuredSupported: false,
      confirmationRequired: true,
      confirmed: false,
      repairAuthorized: false
    }],
    repairActions: [],
    repairSteps: [],
    proTips: [],
    additionalChecks: [],
    notes: note
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
  const traceId = `EST-${Date.now().toString(16).toUpperCase()}`;
  const startedAt = Date.now();

  try {
    const {
      vehicle = {},
      obdCodes = [],
      customerStates = [],
      mechanicNotices = [],
      keywords = [],
      diagnosticTests = [],
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
      if (pipelineResults.profile?.rustMultiplier > 1.0) rustBeltMultiplier = pipelineResults.profile.rustMultiplier;
    } catch (e) {
      console.warn(`[${traceId}] [Estimate Engine] Pipeline background pass skipped:`, e.message);
    }

    let evidenceVehicle = vehicle;
    try {
      evidenceVehicle = await resolveVehicleProfile(vin, vehicle);
    } catch (err) {
      console.warn(`[${traceId}] [Estimate Evidence] VIN/profile resolution failed (non-fatal):`, err.message);
    }

    const evidenceContext = {
      symptoms: customerStates.join(' '),
      mechanicNotices,
      obdCodes,
      keywords
    };

    const warmupStatus = await waitForVehicleWarmup(evidenceVehicle, 2500);

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
      vehicleEvidence = await collectVehicleEvidence(evidenceVehicle, evidenceContext, { includeNhtsa: false });
    } catch (e) {
      console.warn(`[${traceId}] [Estimate Evidence] Collection failed:`, e.message);
      vehicleEvidence.errors = [e.message];
    }

    const completedWork = normalizeCompletedWork(mechanicNotices);
    const vehicleStr = [evidenceVehicle.year, evidenceVehicle.make, evidenceVehicle.model, evidenceVehicle.trim]
      .filter(Boolean)
      .join(' ') || 'Unknown Vehicle';

    const relevantTsbs = selectRelevantTsbs(vehicleEvidence, evidenceContext, MIN_TSB_RELEVANCE);
    const oemReferences = (vehicleEvidence.oem?.references || []).slice(0, 8);
    const estimateSources = (vehicleEvidence.sources || [])
      .filter(source => source !== 'NHTSA_ODI' && source !== 'NHTSA ODI')
      .filter(source => source !== 'LEMON_MANUALS' || oemReferences.length || relevantTsbs.length);

    const ledger = buildEvidenceLedger({
      oemReferences,
      relevantTsbs: relevantTsbs.slice(0, 6),
      customerStates,
      mechanicNotices,
      obdCodes,
      diagnosticTests
    });
    const compactLedger = compactLedgerForModel(ledger);
    const evidenceText = JSON.stringify(compactLedger);

    const systemPrompt = `You are the reasoning module of SKSK ProTech. Return only the JSON object required by the supplied JSON Schema.

CONTRACT RULES:
- JSON booleans are real booleans: true or false. Never return "true" or "false" as strings.
- Do not output laborCost, partsCost, total, or laborRate. Those fields are mechanic-owned/deterministic and the AI has zero authority to change them.
- evidenceRefs may contain ONLY IDs present in the supplied EVIDENCE LEDGER.
- factorySupported=true only when an OEM_ or TSB_ reference directly supports that exact candidate/component claim.
- mechanicSupported=true only when a MECH_ reference directly supports that exact candidate/component claim.
- measuredSupported=true only when a CODE_ or TEST_ reference directly supports the candidate.
- A historical code is evidence that a fault was observed previously; it does not by itself prove the component must be replaced now.
- confirmed=true only when supplied measured/test evidence actually confirms the candidate. A model inference is never confirmation.
- repairAuthorized=true only when confirmed=true. If confirmation is missing, repairAuthorized MUST be false and confirmationRequired MUST be true.
- When repairAuthorized=false, give discriminating confirmationTests instead of jumping to replacement.
- Completed work may still be verified for installation/fitment/failure, but do not casually recommend repeating the same replacement.
- EVIDENCE HIERARCHY: measured/test facts > directly applicable OEM/TSB evidence > mechanic observations > customer statements > model inference.
- Customer statements preserve symptom/condition but are not proof of a component failure.
- Mechanic observations are high-value context but still distinguish observation/history from measured confirmation.
- Never invent a TSB, OEM procedure, torque, measurement, construction method, special tool, or vehicle-specific failure pattern.
- When two operating conditions are reported, preserve both branches unless evidence proves one component explains both.
- Probabilities/confidence are advisory model confidence only. SKSK will cap and normalize them deterministically after your response.
- repairSteps are allowed only for repairAuthorized candidates. Otherwise return an empty repairSteps array; SKSK will display confirmation tests.
- proTips must cite evidenceRefs when they claim vehicle-specific/factory facts. If a tip is only general shop reasoning, use an empty evidenceRefs array and factorySupported=false.`;

    const userPrompt = `Vehicle: ${vehicleStr}\nVIN: ${vin || 'N/A'}\nVehicle applicability: ${evidenceVehicle.driveType || evidenceVehicle.drivetrain || 'drivetrain not decoded'}\nMileage: ${mileage || 'N/A'}\nMechanic-entered labor rate: $${laborRateNum}/hr (DO NOT MODIFY)\nMechanic-entered parts cost: $${partsCostNum} (DO NOT MODIFY)\nCompleted Work Detected: ${completedWork.join(', ') || 'None'}\n\nEVIDENCE LEDGER:\n${evidenceText}`;

    console.log(`[${traceId}] [Estimate AI] dispatch`, {
      ledgerEntries: ledger.length,
      oemRefs: oemReferences.length,
      tsbRefs: relevantTsbs.length,
      mechanicRefs: mechanicNotices.length,
      customerRefs: customerStates.length,
      measuredRefs: obdCodes.length + diagnosticTests.length
    });

    const aiStartedAt = Date.now();
    const aiRes = await aiChat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 2500,
      temperature: 0.15,
      reasoning_effort: 'low',
      response_format: ESTIMATE_RESPONSE_FORMAT
    });
    const aiMs = Date.now() - aiStartedAt;

    const aiText = typeof aiRes === 'string'
      ? aiRes
      : (aiRes?.choices?.[0]?.message?.content || '');
    if (!aiText) throw new Error('AI provider returned an empty estimate response');

    let parsed = extractJSON(aiText);
    if (!parsed) parsed = safeAIReasoning('AI schema output could not be parsed; manual inspection required.');

    const finalEstimate = buildFinalEstimate(parsed, {
      ledger,
      laborRate: laborRateNum,
      partsCost: partsCostNum,
      rustMultiplier: rustBeltMultiplier
    });

    finalEstimate.repairs = filterCompletedRepairs(finalEstimate.repairs, completedWork);
    if (!finalEstimate.repairs.length) finalEstimate.repairs = ['Perform targeted confirmation tests before replacement'];

    finalEstimate.knownIssues = relevantTsbs.slice(0, 3).map(x =>
      `TSB candidate: ${x.title || 'Factory service bulletin reference'}${x.url ? ` — ${x.url}` : ''}`
    );

    const unsupportedTorqueSpecsRemoved = sanitizeUnsupportedTorque(finalEstimate, evidenceText);

    const sourceLabel = estimateSources.join(', ') || 'No external OEM/TSB evidence source returned';
    finalEstimate.notes = [
      finalEstimate.notes,
      `Evidence available: ${sourceLabel}.`,
      `Direct factory-supported candidates: ${finalEstimate.validation.factorySupportedCandidateCount}.`,
      `Model-only candidates: ${finalEstimate.validation.modelInferenceCandidateCount}.`,
      `Completed repairs excluded: ${completedWork.join(', ') || 'none'}.`
    ].filter(Boolean).join(' ');

    finalEstimate.evidence = {
      oem: oemReferences,
      tsbs: relevantTsbs.slice(0, 6),
      sources: estimateSources,
      available: !!(oemReferences.length || relevantTsbs.length),
      completedWorkExcluded: completedWork,
      drivetrain: evidenceVehicle.driveType || evidenceVehicle.drivetrain || '',
      tsbRelevanceFloor: MIN_TSB_RELEVANCE,
      unsupportedTorqueSpecsRemoved,
      warmupStatus: warmupStatus.status,
      ledger: compactLedger.map(ref => ({ id: ref.id, type: ref.type, title: ref.title || '', url: ref.url || '' })),
      claimTrace: finalEstimate.candidates.map(candidate => ({
        cause: candidate.cause,
        component: candidate.component,
        evidenceClass: candidate.evidenceClass,
        evidenceRefs: candidate.evidenceRefs,
        supportingEvidenceRefs: candidate.supportingEvidenceRefs,
        modelConfidence: candidate.modelConfidence,
        confidenceCap: candidate.confidenceCap,
        finalConfidence: candidate.finalConfidence,
        factorySupported: candidate.factorySupported,
        mechanicSupported: candidate.mechanicSupported,
        measuredSupported: candidate.measuredSupported,
        confirmed: candidate.confirmed,
        repairAuthorized: candidate.repairAuthorized
      }))
    };

    finalEstimate.aiTrace = {
      traceId,
      provider: aiRes?._provider || 'unknown',
      model: aiRes?.model || 'unknown',
      fallbackReason: aiRes?._fallbackReason || null,
      providerLatencyMs: aiRes?._latency ?? aiMs,
      routeAiLatencyMs: aiMs,
      totalRouteLatencyMs: Date.now() - startedAt
    };

    try {
      if (supabase) {
        await supabase.from('estimates').insert({
          total: finalEstimate.total,
          details: { ...finalEstimate, customer, vehicle: evidenceVehicle }
        });
      }
    } catch (e) {
      // DB target optional
    }

    console.log(`[${traceId}] [Estimate Ready]`, {
      provider: finalEstimate.aiTrace.provider,
      fallbackReason: finalEstimate.aiTrace.fallbackReason,
      probabilityTotal: finalEstimate.probability.reduce((sum, item) => sum + item.likelihood, 0),
      authorizedRepairs: finalEstimate.candidates.filter(candidate => candidate.repairAuthorized).length,
      totalMs: finalEstimate.aiTrace.totalRouteLatencyMs
    });

    res.json({ success: true, appliedRustPenalty: rustBeltMultiplier > 1.0, estimate: finalEstimate });
  } catch (err) {
    console.error(`[${traceId}] [Estimate System Fault]:`, err.message);
    res.status(500).json({ success: false, error: 'Estimate generation failed completely.', details: err.message, traceId });
  }
});

module.exports = router;
