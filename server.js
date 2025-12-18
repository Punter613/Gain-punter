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
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public'));

// Stripe webhook needs raw body
app.post('/api/stripe-webhook', express.raw({type: 'application/json'}), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // Update job as paid (you'd link session.metadata.jobId to jobs table)
    console.log('Payment succeeded:', session.id);
  }
  res.json({received: true});
});

// ========================================
// SUPABASE
// ========================================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ========================================
// FLAT RATES (80+ jobs)
const FLAT_RATES = {
  'oil change': 0.5, 'tire rotation': 0.5, 'battery replacement': 0.3,
  'wiper blades': 0.2, 'air filter': 0.3, 'cabin filter': 0.4,
  'brake pads front': {min: 1.5, max: 2.0}, 'brake pads rear': {min: 1.5, max: 2.0},
  'alternator': {min: 1.5, max: 3.5}, 'water pump': 2.5,
  // ... (add your full table from paste.txt)
};

function getFlatRate(description) {
  const desc = description.toLowerCase().trim();
  for (const [job, hours] of Object.entries(FLAT_RATES)) {
    if (desc.includes(job)) return { job, hours };
  }
  return null;
}

// ========================================
// ROUTES
// ========================================

// Health check
app.get('/', (req, res) => res.json({ status: 'SKSK ProTech v3.0 - Ready' }));

// Validate access code
app.post('/api/validate-access', async (req, res) => {
  try {
    const { accessCode } = req.body;
    const { data, error } = await supabase
      .from('access_codes')
      .select('*')
      .eq('code', accessCode.trim().toUpperCase())
      .eq('is_active', true)
      .single();

    if (error || !data) return res.json({ valid: false, error: 'Invalid code' });

    await supabase
      .from('access_codes')
      .update({ current_uses: data.current_uses + 1 })
      .eq('id', data.id);

    res.json({ 
      valid: true, 
      tier: data.tier || 'pro',
      customer: data.customer_name 
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// VIN lookup
app.get('/api/vin-lookup/:vin', async (req, res) => {
  try {
    const vin = req.params.vin.trim().toUpperCase();
    const response = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`);
    const data = await response.json();
    
    if (!data.Results?.length) return res.json({ ok: false, error: 'VIN not found' });
    
    const results = data.Results;
    const getField = (id) => results.find(r => r.VariableId === id)?.Value || null;
    
    res.json({
      ok: true,
      vin,
      displayString: `${getField(29)} ${getField(26)} ${getField(28)}`.trim()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Generate estimate
app.post('/api/generate-estimate', async (req, res) => {
  try {
    const { customer, vehicle, description, laborRate = 65 } = req.body;
    
    // Groq AI call (your prompt logic here)
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: `Estimate: ${description}` }],
        max_tokens: 1000
      })
    });
    
    const aiData = await groqResponse.json();
    const estimate = JSON.parse(aiData.choices[0].message.content);
    
    // Save to Supabase
    const { data: customerRecord } = await supabase.from('customers').upsert({
      name: customer.name,
      phone: customer.phone,
      email: customer.email
    }).select().single();
    
    const { data: job } = await supabase.from('jobs').insert({
      customer_id: customerRecord.id,
      status: 'estimate',
      vehicle,
      description,
      estimated_labor_hours: estimate.laborHours,
      estimated_labor_rate: laborRate,
      estimated_subtotal: estimate.subtotal
    }).select().single();
    
    res.json({ ok: true, estimate, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stripe checkout
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { jobId, amount } = req.body;
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Auto Repair Invoice' },
          unit_amount: amount * 100,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.headers.origin}/?success=true`,
      cancel_url: `${req.headers.origin}/?canceled=true`,
      metadata: { jobId }
    });
    
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 SKSK ProTech Backend v3.0 on port ${PORT}`);
});
