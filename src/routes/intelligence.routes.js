/**
 * SKSK Intelligence API Routes
 * Express routes that expose the full orchestrator pipeline
 */

const express = require('express');
const router = express.Router();

let orchestrator;
let economicEngine;
let orchestratorLoadError = null;

try {
  const SKSKOrchestrator = require('../core/orchestrator/main.orchestrator');
  orchestrator = typeof SKSKOrchestrator === 'function' ? new SKSKOrchestrator() : SKSKOrchestrator;
} catch (err) {
  orchestratorLoadError = err;
  console.error('[SKSK Intelligence Route] Orchestrator failed to load:', err.message);
  orchestrator = {
    process: async () => {
      const unavailable = new Error('SKSK intelligence orchestrator is unavailable');
      unavailable.code = 'ORCHESTRATOR_UNAVAILABLE';
      unavailable.cause = err;
      throw unavailable;
    },
    health: () => ({ ok: false, layer: 'orchestrator', code: 'ORCHESTRATOR_UNAVAILABLE' }),
    getStats: () => ({ unavailable: true })
  };
}

try {
  const SKSKEconomicEngine = require('../core/economic/economic.engine');
  economicEngine = typeof SKSKEconomicEngine === 'function' ? new SKSKEconomicEngine() : SKSKEconomicEngine;
} catch (err) {
  console.warn('[SKSK Intelligence Route Warning] EconomicEngine failed to load:', err.message);
  economicEngine = {
    analyze: async () => { throw new Error('Economic engine unavailable'); },
    analyzeBatch: async () => { throw new Error('Economic engine unavailable'); },
    getAssumptions: () => ({ unavailable: true })
  };
}

