const express = require('express');
const router = express.Router();
const { aiChat } = require('../services/ai/aiClient');
const { verifiedEstimateInput } = require('../core/evidence/verified.case');
const {
  buildVerifiedRepairResolution,
  assertRepairResolutionIntegrity
} = require('../core/evidence/verified.repair.resolution');
const {
  ESTIMATE_RESPONSE_FORMAT,
  buildEvidenceLedger,
  compactLedgerForModel,
  buildFinalEstimate
} = require('../contracts/estimate.ai.contract');
const { supabase } = require('../db');

const VERIFIED_CASE_ERROR = 'Verified diagnostic truth is required for estimate generation.';
const VERIFIED_CASE_ERROR_CODE = 'VERIFIED_CASE_REQUIRED_OR_INVALID';

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

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeAIReasoning(verifiedCause, verificationRef, note = '') {
  return {
    priority: 'medium',
    diagnosis: `Verified fault: ${verifiedCause}`,
    estimatedHours: 1,
    candidates: [{
      cause: verifiedCause,
      component: verifiedCause,
      modelConfidence: 90,
      evidenceRefs: [verificationRef],
      contradictions: [],
      confirmationTests: [],
      evidenceClass: 'MEASURED_FACT',
      factorySupported: false,
      mechanicSupported: false,
      measuredSupported: true,
      confirmationRequired: false,
      confirmed: true,
      repairAuthorized: true
    }],
    repairActions: [{
      action: `Repair verified fault: ${verifiedCause}`,
      component: verifiedCause,
      evidenceRefs: [verificationRef],
      confirmationRequired: false,
      repairAuthorized: true
    }],
    repairSteps: [],
    proTips: [],
    additionalChecks: [],
    notes: note
  };
}

function forceVerifiedTruth(ai = {}, verifiedCase, verificationRef) {
  const verifiedCause = clean(
    verifiedCase?.verification?.confirmedCause || verifiedCase?.repairScope?.[0]?.cause,
    300
  );
  if (!verifiedCause) throw new Error('VERIFIED_CASE is missing an explicit confirmed cause');

  const firstCandidate = Array.isArray(ai.candidates) && ai.candidates.length ? ai.candidates[0] : {};
  const refs = new Set(Array.isArray(firstCandidate.evidenceRefs) ? firstCandidate.evidenceRefs : []);
  refs.add(verificationRef);

  return {
    ...ai,
    diagnosis: `Verified fault: ${verifiedCause}`,
    candidates: [{
      ...firstCandidate,
      cause: verifiedCause,
      component: verifiedCause,
      evidenceRefs: [...refs],
      confirmationTests: [],
      confirmationRequired: false,
      confirmed: true,
      repairAuthorized: true
    }],
    repairActions: [{
      action: `Repair verified fault: ${verifiedCause}`,
      component: verifiedCause,
      evidenceRefs: [verificationRef],
      confirmationRequired: false,
      repairAuthorized: true
    }],
    repairSteps: []
  };
}

