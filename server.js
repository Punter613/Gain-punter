require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const { z } = require('zod');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEFAULT_LABOR_RATE = Number(process.env.DEFAULT_LABOR_RATE || 65);

if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing in env');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE creds missing in env');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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

// IMPROVED PROMPT with real-world pricing logic
function buildPrompt({customer, vehicle, description}) {
  return `
You are an experienced automotive service writer for a MOBILE MECHANIC or small independent shop (1-2 technicians). 
Given a customer job description, produce a realistic, itemized ESTIMATE as JSON.

CRITICAL PRICING RULES:
===========================================

1. LABOR EFFICIENCY - Think in COMPLETE JOBS, not individual parts:
   - OIL CHANGES: 0.5-0.75 hours MAX (not 1.5 hours!)
   - Brake jobs: Price as COMPLETE AXLE SERVICE (front OR rear), NOT per wheel
   - Example: "Front brake pads and rotors" = 1.5-2 hrs TOTAL (not 1.5 per side)
   - Spark plugs: Price as COMPLETE SET, not per cylinder
   - Example: "Replace 8 spark plugs V8" = 1.0-1.5 hrs TOTAL (not 0.2 hrs × 8)

2. COMMON JOB LABOR TIMES (FOLLOW THESE):
   - Oil change (basic): 0.5-0.75 hrs
   - Oil change + tire rotation: 0.75-1.0 hrs
   - Front brake pads only: 1.0-1.5 hrs
   - Front pads + rotors: 1.5-2.0 hrs
   - Battery replacement: 0.25-0.5 hrs
   - Alternator: 1.5-3.0 hrs (depends on accessibility)
   - Starter: 1.5-3.0 hrs (depends on location)
   - Spark plugs (4-cyl): 0.75-1.0 hrs
   - Spark plugs (V6/V8): 1.0-1.5 hrs

3. SETUP TIME ONLY COUNTS ONCE:
   - Lifting vehicle, removing wheels = counted once, not per corner
   - Accessing engine bay = one time, applies to all work in that area
   - If doing multiple related tasks, overlap setup time

4. REALISTIC MOBILE MECHANIC PRICING:
   - Small jobs (oil, battery): 0.5-1.5 hours max
   - Medium jobs (brakes, alternator): 1.5-3 hours
   - Large jobs (engine work): 4-16 hours
   - AVOID: Inflated hours that would price out mobile customers

5. PART PRICING - Realistic aftermarket/OEM blend:
   - Use TOTAL part cost, not per-unit × quantity
   - Example: "4 brake rotors" = $200 total (not $50 each listed 4 times)
   - Mobile shops use affordable parts, not dealer premium

===========================================

REAL-WORLD EXAMPLES (FOLLOW THESE PATTERNS):
===========================================

Example 1: "Oil change with full synthetic"
CORRECT:
{
  "laborHours": 0.5,
  "parts": [
    {"name": "Full Synthetic Oil (5qt)", "cost": 35},
    {"name": "Oil Filter", "cost": 12}
  ]
}
WRONG: 1.5 hours labor (way too much!)

Example 2: "Replace front brake pads and rotors"
CORRECT:
{
  "laborHours": 1.5,
  "parts": [
    {"name": "Front Brake Pad Set", "cost": 80},
    {"name": "Front Rotor Set (2)", "cost": 140}
  ]
}
WRONG: 3.0 hours (charging per side separately)

Example 3: "Replace all 8 spark plugs on V8"
CORRECT:
{
  "laborHours": 1.2,
  "parts": [
    {"name": "Spark Plug Set (8)", "cost": 60}
  ]
}
WRONG: 2.4 hours or listing each plug individually

Example 4: "Battery replacement"
CORRECT:
{
  "laborHours": 0.3,
  "parts": [
    {"name": "Battery (Group 65)", "cost": 150}
  ]
}
WRONG: 1.0 hour (way too much for simple battery swap)

===========================================

JSON STRUCTURE REQUIRED:
{
  "jobType": string,
  "shortDescription": string,
  "laborHours": number (decimal, e.g. 1.5),
  "laborRate": number,
  "workSteps": [string],
  "parts": [{"name":string,"cost":number}],
  "shopSuppliesPercent": number,
  "timeline": string,
  "notes": string,
  "tips": [string],
  "warnings": [string]
}

ADDITIONAL FIELDS:
- tips: Array of helpful tips for the mechanic (e.g., "Use a torque wrench for lug nuts")
- warnings: Array of things to watch out for (e.g., "Check for brake line corrosion on older vehicles")

REQUIREMENTS:
- Use laborRate = ${DEFAULT_LABOR_RATE} unless job clearly justifies different rate
- Parts costs in whole dollars (realistic aftermarket pricing)
- shopSuppliesPercent default to 7% (or justify in notes)
- shortDescription = one-line summary
- timeline = realistic for mobile/small shop ("Same day", "2-3 hours", "1-2 days")
- notes = any warnings, assumptions, or upsell opportunities
- workSteps = use plain bullet points (no special characters)
- Return ONLY valid JSON, no markdown or explanations

===========================================

CUSTOMER INFO:
Customer: ${customer.name} ${customer.phone ? `phone:${customer.phone}` : ''} ${customer.email ? `email:${customer.email}` : ''}
Vehicle: ${vehicle || 'Not provided'}
Job description: ${description}

Generate realistic estimate now:
`;
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SKSK AutoPro Backend - AI Estimator & Parts Integration',
    version: '1.1.0'
  });
});

