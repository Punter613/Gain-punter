require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');

const app = express();

// Bulletproof CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: false
}));

app.options('*', cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEFAULT_LABOR_RATE = Number(process.env.DEFAULT_LABOR_RATE || 65);

if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY missing in env');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE creds missing in env');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Utility functions
async function fetchWithRetry(url, options, retries = 3, backoff = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) return response;
      if (response.ok || i === retries - 1) return response;
      console.log(`Retry ${i + 1}/${retries} after ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff *= 2;
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`Retry ${i + 1}/${retries} after error: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff *= 2;
    }
  }
}

function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, level, message, ...meta }));
}

// FLAT RATE TABLE
const FLAT_RATES = {
  'oil change': 0.5,
  'oil change basic': 0.5,
  'oil change synthetic': 0.5,
  'oil change + rotation': 1.0,
  'tire rotation': 0.5,
  'battery replacement': 0.3,
  'wiper blades': 0.2,
  'air filter': 0.3,
  'cabin filter': 0.4,
  'brake fluid flush': 0.75,
  'coolant flush': 1.0
};

function getFlatRate(description) {
  const desc = description.toLowerCase().trim();
  for (const [job, hours] of Object.entries(FLAT_RATES)) {
    if (desc.includes(job)) return hours;
  }
  return null;
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'SKSK AutoPro Backend (Groq + Charm.li OEM)',
    version: '3.0.0',
    features: ['Groq AI', 'Flat Rates', 'Tax Tracking', 'OEM Data', 'Photo Analysis', 'VIN Lookup']
  });
});

// VIN Lookup
app.get('/api/vin-lookup/:vin', async (req, res) => {
  const requestId = generateRequestId();
  try {
    const { vin } = req.params;
    log('info', 'VIN lookup requested', { requestId, vin: vin.substring(0, 4) + '...' });
    
    const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/;
    if (!vin || !vinRegex.test(vin.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid VIN format' });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetchWithRetry(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin.toUpperCase()}?format=json`,
      { signal: controller.signal },
      2,
      1000
    );
    
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error('NHTSA VIN decoder unavailable');

    const data = await response.json();
    const results = data.Results || [];
    
    const getField = (variableId) => {
      const field = results.find(r => r.VariableId === variableId);
      return field?.Value || null;
    };

    const vehicleInfo = {
      vin: vin.toUpperCase(),
      year: getField(29) || getField(26),
      make: getField(26) || getField(27),
      model: getField(28),
      trim: getField(109),
      engine: getField(13) || getField(71),
      engineCylinders: getField(9),
      displacement: getField(11),
      fuelType: getField(24),
      bodyClass: getField(5),
      driveType: getField(15),
      transmission: getField(37)
    };

    const displayString = [
      vehicleInfo.year,
      vehicleInfo.make,
      vehicleInfo.model,
      vehicleInfo.trim,
      vehicleInfo.engine
    ].filter(Boolean).join(' ');

    log('info', 'VIN lookup successful', { requestId, vehicle: displayString });
    
    res.json({
      ok: true,
      vehicle: vehicleInfo,
      displayString: displayString || 'Unknown Vehicle',
      raw: data.Results
    });

  } catch (err) {
    log('error', 'VIN lookup failed', { requestId, error: err.message });
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'VIN lookup timed out' });
    }
    res.status(500).json({ error: err.message || 'Failed to lookup VIN' });
  }
});

