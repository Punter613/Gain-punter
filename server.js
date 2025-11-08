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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'P613 Estimator Backend (Groq-powered)' });
});

// VIN Lookup endpoint (FREE NHTSA API)
app.get('/api/vin-lookup/:vin', async (req, res) => {
  try {
    const { vin } = req.params;
    
    // Validate VIN format (17 characters, alphanumeric)
    if (!vin || vin.length !== 17) {
      return res.status(400).json({ error: 'VIN must be exactly 17 characters' });
    }

    // Call NHTSA VIN decoder API (FREE, no API key needed)
    const response = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`);
    
    if (!response.ok) {
      throw new Error('Failed to lookup VIN');
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
    res.status(500).json({ error: err.message || 'Failed to lookup VIN' });
  }
});

// Photo Damage Analysis endpoint
app.post('/api/analyze-photo', async (req, res) => {
  try {
    const { imageData } = req.body;
    
    if (!imageData) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    // Groq Vision API call
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
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
    res.status(500).json({ error: err.message || 'Failed to analyze photo' });
  }
});

// Input validation schema
const GenerateSchema = z.object({
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().optional()
  }),
  vehicle: z.string().optional(),
  description: z.string().min(3),
  jobType: z.string().optional()
});

// Prompt builder
function buildPrompt({customer, vehicle, description}) {
  return `You are a master automotive technician and service writer with 20+ years of experience in independent repair shops.
Given a customer job description, produce a DETAILED, professional estimate as JSON.

{
  "jobType": string,
  "shortDescription": string,
  "laborHours": number,
  "laborRate": number,
  "workSteps": [string (detailed steps with specific actions)],
  "parts": [{"name":string,"cost":number}],
  "shopSuppliesPercent": number,
  "timeline": string,
  "notes": string,
  "proTips": [string (insider tips, tricks, and things to watch out for)],
  "warnings": [string (potential issues, gotchas, or things that could go wrong)]
}

Requirements:
- Be realistic and conservative for a 1-2 tech independent shop
- Use laborRate = ${DEFAULT_LABOR_RATE} unless specialty work justifies more
- Provide detailed parts with realistic costs (whole dollars)
- laborHours as decimal (e.g., 14.5) - include diagnosis, testing, cleanup time
- shopSuppliesPercent default to 7%
- workSteps should be DETAILED with specific actions (not just "remove engine" but "Drain coolant and engine oil, disconnect battery, remove radiator, unbolt motor mounts, etc.")
- proTips should include: time-savers, special tools needed, parts to inspect while you're in there, torque specs if critical, common shortcuts
- warnings should include: common problems (stripped bolts, seized parts), year-specific issues, things that break often, hidden labor traps
- Be conversational and practical - like talking to another tech
- Return ONLY valid JSON, no markdown

Customer: ${customer.name} ${customer.phone ? `phone:${customer.phone}` : ''} ${customer.email ? `email:${customer.email}` : ''}
Vehicle: ${vehicle || 'Not specified'}
Job description: ${description}

Think like a seasoned tech explaining the job to an apprentice - thorough, practical, and real-world focused.`;
}

app.post('/api/generate-estimate', async (req, res) => {
  try {
    const parsed = GenerateSchema.parse(req.body);
    const { customer, vehicle, description } = parsed;

    const prompt = buildPrompt({ customer, vehicle, description });

    // Call Groq API (OpenAI-compatible)
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
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
    res.status(500).json({ error: err.message || err });
  }
});

app.get('/api/jobs', async (req, res) => {
  const { data, error } = await supabase.from('jobs').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error });
  res.json({ data });
});

app.listen(PORT, () => console.log(`P613 estimator backend running on port ${PORT} (Groq-powered)`));
