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

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'SKSK AutoPro Backend (Groq-powered)',
    version: '2.0.0',
    features: ['Groq AI', 'Flat Rates', 'Tax Tracking', 'OEM Data Ready']
  });
});

// Input validation
const GenerateSchema = z.object({
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().optional()
  }),
  vehicle: z.string().optional(),
  description: z.string().min(3),
  jobType: z.string().optional(),
  laborRate: z.number().optional() // ← BRIAN: Add this so frontend can pass custom rate
});

// FLAT RATE TABLE - Common jobs have fixed labor times
// BRIAN: Expand this list significantly! Add water pump, alternator, starter, 
// fuel pump, thermostat, radiator, serpentine belt, brake jobs by axle, etc.
const FLAT_RATES = {
  'oil change': 0.5,
  'oil change basic': 0.5,
  'oil change synthetic': 0.5,
  'oil change + rotation': 1.0,
  'tire rotation': 0.5,
  'battery replacement': 0.3,
  'battery install': 0.3,
  'wiper blades': 0.2,
  'air filter': 0.3,
  'cabin filter': 0.4,
  'brake fluid flush': 0.75,
  'coolant flush': 1.0,
  'transmission fluid': 1.0
  // BRIAN TODO: Add at least 20-30 more common jobs here with realistic mobile mechanic times
};

// Check if job matches a flat rate
function getFlatRate(description) {
  const desc = description.toLowerCase().trim();
  for (const [job, hours] of Object.entries(FLAT_RATES)) {
    if (desc.includes(job)) {
      return hours;
    }
  }
  return null;
}

// BRIAN: This prompt needs major work:
// 1. Must RESPECT the custom laborRate passed from frontend
// 2. Need better hour estimates (water pump was 8.5hrs - way too high!)
// 3. Add more specific guidance for common repairs
// 4. Make it understand mobile mechanic constraints vs full shop
function buildPrompt({customer, vehicle, description, laborRate}) {
  const flatRate = getFlatRate(description);
  const effectiveRate = laborRate || DEFAULT_LABOR_RATE; // Use custom rate if provided
  const flatRateHint = flatRate ? `\n\nIMPORTANT: This is a FLAT RATE job. Use exactly ${flatRate} hours for labor, no exceptions.` : '';
  
  return `You are an experienced automotive service writer for a MOBILE MECHANIC or small shop.
Given a customer job description, produce a realistic estimate as JSON.

CRITICAL FLAT RATE JOBS (USE EXACT HOURS):
- Oil change (any type): 0.5 hours
- Oil change + tire rotation: 1.0 hours  
- Battery replacement: 0.3 hours
- Wiper blades: 0.2 hours
- Air filter: 0.3 hours
- Cabin filter: 0.4 hours
- Tire rotation: 0.5 hours
- Brake fluid flush: 0.75 hours
- Coolant flush: 1.0 hours

OTHER JOBS - REALISTIC MOBILE MECHANIC TIMES:
- Brake pads (front or rear): 1.5-2.0 hours TOTAL (not per wheel)
- Brake pads + rotors: 2.0-2.5 hours TOTAL
- Alternator: 1.5-3.0 hours (depends on accessibility)
- Starter: 1.5-3.0 hours
- Spark plugs (4-cyl): 0.75-1.0 hours TOTAL
- Spark plugs (V6/V8): 1.0-1.5 hours TOTAL
- Serpentine belt: 0.5-1.0 hours
// BRIAN TODO: Add water pump (2-3.5hrs), thermostat (0.75-1.5hrs), fuel pump (1.5-2.5hrs), etc.

SETUP TIME COUNTS ONCE:
- Don't charge separately for lifting vehicle, removing wheels, etc.
- If doing multiple tasks, overlap setup time

JSON STRUCTURE REQUIRED:
{
  "jobType": string,
  "shortDescription": string,
  "laborHours": number (decimal),
  "laborRate": number,
  "workSteps": [string],
  "parts": [{"name":string,"cost":number}],
  "shopSuppliesPercent": number,
  "timeline": string,
  "notes": string,
  "tips": [string],
  "warnings": [string]
}

FIELDS EXPLAINED:
- laborRate: Use ${effectiveRate} for this job (RESPECT THIS RATE - DO NOT CHANGE IT)
- shopSuppliesPercent: Default 7%
- workSteps: Plain bullet points (no special characters)
- tips: Helpful advice for mechanic (e.g., "Use torque wrench")
- warnings: Things to watch for (e.g., "Check for rust on brake lines")
- parts: Use realistic aftermarket pricing, whole dollars
- timeline: Realistic (e.g., "Same day", "2-3 hours", "1-2 days")

IMPORTANT:
- Return ONLY valid JSON, no markdown backticks
- Use realistic mobile mechanic pricing
- Don't inflate hours to increase profit${flatRateHint}

Customer: ${customer.name}${customer.phone ? ` | ${customer.phone}` : ''}${customer.email ? ` | ${customer.email}` : ''}
Vehicle: ${vehicle || 'Not specified'}
Job: ${description}

Generate estimate now:`;
}

