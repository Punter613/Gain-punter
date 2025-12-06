require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');

const app = express();
// ========================================
// STRIPE WEBHOOK — MUST BE ABOVE express.json()
// ========================================
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('[STRIPE EVENT]', event.type);

  switch (event.type) {
    case 'checkout.session.completed':
      console.log('[CHECKOUT COMPLETED]');
      break;

    case 'customer.subscription.created':
      console.log('[SUB CREATED]');
      break;

    case 'customer.subscription.updated':
      console.log('[SUB UPDATED]');
      break;

    case 'customer.subscription.deleted':
      console.log('[SUB DELETED]');
      break;

    case 'invoice.payment_failed':
      console.log('[PAYMENT FAILED]');
      break;

    default:
      console.log('[UNHANDLED EVENT]', event.type);
  }

  res.json({ received: true });
});
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

if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY missing');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE creds missing');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ========================================
// FLAT RATES TABLE (80+ common jobs)
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
  'brake pads front': { min: 1.5, max: 2.0 }, 'front brake pads': { min: 1.5, max: 2.0 }, 'front brakes': { min: 1.5, max: 2.0 },
  'brake pads rear': { min: 1.5, max: 2.0 }, 'rear brake pads': { min: 1.5, max: 2.0 }, 'rear brakes': { min: 1.5, max: 2.0 },
  'brake pads and rotors front': { min: 2.0, max: 2.5 }, 'front brake pads and rotors': { min: 2.0, max: 2.5 },
  'brake pads and rotors rear': { min: 2.0, max: 2.5 }, 'rear brake pads and rotors': { min: 2.0, max: 2.5 },
  'brake caliper': { min: 1.0, max: 1.5 }, 'caliper replacement': { min: 1.0, max: 1.5 },
  'alternator': { min: 1.5, max: 3.5 }, 'alternator replacement': { min: 1.5, max: 3.5 },
  'starter': { min: 1.5, max: 3.5 }, 'starter motor': { min: 1.5, max: 3.5 }, 'starter replacement': { min: 1.5, max: 3.5 },
  'battery terminals': 0.3, 'battery terminal cleaning': 0.3,
  'spark plugs': { min: 0.75, max: 2.0 }, 'spark plug replacement': { min: 0.75, max: 2.0 },
  'ignition coil': { min: 0.5, max: 1.0 }, 'coil pack': { min: 0.5, max: 1.0 },
  'serpentine belt': { min: 0.5, max: 1.0 }, 'drive belt': { min: 0.5, max: 1.0 }, 'accessory belt': { min: 0.5, max: 1.0 },
  'timing belt': { min: 4.0, max: 8.0 },
  'belt tensioner': 0.75,
  'tie rod end': { min: 1.0, max: 1.5 }, 'tie rod': { min: 1.0, max: 1.5 },
  'ball joint': { min: 1.5, max: 2.5 },
  'control arm': { min: 1.5, max: 2.5 },
  'sway bar link': 0.75, 'stabilizer link': 0.75,
  'shock absorber': { min: 1.0, max: 1.5 },
  'strut': { min: 1.5, max: 2.5 },
  'fuel pump': { min: 2.0, max: 3.5 }, 'fuel pump replacement': { min: 2.0, max: 3.5 },
  'fuel filter': 0.5,
  'fuel injector': { min: 1.0, max: 2.0 },
  'muffler': { min: 1.0, max: 1.5 }, 'muffler replacement': { min: 1.0, max: 1.5 },
  'catalytic converter': { min: 1.5, max: 2.5 }, 'cat converter': { min: 1.5, max: 2.5 },
  'oxygen sensor': 0.5, 'o2 sensor': 0.5,
  'headlight bulb': 0.3, 'headlight replacement': 0.3,
  'taillight bulb': 0.2,
  'door handle': 0.75,
  'window regulator': { min: 1.5, max: 2.5 },
  'wheel bearing': { min: 1.5, max: 2.5 }, 'hub bearing': { min: 1.5, max: 2.5 }
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
// AI PROMPT BUILDER
// ========================================
function buildPrompt({ customer, vehicle, description, laborRate }) {
  const effectiveRate = laborRate || DEFAULT_LABOR_RATE;
  const guidance = getHourGuidance(description);
  
  return `You are an experienced mobile mechanic estimator.

🔒 MANDATORY LABOR RATE: $${effectiveRate}/hour
DO NOT change this rate. This is what the customer is being charged.

${guidance.message}

REALISTIC MOBILE TIMES: Water pump 2.5hrs, Alternator 1.5-3.5hrs, Brakes 1.5-2hrs, Oil change 0.5hrs, Spark plugs 0.75-2hrs

JSON REQUIRED:
{
  "jobType": "Repair",
  "shortDescription": "Brief summary",
  "laborHours": 2.5,
  "laborRate": ${effectiveRate},
  "workSteps": ["Step 1", "Step 2"],
  "parts": [{"name":"Part","cost":50}],
  "shopSuppliesPercent": 7,
  "timeline": "Same day",
  "notes": "Context",
  "tips": ["Tip 1"],
  "warnings": ["Warning 1"]
}

Customer: ${customer.name}
Vehicle: ${vehicle || 'N/A'}
Job: ${description}

Return ONLY valid JSON:`;
}

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
    features: ['Groq AI', 'Flat Rates', 'Tax Tracking', 'Invoice System', 'VIN Lookup']
  });
});

