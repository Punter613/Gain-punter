/**
 * SKSK Intelligence API Routes
 * Express routes that expose the full orchestrator pipeline
 * 
 * POST /api/intelligence/analyze - Main analysis endpoint
 * POST /api/intelligence/estimate - Quick estimate (diagnostic + estimate chain)
 * POST /api/intelligence/predict - Predictive maintenance forecast
 * POST /api/intelligence/economic - Economic analysis only
 * GET  /api/intelligence/health - System health check
 * GET  /api/intelligence/stats - Pipeline statistics
 */

const express = require('express');
const router = express.Router();

let orchestrator;
let economicEngine;
let orchestratorLoadError = null;
let economicEngineLoadError = null;

// 🛡️ REQUIRE ISOLATION GUARD: Prevents syntax/path errors in core engines from crashing server initialization
try {
  const SKSKOrchestrator = require('../core/orchestrator/main.orchestrator');
  orchestrator = typeof SKSKOrchestrator === 'function' ? new SKSKOrchestrator() : SKSKOrchestrator;
} catch (err) {
  orchestratorLoadError = err;
  orchestrator = null;
  console.error('[SKSK Intelligence Route] Orchestrator failed to load:', err.message);
}

try {
  const SKSKEconomicEngine = require('../core/economic/economic.engine');
  economicEngine = typeof SKSKEconomicEngine === 'function' ? new SKSKEconomicEngine() : SKSKEconomicEngine;
} catch (err) {
  economicEngineLoadError = err;
  economicEngine = null;
  console.error('[SKSK Intelligence Route] EconomicEngine failed to load:', err.message);
}

const validateVehicleProfile = (req, res, next) => {
  const required = ['vin', 'make', 'model', 'year', 'mileage'];
  const missing = required.filter(field => !req.body.vehicleProfile?.[field]);
  
  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Missing required vehicle profile fields',
      missing,
      example: {
        vehicleProfile: {
          vin: '1FTFW1ET5DFC10312',
          make: 'Ford',
          model: 'F-150',
          year: 2019,
          mileage: 85000,
          componentData: {
            brakes: { padThickness: 3.2, rotorRunout: 0.03 }
          }
        }
      }
    });
  }
  next();
};

function intelligenceUnavailable(res) {
  return res.status(503).json({
    status: 'UNAVAILABLE',
    error: 'SKSK intelligence orchestrator is unavailable',
    code: 'ORCHESTRATOR_UNAVAILABLE',
    fallback: { action: 'HUMAN_HANDOFF', message: 'Automated intelligence is unavailable. Human review required.', urgency: 'HIGH' }
  });
}

function economicUnavailable(res) {
  return res.status(503).json({
    status: 'UNAVAILABLE',
    error: 'SKSK economic engine is unavailable',
    code: 'ECONOMIC_ENGINE_UNAVAILABLE'
  });
}

router.post('/analyze', validateVehicleProfile, async (req, res) => {
  if (orchestratorLoadError || !orchestrator) return intelligenceUnavailable(res);
  try {
    const { input, vehicleProfile, context = {} } = req.body;
    console.log(`[API] Intelligence request for VIN ${vehicleProfile.vin}: "${input}"`);
    
    const result = await orchestrator.process({ input, vehicleProfile, context });
    return res.json(result);
  } catch (error) {
    // Log the FULL real reason server-side — previously this got swallowed into
    // a generic "System error" message with no way to tell a safety-model refusal
    // apart from a timeout, a bug, or bad input.
    console.error('[API] Intelligence error — full detail:', {
      message: error.message,
      stack: error.stack,
      vin: req.body?.vehicleProfile?.vin,
      input: req.body?.input
    });
    return res.status(500).json({
      status: 'ERROR',
      error: error.message,
      fallback: { action: 'HUMAN_HANDOFF', message: 'System error. Please contact a service advisor.', urgency: 'HIGH' }
    });
  }
});

