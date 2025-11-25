require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');

const app = express();

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

const PRO_ACCESS_CODES = {
  'DEMO2024': { tier: 'pro', expires: '2099-12-31', customer: 'Demo Account' },
  'SKSKPRO2024': { tier: 'pro', expires: '2099-12-31', customer: 'Brian Shaffer' },
};

function validateAccessCode(code) {
  if (!code) return { valid: false, tier: 'free' };
  const accessData = PRO_ACCESS_CODES[code.toUpperCase()];
  if (!accessData) return { valid: false, tier: 'free' };
  const expires = new Date(accessData.expires);
  const now = new Date();
  if (expires < now) return { valid: false, tier: 'free', expired: true };
  return { valid: true, tier: accessData.tier, customer: accessData.customer, expires: accessData.expires };
}

if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY missing in env');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE creds missing in env');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function fetchWithRetry(url, options, retries = 3, backoff = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) return response;
      if (response.ok || i === retries - 1) return response;
      console.log(`Retry ${i + 1}/${retries} after ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff *= 2;
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`Retry ${i + 1}/${retries} after error: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff *= 2;
    }
  }
}

function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, level, message, ...meta }));
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SKSK AutoPro Backend - AI Estimator & Parts Integration' });
});

app.post('/api/validate-access', async (req, res) => {
  const requestId = generateRequestId();
  try {
    const { accessCode } = req.body;
    log('info', 'Access code validation requested', { requestId });
    if (!accessCode || typeof accessCode !== 'string') {
      return res.status(400).json({ valid: false, error: 'Access code required' });
    }
    const validation = validateAccessCode(accessCode.trim());
    if (!validation.valid) {
      log('warn', 'Invalid access code attempt', { requestId, code: accessCode.substring(0, 4) + '...' });
      if (validation.expired) {
        return res.json({ valid: false, error: 'Access code has expired. Please contact support for renewal.', expired: true });
      }
      return res.json({ valid: false, error: 'Invalid access code. Please check your code and try again.' });
    }
    log('info', 'Valid access code used', { requestId, tier: validation.tier, customer: validation.customer });
    res.json({ valid: true, tier: validation.tier, customer: validation.customer, expires: validation.expires, message: `Welcome back, ${validation.customer}!` });
  } catch (err) {
    log('error', 'Access validation failed', { requestId, error: err.message });
    res.status(500).json({ valid: false, error: 'Validation error. Please try again.' });
  }
});

