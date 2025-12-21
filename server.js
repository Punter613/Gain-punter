require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');

const app = express();

// ========================================
// CORS & MIDDLEWARE
// ========================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: false
}));
app.options('*', cors());
app.use(express.json());

// ========================================
// ENVIRONMENT VARIABLES
// ========================================
const PORT = process.env.PORT || 4000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEFAULT_LABOR_RATE = Number(process.env.DEFAULT_LABOR_RATE || 65);
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://sksk-protech.netlify.app';

if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY missing');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE creds missing');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Initialize Stripe (only if key exists)
let stripe = null;
if (STRIPE_SECRET_KEY) {
  stripe = require('stripe')(STRIPE_SECRET_KEY);
  console.log('💳 Stripe initialized');
}

// ========================================
// FLAT RATES TABLE
// ========================================
const FLAT_RATES = {
  'oil change': 0.5, 'oil change basic': 0.5, 'oil change synthetic': 0.5,
  'oil and filter': 0.5, 'oil change + rotation': 1.0, 'oil change and tire rotation': 1.0,
  'tire rotation': 0.5, 'rotate tires': 0.5,
  'battery replacement': 0.3, 'battery install': 0.3, 'replace battery': 0.3,
  'wiper blades': 0.2, 'windshield wipers': 0.2,
  'air filter': 0.3, 'engine air filter': 0.3,
  'cabin filter': 0.4, 'cabin air filter': 0.4,
  'brake fluid flush': 0.75, 'brake fluid change': 0.75,
  'coolant flush': 1.0, 'radiator flush': 1.0, 'coolant change': 1.0,
  'transmission fluid': 1.0, 'transmission fluid change': 1.0, 'trans fluid': 1.0,
  'power steering flush': 0.5, 'power steering fluid': 0.5,
  'differential fluid': 0.75, 'diff fluid': 0.75,
  'thermostat': 1.0, 'thermostat replacement': 1.0,
  'water pump': 2.5, 'water pump replacement': 2.5, 'coolant pump': 2.5,
  'radiator': { min: 2.0, max: 3.5 }, 'radiator replacement': { min: 2.0, max: 3.5 },
  'radiator hose': 0.5, 'coolant hose': 0.5,
  'brake pads front': { min: 1.5, max: 2.0 }, 'front brake pads': { min: 1.5, max: 2.0 },
  'brake pads rear': { min: 1.5, max: 2.0 }, 'rear brake pads': { min: 1.5, max: 2.0 },
  'brake pads and rotors front': { min: 2.0, max: 2.5 },
  'brake pads and rotors rear': { min: 2.0, max: 2.5 },
  'brake caliper': { min: 1.0, max: 1.5 },
  'alternator': { min: 1.5, max: 3.5 }, 'alternator replacement': { min: 1.5, max: 3.5 },
  'starter': { min: 1.5, max: 3.5 }, 'starter motor': { min: 1.5, max: 3.5 },
  'spark plugs': { min: 0.75, max: 2.0 }, 'spark plug replacement': { min: 0.75, max: 2.0 },
  'ignition coil': { min: 0.5, max: 1.0 },
  'serpentine belt': { min: 0.5, max: 1.0 }, 'drive belt': { min: 0.5, max: 1.0 },
  'timing belt': { min: 4.0, max: 8.0 },
  'belt tensioner': 0.75,
  'tie rod': { min: 1.0, max: 1.5 },
  'ball joint': { min: 1.5, max: 2.5 },
  'control arm': { min: 1.5, max: 2.5 },
  'sway bar link': 0.75,
  'shock absorber': { min: 1.0, max: 1.5 },
  'strut': { min: 1.5, max: 2.5 },
  'fuel pump': { min: 2.0, max: 3.5 },
  'fuel filter': 0.5,
  'fuel injector': { min: 1.0, max: 2.0 },
  'muffler': { min: 1.0, max: 1.5 },
  'catalytic converter': { min: 1.5, max: 2.5 },
  'oxygen sensor': 0.5, 'o2 sensor': 0.5,
  'headlight bulb': 0.3,
  'window regulator': { min: 1.5, max: 2.5 },
  'wheel bearing': { min: 1.5, max: 2.5 }
};