const validateVehicleProfile = (req, res, next) => {
  const required = ['vin', 'make', 'model', 'year', 'mileage'];
  const missing = required.filter(field => !req.body.vehicleProfile?.[field]);
  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Missing required vehicle profile fields',
      missing,
      example: { vehicleProfile: { vin: '1FTFW1ET5DFC10312', make: 'Ford', model: 'F-150', year: 2019, mileage: 85000, componentData: { brakes: { padThickness: 3.2, rotorRunout: 0.03 } } } }
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

async function processOrchestrator(req, res, contextOverride) {
  if (orchestratorLoadError) return intelligenceUnavailable(res);
  try {
    const { input, vehicleProfile, context = {} } = req.body;
    return res.json(await orchestrator.process({ input, vehicleProfile, context: contextOverride ? contextOverride(context) : context }));
  } catch (error) {
    console.error('[API] Intelligence error:', { message: error.message, stack: error.stack, vin: req.body?.vehicleProfile?.vin });
    return res.status(500).json({ status: 'ERROR', error: error.message, fallback: { action: 'HUMAN_HANDOFF', message: 'System error. Human review required.', urgency: 'HIGH' } });
  }
}

router.post('/analyze', validateVehicleProfile, (req, res) => processOrchestrator(req, res));
router.post('/estimate', validateVehicleProfile, (req, res) => processOrchestrator(req, res, context => ({ ...context, forceSpecialist: 'estimate', suggestedChain: ['diagnostic', 'estimate', 'parts'] })));
router.post('/predict', validateVehicleProfile, async (req, res) => {
  if (orchestratorLoadError) return intelligenceUnavailable(res);
  try {
    const { vehicleProfile, context = {} } = req.body;
    return res.json(await orchestrator.process({ input: 'Generate predictive maintenance forecast for all components', vehicleProfile, context: { ...context, forceSpecialist: 'prediction' } }));
  } catch (error) { return res.status(500).json({ status: 'ERROR', error: error.message }); }
});

router.post('/economic', async (req, res) => {
  try {
    const { recommendation, vehicleProfile } = req.body;
    if (!recommendation || !vehicleProfile) return res.status(400).json({ error: 'Requires recommendation and vehicleProfile' });
    return res.json(await economicEngine.analyze(recommendation, vehicleProfile));
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.post('/batch', validateVehicleProfile, async (req, res) => {
  try {
    const { recommendations, vehicleProfile } = req.body;
    if (!Array.isArray(recommendations)) return res.status(400).json({ error: 'recommendations must be an array' });
    const results = await economicEngine.analyzeBatch(recommendations, vehicleProfile);
    return res.json({ status: 'SUCCESS', count: results.length, results, rankedByUrgency: true });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get('/health', (req, res) => {
  try {
    const health = typeof orchestrator.health === 'function' ? orchestrator.health() : { ok: false, code: 'ORCHESTRATOR_HEALTH_UNAVAILABLE' };
    return res.status(health.ok === false ? 503 : 200).json(health);
  } catch (err) { return res.status(503).json({ ok: false, error: err.message }); }
});

router.get('/stats', (req, res) => {
  try {
    const pipeStats = typeof orchestrator.getStats === 'function' ? orchestrator.getStats() : {};
    const assumptions = typeof economicEngine.getAssumptions === 'function' ? economicEngine.getAssumptions() : {};
    return res.json({ status: 'SUCCESS', stats: pipeStats, economicAssumptions: assumptions });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/feedback', async (req, res) => {
  try {
    const { repairKey, feedback } = req.body;
    try {
      const evidenceVerifier = require('../core/evidence/evidence.verifier');
      if (evidenceVerifier && typeof evidenceVerifier.recordFeedback === 'function') evidenceVerifier.recordFeedback(repairKey, feedback);
    } catch (e) { console.log(`[Feedback Legacy Log] Key: ${repairKey}, Data:`, feedback); }
    try {
      const { feedbackLoop, usingSupabase } = require('../core/learning');
      const stored = await feedbackLoop.recordRepairOutcome({ requestId: repairKey, ...feedback });
      return res.json({ status: 'SUCCESS', message: 'Feedback recorded for continuous learning', repairKey, persisted: usingSupabase, exampleId: stored?.id || null });
    } catch (learningErr) {
      console.warn('[Feedback] learning loop failed, feedback only logged legacy-side:', learningErr.message);
      return res.json({ status: 'SUCCESS', message: 'Feedback recorded (legacy log only)', repairKey, persisted: false });
    }
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.post('/feedback/quick', async (req, res) => {
  try {
    const { requestId, provider, model, verdict, metadata } = req.body;
    if (!['up', 'down', 'neutral'].includes(verdict)) return res.status(400).json({ error: "verdict must be 'up', 'down', or 'neutral'" });
    const { feedbackLoop, usingSupabase } = require('../core/learning');
    const stored = await feedbackLoop.recordQuickFeedback({ requestId, provider, model, verdict, metadata });
    return res.json({ status: 'SUCCESS', persisted: usingSupabase, feedback: stored });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get('/feedback/blindspots', async (req, res) => {
  try { const { feedbackLoop } = require('../core/learning'); const blindspots = await feedbackLoop.getAIBlindspots(); return res.json({ status: 'SUCCESS', count: blindspots.length, blindspots }); }
  catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get('/feedback/mechanic/:mechanicId', async (req, res) => {
  try { const { feedbackLoop } = require('../core/learning'); return res.json({ status: 'SUCCESS', insights: await feedbackLoop.getMechanicInsights(req.params.mechanicId) }); }
  catch (error) { return res.status(500).json({ error: error.message }); }
});

router.get('/guard-catches', async (req, res) => {
  try { const { listPendingGuardCatches } = require('../core/learning/guard.catch.recorder'); const catches = await listPendingGuardCatches(Number(req.query.limit) || 50); return res.json({ status: 'SUCCESS', count: catches.length, catches }); }
  catch (error) { return res.status(500).json({ error: error.message }); }
});

router.post('/guard-catches/:id/verify', async (req, res) => {
  try {
    const { correct, mechanicId, note } = req.body;
    if (typeof correct !== 'boolean') return res.status(400).json({ error: '"correct" must be true or false' });
    const { recordVerification } = require('../core/learning/guard.catch.recorder');
    const { feedbackLoop } = require('../core/learning');
    return res.json({ status: 'SUCCESS', ...(await recordVerification(req.params.id, correct, { mechanicId, note, feedbackLoop })) });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

module.exports = router;