// ========================================
// ESTIMATE GENERATION (FIXED)
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

app.post('/api/customers', async (req, res) => {
  try {
    const { name, phone, email, address, notes } = req.body;
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Customer name required' });
    }
    
    let existing = null;
    if (email) {
      const { data } = await supabase.from('customers').select('*').eq('email', email).limit(1);
      if (data && data.length > 0) existing = data[0];
    }
    if (!existing && phone) {
      const { data } = await supabase.from('customers').select('*').eq('phone', phone).limit(1);
      if (data && data.length > 0) existing = data[0];
    }
    
    if (existing) {
      return res.json({ ok: true, customer: existing, message: 'Customer already exists' });
    }
    
    const { data, error } = await supabase.from('customers').insert({
      name: name.trim(),
      phone: phone || null,
      email: email || null,
      address: address || null,
      notes: notes || null
    }).select().single();
    
    if (error) throw error;
    res.json({ ok: true, customer: data });
  } catch (err) {
    console.error('[CREATE CUSTOMER ERROR]', err);
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
// VIN LOOKUP (NHTSA API)
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
// STRIPE INTEGRATION FOR PRO SUBSCRIPTIONS
// Add this to your existing server.js
// ========================================

// 1. Install Stripe package
// Run in terminal: npm install stripe

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://sksk-protech.netlify.app';

// ========================================
// PRICING
// ========================================
const PRICING = {
  pro_monthly: {
    price: 2900, // $29.00 in cents
    interval: 'month',
    name: 'SKSK ProTech Pro - Monthly'
  },
  pro_yearly: {
    price: 29000, // $290.00 in cents (save $58/year)
    interval: 'year',
    name: 'SKSK ProTech Pro - Yearly'
  }
};

// ========================================
// CREATE STRIPE CHECKOUT SESSION
// Frontend calls this to start subscription
// ========================================
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { plan, customerEmail, customerName } = req.body;
    
    // Validate plan
    if (!plan || !PRICING[plan]) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }
    
    const pricing = PRICING[plan];
    
    // Create Stripe checkout session
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
              description: 'Full access to Pro features: Invoice generation, customer database, VIN lookup, expense tracking, tax reports',
            },
            unit_amount: pricing.price,
            recurring: {
              interval: pricing.interval,
            },
          },
          quantity: 1,
        },
      ],
      
      success_url: `${FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}?canceled=true`,
      
      metadata: {
        plan: plan,
        tier: 'pro'
      },
    });
    
    res.json({ 
      ok: true, 
      sessionId: session.id,
      url: session.url 
    });
    
  } catch (err) {
    console.error('[STRIPE CHECKOUT ERROR]', err);
    res.status(500).json({ error: err.message || 'Failed to create checkout session' });
  }
});

// ========================================
// STRIPE WEBHOOK (handles subscription events)
// ========================================
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  console.log(`[STRIPE EVENT] ${event.type}`);
  
  // Handle different event types
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object);
      break;
      
    case 'customer.subscription.created':
      await handleSubscriptionCreated(event.data.object);
      break;
      
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object);
      break;
      
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object);
      break;
      
    case 'invoice.payment_succeeded':
      console.log('[PAYMENT SUCCEEDED]', event.data.object.customer);
      break;
      
    case 'invoice.payment_failed':
      console.log('[PAYMENT FAILED]', event.data.object.customer);
      await handlePaymentFailed(event.data.object);
      break;
      
    default:
      console.log(`[UNHANDLED EVENT] ${event.type}`);
  }
  
  res.json({ received: true });
});

// ========================================
// WEBHOOK HANDLERS
// ========================================

