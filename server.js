require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');

const app = express();

// CORS & MIDDLEWARE
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

// ENVIRONMENT VARIABLES
const PORT = process.env.PORT || 4000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEFAULT_LABOR_RATE = Number(process.env.DEFAULT_LABOR_RATE || 65);
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://sksk-protech.netlify.app';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE creds missing');
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Stripe
let stripe = null;
if (STRIPE_SECRET_KEY) {
  stripe = require('stripe')(STRIPE_SECRET_KEY);
  console.log('💳 Stripe initialized');
}

// FLAT RATES TABLE (YOUR ORIGINAL - PERFECT)
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
// VALIDATION SCHEMAS
const GenerateSchema = z.object({
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().optional()
  }),
  vehicle: z.string().optional(),
  description: z.string().min(3),
  laborRate: z.number().optional()
});

// HEALTH CHECK
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'SKSK ProTech Backend',
    version: '3.0.0-FIXED',
    features: ['Groq AI + Flat Rate Fallback', 'Tax Tracking', 'VIN Lookup']
  });
});
// FIXED ESTIMATE GENERATION (NO MORE CRASHES)
app.post('/api/generate-estimate', async (req, res) => {
  try {
    const parsed = GenerateSchema.parse(req.body);
    const { customer, vehicle, description } = parsed;
    const laborRate = parsed.laborRate || DEFAULT_LABOR_RATE;

    console.log(`[ESTIMATE] ${customer.name} | ${vehicle || 'N/A'} | $${laborRate}/hr`);

    // 1. FLAT RATE FALLBACK (WORKS IMMEDIATELY)
    const flatRateMatch = getFlatRate(description);
    let estimate = {
      jobType: "Auto Repair",
      shortDescription: flatRateMatch ? `Flat Rate: ${flatRateMatch.job}` : description,
      laborHours: 2.5,
      laborRate,
      parts: [{name: "Standard parts", cost: 125}],
      shopSuppliesPercent: 7,
      tips: ["Double-check flat rate hours"],
      warnings: []
    };

    if (flatRateMatch) {
      estimate.laborHours = typeof flatRateMatch.hours === 'number' 
        ? flatRateMatch.hours 
        : (flatRateMatch.hours.min + flatRateMatch.hours.max) / 2;
      console.log(`[FLAT RATE] Forced ${estimate.laborHours}hrs for "${flatRateMatch.job}"`);
    }

    // 2. TRY GROQ (8s timeout - fails gracefully)
    try {
      if (GROQ_API_KEY) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() =>
