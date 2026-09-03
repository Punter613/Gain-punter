const express = require('express');
const router = express.Router();
const { exec } = require('child_process'); 
const cleanInput = require('../middleware/clean.input');

// Durable-first knowledge coverage planner. This is intentionally independent
// of the legacy OEM/manual bridge below so common-vehicle coverage remains
// available even when an external manual source is unavailable.
router.use('/api/knowledge-builder', require('./knowledge.builder'));

router.get('/api/oem-data/:vin/:procedure', cleanInput, async (req, res) => {
  const requestId = `req_${Date.now()}`;
  try {
    const { vin, procedure } = req.params;
    
    // Leverage the sanitized fields passed through our sound middleware
    const vinTarget = String(vin || '').toUpperCase().trim();
    
    // Call our fast internal/NHTSA decoder to extract precise specs
    const vinResponse = await fetch(`http://localhost:${process.env.PORT || 4000}/api/vin-lookup/${vinTarget}`);
    if (!vinResponse.ok) throw new Error('VIN tracking validation hit a fault');
    const vinData = await vinResponse.json();
    
    const year = parseInt(vinData.vehicle?.year) || 0;
    const make = String(vinData.vehicle?.make || '').toLowerCase().trim();
    const model = String(vinData.vehicle?.model || '').toLowerCase().trim();

    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', message: 'Querying local LEMON database core', requestId, year, make, model }));

    // Target the portable local Rust binary core execution path
    const command = `./lemon-core --year ${year} --make "${make}" --model "${model}" --get "${procedure}"`;
    
    // Execute the shell process with safe, isolated callback scoping
    exec(command, (execError, stdout, stderr) => {
      if (execError) {
        console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', message: 'LEMON local core lookup missed, falling back to generic AI estimate logic', requestId, details: execError.message }));
        return res.json({ found: false, data: null });
      }
      
      try {
        const factoryData = JSON.parse(stdout);
        return res.json({
          found: true,
          source: year <= 2013 ? 'CHARM Core' : 'LEMON Core',
          data: factoryData
        });
      } catch (parseError) {
        console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', message: 'LEMON core output string parsing failed', requestId, details: parseError.message }));
        return res.json({ found: false, data: null, error: 'Malformed core data response mapping' });
      }
    });

  } catch (err) {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', message: 'OEM data bridge failed completely', requestId, error: err.message }));
    return res.status(500).json({ found: false, data: null, error: err.message });
  }
});

module.exports = router;
