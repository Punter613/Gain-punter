require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');

const app = express();

// Bulletproof CORS - Allow everything
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: false
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());

const PORT = process.env.PORT || 4000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEFAULT_LABOR_RATE = Number(process.env.DEFAULT_LABOR_RATE || 65);

// Pro access codes (manage manually - replace with real system later)
const PRO_ACCESS_CODES = {
  // Format: 'access_code': { tier: 'pro', expires: 'YYYY-MM-DD', customer: 'name' }
  'DEMO2024': { tier: 'pro', expires: '2099-12-31', customer: 'Demo Account' },
  'SKSKPRO2024': { tier: 'pro', expires: '2099-12-31', customer: 'SKSK ProTech Demo' },
  'PUNTER613': { tier: 'pro', expires: '2099-12-31', customer: 'Brian Shaffer' },
  // Add customer codes here as you get them
  // Example: 'CUSTOMER1_BRIAN': { tier: 'pro', expires: '2025-12-13', customer: 'Customer Name' }
};

// Validate pro access code
function validateAccessCode(code) {
  if (!code) return { valid: false, tier: 'free' };
  
  const accessData = PRO_ACCESS_CODES[code.toUpperCase()];
  if (!accessData) return { valid: false, tier: 'free' };
  
  // Check expiration
  const expires = new Date(accessData.expires);
  const now = new Date();
  
  if (expires < now) {
    return { valid: false, tier: 'free', expired: true };
  }
  
  return {
    valid: true,
    tier: accessData.tier,
    customer: accessData.customer,
    expires: accessData.expires
  };
}

if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY missing in env');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE creds missing in env');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Utility: Retry logic with exponential backoff
async function fetchWithRetry(url, options, retries = 3, backoff = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      
      // Don't retry on 4xx errors (client errors like bad input)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return response;
      }
      
      // Retry on 5xx (server errors) or 429 (rate limit)
      if (response.ok || i === retries - 1) {
        return response;
      }
      
      console.log(`Retry ${i + 1}/${retries} after ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff *= 2; // Exponential backoff
      
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`Retry ${i + 1}/${retries} after error: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff *= 2;
    }
  }
}

// Utility: Generate request ID for tracking
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Utility: Structured logging
function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, level, message, ...meta }));
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SKSK ProTech Backend (Groq-powered)' });
});

// Access Code Validation endpoint
app.post('/api/validate-access', async (req, res) => {
  const requestId = generateRequestId();
  
  try {
    const { accessCode } = req.body;
    log('info', 'Access code validation requested', { requestId });
    
    if (!accessCode || typeof accessCode !== 'string') {
      return res.status(400).json({ 
        valid: false, 
        error: 'Access code required' 
      });
    }
    
    const validation = validateAccessCode(accessCode.trim());
    
    if (!validation.valid) {
      log('warn', 'Invalid access code attempt', { requestId, code: accessCode.substring(0, 4) + '...' });
      
      if (validation.expired) {
        return res.json({
          valid: false,
          error: 'Access code has expired. Please contact support for renewal.',
          expired: true
        });
      }
      
      return res.json({
        valid: false,
        error: 'Invalid access code. Please check your code and try again.'
      });
    }
    
    log('info', 'Valid access code used', { 
      requestId, 
      tier: validation.tier, 
      customer: validation.customer 
    });
    
    res.json({
      valid: true,
      tier: validation.tier,
      customer: validation.customer,
      expires: validation.expires,
      message: `Welcome back, ${validation.customer}!`
    });
    
  } catch (err) {
    log('error', 'Access validation failed', { requestId, error: err.message });
    res.status(500).json({ 
      valid: false, 
      error: 'Validation error. Please try again.' 
    });
  }
});