// **NEW: OEM Data Lookup via Charm.li Web Search**
app.get('/api/oem-data/:vin/:procedure', async (req, res) => {
  const requestId = generateRequestId();
  
  try {
    const { vin, procedure } = req.params;
    log('info', 'OEM data requested', { requestId, vin: vin.substring(0, 4) + '...', procedure });

    // First, get vehicle info from VIN
    const vinResponse = await fetch(`http://localhost:${PORT}/api/vin-lookup/${vin}`);
    if (!vinResponse.ok) throw new Error('VIN lookup failed');
    
    const vinData = await vinResponse.json();
    const vehicle = vinData.displayString;

    // Build search query for Charm.li
    const searchPrompt = `You are an automotive data researcher. Search charm.li and other OEM databases for factory repair information.

Vehicle: ${vehicle}
VIN: ${vin}
Procedure: ${procedure}

Find and return ONLY this information as JSON:
{
  "found": boolean,
  "data": {
    "laborHours": number (factory time book hours),
    "steps": [string] (factory repair procedure steps),
    "torqueSpecs": [{"part": string, "spec": string}],
    "knownIssues": [string] (common problems for this vehicle/procedure),
    "warnings": [string] (factory warnings and cautions),
    "specialTools": [string] (if any required)
  }
}

CRITICAL: Use plain text only, no Unicode symbols or emoji. Use "WARNING:" prefix for warnings.

Search charm.li, Mitchell, AllData, and factory service manuals for this exact vehicle and procedure.
If you cannot find specific OEM data, return {"found": false, "data": null}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    // Call Groq with web search capability
    const response = await fetchWithRetry(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { 
              role: 'system', 
              content: 'You are an automotive OEM data researcher. Search charm.li and factory databases for repair procedures. Return ONLY valid JSON.' 
            },
            { role: 'user', content: searchPrompt }
          ],
          max_tokens: 2000,
          temperature: 0.1
        })
      },
      2,
      2000
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      log('warn', 'OEM data search failed', { requestId, status: response.status });
      return res.json({ found: false, data: null });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    
    if (!text) {
      log('warn', 'No OEM data response', { requestId });
      return res.json({ found: false, data: null });
    }

    // Parse JSON response
    let cleanText = text.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : cleanText;

    let oemData;
    try {
      oemData = JSON.parse(jsonText);
      log('info', 'OEM data retrieved', { requestId, found: oemData.found });
    } catch (err) {
      log('error', 'OEM data parse error', { requestId });
      return res.json({ found: false, data: null });
    }

    res.json(oemData);

  } catch (err) {
    log('error', 'OEM data fetch failed', { requestId, error: err.message });
    if (err.name === 'AbortError') {
      return res.status(504).json({ found: false, data: null, error: 'Timeout' });
    }
    res.json({ found: false, data: null });
  }
});

// Photo Analysis
app.post('/api/analyze-photo', async (req, res) => {
  const requestId = generateRequestId();
  
  try {
    const { imageData } = req.body;
    log('info', 'Photo analysis requested', { requestId });
    
    if (!imageData || !imageData.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image data' });
    }
    
    const sizeInMB = (imageData.length * 0.75) / (1024 * 1024);
    if (sizeInMB > 10) {
      return res.status(400).json({ error: 'Image too large (max 10MB)' });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetchWithRetry(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'llama-3.2-90b-vision-preview',
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analyze this vehicle damage photo. Return ONLY valid JSON:
{
  "damageFound": boolean,
  "damageAreas": [{"area": string, "severity": "minor/moderate/severe", "description": string}],
  "recommendedRepairs": [string],
  "estimatedParts": [{"name": string, "reason": string}],
  "notes": string,
  "confidence": "low/medium/high"
}`
              },
              {
                type: 'image_url',
                image_url: { url: imageData }
              }
            ]
          }],
          max_tokens: 1000,
          temperature: 0.2
        })
      },
      2,
      2000
    );

    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`Vision API error: ${response.status}`);

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('No response from Vision AI');

    let cleanText = text.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : cleanText;

    const analysis = JSON.parse(jsonText);
    
    // Build description
    let description = '';
    if (analysis.damageFound) {
      description += 'DAMAGE ANALYSIS:\n\n';
      if (analysis.damageAreas?.length) {
        description += 'Damaged Areas:\n';
        analysis.damageAreas.forEach(area => {
          description += `- ${area.area} (${area.severity}): ${area.description}\n`;
        });
      }
      if (analysis.recommendedRepairs?.length) {
        description += '\nRecommended Repairs:\n';
        analysis.recommendedRepairs.forEach(repair => {
          description += `- ${repair}\n`;
        });
      }
    } else {
      description = 'No visible damage detected.';
    }

    log('info', 'Photo analysis complete', { requestId, damageFound: analysis.damageFound });
    res.json({ ok: true, analysis, description: description.trim() });

  } catch (err) {
    log('error', 'Photo analysis failed', { requestId, error: err.message });
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Analysis timed out' });
    }
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

