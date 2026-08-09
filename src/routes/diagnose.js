const express = require('express');
const router = express.Router();
const { runDiagnosticPipeline } = require('../services/pipeline.engine');
const { groqChat } = require('../services/groq'); // Ensure this is the correct AI service import
const { calibrateProbabilityArray } = require('../core/metrics/index');
const { getVehicleRiskProfile } = require('../knowledge/vehicle.risk.table');
const { findKnownPatterns } = require('../knowledge/failure.patterns');
const { getLocalProcedure } = require('../knowledge/procedure.data');

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
    const targetSymptoms = [
      ...(Array.isArray(symptoms) ? symptoms : []),
      ...(Array.isArray(customerStates) ? customerStates : []),
      ...(Array.isArray(mechanicNotices) ? mechanicNotices : [])
    ].map(s => String(s).toLowerCase().trim());

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
        vehicle, vin, axleCode, symptoms: targetSymptoms, codes: targetCodes, notes, laborRate, mileage
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

    const localProfile = getVehicleRiskProfile(vehicle, vin);
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
        cleanTips.push("Always verify clearance specifications against factory block data prior to teardown.");
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
        error: "Diagnosis failed",
        details: "Local pattern database miss and cloud GROQ_API_KEY is not configured.",
        trace: executionTrace.traceId
      });
    }

    const inputMake = (vehicle.make || '').toLowerCase();
    const inputModel = (vehicle.model || '').toLowerCase();
    const profileId = profile ? profile.vehicleId : '';

    let isProfileValidContext = false;
    if (profileId === 'FORD_F150_3V_TRITON' && inputMake.includes('ford') && (inputModel.includes('150') || inputModel.includes('f-150'))) {
      isProfileValidContext = true;
    } else if (profileId === 'GM_SILVERADO_AFM_5.3' && (inputMake.includes('chev') || inputMake.includes('gm')) && (inputModel.includes('silverado') || inputModel.includes('sierra'))) {
      isProfileValidContext = true;
    } else if (profileId === 'FORD_3.5_ECOBOOST_V1' && inputMake.includes('ford') && (inputModel.includes('150') || inputModel.includes('f-150'))) {
      isProfileValidContext = true;
    }

    let systemPrompt = `You are the expert logic unit of SKSK ProTech...`; // Keep your existing prompt string here

    if (profile && isProfileValidContext) {
      systemPrompt += `\n\nVEHICLE PROFILE: ${JSON.stringify({ ...profile, dynamicRisk }, null, 2)}`;
    }
    if (assemblyData && isProfileValidContext && assemblyData.breakdowns.length > 0) {
      systemPrompt += `\n\nLABOR: ${JSON.stringify(assemblyData.breakdowns, null, 2)}\nPARTS: ${JSON.stringify(assemblyData.partsRisks, null, 2)}`;
    }

    const keywordsList = Array.isArray(keywords) ? keywords.filter(k => typeof k === 'string' && k.trim()) : [];
    const userPrompt = `Vehicle: ${vehicle.make || 'N/A'} ${vehicle.model || 'N/A'} | VIN: ${vin || 'N/A'} | Mileage: ${mileage || 'N/A'} | Codes: ${targetCodes.join(', ') || 'None'} | Symptoms: ${targetSymptoms.join(', ') || 'N/A'} | Tech Notes: ${notes.join(', ') || 'N/A'}${keywordsList.length ? ` | Technical Keywords: ${keywordsList.join(', ')}` : ''}`;

    executionTrace.log('GROQ_DISPATCH', 'Sending to Groq...');

    // UPDATED: Use groqChat instead of the diagnostic engine for the API call
    const groqRes = await groqChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { max_tokens: 1500, temperature: 0.15 });

    const aiText = typeof groqRes === 'string'
      ? groqRes
      : (groqRes?.choices?.[0]?.message?.content || '');

    if (!aiText) throw new Error('Groq returned empty response');

    let parsed = extractJSON(aiText);

    if (!parsed || typeof parsed !== 'object') {
      console.warn('[Diagnose] JSON extract failed. Raw snippet:', aiText.substring(0, 300));
      parsed = safeResult({ notes: 'AI returned unparseable response — please retry' });
    }

    const finalResult = { ...safeResult(), ...parsed };

    // ... (keep the rest of your finalResult logic unchanged)

    res.json({ success: true, result: finalResult, traceLog: { traceId: executionTrace.traceId, logs: executionTrace.logs } });

  } catch (err) {
    executionTrace.log('FATAL', err.message);
    console.error(`[Diagnose Fatal ${executionTrace.traceId}]:`, err.message);
    res.status(500).json({ success: false, error: 'Diagnosis failed', details: err.message, trace: executionTrace.traceId });
  }
});

module.exports = router;