function getFlatRate(description) {
  const desc = description.toLowerCase().trim();
  for (const [job, hours] of Object.entries(FLAT_RATES)) {
    if (desc.includes(job)) return { job, hours };
  }
  return null;
}

function getHourGuidance(description) {
  const flatRate = getFlatRate(description);
  if (!flatRate) {
    return { type: 'custom', message: '⚠️ CUSTOM JOB: Estimate realistic hours. Max 6hrs standard, 12hrs major.' };
  }
  const { job, hours } = flatRate;
  if (typeof hours === 'number') {
    return { type: 'fixed', message: `🔒 LOCKED: Use EXACTLY ${hours} hours for "${job}".`, hours };
  }
  return { type: 'range', message: `📊 RANGE: Use ${hours.min}-${hours.max} hours for "${job}".`, hours };
}

// ========================================
// ========================================
// SECTION 4: AI PROMPT BUILDER (ENHANCED)
// REPLACE YOUR EXISTING buildPrompt() FUNCTION WITH THIS
// ========================================

function buildPrompt({ customer, vehicle, description, laborRate }) {
  const effectiveRate = laborRate || DEFAULT_LABOR_RATE;
  
  // ========================================
  // SYMPTOM DETECTION
  // Detect if user described a symptom vs specific repair
  // ========================================
  const symptomKeywords = [
    'no heat', 'no ac', 'overheating', 'rough idle', 'wont start', 'won\'t start',
    'no start', 'stalling', 'stalls', 'smoking', 'leaking', 'leak', 'noise', 
    'clicking', 'grinding', 'squealing', 'squeaking', 'vibration', 'shaking', 
    'pulling', 'hesitation', 'hesitates', 'check engine', 'light on', 'mil on',
    'smell', 'burning', 'not working', 'doesn\'t work', 'misfire', 'misfiring',
    'hard to start', 'cranks but', 'turns over', 'sputtering', 'jerking',
    'sluggish', 'loss of power', 'no power', 'running rough'
  ];
  
  const isSymptom = symptomKeywords.some(keyword => 
    description.toLowerCase().includes(keyword)
  );
  
  // ========================================
  // DIAGNOSTIC GUIDANCE (for symptoms)
  // ========================================
  const diagnosticGuidance = isSymptom ? `

🚨 CRITICAL: This is a SYMPTOM, not a confirmed repair!

DIAGNOSTIC APPROACH REQUIRED:
1. Set "jobType": "Diagnosis"
2. Set "shortDescription": "Diagnose [symptom] - [vehicle if known]"
3. Set "laborHours": 1.0-1.5 (diagnostic time only)
4. Set "parts": [] (empty - no parts until diagnosis confirms issue)
5. In "workSteps": List diagnostic steps (not repair steps)
6. In "warnings": List POSSIBLE causes ranked by probability
7. In "notes": Explain diagnostic fee applies toward repair if approved

DIAGNOSTIC STEP DETAIL LEVEL (Goldilocks - not too basic, not excessive):
✅ GOOD: "Remove wheel, inspect brake lines and hoses for cracks/leaks, check pad thickness and wear pattern (uneven = stuck caliper), measure rotor thickness with micrometer, check caliper slide pins for binding"

❌ TOO BASIC: "Check brakes"

❌ TOO DETAILED: "Using 19mm socket, turn lug nuts counterclockwise exactly 12 rotations, lift with floor jack rated 3-ton minimum..."

PROBABILITY RANKING (in warnings):
- List MOST LIKELY cause first (60-80% probability)
- Then COMMON causes (15-25%)
- Then LESS COMMON (5-10%)
- Include cost estimate for each: "Thermostat ($20 + 1.0hr)"

EXAMPLE for "no heat" symptom:
{
  "jobType": "Diagnosis",
  "shortDescription": "Diagnose no heat condition - HVAC system",
  "laborHours": 1.5,
  "laborRate": ${effectiveRate},
  "parts": [],
  "workSteps": [
    "Check coolant level and condition (low = air in system)",
    "Start engine, feel heater hoses - both should get hot (if not, flow issue)",
    "Monitor temp gauge - if slow to warm up, likely thermostat",
    "With engine warm, change temp from cold to hot - listen for blend door motor clicking",
    "Check cabin air filter - severely clogged reduces airflow",
    "If available, scan for HVAC fault codes"
  ],
  "shopSuppliesPercent": 7,
  "timeline": "1-2 hours",
  "notes": "Diagnostic fee applies toward repair cost if work is approved. Multiple possible causes require testing before accurate parts quote.",
  "tips": [
    "Start with easiest checks first - coolant level is free",
    "Heater core clogs are less common but expensive - diagnose thoroughly first"
  ],
  "warnings": [
    "MOST LIKELY (70%): Low coolant or air in system - refill/bleed ($20 + 0.5hr)",
    "COMMON (20%): Stuck thermostat - replace ($25 + 1.0hr)",
    "COMMON (15%): Blend door actuator failure - replace ($80 + 2.0hrs)",
    "LESS LIKELY (10%): Clogged heater core - flush or replace ($150 + 3.0hrs)",
    "RARE (5%): Failed heater control valve (if equipped) - replace ($60 + 1.5hrs)",
    "Additional labor/parts determined after diagnosis confirms root cause"
  ]
}
` : `

CONFIRMED REPAIR APPROACH:
This is a specific repair request (not just a symptom).
- Quote the repair with parts and labor
- Provide detailed work steps (Goldilocks detail level)
- Include possible complications in warnings
- Tips should help mechanic do job efficiently
`;
  
  return `You are an experienced mobile mechanic estimator with 20+ years diagnostic experience.

🔒 MANDATORY LABOR RATE: $${effectiveRate}/hour
NEVER change this rate. This is what the customer is being charged.

${diagnosticGuidance}

📋 REALISTIC MOBILE MECHANIC LABOR TIMES:

DIAGNOSTICS (symptom-based jobs):
- General diagnosis: 1.0-1.5 hrs
- Electrical diagnosis: 1.5-2.0 hrs  
- Drivability diagnosis: 1.5-2.0 hrs
- No-start diagnosis: 1.0-1.5 hrs
- HVAC diagnosis: 1.0-1.5 hrs

CONFIRMED REPAIRS (specific part replacement):
- Water pump: 2.5 hrs
- Thermostat: 1.0 hrs
- Alternator: 1.5-3.5 hrs (depends on access)
- Starter: 1.5-3.5 hrs
- Brake pads (per axle): 1.5-2.0 hrs
- Brake pads + rotors (per axle): 2.0-2.5 hrs
- Spark plugs (4-cyl): 0.75-1.0 hrs
- Spark plugs (V6/V8): 1.0-2.0 hrs
- Serpentine belt: 0.5-1.0 hrs
- Oil change: 0.5 hrs
- Battery: 0.3 hrs

🎯 WORK STEP DETAIL GUIDELINES:

GOLDILOCKS LEVEL (what we want):
- Include key troubleshooting checks during work
- Mention critical torque specs or procedures
- Note common complications to watch for
- Professional but not hand-holding

EXAMPLES:
✅ Brakes: "Remove wheel, inspect lines/hoses for damage, check pad wear pattern (uneven = stuck caliper), apply thin film of grease to pad backs, lubricate caliper slide pins, compress piston while watching for fluid leaks, torque lug nuts to spec"

✅ Thermostat: "Drain coolant into container, remove upper hose, note thermostat orientation before removal, clean mating surfaces thoroughly, install with spring toward engine, refill and bleed system, verify temp gauge reaches normal operating range"

✅ Alternator: "Disconnect battery negative first, photograph belt routing before removal, check belt condition while off, inspect alternator connections for corrosion, torque mounting bolts to spec, verify battery warning light goes off after start"

JSON RESPONSE REQUIRED:
{
  "jobType": "Diagnosis" OR "Repair" OR "Service",
  "shortDescription": "Brief one-line summary",
  "laborHours": 2.5,
  "laborRate": ${effectiveRate},
  "workSteps": [
    "Step 1 with troubleshooting details",
    "Step 2 with key procedures",
    "Step 3 with verification checks"
  ],
  "parts": [
    {"name": "Part Name", "cost": 50}
  ],
  "shopSuppliesPercent": 7,
  "timeline": "Same day" OR "2-3 hours" OR "Next day",
  "notes": "Important context for customer",
  "tips": [
    "Helpful advice for mechanic doing work",
    "Tool recommendations or best practices"
  ],
  "warnings": [
    "Things to watch for during job",
    "If X found, may need Y (with cost estimate)"
  ]
}

🚨 CRITICAL RULES:
1. Return ONLY valid JSON, no markdown backticks
2. laborRate MUST be ${effectiveRate} exactly
3. If SYMPTOM → Diagnosis job, empty parts array, list possible causes
4. If SPECIFIC REPAIR → Quote with parts, detailed steps
5. Work steps = Goldilocks detail (not basic, not excessive)
6. Tips = for mechanic (tools, techniques, safety)
7. Warnings = possible complications ranked by probability
8. Filter out irrelevant issues (don't list water pump for starter problem)
9. Be conservative with labor hours - mobile mechanics work faster
10. Parts should be aftermarket pricing (not OEM dealer prices)

CUSTOMER: ${customer.name}
VEHICLE: ${vehicle || 'Not specified'}
JOB DESCRIPTION: ${description}

Generate estimate now (JSON only, no other text):`;
}

