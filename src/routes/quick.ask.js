const express = require('express');
const router = express.Router();
const { BoundedQuickAskRetriever } = require('../core/knowledge/quick.ask.bounded');
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
    const result = await new BoundedQuickAskRetriever().ask({ vehicle: resolved.vehicle, query, limit });
    if (resolved.warning) result.warnings = [resolved.warning, ...(result.warnings || [])];
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