// Generate estimate endpoint
app.post('/api/generate-estimate', async (req, res) => {
  try {
    // Validate input
    const parsed = GenerateSchema.parse(req.body);
    const { customer, vehicle, description } = parsed;

    // Build improved prompt
    const prompt = buildPrompt({ customer, vehicle, description });

    // Call OpenAI
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an expert automotive estimator for mobile mechanics and small shops. Provide realistic, competitive pricing that helps close deals while maintaining profitability. Always return valid JSON only.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1500,
      temperature: 0.1
    });

    // Extract response
    const text = response.choices?.[0]?.message?.content;
    if (!text) throw new Error('No response from AI');

    // Parse JSON from response
    const jsonMatch = text.trim().match(/\{[\s\S]*\}$/);
    const jsonText = jsonMatch ? jsonMatch[0] : text;

    let estimate;
    try {
      estimate = JSON.parse(jsonText);
    } catch (err) {
      return res.status(500).json({ 
        error: 'AI returned invalid JSON', 
        raw: text,
        hint: 'Try rephrasing the job description'
      });
    }

    // Normalize and validate estimate data
    estimate.laborRate = estimate.laborRate || DEFAULT_LABOR_RATE;
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
    const partsCost = estimate.parts.reduce((sum, p) => sum + Number(p.cost || 0), 0);
    const shopSupplies = Number((partsCost * (estimate.shopSuppliesPercent / 100)).toFixed(2));
    const subtotal = Number((laborCost + partsCost + shopSupplies).toFixed(2));

    // Calculate tax setaside (28% default for self-employed)
    const taxRate = 28;
    const recommendedTaxSetaside = Number((subtotal * (taxRate / 100)).toFixed(2));
    const netAfterTax = Number((subtotal - recommendedTaxSetaside).toFixed(2));

    // SANITY CHECK: Flag potentially inflated estimates
    const warnings = [];
    if (laborCost > 800 && description.toLowerCase().includes('brake')) {
      warnings.push('Labor cost seems high for brake job - verify hours are for complete service, not per wheel');
    }
    if (laborCost > 500 && description.toLowerCase().includes('oil change')) {
      warnings.push('Labor cost unusually high for oil change - check if other work is included');
    }
    if (laborCost > 100 && description.toLowerCase().match(/oil.*change/i) && !description.toLowerCase().includes('rotate')) {
      warnings.push('Labor seems high for basic oil change - should be 0.5-0.75 hours');
    }
    if (estimate.laborHours > 20) {
      warnings.push('Job exceeds 20 hours - may be too complex for mobile service');
    }

    // Save customer (upsert logic)
    let customerRecord = null;
    if (customer.email) {
      const { data: existingByEmail } = await supabase
        .from('customers')
        .select('*')
        .eq('email', customer.email)
        .limit(1);
      if (existingByEmail && existingByEmail.length) customerRecord = existingByEmail[0];
    }
    if (!customerRecord && customer.phone) {
      const { data: existingByPhone } = await supabase
        .from('customers')
        .select('*')
        .eq('phone', customer.phone)
        .limit(1);
      if (existingByPhone && existingByPhone.length) customerRecord = existingByPhone[0];
    }

    if (!customerRecord) {
      const { data: insertedCustomer, error: insertErr } = await supabase
        .from('customers')
        .insert({
          name: customer.name,
          phone: customer.phone || null,
          email: customer.email || null
        })
        .select()
        .single();
      if (insertErr) throw insertErr;
      customerRecord = insertedCustomer;
    }

    // Save job to database
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

    const { data: savedJob, error: jobErr } = await supabase
      .from('jobs')
      .insert(jobPayload)
      .select()
      .single();
    if (jobErr) throw jobErr;

    // Return response with tax info and warnings
    res.json({
      ok: true,
      estimate: { 
        ...estimate, 
        laborCost, 
        partsCost, 
        shopSupplies, 
        subtotal,
        // Tax calculations for mechanic
        taxRate,
        recommendedTaxSetaside,
        netAfterTax
      },
      savedJob,
      customer: customerRecord,
      warnings: warnings.length > 0 ? warnings : undefined
    });

  } catch (err) {
    console.error('generate-estimate error', err);
    res.status(500).json({ 
      error: err.message || 'Server error',
      type: err.name || 'UnknownError'
    });
  }
});