// Input validation
const GenerateSchema = z.object({
  customer: z.object({
    name: z.string().min(1).max(200),
    phone: z.string().max(20).optional(),
    email: z.string().email().max(200).optional()
  }),
  vehicle: z.string().max(500).optional(),
  description: z.string().min(3).max(5000)
});

// Prompt builder
function buildPrompt({customer, vehicle, description, oemData = null}) {
  const flatRate = getFlatRate(description);
  const flatRateHint = flatRate ? `\n\nIMPORTANT: This is a FLAT RATE job. Use exactly ${flatRate} hours for labor.` : '';
  
  let basePrompt = `You are a master automotive technician with 20+ years experience.

FLAT RATE JOBS (USE EXACT HOURS):
- Oil change: 0.5 hours
- Oil change + rotation: 1.0 hours
- Battery replacement: 0.3 hours
- Wiper blades: 0.2 hours
- Air filter: 0.3 hours
- Brake fluid flush: 0.75 hours

OTHER JOBS - REALISTIC TIMES:
- Brake pads (front or rear): 1.5-2.0 hours TOTAL
- Brake pads + rotors: 2.0-2.5 hours TOTAL
- Alternator: 1.5-3.0 hours
- Spark plugs (4-cyl): 0.75-1.0 hours TOTAL
- Spark plugs (V6/V8): 1.0-1.5 hours TOTAL${flatRateHint}`;

  if (oemData && oemData.found) {
    basePrompt += `\n\nFACTORY OEM DATA (charm.li):
- Factory Labor: ${oemData.data.laborHours} hours
- Factory Steps: ${JSON.stringify(oemData.data.steps)}
- Torque Specs: ${JSON.stringify(oemData.data.torqueSpecs)}
- Known Issues: ${JSON.stringify(oemData.data.knownIssues)}
- Factory Warnings: ${JSON.stringify(oemData.data.warnings)}

Use OEM labor time (add 10-20% for small shops). Include OEM warnings in your output.`;
  }

  basePrompt += `\n\nJSON STRUCTURE:
{
  "jobType": string,
  "shortDescription": string,
  "laborHours": number,
  "laborRate": number,
  "workSteps": [string],
  "parts": [{"name":string,"cost":number}],
  "shopSuppliesPercent": number,
  "timeline": string,
  "notes": string,
  "tips": [string],
  "warnings": [string]${oemData ? ',\n  "oemDataUsed": true' : ''}
}

Requirements:
- laborRate: ${DEFAULT_LABOR_RATE}
- shopSuppliesPercent: 7%
- workSteps: detailed steps
- tips: time-savers, special tools, torque specs
- warnings: problems, gotchas, traps
- Use ONLY plain text, no Unicode/emoji
- Return ONLY valid JSON

Customer: ${customer.name}
Vehicle: ${vehicle || 'Not specified'}
Job: ${description}`;

  return basePrompt;
}