app.post('/api/generate-estimate', async (req, res) => {
  try {
    const parsed = GenerateSchema.parse(req.body);
    const { customer, vehicle, description, laborRate } = parsed; // ← BRIAN: Extract laborRate here

    const prompt = buildPrompt({ customer, vehicle, description, laborRate }); // ← BRIAN: Pass it to prompt

    // Call Groq API
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { 
            role: 'system', 
            content: 'You are an expert automotive estimator. Always respond with valid JSON only, no markdown formatting or explanations.' 
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1500,
        temperature: 0.1
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

    // Clean response
    let cleanText = text.trim();
    cleanText = cleanText.replace(/```json\n?/g, '');
    cleanText = cleanText.replace(/```\n?/g, '');
    cleanText = cleanText.trim();

    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : cleanText;

    let estimate;
    try {
      estimate = JSON.parse(jsonText);
    } catch (err) {
      console.error('JSON parse error. Raw:', text);
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: text });
    }

    // BRIAN: Force the laborRate to match what user selected, don't trust AI
    estimate.laborRate = laborRate || estimate.laborRate || DEFAULT_LABOR_RATE;
    estimate.shopSuppliesPercent = estimate.shopSuppliesPercent ?? 7;
    estimate.laborHours = parseFloat(estimate.laborHours || 0);
    estimate.parts = (estimate.parts || []).map(p => ({ 
      name: p.name, 
      cost: Math.round(Number(p.cost || 0)) 
    }));
    estimate.tips = estimate.tips || [];
    estimate.warnings = estimate.warnings || [];

    // Calculate totals
    const laborCost = Number((estimate.laborHours * estimate.laborRate).toFixed(2));
    const partsCost = estimate.parts.reduce((s,p)=> s + Number(p.cost || 0), 0);
    const shopSupplies = Number((partsCost * (estimate.shopSuppliesPercent/100)).toFixed(2));
    const subtotal = Number((laborCost + partsCost + shopSupplies).toFixed(2));

    // Tax calculation (28% for self-employed)
    const taxRate = 28;
    const recommendedTaxSetaside = Number((subtotal * (taxRate / 100)).toFixed(2));
    const netAfterTax = Number((subtotal - recommendedTaxSetaside).toFixed(2));

    // Save customer (existing logic is fine)
    let customerRecord = null;
    if (customer.email) {
      const { data: existing } = await supabase.from('customers').select('*').eq('email', customer.email).limit(1);
      if (existing && existing.length) customerRecord = existing[0];
    }
    if (!customerRecord && customer.phone) {
      const { data: existing } = await supabase.from('customers').select('*').eq('phone', customer.phone).limit(1);
      if (existing && existing.length) customerRecord = existing[0];
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
    console.error('generate-estimate error', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// BRIAN TODO: Add /api/customers GET endpoint so frontend can load saved customers
// BRIAN TODO: Add /api/validate-access POST endpoint for Pro access code checking
// BRIAN TODO: Add /api/vin-lookup/:vin GET endpoint for VIN decoding (NHTSA API is free)

app.get('/api/jobs', async (req, res) => {
  const { data, error } = await supabase.from('jobs').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

// Tax summary endpoints
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
  console.log(`🔥 SKSK AutoPro Backend running on port ${PORT}`);
  console.log(`🤖 Powered by Groq (llama-3.3-70b-versatile)`);
  console.log(`💰 Tax tracking enabled`);
  console.log(`⚡ Flat rates active for common jobs`);
});