router.post('/estimate', validateVehicleProfile, async (req, res) => {
  if (orchestratorLoadError || !orchestrator) return intelligenceUnavailable(res);
  try {
    const { input, vehicleProfile, context = {} } = req.body;
    
    const result = await orchestrator.process({
      input,
      vehicleProfile,
      context: { 
        ...context, 
        forceSpecialist: 'estimate',
        suggestedChain: ['diagnostic', 'estimate', 'parts']
      }
    });
    return res.json(result);
  } catch (error) {
    console.error('[API] Estimate error:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.post('/predict', validateVehicleProfile, async (req, res) => {
  if (orchestratorLoadError || !orchestrator) return intelligenceUnavailable(res);
  try {
    const { vehicleProfile, context = {} } = req.body;
    
    const result = await orchestrator.process({
      input: 'Generate predictive maintenance forecast for all components',
      vehicleProfile,
      context: { ...context, forceSpecialist: 'prediction' }
    });
    return res.json(result);
  } catch (error) {
    console.error('[API] Prediction error:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.post('/economic', async (req, res) => {
  if (economicEngineLoadError || !economicEngine) return economicUnavailable(res);
  try {
    const { recommendation, vehicleProfile } = req.body;
    if (!recommendation || !vehicleProfile) {
      return res.status(400).json({ error: 'Requires recommendation and vehicleProfile' });
    }
    
    const result = await economicEngine.analyze(recommendation, vehicleProfile);
    return res.json(result);
  } catch (error) {
    console.error('[API] Economic error:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.post('/batch', validateVehicleProfile, async (req, res) => {
  if (economicEngineLoadError || !economicEngine) return economicUnavailable(res);
  try {
    const { recommendations, vehicleProfile } = req.body;
    if (!Array.isArray(recommendations)) {
      return res.status(400).json({ error: 'recommendations must be an array' });
    }
    
    const results = await economicEngine.analyzeBatch(recommendations, vehicleProfile);
    return res.json({ status: 'SUCCESS', count: results.length, results, rankedByUrgency: true });
  } catch (error) {
    console.error('[API] Batch error:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.get('/health', (req, res) => {
  if (orchestratorLoadError || !orchestrator) {
    return res.status(503).json({ ok: false, layer: 'orchestrator', code: 'ORCHESTRATOR_UNAVAILABLE' });
  }
  try {
    const health = typeof orchestrator.health === 'function'
      ? orchestrator.health()
      : { ok: false, code: 'ORCHESTRATOR_HEALTH_UNAVAILABLE' };
    return res.status(health.ok === false ? 503 : 200).json(health);
  } catch (err) {
    return res.status(503).json({ ok: false, error: err.message });
  }
});

router.get('/stats', (req, res) => {
  if (orchestratorLoadError || !orchestrator) return intelligenceUnavailable(res);
  try {
    const pipeStats = typeof orchestrator.getStats === 'function' ? orchestrator.getStats() : {};
    const assumptions = economicEngine && typeof economicEngine.getAssumptions === 'function'
      ? economicEngine.getAssumptions()
      : { unavailable: true };
    return res.json({ status: 'SUCCESS', stats: pipeStats, economicAssumptions: assumptions });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/feedback', async (req, res) => {
  try {
    const { repairKey, feedback } = req.body;

    // Legacy in-memory tag (kept for backwards compat, non-fatal either way)
    try {
      const evidenceVerifier = require('../core/evidence/evidence.verifier');
      if (evidenceVerifier && typeof evidenceVerifier.recordFeedback === 'function') {
        evidenceVerifier.recordFeedback(repairKey, feedback);
      }
    } catch (e) {
      console.log(`[Feedback Proxy Tracked Log] Key: ${repairKey}, Data:`, feedback);
    }

    // Real persistent learning loop (Supabase-backed when configured)
    let stored = null;
    try {
      const { feedbackLoop, usingSupabase } = require('../core/learning');
      stored = await feedbackLoop.recordRepairOutcome({ requestId: repairKey, ...feedback });
      return res.json({
        status: 'SUCCESS',
        message: 'Feedback recorded for continuous learning',
        repairKey,
        persisted: usingSupabase,
        exampleId: stored?.id || null
      });
    } catch (learningErr) {
      console.warn('[Feedback] learning loop failed, feedback only logged legacy-side:', learningErr.message);
      return res.json({ status: 'SUCCESS', message: 'Feedback recorded (legacy log only)', repairKey, persisted: false });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Lightweight thumbs up/down on a single AI response - high volume, low detail
router.post('/feedback/quick', async (req, res) => {
  try {
    const { requestId, provider, model, verdict, metadata } = req.body;
    if (!['up', 'down', 'neutral'].includes(verdict)) {
      return res.status(400).json({ error: "verdict must be 'up', 'down', or 'neutral'" });
    }
    const { feedbackLoop, usingSupabase } = require('../core/learning');
    const stored = await feedbackLoop.recordQuickFeedback({ requestId, provider, model, verdict, metadata });
    return res.json({ status: 'SUCCESS', persisted: usingSupabase, feedback: stored });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Where the AI keeps getting it wrong or missing things - repeat offenders by vehicle/component
router.get('/feedback/blindspots', async (req, res) => {
  try {
    const { feedbackLoop } = require('../core/learning');
    const blindspots = await feedbackLoop.getAIBlindspots();
    return res.json({ status: 'SUCCESS', count: blindspots.length, blindspots });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// A given mechanic's accuracy track record against AI recommendations
router.get('/feedback/mechanic/:mechanicId', async (req, res) => {
  try {
    const { feedbackLoop } = require('../core/learning');
    const insights = await feedbackLoop.getMechanicInsights(req.params.mechanicId);
    return res.json({ status: 'SUCCESS', insights });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Pending queue: AI outputs the deterministic completed-work-guard caught
// and filtered, waiting on a mechanic to confirm the catch was real
// before it counts as a training signal.
router.get('/guard-catches', async (req, res) => {
  try {
    const { listPendingGuardCatches } = require('../core/learning/guard.catch.recorder');
    const catches = await listPendingGuardCatches(Number(req.query.limit) || 50);
    return res.json({ status: 'SUCCESS', count: catches.length, catches });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// body: { correct: boolean, mechanicId?: string, note?: string }
// correct=true feeds the catch into the real learning loop as an
// AI_HALLUCINATED-weighted example. correct=false marks it a false
// positive - logged for guard tuning, never trains anything.
router.post('/guard-catches/:id/verify', async (req, res) => {
  try {
    const { correct, mechanicId, note } = req.body;
    if (typeof correct !== 'boolean') {
      return res.status(400).json({ error: '"correct" must be true or false' });
    }
    const { recordVerification } = require('../core/learning/guard.catch.recorder');
    const { feedbackLoop } = require('../core/learning');
    const result = await recordVerification(req.params.id, correct, { mechanicId, note, feedbackLoop });
    return res.json({ status: 'SUCCESS', ...result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
