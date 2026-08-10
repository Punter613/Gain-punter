const express = require('express');
const router = express.Router();
const { resolveVehicleProfile, warmVehicleEvidence } = require('../services/vehicle.warmup');

router.post('/decode', async (req, res) => {
  try {
    const vin = String(req.body?.vin || '').trim();
    if (vin.length !== 17) {
      return res.status(400).json({ success: false, error: 'A valid 17-character VIN is required.' });
    }

    const vehicle = await resolveVehicleProfile(vin, {});
    const warmup = warmVehicleEvidence(vehicle);

    return res.json({
      success: true,
      vehicle,
      evidenceWarmup: warmup.status,
      evidenceKey: warmup.key
    });
  } catch (error) {
    console.error('[Vehicle Decode]', error.message);
    return res.status(502).json({ success: false, error: 'VIN decode failed.', details: error.message });
  }
});

module.exports = router;
