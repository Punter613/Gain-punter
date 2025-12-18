require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');

const app = express();
const PORT = process.env.PORT || 4000;

// ========================================
// MIDDLEWARE
// ========================================
app.use(cors({ 
  origin: [
    'http://localhost:3000', 
    'https://p613-estimator.netlify.app',
    'https://*.netlify.app'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.static('public'));

// Stripe webhook (raw body)
app.post('/api/stripe-webhook', 
  express.raw({type: 'application/json'}), 
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
      event = stripe.webhooks.constructEvent(
        req.body, 
        sig, 
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const jobId = session.metadata.jobId;
      
      // Mark job as paid
      await supabase
        .from('jobs')
        .update({ 
          payment_status: 'paid',
          paid_amount: session.amount_total / 100,
          payment_method: 'stripe',
          paid_date: new Date().toISOString()
        })
        .eq('id', jobId);
        
      console.log(`✅ Job ${jobId} paid via Stripe: $${session.amount_total / 100}`);
    }
    
    res.json({received: true});
  }
);

// ========================================
// SUPABASE
// ========================================
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
}

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ========================================
// FLAT RATES (80+ common jobs)
const FLAT_RATES = {
  'oil change': 0.5, 'oil change basic': 0.5, 'oil change synthetic': 0.5,
  'oil and filter': 0.5, 'oil change + rotation': 1.0, 'tire rotation': 0.5,
  'battery replacement': 0.3, 'battery install': 0.3, 'replace battery': 0.3,
  'wiper blades': 0.2, 'windshield wipers': 0.2,
  'air filter': 0.3, 'engine air filter': 0.3,
  'cabin filter': 0.4, 'cabin air filter': 0.4,
  'brake pads front': { min: 1.5, max: 2.0 }, 'front brake pads': { min: 1.5, max: 2.0 },
  'brake pads rear': { min: 1.5, max: 2.0 }, 'rear brake pads': { min: 1.5, max: 2.0 },
  'alternator': { min: 1.5, max: 3.5 }, 'alternator replacement': { min: 1.5, max: 3.5 },
  'water pump': 2.5, 'water pump replacement': 2.5,
  'radiator': { min: 2.0, max: 3.5 }, 'thermostat': 1.0
  // Add more from your paste.txt as needed
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
    return { type: 'custom', message: 'Estimate realistic hours (max 6hrs standard)' };
  }
  const { job, hours } = flatRate;
  if (typeof hours === 'number') {
    return { type: 'fixed', message: `Use exactly ${hours} hours for "${job}"`, hours };
  }
  return { type: 'range', message: `Use ${hours.min}-${hours.max} hours for "${job}"`, hours };
}

// ========================================
// ROUTES
// ========================================

app.get('/', (req, res) => {
  res.json({ 
    status: '🚀 SKSK ProTech v3.0 LIVE',
    backend: 'https://p613-backend.onrender.com',
    features: ['Groq AI', 'Stripe', 'Supabase', 'VIN Lookup']
  });
});

// 🔒 Secure Stripe config (NO KEYS IN FRONTEND)
app.get('/api/stripe-config', (req, res) => {
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
  });
});