function enforceVerifiedFinalEstimate(finalEstimate, verifiedCause, verificationRef) {
  const evaluated = finalEstimate.candidates?.[0] || {};
  const evidenceRefs = [...new Set([...(evaluated.evidenceRefs || []), verificationRef])];
  const supportingEvidenceRefs = [...new Set([...(evaluated.supportingEvidenceRefs || []), verificationRef])];

  finalEstimate.diagnosis = `Verified fault: ${verifiedCause}`;
  finalEstimate.candidates = [{
    ...evaluated,
    cause: verifiedCause,
    component: verifiedCause,
    evidenceClass: 'MEASURED_FACT',
    evidenceRefs,
    supportingEvidenceRefs,
    measuredSupported: true,
    confirmationTests: [],
    confirmationRequired: false,
    confirmed: true,
    repairAuthorized: true
  }];
  finalEstimate.probability = [{ cause: verifiedCause, likelihood: 100 }];
  finalEstimate.repairs = [`Repair verified fault: ${verifiedCause}`];
  finalEstimate.repairSteps = [];
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
    const canonical = verifiedEstimateInput(req.body?.verifiedCase);
    const verifiedCase = canonical.verifiedCase;
    const packet = verifiedCase.evidencePacket;
    if (!packet || packet.stage !== 'DIAGNOSE') {
      return res.status(409).json({
        success: false,
        error: VERIFIED_CASE_ERROR,
        code: VERIFIED_CASE_ERROR_CODE,
        traceId
      });
    }

    const laborRateNum = Math.max(0, Number(req.body?.laborRate ?? 65));
    const partsCostNum = Math.max(0, Number(req.body?.partsCost ?? 0));
    const customer = req.body?.customer || {};

    const vehicle = verifiedCase.vehicle || packet.vehicle || {};
    const customerStates = packet.observations?.customer || [];
    const mechanicNotices = packet.observations?.mechanic || [];
    const obdCodes = packet.dtcs || [];
    const diagnosticTests = verifiedCase.tests || [];
    const completedWork = packet.observations?.completedWork || [];
    const verifiedCause = clean(verifiedCase.verification?.confirmedCause || verifiedCase.repairScope?.[0]?.cause, 300);
    if (!verifiedCause) throw new Error('VERIFIED_CASE is missing an explicit confirmed cause');

    const oemReferences = (packet.evidence?.oem || []).slice(0, 8);
    const relevantTsbs = (packet.evidence?.tsbs || []).slice(0, 6);
    const estimateSources = (packet.evidence?.sources || []).filter(source => source !== 'NHTSA_ODI' && source !== 'NHTSA ODI');

    const ledger = buildEvidenceLedger({
      oemReferences,
      relevantTsbs,
      customerStates,
      mechanicNotices,
      obdCodes,
      diagnosticTests
    });
    const verificationRef = 'VERIFY_001';
    ledger.push({
      id: verificationRef,
      type: 'MEASURED_FACT',
      text: [verifiedCause, verifiedCase.verification?.conclusion, verifiedCase.verification?.notes]
        .map(clean)
        .filter(Boolean)
        .join(' | ')
    });

    const compactLedger = compactLedgerForModel(ledger);
    const evidenceText = JSON.stringify(compactLedger);
    const rawRustMultiplier = Number(packet.deterministic?.vehicleProfile?.rustMultiplier);
    const hasVerifiedRustMultiplier = Number.isFinite(rawRustMultiplier) && rawRustMultiplier >= 1;
    const rustBeltMultiplier = hasVerifiedRustMultiplier ? rawRustMultiplier : 1;
    const vehicleStr = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ') || 'Unknown Vehicle';

    const systemPrompt = `You are the repair-estimate reasoning module of SKSK ProTech. Return only the JSON object required by the supplied JSON Schema.\n\nCONTRACT RULES:\n- The mechanic has already completed TEST -> VERIFY. The VERIFIED CAUSE supplied below is immutable diagnostic truth. Do not diagnose a different cause, add a competing fault, or revoke verification.\n- Your job is to describe repair of the verified fault using only the supplied VERIFIED_CASE evidence.\n- JSON booleans are real booleans: true or false.\n- Do not output laborCost, partsCost, total, or laborRate. Those are mechanic-owned/deterministic.\n- estimatedHours is advisory only; explicit mechanic laborHours overrides it deterministically.\n- evidenceRefs may contain ONLY IDs present in the supplied EVIDENCE LEDGER.\n- Never invent a TSB, OEM procedure, torque, measurement, construction method, special tool, or vehicle-specific failure pattern.\n- repairActions and repairSteps must stay within the verified repair scope.\n- proTips that claim factory facts must cite supplied OEM/TSB evidence.\n- Probabilities/confidence are advisory only and will be normalized deterministically.`;

    const userPrompt = `VERIFIED CAUSE: ${verifiedCause}\nVehicle: ${vehicleStr}\nVIN: ${vehicle.vin || 'N/A'}\nMileage: ${vehicle.mileage || 'N/A'}\nMechanic-entered labor rate: $${laborRateNum}/hr (DO NOT MODIFY)\nMechanic-entered parts cost: $${partsCostNum} (DO NOT MODIFY)\nMechanic-entered labor hours: ${req.body?.laborHours ?? 'not supplied'} (OVERRIDES ADVISORY HOURS WHEN PRESENT)\n\nVERIFIED_CASE fingerprint: ${verifiedCase.fingerprint}\nEVIDENCE LEDGER:\n${evidenceText}`;

    const aiStartedAt = Date.now();
    const aiRes = await aiChat({
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 2500,
      temperature: 0.15,
      reasoning_effort: 'low',
      response_format: ESTIMATE_RESPONSE_FORMAT
    });
    const aiMs = Date.now() - aiStartedAt;

    const aiText = typeof aiRes === 'string' ? aiRes : (aiRes?.choices?.[0]?.message?.content || '');
    let parsed = extractJSON(aiText);
    if (!parsed) {
      parsed = safeAIReasoning(verifiedCause, verificationRef, 'AI schema output could not be parsed; verified repair scope retained.');
    }
    parsed = forceVerifiedTruth(parsed, verifiedCase, verificationRef);

    const repairResolution = buildVerifiedRepairResolution({
      verifiedCase,
      laborRate: laborRateNum,
      laborHours: req.body?.laborHours,
      modelEstimatedHours: parsed.estimatedHours,
      parts: req.body?.parts,
      partsCost: partsCostNum
    });
    const lockedRepairResolution = assertRepairResolutionIntegrity(repairResolution, verifiedCase);
    parsed = { ...parsed, estimatedHours: lockedRepairResolution.labor.hours };

    const finalEstimate = buildFinalEstimate(parsed, {
      ledger,
      laborRate: lockedRepairResolution.labor.hourlyRate,
      partsCost: lockedRepairResolution.partsTotal,
      rustMultiplier: rustBeltMultiplier
    });
    enforceVerifiedFinalEstimate(finalEstimate, verifiedCause, verificationRef);
    finalEstimate.repairResolution = lockedRepairResolution;

    finalEstimate.knownIssues = relevantTsbs.slice(0, 3).map(x =>
      `TSB candidate: ${x.title || 'Factory service bulletin reference'}${x.url ? ` — ${x.url}` : ''}`
    );
    const unsupportedTorqueSpecsRemoved = sanitizeUnsupportedTorque(finalEstimate, evidenceText);

    finalEstimate.rustAdjustment = hasVerifiedRustMultiplier
      ? {
          applied: rustBeltMultiplier > 1,
          multiplier: rustBeltMultiplier,
          source: 'VERIFIED_CASE'
        }
      : {
          applied: false,
          reason: 'not_present_in_verified_packet'
        };

    finalEstimate.notes = [
      finalEstimate.notes,
      `Diagnostic truth source: VERIFIED_CASE ${verifiedCase.fingerprint}.`,
      `Repair resolution source: ${lockedRepairResolution.fingerprint}.`,
      `Completed repairs excluded from diagnostic re-interpretation: ${completedWork.join(', ') || 'none'}.`
    ].filter(Boolean).join(' ');

    finalEstimate.evidence = {
      oem: oemReferences,
      tsbs: relevantTsbs,
      sources: estimateSources,
      available: !!(oemReferences.length || relevantTsbs.length),
      completedWorkExcluded: completedWork,
      drivetrain: vehicle.drivetrain || '',
      unsupportedTorqueSpecsRemoved,
      packetSchemaVersion: packet.schemaVersion,
      verifiedCaseFingerprint: verifiedCase.fingerprint,
      repairResolutionFingerprint: lockedRepairResolution.fingerprint,
      ledger: compactLedger.map(ref => ({ id: ref.id, type: ref.type, title: ref.title || '', url: ref.url || '' })),
      claimTrace: finalEstimate.candidates.map(candidate => ({
        cause: candidate.cause,
        component: candidate.component,
        evidenceClass: candidate.evidenceClass,
        evidenceRefs: candidate.evidenceRefs,
        supportingEvidenceRefs: candidate.supportingEvidenceRefs,
        finalConfidence: candidate.finalConfidence,
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
        await supabase.from('estimates').insert({ total: finalEstimate.total, details: { ...finalEstimate, customer, vehicle } });
      }
    } catch (_) {}

    return res.json({ success: true, appliedRustPenalty: rustBeltMultiplier > 1, estimate: finalEstimate });
  } catch (err) {
    console.error(`[${traceId}] [Estimate System Fault]:`, err.message);
    const verificationFailure = /VERIFIED_CASE|Verified case|verified|repair resolution/i.test(err.message || '');
    return res.status(verificationFailure ? 409 : 500).json({
      success: false,
      error: verificationFailure ? VERIFIED_CASE_ERROR : 'Estimate generation failed completely.',
      code: verificationFailure ? VERIFIED_CASE_ERROR_CODE : 'ESTIMATE_GENERATION_FAILED',
      traceId
    });
  }
});

module.exports = router;
