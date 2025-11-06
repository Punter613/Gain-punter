require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const { z } = require('zod');

const app = express();

// FIXED: Allow all origins including Claude.ai
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'P613 Estimator Backend' });
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
  return `
You are an experienced automotive service writer for a small independent shop. 
Given a customer job description, produce a concise, itemized ESTIMATE as JSON. The JSON must have these fields:

{
  "jobType": string,
  "shortDescription": string,
  "laborHours": number,
  "laborRate": number,
  "workSteps": [string],
  "parts": [{"name":string,"cost":number}],
  "shopSuppliesPercent": number,
  "timeline": string,
  "notes": string
}

Requirements:
- Be realistic and conservative for a 1-2 tech shop.
- Use laborRate = ${DEFAULT_LABOR_RATE} unless the job justifies more.
- Provide sensible parts and approximate costs (use whole dollars).
- Provide laborHours as a decimal (e.g., 14.5).
- shopSuppliesPercent default to 7 if you recommend otherwise include justification in notes.
- The shortDescription should be a one-line summary.
- Do NOT include markup; return ONLY parsable JSON.

Customer: ${customer.name} ${customer.phone ? `phone:${customer.phone}` : ''} ${customer.email ? `email:${customer.email}` : ''}
Vehicle: ${vehicle || 'Not provided'}
Job description: ${description}

Example job: "Ford F-150 5.4L V8 motor swap" — produce realistic parts list, hours, and timeline.
`;
}

app.post('/api/generate-estimate', async (req, res) => {
  try {
    const parsed = GenerateSchema.parse(req.body);
    const { customer, vehicle, description } = parsed;

    const prompt = buildPrompt({ customer, vehicle, description });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful automotive estimator assistant.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 900,
      temperature: 0.1
    });

    const text = response.choices?.[0]?.message?.content ?? response.choices?.[0]?.text;
    if (!text) throw new Error('No response from AI');

    const jsonMatch = text.trim().match(/\{[\s\S]*\}$/);
    const jsonText = jsonMatch ? jsonMatch[0] : text;

    let estimate;
    try {
      estimate = JSON.parse(jsonText);
    } catch (err) {
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
      notes: estimate.notes || ''
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

app.listen(PORT, () => console.log(`P613 estimator backend running on port ${PORT}`));
