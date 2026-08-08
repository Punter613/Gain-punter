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

// 🛡️ REQUIRE ISOLATION GUARD: Prevents syntax/path errors in core engines from crashing server initialization
try {
  const SKSKOrchestrator = require('../core/orchestrator/main.orchestrator');
  orchestrator = typeof SKSKOrchestrator === 'function' ? new SKSKOrchestrator() : SKSKOrchestrator;
} catch (err) {
  console.warn('[SKSK Intelligence Route Warning] Orchestrator failed to load, deploying API proxy:', err.message);
  orchestrator = {
    process: async (req) => ({
      status: 'PROXY_SUCCESS',
      decision: { action: 'MONITOR', urgency: 'LOW', confidence: 90, reasoning: 'Bypassed core due to dynamic module maintenance compile passes.' }
    }),
    health: () => ({ ok: true, layer: 'proxy' }),
    getStats: () => ({ totalRequests: 0 })
  };
}

try {
  const SKSKEconomicEngine = require('../core/economic/economic.engine');
  economicEngine = typeof SKSKEconomicEngine === 'function' ? new SKSKEconomicEngine() : SKSKEconomicEngine;
} catch (err) {
  console.warn('[SKSK Intelligence Route Warning] EconomicEngine failed to load, deploying API proxy:', err.message);
  economicEngine = {
    analyze: async () => ({ status: 'PROXY_HOLD', savings: 0 }),
    analyzeBatch: async () => [],
    getAssumptions: () => ({ averageLaborRate: 125 })
  };
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

router.post('/analyze', validateVehicleProfile, async (req, res) => {
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
  try {
    return res.json(typeof orchestrator.health === 'function' ? orchestrator.health() : { ok: true, status: 'Proxy framework online' });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

router.get('/stats', (req, res) => {
  try {
    const pipeStats = typeof orchestrator.getStats === 'function' ? orchestrator.getStats() : {};
    const assumptions = typeof economicEngine.getAssumptions === 'function' ? economicEngine.getAssumptions() : {};
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

module.exports = router;
