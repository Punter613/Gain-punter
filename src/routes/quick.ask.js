const express = require('express');
const router = express.Router();
const { BoundedQuickAskRetriever } = require('../core/knowledge/quick.ask.bounded');
const {
  buildDtcRetrievalIntent,
  applyQuickAskRetrievalGuards,
  publicIntent
} = require('../core/knowledge/dtc.retrieval.intent');
const { decodeVinNhtsa } = require('../services/vin');

function clean(value) { return String(value || '').trim(); }

async function resolveVehicle(vehicle = {}) {
  const vin = clean(vehicle.vin);
  const resolved = { ...vehicle, vin };
  if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) return { vehicle: resolved, warning: null };

  try {
    const decoded = await decodeVinNhtsa(vin);
    if (!decoded) return { vehicle: resolved, warning: 'VIN could not be decoded; manual applicability is based on the entered vehicle fields.' };
    for (const [key, value] of Object.entries(decoded)) {
      if (clean(value)) resolved[key] = value;
    }
    return { vehicle: resolved, warning: null };
  } catch (error) {
    return { vehicle: resolved, warning: `VIN decode unavailable; manual applicability is based on the entered vehicle fields. ${error.message}` };
  }
}

router.post('/', async (req, res) => {
  try {
    const { vehicle = {}, query = '', limit = 5 } = req.body || {};
    const resolved = await resolveVehicle(vehicle);
    const intent = buildDtcRetrievalIntent(resolved.vehicle, query);
    const result = await new BoundedQuickAskRetriever().ask({
      vehicle: resolved.vehicle,
      query: intent.searchQuery,
      limit
    });

    applyQuickAskRetrievalGuards(result, resolved.vehicle, intent);
    result.query = clean(query);
    result.retrievalIntent = publicIntent(intent);

    const guard = result.retrievalTelemetry?.applicabilityGuard || {};
    const rejected = Object.values(guard).reduce((sum, value) => sum + Number(value || 0), 0);
    const warnings = [...(result.warnings || [])];

    if (intent.mode === 'DTC_ANCHORED') {
      warnings.unshift(
        `DTC-anchored retrieval active for ${intent.anchors.map(anchor => anchor.code).join(', ')}; symptoms refine the code context and unrelated generic matches are excluded.`
      );
    } else if (intent.unresolvedDtcs.length) {
      warnings.unshift(
        `DTC ${intent.unresolvedDtcs.join(', ')} is not resolved by deterministic SKSK code context; symptom-driven retrieval was used without inventing a code meaning.`
      );
    }
    if (rejected > 0) {
      warnings.unshift(`Applicability guard rejected ${rejected} unrelated or explicitly conflicting evidence item${rejected === 1 ? '' : 's'}.`);
    }
    if (resolved.warning) warnings.unshift(resolved.warning);
    result.warnings = warnings;

    return res.json(result);
  } catch (error) {
    const status = /requires vehicle\.make and vehicle\.model/.test(error.message) ? 400 : 500;
    return res.status(status).json({
      status: 'ERROR',
      error: error.message,
      mode: 'RETRIEVAL_ONLY'
    });
  }
});

module.exports = router;
module.exports.resolveVehicle = resolveVehicle;
