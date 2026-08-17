'use strict';

const express = require('express');
const { supabase } = require('../db');
const { buildQuickAskResponse } = require('../services/quick.ask');

const router = express.Router();

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

router.post('/', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Knowledge storage is not configured' });
    }

    const body = req.body || {};
    const vehicle = {
      year: Number(body.year || body.vehicle?.year) || null,
      make: clean(body.make || body.vehicle?.make, 80),
      model: clean(body.model || body.vehicle?.model, 120)
    };
    const question = clean(body.question || body.symptoms || '', 1000);

    if (!vehicle.make || !vehicle.model) {
      return res.status(400).json({ success: false, error: 'Quick Ask requires vehicle make and model' });
    }
    if (!question) {
      return res.status(400).json({ success: false, error: 'Quick Ask requires a symptom or question' });
    }

    let tsbQuery = supabase
      .from('vehicle_tsb_corpus')
      .select('year,make,model,title,bulletin_number,bulletin_date,group_name,subject,body_text,source,source_url')
      .ilike('make', vehicle.make)
      .ilike('model', vehicle.model)
      .limit(250);
    if (vehicle.year) tsbQuery = tsbQuery.eq('year', vehicle.year);

    const [tsbResult, feedbackResult] = await Promise.all([
      tsbQuery,
      supabase
        .from('feedback_examples')
        .select('id,request_id,labels,metadata,stored_at')
        .order('stored_at', { ascending: false })
        .limit(500)
    ]);

    if (tsbResult.error) throw new Error(`TSB retrieval failed: ${tsbResult.error.message}`);
    if (feedbackResult.error) throw new Error(`Confirmed repair retrieval failed: ${feedbackResult.error.message}`);

    const answer = buildQuickAskResponse({
      vehicle,
      question,
      tsbRows: tsbResult.data || [],
      feedbackRows: feedbackResult.data || []
    });

    return res.json({ success: true, ...answer });
  } catch (err) {
    console.warn('[quick-ask] retrieval failed:', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Quick Ask failed' });
  }
});

module.exports = router;
