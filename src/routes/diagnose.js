const express = require('express');
const router = express.Router();
const { runDiagnosticPipeline } = require('../services/pipeline.engine');
const { aiChat } = require('../services/ai/aiClient');
const { calibrateProbabilityArray } = require('../core/metrics/index');
const { getVehicleRiskProfile } = require('../knowledge/vehicle.risk.table');
const { findKnownPatterns } = require('../knowledge/failure.patterns');
const { getLocalProcedure } = require('../knowledge/procedure.data');
const { applyCompletedWorkGuard } = require('../core/orchestrator/completed.work.guard');
const { applyDiagnosticStageGuard } = require('../core/orchestrator/diagnostic.stage.guard');
const { recordGuardCatch } = require('../core/learning/guard.catch.recorder');
const { buildDiagnosticEvidencePacket, compactDiagnosticEvidencePacket } = require('../core/evidence/diagnostic.evidence.packet');
const { publicSourceHealth } = require('../core/evidence/source.resilience');
const {
  resolveRequestDtcEvidence,
  trustedDtcCodes,
  summarizeDtcProvenance,
  publicDtcEvidence
} = require('../core/evidence/dtc.provenance');
const { collectVehicleEvidence, selectRelevantTsbs } = require('../services/vehicle.evidence');
const { resolveVehicleProfile, waitForVehicleWarmup } = require('../services/vehicle.warmup');

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

function safeResult(overrides = {}) {
  return {
    urgency: 'soon', safetyRisk: false, primaryCause: 'Manual inspection required', secondaryCauses: [],
    codeExplanations: {}, probability: [], knownIssues: [], repairSteps: [], proTips: [], recommendedTests: [],
    additionalChecks: [], estimatedRepairTime: 'N/A', notes: '', diagnosticConfidence: { percentage: 30, rating: 'LOW' },
    localVehicleTelemetry: null, injectedFieldProtocols: [], calculatedLaborBreakdown: [], partsRiskAnalysis: [], vinManufacturingTelemetry: null,
    dtcProvenance: null,
    ...overrides
  };
}

function withDynamicRisk(profile, dynamicRisk) {
  if (!profile) return null;
  if (dynamicRisk === undefined || dynamicRisk === null) return { ...profile };
  return { ...profile, dynamicCalculatedRisk: dynamicRisk };
}

function filterCodeExplanations(value, trustedCodes = []) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  for (const code of trustedCodes) {
    const explanation = String(source[code] ?? '').replace(/\s+/g, ' ').trim();
    if (explanation) output[code] = explanation.slice(0, 800);
  }
  return output;
}