async function handleCheckoutCompleted(session) {
  console.log('[CHECKOUT COMPLETED]', session.id);
  
  const customerEmail = session.customer_email;
  const customerName = session.client_reference_id;
  const stripeCustomerId = session.customer;
  const subscriptionId = session.subscription;
  
  // Generate permanent access code
  const accessCode = generateAccessCode();
  
  try {
    // Create access code in database
    const { error } = await supabase.from('access_codes').insert({
      code: accessCode,
      tier: 'pro',
      customer_name: customerName || customerEmail,
      email: customerEmail,
      is_active: true,
      max_uses: 999, // Unlimited for paid
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: subscriptionId
    });
    
    if (error) throw error;
    
    console.log(`[ACCESS CODE CREATED] ${accessCode} for ${customerEmail}`);
    
    // TODO: Send email with access code
    // await sendWelcomeEmail(customerEmail, accessCode);
    
  } catch (err) {
    console.error('[CHECKOUT HANDLER ERROR]', err);
  }
}

async function handleSubscriptionCreated(subscription) {
  console.log('[SUBSCRIPTION CREATED]', subscription.id);
  
  const { error } = await supabase
    .from('access_codes')
    .update({ 
      is_active: true,
      stripe_subscription_id: subscription.id,
      stripe_subscription_status: subscription.status
    })
    .eq('stripe_customer_id', subscription.customer);
  
  if (error) console.error('[UPDATE ERROR]', error);
}

async function handleSubscriptionUpdated(subscription) {
  console.log('[SUBSCRIPTION UPDATED]', subscription.id, subscription.status);
  
  const isActive = subscription.status === 'active' || subscription.status === 'trialing';
  
  const { error } = await supabase
    .from('access_codes')
    .update({ 
      is_active: isActive,
      stripe_subscription_status: subscription.status
    })
    .eq('stripe_subscription_id', subscription.id);
  
  if (error) console.error('[UPDATE ERROR]', error);
}

async function handleSubscriptionDeleted(subscription) {
  console.log('[SUBSCRIPTION DELETED]', subscription.id);
  
  // Deactivate access code
  const { error } = await supabase
    .from('access_codes')
    .update({ 
      is_active: false,
      stripe_subscription_status: 'canceled'
    })
    .eq('stripe_subscription_id', subscription.id);
  
  if (error) console.error('[UPDATE ERROR]', error);
}

async function handlePaymentFailed(invoice) {
  console.log('[PAYMENT FAILED]', invoice.customer);
  
  // Optionally notify customer
  // Could also give them a grace period before deactivating
}

// ========================================
// GENERATE RANDOM ACCESS CODE
// ========================================
function generateAccessCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusing chars
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ========================================
// CHECK SUBSCRIPTION STATUS
// ========================================
app.get('/api/subscription-status/:email', async (req, res) => {
  try {
    const email = req.params.email;
    
    const { data, error } = await supabase
      .from('access_codes')
      .select('*')
      .eq('email', email)
      .eq('is_active', true)
      .single();
    
    if (error || !data) {
      return res.json({ 
        ok: true, 
        hasSubscription: false 
      });
    }
    
    // If has Stripe subscription, verify it's still active
    if (data.stripe_subscription_id) {
      const subscription = await stripe.subscriptions.retrieve(data.stripe_subscription_id);
      
      return res.json({
        ok: true,
        hasSubscription: true,
        status: subscription.status,
        currentPeriodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        accessCode: data.code
      });
    }
    
    res.json({ 
      ok: true, 
      hasSubscription: true,
      accessCode: data.code 
    });
    
  } catch (err) {
    console.error('[SUBSCRIPTION STATUS ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// CUSTOMER PORTAL (manage subscription)
// ========================================
app.post('/api/create-portal-session', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }
    
    // Get Stripe customer ID from access code
    const { data } = await supabase
      .from('access_codes')
      .select('stripe_customer_id')
      .eq('email', email)
      .single();
    
    if (!data || !data.stripe_customer_id) {
      return res.status(404).json({ error: 'No subscription found' });
    }
    
    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: `${FRONTEND_URL}`,
    });
    
    res.json({ 
      ok: true, 
      url: session.url 
    });
    
  } catch (err) {
    console.error('[PORTAL SESSION ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// ADD TO YOUR .env FILE:
// STRIPE_SECRET_KEY=sk_test_...
// STRIPE_WEBHOOK_SECRET=whsec_...
// FRONTEND_URL=https://sksk-protech.netlify.app
// ========================================
// ========================================
// START SERVER
// ========================================
app.listen(PORT, () => {
  console.log(`🔥 SKSK ProTech Backend v3.0 on port ${PORT}`);
  console.log(`🤖 Groq AI + 80+ flat rates active`);
  console.log(`💰 Tax tracking enabled`);
});