// ========================================
// END SECTION 4
// ========================================
// ========================================
// VALIDATION SCHEMAS
// ========================================
const GenerateSchema = z.object({
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().optional()
  }),
  vehicle: z.string().optional(),
  description: z.string().min(3),
  jobType: z.string().optional(),
  laborRate: z.number().optional()
});

// ========================================
// HEALTH CHECK
// ========================================
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'SKSK ProTech Backend',
    version: '3.0.0',
    features: ['Groq AI', 'Flat Rates', 'Tax Tracking', 'Invoice System', 'VIN Lookup', 'Stripe Payments']
  });
});

// ========================================
// ESTIMATE GENERATION
// ========================================
app.post('/api/generate-estimate', async (req, res) => {
  try {
    const parsed = GenerateSchema.parse(req.body);
    const { customer, vehicle, description } = parsed;
    const laborRate = parsed.laborRate || DEFAULT_LABOR_RATE;

    console.log(`[ESTIMATE] ${customer.name} | ${vehicle || 'N/A'} | $${laborRate}/hr`);

    const prompt = buildPrompt({ customer, vehicle, description, laborRate });

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'Expert automotive estimator. Return valid JSON only.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1500,
        temperature: 0.1
      })
    });

    if (!response.ok) throw new Error(`Groq API error: ${response.status}`);

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
      console.error('[JSON ERROR]', text.substring(0, 200));
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: text.substring(0, 500) });
    }

    estimate.laborRate = laborRate;
    
    const flatRateMatch = getFlatRate(description);
    if (flatRateMatch && typeof flatRateMatch.hours === 'number') {
      estimate.laborHours = flatRateMatch.hours;
      console.log(`[FLAT RATE] Forced ${flatRateMatch.hours}hrs for "${flatRateMatch.job}"`);
    }
    
    estimate.shopSuppliesPercent = estimate.shopSuppliesPercent ?? 7;
    estimate.laborHours = parseFloat(estimate.laborHours || 0);
    estimate.parts = (estimate.parts || []).map(p => ({ 
      name: p.name || 'Part', 
      cost: Math.round(Number(p.cost || 0)) 
    }));
    estimate.tips = estimate.tips || [];
    estimate.warnings = estimate.warnings || [];
    estimate.workSteps = estimate.workSteps || [];

    const laborCost = Number((estimate.laborHours * estimate.laborRate).toFixed(2));
    const partsCost = estimate.parts.reduce((s, p) => s + Number(p.cost || 0), 0);
    const shopSupplies = Number((partsCost * (estimate.shopSuppliesPercent / 100)).toFixed(2));
    const subtotal = Number((laborCost + partsCost + shopSupplies).toFixed(2));
    const taxRate = 28;
    const recommendedTaxSetaside = Number((subtotal * 0.28).toFixed(2));
    const netAfterTax = Number((subtotal - recommendedTaxSetaside).toFixed(2));

    let customerRecord = null;
    if (customer.email) {
      const { data } = await supabase.from('customers').select('*').eq('email', customer.email).limit(1);
      if (data && data.length) customerRecord = data[0];
    }
    if (!customerRecord && customer.phone) {
      const { data } = await supabase.from('customers').select('*').eq('phone', customer.phone).limit(1);
      if (data && data.length) customerRecord = data[0];
    }
    if (!customerRecord) {
      const { data, error } = await supabase.from('customers')
        .insert({ name: customer.name, phone: customer.phone || null, email: customer.email || null })
        .select().single();
      if (error) throw error;
      customerRecord = data;
    }

    const { data: savedJob, error: jobErr } = await supabase.from('jobs').insert({
      customer_id: customerRecord.id,
      status: 'estimate',
      description: estimate.shortDescription || description,
      raw_description: description,
      job_type: estimate.jobType || 'Auto Repair',
      vehicle: vehicle || null,
      estimated_labor_hours: estimate.laborHours,
      estimated_labor_rate: estimate.laborRate,
      estimated_labor_cost: laborCost,
      estimated_parts: estimate.parts,
      estimated_parts_cost: partsCost,
      estimated_shop_supplies_percent: estimate.shopSuppliesPercent,
      estimated_shop_supplies_cost: shopSupplies,
      estimated_subtotal: subtotal,
      estimated_tax_setaside: recommendedTaxSetaside,
      tax_year: new Date().getFullYear(),
      tax_rate: taxRate,
      timeline: estimate.timeline || 'TBD',
      work_steps: estimate.workSteps,
      notes: estimate.notes || ''
    }).select().single();
    
    if (jobErr) throw jobErr;

    console.log(`[SAVED] Job ${savedJob.id} | $${subtotal}`);

    res.json({
      ok: true,
      estimate: { ...estimate, laborCost, partsCost, shopSupplies, subtotal, taxRate, recommendedTaxSetaside, netAfterTax },
      savedJob,
      customer: customerRecord
    });

  } catch (err) {
    console.error('[ESTIMATE ERROR]', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ========================================
// CUSTOMERS
// ========================================
app.get('/api/customers', async (req, res) => {
  try {
    const { data, error } = await supabase.from('customers').select('*').order('name', { ascending: true });
    if (error) throw error;
    res.json({ ok: true, customers: data || [] });
  } catch (err) {
    console.error('[CUSTOMERS ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// ACCESS CODE VALIDATION
// ========================================
app.post('/api/validate-access', async (req, res) => {
  try {
    const { accessCode } = req.body;
    if (!accessCode || accessCode.trim().length === 0) {
      return res.json({ valid: false, error: 'Access code required' });
    }
    
    const code = accessCode.trim().toUpperCase();
    
    const { data, error } = await supabase.from('access_codes')
      .select('*').eq('code', code).eq('is_active', true).single();
    
    if (error || !data) {
      return res.json({ valid: false, error: 'Invalid or expired code' });
    }
    
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return res.json({ valid: false, error: 'Code expired' });
    }
    
    if (data.max_uses && data.current_uses >= data.max_uses) {
      return res.json({ valid: false, error: 'Code max uses reached' });
    }
    
    await supabase.from('access_codes').update({ 
      current_uses: (data.current_uses || 0) + 1,
      last_used_at: new Date().toISOString()
    }).eq('id', data.id);
    
    res.json({
      valid: true,
      tier: data.tier || 'pro',
      customer: data.customer_name || 'Pro User',
      expires: data.expires_at,
      message: `Welcome to SKSK ProTech ${data.tier === 'pro_plus' ? 'Pro Plus' : 'Pro'}!`
    });
  } catch (err) {
    console.error('[VALIDATE ACCESS ERROR]', err);
    res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// ========================================
// VIN LOOKUP
// ========================================
app.get('/api/vin-lookup/:vin', async (req, res) => {
  try {
    const vin = req.params.vin.trim().toUpperCase();
    if (vin.length !== 17) {
      return res.status(400).json({ ok: false, error: 'VIN must be 17 characters' });
    }
    
    const nhtsaUrl = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`;
    const response = await fetch(nhtsaUrl);
    if (!response.ok) throw new Error('NHTSA API failed');
    
    const data = await response.json();
    if (!data.Results || data.Results.length === 0) {
      return res.json({ ok: false, error: 'VIN not found' });
    }
    
    const results = data.Results;
    const getField = (variableId) => {
      const field = results.find(r => r.VariableId === variableId);
      return field?.Value || null;
    };
    
    const year = getField(29) || getField(26);
    const make = getField(26);
    const model = getField(28);
    const trim = getField(109);
    const displacement = getField(11);
    const cylinders = getField(9);
    
    let displayString = '';
    if (year) displayString += `${year} `;
    if (make) displayString += `${make} `;
    if (model) displayString += `${model} `;
    if (trim) displayString += `${trim} `;
    if (displacement && cylinders) displayString += `${displacement}L V${cylinders}`;
    
    res.json({
      ok: true,
      vin,
      year, make, model, trim, displacement, cylinders,
      displayString: displayString.trim()
    });
  } catch (err) {
    console.error('[VIN LOOKUP ERROR]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ========================================
// JOBS
// ========================================
app.get('/api/jobs', async (req, res) => {
  const { data, error } = await supabase.from('jobs').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, data });
});

// ========================================
// STRIPE INTEGRATION
// ========================================

const PRICING = {
  pro_monthly: {
    price: 2900,
    interval: 'month',
    name: 'SKSK ProTech Pro - Monthly'
  },
  pro_yearly: {
    price: 29000,
    interval: 'year',
    name: 'SKSK ProTech Pro - Yearly'
  }
};

// Generate random access code
function generateAccessCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Create Stripe checkout session
app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  try {
    const { plan, customerEmail, customerName } = req.body;
    
    if (!plan || !PRICING[plan]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    
    const pricing = PRICING[plan];
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: customerEmail || undefined,
      client_reference_id: customerName || undefined,
      
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: pricing.name,
              description: 'Full access: Unlimited estimates, customer DB, VIN lookup, invoices, expense tracking, tax reports',
            },
            unit_amount: pricing.price,
            recurring: {
              interval: pricing.interval,
            },
          },
          quantity: 1,
        },
      ],
      
      success_url: `${FRONTEND_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}?canceled=true`,
      
      metadata: {
        plan: plan,
        tier: 'pro'
      },
    });
    
    console.log(`[STRIPE] Checkout session created: ${session.id}`);
    
    res.json({ 
      ok: true, 
      sessionId: session.id,
      url: session.url 
    });
    
  } catch (err) {
    console.error('[STRIPE CHECKOUT ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook handler
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    return res.status(500).send('Stripe not configured');
  }

  const sig = req.headers['stripe-signature'];
  
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  console.log(`[STRIPE EVENT] ${event.type}`);
  
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        const customerEmail = session.customer_email;
        const customerName = session.client_reference_id;
        const stripeCustomerId = session.customer;
        const subscriptionId = session.subscription;
        
        const accessCode = generateAccessCode();
        
        await supabase.from('access_codes').insert({
          code: accessCode,
          tier: 'pro',
          customer_name: customerName || customerEmail,
          email: customerEmail,
          is_active: true,
          max_uses: 999,
          stripe_customer_id: stripeCustomerId,
          stripe_subscription_id: subscriptionId,
          stripe_subscription_status: 'active'
        });
        
        console.log(`[ACCESS CODE CREATED] ${accessCode} for ${customerEmail}`);
        break;
        
      case 'customer.subscription.updated':
        const subscription = event.data.object;
        const isActive = subscription.status === 'active' || subscription.status === 'trialing';
        
        await supabase.from('access_codes').update({ 
          is_active: isActive,
          stripe_subscription_status: subscription.status
        }).eq('stripe_subscription_id', subscription.id);
        
        console.log(`[SUBSCRIPTION UPDATED] ${subscription.id} -> ${subscription.status}`);
        break;
        
      case 'customer.subscription.deleted':
        const deletedSub = event.data.object;
        
        await supabase.from('access_codes').update({ 
          is_active: false,
          stripe_subscription_status: 'canceled'
        }).eq('stripe_subscription_id', deletedSub.id);
        
        console.log(`[SUBSCRIPTION DELETED] ${deletedSub.id}`);
        break;
    }
  } catch (err) {
    console.error('[WEBHOOK HANDLER ERROR]', err);
  }
  
  res.json({ received: true });
});

// ========================================
// START SERVER
// ========================================
app.listen(PORT, () => {
  console.log(`🔥 SKSK ProTech Backend v3.0 on port ${PORT}`);
  console.log(`🤖 Groq AI + 80+ flat rates active`);
  console.log(`💰 Tax tracking enabled`);
  if (stripe) {
    console.log(`💳 Stripe payments enabled`);
  }
});
