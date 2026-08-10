const express = require('express');
const router = express.Router();
const { runDiagnosticPipeline } = require('../services/pipeline.engine');
const { groqChat } = require('../services/groq');
const { calibrateProbabilityArray } = require('../core/metrics/index');
const { getVehicleRiskProfile } = require('../knowledge/vehicle.risk.table');
const { findKnownPatterns } = require('../knowledge/failure.patterns');
const { getLocalProcedure } = require('../knowledge/procedure.data');
const { applyCompletedWorkGuard } = require('../core/orchestrator/completed.work.guard');
const { recordGuardCatch } = require('../core/learning/guard.catch.recorder');
const { collectVehicleEvidence, selectRelevantTsbs } = require('../services/vehicle.evidence');
const { resolveVehicleProfile, waitForVehicleWarmup } = require('../services/vehicle.warmup');

function extractJSON(text) {
  if (!text) return null;
  text = text.replace(/\`\`\`json\s*/gi, '').replace(/\`\`\`\s*/g, '');
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
    urgency: 'soon',
    safetyRisk: false,
    primaryCause: 'Manual inspection required',
    secondaryCauses: [],
    codeExplanations: {},
    probability: [],
    knownIssues: [],
    repairSteps: [],
    proTips: [],
    recommendedTests: [],
    additionalChecks: [],
    estimatedRepairTime: 'N/A',
    notes: '',
    diagnosticConfidence: { percentage: 30, rating: 'LOW' },
    localVehicleTelemetry: null,
    injectedFieldProtocols: [],
    calculatedLaborBreakdown: [],
    partsRiskAnalysis: [],
    vinManufacturingTelemetry: null,
    ...overrides
  };
}

router.post('/', async (req, res) => {
  const executionTrace = {
    traceId: 'TR-' + Date.now().toString(16).toUpperCase(),
    stage: 'INGESTION',
    logs: [],
    log: function(stage, message) {
      this.stage = stage;
      this.logs.push(`[${stage}] ${message}`);
    }
  };

  executionTrace.log('API_ROUTER', 'Payload received.');

  try {
    const {
      vin = '',
      mileage = 0,
      symptoms = [],
      codes = [],
      customerStates = [],
      mechanicNotices = [],
      obdCodes = [],
      notes = [],
      keywords = [],
      vehicle = {},
      laborRate = 65,
      axleCode = ''
    } = req.body;

    const targetCodes = Array.isArray(codes) && codes.length ? codes : (Array.isArray(obdCodes) ? obdCodes : []);
    const customerSymptomContext = [
      ...(Array.isArray(symptoms) ? symptoms : []),
      ...(Array.isArray(customerStates) ? customerStates : [])
    ].map(s => String(s).toLowerCase().trim()).filter(Boolean);
    const mechanicContext = [
      ...(Array.isArray(mechanicNotices) ? mechanicNotices : []),
      ...(Array.isArray(notes) ? notes : [])
    ].map(s => String(s).trim()).filter(Boolean);
    const targetSymptoms = [
      ...customerSymptomContext,
      ...(Array.isArray(mechanicNotices) ? mechanicNotices : [])
    ].map(s => String(s).toLowerCase().trim()).filter(Boolean);

    let resolvedVehicle = vehicle;
    try {
      resolvedVehicle = await resolveVehicleProfile(vin, vehicle);
      if (resolvedVehicle?.make) executionTrace.log('VIN_PROFILE', `${resolvedVehicle.year} ${resolvedVehicle.make} ${resolvedVehicle.model} ${resolvedVehicle.driveType || ''}`.trim());
    } catch (err) {
      executionTrace.log('VIN_PROFILE_WARN', `VIN/profile resolution failed: ${err.message}`);
    }

    let compiledData = {
      profile: null,
      vinBuildProfile: null,
      localSafetyTriggered: false,
      safetyNotes: '',
      matchedPatterns: [],
      assemblyData: null,
      dynamicRisk: 0,
      confidence: { percentage: 30, rating: 'LOW' },
      symptomTelemetry: { hasMismatchedSignals: false, categories: {}, overlappingClassesCount: 0 }
    };

    try {
      compiledData = runDiagnosticPipeline({
        vehicle: resolvedVehicle, vin, axleCode, symptoms: targetSymptoms, codes: targetCodes, notes, laborRate, mileage
      }, executionTrace);
    } catch (pipelineErr) {
      executionTrace.log('PIPELINE_WARN', `Pipeline skipped: ${pipelineErr.message}`);
    }

    const {
      profile,
      vinBuildProfile,
      localSafetyTriggered,
      safetyNotes,
      matchedPatterns,
      assemblyData,
      dynamicRisk,
      confidence,
      symptomTelemetry
    } = compiledData;

    const localProfile = getVehicleRiskProfile(resolvedVehicle, vin);
    const platformHits = findKnownPatterns(localProfile, targetSymptoms, targetCodes);

    if (platformHits && platformHits.length > 0) {
      const hit = platformHits[0];
      const procedureSpecs = getLocalProcedure(hit.linkProtocol);

      executionTrace.log('LOCAL_MATCH', `Deterministic hit: ${hit.patternName}`);

      const rawTips = procedureSpecs && procedureSpecs.criticalSpecs ? [
        procedureSpecs.criticalSpecs.torqueSequence,
        procedureSpecs.criticalSpecs.antiseizeNote
      ] : [];
      const cleanTips = rawTips.filter(Boolean);
      if (cleanTips.length === 0) {
        cleanTips.push('Always verify clearance specifications against factory block data prior to teardown.');
      }

      const localResult = safeResult({
        urgency: 'immediate',
        safetyRisk: true,
        primaryCause: hit.patternName.toUpperCase(),
        notes: `Offline deterministic match active. ${hit.primaryCause}`.trim(),
        diagnosticConfidence: confidence || { percentage: 95, rating: 'HIGH' },
        localVehicleTelemetry: localProfile ? { ...localProfile, dynamicCalculatedRisk: dynamicRisk } : null,
        probability: [{ cause: hit.patternName, likelihood: hit.likelihood }],
        repairSteps: procedureSpecs ? procedureSpecs.clearanceSteps : [],
        proTips: cleanTips
      });

      return res.json({ success: true, result: localResult, traceLog: { traceId: executionTrace.traceId, logs: executionTrace.logs } });
    }

    if (!process.env.GROQ_API_KEY) {
      executionTrace.log('FATAL', 'Cloud key missing during local database miss.');
      return res.status(503).json({
        success: false,
        error: 'Diagnosis failed',
        details: 'Local pattern database miss and cloud GROQ_API_KEY is not configured.',
        trace: executionTrace.traceId
      });
    }

    const inputMake = (resolvedVehicle.make || '').toLowerCase();
    const inputModel = (resolvedVehicle.model || '').toLowerCase();
    const profileId = profile ? profile.vehicleId : '';

    let isProfileValidContext = false;
    if (profileId === 'FORD_F150_3V_TRITON' && inputMake.includes('ford') && (inputModel.includes('150') || inputModel.includes('f-150'))) {
      isProfileValidContext = true;
    } else if (profileId === 'GM_SILVERADO_AFM_5.3' && (inputMake.includes('chev') || inputMake.includes('gm')) && (inputModel.includes('silverado') || inputModel.includes('sierra'))) {
      isProfileValidContext = true;
    } else if (profileId === 'FORD_3.5_ECOBOOST_V1' && inputMake.includes('ford') && (inputModel.includes('150') || inputModel.includes('f-150'))) {
      isProfileValidContext = true;
    }

    const evidenceContext = {
      symptoms: customerSymptomContext.join(' '),
      mechanicNotices: mechanicContext,
      obdCodes: targetCodes,
      keywords
    };
    let vehicleEvidence = { available: false, oem: { references: [] }, tsbs: { references: [] }, sources: [], errors: [] };
    let warmupStatus = { status: 'NOT_STARTED' };
    if (resolvedVehicle?.year && resolvedVehicle?.make && resolvedVehicle?.model) {
      try {
        warmupStatus = await waitForVehicleWarmup(resolvedVehicle, 2500);
        vehicleEvidence = await collectVehicleEvidence(resolvedVehicle, evidenceContext, { includeNhtsa: false });
      } catch (err) {
        executionTrace.log('EVIDENCE_WARN', `Vehicle evidence unavailable: ${err.message}`);
      }
    }
    const relevantTsbs = selectRelevantTsbs(vehicleEvidence, evidenceContext, 12);
    const oemReferences = (vehicleEvidence.oem?.references || []).slice(0, 6);
    const compactEvidence = {
      OEM_FACTORY_REFERENCES: oemReferences.map(x => ({ title: x.title, url: x.url, type: x.evidenceType, facts: x.extractedFacts })),
      TSB_CANDIDATES: relevantTsbs.slice(0, 5).map(x => ({ title: x.title, url: x.url, facts: x.extractedFacts, relevanceScore: x.relevanceScore })),
      SOURCES: (vehicleEvidence.sources || []).filter(source => source !== 'NHTSA_ODI' && source !== 'NHTSA ODI')
    };

    let systemPrompt = `You are the expert diagnostic logic unit of SKSK ProTech — a master automotive diagnostician with 25 years of real shop experience.
Output a single valid JSON object ONLY. No backticks, markdown, or text before/after.
{
 "urgency":"immediate|soon|monitor","safetyRisk":false,"primaryCause":"string","secondaryCauses":["string"],
 "codeExplanations":{"P0300":"string"},"probability":[{"cause":"string","likelihood":80}],
 "knownIssues":["string"],"repairSteps":["string"],"proTips":["string"],"recommendedTests":["string"],
 "additionalChecks":["string"],"estimatedRepairTime":"string","notes":"string"
}
RULES:
- urgency exactly immediate, soon, or monitor. safetyRisk true only if driving the vehicle as-is risks loss of control, fire, or injury.
- codeExplanations must cover every OBD code provided, keyed exactly as given (e.g. "P0300").
- probability likelihoods should roughly sum to 100 across all listed causes; rank by evidence, not by which symptom was mentioned first.
- All array values must be strings.
- EVIDENCE HIERARCHY: verified/measured facts and deterministic knowledge outrank mechanic observations; mechanic observations outrank customer-translated symptom wording. Treat translated customer wording as no more than ~5% directional influence: use it to understand the observed symptom and operating conditions, never as proof that a component/system named by the translator is the cause.
- MECHANIC NOTICES / TECH NOTES are high-value diagnostic context. Completed repairs, measured play, leaks, readings, inspection results, noise location, and technician observations must materially affect ranking.
- RETRIEVAL KEYWORDS are search-only metadata. They must never influence diagnostic ranking directly and are intentionally excluded from the AI prompt.
- Never invent a TSB number, recall number, or campaign number — omit rather than fabricate.
- KNOWN ISSUES / VEHICLE-SPECIFIC CLAIMS: never state that a condition is common, known, frequent, or specific to this model/year/manufacturer unless that claim is directly supported by evidence actually supplied in this prompt. Do not rely on general model memory for knownIssues. If no supplied evidence supports a known-issue claim, return knownIssues as an empty array rather than writing a plausible-sounding one.
- Never recommend replacing a component the mechanic notes already replaced.
MULTI-CONDITION REASONING: When the same symptom occurs under two or more distinct operating conditions (e.g. deceleration AND full steering lock, or cold-start AND hard acceleration), analyze what changes mechanically in each condition, then prioritize causes plausible under ALL the reported conditions over causes that only fit one. Consider three hypotheses: (1) one component explains every occurrence, (2) different components in the same system produce a similar-sounding reaction, (3) two unrelated faults happen to sound alike. Use the overlap between conditions to narrow the diagnostic tree rather than anchoring on the most obvious single-condition match.
- Output raw JSON only.`;

    if (profile && isProfileValidContext) {
      systemPrompt += `\n\nVEHICLE PROFILE: ${JSON.stringify({ ...profile, dynamicRisk }, null, 2)}`;
    }
    if (assemblyData && isProfileValidContext && assemblyData.breakdowns.length > 0) {
      systemPrompt += `\n\nLABOR: ${JSON.stringify(assemblyData.breakdowns, null, 2)}\nPARTS: ${JSON.stringify(assemblyData.partsRisks, null, 2)}`;
    }

    const userPrompt = `Vehicle: ${[resolvedVehicle.year, resolvedVehicle.make, resolvedVehicle.model, resolvedVehicle.trim || resolvedVehicle.engine].filter(Boolean).join(' ') || 'N/A'} | Drivetrain: ${resolvedVehicle.driveType || resolvedVehicle.drivetrain || 'unknown'} | VIN: ${vin || 'N/A'} | Mileage: ${mileage || 'N/A'} | Codes: ${targetCodes.join(', ') || 'None'} | LOW-WEIGHT CUSTOMER SYMPTOM CONTEXT (~5%): ${customerSymptomContext.join(', ') || 'N/A'} | HIGH-WEIGHT MECHANIC / TECH OBSERVATIONS: ${mechanicContext.join(', ') || 'N/A'}\n\nVEHICLE EVIDENCE:\n${JSON.stringify(compactEvidence)}`;

    executionTrace.log('GROQ_DISPATCH', 'Sending to Groq...');

    const groqRes = await groqChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { max_tokens: 2500, temperature: 0.15, reasoning_effort: 'low', response_format: { type: 'json_object' } });

    const aiText = typeof groqRes === 'string'
      ? groqRes
      : (groqRes?.choices?.[0]?.message?.content || '');

    if (!aiText) throw new Error('Groq returned empty response');

    let parsed = extractJSON(aiText);

    if (!parsed || typeof parsed !== 'object') {
      console.warn('[Diagnose] JSON extract failed. Raw snippet:', aiText.substring(0, 300));
      parsed = safeResult({ notes: 'AI returned unparseable response — please retry' });
    }

    const completedWorkContext = [
      ...(Array.isArray(notes) ? notes : []),
      ...(Array.isArray(mechanicNotices) ? mechanicNotices : [])
    ];
    const guardResult = applyCompletedWorkGuard(parsed, completedWorkContext);
    if (guardResult.changed) {
      executionTrace.log('COMPLETED_WORK_GUARD', `Removed ${guardResult.removed.length} recommendation(s) already completed: ${guardResult.removed.join(' | ')}`);
      console.log(`[Diagnose] Completed-work guard filtered ${guardResult.removed.length} item(s):`, guardResult.removed);

      recordGuardCatch({
        requestId: executionTrace.traceId,
        route: '/api/diagnose',
        vehicle: resolvedVehicle,
        completedWork: guardResult.completedWork,
        removedItems: guardResult.removed,
        primaryCauseFlagged: !!parsed.primaryCauseFlaggedForReview,
        model: groqRes?.model || 'openai/gpt-oss-120b'
      }).catch(err => console.warn('[Diagnose] recordGuardCatch failed (non-fatal):', err.message));
    }
    parsed = guardResult.output;

    const finalResult = { ...safeResult(), ...parsed };
    finalResult.knownIssues = relevantTsbs.slice(0, 3).map(x =>
      `TSB candidate: ${x.title || 'Factory service bulletin reference'}${x.url ? ` — ${x.url}` : ''}`
    );
    finalResult.evidence = {
      oem: oemReferences,
      tsbs: relevantTsbs.slice(0, 5),
      sources: compactEvidence.SOURCES,
      available: !!(oemReferences.length || relevantTsbs.length),
      drivetrain: resolvedVehicle.driveType || resolvedVehicle.drivetrain || '',
      warmupStatus: warmupStatus.status
    };

    res.json({ success: true, result: finalResult, traceLog: { traceId: executionTrace.traceId, logs: executionTrace.logs } });

  } catch (err) {
    executionTrace.log('FATAL', err.message);
    console.error(`[Diagnose Fatal ${executionTrace.traceId}]:`, err.message);
    res.status(500).json({ success: false, error: 'Diagnosis failed', details: err.message, trace: executionTrace.traceId });
  }
});

module.exports = router;
