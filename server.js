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
  // ...[table unchanged]...
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
    // ...[rest of route unchanged]...
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
    // [handler unchanged]
  } catch (err) {
    console.error('[CUSTOMERS ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', async (req, res) => {
  try {
    // [handler unchanged]
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
    // [handler unchanged]
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
    // [handler unchanged]
  } catch (err) {
    console.error('[VIN LOOKUP ERROR]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ========================================
// JOBS
// ========================================
app.get('/api/jobs', async (req, res) => {
  // [handler unchanged]
});
// ========================================
// STRIPE INTEGRATION FOR PRO SUBSCRIPTIONS
// Add this to your existing server.js
// ========================================

// 1. Install Stripe package
// Run in terminal: npm install stripe

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://skskprotech.netlify.app'; // <-- fixed

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

// ...[rest of the code remains unchanged: make sure all uses of FRONTEND_URL downstream use this single variable!]...

// ADD TO YOUR .env FILE:
// STRIPE_SECRET_KEY=sk_test_...
// STRIPE_WEBHOOK_SECRET=whsec_...
// FRONTEND_URL=https://skskprotech.netlify.app  // <-- fixed (no hyphen)
// ========================================
// ========================================
// START SERVER
// ========================================
app.listen(PORT, () => {
  console.log(`🔥 SKSK ProTech Backend v3.0 on port ${PORT}`);
  console.log(`🤖 Groq AI + 80+ flat rates active`);
  console.log(`💰 Tax tracking enabled`);
});