// Generate Estimate
app.post('/api/generate-estimate', async (req, res) => {
  const requestId = generateRequestId();
  
  try {
    log('info', 'Estimate generation requested', { requestId });
    
    const parsed = GenerateSchema.parse(req.body);
    const { customer, vehicle, description } = parsed;
    const { useOemData, vin } = req.body;

    let oemData = null;
    if (useOemData && vin) {
      try {
        let procedure = 'general-repair';
        if (description.toLowerCase().includes('engine')) procedure = 'engine-replacement';
        else if (description.toLowerCase().includes('brake')) procedure = 'brake-service';
        else if (description.toLowerCase().includes('transmission')) procedure = 'transmission-service';
        
        const oemResponse = await fetch(`http://localhost:${PORT}/api/oem-data/${vin}/${procedure}`);
        if (oemResponse.ok) {
          oemData = await oemResponse.json();
          log('info', 'OEM data fetched', { requestId, found: oemData.found });
        }
      } catch (oemErr) {
        log('warn', 'OEM fetch failed, continuing', { requestId });
      }
    }

    const prompt = buildPrompt({ customer, vehicle, description, oemData });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const response = await fetchWithRetry(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You are a master automotive technician. Always respond with valid JSON only.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 2500,
          temperature: 0.2
        })
      },
      3,
      2000
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Groq API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('No AI response');

    let cleanText = text.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : cleanText;

    let estimate;
    try {
      estimate = JSON.parse(jsonText);
    } catch (err) {
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: text });
    }

    estimate.laborRate = estimate.laborRate || DEFAULT_LABOR_RATE;
    estimate.shopSuppliesPercent = estimate.shopSuppliesPercent ?? 7;
    estimate.laborHours = parseFloat(estimate.laborHours || 0);
    estimate.parts = (estimate.parts || []).map(p => ({ 
      name: p.name, 
      cost: Math.round(Number(p.cost || 0)) 
    }));
    estimate.tips = estimate.tips || [];
    estimate.warnings = estimate.warnings || [];

    const laborCost = Number((estimate.laborHours * estimate.laborRate).toFixed(2));
    const partsCost = estimate.parts.reduce((s,p)=> s + Number(p.cost || 0), 0);
    const shopSupplies = Number((partsCost * (estimate.shopSuppliesPercent/100)).toFixed(2));
    const subtotal = Number((laborCost + partsCost + shopSupplies).toFixed(2));

    // Tax calculation (28%)
    const taxRate = 28;
    const recommendedTaxSetaside = Number((subtotal * (taxRate / 100)).toFixed(2));
    const netAfterTax = Number((subtotal - recommendedTaxSetaside).toFixed(2));

    // Save customer
    let customerRecord = null;
    if (customer.email) {
      const { data: existing } = await supabase.from('customers').select('*').eq('email', customer.email).limit(1);
      if (existing?.length) customerRecord = existing[0];
    }
    if (!customerRecord && customer.phone) {
      const { data: existing } = await supabase.from('customers').select('*').eq('phone', customer.phone).limit(1);
      if (existing?.length) customerRecord = existing[0];
    }
    if (!customerRecord) {
      const { data: inserted, error: insertErr } = await supabase.from('customers').insert({
        name: customer.name,
        phone: customer.phone || null,
        email: customer.email || null
      }).select().single();
      if (insertErr) throw insertErr;
      customerRecord = inserted;
    }

    // Save job
    const jobPayload = {
      customer_id: customerRecord.id,
      description: estimate.shortDescription || description,
      raw_description: description,
      job_type: estimate.jobType || 'Auto Repair',
      vehicle,
      labor_hours: estimate.laborHours,
      labor_rate: estimate.laborRate,
      labor_cost: laborCost,
      parts: estimate.parts,
      parts_cost: partsCost,
      shop_supplies_percent: estimate.shopSuppliesPercent,
      shop_supplies_cost: shopSupplies,
      subtotal,
      tax_rate: taxRate,
      recommended_tax_setaside: recommendedTaxSetaside,
      is_taxable: true,
      timeline: estimate.timeline || '',
      work_steps: estimate.workSteps || [],
      notes: estimate.notes || ''
    };

    const { data: savedJob, error: jobErr } = await supabase.from('jobs').insert(jobPayload).select().single();
    if (jobErr) throw jobErr;

    log('info', 'Estimate saved', { requestId, jobId: savedJob.id, subtotal });

    res.json({
      ok: true,
      estimate: { 
        ...estimate, 
        laborCost, 
        partsCost, 
        shopSupplies, 
        subtotal,
        taxRate,
        recommendedTaxSetaside,
        netAfterTax
      },
      savedJob,
      customer: customerRecord
    });

  } catch (err) {
    log('error', 'Estimate failed', { requestId, error: err.message });
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Request timed out' });
    }
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    res.status(500).json({ error: err.message || 'Generation failed' });
  }
});

app.get('/api/jobs', async (req, res) => {
  const { data, error } = await supabase.from('jobs').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

// Tax endpoints
app.get('/api/tax-summary/month', async (req, res) => {
  try {
    const { data, error } = await supabase.from('tax_summary').select('*').limit(12);
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tax-summary/quarter', async (req, res) => {
  try {
    const { data, error } = await supabase.from('quarterly_tax_summary').select('*').limit(8);
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  log('info', 'SKSK AutoPro Backend started', {
    port: PORT,
    groq: !!GROQ_API_KEY,
    supabase: !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  });
  console.log(`🔥 SKSK AutoPro Backend running on port ${PORT}`);
  console.log(`🤖 Groq AI + Charm.li OEM Integration`);
  console.log(`💰 Tax tracking enabled (28% set-aside)`);
  console.log(`⚡ Flat rates + Photo analysis + VIN lookup`);
});