router.post('/', async (req, res) => {
  const executionTrace = { traceId: 'TR-' + Date.now().toString(16).toUpperCase(), stage: 'INGESTION', logs: [], log(stage, message) { this.stage = stage; this.logs.push(`[${stage}] ${message}`); } };
  executionTrace.log('API_ROUTER', 'Payload received.');
  try {
    const { vin = '', mileage = 0, symptoms = [], customerStates = [], mechanicNotices = [], notes = [], keywords = [], vehicle = {}, laborRate = 65, axleCode = '' } = req.body;
    const normalizedDtcEvidence = resolveRequestDtcEvidence(req.body || {});
    const targetCodes = trustedDtcCodes(normalizedDtcEvidence);
    const dtcProvenance = summarizeDtcProvenance(normalizedDtcEvidence);
    if (dtcProvenance.excludedCount > 0) {
      executionTrace.log('DTC_PROVENANCE', `${dtcProvenance.excludedCount} entered DTC record(s) excluded from diagnostic reasoning because they were not verified scan-tool evidence.`);
    }
    if (dtcProvenance.verifiedCount > 0) {
      executionTrace.log('DTC_PROVENANCE', `${dtcProvenance.verifiedCount} verified scan-tool DTC record(s) admitted to diagnostic reasoning.`);
    }

    const customerSymptomContext = [...(Array.isArray(symptoms) ? symptoms : []), ...(Array.isArray(customerStates) ? customerStates : [])].map(s => String(s).toLowerCase().trim()).filter(Boolean);
    const mechanicContext = [...(Array.isArray(mechanicNotices) ? mechanicNotices : []), ...(Array.isArray(notes) ? notes : [])].map(s => String(s).trim()).filter(Boolean);
    const targetSymptoms = [...customerSymptomContext, ...(Array.isArray(mechanicNotices) ? mechanicNotices : [])].map(s => String(s).toLowerCase().trim()).filter(Boolean);

    let resolvedVehicle = vehicle;
    try { resolvedVehicle = await resolveVehicleProfile(vin, vehicle); if (resolvedVehicle?.make) executionTrace.log('VIN_PROFILE', `${resolvedVehicle.year} ${resolvedVehicle.make} ${resolvedVehicle.model} ${resolvedVehicle.driveType || ''}`.trim()); }
    catch (err) { executionTrace.log('VIN_PROFILE_WARN', `VIN/profile resolution failed: ${err.message}`); }

    let compiledData = { profile: null, vinBuildProfile: null, localSafetyTriggered: false, safetyNotes: '', matchedPatterns: [], assemblyData: null, confidence: { percentage: 30, rating: 'LOW' }, symptomTelemetry: { hasMismatchedSignals: false, categories: {}, overlappingClassesCount: 0 } };
    try { compiledData = runDiagnosticPipeline({ vehicle: resolvedVehicle, vin, axleCode, symptoms: targetSymptoms, codes: targetCodes, notes, laborRate, mileage }, executionTrace); }
    catch (pipelineErr) { executionTrace.log('PIPELINE_WARN', `Pipeline skipped: ${pipelineErr.message}`); }
    const { profile, vinBuildProfile, localSafetyTriggered, safetyNotes, matchedPatterns, assemblyData, dynamicRisk, confidence, symptomTelemetry } = compiledData;

    const localProfile = getVehicleRiskProfile(resolvedVehicle, vin);
    const platformHits = findKnownPatterns(localProfile, targetSymptoms, targetCodes);
    if (platformHits && platformHits.length > 0) {
      const hit = platformHits[0]; const procedureSpecs = getLocalProcedure(hit.linkProtocol);
      executionTrace.log('LOCAL_MATCH', `Deterministic hit: ${hit.patternName}`);
      const rawTips = procedureSpecs && procedureSpecs.criticalSpecs ? [procedureSpecs.criticalSpecs.torqueSequence, procedureSpecs.criticalSpecs.antiseizeNote] : [];
      const cleanTips = rawTips.filter(Boolean); if (!cleanTips.length) cleanTips.push('Always verify clearance specifications against factory block data prior to teardown.');
      const localResult = safeResult({ urgency: 'immediate', safetyRisk: true, primaryCause: hit.patternName.toUpperCase(), notes: `Offline deterministic match active. ${hit.primaryCause}`.trim(), diagnosticConfidence: confidence || { percentage: 95, rating: 'HIGH' }, localVehicleTelemetry: withDynamicRisk(localProfile, dynamicRisk), probability: [{ cause: hit.patternName, likelihood: hit.likelihood }], recommendedTests: procedureSpecs ? procedureSpecs.clearanceSteps : [], repairSteps: [], proTips: cleanTips, dtcProvenance: { ...dtcProvenance, records: publicDtcEvidence(normalizedDtcEvidence) } });
      return res.json({ success: true, result: localResult, traceLog: { traceId: executionTrace.traceId, logs: executionTrace.logs } });
    }

    const inputMake = (resolvedVehicle.make || '').toLowerCase(); const inputModel = (resolvedVehicle.model || '').toLowerCase(); const profileId = profile ? profile.vehicleId : '';
    let isProfileValidContext = false;
    if (profileId === 'FORD_F150_3V_TRITON' && inputMake.includes('ford') && (inputModel.includes('150') || inputModel.includes('f-150'))) isProfileValidContext = true;
    else if (profileId === 'GM_SILVERADO_AFM_5.3' && (inputMake.includes('chev') || inputMake.includes('gm')) && (inputModel.includes('silverado') || inputModel.includes('sierra'))) isProfileValidContext = true;
    else if (profileId === 'FORD_3.5_ECOBOOST_V1' && inputMake.includes('ford') && (inputModel.includes('150') || inputModel.includes('f-150'))) isProfileValidContext = true;

    const evidenceContext = { symptoms: customerSymptomContext.join(' '), mechanicNotices: mechanicContext, obdCodes: targetCodes, keywords };
    let vehicleEvidence = { available: false, oem: { references: [] }, tsbs: { references: [] }, sources: [], errors: [], sourceHealth: null, sourceStatusMessage: '' }; let warmupStatus = { status: 'NOT_STARTED' };
    if (resolvedVehicle?.year && resolvedVehicle?.make && resolvedVehicle?.model) {
      try {
        warmupStatus = await waitForVehicleWarmup(resolvedVehicle, 2500);
        const previewLemonOutage = process.env.IS_PULL_REQUEST === 'true' && String(req.get('x-sksk-preview-source-outage') || '').toUpperCase() === 'LEMON';
        if (previewLemonOutage) executionTrace.log('EVIDENCE_SOURCE_CANARY', 'Simulating optional LEMON source outage on PR preview.');
        vehicleEvidence = await collectVehicleEvidence(resolvedVehicle, evidenceContext, {
          includeNhtsa: false,
          includeManual: !previewLemonOutage,
          includeLemonTsb: !previewLemonOutage
        });
        if (vehicleEvidence.sourceHealth?.mode === 'DEGRADED' || Number(vehicleEvidence.sourceHealth?.optionalUnavailableCount || 0) > 0) {
          executionTrace.log('EVIDENCE_SOURCE_DEGRADED', vehicleEvidence.sourceStatusMessage || 'Optional evidence source unavailable; continuing with remaining sources.');
        }
      } catch (err) { executionTrace.log('EVIDENCE_WARN', `Vehicle evidence unavailable: ${err.message}`); }
    }
    const relevantTsbs = selectRelevantTsbs(vehicleEvidence, evidenceContext, 12); const oemReferences = (vehicleEvidence.oem?.references || []).slice(0, 6);
    const evidencePacket = buildDiagnosticEvidencePacket({
      vin,
      mileage,
      vehicle: resolvedVehicle,
      customerObservations: customerSymptomContext,
      mechanicObservations: mechanicContext,
      dtcEvidence: normalizedDtcEvidence,
      deterministicProfile: isProfileValidContext ? profile : null,
      localSafetyTriggered,
      safetyNotes,
      matchedPatterns,
      symptomTelemetry,
      oemReferences,
      tsbReferences: relevantTsbs,
      sources: vehicleEvidence.sources || [],
      evidenceAvailable: vehicleEvidence.available,
      warmupStatus,
      sourceHealth: vehicleEvidence.sourceHealth
    });

    const systemPrompt = `You are the expert diagnostic logic unit of SKSK ProTech — a master automotive diagnostician with 25 years of real shop experience.
Output a single valid JSON object ONLY. No backticks, markdown, or text before/after.
{"urgency":"immediate|soon|monitor","safetyRisk":false,"primaryCause":"string","secondaryCauses":["string"],"codeExplanations":{"P0300":"string"},"probability":[{"cause":"string","likelihood":80}],"knownIssues":["string"],"repairSteps":["string"],"proTips":["string"],"recommendedTests":["string"],"additionalChecks":["string"],"estimatedRepairTime":"string","notes":"string"}
RULES:
- urgency exactly immediate, soon, or monitor. safetyRisk true only if driving the vehicle as-is risks loss of control, fire, or injury.
- DIAGNOSTIC_EVIDENCE_PACKET_V2.dtcs contains the ONLY DTC values authorized as diagnostic evidence. These codes were explicitly marked verified scan-tool evidence.
- dtcProvenance contains counts/source metadata only. Excluded DTC values are intentionally absent. Never infer, guess, or reconstruct excluded code identities.
- codeExplanations must cover every code in packet.dtcs, keyed exactly as given, and must not invent explanations for excluded/unlisted codes.
- probability likelihoods should roughly sum to 100; rank by evidence, not symptom order.
- All array values must be strings.
- DIAGNOSIS STAGE IS TEST-FIRST. No component is repair-authorized yet. repairSteps MUST contain only non-invasive inspection, measurement, verification, or confirmation steps. Do not instruct removal, teardown, replacement, installation, adjustment, lubrication-as-a-fix, or alignment as a repair. Put discriminating tests in recommendedTests. Actual repair procedure belongs only after TEST -> VERIFY.
- Prefer tests that separate the highest-ranked candidate from the next candidate. Order tests by safety, diagnostic value, low invasiveness, then time/cost.
- Treat DIAGNOSTIC_EVIDENCE_PACKET_V2 as the sole structured case context for reasoning.
- Evidence source health is retrieval telemetry, not vehicle evidence. An unavailable/disabled source is not evidence that a fault is absent and must never block diagnostic reasoning from the evidence that remains.
- No single external manual provider is required. Continue from trusted measurements, mechanic observations, deterministic knowledge, stored official bulletins, and any other available sources.
- EVIDENCE HIERARCHY: trusted measurements and deterministic knowledge outrank mechanic observations; mechanic observations outrank customer symptom wording.
- Customer observations are directional context only and must not override trusted measurements or deterministic evidence.
- Never invent a TSB, recall, campaign, measurement, completed repair, or vehicle-specific fact absent from the packet.
- Never state a condition is common/known/model-specific unless packet evidence supports it; otherwise knownIssues must be empty.
- Never recommend replacing completed work listed in observations.completedWork. You MAY inspect or verify its installation, torque, fitment, binding, or measured condition when diagnostically relevant.
MULTI-CONDITION REASONING: When a symptom occurs under distinct operating conditions, analyze what changes mechanically in each condition and prioritize causes plausible under all conditions. Consider one common cause, multiple causes in one system, and two unrelated faults. Use overlap to narrow the diagnostic tree.
- Output raw JSON only.`;
    const userPrompt = `DIAGNOSTIC_EVIDENCE_PACKET_V2:\n${compactDiagnosticEvidencePacket(evidencePacket)}`;

    executionTrace.log('AI_DISPATCH', 'Sending canonical diagnostic evidence packet to shared AI provider router...');
    const aiRes = await aiChat({
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 2500,
      temperature: 0.15,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' }
    });
    const aiText = typeof aiRes === 'string' ? aiRes : (aiRes?.choices?.[0]?.message?.content || ''); if (!aiText) throw new Error('AI provider returned empty response');
    let parsed = extractJSON(aiText); if (!parsed || typeof parsed !== 'object') { console.warn('[Diagnose] JSON extract failed. Raw snippet:', aiText.substring(0, 300)); parsed = safeResult({ notes: 'AI returned unparseable response — please retry' }); }

    const stageGuard = applyDiagnosticStageGuard(parsed);
    if (stageGuard.changed) {
      executionTrace.log('DIAGNOSTIC_STAGE_GUARD', `Blocked ${stageGuard.removed.length} repair/invasive action(s) before VERIFY: ${stageGuard.removed.map(x => x.text).join(' | ')}`);
      console.log(`[Diagnose] Diagnostic-stage guard blocked ${stageGuard.removed.length} item(s):`, stageGuard.removed);
    }
    parsed = stageGuard.output;

    const completedWorkContext = [...(Array.isArray(notes) ? notes : []), ...(Array.isArray(mechanicNotices) ? mechanicNotices : [])];
    const guardResult = applyCompletedWorkGuard(parsed, completedWorkContext);
    if (guardResult.changed) {
      executionTrace.log('COMPLETED_WORK_GUARD', `Removed ${guardResult.removed.length} recommendation(s) already completed: ${guardResult.removed.join(' | ')}`);
      console.log(`[Diagnose] Completed-work guard filtered ${guardResult.removed.length} item(s):`, guardResult.removed);
      recordGuardCatch({ requestId: executionTrace.traceId, route: '/api/diagnose', vehicle: resolvedVehicle, completedWork: guardResult.completedWork, removedItems: guardResult.removed, primaryCauseFlagged: !!parsed.primaryCauseFlaggedForReview, model: aiRes?.model || 'unknown-provider-model' }).catch(err => console.warn('[Diagnose] recordGuardCatch failed (non-fatal):', err.message));
    }
    parsed = guardResult.output;

    const finalResult = { ...safeResult(), ...parsed };
    finalResult.codeExplanations = filterCodeExplanations(parsed.codeExplanations, targetCodes);
    finalResult.knownIssues = relevantTsbs.slice(0, 3).map(x => `TSB candidate: ${x.title || 'Factory service bulletin reference'}${x.url ? ` — ${x.url}` : ''}`);
    finalResult.evidence = {
      oem: oemReferences,
      tsbs: relevantTsbs.slice(0, 5),
      sources: vehicleEvidence.sources || [],
      available: vehicleEvidence.available,
      warmup: warmupStatus,
      packetSchemaVersion: evidencePacket.schemaVersion,
      sourceHealth: publicSourceHealth(vehicleEvidence.sourceHealth || {}),
      sourceStatusMessage: vehicleEvidence.sourceStatusMessage || ''
    };
    finalResult.probability = calibrateProbabilityArray(finalResult.probability || [], confidence);
    finalResult.diagnosticConfidence = confidence || { percentage: 30, rating: 'LOW' };
    finalResult.localVehicleTelemetry = withDynamicRisk(localProfile, dynamicRisk);
    finalResult.vinManufacturingTelemetry = vinBuildProfile || null;
    finalResult.injectedFieldProtocols = matchedPatterns || [];
    finalResult.calculatedLaborBreakdown = assemblyData ? assemblyData.breakdowns : [];
    finalResult.partsRiskAnalysis = assemblyData ? assemblyData.partsRisks : [];
    finalResult.dtcProvenance = { ...dtcProvenance, records: publicDtcEvidence(normalizedDtcEvidence) };
    if (dtcProvenance.excludedCount > 0) {
      finalResult.notes = `${finalResult.notes || ''} ${dtcProvenance.excludedCount} entered DTC record${dtcProvenance.excludedCount === 1 ? ' was' : 's were'} excluded from diagnostic ranking because the source was not verified scan-tool evidence.`.trim();
    }
    if (localSafetyTriggered) { finalResult.safetyRisk = true; finalResult.urgency = 'immediate'; finalResult.notes = `${finalResult.notes || ''} ${safetyNotes || ''}`.trim(); }
    if (symptomTelemetry?.hasMismatchedSignals) finalResult.notes = `${finalResult.notes || ''} Multiple symptom classes detected; verify whether one fault or multiple faults are present.`.trim();
    executionTrace.log('COMPLETE', 'Diagnostic result assembled.');
    return res.json({ success: true, result: finalResult, traceLog: { traceId: executionTrace.traceId, logs: executionTrace.logs } });
  } catch (err) {
    console.error('[Diagnose] Error:', err); executionTrace.log('FATAL', err.message || 'Unknown diagnosis error');
    return res.status(500).json({ success: false, error: 'Diagnosis failed', details: err.message || 'Unknown error', trace: executionTrace.traceId });
  }
});

module.exports = router;
module.exports.filterCodeExplanations = filterCodeExplanations;