require('dotenv').config();
const express = require('express');
const cors = require('cors');
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
  res.json({ status: 'ok', service: 'P613 Estimator Backend (Groq-powered)' });
});

// VIN Lookup endpoint (FREE NHTSA API)
app.get('/api/vin-lookup/:vin', async (req, res) => {
  try {
    const { vin } = req.params;
    
    // VIN regex validation: 17 alphanumeric chars, no I, O, or Q
    const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/;
    
    if (!vin || !vinRegex.test(vin.toUpperCase())) {
      return res.status(400).json({ 
        error: 'Invalid VIN format. Must be exactly 17 characters (letters and numbers, no I, O, or Q)' 
      });
    }

    // Add timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    // Call NHTSA VIN decoder API (FREE, no API key needed)
    const response = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin.toUpperCase()}?format=json`,
      { signal: controller.signal }
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

    res.json({
      ok: true,
      vehicle: vehicleInfo,
      displayString: displayString || 'Unknown Vehicle',
      raw: data.Results // Include full data for debugging if needed
    });

  } catch (err) {
    console.error('VIN lookup error', err);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'VIN lookup timed out. Please try again.' });
    }
    res.status(500).json({ error: err.message || 'Failed to lookup VIN' });
  }
});

// Photo Damage Analysis endpoint
app.post('/api/analyze-photo', async (req, res) => {
  try {
    const { imageData } = req.body;
    
    // Validate image data
    if (!imageData || typeof imageData !== 'string') {
      return res.status(400).json({ error: 'No valid image data provided' });
    }
    
    if (!imageData.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image format. Must be base64 encoded image.' });
    }
    
    // Check image size (prevent huge uploads)
    const sizeInMB = (imageData.length * 0.75) / (1024 * 1024); // rough base64 to bytes
    if (sizeInMB > 10) {
      return res.status(400).json({ error: 'Image too large. Please compress to under 10MB.' });
    }

    // Add timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    // Groq Vision API call
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Groq Vision API error:', errorText);
      throw new Error(`Vision API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    
    if (!text) throw new Error('No response from Vision AI');

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
    } catch (err) {
      console.error('JSON parse error. Raw text:', text);
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
    console.error('Photo analysis error', err);
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
  try {
    // Validate input
    const parsed = GenerateSchema.parse(req.body);
    const { customer, vehicle, description } = parsed;

    const prompt = buildPrompt({ customer, vehicle, description });

    // Add timeout and retry logic
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

    // Call Groq API (OpenAI-compatible)
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
    });

    clearTimeout(timeoutId);
    console.log('Got API response, status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Groq API error:', errorText);
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
    } catch (err) {
      console.error('JSON parse error. Raw text:', text);
      return res.status(500).json({ error: 'AI returned non-JSON output', raw: text });
    }

    estimate.laborRate = estimate.laborRate || DEFAULT_LABOR_RATE;
    estimate.shopSuppliesPercent = estimate.shopSuppliesPercent ?? 7;
    estimate.parts = (estimate.parts || []).map(p => ({ name: p.name, cost: Math.round(Number(p.cost || 0)) }));

    const laborCost = Number((parseFloat(estimate.laborHours || 0) * estimate.laborRate).toFixed(2));
    const partsCost = estimate.parts.reduce((s,p)=> s + Number(p.cost || 0), 0);
    const shopSupplies = Number(((partsCost) * (estimate.shopSuppliesPercent/100)).toFixed(2));
    const subtotal = Number((laborCost + partsCost + shopSupplies).toFixed(2));

    let customerRecord = null;
    if (customer.email) {
      const { data: existingByEmail } = await supabase.from('customers').select('*').eq('email', customer.email).limit(1);
      if (existingByEmail && existingByEmail.length) customerRecord = existingByEmail[0];
    }
    if (!customerRecord && customer.phone) {
      const { data: existingByPhone } = await supabase.from('customers').select('*').eq('phone', customer.phone).limit(1);
      if (existingByPhone && existingByPhone.length) customerRecord = existingByPhone[0];
    }

    if (!customerRecord) {
      const { data: insertedCustomer, error: insertErr } = await supabase.from('customers').insert({
        name: customer.name,
        phone: customer.phone || null,
        email: customer.email || null
      }).select().single();
      if (insertErr) throw insertErr;
      customerRecord = insertedCustomer;
    }

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
      timeline: estimate.timeline || '',
      work_steps: estimate.workSteps || [],
      notes: estimate.notes || '',
      pro_tips: estimate.proTips || [],
      warnings: estimate.warnings || []
    };

    const { data: savedJob, error: jobErr } = await supabase.from('jobs').insert(jobPayload).select().single();
    if (jobErr) throw jobErr;

    res.json({
      ok: true,
      ai_raw_text: text,
      estimate: { ...estimate, laborCost, partsCost, shopSupplies, subtotal },
      savedJob,
      customer: customerRecord
    });

  } catch (err) {
    console.error('generate-estimate error', err);
    
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

app.get('/api/jobs', async (req, res) => {
  const { data, error } = await supabase.from('jobs').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error });
  res.json({ data });
});

app.listen(PORT, () => console.log(`P613 estimator backend running on port ${PORT} (Groq-powered)`));