// VIN Lookup endpoint (FREE NHTSA API)
app.get('/api/vin-lookup/:vin', async (req, res) => {
  const requestId = generateRequestId();
  
  try {
    const { vin } = req.params;
    log('info', 'VIN lookup requested', { requestId, vin: vin.substring(0, 4) + '...' });
    
    // VIN regex validation: 17 alphanumeric chars, no I, O, or Q
    const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/;
    
    if (!vin || !vinRegex.test(vin.toUpperCase())) {
      log('warn', 'Invalid VIN format', { requestId, vin });
      return res.status(400).json({ 
        error: 'Invalid VIN format. Must be exactly 17 characters (letters and numbers, no I, O, or Q)' 
      });
    }

    // Add timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // Call NHTSA with retry logic
    const response = await fetchWithRetry(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin.toUpperCase()}?format=json`,
      { signal: controller.signal },
      2, // 2 retries
      1000 // 1 second initial backoff
    );
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error('NHTSA VIN decoder service unavailable');
    }

    const data = await response.json();
    
    // Extract useful fields from the massive response
    const results = data.Results || [];
    
    const getField = (variableId) => {
      const field = results.find(r => r.VariableId === variableId);
      return field?.Value || null;
    };

    const vehicleInfo = {
      vin: vin.toUpperCase(),
      year: getField(29) || getField(26), // Model Year
      make: getField(26) || getField(27), // Make
      model: getField(28), // Model
      trim: getField(109), // Trim
      engine: getField(13) || getField(71), // Engine Config or Displacement
      engineCylinders: getField(9), // Engine Cylinders
      displacement: getField(11), // Displacement (L)
      fuelType: getField(24), // Fuel Type
      bodyClass: getField(5), // Body Class
      driveType: getField(15), // Drive Type
      transmission: getField(37), // Transmission Style
      vehicleType: getField(39), // Vehicle Type
      manufacturer: getField(27), // Manufacturer Name
      plant: getField(31), // Plant City/Country
      errors: data.Results.filter(r => r.VariableId === 143).map(r => r.Value).join(', ') || null
    };

    // Build a friendly display string
    const displayString = [
      vehicleInfo.year,
      vehicleInfo.make,
      vehicleInfo.model,
      vehicleInfo.trim,
      vehicleInfo.engine ? `${vehicleInfo.engine}` : null
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
      return res.status(504).json({ error: 'VIN lookup timed out. Please try again.' });
    }
    res.status(500).json({ error: err.message || 'Failed to lookup VIN' });
  }
});

// OEM Data Lookup endpoint (Searches Charm.li via Groq AI)
app.get('/api/oem-data/:vin/:procedure', async (req, res) => {
  const requestId = generateRequestId();
  
  try {
    const { vin, procedure } = req.params;
    log('info', 'OEM data lookup requested', { requestId, vin: vin.substring(0, 4) + '...', procedure });
    
    // First get vehicle info from VIN
    const vinResponse = await fetch(`http://localhost:${PORT}/api/vin-lookup/${vin}`);
    if (!vinResponse.ok) {
      throw new Error('Failed to decode VIN');
    }
    
    const vinData = await vinResponse.json();
    const vehicle = vinData.displayString;
    
    // Build prompt for Groq to search Charm.li and factory databases
    const prompt = `You are an expert automotive technician with access to factory service manuals and repair databases like Charm.li.

Search for OEM factory repair data for this vehicle and procedure:
Vehicle: ${vehicle} (VIN: ${vin})
Procedure: ${procedure}

Find and return factory-spec information as JSON:

{
  "found": boolean,
  "vehicle": "${vehicle}",
  "procedure": "${procedure}",
  "data": {
    "laborHours": number (factory flat rate time),
    "steps": [string array of factory procedure steps],
    "torqueSpecs": [{"component": "string", "value": "string (e.g., 85 ft-lbs)"}],
    "knownIssues": [string array of common problems for this year/model],
    "warnings": [string array of factory warnings and cautions],
    "specialTools": [string array of required special tools],
    "fluidSpecs": [{"type": "string", "spec": "string"}]
  },
  "source": "charm.li / factory service manual",
  "confidence": "high/medium/low"
}

Search Charm.li database and factory service information. If you cannot find specific data, return "found": false.
Return ONLY valid JSON, no markdown.`;

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
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You are an expert automotive technician with access to factory service data and Charm.li repair database. Search and return accurate OEM specifications.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 1500,
          temperature: 0.1
        })
      },
      2,
      2000
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      log('error', 'Groq API error in OEM lookup', { requestId, status: response.status });
      throw new Error(`OEM lookup failed: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    
    if (!text) throw new Error('No response from AI');

    // Clean and parse JSON
    let cleanText = text.trim();
    cleanText = cleanText.replace(/```json\n?/g, '');
    cleanText = cleanText.replace(/```\n?/g, '');
    cleanText = cleanText.trim();

    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : cleanText;

    let oemData;
    try {
      oemData = JSON.parse(jsonText);
      log('info', 'OEM data retrieved', { 
        requestId, 
        found: oemData.found,
        confidence: oemData.confidence 
      });
    } catch (err) {
      log('error', 'JSON parse error in OEM lookup', { requestId, rawText: text.substring(0, 200) });
      return res.status(500).json({ error: 'OEM data parse error', raw: text });
    }

    res.json(oemData);

  } catch (err) {
    log('error', 'OEM data lookup failed', { requestId, error: err.message });
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'OEM lookup timed out.' });
    }
    res.status(500).json({ 
      found: false, 
      error: err.message || 'Failed to lookup OEM data' 
    });
  }
});

// Photo Damage Analysis endpoint
app.post('/api/analyze-photo', async (req, res) => {
  const requestId = generateRequestId();
  
  try {
    const { imageData } = req.body;
    log('info', 'Photo analysis requested', { requestId });
    
    // Validate image data
    if (!imageData || typeof imageData !== 'string') {
      log('warn', 'Invalid image data', { requestId });
      return res.status(400).json({ error: 'No valid image data provided' });
    }
    
    if (!imageData.startsWith('data:image/')) {
      log('warn', 'Invalid image format', { requestId });
      return res.status(400).json({ error: 'Invalid image format. Must be base64 encoded image.' });
    }
    
    // Check image size
    const sizeInMB = (imageData.length * 0.75) / (1024 * 1024);
    if (sizeInMB > 10) {
      log('warn', 'Image too large', { requestId, sizeMB: sizeInMB.toFixed(2) });
      return res.status(400).json({ error: 'Image too large. Please compress to under 10MB.' });
    }

    log('info', 'Image validated', { requestId, sizeMB: sizeInMB.toFixed(2) });

    // Add timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    // Groq Vision API call with retry
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
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `You are an expert automotive damage assessor. Analyze this vehicle photo and provide a detailed damage assessment as JSON.

Return ONLY valid JSON with this structure:
{
  "damageFound": boolean,
  "damageAreas": [{"area": "string", "severity": "minor/moderate/severe", "description": "string"}],
  "recommendedRepairs": [string],
  "estimatedParts": [{"name": "string", "reason": "string"}],
  "notes": "string",
  "confidence": "low/medium/high"
}

Be specific and practical. If you see damage, describe exactly what needs repair. If no damage is visible, say so.`
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageData
                  }
                }
              ]
            }
          ],
          max_tokens: 1000,
          temperature: 0.2
        })
      },
      2, // 2 retries
      2000 // 2 second initial backoff
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      log('error', 'Groq Vision API error', { requestId, status: response.status, error: errorText.substring(0, 200) });
      throw new Error(`Vision API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    
    if (!text) {
      log('error', 'No content from Vision API', { requestId });
      throw new Error('No response from Vision AI');
    }

    log('info', 'Vision API response received', { requestId, length: text.length });

    // Clean and parse JSON
    let cleanText = text.trim();
    cleanText = cleanText.replace(/```json\n?/g, '');
    cleanText = cleanText.replace(/```\n?/g, '');
    cleanText = cleanText.trim();

    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : cleanText;

    let analysis;
    try {
      analysis = JSON.parse(jsonText);
      log('info', 'Photo analysis complete', { requestId, damageFound: analysis.damageFound });
    } catch (err) {
      log('error', 'JSON parse error in photo analysis', { requestId, rawText: text.substring(0, 200) });
      return res.status(500).json({ error: 'AI returned non-JSON output', raw: text });
    }

    // Build a human-readable description
    let description = '';
    
    if (analysis.damageFound) {
      description += 'DAMAGE ANALYSIS:\n\n';
      
      if (analysis.damageAreas && analysis.damageAreas.length > 0) {
        description += 'Damaged Areas:\n';
        analysis.damageAreas.forEach(area => {
          description += `- ${area.area} (${area.severity}): ${area.description}\n`;
        });
        description += '\n';
      }
      
      if (analysis.recommendedRepairs && analysis.recommendedRepairs.length > 0) {
        description += 'Recommended Repairs:\n';
        analysis.recommendedRepairs.forEach(repair => {
          description += `- ${repair}\n`;
        });
        description += '\n';
      }
      
      if (analysis.estimatedParts && analysis.estimatedParts.length > 0) {
        description += 'Likely Parts Needed:\n';
        analysis.estimatedParts.forEach(part => {
          description += `- ${part.name} (${part.reason})\n`;
        });
        description += '\n';
      }
      
      if (analysis.notes) {
        description += `Notes: ${analysis.notes}`;
      }
    } else {
      description = 'No visible damage detected in photo. Customer may need to provide additional photos or describe the issue verbally.';
    }

    res.json({
      ok: true,
      analysis,
      description: description.trim()
    });

  } catch (err) {
    log('error', 'Photo analysis failed', { requestId, error: err.message, stack: err.stack });
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Photo analysis timed out. Please try again with a smaller image.' });
    }
    res.status(500).json({ error: err.message || 'Failed to analyze photo' });
  }
});