app.get('/api/vin-lookup/:vin', async (req, res) => {
  const requestId = generateRequestId();
  try {
    const { vin } = req.params;
    log('info', 'VIN lookup requested', { requestId, vin: vin.substring(0, 4) + '...' });
    const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/;
    if (!vin || !vinRegex.test(vin.toUpperCase())) {
      log('warn', 'Invalid VIN format', { requestId, vin });
      return res.status(400).json({ error: 'Invalid VIN format. Must be exactly 17 characters (letters and numbers, no I, O, or Q)' });
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetchWithRetry(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin.toUpperCase()}?format=json`,
      { signal: controller.signal },
      2,
      1000
    );
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error('NHTSA VIN decoder service unavailable');
    const data = await response.json();
    const results = data.Results || [];
    const getField = (variableId) => {
      const field = results.find(r => r.VariableId === variableId);
      return field?.Value || null;
    };
    const vehicleInfo = {
      vin: vin.toUpperCase(),
      year: getField(29) || getField(26),
      make: getField(26) || getField(27),
      model: getField(28),
      trim: getField(109),
      engine: getField(13) || getField(71),
      engineCylinders: getField(9),
      displacement: getField(11),
      fuelType: getField(24),
      bodyClass: getField(5),
      driveType: getField(15),
      transmission: getField(37),
      vehicleType: getField(39),
      manufacturer: getField(27),
      plant: getField(31),
      errors: data.Results.filter(r => r.VariableId === 143).map(r => r.Value).join(', ') || null
    };
    const displayString = [vehicleInfo.year, vehicleInfo.make, vehicleInfo.model, vehicleInfo.trim, vehicleInfo.engine ? `${vehicleInfo.engine}` : null].filter(Boolean).join(' ');
    log('info', 'VIN lookup successful', { requestId, vehicle: displayString });
    res.json({ ok: true, vehicle: vehicleInfo, displayString: displayString || 'Unknown Vehicle', raw: data.Results });
  } catch (err) {
    log('error', 'VIN lookup failed', { requestId, error: err.message });
    if (err.name === 'AbortError') return res.status(504).json({ error: 'VIN lookup timed out. Please try again.' });
    res.status(500).json({ error: err.message || 'Failed to lookup VIN' });
  }
});

const GenerateSchema = z.object({
  customer: z.object({
    name: z.string().min(1).max(200),
    phone: z.string().max(20).optional(),
    email: z.string().email().max(200).optional()
  }),
  vehicle: z.string().max(500).optional(),
  description: z.string().min(3).max(5000),
  jobType: z.string().max(100).optional()
});

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
- Provide detailed parts with realistic costs
- laborHours as decimal (e.g., 14.5) - include diagnosis, testing, cleanup time
- shopSuppliesPercent default to 7%
- workSteps should be DETAILED with specific actions
- proTips should include: time-savers, special tools needed, parts to inspect while you're in there, torque specs if critical, common shortcuts
- warnings should include: common problems (stripped bolts, seized parts), year-specific issues, things that break often, hidden labor traps
- Be conversational and practical - like talking to another tech
- Return ONLY valid JSON, no markdown

CRITICAL FORMATTING:
- Use ONLY standard keyboard characters - no Unicode symbols, no emoji
- For lists use: "- item" (dash space)
- For emphasis use: plain text or *asterisks*
- For warnings use: "WARNING: " prefix
- Do NOT use bullet points, checkmarks, arrows, or special symbols

Customer: ${customer.name} ${customer.phone ? `phone:${customer.phone}` : ''} ${customer.email ? `email:${customer.email}` : ''}
Vehicle: ${vehicle || 'Not specified'}
Job description: ${description}

Think like a seasoned tech explaining the job to an apprentice - thorough, practical, and real-world focused.`;
}

app.post('/api/generate-estimate', async (req, res) => {
  const requestId = generateRequestId();
  try {
    log('info', 'Estimate generation requested', { requestId });
    const parsed = GenerateSchema.parse(req.body);
    const { customer, vehicle, description } = parsed;
    log('info', 'Input validated', { requestId, customer: customer.name, vehicle });
    const prompt = buildPrompt({ customer, vehicle, description });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    const response = await fetchWithRetry(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You are a master automotive technician with deep technical knowledge. Provide detailed, practical estimates with insider tips. Always respond with valid JSON only, no markdown formatting.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 2500,
          temperature: 0.2
        })
      },
      3,
      2000
    );
    clearTimeout(timeoutId);
    log('info', 'Groq API responded', { requestId, status: response.status });
    if (!response.ok) {
      const errorText = await response.text();
      log('error', 'Groq API error', { requestId, status: response.status, error: errorText.substring(0, 200) });
      throw new Error(`Groq API error: ${response.status}`);
    }
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('No response from AI');
    let cleanText = text.trim();
    cleanText = cleanText.replace(/```json\n?/g, '');
    cleanText = cleanText.replace(/```\n?/g, '');
    cleanText = cleanText.trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : cleanText;
    let estimate;
    try {
      estimate = JSON.parse(jsonText);
      log('info', 'Estimate parsed successfully', { requestId, jobType: estimate.jobType });
    } catch (err) {
      log('error', 'JSON parse error', { requestId, rawText: text.substring(0, 200) });
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
      if (insertErr) {
        log('error', 'Customer insert failed', { requestId, error: insertErr.message });
        throw insertErr;
      }
      customerRecord = insertedCustomer;
      log('info', 'New customer created', { requestId, customerId: customerRecord.id });
    } else {
      log('info', 'Existing customer found', { requestId, customerId: customerRecord.id });
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
    if (jobErr) {
      log('error', 'Job insert failed', { requestId, error: jobErr.message });
      throw jobErr;
    }
    log('info', 'Estimate saved successfully', { requestId, jobId: savedJob.id, customerId: customerRecord.id, subtotal });
    res.json({
      ok: true,
      ai_raw_text: text,
      estimate: { ...estimate, laborCost, partsCost, shopSupplies, subtotal },
      savedJob,
      customer: customerRecord
    });
  } catch (err) {
    log('error', 'Estimate generation failed', { requestId, error: err.message, type: err.constructor.name, stack: err.stack });
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Request timed out. The AI took too long to respond. Please try again.' });
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input data', details: err.errors.map(e => `${e.path.join('.')}: ${e.message}`) });
    res.status(500).json({ error: err.message || 'Failed to generate estimate' });
  }
});

app.get('/api/jobs', async (req, res) => {
  const { data, error } = await supabase.from('jobs').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error });
  res.json({ data });
});

app.listen(PORT, () => {
  log('info', `SKSK AutoPro backend started`, { port: PORT, mode: process.env.NODE_ENV || 'development', groqConfigured: !!GROQ_API_KEY, supabaseConfigured: !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) });
  console.log(`SKSK AutoPro backend running on port ${PORT} - Professional automotive estimator with AI`);
});