// Fetch recent jobs
app.get('/api/jobs', async (req, res) => {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

// Get tax summary for current month
app.get('/api/tax-summary/month', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tax_summary')
      .select('*')
      .limit(12);
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get quarterly tax summary
app.get('/api/tax-summary/quarter', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('quarterly_tax_summary')
      .select('*')
      .limit(8);
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark job as paid (converts estimate to invoice)
app.post('/api/jobs/:jobId/mark-paid', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { paymentAmount, invoiceNumber, paymentDate } = req.body;
    
    const { data, error } = await supabase
      .from('jobs')
      .update({
        payment_received: paymentAmount,
        invoice_number: invoiceNumber || `INV-${Date.now()}`,
        payment_date: paymentDate || new Date().toISOString(),
        status: 'completed'
      })
      .eq('id', jobId)
      .select()
      .single();
      
    if (error) throw error;
    res.json({ ok: true, job: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add expense tracking
app.post('/api/expenses', async (req, res) => {
  try {
    const { userId, category, description, amount, expenseDate, isDeductible, notes } = req.body;
    
    const { data, error } = await supabase
      .from('expenses')
      .insert({
        user_id: userId,
        category,
        description,
        amount,
        expense_date: expenseDate,
        is_deductible: isDeductible !== false,
        notes
      })
      .select()
      .single();
      
    if (error) throw error;
    res.json({ ok: true, expense: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user's tax settings
app.get('/api/tax-settings/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    let { data, error } = await supabase
      .from('tax_settings')
      .select('*')
      .eq('user_id', userId)
      .single();
      
    // Create default settings if none exist
    if (error && error.code === 'PGRST116') {
      const { data: newSettings, error: insertError } = await supabase
        .from('tax_settings')
        .insert({ user_id: userId, tax_rate: 28 })
        .select()
        .single();
      if (insertError) throw insertError;
      data = newSettings;
    } else if (error) {
      throw error;
    }
    
    res.json({ ok: true, settings: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🔥 SKSK AutoPro Backend running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/`);
  console.log(`💰 Tax tracking enabled - 28% default set-aside`);
});