// DTC Code Analyzer endpoint
app.post('/api/analyze-codes', async (req, res) => {
  const requestId = generateRequestId();
  
  try {
    const { codes, vehicle } = req.body;
    log('info', 'DTC code analysis requested', { requestId, codesCount: codes?.length });
    
    if (!codes || !Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ error: 'At least one DTC code required' });
    }
    
    if (codes.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 codes allowed' });
    }

    // Build prompt for multi-code correlation analysis
    const prompt = `You are a master automotive diagnostic technician with ASE certifications.
Analyze these diagnostic trouble codes (DTCs) and provide correlation analysis to identify root causes.

Vehicle: ${vehicle || 'Not specified'}
Diagnostic Trouble Codes: ${codes.join(', ')}

IMPORTANT FORMATTING RULES:
- Use ONLY standard keyboard characters
- For bullet points, use: "- " (dash and space)
- For checkmarks, use: "[x]" 
- For warnings, use: "WARNING: "
- For arrows, use: "->" 
- Do NOT use any emoji or special Unicode characters
- Use plain numbers for lists: 1. 2. 3.
- Use asterisks for emphasis: *important*

Provide analysis as JSON with this exact structure:

{
  "individualCodes": [
    {
      "code": "P0171",
      "definition": "System Too Lean (Bank 1)",
      "severity": "moderate",
      "commonCauses": ["vacuum leak", "faulty MAF sensor", "low fuel pressure"]
    }
  ],
  "correlationAnalysis": {
    "hasCorrelation": boolean,
    "confidence": "low/medium/high",
    "rootCauseSummary": "string explaining the likely root cause",
    "affectedSystems": ["intake", "fuel", "ignition", etc]
  },
  "likelyRootCauses": [
    {
      "cause": "string (e.g., 'Vacuum leak in intake manifold')",
      "likelihood": "high/medium/low",
      "explanation": "string explaining why this is likely",
      "diagnosticSteps": ["step 1", "step 2"],
      "estimatedCost": "string (e.g., '$50-200')"
    }
  ],
  "doNotReplace": ["parts that are symptoms, not causes"],
  "diagnosticPriority": ["what to check first", "what to check second"],
  "estimatedDiagnosticTime": "string (e.g., '1-2 hours')",
  "notes": "additional important information"
}

CRITICAL RULES:
- Look for patterns across multiple codes
- Identify common root causes that affect multiple systems
- Prioritize cheapest diagnostic steps first
- Warn against replacing expensive parts before finding root cause
- Be specific about what to check and how
- Consider electrical issues (grounds, wiring) as possible causes
- Return ONLY valid JSON, no markdown`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

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
            { role: 'system', content: 'You are an expert automotive diagnostic technician. Analyze DTC codes for root cause correlation. Always respond with valid JSON only.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 2000,
          temperature: 0.2
        })
      },
      2,
      2000
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      log('error', 'Groq API error in code analysis', { requestId, status: response.status });
      throw new Error(`AI analysis failed: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    
    if (!text) throw new Error('No response from AI');

    // Clean and parse JSON
    let cleanText = text.trim();
    cleanText = cleanText.replace(/```json\n?/g, '');
    cleanText = cleanText.replace(/```\n?/g, '');
    cleanText = cleanText.trim();

    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : cleanText;

    let analysis;
    try {
      analysis = JSON.parse(jsonText);
      log('info', 'Code analysis complete', { 
        requestId, 
        hasCorrelation: analysis.correlationAnalysis?.hasCorrelation,
        rootCausesFound: analysis.likelyRootCauses?.length 
      });
    } catch (err) {
      log('error', 'JSON parse error in code analysis', { requestId, rawText: text.substring(0, 200) });
      return res.status(500).json({ error: 'AI returned invalid format', raw: text });
    }

    res.json({
      ok: true,
      analysis
    });

  } catch (err) {
    log('error', 'Code analysis failed', { requestId, error: err.message });
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Analysis timed out. Please try again.' });
    }
    res.status(500).json({ error: err.message || 'Failed to analyze codes' });
  }
});

// Input validation schema
const GenerateSchema = z.object({
  customer: z.object({
    name: z.string().min(1).max(200),
    phone: z.string().max(20).optional(),
    email: z.string().email().max(200).optional()
  }),
  vehicle: z.string().max(500).optional(),
  description: z.string().min(3).max(5000),
  jobType: z.string().max(100).optional()
});

// Prompt builder with optional OEM data
function buildPrompt({customer, vehicle, description, oemData = null, partsPricing = null}) {
  let basePrompt = `You are a master automotive technician and service writer with 20+ years of experience in independent repair shops.
Given a customer job description, produce a DETAILED, professional estimate as JSON.`;

  // Add OEM context if available
  if (oemData && oemData.found) {
    basePrompt += `

IMPORTANT: Factory OEM repair data is available from charm.li database for this vehicle and procedure:
- Factory Labor Time: ${oemData.data.laborHours} hours
- Factory Steps: ${JSON.stringify(oemData.data.steps)}
- Torque Specifications: ${JSON.stringify(oemData.data.torqueSpecs)}
- Known Issues: ${JSON.stringify(oemData.data.knownIssues)}
- Factory Warnings: ${JSON.stringify(oemData.data.warnings)}

Use this OEM data to inform your estimate. Your labor hours should be close to the factory time (add 10-20% for small shops).
Include the known issues and warnings in your output.`;
  }

  // Add parts pricing if available
  if (partsPricing && partsPricing.length > 0) {
    basePrompt += `

PARTS PRICING DATA: Real-time pricing from PartsGeek:
${partsPricing.map(p => `- ${p.partName}: $${p.pricing.priceRange.min}-$${p.pricing.priceRange.max} (${p.pricing.options.length} options available)`).join('\n')}

Use these real prices in your parts list. Choose the mid-range option unless customer specifies budget/premium.`;
  }

  basePrompt += `

{
  "jobType": string,
  "shortDescription": string,
  "laborHours": number,
  "laborRate": number,
  "workSteps": [string (detailed steps with specific actions)],
  "parts": [{"name":string,"cost":number${partsPricing ? ',"options":[{"type":string,"price":number}]' : ''}}],
  "shopSuppliesPercent": number,
  "timeline": string,
  "notes": string,
  "proTips": [string (insider tips, tricks, and things to watch out for)],
  "warnings": [string (potential issues, gotchas, or things that could go wrong)]${oemData ? ',\n  "oemDataUsed": true,\n  "oemSource": "charm.li"' : ''}
}

Requirements:
- Be realistic and conservative for a 1-2 tech independent shop
- Use laborRate = ${DEFAULT_LABOR_RATE} unless specialty work justifies more
- Provide detailed parts with realistic costs (use real pricing data if provided)
- laborHours as decimal (e.g., 14.5) - include diagnosis, testing, cleanup time${oemData ? ' - reference OEM labor time' : ''}
- shopSuppliesPercent default to 7%
- workSteps should be DETAILED with specific actions
- proTips should include: time-savers, special tools needed, parts to inspect while you're in there, torque specs if critical, common shortcuts
- warnings should include: common problems (stripped bolts, seized parts), year-specific issues, things that break often, hidden labor traps${oemData ? ' - INCLUDE the OEM warnings and known issues' : ''}
- Be conversational and practical - like talking to another tech
- Return ONLY valid JSON, no markdown

CRITICAL FORMATTING:
- Use ONLY standard keyboard characters - no Unicode symbols, no emoji
- For lists use: "- item" (dash space)
- For emphasis use: plain text or *asterisks*
- For warnings use: "WARNING: " prefix
- Do NOT use bullet points, checkmarks, arrows, or special symbols

Customer: ${customer.name} ${customer.phone ? `phone:${customer.phone}` : ''} ${customer.email ? `email:${customer.email}` : ''}
Vehicle: ${vehicle || 'Not specified'}
Job description: ${description}

Think like a seasoned tech explaining the job to an apprentice - thorough, practical, and real-world focused.`;

  return basePrompt;
}

app.post('/api/generate-estimate', async (req, res) => {
  const requestId = generateRequestId();
  
  try {
    log('info', 'Estimate generation requested', { requestId });
    
    // Validate input
    const parsed = GenerateSchema.parse(req.body);
    const { customer, vehicle, description } = parsed;
    const { useOemData, vin } = req.body; // Optional: fetch OEM data

    log('info', 'Input validated', { requestId, customer: customer.name, vehicle, useOemData });

    // Optionally fetch OEM data if VIN provided and useOemData flag set
    let oemData = null;
    if (useOemData && vin) {
      try {
        // Determine procedure type from description
        let procedure = 'general-repair';
        if (description.toLowerCase().includes('engine') || description.toLowerCase().includes('motor')) {
          procedure = 'engine-replacement';
        } else if (description.toLowerCase().includes('brake')) {
          procedure = 'brake-service';
        } else if (description.toLowerCase().includes('transmission')) {
          procedure = 'transmission-service';
        } else if (description.toLowerCase().includes('oil change')) {
          procedure = 'oil-change';
        } else if (description.toLowerCase().includes('suspension')) {
          procedure = 'suspension-repair';
        }
        
        // Fetch OEM data (internal call)
        const oemResponse = await fetch(`http://localhost:${PORT}/api/oem-data/${vin}/${procedure}`);
        if (oemResponse.ok) {
          oemData = await oemResponse.json();
          log('info', 'OEM data fetched successfully', { requestId, procedure });
        }
      } catch (oemErr) {
        log('warn', 'OEM data fetch failed, continuing without it', { requestId, error: oemErr.message });
        // Continue without OEM data - don't fail the estimate
      }
    }

    const prompt = buildPrompt({ customer, vehicle, description, oemData });

    // Add timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    // Call Groq API with retry logic
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
            { role: 'system', content: 'You are a master automotive technician with deep technical knowledge. Provide detailed, practical estimates with insider tips. Always respond with valid JSON only, no markdown formatting.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 2500,
          temperature: 0.2
        })
      },
      3, // 3 retries for estimate generation (more critical)
      2000 // 2 second initial backoff
    );

    clearTimeout(timeoutId);
    log('info', 'Groq API responded', { requestId, status: response.status });

    if (!response.ok) {
      const errorText = await response.text();
      log('error', 'Groq API error', { requestId, status: response.status, error: errorText.substring(0, 200) });
      throw new Error(`Groq API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    
    if (!text) throw new Error('No response from AI');

    // Clean up response - remove markdown code blocks if present
    let cleanText = text.trim();
    cleanText = cleanText.replace(/```json\n?/g, '');
    cleanText = cleanText.replace(/```\n?/g, '');
    cleanText = cleanText.trim();

    // Find JSON object
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : cleanText;

    let estimate;
    try {
      estimate = JSON.parse(jsonText);
      log('info', 'Estimate generation complete', { 
        requestId, 
        jobType: estimate.jobType,
        laborHours: estimate.laborHours
      });
    } catch (err) {
      log('error', 'JSON parse error in estimate', { 
        requestId, 
        rawText: text.substring(0, 200),
        error: err.message
      });
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: text });
    }

    // COMPUTE MISSING TOTALS (frontend expects these)
    const laborCost = (estimate.laborHours || 0) * (estimate.laborRate || DEFAULT_LABOR_RATE);
    const partsCost = Array.isArray(estimate.parts)
      ? estimate.parts.reduce((sum, p) => sum + (p.cost || 0), 0)
      : 0;
    const shopSupplies = (laborCost + partsCost) * ((estimate.shopSuppliesPercent || 7) / 100);
    const subtotal = laborCost + partsCost + shopSupplies;

    // Add to estimate object
    estimate.laborCost = laborCost;
    estimate.partsCost = partsCost;
    estimate.shopSupplies = shopSupplies;
    estimate.subtotal = subtotal;

    return res.json({
      ok: true,
      estimate
    });

  } catch (err) {
    log('error', 'Estimate generation failed', { 
      requestId, 
      error: err.message, 
      type: err.constructor.name,
      stack: err.stack 
    });

    // Handle specific error types
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Request timed out. The AI took too long to respond. Please try again.' });
    }

    if (err instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Invalid input data', 
        details: err.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      });
    }

    res.status(500).json({ error: err.message || 'Failed to generate estimate' });
  }
});

// Fetch recent jobs
app.get('/api/jobs', async (req, res) => {
  const { data, error } = await supabase.from('jobs').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error });
  res.json({ data });
});

// PHASE 2 ENDPOINTS - Customer & Estimate Management

// Create or update customer
app.post('/api/customers', async (req, res) => {
  const requestId = generateRequestId();
  
  try {
    const { name, phone, email } = req.body;
    log('info', 'Customer creation requested', { requestId, name });
    
    if (!name) {
      return res.status(400).json({ error: 'Customer name required' });
    }
    
    const { data, error } = await supabase
      .from('customers')
      .insert({ name, phone, email })
      .select()
      .single();
      
    if (error) {
      log('error', 'Customer creation failed', { requestId, error: error.message });
      return res.status(400).json({ error: error.message });
    }
    
    log('info', 'Customer created', { requestId, customerId: data.id });
    res.json({ ok: true, customer: data });
    
  } catch (err) {
    log('error', 'Customer creation error', { requestId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get all customers
app.get('/api/customers', async (req, res) => {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .order('created_at', { ascending: false });
    
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, customers: data });
});

// Get single customer
app.get('/api/customers/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', id)
    .single();
    
  if (error) return res.status(404).json({ error: 'Customer not found' });
  res.json({ ok: true, customer: data });
});

// Save estimate to database
app.post('/api/save-estimate', async (req, res) => {
  const requestId = generateRequestId();
  
  try {
    const { customerId, vehicle, description, estimate } = req.body;
    log('info', 'Saving estimate', { requestId, customerId });
    
    if (!customerId || !estimate) {
      return res.status(400).json({ error: 'Customer ID and estimate required' });
    }
    
    const { data, error } = await supabase
      .from('estimates')
      .insert({ 
        customer_id: customerId, 
        vehicle, 
        description, 
        estimate 
      })
      .select()
      .single();
      
    if (error) {
      log('error', 'Estimate save failed', { requestId, error: error.message });
      return res.status(400).json({ error: error.message });
    }
    
    log('info', 'Estimate saved', { requestId, estimateId: data.id });
    res.json({ ok: true, estimateId: data.id, estimate: data });
    
  } catch (err) {
    log('error', 'Save estimate error', { requestId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get all estimates
app.get('/api/estimates', async (req, res) => {
  const { data, error } = await supabase
    .from('estimates')
    .select(`
      *,
      customers (
        id,
        name,
        phone,
        email
      )
    `)
    .order('created_at', { ascending: false })
    .limit(100);
    
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, estimates: data });
});

// Get single estimate
app.get('/api/estimates/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('estimates')
    .select(`
      *,
      customers (
        id,
        name,
        phone,
        email
      )
    `)
    .eq('id', id)
    .single();
    
  if (error) return res.status(404).json({ error: 'Estimate not found' });
  res.json({ ok: true, estimate: data });
});

// Create invoice from estimate
app.post('/api/create-invoice', async (req, res) => {
  const requestId = generateRequestId();
  
  try {
    const { estimateId } = req.body;
    log('info', 'Creating invoice', { requestId, estimateId });
    
    if (!estimateId) {
      return res.status(400).json({ error: 'Estimate ID required' });
    }
    
    // Get the estimate
    const { data: estimate, error: estimateError } = await supabase
      .from('estimates')
      .select('*')
      .eq('id', estimateId)
      .single();
      
    if (estimateError) {
      return res.status(404).json({ error: 'Estimate not found' });
    }
    
    // Generate invoice number
    const invoiceNumber = `INV-${Date.now()}`;
    const total = estimate.estimate.subtotal || 0;
    
    // Create invoice
    const { data, error } = await supabase
      .from('invoices')
      .insert({
        estimate_id: estimateId,
        invoice_number: invoiceNumber,
        total,
        status: 'draft'
      })
      .select()
      .single();
      
    if (error) {
      log('error', 'Invoice creation failed', { requestId, error: error.message });
      return res.status(400).json({ error: error.message });
    }
    
    // Update estimate status
    await supabase
      .from('estimates')
      .update({ status: 'invoiced' })
      .eq('id', estimateId);
    
    log('info', 'Invoice created', { requestId, invoiceId: data.id, invoiceNumber });
    res.json({ ok: true, invoice: data });
    
  } catch (err) {
    log('error', 'Create invoice error', { requestId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get all invoices
app.get('/api/invoices', async (req, res) => {
  const { data, error } = await supabase
    .from('invoices')
    .select(`
      *,
      estimates (
        id,
        vehicle,
        description,
        estimate,
        customers (
          id,
          name,
          phone,
          email
        )
      )
    `)
    .order('created_at', { ascending: false });
    
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, invoices: data });
});

// Serve static frontend from /public folder
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all for SPA routing (send index.html for any non-API GET)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  log('info', 'SKSK ProTech backend started', { 
    port: PORT, 
    mode: process.env.NODE_ENV || 'development',
    groqConfigured: !!GROQ_API_KEY,
    supabaseConfigured: !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  });
  console.log(`✅ SKSK ProTech backend running on port ${PORT}`);
  console.log(`✅ All features active: VIN, Photo, DTC, OEM, Access Control`);
});
