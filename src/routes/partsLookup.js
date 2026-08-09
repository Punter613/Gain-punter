const express = require('express');
const router = express.Router();
const { lookupPart } = require('../services/partsLookup');

router.post('/', async (req, res) => {
  try {
    const { part_number, name, vehicle, vin } = req.body || {};
    const query = part_number || name;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'part_number or name required'
      });
    }

    const vehicleText = typeof vehicle === 'string'
      ? vehicle
      : [vehicle?.year, vehicle?.make, vehicle?.model, vehicle?.trim]
          .filter(Boolean)
          .join(' ');

    const result = await lookupPart(query, vin || '', vehicleText || '');

    return res.json({
      success: true,
      ...result,
      meta: {
        part_number: part_number || null,
        name: name || null,
        vehicle: vehicle || null,
        vin: vin || null
      }
    });
  } catch (error) {
    console.error('[Parts Lookup Route Error]', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to look up part availability.'
    });
  }
});

module.exports = router;