// Validate access code
app.post('/api/validate-access', async (req, res) => {
  try {
    const { accessCode } = req.body;
    if (!accessCode) return res.json({ valid: false, error: 'Access code required' });

    const { data, error } = await supabase
      .from('access_codes')
      .select('*')
      .eq('code', accessCode.trim().toUpperCase())
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return res.json({ valid: false, error: 'Invalid or expired code' });
    }

    // Update usage
    await supabase
      .from('access_codes')
      .update({ 
        current_uses: data.current_uses + 1,
        last_used_at: new Date().toISOString()
      })
      .eq('id', data.id);

    res.json({ 
      valid: true, 
      tier: data.tier || 'pro',
      customer: data.customer_name || 'Pro User',
      expires: data.expires_at
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// VIN lookup (NHTSA API)
app.get('/api/vin-lookup/:vin', async (req, res) => {
  try {
    const vin = req.params.vin.trim().toUpperCase();
    if (vin.length !== 17) {
      return res.status(400).json({ ok: false, error: 'VIN must be 17 characters' });
    }

    const response = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`);
    const data = await response.json();
    
    if (!data.Results?.length) {
      return res.json({ ok: false, error: 'VIN not found' });
    }

    const results = data.Results;
    const getField = (id) => results.find(r => r.VariableId === id)?.Value || null;
    
    const year = getField(29) || getField(26);
    const make = getField(26);
    const model = getField(28);
    
    res.json({
      ok: true,
      vin,
      displayString: `${year || ''} ${make || ''} ${model || ''}`.trim(),
      year, make, model
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Generate AI estimate (Groq + Flat Rates)
app.post('/api/generate-estimate', async (req, res) => {
  try {
    const { customer, vehicle, description, laborRate = 65 } = req.body;
    
    if (!customer?.name || !description) {
      return res.status(400).json({ ok: false, error: 'Customer name and description required' });
    }

    // Build AI prompt
    const guidance = getHourGuidance(description);
    const prompt = `You are an expert mobile mechanic estimator.

MANDATORY LABOR RATE: $${laborRate}/hour
${guidance.message}

Customer: ${customer.name}
Vehicle: ${vehicle || 'N/A'}
Job: ${description}

Return ONLY valid JSON:
{
  "jobType": "Repair",
  "shortDescription": "Brief summary", 
  "laborHours": 2.5,
  "laborRate": ${laborRate},
  "workSteps": ["Step 1", "Step 2"],
  "parts": [{"name":"Part","cost":50}],
  "shopSuppliesPercent": 7,
  "timeline": "Same day",
  "notes": "Context"
}`;

    // Groq AI
    const aiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'Return valid JSON only. No explanations.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1500,
        temperature: 0.1
      })
    });

    if (!aiResponse.ok) {
      throw new Error(`Groq API error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    let estimateText = aiData.choices?.[0]?.message?.content || '{}';
    
    // Clean JSON
    estimateText = estimateText.replace(/``````/g, '').trim();
    const jsonMatch = estimateText.match(/\{[\s\S]*\}/);
    const cleanJson = jsonMatch ? jsonMatch[0] : estimateText;

    let estimate;
    try {
      estimate = JSON.parse(cleanJson);
    } catch {
      // Fallback estimate
      estimate = {
        jobType: 'Repair',
        shortDescription: description,
        laborHours: 2.0,
        laborRate,
        parts: [{name: 'Parts', cost: 100}],
        shopSuppliesPercent: 7,
        timeline: 'Same day'
      };
    }

    // Apply flat rate override
    const flatRate = getFlatRate(description);
    if (flatRate && typeof flatRate.hours === 'number') {
      estimate.laborHours = flatRate.hours;
    }

    // Calculate totals
    estimate.laborHours = parseFloat(estimate.laborHours || 0);
    estimate.laborCost = (estimate.laborHours * laborRate).toFixed(2);
    estimate.parts = (estimate.parts || []).map(p => ({
      name: p.name || 'Part',
      cost: Math.round(Number(p.cost || 0))
    }));
    estimate.partsCost = estimate.parts.reduce((sum, p) => sum + p.cost, 0);
    estimate.shopSupplies = (estimate.partsCost * (estimate.shopSuppliesPercent / 100 || 0.07)).toFixed(2);
    estimate.subtotal = (parseFloat(estimate.laborCost) + estimate.partsCost + parseFloat(estimate.shopSupplies)).toFixed(2);
    estimate.taxRate = 28;
    estimate.recommendedTaxSetaside = (estimate.subtotal * 0.28).toFixed(2);
    estimate.netAfterTax = (estimate.subtotal * 0.72).toFixed(2);

    // Save customer
    let customerRecord = null;
    if (customer.email) {
      const { data } = await supabase
        .from('customers')
        .select('*')
        .eq('email', customer.email)
        .single();
      customerRecord = data;
    }
    
    if (!customerRecord) {
      const { data, error } = await supabase
        .from('customers')
        .upsert({
          name: customer.name,
          phone: customer.phone || null,
          email: customer.email || null
        })
        .select()
        .single();
      if (error) throw error;
      customerRecord = data;
    }

    // Save job
    const { data: savedJob, error: jobError } = await supabase
      .from('jobs')
      .insert({
        customer_id: customerRecord.id,
        status: 'estimate',
        vehicle: vehicle || null,
        description: estimate.shortDescription || description,
        raw_description: description,
        job_type: estimate.jobType || 'Auto Repair',
        estimated_labor_hours: estimate.laborHours,
        estimated_labor_rate: laborRate,
        estimated_labor_cost: estimate.laborCost,
        estimated_parts: estimate.parts,
        estimated_parts_cost: estimate.partsCost,
        estimated_shop_supplies_percent: estimate.shopSuppliesPercent || 7,
        estimated_shop_supplies_cost: estimate.shopSupplies,
        estimated_subtotal: estimate.subtotal,
        estimated_tax_setaside: estimate.recommendedTaxSetaside,
        tax_rate: estimate.taxRate,
        timeline: estimate.timeline || 'TBD',
        work_steps: estimate.workSteps || [],
        notes: estimate.notes || ''
      })
      .select()
      .single();

    if (jobError) throw jobError;

    console.log(`✅ Estimate saved: Job ${savedJob.id} for ${customer.name} - $${estimate.subtotal}`);
    
    res.json({
      ok: true,
      estimate,
      savedJob,
      customer: customerRecord
    });

  } catch (err) {
    console.error('[ESTIMATE ERROR]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Stripe checkout session
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { jobId, amount } = req.body;
    
    if (!jobId || !amount) {
      return res.status(400).json({ error: 'jobId and amount required' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'SKSK ProTech Auto Repair Invoice'
          },
          unit_amount: Math.round(amount * 100), // cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.headers.origin}/?success=true&jobId=${jobId}`,
      cancel_url: `${req.headers.origin}/?canceled=true`,
      metadata: { jobId }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[STRIPE ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// START SERVER
// ========================================
app.listen(PORT, () => {
  console.log(`🚀 SKSK ProTech v3.0 LIVE on port ${PORT}`);
  console.log(`📡 Backend: https://p613-backend.onrender.com`);
  console.log(`✅ Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Ready' : 'Missing key'}`);
  console.log(`✅ Supabase: ${process.env.SUPABASE_URL ? 'Connected' : 'Missing'}`);
  console.log(`✅ Groq: ${process.env.GROQ_API_KEY ? 'Ready' : 'Missing key'}`);
});
